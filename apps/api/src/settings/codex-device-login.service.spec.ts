import test from 'node:test';
import assert from 'node:assert/strict';

import type { SessionUser } from '@cap/contracts';

import {
  CodexDeviceLoginService,
  isValidCodexChatgptCredential,
} from './codex-device-login.service';
import type {
  CodexDeviceLoginCompletion,
  CodexDeviceLoginOperationOptions,
  CodexDeviceLoginRunner,
  CodexDeviceLoginRunnerHandle,
  CodexDeviceLoginStartOptions,
} from './codex-device-login-runner';
import type { SettingsService } from './settings.service';

const LOCAL: SessionUser = {
  id: 'account-local',
  githubId: null,
  login: null,
  name: 'local@example.test',
  avatarUrl: null,
  allowed: true,
  role: 'member',
  mustChangePassword: false,
};
const GITHUB: SessionUser = {
  ...LOCAL,
  id: 'account-github',
  githubId: 4242,
  login: 'octocat',
};
const OTHER: SessionUser = { ...LOCAL, id: 'account-other' };
const IDENTITY_LESS = { name: 'machine' } as unknown as SessionUser;

const VALID_AUTH = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
  },
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeHandle implements CodexDeviceLoginRunnerHandle {
  readonly authorization = {
    loginId: 'login-id',
    verificationUrl: 'https://auth.openai.test/device',
    userCode: 'ABCD-EFGH',
  };
  readonly completion = deferred<CodexDeviceLoginCompletion>();
  credential = VALID_AUTH;
  readGate?: Deferred<string>;
  cancelCalls = 0;
  disposeCalls = 0;
  disposeFailures = 0;
  completionWaits = 0;

  constructor(readonly sessionId: string) {}

  waitForCompletion(
    options: CodexDeviceLoginOperationOptions = {},
  ): Promise<CodexDeviceLoginCompletion> {
    this.completionWaits += 1;
    return abortable(this.completion.promise, options.signal);
  }

  async cancel(_options?: CodexDeviceLoginOperationOptions): Promise<void> {
    this.cancelCalls += 1;
  }

  async readCredential(
    _options?: CodexDeviceLoginOperationOptions,
  ): Promise<string> {
    return this.readGate ? this.readGate.promise : this.credential;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeFailures > 0) {
      this.disposeFailures -= 1;
      throw new Error('simulated cleanup failure');
    }
  }
}

class FakeRunner implements CodexDeviceLoginRunner {
  readonly startCalls: CodexDeviceLoginStartOptions[] = [];
  readonly orphanCalls: CodexDeviceLoginOperationOptions[] = [];
  readonly starts: Array<Deferred<CodexDeviceLoginRunnerHandle>> = [];
  honorStartAbort = true;

  start(options: CodexDeviceLoginStartOptions): Promise<CodexDeviceLoginRunnerHandle> {
    this.startCalls.push(options);
    const gate = deferred<CodexDeviceLoginRunnerHandle>();
    this.starts.push(gate);
    return this.honorStartAbort
      ? abortable(gate.promise, options.signal)
      : gate.promise;
  }

