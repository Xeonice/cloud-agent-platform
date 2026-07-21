import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const CANARY = 'CAP_STAGE_SECRET_CANARY_7f1b9d';
const RAW_PROVIDER_ID = 'boxlite-native-provider-id-CAP-raw-98f43';
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
        await options.onDelete?.(request);
        if (options.deleteFails) {
          throw (
            options.deleteError ?? new Error('provider delete failed')
          );
        }
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

function diagnosticUuid(index) {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function taskDiagnosticHarness(options = {}) {
  const events = [];
  let eventIdentity = 100 + (options.identityOffset ?? 0);
  let operationIdentity = 200 + (options.identityOffset ?? 0);
  const taskId =
    options.taskId ?? '11111111-1111-4111-8111-111111111111';
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId,
      attemptId:
        options.attemptId ?? '22222222-2222-4222-8222-222222222222',
      attempt: options.attempt ?? 1,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
    },
    createEventId: () => diagnosticUuid(eventIdentity++),
    createOperationId: () => diagnosticUuid(operationIdentity++),
    now: () => new Date('2026-07-17T06:00:00.000Z'),
    record: async (event) => {
      events.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  return { emitter, events, taskId };
}

function operationEvents(events, operation) {
  return events.filter((event) => event.operation === operation);
}

function assertBoundedOperationEvents(events) {
  const byOperationId = new Map();
  for (const event of events) {
    const retained = byOperationId.get(event.operationId) ?? [];
    retained.push(event);
    byOperationId.set(event.operationId, retained);
  }
  for (const retained of byOperationId.values()) {
    assert.equal(
      retained.filter((event) => event.outcome === 'started').length <= 1,
      true,
    );
    assert.equal(
      retained.filter((event) => event.outcome !== 'started').length <= 1,
      true,
    );
  }
}

function assertCompleteDiagnosticLifecycles(events) {
  const byOperationId = new Map();
  for (const event of events) {
    const retained = byOperationId.get(event.operationId) ?? [];
    retained.push(event);
    byOperationId.set(event.operationId, retained);
  }
  for (const [operationId, retained] of byOperationId) {
    assert.equal(
      retained.filter((event) => event.outcome === 'started').length,
      1,
      `${operationId} must have exactly one start`,
    );
    assert.equal(
      retained.filter((event) => event.outcome !== 'started').length,
      1,
      `${operationId} must have exactly one terminal`,
    );
  }
}

function boxLiteResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async arrayBuffer() {
      return new Uint8Array().buffer;
    },
  };
}

async function flushTaskDiagnostics() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

{
  const secrets = privateSecretPort();
  const diagnostics = taskDiagnosticHarness();
  const calls = [];
  const progress = [];
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId: diagnostics.taskId,
      diagnostics: diagnostics.emitter,
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
  assert.equal(diagnostics.events.length, 12);
  assert.deepEqual(
    diagnostics.events.map((event) => [
      event.stage,
      event.operation,
      event.channel,
      event.outcome,
    ]),
    [
      ['credential_setup', 'credential_setup', 'primary', 'started'],
      ['credential_setup', 'credential_setup', 'primary', 'succeeded'],
      ['remote_ref_resolution', 'remote_ref_resolve', 'primary', 'started'],
      ['remote_ref_resolution', 'remote_ref_resolve', 'primary', 'succeeded'],
      ['workspace_transfer', 'repository_transfer', 'primary', 'started'],
      ['workspace_transfer', 'repository_transfer', 'primary', 'succeeded'],
      ['checkout', 'checkout', 'primary', 'started'],
      ['checkout', 'checkout', 'primary', 'succeeded'],
      ['submodules', 'submodules', 'primary', 'started'],
      ['submodules', 'submodules', 'primary', 'succeeded'],
      ['credential_cleanup', 'credential_cleanup', 'cleanup', 'started'],
      ['credential_cleanup', 'credential_cleanup', 'cleanup', 'succeeded'],
    ],
  );
  assertBoundedOperationEvents(diagnostics.events);
  assert.doesNotMatch(
    JSON.stringify({ result, progress, calls, diagnostics: diagnostics.events }),
    new RegExp(CANARY, 'u'),
  );
  assert.doesNotMatch(
    JSON.stringify(diagnostics.events),
    /gitee\.com|private\.git|Authorization:|cap-secrets/u,
  );
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
  const diagnostics = taskDiagnosticHarness();
  const secrets = privateSecretPort();
  const context = workspaceContext({
    taskId: diagnostics.taskId,
    diagnostics: diagnostics.emitter,
    secretFilePort: secrets.port,
    stageExecutor: { execute: async () => executionResult() },
  });
  assert.deepEqual(
    await mod.materializeSandboxGitWorkspaceStaged(context),
    { status: 'succeeded', stage: 'complete' },
  );
  const firstPass = diagnostics.events.map((event) => ({
    idempotencyKey: event.idempotencyKey,
    operationId: event.operationId,
    outcome: event.outcome,
  }));
  assert.equal(firstPass.length, 12);
  assert.deepEqual(
    await mod.materializeSandboxGitWorkspaceStaged(context),
    { status: 'succeeded', stage: 'complete' },
  );
  assert.deepEqual(
    diagnostics.events.map((event) => ({
      idempotencyKey: event.idempotencyKey,
      operationId: event.operationId,
      outcome: event.outcome,
    })),
    firstPass,
  );
  assertBoundedOperationEvents(diagnostics.events);
}

