import { Keypair } from "@stellar/stellar-sdk";
import { getPrisma } from "../database/client.js";
import { encrypt, decrypt } from "./crypto.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ─── Key Manager ─────────────────────────────────────────────
//
// Manages relayer signing keys with rotation lifecycle:
//
//   ACTIVE  →  DEPRECATED  →  RETIRED
//  (signing)  (verify only)   (audit only)
//
// Keys are encrypted at rest using AES-256-GCM. Selection uses
// round-robin across all ACTIVE keys for load distribution.
// ─────────────────────────────────────────────────────────────

// Track round-robin index in memory
let _roundRobinIndex = 0;

/**
 * Add a new relayer signing key (encrypted at rest).
 * Returns the generated UUID and public key.
 */
export async function addKey(secretKey: string): Promise<{ id: string; publicKey: string }> {
  const prisma = getPrisma();
  const keypair = Keypair.fromSecret(secretKey);
  const publicKey = keypair.publicKey();

  // Check for duplicate public keys
  const existing = await prisma.relayerKey.findUnique({
    where: { publicKey },
  });
  if (existing) {
    throw new Error(`Relayer key already exists: ${publicKey}`);
  }

  // Determine next key version
  const maxVersion = await prisma.relayerKey.aggregate({
    _max: { keyVersion: true },
  });
  const nextVersion = (maxVersion._max.keyVersion ?? 0) + 1;

  // Encrypt the secret
  const encrypted = encrypt(secretKey, config.keys.encryptionSecret);

  const key = await prisma.relayerKey.create({
    data: {
      publicKey,
      encryptedSecret: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyVersion: nextVersion,
      status: "ACTIVE",
    },
  });

  logger.info({ publicKey, version: nextVersion }, "Relayer key added");
  return { id: key.id, publicKey };
}

/**
 * Get an active relayer key using round-robin selection.
 * Returns the decrypted Keypair and the key's database ID.
 */
export async function getActiveKey(): Promise<{ keypair: Keypair; keyId: string } | null> {
  const prisma = getPrisma();

  const activeKeys = await prisma.relayerKey.findMany({
    where: { status: "ACTIVE" },
    orderBy: { keyVersion: "asc" },
  });

  if (activeKeys.length === 0) {
    logger.error("No active relayer keys available!");
    return null;
  }

  // Round-robin selection
  const index = _roundRobinIndex % activeKeys.length;
  _roundRobinIndex = (_roundRobinIndex + 1) % activeKeys.length;
  const selected = activeKeys[index];

  // Decrypt the secret key
  const secret = decrypt(
    {
      ciphertext: selected.encryptedSecret,
      iv: selected.iv,
      authTag: selected.authTag,
    },
    config.keys.encryptionSecret,
  );

  // Update last used timestamp (fire-and-forget)
  prisma.relayerKey
    .update({
      where: { id: selected.id },
      data: { lastUsedAt: new Date() },
    })
    .catch((err) => logger.error(err, "Failed to update lastUsedAt"));

  return {
    keypair: Keypair.fromSecret(secret),
    keyId: selected.id,
  };
}

/**
 * Rotate a key: deprecate the old one and add a new one as ACTIVE.
 */
export async function rotateKey(
  oldKeyId: string,
  newSecretKey: string,
): Promise<{ id: string; publicKey: string }> {
  const prisma = getPrisma();

  // Deprecate old key
  await prisma.relayerKey.update({
    where: { id: oldKeyId },
    data: { status: "DEPRECATED" },
  });

  logger.info({ oldKeyId }, "Relayer key deprecated");

  // Add new key as ACTIVE
  return addKey(newSecretKey);
}

/**
 * Retire a deprecated key (no longer used, kept for audit trail).
 */
export async function retireKey(keyId: string): Promise<void> {
  const prisma = getPrisma();

  await prisma.relayerKey.update({
    where: { id: keyId },
    data: { status: "RETIRED" },
  });

  logger.info({ keyId }, "Relayer key retired");
}

/**
 * List all relayer keys with their status (secrets excluded).
 */
export async function listKeys(): Promise<
  Array<{
    id: string;
    publicKey: string;
    keyVersion: number;
    status: string;
    lastUsedAt: Date | null;
    createdAt: Date;
  }>
> {
  const prisma = getPrisma();

  return prisma.relayerKey.findMany({
    select: {
      id: true,
      publicKey: true,
      keyVersion: true,
      status: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: { keyVersion: "desc" },
  });
}

/**
 * Get the count of active relayer keys.
 */
export async function getActiveKeyCount(): Promise<number> {
  const prisma = getPrisma();
  return prisma.relayerKey.count({ where: { status: "ACTIVE" } });
}
