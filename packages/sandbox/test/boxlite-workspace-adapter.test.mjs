import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const REPOSITORY_URL = 'https://code.example.test/acme/private.git';
const SUBMODULE_HOST = 'submodules.example.test';
const CANARY = 'CAP_BOXLITE_ADAPTER_MATRIX_CANARY_d2f8';

let passed = 0;
let failed = 0;

async function test(name, run) {
  try {
    await run();
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function manualDeadlineDriver() {
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
      for (const item of [...scheduled]) {
        if (!item.cancelled && item.at <= now) {
          scheduled.delete(item);
          item.trigger();
        }
      }
    },
  };
}

function exactHostCredential() {
  return mod.createExactHostGitCredential(
    REPOSITORY_URL,
    `Authorization: Basic ${CANARY}`,
  );
}

function workspacePlan(overrides = {}) {
  return {
    repositoryUrl: REPOSITORY_URL,
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs: 60_000,
    ...overrides,
  };
}

function materializationContext(adapter, plan, overrides = {}) {
  return {
    taskId: 'task-boxlite-adapter-matrix',
    plan,
    workspaceDir: '/home/gem/workspace',
    stageExecutor: adapter.stageExecutor,
    secretFilePort: adapter.secretFilePort,
    ...overrides,
  };
}

function tarEntry(archive) {
  const copy = Buffer.from(archive);
  const name = copy.toString('utf8', 0, 100).replace(/\0.*$/u, '');
  const size = parseInt(copy.toString('ascii', 124, 136).replace(/\0.*$/u, ''), 8);
  return {
    name,
    mode: parseInt(copy.toString('ascii', 100, 108).replace(/\0.*$/u, ''), 8),
    content: copy.subarray(512, 512 + size).toString('utf8'),
  };
}

function createWorkspaceHarness(options = {}) {
  const calls = [];
  const uploads = [];
  const state = {
    absent: false,
    secretPath: null,
    secretContent: null,
    cleanupCount: 0,
  };
  const client = {
    async uploadArchive(request) {
      const entry = tarEntry(request.archive);
      const stagingSuffix = `/.${entry.name}.upload`;
      assert.ok(request.path.endsWith(stagingSuffix));
      const secretDirectory = request.path.slice(0, -stagingSuffix.length);
      state.secretPath = `${secretDirectory}/${entry.name}`;
      state.secretContent = entry.content;
      uploads.push({
        sandboxId: request.sandboxId,
        path: request.path,
        entry,
      });
      await options.onUpload?.(request, state);
    },
    async exec(request) {
      calls.push(request);
      if (request.command.includes('stat -c %a')) {
        return executionResult({
          exitCode: state.secretContent === null ? 1 : 0,
        });
      }
      if (
        state.secretPath !== null &&
        request.command.includes('rm -f --') &&
        request.command.includes(state.secretPath)
      ) {
        state.secretPath = null;
        state.secretContent = null;
        state.cleanupCount += 1;
        return executionResult();
      }
      return (
        (await options.onGitCommand?.(request, state)) ??
        executionResult()
      );
    },
    async deleteSandbox(sandboxId) {
      if (options.deleteSandbox) {
        await options.deleteSandbox(sandboxId, state);
        return;
      }
      state.absent = true;
      state.secretPath = null;
      state.secretContent = null;
    },
    async getSandbox(sandboxId) {
      if (options.getSandbox) return options.getSandbox(sandboxId, state);
      return state.absent ? null : { id: sandboxId, state: 'running' };
    },
  };
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client,
    sandboxId: options.sandboxId ?? 'box-adapter-matrix',
    createSecretId: options.createSecretId ?? (() => 'matrix'),
    deletionConfirmation: options.deletionConfirmation,
  });
  return { adapter, calls, client, state, uploads };
}

function gitCalls(calls) {
  return calls.filter((call) => call.command.startsWith('git'));
}

