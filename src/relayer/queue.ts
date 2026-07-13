import { Queue, Worker, Job } from "bullmq";
import { getRedis } from "../database/redis.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

// ─── Relay Queue (BullMQ) ────────────────────────────────────
//
// Reliable Redis-backed queue for TTL extension jobs.
// Supports concurrency, automatic retries with exponential 
// backoff, and state persistence.
// ─────────────────────────────────────────────────────────────

type QueueProcessor = (keyId: string) => Promise<void>;

const QUEUE_NAME = "relayer-queue";
let relayQueue: Queue | null = null;
let relayWorker: Worker | null = null;

/**
 * Initialize the BullMQ queue and worker.
 * Called once during system startup.
 */
export function setQueueProcessor(processor: QueueProcessor): void {
  const connection = getRedis();

  relayQueue = new Queue(QUEUE_NAME, {
    connection: connection as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
      removeOnComplete: true,
      removeOnFail: false, // Keep failed jobs for inspection
    },
  });

  relayWorker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { keyId } = job.data;
      await processor(keyId);
    },
    {
      connection: connection as any,
      concurrency: config.relayer.queueConcurrency ?? 3,
    }
  );

  relayWorker.on("completed", (job) => {
    logger.debug({ jobId: job.id, keyId: job.data.keyId }, "Relay job completed");
  });

  relayWorker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, keyId: job?.data?.keyId, error: err }, "Relay job failed");
  });

  logger.info({ concurrency: config.relayer.queueConcurrency ?? 3 }, "BullMQ relayer queue initialized");
}

/**
 * Add a monitored key ID to the relay queue.
 * BullMQ handles deduplication if jobId is provided, but since we 
 * might want to retry later, we just enqueue it. The indexer handles 
 * rate-limiting enqueues.
 */
export async function enqueueExtension(keyId: string): Promise<void> {
  if (!relayQueue) {
    logger.warn("Relay queue not initialized, cannot enqueue");
    return;
  }

  // Use the keyId as jobId to prevent multiple instances of the exact same key being enqueued simultaneously
  await relayQueue.add("extend", { keyId }, { jobId: keyId });
  logger.info({ keyId }, "Key enqueued for TTL extension (BullMQ)");
}

/**
 * Get current queue depth (for monitoring/health checks).
 */
export async function getQueueDepth(): Promise<number> {
  if (!relayQueue) return 0;
  return await relayQueue.count();
}

/**
 * Stop the queue worker gracefully.
 */
export async function stopQueue(): Promise<void> {
  if (relayWorker) {
    await relayWorker.close();
  }
}
