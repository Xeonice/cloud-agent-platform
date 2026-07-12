import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { TaskFailureSchema, TaskResponseSchema } = require(
  path.join(here, '..', 'dist', 'task.js'),
);
const { ScheduleRunResponseSchema } = require(
  path.join(here, '..', 'dist', 'schedule.js'),
);

const failure = {
  code: 'runtime_auth_expired',
  runtime: 'claude-code',
  message: 'Claude Code 登录凭据已过期，请重新连接。',
  action: 'reconnect_runtime',
  occurredAt: '2026-07-12T12:32:54.000Z',
  exitCode: 1,
};

test('TaskFailure is structured, actionable, and secret-free', () => {
  const parsed = TaskFailureSchema.parse(failure);
  assert.equal(parsed.code, 'runtime_auth_expired');
  assert.equal(parsed.runtime, 'claude-code');
  assert.equal(parsed.action, 'reconnect_runtime');
  assert.ok(parsed.occurredAt instanceof Date);
  assert.equal('rawOutput' in parsed, false);
  assert.equal('token' in parsed, false);
});

test('TaskResponse accepts an actionable runtime failure and legacy absence', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    prompt: 'run',
    status: 'failed',
    createdAt: '2026-07-12T12:32:30.000Z',
  };
  assert.equal(
    TaskResponseSchema.parse({ ...base, failure }).failure.code,
    'runtime_auth_expired',
  );
  assert.equal(TaskResponseSchema.parse(base).failure, undefined);
  assert.equal(TaskResponseSchema.parse({ ...base, failure: null }).failure, null);
});

test('schedule run keeps dispatch success separate from linked task failure', () => {
  const parsed = ScheduleRunResponseSchema.parse({
    id: '33333333-3333-4333-8333-333333333333',
    scheduleId: '44444444-4444-4444-8444-444444444444',
    scheduledFor: '2026-07-12T12:32:30.000Z',
    status: 'created',
    taskId: '11111111-1111-4111-8111-111111111111',
    taskStatus: 'failed',
    taskFailure: failure,
    error: null,
    createdAt: '2026-07-12T12:32:30.000Z',
    updatedAt: '2026-07-12T12:32:57.000Z',
  });
  assert.equal(parsed.status, 'created');
  assert.equal(parsed.error, null);
  assert.equal(parsed.taskStatus, 'failed');
  assert.equal(parsed.taskFailure.code, 'runtime_auth_expired');
});
