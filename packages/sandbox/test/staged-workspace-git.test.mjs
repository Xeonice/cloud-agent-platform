import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const CANARY = 'CAP_STAGE_SECRET_CANARY_7f1b9d';
const REPOSITORY_URL = 'https://gitee.com/acme/private.git';
const DELIVERY_PENDING_SENTINEL = 'CAP_DELIVERY_PENDING';

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

function privateSecretPort(options = {}) {
  const events = options.events ?? [];
  const writes = [];
  const deletes = [];
  const port = mod.createSandboxSecretFilePort({
    directory: '/run/cap-secrets',
    createId: () => 'fixture',
    transport: {
      async writeFile(request) {
        events.push('credential-written');
        writes.push({
          path: request.path,
          mode: request.mode,
          content: Buffer.from(request.content).toString('utf8'),
        });
      },
      async deleteFile(request) {
        events.push('credential-cleaned');
        deletes.push(request.path);
        if (options.deleteFails) throw new Error('provider delete failed');
      },
    },
  });
  return { port, events, writes, deletes };
}

function workspaceContext(overrides = {}) {
  return {
    taskId: 'task-stage-fixture',
    plan: {
      repositoryUrl: REPOSITORY_URL,
      callerBranch: null,
      resolvedBranch: 'master',
      deadlineMs: 60_000,
      credential: mod.createExactHostGitCredential(
        REPOSITORY_URL,
        `Authorization: Basic ${CANARY}`,
      ),
    },
    workspaceDir: '/home/gem/workspace',
    ...overrides,
  };
}

{
  const secrets = privateSecretPort();
  const calls = [];
  const progress = [];
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          calls.push(execution);
          return executionResult();
        },
      },
      onProgress: (event) => progress.push(event),
    }),
  );

  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.deepEqual(
    calls.map((call) => call.stage),
    [
      'remote_ref_resolution',
      'workspace_transfer',
      'checkout',
      'submodules',
    ],
  );
  assert.match(calls[0].request.command, /ls-remote --exit-code --heads/u);
  assert.match(calls[1].request.command, /--no-checkout --single-branch/u);
  assert.match(calls[1].request.command, /--branch 'master'/u);
  assert.doesNotMatch(calls[1].request.command, /--depth/u);
  assert.match(calls[2].request.command, /refs\/remotes\/origin\/master/u);
  assert.match(calls[3].request.command, /submodule update --init --recursive/u);
  for (const call of calls) {
    assert.match(
      call.request.command,
      /-c 'include\.path=\/run\/cap-secrets\/cap-git-credential-fixture\.config'/u,
    );
    assert.equal(call.request.signal, call.signal);
    assert.equal(call.request.timeoutMs, call.remainingTimeoutMs);
    assert.doesNotMatch(call.request.command, new RegExp(CANARY, 'u'));
    assert.doesNotMatch(call.request.command, /Authorization:/u);
  }
  assert.equal(secrets.writes[0].mode, 0o600);
  assert.match(secrets.writes[0].content, /\[credential\]/u);
  assert.match(secrets.writes[0].content, /interactive = never/u);
  assert.match(secrets.writes[0].content, /followRedirects = false/u);
  assert.match(secrets.writes[0].content, /\[http "https:\/\/gitee\.com\/"\]/u);
  assert.doesNotMatch(secrets.writes[0].content, /gitlab\.com/u);
  assert.equal(secrets.deletes.length, 1);
  assert.doesNotMatch(JSON.stringify({ result, progress, calls }), new RegExp(CANARY, 'u'));
  assert.ok(
    progress.findIndex(
      (event) =>
        event.stage === 'credential_cleanup' && event.status === 'succeeded',
    ) <
      progress.findIndex(
        (event) => event.stage === 'complete' && event.status === 'succeeded',
      ),
  );
}

{
  const progress = [];
  const publicPlan = { ...workspaceContext().plan };
  delete publicPlan.credential;
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      plan: publicPlan,
      stageExecutor: { execute: async () => executionResult() },
      onProgress: (event) => progress.push(event),
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.deepEqual(progress.slice(-3), [
    { status: 'started', stage: 'credential_cleanup' },
    { status: 'succeeded', stage: 'credential_cleanup' },
    { status: 'succeeded', stage: 'complete' },
  ]);
}

{
  const secrets = privateSecretPort();
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          return execution.stage === 'workspace_transfer'
            ? executionResult({
                exitCode: 1,
                stderr: `fatal: No space left on device ${CANARY}`,
              })
            : executionResult();
        },
      },
    }),
  );
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'capacity_exhausted',
    retryable: false,
  });
  assert.equal(secrets.deletes.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CANARY, 'u'));
}

