import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets at rest (TOTP seeds). Layout: iv(12) | tag(16) | ciphertext.
 * The key comes from env/Docker secret (MFA_ENC_KEY, 32 bytes base64) and is never stored in the DB.
 */
export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes, base64-encoded");
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptSecret(blob: Buffer, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}

/** SIMULATED MFA: every seeded demo user shares this well-known TOTP secret (documented, demo-only). */
export const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
/** LOCAL-DEV-ONLY key (32 bytes). Production must inject its own MFA_ENC_KEY. */
export const LOCAL_DEV_MFA_KEY = Buffer.from("fincore-local-dev-only-mfa-key!!").toString("base64");
