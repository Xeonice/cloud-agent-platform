import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const REPOSITORY_URL = 'https://example.test/private.git';
const WORKSPACE_DIR = '/home/gem/workspace';
const DELIVERY_PENDING_SENTINEL = 'CAP_DELIVERY_PENDING';

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

function secretFilePort(options = {}) {
  const writes = [];
  const deletes = [];
  const handle = {
    kind: 'sandbox-secret-file',
    path: '/run/cap-secrets/git.config',
    mode: options.mode ?? 0o600,
    toString: () => '[SandboxSecretFile REDACTED]',
    toJSON: () => ({ kind: 'sandbox-secret-file', path: '[REDACTED]' }),
  };
  return {
    writes,
    deletes,
    port: {
      async writeSecretFile(request) {
        writes.push(request);
        await options.onWrite?.(request);
        if (options.writeError !== undefined) throw options.writeError;
        return handle;
      },
      async deleteSecretFile(value) {
        deletes.push(value);
        await options.onDelete?.(value);
        if (options.deleteError !== undefined) throw options.deleteError;
      },
    },
  };
}

function materializationContext(overrides = {}) {
  const { plan, ...rest } = overrides;
  return {
    taskId: 'task-workspace-git-coverage',
    plan: {
      repositoryUrl: REPOSITORY_URL,
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 60_000,
      credential: mod.createExactHostGitCredential(
        REPOSITORY_URL,
        'Authorization: Basic COVERAGE_SECRET',
      ),
      ...(plan ?? {}),
    },
    workspaceDir: WORKSPACE_DIR,
    ...rest,
  };
}

function deliveryContext(overrides = {}) {
  const { plan, ...rest } = overrides;
  return {
    taskId: 'task-delivery-coverage',
    plan: {
      branch: 'cap/task-delivery-coverage',
      commitMessage: 'cap: delivery coverage',
      credential: mod.createExactHostGitCredential(
        REPOSITORY_URL,
        'Authorization: Basic COVERAGE_SECRET',
      ),
      deadlineMs: 60_000,
      ...(plan ?? {}),
    },
    workspaceDir: WORKSPACE_DIR,
    secretFilePort: secretFilePort().port,
    stageExecutor: { execute: async () => executionResult() },
    ...rest,
  };
}

function detachedMaterializationContext(stageExecutor, overrides = {}) {
  const { detachedTransfer, plan, ...rest } = overrides;
  return materializationContext({
    plan: { credential: undefined, ...(plan ?? {}) },
    stageExecutor,
    detachedTransfer: { ...(detachedTransfer ?? {}) },
    ...rest,
  });
}

function scriptedDeadlineDriver(values) {
  let index = 0;
  return {
    now() {
      const value = values[Math.min(index, values.length - 1)];
      index += 1;
      return value;
    },
    schedule() {
      return () => {};
    },
  };
}

function manualDeadlineDriver() {
  let now = 0;
  const scheduled = new Set();
  return {
    driver: {
      now: () => now,
      schedule(delayMs, trigger) {
        const item = { at: now + delayMs, delayMs, trigger, cancelled: false };
        scheduled.add(item);
        return () => {
          item.cancelled = true;
          scheduled.delete(item);
        };
      },
    },
    hasDelay(delayMs) {
      return [...scheduled].some(
        (item) => !item.cancelled && item.delayMs === delayMs,
      );
    },
    advance(ms) {
      now += ms;
      for (const item of [...scheduled].sort((left, right) => left.at - right.at)) {
        if (item.cancelled || item.at > now) continue;
        item.cancelled = true;
        scheduled.delete(item);
        item.trigger();
      }
    },
  };
}

async function waitFor(predicate, message) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function archiveSource(storePath = '/var/lib/cap/repo-store/repo.git') {
  return {
    kind: 'archive',
    repoId: 'repo',
    storePath,
    gitSource: REPOSITORY_URL,
  };
}

