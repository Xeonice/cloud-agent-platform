import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const REPOSITORY_URL = 'https://gitee.com/acme/public.git';
const WORKSPACE_DIR = '/home/gem/workspace';
const STAGING_DIR = '/home/gem/workspace.cap-stage';
const TAIL_SENTINEL = 'CAP_TRANSFER_PROGRESS_TAIL';

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

function executionResult(overrides = {}) {
  return {
    exitCode: 0,
    output: '',
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function manualDriver() {
  let now = 0;
  const scheduled = new Set();
  return {
    driver: {
      now: () => now,
      schedule(delayMs, trigger) {
        const item = { at: now + delayMs, trigger, cancelled: false };
        scheduled.add(item);
        return () => {
          item.cancelled = true;
          scheduled.delete(item);
        };
      },
    },
    advance(ms) {
      now += ms;
      for (const item of [...scheduled].sort((a, b) => a.at - b.at)) {
        if (!item.cancelled && item.at <= now) {
          scheduled.delete(item);
          item.trigger();
        }
      }
    },
  };
}

async function pump(times = 40) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

async function tick(clock, ms) {
  clock.advance(ms);
  await pump();
}

function probeOutput(args) {
  const head =
    args.state === 'exited'
      ? `exit ${args.exitCode}`
      : args.state === 'alive'
        ? `alive ${args.pid ?? 4242}`
        : 'unknown';
  const progress =
    args.sizeBytes === undefined
      ? ''
      : `\nprogress ${args.sizeBytes} ${args.mtime ?? 1}`;
  return `${head}${progress}\n${TAIL_SENTINEL}\n${args.tail ?? ''}`;
}

/**
 * Detached-protocol stage executor fake. `script` is a function invoked per
 * transfer probe (1-indexed) returning either an execution result or a thrown
 * error; launch and kill are tracked separately.
 */
function detachedExecutor(script, options = {}) {
  const calls = [];
  let probeIndex = 0;
  const state = {
    calls,
    launches: [],
    kills: [],
    probes: () => probeIndex,
  };
  state.stageExecutor = {
    async execute(execution) {
      calls.push({ stage: execution.stage, command: execution.request.command });
      const command = execution.request.command;
      if (execution.stage !== 'workspace_transfer') {
        return executionResult();
      }
      if (command.includes('setsid')) {
        state.launches.push(command);
        return options.launch?.(execution) ?? executionResult();
      }
      if (command.includes('kill -TERM')) {
        state.kills.push(command);
        return executionResult();
      }
      if (command.includes(TAIL_SENTINEL)) {
        probeIndex += 1;
        const step = script(probeIndex, execution);
        if (step instanceof Error) throw step;
        return step;
      }
      return executionResult();
    },
  };
  return state;
}

function detachedContext(executor, overrides = {}) {
  const { detachedTransfer, plan, ...rest } = overrides;
  return {
    taskId: 'task-detached-fixture',
    plan: {
      repositoryUrl: REPOSITORY_URL,
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 60_000,
      ...(plan ?? {}),
    },
    workspaceDir: WORKSPACE_DIR,
    stageExecutor: executor.stageExecutor,
    detachedTransfer: {
      liveness: { heartbeatWindowMs: 5_000, absoluteCapMs: 3_600_000 },
      pollIntervalMs: 1_000,
      ...(detachedTransfer ?? {}),
    },
    ...rest,
  };
}

function diagnosticsRecorder() {
  const events = [];
  return {
    events,
    observer: {
      createOperationId: (replayKey) => `op:${replayKey}`,
      emit: (event) => {
        events.push(event);
      },
    },
  };
}

// --- Task 3.2: host-side git stderr progress parser fixtures ---

await test('parser reads CR-delimited Receiving objects with counts, bytes, and throughput', () => {
  const text =
    'remote: Counting objects: 5\r' +
    'remote: Compressing objects: 40% (4/10)\r' +
    'Receiving objects: 42% (42/100), 12.50 MiB | 2.30 MiB/s\r';
  const snapshot = mod.parseGitTransferProgress(text);
  assert.deepEqual(snapshot, {
    percent: 42,
    receivedObjects: 42,
    totalObjects: 100,
    receivedBytes: 13107200,
    throughputBytesPerSecond: 2411725,
  });
});

await test('parser reports pre-transfer phases as explicitly unknown, never 0%', () => {
  for (const text of [
    'remote: Enumerating objects: 1234\r',
    'remote: Counting objects: 12% (3/25)\r',
    'remote: Compressing objects: 40% (4/10)\r',
    'Resolving deltas: 88% (88/100)\r',
  ]) {
    const snapshot = mod.parseGitTransferProgress(text);
    assert.notEqual(snapshot, null);
    assert.equal(snapshot.percent, null);
    assert.equal(snapshot.receivedBytes, null);
  }
});

await test('parser treats unparsed lines as unknown-phase-still-alive and empty text as no observation', () => {
  const unknown = mod.parseGitTransferProgress('warning: something odd\n');
  assert.notEqual(unknown, null);
  assert.equal(unknown.percent, null);
  assert.equal(mod.parseGitTransferProgress(''), null);
  assert.equal(mod.parseGitTransferProgress('  \r\n'), null);
});

await test('parser falls back past a truncated trailing progress line', () => {
  const text =
    'Receiving objects: 10% (10/100), 1.00 KiB | 512 B/s\rReceiving objects: 4';
  const snapshot = mod.parseGitTransferProgress(text);
  assert.equal(snapshot.percent, 10);
  assert.equal(snapshot.receivedBytes, 1024);
  assert.equal(snapshot.throughputBytesPerSecond, 512);
});

await test('parser reports Receiving objects without byte suffix as numeric counts only', () => {
  const snapshot = mod.parseGitTransferProgress('Receiving objects: 7% (7/100)\r');
  assert.deepEqual(snapshot, {
    percent: 7,
    receivedObjects: 7,
    totalObjects: 100,
    receivedBytes: null,
    throughputBytesPerSecond: null,
  });
});

// --- Tasks 3.1/3.4/3.7: staged loop over the detached path ---

await test('detached transfer launches setsid job with --progress, low-speed abort, staging publish; polls to success', async () => {
  const clock = manualDriver();
  const diagnostics = diagnosticsRecorder();
  const progressEvents = [];
  const stageEvents = [];
  const executor = detachedExecutor((index) => {
    if (index === 1) {
      return executionResult({
        output: probeOutput({
          state: 'alive',
          sizeBytes: 100,
          mtime: 1,
          tail: 'remote: Counting objects: 50\r',
        }),
      });
    }
    if (index === 2) {
      return executionResult({
        output: probeOutput({
          state: 'alive',
          sizeBytes: 4_000,
          mtime: 2,
          tail: 'Receiving objects: 42% (42/100), 12.50 MiB | 2.30 MiB/s\r',
        }),
      });
    }
    return executionResult({
      output: probeOutput({ state: 'exited', exitCode: 0, sizeBytes: 9_000 }),
    });
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, {
      diagnostics: diagnostics.observer,
      onProgress: (event) => {
        if (event.status === 'progress') progressEvents.push(event);
        else if (event.stage === 'workspace_transfer') stageEvents.push(event);
      },
    }),
    { deadlineDriver: clock.driver },
  );
  await pump();
  for (let index = 0; index < 4; index += 1) await tick(clock, 1_000);
  const result = await operation;

  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.equal(executor.launches.length, 1);
  const launch = executor.launches[0];
  assert.ok(launch.includes('setsid'));
  assert.ok(launch.includes('--progress'));
  assert.ok(launch.includes('GIT_HTTP_LOW_SPEED_LIMIT=1024'));
  assert.ok(launch.includes('GIT_HTTP_LOW_SPEED_TIME=300'));
  assert.ok(launch.includes(STAGING_DIR));
  // The wrapper is nested one shell-quote level deep; unescape to assert the
  // atomic staging→workspace publish step.
  const unescaped = launch.replaceAll(`'\\''`, `'`);
  assert.ok(unescaped.includes(`mv '${STAGING_DIR}' '${WORKSPACE_DIR}'`));
  assert.ok(launch.includes('ws-transfer-task-detached-fixture'));

  // Progress variant: indeterminate first (never 0%), then parsed percent.
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents[0].progress.percent, null);
  assert.deepEqual(progressEvents[1].progress, {
    percent: 42,
    receivedObjects: 42,
    totalObjects: 100,
    receivedBytes: 13107200,
    throughputBytesPerSecond: 2411725,
  });
  assert.deepEqual(
    stageEvents.map((event) => event.status),
    ['started', 'succeeded'],
  );

  // Task 3.7: exactly one started + one terminal git_clone event per job;
  // per-poll progress never enters the event ledger.
  const transferDiagnostics = diagnostics.events.filter(
    (event) => event.stage === 'workspace_transfer',
  );
  assert.deepEqual(
    transferDiagnostics.map((event) => event.outcome),
    ['started', 'succeeded'],
  );
  assert.ok(
    transferDiagnostics.every(
      (event) => event.commandKind === 'git_clone',
    ),
  );
  assert.equal(
    diagnostics.events.some((event) => event.outcome === 'progress'),
    false,
  );
});

// --- Task 3.3: dual-gate scenarios ---

await test('healthy-but-slow clone outlives the legacy wall clock and still succeeds', async () => {
  const clock = manualDriver();
  let size = 0;
  const executor = detachedExecutor((index) => {
    size += 1_000;
    if (index >= 30) {
      return executionResult({
        output: probeOutput({ state: 'exited', exitCode: 0, sizeBytes: size }),
      });
    }
    return executionResult({
      output: probeOutput({
        state: 'alive',
        sizeBytes: size,
        mtime: index,
        tail: `Receiving objects: ${index}% (${index}/100)\r`,
      }),
    });
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, {
      // Legacy wall clock far below the transfer duration: 5s deadline,
      // 30s transfer. The deadline is paused for the transfer stage only.
      plan: { deadlineMs: 5_000 },
      detachedTransfer: {
        liveness: { heartbeatWindowMs: 5_000, absoluteCapMs: 3_600_000 },
        pollIntervalMs: 1_000,
      },
    }),
    { deadlineDriver: clock.driver },
  );
  await pump();
  for (let index = 0; index < 30; index += 1) await tick(clock, 1_000);
  const result = await operation;
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.equal(executor.kills.length, 0);
});

await test('stalled transfer is killed at the heartbeat gate with the gate window as the diagnostic timeout', async () => {
  const clock = manualDriver();
  const diagnostics = diagnosticsRecorder();
  const executor = detachedExecutor(() =>
    executionResult({
      output: probeOutput({
        state: 'alive',
        sizeBytes: 500,
        mtime: 1,
        tail: 'Receiving objects: 3% (3/100)\r',
      }),
    }),
  );
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, { diagnostics: diagnostics.observer }),
    { deadlineDriver: clock.driver },
  );
  await pump();
  for (let index = 0; index < 8; index += 1) await tick(clock, 1_000);
  const result = await operation;
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'timeout',
    retryable: true,
  });
  assert.equal(executor.kills.length, 1);
  const terminal = diagnostics.events.find(
    (event) =>
      event.stage === 'workspace_transfer' && event.outcome === 'timed_out',
  );
  assert.equal(terminal.timeoutMs, 5_000);
});

