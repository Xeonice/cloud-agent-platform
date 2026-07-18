import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const contracts = require(path.join(here, '..', 'dist', 'index.js'));

const {
  PUBLIC_ERROR_CODES,
  PUBLIC_V1_OPERATIONS,
  PUBLIC_V1_CANONICAL_REST_SUCCESS_PROJECTION,
  PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
  PUBLIC_V1_REST_ERROR_PROJECTION,
  CreateScheduleRequestSchema,
  CreateScheduleRequestSchemaPair,
  CreateScheduleRequestWireSchema,
  DispatchScheduleRequestSchema,
  DispatchScheduleRequestSchemaPair,
  DispatchScheduleRequestWireSchema,
  PublicErrorEnvelopeSchema,
  RepoResponseSchema,
  ScheduleResponseSchema,
  TaskResponseSchema,
  TASK_PROVISIONING_DIAGNOSTIC_MAX_PAGE_SIZE,
  PublicV1IdParamsSchema,
  TaskProvisioningDiagnosticsParamsSchema,
  TaskProvisioningDiagnosticsParamsSchemaPair,
  TaskProvisioningDiagnosticsQuerySchema,
  TaskProvisioningDiagnosticsQuerySchemaPair,
  TaskProvisioningDiagnosticsResponseSchema,
  UpdateScheduleRequestSchema,
  UpdateScheduleRequestSchemaPair,
  UpdateScheduleRequestWireSchema,
  V1ListReposResponseSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListSchedulesResponseSchema,
  V1ListTasksResponseSchema,
  assertPublicV1OperationUniqueness,
  definePublicSchemaPair,
  composePublicInputWireSchema,
} = contracts;

const repoId = '11111111-1111-4111-8111-111111111111';

const AFFECTED_OPERATION_BINDINGS = [
  ['tasks.create', 'post', '/v1/tasks', 'tasks:write', 'create_task', TaskResponseSchema],
  ['tasks.list', 'get', '/v1/tasks', 'tasks:read', 'list_tasks', V1ListTasksResponseSchema],
  ['tasks.get', 'get', '/v1/tasks/{id}', 'tasks:read', 'get_task', TaskResponseSchema],
  ['tasks.stop', 'post', '/v1/tasks/{id}/stop', 'tasks:write', 'stop_task', TaskResponseSchema],
  ['repos.list', 'get', '/v1/repos', 'repos:read', 'list_repos', V1ListReposResponseSchema],
  ['repos.get', 'get', '/v1/repos/{id}', 'repos:read', 'get_repo', RepoResponseSchema],
  ['schedules.list', 'get', '/v1/schedules', 'tasks:read', 'list_schedules', V1ListSchedulesResponseSchema],
  ['schedules.create', 'post', '/v1/schedules', 'tasks:write', 'create_schedule', ScheduleResponseSchema],
  ['schedules.get', 'get', '/v1/schedules/{id}', 'tasks:read', 'get_schedule', ScheduleResponseSchema],
  ['schedules.update', 'patch', '/v1/schedules/{id}', 'tasks:write', 'update_schedule', ScheduleResponseSchema],
  ['schedules.pause', 'post', '/v1/schedules/{id}/pause', 'tasks:write', 'pause_schedule', ScheduleResponseSchema],
  ['schedules.resume', 'post', '/v1/schedules/{id}/resume', 'tasks:write', 'resume_schedule', ScheduleResponseSchema],
  ['schedules.dispatch', 'post', '/v1/schedules/{id}/dispatch', 'tasks:write', 'dispatch_schedule', ScheduleResponseSchema],
  ['schedules.runs', 'get', '/v1/schedules/{id}/runs', 'tasks:read', 'list_schedule_runs', V1ListScheduleRunsResponseSchema],
];

function operation(id) {
  const result = PUBLIC_V1_OPERATIONS.find((entry) => entry.id === id);
  assert.ok(result, `missing registry operation ${id}`);
  return result;
}

