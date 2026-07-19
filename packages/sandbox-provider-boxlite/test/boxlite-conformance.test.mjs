import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
const boxlite = await import(new URL('../dist/index.js', import.meta.url).href);
const conformance = await import(new URL('../../sandbox-conformance/dist/index.js', import.meta.url).href);
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

function fakeConfig(overrides = {}) {
  const result = boxlite.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest',
    BOXLITE_CAPABILITIES: [
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

function appendBehaviorTrace(trace, taskId, providerId, event) {
  trace.push({
    sequence: trace.length + 1,
    taskId,
    providerId,
    ...event,
  });
}

function successfulExecResult() {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    output: '',
    timedOut: false,
  };
}

function boxLiteResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return body === null || body === undefined
        ? ''
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
    },
    async arrayBuffer() {
      return new Uint8Array().buffer;
    },
  };
}

function parseBoxLiteRequestBody(rawBody) {
  if (typeof rawBody === 'string') return JSON.parse(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  return rawBody;
}

class ProtocolGatedBoxLiteSocket extends EventEmitter {
  constructor(onReady) {
    super();
    this.onReady = onReady;
    this.readyState = 1;
    this.started = false;
    this.closed = false;
    this.driver = Promise.resolve();
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  on(eventName, listener) {
    super.on(eventName, listener);
    this.startWhenProtocolReady();
    return this;
  }

  startWhenProtocolReady() {
    if (
      this.started ||
      this.closed ||
      this.listenerCount('message') === 0 ||
      this.listenerCount('close') === 0 ||
      this.listenerCount('error') === 0
    ) {
      return;
    }
    this.started = true;
    try {
      const driving = this.onReady(this);
      if (driving instanceof Promise) {
        this.driver = driving.catch((error) => {
          if (!this.closed) this.emit('error', error);
        });
      }
    } catch (error) {
      if (!this.closed) this.emit('error', error);
    }
  }

  emitOutput(channel, chunk) {
    if (this.closed) return;
    this.emit(
      'message',
      Buffer.concat([Buffer.from([channel]), Buffer.from(chunk)]),
      true,
    );
  }

  emitExit(exitCode) {
    if (this.closed) return;
    this.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'exit', exit_code: exitCode })),
      false,
    );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.resolveClosed();
    this.emit('close');
  }

  terminate() {
    this.close();
  }

  waitForClose() {
    return this.closedPromise;
  }

  waitForDriver() {
    return this.driver;
  }
}

function completedNativeAttachFactory(state) {
  return (input) =>
    new ProtocolGatedBoxLiteSocket((socket) => {
      const url = new URL(input);
      const match = url.pathname.match(
        /^\/v1\/default\/boxes\/([^/]+)\/executions\/([^/]+)\/attach$/u,
      );
      assert.notEqual(match, null);
      const sandboxId = decodeURIComponent(match[1]);
      const executionId = decodeURIComponent(match[2]);
      const terminal = state.executions.get(`${sandboxId}\0${executionId}`) ?? {
        status: 'completed',
        exit_code: 0,
      };
      if (typeof terminal.stdout === 'string' && terminal.stdout.length > 0) {
        socket.emitOutput(1, Buffer.from(terminal.stdout));
      }
      if (typeof terminal.stderr === 'string' && terminal.stderr.length > 0) {
        socket.emitOutput(2, Buffer.from(terminal.stderr));
      }
      socket.emitExit(
        Number.isSafeInteger(terminal.exit_code) ? terminal.exit_code : 0,
      );
    });
}

/**
 * Deterministic BoxLite 0.9 transport. Faults are injected at the same HTTP
 * boundaries used by BoxLiteRestClient; diagnostics are never produced by the
 * fixture itself.
 */
