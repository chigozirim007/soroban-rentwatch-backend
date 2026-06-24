import crypto from "crypto";

// ─── AES-256-GCM Encryption ─────────────────────────────────
//
// Used to encrypt Stellar relayer secret keys at rest in the
// database. The KEY_ENCRYPTION_SECRET from env acts as the KEK.
//
// This is a "software HSM" pattern — the interface is designed
// so swapping in a real HSM later only requires reimplementing
// these two functions.
// ─────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

export interface EncryptedPayload {
  ciphertext: string; // hex-encoded
  iv: string;         // hex-encoded
  authTag: string;    // hex-encoded
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * @param plaintext - The secret key to encrypt (e.g., Stellar secret "S...")
 * @param keyHex - 32-byte hex-encoded encryption key from environment
 * @returns Encrypted payload with ciphertext, IV, and auth tag
 */
export function encrypt(plaintext: string, keyHex: string): EncryptedPayload {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("KEY_ENCRYPTION_SECRET must be exactly 32 bytes (64 hex chars)");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted payload back to plaintext.
 *
 * @param payload - The encrypted payload (ciphertext, IV, auth tag)
 * @param keyHex - 32-byte hex-encoded encryption key from environment
 * @returns The original plaintext secret
 * @throws If authentication fails (tampered ciphertext)
 */
export function decrypt(payload: EncryptedPayload, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("KEY_ENCRYPTION_SECRET must be exactly 32 bytes (64 hex chars)");
  }

  const iv = Buffer.from(payload.iv, "hex");
  const authTag = Buffer.from(payload.authTag, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(payload.ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