test('public operation identities, REST routes, and MCP names are unique', () => {
  assert.doesNotThrow(() =>
    assertPublicV1OperationUniqueness(PUBLIC_V1_OPERATIONS),
  );

  const first = PUBLIC_V1_OPERATIONS[0];
  assert.throws(
    () => assertPublicV1OperationUniqueness([first, { ...first }]),
    /Duplicate public operation id/u,
  );
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        first,
        { ...first, id: 'fixture.route-duplicate' },
      ]),
    /Duplicate public REST route/u,
  );
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        first,
        {
          ...first,
          id: 'fixture.tool-duplicate',
          path: '/v1/fixture/tool-duplicate',
        },
      ]),
    /Duplicate public MCP tool/u,
  );
});

test('every operation declares policy, errors, schemas, and an MCP decision', () => {
  const knownCodes = new Set(PUBLIC_ERROR_CODES);
  for (const entry of PUBLIC_V1_OPERATIONS) {
    assert.ok(entry.ownerPolicy === 'optional' || entry.ownerPolicy === 'required');
    assert.equal(
      entry.restOutputProjection,
      entry.id === 'tasks.provisioningDiagnostics'
        ? PUBLIC_V1_CANONICAL_REST_SUCCESS_PROJECTION
        : PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
      `${entry.id} explicitly declares its REST success projection`,
    );
    assert.ok(entry.errors.length > 0, `${entry.id} must declare public errors`);
    for (const code of entry.errors) {
      assert.ok(knownCodes.has(code), `${entry.id} declares unknown error ${code}`);
    }
    assert.ok('tool' in entry.mcp || entry.mcp.excluded.length > 0);
    for (const pair of Object.values(entry.input)) {
      assert.equal(typeof pair.wire.shape, 'object');
      assert.equal(typeof pair.parse.parse, 'function');
    }
  }
});

test('the registry gate rejects a removed MCP protocol decision mutation', () => {
  const [first, ...rest] = PUBLIC_V1_OPERATIONS;
  const { mcp: _removedDecision, ...withoutMcp } = first;
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        withoutMcp,
        ...rest,
      ]),
    new RegExp(
      `Missing MCP protocol decision for public operation: ${first.id}`,
      'u',
    ),
  );
});

test('the registry gate rejects a removed REST output decision mutation', () => {
  const [first, ...rest] = PUBLIC_V1_OPERATIONS;
  const { restOutputProjection: _removedDecision, ...withoutProjection } = first;
  assert.throws(
    () => assertPublicV1OperationUniqueness([withoutProjection, ...rest]),
    new RegExp(
      `Missing REST output projection for public operation: ${first.id}`,
      'u',
    ),
  );
});

test('the registry gate rejects incomplete and duplicate boundary errors', () => {
  const optional = operation('tasks.get');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...optional,
          errors: optional.errors.filter(
            (code) => code !== 'validation_failed',
          ),
        },
      ]),
    /Missing boundary error validation_failed/u,
  );
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        { ...optional, errors: [...optional.errors, optional.errors[0]] },
      ]),
    /Duplicate public error code/u,
  );

  const ownerRequired = operation('schedules.get');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...ownerRequired,
          errors: ownerRequired.errors.filter(
            (code) => code !== 'owner_required',
          ),
        },
      ]),
    /Missing boundary error owner_required/u,
  );
});

test('the registry gate rejects missing or invalid live REST projectors', () => {
  const ownerRequired = operation('schedules.get');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        { ...ownerRequired, restErrorProjections: [] },
      ]),
    /Missing registry-owned owner REST projector/u,
  );

  const invalidOwner = ownerRequired.restErrorProjections[0];
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...ownerRequired,
          restErrorProjections: [
            {
              ...invalidOwner,
              projector: {
                kind: 'fixed-body',
                body: { error: 'drifted_owner_body' },
              },
            },
          ],
        },
      ]),
    /Invalid fixed REST error body/u,
  );

  const taskCreate = operation('tasks.create');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...taskCreate,
          restErrorProjections: taskCreate.restErrorProjections.filter(
            ({ code }) => code !== 'runtime_model_not_available',
          ),
        },
      ]),
    /Missing runtime-model REST projector/u,
  );

  const runtimeModels = operation('runtimeModels.query');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...runtimeModels,
          restErrorProjections: runtimeModels.restErrorProjections.filter(
            ({ status }) => status !== 503,
          ),
        },
      ]),
    /Incomplete runtime-model catalog REST projection/u,
  );
});