{
  const taskId = '77777777-7777-4777-8777-777777777777';
  const firstAttempt = taskDiagnosticHarness({
    taskId,
    attemptId: '88888888-8888-4888-8888-888888888881',
    attempt: 1,
    identityOffset: 1_000,
  });
  const retryAttempt = taskDiagnosticHarness({
    taskId,
    attemptId: '88888888-8888-4888-8888-888888888882',
    attempt: 2,
    identityOffset: 2_000,
  });
  const materialize = (diagnostics) =>
    mod.materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        taskId,
        diagnostics,
        secretFilePort: privateSecretPort().port,
        stageExecutor: { execute: async () => executionResult() },
      }),
    );

  assert.deepEqual(await materialize(firstAttempt.emitter), {
    status: 'succeeded',
    stage: 'complete',
  });
  assert.deepEqual(await materialize(retryAttempt.emitter), {
    status: 'succeeded',
    stage: 'complete',
  });
  assert.equal(firstAttempt.events.length, 12);
  assert.equal(retryAttempt.events.length, 12);
  const firstOperationIds = new Set(
    firstAttempt.events.map((event) => event.operationId),
  );
  assert.equal(
    retryAttempt.events.some((event) => firstOperationIds.has(event.operationId)),
    false,
    'a scheduled retry with a new attempt emitter must receive new operation ids',
  );
  assert.deepEqual(
    [...new Set(firstAttempt.events.map((event) => event.attempt))],
    [1],
  );
  assert.deepEqual(
    [...new Set(retryAttempt.events.map((event) => event.attempt))],
    [2],
  );
  assertBoundedOperationEvents(firstAttempt.events);
  assertBoundedOperationEvents(retryAttempt.events);
}

{
  let operationIdentity = 300;
  const observer =
    mod.createNonPersistingSandboxProvisioningDiagnosticObserver({
      createOperationId: () => diagnosticUuid(operationIdentity++),
    });
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      diagnostics: observer,
      secretFilePort: privateSecretPort().port,
      stageExecutor: { execute: async () => executionResult() },
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.equal(observer.mode, 'non-persisting');
  assert.equal(Object.hasOwn(observer, 'attemptContext'), false);
  assert.equal(Object.hasOwn(observer, 'record'), false);
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
  const diagnostics = taskDiagnosticHarness();
  const progress = [];
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId: diagnostics.taskId,
      diagnostics: diagnostics.emitter,
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
  assert.deepEqual(
    operationEvents(diagnostics.events, 'credential_cleanup').map((event) => ({
      outcome: event.outcome,
      cause: event.cause,
      channel: event.channel,
    })),
    [
      { outcome: 'started', cause: undefined, channel: 'cleanup' },
      { outcome: 'failed', cause: 'cleanup_failed', channel: 'cleanup' },
    ],
  );
  assertBoundedOperationEvents(diagnostics.events);
}

