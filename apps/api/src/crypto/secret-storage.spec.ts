/**
 * add-forge-credentials — shared at-rest secret storage helpers.
 *
 * Verifies the github-token + forge-PAT storage disciplines against the REAL
 * `secret-storage.ts` (not an inlined copy):
 *   - encryptToStored → decryptStored round-trips; ciphertext is opaque.
 *   - readMaybeEncrypted recovers BOTH an encrypted envelope AND a legacy
 *     plaintext token (the github-token non-breaking path).
 *   - storeMaybeEncrypted encrypts when a key is configured, else stores plaintext.
 *   - assertEncryptionKeyValidIfConfigured: no key = no-op; valid key = ok;
 *     configured-but-malformed key throws (boot fail-fast).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertEncryptionKeyValidIfConfigured,
  decryptStored,
  encryptToStored,
  isEncryptionKeyConfigured,
  readMaybeEncrypted,
  storeMaybeEncrypted,
} from './secret-storage';

/** A valid 32-byte key as 64 hex chars. */
const KEY = '0'.repeat(64);
const withKey: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: KEY };
const noKey: NodeJS.ProcessEnv = {};

test('encryptToStored → decryptStored round-trips and ciphertext is opaque', () => {
  const plain = 'ghp_secret_token_value_1234';
  const stored = encryptToStored(plain, withKey);
  assert.equal(stored.split('.').length, 3, 'stored as ciphertext.iv.authTag');
  assert.ok(!stored.includes(plain), 'ciphertext never contains the plaintext');
  assert.equal(decryptStored(stored, withKey), plain);
});

test('encryptToStored FAILS CLOSED without a server key', () => {
  assert.throws(() => encryptToStored('x', noKey));
});

test('readMaybeEncrypted recovers an encrypted envelope', () => {
  const plain = 'glpat-abcdEFGH1234';
  const stored = encryptToStored(plain, withKey);
  assert.equal(readMaybeEncrypted(stored, withKey), plain);
});

test('readMaybeEncrypted returns a legacy plaintext token unchanged', () => {
  // A real github token has no dots, so it never parses as a 3-part envelope.
  const legacy = 'gho_legacyPlaintextToken';
  assert.equal(readMaybeEncrypted(legacy, withKey), legacy);
  assert.equal(readMaybeEncrypted(legacy, noKey), legacy);
});

test('readMaybeEncrypted handles null/empty', () => {
  assert.equal(readMaybeEncrypted(null, withKey), null);
  assert.equal(readMaybeEncrypted(undefined, withKey), null);
  assert.equal(readMaybeEncrypted('', withKey), null);
});

test('storeMaybeEncrypted encrypts with a key, stores plaintext without', () => {
  const plain = 'ghp_value_for_store';
  const withKeyStored = storeMaybeEncrypted(plain, withKey);
  assert.notEqual(withKeyStored, plain, 'encrypted when key present');
  assert.equal(decryptStored(withKeyStored, withKey), plain);
  assert.equal(storeMaybeEncrypted(plain, noKey), plain, 'plaintext when no key');
});

test('isEncryptionKeyConfigured reflects the env', () => {
  assert.equal(isEncryptionKeyConfigured(withKey), true);
  assert.equal(isEncryptionKeyConfigured(noKey), false);
  assert.equal(isEncryptionKeyConfigured({ CODEX_CRED_ENC_KEY: '  ' }), false);
});

test('assertEncryptionKeyValidIfConfigured: no-op without key, ok with valid key, throws on malformed', () => {
  assert.doesNotThrow(() => assertEncryptionKeyValidIfConfigured(noKey));
  assert.doesNotThrow(() => assertEncryptionKeyValidIfConfigured(withKey));
  assert.throws(() =>
    assertEncryptionKeyValidIfConfigured({ CODEX_CRED_ENC_KEY: 'too-short' }),
  );
});
