/**
 * Minimal test exercising the Claude Code credential storage logic — the spec
 * requirement account-settings / "Claude Code runtime credential"
 * (pixel-restore-console-to-od Track 3).
 *
 * Scenarios:
 *   S1 - Subscription mode stores the setup-token (presence + masked suffix),
 *        state connected.
 *   S2 - api_key mode stores the Anthropic key and CLEARS the subscription
 *        secret (modes are mutually exclusive).
 *   S3 - A subscription re-save omitting the token PRESERVES the stored token.
 *   S4 - Subscription mode with no token stored reads not_connected.
 *   S5 - Saved secret is never returned in plaintext; only the masked suffix is.
 *
 * Runs under plain node:test — no transpile, no NestJS, no Prisma. The
 * derivation is inlined from settings.service.ts saveClaudeCredential /
 * readClaudeCredential to stay self-contained.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors settings-crypto.maskApiKeySuffix (last 4 chars, masked prefix). */
function maskApiKeySuffix(plaintext) {
  if (!plaintext) return null;
  const tail = plaintext.slice(-4);
  return `••••${tail}`;
}

/**
 * Mirrors settings.service.ts saveClaudeCredential — pure projection of a save
 * request + the existing row onto the next stored row (encryption stubbed as an
 * `enc:` prefix so the mutual-exclusion / preserve-by-omission logic is what's
 * under test, not the cipher).
 */
function projectClaudeSave(request, existing) {
  const enc = (s) => `enc:${s}`;

  let setupTokenCiphertext, setupTokenLast4;
  if (request.mode === 'subscription') {
    if (typeof request.setupToken === 'string' && request.setupToken.length > 0) {
      setupTokenCiphertext = enc(request.setupToken);
      setupTokenLast4 = maskApiKeySuffix(request.setupToken);
    } else {
      setupTokenCiphertext = existing?.setupTokenCiphertext ?? null;
      setupTokenLast4 = existing?.setupTokenLast4 ?? null;
    }
  } else {
    setupTokenCiphertext = null;
    setupTokenLast4 = null;
  }

  let apiKeyCiphertext, apiKeyLast4;
  if (request.mode === 'api_key') {
    if (typeof request.apiKey === 'string' && request.apiKey.length > 0) {
      apiKeyCiphertext = enc(request.apiKey);
      apiKeyLast4 = maskApiKeySuffix(request.apiKey);
    } else {
      apiKeyCiphertext = existing?.apiKeyCiphertext ?? null;
      apiKeyLast4 = existing?.apiKeyLast4 ?? null;
    }
  } else {
    apiKeyCiphertext = null;
    apiKeyLast4 = null;
  }

  const activeSecretStored =
    request.mode === 'subscription'
      ? Boolean(setupTokenCiphertext)
      : Boolean(apiKeyCiphertext);
  return {
    mode: request.mode,
    state: activeSecretStored ? 'connected' : 'not_connected',
    setupTokenCiphertext,
    setupTokenLast4,
    apiKeyCiphertext,
    apiKeyLast4,
    defaultModel: request.defaultModel ?? existing?.defaultModel ?? null,
  };
}

/** Mirrors settings.service.ts readClaudeCredential — secret-free read shape. */
function projectClaudeRead(row) {
  if (!row) {
    return { mode: 'subscription', state: 'not_connected', hasSetupToken: false, hasApiKey: false };
  }
  return {
    mode: row.mode,
    state: row.state,
    hasSetupToken: Boolean(row.setupTokenCiphertext),
    setupTokenSuffix: row.setupTokenLast4 ?? null,
    hasApiKey: Boolean(row.apiKeyCiphertext),
    apiKeySuffix: row.apiKeyLast4 ?? null,
    defaultModel: row.defaultModel ?? null,
  };
}

test('S1 subscription mode stores the setup-token, masked, connected', () => {
  const row = projectClaudeSave({ mode: 'subscription', setupToken: 'sk-ant-oat01-ABCD1234' }, null);
  const read = projectClaudeRead(row);
  assert.equal(read.mode, 'subscription');
  assert.equal(read.state, 'connected');
  assert.equal(read.hasSetupToken, true);
  assert.equal(read.setupTokenSuffix, '••••1234');
  assert.equal(read.hasApiKey, false);
});

test('S2 api_key mode stores the key and clears the subscription secret', () => {
  const existing = projectClaudeSave({ mode: 'subscription', setupToken: 'sk-ant-oat01-WXYZ' }, null);
  const row = projectClaudeSave({ mode: 'api_key', apiKey: 'sk-ant-api03-KEY9876' }, existing);
  const read = projectClaudeRead(row);
  assert.equal(read.mode, 'api_key');
  assert.equal(read.state, 'connected');
  assert.equal(read.hasApiKey, true);
  assert.equal(read.apiKeySuffix, '••••9876');
  // Mutual exclusion: the previously stored subscription token is cleared.
  assert.equal(read.hasSetupToken, false);
});

test('S3 subscription re-save omitting the token preserves the stored token', () => {
  const existing = projectClaudeSave({ mode: 'subscription', setupToken: 'sk-ant-oat01-KEEP5555' }, null);
  const row = projectClaudeSave({ mode: 'subscription', defaultModel: 'claude-opus-4-8' }, existing);
  const read = projectClaudeRead(row);
  assert.equal(read.hasSetupToken, true);
  assert.equal(read.setupTokenSuffix, '••••5555');
  assert.equal(read.state, 'connected');
  assert.equal(read.defaultModel, 'claude-opus-4-8');
});

test('S4 subscription mode with no token reads not_connected', () => {
  const row = projectClaudeSave({ mode: 'subscription' }, null);
  const read = projectClaudeRead(row);
  assert.equal(read.state, 'not_connected');
  assert.equal(read.hasSetupToken, false);
});

test('S5 stored secret is never returned in plaintext — only the masked suffix', () => {
  const row = projectClaudeSave({ mode: 'subscription', setupToken: 'sk-ant-oat01-SECRET' }, null);
  const read = projectClaudeRead(row);
  const serialized = JSON.stringify(read);
  assert.ok(!serialized.includes('SECRET'), 'plaintext token must not appear in the read shape');
  assert.ok(!serialized.includes('enc:'), 'ciphertext must not appear in the read shape');
  assert.equal(read.setupTokenSuffix, '••••CRET');
});
