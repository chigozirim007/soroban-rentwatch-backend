import { parseArgs } from "node:util";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";

// Load env before anything else
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { getPrisma, disconnectPrisma } from "../database/client.js";
import { addKey, rotateKey, getActiveKeyCount } from "../keys/manager.js";
import { generateInstanceKeyXdr, generatePersistentDataKeyXdr, generateContractCodeKeyXdr } from "./keygen.js";
import { getQueueDepth } from "../relayer/queue.js";

// ─── CLI Entry Point ─────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  try {
    switch (command) {
      case "register-user":
        await registerUser(args.slice(1));
        break;
      case "add-key":
        await addMonitoredKey(args.slice(1));
        break;
      case "list-keys":
        await listMonitoredKeys(args.slice(1));
        break;
      case "check-balance":
        await checkBalance(args.slice(1));
        break;
      case "add-relayer-key":
        await addRelayerKey(args.slice(1));
        break;
      case "rotate-key":
        await rotateRelayerKey(args.slice(1));
        break;
      case "fund-pool":
        await fundPool(args.slice(1));
        break;
      case "status":
        await systemStatus();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } finally {
    await disconnectPrisma();
  }
}

// ─── Commands ────────────────────────────────────────────────

async function registerUser(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "public-key": { type: "string" },
      "webhook-url": { type: "string" },
    },
  });

  const publicKey = values["public-key"];
  if (!publicKey) {
    console.error("Error: --public-key is required");
    process.exit(1);
  }

  if (!publicKey.startsWith("G") || publicKey.length !== 56) {
    console.error("Error: Invalid Stellar public key (must start with G, 56 chars)");
    process.exit(1);
  }

  const prisma = getPrisma();
  const depositMemo = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  const user = await prisma.user.create({
    data: {
      publicKey,
      depositMemo,
      webhookUrl: values["webhook-url"] ?? undefined,
    },
  });

  // Create an empty balance pool
  await prisma.balancePool.create({
    data: { userId: user.id, xlmBalance: 0 },
  });

  console.log("\n✅ User registered successfully!");
  console.log(`   ID:          ${user.id}`);
  console.log(`   Public Key:  ${publicKey}`);
  console.log(`   Deposit Memo: ${depositMemo}`);
  console.log(`   Webhook:     ${values["webhook-url"] ?? "(not set)"}`);
  console.log(`\n💡 To fund this account, send XLM to the deposit address`);
  console.log(`   with memo: ${depositMemo}\n`);
}

async function addMonitoredKey(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "user": { type: "string" },
      "contract": { type: "string" },
      "storage": { type: "string" },
      "key-xdr": { type: "string" },
      "symbol": { type: "string" },
      "threshold": { type: "string" },
      "extend-to": { type: "string" },
    },
  });

  const userPublicKey = values["user"];
  const contractId = values["contract"];
  const storageType = values["storage"];

  if (!userPublicKey || !contractId || !storageType) {
    console.error("Error: --user, --contract, and --storage are required");
    process.exit(1);
  }

  // Map storage type string to enum
  const storageMap: Record<string, string> = {
    instance: "INSTANCE",
    persistent: "PERSISTENT",
    contract_code: "CONTRACT_CODE",
  };

  const storageKind = storageMap[storageType.toLowerCase()];
  if (!storageKind) {
    console.error("Error: --storage must be one of: instance, persistent, contract_code");
    process.exit(1);
  }

  // Get or generate the LedgerKey XDR
  let targetKeyXdr = values["key-xdr"];

  if (!targetKeyXdr) {
    console.log("No --key-xdr provided, auto-generating...");
    switch (storageKind) {
      case "INSTANCE":
        targetKeyXdr = generateInstanceKeyXdr(contractId);
        break;
      case "PERSISTENT":
        if (!values["symbol"]) {
          console.error("Error: --symbol is required for persistent storage without --key-xdr");
          process.exit(1);
        }
        targetKeyXdr = generatePersistentDataKeyXdr(contractId, values["symbol"]);
        break;
      case "CONTRACT_CODE": {
        const codeXdr = await generateContractCodeKeyXdr(contractId);
        if (!codeXdr) {
          console.error("Error: Could not find contract instance on ledger");
          process.exit(1);
        }
        targetKeyXdr = codeXdr;
        break;
      }
    }
  }

  const prisma = getPrisma();

  const user = await prisma.user.findUnique({ where: { publicKey: userPublicKey } });
  if (!user) {
    console.error(`Error: User not found: ${userPublicKey}`);
    process.exit(1);
  }

  const key = await prisma.monitoredKey.create({
    data: {
      userId: user.id,
      contractId,
      targetKeyXdr: targetKeyXdr!,
      storageKind: storageKind as "INSTANCE" | "PERSISTENT" | "CONTRACT_CODE",
      thresholdLedgers: values["threshold"] ? parseInt(values["threshold"]) : 15_000,
      extendToLedgers: values["extend-to"] ? parseInt(values["extend-to"]) : 100_000,
    },
  });

  console.log("\n✅ Monitored key added!");
  console.log(`   ID:         ${key.id}`);
  console.log(`   Contract:   ${contractId}`);
  console.log(`   Storage:    ${storageKind}`);
  console.log(`   Threshold:  ${key.thresholdLedgers.toLocaleString()} ledgers`);
  console.log(`   Extend To:  ${key.extendToLedgers.toLocaleString()} ledgers\n`);
}

