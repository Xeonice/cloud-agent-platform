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

function createProviderBehaviorFixture({
  omitTerminalKind,
  terminalOutcome = 'attached',
  terminalTraceTaskId,
  workspaceSandboxTaskId,
  reattachResult = true,
  ownerTaskId = 'task-behavior',
  ownerProviderId = 'behavior-provider',
} = {}) {
  const taskId = 'task-behavior';
  const providerId = 'behavior-provider';
  const capabilities = [
    'terminal.websocket',
    'terminal.interactive',
    'command.exec',
    'workspace.git.materialize',
    'workspace.git.deliver',
    'transcript.retained-read',
    'lifecycle.readopt',
  ];
  const terminalTrace = [];
  const commandTrace = [];
  const workspaceTrace = [];
  const ownershipTrace = [];
  let materialized = false;

  const append = (trace, event, overrides = {}) => {
    trace.push({
      sequence: trace.length + 1,
      taskId,
      providerId,
      ...overrides,
      ...event,
    });
  };
  const connection = () => ({
    taskId,
    baseUrl: `http://sandbox/${taskId}`,
    wsUrl: `ws://sandbox/${taskId}/ws`,
  });

  let provider;
  provider = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => capabilities,
    async provision(context) {
      if (!materialized && context.workspace) {
        materialized = true;
        for (const kind of [
          'materialize-start',
          'materialize-operation',
          'materialize-settled',
        ]) {
          append(workspaceTrace, {
            kind,
            sandboxTaskId: workspaceSandboxTaskId ?? context.taskId,
            ...(kind === 'materialize-settled'
              ? { outcome: 'succeeded' }
              : {}),
          });
        }
      }
      return connection();
    },
    async sandboxExists() {
      return true;
    },
    async deliverWorkspaceChanges(deliveryTaskId) {
      for (const kind of [
        'delivery-start',
        'delivery-command',
        'delivery-settled',
      ]) {
        append(workspaceTrace, {
          kind,
          sandboxTaskId: workspaceSandboxTaskId ?? deliveryTaskId,
          ...(kind === 'delivery-settled' ? { outcome: 'succeeded' } : {}),
        });
      }
      return { hadChanges: true, commitSha: 'behavior-sha', error: null };
    },
    async readRolloutFromContainer() {
      return { format: 'codex-rollout', jsonl: '' };
    },
    async teardownSandbox() {},
    async getSelectedSandboxRun(selectedTaskId) {
      if (ownershipTrace.length === 0) {
        append(ownershipTrace, { kind: 'provider-selected' });
      }
      return {
        taskId: selectedTaskId,
        providerId,
        providerSandboxId: 'behavior-sandbox',
        provider,
        capabilities,
        connection: connection(),
        owner: {
          taskId: ownerTaskId,
          providerId: ownerProviderId,
          status: 'running',
          connection: connection(),
        },
      };
    },
    async listReadoptable() {
      append(ownershipTrace, { kind: 'readoptable-listed' });
      return [taskId];
    },
    async reattach(_taskId, target) {
      append(ownershipTrace, {
        kind: 'reattached',
        providerSandboxIdMatched:
          target?.providerSandboxId === 'behavior-sandbox',
        ownershipFenceMatched:
          target?.ownership?.ownerGeneration === 'owner-generation' &&
          target?.ownership?.resourceGeneration === 'resource-generation',
      });
      return reattachResult ? connection() : null;
    },
  };

  function createTerminalSession(replacement) {
    const listeners = new Set();
    let closed = false;
    if (replacement) append(terminalTrace, { kind: 'replacement' });
    append(
      terminalTrace,
      { kind: 'attach', outcome: terminalOutcome },
      terminalTraceTaskId === undefined ? {} : { taskId: terminalTraceTaskId },
    );
    const terminal = {
      launchDecision: Promise.resolve({ kind: terminalOutcome }),
      onData(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      write(data) {
        if (omitTerminalKind !== 'input') {
          append(terminalTrace, { kind: 'input', data });
        }
      },
      resize(cols, rows) {
        if (omitTerminalKind !== 'resize') {
          append(terminalTrace, { kind: 'resize', cols, rows });
        }
      },
      pause() {},
      resume() {},
      close() {
        if (!closed) {
          closed = true;
          if (omitTerminalKind !== 'close') {
            append(terminalTrace, { kind: 'close' });
          }
        }
      },
    };
    return {
      taskId,
      providerId,
      terminal,
      emitProviderOutput(data) {
        if (omitTerminalKind !== 'output') {
          append(terminalTrace, { kind: 'output', data });
        }
        for (const listener of listeners) listener(data);
      },
    };
  }

  return {
    taskId,
    providerId,
    provider,
    workspace: {
      repositoryUrl: 'https://conformance.invalid/repository.git',
      callerBranch: null,
      resolvedBranch: 'cap-conformance',
      deadlineMs: 30_000,
      credential: core.createExactHostGitCredential(
        'https://conformance.invalid/repository.git',
        'Authorization: Basic behavior-token',
      ),
    },
    behavior: {
      terminal: {
        open: () => createTerminalSession(false),
        replace: () => createTerminalSession(true),
        readTrace: () => terminalTrace,
      },
      command: {
        open: () => ({
          taskId,
          providerId,
          executor: {
            async exec() {
              append(commandTrace, { kind: 'execute' });
              const result = {
                exitCode: 0,
                output: 'ok',
                stdout: 'ok',
                stderr: '',
                timedOut: false,
              };
              append(commandTrace, {
                kind: 'settled',
                exitCode: result.exitCode,
                timedOut: result.timedOut,
              });
              return result;
            },
          },
        }),
        readTrace: () => commandTrace,
      },
      workspace: {
        readTrace: () => workspaceTrace,
      },
      ownership: {
        readoptionTarget: () => ({
          providerSandboxId: 'behavior-sandbox',
          ownership: {
            ownerGeneration: 'owner-generation',
            resourceGeneration: 'resource-generation',
          },
        }),
        readTrace: () => ownershipTrace,
      },
    },
  };
}