await test('runaway transfer is killed at the absolute cap even while progress keeps advancing', async () => {
  const clock = manualDriver();
  const diagnostics = diagnosticsRecorder();
  let size = 0;
  const executor = detachedExecutor((index) => {
    size += 1_000;
    return executionResult({
      output: probeOutput({
        state: 'alive',
        sizeBytes: size,
        mtime: index,
        tail: `Receiving objects: 50% (50/100)\r`,
      }),
    });
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, {
      diagnostics: diagnostics.observer,
      detachedTransfer: {
        liveness: { heartbeatWindowMs: 5_000, absoluteCapMs: 8_000 },
        pollIntervalMs: 1_000,
      },
    }),
    { deadlineDriver: clock.driver },
  );
  await pump();
  for (let index = 0; index < 10; index += 1) await tick(clock, 1_000);
  const result = await operation;
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'timeout',
    retryable: true,
  });
  assert.equal(executor.kills.length, 1);
  const terminal = diagnostics.events.find(
    (event) =>
      event.stage === 'workspace_transfer' && event.outcome === 'timed_out',
  );
  assert.equal(terminal.timeoutMs, 8_000);
});

await test('dropped polls are never settlement evidence; a later exit marker settles the stage', async () => {
  const clock = manualDriver();
  const executor = detachedExecutor((index) => {
    if (index <= 2) return new Error('exec transport dropped');
    return executionResult({
      output: probeOutput({ state: 'exited', exitCode: 0, sizeBytes: 10 }),
    });
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor),
    { deadlineDriver: clock.driver },
  );
  await pump();
  for (let index = 0; index < 4; index += 1) await tick(clock, 1_000);
  const result = await operation;
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
});