await test('credential setup rejects a missing writer and a non-private handle', async () => {
  const withoutPort = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      stageExecutor: {
        async execute() {
          assert.fail('no workspace command may run without credential setup');
        },
      },
    }),
  );
  assert.deepEqual(withoutPort, {
    status: 'failed',
    stage: 'credential_setup',
    cause: 'unknown',
    retryable: false,
  });

  const insecure = secretFilePort({ mode: 0o644 });
  const wrongMode = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      secretFilePort: insecure.port,
      stageExecutor: {
        async execute() {
          assert.fail('no workspace command may run with a non-private handle');
        },
      },
    }),
  );
  assert.deepEqual(wrongMode, {
    status: 'failed',
    stage: 'credential_setup',
    cause: 'unknown',
    retryable: false,
  });
  assert.equal(insecure.deletes.length, 1);
});

await test('materialization classifies thrown and missing executor results', async () => {
  for (const [name, execute] of [
    ['throw', async () => { throw new Error('opaque transport failure'); }],
    ['missing', async () => null],
  ]) {
    const secrets = secretFilePort();
    const result = await mod.materializeSandboxGitWorkspaceStaged(
      materializationContext({
        secretFilePort: secrets.port,
        stageExecutor: { execute },
      }),
    );
    assert.deepEqual(result, {
      status: 'failed',
      stage: 'remote_ref_resolution',
      cause: 'unknown',
      retryable: false,
    }, name);
    assert.equal(secrets.deletes.length, 1, name);
  }
});

await test('cancellation between credential setup and the first command settles the exact stage', async () => {
  const abort = new AbortController();
  const secrets = secretFilePort();
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      cancellationSignal: abort.signal,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute() {
          assert.fail('cancelled materialization must not start a command');
        },
      },
      onProgress(event) {
        if (
          event.stage === 'credential_setup' &&
          event.status === 'succeeded'
        ) {
          abort.abort();
        }
      },
    }),
  );
  assert.deepEqual(result, {
    status: 'cancelled',
    stage: 'remote_ref_resolution',
  });
});

await test('archive action observes cancellation before and after host transfer', async () => {
  const beforeAbort = new AbortController();
  const before = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      source: archiveSource(),
      cancellationSignal: beforeAbort.signal,
      stageExecutor: {
        async execute() {
          assert.fail('pre-cancelled archive action must not prepare staging');
        },
      },
      archiveTransfer: {
        async uploadArchive() {
          assert.fail('pre-cancelled archive action must not upload');
        },
      },
      onProgress(event) {
        if (
          event.stage === 'credential_setup' &&
          event.status === 'succeeded'
        ) {
          beforeAbort.abort();
        }
      },
    }),
  );
  assert.deepEqual(before, {
    status: 'cancelled',
    stage: 'workspace_transfer',
  });

  const afterAbort = new AbortController();
  const after = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      source: archiveSource(),
      cancellationSignal: afterAbort.signal,
      stageExecutor: { execute: async () => executionResult() },
      archiveTransfer: {
        async uploadArchive() {
          afterAbort.abort();
        },
      },
    }),
  );
  assert.deepEqual(after, {
    status: 'cancelled',
    stage: 'workspace_transfer',
  });
});

await test('archive preparation failure remains a workspace-transfer failure', async () => {
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      source: archiveSource(),
      stageExecutor: {
        async execute(execution) {
          return execution.stage === 'workspace_transfer'
            ? executionResult({ exitCode: 1 })
            : executionResult();
        },
      },
      archiveTransfer: {
        async uploadArchive() {
          assert.fail('failed staging must prevent archive upload');
        },
      },
    }),
  );
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'unknown',
    retryable: false,
  });
});