async function listMonitoredKeys(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { "user": { type: "string" } } });
  const userPublicKey = values["user"];

  if (!userPublicKey) {
    console.error("Error: --user is required");
    process.exit(1);
  }

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { publicKey: userPublicKey } });
  if (!user) {
    console.error(`Error: User not found: ${userPublicKey}`);
    process.exit(1);
  }

  const keys = await prisma.monitoredKey.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
  });

  if (keys.length === 0) {
    console.log("\nNo monitored keys found.\n");
    return;
  }

  console.log(`\n📋 Monitored Keys for ${userPublicKey.slice(0, 8)}...${userPublicKey.slice(-4)}\n`);
  console.log("ID                                   | Contract        | Storage      | Status      | Remaining");
  console.log("─".repeat(100));

  for (const key of keys) {
    const remaining = key.liveUntilLedger && key.lastCheckedLedger
      ? key.liveUntilLedger - key.lastCheckedLedger
      : "?";
    console.log(
      `${key.id} | ${key.contractId.slice(0, 12)}... | ${key.storageKind.padEnd(12)} | ${key.status.padEnd(11)} | ${remaining}`,
    );
  }
  console.log();
}

async function checkBalance(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { "user": { type: "string" } } });
  const userPublicKey = values["user"];

  if (!userPublicKey) {
    console.error("Error: --user is required");
    process.exit(1);
  }

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { publicKey: userPublicKey },
    include: { balancePool: true, deposits: { orderBy: { createdAt: "desc" }, take: 5 } },
  });

  if (!user) {
    console.error(`Error: User not found: ${userPublicKey}`);
    process.exit(1);
  }

  const balance = user.balancePool?.xlmBalance ?? 0;
  console.log(`\n💰 Balance: ${Number(balance).toFixed(7)} XLM`);
  console.log(`   Deposit Memo: ${user.depositMemo}`);

  if (user.deposits.length > 0) {
    console.log(`\n   Recent Deposits:`);
    for (const dep of user.deposits) {
      console.log(`   ${Number(dep.amount).toFixed(7)} XLM — ${dep.createdAt.toISOString()}`);
    }
  }
  console.log();
}

async function addRelayerKey(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { "secret": { type: "string" } } });
  const secret = values["secret"];

  if (!secret) {
    console.error("Error: --secret is required");
    process.exit(1);
  }

  if (!secret.startsWith("S") || secret.length !== 56) {
    console.error("Error: Invalid Stellar secret key (must start with S, 56 chars)");
    process.exit(1);
  }

  const result = await addKey(secret);
  console.log(`\n✅ Relayer key added!`);
  console.log(`   ID:         ${result.id}`);
  console.log(`   Public Key: ${result.publicKey}\n`);
}

async function rotateRelayerKey(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "old-key-id": { type: "string" },
      "new-secret": { type: "string" },
    },
  });

  if (!values["old-key-id"] || !values["new-secret"]) {
    console.error("Error: --old-key-id and --new-secret are required");
    process.exit(1);
  }

  const result = await rotateKey(values["old-key-id"], values["new-secret"]);
  console.log(`\n✅ Key rotated!`);
  console.log(`   New Key ID: ${result.id}`);
  console.log(`   Public Key: ${result.publicKey}\n`);
}

async function fundPool(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "user": { type: "string" },
      "amount": { type: "string" },
    },
  });

  if (!values["user"] || !values["amount"]) {
    console.error("Error: --user and --amount are required");
    process.exit(1);
  }

  const amount = parseFloat(values["amount"]);
  if (isNaN(amount) || amount <= 0) {
    console.error("Error: --amount must be a positive number");
    process.exit(1);
  }

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { publicKey: values["user"] } });
  if (!user) {
    console.error(`Error: User not found: ${values["user"]}`);
    process.exit(1);
  }

  await prisma.balancePool.upsert({
    where: { userId: user.id },
    update: { xlmBalance: { increment: amount } },
    create: { userId: user.id, xlmBalance: amount },
  });

  console.log(`\n✅ Funded ${amount.toFixed(7)} XLM to ${values["user"].slice(0, 8)}...\n`);
}

async function systemStatus(): Promise<void> {
  const prisma = getPrisma();

  const [userCount, keyCount, activeKeyCount, txCount, queueDepth] = await Promise.all([
    prisma.user.count(),
    prisma.monitoredKey.count(),
    getActiveKeyCount(),
    prisma.transactionLog.count(),
    getQueueDepth(),
  ]);

  const statusCounts = await prisma.monitoredKey.groupBy({
    by: ["status"],
    _count: { status: true },
  });

  console.log("\n⏳ Soroban RentWatch — System Status\n");
  console.log(`   Users:          ${userCount}`);
  console.log(`   Monitored Keys: ${keyCount}`);
  console.log(`   Relayer Keys:   ${activeKeyCount} active`);
  console.log(`   Relay Queue:    ${queueDepth} pending`);
  console.log(`   Total Txns:     ${txCount}`);
  console.log();

  if (statusCounts.length > 0) {
    console.log("   Status Breakdown:");
    for (const s of statusCounts) {
      const icon = s.status === "HEALTHY" ? "🟢" : s.status === "NEAR_EXPIRY" ? "🟡" : s.status === "CRITICAL" ? "🔴" : "⚫";
      console.log(`   ${icon} ${s.status.padEnd(12)}: ${s._count.status}`);
    }
    console.log();
  }
}

// ─── Usage ───────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
⏳ Soroban RentWatch CLI

Usage:
  npm run cli -- <command> [options]

Commands:
  register-user    --public-key <G...> [--webhook-url <URL>]
  add-key          --user <G...> --contract <C...> --storage <instance|persistent|contract_code>
                   [--key-xdr <BASE64>] [--symbol <NAME>] [--threshold <15000>] [--extend-to <100000>]
  list-keys        --user <G...>
  check-balance    --user <G...>
  add-relayer-key  --secret <S...>
  rotate-key       --old-key-id <UUID> --new-secret <S...>
  fund-pool        --user <G...> --amount <XLM>
  status
`);
}

// ─── Run ─────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