await test('clone can exceed the short control-plane timeout within its workspace deadline', async () => {
  const controlPlaneTimeoutMs = 30;
  const workspaceDeadlineMs = 500;
  const timing = manualDeadlineDriver();
  const transferStarted = deferred();
  const transferReleased = deferred();
  const harness = createWorkspaceHarness({
    async onGitCommand(request) {
      if (request.command.includes('clone --no-checkout')) {
        transferStarted.resolve(request);
        return transferReleased.promise;
      }
      return executionResult();
    },
  });
  let settled = false;
  const operation = mod
    .materializeSandboxGitWorkspaceStaged(
      materializationContext(
        harness.adapter,
        workspacePlan({ deadlineMs: workspaceDeadlineMs }),
      ),
      { deadlineDriver: timing.driver },
    )
    .finally(() => {
      settled = true;
    });

  const transferRequest = await transferStarted.promise;
  assert(transferRequest.timeoutMs > controlPlaneTimeoutMs);
  timing.advance(controlPlaneTimeoutMs + 1);
  await Promise.resolve();
  assert.equal(settled, false);
  transferReleased.resolve(executionResult());

  assert.deepEqual(await operation, {
    status: 'succeeded',
    stage: 'complete',
  });
  assert.equal(harness.state.absent, false);
});

await test('disk exhaustion after successful refs is a transfer capacity failure', async () => {
  let refsSucceeded = false;
  const credential = exactHostCredential();
  const harness = createWorkspaceHarness({
    async onGitCommand(request) {
      if (request.command.includes('ls-remote --exit-code')) {
        refsSucceeded = true;
        return executionResult();
      }
      if (request.command.includes('clone --no-checkout')) {
        assert.equal(refsSucceeded, true);
        return executionResult({
          exitCode: 1,
          stderr: 'fatal: No space left on device',
          output: 'fatal: No space left on device',
        });
      }
      return executionResult();
    },
  });

  const outcome = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext(
      harness.adapter,
      workspacePlan({ credential }),
    ),
  );
  assert.deepEqual(outcome, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'capacity_exhausted',
    retryable: false,
  });
  assert.equal(harness.state.absent, false);
  assert.equal(harness.state.secretContent, null);
  assert.equal(harness.state.cleanupCount, 1);
  assert.equal(
    gitCalls(harness.calls).some((call) => call.command.includes('checkout --force')),
    false,
  );
});

await test('missing master and main refs fail without an invented fallback', async () => {
  for (const branch of ['master', 'main']) {
    const harness = createWorkspaceHarness({
      async onGitCommand(request) {
        if (request.command.includes('ls-remote --exit-code')) {
          return executionResult({ exitCode: 2 });
        }
        return executionResult();
      },
    });
    const outcome = await mod.materializeSandboxGitWorkspaceStaged(
      materializationContext(
        harness.adapter,
        workspacePlan({ resolvedBranch: branch }),
      ),
    );
    assert.deepEqual(outcome, {
      status: 'failed',
      stage: 'remote_ref_resolution',
      cause: 'ref_not_found',
      retryable: false,
    });
    const commands = gitCalls(harness.calls).map((call) => call.command);
    assert.equal(commands.length, 1);
    assert.match(commands[0], new RegExp(`refs/heads/${branch}`, 'u'));
    assert.equal(
      commands[0].includes(branch === 'master' ? 'refs/heads/main' : 'refs/heads/master'),
      false,
    );
  }
});

await test('different-host submodules cannot receive the parent credential', async () => {
  const credential = exactHostCredential();
  const harness = createWorkspaceHarness({
    async onGitCommand(request) {
      if (request.command.includes('submodule update --init --recursive')) {
        return executionResult({
          exitCode: 1,
          stderr: `fatal: could not read Username for 'https://${SUBMODULE_HOST}'`,
        });
      }
      return executionResult();
    },
  });
  const outcome = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext(
      harness.adapter,
      workspacePlan({ credential }),
    ),
  );

  assert.deepEqual(outcome, {
    status: 'failed',
    stage: 'submodules',
    cause: 'authentication',
    retryable: false,
  });
  assert.equal(harness.uploads.length, 1);
  assert.equal(harness.uploads[0].entry.mode, 0o600);
  assert.match(
    harness.uploads[0].entry.content,
    /\[http "https:\/\/code\.example\.test\/"\]/u,
  );
  assert.doesNotMatch(
    harness.uploads[0].entry.content,
    new RegExp(SUBMODULE_HOST, 'u'),
  );
  assert.doesNotMatch(
    JSON.stringify(harness.calls),
    new RegExp(`${CANARY}|Authorization:`, 'u'),
  );
  assert.equal(harness.state.secretContent, null);
  assert.equal(harness.state.absent, false);
});