await test('archive byte progress throttles updates and computes later throughput', async () => {
  const progress = [];
  const realDateNow = Date.now;
  let now = 1_000;
  try {
    Date.now = () => now;
    const result = await mod.materializeSandboxGitWorkspaceStaged(
      materializationContext({
        source: archiveSource('/definitely/missing/repo.git'),
        stageExecutor: { execute: async () => executionResult() },
        archiveTransfer: {
          async uploadArchive(request) {
            request.onBytesUploaded?.(100);
            now = 1_200;
            request.onBytesUploaded?.(150);
            now = 2_000;
            request.onBytesUploaded?.(300);
          },
        },
        onProgress(event) {
          if (event.status === 'progress') progress.push(event.progress);
        },
      }),
    );
    assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(progress.length, 2);
  assert.equal(progress[0].throughputBytesPerSecond, null);
  assert.equal(progress[1].receivedBytes, 300);
  assert.equal(progress[1].throughputBytesPerSecond, 200);
});

await test('archive source rejects a store path without a copy directory name', async () => {
  await assert.rejects(
    () =>
      mod.materializeSandboxGitWorkspaceStaged(
        materializationContext({
          source: archiveSource('/'),
          stageExecutor: { execute: async () => executionResult() },
          archiveTransfer: { uploadArchive: async () => undefined },
        }),
      ),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );
});

await test('progress parser fails closed for invalid numeric evidence', async () => {
  assert.deepEqual(
    mod.parseGitTransferProgress('Receiving objects: 150% (3/2)\r'),
    {
      percent: null,
      receivedObjects: null,
      totalObjects: null,
      receivedBytes: null,
      throughputBytesPerSecond: null,
    },
  );
  assert.deepEqual(
    mod.parseGitTransferProgress(
      'Receiving objects: 20% (2/10), . MiB | . MiB/s\r',
    ),
    {
      percent: 20,
      receivedObjects: 2,
      totalObjects: 10,
      receivedBytes: null,
      throughputBytesPerSecond: null,
    },
  );
});

await test('retry stops when backoff consumes the minimum remaining budget', async () => {
  const clock = manualDeadlineDriver();
  const secrets = secretFilePort();
  let transferAttempts = 0;
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      plan: { deadlineMs: 66_000 },
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          if (execution.stage === 'workspace_transfer') {
            transferAttempts += 1;
            return executionResult({
              exitCode: 128,
              stderr: 'fatal: connection reset by peer',
            });
          }
          return executionResult();
        },
      },
    }),
    { deadlineDriver: clock.driver },
  );
  await waitFor(
    () => clock.hasDelay(5_000),
    'transfer retry backoff was not scheduled',
  );
  clock.advance(6_000);
  assert.deepEqual(await operation, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'tls_network',
    retryable: true,
  });
  assert.equal(transferAttempts, 1);
});

await test('progress and diagnostic observer faults never replace materialization truth', async () => {
  const secrets = secretFilePort();
  let boundaries = 0;
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      secretFilePort: secrets.port,
      stageExecutor: { execute: async () => executionResult() },
      beforeBoundary: async () => {
        boundaries += 1;
      },
      onProgress() {
        throw new Error('progress observer unavailable');
      },
      diagnostics: {
        mode: 'non-persisting',
        createOperationId() {
          throw new Error('diagnostic identity unavailable');
        },
        async emit() {
          assert.fail('emit must not run without an operation identity');
        },
        async flush() {},
      },
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.equal(boundaries, 10);
});

await test('string errors and root workspaces use the public safe fallback paths', async () => {
  assert.deepEqual(
    mod.classifySandboxGitFailure({
      stage: 'workspace_transfer',
      error: 'failed to connect to provider',
    }),
    { cause: 'tls_network', retryable: true },
  );

  const publicPlan = {
    repositoryUrl: REPOSITORY_URL,
    callerBranch: null,
    resolvedBranch: 'main',
    deadlineMs: 60_000,
  };
  const calls = [];
  const secrets = secretFilePort();
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      plan: publicPlan,
      workspaceDir: '/workspace',
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          calls.push(execution.request.command);
          return executionResult();
        },
      },
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert(calls.some((command) => command.includes("mkdir -p -- '/'")));
});

