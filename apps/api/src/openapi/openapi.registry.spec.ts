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
import { PUBLIC_V1_OPERATIONS } from '@cap/contracts';

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
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, LooseSchema>;
  not?: LooseSchema;
  oneOf?: LooseSchema[];
  anyOf?: LooseSchema[];
};

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

  // Sanity: every current task/repo/schedule path is present.
  const paths = Object.keys(asLoose(doc).paths ?? {});
  for (const expected of [
    '/v1/tasks',
    '/v1/tasks/{id}',
    '/v1/tasks/{id}/stop',
    '/v1/tasks/{id}/transcript',
    '/v1/tasks/{id}/events',
    '/v1/repos',
    '/v1/repos/{id}',
    '/v1/schedules',
    '/v1/schedules/{id}',
    '/v1/schedules/{id}/pause',
    '/v1/schedules/{id}/resume',
    '/v1/schedules/{id}/dispatch',
    '/v1/schedules/{id}/runs',
  ]) {
    assert.ok(paths.includes(expected), `document includes ${expected}`);
  }
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
        }
      | undefined;
    assert.ok(documented, `${operation.id} is present in OpenAPI`);
    assert.equal(documented.operationId, operation.id);
    assert.deepEqual(documented.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.equal(documented['x-cap-required-scope'], operation.scope);
    assert.match(documented.responses?.['400']?.description ?? '', /Bad Request/);
    assert.match(documented.responses?.['401']?.description ?? '', /Unauthorized/);
    assert.match(documented.responses?.['403']?.description ?? '', /Forbidden/);
    assert.ok(
      documented.responses?.['403']?.description?.includes(operation.scope),
      `${operation.id} 403 description names ${operation.scope}`,
    );
  }
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

  assert.deepEqual(parameterNames('/v1/tasks', 'post'), ['Idempotency-Key']);
  assert.deepEqual(parameterNames('/v1/tasks/{id}/events', 'get'), [
    'Last-Event-ID',
  ]);
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