// --- Marker settlement + triage three-way over the staged loop ---

await test('nonzero exit marker settles as a typed failure classified from the progress tail', async () => {
  const clock = manualDriver();
  const executor = detachedExecutor(() =>
    executionResult({
      output: probeOutput({
        state: 'exited',
        exitCode: 128,
        sizeBytes: 10,
        tail: "fatal: Authentication failed for 'https://gitee.com/acme/public.git'",
      }),
    }),
  );
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor),
    { deadlineDriver: clock.driver },
  );
  await pump();
  await tick(clock, 1_000);
  const result = await operation;
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'authentication',
    retryable: false,
  });
});

await test('unprovable job (neither pid nor exit marker) is a typed failure, never success or parking', async () => {
  const clock = manualDriver();
  const executor = detachedExecutor(() =>
    executionResult({ output: probeOutput({ state: 'unknown' }) }),
  );
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor),
    { deadlineDriver: clock.driver },
  );
  await pump();
  await tick(clock, 1_000);
  const result = await operation;
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'unknown',
    retryable: false,
  });
});

await test('cancellation during a detached transfer kills the job via the pid marker', async () => {
  const clock = manualDriver();
  const controller = new AbortController();
  const executor = detachedExecutor(() =>
    executionResult({
      output: probeOutput({ state: 'alive', sizeBytes: 5, mtime: 1 }),
    }),
  );
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, { cancellationSignal: controller.signal }),
    { deadlineDriver: clock.driver },
  );
  await pump();
  await tick(clock, 1_000);
  controller.abort();
  await tick(clock, 1_000);
  const result = await operation;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stage, 'workspace_transfer');
  assert.equal(executor.kills.length, 1);
  assert.ok(executor.kills[0].includes('ws-transfer-task-detached-fixture'));
});