function createNativeDiagnosticFixture(options = {}) {
  const state = {
    boxes: new Map(),
    calls: [],
    createFailure: options.createFailure,
    deleteFailure: options.deleteFailure,
    forcePresent: false,
    executionIndex: 0,
    executions: new Map(),
  };

  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = url.pathname;
    const body = parseBoxLiteRequestBody(init.body);
    state.calls.push({ method, path: `${path}${url.search}`, body });

    if (method === 'GET' && /^\/v1\/default\/boxes\/[^/]+$/u.test(path)) {
      const sandboxId = decodeURIComponent(path.split('/').at(-1));
      const sandbox = state.boxes.get(sandboxId);
      if (!sandbox && !state.forcePresent) {
        return boxLiteResponse(404, { error: 'absent' });
      }
      return boxLiteResponse(200, sandbox ?? {
        box_id: sandboxId,
        status: 'running',
        image: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest',
      });
    }

    if (method === 'POST' && path === '/v1/default/boxes') {
      if (typeof options.onCreate === 'function') {
        await options.onCreate({ body, init, state });
      }
      if (state.createFailure !== undefined) throw state.createFailure;
      const sandboxId = body.name;
      const sandbox = {
        box_id: sandboxId,
        task_id: sandboxId,
        status: 'configured',
        image: body.image,
        disk_size_gb: body.disk_size_gb,
      };
      state.boxes.set(sandboxId, sandbox);
      return boxLiteResponse(200, sandbox);
    }

    const startMatch = path.match(/^\/v1\/default\/boxes\/([^/]+)\/start$/u);
    if (method === 'POST' && startMatch) {
      const sandboxId = decodeURIComponent(startMatch[1]);
      const previous = state.boxes.get(sandboxId) ?? {};
      const sandbox = { ...previous, box_id: sandboxId, status: 'running' };
      state.boxes.set(sandboxId, sandbox);
      return boxLiteResponse(200, sandbox);
    }

    const execMatch = path.match(/^\/v1\/default\/boxes\/([^/]+)\/exec$/u);
    if (method === 'POST' && execMatch) {
      const sandboxId = decodeURIComponent(execMatch[1]);
      const command = Array.isArray(body.args) ? body.args.at(-1) : body.command;
      const terminal = options.executionResult?.(command, {
        sandboxId,
        body,
        state,
      }) ?? { status: 'completed', exit_code: 0 };
      const executionId = `boxlite-conformance-exec-${++state.executionIndex}`;
      state.executions.set(`${sandboxId}\0${executionId}`, terminal);
      return boxLiteResponse(200, { execution_id: executionId });
    }

    const pollMatch = path.match(
      /^\/v1\/default\/boxes\/([^/]+)\/executions\/([^/]+)$/u,
    );
    if (method === 'GET' && pollMatch) {
      const sandboxId = decodeURIComponent(pollMatch[1]);
      const executionId = decodeURIComponent(pollMatch[2]);
      return boxLiteResponse(
        200,
        state.executions.get(`${sandboxId}\0${executionId}`) ?? {
          status: 'completed',
          exit_code: 0,
        },
      );
    }

    const filesMatch = path.match(/^\/v1\/default\/boxes\/([^/]+)\/files$/u);
    if (method === 'PUT' && filesMatch) return boxLiteResponse(204, null);

    const deleteMatch = path.match(/^\/v1\/default\/boxes\/([^/]+)$/u);
    if (method === 'DELETE' && deleteMatch) {
      if (state.deleteFailure !== undefined) throw state.deleteFailure;
      const sandboxId = decodeURIComponent(deleteMatch[1]);
      if (!state.forcePresent) state.boxes.delete(sandboxId);
      return boxLiteResponse(204, null);
    }

    return boxLiteResponse(404, { error: 'unhandled fixture route' });
  };

  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    apiToken: options.apiToken,
    protocolMode: 'native',
    pathPrefix: 'default',
    fetch,
    webSocketFactory:
      options.webSocketFactory ?? completedNativeAttachFactory(state),
  });
  const provider = new boxlite.BoxLiteSandboxProvider({
    config: fakeConfig({
      BOXLITE_PROVIDER_ID: 'boxlite-diagnostic-conformance',
      BOXLITE_PROTOCOL_MODE: 'native',
      BOXLITE_PATH_PREFIX: 'default',
      BOXLITE_CAPABILITIES: [
        'command.exec',
        'workspace.archive.transfer',
        'workspace.git.materialize',
        'lifecycle.readoption',
      ].join(','),
    }),
    client,
    workspaceMaterialization: options.workspaceMaterialization,
  });
  return { client, provider, state };
}