{
  const diagnostics = taskDiagnosticHarness();
  const cleanupError = new Error(
    `${CANARY} ${RAW_PROVIDER_ID} https://provider.invalid/private-delete`,
  );
  const secrets = privateSecretPort({
    deleteFails: true,
    deleteError: cleanupError,
  });
  const progress = [];
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId: diagnostics.taskId,
      diagnostics: diagnostics.emitter,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          return execution.stage === 'workspace_transfer'
            ? executionResult({
                exitCode: 1,
                stderr: `fatal: No space left on device ${CANARY} ${RAW_PROVIDER_ID}`,
              })
            : executionResult();
        },
      },
      onProgress: (event) => progress.push(event),
    }),
  );
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'capacity_exhausted',
    retryable: false,
  });
  assert.deepEqual(
    operationEvents(diagnostics.events, 'repository_transfer').map(
      (event) => ({ outcome: event.outcome, cause: event.cause }),
    ),
    [
      { outcome: 'started', cause: undefined },
      { outcome: 'failed', cause: 'capacity_exhausted' },
    ],
  );
  assert.deepEqual(
    operationEvents(diagnostics.events, 'credential_cleanup').map((event) => ({
      outcome: event.outcome,
      cause: event.cause,
      channel: event.channel,
    })),
    [
      { outcome: 'started', cause: undefined, channel: 'cleanup' },
      { outcome: 'failed', cause: 'cleanup_failed', channel: 'cleanup' },
    ],
  );
  assertBoundedOperationEvents(diagnostics.events);
  const serialized = JSON.stringify({ result, progress, events: diagnostics.events });
  for (const forbidden of [
    CANARY,
    RAW_PROVIDER_ID,
    REPOSITORY_URL,
    'provider.invalid',
    'Authorization:',
    '/run/cap-secrets',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

{
  const attemptedDiagnostics = [];
  let eventIdentity = 400;
  let operationIdentity = 500;
  const taskId = '33333333-3333-4333-8333-333333333333';
  const diagnostics = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId,
      attemptId: '44444444-4444-4444-8444-444444444444',
      attempt: 1,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
    },
    createEventId: () => diagnosticUuid(eventIdentity++),
    createOperationId: () => diagnosticUuid(operationIdentity++),
    record: async (event) => {
      attemptedDiagnostics.push(event);
      throw new Error(
        `${CANARY} ${RAW_PROVIDER_ID} diagnostic store provider rejection`,
      );
    },
  });
  const progress = [];
  const secrets = privateSecretPort({
    deleteFails: true,
    deleteError: new Error(`${CANARY} ${RAW_PROVIDER_ID} cleanup rejection`),
  });
  let executionCount = 0;
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId,
      diagnostics,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          executionCount += 1;
          return execution.stage === 'workspace_transfer'
            ? executionResult({
                exitCode: 1,
                stderr: `No space left on device ${CANARY} ${RAW_PROVIDER_ID}`,
              })
            : executionResult();
        },
      },
      onProgress: (event) => progress.push(event),
    }),
  );
  assert.deepEqual(result, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'capacity_exhausted',
    retryable: false,
  });
  assert.equal(executionCount, 2);
  assert.equal(secrets.deletes.length, 1);
  assert.equal(
    progress.some(
      (event) =>
        event.stage === 'credential_cleanup' && event.status === 'failed',
    ),
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attemptedDiagnostics.length, 8);
  const serialized = JSON.stringify({
    result,
    progress,
    attemptedDiagnostics,
  });
  assert.equal(serialized.includes(CANARY), false);
  assert.equal(serialized.includes(RAW_PROVIDER_ID), false);
  assert.equal(serialized.includes(REPOSITORY_URL), false);
}

