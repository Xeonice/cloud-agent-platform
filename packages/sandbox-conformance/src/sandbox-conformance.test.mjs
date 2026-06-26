import assert from 'node:assert/strict';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(new URL('../../sandbox-core/dist/index.js', import.meta.url).href);

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

function makeProvider({
  capabilities = core.SANDBOX_PROVIDER_CAPABILITIES,
  transcript = { format: 'codex-rollout', jsonl: '{"type":"turn"}\n' },
  reattach = { taskId: 'task-1', baseUrl: 'http://sandbox', wsUrl: 'ws://sandbox/ws' },
  mode = 'workspace-write',
  onDeliver,
} = {}) {
  return {
    getSandboxMode: () => mode,
    getProviderCapabilities: capabilities === undefined ? undefined : () => capabilities,
    provision: async ({ taskId }) => ({
      taskId,
      baseUrl: `http://sandbox/${taskId}`,
      wsUrl: `ws://sandbox/${taskId}/ws`,
    }),
    sandboxExists: async () => true,
    deliverWorkspaceChanges: async (_taskId, args) => {
      onDeliver?.(args);
      return { hadChanges: true, commitSha: 'abc123', error: null };
    },
    readRolloutFromContainer: async () => transcript,
    listReadoptable: async () => ['task-1'],
    reattach: async () => reattach,
    teardownSandbox: async () => undefined,
    getSelectedSandboxRun: async (taskId) => ({
      taskId,
      providerId: 'fake-provider',
      provider: {},
      capabilities,
      connection: {
        taskId,
        baseUrl: `http://sandbox/${taskId}`,
        wsUrl: `ws://sandbox/${taskId}/ws`,
      },
    }),
    getTerminalDescriptor: async () => ({
      protocol: 'provider-native',
      wsUrl: 'ws://sandbox/terminal',
    }),
    getCommandDescriptor: async () => ({
      protocol: 'provider-native',
      baseUrl: 'http://sandbox/exec',
      workingDirectory: '/workspace',
    }),
    getWorkspaceDescriptor: async () => ({
      mode: 'archive',
      path: '/workspace',
      archive: { upload: true, download: true },
    }),
    getRetentionPolicy: async () => ({
      mode: 'snapshot',
      retainTranscript: true,
    }),
  };
}

await test('conformance scenarios pass for a fully capable provider', async () => {
  const scenarios = mod.createSandboxProviderConformanceScenarios(
    {
      provider: makeProvider(),
      taskId: 'task-1',
      cloneSpec: { url: 'https://example.test/repo.git' },
      runtimeId: 'codex',
      requiredCapabilities: core.SANDBOX_PROVIDER_CAPABILITIES,
    },
    assert,
  );
  assert.equal(scenarios.length, 8);
  for (const scenario of scenarios) {
    await scenario.run();
  }
});

await test('conformance scenarios honor custom delivery args and nullable reattach', async () => {
  let delivered;
  const deliverArgs = {
    authHeader: 'Authorization: Basic custom',
    branch: 'cap/custom',
    commitMessage: 'custom message',
  };
  const scenarios = mod.createSandboxProviderConformanceScenarios(
    {
      provider: makeProvider({ reattach: null, onDeliver: (args) => (delivered = args) }),
      taskId: 'task-1',
      deliverArgs,
      expectTranscriptSource: true,
    },
    assert,
  );
  for (const scenario of scenarios) {
    await scenario.run();
  }
  assert.equal(delivered, deliverArgs);
});

await test('conformance supports absent transcript and disabled readoption scenarios', async () => {
  const scenarios = mod.createSandboxProviderConformanceScenarios(
    {
      provider: makeProvider({
        capabilities: ['terminal.websocket'],
        transcript: null,
      }),
      taskId: 'task-1',
      expectTranscriptSource: false,
      expectReadoption: false,
    },
    assert,
  );
  for (const scenario of scenarios) {
    await scenario.run();
  }
});

await test('conformance adds descriptor scenarios for declared feature capabilities', async () => {
  const scenarios = mod.createSandboxProviderConformanceScenarios(
    {
      provider: makeProvider({
        capabilities: [
          ...core.SANDBOX_PROVIDER_CAPABILITIES,
          'terminal.interactive',
          'command.exec',
          'workspace.archive.transfer',
          'lifecycle.readoption',
          'lifecycle.snapshot',
        ],
      }),
      taskId: 'task-1',
      requiredCapabilities: [
        'terminal.interactive',
        'command.exec',
        'workspace.archive.transfer',
      ],
      expectSelectedRun: true,
    },
    assert,
  );

  assert(scenarios.some((scenario) => scenario.name.includes('terminal descriptor')));
  assert(scenarios.some((scenario) => scenario.name.includes('command descriptor')));
  assert(scenarios.some((scenario) => scenario.name.includes('workspace descriptor')));
  assert(scenarios.some((scenario) => scenario.name.includes('retention policy')));
  assert(scenarios.some((scenario) => scenario.name.includes('selected run')));
  for (const scenario of scenarios) {
    await scenario.run();
  }
});