function diagnosticProvisionContext(input, overrides = {}) {
  return {
    taskId: input.taskId,
    cloneSpec: null,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'headless-exec',
    workspace: null,
    diagnostics: input.diagnostics,
    ...overrides,
  };
}

async function cleanupNativeDiagnosticFixture(fixture, diagnostics, options = {}) {
  await boxlite.deleteBoxLiteSandboxAndConfirm({
    client: fixture.client,
    sandboxId: options.sandboxId ?? `cap-boxlite-${options.taskId}`,
    diagnostics,
    attempts: options.attempts ?? 1,
    waitForRetry: async () => undefined,
  });
}

async function runNativeDiagnosticCleanup(fixture, diagnostics, options = {}) {
  return core.runSandboxPhysicalCleanup(() =>
    cleanupNativeDiagnosticFixture(fixture, diagnostics, options),
  );
}

async function flushBoxLiteDiagnostics(diagnostics) {
  await diagnostics?.flush();
}

function createBoxLiteBehaviorFixture() {
  const taskId = 'task-behavior-conformance';
  const config = fakeConfig({
    BOXLITE_PROVIDER_ID: 'boxlite-behavior-conformance',
    BOXLITE_CAPABILITIES: [
      'command.exec',
      'workspace.git.materialize',
      'workspace.git.deliver',
      'lifecycle.readoption',
    ].join(','),
  });
  const client = new boxlite.FakeBoxLiteClient();
  const commandTrace = [];
  const workspaceTrace = [];
  const ownershipTrace = [];

  class TracedBoxLiteSandboxProvider extends boxlite.BoxLiteSandboxProvider {
    async getSelectedSandboxRun(selectedTaskId) {
      const selected = await super.getSelectedSandboxRun(selectedTaskId);
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
    }

    async listReadoptable() {
      const listed = await super.listReadoptable();
      appendBehaviorTrace(ownershipTrace, taskId, this.getProviderId(), {
        kind: 'readoptable-listed',
      });
      return listed;
    }

    async reattach(reattachTaskId, target) {
      const execCallCount = client.execCalls.length;
      const connection = await super.reattach(reattachTaskId, target);
      const created = client.createCalls.find(
        (request) => request.taskId === reattachTaskId,
      );
      const ownershipFenceMatched =
        connection !== null &&
        typeof target?.ownership?.ownerGeneration === 'string' &&
        target.ownership.ownerGeneration.length > 0 &&
        typeof target.ownership.resourceGeneration === 'string' &&
        target.ownership.resourceGeneration.length > 0 &&
        client.execCalls
          .slice(execCallCount)
          .some((request) =>
            request.command.includes(target.ownership.resourceGeneration),
          );
      appendBehaviorTrace(ownershipTrace, reattachTaskId, this.getProviderId(), {
        kind: 'reattached',
        providerSandboxIdMatched:
          connection !== null &&
          target?.providerSandboxId === created?.sandboxId,
        ownershipFenceMatched,
      });
      return connection;
    }
  }

  let provider;
  provider = new TracedBoxLiteSandboxProvider({
    config,
    client,
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
      const signal = new AbortController().signal;
      const execution = await workspace.stageExecutor.execute({
        stage: 'workspace_transfer',
        request: {
          command: 'test -d /home/gem/workspace',
          cwd: workspace.workspaceDir,
          timeoutMs: 5_000,
        },
        signal,
        remainingTimeoutMs: 5_000,
      });
      const succeeded = execution.exitCode === 0 && execution.timedOut !== true;
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
      const signal = new AbortController().signal;
      const execution = await workspace.stageExecutor.execute({
        stage: 'delivery_push',
        request: {
          command: 'git status --porcelain',
          cwd: workspace.workspaceDir,
          timeoutMs: 5_000,
        },
        signal,
        remainingTimeoutMs: 5_000,
      });
      const succeeded = execution.exitCode === 0 && execution.timedOut !== true;
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
        error: succeeded ? null : 'boxlite_behavior_delivery_failed',
      };
    },
  });

  return {
    taskId,
    provider,
    client,
    workspace: {
      repositoryUrl: 'https://conformance.invalid/private.git',
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 30_000,
    },
    behavior: {
      command: {
        open: (context) => {
          const executor = provider.createCommandExecutor(
            context.selectedRun.providerSandboxId,
          );
          return {
            taskId: context.taskId,
            providerId: context.providerId,
            executor: {
              async exec(request) {
                appendBehaviorTrace(
                  commandTrace,
                  context.taskId,
                  context.providerId,
                  { kind: 'execute' },
                );
                const result = await executor.exec(request);
                appendBehaviorTrace(
                  commandTrace,
                  context.taskId,
                  context.providerId,
                  {
                    kind: 'settled',
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                  },
                );
                return result;
              },
            },
          };
        },
        readTrace: () => commandTrace,
      },
      workspace: {
        readTrace: () => workspaceTrace,
      },
      ownership: {
        readoptionTarget: (context) => ({
          providerSandboxId: context.selectedRun.providerSandboxId,
          ownership: {
            ownerGeneration: 'boxlite-conformance-owner-generation',
            resourceGeneration: 'boxlite-conformance-resource-generation',
          },
        }),
        readTrace: () => ownershipTrace,
      },
    },
  };
}