await test('delivery exposes status, clean, commit, and sha outcomes without credentials', async () => {
  const cases = [
    {
      name: 'status failure',
      execute: async () =>
        executionResult({ exitCode: 1, stderr: 'SSL certificate problem' }),
      expected: {
        hadChanges: false,
        commitSha: null,
        error: 'workspace_git_tls_network',
      },
    },
    {
      name: 'clean worktree',
      execute: async () => executionResult(),
      expected: { hadChanges: false, commitSha: null, error: null },
    },
    {
      name: 'commit failure',
      execute: async (execution) =>
        execution.stage === 'delivery_status'
          ? executionResult({ output: ' M changed.txt\n' })
          : executionResult({
              exitCode: 1,
              stderr: 'fatal: No space left on device',
            }),
      expected: {
        hadChanges: true,
        commitSha: null,
        error: 'workspace_git_capacity_exhausted',
      },
    },
    {
      name: 'sha failure after pending commit',
      execute: async (execution) =>
        execution.stage === 'delivery_status'
          ? executionResult({ output: `${DELIVERY_PENDING_SENTINEL}\n` })
          : executionResult({ exitCode: 1, stderr: 'opaque revision failure' }),
      expected: {
        hadChanges: true,
        commitSha: null,
        error: 'workspace_git_unknown',
      },
    },
  ];

  for (const scenario of cases) {
    let credentialWrites = 0;
    const result = await mod.deliverSandboxGitWorkspaceStaged(
      deliveryContext({
        secretFilePort: {
          async writeSecretFile() {
            credentialWrites += 1;
            assert.fail(`${scenario.name} must not write a credential`);
          },
          async deleteSecretFile() {},
        },
        stageExecutor: { execute: scenario.execute },
      }),
    );
    assert.deepEqual(result, scenario.expected, scenario.name);
    assert.equal(credentialWrites, 0, scenario.name);
  }
});

await test('delivery classifies unsafe and failed credential setup exactly', async () => {
  for (const [name, secrets, expectedError] of [
    [
      'unsafe handle',
      secretFilePort({ mode: 0o644 }),
      'workspace_git_credential_setup_unknown',
    ],
    [
      'write failure',
      secretFilePort({ writeError: new Error('provider write failed') }),
      'workspace_git_credential_setup_unknown',
    ],
  ]) {
    const result = await mod.deliverSandboxGitWorkspaceStaged(
      deliveryContext({
        secretFilePort: secrets.port,
        stageExecutor: {
          async execute(execution) {
            if (execution.stage === 'delivery_status') {
              return executionResult({
                output: `${DELIVERY_PENDING_SENTINEL}\n`,
              });
            }
            if (execution.request.command === 'git rev-parse HEAD') {
              return executionResult({ output: '   \n' });
            }
            assert.fail(`${name} must stop before push`);
          },
        },
      }),
    );
    assert.deepEqual(
      result,
      {
        hadChanges: true,
        commitSha: null,
        error: expectedError,
      },
      name,
    );
  }
});