{
  const secrets = privateSecretPort({ deleteFails: true });
  const progress = [];
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      secretFilePort: secrets.port,
      stageExecutor: { execute: async () => executionResult() },
      onProgress: (event) => progress.push(event),
    }),
  );
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'credential_cleanup',
    cause: 'unknown',
    retryable: false,
  });
  assert.equal(progress.some((event) => event.stage === 'complete'), false);
}

{
  const events = [];
  const secrets = privateSecretPort({ events });
  const transferStarted = deferred();
  const transferSettled = deferred();
  const abort = new AbortController();
  let helperSettled = false;
  const operation = mod
    .materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        secretFilePort: secrets.port,
        cancellationSignal: abort.signal,
        stageExecutor: {
          async execute(execution) {
            if (execution.stage !== 'workspace_transfer') {
              return executionResult();
            }
            events.push('runner-started');
            transferStarted.resolve();
            const result = await transferSettled.promise;
            events.push('runner-stopped');
            return result;
          },
        },
      }),
    )
    .finally(() => {
      helperSettled = true;
    });
  await transferStarted.promise;
  abort.abort();
  await Promise.resolve();
  assert.equal(helperSettled, false);
  assert.equal(secrets.deletes.length, 0);
  transferSettled.resolve(executionResult({ timedOut: true, exitCode: 124 }));
  const result = await operation;
  assert.deepEqual(result, {
    status: 'cancelled',
    stage: 'workspace_transfer',
  });
  assert.deepEqual(events.slice(-2), ['runner-stopped', 'credential-cleaned']);
}

{
  const timing = manualDeadlineDriver();
  const events = [];
  const secrets = privateSecretPort({ events });
  const transferStarted = deferred();
  const transferSettled = deferred();
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      plan: { ...workspaceContext().plan, deadlineMs: 500 },
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          if (execution.stage !== 'workspace_transfer') {
            return executionResult();
          }
          transferStarted.resolve();
          const result = await transferSettled.promise;
          events.push('runner-stopped');
          return result;
        },
      },
    }),
    { deadlineDriver: timing.driver },
  );
  await transferStarted.promise;
  timing.advance(500);
  assert.equal(secrets.deletes.length, 0);
  transferSettled.resolve(executionResult({ timedOut: true, exitCode: 124 }));
  const result = await operation;
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'timeout',
    retryable: true,
  });
  assert.deepEqual(events.slice(-2), ['runner-stopped', 'credential-cleaned']);
}

{
  const timing = manualDeadlineDriver();
  const uploadStarted = deferred();
  const lateUpload = deferred();
  const deleteStarted = deferred();
  const absenceConfirmed = deferred();
  let fenceStarted = false;
  let execCount = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    sandboxId: 'box-credential-deadline',
    createSecretId: () => 'credential-deadline',
    deletionConfirmation: { attempts: 1 },
    client: {
      async uploadArchive() {
        uploadStarted.resolve();
        return lateUpload.promise;
      },
      async exec() {
        execCount += 1;
        if (execCount === 1) {
          return executionResult();
        }
        assert.fail('mode verification must not start after upload deadline');
      },
      async deleteSandbox() {
        fenceStarted = true;
        deleteStarted.resolve();
      },
      async getSandbox() {
        return fenceStarted
          ? absenceConfirmed.promise
          : { id: 'box-credential-deadline', state: 'running' };
      },
    },
  });
  let settled = false;
  const operation = mod
    .materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        plan: { ...workspaceContext().plan, deadlineMs: 250 },
        secretFilePort: adapter.secretFilePort,
        stageExecutor: adapter.stageExecutor,
      }),
      { deadlineDriver: timing.driver },
    )
    .finally(() => {
      settled = true;
    });

  await uploadStarted.promise;
  timing.advance(250);
  await deleteStarted.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  absenceConfirmed.resolve(null);
  assert.deepEqual(await operation, {
    status: 'failed',
    stage: 'credential_setup',
    cause: 'timeout',
    retryable: true,
  });
  assert.equal(adapter.wasSandboxFenced(), true);
  lateUpload.reject(new Error('late BoxLite archive response'));
  await Promise.resolve();
}