await test('conformance reports missing expected transcript sources', async () => {
  const scenario = mod.createSandboxProviderConformanceScenarios(
    {
      provider: makeProvider({ transcript: null }),
      taskId: 'task-1',
    },
    assert,
  ).find((entry) => entry.name.startsWith('retained transcript'));
  await assert.rejects(() => scenario.run(), /transcript source should be present/);
});

await test('conformance reports missing selected-run and feature descriptors', async () => {
  const selectedRunScenario = mod.createSandboxProviderConformanceScenarios(
    {
      provider: {
        ...makeProvider(),
        getSelectedSandboxRun: async () => null,
      },
      taskId: 'task-1',
      expectSelectedRun: true,
    },
    assert,
  ).find((entry) => entry.name.startsWith('selected run descriptor'));
  await assert.rejects(
    () => selectedRunScenario.run(),
    /selected run descriptor should be present/,
  );

  const terminalScenario = mod.createSandboxProviderConformanceScenarios(
    {
      provider: {
        ...makeProvider({
          capabilities: ['terminal.websocket', 'terminal.interactive'],
        }),
        getTerminalDescriptor: async () => null,
      },
      taskId: 'task-1',
    },
    assert,
  ).find((entry) => entry.name.startsWith('interactive terminal capability'));
  await assert.rejects(
    () => terminalScenario.run(),
    /terminal descriptor should be present/,
  );

  const commandScenario = mod.createSandboxProviderConformanceScenarios(
    {
      provider: {
        ...makeProvider({ capabilities: ['command.exec'] }),
        getCommandDescriptor: async () => null,
      },
      taskId: 'task-1',
    },
    assert,
  ).find((entry) => entry.name.startsWith('command execution capability'));
  await assert.rejects(
    () => commandScenario.run(),
    /command descriptor should be present/,
  );

  const workspaceScenario = mod.createSandboxProviderConformanceScenarios(
    {
      provider: {
        ...makeProvider({ capabilities: ['workspace.archive.transfer'] }),
        getWorkspaceDescriptor: async () => null,
      },
      taskId: 'task-1',
    },
    assert,
  ).find((entry) => entry.name.startsWith('archive workspace capability'));
  await assert.rejects(
    () => workspaceScenario.run(),
    /workspace descriptor should be present/,
  );
});

await test('conformance can be used with non-throwing assertion adapters', async () => {
  const calls = [];
  const softAssert = {
    ok(value, message) {
      calls.push(['ok', value, message]);
    },
    equal(actual, expected, message) {
      calls.push(['equal', actual, expected, message]);
    },
    deepEqual(actual, expected, message) {
      calls.push(['deepEqual', actual, expected, message]);
    },
  };
  await mod.createSandboxProviderConformanceScenarios(
    {
      provider: makeProvider({ capabilities: undefined }),
      taskId: 'task-1',
      requiredCapabilities: ['terminal.websocket'],
    },
    softAssert,
  )[0].run();
  assert(calls.some((call) => call.includes('provider must declare capabilities')));
});

await test('capability scenario supports omitted required capability lists', async () => {
  const calls = [];
  const softAssert = {
    ok(value, message) {
      calls.push(['ok', value, message]);
    },
    equal(actual, expected, message) {
      calls.push(['equal', actual, expected, message]);
    },
    deepEqual(actual, expected, message) {
      calls.push(['deepEqual', actual, expected, message]);
    },
  };
  await mod.createSandboxProviderConformanceScenarios(
    {
      provider: {
        ...makeProvider(),
        getProviderCapabilities: () => undefined,
      },
      taskId: 'task-1',
    },
    softAssert,
  )[0].run();
  assert(
    calls.some(
      (call) =>
        call[0] === 'deepEqual' &&
        Array.isArray(call[1]) &&
        call[1].length === 0 &&
        Array.isArray(call[2]) &&
        call[2].length === 0,
    ),
  );
});

await test('shape assertion helpers accept nullable fields and omit task id check when requested', () => {
  mod.assertSandboxConnection(
    { taskId: 'other', baseUrl: 'http://sandbox', wsUrl: 'ws://sandbox/ws' },
    undefined,
    assert,
  );
  mod.assertSandboxDeliverWorkspaceResult(
    { hadChanges: false, commitSha: null, error: 'delivery failed' },
    assert,
  );
  mod.assertSandboxTranscriptSource({ format: 'codex-rollout', jsonl: '' }, assert);
  mod.assertTerminalDescriptor({ protocol: 'provider-native' }, assert);
  mod.assertTerminalDescriptor({ protocol: 'provider-native', url: 'http://terminal' }, assert);
  mod.assertCommandDescriptor({ protocol: 'provider-native' }, assert);
  mod.assertWorkspaceDescriptor({ mode: 'archive' }, assert);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
