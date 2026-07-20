import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  ListReposResponseSchema,
  ListTasksResponseSchema,
  PUBLIC_V1_OPERATIONS,
  ProvisioningSummarySchema,
  RepoResponseSchema,
  ScheduleLatestRunSchema,
  ScheduleResponseSchema,
  ScheduleRunResponseSchema,
  TASK_PROVISIONING_STAGES,
  TASK_PROVISIONING_STATES,
  TaskFailureSchema,
  TaskProvisioningProgressSchema,
  TaskProvisioningSummarySchema,
  TaskResponseSchema,
  V1ListReposResponseSchema,
  V1ListTasksResponseSchema,
} = require(path.join(here, '..', 'dist', 'index.js'));

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-07-15T01:00:00.000Z';
const UPDATED_AT = '2026-07-15T01:02:03.000Z';

const taskRow = {
  id: TASK_ID,
  repoId: REPO_ID,
  prompt: 'materialize the selected branch',
  status: 'pending',
  createdAt: CREATED_AT,
};

const repoRow = {
  id: REPO_ID,
  name: 'zhiwen',
  gitSource: 'https://code.example.test/group/zhiwen.git',
  createdAt: CREATED_AT,
  defaultBranch: 'master',
};

const provisioning = {
  state: 'running',
  stage: 'workspace_transfer',
  attempt: 1,
  resolvedBranch: 'master',
  updatedAt: UPDATED_AT,
};

const runtimeFailures = [
  ['runtime_auth_expired', 'reconnect_runtime'],
  ['runtime_auth_rejected', 'reconnect_runtime'],
  ['runtime_model_setup_failed', 'retry_task'],
  ['runtime_model_rejected', 'choose_another_model'],
];

const provisioningFailures = [
  ['provisioning_capacity_exhausted', 'increase_sandbox_capacity'],
  ['provisioning_workspace_timeout', 'retry_task'],
  ['provisioning_forge_auth_failed', 'reconnect_forge'],
  ['provisioning_tls_network_failed', 'retry_task'],
  ['provisioning_ref_not_found', 'verify_repository_ref'],
  ['provisioning_platform_dependency_unavailable', 'repair_deployment'],
  ['provisioning_unknown', 'retry_task'],
];

test('provisioning summary has stable state/stage enums and strict safe fields', () => {
  assert.deepEqual(TASK_PROVISIONING_STATES, [
    'accepted',
    'queued',
    'running',
    'retrying',
    'succeeded',
    'failed',
    'cancelled',
  ]);
  assert.deepEqual(TASK_PROVISIONING_STAGES, [
    'accepted',
    'sandbox_creation',
    'credential_setup',
    'remote_ref_resolution',
    'workspace_transfer',
    'checkout',
    'submodules',
    'credential_cleanup',
    'runtime_setup',
    'readiness',
    'agent_launch',
    'complete',
  ]);

  const parsed = ProvisioningSummarySchema.parse(provisioning);
  assert.equal(parsed.state, 'running');
  assert.equal(parsed.stage, 'workspace_transfer');
  assert.equal(parsed.resolvedBranch, 'master');
  assert.ok(parsed.updatedAt instanceof Date);

  assert.throws(() =>
    TaskProvisioningSummarySchema.parse({
      ...provisioning,
      leaseOwner: 'worker-1',
      providerEndpoint: 'https://provider.internal',
      nativeSandboxId: 'box-secret-id',
      rawOutput: 'authenticated git command',
    }),
  );
  assert.throws(() =>
    TaskProvisioningSummarySchema.parse({ ...provisioning, attempt: -1 }),
  );
  assert.throws(() =>
    TaskProvisioningSummarySchema.parse({ ...provisioning, stage: 'git_clone' }),
  );
});

test('TaskResponse provisioning is optional and nullable for legacy task rows', () => {
  assert.equal(TaskResponseSchema.parse(taskRow).provisioning, undefined);
  assert.equal(
    TaskResponseSchema.parse({ ...taskRow, provisioning: null }).provisioning,
    null,
  );

  const parsed = TaskResponseSchema.parse({ ...taskRow, provisioning });
  assert.equal(parsed.provisioning.state, 'running');
  assert.equal(parsed.provisioning.stage, 'workspace_transfer');
});

