/**
 * Minimal test: "The operator GitHub login token is encrypted at rest"
 * (add-forge-credentials requirement, scenario: Login persists the token
 * encrypted and all readers decrypt)
 *
 * Drives the REAL compiled helpers (dist/) — no mocking of the encryption logic.
 * Three assertions:
 *   1. storeMaybeEncrypted writes CIPHERTEXT (not the plaintext) when a key is set.
 *   2. readMaybeEncrypted decrypts the ciphertext back to the original token
 *      (clone-auth reader and repo-import reader both use this path).
 *   3. readMaybeEncrypted is transparent for a legacy plaintext token (non-breaking).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_SETTINGS = path.resolve(here, '../../dist/settings');

const { storeMaybeEncrypted, readMaybeEncrypted } = require(
  path.join(DIST_SETTINGS, 'secret-storage.js'),
);

// Valid 32-byte AES-256 key as 64 hex chars.
const KEY = 'a'.repeat(64);
const envWithKey = { CODEX_CRED_ENC_KEY: KEY };
const envNoKey = {};

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

console.log('\n=== github login token encrypted at rest (add-forge-credentials) ===\n');

// T1 — Write path: storeMaybeEncrypted produces ciphertext envelope, not plaintext.
{
  const plaintextToken = 'ghp_fakeGitHubOAuthToken1234567890';
  const stored = storeMaybeEncrypted(plaintextToken, envWithKey);
  assert(
    stored !== plaintextToken,
    'T1a: stored value is NOT the plaintext token (it is encrypted)',
  );
  assert(
    stored.split('.').length === 3,
    'T1b: stored value is a ciphertext.iv.authTag envelope (3 dot-separated parts)',
  );
  assert(
    !stored.includes(plaintextToken),
    'T1c: ciphertext envelope does not contain the plaintext token',
  );
}

// T2 — Read path (clone-auth + repo-import readers): readMaybeEncrypted decrypts.
{
  const plaintextToken = 'ghp_fakeGitHubOAuthToken1234567890';
  const stored = storeMaybeEncrypted(plaintextToken, envWithKey);
  const recovered = readMaybeEncrypted(stored, envWithKey);
  assert(
    recovered === plaintextToken,
    'T2: readMaybeEncrypted decrypts the stored ciphertext back to the original token',
  );
}

// T3 — Legacy compatibility: a plaintext token (no dots, no key) is returned as-is.
{
  const legacyToken = 'gho_legacyPlaintextNoEncryptionConfigured';
  const recovered = readMaybeEncrypted(legacyToken, envNoKey);
  assert(
    recovered === legacyToken,
    'T3: readMaybeEncrypted returns a legacy plaintext token unchanged (non-breaking)',
  );
}

// T4 — Without a key, storeMaybeEncrypted stores plaintext (keyless-dev fallback).
{
  const token = 'ghp_plaintextFallback';
  const stored = storeMaybeEncrypted(token, envNoKey);
  assert(
    stored === token,
    'T4: without a key, storeMaybeEncrypted stores the plaintext (keyless dev/test)',
  );
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