await test('opt-in provider behavior conformance executes closed task-owned traces', async () => {
  const fixture = createProviderBehaviorFixture();
  const scenarios = mod.createSandboxProviderBehaviorConformanceScenarios(
    {
      provider: fixture.provider,
      taskId: fixture.taskId,
      workspace: fixture.workspace,
      behavior: fixture.behavior,
      expectTranscriptSource: true,
    },
    assert,
  );
  assert.deepEqual(
    scenarios.map((scenario) => scenario.name),
    [
      'behavior adapters cover every advertised provider-owned capability',
      'interactive terminal behavior preserves attach and replacement ownership',
      'command executor behavior runs in the selected provider task',
      'workspace behavior materializes and delivers in the selected provider task',
      'ownership behavior readopts only the selected provider task',
    ],
  );
  for (const scenario of scenarios) await scenario.run();
});

await test('provider behavior conformance rejects missing terminal steps', async () => {
  const fixture = createProviderBehaviorFixture({ omitTerminalKind: 'resize' });
  const terminal = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: fixture.provider,
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      assert,
    )
    .find((scenario) => scenario.name.startsWith('interactive terminal behavior'));
  await assert.rejects(
    () => terminal.run(),
    /terminal behavior trace must preserve action order and ownership/u,
  );
});

await test('provider behavior conformance rejects wrong terminal task identity', async () => {
  const fixture = createProviderBehaviorFixture({
    terminalTraceTaskId: 'different-task',
  });
  const terminal = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: fixture.provider,
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      assert,
    )
    .find((scenario) => scenario.name.startsWith('interactive terminal behavior'));
  await assert.rejects(
    () => terminal.run(),
    /terminal behavior trace must preserve action order and ownership/u,
  );
});

await test('provider behavior conformance rejects wrong workspace sandbox ownership', async () => {
  const fixture = createProviderBehaviorFixture({
    workspaceSandboxTaskId: 'different-sandbox-task',
  });
  const workspace = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: fixture.provider,
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      assert,
    )
    .find((scenario) => scenario.name.startsWith('workspace behavior'));
  await assert.rejects(
    () => workspace.run(),
    /workspace behavior trace must prove materialization and delivery executor ownership/u,
  );
});

