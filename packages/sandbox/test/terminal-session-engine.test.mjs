// Provider-neutral terminal session engine coverage.
process.env.CODEX_AUTOSUBMIT_QUIESCE_MS = '15';
process.env.CODEX_LIVENESS_POLL_MS = '15';
process.env.CODEX_ATTACH_BOOTSTRAP_QUIESCE_MS = '15';
process.env.CODEX_ATTACH_BOOTSTRAP_MAX_MS = '50';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sandbox = await import(new URL('../dist/index.js', import.meta.url).href);
// AIO terminal helpers are provider-package surface, not facade surface (R6).
const aio = await import('@cap-console/sandbox-provider-aio');

/**
 * Adapt this legacy-heavy test file to the strict combined launch-context
 * constructor while preserving each case's original transport/executor setup.
 * Tests that pass a resolver still exercise its success/failure exactly; cases
 * unrelated to lookup get an explicit runtime-default context from the fixture.
 */
class TestSandboxTerminalSession extends sandbox.SandboxTerminalSession {
  constructor(
    taskId,
    wsUrl,
    baseUrl,
    onExit,
    mode = 'replay-only',
    resolveRuntime,
    resolveExecutionMode,
    transportFactory,
    commandExecutor,
    prepareModelMaterial,
    onRuntimeSetupFailure,
    signal,
    beforeAgentLaunch,
  ) {
    const resolveTaskLaunchContext =
      mode === 'launch-or-attach'
        ? async () => {
            const runtime = resolveRuntime
              ? await resolveRuntime()
              : makeRuntime();
            const executionMode = resolveExecutionMode
              ? await resolveExecutionMode()
              : 'interactive-pty';
            if (
              !runtime ||
              (executionMode !== 'interactive-pty' &&
                executionMode !== 'headless-exec')
            ) {
              throw new Error('invalid test launch context');
            }
            return {
              runtime,
              executionMode,
              modelIntent: { kind: 'runtime-default' },
            };
          }
        : undefined;
    super(
      taskId,
      wsUrl,
      baseUrl,
      onExit,
      mode,
      resolveTaskLaunchContext,
      transportFactory,
      commandExecutor,
      prepareModelMaterial ?? testModelMaterial,
      onRuntimeSetupFailure,
      signal,
      beforeAgentLaunch,
      aio.createAioTerminalExitStatusResolver({ baseUrl }),
    );
  }
}

const mod = {
  ...sandbox,
  SandboxTerminalSession: TestSandboxTerminalSession,
  // Keep the local alias while the legacy-heavy cases below are renamed.
  AioPtyClient: TestSandboxTerminalSession,
};

async function testModelMaterial(intent) {
  if (intent.kind === 'runtime-default') return intent;
  return {
    kind: 'explicit',
    path: '/home/gem/.cap/task-model.txt',
    checksum: `sha256:${createHash('sha256').update(intent.selector).digest('hex')}`,
  };
}

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'condition was not met before timeout');
}

class FakeTransport {
  frameListeners = new Set();
  closeListeners = new Set();
  errorListeners = new Set();
  input = [];
  resizes = [];
  pongs = [];
  closeCount = 0;
  pauseCount = 0;
  resumeCount = 0;
  readyState = 'open';
  sendInputResult = true;
  throwOnClose = false;

