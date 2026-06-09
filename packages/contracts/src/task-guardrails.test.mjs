/**
 * Schema round-trip for the per-task guardrail parameters `idleTimeoutMs` /
 * `deadlineMs` and the new `cancelled` terminal status (task-guardrail-controls,
 * task 1.5). Drives the REAL compiled zod schemas from dist/ — the contract is
 * the single source of truth shared by api + web, so this guards that a sent
 * guardrail value is a readable value, that omission reads back null/absent
 * (never fabricated → no implicit idle reclaim), and that `cancelled` is a
 * distinct terminal status.
 *
 * Requires `pnpm --filter @cap/contracts build` first. Run: `node task-guardrails.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { CreateTaskRequestSchema, TaskResponseSchema, TaskSchema, TaskStatusSchema, TERMINAL_TASK_STATUSES } =
  require(path.join(here, '..', 'dist', 'task.js'));

const baseRow = {
  id: '11111111-1111-4111-8111-111111111111',
  repoId: '22222222-2222-4222-8222-222222222222',
  prompt: 'p',
  status: 'pending',
  createdAt: new Date().toISOString(),
  branch: null,
  strategy: null,
  skills: [],
};

test('CreateTaskRequest accepts idleTimeoutMs and deadlineMs', () => {
  const parsed = CreateTaskRequestSchema.parse({
    prompt: 'do the thing',
    idleTimeoutMs: 1_800_000,
    deadlineMs: 7_200_000,
  });
  assert.equal(parsed.idleTimeoutMs, 1_800_000);
  assert.equal(parsed.deadlineMs, 7_200_000);
});

test('CreateTaskRequest without guardrail params is valid (opt-in, off by default)', () => {
  const parsed = CreateTaskRequestSchema.parse({ prompt: 'do the thing' });
  assert.equal(parsed.idleTimeoutMs, undefined, 'omitted idleTimeoutMs stays undefined → never reclaimed for idleness');
  assert.equal(parsed.deadlineMs, undefined, 'omitted deadlineMs stays undefined → no deadline');
});

test('CreateTaskRequest rejects non-positive guardrail values', () => {
  assert.throws(() => CreateTaskRequestSchema.parse({ prompt: 'x', idleTimeoutMs: 0 }), 'idleTimeoutMs must be positive');
  assert.throws(() => CreateTaskRequestSchema.parse({ prompt: 'x', deadlineMs: -1 }), 'deadlineMs must be positive');
  assert.throws(() => CreateTaskRequestSchema.parse({ prompt: 'x', idleTimeoutMs: 1.5 }), 'idleTimeoutMs must be an integer');
});

test('TaskResponse echoes idleTimeoutMs and deadlineMs back (sent == readable)', () => {
  const parsed = TaskResponseSchema.parse({ ...baseRow, idleTimeoutMs: 600_000, deadlineMs: 3_600_000 });
  assert.equal(parsed.idleTimeoutMs, 600_000);
  assert.equal(parsed.deadlineMs, 3_600_000);
});

test('TaskResponse with null guardrail params reads back null (never fabricated)', () => {
  const parsed = TaskResponseSchema.parse({ ...baseRow, idleTimeoutMs: null, deadlineMs: null });
  assert.equal(parsed.idleTimeoutMs, null);
  assert.equal(parsed.deadlineMs, null);
});

test('cancelled is a distinct status value', () => {
  assert.equal(TaskStatusSchema.parse('cancelled'), 'cancelled');
  assert.notEqual('cancelled', 'failed');
  assert.notEqual('cancelled', 'completed');
});

test('cancelled is a terminal status', () => {
  assert.ok(TERMINAL_TASK_STATUSES.includes('cancelled'), 'cancelled is terminal');
});

test('TaskSchema accepts a cancelled task carrying guardrail params', () => {
  const parsed = TaskSchema.parse({ ...baseRow, status: 'cancelled', idleTimeoutMs: 600_000, deadlineMs: null });
  assert.equal(parsed.status, 'cancelled');
  assert.equal(parsed.idleTimeoutMs, 600_000);
});

test('guardrail params are independent of status (do not gate lifecycle)', () => {
  for (const status of ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled']) {
    const parsed = TaskSchema.parse({ ...baseRow, status, idleTimeoutMs: 600_000, deadlineMs: 3_600_000 });
    assert.equal(parsed.status, status);
    assert.equal(parsed.idleTimeoutMs, 600_000);
    assert.equal(parsed.deadlineMs, 3_600_000);
  }
});