{
  const timing = manualDeadlineDriver();
  const transferStarted = deferred();
  const lateTransfer = deferred();
  const deleteStarted = deferred();
  const absenceConfirmed = deferred();
  const uploads = [];
  let execCount = 0;
  let fenceStarted = false;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    sandboxId: 'box-manual-deadline',
    createSecretId: () => 'manual-deadline',
    deletionConfirmation: { attempts: 1 },
    client: {
      async uploadArchive(request) {
        uploads.push(Buffer.from(request.archive));
      },
      async exec() {
        execCount += 1;
        if (execCount < 4) return executionResult();
        transferStarted.resolve();
        return lateTransfer.promise;
      },
      async deleteSandbox() {
        fenceStarted = true;
        deleteStarted.resolve();
      },
      async getSandbox() {
        return fenceStarted
          ? absenceConfirmed.promise
          : { id: 'box-manual-deadline', state: 'running' };
      },
    },
  });
  let settled = false;
  const operation = mod
    .materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        plan: { ...workspaceContext().plan, deadlineMs: 500 },
        secretFilePort: adapter.secretFilePort,
        stageExecutor: adapter.stageExecutor,
      }),
      { deadlineDriver: timing.driver },
    )
    .finally(() => {
      settled = true;
    });

  await transferStarted.promise;
  timing.advance(500);
  await deleteStarted.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(adapter.wasSandboxFenced(), false);
  assert.equal(uploads[0].subarray(0, 512).includes(CANARY), false);
  assert(uploads[0].indexOf(CANARY) >= 512);

  absenceConfirmed.resolve(null);
  assert.deepEqual(await operation, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'timeout',
    retryable: true,
  });
  assert.equal(adapter.wasSandboxFenced(), true);
  await adapter.settleCredentialSafety();
  lateTransfer.reject(new Error('late BoxLite transfer response'));
  await Promise.resolve();
}

{
  const cases = [
    ['capacity_exhausted', 'fatal: No space left on device', 'workspace_transfer', false],
    ['authentication', 'HTTP 403 access denied', 'remote_ref_resolution', false],
    ['tls_network', 'SSL certificate problem', 'workspace_transfer', true],
    ['ref_not_found', '', 'remote_ref_resolution', false, 2],
    ['unknown', 'unrecognized provider failure', 'checkout', false],
  ];
  for (const [cause, output, stage, retryable, exitCode = 1] of cases) {
    assert.deepEqual(
      mod.classifySandboxGitFailure({
        stage,
        result: executionResult({ exitCode, output }),
      }),
      { cause, retryable },
    );
  }
}

{
  const secrets = privateSecretPort();
  const firstCalls = [];
  const first = await mod.deliverSandboxGitWorkspaceStaged({
    taskId: 'task-delivery-retry',
    plan: {
      branch: 'cap/task-delivery-retry',
      commitMessage: 'cap: retry delivery',
      credential: workspaceContext().plan.credential,
      deadlineMs: 60_000,
    },
    workspaceDir: '/home/gem/workspace',
    secretFilePort: secrets.port,
    stageExecutor: {
      async execute(execution) {
        firstCalls.push(execution);
        if (execution.stage === 'delivery_status') {
          return executionResult({ output: ' M changed.txt\n' });
        }
        if (
          execution.stage === 'delivery_commit' &&
          execution.request.command === 'git rev-parse HEAD'
        ) {
          return executionResult({ output: 'abc123\n' });
        }
        if (execution.stage === 'delivery_push') {
          return executionResult({ exitCode: 1, stderr: `HTTP 403 ${CANARY}` });
        }
        return executionResult();
      },
    },
  });
  assert.equal(first.hadChanges, true);
  assert.equal(first.commitSha, 'abc123');
  assert.equal(first.error, 'workspace_git_authentication');
  assert.doesNotMatch(JSON.stringify(first), new RegExp(CANARY, 'u'));

  const retryCalls = [];
  const retry = await mod.deliverSandboxGitWorkspaceStaged({
    taskId: 'task-delivery-retry',
    plan: {
      branch: 'cap/task-delivery-retry',
      commitMessage: 'cap: retry delivery',
      credential: workspaceContext().plan.credential,
      deadlineMs: 60_000,
    },
    workspaceDir: '/home/gem/workspace',
    secretFilePort: secrets.port,
    stageExecutor: {
      async execute(execution) {
        retryCalls.push(execution);
        if (execution.stage === 'delivery_status') {
          return executionResult({ output: `${DELIVERY_PENDING_SENTINEL}\n` });
        }
        if (
          execution.stage === 'delivery_commit' &&
          execution.request.command === 'git rev-parse HEAD'
        ) {
          return executionResult({ output: 'abc123\n' });
        }
        return executionResult();
      },
    },
  });
  assert.deepEqual(retry, { hadChanges: true, commitSha: 'abc123', error: null });
  assert.equal(
    retryCalls.some(
      (call) =>
        call.stage === 'delivery_commit' &&
        call.request.command.includes('commit -F'),
    ),
    false,
  );
  const push = retryCalls.find((call) => call.stage === 'delivery_push');
  assert.ok(push);
  assert.match(push.request.command, /include\.path=/u);
  assert.doesNotMatch(push.request.command, /Authorization:|CAP_STAGE_SECRET/u);
}

console.log('staged workspace git production helper tests passed');