  onFrame(listener) {
    this.frameListeners.add(listener);
    return { dispose: () => this.frameListeners.delete(listener) };
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onError(listener) {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  sendInput(data) {
    this.input.push(data);
    return this.sendInputResult;
  }

  sendResize(cols, rows) {
    this.resizes.push([cols, rows]);
    return true;
  }

  sendPong(timestamp) {
    this.pongs.push(timestamp);
    return true;
  }

  pause() {
    this.pauseCount += 1;
  }

  resume() {
    this.resumeCount += 1;
  }

  close() {
    this.closeCount += 1;
    if (this.throwOnClose) throw new Error('close failed');
  }

  emit(frame) {
    for (const listener of this.frameListeners) listener(frame);
  }

  emitClose() {
    for (const listener of this.closeListeners) listener();
  }

  emitError(error = new Error('transport failed')) {
    for (const listener of this.errorListeners) listener(error);
  }
}

function makeTransportFactory(seed = {}) {
  const transports = [];
  return {
    transports,
    open() {
      const transport = new FakeTransport();
      Object.assign(transport, seed);
      transports.push(transport);
      return transport;
    },
  };
}

function confirmedTransportCleanup() {
  return Promise.resolve({
    kind: 'confirmed',
    expectedIdentities: 1,
    observedIdentities: 1,
    confirmedIdentities: 1,
    deletedIdentities: 1,
    alreadyAbsentIdentities: 0,
    cause: null,
  });
}

function makeExecutor(handler) {
  const calls = [];
  return {
    calls,
    async exec(request) {
      calls.push(request);
      return (
        (await handler?.(request, calls.length)) ?? {
          exitCode: 0,
          output: '',
          stdout: '',
          stderr: '',
          timedOut: false,
        }
      );
    },
  };
}

function makeRuntime(overrides = {}) {
  return {
    id: 'runtime-test',
    terminalStartup: { replyToStartupDSR: false, promptSubmit: 'none' },
    buildLaunchLine: (ctx) =>
      `tmux -u new-session -d -s task${ctx.taskId} interactive:${ctx.sessionId}`,
    buildHeadlessLine: (ctx) => `headless:${ctx.taskId}:${ctx.sessionId}`,
    async detectExit() {
      return { status: 'running' };
    },
    ...overrides,
  };
}

function makeNeutralSession(overrides = {}) {
  const transportFactory = overrides.transportFactory ?? makeTransportFactory();
  const commandExecutor = overrides.commandExecutor ?? makeExecutor();
  const client = new sandbox.SandboxTerminalSession(
    overrides.taskId ?? 'task-neutral',
    'ws://unused',
    'http://unused',
    overrides.onExit,
    overrides.mode ?? 'replay-only',
    overrides.resolveTaskLaunchContext,
    transportFactory,
    commandExecutor,
    overrides.prepareModelMaterial,
    overrides.onRuntimeSetupFailure,
    overrides.signal,
    overrides.beforeAgentLaunch,
    overrides.resolveProviderExitStatus,
    overrides.ownerRecoveryPolicy,
  );
  return { client, transportFactory, commandExecutor };
}

function makeLaunchContext(overrides = {}) {
  return {
    runtime: overrides.runtime ?? makeRuntime(),
    executionMode: overrides.executionMode ?? 'interactive-pty',
    modelIntent: overrides.modelIntent ?? { kind: 'runtime-default' },
  };
}

await test('owner cleanup decision aggregates every transport generation without identities', async () => {
  const perTransport = {
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 1,
    alreadyAbsentIdentities: 1,
    cause: null,
  };
  const transportFactory = makeTransportFactory({
    cleanupDecision: Promise.resolve(perTransport),
  });
  const { client } = makeNeutralSession({ transportFactory });
  transportFactory.transports[0].sendInputResult = false;
  client.write('reopen-owner-transport');
  assert.equal(transportFactory.transports.length, 2);

  client.close();
  assert.deepEqual(await client.cleanupDecision, {
    kind: 'confirmed',
    expectedIdentities: 4,
    observedIdentities: 4,
    confirmedIdentities: 4,
    deletedIdentities: 2,
    alreadyAbsentIdentities: 2,
    cause: null,
  });
  client.close();
  assert.equal(transportFactory.transports[1].closeCount, 1);

  const unsupported = makeNeutralSession();
  unsupported.client.close();
  assert.deepEqual(await unsupported.client.cleanupDecision, {
    kind: 'indeterminate',
    expectedIdentities: 1,
    observedIdentities: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    cause: 'cleanup-unsupported',
  });
});

await test('runtime headless launch resolves exit through the selected runtime', async () => {
  const factory = makeTransportFactory();
  const exits = [];
  const executor = makeExecutor((request) => {
    if (request.command.includes('__cap_has__')) {
      return { exitCode: 0, output: '__cap_has__1\n' };
    }
    if (request.command.includes('cat /home/gem/.cap-headless-task-runtime.exit')) {
      return { exitCode: 0, output: '7\n' };
    }
    return { exitCode: 0, output: '' };
  });
  const runtime = makeRuntime({
    async detectExit(exec, ctx) {
      const res = await exec.exec(`probe:${ctx.sessionId}`);
      assert.equal(res.code, 0);
      assert.equal(res.stdout, '');
      return { status: 'done' };
    },
  });
  const client = new mod.AioPtyClient(
    'task-runtime',
    'ws://unused',
    'http://unused',
    (status) => exits.push(status),
    'launch-or-attach',
    async () => runtime,
    async () => 'headless-exec',
    factory,
    executor,
  );
  const chunks = [];
  const sub = client.onData((chunk) => chunks.push(chunk));
  const transport = factory.transports[0];

  transport.emit({ type: 'session_id', data: 's1' });
  transport.emit({ type: 'ready' });
  await waitFor(() => transport.input.some((data) => data.startsWith('headless:')));
  transport.emit({ type: 'output', data: `hello\x1b[6n` });
  await waitFor(() => exits.length === 1);

  assert.equal(chunks.join(''), `hello\x1b[6n`);
  assert.equal(transport.input.some((data) => data === '\x1b[1;1R'), false);
  assert.deepEqual(exits, [{ code: 7, abnormal: false }]);
  sub.dispose();
  transport.emit({ type: 'output', data: 'after-dispose' });
  assert.equal(chunks.join(''), `hello\x1b[6n`);
  client.close();
});

await test('runtime launch-context resolver failures fail closed without a default launch', async () => {
  const factory = makeTransportFactory();
  const failures = [];
  const executor = makeExecutor((request) => {
    if (request.command.includes('__cap_has__')) {
      return { exitCode: 0, output: 'no marker' };
    }
    return { exitCode: 0, output: '' };
  });
  const client = new mod.AioPtyClient(
    'task-inconclusive',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    async () => {
      throw new Error('runtime lookup failed');
    },
    async () => {
      throw new Error('mode lookup failed');
    },
    factory,
    executor,
    undefined,
    (code) => failures.push(code),
  );
  const transport = factory.transports[0];

  transport.emit({ type: 'session_id', data: 's1' });
  transport.emit({ type: 'ready' });
  await waitFor(() => failures.length === 1);
  assert.deepEqual(await client.launchDecision, { kind: 'failed' });
  transport.emit({ type: 'output', data: '\x1b[6n' });
  await delay(30);

  assert.deepEqual(failures, ['runtime_model_setup_failed']);
  assert.equal(transport.input.some((data) => data.includes('new-session')), false);
  assert.equal(executor.calls.length, 0);
  client.close();

  const undefinedFactory = makeTransportFactory();
  const undefinedFailures = [];
  const undefinedClient = new mod.AioPtyClient(
    'task-undefined-runtime',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    async () => undefined,
    async () => null,
    undefinedFactory,
    makeExecutor((request) =>
      request.command.includes('__cap_has__')
        ? { exitCode: 0, output: '__cap_has__0\n' }
        : { exitCode: 0, output: '' },
    ),
    undefined,
    (code) => undefinedFailures.push(code),
  );
  undefinedFactory.transports[0].emit({ type: 'session_id', data: 's1' });
  undefinedFactory.transports[0].emit({ type: 'ready' });
  await waitFor(() => undefinedFailures.length === 1);
  assert.equal(undefinedFactory.transports[0].input.length, 0);
  undefinedClient.close();

  const stringThrowFactory = makeTransportFactory();
  const stringFailures = [];
  const stringThrowClient = new mod.AioPtyClient(
    'task-string-throw',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    async () => {
      throw 'runtime lookup failed';
    },
    async () => {
      throw 'mode lookup failed';
    },
    stringThrowFactory,
    makeExecutor((request) =>
      request.command.includes('__cap_has__')
        ? { exitCode: 0, output: '__cap_has__1\n' }
        : { exitCode: 0, output: '' },
    ),
    undefined,
    (code) => stringFailures.push(code),
  );
  stringThrowFactory.transports[0].emit({ type: 'session_id', data: 's1' });
  stringThrowFactory.transports[0].emit({ type: 'ready' });
  await waitFor(() => stringFailures.length === 1);
  assert.equal(stringThrowFactory.transports[0].input.length, 0);
  stringThrowClient.close();
});

await test('final launch fence aborts both fresh-launch branches without input, attach, polling, or model failure', async () => {
  const cases = [
    { name: 'gone', probeOutput: '__cap_has__1\n', abortWhileChecked: true },
    { name: 'inconclusive', probeOutput: 'no marker', abortWhileChecked: false },
  ];

  for (const scenario of cases) {
    const factory = makeTransportFactory();
    const controller = new AbortController();
    const failures = [];
    const checkEntered = deferred();
    const releaseCheck = deferred();
    let checkCount = 0;
    const client = new mod.AioPtyClient(
      `task-launch-fence-${scenario.name}`,
      'ws://unused',
      'http://unused',
      undefined,
      'launch-or-attach',
      undefined,
      undefined,
      factory,
      makeExecutor((request) =>
        request.command.includes('__cap_has__')
          ? { exitCode: 0, output: scenario.probeOutput }
          : { exitCode: 0, output: '' },
      ),
      undefined,
      (code) => failures.push(code),
      controller.signal,
      async () => {
        checkCount += 1;
        checkEntered.resolve();
        if (scenario.abortWhileChecked) {
          await releaseCheck.promise;
          return;
        }
        throw new Error('lease authority lost');
      },
    );

    const launch = client.launchOrAttachOnReady();
    await checkEntered.promise;
    assert.equal(factory.transports[0].input.length, 0);
    if (scenario.abortWhileChecked) {
      controller.abort(new Error('task stopped'));
      assert.deepEqual(await client.launchDecision, { kind: 'fenced' });
      releaseCheck.resolve();
    }
    await launch;

    assert.deepEqual(await client.launchDecision, { kind: 'fenced' });
    assert.equal(checkCount, 1);
    assert.deepEqual(factory.transports[0].input, []);
    assert.deepEqual(failures, []);
    assert.equal(client.livenessTimer, undefined);
    client.close();
  }
});

await test('abort settles a no-ready launch decision immediately and prevents later launch work', async () => {
  const factory = makeTransportFactory();
  const controller = new AbortController();
  let decisionSettled = false;
  const client = new mod.AioPtyClient(
    'task-launch-fence-no-ready',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    undefined,
    undefined,
    factory,
    makeExecutor(),
    undefined,
    undefined,
    controller.signal,
    async () => {
      throw new Error('must not run without ready');
    },
  );
  void client.launchDecision.then(() => {
    decisionSettled = true;
  });

  await Promise.resolve();
  assert.equal(decisionSettled, false);
  controller.abort(new Error('lease lost before ready'));
  assert.deepEqual(await client.launchDecision, { kind: 'fenced' });
  assert.equal(decisionSettled, true);
  assert.deepEqual(factory.transports[0].input, []);
  assert.equal(factory.transports[0].closeCount, 1);
  assert.equal(client.livenessTimer, undefined);

  factory.transports[0].emit({ type: 'session_id', data: 'late' });
  factory.transports[0].emit({ type: 'ready' });
  await Promise.resolve();
  assert.deepEqual(factory.transports[0].input, []);
});

await test('successful final launch fence runs once immediately before launch while readoption skips it', async () => {
  const freshFactory = makeTransportFactory();
  const checkEntered = deferred();
  const releaseCheck = deferred();
  let freshCheckCount = 0;
  const freshClient = new mod.AioPtyClient(
    'task-launch-fence-success',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    undefined,
    undefined,
    freshFactory,
    makeExecutor((request) =>
      request.command.includes('__cap_has__')
        ? { exitCode: 0, output: '__cap_has__1\n' }
        : { exitCode: 0, output: '' },
    ),
    undefined,
    undefined,
    undefined,
    async () => {
      freshCheckCount += 1;
      assert.equal(freshFactory.transports[0].input.length, 0);
      checkEntered.resolve();
      await releaseCheck.promise;
    },
  );

  let freshDecisionSettled = false;
  void freshClient.launchDecision.then(() => {
    freshDecisionSettled = true;
  });
  await Promise.resolve();
  assert.equal(freshDecisionSettled, false);
  const freshLaunch = freshClient.launchOrAttachOnReady();
  await checkEntered.promise;
  assert.equal(freshDecisionSettled, false);
  assert.deepEqual(freshFactory.transports[0].input, []);
  releaseCheck.resolve();
  assert.deepEqual(await freshClient.launchDecision, { kind: 'launched' });
  await freshLaunch;
  await freshClient.launchOrAttachOnReady();
  assert.equal(freshCheckCount, 1);
  assert.equal(freshFactory.transports[0].input.length, 2);
  assert.match(freshFactory.transports[0].input[0], /new-session/);
  assert.match(freshFactory.transports[0].input[1], /attach/);
  assert.notEqual(freshClient.livenessTimer, undefined);
  freshClient.close();

  const adoptedFactory = makeTransportFactory();
  let adoptedCheckCount = 0;
  const adoptedClient = new mod.AioPtyClient(
    'task-launch-fence-readopt',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    undefined,
    undefined,
    adoptedFactory,
    makeExecutor((request) =>
      request.command.includes('__cap_has__')
        ? { exitCode: 0, output: '__cap_has__0\n' }
        : { exitCode: 0, output: '' },
    ),
    undefined,
    undefined,
    undefined,
    async () => {
      adoptedCheckCount += 1;
    },
  );

  await adoptedClient.launchOrAttachOnReady();
  assert.deepEqual(await adoptedClient.launchDecision, { kind: 'attached' });
  assert.equal(adoptedCheckCount, 0);
  assert.equal(adoptedFactory.transports[0].input.length, 1);
  assert.doesNotMatch(adoptedFactory.transports[0].input[0], /new-session/);
  assert.match(adoptedFactory.transports[0].input[0], /attach/);
  adoptedClient.close();
});

await test('attach-only attaches only after a definitive live probe', async () => {
  const factory = makeTransportFactory();
  const probeEntered = deferred();
  const probeResult = deferred();
  const executor = makeExecutor(async (request) => {
    assert.match(request.command, /__cap_has__/);
    probeEntered.resolve();
    return probeResult.promise;
  });
  const client = new mod.AioPtyClient(
    'task-attach-only-live',
    'ws://unused',
    'http://unused',
    undefined,
    'attach-only',
    undefined,
    undefined,
    factory,
    executor,
  );

  factory.transports[0].emit({ type: 'session_id', data: 's1' });
  factory.transports[0].emit({ type: 'ready' });
  await probeEntered.promise;
  assert.deepEqual(factory.transports[0].input, []);

  probeResult.resolve({ exitCode: 0, output: '__cap_has__0\n' });
  assert.deepEqual(await client.launchDecision, { kind: 'attached' });
  assert.equal(factory.transports[0].input.length, 1);
  assert.match(factory.transports[0].input[0], /attach/);
  assert.doesNotMatch(factory.transports[0].input[0], /new-session/);
  assert.notEqual(client.livenessTimer, undefined);
  client.close();
});

await test('attach-only distinguishes absent from indeterminate without launching', async () => {
  const cases = [
    {
      name: 'absent',
      probeOutput: '__cap_has__1\n',
      expected: { kind: 'absent' },
    },
    {
      name: 'indeterminate',
      probeOutput: 'provider response omitted the marker',
      expected: { kind: 'indeterminate' },
    },
  ];

  for (const scenario of cases) {
    const factory = makeTransportFactory();
    const probeEntered = deferred();
    const releaseProbe = deferred();
    const client = new mod.AioPtyClient(
      `task-attach-only-${scenario.name}`,
      'ws://unused',
      'http://unused',
      undefined,
      'attach-only',
      undefined,
      undefined,
      factory,
      makeExecutor(async () => {
        probeEntered.resolve();
        await releaseProbe.promise;
        return { exitCode: 0, output: scenario.probeOutput };
      }),
    );

    factory.transports[0].emit({ type: 'session_id', data: 's1' });
    factory.transports[0].emit({ type: 'ready' });
    await probeEntered.promise;
    assert.deepEqual(factory.transports[0].input, []);
    releaseProbe.resolve();

    assert.deepEqual(await client.launchDecision, scenario.expected);
    assert.deepEqual(factory.transports[0].input, []);
    assert.equal(client.livenessTimer, undefined);
    client.close();
  }
});

await test('launch-or-attach catches runtime launch errors and still arms cleanup', async () => {
  const factory = makeTransportFactory();
  const executor = makeExecutor((request) => {
    if (request.command.includes('__cap_has__')) {
      return { exitCode: 0, output: '__cap_has__1\n' };
    }
    return { exitCode: 0, output: '' };
  });
  const client = new mod.AioPtyClient(
    'task-launch-error',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    async () =>
      makeRuntime({
        buildLaunchLine() {
          throw 'launch line failed';
        },
      }),
    undefined,
    factory,
    executor,
  );

  factory.transports[0].emit({ type: 'session_id', data: 's1' });
  factory.transports[0].emit({ type: 'ready' });
  await delay(30);

  client.close();

  const errorFactory = makeTransportFactory();
  const errorClient = new mod.AioPtyClient(
    'task-launch-error-object',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    async () =>
      makeRuntime({
        buildLaunchLine() {
          throw new Error('launch line failed');
        },
      }),
    undefined,
    errorFactory,
    executor,
  );
  errorFactory.transports[0].emit({ type: 'session_id', data: 's1' });
  errorFactory.transports[0].emit({ type: 'ready' });
  await delay(30);
  errorClient.close();
});

await test('provider story fixture reports install failures and suppresses duplicate starts', async () => {
  const failedFactory = makeTransportFactory();
  const failedExec = makeExecutor((request) => {
    assert.match(request.command, /PROVIDER_STORY_BEGIN/);
    return { exitCode: 2, output: '', stdout: '', stderr: '', timedOut: false };
  });
  const failedClient = new mod.AioPtyClient(
    'task-story-fail',
    'ws://unused',
    'http://unused',
    undefined,
    'provider-story-fixture',
    undefined,
    undefined,
    failedFactory,
    failedExec,
  );
  failedFactory.transports[0].emit({ type: 'session_id', data: 's1' });
  failedFactory.transports[0].emit({ type: 'ready' });
  failedFactory.transports[0].emit({ type: 'ready' });
  await delay(20);
  assert.equal(failedExec.calls.length, 1);
  failedClient.close();

  const throwingFactory = makeTransportFactory();
  const throwingExec = makeExecutor(() => {
    throw 'exec unavailable';
  });
  const throwingClient = new mod.AioPtyClient(
    'task-story-throw',
    'ws://unused',
    'http://unused',
    undefined,
    'provider-story-fixture',
    undefined,
    undefined,
    throwingFactory,
    throwingExec,
  );
  throwingFactory.transports[0].emit({ type: 'session_id', data: 's1' });
  throwingFactory.transports[0].emit({ type: 'ready' });
  await delay(20);
  throwingClient.close();

  const outputFactory = makeTransportFactory();
  const outputExec = makeExecutor(() => ({
    exitCode: 2,
    output: ' install failed ',
    stdout: '',
    stderr: '',
    timedOut: false,
  }));
  const outputClient = new mod.AioPtyClient(
    'task-story-output',
    'ws://unused',
    'http://unused',
    undefined,
    'provider-story-fixture',
    undefined,
    undefined,
    outputFactory,
    outputExec,
  );
  outputFactory.transports[0].emit({ type: 'session_id', data: 's1' });
  outputFactory.transports[0].emit({ type: 'ready' });
  await delay(20);
  outputClient.close();

  const errorThrowFactory = makeTransportFactory();
  const errorThrowExec = makeExecutor(() => {
    throw new Error('exec unavailable');
  });
  const errorThrowClient = new mod.AioPtyClient(
    'task-story-error-throw',
    'ws://unused',
    'http://unused',
    undefined,
    'provider-story-fixture',
    undefined,
    undefined,
    errorThrowFactory,
    errorThrowExec,
  );
  errorThrowFactory.transports[0].emit({ type: 'session_id', data: 's1' });
  errorThrowFactory.transports[0].emit({ type: 'ready' });
  await delay(20);
  errorThrowClient.close();
});

await test('transport controls handle stale frames, reconnect, resize, and abnormal close', async () => {
  const factory = makeTransportFactory();
  const exits = [];
  const executor = makeExecutor((request) => {
    if (request.command.includes('resize-window')) {
      throw new Error('resize unavailable');
    }
    return { exitCode: 0, output: '' };
  });
  const client = new mod.AioPtyClient(
    'task-controls',
    'ws://unused',
    'http://unused',
    (status) => exits.push(status),
    'replay-only',
    undefined,
    undefined,
    factory,
    executor,
  );
  const first = factory.transports[0];
  const chunks = [];
  client.onData((chunk) => chunks.push(chunk));

  first.emitError();
  first.emit({ type: 'ping', timestamp: 123 });
  first.emit({ type: 'unknown' });
  first.emit({ type: 'output', data: '' });
  first.emit({ type: 'output', data: { bad: true } });
  first.emit({ type: 'output', data: 'visible' });
  assert.equal(first.pongs.length, 1);
  assert.deepEqual(chunks, ['visible']);

  client.pause();
  client.resume();
  assert.equal(first.pauseCount, 1);
  assert.equal(first.resumeCount, 1);

  first.sendInputResult = false;
  first.readyState = 'closed';
  client.write('queued-1');
  const second = factory.transports[1];
  second.sendInputResult = false;
  second.readyState = 'connecting';
  client.write('queued-2');
  first.emit({ type: 'output', data: 'stale' });
  first.emitClose();
  assert.deepEqual(chunks, ['visible']);

  second.readyState = 'closed';
  client.attachToNamedSession();
  await delay(120);
  assert.ok(factory.transports.length >= 2);

  client.resize(Number.NaN, 24);
  client.resize(0, 24);
  client.resize(120.9, 40.1);
  await delay(20);
  assert.deepEqual(second.resizes, [
    [Number.NaN, 24],
    [0, 24],
    [120.9, 40.1],
  ]);

  const timerFactory = makeTransportFactory();
  const timerClient = new mod.AioPtyClient(
    'task-timer',
    'ws://unused',
    'http://unused',
    undefined,
    'replay-only',
    undefined,
    undefined,
    timerFactory,
    makeExecutor(),
  );
  timerClient.launchCodex(mod.DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV);
  timerFactory.transports[0].emit({ type: 'output', data: '\x1b[6n' });
  timerFactory.transports[0].emit({ type: 'output', data: '\x1b[6n again' });
  timerClient.close();

  const submittedTimerFactory = makeTransportFactory();
  const submittedTimerClient = new mod.AioPtyClient(
    'task-submitted-timer',
    'ws://unused',
    'http://unused',
    undefined,
    'replay-only',
    undefined,
    undefined,
    submittedTimerFactory,
    makeExecutor(),
  );
  submittedTimerClient.launchCodex(mod.DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV);
  submittedTimerFactory.transports[0].emit({ type: 'output', data: '\x1b[6n' });
  submittedTimerClient.promptSubmitted = true;
  await delay(25);
  submittedTimerClient.close();

  const closeTimerFactory = makeTransportFactory();
  const closeTimerClient = new mod.AioPtyClient(
    'task-close-timer',
    'ws://unused',
    'http://unused',
    undefined,
    'replay-only',
    undefined,
    undefined,
    closeTimerFactory,
    makeExecutor(),
  );
  closeTimerClient.launchCodex(mod.DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV);
  closeTimerFactory.transports[0].emit({ type: 'output', data: '\x1b[6n' });
  closeTimerFactory.transports[0].emitClose();
  closeTimerClient.exitResolved = true;
  closeTimerFactory.transports[0].emitClose();
  closeTimerClient.close();

  second.throwOnClose = true;
  assert.doesNotThrow(() => client.close());

  const resizeStringFactory = makeTransportFactory();
  const resizeStringClient = new mod.AioPtyClient(
    'task-resize-string',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    undefined,
    undefined,
    resizeStringFactory,
    makeExecutor((request) => {
      if (request.command.includes('resize-window')) throw 'resize unavailable';
      return { exitCode: 0, output: '' };
    }),
  );
  resizeStringClient.resize(80, 24);
  await delay(20);
  resizeStringClient.close();

  const abnormalFactory = makeTransportFactory();
  const abnormalClient = new mod.AioPtyClient(
    'task-abnormal',
    'ws://unused',
    'http://unused',
    (status) => exits.push(status),
    'replay-only',
    undefined,
    undefined,
    abnormalFactory,
    makeExecutor(),
  );
  abnormalFactory.transports[0].emitClose();
  assert.deepEqual(exits.at(-1), { code: null, abnormal: true });
  abnormalClient.close();

  const connectingFactory = makeTransportFactory({ readyState: 'connecting' });
  const connectingClient = new mod.AioPtyClient(
    'task-connecting',
    'ws://unused',
    'http://unused',
    undefined,
    'replay-only',
    undefined,
    undefined,
    connectingFactory,
    makeExecutor(),
  );
  connectingFactory.transports[0].sendInputResult = false;
  connectingClient.write('queued-on-connecting');
  assert.equal(connectingFactory.transports.length, 1);
  connectingClient.close();
});

await test('detached tmux resizes stay ordered and retry transient command failures', async () => {
  const orderedFactory = makeTransportFactory();
  const firstResize = deferred();
  const orderedExecutor = makeExecutor(async (request) => {
    if (request.command.includes('-x 132 -y 40')) {
      return firstResize.promise;
    }
    return {
      exitCode: 0,
      output: '',
      stdout: '',
      stderr: '',
      timedOut: false,
    };
  });
  const orderedClient = new mod.AioPtyClient(
    'task-resize-order',
    'ws://unused',
    'http://unused',
    undefined,
    'replay-only',
    undefined,
    undefined,
    orderedFactory,
    orderedExecutor,
  );

  orderedClient.resize(132, 40);
  orderedClient.resize(120, 36);
  await waitFor(() => orderedExecutor.calls.length === 1);
  assert.match(orderedExecutor.calls[0].command, /-x 132 -y 40$/);

  firstResize.resolve({
    exitCode: 0,
    output: '',
    stdout: '',
    stderr: '',
    timedOut: false,
  });
  await waitFor(() => orderedExecutor.calls.length === 2);
  assert.match(orderedExecutor.calls[1].command, /-x 120 -y 36$/);
  orderedClient.close();

  const retryFactory = makeTransportFactory();
  let resizeAttempts = 0;
  const retryExecutor = makeExecutor((request) => {
    if (!request.command.includes('resize-window')) {
      return {
        exitCode: 0,
        output: '',
        stdout: '',
        stderr: '',
        timedOut: false,
      };
    }
    resizeAttempts += 1;
    return {
      exitCode: resizeAttempts === 1 ? 1 : 0,
      output: '',
      stdout: '',
      stderr: '',
      timedOut: false,
    };
  });
  const retryClient = new mod.AioPtyClient(
    'task-resize-retry',
    'ws://unused',
    'http://unused',
    undefined,
    'replay-only',
    undefined,
    undefined,
    retryFactory,
    retryExecutor,
  );

  retryClient.resize(99, 33);
  await waitFor(() => resizeAttempts === 2, 1_000);
  assert.equal(resizeAttempts, 2);
  retryClient.close();
});

await test('alive-session attach output is visible but marked non-recordable until quiet', async () => {
  const factory = makeTransportFactory();
  const executor = makeExecutor((request) =>
    request.command.includes('__cap_has__')
      ? { exitCode: 0, output: '__cap_has__0\n' }
      : { exitCode: 0, output: '' },
  );
  const client = new mod.AioPtyClient(
    'task-attach-bootstrap',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    undefined,
    undefined,
    factory,
    executor,
  );
  const observed = [];
  client.onData((chunk, meta) => {
    observed.push({ chunk, recordable: meta?.recordable !== false, source: meta?.source });
  });
  const transport = factory.transports[0];

  transport.emit({ type: 'session_id', data: 's1' });
  transport.emit({ type: 'ready' });
  await waitFor(() => transport.input.some((data) => data.includes('attach')));

  transport.emit({ type: 'output', data: 'duplicate session: task-attach-bootstrap\r\n' });
  assert.deepEqual(observed.at(-1), {
    chunk: 'duplicate session: task-attach-bootstrap\r\n',
    recordable: false,
    source: 'attach-bootstrap',
  });

  await delay(25);
  transport.emit({ type: 'output', data: 'real agent output\r\n' });
  assert.deepEqual(observed.at(-1), {
    chunk: 'real agent output\r\n',
    recordable: true,
    source: undefined,
  });
  client.close();
});

await test('owner attach settle exposes both recording uncertainties and resumes after deadline', async () => {
  const factory = makeTransportFactory();
  const executor = makeExecutor((request) =>
    request.command.includes('__cap_has__')
      ? { exitCode: 0, output: '__cap_has__0\n' }
      : { exitCode: 0, output: '' },
  );
  const client = new mod.AioPtyClient(
    'task-recording-uncertainty',
    'ws://unused',
    'http://unused',
    undefined,
    'attach-only',
    undefined,
    undefined,
    factory,
    executor,
  );
  const observed = [];
  client.onData((chunk, meta) => {
    observed.push({
      chunk,
      recordable: meta?.recordable !== false,
      source: meta?.source,
    });
  });
  const transport = factory.transports[0];

  transport.emit({ type: 'session_id', data: 's-recording-uncertainty' });
  transport.emit({ type: 'ready' });
  await waitFor(() => transport.input.some((data) => data.includes('attach')));

  transport.emit({ type: 'output', data: 'attach current-frame repaint\r\n' });
  transport.emit({
    type: 'output',
    data: 'real live delta inside indistinguishable settle window\r\n',
  });
  assert.deepEqual(observed.slice(-2), [
    {
      chunk: 'attach current-frame repaint\r\n',
      recordable: false,
      source: 'attach-bootstrap',
    },
    {
      chunk: 'real live delta inside indistinguishable settle window\r\n',
      recordable: false,
      source: 'attach-bootstrap',
    },
  ]);

  let repaintIndex = 0;
  while (client.attachBootstrapActive) {
    transport.emit({
      type: 'output',
      data: `continuous attach repaint ${repaintIndex++}\r\n`,
    });
    await delay(5);
  }

  transport.emit({
    type: 'output',
    data: 'late indistinguishable repaint after hard deadline\r\n',
  });
  transport.emit({ type: 'output', data: 'later observed real append\r\n' });
  assert.deepEqual(observed.slice(-2), [
    {
      chunk: 'late indistinguishable repaint after hard deadline\r\n',
      recordable: true,
      source: undefined,
    },
    {
      chunk: 'later observed real append\r\n',
      recordable: true,
      source: undefined,
    },
  ]);
  client.close();
});

await test('pre-decision shell output is non-recordable before attaching an alive session', async () => {
  const factory = makeTransportFactory();
  let resolveProbe;
  const probeReady = new Promise((resolve) => {
    resolveProbe = resolve;
  });
  const executor = makeExecutor(async (request) => {
    if (request.command.includes('__cap_has__')) {
      await probeReady;
      return { exitCode: 0, output: '__cap_has__0\n' };
    }
    return { exitCode: 0, output: '' };
  });
  const client = new mod.AioPtyClient(
    'task-predecision-alive',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    undefined,
    undefined,
    factory,
    executor,
  );
  const observed = [];
  client.onData((chunk, meta) => {
    observed.push({ chunk, recordable: meta?.recordable !== false, source: meta?.source });
  });
  const transport = factory.transports[0];

  transport.emit({ type: 'session_id', data: 's1' });
  transport.emit({ type: 'ready' });
  await waitFor(() => executor.calls.some((call) => call.command.includes('__cap_has__')));
  transport.emit({ type: 'output', data: 'gem@boxlite:~/workspace$ ' });
  assert.deepEqual(observed.at(-1), {
    chunk: 'gem@boxlite:~/workspace$ ',
    recordable: false,
    source: 'attach-bootstrap',
  });

  resolveProbe();
  await waitFor(() => transport.input.some((data) => data.includes('attach')));
  transport.emit({ type: 'output', data: 'duplicate attach redraw\r\n' });
  assert.deepEqual(observed.at(-1), {
    chunk: 'duplicate attach redraw\r\n',
    recordable: false,
    source: 'attach-bootstrap',
  });

  await delay(25);
  transport.emit({ type: 'output', data: 'real agent output\r\n' });
  assert.deepEqual(observed.at(-1), {
    chunk: 'real agent output\r\n',
    recordable: true,
    source: undefined,
  });
  client.close();
});

await test('pre-decision shell output is non-recordable but fresh launch output is recordable', async () => {
  const factory = makeTransportFactory();
  let resolveProbe;
  const probeReady = new Promise((resolve) => {
    resolveProbe = resolve;
  });
  const executor = makeExecutor(async (request) => {
    if (request.command.includes('__cap_has__')) {
      await probeReady;
      return { exitCode: 0, output: '__cap_has__1\n' };
    }
    return { exitCode: 0, output: '' };
  });
  const client = new mod.AioPtyClient(
    'task-predecision-fresh',
    'ws://unused',
    'http://unused',
    undefined,
    'launch-or-attach',
    undefined,
    undefined,
    factory,
    executor,
  );
  const observed = [];
  client.onData((chunk, meta) => {
    observed.push({ chunk, recordable: meta?.recordable !== false, source: meta?.source });
  });
  const transport = factory.transports[0];

  transport.emit({ type: 'session_id', data: 's1' });
  transport.emit({ type: 'ready' });
  await waitFor(() => executor.calls.some((call) => call.command.includes('__cap_has__')));
  transport.emit({ type: 'output', data: 'gem@boxlite:~/workspace$ ' });
  assert.deepEqual(observed.at(-1), {
    chunk: 'gem@boxlite:~/workspace$ ',
    recordable: false,
    source: 'attach-bootstrap',
  });

  resolveProbe();
  await waitFor(() => transport.input.some((data) => data.includes('new-session')));
  transport.emit({ type: 'output', data: 'codex banner\r\n' });
  assert.deepEqual(observed.at(-1), {
    chunk: 'codex banner\r\n',
    recordable: true,
    source: undefined,
  });
  client.close();
});

await test('exit fallback paths resolve wait, echo, abnormal, and helper parsing', async () => {
  assert.equal(
    await mod.probeSessionLiveness(
      makeExecutor(() => ({ exitCode: 0, output: '__cap_has__0\n' })),
      'task-probe',
    ),
    true,
  );
  assert.equal(
    await mod.probeSessionLiveness(
      makeExecutor(() => ({ exitCode: 0, output: '__cap_has__1\n' })),
      'task-probe',
    ),
    false,
  );
  assert.equal(
    await mod.probeSessionLiveness(
      makeExecutor(() => ({ exitCode: 0, output: 'missing' })),
      'task-probe',
    ),
    null,
  );
  assert.equal(
    await mod.probeSessionLiveness(
      makeExecutor(() => {
        throw new Error('down');
      }),
      'task-probe',
    ),
    null,
  );
  assert.equal(mod.exitCodeFromExecBody(null), null);
  assert.equal(mod.exitCodeFromExecBody({ data: { output: '12\n' } }), 12);
  assert.equal(mod.exitCodeFromExecBody({ data: { stdout: '13\n' } }), 13);
  assert.equal(mod.exitCodeFromExecBody({ data: {} }), null);
  assert.equal(mod.exitCodeFromExecBody({ output: 'not-a-code' }), null);

  const originalFetch = globalThis.fetch;
  try {
    const headlessFallbackFactory = makeTransportFactory();
    const headlessFallbackExits = [];
    let headlessCatAttempted = false;
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { exitCode: 6 };
      },
    });
    const headlessFallbackClient = new mod.AioPtyClient(
      'task-headless-fallback',
      'ws://unused',
      'http://unused',
      (status) => headlessFallbackExits.push(status),
      'launch-or-attach',
      async () =>
        makeRuntime({
          async detectExit() {
            return { status: 'done' };
          },
        }),
      async () => 'headless-exec',
      headlessFallbackFactory,
      makeExecutor((request) => {
        if (request.command.includes('__cap_has__')) {
          return { exitCode: 0, output: '__cap_has__1\n' };
        }
        if (request.command.includes('cat /home/gem/.cap-headless-task-headless-fallback.exit')) {
          headlessCatAttempted = true;
          throw new Error('sentinel missing');
        }
        return { exitCode: 0, output: '' };
      }),
    );
    headlessFallbackFactory.transports[0].emit({ type: 'session_id', data: 's1' });
    headlessFallbackFactory.transports[0].emit({ type: 'ready' });
    await waitFor(() => headlessFallbackExits.length === 1);
    assert.equal(headlessCatAttempted, true);
    assert.deepEqual(headlessFallbackExits[0], { code: 6, abnormal: false });
    headlessFallbackClient.close();

    const runtimeThrowFactory = makeTransportFactory();
    const runtimeThrowExits = [];
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { exitCode: 8 };
      },
    });
    const runtimeThrowClient = new mod.AioPtyClient(
      'task-runtime-detect-throw',
      'ws://unused',
      'http://unused',
      (status) => runtimeThrowExits.push(status),
      'launch-or-attach',
      async () =>
        makeRuntime({
          async detectExit() {
            throw new Error('detect failed');
          },
        }),
      undefined,
      runtimeThrowFactory,
      makeExecutor((request) =>
        request.command.includes('__cap_has__')
          ? { exitCode: 0, output: '__cap_has__1\n' }
          : { exitCode: 0, output: '' },
      ),
    );
    runtimeThrowFactory.transports[0].emit({ type: 'session_id', data: 's1' });
    runtimeThrowFactory.transports[0].emit({ type: 'ready' });
    await waitFor(() => runtimeThrowExits.length === 1);
    assert.deepEqual(runtimeThrowExits[0], { code: 8, abnormal: false });
    runtimeThrowClient.close();

    const runtimeStringThrowFactory = makeTransportFactory();
    const runtimeStringThrowClient = new mod.AioPtyClient(
      'task-runtime-detect-string-throw',
      'ws://unused',
      'http://unused',
      undefined,
      'replay-only',
      async () => makeRuntime(),
      undefined,
      runtimeStringThrowFactory,
      makeExecutor(),
    );
    await runtimeStringThrowClient.pollRuntimeExit(
      makeRuntime({
        async detectExit() {
          throw 'detect failed';
        },
      }),
    );
    runtimeStringThrowClient.close();

    const privateBranchClient = new mod.AioPtyClient(
      'task-private-branches',
      'ws://unused',
      'http://unused',
      undefined,
      'replay-only',
      undefined,
      undefined,
      makeTransportFactory(),
      makeExecutor(),
    );
    privateBranchClient.livenessProbeInFlight = true;
    await privateBranchClient.pollLiveness();
    privateBranchClient.livenessProbeInFlight = false;
    privateBranchClient.hasSession = async () => {
      privateBranchClient.exitResolved = true;
      return false;
    };
    await privateBranchClient.pollLiveness();
    privateBranchClient.exitResolved = false;
    await privateBranchClient.pollRuntimeExit(
      makeRuntime({
        async detectExit() {
          privateBranchClient.exitResolved = true;
          return { status: 'done' };
        },
      }),
    );
    privateBranchClient.exitResolved = false;
    privateBranchClient.hasSession = async () => true;
    await privateBranchClient.pollRuntimeExit(makeRuntime());
    privateBranchClient.hasSession = async () => null;
    await privateBranchClient.pollRuntimeExit(makeRuntime());
    privateBranchClient.hasSession = async () => {
      privateBranchClient.exitResolved = true;
      return false;
    };
    await privateBranchClient.pollRuntimeExit(makeRuntime());
    privateBranchClient.close();

    const waitFactory = makeTransportFactory();
    const waitExits = [];
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { code: 4 };
      },
    });
    const waitClient = new mod.AioPtyClient(
      'task-wait',
      'ws://unused',
      'http://unused',
      (status) => waitExits.push(status),
      'launch-or-attach',
      undefined,
      undefined,
      waitFactory,
      makeExecutor((request) =>
        request.command.includes('__cap_has__')
          ? { exitCode: 0, output: '__cap_has__1\n' }
          : { exitCode: 0, output: '' },
      ),
    );
    waitFactory.transports[0].emit({ type: 'session_id', data: 's1' });
    waitFactory.transports[0].emit({ type: 'ready' });
    await waitFor(() => waitExits.length === 1);
    assert.deepEqual(waitExits[0], { code: 4, abnormal: false });
    waitClient.close();

    const echoFactory = makeTransportFactory();
    const echoExits = [];
    globalThis.fetch = async () => ({ ok: false, async json() {} });
    const echoClient = new mod.AioPtyClient(
      'task-echo',
      'ws://unused',
      'http://unused',
      (status) => echoExits.push(status),
      'launch-or-attach',
      undefined,
      undefined,
      echoFactory,
      makeExecutor((request) => {
        if (request.command.includes('__cap_has__')) {
          return { exitCode: 0, output: '__cap_has__1\n' };
        }
        if (request.command === 'echo $?') {
          return { exitCode: 0, output: '9\n' };
        }
        return { exitCode: 0, output: '' };
      }),
    );
    echoFactory.transports[0].emit({ type: 'session_id', data: 's1' });
    echoFactory.transports[0].emit({ type: 'ready' });
    await waitFor(() => echoExits.length === 1);
    assert.deepEqual(echoExits[0], { code: 9, abnormal: false });
    echoClient.close();

    const abnormalFactory = makeTransportFactory();
    const abnormalExits = [];
    globalThis.fetch = async () => {
      throw new Error('wait unavailable');
    };
    const abnormalClient = new mod.AioPtyClient(
      'task-exit-abnormal',
      'ws://unused',
      'http://unused',
      (status) => abnormalExits.push(status),
      'launch-or-attach',
      undefined,
      undefined,
      abnormalFactory,
      makeExecutor((request) => {
        if (request.command.includes('__cap_has__')) {
          return { exitCode: 0, output: '__cap_has__1\n' };
        }
        throw new Error('exec unavailable');
      }),
    );
    abnormalFactory.transports[0].emit({ type: 'session_id', data: 's1' });
    abnormalFactory.transports[0].emit({ type: 'ready' });
    await waitFor(() => abnormalExits.length === 1);
    assert.deepEqual(abnormalExits[0], { code: null, abnormal: true });
    abnormalClient.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('neutral session constructor and launch-context guards fail closed', async () => {
  assert.throws(
    () =>
      new sandbox.SandboxTerminalSession(
        'task-missing-transport',
        'ws://unused',
        'http://unused',
        undefined,
        'replay-only',
        undefined,
        undefined,
        makeExecutor(),
      ),
    /requires a transport factory and command executor/,
  );
  assert.throws(
    () =>
      new sandbox.SandboxTerminalSession(
        'task-missing-executor',
        'ws://unused',
        'http://unused',
        undefined,
        'replay-only',
        undefined,
        makeTransportFactory(),
        undefined,
      ),
    /requires a transport factory and command executor/,
  );

  const noResolver = makeNeutralSession();
  await assert.rejects(
    noResolver.client.ensureTaskLaunchContextResolved(),
    (error) => error?.phase === 'launch-context',
  );
  noResolver.client.close();

  const typedFailure = new sandbox.SandboxRuntimeModelSetupError(
    'runtime-resolution',
  );
  const typedResolver = makeNeutralSession({
    resolveTaskLaunchContext: async () => {
      throw typedFailure;
    },
  });
  await assert.rejects(
    typedResolver.client.ensureTaskLaunchContextResolved(),
    (error) => error === typedFailure,
  );
  typedResolver.client.close();

  const invalidContexts = [
    {
      runtime: undefined,
      executionMode: 'interactive-pty',
      modelIntent: { kind: 'runtime-default' },
    },
    {
      runtime: makeRuntime(),
      executionMode: 'invalid-mode',
      modelIntent: { kind: 'runtime-default' },
    },
    {
      runtime: makeRuntime(),
      executionMode: 'interactive-pty',
      modelIntent: { kind: 'invalid-model-intent' },
    },
  ];
  for (const context of invalidContexts) {
    const invalid = makeNeutralSession({
      resolveTaskLaunchContext: async () => context,
    });
    await assert.rejects(
      invalid.client.ensureTaskLaunchContextResolved(),
      (error) => error?.phase === 'launch-context',
    );
    invalid.client.close();
  }

  let resolutionCount = 0;
  const cached = makeNeutralSession({
    resolveTaskLaunchContext: async () => {
      resolutionCount += 1;
      return {
        runtime: makeRuntime(),
        executionMode: 'interactive-pty',
        modelIntent: { kind: 'runtime-default' },
      };
    },
  });
  const firstResolution = cached.client.ensureTaskLaunchContextResolved();
  const secondResolution = cached.client.ensureTaskLaunchContextResolved();
  assert.equal(firstResolution, secondResolution);
  await firstResolution;
  assert.equal(resolutionCount, 1);

  assert.throws(
    () => cached.client.launchCodex('codex', true, {
      kind: 'explicit',
      path: '/home/gem/.cap/task-model.txt',
      checksum: `sha256:${'a'.repeat(64)}`,
    }),
    (error) => error?.phase === 'launch-context',
  );
  cached.client.runtime = undefined;
  cached.client.modelMaterial = undefined;
  assert.throws(
    () => cached.client.launchAgent(),
    (error) => error?.phase === 'launch-context',
  );
  cached.client.runtime = makeRuntime();
  assert.throws(
    () => cached.client.launchAgent(),
    (error) => error?.phase === 'launch-context',
  );

  let failures = 0;
  cached.client.onRuntimeSetupFailure = () => {
    failures += 1;
  };
  cached.client.reportRuntimeSetupFailure();
  cached.client.reportRuntimeSetupFailure();
  assert.equal(failures, 1);
  cached.client.fencePendingAgentLaunch();
  cached.client.fencePendingAgentLaunch();
  cached.client.close();

  const preAborted = new AbortController();
  preAborted.abort();
  const abortedFactory = makeTransportFactory();
  const aborted = makeNeutralSession({
    taskId: 'task-pre-aborted',
    mode: 'launch-or-attach',
    transportFactory: abortedFactory,
    signal: preAborted.signal,
  });
  assert.deepEqual(await aborted.client.launchDecision, { kind: 'fenced' });
  assert.equal(abortedFactory.transports[0].closeCount, 1);

  const replayAborted = makeNeutralSession({ signal: preAborted.signal });
  assert.throws(
    () => replayAborted.client.assertAgentLaunchSignal(),
    /Agent launch was fenced/,
  );
  replayAborted.client.close();
});