{
  const timing = manualDeadlineDriver();
  const firstRecordStarted = deferred();
  const releaseRecord = deferred();
  const remoteRefStarted = deferred();
  const continueBusiness = deferred();
  const allRecorded = deferred();
  const recorded = [];
  let eventIdentity = 600;
  let operationIdentity = 700;
  const taskId = '55555555-5555-4555-8555-555555555555';
  const diagnostics = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId,
      attemptId: '66666666-6666-4666-8666-666666666666',
      attempt: 1,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
    },
    createEventId: () => diagnosticUuid(eventIdentity++),
    createOperationId: () => diagnosticUuid(operationIdentity++),
    record: async (event) => {
      firstRecordStarted.resolve();
      await releaseRecord.promise;
      recorded.push(event);
      if (recorded.length === 12) allRecorded.resolve();
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  const secrets = privateSecretPort();
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId,
      diagnostics,
      plan: { ...workspaceContext().plan, deadlineMs: 500 },
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          if (execution.stage === 'remote_ref_resolution') {
            remoteRefStarted.resolve();
            await continueBusiness.promise;
          }
          return executionResult();
        },
      },
    }),
    { deadlineDriver: timing.driver },
  );

  await firstRecordStarted.promise;
  const reachedBusiness = await Promise.race([
    remoteRefStarted.promise.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(reachedBusiness, true, 'diagnostic recorder must not gate Git work');
  timing.advance(400);
  continueBusiness.resolve();
  const business = await Promise.race([
    operation.then((result) => ({ kind: 'settled', result })),
    new Promise((resolve) =>
      setImmediate(() => resolve({ kind: 'diagnostic-blocked' })),
    ),
  ]);
  assert.deepEqual(business, {
    kind: 'settled',
    result: { status: 'succeeded', stage: 'complete' },
  });
  assert.equal(secrets.deletes.length, 1);
  assert.equal(recorded.length, 0, 'business settles while recorder is pending');

  releaseRecord.resolve();
  const drained = await Promise.race([
    allRecorded.promise.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(drained, true);
  assert.equal(recorded.length, 12);
  assert.deepEqual(
    recorded.map((event) => event.sequence),
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  assertBoundedOperationEvents(recorded);
}

{
  const events = [];
  const secrets = privateSecretPort({ events });
  const diagnostics = taskDiagnosticHarness();
  const transferStarted = deferred();
  const transferSettled = deferred();
  const abort = new AbortController();
  let helperSettled = false;
  const operation = mod
    .materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        taskId: diagnostics.taskId,
        diagnostics: diagnostics.emitter,
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
  assert.deepEqual(
    operationEvents(diagnostics.events, 'repository_transfer').map(
      (event) => event.outcome,
    ),
    ['started', 'cancelled'],
  );
  assert.deepEqual(
    operationEvents(diagnostics.events, 'credential_cleanup').map(
      (event) => event.outcome,
    ),
    ['started', 'cancelled'],
  );
  assertBoundedOperationEvents(diagnostics.events);
}

{
  const timing = manualDeadlineDriver();
  const events = [];
  const secrets = privateSecretPort({ events });
  const diagnostics = taskDiagnosticHarness();
  const transferStarted = deferred();
  const transferSettled = deferred();
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId: diagnostics.taskId,
      diagnostics: diagnostics.emitter,
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
  const transferDiagnostics = operationEvents(
    diagnostics.events,
    'repository_transfer',
  );
  assert.deepEqual(
    transferDiagnostics.map((event) => event.outcome),
    ['started', 'timed_out'],
  );
  assert.equal(transferDiagnostics[1].cause, 'workspace_timeout');
  assert.equal(transferDiagnostics[1].timeoutMs, 500);
  assert.deepEqual(
    operationEvents(diagnostics.events, 'credential_cleanup').map(
      (event) => event.outcome,
    ),
    ['started', 'timed_out'],
  );
  assertBoundedOperationEvents(diagnostics.events);
}

{
  const timing = manualDeadlineDriver();
  const diagnostics = taskDiagnosticHarness();
  const deleteStarted = deferred();
  const deleteSettled = deferred();
  const progress = [];
  const secrets = privateSecretPort({
    async onDelete() {
      deleteStarted.resolve();
      await deleteSettled.promise;
    },
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId: diagnostics.taskId,
      diagnostics: diagnostics.emitter,
      plan: { ...workspaceContext().plan, deadlineMs: 500 },
      secretFilePort: secrets.port,
      stageExecutor: { execute: async () => executionResult() },
      onProgress: (event) => progress.push(event),
    }),
    { deadlineDriver: timing.driver },
  );
  await deleteStarted.promise;
  timing.advance(500);
  deleteSettled.reject(new Error('late credential cleanup rejection'));
  assert.deepEqual(await operation, {
    status: 'failed',
    stage: 'credential_cleanup',
    cause: 'timeout',
    retryable: true,
  });
  assert.deepEqual(
    progress.filter((event) => event.stage === 'credential_cleanup'),
    [
      { status: 'started', stage: 'credential_cleanup' },
      {
        status: 'failed',
        stage: 'credential_cleanup',
        cause: 'timeout',
        retryable: true,
      },
    ],
  );
  const cleanupDiagnostics = operationEvents(
    diagnostics.events,
    'credential_cleanup',
  );
  assert.deepEqual(
    cleanupDiagnostics.map((event) => event.outcome),
    ['started', 'timed_out'],
  );
  assert.equal(cleanupDiagnostics[1].cause, 'workspace_timeout');
  assert.equal(cleanupDiagnostics[1].timeoutMs, 500);
  assertBoundedOperationEvents(diagnostics.events);
}

{
  const timing = manualDeadlineDriver();
  const diagnostics = taskDiagnosticHarness();
  const deleteStarted = deferred();
  const deleteSettled = deferred();
  const progress = [];
  const secrets = privateSecretPort({
    async onDelete() {
      deleteStarted.resolve();
      await deleteSettled.promise;
    },
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId: diagnostics.taskId,
      diagnostics: diagnostics.emitter,
      plan: { ...workspaceContext().plan, deadlineMs: 500 },
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          return execution.stage === 'workspace_transfer'
            ? executionResult({
                exitCode: 1,
                stderr: 'fatal: No space left on device',
              })
            : executionResult();
        },
      },
      onProgress: (event) => progress.push(event),
    }),
    { deadlineDriver: timing.driver },
  );
  await deleteStarted.promise;
  timing.advance(500);
  deleteSettled.resolve();

  assert.deepEqual(await operation, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'capacity_exhausted',
    retryable: false,
  });
  assert.deepEqual(
    progress.filter((event) => event.stage === 'credential_cleanup'),
    [
      { status: 'started', stage: 'credential_cleanup' },
      {
        status: 'failed',
        stage: 'credential_cleanup',
        cause: 'timeout',
        retryable: true,
      },
    ],
  );
  assert.deepEqual(
    operationEvents(diagnostics.events, 'repository_transfer').map(
      (event) => ({ outcome: event.outcome, cause: event.cause }),
    ),
    [
      { outcome: 'started', cause: undefined },
      { outcome: 'failed', cause: 'capacity_exhausted' },
    ],
  );
  const cleanupDiagnostics = operationEvents(
    diagnostics.events,
    'credential_cleanup',
  );
  assert.deepEqual(
    cleanupDiagnostics.map((event) => event.outcome),
    ['started', 'timed_out'],
  );
  assert.equal(cleanupDiagnostics[1].cause, 'workspace_timeout');
  assert.equal(cleanupDiagnostics[1].timeoutMs, 500);
  assertBoundedOperationEvents(diagnostics.events);
}

