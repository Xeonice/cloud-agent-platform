import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeRuntime } from './claude-code-runtime';
import { CodexRuntime } from './codex-runtime';

const codex = new CodexRuntime();
const claude = new ClaudeCodeRuntime();

test('Codex classifies the production token_expired envelope through ANSI decoration', () => {
  const output =
    '\x1b[31mHTTP 401 Unauthorized\x1b[0m {\\"error\\":{' +
    '\\"message\\":\\"Provided authentication token is expired. Please try signing in again.\\",' +
    '\\"type\\":\\"invalid_request_error\\",\\"code\\":\\"token_expired\\"}}';

  assert.deepEqual(codex.classifyOutputFailure(output), { code: 'runtime_auth_expired' });
});

test('Codex rolling input recognizes a signal split across PTY chunks', () => {
  let rolling = 'HTTP 401 Unauthorized {"error":{"code":"token_';
  assert.equal(codex.classifyOutputFailure(rolling), null);

  rolling += 'expired","message":"Provided authentication token is expired."}}';
  assert.deepEqual(codex.classifyOutputFailure(rolling), { code: 'runtime_auth_expired' });
});

test('Codex distinguishes refresh rejection from explicit expiration', () => {
  assert.deepEqual(
    codex.classifyOutputFailure(
      'Turn error: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    ),
    { code: 'runtime_auth_rejected' },
  );
  assert.deepEqual(
    codex.classifyOutputFailure(
      'Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.\n',
    ),
    { code: 'runtime_auth_rejected' },
  );
  assert.deepEqual(
    codex.classifyOutputFailure(
      '{"type":"error","message":"Your access token could not be refreshed. Please log out and sign in again."}',
    ),
    { code: 'runtime_auth_rejected' },
  );
});

test('Codex rejects only a structured provider credential failure', () => {
  assert.deepEqual(
    codex.classifyOutputFailure(
      'HTTP 401 {"error":{"type":"authentication_error","code":"invalid_api_key","message":"Invalid API key"}}',
    ),
    { code: 'runtime_auth_rejected' },
  );
  assert.deepEqual(
    codex.classifyOutputFailure(
      'HTTP 401 {"error":{"type":"authentication_error","code":"invalid_api_key","message":"Incorrect API key provided"}}',
    ),
    { code: 'runtime_auth_rejected' },
  );
});

test('Codex does not classify generic HTTP/rate-limit output or ordinary prose', () => {
  const ordinary = [
    'HTTP 401 Unauthorized',
    'HTTP 429 Too Many Requests: rate limit exceeded',
    'Please document token_expired and authentication_error handling.',
    'The UI should say "Provided authentication token is expired. Please try signing in again."',
    '{"code":"token_expired"}',
    '{"method":"turn/failed","params":{"error":{"message":"The requested model is not available","codexErrorInfo":{"type":"badRequest"}}}}',
    '{"error":{"code":"model_not_found","message":"Unknown model selector"}}',
    'The logs may say: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'Example payload: {"type":"error","message":"Your access token could not be refreshed. Please log out and sign in again."}',
  ];
  for (const output of ordinary) {
    assert.equal(codex.classifyOutputFailure(output), null, output);
  }
});

test('Claude classifies standalone expired-session output through ANSI decoration', () => {
  assert.deepEqual(
    claude.classifyOutputFailure(
      '\x1b[33mSession expired. Please run /login to sign in again.\x1b[0m\r\n',
    ),
    { code: 'runtime_auth_expired' },
  );
});

test('Claude classifies structured OAuth expiration and invalid credentials separately', () => {
  assert.deepEqual(
    claude.classifyOutputFailure(
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}',
    ),
    { code: 'runtime_auth_expired' },
  );
  assert.deepEqual(
    claude.classifyOutputFailure(
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
    ),
    { code: 'runtime_auth_rejected' },
  );
});

test('Claude rolling input recognizes an authentication envelope split across chunks', () => {
  let rolling = 'API Error: 401 {"type":"error","error":{"type":"authentica';
  assert.equal(claude.classifyOutputFailure(rolling), null);

  rolling += 'tion_error","message":"Invalid authentication credentials"}}';
  assert.deepEqual(claude.classifyOutputFailure(rolling), {
    code: 'runtime_auth_rejected',
  });
});

test('Claude recognizes its standalone not-logged-in recovery prompt', () => {
  assert.deepEqual(
    claude.classifyOutputFailure('Not logged in \u00b7 Please run /login\n'),
    { code: 'runtime_auth_rejected' },
  );
});

test('Claude recognizes official refresh-token and API-key recovery prompts', () => {
  assert.deepEqual(
    claude.classifyOutputFailure(
      'OAuth refresh token is no longer valid · Please run /login to sign in again.\n',
    ),
    { code: 'runtime_auth_expired' },
  );
  assert.deepEqual(
    claude.classifyOutputFailure('Invalid API key · Please run /login\n'),
    { code: 'runtime_auth_rejected' },
  );
});

test('Claude does not classify generic HTTP/rate-limit output or quoted prose', () => {
  const ordinary = [
    'API Error: 401 Unauthorized',
    'API Error: 429 {"type":"rate_limit_error"}',
    'authentication_error is a provider response type.',
    'Example: API Error: 401 {"type":"authentication_error","message":"Invalid bearer token"}',
    'The UI should display "Session expired. Please run /login to sign in again."',
    'The UI should display "OAuth refresh token is no longer valid · Please run /login to sign in again."',
    'Example: Invalid API key · Please run /login',
    'Invalid bearer token',
    '{"type":"system","subtype":"init","model":"substituted-model"}\n{"type":"result","subtype":"success","is_error":false}',
    '{"type":"result","subtype":"error_during_execution","is_error":true,"error":"model_not_found"}',
    'invalid_model: the selected model is unavailable',
  ];
  for (const output of ordinary) {
    assert.equal(claude.classifyOutputFailure(output), null, output);
  }
});
