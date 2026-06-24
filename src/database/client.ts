import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger.js";

// ─── Singleton Prisma Client ─────────────────────────────────

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log: [
        { level: "error", emit: "event" },
        { level: "warn", emit: "event" },
      ],
    });

    // Forward Prisma logs to our structured logger
    _prisma.$on("error" as never, (e: unknown) => {
      logger.error(e, "Prisma error");
    });
    _prisma.$on("warn" as never, (e: unknown) => {
      logger.warn(e, "Prisma warning");
    });
  }

  return _prisma;
}

// ─── Graceful Shutdown ───────────────────────────────────────

export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
    logger.info("PostgreSQL connection closed");
  }
}