await test('provider behavior conformance rejects mismatched selected ownership', async () => {
  const fixture = createProviderBehaviorFixture({ ownerProviderId: 'different-provider' });
  const ownership = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: fixture.provider,
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      assert,
    )
    .find((scenario) => scenario.name.startsWith('ownership behavior'));
  await assert.rejects(
    () => ownership.run(),
    /selected run owner providerId must match/u,
  );
});

await test('provider behavior conformance rejects missing adapters for advertised capabilities', async () => {
  const fixture = createProviderBehaviorFixture();
  const capability = mod.createSandboxProviderBehaviorConformanceScenarios(
    {
      provider: fixture.provider,
      taskId: fixture.taskId,
      workspace: fixture.workspace,
      behavior: {},
    },
    assert,
  )[0];
  await assert.rejects(
    () => capability.run(),
    /interactive terminal capability requires a behavior adapter/u,
  );
});

await test('provider behavior conformance supports providers with no behavioral capabilities', async () => {
  const fixture = createProviderBehaviorFixture();
  const scenarios = mod.createSandboxProviderBehaviorConformanceScenarios(
    {
      provider: {
        ...fixture.provider,
        getProviderCapabilities: undefined,
      },
      taskId: fixture.taskId,
      behavior: {},
    },
    assert,
  );
  assert.equal(scenarios.length, 1);
  await scenarios[0].run();
});

await test('provider behavior conformance requires a selected run', async () => {
  const fixture = createProviderBehaviorFixture();
  const terminal = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: {
          ...fixture.provider,
          getSelectedSandboxRun: async () => null,
        },
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      assert,
    )
    .find((scenario) => scenario.name.startsWith('interactive terminal behavior'));
  await assert.rejects(
    () => terminal.run(),
    /Behavior conformance requires a selected provider run/u,
  );
});

await test('provider behavior conformance requires terminal close support', async () => {
  const fixture = createProviderBehaviorFixture();
  const open = fixture.behavior.terminal.open;
  fixture.behavior.terminal.open = async (context) => {
    const session = await open(context);
    delete session.terminal.close;
    return session;
  };
  const terminal = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: fixture.provider,
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      assert,
    )
    .find((scenario) => scenario.name.startsWith('interactive terminal behavior'));
  await assert.rejects(
    () => terminal.run(),
    /Interactive terminal behavior requires close support/u,
  );
});

await test('provider behavior conformance accepts provider-launched terminal sessions', async () => {
  const fixture = createProviderBehaviorFixture({ terminalOutcome: 'launched' });
  const terminal = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: fixture.provider,
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      assert,
    )
    .find((scenario) => scenario.name.startsWith('interactive terminal behavior'));
  await terminal.run();
});

await test('provider behavior conformance rejects an unestablished terminal session', async () => {
  const fixture = createProviderBehaviorFixture({ terminalOutcome: 'failed' });
  const nonThrowingAttachAssert = {
    ok(value, message) {
      if (message === 'terminal launch decision must prove attach or launch') return;
      assert.ok(value, message);
    },
    equal: assert.equal,
    deepEqual: assert.deepEqual,
  };
  const terminal = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: fixture.provider,
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      nonThrowingAttachAssert,
    )
    .find((scenario) => scenario.name.startsWith('interactive terminal behavior'));
  await assert.rejects(
    () => terminal.run(),
    /Terminal behavior did not establish an attachable session/u,
  );
});

await test('provider behavior conformance requires a staged workspace plan', async () => {
  for (const workspacePlan of [undefined, null]) {
    const fixture = createProviderBehaviorFixture();
    const workspace = mod
      .createSandboxProviderBehaviorConformanceScenarios(
        {
          provider: fixture.provider,
          taskId: fixture.taskId,
          workspace: workspacePlan,
          behavior: fixture.behavior,
        },
        assert,
      )
      .find((scenario) => scenario.name.startsWith('workspace behavior'));
    await assert.rejects(
      () => workspace.run(),
      /Workspace behavior conformance requires a staged materialization plan/u,
    );
  }
});

await test('provider behavior conformance requires a successful reattach', async () => {
  const fixture = createProviderBehaviorFixture({ reattachResult: false });
  const ownership = mod
    .createSandboxProviderBehaviorConformanceScenarios(
      {
        provider: fixture.provider,
        taskId: fixture.taskId,
        workspace: fixture.workspace,
        behavior: fixture.behavior,
      },
      assert,
    )
    .find((scenario) => scenario.name.startsWith('ownership behavior'));
  await assert.rejects(
    () => ownership.run(),
    /Selected provider task must be reattached/u,
  );
});

