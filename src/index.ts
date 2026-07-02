import cron from "node-cron";
import { StrKey } from "@stellar/stellar-sdk";
import { config } from "./config/index.js";
import { getPrisma, disconnectPrisma } from "./database/client.js";
import { connectRedis, disconnectRedis } from "./database/redis.js";
import { getActiveKeyCount } from "./keys/manager.js";
import { runIndexerCycle } from "./indexer/worker.js";
import { setQueueProcessor, getQueueDepth } from "./relayer/queue.js";
import { processExtension } from "./relayer/engine.js";
import { startDepositWatcher, stopDepositWatcher } from "./deposit/watcher.js";
import { startHealthServer } from "./health/server.js";
import { logger } from "./utils/logger.js";

// ─── Main Entry Point ────────────────────────────────────────
//
// Orchestrates all background services:
//   1. PostgreSQL (Prisma) connection
//   2. Redis connection
//   3. Key Manager initialization
//   4. Deposit Watcher (Horizon stream)
//   5. Indexer Worker (cron loop)
//   6. Relayer Queue processor
//   7. Graceful shutdown handlers
// ─────────────────────────────────────────────────────────────

let _cronTask: cron.ScheduledTask | null = null;

async function main(): Promise<void> {
  logger.info("═══════════════════════════════════════════════");
  logger.info("  ⏳ Soroban RentWatch — Starting Up");
  logger.info("═══════════════════════════════════════════════");

  // ── 1. Connect to PostgreSQL ─────────────────────────────
  const prisma = getPrisma();
  await prisma.$connect();
  logger.info("PostgreSQL connected");

  // ── 2. Connect to Redis ──────────────────────────────────
  await connectRedis();

  // ── 3. Verify Relayer Keys ───────────────────────────────
  const keyCount = await getActiveKeyCount();
  if (keyCount === 0) {
    logger.warn("⚠️  No active relayer keys! Use the CLI to add one:");
    logger.warn("   npm run cli -- add-relayer-key --secret S...");
    logger.warn("   The relayer will be unable to submit transactions.");
  } else {
    logger.info({ activeKeys: keyCount }, "Relayer keys loaded");
  }

  // ── 4. Wire up Relayer Queue ─────────────────────────────
  setQueueProcessor(processExtension);
  logger.info("Relayer queue processor active");

  // ── 5. Start Deposit Watcher ─────────────────────────────
  const depositKey = config.deposit.accountPublic;
  const isValidDepositKey = StrKey.isValidEd25519PublicKey(depositKey);

  if (!isValidDepositKey) {
    logger.warn(
      { depositAccount: depositKey },
      "⚠️  DEPOSIT_ACCOUNT_PUBLIC is missing or invalid — deposit watcher skipped",
    );
    logger.warn("   Set a valid Stellar public key in your .env to enable deposit detection.");
  } else {
    try {
      await startDepositWatcher();
    } catch (err) {
      logger.error(err, "Failed to start deposit watcher — deposits will not be auto-detected");
    }
  }

  // ── 6. Start Health Server ──────────────────────────────
  startHealthServer();

  // ── 7. Start Indexer Cron ────────────────────────────────
  const intervalSeconds = Math.max(Math.ceil(config.indexer.intervalMs / 1000), 1);
  const cronExpr = `*/${intervalSeconds} * * * * *`;

  _cronTask = cron.schedule(cronExpr, async () => {
    try {
      await runIndexerCycle();
    } catch (err) {
      logger.error(err, "Indexer cron cycle error");
    }
  });

  logger.info({ intervalMs: config.indexer.intervalMs }, "Indexer cron started");

  // ── 7. Log Summary ──────────────────────────────────────

  const monitoredCount = await prisma.monitoredKey.count({
    where: { status: { not: "ARCHIVED" } },
  });

  logger.info("═══════════════════════════════════════════════");
  logger.info(`  Network:       ${config.stellar.networkPassphrase}`);
  logger.info(`  RPC:           ${config.stellar.rpcUrl}`);
  logger.info(`  Relayer Keys:  ${keyCount} active`);
  logger.info(`  Monitoring:    ${monitoredCount} keys`);
  logger.info(`  Interval:      ${config.indexer.intervalMs}ms`);
  logger.info("  Status:        🟢 RUNNING");
  logger.info("═══════════════════════════════════════════════");

  // ── 8. Graceful Shutdown ─────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    if (_cronTask) {
      _cronTask.stop();
      logger.info("Indexer cron stopped");
    }

    stopDepositWatcher();

    // Wait for relay queue to drain (with timeout)
    const drainStart = Date.now();
    while (getQueueDepth() > 0 && Date.now() - drainStart < 10_000) {
      logger.info({ queueDepth: getQueueDepth() }, "Draining relay queue...");
      await new Promise((r) => setTimeout(r, 1000));
    }

    await disconnectRedis();
    await disconnectPrisma();

    logger.info("Shutdown complete. Goodbye! 👋");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ─── Run ─────────────────────────────────────────────────────

main().catch((err) => {
  logger.fatal(err, "Fatal startup error");
  process.exit(1);
});