await test('launch failure classifies without polling and without a kill', async () => {
  const clock = manualDriver();
  const executor = detachedExecutor(() => executionResult(), {
    launch: () =>
      executionResult({ exitCode: 1, output: 'sh: setsid: not found' }),
  });
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor),
    { deadlineDriver: clock.driver },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'workspace_transfer');
  assert.equal(executor.probes(), 0);
});

await test('contexts without detachedTransfer keep the legacy single blocking transfer exec', async () => {
  const executor = detachedExecutor(() => {
    throw new Error('probe must not run on the legacy path');
  });
  const context = detachedContext(executor);
  delete context.detachedTransfer;
  const result = await mod.materializeSandboxGitWorkspaceStaged(context);
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.equal(executor.launches.length, 0);
  assert.equal(executor.probes(), 0);
});

// --- Verify-reopened V.1/V.2: cooperative parking + resume triage seam ---

await test('park opt-in raises the detached signal after launch instead of entering the poll loop', async () => {
  const stageEvents = [];
  const executor = detachedExecutor(() => {
    throw new Error('parking must not enter the transfer poll loop');
  });
  let signal;
  try {
    await mod.materializeSandboxGitWorkspaceStaged(
      detachedContext(executor, {
        detachment: { park: true },
        onProgress: (event) => {
          stageEvents.push(event);
        },
      }),
    );
    assert.fail('a parking transfer must not resolve the materialization');
  } catch (error) {
    signal = error;
  }
  assert.equal(mod.isSandboxWorkspaceTransferDetachedSignal(signal), true);
  assert.equal(signal.job.taskId, 'task-detached-fixture');
  assert.equal(signal.job.jobId, 'ws-transfer-task-detached-fixture');
  assert.equal(executor.launches.length, 1);
  assert.equal(executor.probes(), 0);
  assert.equal(executor.kills.length, 0);
  // The stage stays open (no transfer terminal), while credential cleanup —
  // the materialization's finally — still ran before the signal escaped.
  const transferEvents = stageEvents.filter(
    (event) => event.stage === 'workspace_transfer',
  );
  assert.deepEqual(
    transferEvents.map((event) => event.status),
    ['started'],
  );
  const cleanupEvents = stageEvents.filter(
    (event) => event.stage === 'credential_cleanup',
  );
  assert.deepEqual(
    cleanupEvents.map((event) => event.status),
    ['started', 'succeeded'],
  );
});

