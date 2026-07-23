import assert from 'node:assert/strict';

const aio = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);
const conformance = await import(
  new URL('../../sandbox-conformance/dist/index.js', import.meta.url).href
);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

function dockerNotFound() {
  return Object.assign(new Error('provider-private missing container'), {
    statusCode: 404,
  });
}

function createFakeDocker(options = {}) {
  const byReference = new Map();
  const created = [];
  let sequence = 0;

  function missingContainer() {
    return {
      async start() {
        throw dockerNotFound();
      },
      async stop() {
        throw dockerNotFound();
      },
      async remove() {
        throw dockerNotFound();
      },
      async inspect() {
        throw dockerNotFound();
      },
      async getArchive() {
        throw dockerNotFound();
      },
      async putArchive() {
        throw dockerNotFound();
      },
    };
  }

  return {
    created,
    getImage() {
      return {
        async inspect() {
          return { Id: 'sha256:aio-diagnostic-conformance' };
        },
      };
    },
    getContainer(reference) {
      return byReference.get(reference) ?? missingContainer();
    },
    async createContainer(containerOptions) {
      await options.onCreate?.(containerOptions);
      if (options.createError !== undefined) throw options.createError;
      const id =
        options.providerSandboxId ??
        `aio-native-conformance-${String(++sequence).padStart(4, '0')}`;
      let running = false;
      let removed = false;
      const calls = [];
      const container = {
        id,
        calls,
        isRunning() {
          return running && !removed;
        },
        isRemoved() {
          return removed;
        },
        async start() {
          calls.push(['start']);
          if (options.startBecomesRunning) running = true;
          if (options.startError !== undefined) throw options.startError;
          running = true;
        },
        async stop() {
          calls.push(['stop']);
          if (options.stopError !== undefined) throw options.stopError;
          running = false;
        },
        async remove() {
          calls.push(['remove']);
          if (options.removeError !== undefined) throw options.removeError;
          removed = true;
          running = false;
        },
        async inspect() {
          calls.push(['inspect']);
          if (removed) throw dockerNotFound();
          return {
            Id: id,
            Config: {
              Image: containerOptions.Image,
              Env: containerOptions.Env,
              Labels: {
                ...(options.resourceGenerationLabel === undefined
                  ? {}
                  : {
                      [aio.AIO_SANDBOX_RESOURCE_GENERATION_LABEL]:
                        options.resourceGenerationLabel,
                    }),
                ...(containerOptions.Labels ?? {}),
              },
            },
            HostConfig: {
              NetworkMode: containerOptions.HostConfig.NetworkMode,
            },
            State: { Running: running },
          };
        },
        async getArchive() {
          calls.push(['getArchive']);
          throw new Error('archive read is not used by diagnostic conformance');
        },
        async putArchive(stream) {
          calls.push(['putArchive']);
          for await (const _chunk of stream) {
            // Consume provider-private bytes without retaining them.
          }
        },
      };
      byReference.set(containerOptions.name, container);
      byReference.set(id, container);
      created.push({ options: containerOptions, container });
      return container;
    },
    async listContainers() {
      return created
        .filter(({ container }) => container.isRunning())
        .map(({ options: containerOptions, container }) => ({
          Id: container.id,
          Names: [`/${containerOptions.name}`],
        }));
    },
  };
}

function response(status, body = { data: { exit_code: 0, output: '' } }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createProvider(options = {}) {
  const docker = options.docker ?? createFakeDocker(options);
  let shellExecCalls = 0;
  const shellCommands = [];
  const fetch = async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/v1/docs') {
      if (options.readinessError !== undefined) throw options.readinessError;
      return response(options.readinessStatus ?? 200);
    }
    if (path === '/v1/shell/exec') {
      shellExecCalls += 1;
      if (typeof init?.body === 'string') {
        const payload = JSON.parse(init.body);
        if (typeof payload.command === 'string') shellCommands.push(payload.command);
      }
      if (options.failSecretDelete && shellExecCalls >= 2) {
        return response(200, {
          data: { exit_code: 1, output: options.secretOutput ?? 'provider-private' },
        });
      }
      if (options.shellExecBody !== undefined) {
        return response(200, options.shellExecBody);
      }
      return response(200);
    }
    return response(404);
  };
  const controller = new aio.AioSandboxContainerController({
    docker,
    fetch,
    delay: async () => undefined,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:diagnostic-conformance',
      AIO_SANDBOX_READINESS_TIMEOUT_MS: '2',
    },
  });
  return {
    docker,
    controller,
    shellCommands,
    provider: new aio.AioSandboxProvider({
      controller,
      fetch,
      hooks: options.hooks,
      capabilities: options.capabilities,
    }),
  };
}

