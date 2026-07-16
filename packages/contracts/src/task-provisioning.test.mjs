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
  TASK_PROVISIONING_STAGES,
  TASK_PROVISIONING_STATES,
  TaskFailureSchema,
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