test('summary progress is additive: absent, null, populated, and indeterminate shapes all round-trip strictly', () => {
  // Absent (old payload, contracts-first rollout safety): parses, progress undefined.
  const legacy = TaskProvisioningSummarySchema.parse(provisioning);
  assert.equal(legacy.progress, undefined);
  assert.equal(
    TaskResponseSchema.parse({ ...taskRow, provisioning }).provisioning.progress,
    undefined,
  );

  // Explicit null: the emitter knows there is no transfer progress to report.
  assert.equal(
    TaskProvisioningSummarySchema.parse({ ...provisioning, progress: null })
      .progress,
    null,
  );

  // Populated numeric shape during an active object transfer.
  const populated = {
    percent: 42.5,
    receivedObjects: 425,
    totalObjects: 1000,
    receivedBytes: 7_340_032,
    throughput: 1_048_576,
  };
  const parsed = TaskProvisioningSummarySchema.parse({
    ...provisioning,
    progress: populated,
  });
  assert.deepEqual(parsed.progress, populated);
  assert.deepEqual(Object.keys(parsed.progress).sort(), [
    'percent',
    'receivedBytes',
    'receivedObjects',
    'throughput',
    'totalObjects',
  ]);

  // Indeterminate phase (before "Receiving objects"): unknown is explicit null,
  // never 0% — a consumer can distinguish it from an actual 0% transfer.
  const indeterminate = {
    percent: null,
    receivedObjects: null,
    totalObjects: null,
    receivedBytes: null,
    throughput: null,
  };
  const parsedIndeterminate = TaskProvisioningProgressSchema.parse(indeterminate);
  assert.equal(parsedIndeterminate.percent, null);
  assert.notEqual(parsedIndeterminate.percent, 0);
  const zeroPercent = TaskProvisioningProgressSchema.parse({
    ...indeterminate,
    percent: 0,
    receivedObjects: 0,
    totalObjects: 1000,
  });
  assert.equal(zeroPercent.percent, 0);
  assert.notEqual(zeroPercent.percent, parsedIndeterminate.percent);
  assert.equal(
    TaskProvisioningSummarySchema.parse({
      ...provisioning,
      progress: indeterminate,
    }).progress.percent,
    null,
  );
});

test('summary progress stays numeric-only and strict', () => {
  const populated = {
    percent: 42.5,
    receivedObjects: 425,
    totalObjects: 1000,
    receivedBytes: 7_340_032,
    throughput: 1_048_576,
  };

  // Strictness: free text, URLs, or raw git output must fail validation.
  for (const leak of [
    { phase: 'Receiving objects' },
    { rawLine: 'Receiving objects:  42% (425/1000), 7.00 MiB | 1.00 MiB/s' },
    { remoteUrl: 'https://forge.internal/group/repo.git' },
  ]) {
    assert.throws(() =>
      TaskProvisioningProgressSchema.parse({ ...populated, ...leak }),
    );
    assert.throws(() =>
      TaskProvisioningSummarySchema.parse({
        ...provisioning,
        progress: { ...populated, ...leak },
      }),
    );
  }

  // Numeric bounds: percent is 0-100, counts are non-negative integers.
  assert.throws(() =>
    TaskProvisioningProgressSchema.parse({ ...populated, percent: 101 }),
  );
  assert.throws(() =>
    TaskProvisioningProgressSchema.parse({ ...populated, percent: -1 }),
  );
  assert.throws(() =>
    TaskProvisioningProgressSchema.parse({ ...populated, receivedObjects: -1 }),
  );
  assert.throws(() =>
    TaskProvisioningProgressSchema.parse({ ...populated, receivedBytes: 1.5 }),
  );
  assert.throws(() =>
    TaskProvisioningProgressSchema.parse({ ...populated, percent: '42%' }),
  );

  // Partial progress objects are rejected: every field is present, null when unknown.
  assert.throws(() => TaskProvisioningProgressSchema.parse({ percent: 42.5 }));
});

test('every existing runtime failure keeps its exact production shape and action', () => {
  for (const [code, action] of runtimeFailures) {
    const input = {
      code,
      runtime: 'codex',
      message: `safe ${code}`,
      action,
      occurredAt: UPDATED_AT,
      exitCode: 1,
    };
    const parsed = TaskFailureSchema.parse(input);
    assert.deepEqual(Object.keys(parsed).sort(), [
      'action',
      'code',
      'exitCode',
      'message',
      'occurredAt',
      'runtime',
    ]);
    assert.equal(parsed.code, code);
    assert.equal(parsed.action, action);
    assert.equal(
      TaskResponseSchema.parse({ ...taskRow, status: 'failed', failure: input })
        .failure.action,
      action,
    );
    assert.throws(() =>
      TaskFailureSchema.parse({ ...input, action: 'reconnect_forge' }),
    );
  }
});