function createDiagnosticProvider(options = {}) {
  return createProvider({
    ...options,
    hooks: {
      workspaceMaterialization: async () => ({
        status: 'succeeded',
        stage: 'complete',
      }),
      ...options.hooks,
    },
  });
}

function appendBehaviorTrace(trace, taskId, providerId, event) {
  trace.push({
    sequence: trace.length + 1,
    taskId,
    providerId,
    ...event,
  });
}

function createAioBehaviorFixture() {
  const taskId = '37000000-0000-4000-8000-000000000001';
  const resourceGeneration = 'aio-conformance-resource-generation';
  const workspaceTrace = [];
  const ownershipTrace = [];
  let provider;
  const fixture = createProvider({
    resourceGenerationLabel: resourceGeneration,
    hooks: {
      workspaceMaterialization: async (workspace) => {
        appendBehaviorTrace(
          workspaceTrace,
          workspace.taskId,
          provider.getProviderId(),
          { kind: 'materialize-start', sandboxTaskId: workspace.taskId },
        );
        appendBehaviorTrace(
          workspaceTrace,
          workspace.taskId,
          provider.getProviderId(),
          { kind: 'materialize-operation', sandboxTaskId: workspace.taskId },
        );
        const execution = await workspace.stageExecutor.execute({
          stage: 'workspace_transfer',
          request: {
            command: 'test -d /home/gem/workspace',
            cwd: workspace.workspaceDir,
            timeoutMs: 5_000,
          },
          signal: new AbortController().signal,
          remainingTimeoutMs: 5_000,
        });
        const succeeded = execution.exitCode === 0 && !execution.timedOut;
        appendBehaviorTrace(
          workspaceTrace,
          workspace.taskId,
          provider.getProviderId(),
          {
            kind: 'materialize-settled',
            sandboxTaskId: workspace.taskId,
            outcome: succeeded ? 'succeeded' : 'failed',
          },
        );
        return succeeded
          ? { status: 'succeeded', stage: 'complete' }
          : {
              status: 'failed',
              stage: 'workspace_transfer',
              cause: 'unknown',
              retryable: false,
            };
      },
      workspaceDelivery: async (workspace) => {
        appendBehaviorTrace(
          workspaceTrace,
          workspace.taskId,
          provider.getProviderId(),
          { kind: 'delivery-start', sandboxTaskId: workspace.taskId },
        );
        appendBehaviorTrace(
          workspaceTrace,
          workspace.taskId,
          provider.getProviderId(),
          { kind: 'delivery-command', sandboxTaskId: workspace.taskId },
        );
        const execution = await workspace.stageExecutor.execute({
          stage: 'delivery_push',
          request: {
            command: 'git status --porcelain',
            cwd: workspace.workspaceDir,
            timeoutMs: 5_000,
          },
          signal: new AbortController().signal,
          remainingTimeoutMs: 5_000,
        });
        const succeeded = execution.exitCode === 0 && !execution.timedOut;
        appendBehaviorTrace(
          workspaceTrace,
          workspace.taskId,
          provider.getProviderId(),
          {
            kind: 'delivery-settled',
            sandboxTaskId: workspace.taskId,
            outcome: succeeded ? 'succeeded' : 'failed',
          },
        );
        return {
          hadChanges: false,
          commitSha: null,
          error: succeeded ? null : 'aio_behavior_delivery_failed',
        };
      },
    },
  });
  provider = fixture.provider;

  const getSelectedSandboxRun = provider.getSelectedSandboxRun.bind(provider);
  provider.getSelectedSandboxRun = async (selectedTaskId) => {
    const selected = await getSelectedSandboxRun(selectedTaskId);
    if (
      selected !== null &&
      !ownershipTrace.some((event) => event.kind === 'provider-selected')
    ) {
      appendBehaviorTrace(
        ownershipTrace,
        selected.taskId,
        selected.providerId,
        { kind: 'provider-selected' },
      );
    }
    return selected;
  };

  const listReadoptable = provider.listReadoptable.bind(provider);
  provider.listReadoptable = async () => {
    const listed = await listReadoptable();
    appendBehaviorTrace(ownershipTrace, taskId, provider.getProviderId(), {
      kind: 'readoptable-listed',
    });
    return listed;
  };

  const reattach = provider.reattach.bind(provider);
  provider.reattach = async (reattachTaskId, target) => {
    const connection = await reattach(reattachTaskId, target);
    appendBehaviorTrace(
      ownershipTrace,
      reattachTaskId,
      provider.getProviderId(),
      {
        kind: 'reattached',
        providerSandboxIdMatched:
          connection !== null &&
          target?.providerSandboxId ===
            fixture.controller.getProviderSandboxId(reattachTaskId),
        ownershipFenceMatched:
          connection !== null &&
          target?.ownership?.ownerGeneration ===
            'aio-conformance-owner-generation' &&
          target?.ownership?.resourceGeneration === resourceGeneration,
      },
    );
    return connection;
  };

  return {
    ...fixture,
    taskId,
    workspace: {
      repositoryUrl: 'https://conformance.invalid/private.git',
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 30_000,
    },
    behavior: {
      workspace: {
        readTrace: () => workspaceTrace,
      },
      ownership: {
        readoptionTarget: (context) => ({
          providerSandboxId: context.selectedRun.providerSandboxId,
          ownership: {
            ownerGeneration: 'aio-conformance-owner-generation',
            resourceGeneration,
          },
        }),
        readTrace: () => ownershipTrace,
      },
    },
  };
}