await test('fresh model material is required, normalized, and independently verified', async () => {
  const missingIntent = makeNeutralSession({
    prepareModelMaterial: async (intent) => intent,
  });
  await assert.rejects(
    missingIntent.client.prepareFreshModelMaterial(),
    (error) => error?.phase === 'launch-context',
  );
  missingIntent.client.close();

  const missingPreparer = makeNeutralSession();
  missingPreparer.client.modelIntent = { kind: 'runtime-default' };
  await assert.rejects(
    missingPreparer.client.prepareFreshModelMaterial(),
    (error) => error?.phase === 'launch-context',
  );
  missingPreparer.client.close();

  const typedError = new sandbox.SandboxRuntimeModelSetupError('material-verify');
  const typedFailure = makeNeutralSession({
    prepareModelMaterial: async () => {
      throw typedError;
    },
  });
  typedFailure.client.modelIntent = { kind: 'runtime-default' };
  await assert.rejects(
    typedFailure.client.prepareFreshModelMaterial(),
    (error) => error === typedError,
  );
  typedFailure.client.close();

  const writeFailure = makeNeutralSession({
    prepareModelMaterial: async () => {
      throw new Error('write failed');
    },
  });
  writeFailure.client.modelIntent = { kind: 'runtime-default' };
  await assert.rejects(
    writeFailure.client.prepareFreshModelMaterial(),
    (error) => error?.phase === 'material-write',
  );
  writeFailure.client.close();

  const kindMismatch = makeNeutralSession({
    prepareModelMaterial: async () => ({
      kind: 'explicit',
      path: '/wrong',
      checksum: `sha256:${'0'.repeat(64)}`,
    }),
  });
  kindMismatch.client.modelIntent = { kind: 'runtime-default' };
  await assert.rejects(
    kindMismatch.client.prepareFreshModelMaterial(),
    (error) => error?.phase === 'material-verify',
  );
  kindMismatch.client.close();

  const explicitIntent = { kind: 'explicit', selector: 'gpt-test' };
  const expected = sandbox.taskModelLaunchMaterial(explicitIntent);
  for (const prepared of [
    { ...expected, path: '/wrong' },
    { ...expected, checksum: `sha256:${'f'.repeat(64)}` },
  ]) {
    const mismatch = makeNeutralSession({
      prepareModelMaterial: async () => prepared,
    });
    mismatch.client.modelIntent = explicitIntent;
    await assert.rejects(
      mismatch.client.prepareFreshModelMaterial(),
      (error) => error?.phase === 'material-verify',
    );
    mismatch.client.close();
  }

  const verified = makeNeutralSession({
    prepareModelMaterial: async () => ({ ...expected }),
  });
  verified.client.modelIntent = explicitIntent;
  await verified.client.prepareFreshModelMaterial();
  assert.deepEqual(verified.client.modelMaterial, expected);
  verified.client.close();
});