await test('the handed-back job seam probes and kills through the same sandbox exec channel', async () => {
  let nextProbe = probeOutput({
    state: 'alive',
    sizeBytes: 100,
    mtime: 1,
    tail: 'Receiving objects: 42% (42/100), 12.50 MiB | 2.30 MiB/s\r',
  });
  let throwProbe = false;
  const executor = detachedExecutor(() => {
    if (throwProbe) return new Error('exec transport dropped');
    return executionResult({ output: nextProbe });
  });
  let signal;
  try {
    await mod.materializeSandboxGitWorkspaceStaged(
      detachedContext(executor, { detachment: { park: true } }),
    );
  } catch (error) {
    signal = error;
  }
  assert.equal(mod.isSandboxWorkspaceTransferDetachedSignal(signal), true);

  const alive = await signal.job.probe();
  assert.equal(alive.kind, 'alive');
  assert.deepEqual(alive.progress, {
    percent: 42,
    receivedObjects: 42,
    totalObjects: 100,
    receivedBytes: 13107200,
    throughputBytesPerSecond: 2411725,
  });

  nextProbe = probeOutput({ state: 'exited', exitCode: 0, sizeBytes: 200 });
  assert.deepEqual(await signal.job.probe(), { kind: 'exited' });

  nextProbe = probeOutput({ state: 'unknown' });
  assert.deepEqual(await signal.job.probe(), { kind: 'unknown' });

  // Transport failure is transient (thrown), never an unknown settlement.
  throwProbe = true;
  await assert.rejects(() => signal.job.probe());
  throwProbe = false;

  assert.equal(executor.kills.length, 0);
  await signal.job.kill();
  assert.equal(executor.kills.length, 1);
  assert.ok(executor.kills[0].includes('ws-transfer-task-detached-fixture'));
});

await test('resume with a success exit marker settles from the marker and never relaunches the transfer', async () => {
  const triaged = [];
  const executor = detachedExecutor(() =>
    executionResult({
      output: probeOutput({ state: 'exited', exitCode: 0, sizeBytes: 9_000 }),
    }),
  );
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, {
      detachment: {
        park: true,
        resume: {
          triage: (probe) => {
            triaged.push(probe);
            return probe.exitMarker
              ? 'settle_from_exit'
              : probe.pidAlive
                ? 'keep_parked'
                : 'fail_attempt';
          },
        },
      },
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  // The claim-path triage saw the marker evidence, no job was relaunched, and
  // provision continued from checkout onwards in the same sandbox. The
  // observed progress stream is evidence only — never settlement input.
  assert.deepEqual(triaged, [
    { pidAlive: false, exitMarker: { exitCode: 0 }, progressObserved: true },
  ]);
  assert.equal(executor.launches.length, 0);
  const stages = executor.calls.map((call) => call.stage);
  assert.ok(stages.includes('checkout'));
  assert.ok(stages.includes('submodules'));
});

await test('resume with a nonzero exit marker settles the typed failure classified from the tail', async () => {
  const executor = detachedExecutor(() =>
    executionResult({
      output: probeOutput({
        state: 'exited',
        exitCode: 128,
        sizeBytes: 10,
        tail: "fatal: Authentication failed for 'https://gitee.com/acme/public.git'",
      }),
    }),
  );
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, {
      detachment: {
        park: true,
        resume: { triage: () => 'settle_from_exit' },
      },
    }),
  );
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'authentication',
    retryable: false,
  });
  assert.equal(executor.launches.length, 0);
});