function provisionContext(input, overrides = {}) {
  return {
    taskId: input.taskId,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    diagnostics: input.diagnostics,
    ...overrides,
  };
}

async function flushDiagnostics() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function retryAioDiagnosticPhysicalCleanup(fixture, taskId) {
  return core.runSandboxPhysicalCleanup(() =>
    fixture.provider.teardownSandbox(taskId),
  );
}

function taskDiagnostics(taskId, options = {}) {
  const events = [];
  let recordCalls = 0;
  let identity = 0;
  const diagnostics = core.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId,
      attemptId: `33000000-0000-4000-8000-${String(
        options.identityOffset ?? 1,
      ).padStart(12, '0')}`,
      attempt: 1,
      admissionMode: 'durable',
      providerFamily: 'unknown',
    },
    createEventId: () =>
      `34000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`,
    createOperationId: () =>
      `35000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`,
    record: async (event) => {
      recordCalls += 1;
      if (options.recordError !== undefined) throw options.recordError;
      events.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  return {
    diagnostics,
    events,
    get recordCalls() {
      return recordCalls;
    },
  };
}

await test('AIO diagnostic helper covers closed classification and non-authoritative failures', async () => {
  const facts = [];
  let identity = 0;
  const observer = {
    mode: 'non-persisting',
    createOperationId: () => `aio-helper-operation-${++identity}`,
    async emit(fact) {
      facts.push(fact);
    },
  };
  const descriptor = {
    key: 'aio:helper:stable-primary',
    stage: 'sandbox_creation',
    operation: 'sandbox_create',
    channel: 'primary',
  };
  const first = aio.startAioProvisioningDiagnostic(observer, descriptor);
  first.succeed({ httpStatusClass: '2xx' });
  first.fail(new Error('ignored after settlement'));
  first.settle({
    outcome: 'failed',
    cause: 'transport_failed',
    retryable: true,
  });
  const replay = aio.startAioProvisioningDiagnostic(observer, descriptor);
  replay.fail(new Error('provider-private helper failure'));
  assert.equal(first.operationId, replay.operationId);
  assert.equal(facts.length, 4);
  assert.equal(facts[1].httpStatusClass, '2xx');

  const cleanup = aio.startAioProvisioningDiagnostic(observer, {
    key: 'aio:helper:fresh-cleanup',
    stage: 'cleanup',
    operation: 'sandbox_delete',
    channel: 'cleanup',
    commandKind: 'sandbox_cleanup',
  });
  cleanup.settle({
    outcome: 'indeterminate',
    cause: 'cleanup_unconfirmed',
    retryable: true,
    timeoutMs: null,
  });
  assert.equal(facts.at(-1).commandKind, 'sandbox_cleanup');

  const noop = aio.startAioProvisioningDiagnostic(undefined, descriptor);
  noop.succeed();
  noop.fail(new Error('not observed'));
  noop.settle({
    outcome: 'failed',
    cause: 'unknown',
    retryable: false,
  });
  assert.equal(noop.operationId, null);

  const rejectedStart = aio.startAioProvisioningDiagnostic(
    {
      mode: 'non-persisting',
      createOperationId() {
        throw new Error('provider-private identity failure');
      },
      async emit() {},
    },
    descriptor,
  );
  rejectedStart.succeed();
  rejectedStart.fail(new Error('not observed'));
  rejectedStart.settle({
    outcome: 'failed',
    cause: 'unknown',
    retryable: false,
  });
  assert.equal(rejectedStart.operationId, null);

  const syncThrowingObserver = {
    mode: 'non-persisting',
    createOperationId: () => 'aio-helper-sync-throw',
    emit() {
      throw new Error('provider-private synchronous emitter failure');
    },
  };
  const ignoredEvidenceFailure = aio.startAioProvisioningDiagnostic(
    syncThrowingObserver,
    descriptor,
  );
  ignoredEvidenceFailure.succeed();
  assert.equal(ignoredEvidenceFailure.operationId, 'aio-helper-sync-throw');

  const timeoutSignal = new AbortController();
  timeoutSignal.abort(new DOMException('provider-private', 'TimeoutError'));
  const cancellationSignal = new AbortController();
  cancellationSignal.abort(new Error('provider-private'));
  const classifications = [
    aio.classifyAioProvisioningDiagnosticFailure(undefined),
    aio.classifyAioProvisioningDiagnosticFailure({ name: 'TimeoutError' }),
    aio.classifyAioProvisioningDiagnosticFailure({ code: 'ETIMEDOUT' }),
    aio.classifyAioProvisioningDiagnosticFailure({
      code: 'UND_ERR_CONNECT_TIMEOUT',
      status: 504,
    }),
    aio.classifyAioProvisioningDiagnosticFailure(
      { status: 503 },
      {
        cause: 'cleanup_failed',
        retryable: false,
        timeoutMs: 25,
        signal: timeoutSignal.signal,
      },
    ),
    aio.classifyAioProvisioningDiagnosticFailure(new Error('cancelled'), {
      signal: cancellationSignal.signal,
    }),
    aio.classifyAioProvisioningDiagnosticFailure({ name: 'AbortError' }),
    aio.classifyAioProvisioningDiagnosticFailure({ code: 'ABORT_ERR' }),
    aio.classifyAioProvisioningDiagnosticFailure({ code: 'ERR_CANCELED' }),
    aio.classifyAioProvisioningDiagnosticFailure({ status: 401 }),
    aio.classifyAioProvisioningDiagnosticFailure({ statusCode: 403 }),
    aio.classifyAioProvisioningDiagnosticFailure({
      status: 'invalid',
      statusCode: 99,
      response: { status: 502 },
    }),
    aio.classifyAioProvisioningDiagnosticFailure({ status: 408 }),
    aio.classifyAioProvisioningDiagnosticFailure({ status: 429 }),
    aio.classifyAioProvisioningDiagnosticFailure({ status: 400 }),
    aio.classifyAioProvisioningDiagnosticFailure(
      { status: 600 },
      {
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: false,
        timeoutMs: 50,
      },
    ),
  ];
  assert.deepEqual(
    classifications.map(({ outcome, cause, retryable }) => [
      outcome,
      cause,
      retryable,
    ]),
    [
      ['failed', 'transport_failed', true],
      ['timed_out', 'provider_unavailable', true],
      ['timed_out', 'provider_unavailable', true],
      ['timed_out', 'provider_unavailable', true],
      ['timed_out', 'cleanup_failed', false],
      ['cancelled', 'cancelled', false],
      ['cancelled', 'cancelled', false],
      ['cancelled', 'cancelled', false],
      ['cancelled', 'cancelled', false],
      ['failed', 'authentication_failed', false],
      ['failed', 'access_denied', false],
      ['failed', 'provider_unavailable', true],
      ['failed', 'transport_failed', true],
      ['failed', 'transport_failed', true],
      ['failed', 'transport_failed', false],
      ['indeterminate', 'settlement_unknown', false],
    ],
  );
  assert.deepEqual(
    [classifications[3].httpStatusClass, classifications[4].timeoutMs],
    ['5xx', 25],
  );
  assert.equal(classifications[15].timeoutMs, 50);
  assert.deepEqual(
    [99, 100, 204, 399, 499, 599, 600, Number.NaN, 200.5].map((status) =>
      aio.aioHttpStatusClass(status),
    ),
    [undefined, '1xx', '2xx', '3xx', '4xx', '5xx', undefined, undefined, undefined],
  );
});