test('the registry gate ties declared MCP differences to real projections', () => {
  const canonical = operation('tasks.get');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...canonical,
          mcp: {
            ...canonical.mcp,
            outputProjection: {
              schema: canonical.responseSchema,
              reason: 'fixture projection',
            },
          },
        },
      ]),
    /MCP success projection decision does not match/u,
  );

  const taskCreate = operation('tasks.create');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...taskCreate,
          mcp: {
            ...taskCreate.mcp,
            differences: taskCreate.mcp.differences.filter(
              (difference) => difference.kind !== 'rest-only-header',
            ),
          },
        },
      ]),
    /MCP REST-only header differences do not match/u,
  );
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...taskCreate,
          mcp: { ...taskCreate.mcp, description: undefined },
        },
      ]),
    /MCP description projection decision does not match/u,
  );

  const transcript = operation('tasks.transcript');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...transcript,
          mcp: {
            ...transcript.mcp,
            differences: transcript.mcp.differences.filter(
              (difference) =>
                difference.kind !== 'mcp-output-schema-relaxation',
            ),
          },
        },
      ]),
    /MCP output schema relaxation decision does not match/u,
  );
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...canonical,
          mcp: {
            ...canonical.mcp,
            differences: [
              ...canonical.mcp.differences,
              {
                kind: 'mcp-output-schema-relaxation',
                reason: 'fixture-only relaxation',
              },
            ],
          },
        },
      ]),
    /MCP output schema relaxation decision does not match/u,
  );
});

test('schedule wire objects own fields and derived parsers preserve behavior', () => {
  assert.equal(
    CreateScheduleRequestSchemaPair.wire,
    CreateScheduleRequestWireSchema,
  );
  assert.equal(CreateScheduleRequestSchemaPair.parse, CreateScheduleRequestSchema);
  assert.equal(
    UpdateScheduleRequestSchemaPair.wire,
    UpdateScheduleRequestWireSchema,
  );
  assert.equal(UpdateScheduleRequestSchemaPair.parse, UpdateScheduleRequestSchema);
  assert.equal(
    DispatchScheduleRequestSchemaPair.wire,
    DispatchScheduleRequestWireSchema,
  );
  assert.equal(
    DispatchScheduleRequestSchemaPair.parse,
    DispatchScheduleRequestSchema,
  );

  const parsed = CreateScheduleRequestSchema.parse({
    recurrence: {
      kind: 'daily',
      time: '09:00',
      timezone: 'Asia/Shanghai',
    },
    taskTemplate: { repoId, prompt: 'daily check' },
  });
  assert.equal(parsed.cronExpression, '0 9 * * *');
  assert.equal(parsed.overlapPolicy, 'skip');
  assert.equal(parsed.misfirePolicy, 'fire-once');
  assert.throws(() =>
    CreateScheduleRequestSchema.parse({
      recurrence: {
        kind: 'daily',
        time: '09:00',
        timezone: 'Asia/Shanghai',
      },
      cronExpression: '0 9 * * *',
      taskTemplate: { repoId, prompt: 'ambiguous timing' },
    }),
  );
  assert.throws(() => UpdateScheduleRequestSchema.parse({}));
  assert.deepEqual(DispatchScheduleRequestSchema.parse(undefined), {});
});

test('schema pairs reject independently authored parse objects', () => {
  const wire = operation('schedules.create').input.body.wire;
  assert.throws(
    () => definePublicSchemaPair(wire, wire.pick({ taskTemplate: true })),
    /derive from its exact wire schema/u,
  );
  assert.doesNotThrow(() =>
    definePublicSchemaPair(
      wire,
      wire.superRefine(() => undefined).transform((value) => value),
    ),
  );
});

test('schema composition derives flattened inputs and rejects collisions', () => {
  const params = operation('schedules.update').input.params.wire;
  const body = operation('schedules.update').input.body.wire;
  const composed = composePublicInputWireSchema(params, body);
  assert.deepEqual(
    Object.keys(composed.shape).sort(),
    [...Object.keys(params.shape), ...Object.keys(body.shape)].sort(),
  );
  assert.throws(
    () => composePublicInputWireSchema(params, params),
    /duplicate field: id/u,
  );
});

