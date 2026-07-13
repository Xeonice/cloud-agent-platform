/**
 * Compiled-schema coverage for the asynchronous, session-scoped Codex device
 * login contract. Requires `pnpm --filter @cap/contracts build` first.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  CodexDeviceLoginSessionIdSchema,
  CodexDeviceLoginSessionParamsSchema,
  CodexDeviceLoginStartResponseSchema,
  CodexDeviceLoginStatusSchema,
} = require(path.join(here, '..', 'dist', 'settings.js'));

const sessionId = '11111111-1111-4111-8111-111111111111';
const expiresAt = '2026-07-13T12:30:00.000Z';
const common = { sessionId, expiresAt };

test('start response exposes only the pre-registered CAP session and deadline', () => {
  const parsed = CodexDeviceLoginStartResponseSchema.parse({
    ...common,
    status: 'preparing',
  });

  assert.deepEqual(parsed, { ...common, status: 'preparing' });
  assert.throws(() =>
    CodexDeviceLoginStartResponseSchema.parse({
      ...common,
      status: 'preparing',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    }),
  );
  assert.throws(() =>
    CodexDeviceLoginStartResponseSchema.parse({
      ...common,
      status: 'preparing',
      expiresInSeconds: 900,
    }),
  );
});

test('status schema accepts every lifecycle variant', () => {
  const variants = [
    { ...common, status: 'preparing' },
    {
      ...common,
      status: 'awaiting_authorization',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    },
    { ...common, status: 'finalizing' },
    { ...common, status: 'connected' },
    { ...common, status: 'cancelled' },
    { ...common, status: 'expired', message: 'CAP 登录会话已过期。' },
    { ...common, status: 'error', message: '无法启动 Codex 登录工作进程。' },
  ];

  for (const variant of variants) {
    assert.deepEqual(CodexDeviceLoginStatusSchema.parse(variant), variant);
  }
});

test('awaiting authorization requires both URL and code', () => {
  const awaiting = {
    ...common,
    status: 'awaiting_authorization',
    verificationUri: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
  };

  assert.throws(() =>
    CodexDeviceLoginStatusSchema.parse({
      ...awaiting,
      verificationUri: undefined,
    }),
  );
  assert.throws(() =>
    CodexDeviceLoginStatusSchema.parse({
      ...awaiting,
      userCode: undefined,
    }),
  );
  assert.throws(() =>
    CodexDeviceLoginStatusSchema.parse({
      ...awaiting,
      verificationUri: 'not-a-url',
    }),
  );
  assert.throws(() =>
    CodexDeviceLoginStatusSchema.parse({ ...awaiting, userCode: '' }),
  );
});

test('URL and code are rejected outside awaiting authorization', () => {
  for (const status of ['preparing', 'finalizing', 'connected', 'cancelled']) {
    assert.throws(() =>
      CodexDeviceLoginStatusSchema.parse({
        ...common,
        status,
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
      }),
    );
  }
});

test('terminal payloads reject device codes and credential material', () => {
  const terminalVariants = [
    { ...common, status: 'connected' },
    { ...common, status: 'cancelled' },
    { ...common, status: 'expired', message: 'CAP 登录会话已过期。' },
    { ...common, status: 'error', message: '登录失败。' },
  ];
  const forbiddenFields = [
    { userCode: 'ABCD-1234' },
    { verificationUri: 'https://auth.openai.com/codex/device' },
    { authJson: '{"tokens":{"access_token":"secret"}}' },
    { accessToken: 'secret' },
  ];

  for (const variant of terminalVariants) {
    for (const forbidden of forbiddenFields) {
      assert.throws(() =>
        CodexDeviceLoginStatusSchema.parse({ ...variant, ...forbidden }),
      );
    }
  }
});

test('expired and error outcomes require a non-empty operator message', () => {
  for (const status of ['expired', 'error']) {
    assert.throws(() =>
      CodexDeviceLoginStatusSchema.parse({ ...common, status }),
    );
    assert.throws(() =>
      CodexDeviceLoginStatusSchema.parse({ ...common, status, message: '' }),
    );
  }
});

test('all responses require a UUID session id and ISO CAP deadline', () => {
  assert.throws(() =>
    CodexDeviceLoginStartResponseSchema.parse({
      sessionId: 'guessable-session',
      status: 'preparing',
      expiresAt,
    }),
  );
  assert.throws(() =>
    CodexDeviceLoginStatusSchema.parse({
      sessionId,
      status: 'preparing',
      expiresAt: 'in fifteen minutes',
    }),
  );
});

test('session-id schemas validate the session-scoped GET/DELETE path', () => {
  assert.equal(CodexDeviceLoginSessionIdSchema.parse(sessionId), sessionId);
  assert.deepEqual(CodexDeviceLoginSessionParamsSchema.parse({ sessionId }), {
    sessionId,
  });

  for (const invalid of ['', 'session-1', '11111111-1111-4111-8111-11111111111']) {
    assert.throws(() => CodexDeviceLoginSessionIdSchema.parse(invalid));
    assert.throws(() =>
      CodexDeviceLoginSessionParamsSchema.parse({ sessionId: invalid }),
    );
  }
  assert.throws(() => CodexDeviceLoginSessionParamsSchema.parse({}));
  assert.throws(() =>
    CodexDeviceLoginSessionParamsSchema.parse({ sessionId, accountId: 'other' }),
  );
});
