// Field-level encryption for confidential Postgres columns.
//
// Confidentiality TSC + CC6.1. Neon Postgres encrypts everything at
// rest at the volume layer, but a DB-admin (or anyone with a leaked
// connection string) can read plaintext rows. Field-level encryption
// limits the blast radius: even with full DB access, the confidential
// columns are useless without `FIELD_ENCRYPTION_KEY`.
//
// What gets encrypted (per docs/policies/data-classification.md):
//   - JournalEntry.memo
//   - BankStatementLine.description (recon)
//   - EmailDelivery.bodyText / .bodyHtml / .subject
//   - Party.displayName (longer term — currently INTERNAL-leaning)
//
// What DOESN'T get encrypted:
//   - Lookup keys (entityCode, partyCode) — needed for queries
//   - Identifiers (id, tenantId) — joins depend on them
//   - Money amounts — needed for aggregation + reports
//
// Cryptography:
//   - AES-256-GCM. The standard authenticated cipher in node:crypto.
//   - 256-bit key from env (FIELD_ENCRYPTION_KEY, 64 hex chars).
//   - 96-bit IV (12 bytes), randomly generated per encrypt.
//   - 128-bit GCM auth tag, validated on decrypt — tampered ciphertext
//     decrypts to an exception, not garbage plaintext.
//
// Wire format (base64):
//   [1-byte version][12-byte IV][N-byte ciphertext][16-byte tag]
//
// Version byte enables future key rotation: v1 today; v2 would mean
// a new key, with decrypt routing to the right key. Implementation
// keeps v1 only for now; rotation is a follow-up.
//
// Key management:
//   - Today: FIELD_ENCRYPTION_KEY env var (Vercel secret). Rotated
//     manually via the policy in docs/policies/access-control.md.
//   - Future: AWS KMS / Vercel Secrets / GCP KMS — drop-in via
//     `loadKey()` swap.
//
// Performance: ~80μs per encrypt/decrypt on M2. Negligible vs the
// Postgres round-trip (10-50ms).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_V1 = 0x01;
const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16; // GCM standard
const KEY_BYTES = 32; // AES-256

export class FieldEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldEncryptionError";
  }
}

export class KeyNotConfiguredError extends FieldEncryptionError {
  constructor() {
    super(
      "FIELD_ENCRYPTION_KEY env var is not set. Confidential columns " +
        "cannot be encrypted. Generate a 32-byte key " +
        "(`openssl rand -hex 32`) and set in Vercel."
    );
    this.name = "KeyNotConfiguredError";
  }
}

let cachedKey: Buffer | null = null;

/**
 * Load the encryption key from env. Cached after first load (called
 * on every encrypt/decrypt). Throws KeyNotConfiguredError when the
 * env var is missing — call sites should surface a clear message.
 *
 * Test seam: `_setKeyForTesting(key)` lets unit tests inject a known
 * key without env var manipulation.
 */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex) throw new KeyNotConfiguredError();
  if (hex.length !== KEY_BYTES * 2) {
    throw new FieldEncryptionError(
      `FIELD_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex chars ` +
        `(${KEY_BYTES}-byte key); got ${hex.length} chars.`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new FieldEncryptionError(
      "FIELD_ENCRYPTION_KEY must be hex-encoded (0-9, a-f)."
    );
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

/**
 * Encrypt a plaintext string with AES-256-GCM. Returns a base64-
 * encoded blob in the wire format documented above. Empty / null /
 * undefined returns null — DB column should be nullable; encrypting
 * empty wastes 30+ bytes per row.
 */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return null;
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // [1-byte version][12-byte IV][N-byte ciphertext][16-byte tag]
  const blob = Buffer.concat([
    Buffer.from([VERSION_V1]),
    iv,
    encrypted,
    tag,
  ]);
  return blob.toString("base64");
}

/**
 * Decrypt a base64 blob produced by encryptField. Throws
 * FieldEncryptionError if:
 *   - the version byte isn't recognized (likely wrong key or wrong table)
 *   - the GCM auth tag fails (data tampered, wrong key, or corruption)
 *
 * Returns null on null/empty input — symmetric with encryptField.
 */
export function decryptField(blob: string | null | undefined): string | null {
  if (blob == null || blob === "") return null;
  const key = loadKey();
  let raw: Buffer;
  try {
    raw = Buffer.from(blob, "base64");
  } catch {
    throw new FieldEncryptionError("Encrypted blob is not valid base64.");
  }
  if (raw.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new FieldEncryptionError(
      `Encrypted blob is too short (${raw.length} bytes; need ≥ ${
        1 + IV_BYTES + TAG_BYTES
      }).`
    );
  }
  const version = raw[0];
  if (version !== VERSION_V1) {
    throw new FieldEncryptionError(
      `Unknown encryption version ${version}. Supported: v${VERSION_V1}.`
    );
  }
  const iv = raw.subarray(1, 1 + IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(1 + IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    // Don't propagate the underlying crypto error — it can leak which
    // step failed (tag mismatch vs key mismatch vs corruption).
    throw new FieldEncryptionError(
      "Decryption failed. Possible causes: wrong key, tampered data, or storage corruption."
    );
  }
}

/**
 * Quick check whether a string looks like our encrypted blob. Used
 * during migration to identify already-encrypted rows. NOT a security
 * check — anyone can produce a base64 string starting with our
 * version byte; this just helps the migrator skip already-encrypted
 * values.
 */
export function looksEncrypted(value: string | null | undefined): boolean {
  if (value == null || value === "") return false;
  try {
    const raw = Buffer.from(value, "base64");
    return (
      raw.length >= 1 + IV_BYTES + TAG_BYTES && raw[0] === VERSION_V1
    );
  } catch {
    return false;
  }
}

/** Test helper. Resets the cached key so test injections take effect. */
export function _setKeyForTesting(key: Buffer | null): void {
  cachedKey = key;
}