test('intentional REST and MCP differences are explicit registry data', () => {
  const taskCreate = operation('tasks.create');
  assert.deepEqual(taskCreate.mcp.inputProjection.omittedHeaders, [
    'Idempotency-Key',
  ]);
  assert.deepEqual(
    taskCreate.mcp.differences.map((difference) => difference.kind),
    [
      'rest-only-header',
      'mcp-compatibility-text',
      'mcp-description-projection',
      'rate-limit-policy',
    ],
  );
  assert.match(taskCreate.mcp.description, /not mapped to a tool argument/u);

  assert.match(operation('tasks.events').mcp.excluded, /SSE is REST-only/u);

  const transcript = operation('tasks.transcript');
  assert.deepEqual(
    transcript.mcp.differences.map((difference) => difference.kind),
    ['mcp-output-schema-relaxation'],
  );
  assert.match(
    transcript.mcp.differences[0].reason,
    /canonical SessionHistory discriminated union/u,
  );

  const scheduleDelete = operation('schedules.delete');
  assert.equal(scheduleDelete.successStatus, 204);
  assert.equal(scheduleDelete.responseSchema, null);
  assert.equal(scheduleDelete.mcp.outputProjection.reason.length > 0, true);
  assert.deepEqual(
    scheduleDelete.mcp.outputProjection.schema.parse({
      id: '22222222-2222-4222-8222-222222222222',
      deleted: true,
    }),
    {
      id: '22222222-2222-4222-8222-222222222222',
      deleted: true,
    },
  );
  assert.equal(PUBLIC_V1_REST_ERROR_PROJECTION.exposesStableCode, false);

  const runtimeModels = operation('runtimeModels.query');
  assert.equal(runtimeModels.errors.includes('rate_limited'), false);
  assert.deepEqual(
    runtimeModels.mcp.differences.map((difference) => difference.kind),
    ['rate-limit-policy'],
  );
  assert.match(
    runtimeModels.mcp.differences[0].reason,
    /dedicated per-principal catalog throttle/u,
  );
  assert.deepEqual(
    runtimeModels.restErrorProjections.map(({ code, status, projector }) => ({
      code,
      status,
      projector: projector.kind,
    })),
    [
      { code: 'owner_required', status: 403, projector: 'fixed-body' },
      {
        code: 'runtime_model_catalog_unavailable',
        status: 429,
        projector: 'runtime-model-domain-error',
      },
      {
        code: 'runtime_model_catalog_unavailable',
        status: 503,
        projector: 'runtime-model-domain-error',
      },
    ],
  );
  assert.deepEqual(
    runtimeModels.restErrorProjections[1].responseSchema.parse({
      code: 'runtime_model_catalog_unavailable',
      message: 'Catalog capacity is temporarily unavailable.',
      retryable: true,
    }),
    {
      code: 'runtime_model_catalog_unavailable',
      message: 'Catalog capacity is temporarily unavailable.',
      retryable: true,
    },
  );

  for (const id of [
    'tasks.create',
    'schedules.create',
    'schedules.update',
  ]) {
    const entry = operation(id);
    assert.equal(entry.errors.includes('temporarily_unavailable'), true);
    const projection = entry.restErrorProjections.find(
      ({ code, status }) =>
        code === 'temporarily_unavailable' && status === 503,
    );
    assert.ok(projection, `${id} declares its runtime readiness 503`);
    assert.deepEqual(
      projection.responseSchema.parse({
        reason: 'runtime not configured',
        runtime: 'claude-code',
        message: 'runtime "claude-code" is not configured',
      }),
      {
        reason: 'runtime not configured',
        runtime: 'claude-code',
        message: 'runtime "claude-code" is not configured',
      },
    );
  }

  for (const entry of PUBLIC_V1_OPERATIONS.filter(
    ({ ownerPolicy }) => ownerPolicy === 'required',
  )) {
    const projection = entry.restErrorProjections.find(
      ({ code }) => code === 'owner_required',
    );
    assert.ok(projection, `${entry.id} declares its owner projection`);
    assert.equal(projection.projector.kind, 'fixed-body');
    if (projection.projector.kind !== 'fixed-body') {
      throw new Error('expected registry-owned fixed owner body');
    }
    assert.deepEqual(
      projection.responseSchema.parse(projection.projector.body),
      projection.projector.body,
    );
  }
});

