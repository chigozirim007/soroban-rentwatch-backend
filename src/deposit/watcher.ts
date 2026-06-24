import { Horizon } from "@stellar/stellar-sdk";
import { getHorizonServer } from "../config/stellar.js";
import { config } from "../config/index.js";
import { getPrisma } from "../database/client.js";
import { saveCursor, loadCursor } from "./cursor.js";
import { sendNotification, NotificationEvent } from "../notifications/webhook.js";
import { logger } from "../utils/logger.js";

// ─── Deposit Watcher ─────────────────────────────────────────
//
// Streams incoming XLM payments to the platform's deposit
// account via Horizon. Identifies users by transaction memo,
// credits their balance pool, and logs every deposit.
//
// Resilience:
//   - Cursor persistence: resumes from last processed payment
//   - Idempotency: DepositLog.txHash is UNIQUE
//   - Auto-reconnect: Horizon stream reconnects on disconnect
// ─────────────────────────────────────────────────────────────

let _closeStream: (() => void) | null = null;

/**
 * Start the deposit watcher stream.
 */
export async function startDepositWatcher(): Promise<void> {
  const horizon = getHorizonServer();
  const depositAccount = config.deposit.accountPublic;
  const cursor = await loadCursor();

  logger.info({ depositAccount, cursor }, "Starting deposit watcher");

  // Stream all payment-like operations, filter inside handler
  const streamClose = horizon
    .payments()
    .forAccount(depositAccount)
    .cursor(cursor)
    .stream({
      onmessage: async (record) => {
        try {
          await processPayment(record, depositAccount);
        } catch (err) {
          logger.error({ error: err, paymentId: record.id }, "Error processing payment");
        }
      },
      onerror: (error: unknown) => {
        logger.error({ error }, "Deposit stream error — will auto-reconnect");
      },
    });

  _closeStream = streamClose as unknown as () => void;
  logger.info("Deposit watcher stream active");
}

/**
 * Stop the deposit watcher stream gracefully.
 */
export function stopDepositWatcher(): void {
  if (_closeStream) {
    _closeStream();
    _closeStream = null;
    logger.info("Deposit watcher stream stopped");
  }
}

/**
 * Process a single incoming payment record.
 */
async function processPayment(
  record: Horizon.ServerApi.PaymentOperationRecord | Horizon.ServerApi.CreateAccountOperationRecord | Horizon.ServerApi.AccountMergeOperationRecord | Horizon.ServerApi.PathPaymentOperationRecord | Horizon.ServerApi.PathPaymentStrictSendOperationRecord | Horizon.ServerApi.InvokeHostFunctionOperationRecord,
  depositAccount: string,
): Promise<void> {
  // Only process standard 'payment' type operations
  if (record.type !== "payment") return;
  const payment = record as Horizon.ServerApi.PaymentOperationRecord;
  if (payment.to !== depositAccount) return;
  if (payment.asset_type !== "native") return;

  const prisma = getPrisma();

  // Fetch the parent transaction to get the memo
  const txRecord = await payment.transaction();
  const memo = txRecord.memo;

  if (!memo || txRecord.memo_type === "none") {
    logger.debug({ txHash: txRecord.hash }, "Payment has no memo, ignoring");
    await saveCursor(payment.paging_token);
    return;
  }

  // Look up user by deposit memo
  const user = await prisma.user.findUnique({
    where: { depositMemo: memo },
  });

  if (!user) {
    logger.warn({ memo, txHash: txRecord.hash }, "Unknown deposit memo — payment ignored");
    await saveCursor(payment.paging_token);
    return;
  }

  // Idempotency: check if we've already processed this tx
  const existing = await prisma.depositLog.findUnique({
    where: { txHash: txRecord.hash },
  });

  if (existing) {
    logger.debug({ txHash: txRecord.hash }, "Deposit already processed, skipping");
    await saveCursor(payment.paging_token);
    return;
  }

  const amount = parseFloat(payment.amount);

  // Credit balance + log deposit atomically
  await prisma.$transaction([
    prisma.balancePool.upsert({
      where: { userId: user.id },
      update: { xlmBalance: { increment: amount } },
      create: { userId: user.id, xlmBalance: amount },
    }),
    prisma.depositLog.create({
      data: {
        userId: user.id,
        txHash: txRecord.hash,
        amount,
        memo,
        sourceAccount: payment.from,
        ledgerSeq: txRecord.ledger_attr,
      },
    }),
  ]);

  logger.info(
    { userId: user.id, amount, memo, txHash: txRecord.hash },
    "💰 Deposit credited",
  );

  // Notify user
  await sendNotification(user.id, {
    event: NotificationEvent.DEPOSIT_RECEIVED,
    contractId: "N/A",
    storageKind: "INSTANCE",
    remaining: 0,
    message: `Deposit received: ${amount.toFixed(7)} XLM. Your balance has been updated.`,
    txHash: txRecord.hash,
  });

  // Persist cursor for crash recovery
  await saveCursor(payment.paging_token);
}
