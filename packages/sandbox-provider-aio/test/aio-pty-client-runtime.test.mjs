process.env.CODEX_AUTOSUBMIT_QUIESCE_MS = '15';
process.env.CODEX_LIVENESS_POLL_MS = '15';
process.env.CODEX_ATTACH_BOOTSTRAP_QUIESCE_MS = '15';
process.env.CODEX_ATTACH_BOOTSTRAP_MAX_MS = '50';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const aio = await import(new URL('../dist/index.js', import.meta.url).href);

/**
 * Adapt this legacy-heavy test file to the strict combined launch-context
 * constructor while preserving each case's original transport/executor setup.
 * Tests that pass a resolver still exercise its success/failure exactly; cases
 * unrelated to lookup get an explicit runtime-default context from the fixture.
 */
class TestAioPtyClient extends aio.AioPtyClient {
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
    );
  }
}

const mod = { ...aio, AioPtyClient: TestAioPtyClient };

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
  timerClient.launchCodex('codex test');
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
  submittedTimerClient.launchCodex('codex test');
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
  closeTimerClient.launchCodex('codex test');
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
