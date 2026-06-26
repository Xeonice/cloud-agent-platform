import assert from 'node:assert/strict';
const sandbox = await import(new URL('../../../../packages/sandbox/dist/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

function boxliteConfig(overrides = {}) {
  const result = sandbox.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'cap-boxlite:2026-06-27',
    BOXLITE_PROVIDER_PRIORITY: '60',
    BOXLITE_TERMINAL_MODE: 'pty',
    BOXLITE_CAPABILITIES: [
      'terminal.websocket',
      'terminal.interactive',
      'command.exec',
      'workspace.archive.transfer',
      'workspace.git.deliver',
      'lifecycle.readoption',
    ].join(','),
    ...overrides,
  });
  assert.equal(result.status, 'valid');
  return result.config;
}

function makeAioProvider() {
  const calls = [];
  return {
    calls,
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => [
      'terminal.websocket',
      'workspace.git.materialize',
      'workspace.git.deliver',
      'transcript.retained-read',
      'lifecycle.readopt',
    ],
    async provision(ctx) {
      calls.push(['provision', ctx.taskId]);
      return {
        taskId: ctx.taskId,
        baseUrl: `http://aio/${ctx.taskId}`,
        wsUrl: `ws://aio/${ctx.taskId}`,
      };
    },
    async teardownSandbox(taskId) {
      calls.push(['teardown', taskId]);
    },
    async readRolloutFromContainer() {
      return null;
    },
    async sandboxExists() {
      return false;
    },
    async deliverWorkspaceChanges(taskId) {
      calls.push(['deliver', taskId]);
      return { hadChanges: false, commitSha: null, error: null };
    },
    async listReadoptable() {
      calls.push(['listReadoptable']);
      return [];
    },
    async reattach(taskId) {
      calls.push(['reattach', taskId]);
      return null;
    },
  };
}

function makeOwnerStore() {
  const records = new Map();
  return {
    records,
    async getSandboxRunOwner(taskId) {
      return records.get(taskId) ?? null;
    },
    async recordSandboxRunOwner(record) {
      records.set(record.taskId, { ...record, status: 'running' });
    },
    async markSandboxRunOwnerStatus(taskId, status) {
      const existing = records.get(taskId);
      if (existing) records.set(taskId, { ...existing, status });
    },
  };
}

await test('API provider wiring keeps AIO-only behavior when BoxLite env is absent', async () => {
  assert.equal(sandbox.readBoxLiteProviderConfig({}).status, 'disabled');
  const aio = makeAioProvider();
  const router = new sandbox.SandboxProviderRouter([
    sandbox.defineLocalSandboxProvider({ id: 'aio-local', provider: aio, priority: 10 }),
  ]);

  const connection = await router.provision({ taskId: 'task-aio', cloneSpec: null });
  assert.equal(connection.baseUrl, 'http://aio/task-aio');
  assert.deepEqual(aio.calls, [['provision', 'task-aio']]);
});

await test('API provider wiring selects BoxLite by priority and capability', async () => {
  const aio = makeAioProvider();
  const client = new sandbox.FakeBoxLiteClient();
  const boxliteDescriptor = sandbox.defineBoxLiteSandboxProvider({
    config: boxliteConfig(),
    client,
  });
  const router = new sandbox.SandboxProviderRouter([
    sandbox.defineLocalSandboxProvider({ id: 'aio-local', provider: aio, priority: 10 }),
    boxliteDescriptor,
  ]);

  const connection = await router.provision({ taskId: 'task-boxlite', cloneSpec: null });
  assert.equal(connection.baseUrl, 'boxlite://cap-boxlite-task-boxlite');
  assert.equal(client.createCalls.length, 1);
  assert.deepEqual(aio.calls, []);
  assert.equal((await router.getSelectedSandboxRun('task-boxlite')).providerId, 'boxlite');
});

await test('API provider wiring fails closed on BoxLite preflight failure', async () => {
  const aio = makeAioProvider();
  const ownerStore = makeOwnerStore();
  const client = new sandbox.FakeBoxLiteClient({
    execHandler: () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'missing',
      output: 'missing',
      timedOut: false,
    }),
  });
  const router = new sandbox.SandboxProviderRouter(
    [
      sandbox.defineLocalSandboxProvider({ id: 'aio-local', provider: aio, priority: 10 }),
      sandbox.defineBoxLiteSandboxProvider({
        config: boxliteConfig(),
        client,
        preflight: sandbox.createBoxLiteRuntimePreflight({
          requiredTools: ['missing-tool'],
        }),
      }),
    ],
    { ownerStore },
  );

  await assert.rejects(
    () => router.provision({ taskId: 'task-preflight-fail', cloneSpec: null }),
    /BoxLite image missing required tools: missing-tool/,
  );
  assert.equal(ownerStore.records.has('task-preflight-fail'), false);
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-preflight-fail']);
  assert.deepEqual(aio.calls, []);
});

await test('API delivery skips instead of guessing when no provider owner can be proven', async () => {
  const client = new sandbox.FakeBoxLiteClient();
  const router = new sandbox.SandboxProviderRouter([
    sandbox.defineBoxLiteSandboxProvider({
      config: boxliteConfig({
        BOXLITE_TERMINAL_MODE: 'none',
        BOXLITE_CAPABILITIES: 'command.exec,workspace.git.deliver,lifecycle.readoption',
      }),
      client,
    }),
  ]);

  const result = await router.deliverWorkspaceChanges('unknown-task', {
    authHeader: 'Authorization: Basic token',
    branch: 'cap/unknown-task',
    commitMessage: 'deliver',
  });
  assert.equal(result.hadChanges, false);
  assert.match(result.error, /unknown; reattach must succeed/);
  assert.equal(client.execCalls.length, 0);
});

await test('API restart-style readoption uses stored BoxLite owner before probing AIO', async () => {
  const aio = makeAioProvider();
  const client = new sandbox.FakeBoxLiteClient();
  const ownerStore = makeOwnerStore();
  const boxliteDescriptor = sandbox.defineBoxLiteSandboxProvider({
    config: boxliteConfig(),
    client,
  });
  const firstRouter = new sandbox.SandboxProviderRouter(
    [
      sandbox.defineLocalSandboxProvider({ id: 'aio-local', provider: aio, priority: 10 }),
      boxliteDescriptor,
    ],
    { ownerStore },
  );
  await firstRouter.provision({ taskId: 'task-restart', cloneSpec: null });

  const restartedRouter = new sandbox.SandboxProviderRouter(
    [
      sandbox.defineLocalSandboxProvider({ id: 'aio-local', provider: aio, priority: 10 }),
      boxliteDescriptor,
    ],
    { ownerStore },
  );
  const connection = await restartedRouter.reattach('task-restart');
  assert.equal(connection.baseUrl, 'boxlite://cap-boxlite-task-restart');
  assert(!aio.calls.some((call) => call[0] === 'reattach'));
  assert.equal((await restartedRouter.getSelectedSandboxRun('task-restart')).providerId, 'boxlite');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
