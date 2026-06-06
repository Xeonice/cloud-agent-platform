/**
 * Verify-phase test for the compatible-provider API-key encryption-at-rest
 * primitives (account-settings, task 7.5).
 *
 * Requirement semantics (from settings-crypto.ts):
 *   1. resolveEncryptionKey FAILS CLOSED when the key is unset/blank or not a
 *      valid 32-byte key (hex64 or base64-of-32) — so "no key configured ⇒
 *      cannot store a secret" is a hard error, not a silent plaintext write.
 *   2. encrypt→decrypt round-trips: decrypt(encrypt(k)) === k, for the same key.
 *   3. ciphertext is OPAQUE: it never equals/contains the plaintext, and a fresh
 *      random iv makes two encryptions of the same plaintext differ.
 *   4. Tampering / wrong key is REJECTED at decrypt (GCM auth), never returning a
 *      silently-corrupted plaintext.
 *   5. maskApiKeySuffix exposes only the last 4 chars (null for <4), never the
 *      full key.
 *
 * Logic is inlined (mirrors settings-crypto.ts) so the test runs under plain
 * node:test with no transpile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

class EncryptionKeyUnavailableError extends Error {}
class DecryptionFailedError extends Error {}

function resolveEncryptionKey(configured) {
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    throw new EncryptionKeyUnavailableError('unset');
  }
  const raw = configured.trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (decoded.length !== KEY_BYTES) {
    throw new EncryptionKeyUnavailableError('bad length');
  }
  return decoded;
}

function encryptSecret(plaintext, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSecret(envelope, key) {
  try {
    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionFailedError();
  }
}

function maskApiKeySuffix(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length < 4) return null;
  return plaintext.slice(-4);
}

// 1. fail-closed key resolution
test('resolveEncryptionKey fails closed on unset/blank key', () => {
  assert.throws(() => resolveEncryptionKey(undefined), EncryptionKeyUnavailableError);
  assert.throws(() => resolveEncryptionKey(''), EncryptionKeyUnavailableError);
  assert.throws(() => resolveEncryptionKey('   '), EncryptionKeyUnavailableError);
});

test('resolveEncryptionKey rejects a wrong-length key', () => {
  assert.throws(() => resolveEncryptionKey('deadbeef'), EncryptionKeyUnavailableError);
  // base64 decoding to 16 bytes (too short for AES-256)
  assert.throws(
    () => resolveEncryptionKey(Buffer.alloc(16, 1).toString('base64')),
    EncryptionKeyUnavailableError,
  );
});

test('resolveEncryptionKey accepts a 64-char hex AND a 32-byte base64 key', () => {
  const hex = 'a'.repeat(64);
  assert.equal(resolveEncryptionKey(hex).length, KEY_BYTES);
  const b64 = randomBytes(32).toString('base64');
  assert.equal(resolveEncryptionKey(b64).length, KEY_BYTES);
});

// 2. round-trip
test('encrypt then decrypt recovers the plaintext', () => {
  const key = resolveEncryptionKey('f'.repeat(64));
  const secret = 'sk-test-1234567890ABCDEF';
  const env = encryptSecret(secret, key);
  assert.equal(decryptSecret(env, key), secret);
});

// 3. opaque ciphertext + iv freshness
test('ciphertext is opaque and never contains the plaintext', () => {
  const key = resolveEncryptionKey('1'.repeat(64));
  const secret = 'super-secret-key-value';
  const env = encryptSecret(secret, key);
  const decodedCipher = Buffer.from(env.ciphertext, 'base64').toString('latin1');
  assert.ok(!env.ciphertext.includes(secret));
  assert.ok(!decodedCipher.includes(secret));
});

test('two encryptions of the same plaintext differ (fresh iv)', () => {
  const key = resolveEncryptionKey('2'.repeat(64));
  const a = encryptSecret('same', key);
  const b = encryptSecret('same', key);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  // both still decrypt back to the same plaintext
  assert.equal(decryptSecret(a, key), 'same');
  assert.equal(decryptSecret(b, key), 'same');
});

// 4. tamper / wrong key rejection
test('decrypt with the wrong key is rejected (no garbage plaintext)', () => {
  const key = resolveEncryptionKey('3'.repeat(64));
  const wrong = resolveEncryptionKey('4'.repeat(64));
  const env = encryptSecret('secret', key);
  assert.throws(() => decryptSecret(env, wrong), DecryptionFailedError);
});

test('tampered ciphertext/iv/authTag is rejected by GCM auth', () => {
  const key = resolveEncryptionKey('5'.repeat(64));
  const env = encryptSecret('secret', key);
  const flip = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] ^= 0xff;
    return buf.toString('base64');
  };
  assert.throws(() => decryptSecret({ ...env, ciphertext: flip(env.ciphertext) }, key), DecryptionFailedError);
  assert.throws(() => decryptSecret({ ...env, authTag: flip(env.authTag) }, key), DecryptionFailedError);
  assert.throws(() => decryptSecret({ ...env, iv: flip(env.iv) }, key), DecryptionFailedError);
});

// 5. masking
test('maskApiKeySuffix exposes only the last 4, never the full key', () => {
  assert.equal(maskApiKeySuffix('sk-abcdEFGH'), 'EFGH');
  assert.equal(maskApiKeySuffix('1234'), '1234');
  assert.equal(maskApiKeySuffix('abc'), null);
  assert.equal(maskApiKeySuffix(''), null);
  assert.equal(maskApiKeySuffix(undefined), null);
});
