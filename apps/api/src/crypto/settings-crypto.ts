/**
 * Pure encryption-at-rest primitives for the compatible-provider Codex API key
 * (account-settings, task 7.5).
 *
 * Everything here is a PURE function of its inputs — no NestJS, no Prisma, no
 * `process.env` read (the caller supplies the configured key string), no I/O.
 * That keeps the security-critical round-trip unit-testable under plain `node`:
 * encrypt then decrypt MUST recover the plaintext, ciphertext MUST be opaque
 * (never the plaintext), and a wrong key / tampered ciphertext MUST fail to
 * decrypt rather than silently returning garbage.
 *
 * Algorithm: AES-256-GCM. GCM is authenticated, so a tampered ciphertext, iv,
 * or auth tag is REJECTED at decrypt time (the auth tag verification throws)
 * rather than yielding an attacker-chosen plaintext. A fresh random 12-byte iv
 * is generated per encryption so encrypting the same key twice yields different
 * ciphertext.
 *
 * Secret discipline (mirrors the contract in `@cap/contracts/settings`): the
 * plaintext key is accepted only on the encrypt path and is NEVER returned by a
 * read shape. {@link maskApiKeySuffix} derives the display-only last-4 suffix.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from 'node:crypto';

/** The authenticated cipher used for the API key at rest. */
const ALGORITHM: CipherGCMTypes = 'aes-256-gcm';
/** AES-256 key length in bytes. */
const KEY_BYTES = 32;
/** Recommended GCM iv length in bytes. */
const IV_BYTES = 12;
/** GCM auth-tag length in bytes. */
const AUTH_TAG_BYTES = 16;

/**
 * Thrown when the server encryption key is unset/blank or not a valid 32-byte
 * key. FAIL-CLOSED: the caller surfaces this as a clear error and persists
 * NOTHING, so a key can never be stored in plaintext because encryption was
 * silently skipped (task 7.5).
 */
export class EncryptionKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyUnavailableError';
  }
}

/** Thrown when stored ciphertext cannot be authenticated/decrypted. */
export class DecryptionFailedError extends Error {
  constructor(message = 'Failed to decrypt stored credential ciphertext') {
    super(message);
    this.name = 'DecryptionFailedError';
  }
}

/**
 * The opaque encrypted envelope persisted for an API key. None of these three
 * parts is secret on its own (the key is what protects them); all three are
 * required to decrypt, and the auth tag binds the ciphertext + iv so tampering
 * is detected. All are base64-encoded for storage as plain strings.
 */
export interface EncryptedSecret {
  /** Base64 ciphertext of the plaintext key. NEVER the plaintext. */
  readonly ciphertext: string;
  /** Base64 of the per-encryption random initialization vector. */
  readonly iv: string;
  /** Base64 of the GCM authentication tag binding ciphertext + iv. */
  readonly authTag: string;
}

/**
 * Parses and validates the configured server encryption key into 32 raw bytes,
 * FAILING CLOSED with {@link EncryptionKeyUnavailableError} when it is
 * unset/blank or the wrong length. Accepts the key as either:
 *  - a 64-char hex string (32 bytes), or
 *  - a base64 / base64url string decoding to exactly 32 bytes.
 *
 * This is the single gate that makes "no key configured ⇒ cannot save a secret"
 * a hard error rather than a silent plaintext write.
 */
export function resolveEncryptionKey(configured: string | undefined | null): Buffer {
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    throw new EncryptionKeyUnavailableError(
      'Server encryption key (CODEX_CRED_ENC_KEY) is not configured; refusing ' +
        'to store a compatible-provider API key without encryption at rest.',
    );
  }
  const raw = configured.trim();

  // Try hex first (exactly 64 hex chars => 32 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // Otherwise interpret as base64/base64url and require exactly 32 bytes.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (decoded.length !== KEY_BYTES) {
    throw new EncryptionKeyUnavailableError(
      `Server encryption key must decode to exactly ${KEY_BYTES} bytes ` +
        `(got ${decoded.length}); provide a 64-char hex or 32-byte base64 key.`,
    );
  }
  return decoded;
}

/**
 * Encrypts a plaintext API key with AES-256-GCM under the supplied 32-byte key,
 * returning the opaque {@link EncryptedSecret} envelope. A fresh random iv is
 * generated per call (so identical plaintext yields different ciphertext), and
 * the GCM auth tag is captured so tampering is detectable at decrypt time.
 *
 * The returned ciphertext is OPAQUE: it never contains the plaintext and is the
 * only key material ever persisted.
 */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyUnavailableError(
      `Encryption key must be exactly ${KEY_BYTES} bytes.`,
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypts an {@link EncryptedSecret} envelope back to the plaintext key with
 * the supplied 32-byte key, returning the recovered plaintext. Throws
 * {@link DecryptionFailedError} when the key is wrong or any of ciphertext / iv
 * / auth tag was tampered with (GCM authentication fails) — it NEVER returns a
 * silently-corrupted plaintext.
 */
export function decryptSecret(envelope: EncryptedSecret, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyUnavailableError(
      `Encryption key must be exactly ${KEY_BYTES} bytes.`,
    );
  }
  try {
    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (error) {
    // Normalize any GCM/format failure into the single DecryptionFailedError so
    // callers never branch on raw OpenSSL error strings, and never see plaintext.
    throw new DecryptionFailedError(
      error instanceof Error ? error.message : 'decrypt failed',
    );
  }
}

/**
 * Derives the display-only masked suffix of an API key (its last 4 characters),
 * or `null` for an empty/too-short key. This is the ONLY fragment of the key
 * ever exposed on a read shape; the full key is never returned. A key shorter
 * than 4 chars yields `null` rather than leaking the whole (short) key.
 */
export function maskApiKeySuffix(plaintext: string | undefined | null): string | null {
  if (typeof plaintext !== 'string' || plaintext.length < 4) {
    return null;
  }
  return plaintext.slice(-4);
}