await test('resume of a still-running job re-raises the parking signal without relaunching', async () => {
  const executor = detachedExecutor(() =>
    executionResult({
      output: probeOutput({ state: 'alive', sizeBytes: 500, mtime: 3 }),
    }),
  );
  const triaged = [];
  await assert.rejects(
    () =>
      mod.materializeSandboxGitWorkspaceStaged(
        detachedContext(executor, {
          detachment: {
            park: true,
            resume: {
              triage: (probe) => {
                triaged.push(probe);
                return 'keep_parked';
              },
            },
          },
        }),
      ),
    (error) => mod.isSandboxWorkspaceTransferDetachedSignal(error),
  );
  assert.equal(triaged[0]?.pidAlive, true);
  assert.equal(triaged[0]?.exitMarker, null);
  assert.equal(executor.launches.length, 0);
});

await test('blocking resume of a still-running job re-enters the poll loop without relaunching', async () => {
  const clock = manualDriver();
  const executor = detachedExecutor((index) =>
    executionResult({
      output:
        index <= 2
          ? probeOutput({ state: 'alive', sizeBytes: index * 100, mtime: index })
          : probeOutput({ state: 'exited', exitCode: 0, sizeBytes: 900 }),
    }),
  );
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, {
      detachment: { resume: { triage: () => 'keep_parked' } },
    }),
    { deadlineDriver: clock.driver },
  );
  await pump();
  for (let index = 0; index < 4; index += 1) await tick(clock, 1_000);
  const result = await operation;
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.equal(executor.launches.length, 0);
});

await test('resume with unprovable markers fails the attempt instead of re-running the transfer', async () => {
  for (const mode of ['unknown-output', 'probe-drop']) {
    const triaged = [];
    const executor = detachedExecutor(() =>
      mode === 'probe-drop'
        ? new Error('exec transport dropped')
        : executionResult({ output: probeOutput({ state: 'unknown' }) }),
    );
    const result = await mod.materializeSandboxGitWorkspaceStaged(
      detachedContext(executor, {
        detachment: {
          park: true,
          resume: {
            triage: (probe) => {
              triaged.push(probe);
              return probe.exitMarker
                ? 'settle_from_exit'
                : probe.pidAlive
                  ? 'keep_parked'
                  : 'fail_attempt';
            },
          },
        },
      }),
    );
    assert.deepEqual(
      result,
      {
        status: 'failed',
        stage: 'workspace_transfer',
        cause: 'unknown',
        retryable: false,
      },
      mode,
    );
    assert.equal(triaged[0]?.pidAlive, false, mode);
    assert.equal(triaged[0]?.exitMarker, null, mode);
    // Never a from-scratch relaunch on an unprovable resumed job.
    assert.equal(executor.launches.length, 0, mode);
  }
});

// --- Task 3.5: knob plumbing through the deployment-environment path ---

await test('transfer-liveness knobs validate with min/max bounds and read from env', () => {
  assert.deepEqual(mod.readConfiguredWorkspaceTransferLiveness({}), {});
  assert.deepEqual(
    mod.readConfiguredWorkspaceTransferLiveness({
      CAP_SANDBOX_TRANSFER_HEARTBEAT_WINDOW_MS: '120000',
      CAP_SANDBOX_TRANSFER_ABSOLUTE_CAP_MS: '7200000',
    }),
    { heartbeatWindowMs: 120_000, absoluteCapMs: 7_200_000 },
  );
  assert.throws(
    () =>
      mod.readConfiguredWorkspaceTransferLiveness({
        CAP_SANDBOX_TRANSFER_HEARTBEAT_WINDOW_MS: '500',
      }),
    /heartbeat window/,
  );
  assert.throws(
    () =>
      mod.readConfiguredWorkspaceTransferLiveness({
        CAP_SANDBOX_TRANSFER_ABSOLUTE_CAP_MS: 'not-a-number',
      }),
    /must be an integer/,
  );
  assert.throws(
    () =>
      mod.readConfiguredWorkspaceTransferLiveness({
        CAP_SANDBOX_TRANSFER_HEARTBEAT_WINDOW_MS: '600000',
        CAP_SANDBOX_TRANSFER_ABSOLUTE_CAP_MS: '60000',
      }),
    /must not be below/,
  );
});

