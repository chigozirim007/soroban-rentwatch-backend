import { xdr } from "@stellar/stellar-sdk";
import { getRpcServer } from "../config/stellar.js";
import { getPrisma } from "../database/client.js";
import { setTTLDelta } from "../database/redis.js";
import { evaluateStatus, isStatusTransition } from "./evaluator.js";
import { enqueueExtension } from "../relayer/queue.js";
import { sendNotification, NotificationEvent } from "../notifications/webhook.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import type { MonitoredKey, TrackingStatus } from "@prisma/client";

// ─── Indexer Worker ──────────────────────────────────────────
//
// The core monitoring loop. Runs on a cron interval, batch-
// queries Soroban RPC for ledger entry TTLs, evaluates status,
// and triggers downstream actions (relay queue, notifications).
// ─────────────────────────────────────────────────────────────

interface StatusTransition {
  key: MonitoredKey;
  oldStatus: TrackingStatus;
  newStatus: TrackingStatus;
  remaining: number;
}

/**
 * Execute one full indexer cycle.
 * Called by the cron scheduler in src/index.ts.
 */
export async function runIndexerCycle(): Promise<void> {
  const startTime = Date.now();
  const rpcServer = getRpcServer();
  const prisma = getPrisma();

  try {
    // 1. Get current network ledger sequence
    const latestLedger = await rpcServer.getLatestLedger();
    const currentSequence = latestLedger.sequence;
    logger.debug({ currentSequence }, "Indexer cycle starting");

    // 2. Fetch all non-archived monitored keys
    const allKeys = await prisma.monitoredKey.findMany({
      where: { status: { not: "ARCHIVED" } },
      include: { user: { select: { webhookUrl: true } } },
    });

    if (allKeys.length === 0) {
      logger.debug("No monitored keys to process");
      return;
    }

    // 3. Chunk into batches
    const batches = chunkArray(allKeys, config.indexer.batchSize);
    const transitions: StatusTransition[] = [];

    // 4. Process batches with bounded concurrency
    for (let i = 0; i < batches.length; i += config.indexer.maxConcurrency) {
      const concurrentBatches = batches.slice(i, i + config.indexer.maxConcurrency);
      const results = await Promise.allSettled(
        concurrentBatches.map((batch) =>
          processBatch(batch, currentSequence, rpcServer),
        ),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          transitions.push(...result.value);
        } else {
          logger.error(result.reason, "Batch processing failed");
        }
      }
    }

    // 5. Handle status transitions
    for (const transition of transitions) {
      await handleTransition(transition);
    }

    const elapsed = Date.now() - startTime;
    logger.info(
      {
        keysProcessed: allKeys.length,
        transitions: transitions.length,
        durationMs: elapsed,
        currentSequence,
      },
      "Indexer cycle complete",
    );
  } catch (err) {
    logger.error(err, "Indexer cycle failed");
  }
}

/**
 * Process a single batch of monitored keys against the RPC.
 */
async function processBatch(
  keys: Array<MonitoredKey & { user: { webhookUrl: string | null } }>,
  currentSequence: number,
  rpcServer: ReturnType<typeof getRpcServer>,
): Promise<StatusTransition[]> {
  const prisma = getPrisma();
  const transitions: StatusTransition[] = [];

  // Deserialize all LedgerKeys
  const ledgerKeys: xdr.LedgerKey[] = [];
  const keyMap = new Map<number, (typeof keys)[number]>();

  for (let i = 0; i < keys.length; i++) {
    try {
      const lk = xdr.LedgerKey.fromXDR(keys[i].targetKeyXdr, "base64");
      ledgerKeys.push(lk);
      keyMap.set(ledgerKeys.length - 1, keys[i]);
    } catch (err) {
      logger.error({ keyId: keys[i].id, error: err }, "Failed to deserialize LedgerKey XDR");
    }
  }

  if (ledgerKeys.length === 0) return transitions;

  // Query RPC for all entries in this batch
  const response = await rpcServer.getLedgerEntries(...ledgerKeys);

  // Build a lookup by XDR to match responses back to our keys
  const responseByXdr = new Map<string, number>();
  if (response.entries) {
    for (const entry of response.entries) {
      const entryXdr = entry.key.toXDR("base64");
      responseByXdr.set(entryXdr, entry.liveUntilLedgerSeq ?? 0);
    }
  }

  // Evaluate each key
  const updates: Array<{
    id: string;
    liveUntilLedger: number;
    lastCheckedLedger: number;
    status: TrackingStatus;
  }> = [];

  for (const [idx, dbKey] of keyMap) {
    const entryXdr = ledgerKeys[idx].toXDR("base64");
    const liveUntil = responseByXdr.get(entryXdr);

    let remaining: number;
    let newStatus: TrackingStatus;

    if (liveUntil === undefined) {
      // Entry not found in RPC response — possibly already archived
      remaining = 0;
      newStatus = "ARCHIVED";
    } else {
      remaining = liveUntil - currentSequence;
      newStatus = evaluateStatus(remaining, dbKey.thresholdLedgers);
    }

    // Write TTL delta to Redis cache
    await setTTLDelta(dbKey.id, {
      liveUntil: liveUntil ?? 0,
      remaining,
      lastChecked: currentSequence,
      status: newStatus,
    });

    // Track status transitions
    if (isStatusTransition(dbKey.status, newStatus)) {
      transitions.push({
        key: dbKey,
        oldStatus: dbKey.status,
        newStatus,
        remaining,
      });
    }

    updates.push({
      id: dbKey.id,
      liveUntilLedger: liveUntil ?? 0,
      lastCheckedLedger: currentSequence,
      status: newStatus,
    });
  }

  // Batch update PostgreSQL
  for (const update of updates) {
    await prisma.monitoredKey.update({
      where: { id: update.id },
      data: {
        liveUntilLedger: update.liveUntilLedger,
        lastCheckedLedger: update.lastCheckedLedger,
        status: update.status,
      },
    });
  }

  return transitions;
}

/**
 * Handle a status transition — trigger notifications and relay queue.
 */
async function handleTransition(transition: StatusTransition): Promise<void> {
  const { key, oldStatus, newStatus, remaining } = transition;

  logger.info(
    {
      keyId: key.id,
      contractId: key.contractId,
      from: oldStatus,
      to: newStatus,
      remaining,
    },
    "Status transition detected",
  );

  switch (newStatus) {
    case "CRITICAL":
      // Push to relayer queue for automatic extension
      enqueueExtension(key.id);
      await sendNotification(key.userId, {
        event: NotificationEvent.CRITICAL,
        contractId: key.contractId,
        storageKind: key.storageKind,
        remaining,
        message: "Contract entry is critically low on TTL. Automatic extension queued.",
      });
      break;

    case "NEAR_EXPIRY":
      await sendNotification(key.userId, {
        event: NotificationEvent.NEAR_EXPIRY,
        contractId: key.contractId,
        storageKind: key.storageKind,
        remaining,
        message: "Contract entry is approaching TTL threshold.",
      });
      break;

    case "ARCHIVED":
      await sendNotification(key.userId, {
        event: NotificationEvent.CRITICAL,
        contractId: key.contractId,
        storageKind: key.storageKind,
        remaining: 0,
        message: "⚠️ Contract entry has been ARCHIVED. Manual restoration required.",
      });
      break;
  }
}

/**
 * Split an array into chunks of a given size.
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