{
  const diagnostics = taskDiagnosticHarness();
  const abort = new AbortController();
  const deleteStarted = deferred();
  const deleteSettled = deferred();
  const progress = [];
  const secrets = privateSecretPort({
    async onDelete() {
      deleteStarted.resolve();
      await deleteSettled.promise;
    },
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      taskId: diagnostics.taskId,
      diagnostics: diagnostics.emitter,
      cancellationSignal: abort.signal,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          return execution.stage === 'workspace_transfer'
            ? executionResult({
                exitCode: 1,
                stderr: 'fatal: No space left on device',
              })
            : executionResult();
        },
      },
      onProgress: (event) => progress.push(event),
    }),
  );
  await deleteStarted.promise;
  abort.abort();
  deleteSettled.resolve();

  assert.deepEqual(await operation, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'capacity_exhausted',
    retryable: false,
  });
  assert.deepEqual(
    progress.filter((event) => event.stage === 'credential_cleanup'),
    [
      { status: 'started', stage: 'credential_cleanup' },
      { status: 'cancelled', stage: 'credential_cleanup' },
    ],
  );
  assert.deepEqual(
    operationEvents(diagnostics.events, 'credential_cleanup').map((event) => ({
      outcome: event.outcome,
      cause: event.cause,
    })),
    [
      { outcome: 'started', cause: undefined },
      { outcome: 'cancelled', cause: 'cancelled' },
    ],
  );
  assertBoundedOperationEvents(diagnostics.events);
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
  // detach-workspace-clone: a `workspace_transfer` exec that outlives the
  // deadline is a dropped control exec, never settlement evidence — BoxLite
  // must NOT fence the whole sandbox for it (marker probes own settlement in
  // the detached path; the dual-gate liveness policy owns transfer timeout
  // semantics). The stage still fails as a retryable timeout, and the late
  // transport response stays absorbed. Non-transfer stages keep the fencing
  // boundary — see the credential_setup block above.
  const timing = manualDeadlineDriver();
  const transferStarted = deferred();
  const lateTransfer = deferred();
  const uploads = [];
  let execCount = 0;
  let deleteCalls = 0;
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
        if (execCount !== 4) return executionResult();
        transferStarted.resolve();
        return lateTransfer.promise;
      },
      async deleteSandbox() {
        deleteCalls += 1;
      },
      async getSandbox() {
        return { id: 'box-manual-deadline', state: 'running' };
      },
    },
  });
  const operation = mod.materializeSandboxGitWorkspaceStaged(
    workspaceContext({
      plan: { ...workspaceContext().plan, deadlineMs: 500 },
      secretFilePort: adapter.secretFilePort,
      stageExecutor: adapter.stageExecutor,
    }),
    { deadlineDriver: timing.driver },
  );

  await transferStarted.promise;
  assert.equal(uploads[0].subarray(0, 512).includes(CANARY), false);
  assert(uploads[0].indexOf(CANARY) >= 512);
  timing.advance(500);
  assert.deepEqual(await operation, {
    status: 'failed',
    stage: 'workspace_transfer',
    cause: 'timeout',
    retryable: true,
  });
  assert.equal(deleteCalls, 0);
  assert.equal(adapter.wasSandboxFenced(), false);
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