await test('delivery credential setup preserves cancellation and timeout truth', async () => {
  for (const source of ['during-write-cancellation', 'after-write-cancellation']) {
    const controller = new AbortController();
    const secrets = secretFilePort({
      onWrite() {
        controller.abort();
      },
      ...(source === 'during-write-cancellation'
        ? { writeError: new Error('provider stopped write') }
        : {}),
    });
    const result = await mod.deliverSandboxGitWorkspaceStaged(
      deliveryContext({
        plan: { cancellationSignal: controller.signal },
        secretFilePort: secrets.port,
        stageExecutor: {
          async execute(execution) {
            if (execution.stage === 'delivery_status') {
              return executionResult({ output: `${DELIVERY_PENDING_SENTINEL}\n` });
            }
            if (execution.request.command === 'git rev-parse HEAD') {
              return executionResult({ output: 'cancel-sha\n' });
            }
            assert.fail(`${source} must stop before push`);
          },
        },
      }),
    );
    assert.deepEqual(result, {
      hadChanges: true,
      commitSha: 'cancel-sha',
      error: 'workspace_git_cancelled',
    });
  }

  const clock = manualDeadlineDriver();
  const timedOutSecrets = secretFilePort({
    onWrite() {
      clock.advance(60_000);
    },
    writeError: new Error('provider write timed out'),
  });
  const timedOut = await mod.deliverSandboxGitWorkspaceStaged(
    deliveryContext({
      secretFilePort: timedOutSecrets.port,
      stageExecutor: {
        async execute(execution) {
          if (execution.stage === 'delivery_status') {
            return executionResult({ output: `${DELIVERY_PENDING_SENTINEL}\n` });
          }
          return executionResult({ output: 'timeout-sha\n' });
        },
      },
    }),
    { deadlineDriver: clock.driver },
  );
  assert.deepEqual(timedOut, {
    hadChanges: true,
    commitSha: 'timeout-sha',
    error: 'workspace_git_timeout',
  });
});

await test('delivery cleanup and finalize failures preserve the pushed commit', async () => {
  for (const scenario of ['delete-failure', 'delete-cancellation', 'finalize-failure']) {
    const controller = new AbortController();
    const secrets = secretFilePort({
      ...(scenario === 'delete-failure'
        ? { deleteError: new Error('provider delete failed') }
        : {}),
      ...(scenario === 'delete-cancellation'
        ? {
            onDelete() {
              controller.abort();
            },
            deleteError: new Error('provider delete cancelled'),
          }
        : {}),
    });
    const result = await mod.deliverSandboxGitWorkspaceStaged(
      deliveryContext({
        plan: { cancellationSignal: controller.signal },
        secretFilePort: secrets.port,
        stageExecutor: {
          async execute(execution) {
            if (execution.stage === 'delivery_status') {
              return executionResult({ output: `${DELIVERY_PENDING_SENTINEL}\n` });
            }
            if (execution.request.command === 'git rev-parse HEAD') {
              return executionResult({ output: 'pushed-sha extra\n' });
            }
            if (
              scenario === 'finalize-failure' &&
              execution.request.command.includes('rm -f --')
            ) {
              return executionResult({
                exitCode: 1,
                stderr: 'fatal: No space left on device',
              });
            }
            return executionResult();
          },
        },
      }),
    );
    const expectedError =
      scenario === 'delete-failure'
        ? 'workspace_git_credential_cleanup_unknown'
        : scenario === 'delete-cancellation'
          ? 'workspace_git_cancelled'
          : 'workspace_git_capacity_exhausted';
    assert.deepEqual(
      result,
      { hadChanges: true, commitSha: 'pushed-sha', error: expectedError },
      scenario,
    );
  }
});