test('provisioning failure codes have fixed actions and reject diagnostic fields', () => {
  for (const [code, action] of provisioningFailures) {
    const input = {
      code,
      message: `safe ${code}`,
      action,
      occurredAt: UPDATED_AT,
    };
    const parsed = TaskFailureSchema.parse(input);
    assert.equal(parsed.code, code);
    assert.equal(parsed.action, action);
    assert.deepEqual(Object.keys(parsed).sort(), [
      'action',
      'code',
      'message',
      'occurredAt',
    ]);

    const response = TaskResponseSchema.parse({
      ...taskRow,
      status: 'failed',
      provisioning: { ...provisioning, state: 'failed' },
      failure: input,
    });
    assert.equal(response.failure.code, code);
    assert.equal(response.failure.action, action);

    assert.throws(() =>
      TaskFailureSchema.parse({ ...input, action: 'choose_another_model' }),
    );
    assert.throws(() =>
      TaskFailureSchema.parse({
        ...input,
        rawOutput: 'fatal: authenticated clone failed',
        providerEndpoint: 'https://provider.internal',
        token: 'secret-canary',
      }),
    );
  }
});

test('closed failure union documents the matched-upgrade boundary while current readers accept legacy payloads', () => {
  assert.match(TaskFailureSchema.description ?? '', /closed/iu);
  assert.match(TaskFailureSchema.description ?? '', /matched upgrade/iu);
  for (const [code, action] of provisioningFailures.slice(0, -1)) {
    assert.doesNotThrow(() =>
      TaskFailureSchema.parse({
        code,
        message: `legacy-safe-${code}`,
        action,
        occurredAt: UPDATED_AT,
      }),
    );
  }
});

test('all eight schedule operations preserve the platform dependency failure in latest-run or ledger shapes', () => {
  const failure = {
    code: 'provisioning_platform_dependency_unavailable',
    message: 'The deployment is missing a required control-plane dependency.',
    action: 'repair_deployment',
    occurredAt: UPDATED_AT,
  };
  const latestRun = ScheduleLatestRunSchema.parse({
    id: '33333333-3333-4333-8333-333333333333',
    scheduledFor: CREATED_AT,
    status: 'created',
    taskId: TASK_ID,
    taskStatus: 'failed',
    taskFailure: failure,
    error: null,
    createdAt: CREATED_AT,
  });
  const schedule = ScheduleResponseSchema.parse({
    id: '44444444-4444-4444-8444-444444444444',
    ownerUserId: 'owner-current-reader',
    repoId: REPO_ID,
    name: 'platform dependency projection',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    recurrence: {
      kind: 'daily',
      time: '09:00',
      timezone: 'UTC',
      label: 'Daily 09:00',
    },
    enabled: true,
    nextRunAt: UPDATED_AT,
    overlapPolicy: 'skip',
    misfirePolicy: 'fire-once',
    taskTemplate: {
      repoId: REPO_ID,
      prompt: 'verify deployment dependency',
      runtime: 'codex',
      sandboxEnvironmentId: null,
      deliver: 'none',
    },
    latestRun,
    currentPeriod: {
      key: 'day:2026-07-16',
      scheduledFor: UPDATED_AT,
      run: latestRun,
    },
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  });
  const run = ScheduleRunResponseSchema.parse({
    ...latestRun,
    scheduleId: schedule.id,
    updatedAt: UPDATED_AT,
  });

  const scheduleOperationIds = [
    'schedules.list',
    'schedules.create',
    'schedules.get',
    'schedules.update',
    'schedules.pause',
    'schedules.resume',
    'schedules.dispatch',
    'schedules.runs',
  ];
  for (const operationId of scheduleOperationIds) {
    const operation = PUBLIC_V1_OPERATIONS.find(
      (candidate) => candidate.id === operationId,
    );
    assert.ok(operation, `missing public operation ${operationId}`);
    const payload =
      operationId === 'schedules.list'
        ? { items: [schedule], nextCursor: null }
        : operationId === 'schedules.runs'
          ? { items: [run], nextCursor: null }
          : schedule;
    const parsed = operation.responseSchema.parse(payload);
    const projectedFailure =
      operationId === 'schedules.list'
        ? parsed.items[0].latestRun.taskFailure
        : operationId === 'schedules.runs'
          ? parsed.items[0].taskFailure
          : parsed.latestRun.taskFailure;
    assert.equal(projectedFailure.code, failure.code, operationId);
    assert.equal(projectedFailure.action, failure.action, operationId);
    assert.equal(JSON.stringify(projectedFailure).includes('token'), false);
  }

  const legacySchedule = {
    ...schedule,
    latestRun: { ...latestRun, taskFailure: undefined },
    currentPeriod: undefined,
  };
  assert.equal(
    ScheduleResponseSchema.parse(legacySchedule).latestRun.taskFailure,
    undefined,
  );
  assert.equal(
    ScheduleRunResponseSchema.parse({ ...run, taskFailure: null }).taskFailure,
    null,
  );
});