{
  const baseDiagnostics = taskDiagnosticHarness({
    taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    identityOffset: 10_000,
  });
  const attemptedDiagnostics = [];
  const diagnostics = Object.freeze({
    mode: baseDiagnostics.emitter.mode,
    bindProviderFamily: (...args) =>
      baseDiagnostics.emitter.bindProviderFamily(...args),
    createOperationId: (...args) =>
      baseDiagnostics.emitter.createOperationId(...args),
    async emit(fact) {
      attemptedDiagnostics.push(fact);
      return baseDiagnostics.emitter.emit(fact);
    },
  });
  const providerId = 'boxlite-budget-provider-RAW_PROVIDER_CANARY';
  const configResult = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite-budget.example.test',
    BOXLITE_API_TOKEN: 'RAW_BOXLITE_TOKEN_CANARY',
    BOXLITE_IMAGE: 'cap-boxlite:diagnostic-budget',
    BOXLITE_PROVIDER_ID: providerId,
    BOXLITE_PROTOCOL_MODE: 'native',
    BOXLITE_TERMINAL_MODE: 'none',
    BOXLITE_CAPABILITIES:
      'command.exec,lifecycle.readoption,workspace.git.materialize',
  });
  assert.equal(configResult.status, 'valid');

  const routeSequence = [];
  const executedCommands = [];
  let conflictObserved = false;
  let deleted = false;
  let runtimePhase = false;
  let nativeExecution = 0;
  let sandboxId = null;
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = `${url.pathname}${url.search}`;
    if (
      method === 'GET' &&
      path.startsWith('/v1/default/boxes/') &&
      !path.includes('/executions/')
    ) {
      if (!conflictObserved) {
        routeSequence.push('initial-inspect-absent');
        return boxLiteResponse(404, { error: 'RAW_INITIAL_ABSENCE_CANARY' });
      }
      if (deleted) {
        routeSequence.push('absence-confirmed');
        return boxLiteResponse(404, { error: 'RAW_FINAL_ABSENCE_CANARY' });
      }
      routeSequence.push('conflict-inspect-readopt');
      return boxLiteResponse(200, {
        box_id: sandboxId,
        status: 'running',
        disk_size_gb: 5,
        native_message: 'RAW_CONFLICT_NATIVE_PROSE_CANARY',
      });
    }
    if (method === 'POST' && path === '/v1/default/boxes') {
      const body = JSON.parse(init.body);
      sandboxId = body.name;
      conflictObserved = true;
      routeSequence.push('create-conflict');
      return boxLiteResponse(409, {
        error: 'RAW_CREATE_CONFLICT_NATIVE_PROSE_CANARY',
      });
    }
    if (method === 'POST' && path.endsWith('/exec')) {
      const body = JSON.parse(init.body);
      executedCommands.push(body.args?.at(-1) ?? '');
      nativeExecution += 1;
      return boxLiteResponse(200, {
        execution_id: `RAW_NATIVE_EXECUTION_ID_CANARY_${nativeExecution}`,
      });
    }
    if (
      method === 'GET' &&
      path.includes('/executions/RAW_NATIVE_EXECUTION_ID_CANARY_')
    ) {
      return boxLiteResponse(200, {
        status: 'completed',
        exit_code: runtimePhase ? 1 : 0,
        output: 'RAW_NATIVE_POLL_OUTPUT_CANARY',
      });
    }
    if (method === 'PUT' && path.includes('/files?path=')) {
      return boxLiteResponse(204, null);
    }
    if (method === 'DELETE' && path.startsWith('/v1/default/boxes/')) {
      deleted = true;
      routeSequence.push('sandbox-delete');
      return boxLiteResponse(204, null);
    }
    return boxLiteResponse(404, {
      error: 'RAW_UNEXPECTED_ROUTE_NATIVE_PROSE_CANARY',
    });
  };
  const webSocketFactory = () => {
    const socket = new EventEmitter();
    const exitCode = runtimePhase ? 1 : 0;
    socket.readyState = 1;
    socket.close = () => {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      socket.emit('close');
    };
    socket.terminate = socket.close;
    setImmediate(() => {
      socket.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'exit', exit_code: exitCode })),
        false,
      );
    });
    return socket;
  };
  const client = new mod.BoxLiteRestClient({
    baseUrl: configResult.config.endpoint,
    apiToken: configResult.config.apiToken,
    protocolMode: 'native',
    fetch,
    webSocketFactory,
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: configResult.config,
    client,
    preflight: async ({ executor }) => {
      for (let ordinal = 1; ordinal <= 7; ordinal += 1) {
        await executor.exec({
          command: `RAW_PREFLIGHT_COMMAND_CANARY_${ordinal}`,
        });
      }
      return {
        status: 'passed',
        checkedAt: '2026-07-18T00:00:00.000Z',
        probes: [],
      };
    },
    workspaceMaterialization: mod.materializeSandboxGitWorkspaceStaged,
    runtimeSetup: async ({ executor }) => {
      runtimePhase = true;
      await executor.exec({ command: 'RAW_RUNTIME_FAILURE_COMMAND_CANARY' });
      throw new Error('RAW_RUNTIME_FAILURE_NATIVE_PROSE_CANARY');
    },
  });
  const ownership = {
    ownerGeneration: 'owner:diagnostic-budget',
    resourceGeneration: 'resource:diagnostic-budget',
  };
  const cleanupAuthorization = {
    kind: 'generation',
    taskId: baseDiagnostics.taskId,
    providerId,
    ownership,
  };

  await assert.rejects(
    () =>
      provider.provision({
        taskId: baseDiagnostics.taskId,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
        cloneSpec: null,
        ownership,
        beforeSandboxCleanup: async () => cleanupAuthorization,
        afterSandboxCleanup: async () => undefined,
        workspace: {
          repositoryUrl: REPOSITORY_URL,
          callerBranch: null,
          resolvedBranch: 'master',
          deadlineMs: 60_000,
          credential: mod.createExactHostGitCredential(
            REPOSITORY_URL,
            `Authorization: Basic ${CANARY}`,
          ),
        },
        diagnostics,
      }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error.stage === 'runtime_setup' &&
      !error.message.includes('RAW_RUNTIME_FAILURE_NATIVE_PROSE_CANARY'),
  );
  await flushTaskDiagnostics();

  assert.deepEqual(routeSequence.slice(0, 3), [
    'initial-inspect-absent',
    'create-conflict',
    'conflict-inspect-readopt',
  ]);
  assert.deepEqual(routeSequence.slice(-2), [
    'sandbox-delete',
    'absence-confirmed',
  ]);
  assert.match(executedCommands[0], /CAP_RESOURCE_GENERATION/u);
  assert(executedCommands.some((command) => /\bls-remote\b/u.test(command)));
  assert(executedCommands.some((command) => /\bclone\b/u.test(command)));
  assert(executedCommands.some((command) => /\bcheckout\b/u.test(command)));
  assert(executedCommands.some((command) => /\bsubmodule\b/u.test(command)));
  assert.equal(runtimePhase, true);
  assert.equal(deleted, true);

  const acceptedOperations = new Set(
    baseDiagnostics.events.map((event) => event.operation),
  );
  for (const operation of [
    'sandbox_inspect',
    'sandbox_create',
    'native_exec_start',
    'native_exec_poll',
    'native_exec_attach',
    'native_exec_settlement',
    'runtime_preflight',
    'credential_setup',
    'remote_ref_resolve',
    'repository_transfer',
    'checkout',
    'submodules',
    'credential_cleanup',
    'runtime_setup',
    'sandbox_delete',
    'sandbox_absence_confirm',
  ]) {
    assert(acceptedOperations.has(operation), `${operation} must be diagnosed`);
  }
  assert.equal(
    baseDiagnostics.events.filter(
      (event) => event.operation === 'sandbox_inspect',
    ).length,
    4,
    'initial-absence and conflict-readoption inspect must each retain a pair',
  );
  for (const operation of [
    'credential_setup',
    'remote_ref_resolve',
    'repository_transfer',
    'checkout',
    'submodules',
    'credential_cleanup',
  ]) {
    assert(
      baseDiagnostics.events.some(
        (event) =>
          event.operation === operation && event.outcome === 'succeeded',
      ),
      `${operation} must preserve the successful private Git stage`,
    );
  }
  const runtimeSettlement = baseDiagnostics.events.find(
    (event) =>
      event.operation === 'native_exec_settlement' &&
      event.commandKind === 'runtime_setup' &&
      event.outcome !== 'started',
  );
  assert.equal(runtimeSettlement?.outcome, 'failed');
  assert.equal(runtimeSettlement?.exitCode, 1);

  const maxEvents = mod.SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT;
  assert.ok(
    attemptedDiagnostics.length <= maxEvents,
    `BoxLite attempted ${attemptedDiagnostics.length} diagnostics; max is ${maxEvents}`,
  );
  assert.ok(
    baseDiagnostics.events.length <= maxEvents,
    `BoxLite accepted ${baseDiagnostics.events.length} diagnostics; max is ${maxEvents}`,
  );
  assert.equal(
    baseDiagnostics.events.length,
    attemptedDiagnostics.length,
    'the bounded path must not silently drop a diagnostic lifecycle',
  );
  assertCompleteDiagnosticLifecycles(attemptedDiagnostics);
  assertCompleteDiagnosticLifecycles(baseDiagnostics.events);

  for (const operation of ['sandbox_delete', 'sandbox_absence_confirm']) {
    const lifecycle = baseDiagnostics.events.filter(
      (event) => event.channel === 'cleanup' && event.operation === operation,
    );
    assert.equal(lifecycle.length, 2, `${operation} must retain its pair`);
    assert.equal(lifecycle[0].outcome, 'started');
    assert.equal(lifecycle[1].outcome, 'succeeded');
  }
  assert.doesNotMatch(
    JSON.stringify({
      attempted: attemptedDiagnostics,
      accepted: baseDiagnostics.events,
    }),
    new RegExp(
      [
        CANARY,
        REPOSITORY_URL,
        sandboxId,
        providerId,
        'boxlite-budget.example.test',
        'RAW_',
        'Authorization:',
        'CAP_RESOURCE_GENERATION',
        '/v1/default/boxes',
        'git clone',
      ]
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('|'),
      'u',
    ),
  );
}

