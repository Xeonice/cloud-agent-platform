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
  onProvision,
} = {}) {
  return {
    getSandboxMode: () => mode,
    getProviderCapabilities: capabilities === undefined ? undefined : () => capabilities,
    provision: async (context) => {
      onProvision?.(context);
      return {
        taskId: context.taskId,
        baseUrl: `http://sandbox/${context.taskId}`,
        wsUrl: `ws://sandbox/${context.taskId}/ws`,
      };
    },
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
    credential: core.createExactHostGitCredential(
      'https://conformance.invalid/repository.git',
      'Authorization: Basic custom',
    ),
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

await test('conformance carries immutable resources, branch facts, deadline, and cancellation', async () => {
  let received;
  const controller = new AbortController();
  const resources = { diskSizeGb: 10 };
  const workspace = {
    repositoryUrl: 'https://example.test/repo.git',
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs: 900_000,
  };
  const scenarios = mod.createSandboxProviderConformanceScenarios(
    {
      provider: makeProvider({
        capabilities: [
          ...core.SANDBOX_PROVIDER_CAPABILITIES,
          'resource.disk-size-gb',
        ],
        onProvision: (context) => (received = context),
      }),
      taskId: 'task-resources',
      resources,
      workspace,
      cancellationSignal: controller.signal,
      expectTranscriptSource: false,
      expectReadoption: false,
    },
    assert,
  );
  await scenarios[0].run();
  await scenarios[1].run();
  assert.deepEqual(received.resources, { diskSizeGb: 10 });
  assert.notEqual(received.resources, resources);
  assert.equal(Object.isFrozen(received.resources), true);
  assert.equal(received.workspace.callerBranch, null);
  assert.equal(received.workspace.resolvedBranch, 'master');
  assert.equal(received.workspace.deadlineMs, 900_000);
  assert.equal(Object.isFrozen(received.workspace), true);
  assert.equal(received.cancellationSignal, controller.signal);

  const capabilityScenario = mod.createSandboxProviderConformanceScenarios(
    {
      provider: makeProvider({ capabilities: core.SANDBOX_PROVIDER_CAPABILITIES }),
      taskId: 'task-unsupported-resource',
      resources: { diskSizeGb: 10 },
    },
    assert,
  )[0];
  await assert.rejects(
    () => capabilityScenario.run(),
    /provider is missing required capabilities/,
  );
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

await test('generated private Git fixture rejects wildcard and unsafe URL hosts', async () => {
  await assert.rejects(
    () => mod.createGeneratedPrivateGitFixture({ listenHost: '0.0.0.0' }),
    /advertisedHost is required for a wildcard listenHost/,
  );
  await assert.rejects(
    () =>
      mod.createGeneratedPrivateGitFixture({
        listenHost: '::',
        advertisedHost: '::',
      }),
    /advertisedHost must not be a wildcard address/,
  );

  const unsafeHosts = [
    '',
    ' guest.internal',
    'https://guest.internal',
    'guest.internal:8080',
    'guest.internal/repository',
    'user@guest.internal',
    'guest.internal?query=1',
    'guest.internal#fragment',
    'guest_internal',
    '127.1',
    '[::1]',
    'fe80::1%lo0',
    123,
    null,
  ];
  for (const optionName of ['listenHost', 'advertisedHost']) {
    for (const unsafeHost of unsafeHosts) {
      await assert.rejects(
        () =>
          mod.createGeneratedPrivateGitFixture({
            [optionName]: unsafeHost,
          }),
        new RegExp(optionName),
      );
    }
  }
});

await test('generated private Git fixture advertises one safe guest host with real ports', async () => {
  const fixture = await mod.createGeneratedPrivateGitFixture({
    largeBlobBytes: 2 * 1024 * 1024,
    advertisedHost: 'Host.BoxLite.Internal',
  });
  try {
    const root = new URL(fixture.rootUrl);
    const sameOrigin = new URL(fixture.submodules.sameOriginUrl);
    const crossOrigin = new URL(fixture.submodules.crossOriginUrl);
    assert.equal(root.hostname, 'host.boxlite.internal');
    assert.equal(sameOrigin.hostname, 'host.boxlite.internal');
    assert.equal(crossOrigin.hostname, 'host.boxlite.internal');
    assert.equal(root.port, sameOrigin.port);
    assert.notEqual(root.port, crossOrigin.port);
    assert.match(root.port, /^\d+$/u);
    assert.match(crossOrigin.port, /^\d+$/u);
  } finally {
    await fixture.dispose();
  }
  assert.equal(fixture.diagnostics().activeRequests, 0);
  assert.equal(fixture.diagnostics().activeBackendProcesses, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