await test('provider behavior conformance rejects a mismatched readoption target and fence', async () => {
  for (const readoptionTarget of [
    {
      providerSandboxId: 'different-sandbox',
      ownership: {
        ownerGeneration: 'owner-generation',
        resourceGeneration: 'resource-generation',
      },
    },
    {
      providerSandboxId: 'behavior-sandbox',
      ownership: {
        ownerGeneration: '',
        resourceGeneration: 'resource-generation',
      },
    },
  ]) {
    const fixture = createProviderBehaviorFixture();
    fixture.behavior.ownership.readoptionTarget = () => readoptionTarget;
    const ownership = mod
      .createSandboxProviderBehaviorConformanceScenarios(
        {
          provider: fixture.provider,
          taskId: fixture.taskId,
          workspace: fixture.workspace,
          behavior: fixture.behavior,
        },
        assert,
      )
      .find((scenario) => scenario.name.startsWith('ownership behavior'));
    await assert.rejects(
      () => ownership.run(),
      /readoption target must/u,
    );
  }
});

async function emitDiagnosticPair(
  diagnostics,
  {
    stage = 'sandbox_creation',
    operation = 'sandbox_create',
    channel = 'primary',
    commandKind,
    outcome = 'succeeded',
    cause = outcome === 'succeeded' ? null : 'unknown',
    retryable = false,
    replay = false,
  } = {},
) {
  const operationId = diagnostics.createOperationId();
  const common = {
    operationId,
    stage,
    operation,
    channel,
    ...(commandKind === undefined ? {} : { commandKind }),
  };
  const started = { ...common, outcome: 'started' };
  const terminal = { ...common, outcome, cause, retryable };
  await diagnostics.emit(started);
  if (replay) await diagnostics.emit(started);
  await diagnostics.emit(terminal);
  if (replay) await diagnostics.emit(terminal);
}

const providerLocalWorkspaceCredential = Object.freeze({
  kind: 'provider-local-secret',
  providerCapabilities: Object.freeze(['workspace.git.materialize']),
});
const rejectingWorkspaceCredential = Object.freeze({
  kind: 'reject-before-external-boundary',
  providerCapabilities: Object.freeze(['terminal.websocket']),
});