// ---------------------------------------------------------------------------
// Inline repository-transfer retry (fix-clone-retry-and-tui-classifier D1).
// ---------------------------------------------------------------------------

/**
 * Drive a staged materialization whose retry backoffs await the manual
 * deadline driver: pump the microtask queue and advance manual time in
 * backoff-sized steps until the materialization settles. Total advanced time
 * stays far below the workspace deadline, so only backoff triggers fire.
 */
async function settleWithManualTime(promise, manual) {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    manual.advance(5_000);
  }
  return tracked;
}

function transferStageEvents(events) {
  return events.filter((event) => event.stage === 'workspace_transfer');
}

{
  // Transient network failure → retried from a clean slate → succeeds, with
  // per-attempt observable diagnostics (failed attempt settles retryable).
  const secrets = privateSecretPort();
  const diagnostics = taskDiagnosticHarness();
  const calls = [];
  let transferAttempts = 0;
  const manual = manualDeadlineDriver();
  const result = await settleWithManualTime(
    mod.materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        taskId: diagnostics.taskId,
        diagnostics: diagnostics.emitter,
        secretFilePort: secrets.port,
        plan: {
          ...workspaceContext().plan,
          deadlineMs: 900_000,
        },
        stageExecutor: {
          async execute(execution) {
            calls.push(execution.stage);
            if (execution.stage === 'workspace_transfer') {
              transferAttempts += 1;
              if (transferAttempts === 1) {
                return executionResult({
                  exitCode: 128,
                  stderr:
                    'error: RPC failed; curl 56 OpenSSL SSL_read: Connection reset by peer\nfatal: early EOF',
                });
              }
            }
            return executionResult();
          },
        },
      }),
      { deadlineDriver: manual.driver },
    ),
    manual,
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.deepEqual(calls, [
    'remote_ref_resolution',
    'workspace_transfer',
    'workspace_transfer',
    'checkout',
    'submodules',
  ]);
  await flushTaskDiagnostics();
  const transfer = transferStageEvents(diagnostics.events);
  assert.deepEqual(
    transfer.map((event) => event.outcome),
    ['started', 'failed', 'started', 'succeeded'],
  );
  assert.equal(transfer[1].retryable, true, 'non-final attempt settles retryable');
  assert.equal(transfer[1].cause, 'tls_network_failed');
  assertBoundedOperationEvents(diagnostics.events);
  assertCompleteDiagnosticLifecycles(diagnostics.events);
}