await test('retrying the same workspace plan is idempotent and cleans each credential', async () => {
  const credential = exactHostCredential();
  const plan = workspacePlan({ credential });
  let cloneAttempts = 0;
  const harness = createWorkspaceHarness({
    createSecretId: () => 'same-retry-path',
    async onGitCommand(request) {
      if (request.command.includes('clone --no-checkout')) {
        cloneAttempts += 1;
        if (cloneAttempts === 1) {
          return executionResult({
            exitCode: 1,
            stderr: 'fatal: connection reset by peer',
          });
        }
      }
      return executionResult();
    },
  });

  const first = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext(harness.adapter, plan),
  );
  const second = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext(harness.adapter, plan),
  );

  assert.deepEqual(first, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'tls_network',
    retryable: true,
  });
  assert.deepEqual(second, { status: 'succeeded', stage: 'complete' });
  assert.equal(cloneAttempts, 2);
  assert.equal(
    harness.calls.filter((call) => call.command.includes('clone --no-checkout')).length,
    2,
  );
  assert.equal(harness.uploads.length, 2);
  assert.equal(harness.state.cleanupCount, 2);
  assert.equal(harness.state.secretContent, null);
  assert.equal(harness.state.absent, false);
});

await test('cancellation settles without whole-sandbox fencing and leaves no retained credential', async () => {
  // detach-workspace-clone: a cancelled `workspace_transfer` exec is a
  // dropped control exec, never settlement evidence — BoxLite no longer
  // fences (deletes) the whole sandbox for it. The operation still settles
  // as cancelled at the transfer stage, and credential safety is proven
  // through the exec seam (cleanup + absence probe) instead of sandbox
  // deletion.
  const cancellation = new AbortController();
  const transferStarted = deferred();
  const lateTransfer = deferred();
  let deletionRequested = false;
  const harness = createWorkspaceHarness({
    async onGitCommand(request) {
      if (request.command.includes('clone --no-checkout')) {
        transferStarted.resolve();
        return lateTransfer.promise;
      }
      return executionResult();
    },
    async deleteSandbox(_sandboxId, state) {
      deletionRequested = true;
      state.absent = true;
      state.secretPath = null;
      state.secretContent = null;
    },
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    materializationContext(
      harness.adapter,
      workspacePlan({ credential: exactHostCredential() }),
      { cancellationSignal: cancellation.signal },
    ),
  );

  await transferStarted.promise;
  cancellation.abort();
  assert.deepEqual(await operation, {
    status: 'cancelled',
    stage: 'workspace_transfer',
  });
  assert.equal(deletionRequested, false);
  assert.equal(harness.adapter.wasSandboxFenced(), false);
  await harness.adapter.settleCredentialSafety();
  assert.equal(harness.state.secretContent, null);
  assert.equal(harness.state.absent, false);
  lateTransfer.reject(new Error('late cancelled transfer response'));
  await Promise.resolve();
});

await test('retained clone and push both prove idempotent secret absence', async () => {
  let deliveryMode = false;
  const harness = createWorkspaceHarness({
    async onGitCommand(request) {
      if (!deliveryMode) return executionResult();
      if (request.command.includes('git status --porcelain')) {
        return executionResult({ output: ' M changed.txt\n' });
      }
      if (request.command === 'git rev-parse HEAD') {
        return executionResult({ output: 'abc123\n' });
      }
      return executionResult();
    },
  });
  const credential = exactHostCredential();
  const cloned = await mod.materializeSandboxGitWorkspaceStaged(
    materializationContext(
      harness.adapter,
      workspacePlan({ credential }),
    ),
  );
  assert.deepEqual(cloned, { status: 'succeeded', stage: 'complete' });
  assert.equal(harness.state.absent, false);
  assert.equal(harness.state.secretContent, null);
  assert.equal(harness.state.cleanupCount, 1);

  deliveryMode = true;
  const delivered = await mod.deliverSandboxGitWorkspaceStaged({
    taskId: 'task-boxlite-adapter-matrix',
    plan: {
      branch: 'cap/task-boxlite-adapter-matrix',
      commitMessage: 'cap: adapter matrix',
      credential,
      deadlineMs: 60_000,
    },
    workspaceDir: '/home/gem/workspace',
    stageExecutor: harness.adapter.stageExecutor,
    secretFilePort: harness.adapter.secretFilePort,
  });
  assert.deepEqual(delivered, {
    hadChanges: true,
    commitSha: 'abc123',
    error: null,
  });
  assert.equal(harness.state.absent, false);
  assert.equal(harness.state.secretContent, null);
  assert.equal(harness.state.cleanupCount, 2);
  assert.equal(harness.uploads.length, 2);
  await harness.adapter.settleCredentialSafety();
  await harness.adapter.settleCredentialSafety();
  assert.equal(harness.state.cleanupCount, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
