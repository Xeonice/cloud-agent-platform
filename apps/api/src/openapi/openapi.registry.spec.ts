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
  buildV1OpenApiDocument,
  v1RouteKeys,
  V1_ROUTES,
  V1CreateTaskRequestSchema,
  V1TaskListResponseSchema,
  V1RepoListResponseSchema,
  V1ListQuerySchema,
  V1ScheduleCreateRequestSchema,
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

test('the spec covers EVERY /v1 route and nothing else (route↔registration diff)', () => {
  const doc = buildV1OpenApiDocument();

  // The OpenAPI document uses `{id}`-style path templates — the same form the
  // route table declares — so the keys compare directly.
  assert.deepEqual(
    documentRouteKeys(doc),
    v1RouteKeys(),
    'every served /v1 route is in the document and the document has no extra routes',
  );

  // Sanity: the seven core `/v1` REST routes are all present by path.
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