await test('launch and attach decisions stay fenced across every async boundary', async () => {
  const contextEntered = deferred();
  const contextResult = deferred();
  const contextAbort = new AbortController();
  const contextRace = makeNeutralSession({
    taskId: 'task-context-race',
    mode: 'launch-or-attach',
    signal: contextAbort.signal,
    resolveTaskLaunchContext: async () => {
      contextEntered.resolve();
      return contextResult.promise;
    },
    prepareModelMaterial: async (intent) => intent,
  });
  const contextLaunch = contextRace.client.launchOrAttachOnReady();
  await contextEntered.promise;
  contextAbort.abort();
  contextResult.resolve(makeLaunchContext());
  await contextLaunch;
  assert.deepEqual(await contextRace.client.launchDecision, { kind: 'fenced' });

  const probeEntered = deferred();
  const probeResult = deferred();
  const probeAbort = new AbortController();
  const probeRace = makeNeutralSession({
    taskId: 'task-probe-race',
    mode: 'launch-or-attach',
    signal: probeAbort.signal,
    resolveTaskLaunchContext: async () => makeLaunchContext(),
    prepareModelMaterial: async (intent) => intent,
  });
  probeRace.client.hasSession = async () => {
    probeEntered.resolve();
    return probeResult.promise;
  };
  const probeLaunch = probeRace.client.launchOrAttachOnReady();
  await probeEntered.promise;
  probeAbort.abort();
  probeResult.resolve(true);
  await probeLaunch;
  assert.deepEqual(await probeRace.client.launchDecision, { kind: 'fenced' });

  for (const alive of [false, null]) {
    const prepareEntered = deferred();
    const prepared = deferred();
    const prepareAbort = new AbortController();
    const prepareRace = makeNeutralSession({
      taskId: `task-prepare-race-${String(alive)}`,
      mode: 'launch-or-attach',
      signal: prepareAbort.signal,
      resolveTaskLaunchContext: async () => makeLaunchContext(),
      prepareModelMaterial: async () => {
        prepareEntered.resolve();
        return prepared.promise;
      },
    });
    prepareRace.client.hasSession = async () => alive;
    const launch = prepareRace.client.launchOrAttachOnReady();
    await prepareEntered.promise;
    prepareAbort.abort();
    prepared.resolve({ kind: 'runtime-default' });
    await launch;
    assert.deepEqual(await prepareRace.client.launchDecision, { kind: 'fenced' });
    assert.deepEqual(prepareRace.transportFactory.transports[0].input, []);
  }

  const nullPrepareEntered = deferred();
  const nullPrepared = deferred();
  const nullCloseRace = makeNeutralSession({
    taskId: 'task-null-prepare-close-race',
    mode: 'launch-or-attach',
    resolveTaskLaunchContext: async () => makeLaunchContext(),
    prepareModelMaterial: async () => {
      nullPrepareEntered.resolve();
      return nullPrepared.promise;
    },
  });
  nullCloseRace.client.hasSession = async () => null;
  const nullLaunch = nullCloseRace.client.launchOrAttachOnReady();
  await nullPrepareEntered.promise;
  nullCloseRace.client.close();
  nullPrepared.resolve({ kind: 'runtime-default' });
  await nullLaunch;
  assert.deepEqual(await nullCloseRace.client.launchDecision, { kind: 'fenced' });
  assert.deepEqual(nullCloseRace.transportFactory.transports[0].input, []);

  const inconclusive = makeNeutralSession({
    taskId: 'task-inconclusive-success',
    mode: 'launch-or-attach',
    resolveTaskLaunchContext: async () => makeLaunchContext(),
    prepareModelMaterial: async (intent) => intent,
  });
  inconclusive.client.hasSession = async () => null;
  await inconclusive.client.launchOrAttachOnReady();
  assert.deepEqual(await inconclusive.client.launchDecision, { kind: 'launched' });
  assert.equal(inconclusive.client.launchedCodex, false);
  assert.equal(inconclusive.transportFactory.transports[0].input.length, 2);
  inconclusive.client.close();

  const attachProbeEntered = deferred();
  const attachProbeResult = deferred();
  const attachRace = makeNeutralSession({
    taskId: 'task-attach-close-race',
    mode: 'attach-only',
  });
  attachRace.client.hasSession = async () => {
    attachProbeEntered.resolve();
    return attachProbeResult.promise;
  };
  const attach = attachRace.client.attachOnlyOnReady();
  await attachProbeEntered.promise;
  attachRace.client.close();
  attachProbeResult.resolve(true);
  await attach;
  assert.deepEqual(await attachRace.client.launchDecision, { kind: 'fenced' });
  await attachRace.client.attachOnlyOnReady();

  const attachError = makeNeutralSession({
    taskId: 'task-attach-probe-error',
    mode: 'attach-only',
  });
  attachError.client.hasSession = async () => {
    throw new Error('probe contract violation');
  };
  await attachError.client.attachOnlyOnReady();
  assert.deepEqual(await attachError.client.launchDecision, {
    kind: 'indeterminate',
  });
  attachError.client.close();
});

