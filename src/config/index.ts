import dotenv from "dotenv";
import path from "path";

// Load .env from the project root (one level above backend/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// ─── Helpers ─────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`❌ Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`❌ Environment variable ${key} must be an integer, got: "${raw}"`);
  }
  return parsed;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    throw new Error(`❌ Environment variable ${key} must be a number, got: "${raw}"`);
  }
  return parsed;
}

// ─── Configuration Object ────────────────────────────────────

export const config = {
  stellar: {
    rpcUrl: requireEnv("SOROBAN_RPC_URL"),
    horizonUrl: requireEnv("HORIZON_URL"),
    networkPassphrase: requireEnv("NETWORK_PASSPHRASE"),
  },

  database: {
    url: requireEnv("DATABASE_URL"),
  },

  redis: {
    url: requireEnv("REDIS_URL"),
  },

  keys: {
    encryptionSecret: requireEnv("KEY_ENCRYPTION_SECRET"),
  },

  deposit: {
    accountPublic: requireEnv("DEPOSIT_ACCOUNT_PUBLIC"),
  },

  indexer: {
    intervalMs: envInt("INDEXER_INTERVAL_MS", 30_000),
    batchSize: envInt("INDEXER_BATCH_SIZE", 200),
    maxConcurrency: envInt("INDEXER_MAX_CONCURRENCY", 3),
  },

  relayer: {
    minBalanceXlm: envFloat("MIN_BALANCE_XLM", 1.0),
    queueConcurrency: envInt("RELAY_QUEUE_CONCURRENCY", 1),
  },

  logging: {
    level: optionalEnv("LOG_LEVEL", "info"),
  },
} as const;

export type Config = typeof config;
