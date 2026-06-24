import {
  TransactionBuilder,
  Operation,
  xdr,
  SorobanDataBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { getRpcServer, getNetworkPassphrase } from "../config/stellar.js";
import { getPrisma } from "../database/client.js";
import { getActiveKey } from "../keys/manager.js";
import { extractFeeXlm } from "./fees.js";
import { sendNotification, NotificationEvent } from "../notifications/webhook.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ─── Relayer Engine ──────────────────────────────────────────
//
// Builds, simulates, signs, submits, and confirms Soroban
// extendFootprintTtl transactions. This is the queue processor
// function wired up in src/index.ts.
//
// Critical flow: simulate → assemble → sign → submit → poll
// ─────────────────────────────────────────────────────────────

const TX_TIMEOUT_SECONDS = 30;
const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_ATTEMPTS = 30;

/**
 * Process a single monitored key extension.
 * This function is set as the queue processor in src/index.ts.
 */
export async function processExtension(monitoredKeyId: string): Promise<void> {
  const prisma = getPrisma();
  const rpcServer = getRpcServer();

  // Load the monitored key record
  const keyRecord = await prisma.monitoredKey.findUnique({
    where: { id: monitoredKeyId },
    include: { user: { include: { balancePool: true } } },
  });

  if (!keyRecord) {
    logger.warn({ monitoredKeyId }, "Monitored key not found, skipping extension");
    return;
  }

  const userId = keyRecord.userId;
  const contractId = keyRecord.contractId;

  logger.info(
    { monitoredKeyId, contractId, extendTo: keyRecord.extendToLedgers },
    "Processing TTL extension",
  );

  // ── Step 1: Balance Check ──────────────────────────────────

  const balance = keyRecord.user.balancePool?.xlmBalance;
  const balanceNum = balance ? parseFloat(balance.toString()) : 0;

  if (balanceNum < config.relayer.minBalanceXlm) {
    logger.warn(
      { userId, balance: balanceNum, required: config.relayer.minBalanceXlm },
      "Insufficient balance for extension",
    );
    await sendNotification(userId, {
      event: NotificationEvent.LOW_BALANCE,
      contractId,
      storageKind: keyRecord.storageKind,
      remaining: keyRecord.liveUntilLedger
        ? keyRecord.liveUntilLedger - (keyRecord.lastCheckedLedger ?? 0)
        : 0,
      message: `Balance too low (${balanceNum.toFixed(7)} XLM). Minimum ${config.relayer.minBalanceXlm} XLM required.`,
    });
    return;
  }

  // ── Step 2: Get Active Relayer Key ─────────────────────────

  const activeKey = await getActiveKey();
  if (!activeKey) {
    logger.error("No active relayer keys — cannot process extension");
    return;
  }

  const { keypair, keyId: signingKeyId } = activeKey;

  try {
    // ── Step 3: Build Base Transaction ─────────────────────────

    const account = await rpcServer.getAccount(keypair.publicKey());
    const targetLedgerKey = xdr.LedgerKey.fromXDR(keyRecord.targetKeyXdr, "base64");

    const sorobanData = new SorobanDataBuilder()
      .setReadOnly([targetLedgerKey])
      .build();

    const tx = new TransactionBuilder(account, {
      fee: "100", // Base fee — will be overridden by simulation
      networkPassphrase: getNetworkPassphrase(),
    })
      .setSorobanData(sorobanData)
      .addOperation(
        Operation.extendFootprintTtl({
          extendTo: keyRecord.extendToLedgers,
        }),
      )
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    // ── Step 4: Simulate ───────────────────────────────────────

    logger.debug({ contractId }, "Simulating transaction");
    const simulation = await rpcServer.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      const errorMsg = `Simulation failed: ${JSON.stringify(simulation.error)}`;
      logger.error({ contractId, error: simulation.error }, errorMsg);
      await createTransactionLog(prisma, {
        userId,
        monitoredKeyId,
        txHash: "SIMULATION_FAILED",
        signingKeyId,
        status: "FAILED",
        errorMessage: errorMsg,
      });
      return;
    }

    // ── Step 5: Assemble ───────────────────────────────────────

    const assembledTx = rpc.assembleTransaction(tx, simulation).build();

    // ── Step 6: Sign ───────────────────────────────────────────

    assembledTx.sign(keypair);

    // ── Step 7: Submit ─────────────────────────────────────────

    logger.debug({ contractId }, "Submitting transaction");
    const sendResponse = await rpcServer.sendTransaction(assembledTx);

    if (sendResponse.status !== "PENDING") {
      const errorMsg = `Transaction submission failed: ${sendResponse.status} — ${sendResponse.errorResult?.toXDR("base64") ?? "unknown"}`;
      logger.error({ contractId, status: sendResponse.status }, errorMsg);
      await createTransactionLog(prisma, {
        userId,
        monitoredKeyId,
        txHash: sendResponse.hash,
        signingKeyId,
        status: "FAILED",
        errorMessage: errorMsg,
      });
      return;
    }

    // ── Step 8: Poll for Confirmation ──────────────────────────

    logger.info({ contractId, txHash: sendResponse.hash }, "Transaction submitted, polling");

    let getResponse = await rpcServer.getTransaction(sendResponse.hash);
    let attempts = 0;

    while (getResponse.status === "NOT_FOUND" && attempts < MAX_POLL_ATTEMPTS) {
      await sleep(POLL_INTERVAL_MS);
      getResponse = await rpcServer.getTransaction(sendResponse.hash);
      attempts++;
    }

    // ── Step 9/10: Handle Result ───────────────────────────────

    if (getResponse.status === "SUCCESS") {
      const successResponse = getResponse as rpc.Api.GetSuccessfulTransactionResponse;
      const feeXlm = extractFeeXlm(successResponse);

      logger.info(
        { contractId, txHash: sendResponse.hash, feeXlm },
        "✅ TTL extension successful",
      );

      // Deduct fee from user balance (atomic transaction)
      await prisma.$transaction([
        prisma.balancePool.update({
          where: { userId },
          data: {
            xlmBalance: { decrement: parseFloat(feeXlm) },
          },
        }),
        prisma.monitoredKey.update({
          where: { id: monitoredKeyId },
          data: { status: "HEALTHY" },
        }),
        prisma.transactionLog.create({
          data: {
            userId,
            monitoredKeyId,
            txHash: sendResponse.hash,
            signingKeyId,
            status: "SUCCESS",
            xlmCost: parseFloat(feeXlm),
            extendedTo: keyRecord.extendToLedgers,
          },
        }),
      ]);

      await sendNotification(userId, {
        event: NotificationEvent.EXTENSION_SUCCESS,
        contractId,
        storageKind: keyRecord.storageKind,
        remaining: keyRecord.extendToLedgers,
        message: `TTL extended by ${keyRecord.extendToLedgers.toLocaleString()} ledgers. Cost: ${feeXlm} XLM.`,
        txHash: sendResponse.hash,
      });
    } else {
      // FAILED or timed out
      const errorMsg =
        getResponse.status === "FAILED"
          ? `Transaction failed on-chain`
          : `Transaction confirmation timed out after ${MAX_POLL_ATTEMPTS}s`;

      logger.error({ contractId, txHash: sendResponse.hash, status: getResponse.status }, errorMsg);

      await createTransactionLog(prisma, {
        userId,
        monitoredKeyId,
        txHash: sendResponse.hash,
        signingKeyId,
        status: "FAILED",
        errorMessage: errorMsg,
      });

      await sendNotification(userId, {
        event: NotificationEvent.EXTENSION_FAILED,
        contractId,
        storageKind: keyRecord.storageKind,
        remaining: keyRecord.liveUntilLedger
          ? keyRecord.liveUntilLedger - (keyRecord.lastCheckedLedger ?? 0)
          : 0,
        message: errorMsg,
        txHash: sendResponse.hash,
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ contractId, error: err }, "Extension processing error");

    await createTransactionLog(prisma, {
      userId,
      monitoredKeyId,
      txHash: "ERROR",
      signingKeyId,
      status: "FAILED",
      errorMessage: errorMsg,
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────

async function createTransactionLog(
  prisma: ReturnType<typeof getPrisma>,
  data: {
    userId: string;
    monitoredKeyId: string;
    txHash: string;
    signingKeyId: string;
    status: string;
    xlmCost?: number;
    extendedTo?: number;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    await prisma.transactionLog.create({ data });
  } catch (err) {
    logger.error(err, "Failed to create transaction log");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
