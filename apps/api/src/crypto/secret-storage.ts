/**
 * Shared at-rest secret storage helpers (add-forge-credentials).
 *
 * Centralizes the `ciphertext.iv.authTag` joined-string envelope used by the
 * settings credentials, so forge PATs and model-provider credentials share ONE
 * encrypt/decrypt path instead of re-implementing it per call-site.
 *
 * Two storage disciplines:
 *  - {@link encryptToStored} / {@link decryptStored}: FAIL-CLOSED (require a key).
 *    Used for born-encrypted secrets like the forge PAT — connecting requires the
 *    server key, exactly like the codex compatible key.
 *  - {@link storeMaybeEncrypted} / {@link readMaybeEncrypted}: legacy-compatible
 *    discipline — encrypt when a key is configured, else store plaintext (keyless
 *    dev), and read back transparently whether the value is an encrypted envelope
 *    or a legacy plaintext token.
 *
 * Pure functions of `(plaintext|stored, env)` — no Prisma/NestJS — so the
 * round-trip is unit-testable under plain `node`.
 */

import {
  decryptSecret,
  encryptSecret,
  resolveEncryptionKey,
  type EncryptedSecret,
} from './settings-crypto.js';

/** Env var holding the server encryption key (shared with the codex credential). */
export const CODEX_CRED_ENC_KEY_ENV = 'CODEX_CRED_ENC_KEY';

/** True when a non-blank encryption key is configured (encryption is "enabled"). */
export function isEncryptionKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CODEX_CRED_ENC_KEY_ENV];
  return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * Boot fail-fast: when a key is CONFIGURED it MUST be valid (32 bytes). A
 * configured-but-malformed key throws here so startup fails loudly rather than
 * silently breaking every encrypted write. When no key is configured this is a
 * no-op (encryption disabled for legacy-compatible writes).
 */
export function assertEncryptionKeyValidIfConfigured(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isEncryptionKeyConfigured(env)) {
    resolveEncryptionKey(env[CODEX_CRED_ENC_KEY_ENV]); // throws if malformed
  }
}

/** Splits the joined `ciphertext.iv.authTag` storage string into an envelope. */
function parseStored(stored: string): EncryptedSecret | null {
  const parts = stored.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    return null;
  }
  const [ciphertext, iv, authTag] = parts;
  return { ciphertext, iv, authTag };
}

/**
 * Encrypts a plaintext secret into the joined `ciphertext.iv.authTag` storage
 * string. FAIL-CLOSED: throws {@link EncryptionKeyUnavailableError} when no
 * server key is configured (a secret is never stored unencrypted on this path).
 */
export function encryptToStored(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = resolveEncryptionKey(env[CODEX_CRED_ENC_KEY_ENV]);
  const envelope = encryptSecret(plaintext, key);
  return `${envelope.ciphertext}.${envelope.iv}.${envelope.authTag}`;
}

/**
 * Decrypts a born-encrypted joined-envelope string. Returns null when the value
 * is not a valid envelope or decryption fails (never a corrupted plaintext).
 */
export function decryptStored(
  stored: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof stored !== 'string' || stored.length === 0) {
    return null;
  }
  const envelope = parseStored(stored);
  if (!envelope) {
    return null;
  }
  try {
    const key = resolveEncryptionKey(env[CODEX_CRED_ENC_KEY_ENV]);
    return decryptSecret(envelope, key);
  } catch {
    return null;
  }
}

/**
 * github-token write: encrypt when a key is configured, else store the plaintext
 * (keyless dev/test — preserves today's behavior). Returns the value to persist.
 */
export function storeMaybeEncrypted(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isEncryptionKeyConfigured(env) ? encryptToStored(plaintext, env) : plaintext;
}

/**
 * github-token read: recover the plaintext whether `stored` is an encrypted
 * envelope or a legacy plaintext token. A real github token (`ghp_`/`gho_`/…)
 * contains no `.` so it never parses as a 3-part envelope and is returned as-is;
 * an envelope is decrypted. Returns null only on a genuine decrypt failure.
 */
export function readMaybeEncrypted(
  stored: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof stored !== 'string' || stored.length === 0) {
    return null;
  }
  const envelope = parseStored(stored);
  if (!envelope || !isEncryptionKeyConfigured(env)) {
    return stored; // legacy plaintext, or no key configured
  }
  try {
    const key = resolveEncryptionKey(env[CODEX_CRED_ENC_KEY_ENV]);
    return decryptSecret(envelope, key);
  } catch {
    return null;
  }
}