await test('codex defaults, autosubmit timers, and transport close remain deterministic', async () => {
  const previousArgv = process.env.CODEX_LAUNCH_ARGV;
  try {
    delete process.env.CODEX_LAUNCH_ARGV;
    const defaultLaunch = makeNeutralSession({ taskId: 'task-default-argv' });
    defaultLaunch.client.launchCodex();
    assert.match(
      defaultLaunch.transportFactory.transports[0].input[0],
      /codex -C \/home\/gem\/workspace --dangerously-bypass-approvals-and-sandbox/,
    );
    assert.doesNotMatch(
      defaultLaunch.transportFactory.transports[0].input[0],
      /--no-alt-screen/,
    );
    defaultLaunch.client.close();

    process.env.CODEX_LAUNCH_ARGV =
      'codex custom-default --dangerously-bypass-approvals-and-sandbox';
    const envLaunch = makeNeutralSession({ taskId: 'task-env-argv' });
    envLaunch.client.launchCodex(undefined, false);
    assert.match(
      envLaunch.transportFactory.transports[0].input[0],
      /codex custom-default/,
    );
    assert.equal(envLaunch.client.attachBootstrapActive, true);
    envLaunch.client.close();

    process.env.CODEX_LAUNCH_ARGV =
      'codex --no-alt-screen -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox';
    const staleEnvLaunch = makeNeutralSession({ taskId: 'task-stale-env-argv' });
    assert.throws(
      () => staleEnvLaunch.client.launchCodex(),
      /forbidden legacy flag --no-alt-screen/,
    );
    assert.equal(staleEnvLaunch.transportFactory.transports[0].input.length, 0);
    staleEnvLaunch.client.close();
  } finally {
    if (previousArgv === undefined) delete process.env.CODEX_LAUNCH_ARGV;
    else process.env.CODEX_LAUNCH_ARGV = previousArgv;
  }

  const cancelledSubmit = makeNeutralSession({ taskId: 'task-submit-cancel' });
  cancelledSubmit.client.terminalStartup = {
    replyToStartupDSR: true,
    promptSubmit: 'cr-on-quiesce',
    quiesceMs: 30,
  };
  cancelledSubmit.client.launchedCodex = true;
  const cancelledTransport = cancelledSubmit.transportFactory.transports[0];
  cancelledTransport.emit({ type: 'output', data: '\x1b[6n first' });
  cancelledTransport.emit({ type: 'output', data: '\x1b[6n second' });
  assert.notEqual(cancelledSubmit.client.autoSubmitTimer, undefined);
  cancelledSubmit.client.promptSubmitted = true;
  await delay(40);
  assert.equal(cancelledTransport.input.filter((data) => data === '\r').length, 0);
  cancelledSubmit.client.close();

  const fallbackDelay = makeNeutralSession({ taskId: 'task-submit-fallback-delay' });
  fallbackDelay.client.terminalStartup = {
    replyToStartupDSR: true,
    promptSubmit: 'cr-on-quiesce',
  };
  fallbackDelay.client.launchedCodex = true;
  const fallbackTransport = fallbackDelay.transportFactory.transports[0];
  fallbackTransport.emit({ type: 'output', data: '\x1b[6n' });
  await waitFor(() => fallbackTransport.input.includes('\r'));
  fallbackDelay.client.close();

  const closeExits = [];
  const pendingClose = makeNeutralSession({
    taskId: 'task-close-pending-submit',
    onExit: (status) => closeExits.push(status),
  });
  pendingClose.client.terminalStartup = {
    replyToStartupDSR: true,
    promptSubmit: 'cr-on-quiesce',
    quiesceMs: 1_000,
  };
  pendingClose.client.launchedCodex = true;
  pendingClose.transportFactory.transports[0].emit({
    type: 'output',
    data: '\x1b[6n',
  });
  assert.notEqual(pendingClose.client.autoSubmitTimer, undefined);
  pendingClose.transportFactory.transports[0].emitClose();
  assert.equal(pendingClose.client.autoSubmitTimer, undefined);
  assert.deepEqual(closeExits, [{ code: null, abnormal: true }]);
  pendingClose.client.close();

  const establishedClose = makeNeutralSession({
    taskId: 'task-established-unsettled-close',
  });
  establishedClose.client.established = true;
  establishedClose.transportFactory.transports[0].emitClose();
  assert.deepEqual(await establishedClose.client.launchDecision, {
    kind: 'failed',
  });
  establishedClose.client.close();

  const inactiveBootstrap = makeNeutralSession({ taskId: 'task-inactive-bootstrap' });
  inactiveBootstrap.client.attachBootstrapActive = false;
  inactiveBootstrap.client.armAttachBootstrapQuietTimer();
  assert.equal(inactiveBootstrap.client.attachBootstrapQuietTimer, undefined);
  inactiveBootstrap.client.startLivenessPoller();
  const firstTimer = inactiveBootstrap.client.livenessTimer;
  inactiveBootstrap.client.startLivenessPoller();
  assert.equal(inactiveBootstrap.client.livenessTimer, firstTimer);
  inactiveBootstrap.client.close();
  inactiveBootstrap.client.startLivenessPoller();
  assert.equal(inactiveBootstrap.client.livenessTimer, undefined);
});

