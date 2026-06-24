import { logger } from "../utils/logger.js";

// ─── Relay Queue ─────────────────────────────────────────────
//
// FIFO queue for TTL extension jobs. Sequential processing per
// relayer key prevents sequence number conflicts from parallel
// submissions on the same Stellar account.
//
// Deduplication: if a keyId is already queued, skip it.
// ─────────────────────────────────────────────────────────────

type QueueProcessor = (keyId: string) => Promise<void>;

const _queue: string[] = [];
const _queued = new Set<string>();
let _processing = false;
let _processor: QueueProcessor | null = null;

/**
 * Set the function that processes each queued key ID.
 * Called once during system startup.
 */
export function setQueueProcessor(processor: QueueProcessor): void {
  _processor = processor;
}

/**
 * Add a monitored key ID to the relay queue.
 * Deduplicates — if already queued, this is a no-op.
 */
export function enqueueExtension(keyId: string): void {
  if (_queued.has(keyId)) {
    logger.debug({ keyId }, "Key already in relay queue, skipping");
    return;
  }

  _queue.push(keyId);
  _queued.add(keyId);
  logger.info({ keyId, queueDepth: _queue.length }, "Key enqueued for TTL extension");

  if (_queue.length > 50) {
    logger.warn({ queueDepth: _queue.length }, "Relay queue depth is high — system may be falling behind");
  }

  // Start processing if not already running
  processQueue();
}

/**
 * Process the queue sequentially.
 */
async function processQueue(): Promise<void> {
  if (_processing) return;
  if (!_processor) {
    logger.error("Queue processor not set — call setQueueProcessor() first");
    return;
  }

  _processing = true;

  while (_queue.length > 0) {
    const keyId = _queue.shift()!;
    _queued.delete(keyId);

    try {
      await _processor(keyId);
    } catch (err) {
      logger.error({ keyId, error: err }, "Queue processor failed for key");
    }
  }

  _processing = false;
}

/**
 * Get current queue depth (for monitoring/health checks).
 */
export function getQueueDepth(): number {
  return _queue.length;
}

/**
 * Check if the queue is currently processing.
 */
export function isProcessing(): boolean {
  return _processing;
}