function createCommandOutputDiagnosticHarness() {
  const events = [];
  let identity = 0;
  const nextIdentity = (prefix) =>
    `${prefix}-0000-4000-8000-${String(++identity).padStart(12, '0')}`;
  const diagnostics = core.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId: '41000000-0000-4000-8000-000000000001',
      attemptId: '42000000-0000-4000-8000-000000000001',
      attempt: 1,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
    },
    createEventId: () => nextIdentity('43000000'),
    createOperationId: () => nextIdentity('44000000'),
    record: async (event) => {
      events.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  return { diagnostics, events };
}

function commandOutputAttachFactory(protocol, calls, observeSocket) {
  return () => {
    calls.attaches += 1;
    const socket = new ProtocolGatedBoxLiteSocket(async (activeSocket) => {
      let iterator;
      try {
        const handshake = await Promise.race([
          protocol.output.waitForHandshake().then(() => 'ready'),
          activeSocket.waitForClose().then(() => 'closed'),
        ]);
        if (handshake === 'closed') return;
        iterator = protocol.output.events()[Symbol.asyncIterator]();
        for (;;) {
          const observed = await Promise.race([
            iterator.next().then((result) => ({ kind: 'event', result })),
            activeSocket.waitForClose().then(() => ({ kind: 'closed' })),
          ]);
          if (observed.kind === 'closed') return;
          if (observed.result.done) return;
          const event = observed.result.value;
          if (event.kind === 'stdout') {
            activeSocket.emitOutput(1, event.chunk);
            continue;
          }
          if (event.kind === 'stderr') {
            activeSocket.emitOutput(2, event.chunk);
            continue;
          }
          if (event.kind === 'exit') {
            activeSocket.emitExit(event.exitCode);
          } else if (event.kind === 'close') {
            activeSocket.close();
          } else {
            activeSocket.emit('error', new Error(event.rawErrorCanary));
          }
          protocol.output.acknowledgeTerminalConsumed(event.receipt);
          return;
        }
      } finally {
        await iterator?.return?.();
        protocol.output.acknowledgeDriverSettled();
      }
    });
    observeSocket(socket);
    return socket;
  };
}