await test('established owner redials attach-only without viewer input or relaunch', async () => {
  const events = [];
  const exits = [];
  const observed = [];
  const factory = makeTransportFactory({
    cleanupDecision: confirmedTransportCleanup(),
  });
  const executor = makeExecutor((request) =>
    request.command.includes('__cap_has__')
      ? { exitCode: 0, output: '__cap_has__0\n' }
      : { exitCode: 0, output: '' },
  );
  const session = makeNeutralSession({
    taskId: 'task-owner-redial',
    mode: 'attach-only',
    transportFactory: factory,
    commandExecutor: executor,
    onExit: (status) => exits.push(status),
    ownerRecoveryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      readyTimeoutMs: 50,
      jitterRatio: 0,
      onEvent: (event) => events.push(event),
    },
  });
  session.client.onData((chunk, meta) => observed.push({ chunk, meta }));
  const oldTransport = factory.transports[0];
  session.client.established = true;
  oldTransport.emitClose();

  await waitFor(() => factory.transports.length === 2);
  const replacement = factory.transports[1];
  oldTransport.emit({ type: 'output', data: 'STALE_OWNER_OUTPUT' });
  replacement.emit({ type: 'session_id', data: 'owner-redial-2' });
  replacement.emit({ type: 'ready' });
  await waitFor(() => replacement.input.some((data) => data.includes('attach')));
  replacement.emit({ type: 'output', data: 'REATTACHED_OWNER_OUTPUT' });

  assert.equal(observed.some(({ chunk }) => chunk.includes('STALE_OWNER_OUTPUT')), false);
  assert.equal(
    observed.some(({ chunk }) => chunk.includes('REATTACHED_OWNER_OUTPUT')),
    true,
  );
  assert.equal(
    [...oldTransport.input, ...replacement.input].some((data) =>
      data.includes('new-session'),
    ),
    false,
  );
  assert.equal(
    executor.calls.some((request) =>
      request.command.includes('tmux -u has-session -t =tasktask-owner-redial'),
    ),
    true,
  );
  assert.deepEqual(events.map((event) => event.kind), [
    'outage',
    'retry',
    'restored',
  ]);
  // A provider may deliver the superseded generation's close callback after
  // the replacement has already reached ready. That late callback must remain
  // inert: it cannot start a second recovery or open another owner transport.
  oldTransport.emitClose();
  await delay(10);
  assert.equal(factory.transports.length, 2);
  assert.deepEqual(events.map((event) => event.kind), [
    'outage',
    'retry',
    'restored',
  ]);
  assert.equal(events.at(-1).durationMs >= 0, true);
  assert.deepEqual(exits, []);
  session.client.close();
});