{
  // Deterministic authentication failure settles immediately — no retry.
  const secrets = privateSecretPort();
  const diagnostics = taskDiagnosticHarness({ identityOffset: 100 });
  let transferAttempts = 0;
  const manual = manualDeadlineDriver();
  const result = await settleWithManualTime(
    mod.materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        taskId: diagnostics.taskId,
        diagnostics: diagnostics.emitter,
        secretFilePort: secrets.port,
        plan: { ...workspaceContext().plan, deadlineMs: 900_000 },
        stageExecutor: {
          async execute(execution) {
            if (execution.stage === 'workspace_transfer') {
              transferAttempts += 1;
              return executionResult({
                exitCode: 128,
                stderr: 'fatal: Authentication failed for repository',
              });
            }
            return executionResult();
          },
        },
      }),
      { deadlineDriver: manual.driver },
    ),
    manual,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.cause, 'authentication');
  assert.equal(transferAttempts, 1);
}

{
  // The unknown fallback (lost output) retries up to the attempt cap, then
  // settles unknown with final (non-retryable) semantics.
  const secrets = privateSecretPort();
  const diagnostics = taskDiagnosticHarness({ identityOffset: 200 });
  let transferAttempts = 0;
  const manual = manualDeadlineDriver();
  const result = await settleWithManualTime(
    mod.materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        taskId: diagnostics.taskId,
        diagnostics: diagnostics.emitter,
        secretFilePort: secrets.port,
        plan: { ...workspaceContext().plan, deadlineMs: 900_000 },
        stageExecutor: {
          async execute(execution) {
            if (execution.stage === 'workspace_transfer') {
              transferAttempts += 1;
              return executionResult({ exitCode: 1, stderr: '' });
            }
            return executionResult();
          },
        },
      }),
      { deadlineDriver: manual.driver },
    ),
    manual,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.cause, 'unknown');
  assert.equal(transferAttempts, 3, 'bounded at the attempt cap');
  await flushTaskDiagnostics();
  const transfer = transferStageEvents(diagnostics.events);
  assert.deepEqual(
    transfer.map((event) => event.outcome),
    ['started', 'failed', 'started', 'failed', 'started', 'failed'],
  );
  assert.equal(transfer[1].retryable, true);
  assert.equal(transfer[3].retryable, true);
  assert.equal(transfer[5].retryable, false, 'final attempt is not retryable');
}

{
  // Remaining-deadline budget floor: no second attempt when the budget after
  // backoff would drop under the safe floor.
  const secrets = privateSecretPort();
  const diagnostics = taskDiagnosticHarness({ identityOffset: 300 });
  let transferAttempts = 0;
  const manual = manualDeadlineDriver();
  const result = await settleWithManualTime(
    mod.materializeSandboxGitWorkspaceStaged(
      workspaceContext({
        taskId: diagnostics.taskId,
        diagnostics: diagnostics.emitter,
        secretFilePort: secrets.port,
        plan: { ...workspaceContext().plan, deadlineMs: 64_000 },
        stageExecutor: {
          async execute(execution) {
            if (execution.stage === 'workspace_transfer') {
              transferAttempts += 1;
              return executionResult({
                exitCode: 128,
                stderr: 'fatal: the remote end hung up unexpectedly',
              });
            }
            return executionResult();
          },
        },
      }),
      { deadlineDriver: manual.driver },
    ),
    manual,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.cause, 'tls_network');
  assert.equal(transferAttempts, 1, 'no retry without deadline budget');
}

console.log('staged workspace git production helper tests passed');