await test('AIO advertises optional capabilities only with their real provider hooks', async () => {
  assert.deepEqual(createProvider().provider.getProviderCapabilities(), [
    'terminal.websocket',
    'lifecycle.readopt',
  ]);
  const hooked = createProvider({
    hooks: {
      workspaceMaterialization: async () => ({
        status: 'succeeded',
        stage: 'complete',
      }),
      workspaceDelivery: async () => ({
        hadChanges: false,
        commitSha: null,
        error: null,
      }),
      transcriptRead: async () => null,
    },
  }).provider;
  assert.deepEqual(hooked.getProviderCapabilities(), [
    'terminal.websocket',
    'workspace.git.materialize',
    // add-repo-content-store: the staged workspace hook is exactly what makes
    // repo-copy injection (read-only subpath mount) and the gated legacy clone
    // available, so both variants are declared alongside it.
    'workspace.source.volume',
    'workspace.source.git',
    'workspace.git.deliver',
    'transcript.retained-read',
    'lifecycle.readopt',
  ]);
  for (const capability of [
    'workspace.git.materialize',
    'workspace.git.deliver',
    'transcript.retained-read',
  ]) {
    assert.throws(
      () => createProvider({ capabilities: [capability] }),
      (error) =>
        error?.code === 'sandbox_provider_configuration_error' &&
        error.message.includes(capability),
    );
  }
});

