import express from "express";
import { getPrisma } from "../database/client.js";
import { getActiveKeyCount } from "../keys/manager.js";
import { getQueueDepth } from "../relayer/queue.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ─── Health / Status HTTP Server ─────────────────────────────
//
// Exposes a lightweight HTTP server for health checks and
// status monitoring. Useful for:
//   - Container orchestrators (Docker, Railway, Fly.io)
//   - Deployment health probes
//   - Quick operational dashboards
// ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.HEALTH_PORT ?? "3001");

export function startHealthServer(): void {
  const app = express();

  // GET /health — basic liveness probe
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // GET /status — detailed operational status
  app.get("/status", async (_req, res) => {
    try {
      const prisma = getPrisma();

      const [userCount, monitoredCount, activeRelayerKeys, txCount, statusCounts, queueDepth] =
        await Promise.all([
          prisma.user.count(),
          prisma.monitoredKey.count({ where: { status: { not: "ARCHIVED" } } }),
          getActiveKeyCount(),
          prisma.transactionLog.count(),
          prisma.monitoredKey.groupBy({
            by: ["status"],
            _count: { status: true },
          }),
          getQueueDepth(),
        ]);

      const statusBreakdown: Record<string, number> = {};
      for (const s of statusCounts) {
        statusBreakdown[s.status] = s._count.status;
      }

      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        network: config.stellar.networkPassphrase,
        depositAccount: config.deposit.accountPublic,
        relayerKeys: activeRelayerKeys,
        queueDepth,
        stats: {
          users: userCount,
          monitoredKeys: monitoredCount,
          transactions: txCount,
          statusBreakdown,
        },
      });
    } catch (err) {
      logger.error(err, "Health status check failed");
      res.status(500).json({ status: "error", error: String(err) });
    }
  });

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `Health server listening on :${PORT}`);
  });
}
