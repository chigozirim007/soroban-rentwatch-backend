import type { TrackingStatus } from "@prisma/client";

// ─── TTL Evaluator ───────────────────────────────────────────
//
// Pure functions for determining contract health status based
// on remaining ledger count. Soroban produces ~1 ledger every
// 5 seconds, giving us these reference points:
//
//   720 ledgers     ≈  1 hour
//   17,280 ledgers  ≈  1 day
//   120,960 ledgers ≈  1 week
//   518,400 ledgers ≈  30 days
// ─────────────────────────────────────────────────────────────

const CRITICAL_FLOOR = 5_000; // ~6.9 hours — emergency threshold
const SECONDS_PER_LEDGER = 5;

/**
 * Evaluate the tracking status based on remaining ledger life.
 *
 * @param remaining   - Ledgers remaining before archival
 * @param threshold   - User-configured warning threshold (default 15,000)
 * @returns The appropriate tracking status
 */
export function evaluateStatus(remaining: number, threshold: number): TrackingStatus {
  if (remaining <= 0) return "ARCHIVED";
  if (remaining <= CRITICAL_FLOOR) return "CRITICAL";
  if (remaining <= threshold) return "NEAR_EXPIRY";
  return "HEALTHY";
}

/**
 * Convert a ledger count to a human-readable time string.
 *
 * @param ledgers - Number of ledgers
 * @returns Human-readable string like "~4.2 days" or "~2.3 hours"
 */
export function ledgersToHumanTime(ledgers: number): string {
  const totalSeconds = ledgers * SECONDS_PER_LEDGER;
  const minutes = totalSeconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;

  if (days >= 1) return `~${days.toFixed(1)} days`;
  if (hours >= 1) return `~${hours.toFixed(1)} hours`;
  if (minutes >= 1) return `~${minutes.toFixed(0)} minutes`;
  return `~${totalSeconds.toFixed(0)} seconds`;
}

/**
 * Check if a status transition has occurred.
 * Returns true if the status has changed in a notable way.
 */
export function isStatusTransition(
  oldStatus: TrackingStatus | null,
  newStatus: TrackingStatus,
): boolean {
  if (!oldStatus) return false; // First check — no transition
  return oldStatus !== newStatus;
}