await test('owner recovery fences replacement attach on exact old-generation cleanup', async () => {
  const cleanup = deferred();
  const factory = makeTransportFactory({ cleanupDecision: cleanup.promise });
  const executor = makeExecutor((request) =>
    request.command.includes('__cap_has__')
      ? { exitCode: 0, output: '__cap_has__0\n' }
      : { exitCode: 0, output: '' },
  );
  const session = makeNeutralSession({
    taskId: 'task-owner-cleanup-fence',
    mode: 'attach-only',
    transportFactory: factory,
    commandExecutor: executor,
    ownerRecoveryPolicy: {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      readyTimeoutMs: 25,
      cleanupTimeoutMs: 100,
      jitterRatio: 0,
    },
  });
  session.client.established = true;
  factory.transports[0].emitClose();
  await delay(20);
  assert.equal(factory.transports.length, 1);
  assert.equal(executor.calls.length, 0);

  cleanup.resolve(await confirmedTransportCleanup());
  await waitFor(() => factory.transports.length === 2);
  assert.equal(
    executor.calls.some((request) => request.command.includes('__cap_has__')),
    true,
  );
  session.client.close();
});

await test('owner recovery queues terminal responses behind old-generation cleanup without an input redial', async () => {
  for (const closeFirst of [true, false]) {
    const cleanup = deferred();
    const events = [];
    const factory = makeTransportFactory({ cleanupDecision: cleanup.promise });
    const executor = makeExecutor((request) =>
      request.command.includes('__cap_has__')
        ? { exitCode: 0, output: '__cap_has__0\n' }
        : { exitCode: 0, output: '' },
    );
    const session = makeNeutralSession({
      taskId: `task-owner-input-fence-${closeFirst ? 'close' : 'write'}`,
      mode: 'attach-only',
      transportFactory: factory,
      commandExecutor: executor,
      ownerRecoveryPolicy: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        readyTimeoutMs: 100,
        cleanupTimeoutMs: 250,
        jitterRatio: 0,
        onEvent: (event) => events.push(event),
      },
    });
    const oldTransport = factory.transports[0];
    const terminalResponse = '\x1b[>0;276;0c';
    session.client.established = true;
    oldTransport.sendInputResult = false;
    if (closeFirst) oldTransport.emitClose();

    session.client.write(terminalResponse);
    assert.equal(factory.transports.length, 1);
    assert.deepEqual(session.client.pendingInput, [terminalResponse]);
    assert.equal(session.client.ownerRecoveryActive, true);
    if (!closeFirst) assert.equal(oldTransport.closeCount, 1);
    await delay(20);
    assert.equal(factory.transports.length, 1);

    cleanup.resolve(await confirmedTransportCleanup());
    await waitFor(() => factory.transports.length === 2);
    const replacement = factory.transports[1];
    replacement.emit({ type: 'session_id', data: 'owner-input-fence-2' });
    replacement.emit({ type: 'ready' });
    await waitFor(() =>
      replacement.input.some((data) => data.includes('attach-session')),
    );
    await waitFor(
      () => replacement.input.filter((data) => data === terminalResponse).length === 1,
      250,
    );

    assert.equal(factory.transports.length, 2);
    assert.equal(
      replacement.input.filter((data) => data === terminalResponse).length,
      1,
    );
    assert.deepEqual(events.map((event) => event.kind), [
      'outage',
      'retry',
      'restored',
    ]);
    session.client.close();
  }
});