await test('delivery command boundaries preserve pre, post, thrown, and expired interruptions', async () => {
  const preCancelled = new AbortController();
  preCancelled.abort();
  const immediateDriver = {
    now: () => 0,
    schedule(_delayMs, trigger) {
      trigger();
      return () => {};
    },
  };
  const before = await mod.deliverSandboxGitWorkspaceStaged(
    deliveryContext({
      plan: { cancellationSignal: preCancelled.signal },
      stageExecutor: {
        async execute() {
          assert.fail('pre-cancelled delivery must not execute');
        },
      },
    }),
    { deadlineDriver: immediateDriver },
  );
  assert.deepEqual(before, {
    hadChanges: false,
    commitSha: null,
    error: 'workspace_git_cancelled',
  });

  for (const mode of ['return-after-cancel', 'throw-after-cancel', 'throw']) {
    const controller = new AbortController();
    const result = await mod.deliverSandboxGitWorkspaceStaged(
      deliveryContext({
        plan: { cancellationSignal: controller.signal },
        stageExecutor: {
          async execute() {
            if (mode !== 'throw') controller.abort();
            if (mode !== 'return-after-cancel') {
              throw new Error(
                mode === 'throw' ? 'SSL connection reset' : 'cancelled exec',
              );
            }
            return executionResult();
          },
        },
      }),
    );
    assert.deepEqual(
      result,
      {
        hadChanges: false,
        commitSha: null,
        error:
          mode === 'throw'
            ? 'workspace_git_tls_network'
            : 'workspace_git_cancelled',
      },
      mode,
    );
  }

  const thrownTimeoutClock = manualDeadlineDriver();
  const thrownTimeout = await mod.deliverSandboxGitWorkspaceStaged(
    deliveryContext({
      stageExecutor: {
        async execute() {
          thrownTimeoutClock.advance(60_000);
          throw new Error('executor timed out');
        },
      },
    }),
    { deadlineDriver: thrownTimeoutClock.driver },
  );
  assert.deepEqual(thrownTimeout, {
    hadChanges: false,
    commitSha: null,
    error: 'workspace_git_timeout',
  });

  const naturallyExpired = await mod.deliverSandboxGitWorkspaceStaged(
    deliveryContext({ plan: { deadlineMs: 50 } }),
    { deadlineDriver: scriptedDeadlineDriver([0, 100]) },
  );
  assert.equal(naturallyExpired.error, 'workspace_git_timeout');

  const expiredInsideExecute = await mod.deliverSandboxGitWorkspaceStaged(
    deliveryContext({
      plan: { deadlineMs: 50 },
      stageExecutor: {
        async execute() {
          assert.fail('an exhausted execution budget must not reach the executor');
        },
      },
    }),
    { deadlineDriver: scriptedDeadlineDriver([0, 0, 100]) },
  );
  assert.equal(expiredInsideExecute.error, 'workspace_git_timeout');
});

await test('materialization preserves cancellation raised by a throwing stage executor', async () => {
  const controller = new AbortController();
  const secrets = secretFilePort();
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      cancellationSignal: controller.signal,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute() {
          controller.abort();
          throw new Error('transport closed while cancelling');
        },
      },
    }),
  );
  assert.deepEqual(result, {
    status: 'cancelled',
    stage: 'remote_ref_resolution',
  });
});

await test('materialization retries an unknown thrown transfer while budget remains', async () => {
  const clock = manualDeadlineDriver();
  const secrets = secretFilePort();
  let transferAttempts = 0;
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      plan: { deadlineMs: 70_000 },
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          if (execution.stage === 'workspace_transfer') {
            transferAttempts += 1;
            if (transferAttempts === 1) {
              throw new Error('opaque provider transport failure');
            }
          }
          return executionResult();
        },
      },
    }),
    { deadlineDriver: clock.driver },
  );
  await waitFor(
    () => clock.hasDelay(5_000),
    'unknown transfer failure did not schedule its public retry backoff',
  );
  clock.advance(5_000);
  assert.deepEqual(await operation, { status: 'succeeded', stage: 'complete' });
  assert.equal(transferAttempts, 2);
});

await test('materialization settles a deadline that expires between stage checks', async () => {
  const secrets = secretFilePort();
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext({
      plan: { deadlineMs: 50 },
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute() {
          throw new Error('stage transport failed at the deadline boundary');
        },
      },
    }),
    { deadlineDriver: scriptedDeadlineDriver([0, 0, 0, 0, 0, 100]) },
  );
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'remote_ref_resolution',
    cause: 'timeout',
    retryable: true,
  });
});