function createDiagnosticConformanceExercise({
  omitCleanupFor,
  providerFamily = 'boxlite',
  workspaceCredentialKind = 'provider-local-secret',
} = {}) {
  return async (input) => {
    const normalizedCleanupFailure = () =>
      core.runSandboxPhysicalCleanup(async () => ({
        ...input.cleanupFailure,
      }));

    if (input.scenario === 'taskless-probe') {
      assert.equal(input.diagnostics.mode, 'non-persisting');
      assert.equal(Object.hasOwn(input, 'taskId'), false);
      assert.equal(Object.hasOwn(input, 'attemptContext'), false);
    } else {
      assert.equal(input.diagnostics.mode, 'task');
      assert.equal(input.taskId, input.attemptContext.taskId);
      assert.deepEqual(input.attemptContext, input.diagnostics.attemptContext);
      assert.deepEqual(Object.keys(input.attemptContext).sort(), [
        'admissionMode',
        'attempt',
        'attemptId',
        'providerFamily',
        'schemaVersion',
        'taskId',
      ]);
      assert.equal(Object.hasOwn(input.diagnostics, 'record'), false);
      const providerContext = {
        taskId: input.taskId,
        diagnostics: input.diagnostics,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
      };
      let receivedContext;
      await makeProvider({
        onProvision: (context) => {
          context.diagnostics.bindProviderFamily(providerFamily);
          receivedContext = context;
        },
      }).provision(providerContext);
      assert.equal(receivedContext.taskId, input.taskId);
      assert.equal(receivedContext.diagnostics, input.diagnostics);
    }

    switch (input.scenario) {
      case 'bounded-start-terminal':
        await emitDiagnosticPair(input.diagnostics);
        return;
      case 'replay-deduplication':
        await emitDiagnosticPair(input.diagnostics, { replay: true });
        return;
      case 'timeout':
        await emitDiagnosticPair(input.diagnostics, {
          outcome: 'timed_out',
          cause: 'settlement_unknown',
          retryable: true,
        });
        if (omitCleanupFor !== input.scenario) {
          await emitDiagnosticPair(input.diagnostics, {
            stage: 'cleanup',
            operation: 'sandbox_absence_confirm',
            channel: 'cleanup',
            commandKind: 'sandbox_cleanup',
          });
        }
        return;
      case 'cancellation':
        await emitDiagnosticPair(input.diagnostics, {
          outcome: 'cancelled',
          cause: 'cancelled',
        });
        if (omitCleanupFor !== input.scenario) {
          await emitDiagnosticPair(input.diagnostics, {
            stage: 'cleanup',
            operation: 'sandbox_delete',
            channel: 'cleanup',
            commandKind: 'sandbox_cleanup',
          });
        }
        return;
      case 'indeterminate-settlement':
        await emitDiagnosticPair(input.diagnostics, {
          outcome: 'indeterminate',
          cause: 'settlement_unknown',
          retryable: true,
        });
        if (omitCleanupFor !== input.scenario) {
          await emitDiagnosticPair(input.diagnostics, {
            stage: 'cleanup',
            operation: 'sandbox_absence_confirm',
            channel: 'cleanup',
            commandKind: 'sandbox_cleanup',
            outcome: 'indeterminate',
            cause: 'cleanup_unconfirmed',
            retryable: true,
          });
        }
        return;
      case 'primary-plus-cleanup-failure':
        await emitDiagnosticPair(input.diagnostics, {
          outcome: 'failed',
          cause: 'provider_unavailable',
          retryable: true,
        });
        await emitDiagnosticPair(input.diagnostics, {
          stage: 'cleanup',
          operation: 'sandbox_delete',
          channel: 'cleanup',
          commandKind: 'sandbox_cleanup',
          outcome: 'indeterminate',
          cause: 'cleanup_unconfirmed',
          retryable: true,
        });
        return core.preserveSandboxPrimaryWithCleanup(
          input.primaryFailure,
          await normalizedCleanupFailure(),
        );
      case 'credential-cleanup-failure':
        if (workspaceCredentialKind === 'reject-before-external-boundary') {
          return {
            rejection: {
              code: 'sandbox_provider_configuration_error',
              message: 'Canonical workspace credentials are unsupported',
            },
            externalBoundaryCalls: 0,
          };
        }
        await emitDiagnosticPair(input.diagnostics, {
          stage: 'workspace_transfer',
          operation: 'repository_transfer',
          commandKind: 'git_clone',
          outcome: 'failed',
          cause: 'transport_failed',
          retryable: true,
        });
        await emitDiagnosticPair(input.diagnostics, {
          stage: 'credential_cleanup',
          operation: 'credential_cleanup',
          channel: 'cleanup',
          commandKind: 'credential_cleanup',
          outcome: 'failed',
          cause: 'cleanup_failed',
        });
        return {
          primary: input.primaryFailure,
          cleanup: await normalizedCleanupFailure(),
        };
      case 'taskless-probe':
        await emitDiagnosticPair(input.diagnostics, {
          stage: 'readiness',
          operation: 'sandbox_inspect',
        });
        return { probe: input.probeResult };
      case 'raw-provider-secret-canary': {
        const operationId = input.diagnostics.createOperationId();
        await assert.rejects(
          input.diagnostics.emit({
            operationId,
            stage: 'sandbox_creation',
            operation: 'sandbox_create',
            channel: 'primary',
            outcome: 'started',
            requestBody: input.canaries.providerBody,
            rawError: input.canaries.providerError,
            command: input.canaries.command,
            stdout: input.canaries.output,
            token: input.canaries.secret,
          }),
          (error) =>
            error?.code === 'sandbox_provisioning_diagnostic_validation_error' &&
            Object.values(input.canaries).every(
              (canary) => !error.message.includes(canary),
            ),
        );
        await emitDiagnosticPair(input.diagnostics, {
          outcome: 'failed',
          cause: 'unknown',
        });
        await emitDiagnosticPair(input.diagnostics, {
          stage: 'cleanup',
          operation: 'sandbox_delete',
          channel: 'cleanup',
          commandKind: 'sandbox_cleanup',
          outcome: 'indeterminate',
          cause: 'cleanup_unconfirmed',
          retryable: true,
        });
        return {
          primary: input.primaryFailure,
          cleanup: await normalizedCleanupFailure(),
        };
      }
      case 'diagnostic-write-failure':
        await assert.rejects(
          emitDiagnosticPair(input.diagnostics),
          /Sandbox diagnostic conformance recorder unavailable/,
        );
        return {
          primary: input.primaryFailure,
          cleanup: await normalizedCleanupFailure(),
        };
    }
  };
}