test('console, Public V1, and canonical MCP mappings share task provisioning', () => {
  const task = { ...taskRow, provisioning };
  assert.equal(
    ListTasksResponseSchema.parse([task])[0].provisioning.stage,
    'workspace_transfer',
  );
  assert.equal(
    V1ListTasksResponseSchema.parse({ items: [task], nextCursor: null }).items[0]
      .provisioning.stage,
    'workspace_transfer',
  );

  for (const operationId of [
    'tasks.create',
    'tasks.list',
    'tasks.get',
    'tasks.stop',
  ]) {
    const operation = PUBLIC_V1_OPERATIONS.find(
      (candidate) => candidate.id === operationId,
    );
    assert.ok(operation, `missing public operation ${operationId}`);
    assert.equal(operation.mcp.outputProjection, 'canonical');
    const payload =
      operationId === 'tasks.list'
        ? { items: [task], nextCursor: null }
        : task;
    const parsed = operation.responseSchema.parse(payload);
    const projectedTask = operationId === 'tasks.list' ? parsed.items[0] : parsed;
    assert.equal(projectedTask.provisioning.state, 'running');
    assert.equal(projectedTask.provisioning.stage, 'workspace_transfer');
  }
});

test('the six existing public task/repo bindings declare additive provisioning truth without identity drift', () => {
  const expected = [
    ['tasks.create', 'post', '/v1/tasks', 'create_task', TaskResponseSchema],
    ['tasks.list', 'get', '/v1/tasks', 'list_tasks', V1ListTasksResponseSchema],
    ['tasks.get', 'get', '/v1/tasks/{id}', 'get_task', TaskResponseSchema],
    [
      'tasks.stop',
      'post',
      '/v1/tasks/{id}/stop',
      'stop_task',
      TaskResponseSchema,
    ],
    ['repos.list', 'get', '/v1/repos', 'list_repos', V1ListReposResponseSchema],
    ['repos.get', 'get', '/v1/repos/{id}', 'get_repo', RepoResponseSchema],
  ];

  for (const [id, method, route, tool, responseSchema] of expected) {
    const operation = PUBLIC_V1_OPERATIONS.find((candidate) => candidate.id === id);
    assert.ok(operation, `missing public operation ${id}`);
    assert.equal(operation.method, method);
    assert.equal(operation.path, route);
    assert.equal(operation.mcp.tool, tool);
    assert.equal(operation.mcp.outputProjection, 'canonical');
    assert.equal(operation.responseSchema, responseSchema);
  }

  const taskOperations = expected
    .map(([id]) => PUBLIC_V1_OPERATIONS.find((candidate) => candidate.id === id))
    .filter((operation) => operation?.id.startsWith('tasks.'));
  for (const operation of taskOperations) {
    assert.match(
      `${operation.description} ${operation.responseDescription}`,
      /provisioning/u,
    );
  }
  const create = PUBLIC_V1_OPERATIONS.find(({ id }) => id === 'tasks.create');
  assert.match(create.description, /return as soon as that acceptance is committed/u);
  assert.match(create.responseDescription, /optional\/nullable/u);

  for (const id of ['repos.list', 'repos.get']) {
    const operation = PUBLIC_V1_OPERATIONS.find((candidate) => candidate.id === id);
    assert.match(operation.description, /`defaultBranch`/u);
    assert.match(operation.description, /optional\/nullable/u);
  }
  assert.equal(
    PUBLIC_V1_OPERATIONS.some(({ id }) =>
      ['repos.create', 'repos.import'].includes(id),
    ),
    false,
  );
});

test('repo response projections preserve verified master and legacy null', () => {
  assert.equal(RepoResponseSchema.parse(repoRow).defaultBranch, 'master');
  assert.equal(
    ListReposResponseSchema.parse([repoRow])[0].defaultBranch,
    'master',
  );
  assert.equal(
    V1ListReposResponseSchema.parse({ items: [repoRow], nextCursor: null }).items[0]
      .defaultBranch,
    'master',
  );
  assert.equal(
    RepoResponseSchema.parse({ ...repoRow, defaultBranch: null }).defaultBranch,
    null,
  );
  const { defaultBranch: _defaultBranch, ...legacyRepo } = repoRow;
  assert.equal(RepoResponseSchema.parse(legacyRepo).defaultBranch, undefined);

  for (const operationId of ['repos.list', 'repos.get']) {
    const operation = PUBLIC_V1_OPERATIONS.find(
      (candidate) => candidate.id === operationId,
    );
    assert.ok(operation, `missing public operation ${operationId}`);
    assert.equal(operation.mcp.outputProjection, 'canonical');
    const payload =
      operationId === 'repos.list'
        ? { items: [repoRow], nextCursor: null }
        : repoRow;
    const parsed = operation.responseSchema.parse(payload);
    const projectedRepo = operationId === 'repos.list' ? parsed.items[0] : parsed;
    assert.equal(projectedRepo.defaultBranch, 'master');
  }
});