  async disposeOrphans(options: CodexDeviceLoginOperationOptions = {}): Promise<void> {
    this.orphanCalls.push(options);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

class FakeSettings {
  readonly saves: Array<{ operator: SessionUser; authJson: string }> = [];
  failure?: Error;
  saveGate?: Deferred<void>;

  async saveCredential(
    operator: SessionUser,
    request: { mode: 'official'; authJson: string },
  ): Promise<Record<string, never>> {
    this.saves.push({ operator, authJson: request.authJson });
    if (this.saveGate) await this.saveGate.promise;
    if (this.failure) throw this.failure;
    return {};
  }
}

function makeService(
  runner = new FakeRunner(),
  settings = new FakeSettings(),
): {
  service: CodexDeviceLoginService;
  runner: FakeRunner;
  settings: FakeSettings;
} {
  return {
    service: new CodexDeviceLoginService(
      settings as unknown as SettingsService,
      runner,
    ),
    runner,
    settings,
  };
}

test('credential validator requires file-backed ChatGPT access and refresh tokens', () => {
  assert.equal(isValidCodexChatgptCredential(VALID_AUTH), true);
  for (const invalid of [
    'not-json',
    '{}',
    '{"auth_mode":"chatgpt"}',
    '{"auth_mode":"chatgpt","tokens":null}',
    '{"auth_mode":"chatgpt","tokens":{}}',
    '{"auth_mode":"chatgpt","tokens":{"access_token":""}}',
    '{"auth_mode":"chatgpt","tokens":{"access_token":"a"}}',
    '{"auth_mode":"apikey","tokens":{"access_token":"a","refresh_token":"r"}}',
  ]) {
    assert.equal(isValidCodexChatgptCredential(invalid), false, invalid);
  }
});

test('start pre-registers one account session and a retry does not create a second worker', async () => {
  const { service, runner } = makeService();
  try {
    const first = await service.start(LOCAL);
    const retried = await service.start(LOCAL);

    assert.equal(first.status, 'preparing');
    assert.equal(retried.sessionId, first.sessionId);
    assert.equal(runner.startCalls.length, 1);
    assert.equal((await service.getStatus(LOCAL, first.sessionId)).status, 'preparing');
  } finally {
    await service.onModuleDestroy();
  }
});

test('structured authorization progresses through awaiting and connected after persistence', async () => {
  const { service, runner, settings } = makeService();
  const started = await service.start(GITHUB);
  const handle = new FakeHandle(started.sessionId);
  runner.starts[0].resolve(handle);
  await flush();

  const awaiting = await service.getStatus(GITHUB, started.sessionId);
  assert.deepEqual(awaiting, {
    sessionId: started.sessionId,
    status: 'awaiting_authorization',
    expiresAt: started.expiresAt,
    verificationUri: handle.authorization.verificationUrl,
    userCode: handle.authorization.userCode,
  });
  assert.equal(handle.completionWaits, 1, 'completion has one non-overlapping waiter');

  handle.completion.resolve({ loginId: handle.authorization.loginId, success: true });
  await flush();

  assert.equal((await service.getStatus(GITHUB, started.sessionId)).status, 'connected');
  assert.deepEqual(settings.saves, [{ operator: GITHUB, authJson: VALID_AUTH }]);
  assert.ok(handle.disposeCalls >= 1);
  await service.onModuleDestroy();
});

test('cancel during preparation is authoritative and a late worker is reclaimed', async () => {
  const { service, runner, settings } = makeService();
  // Model a non-conforming/late adapter result to prove the service generation
  // guard still reclaims it; the production runner itself rejects on abort.
  runner.honorStartAbort = false;
  const first = await service.start(LOCAL);
  await service.cancel(LOCAL, first.sessionId);
  assert.equal((await service.getStatus(LOCAL, first.sessionId)).status, 'cancelled');

  const staleHandle = new FakeHandle(first.sessionId);
  runner.starts[0].resolve(staleHandle);
  await flush();
  assert.ok(staleHandle.cancelCalls >= 1);
  assert.ok(staleHandle.disposeCalls >= 1);
  assert.equal(settings.saves.length, 0);

  runner.honorStartAbort = true;
  const retry = await service.start(LOCAL);
  assert.notEqual(retry.sessionId, first.sessionId);
  assert.equal(runner.startCalls.length, 2);
  await service.onModuleDestroy();
});

test('persistence is a linearized commit boundary that blocks cancellation and retry races', async () => {
  const settings = new FakeSettings();
  settings.saveGate = deferred<void>();
  const { service, runner } = makeService(new FakeRunner(), settings);
  const started = await service.start(LOCAL);
  const handle = new FakeHandle(started.sessionId);
  runner.starts[0].resolve(handle);
  await flush();
  handle.completion.resolve({ loginId: 'login-id', success: true });
  await flush();

  assert.equal((await service.getStatus(LOCAL, started.sessionId)).status, 'finalizing');
  assert.equal(settings.saves.length, 1, 'the encrypted write crossed its commit boundary');

  let cancelSettled = false;
  const cancelling = service.cancel(LOCAL, started.sessionId).then(() => {
    cancelSettled = true;
  });
  const retried = await service.start(LOCAL);
  assert.equal(retried.sessionId, started.sessionId, 'retry cannot create an overlapping writer');
  assert.equal(cancelSettled, false, 'DELETE waits for the real persistence outcome');

  settings.saveGate.resolve();
  await cancelling;
  await flush();
  assert.equal((await service.getStatus(LOCAL, started.sessionId)).status, 'connected');
  assert.equal(runner.startCalls.length, 1);
  await service.onModuleDestroy();
});

test('terminal cleanup retries a bounded runner failure before dropping its handle', async () => {
  const { service, runner } = makeService();
  const started = await service.start(LOCAL);
  const handle = new FakeHandle(started.sessionId);
  handle.disposeFailures = 2;
  runner.starts[0].resolve(handle);
  await flush();

  await service.cancel(LOCAL, started.sessionId);

  assert.equal((await service.getStatus(LOCAL, started.sessionId)).status, 'cancelled');
  assert.equal(handle.cancelCalls, 1);
  assert.equal(handle.disposeCalls, 3, 'cleanup is retried, then succeeds');
  await service.onModuleDestroy();
  assert.equal(handle.disposeCalls, 3, 'a reclaimed handle is not retried on shutdown');
});

test('cancel during credential read blocks stale completion from saving over a retry', async () => {
  const { service, runner, settings } = makeService();
  const first = await service.start(LOCAL);
  const oldHandle = new FakeHandle(first.sessionId);
  oldHandle.readGate = deferred<string>();
  runner.starts[0].resolve(oldHandle);
  await flush();
  oldHandle.completion.resolve({ loginId: 'login-id', success: true });
  await flush();
  assert.equal((await service.getStatus(LOCAL, first.sessionId)).status, 'finalizing');

  await service.cancel(LOCAL, first.sessionId);
  const retry = await service.start(LOCAL);
  const newHandle = new FakeHandle(retry.sessionId);
  runner.starts[1].resolve(newHandle);
  await flush();

  oldHandle.readGate.resolve(VALID_AUTH);
  await flush();
  assert.equal(settings.saves.length, 0, 'the cancelled generation never persists');
  assert.equal((await service.getStatus(LOCAL, first.sessionId)).status, 'cancelled');
  assert.equal((await service.getStatus(LOCAL, retry.sessionId)).status, 'awaiting_authorization');
  await service.onModuleDestroy();
});

test('persistence failure stays secret-free and never reports connected', async () => {
  const settings = new FakeSettings();
  settings.failure = new Error(`database rejected ${VALID_AUTH}`);
  const { service, runner } = makeService(new FakeRunner(), settings);
  const started = await service.start(LOCAL);
  const handle = new FakeHandle(started.sessionId);
  runner.starts[0].resolve(handle);
  await flush();
  handle.completion.resolve({ loginId: 'login-id', success: true });
  await flush();

  const status = await service.getStatus(LOCAL, started.sessionId);
  assert.equal(status.status, 'error');
  assert.ok(status.status === 'error' && status.message.includes('device_login_persistence_failed'));
  assert.equal(JSON.stringify(status).includes('access-secret'), false);
  await service.onModuleDestroy();
});

test('session lookup is account-isolated while DELETE remains non-enumerating', async () => {
  const { service, runner } = makeService();
  const started = await service.start(LOCAL);
  const handle = new FakeHandle(started.sessionId);
  runner.starts[0].resolve(handle);
  await flush();

  await assert.rejects(
    () => service.getStatus(OTHER, started.sessionId),
    (error: unknown) =>
      (error as { response?: { error?: string } }).response?.error ===
      'device_login_session_not_found',
  );
  await service.cancel(OTHER, started.sessionId);
  assert.equal(handle.cancelCalls, 0);
  assert.equal((await service.getStatus(LOCAL, started.sessionId)).status, 'awaiting_authorization');
  await assert.rejects(() => service.start(IDENTITY_LESS), /authenticated account/);
  await service.onModuleDestroy();
});

test('the absolute CAP deadline expires without depending on browser polling', async () => {
  const previous = process.env.CODEX_DEVICE_LOGIN_SESSION_TTL_MS;
  process.env.CODEX_DEVICE_LOGIN_SESSION_TTL_MS = '20';
  const { service, runner } = makeService();
  try {
    const started = await service.start(LOCAL);
    const handle = new FakeHandle(started.sessionId);
    runner.starts[0].resolve(handle);
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    const status = await service.getStatus(LOCAL, started.sessionId);
    assert.equal(status.status, 'expired');
    assert.ok(handle.cancelCalls >= 1);
    assert.ok(handle.disposeCalls >= 1);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_DEVICE_LOGIN_SESSION_TTL_MS;
    } else {
      process.env.CODEX_DEVICE_LOGIN_SESSION_TTL_MS = previous;
    }
    await service.onModuleDestroy();
  }
});

test('module lifecycle cleans labelled orphans and disposes every live worker', async () => {
  const { service, runner } = makeService();
  await service.onModuleInit();
  assert.equal(runner.orphanCalls.length, 1);

  const started = await service.start(LOCAL);
  const handle = new FakeHandle(started.sessionId);
  runner.starts[0].resolve(handle);
  await flush();
  await service.onModuleDestroy();

  assert.ok(handle.cancelCalls >= 1);
  assert.ok(handle.disposeCalls >= 1);
});

test('module shutdown reclaims a worker that resolves after the first cleanup pass', async () => {
  const { service, runner } = makeService();
  runner.honorStartAbort = false;

  const started = await service.start(LOCAL);
  const shuttingDown = service.onModuleDestroy();
  const lateHandle = new FakeHandle(started.sessionId);
  runner.starts[0].resolve(lateHandle);

  await shuttingDown;

  assert.ok(lateHandle.cancelCalls >= 1, 'the late worker receives cancellation');
  assert.ok(lateHandle.disposeCalls >= 1, 'the late worker is reclaimed before shutdown');
});
