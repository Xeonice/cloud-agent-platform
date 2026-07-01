import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

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

function fakeProvider(id, capabilities, options = {}) {
  const calls = [];
  const connection = (taskId) => ({
    taskId: `${id}-${taskId}`,
    baseUrl: `https://${id}.example.test/${taskId}`,
    wsUrl: `wss://${id}.example.test/${taskId}`,
  });
  return {
    id,
    calls,
    getSandboxMode: () => options.mode ?? 'workspace-write',
    getProviderCapabilities: () => capabilities,
    async provision(ctx) {
      calls.push(['provision', ctx.taskId, ctx.cloneSpec?.url ?? null]);
      return connection(ctx.taskId);
    },
    async teardownSandbox(taskId) {
      calls.push(['teardown', taskId]);
    },
    async readRolloutFromContainer(taskId) {
      calls.push(['readRollout', taskId]);
      return options.transcript ?? null;
    },
    async sandboxExists(taskId) {
      calls.push(['exists', taskId]);
      return options.exists?.has(taskId) ?? false;
    },
    async deliverWorkspaceChanges(taskId, args) {
      calls.push(['deliver', taskId, args.branch]);
      return { hadChanges: true, commitSha: `${id}-sha`, error: null };
    },
    async listReadoptable() {
      calls.push(['listReadoptable']);
      return [...(options.readoptable ?? [])];
    },
    async reattach(taskId) {
      calls.push(['reattach', taskId]);
      return options.readoptable?.has(taskId) ? connection(taskId) : null;
    },
    async getSelectedSandboxRun(taskId) {
      calls.push(['selectedRun', taskId]);
      return {
        taskId,
        providerId: id,
        providerSandboxId: `${id}-${taskId}`,
        provider: this,
        capabilities,
        connection: connection(taskId),
        terminal: {
          protocol: 'fake-terminal-v1',
          wsUrl: `wss://${id}.example.test/${taskId}`,
        },
        command: {
          protocol: 'fake-exec-v1',
          baseUrl: `https://${id}.example.test/${taskId}`,
          workingDirectory: '/workspace',
        },
        workspace: {
          mode: 'git',
          path: '/workspace',
          git: { materialized: true, deliverable: true },
        },
        retention: {
          mode: 'stop-retain',
          retainTranscript: true,
          cleanupEligible: true,
        },
        preflight: {
          status: 'passed',
          checkedAt: '2026-01-02T03:04:05.000Z',
          runtimeId: 'fake',
        },
      };
    },
  };
}

await test('fake conformance routes provision, ownership, selected-run, and delivery without live providers', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const incomplete = fakeProvider('fake-incomplete', ['terminal.websocket']);
  const complete = fakeProvider('fake-complete', [
    'terminal.websocket',
    'command.exec',
    'workspace.git.materialize',
    'workspace.git.deliver',
    'transcript.retained-read',
    'lifecycle.readopt',
  ]);

  const router = new mod.SandboxProviderRouter(
    [
      mod.defineCloudSandboxProvider({
        id: 'fake-incomplete',
        provider: incomplete,
        priority: 100,
        capabilities: incomplete.getProviderCapabilities(),
      }),
      mod.defineLocalSandboxProvider({
        id: 'fake-complete',
        provider: complete,
        priority: 10,
        capabilities: complete.getProviderCapabilities(),
      }),
    ],
    { ownerStore },
  );

  const cloneSpec = { url: 'https://example.test/repo.git', authHeader: 'secret' };
  const connection = await router.provision({ taskId: 'task-1', cloneSpec });

  assert.equal(connection.taskId, 'fake-complete-task-1');
  assert.deepEqual(incomplete.calls, []);
  assert.deepEqual(complete.calls[0], [
    'provision',
    'task-1',
    'https://example.test/repo.git',
  ]);

  const owner = await ownerStore.getSandboxRunOwner('task-1');
  assert.equal(owner.providerId, 'fake-complete');
  assert.equal(owner.providerSandboxId, 'fake-complete-task-1');

  const selected = await router.getSelectedSandboxRun('task-1');
  assert.equal(selected.providerId, 'fake-complete');
  assert.equal(selected.providerSandboxId, 'fake-complete-task-1');
  assert.equal(selected.terminal.protocol, 'fake-terminal-v1');
  assert.equal(selected.command.protocol, 'fake-exec-v1');
  assert.equal(selected.workspace.path, '/workspace');
  assert.equal(selected.retention.mode, 'stop-retain');
  assert.equal(selected.preflight.status, 'passed');

  const delivery = await router.deliverWorkspaceChanges('task-1', {
    branch: 'provider-e2e',
    commitMessage: 'provider conformance',
    authHeader: 'Authorization: Bearer hidden',
  });
  assert.deepEqual(delivery, {
    hadChanges: true,
    commitSha: 'fake-complete-sha',
    error: null,
  });

  await router.teardownSandbox('task-1');
  assert.deepEqual(complete.calls.at(-1), ['teardown', 'task-1']);
  assert.equal((await ownerStore.getSandboxRunOwner('task-1')).status, 'removed');
});

await test('stored owner metadata selects readoption provider before probing unrelated providers', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-readopt',
    providerId: 'fake-owner',
    providerSandboxId: 'fake-owner-task-readopt',
    connection: {
      taskId: 'fake-owner-task-readopt',
      baseUrl: 'https://fake-owner.example.test/task-readopt',
      wsUrl: 'wss://fake-owner.example.test/task-readopt',
    },
  });

  const unrelated = fakeProvider('fake-unrelated', [
    'terminal.websocket',
    'lifecycle.readopt',
  ], {
    readoptable: new Set(['task-readopt']),
  });
  const owner = fakeProvider('fake-owner', [
    'terminal.websocket',
    'command.exec',
    'workspace.git.materialize',
    'lifecycle.readopt',
  ], {
    readoptable: new Set(['task-readopt']),
  });

  const router = new mod.SandboxProviderRouter(
    [
      mod.defineCloudSandboxProvider({
        id: 'fake-unrelated',
        provider: unrelated,
        priority: 100,
        capabilities: unrelated.getProviderCapabilities(),
      }),
      mod.defineLocalSandboxProvider({
        id: 'fake-owner',
        provider: owner,
        priority: 1,
        capabilities: owner.getProviderCapabilities(),
      }),
    ],
    { ownerStore },
  );

  const connection = await router.reattach('task-readopt');
  assert.equal(connection.taskId, 'fake-owner-task-readopt');
  assert.deepEqual(unrelated.calls, []);
  assert.deepEqual(owner.calls[0], ['reattach', 'task-readopt']);

  const selected = await router.getSelectedSandboxRun('task-readopt');
  assert.equal(selected.providerId, 'fake-owner');
  assert.equal(selected.owner.providerId, 'fake-owner');
});

await test('fake conformance fails closed for missing operation capabilities', async () => {
  const provider = fakeProvider('fake-readonly', ['terminal.websocket']);
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'fake-readonly',
      provider,
      capabilities: provider.getProviderCapabilities(),
    }),
  ]);

  await assert.rejects(
    () =>
      router.provision({
        taskId: 'task-materialize',
        cloneSpec: { url: 'https://example.test/repo.git' },
      }),
    /No sandbox provider candidate satisfies required capabilities/,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