await test('owner recovery waits for a timed-out candidate cleanup before retrying', async () => {
  const timedOutCleanup = deferred();
  const cleanupDecisions = [
    confirmedTransportCleanup(),
    timedOutCleanup.promise,
    confirmedTransportCleanup(),
  ];
  const factory = makeTransportFactory();
  const originalOpen = factory.open.bind(factory);
  factory.open = () => {
    const transport = originalOpen();
    transport.cleanupDecision =
      cleanupDecisions[factory.transports.length - 1] ??
      confirmedTransportCleanup();
    return transport;
  };
  const events = [];
  const session = makeNeutralSession({
    taskId: 'task-owner-timeout-cleanup-fence',
    mode: 'attach-only',
    transportFactory: factory,
    commandExecutor: makeExecutor((request) =>
      request.command.includes('__cap_has__')
        ? { exitCode: 0, output: '__cap_has__0\n' }
        : { exitCode: 0, output: '' },
    ),
    ownerRecoveryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      readyTimeoutMs: 10,
      cleanupTimeoutMs: 250,
      jitterRatio: 0,
      onEvent: (event) => events.push(event),
    },
  });
  session.client.established = true;
  factory.transports[0].emitClose();
  await waitFor(() => factory.transports.length === 2);
  const timedOutCandidate = factory.transports[1];
  await waitFor(() => timedOutCandidate.closeCount === 1);
  timedOutCandidate.readyState = 'closed';
  timedOutCandidate.sendInputResult = false;

  const terminalResponse = '\x1b[?1;2c';
  session.client.write(terminalResponse);
  timedOutCandidate.emit({ type: 'ready' });
  await delay(20);
  assert.equal(factory.transports.length, 2);
  assert.equal(
    timedOutCandidate.input.some((data) => data.includes('attach-session')),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === 'restored'),
    false,
  );

  timedOutCleanup.resolve(await confirmedTransportCleanup());
  await waitFor(() => factory.transports.length === 3);
  const replacement = factory.transports[2];
  replacement.emit({ type: 'session_id', data: 'owner-timeout-fence-3' });
  replacement.emit({ type: 'ready' });
  await waitFor(
    () => replacement.input.filter((data) => data === terminalResponse).length === 1,
    250,
  );
  assert.equal(timedOutCandidate.closeCount, 1);
  assert.equal(
    replacement.input.filter((data) => data.includes('attach-session')).length,
    1,
  );
  assert.equal(
    replacement.input.filter((data) => data === terminalResponse).length,
    1,
  );
  assert.deepEqual(events.map((event) => event.kind), [
    'outage',
    'retry',
    'retry',
    'restored',
  ]);
  session.client.close();
});

await test('late write and pending-input flush cannot reopen a closed session', async () => {
  const session = makeNeutralSession({ taskId: 'task-no-redial-after-close' });
  const terminalResponse = '\x1b[>0;276;0c';
  session.client.pendingInput.push(terminalResponse);
  session.client.flushPendingInputSoon();
  session.client.close();
  session.client.write(terminalResponse);
  await delay(125);

  assert.equal(session.transportFactory.transports.length, 1);
  assert.equal(session.transportFactory.transports[0].closeCount, 1);
  assert.equal(session.transportFactory.transports[0].input.length, 0);
});

await test('owner recovery fails closed when old-generation cleanup is indeterminate or hangs', async () => {
  const indeterminate = Promise.resolve({
    kind: 'indeterminate',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    cause: 'cleanup-unconfirmed',
  });
  for (const scenario of [
    { name: 'indeterminate', cleanupDecision: indeterminate, timeoutMs: 50 },
    { name: 'timeout', cleanupDecision: new Promise(() => {}), timeoutMs: 5 },
  ]) {
    const events = [];
    const exits = [];
    const factory = makeTransportFactory({
      cleanupDecision: scenario.cleanupDecision,
    });
    const executor = makeExecutor();
    const session = makeNeutralSession({
      taskId: `task-owner-cleanup-${scenario.name}`,
      mode: 'attach-only',
      transportFactory: factory,
      commandExecutor: executor,
      onExit: (status) => exits.push(status),
      ownerRecoveryPolicy: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        readyTimeoutMs: 10,
        cleanupTimeoutMs: scenario.timeoutMs,
        jitterRatio: 0,
        onEvent: (event) => events.push(event),
      },
    });
    session.client.established = true;
    factory.transports[0].emitClose();
    await waitFor(() => exits.length === 1);
    assert.deepEqual(exits, [{ code: null, abnormal: true }]);
    assert.deepEqual(events.map((event) => event.kind), ['outage', 'failed']);
    assert.equal(events.at(-1).reason, 'cleanup-unconfirmed');
    assert.equal(factory.transports.length, 1);
    assert.equal(executor.calls.length, 0);
    session.client.close();
  }
});

await test('owner recovery keeps indeterminate probes bounded then fails honestly', async () => {
  const events = [];
  const exits = [];
  const session = makeNeutralSession({
    taskId: 'task-owner-indeterminate',
    mode: 'attach-only',
    transportFactory: makeTransportFactory({
      cleanupDecision: confirmedTransportCleanup(),
    }),
    commandExecutor: makeExecutor(() => ({ exitCode: 0, output: 'no marker' })),
    onExit: (status) => exits.push(status),
    ownerRecoveryPolicy: {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      readyTimeoutMs: 10,
      jitterRatio: 0,
      onEvent: (event) => events.push(event),
    },
  });
  session.client.established = true;
  session.transportFactory.transports[0].emitClose();
  await waitFor(() => exits.length === 1);

  assert.deepEqual(exits, [{ code: null, abnormal: true }]);
  assert.deepEqual(events.map((event) => event.kind), [
    'outage',
    'retry',
    'retry',
    'failed',
  ]);
  assert.equal(events.at(-1).reason, 'budget-exhausted');
  assert.equal(session.transportFactory.transports.length, 1);
  assert.equal(
    session.transportFactory.transports[0].input.some((data) =>
      data.includes('new-session'),
    ),
    false,
  );
  session.client.close();
});

await test('owner recovery treats a definitively absent session as unobserved exit', async () => {
  const events = [];
  const exits = [];
  const session = makeNeutralSession({
    taskId: 'task-owner-absent',
    mode: 'launch-or-attach',
    transportFactory: makeTransportFactory({
      cleanupDecision: confirmedTransportCleanup(),
    }),
    commandExecutor: makeExecutor(() => ({
      exitCode: 0,
      output: '__cap_has__1\n',
    })),
    onExit: (status) => exits.push(status),
    ownerRecoveryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      readyTimeoutMs: 10,
      jitterRatio: 0,
      onEvent: (event) => events.push(event),
    },
  });
  session.client.established = true;
  session.transportFactory.transports[0].emitClose();
  await waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [{ code: null, abnormal: true }]);
  assert.equal(events.at(-1).kind, 'failed');
  assert.equal(events.at(-1).reason, 'absent');
  assert.equal(session.transportFactory.transports.length, 1);
  assert.equal(session.transportFactory.transports[0].input.length, 0);
  session.client.close();
});

await test('inline and runtime liveness paths preserve inconclusive and terminal outcomes', async () => {
  for (const alive of [null, true]) {
    const exits = [];
    const probe = makeNeutralSession({
      taskId: `task-inline-${String(alive)}`,
      onExit: (status) => exits.push(status),
    });
    probe.client.hasSession = async () => alive;
    await probe.client.pollLiveness();
    assert.deepEqual(exits, []);
    probe.client.close();
  }

  const inlineExits = [];
  const inlineGone = makeNeutralSession({
    taskId: 'task-inline-gone',
    onExit: (status) => inlineExits.push(status),
    resolveProviderExitStatus: async () => 5,
  });
  inlineGone.client.hasSession = async () => false;
  await inlineGone.client.pollLiveness();
  assert.deepEqual(inlineExits, [{ code: 5, abnormal: false }]);
  inlineGone.client.close();

  const settledDuringProbe = makeNeutralSession({
    taskId: 'task-inline-settled-during-probe',
  });
  settledDuringProbe.client.hasSession = async () => {
    settledDuringProbe.client.exitResolved = true;
    return false;
  };
  await settledDuringProbe.client.pollLiveness();
  settledDuringProbe.client.close();

  const stringProbe = makeNeutralSession({ taskId: 'task-runtime-string-probe' });
  stringProbe.client.modelMaterial = { kind: 'runtime-default' };
  stringProbe.client.hasSession = async () => true;
  await stringProbe.client.pollRuntimeExit(
    makeRuntime({
      async detectExit() {
        throw 'string probe failure';
      },
    }),
  );
  stringProbe.client.close();

  const alreadyExited = makeNeutralSession({ taskId: 'task-runtime-already-exited' });
  alreadyExited.client.modelMaterial = { kind: 'runtime-default' };
  alreadyExited.client.exitResolved = true;
  await alreadyExited.client.pollRuntimeExit(
    makeRuntime({
      async detectExit() {
        return { status: 'done' };
      },
    }),
  );
  alreadyExited.client.close();

  const runtimeExits = [];
  const runtimeGone = makeNeutralSession({
    taskId: 'task-runtime-backstop-gone',
    onExit: (status) => runtimeExits.push(status),
    resolveProviderExitStatus: async () => 6,
  });
  runtimeGone.client.modelMaterial = { kind: 'runtime-default' };
  runtimeGone.client.hasSession = async () => false;
  await runtimeGone.client.pollRuntimeExit(makeRuntime());
  assert.deepEqual(runtimeExits, [{ code: 6, abnormal: false }]);
  runtimeGone.client.close();

  const noRuntimeDetector = makeNeutralSession({ taskId: 'task-no-runtime-detector' });
  noRuntimeDetector.client.runtime = {
    ...makeRuntime(),
    detectExit: undefined,
  };
  noRuntimeDetector.client.hasSession = async () => true;
  await noRuntimeDetector.client.pollLiveness();
  noRuntimeDetector.client.close();

  const noWait = makeNeutralSession({ taskId: 'task-no-provider-wait' });
  assert.equal(await noWait.client.resolveViaWait(), null);
  noWait.client.close();

  const throwingWait = makeNeutralSession({
    taskId: 'task-throwing-provider-wait',
    resolveProviderExitStatus: async () => {
      throw new Error('wait failed');
    },
  });
  assert.equal(await throwingWait.client.resolveViaWait(), null);
  throwingWait.client.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