async function exerciseBoxLiteCommandOutputConformance(input, observations) {
  const calls = { executions: 0, polls: 0, attaches: 0 };
  let outputSocket;
  const diagnosticHarness = createCommandOutputDiagnosticHarness();
  const fetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    const method = init.method ?? 'GET';
    if (
      method === 'POST' &&
      url.pathname === '/v1/default/boxes/command-output-conformance/exec'
    ) {
      calls.executions += 1;
      return boxLiteResponse(200, {
        execution_id: 'command-output-conformance-execution',
      });
    }
    if (
      method === 'GET' &&
      url.pathname ===
        '/v1/default/boxes/command-output-conformance/executions/command-output-conformance-execution'
    ) {
      calls.polls += 1;
      const process = await input.protocol.process.waitForSettlement();
      const responseBody = {
        status: process.exitCode === 0 ? 'completed' : 'failed',
      };
      Object.defineProperty(responseBody, 'exit_code', {
        enumerable: true,
        get() {
          input.protocol.process.acknowledgeConsumed();
          return process.exitCode;
        },
      });
      return boxLiteResponse(200, responseBody);
    }
    return boxLiteResponse(404, { error: 'unhandled conformance route' });
  };
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    pathPrefix: 'default',
    fetch,
    webSocketFactory: commandOutputAttachFactory(
      input.protocol,
      calls,
      (socket) => {
        outputSocket = socket;
      },
    ),
    nativeExecutionDeadlineDriver: input.deadlineDriver,
  });
  const executor = boxlite.createBoxLiteCommandExecutor({
    client,
    sandboxId: 'command-output-conformance',
    diagnostics: diagnosticHarness.diagnostics,
    commandKind: 'runtime_setup',
  });

  let observation;
  try {
    observation = {
      kind: 'resolved',
      executionCount: calls.executions,
      result: await executor.exec(input.request),
    };
  } catch (rejection) {
    observation = {
      kind: 'rejected',
      executionCount: calls.executions,
      rejection,
    };
  }
  await outputSocket?.waitForDriver();
  await diagnosticHarness.diagnostics.flush();
  observations.set(input.scenario, { ...calls });
  return {
    ...observation,
    executionCount: calls.executions,
    diagnostics: diagnosticHarness.events,
  };
}

