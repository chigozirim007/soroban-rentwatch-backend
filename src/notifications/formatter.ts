import { ledgersToHumanTime } from "../indexer/evaluator.js";
import type { StorageType } from "@prisma/client";

// ─── Notification Formatter ──────────────────────────────────
//
// Formats notification payloads as Discord webhook embeds.
// Supports Slack-compatible format as well (same JSON structure).
// ─────────────────────────────────────────────────────────────

export enum NotificationColor {
  GREEN = 0x00d26a,   // Success
  YELLOW = 0xffc107,  // Warning
  RED = 0xff4444,     // Error / Critical
  BLUE = 0x2196f3,    // Info
}

export interface NotificationPayload {
  event: string;
  contractId: string;
  storageKind: StorageType;
  remaining: number;
  message: string;
  txHash?: string;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  footer: { text: string };
  timestamp: string;
}

/**
 * Format a notification payload into a Discord webhook embed.
 */
export function formatDiscordEmbed(payload: NotificationPayload): { embeds: DiscordEmbed[] } {
  const color = getEventColor(payload.event);
  const icon = getEventIcon(payload.event);
  const humanTime = ledgersToHumanTime(payload.remaining);

  const fields: DiscordEmbed["fields"] = [
    { name: "Contract", value: `\`${payload.contractId}\``, inline: true },
    { name: "Storage Type", value: payload.storageKind, inline: true },
    { name: "Remaining", value: `${humanTime} (${payload.remaining.toLocaleString()} ledgers)`, inline: true },
  ];

  if (payload.txHash && payload.txHash !== "SIMULATION_FAILED" && payload.txHash !== "ERROR") {
    fields.push({
      name: "Transaction",
      value: `[\`${payload.txHash.slice(0, 12)}...\`](https://stellar.expert/explorer/testnet/tx/${payload.txHash})`,
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title: `${icon} Soroban RentWatch — ${formatEventName(payload.event)}`,
        description: payload.message,
        color,
        fields,
        footer: { text: "Soroban RentWatch ⏳" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function getEventColor(event: string): number {
  switch (event) {
    case "EXTENSION_SUCCESS":
    case "DEPOSIT_RECEIVED":
      return NotificationColor.GREEN;
    case "NEAR_EXPIRY":
    case "LOW_BALANCE":
      return NotificationColor.YELLOW;
    case "CRITICAL":
    case "EXTENSION_FAILED":
      return NotificationColor.RED;
    default:
      return NotificationColor.BLUE;
  }
}

function getEventIcon(event: string): string {
  switch (event) {
    case "EXTENSION_SUCCESS": return "✅";
    case "DEPOSIT_RECEIVED": return "💰";
    case "NEAR_EXPIRY": return "⚠️";
    case "LOW_BALANCE": return "💸";
    case "CRITICAL": return "🔴";
    case "EXTENSION_FAILED": return "❌";
    default: return "📢";
  }
}

function formatEventName(event: string): string {
  return event
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}