await test('AIO deterministic transport satisfies the shared provider baseline', async () => {
  const fixture = createProvider();
  const scenarios = conformance.createSandboxProviderConformanceScenarios(
    {
      provider: fixture.provider,
      taskId: '38000000-0000-4000-8000-000000000001',
      cloneSpec: null,
      expectTranscriptSource: false,
      expectReadoption: true,
      expectSelectedRun: true,
    },
    assert,
  );
  const teardown = scenarios.find((scenario) =>
    scenario.name.startsWith('teardown'),
  );
  for (const scenario of scenarios.filter((entry) => entry !== teardown)) {
    await scenario.run();
  }
  await teardown?.run();
});

await test('AIO atomic HTTP executor proves complete output without advertising command.exec', async () => {
  const taskId = '39000000-0000-4000-8000-000000000001';
  const fixture = createProvider({
    shellExecBody: {
      data: {
        exit_code: 0,
        stdout: 'cap-aio-atomic-stdout',
        stderr: 'cap-aio-atomic-stderr',
        output: 'cap-aio-atomic-stdoutcap-aio-atomic-stderr',
      },
    },
  });

  assert.equal(
    fixture.provider.getProviderCapabilities().includes('command.exec'),
    false,
  );

  try {
    const connection = await fixture.provider.provision(
      provisionContext({ taskId }),
    );
    const selectedRun = await fixture.provider.getSelectedSandboxRun(taskId);
    assert.equal(selectedRun?.command?.protocol, 'aio-http-exec-v1');

    const result = await fixture.provider
      .createCommandExecutor(connection.baseUrl)
      .exec({
        command: 'printf cap-aio-atomic-output',
        cwd: '/home/gem/workspace',
        timeoutMs: 30_000,
      });

    conformance.assertSandboxCommandExecutionResult(result, assert);
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: 'cap-aio-atomic-stdout',
      stderr: 'cap-aio-atomic-stderr',
      output: 'cap-aio-atomic-stdoutcap-aio-atomic-stderr',
      timedOut: false,
    });
    assert.deepEqual(fixture.shellCommands, [
      "cd '/home/gem/workspace' && printf cap-aio-atomic-output",
    ]);
  } finally {
    await fixture.provider.teardownSandbox(taskId);
  }
});

await test('AIO behavior conformance drives real workspace and readoption seams', async () => {
  const fixture = createAioBehaviorFixture();
  const scenarios = conformance.createSandboxProviderBehaviorConformanceScenarios(
    {
      provider: fixture.provider,
      taskId: fixture.taskId,
      cloneSpec: null,
      workspace: fixture.workspace,
      behavior: fixture.behavior,
      expectTranscriptSource: false,
    },
    assert,
  );
  assert.deepEqual(
    scenarios.map((scenario) => scenario.name),
    [
      'behavior adapters cover every advertised provider-owned capability',
      'workspace behavior materializes and delivers in the selected provider task',
      'ownership behavior readopts only the selected provider task',
    ],
  );
  try {
    for (const scenario of scenarios) await scenario.run();
    assert.equal(fixture.docker.created.length, 1);
    assert.equal(
      fixture.shellCommands.some((command) =>
        command.includes('test -d /home/gem/workspace'),
      ),
      true,
    );
    assert.equal(
      fixture.shellCommands.some((command) =>
        command.includes('git status --porcelain'),
      ),
      true,
    );
  } finally {
    await fixture.provider.teardownSandbox(fixture.taskId);
  }
});