await test('fake BoxLite provider satisfies provider conformance for declared features', async () => {
  const provider = new boxlite.BoxLiteSandboxProvider({
    config: fakeConfig(),
    client: new boxlite.FakeBoxLiteClient(),
  });
  const scenarios = conformance.createSandboxProviderConformanceScenarios(
    {
      provider,
      taskId: 'task-conformance',
      cloneSpec: null,
      requiredCapabilities: ['command.exec', 'workspace.archive.transfer'],
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

await test('BoxLite behavior conformance drives real provider-owned executor, workspace, and readoption seams', async () => {
  const fixture = createBoxLiteBehaviorFixture();
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
      'command executor behavior runs in the selected provider task',
      'workspace behavior materializes and delivers in the selected provider task',
      'ownership behavior readopts only the selected provider task',
    ],
  );
  try {
    for (const scenario of scenarios) await scenario.run();

    assert.equal(fixture.client.createCalls.length, 1);
    assert.equal(fixture.client.createCalls[0].taskId, fixture.taskId);
    assert.equal(
      fixture.client.execCalls.some(
        (request) => request.command === 'printf cap-command-conformance',
      ),
      true,
    );
    assert.equal(
      fixture.client.execCalls.some(
        (request) => request.command === 'test -d /home/gem/workspace',
      ),
      true,
    );
    assert.equal(
      fixture.client.execCalls.some(
        (request) => request.command === 'git status --porcelain',
      ),
      true,
    );
    assert.equal(
      fixture.client.execCalls.some((request) =>
        request.command.includes('boxlite-conformance-resource-generation'),
      ),
      true,
    );
  } finally {
    await fixture.provider.teardownSandbox(fixture.taskId);
  }
});

await test('BoxLite native executor satisfies split command-output conformance without fallback execution', async () => {
  const observations = new Map();
  const scenarios = conformance.createSandboxCommandOutputConformanceScenarios(
    {
      exercise: (input) =>
        exerciseBoxLiteCommandOutputConformance(input, observations),
    },
    assert,
  );

  assert.deepEqual(
    scenarios.map((scenario) => scenario.name),
    conformance.SANDBOX_SPLIT_COMMAND_OUTPUT_CONFORMANCE_CASES.map(
      (scenario) => `command output settlement: ${scenario}`,
    ),
  );
  for (const scenario of scenarios) await scenario.run();
  assert.deepEqual(
    Object.fromEntries(observations),
    Object.fromEntries(
      conformance.SANDBOX_SPLIT_COMMAND_OUTPUT_CONFORMANCE_CASES.map(
        (scenario) => [scenario, { executions: 1, polls: 1, attaches: 1 }],
      ),
    ),
  );
});

await test('BoxLite remains the real primary-cleanup comparator when cleanup acknowledgement fails', async () => {
  const taskId = 'task-primary-cleanup-conformance';
  const providerId = 'boxlite-primary-cleanup-conformance';
  const canary = 'CAP_BOXLITE_CONFORMANCE_ACK_CANARY_2_5';
  const repositoryUrl = 'https://conformance.invalid/private-cleanup.git';
  const ownership = {
    ownerGeneration: 'boxlite-conformance-cleanup-owner',
    resourceGeneration: 'boxlite-conformance-cleanup-resource',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId,
    ownership,
  };
  const client = new boxlite.FakeBoxLiteClient({
    execHandler: (request) =>
      request.command.includes('rm -f --')
        ? { ...successfulExecResult(), exitCode: 1 }
        : successfulExecResult(),
  });
  const provider = new boxlite.BoxLiteSandboxProvider({
    config: fakeConfig({
      BOXLITE_PROVIDER_ID: providerId,
      BOXLITE_CAPABILITIES:
        'command.exec,workspace.git.materialize,lifecycle.readoption',
    }),
    client,
    workspaceMaterialization: async (workspace) => {
      await workspace.secretFilePort.writeSecretFile({
        kind: 'git-http-credential',
        credential: core.createExactHostGitCredential(
          repositoryUrl,
          `Authorization: Basic ${canary}`,
        ),
      });
      return {
        status: 'failed',
        stage: 'workspace_transfer',
        cause: 'capacity_exhausted',
        retryable: false,
      };
    },
  });

  let pending;
  await assert.rejects(
    () =>
      provider.provision({
        taskId,
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'headless-exec',
        workspace: {
          repositoryUrl,
          callerBranch: null,
          resolvedBranch: 'main',
          deadlineMs: 30_000,
          credential: core.createExactHostGitCredential(
            repositoryUrl,
            `Authorization: Basic ${canary}`,
          ),
        },
        ownership,
        beforeSandboxCleanup: async () => authorization,
        afterSandboxCleanup: async () => {
          throw new Error(`cleanup acknowledgement rejected: ${canary}`);
        },
      }),
    (error) => {
      pending = error;
      return (
        error?.code === 'sandbox_cleanup_coordination_pending' &&
        error.primary?.code === 'sandbox_workspace_materialization_error' &&
        error.primary.failure?.stage === 'workspace_transfer' &&
        error.primary.failure?.cause === 'capacity_exhausted' &&
        !Object.keys(error).includes('primary')
      );
    },
  );
  assert.doesNotMatch(JSON.stringify(pending), new RegExp(canary, 'u'));
  assert.equal(await provider.sandboxExists(taskId), false);
  assert.equal(await provider.reattach(taskId), null);
  assert.deepEqual(await provider.listReadoptable(), []);
  await assert.rejects(
    () =>
      provider.provision({
        taskId,
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'headless-exec',
        workspace: null,
        ownership,
      }),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );

  const providerSandboxId = client.createCalls[0].sandboxId;
  assert.deepEqual(
    await provider.teardownSandbox(taskId, {
      ownership,
      cleanupAuthorization: authorization,
      providerSandboxId,
    }),
    { kind: 'already-absent' },
  );
  await provider.provision({
    taskId,
    cloneSpec: null,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'headless-exec',
    workspace: null,
    ownership,
  });
  assert.deepEqual(await provider.listReadoptable(), [taskId]);
  await provider.teardownSandbox(taskId, { ownership });
});

async function exerciseBoxLiteDiagnosticConformance(input) {
  if (input.scenario === 'taskless-probe') {
    const fixture = createNativeDiagnosticFixture();
    const digest = `sha256:${'a'.repeat(64)}`;
    const result = await boxlite.validateBoxLiteEnvironment({
      client: fixture.client,
      diagnostics: input.diagnostics,
      environment: {
        sourceKind: 'boxlite-image',
        sourceRef: `ghcr.io/xeonice/cap-boxlite-sandbox@${digest}`,
        digest,
      },
    });
    assert.equal(result.status, 'passed');
    await flushBoxLiteDiagnostics(input.diagnostics);
    return { probe: input.probeResult };
  }

  if (input.scenario === 'bounded-start-terminal') {
    const fixture = createNativeDiagnosticFixture();
    await fixture.provider.provision(diagnosticProvisionContext(input));
    await flushBoxLiteDiagnostics(input.diagnostics);
    return;
  }

  if (input.scenario === 'replay-deduplication') {
    const fixture = createNativeDiagnosticFixture();
    const context = diagnosticProvisionContext(input);
    await fixture.provider.provision(context);
    await fixture.provider.provision(context);
    await flushBoxLiteDiagnostics(input.diagnostics);
    return;
  }

  if (input.scenario === 'timeout') {
    const timeout = new DOMException('private BoxLite create timeout', 'TimeoutError');
    const fixture = createNativeDiagnosticFixture({ createFailure: timeout });
    await assert.rejects(
      fixture.provider.provision(diagnosticProvisionContext(input)),
      (error) => error === timeout,
    );
    await cleanupNativeDiagnosticFixture(fixture, input.diagnostics, {
      taskId: input.taskId,
    });
    await flushBoxLiteDiagnostics(input.diagnostics);
    return;
  }

  if (input.scenario === 'cancellation') {
    const controller = new AbortController();
    const cancellation = new DOMException(
      'private BoxLite create cancellation',
      'AbortError',
    );
    const fixture = createNativeDiagnosticFixture({
      onCreate: () => {
        controller.abort(cancellation);
        throw cancellation;
      },
    });
    await assert.rejects(
      fixture.provider.provision(
        diagnosticProvisionContext(input, {
          cancellationSignal: controller.signal,
        }),
      ),
      (error) => error === cancellation,
    );
    await cleanupNativeDiagnosticFixture(fixture, input.diagnostics, {
      taskId: input.taskId,
    });
    await flushBoxLiteDiagnostics(input.diagnostics);
    return;
  }

  if (input.scenario === 'indeterminate-settlement') {
    const indeterminate = new Error(input.canaries.providerError);
    const fixture = createNativeDiagnosticFixture({
      createFailure: indeterminate,
    });
    await assert.rejects(
      fixture.provider.provision(diagnosticProvisionContext(input)),
      (error) => error === indeterminate,
    );
    await cleanupNativeDiagnosticFixture(fixture, input.diagnostics, {
      taskId: input.taskId,
    });
    await flushBoxLiteDiagnostics(input.diagnostics);
    return;
  }

  if (
    input.scenario === 'primary-plus-cleanup-failure' ||
    input.scenario === 'diagnostic-write-failure'
  ) {
    const fixture = createNativeDiagnosticFixture({
      createFailure: input.primaryFailure,
      deleteFailure: new Error(input.canaries.providerError),
    });
    let primary;
    await assert.rejects(
      fixture.provider.provision(diagnosticProvisionContext(input)),
      (error) => {
        primary = error;
        return error === input.primaryFailure;
      },
    );
    fixture.state.forcePresent = true;
    const cleanup = await runNativeDiagnosticCleanup(
      fixture,
      input.diagnostics,
      { taskId: input.taskId },
    );
    await flushBoxLiteDiagnostics(input.diagnostics);
    return { primary, cleanup };
  }

  if (input.scenario === 'credential-cleanup-failure') {
    const repositoryUrl = 'https://conformance.invalid/private.git';
    const fixture = createNativeDiagnosticFixture({
      executionResult: (command) => {
        if (command.includes('CAP_BOXLITE_WORKSPACE_TRANSFER_FAILURE')) {
          return {
            status: 'completed',
            exit_code: 17,
            stderr: input.canaries.output,
          };
        }
        if (command.includes('rm -f --')) {
          return {
            status: 'completed',
            exit_code: 23,
            stderr: input.canaries.output,
          };
        }
        return { status: 'completed', exit_code: 0 };
      },
      workspaceMaterialization: async (workspace) => {
        await workspace.secretFilePort.writeSecretFile({
          kind: 'git-http-credential',
          credential: workspace.plan.credential,
        });
        const transfer = await workspace.stageExecutor.execute({
          stage: 'workspace_transfer',
          request: {
            command: 'CAP_BOXLITE_WORKSPACE_TRANSFER_FAILURE',
            cwd: workspace.workspaceDir,
            timeoutMs: 5_000,
          },
          signal: new AbortController().signal,
          remainingTimeoutMs: 5_000,
        });
        assert.equal(transfer.exitCode, 17);
        throw input.primaryFailure;
      },
    });
    let primary;
    await assert.rejects(
      fixture.provider.provision(
        diagnosticProvisionContext(input, {
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
    assert.equal(fixture.state.boxes.size, 0);
    await flushBoxLiteDiagnostics(input.diagnostics);
    return { primary };
  }

  if (input.scenario === 'raw-provider-secret-canary') {
    const fixture = createNativeDiagnosticFixture({
      apiToken: input.canaries.secret,
      createFailure: input.primaryFailure,
      deleteFailure: new Error(input.canaries.providerError),
    });
    let primary;
    await assert.rejects(
      fixture.provider.provision(diagnosticProvisionContext(input)),
      (error) => {
        primary = error;
        return error === input.primaryFailure;
      },
    );
    fixture.state.forcePresent = true;
    const cleanup = await runNativeDiagnosticCleanup(
      fixture,
      input.diagnostics,
      { taskId: input.taskId },
    );

    const operationId = input.diagnostics.createOperationId();
    await assert.rejects(() =>
      input.diagnostics.emit({
        operationId,
        stage: 'sandbox_creation',
        operation: 'sandbox_create',
        channel: 'primary',
        outcome: 'failed',
        cause: 'unknown',
        retryable: false,
        providerBody: input.canaries.providerBody,
        providerError: input.canaries.providerError,
        command: input.canaries.command,
        output: input.canaries.output,
        secret: input.canaries.secret,
      }),
    );
    await flushBoxLiteDiagnostics(input.diagnostics);
    return { primary, cleanup };
  }

  assert.fail(`unhandled BoxLite diagnostic conformance case: ${input.scenario}`);
}

const diagnosticCapabilityProvider = createNativeDiagnosticFixture().provider;
const diagnosticScenarios =
  conformance.createSandboxProviderDiagnosticConformanceScenarios(
    {
      providerFamily: 'boxlite',
      workspaceCredential: {
        kind: 'provider-local-secret',
        providerCapabilities:
          diagnosticCapabilityProvider.getProviderCapabilities(),
      },
      exercise: exerciseBoxLiteDiagnosticConformance,
    },
    assert,
  );
assert.equal(diagnosticScenarios.length, 10);
for (const scenario of diagnosticScenarios) {
  await test(scenario.name, scenario.run);
}

await test('live BoxLite integration is guarded by BOXLITE_LIVE_TEST', async () => {
  if (process.env.BOXLITE_LIVE_TEST !== '1') {
    console.log('skip - set BOXLITE_LIVE_TEST=1 with BOXLITE_* env to run live BoxLite integration');
    return;
  }

  const descriptorResult = boxlite.defineBoxLiteSandboxProviderFromEnv({
    env: process.env,
  });
  assert.equal(descriptorResult.status, 'registered');
  const provider = descriptorResult.descriptor.provider;
  const taskId = `boxlite-live-${Date.now()}`;
  try {
    const connection = await provider.provision({ taskId, cloneSpec: null });
    assert.equal(connection.taskId, taskId);
    assert.equal(await provider.sandboxExists(taskId), true);
  } finally {
    await provider.teardownSandbox(taskId);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
