import Redis from "ioredis";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface TTLDelta {
  liveUntil: number;
  remaining: number;
  lastChecked: number;
  status: string;
}

// ─── Singleton Redis Client ──────────────────────────────────

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        const delay = Math.min(times * 200, 5000);
        logger.warn({ attempt: times, delayMs: delay }, "Redis reconnecting");
        return delay;
      },
      lazyConnect: true,
    });

    _redis.on("connect", () => logger.info("Redis connected"));
    _redis.on("error", (err) => logger.error(err, "Redis error"));
  }

  return _redis;
}

export async function connectRedis(): Promise<void> {
  const redis = getRedis();
  await redis.connect();
}

export async function disconnectRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
    logger.info("Redis connection closed");
  }
}

// ─── TTL Delta Cache Operations ──────────────────────────────

const TTL_PREFIX = "ttl:";
const TTL_EXPIRY_SECONDS = Math.ceil((config.indexer.intervalMs * 2) / 1000);

export async function setTTLDelta(keyId: string, delta: TTLDelta): Promise<void> {
  const redis = getRedis();
  await redis.setex(`${TTL_PREFIX}${keyId}`, TTL_EXPIRY_SECONDS, JSON.stringify(delta));
}

export async function getTTLDelta(keyId: string): Promise<TTLDelta | null> {
  const redis = getRedis();
  const raw = await redis.get(`${TTL_PREFIX}${keyId}`);
  if (!raw) return null;
  return JSON.parse(raw) as TTLDelta;
}

export async function getCriticalKeys(): Promise<string[]> {
  const redis = getRedis();
  const keys = await redis.keys(`${TTL_PREFIX}*`);
  const criticalIds: string[] = [];

  if (keys.length === 0) return criticalIds;

  // Pipeline for efficient batch reads
  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.get(key);
  }
  const results = await pipeline.exec();

  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, raw] = results[i];
      if (err || !raw) continue;
      const delta = JSON.parse(raw as string) as TTLDelta;
      if (delta.status === "CRITICAL") {
        // Extract keyId from "ttl:{keyId}"
        criticalIds.push(keys[i].slice(TTL_PREFIX.length));
      }
    }
  }

  return criticalIds;
}

// ─── Deposit Cursor Persistence ──────────────────────────────

const CURSOR_KEY = "deposit:cursor";

export async function saveDepositCursor(cursor: string): Promise<void> {
  const redis = getRedis();
  await redis.set(CURSOR_KEY, cursor);
}

export async function loadDepositCursor(): Promise<string> {
  const redis = getRedis();
  const cursor = await redis.get(CURSOR_KEY);
  return cursor ?? "now";
}