test('task provisioning diagnostics owns one strict canonical Public V1 registry contract', () => {
  const diagnostics = operation('tasks.provisioningDiagnostics');
  assert.equal(diagnostics.method, 'get');
  assert.equal(
    diagnostics.path,
    '/v1/tasks/{id}/provisioning-diagnostics',
  );
  assert.equal(diagnostics.scope, 'tasks:diagnostics');
  assert.equal(diagnostics.ownerPolicy, 'required');
  assert.equal(diagnostics.streaming, false);
  assert.equal(diagnostics.destructive, false);
  assert.equal(
    diagnostics.restOutputProjection,
    PUBLIC_V1_CANONICAL_REST_SUCCESS_PROJECTION,
  );
  assert.equal(
    diagnostics.input.params,
    TaskProvisioningDiagnosticsParamsSchemaPair,
  );
  assert.equal(
    diagnostics.paramsSchema,
    TaskProvisioningDiagnosticsParamsSchema,
  );
  assert.equal(
    TaskProvisioningDiagnosticsParamsSchemaPair.wire,
    TaskProvisioningDiagnosticsParamsSchema,
  );
  assert.equal(
    TaskProvisioningDiagnosticsParamsSchemaPair.parse,
    TaskProvisioningDiagnosticsParamsSchema,
  );
  assert.equal(
    diagnostics.input.query,
    TaskProvisioningDiagnosticsQuerySchemaPair,
  );
  assert.equal(
    TaskProvisioningDiagnosticsQuerySchemaPair.wire,
    TaskProvisioningDiagnosticsQuerySchema,
  );
  assert.equal(
    TaskProvisioningDiagnosticsQuerySchemaPair.parse,
    TaskProvisioningDiagnosticsQuerySchema,
  );
  assert.equal(
    diagnostics.responseSchema,
    TaskProvisioningDiagnosticsResponseSchema,
  );

  assert.equal(
    diagnostics.input.params.parse.safeParse({ id: repoId, extra: true })
      .success,
    false,
  );
  assert.deepEqual(PublicV1IdParamsSchema.parse({ id: repoId, extra: true }), {
    id: repoId,
  });
  assert.equal(operation('tasks.get').paramsSchema, PublicV1IdParamsSchema);
  assert.deepEqual(diagnostics.input.query.parse.parse({}), { limit: 50 });
  assert.deepEqual(
    diagnostics.input.query.parse.parse({ limit: '200', cursor: 'opaque-1' }),
    { limit: 200, cursor: 'opaque-1' },
  );
  for (const invalid of [
    { limit: 0 },
    { limit: TASK_PROVISIONING_DIAGNOSTIC_MAX_PAGE_SIZE + 1 },
    { cursor: '' },
    { cursor: 'x'.repeat(2_049) },
    { unexpected: true },
  ]) {
    assert.equal(
      diagnostics.input.query.parse.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }

  const canonical = {
    schemaVersion: 1,
    taskId: repoId,
    coverage: 'unavailable',
    admissionState: null,
    attempts: [],
    events: [],
    compaction: null,
    nextCursor: null,
  };
  assert.deepEqual(diagnostics.responseSchema.parse(canonical), canonical);

  assert.deepEqual(diagnostics.additionalErrorStatuses, [404, 503]);
  assert.deepEqual(diagnostics.errors, [
    'validation_failed',
    'insufficient_scope',
    'owner_required',
    'not_found',
    'task_provisioning_diagnostics_unavailable',
  ]);
  const ownerRequired = diagnostics.restErrorProjections.find(
    ({ code }) => code === 'owner_required',
  );
  assert.ok(ownerRequired);
  assert.equal(ownerRequired.status, 403);
  assert.deepEqual(
    ownerRequired.responseSchema.parse(ownerRequired.projector.body),
    {
      code: 'owner_required',
      message:
        'Task provisioning diagnostics require an authenticated account owner.',
      retryable: false,
    },
  );
  const unavailable = diagnostics.restErrorProjections.find(
    ({ code }) =>
      code === 'task_provisioning_diagnostics_unavailable',
  );
  assert.ok(unavailable);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(
    unavailable.responseSchema.parse(unavailable.projector.body),
    {
      code: 'task_provisioning_diagnostics_unavailable',
      message: 'Task provisioning diagnostics are temporarily unavailable.',
      retryable: true,
    },
  );

  assert.equal(diagnostics.mcp.tool, 'get_task_provisioning_diagnostics');
  assert.deepEqual(diagnostics.mcp.inputProjection, {
    sources: ['params', 'query'],
  });
  assert.equal(diagnostics.mcp.outputProjection, 'canonical');
  assert.deepEqual(diagnostics.mcp.differences, []);
});

test('diagnostic response examples are canonical, versioned, paginated, and secret-free', () => {
  const diagnostics = operation('tasks.provisioningDiagnostics');
  assert.deepEqual(Object.keys(diagnostics.responseExamples), [
    'notStarted',
    'partialPrimaryAndCleanup',
    'historicalUnavailable',
  ]);

  const parsed = Object.fromEntries(
    Object.entries(diagnostics.responseExamples).map(([name, example]) => [
      name,
      diagnostics.responseSchema.parse(example.value),
    ]),
  );
  assert.deepEqual(
    Object.values(parsed).map(({ schemaVersion, coverage }) => ({
      schemaVersion,
      coverage,
    })),
    [
      { schemaVersion: 1, coverage: 'not_started' },
      { schemaVersion: 1, coverage: 'partial' },
      { schemaVersion: 1, coverage: 'unavailable' },
    ],
  );

  const partial = parsed.partialPrimaryAndCleanup;
  assert.deepEqual(
    JSON.parse(Buffer.from(partial.nextCursor, 'base64url').toString('utf8')),
    {
      version: 1,
      observedAt: '2026-07-18T01:02:04.600Z',
      eventId: '00000000-0000-4000-8000-000000000304',
    },
  );
  assert.equal(partial.attempts[0].eventCount, 5);
  assert.equal(partial.events.length, 4);
  assert.equal(partial.attempts[0].primary.cause, 'command_failed');
  assert.equal(partial.attempts[0].primary.exitCode, 17);
  assert.equal(partial.attempts[0].cleanup.cause, 'cleanup_failed');
  assert.equal(partial.attempts[0].cleanup.state, 'failed');
  assert.deepEqual(
    partial.events.map(({ channel, outcome, cause }) => ({
      channel,
      outcome,
      cause: cause ?? null,
    })),
    [
      { channel: 'primary', outcome: 'started', cause: null },
      { channel: 'primary', outcome: 'failed', cause: 'command_failed' },
      { channel: 'cleanup', outcome: 'started', cause: null },
      { channel: 'cleanup', outcome: 'failed', cause: 'cleanup_failed' },
    ],
  );

  const wireExamples = JSON.stringify(diagnostics.responseExamples);
  for (const forbidden of [
    'secret-canary',
    'authenticatedGitCommand',
    'providerEndpoint',
    'nativeSandboxId',
    'credentialPath',
    'stdout',
    'stderr',
    'prompt',
    'stack',
    'requestBody',
    'responseBody',
  ]) {
    assert.equal(wireExamples.includes(forbidden), false, forbidden);
  }
});

test('the registry rejects malformed or independently shaped response examples', () => {
  const diagnostics = operation('tasks.provisioningDiagnostics');
  const canonical = diagnostics.responseExamples.notStarted.value;
  for (const [responseExamples, message] of [
    [
      { 'bad name': { summary: 'bad name', value: canonical } },
      /Invalid response example name/u,
    ],
    [
      { invalidSummary: { summary: '   ', value: canonical } },
      /Empty response example summary/u,
    ],
    [
      {
        parallelSchema: {
          summary: 'invalid independently shaped example',
          value: { ...canonical, rawProviderResponse: 'secret-canary' },
        },
      },
      /Invalid response example/u,
    ],
  ]) {
    assert.throws(
      () =>
        assertPublicV1OperationUniqueness([
          { ...diagnostics, responseExamples },
        ]),
      message,
    );
  }

  const deletion = operation('schedules.delete');
  assert.throws(
    () =>
      assertPublicV1OperationUniqueness([
        {
          ...deletion,
          responseExamples: {
            impossible: {
              summary: 'A body cannot be documented for a no-content response.',
              value: { deleted: true },
            },
          },
        },
      ]),
    /Response examples require a response schema/u,
  );
});

test('the fourteen affected operations retain exact registry identities and canonical projections', () => {
  assert.equal(AFFECTED_OPERATION_BINDINGS.length, 14);
  for (const [id, method, route, scope, tool, responseSchema] of AFFECTED_OPERATION_BINDINGS) {
    const entry = operation(id);
    assert.equal(entry.method, method, id);
    assert.equal(entry.path, route, id);
    assert.equal(entry.scope, scope, id);
    assert.equal(entry.responseSchema, responseSchema, id);
    assert.ok('tool' in entry.mcp, `${id} remains MCP mapped`);
    assert.equal(entry.mcp.tool, tool, id);
    assert.equal(entry.mcp.outputProjection, 'canonical', id);

    const guidance = `${entry.description} ${entry.responseDescription}`;
    if (id.startsWith('tasks.')) {
      assert.match(guidance, /provisioning|failure/iu, id);
    } else if (id.startsWith('repos.')) {
      assert.match(guidance, /defaultBranch/u, id);
    } else {
      assert.match(guidance, /taskFailure|task failure/iu, id);
    }
  }
});

test('repository refresh stays outside Public V1 and MCP while task-create keeps exactly four differences', () => {
  const repositoryEntries = PUBLIC_V1_OPERATIONS.filter(({ id }) =>
    id.startsWith('repos.'),
  );
  assert.deepEqual(
    repositoryEntries.map(({ id, method, path }) => ({ id, method, path })),
    [
      { id: 'repos.list', method: 'get', path: '/v1/repos' },
      { id: 'repos.get', method: 'get', path: '/v1/repos/{id}' },
    ],
  );
  assert.deepEqual(
    repositoryEntries.map(({ mcp }) => ('tool' in mcp ? mcp.tool : null)),
    ['list_repos', 'get_repo'],
  );
  assert.equal(
    JSON.stringify(PUBLIC_V1_OPERATIONS).includes('refresh-default-branch'),
    false,
  );
  assert.equal(
    PUBLIC_V1_OPERATIONS.some(
      ({ id, mcp }) =>
        /refresh/iu.test(id) || ('tool' in mcp && /refresh/iu.test(mcp.tool)),
    ),
    false,
  );

  assert.deepEqual(
    operation('tasks.create').mcp.differences.map(({ kind }) => kind),
    [
      'rest-only-header',
      'mcp-compatibility-text',
      'mcp-description-projection',
      'rate-limit-policy',
    ],
  );
});

test('public error envelopes accept only stable codes and safe details', () => {
  assert.deepEqual(
    PublicErrorEnvelopeSchema.parse({
      code: 'rate_limited',
      message: 'Try again later',
      retryable: true,
      details: { retryAfterSeconds: 10, operationId: 'tasks.create' },
    }),
    {
      code: 'rate_limited',
      message: 'Try again later',
      retryable: true,
      details: { retryAfterSeconds: 10, operationId: 'tasks.create' },
    },
  );
  assert.throws(() =>
    PublicErrorEnvelopeSchema.parse({
      code: 'internal_exception',
      message: 'failure',
      retryable: false,
    }),
  );
  assert.deepEqual(
    PublicErrorEnvelopeSchema.parse({
      code: 'task_provisioning_diagnostics_unavailable',
      message: 'Task provisioning diagnostics are temporarily unavailable.',
      retryable: true,
    }),
    {
      code: 'task_provisioning_diagnostics_unavailable',
      message: 'Task provisioning diagnostics are temporarily unavailable.',
      retryable: true,
    },
  );
  for (const forbiddenDetail of [
    { stack: 'Error: secret' },
    { credential: 'token' },
    { providerDiagnostic: 'raw output' },
  ]) {
    assert.throws(() =>
      PublicErrorEnvelopeSchema.parse({
        code: 'temporarily_unavailable',
        message: 'Unavailable',
        retryable: true,
        details: forbiddenDetail,
      }),
    );
  }
});