await test('AIO created-observation rejection preserves its coordination primary after cleanup', async () => {
  const taskId = '36000000-0000-4000-8000-000000000001';
  const canary = 'CAP_AIO_OBSERVATION_CALLBACK_CANARY';
  const observationFailure = new Error(canary);
  const harness = taskDiagnostics(taskId);
  const fixture = createDiagnosticProvider();
  const repositoryUrl = 'https://conformance.invalid/observation.git';
  await assert.rejects(
    fixture.provider.provision({
      ...provisionContext(
        { taskId, diagnostics: harness.diagnostics },
        {
          workspace: {
            repositoryUrl,
            callerBranch: null,
            resolvedBranch: 'main',
            deadlineMs: 30_000,
            credential: core.createExactHostGitCredential(
              repositoryUrl,
              'Authorization: Basic observation-cleanup-secret',
            ),
          },
        },
      ),
      onSandboxCreateObserved: async () => {
        throw observationFailure;
      },
    }),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      error.primary === observationFailure &&
      !Object.keys(error).includes('primary'),
  );
  await flushDiagnostics();
  const createEvents = harness.events.filter(
    (event) => event.operation === 'sandbox_create',
  );
  assert.deepEqual(
    createEvents.map((event) => event.outcome),
    ['started', 'succeeded'],
  );
  assert.deepEqual(
    fixture.docker.created[0].container.calls.map(([operation]) => operation),
    ['inspect', 'remove', 'inspect'],
  );
  assert.equal(JSON.stringify(harness.events).includes(canary), false);
});

await test('AIO not-created observation rejection preserves the Docker primary without cleanup', async () => {
  const taskId = '36000000-0000-4000-8000-000000000006';
  const providerFailure = Object.assign(
    new Error('provider-private invalid create request'),
    { statusCode: 422 },
  );
  const observationFailure = new Error(
    'provider-private not-created observation failure',
  );
  const harness = taskDiagnostics(taskId, { identityOffset: 6 });
  const fixture = createProvider({ createError: providerFailure });
  let observations = 0;

  await assert.rejects(
    fixture.provider.provision({
      ...provisionContext({ taskId, diagnostics: harness.diagnostics }),
      onSandboxCreateObserved: async (observation) => {
        observations += 1;
        assert.deepEqual(observation, { kind: 'not-created' });
        throw observationFailure;
      },
    }),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      error.primary === providerFailure &&
      error.primary !== observationFailure &&
      !Object.keys(error).includes('primary'),
  );
  await flushDiagnostics();

  assert.equal(observations, 1);
  assert.equal(fixture.docker.created.length, 0);
  assert.deepEqual(
    harness.events
      .filter((event) => event.operation === 'sandbox_create')
      .map((event) => event.outcome),
    ['started', 'failed'],
  );
  assert.equal(
    harness.events.some((event) => event.channel === 'cleanup'),
    false,
  );
});

await test('AIO diagnostic recorder rejection cannot block successful provisioning', async () => {
  const taskId = '36000000-0000-4000-8000-000000000002';
  const harness = taskDiagnostics(taskId, {
    identityOffset: 2,
    recordError: new Error('provider-private diagnostic store failure'),
  });
  const { provider } = createProvider();
  const connection = await provider.provision(
    provisionContext({ taskId, diagnostics: harness.diagnostics }),
  );
  await flushDiagnostics();
  assert.equal(connection.taskId, taskId);
  assert.ok(harness.recordCalls > 0);
  assert.deepEqual(harness.events, []);
});

await test('AIO readiness polling emits one bounded timed-out terminal with safe HTTP class', async () => {
  const taskId = '36000000-0000-4000-8000-000000000003';
  const harness = taskDiagnostics(taskId, { identityOffset: 3 });
  const { provider } = createProvider({ readinessStatus: 503 });
  await assert.rejects(
    provider.provision(
      provisionContext({ taskId, diagnostics: harness.diagnostics }),
    ),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error.stage === 'readiness',
  );
  await flushDiagnostics();
  const readiness = harness.events.filter(
    (event) => event.stage === 'readiness',
  );
  assert.deepEqual(
    readiness.map((event) => event.outcome),
    ['started', 'timed_out'],
  );
  assert.equal(readiness[1].cause, 'provider_unavailable');
  assert.equal(readiness[1].httpStatusClass, '5xx');
  assert.equal(Object.hasOwn(readiness[1], 'message'), false);
});

await test('AIO physical cleanup retries use distinct diagnostic operation identities', async () => {
  const taskId = '36000000-0000-4000-8000-000000000004';
  const harness = taskDiagnostics(taskId, { identityOffset: 4 });
  const options = {};
  const fixture = createProvider(options);
  await fixture.provider.provision(
    provisionContext({ taskId, diagnostics: harness.diagnostics }),
  );

  options.removeError = new Error('provider-private first cleanup failure');
  await assert.rejects(
    fixture.controller.removeSandboxAndConfirm(
      taskId,
      undefined,
      undefined,
      harness.diagnostics,
    ),
    /removal could not be confirmed/u,
  );
  delete options.removeError;
  assert.deepEqual(
    await fixture.controller.removeSandboxAndConfirm(
      taskId,
      undefined,
      undefined,
      harness.diagnostics,
    ),
    { kind: 'found-and-cleaned' },
  );
  await flushDiagnostics();

  const deleteStarts = harness.events.filter(
    (event) =>
      event.operation === 'sandbox_delete' && event.outcome === 'started',
  );
  assert.equal(deleteStarts.length, 2);
  assert.notEqual(deleteStarts[0].operationId, deleteStarts[1].operationId);
  assert.equal(
    fixture.docker.created[0].container.calls.filter(
      ([operation]) => operation === 'remove',
    ).length,
    2,
  );
});

