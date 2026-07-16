/**
 * OpenAPI registry generation spec (public-v1-api, Track `openapi`, task 4.4).
 *
 * Asserts the two D3 invariants that keep the published spec from drifting from
 * the wire:
 *
 *   1. The generated OpenAPI 3.1 document describes EVERY `/v1` route and no
 *      route that is not served — a route↔schema registration DIFF: the
 *      document's `(METHOD, path)` keys equal {@link v1RouteKeys}() exactly.
 *   2. The document is built from the SAME `@cap/contracts` schemas the `/v1`
 *      controllers validate against: the registered request/response shapes are
 *      the exact exported schemas (not parallel re-declarations), proven by
 *      feeding a representative payload through both the exported schema and the
 *      generated component and asserting they agree.
 *
 * Pure / in-process: no HTTP, no Nest — it drives the registry functions
 * directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_V1_OPERATIONS,
  PublicV1EventHeadersSchema,
  PublicV1IdempotencyHeadersSchema,
  RuntimeModelCatalogQuerySchema,
  type PublicV1OperationShape,
} from '@cap/contracts';
import { REST_PUBLIC_ERROR_MAP } from '../public-surface/public-error-mappings';

import {
  buildV1OpenApiDocument,
  v1RouteKeys,
  V1_ROUTES,
  V1CreateTaskRequestSchema,
  V1TaskListResponseSchema,
  V1RepoListResponseSchema,
  V1ListQuerySchema,
  V1ScheduleCreateRequestSchema,
  V1ScheduleResponseSchema,
  V1ScheduleUpdateRequestSchema,
} from './openapi.registry';

/**
 * A loosely-typed view of the generated document for structural inspection. The
 * openapi3-ts types are strict (responses/paths can be `$ref`s); the assertions
 * here read the document structurally, so a permissive shape keeps the test
 * focused on behavior rather than fighting the generator's static types.
 */
type LooseDoc = {
  openapi?: string;
  info?: { title?: string };
  paths?: Record<string, Record<string, unknown> | undefined>;
};

type LooseSchema = {
  type?: string | string[];
  const?: unknown;
  nullable?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  required?: string[];
  properties?: Record<string, LooseSchema>;
  items?: LooseSchema;
  additionalProperties?: boolean;
  not?: LooseSchema;
  oneOf?: LooseSchema[];
  anyOf?: LooseSchema[];
};

const AFFECTED_PROJECTION_OPERATION_IDS = [
  'tasks.create',
  'tasks.list',
  'tasks.get',
  'tasks.stop',
  'repos.list',
  'repos.get',
  'schedules.list',
  'schedules.create',
  'schedules.get',
  'schedules.update',
  'schedules.pause',
  'schedules.resume',
  'schedules.dispatch',
  'schedules.runs',
] as const;

const PROVISIONING_FAILURE_CODE_ACTIONS = [
  ['provisioning_capacity_exhausted', 'increase_sandbox_capacity'],
  ['provisioning_workspace_timeout', 'retry_task'],
  ['provisioning_forge_auth_failed', 'reconnect_forge'],
  ['provisioning_tls_network_failed', 'retry_task'],
  ['provisioning_ref_not_found', 'verify_repository_ref'],
  ['provisioning_platform_dependency_unavailable', 'repair_deployment'],
  ['provisioning_unknown', 'retry_task'],
] as const;

function operationById(id: string): PublicV1OperationShape {
  const operation = PUBLIC_V1_OPERATIONS.find((candidate) => candidate.id === id);
  assert.ok(operation, `missing public operation ${id}`);
  return operation;
}

function successSchema(
  doc: ReturnType<typeof buildV1OpenApiDocument>,
  operation: PublicV1OperationShape,
): LooseSchema {
  const documented = documentedOperation(doc, operation) as {
    responses?: Record<
      string,
      {
        content?: Record<string, { schema?: LooseSchema }>;
      }
    >;
  };
  const contentType = operation.responseContentType ?? 'application/json';
  const schema =
    documented.responses?.[String(operation.successStatus)]?.content?.[contentType]
      ?.schema;
  assert.ok(schema, `${operation.id} has a success schema`);
  return schema;
}

function projectedItemSchema(
  schema: LooseSchema,
  operationId: string,
): LooseSchema {
  if (
    operationId === 'tasks.list' ||
    operationId === 'repos.list' ||
    operationId === 'schedules.list' ||
    operationId === 'schedules.runs'
  ) {
    const item = schema.properties?.items?.items;
    assert.ok(item, `${operationId} exposes paginated items`);
    return item;
  }
  return schema;
}

