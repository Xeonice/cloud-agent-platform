/**
 * Guards the public-v1-api ADDITIVE invariant (public-v1-api spec, D2 / task 1.2):
 * adding the `/v1` DTOs (`V1CreateTaskRequestSchema`, the paginated list
 * envelopes, the list query, the SSE event shape) MUST NOT mutate the console
 * schemas (`CreateTaskRequestSchema` / `ListTasksResponseSchema` /
 * `ListReposResponseSchema`) that `apps/web` imports. "Byte-unchanged" is proven
 * behaviourally against the REAL compiled zod schemas in dist/: the console
 * create body still rejects the `/v1`-only `repoId` (it is stripped, never
 * required), the console list responses are still bare arrays (not the `/v1`
 * `{ items, nextCursor }` envelope), and the `/v1` shapes themselves carry the
 * additions.
 *
 * Requires `pnpm --filter @cap/contracts build` first. Run: `node v1.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const contracts = require(path.join(here, '..', 'dist', 'index.js'));

const {
  // console schemas (must stay byte-unchanged)
  CreateTaskRequestSchema,
  ListTasksResponseSchema,
  ListReposResponseSchema,
  // /v1 additions
  V1CreateTaskRequestSchema,
  V1ListTasksResponseSchema,
  V1ListReposResponseSchema,
  V1ListQuerySchema,
  V1TaskEventSchema,
  V1_LIST_DEFAULT_LIMIT,
  V1_LIST_MAX_LIMIT,
} = contracts;

const repoId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const repoRow = {
  id: repoId,
  name: 'demo',
  gitSource: 'https://example.com/demo.git',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};
const taskRow = {
  id: taskId,
  repoId,
  prompt: 'do the thing',
  status: 'pending',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// Console CreateTaskRequestSchema is byte-unchanged
// ---------------------------------------------------------------------------

test('console CreateTaskRequestSchema still parses the same minimal body', () => {
  const parsed = CreateTaskRequestSchema.parse({ prompt: 'hi' });
  assert.deepEqual(parsed, { prompt: 'hi' });
});

test('console CreateTaskRequestSchema did NOT gain the /v1-only repoId (it is stripped, never required)', () => {
  // repoId is NOT a console field: a body without it is valid, and a stray
  // repoId is dropped rather than carried — proof the /v1 .extend() did not
  // mutate the shared console schema.
  CreateTaskRequestSchema.parse({ prompt: 'hi' }); // valid without repoId
  const parsed = CreateTaskRequestSchema.parse({ prompt: 'hi', repoId });
  assert.equal(parsed.repoId, undefined);
});

test('console CreateTaskRequestSchema still rejects a missing prompt', () => {
  assert.throws(() => CreateTaskRequestSchema.parse({}));
});

// ---------------------------------------------------------------------------
// Console list responses are byte-unchanged (bare arrays, not /v1 envelopes)
// ---------------------------------------------------------------------------

test('console ListTasksResponseSchema is still a bare array (not the /v1 envelope)', () => {
  const parsed = ListTasksResponseSchema.parse([taskRow]);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  // the /v1 envelope shape must NOT validate against the console array schema
  assert.throws(() => ListTasksResponseSchema.parse({ items: [taskRow], nextCursor: null }));
});

test('console ListReposResponseSchema is still a bare array (not the /v1 envelope)', () => {
  const parsed = ListReposResponseSchema.parse([repoRow]);
  assert.ok(Array.isArray(parsed));
  assert.throws(() => ListReposResponseSchema.parse({ items: [repoRow], nextCursor: null }));
});

// ---------------------------------------------------------------------------
// The /v1 additions exist and carry the new shape
// ---------------------------------------------------------------------------

test('V1CreateTaskRequestSchema requires repoId in the body AND keeps the console fields', () => {
  assert.throws(() => V1CreateTaskRequestSchema.parse({ prompt: 'hi' }), 'repoId is required');
  const parsed = V1CreateTaskRequestSchema.parse({ prompt: 'hi', repoId, runtime: 'codex' });
  assert.equal(parsed.repoId, repoId);
  assert.equal(parsed.prompt, 'hi');
  assert.equal(parsed.runtime, 'codex');
});

test('V1 list envelopes are { items, nextCursor } (nextCursor nullable)', () => {
  const lastPage = V1ListTasksResponseSchema.parse({ items: [taskRow], nextCursor: null });
  assert.equal(lastPage.nextCursor, null);
  const midPage = V1ListReposResponseSchema.parse({ items: [repoRow], nextCursor: 'b64cursor' });
  assert.equal(midPage.nextCursor, 'b64cursor');
});

test('V1ListQuerySchema defaults limit and bounds it to the max', () => {
  assert.equal(V1ListQuerySchema.parse({}).limit, V1_LIST_DEFAULT_LIMIT);
  assert.equal(V1ListQuerySchema.parse({ limit: '120' }).limit, 120); // coerced from query string
  assert.throws(() => V1ListQuerySchema.parse({ limit: V1_LIST_MAX_LIMIT + 1 }));
  assert.throws(() => V1ListQuerySchema.parse({ limit: 0 }));
});

test('V1TaskEventSchema carries id + status + audit fields for SSE Last-Event-ID resume', () => {
  const parsed = V1TaskEventSchema.parse({
    id: eventId,
    taskId,
    type: 'task.completed',
    status: 'completed',
    title: 'Task completed',
    description: 'clean exit',
    timestamp: new Date('2026-01-01T00:01:00Z'),
  });
  assert.equal(parsed.id, eventId);
  assert.equal(parsed.status, 'completed');
  assert.throws(() => V1TaskEventSchema.parse({ id: eventId, taskId, type: 'x', status: 'not-a-status', title: 't', description: '', timestamp: new Date() }));
});