await test('AIO public teardown retains the provision attempt observer for cleanup facts', async () => {
  const taskId = '36000000-0000-4000-8000-000000000005';
  const harness = taskDiagnostics(taskId, { identityOffset: 5 });
  const fixture = createProvider();
  await fixture.provider.provision(
    provisionContext({ taskId, diagnostics: harness.diagnostics }),
  );
  assert.deepEqual(await fixture.provider.teardownSandbox(taskId), {
    kind: 'found-and-cleaned',
  });
  await flushDiagnostics();

  const cleanup = harness.events.filter((event) => event.channel === 'cleanup');
  assert.ok(
    cleanup.some(
      (event) =>
        event.operation === 'sandbox_delete' && event.outcome === 'succeeded',
    ),
  );
  assert.ok(
    cleanup.some((event) => event.operation === 'sandbox_absence_confirm'),
  );
  const calls = fixture.docker.created[0].container.calls.map(
    ([operation]) => operation,
  );
  assert.ok(calls.includes('stop'));
  assert.ok(calls.includes('inspect'));
});

async function exerciseDiagnosticConformance(input) {
  if (input.scenario === 'taskless-probe') {
    const { controller } = createDiagnosticProvider();
    const result = await aio.validateAioEnvironment({
      controller,
      diagnostics: input.diagnostics,
      environment: {
        sourceKind: 'aio-docker-image',
        sourceRef: 'cap-aio-sandbox:diagnostic-conformance',
      },
    });
    assert.equal(result.status, 'passed');
    await flushDiagnostics();
    return { probe: input.probeResult };
  }

  if (input.scenario === 'bounded-start-terminal') {
    const { provider } = createDiagnosticProvider();
    await provider.provision(provisionContext(input));
    await flushDiagnostics();
    return;
  }

  if (input.scenario === 'replay-deduplication') {
    const { provider } = createDiagnosticProvider();
    const context = provisionContext(input);
    await provider.provision(context);
    await provider.provision(context);
    await flushDiagnostics();
    return;
  }

  if (input.scenario === 'timeout') {
    const timeout = new DOMException('provider-private timeout', 'TimeoutError');
    const { provider } = createDiagnosticProvider({ createError: timeout });
    await assert.rejects(provider.provision(provisionContext(input)), (error) => error === timeout);
    await flushDiagnostics();
    return;
  }

  if (input.scenario === 'cancellation') {
    const cancellation = new DOMException(
      'provider-private cancellation',
      'AbortError',
    );
    const controller = new AbortController();
    const { provider } = createDiagnosticProvider({
      onCreate: () => {
        controller.abort(cancellation);
        throw cancellation;
      },
    });
    await assert.rejects(
      provider.provision(
        provisionContext(input, {
          cancellationSignal: controller.signal,
        }),
      ),
      (error) => error === cancellation,
    );
    assert.equal(controller.signal.aborted, true);
    await flushDiagnostics();
    return;
  }

  if (input.scenario === 'indeterminate-settlement') {
    const indeterminate = new Error('provider-private create response was lost');
    const { provider } = createDiagnosticProvider({ createError: indeterminate });
    await assert.rejects(
      provider.provision(provisionContext(input)),
      (error) => error === indeterminate,
    );
    await flushDiagnostics();
    return;
  }

  if (
    input.scenario === 'primary-plus-cleanup-failure' ||
    input.scenario === 'diagnostic-write-failure'
  ) {
    const fixture = createDiagnosticProvider({
      startError: input.primaryFailure,
      startBecomesRunning: true,
      stopError: new Error('provider-private cleanup failure'),
    });
    let primary;
    await assert.rejects(
      fixture.provider.provision(
        provisionContext(input, {
          externalBoundaryGuard: async () => undefined,
        }),
      ),
      (error) => {
        primary = error;
        return error === input.primaryFailure;
      },
    );
    await flushDiagnostics();
    const calls = fixture.docker.created[0].container.calls.map(
      ([operation]) => operation,
    );
    assert.ok(calls.includes('start'));
    assert.ok(calls.includes('stop'));
    assert.ok(calls.includes('inspect'));
    const cleanup = await retryAioDiagnosticPhysicalCleanup(
      fixture,
      input.taskId,
    );
    return {
      primary,
      cleanup,
    };
  }

  if (input.scenario === 'credential-cleanup-failure') {
    const fixture = createDiagnosticProvider({
      failSecretDelete: true,
      secretOutput: input.canaries.output,
      hooks: {
        workspaceMaterialization: async (context) => {
          const handle = await context.secretFilePort.writeSecretFile({
            kind: 'git-http-credential',
            credential: context.plan.credential,
          });
          const transferOperationId = context.diagnostics.createOperationId(
            'workspace.workspace_transfer',
          );
          void context.diagnostics.emit({
            operationId: transferOperationId,
            stage: 'workspace_transfer',
            operation: 'repository_transfer',
            channel: 'primary',
            commandKind: 'git_clone',
            outcome: 'started',
          });
          void context.diagnostics.emit({
            operationId: transferOperationId,
            stage: 'workspace_transfer',
            operation: 'repository_transfer',
            channel: 'primary',
            commandKind: 'git_clone',
            outcome: 'failed',
            cause: 'transport_failed',
            retryable: true,
          });
          const operationId = context.diagnostics.createOperationId(
            'workspace.credential_cleanup',
          );
          void context.diagnostics.emit({
            operationId,
            stage: 'credential_cleanup',
            operation: 'credential_cleanup',
            channel: 'cleanup',
            commandKind: 'credential_cleanup',
            outcome: 'started',
          });
          try {
            await context.secretFilePort.deleteSecretFile(handle);
            assert.fail('credential cleanup transport must fail closed');
          } catch {
            void context.diagnostics.emit({
              operationId,
              stage: 'credential_cleanup',
              operation: 'credential_cleanup',
              channel: 'cleanup',
              commandKind: 'credential_cleanup',
              outcome: 'failed',
              cause: 'cleanup_failed',
              retryable: false,
            });
          }
          throw input.primaryFailure;
        },
      },
    });
    const repositoryUrl = 'https://conformance.invalid/private.git';
    let primary;
    await assert.rejects(
      fixture.provider.provision(
        provisionContext(input, {
          workspace: {
            repositoryUrl,
            callerBranch: null,
            resolvedBranch: 'main',
            deadlineMs: 30_000,
            credential: core.createExactHostGitCredential(
              repositoryUrl,
              `Authorization: Basic ${input.canaries.secret}`,
            ),
          },
        }),
      ),
      (error) => {
        primary = error;
        return error === input.primaryFailure;
      },
    );
    await flushDiagnostics();
    const calls = fixture.docker.created[0].container.calls.map(
      ([operation]) => operation,
    );
    assert.ok(calls.includes('putArchive'));
    assert.equal(
      fixture.shellCommands.some((command) => command.includes('rm -f')),
      true,
    );
    return { primary };
  }

  if (input.scenario === 'raw-provider-secret-canary') {
    const fixture = createDiagnosticProvider({
      startError: input.primaryFailure,
      startBecomesRunning: true,
      stopError: new Error(input.canaries.providerError),
      removeError: new Error(input.canaries.providerError),
    });
    let primary;
    await assert.rejects(
      fixture.provider.provision(provisionContext(input)),
      (error) => {
        primary = error;
        return error === input.primaryFailure;
      },
    );

    const invalidOperationId = input.diagnostics.createOperationId();
    await assert.rejects(
      input.diagnostics.emit({
        operationId: invalidOperationId,
        stage: 'sandbox_creation',
        operation: 'sandbox_create',
        channel: 'primary',
        outcome: 'started',
        ...input.canaries,
      }),
      (error) => error?.code === 'sandbox_provisioning_diagnostic_validation_error',
    );
    const cleanup = await retryAioDiagnosticPhysicalCleanup(
      fixture,
      input.taskId,
    );
    await flushDiagnostics();
    return {
      primary,
      cleanup,
    };
  }

  assert.fail(`unhandled AIO diagnostic conformance case: ${input.scenario}`);
}

const diagnosticCapabilityProvider = createDiagnosticProvider().provider;

for (const scenario of conformance.createSandboxProviderDiagnosticConformanceScenarios(
  {
    providerFamily: 'aio',
    workspaceCredential: {
      kind: 'provider-local-secret',
      providerCapabilities:
        diagnosticCapabilityProvider.getProviderCapabilities(),
    },
    exercise: exerciseDiagnosticConformance,
  },
  assert,
)) {
  await test(scenario.name, scenario.run);
}

if (failed > 0) process.exitCode = 1;
console.log(`AIO diagnostic conformance: ${passed} passed, ${failed} failed`);