await test('opt-in diagnostic conformance covers deterministic provider fault scenarios', async () => {
  const scenarios = mod.createSandboxProviderDiagnosticConformanceScenarios(
    {
      providerFamily: 'boxlite',
      workspaceCredential: providerLocalWorkspaceCredential,
      exercise: createDiagnosticConformanceExercise(),
    },
    assert,
  );
  assert.deepEqual(
    scenarios.map((scenario) => scenario.name),
    mod.SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CASES.map(
      (scenario) => `provider diagnostics: ${scenario}`,
    ),
  );
  for (const scenario of scenarios) await scenario.run();
});

await test('diagnostic conformance rejects unsettled primary outcomes without cleanup', async () => {
  for (const scenarioName of [
    'timeout',
    'cancellation',
    'indeterminate-settlement',
  ]) {
    const scenario = mod
      .createSandboxProviderDiagnosticConformanceScenarios(
        {
          providerFamily: 'boxlite',
          workspaceCredential: providerLocalWorkspaceCredential,
          exercise: createDiagnosticConformanceExercise({
            omitCleanupFor: scenarioName,
          }),
        },
        assert,
      )
      .find((entry) => entry.name === `provider diagnostics: ${scenarioName}`);
    await assert.rejects(
      () => scenario.run(),
      /must start an independent cleanup lifecycle/u,
    );
  }
});

await test('taskless diagnostic conformance still rejects unsafe provider facts', async () => {
  const scenario = mod
    .createSandboxProviderDiagnosticConformanceScenarios(
      {
        providerFamily: 'boxlite',
        workspaceCredential: providerLocalWorkspaceCredential,
        async exercise(input) {
          assert.equal(input.scenario, 'taskless-probe');
          await input.diagnostics.emit({
            operationId: input.diagnostics.createOperationId(),
            stage: 'readiness',
            operation: 'sandbox_inspect',
            channel: 'primary',
            outcome: 'started',
            rawError: input.canaries.providerError,
          });
        },
      },
      assert,
    )
    .find((entry) => entry.name === 'provider diagnostics: taskless-probe');
  await assert.rejects(
    () => scenario.run(),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error' &&
      !error.message.includes(
        mod.SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CANARIES.providerError,
      ),
  );
});

await test('taskless diagnostic conformance requires the controlled probe result', async () => {
  const scenario = mod
    .createSandboxProviderDiagnosticConformanceScenarios(
      {
        providerFamily: 'boxlite',
        workspaceCredential: providerLocalWorkspaceCredential,
        exercise: async () => undefined,
      },
      assert,
    )
    .find((entry) => entry.name === 'provider diagnostics: taskless-probe');
  await assert.rejects(
    () => scenario.run(),
    /diagnostics must not alter the probe result/u,
  );
});

await test('diagnostic conformance keeps all cases for boundary-rejected credentials', async () => {
  const scenarios = mod.createSandboxProviderDiagnosticConformanceScenarios(
    {
      providerFamily: 'cloud-http',
      workspaceCredential: rejectingWorkspaceCredential,
      exercise: createDiagnosticConformanceExercise({
        providerFamily: 'cloud-http',
        workspaceCredentialKind: 'reject-before-external-boundary',
      }),
    },
    assert,
  );
  assert.deepEqual(
    scenarios.map((scenario) => scenario.name),
    mod.SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CASES.map(
      (scenario) => `provider diagnostics: ${scenario}`,
    ),
  );
  for (const scenario of scenarios) await scenario.run();
});

