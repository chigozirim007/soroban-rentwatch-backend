import { getRedis } from "../database/redis.js";
import { logger } from "../utils/logger.js";

// ─── Deposit Cursor Persistence ──────────────────────────────
//
// Persists the Horizon payment stream cursor to Redis so the
// deposit watcher can resume from where it left off after a
// restart — no missed deposits.
// ─────────────────────────────────────────────────────────────

const CURSOR_KEY = "deposit:cursor";

/**
 * Save the current payment stream cursor.
 */
export async function saveCursor(cursor: string): Promise<void> {
  const redis = getRedis();
  await redis.set(CURSOR_KEY, cursor);
  logger.debug({ cursor }, "Deposit cursor saved");
}

/**
 * Load the last known cursor, or "now" for first run.
 */
export async function loadCursor(): Promise<string> {
  const redis = getRedis();
  const cursor = await redis.get(CURSOR_KEY);
  if (cursor) {
    logger.info({ cursor }, "Resuming deposit watcher from saved cursor");
  } else {
    logger.info("No saved cursor found, starting deposit watcher from 'now'");
  }
  return cursor ?? "now";
}