await test('task provisioning policy carries the transfer-liveness knobs alongside gitCloneTimeoutMs', () => {
  const policy = mod.resolveConfiguredTaskProvisioningPolicy({}, {
    CAP_SANDBOX_PROVIDER: 'auto',
    AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
    CAP_SANDBOX_TRANSFER_HEARTBEAT_WINDOW_MS: '45000',
    CAP_SANDBOX_TRANSFER_ABSOLUTE_CAP_MS: '5400000',
  });
  assert.deepEqual(policy.workspaceTransferLiveness, {
    heartbeatWindowMs: 45_000,
    absoluteCapMs: 5_400_000,
  });

  const unset = mod.resolveConfiguredTaskProvisioningPolicy({}, {
    CAP_SANDBOX_PROVIDER: 'auto',
    AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
  });
  assert.equal(unset.workspaceTransferLiveness, undefined);
});

// --- fix-clone-retry-and-tui-classifier: detached transfer retry ---

await test('detached transfer retries a transient network failure and succeeds on the next attempt', async () => {
  const clock = manualDriver();
  const diagnostics = diagnosticsRecorder();
  const executor = detachedExecutor((index) => {
    if (index === 1) {
      // Attempt 1: the git-side low-speed abort — the live 2026-07-21
      // signature (throughput collapse kills the clone at ~62 s).
      return executionResult({
        output: probeOutput({
          state: 'exited',
          exitCode: 128,
          sizeBytes: 10,
          tail: 'fatal: early EOF\nerror: RPC failed; operation too slow. Less than 1024 bytes/sec',
        }),
      });
    }
    return executionResult({
      output: probeOutput({ state: 'exited', exitCode: 0, sizeBytes: 9_000 }),
    });
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, {
      plan: { deadlineMs: 900_000 },
      diagnostics: diagnostics.observer,
    }),
    { deadlineDriver: clock.driver },
  );
  await pump();
  // Attempt 1 probe → failure, 5 s retry backoff, attempt 2 launch + probe.
  for (let index = 0; index < 10; index += 1) await tick(clock, 2_000);
  const result = await operation;
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.equal(executor.launches.length, 2, 'transfer job launched twice');
  const transfer = diagnostics.events.filter(
    (event) => event.stage === 'workspace_transfer',
  );
  assert.deepEqual(
    transfer.map((event) => event.outcome),
    ['started', 'failed', 'started', 'succeeded'],
  );
  assert.equal(transfer[1].cause, 'tls_network_failed');
  assert.equal(transfer[1].retryable, true);
  assert.notEqual(
    transfer[2].operationId,
    transfer[0].operationId,
    'retry attempt carries its own operation identity',
  );
});

await test('detached transfer does not retry a deterministic authentication failure', async () => {
  const clock = manualDriver();
  const executor = detachedExecutor(() =>
    executionResult({
      output: probeOutput({
        state: 'exited',
        exitCode: 128,
        sizeBytes: 10,
        tail: "fatal: Authentication failed for 'https://gitee.com/acme/public.git'",
      }),
    }),
  );
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    detachedContext(executor, { plan: { deadlineMs: 900_000 } }),
    { deadlineDriver: clock.driver },
  );
  await pump();
  for (let index = 0; index < 4; index += 1) await tick(clock, 2_000);
  const result = await operation;
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'authentication',
    retryable: false,
  });
  assert.equal(executor.launches.length, 1, 'no retry for deterministic causes');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