await test('diagnostic conformance rejects credential mode and capability mismatches', () => {
  assert.throws(
    () =>
      mod.createSandboxProviderDiagnosticConformanceScenarios(
        {
          providerFamily: 'cloud-http',
          workspaceCredential: {
            kind: 'provider-local-secret',
            providerCapabilities: ['terminal.websocket'],
          },
          exercise: createDiagnosticConformanceExercise(),
        },
        assert,
      ),
    /provider-local-secret credential conformance requires workspace\.git/u,
  );
  assert.throws(
    () =>
      mod.createSandboxProviderDiagnosticConformanceScenarios(
        {
          providerFamily: 'cloud-http',
          workspaceCredential: {
            kind: 'reject-before-external-boundary',
            providerCapabilities: ['workspace.git.deliver'],
          },
          exercise: createDiagnosticConformanceExercise(),
        },
        assert,
      ),
    /reject-before-external-boundary credential conformance cannot declare workspace\.git/u,
  );
});

function rejectingCredentialScenario(exercise) {
  return mod
    .createSandboxProviderDiagnosticConformanceScenarios(
      {
        providerFamily: 'cloud-http',
        workspaceCredential: rejectingWorkspaceCredential,
        exercise: async (input) => {
          if (input.scenario !== 'taskless-probe') {
            input.diagnostics.bindProviderFamily('cloud-http');
          }
          return exercise(input);
        },
      },
      assert,
    )
    .find(
      (entry) =>
        entry.name === 'provider diagnostics: credential-cleanup-failure',
    );
}

await test('diagnostic conformance requires the provider to bind its real family', async () => {
  const scenario = mod
    .createSandboxProviderDiagnosticConformanceScenarios(
      {
        providerFamily: 'boxlite',
        workspaceCredential: providerLocalWorkspaceCredential,
        async exercise(input) {
          assert.notEqual(input.scenario, 'taskless-probe');
          await emitDiagnosticPair(input.diagnostics);
        },
      },
      assert,
    )
    .find(
      (entry) =>
        entry.name === 'provider diagnostics: bounded-start-terminal',
    );
  await assert.rejects(
    () => scenario.run(),
    /must bind its real diagnostic family/u,
  );
});

await test('workspace evidence cannot masquerade as sandbox create conformance', async () => {
  const scenario = mod
    .createSandboxProviderDiagnosticConformanceScenarios(
      {
        providerFamily: 'boxlite',
        workspaceCredential: providerLocalWorkspaceCredential,
        async exercise(input) {
          assert.notEqual(input.scenario, 'taskless-probe');
          input.diagnostics.bindProviderFamily('boxlite');
          await emitDiagnosticPair(input.diagnostics, {
            stage: 'workspace_transfer',
            operation: 'repository_transfer',
            commandKind: 'git_clone',
          });
        },
      },
      assert,
    )
    .find(
      (entry) =>
        entry.name === 'provider diagnostics: bounded-start-terminal',
    );
  await assert.rejects(
    () => scenario.run(),
    /successful sandbox create settlement/u,
  );
});

await test('boundary-rejected credential conformance forbids external calls', async () => {
  const scenario = rejectingCredentialScenario(async () => ({
    rejection: { code: 'sandbox_provider_configuration_error' },
    externalBoundaryCalls: 1,
  }));
  await assert.rejects(
    () => scenario.run(),
    /before any provider external boundary/u,
  );
});

await test('boundary-rejected credential conformance forbids synthetic events', async () => {
  const scenario = rejectingCredentialScenario(async (input) => {
    await emitDiagnosticPair(input.diagnostics);
    return {
      rejection: { code: 'sandbox_provider_configuration_error' },
      externalBoundaryCalls: 0,
    };
  });
  await assert.rejects(
    () => scenario.run(),
    /must not fabricate diagnostic facts/u,
  );
});

await test('boundary-rejected credential conformance rejects canary leakage', async () => {
  const scenario = rejectingCredentialScenario(async (input) => ({
    rejection: {
      code: 'sandbox_provider_configuration_error',
      message: input.canaries.secret,
    },
    externalBoundaryCalls: 0,
  }));
  await assert.rejects(
    () => scenario.run(),
    /must contain no raw provider or secret canary/u,
  );
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
