import { getPrisma } from "../database/client.js";
import { formatDiscordEmbed, type NotificationPayload } from "./formatter.js";
import { logger } from "../utils/logger.js";

// ─── Webhook Dispatcher ─────────────────────────────────────
//
// Sends notification webhooks to user-configured endpoints.
// Supports Discord and Slack webhook formats.
//
// Non-blocking: failures are logged but never halt the pipeline.
// Rate-limited: max 5 notifications per user per minute.
// ─────────────────────────────────────────────────────────────

export { NotificationPayload };

export enum NotificationEvent {
  NEAR_EXPIRY = "NEAR_EXPIRY",
  CRITICAL = "CRITICAL",
  EXTENSION_SUCCESS = "EXTENSION_SUCCESS",
  EXTENSION_FAILED = "EXTENSION_FAILED",
  LOW_BALANCE = "LOW_BALANCE",
  DEPOSIT_RECEIVED = "DEPOSIT_RECEIVED",
}

// Simple in-memory rate limiter: userId → timestamps[]
const _rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 5; // max 5 notifications per user per window

/**
 * Send a notification to a user's configured webhook URL.
 * Non-blocking — failures are logged but don't throw.
 */
export async function sendNotification(
  userId: string,
  payload: NotificationPayload,
): Promise<void> {
  try {
    // Rate limit check
    if (isRateLimited(userId)) {
      logger.debug({ userId, event: payload.event }, "Notification rate-limited, skipping");
      return;
    }

    // Fetch user's webhook URL
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { webhookUrl: true },
    });

    if (!user?.webhookUrl) {
      logger.debug({ userId, event: payload.event }, "No webhook URL configured, skipping");
      return;
    }

    // Format the payload
    const body = formatDiscordEmbed(payload);

    // Send the webhook
    const response = await fetch(user.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    if (!response.ok) {
      logger.warn(
        { userId, event: payload.event, status: response.status },
        "Webhook delivery failed",
      );
    } else {
      logger.debug({ userId, event: payload.event }, "Webhook delivered");
      recordNotification(userId);
    }
  } catch (err) {
    // Non-blocking — log and continue
    logger.error({ userId, event: payload.event, error: err }, "Webhook dispatch error");
  }
}

/**
 * Check if a user has exceeded the rate limit.
 */
function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = _rateLimitMap.get(userId) ?? [];

  // Remove timestamps outside the window
  const recent = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  _rateLimitMap.set(userId, recent);

  return recent.length >= RATE_LIMIT_MAX;
}

/**
 * Record a sent notification for rate limiting.
 */
function recordNotification(userId: string): void {
  const timestamps = _rateLimitMap.get(userId) ?? [];
  timestamps.push(Date.now());
  _rateLimitMap.set(userId, timestamps);
}