await test('detached transfer observes cancellation before launch and keeps pause-resume safe', async () => {
  const controller = new AbortController();
  let transferCommands = 0;
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    detachedMaterializationContext(
      {
        async execute(execution) {
          if (execution.stage === 'workspace_transfer') transferCommands += 1;
          return executionResult();
        },
      },
      {
        cancellationSignal: controller.signal,
        onProgress(event) {
          if (
            event.status === 'succeeded' &&
            event.stage === 'remote_ref_resolution'
          ) {
            controller.abort();
          }
        },
      },
    ),
  );
  assert.deepEqual(result, {
    status: 'cancelled',
    stage: 'workspace_transfer',
  });
  assert.equal(transferCommands, 0);
});

await test('detached launch faults distinguish provider failure from cancellation', async () => {
  for (const mode of [
    'throw',
    'throw-after-cancel',
    'result-after-cancel',
    'success-after-cancel',
  ]) {
    const controller = new AbortController();
    let kills = 0;
    const result = await mod.materializeSandboxGitWorkspaceStaged(
      detachedMaterializationContext(
        {
          async execute(execution) {
            if (execution.stage !== 'workspace_transfer') {
              return executionResult();
            }
            const command = execution.request.command;
            if (command.includes('kill -TERM')) {
              kills += 1;
              return executionResult();
            }
            if (command.includes('setsid')) {
              if (mode !== 'throw') controller.abort();
              if (mode.startsWith('throw')) {
                if (mode === 'throw-after-cancel') controller.abort();
                throw new Error('SSL connection reset during launch');
              }
              return executionResult({
                exitCode: mode === 'result-after-cancel' ? 1 : 0,
              });
            }
            assert.fail(`${mode} must not poll after its launch outcome`);
          },
        },
        { cancellationSignal: controller.signal },
      ),
    );
    if (mode === 'throw') {
      assert.deepEqual(result, {
        status: 'failed',
        stage: 'workspace_transfer',
        cause: 'tls_network',
        retryable: true,
      });
      assert.equal(kills, 0);
    } else {
      assert.deepEqual(
        result,
        { status: 'cancelled', stage: 'workspace_transfer' },
        mode,
      );
      assert.equal(kills, 1, mode);
    }
  }
});

await test('parked detached job exposes failed probes and best-effort kill', async () => {
  let signal;
  let probeCalls = 0;
  let killCalls = 0;
  const stageExecutor = {
    async execute(execution) {
      if (execution.stage !== 'workspace_transfer') return executionResult();
      const command = execution.request.command;
      if (command.includes('setsid')) return executionResult();
      if (command.includes('kill -TERM')) {
        killCalls += 1;
        throw new Error('kill transport unavailable');
      }
      if (command.includes('CAP_TRANSFER_PROGRESS_TAIL')) {
        probeCalls += 1;
        return executionResult(
          probeCalls === 1 ? { exitCode: 1 } : { timedOut: true },
        );
      }
      return executionResult();
    },
  };
  try {
    await mod.materializeSandboxGitWorkspaceStaged(
      detachedMaterializationContext(stageExecutor, {
        detachedTransfer: { markerRoot: '/tmp/cap-transfer-markers' },
        detachment: { park: true },
      }),
    );
    assert.fail('parking must hand back a detached job');
  } catch (error) {
    signal = error;
  }
  assert.equal(mod.isSandboxWorkspaceTransferDetachedSignal(signal), true);
  await assert.rejects(() => signal.job.probe(), /did not complete/u);
  await assert.rejects(() => signal.job.probe(), /did not complete/u);
  await signal.job.kill();
  assert.equal(probeCalls, 2);
  assert.equal(killCalls, 1);
});

await test('detached resume fails closed when exit settlement lacks a marker', async () => {
  let launches = 0;
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    detachedMaterializationContext(
      {
        async execute(execution) {
          if (execution.stage !== 'workspace_transfer') return executionResult();
          if (execution.request.command.includes('setsid')) launches += 1;
          return executionResult({ output: 'unknown\n' });
        },
      },
      {
        detachment: {
          resume: { triage: () => 'settle_from_exit' },
        },
      },
    ),
  );
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'unknown',
    retryable: false,
  });
  assert.equal(launches, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