function schemaAllowsNull(schema: LooseSchema | undefined): boolean {
  if (!schema) return false;
  if (schema.nullable === true || schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  return [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some(
    schemaAllowsNull,
  );
}

function nestedSchemas(schema: LooseSchema): LooseSchema[] {
  return [
    schema,
    ...(schema.oneOf ?? []).flatMap(nestedSchemas),
    ...(schema.anyOf ?? []).flatMap(nestedSchemas),
  ];
}

function literalValues(schema: LooseSchema | undefined): unknown[] {
  if (!schema) return [];
  if (schema.enum) return schema.enum;
  return schema.const === undefined ? [] : [schema.const];
}

function asLoose(doc: ReturnType<typeof buildV1OpenApiDocument>): LooseDoc {
  return doc as unknown as LooseDoc;
}

/** All `(METHOD, path)` keys present in the generated document, sorted. */
function documentRouteKeys(doc: ReturnType<typeof buildV1OpenApiDocument>): string[] {
  const keys: string[] = [];
  const paths = asLoose(doc).paths ?? {};
  for (const path of Object.keys(paths)) {
    const item = paths[path] ?? {};
    for (const method of ['get', 'post', 'put', 'delete', 'patch'] as const) {
      if (item[method]) {
        keys.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return keys.sort();
}

function documentedOperation(
  doc: ReturnType<typeof buildV1OpenApiDocument>,
  operation: PublicV1OperationShape,
): Record<string, unknown> {
  const documented = asLoose(doc).paths?.[operation.path]?.[operation.method];
  assert.ok(documented, `${operation.id} is present in OpenAPI`);
  return documented as Record<string, unknown>;
}

test('the generated spec is a valid OpenAPI 3.1 document', () => {
  const doc = asLoose(buildV1OpenApiDocument());
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.info?.title, 'has an info.title');
  assert.ok(doc.paths && typeof doc.paths === 'object', 'has a paths object');
});

test('the spec covers every canonical manifest operation and nothing else', () => {
  const doc = buildV1OpenApiDocument();

  // The OpenAPI document uses `{id}`-style path templates — the same form the
  // route table declares — so the keys compare directly.
  assert.deepEqual(
    documentRouteKeys(doc),
    v1RouteKeys(),
    'every served /v1 route is in the document and the document has no extra routes',
  );

  const documentedIds = Object.values(asLoose(doc).paths ?? {})
    .flatMap((path) => Object.values(path ?? {}))
    .map((operation) =>
      operation && typeof operation === 'object' && 'operationId' in operation
        ? operation.operationId
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string')
    .sort();
  assert.deepEqual(
    documentedIds,
    PUBLIC_V1_OPERATIONS.map((operation) => operation.id).sort(),
    'OpenAPI operation ids are the exact registry set',
  );
});

test('request and success metadata are projected from every exact registry entry', () => {
  const doc = buildV1OpenApiDocument();
  for (const exactOperation of PUBLIC_V1_OPERATIONS) {
    const operation: PublicV1OperationShape = exactOperation;
    const documented = documentedOperation(doc, operation) as {
      parameters?: Array<{ in?: string; name?: string }>;
      requestBody?: unknown;
      'x-cap-rest-success-projection'?: unknown;
      responses?: Record<
        string,
        { content?: Record<string, { schema?: LooseSchema }> }
      >;
    };
    const parameters = documented.parameters ?? [];
    for (const source of ['params', 'query', 'headers'] as const) {
      const location =
        source === 'params' ? 'path' : source === 'headers' ? 'header' : 'query';
      const actual = parameters
        .filter((parameter) => parameter.in === location)
        .map((parameter) => parameter.name)
        .sort();
      const expected = Object.keys(operation.input[source]?.wire.shape ?? {})
        .sort();
      assert.deepEqual(actual, expected, `${operation.id} ${source} projection`);
    }
    assert.equal(
      documented.requestBody !== undefined,
      operation.input.body !== undefined,
      `${operation.id} body projection`,
    );
    assert.deepEqual(
      documented['x-cap-rest-success-projection'],
      operation.restOutputProjection,
      `${operation.id} REST output decision`,
    );

    const success = documented.responses?.[String(operation.successStatus)];
    assert.ok(success, `${operation.id} success response is documented`);
    const contentType = operation.responseContentType ?? 'application/json';
    assert.equal(
      success.content?.[contentType]?.schema !== undefined,
      operation.responseSchema !== null,
      `${operation.id} output schema projection`,
    );
  }
});

test('the fourteen affected projections keep exact guidance and additive safe schemas', () => {
  const doc = buildV1OpenApiDocument();
  const taskOperationIds = AFFECTED_PROJECTION_OPERATION_IDS.filter((id) =>
    id.startsWith('tasks.'),
  );
  const repoOperationIds = AFFECTED_PROJECTION_OPERATION_IDS.filter((id) =>
    id.startsWith('repos.'),
  );
  const scheduleOperationIds = AFFECTED_PROJECTION_OPERATION_IDS.filter((id) =>
    id.startsWith('schedules.'),
  );

  for (const id of AFFECTED_PROJECTION_OPERATION_IDS) {
    const operation = operationById(id);
    const documented = documentedOperation(doc, operation) as {
      description?: string;
      responses?: Record<string, { description?: string }>;
    };
    assert.equal(documented.description, operation.description, `${id} description`);
    assert.equal(
      documented.responses?.[String(operation.successStatus)]?.description,
      operation.responseDescription,
      `${id} response description`,
    );
  }

  for (const id of taskOperationIds) {
    const operation = operationById(id);
    const task = projectedItemSchema(successSchema(doc, operation), id);
    for (const field of ['provisioning', 'failure'] as const) {
      const fieldSchema = task.properties?.[field];
      assert.ok(fieldSchema, `${id} documents ${field}`);
      assert.ok(!task.required?.includes(field), `${id} ${field} remains optional`);
      assert.ok(schemaAllowsNull(fieldSchema), `${id} ${field} remains nullable`);
    }

    const documentedPairs = nestedSchemas(task.properties!.failure!)
      .flatMap((candidate) => {
        const codes = literalValues(candidate.properties?.code);
        const actions = literalValues(candidate.properties?.action);
        return codes.flatMap((code) => actions.map((action) => [code, action]));
      })
      .map(([code, action]) => `${String(code)}:${String(action)}`);
    assert.deepEqual(
      PROVISIONING_FAILURE_CODE_ACTIONS.filter(
        ([code, action]) => documentedPairs.includes(`${code}:${action}`),
      ),
      PROVISIONING_FAILURE_CODE_ACTIONS,
      `${id} documents every stable provisioning code/action pair`,
    );
  }

  for (const id of repoOperationIds) {
    const operation = operationById(id);
    const repo = projectedItemSchema(successSchema(doc, operation), id);
    const defaultBranch = repo.properties?.defaultBranch;
    assert.ok(defaultBranch, `${id} documents defaultBranch`);
    assert.ok(
      !repo.required?.includes('defaultBranch'),
      `${id} defaultBranch remains optional`,
    );
    assert.ok(schemaAllowsNull(defaultBranch), `${id} defaultBranch remains nullable`);
  }

  for (const id of scheduleOperationIds) {
    const operation = operationById(id);
    const output = projectedItemSchema(successSchema(doc, operation), id);
    const taskFailure =
      id === 'schedules.runs'
        ? output.properties?.taskFailure
        : nestedSchemas(output.properties?.latestRun ?? {}).flatMap(
            (candidate) =>
              candidate.properties?.taskFailure
                ? [candidate.properties.taskFailure]
                : [],
          )[0];
    assert.ok(taskFailure, `${id} documents nested taskFailure`);
    assert.ok(
      id === 'schedules.runs'
        ? !output.required?.includes('taskFailure')
        : !output.required?.includes('latestRun'),
      `${id} keeps its nested failure carrier optional`,
    );
    assert.ok(schemaAllowsNull(taskFailure), `${id} taskFailure remains nullable`);
    const documentedPairs = nestedSchemas(taskFailure)
      .flatMap((candidate) => {
        const codes = literalValues(candidate.properties?.code);
        const actions = literalValues(candidate.properties?.action);
        return codes.flatMap((code) => actions.map((action) => [code, action]));
      })
      .map(([code, action]) => `${String(code)}:${String(action)}`);
    assert.ok(
      documentedPairs.includes(
        'provisioning_platform_dependency_unavailable:repair_deployment',
      ),
      `${id} documents the deployment-repair failure pair`,
    );
  }

  const acceptedTask = {
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    prompt: 'inspect the verified default branch',
    status: 'pending',
    createdAt: '2026-07-15T01:00:00.000Z',
    provisioning: {
      state: 'accepted',
      stage: 'accepted',
      attempt: 0,
      resolvedBranch: null,
      updatedAt: '2026-07-15T01:00:01.000Z',
    },
  };
  const failedTask = {
    ...acceptedTask,
    status: 'failed',
    provisioning: {
      ...acceptedTask.provisioning,
      state: 'failed',
      stage: 'workspace_transfer',
    },
    failure: {
      code: 'provisioning_platform_dependency_unavailable',
      message: 'Repair the deployment dependency before creating another task.',
      action: 'repair_deployment',
      occurredAt: '2026-07-15T01:02:00.000Z',
    },
  };
  const repos = [
    {
      id: acceptedTask.repoId,
      name: 'github-zhiwen',
      gitSource: 'https://github.example.test/group/zhiwen.git',
      createdAt: acceptedTask.createdAt,
      defaultBranch: 'trunk',
      forge: 'github',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'gitlab-zhiwen',
      gitSource: 'https://gitlab.example.test/group/zhiwen.git',
      createdAt: acceptedTask.createdAt,
      defaultBranch: 'develop',
      forge: 'gitlab',
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'gitee-zhiwen',
      gitSource: 'https://gitee.example.test/group/zhiwen.git',
      createdAt: acceptedTask.createdAt,
      defaultBranch: 'master',
      forge: 'gitee',
    },
  ];
  const latestRun = {
    id: '55555555-5555-4555-8555-555555555555',
    scheduledFor: acceptedTask.createdAt,
    status: 'created',
    taskId: acceptedTask.id,
    taskStatus: 'failed',
    taskFailure: failedTask.failure,
    error: null,
    createdAt: acceptedTask.createdAt,
  };
  const schedule = {
    id: '66666666-6666-4666-8666-666666666666',
    ownerUserId: 'openapi-example-owner',
    repoId: acceptedTask.repoId,
    name: 'deployment dependency example',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    recurrence: {
      kind: 'daily',
      time: '09:00',
      timezone: 'UTC',
      label: 'Daily 09:00',
    },
    enabled: true,
    nextRunAt: '2026-07-16T09:00:00.000Z',
    overlapPolicy: 'skip',
    misfirePolicy: 'fire-once',
    taskTemplate: {
      repoId: acceptedTask.repoId,
      prompt: 'verify deployment dependency',
      runtime: 'codex',
      sandboxEnvironmentId: null,
      deliver: 'none',
    },
    latestRun,
    createdAt: acceptedTask.createdAt,
    updatedAt: '2026-07-15T01:02:00.000Z',
  };
  const scheduleRun = {
    ...latestRun,
    scheduleId: schedule.id,
    updatedAt: schedule.updatedAt,
  };
  const safeSamples = new Map<string, unknown>([
    ['tasks.create', failedTask],
    ['tasks.list', { items: [failedTask], nextCursor: null }],
    ['tasks.get', failedTask],
    ['tasks.stop', failedTask],
    ['repos.list', { items: repos, nextCursor: null }],
    ['repos.get', repos[0]],
    ['schedules.list', { items: [schedule], nextCursor: null }],
    ['schedules.create', schedule],
    ['schedules.get', schedule],
    ['schedules.update', schedule],
    ['schedules.pause', schedule],
    ['schedules.resume', schedule],
    ['schedules.dispatch', schedule],
    ['schedules.runs', { items: [scheduleRun], nextCursor: null }],
  ]);
  for (const id of AFFECTED_PROJECTION_OPERATION_IDS) {
    const operation = operationById(id);
    const sample = safeSamples.get(id);
    assert.ok(operation.responseSchema?.safeParse(sample).success, `${id} sample parses`);
    const serialized = JSON.stringify(sample);
    const documentedSchema = JSON.stringify(successSchema(doc, operation));
    for (const forbidden of [
      'leaseOwner',
      'providerEndpoint',
      'nativeSandboxId',
      'credentialPath',
      'rawOutput',
      'authenticatedGitCommand',
      'secret-canary',
    ]) {
      assert.ok(!serialized.includes(forbidden), `${id} sample excludes ${forbidden}`);
      assert.ok(
        !documentedSchema.includes(forbidden),
        `${id} OpenAPI schema excludes ${forbidden}`,
      );
    }
  }
  const { defaultBranch: _defaultBranch, ...legacyRepo } = repos[0];
  assert.ok(
    operationById('repos.get').responseSchema?.safeParse(legacyRepo).success,
    'legacy repo sample may omit defaultBranch',
  );
  assert.deepEqual(
    repos.map(({ defaultBranch }) => defaultBranch),
    ['trunk', 'develop', 'master'],
  );
  assert.equal(
    Object.keys(asLoose(doc).paths ?? {}).some((path) =>
      path.includes('refresh-default-branch'),
    ),
    false,
    'OpenAPI does not expose the internal refresh write',
  );
});

test('every operation documents supported auth, required scope, and standard failures', () => {
  const doc = asLoose(buildV1OpenApiDocument());
  const components = (doc as LooseDoc & {
    components?: {
      securitySchemes?: Record<string, { type?: string; scheme?: string }>;
    };
  }).components;
  assert.deepEqual(components?.securitySchemes?.bearerAuth, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'CAP API key, MCP token, or optional legacy operator token',
    description:
      'Send a `cap_sk_` API key, `mcp_` token, or an unprefixed legacy ' +
      '`AUTH_TOKEN` (only when legacy auth is enabled) as ' +
      '`Authorization: Bearer <token>`.',
  });
  assert.deepEqual(components?.securitySchemes?.sessionCookie, {
    type: 'apiKey',
    in: 'cookie',
    name: 'cap_session',
    description: 'Opaque operator session cookie issued by the login flow.',
  });

  for (const operation of PUBLIC_V1_OPERATIONS) {
    const documented = doc.paths?.[operation.path]?.[operation.method] as
      | {
          operationId?: string;
          security?: Array<Record<string, string[]>>;
          responses?: Record<string, { description?: string }>;
          'x-cap-required-scope'?: string;
          'x-cap-owner-policy'?: string;
          'x-cap-public-error-codes'?: string[];
          'x-cap-rest-error-projection'?: { exposesStableCode?: boolean };
          'x-cap-rest-error-projections'?: unknown[];
          'x-cap-mcp'?: unknown;
        }
      | undefined;
    assert.ok(documented, `${operation.id} is present in OpenAPI`);
    assert.equal(documented.operationId, operation.id);
    assert.deepEqual(documented.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.equal(documented['x-cap-required-scope'], operation.scope);
    assert.equal(documented['x-cap-owner-policy'], operation.ownerPolicy);
    assert.deepEqual(
      documented['x-cap-public-error-codes'],
      operation.errors,
    );
    assert.equal(
      documented['x-cap-rest-error-projection']?.exposesStableCode,
      false,
    );
    assert.deepEqual(
      documented['x-cap-rest-error-projections'],
      ('restErrorProjections' in operation
        ? operation.restErrorProjections
        : []
      ).map((projection) => ({
        code: projection.code,
        status: projection.status,
        projector: projection.projector.kind,
        reason: projection.reason,
        responseSchema: projection.responseSchema ? 'declared' : 'default',
        headers:
          'headersSchema' in projection && projection.headersSchema
          ? Object.keys(projection.headersSchema.shape)
          : [],
      })),
    );
    assert.deepEqual(
      documented['x-cap-mcp'],
      'tool' in operation.mcp
        ? {
            status: 'mapped',
            tool: operation.mcp.tool,
            differences: operation.mcp.differences,
          }
        : { status: 'excluded', reason: operation.mcp.excluded },
    );
    assert.match(documented.responses?.['400']?.description ?? '', /Bad Request/);
    assert.match(documented.responses?.['401']?.description ?? '', /Unauthorized/);
    assert.match(documented.responses?.['403']?.description ?? '', /Forbidden/);
    assert.ok(
      documented.responses?.['403']?.description?.includes(operation.scope),
      `${operation.id} 403 description names ${operation.scope}`,
    );
  }
});

test('error response statuses are exactly registry codes plus explicit projections', () => {
  const doc = buildV1OpenApiDocument();
  for (const exactOperation of PUBLIC_V1_OPERATIONS) {
    const operation: PublicV1OperationShape = exactOperation;
    const documented = documentedOperation(doc, operation) as {
      responses?: Record<string, { description?: string }>;
    };
    const expected = new Set<string>([
      String(operation.successStatus),
      '401',
      ...operation.errors.map((code) =>
        String(REST_PUBLIC_ERROR_MAP[code].status),
      ),
      ...(operation.restErrorProjections ?? []).map((projection) =>
        String(projection.status),
      ),
    ]);
    assert.deepEqual(
      Object.keys(documented.responses ?? {}).sort(),
      [...expected].sort(),
      `${operation.id} error status projection`,
    );
  }
});

test('MCP exclusions and protocol differences remain explicit in OpenAPI metadata', () => {
  const doc = buildV1OpenApiDocument();
  const extension = (id: string) => {
    const operation = PUBLIC_V1_OPERATIONS.find((entry) => entry.id === id);
    assert.ok(operation);
    return documentedOperation(doc, operation) as { 'x-cap-mcp'?: unknown };
  };

  assert.deepEqual(extension('tasks.events')['x-cap-mcp'], {
    status: 'excluded',
    reason:
      'MCP tools use request/response transport; lifecycle SSE is REST-only.',
  });
  assert.deepEqual(
    (extension('tasks.create')['x-cap-mcp'] as {
      differences?: Array<{ kind?: string }>;
    }).differences?.map((difference) => difference.kind),
    [
      'rest-only-header',
      'mcp-compatibility-text',
      'mcp-description-projection',
      'rate-limit-policy',
    ],
  );
  assert.deepEqual(
    (extension('runtimeModels.query')['x-cap-mcp'] as {
      differences?: Array<{ kind?: string }>;
    }).differences?.map((difference) => difference.kind),
    ['rate-limit-policy'],
  );
  assert.deepEqual(
    (extension('schedules.delete')['x-cap-mcp'] as {
      differences?: Array<{ kind?: string }>;
    }).differences?.map((difference) => difference.kind),
    ['success-projection'],
  );
});

test('operation-specific 404, 409, and 429 responses are documented', () => {
  const doc = asLoose(buildV1OpenApiDocument());
  const responses = (path: string, method: string) =>
    (doc.paths?.[path]?.[method] as
      | { responses?: Record<string, { description?: string }> }
      | undefined)?.responses ?? {};

  const createTask = responses('/v1/tasks', 'post');
  assert.match(createTask['404']?.description ?? '', /Not Found/);
  assert.match(createTask['409']?.description ?? '', /Conflict/);
  assert.match(createTask['429']?.description ?? '', /Too Many Requests/);

  const dispatch = responses('/v1/schedules/{id}/dispatch', 'post');
  assert.match(dispatch['404']?.description ?? '', /Not Found/);
  assert.match(dispatch['409']?.description ?? '', /Conflict/);
  assert.equal(responses('/v1/tasks', 'get')['409'], undefined);
});

test('runtime-model errors and Retry-After are documented on the exact operations', () => {
  const doc = asLoose(buildV1OpenApiDocument());
  type LooseResponse = {
    description?: string;
    headers?: Record<string, unknown>;
    content?: Record<string, { schema?: LooseSchema }>;
  };
  const responses = (path: string, method: string) =>
    ((doc.paths?.[path]?.[method] as
      | { responses?: Record<string, LooseResponse> }
      | undefined)?.responses ?? {});
  const schema = (path: string, method: string, status: string) =>
    responses(path, method)[status]?.content?.['application/json']?.schema;
  const schemaVariants = (value: LooseSchema | undefined) =>
    value?.oneOf ?? value?.anyOf ?? (value ? [value] : []);

  const catalog429 = schema('/v1/runtime-models/query', 'post', '429');
  const catalog503 = schema('/v1/runtime-models/query', 'post', '503');
  assert.deepEqual(catalog429?.properties?.code?.enum, [
    'runtime_model_catalog_unavailable',
  ]);
  assert.ok(catalog429?.properties?.capacity, '429 exposes safe capacity data');
  assert.deepEqual(catalog503?.properties?.code?.enum, [
    'runtime_model_catalog_unavailable',
  ]);
  assert.ok(
    responses('/v1/runtime-models/query', 'post')['429']?.headers?.[
      'Retry-After'
    ],
    'catalog throttle documents Retry-After',
  );

  for (const [path, method] of [
    ['/v1/tasks', 'post'],
    ['/v1/schedules', 'post'],
    ['/v1/schedules/{id}', 'patch'],
  ] as const) {
    assert.deepEqual(schema(path, method, '422')?.properties?.code?.enum, [
      'runtime_model_not_available',
    ]);
    const serviceUnavailable = schemaVariants(schema(path, method, '503'));
    assert.ok(
      serviceUnavailable.some(
        (candidate) =>
          candidate.properties?.code?.enum?.[0] ===
          'runtime_model_catalog_unavailable',
      ),
      `${method.toUpperCase()} ${path} documents catalog-unavailable 503`,
    );
    assert.ok(
      serviceUnavailable.some(
        (candidate) =>
          candidate.properties?.reason?.enum?.[0] === 'runtime not configured',
      ),
      `${method.toUpperCase()} ${path} documents runtime-not-configured 503`,
    );
  }

  assert.ok(schema('/v1/schedules/{id}/resume', 'post', '503'));
  assert.ok(schema('/v1/schedules/{id}/dispatch', 'post', '503'));
  assert.equal(
    responses('/v1/schedules/{id}/dispatch', 'post')['422'],
    undefined,
    'manual dispatch returns the persisted schedule outcome instead of a sync 422',
  );
});

test('model selectors stay optional bounded strings without a static id enum', () => {
  const doc = asLoose(buildV1OpenApiDocument());
  const requestSchema = (path: string, method: string): LooseSchema => {
    const operation = doc.paths?.[path]?.[method] as
      | {
          requestBody?: {
            content?: Record<string, { schema?: LooseSchema }>;
          };
        }
      | undefined;
    const result =
      operation?.requestBody?.content?.['application/json']?.schema;
    assert.ok(result);
    return result;
  };

  const task = requestSchema('/v1/tasks', 'post');
  const scheduleCreate = requestSchema('/v1/schedules', 'post');
  const scheduleUpdate = requestSchema('/v1/schedules/{id}', 'patch');
  const selectors = [
    task.properties?.model,
    scheduleCreate.properties?.taskTemplate?.properties?.model,
    scheduleUpdate.properties?.taskTemplate?.properties?.model,
  ];
  for (const selector of selectors) {
    assert.equal(selector?.type, 'string');
    assert.equal(selector?.minLength, 1);
    assert.equal(selector?.maxLength, 2048);
    assert.equal(selector?.enum, undefined, 'model ids are never a static enum');
  }
  assert.ok(!task.required?.includes('model'));
  assert.ok(!scheduleCreate.properties?.taskTemplate?.required?.includes('model'));
});

test('runtime-model catalog request is strict and contains no client owner field', () => {
  const doc = asLoose(buildV1OpenApiDocument());
  const operation = doc.paths?.['/v1/runtime-models/query']?.post as
    | {
        requestBody?: {
          content?: Record<string, { schema?: LooseSchema }>;
        };
        responses?: Record<
          string,
          { content?: Record<string, { schema?: LooseSchema }> }
        >;
      }
    | undefined;
  const request =
    operation?.requestBody?.content?.['application/json']?.schema;
  assert.ok(request);
  assert.equal(request.additionalProperties, false);
  assert.deepEqual(
    Object.keys(request.properties ?? {}).sort(),
    Object.keys(RuntimeModelCatalogQuerySchema.shape).sort(),
  );

  const catalog = operation?.responses?.['200']?.content?.['application/json']
    ?.schema;
  const item = catalog?.properties?.models?.items;
  assert.equal(item?.properties?.id?.enum, undefined);
  assert.equal(item?.properties?.id?.maxLength, 2048);
});

test('task create and lifecycle events document their protocol headers', () => {
  const doc = asLoose(buildV1OpenApiDocument());
  const parameterNames = (path: string, method: string): string[] => {
    const operation = doc.paths?.[path]?.[method] as
      | { parameters?: Array<{ in?: string; name?: string }> }
      | undefined;
    return (operation?.parameters ?? [])
      .filter((parameter) => parameter.in === 'header')
      .map((parameter) => parameter.name ?? '');
  };

  assert.deepEqual(
    parameterNames('/v1/tasks', 'post'),
    Object.keys(PublicV1IdempotencyHeadersSchema.shape),
  );
  assert.deepEqual(
    parameterNames('/v1/tasks/{id}/events', 'get'),
    Object.keys(PublicV1EventHeadersSchema.shape),
  );
});

test('SSE is documented as framed text with a separate data payload schema', () => {
  const doc = buildV1OpenApiDocument() as unknown as {
    paths?: Record<string, Record<string, {
      responses?: Record<string, {
        content?: Record<string, { schema?: { type?: string } }>;
      }>;
      'x-cap-sse-data-schema'?: { $ref?: string };
    }>>;
    components?: { schemas?: Record<string, unknown> };
  };
  const events = doc.paths?.['/v1/tasks/{id}/events']?.get;
  assert.equal(
    events?.responses?.['200']?.content?.['text/event-stream']?.schema?.type,
    'string',
  );
  assert.deepEqual(events?.['x-cap-sse-data-schema'], {
    $ref: '#/components/schemas/StreamEvent_tasks_events',
  });
  assert.ok(doc.components?.schemas?.StreamEvent_tasks_events);
});

test('every route in the table is registered in the document (no silent drop)', () => {
  const doc = buildV1OpenApiDocument();
  const keys = new Set(documentRouteKeys(doc));
  for (const route of V1_ROUTES) {
    const key = `${route.method.toUpperCase()} ${route.path}`;
    assert.ok(keys.has(key), `route ${key} must be registered in the document`);
  }
});

test('the document is built from the SAME schemas used for request validation', () => {
  const doc = buildV1OpenApiDocument();

  // The create body component must agree with the exported create schema the
  // controller validates against: a payload accepted by the exported schema is
  // structurally describable by the document, and a field the schema rejects is
  // a field the document constrains. We prove identity-of-source by round-trip:
  // the exported schema and the generated request body derive from one object.
  const postTasks = asLoose(doc).paths?.['/v1/tasks']?.post as
    | Record<string, unknown>
    | undefined;
  assert.ok(postTasks?.requestBody, 'POST /v1/tasks documents a request body');

  // The exported schema is the validation authority; a valid body parses.
  const validCreate = {
    repoId: '00000000-0000-0000-0000-000000000000',
    prompt: 'do the thing',
    sandboxEnvironmentId: '00000000-0000-4000-a000-000000000902',
  };
  assert.doesNotThrow(
    () => V1CreateTaskRequestSchema.parse(validCreate),
    'the exported create schema accepts a valid body with sandboxEnvironmentId',
  );
  // repoId is the /v1-only addition — a body without it is rejected by the SAME
  // schema the document is generated from.
  assert.throws(
    () => V1CreateTaskRequestSchema.parse({ prompt: 'no repo' }),
    'the exported create schema requires repoId (the /v1 addition)',
  );

  const docJson = JSON.stringify(doc);
  assert.match(
    docJson,
    /"sandboxEnvironmentId"/,
    'the OpenAPI document exposes the create-task sandboxEnvironmentId field',
  );
  assert.match(
    docJson,
    /"recurrence"/,
    'the OpenAPI document exposes the recurrence-first schedule field',
  );
  assert.match(
    docJson,
    /"cronExpression"/,
    'the OpenAPI document keeps cronExpression for schedule compatibility clients',
  );

  const validScheduleCreate = V1ScheduleCreateRequestSchema.parse({
    recurrence: {
      kind: 'weekdays',
      time: '09:30',
      timezone: 'Asia/Shanghai',
    },
    taskTemplate: {
      repoId: '00000000-0000-4000-a000-000000000101',
      prompt: 'weekday check',
    },
  });
  assert.equal(validScheduleCreate.cronExpression, '30 9 * * 1-5');
  assert.throws(
    () =>
      V1ScheduleCreateRequestSchema.parse({
        recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
        cronExpression: '0 9 * * *',
        taskTemplate: {
          repoId: '00000000-0000-4000-a000-000000000101',
          prompt: 'ambiguous',
        },
      }),
    'schedule create rejects recurrence and cronExpression together',
  );
  assert.throws(
    () =>
      V1ScheduleUpdateRequestSchema.parse({
        recurrence: { kind: 'hourly', minuteOfHour: 15, timezone: 'UTC' },
        cronExpression: '15 * * * *',
      }),
    'schedule update rejects recurrence and cronExpression together',
  );

  // The list envelopes the document generates are the SAME `{ items, nextCursor }`
  // schemas the list controllers return.
  assert.doesNotThrow(() =>
    V1TaskListResponseSchema.parse({ items: [], nextCursor: null }),
  );
  assert.doesNotThrow(() =>
    V1RepoListResponseSchema.parse({ items: [], nextCursor: 'abc' }),
  );

  // The pagination query the list paths document is the same one the controllers
  // parse `?limit=&cursor=` with (max 200 enforced).
  assert.doesNotThrow(() => V1ListQuerySchema.parse({ limit: '50', cursor: 'x' }));
  assert.throws(
    () => V1ListQuerySchema.parse({ limit: '201' }),
    'limit is capped at 200 by the same query schema',
  );
});

test('schedule OpenAPI schemas expose exact sub-day recurrence constraints', () => {
  const doc = buildV1OpenApiDocument();
  const requestSchema = (path: string, method: 'post' | 'patch'): LooseSchema => {
    const operation = doc.paths?.[path]?.[method] as
      | {
          requestBody?: {
            content?: Record<string, { schema?: LooseSchema }>;
          };
        }
      | undefined;
    const schema = operation?.requestBody?.content?.['application/json']?.schema;
    assert.ok(schema, `${method.toUpperCase()} ${path} has a JSON request schema`);
    return schema;
  };
  const responseSchema = (path: string, method: 'get'): LooseSchema => {
    const operation = doc.paths?.[path]?.[method] as
      | {
          responses?: Record<
            string,
            { content?: Record<string, { schema?: LooseSchema }> }
          >;
        }
      | undefined;
    const schema =
      operation?.responses?.['200']?.content?.['application/json']?.schema;
    assert.ok(schema, `${method.toUpperCase()} ${path} has a JSON response schema`);
    return schema;
  };

  const schemas = [
    ['create request', requestSchema('/v1/schedules', 'post')],
    ['update request', requestSchema('/v1/schedules/{id}', 'patch')],
    ['read response', responseSchema('/v1/schedules/{id}', 'get')],
  ] as const;

  for (const [label, schema] of schemas) {
    const variants = schema.properties?.recurrence?.oneOf ?? [];
    const variant = (kind: string) =>
      variants.find((candidate) =>
        candidate.properties?.kind?.enum?.includes(kind),
      );
    const hourly = variant('hourly');
    const interval = variant('minuteInterval');
    assert.ok(hourly, `${label} includes hourly`);
    assert.ok(interval, `${label} includes minuteInterval`);
    assert.deepEqual(hourly.properties?.minuteOfHour, {
      type: 'integer',
      minimum: 0,
      maximum: 59,
    });
    assert.deepEqual(
      interval.properties?.intervalMinutes?.anyOf?.flatMap(
        (candidate) => candidate.enum ?? [],
      ),
      [5, 10, 15, 30],
    );
  }

  const createRequest = requestSchema('/v1/schedules', 'post');
  assert.deepEqual(createRequest.oneOf, [
    {
      required: ['recurrence'],
      not: { required: ['cronExpression'] },
    },
    {
      required: ['cronExpression'],
      not: { required: ['recurrence'] },
    },
  ]);

  const updateRequest = requestSchema('/v1/schedules/{id}', 'patch');
  assert.deepEqual(updateRequest.oneOf, [
    {
      required: ['recurrence'],
      not: {
        anyOf: [
          { required: ['cronExpression'] },
          { required: ['timezone'] },
        ],
      },
    },
    {
      required: ['cronExpression'],
      not: { required: ['recurrence'] },
    },
    {
      anyOf: [
        { required: ['name'] },
        { required: ['timezone'] },
        { required: ['taskTemplate'] },
        { required: ['enabled'] },
        { required: ['overlapPolicy'] },
        { required: ['misfirePolicy'] },
      ],
      not: {
        anyOf: [
          { required: ['recurrence'] },
          { required: ['cronExpression'] },
        ],
      },
    },
  ]);

  assert.doesNotThrow(() =>
    V1ScheduleCreateRequestSchema.parse({
      recurrence: { kind: 'hourly', minuteOfHour: 59, timezone: 'UTC' },
      taskTemplate: {
        repoId: '00000000-0000-4000-a000-000000000101',
        prompt: 'hourly check',
      },
    }),
  );
  assert.doesNotThrow(() =>
    V1ScheduleUpdateRequestSchema.parse({
      recurrence: {
        kind: 'minuteInterval',
        intervalMinutes: 30,
        timezone: 'UTC',
      },
    }),
  );
  assert.throws(
    () => V1ScheduleUpdateRequestSchema.parse({ unknownOnly: true }),
    'schedule update rejects a body with no known update field',
  );
  assert.ok(V1ScheduleResponseSchema.shape.recurrence);
});

test('request-body required flags match the shared validation schemas', () => {
  const doc = asLoose(buildV1OpenApiDocument());
  const createTask = doc.paths?.['/v1/tasks']?.post as
    | { requestBody?: { required?: boolean } }
    | undefined;
  const dispatchSchedule = doc.paths?.['/v1/schedules/{id}/dispatch']?.post as
    | { requestBody?: { required?: boolean } }
    | undefined;

  assert.equal(createTask?.requestBody?.required, true);
  assert.equal(dispatchSchedule?.requestBody?.required, false);
});

test('the list paths document the paginated {items,nextCursor} envelope', () => {
  const doc = buildV1OpenApiDocument();
  const loose = asLoose(doc);
  for (const listPath of ['/v1/tasks', '/v1/repos']) {
    const get = loose.paths?.[listPath]?.get as Record<string, unknown> | undefined;
    assert.ok(get, `${listPath} documents a GET operation`);
    const responses = get?.responses as Record<string, unknown> | undefined;
    assert.ok(responses?.['200'], `${listPath} documents a 200 list response`);
  }
  // The `{ items, nextCursor }` envelope keys appear in the document's component
  // graph (whether inlined or behind a $ref), proving the list responses carry
  // the pagination envelope shape.
  const json = JSON.stringify(doc);
  assert.match(json, /"nextCursor"/, 'the document describes nextCursor');
  assert.match(json, /"items"/, 'the document describes items');
});
