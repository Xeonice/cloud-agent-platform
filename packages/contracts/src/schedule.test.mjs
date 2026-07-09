import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const contracts = require(path.join(here, '..', 'dist', 'index.js'));

const {
  CreateScheduleRequestSchema,
  ScheduleRecurrenceSchema,
  ScheduleOwnerRequiredErrorSchema,
  ScheduleResponseSchema,
  ScheduleRunResponseSchema,
  ScheduleTaskTemplateSchema,
  UpdateScheduleRequestSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListSchedulesResponseSchema,
  computeNextScheduleRunAt,
  recurrenceResponseFromCron,
  recurrenceToScheduleTiming,
} = contracts;

const repoId = '11111111-1111-4111-8111-111111111111';
const scheduleId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const taskId = '44444444-4444-4444-8444-444444444444';

test('schedule create validates five-field cron and IANA timezone', () => {
  const parsed = CreateScheduleRequestSchema.parse({
    cronExpression: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    taskTemplate: { repoId, prompt: 'daily check' },
  });
  assert.equal(parsed.cronExpression, '0 9 * * 1-5');
  assert.equal(parsed.timezone, 'Asia/Shanghai');

  assert.throws(() =>
    CreateScheduleRequestSchema.parse({
      cronExpression: '0 0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      taskTemplate: { repoId, prompt: 'bad seconds' },
    }),
  );
  assert.throws(() =>
    CreateScheduleRequestSchema.parse({
      cronExpression: 'not a cron',
      timezone: 'Asia/Shanghai',
      taskTemplate: { repoId, prompt: 'bad cron' },
    }),
  );
  assert.throws(() =>
    CreateScheduleRequestSchema.parse({
      cronExpression: '0 9 * * *',
      timezone: 'Mars/Phobos',
      taskTemplate: { repoId, prompt: 'bad tz' },
    }),
  );
});

test('schedule recurrence validates product presets and normalizes to cron', () => {
  const recurrence = ScheduleRecurrenceSchema.parse({
    kind: 'weekdays',
    time: '09:00',
    timezone: 'Asia/Shanghai',
  });
  assert.deepEqual(recurrenceToScheduleTiming(recurrence), {
    cronExpression: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
  });

  const parsed = CreateScheduleRequestSchema.parse({
    recurrence,
    taskTemplate: { repoId, prompt: 'weekday check' },
  });
  assert.equal(parsed.cronExpression, '0 9 * * 1-5');
  assert.equal(parsed.timezone, 'Asia/Shanghai');
  assert.equal(parsed.recurrence.kind, 'weekdays');

  const weekly = CreateScheduleRequestSchema.parse({
    recurrence: {
      kind: 'weekly',
      weekday: 1,
      time: '10:30',
      timezone: 'Europe/London',
    },
    taskTemplate: { repoId, prompt: 'weekly check' },
  });
  assert.equal(weekly.cronExpression, '30 10 * * 1');

  assert.throws(() =>
    CreateScheduleRequestSchema.parse({
      recurrence: { kind: 'daily', time: '25:00', timezone: 'UTC' },
      taskTemplate: { repoId, prompt: 'bad time' },
    }),
  );
  assert.throws(() =>
    CreateScheduleRequestSchema.parse({
      recurrence: { kind: 'monthly', dayOfMonth: 31, time: '09:00', timezone: 'UTC' },
      taskTemplate: { repoId, prompt: 'bad monthly day' },
    }),
  );
  assert.throws(() =>
    CreateScheduleRequestSchema.parse({
      recurrence,
      cronExpression: '0 9 * * 1-5',
      taskTemplate: { repoId, prompt: 'ambiguous' },
    }),
  );
});

test('schedule update accepts recurrence and keeps cron compatibility', () => {
  const recurrenceUpdate = UpdateScheduleRequestSchema.parse({
    recurrence: {
      kind: 'monthly',
      dayOfMonth: 12,
      time: '08:15',
      timezone: 'Asia/Shanghai',
    },
  });
  assert.equal(recurrenceUpdate.cronExpression, '15 8 12 * *');
  assert.equal(recurrenceUpdate.timezone, 'Asia/Shanghai');

  const cronUpdate = UpdateScheduleRequestSchema.parse({
    cronExpression: '45 17 * * *',
    timezone: 'UTC',
  });
  assert.equal(cronUpdate.cronExpression, '45 17 * * *');

  assert.throws(() =>
    UpdateScheduleRequestSchema.parse({
      recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      timezone: 'UTC',
    }),
  );
});

test('recurrence response derives supported descriptors and custom summaries', () => {
  const weekdays = recurrenceResponseFromCron('0 9 * * 1-5', 'Asia/Shanghai');
  assert.equal(weekdays.kind, 'weekdays');
  assert.equal(weekdays.label, '工作日 09:00');

  const custom = recurrenceResponseFromCron('7 13 */2 * *', 'UTC');
  assert.equal(custom.kind, 'custom');
  assert.equal(custom.label, '自定义重复');

  const interval = recurrenceResponseFromCron('*/5 * * * *', 'UTC');
  assert.equal(interval.kind, 'custom');
  assert.equal(interval.label, '自定义重复');
});

test('next-fire helper respects timezone and DST gaps', () => {
  const shanghai = computeNextScheduleRunAt({
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    after: new Date('2026-07-09T00:00:00.000Z'),
  });
  assert.equal(shanghai.toISOString(), '2026-07-09T01:00:00.000Z');

  const londonDstGap = computeNextScheduleRunAt({
    cronExpression: '30 2 * * *',
    timezone: 'Europe/London',
    after: new Date('2026-03-29T00:30:00.000Z'),
  });
  assert.equal(londonDstGap.toISOString(), '2026-03-29T01:30:00.000Z');
});

test('ownerless schedule create rejection shape is shared', () => {
  const parsed = ScheduleOwnerRequiredErrorSchema.parse({
    error: 'schedule_owner_required',
    message: 'Schedules require an authenticated account owner.',
  });
  assert.equal(parsed.error, 'schedule_owner_required');
  assert.throws(() =>
    ScheduleOwnerRequiredErrorSchema.parse({
      error: 'other',
      message: 'wrong shape',
    }),
  );
});

test('schedule task template captures task fields and defaults non-secret values', () => {
  const parsed = ScheduleTaskTemplateSchema.parse({
    repoId,
    prompt: 'ship it',
    branch: 'main',
    strategy: 'small steps',
    skills: ['openspec'],
    idleTimeoutMs: 30000,
    deadlineMs: 120000,
    sandboxEnvironmentId: null,
  });
  assert.equal(parsed.runtime, 'codex');
  assert.equal(parsed.deliver, 'none');
  assert.deepEqual(parsed.skills, ['openspec']);
});

test('schedule response redacts claim internals and run envelopes parse', () => {
  const schedule = ScheduleResponseSchema.parse({
    id: scheduleId,
    ownerUserId: 'acct-1',
    repoId,
    name: 'weekday check',
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    recurrence: {
      kind: 'weekdays',
      time: '09:00',
      timezone: 'UTC',
      label: '工作日 09:00',
    },
    enabled: true,
    nextRunAt: new Date('2026-07-10T09:00:00.000Z'),
    overlapPolicy: 'skip',
    misfirePolicy: 'fire-once',
    claimToken: 'must-not-survive-parse',
    claimUntil: new Date('2026-07-09T09:00:00.000Z'),
    taskTemplate: {
      repoId,
      prompt: 'weekday check',
      runtime: 'codex',
      sandboxEnvironmentId: null,
      deliver: 'none',
    },
    latestRun: {
      id: runId,
      scheduledFor: new Date('2026-07-09T09:00:00.000Z'),
      status: 'created',
      taskId,
      error: null,
    },
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  });
  assert.equal(schedule.claimToken, undefined);
  assert.equal(schedule.claimUntil, undefined);

  const run = ScheduleRunResponseSchema.parse({
    id: runId,
    scheduleId,
    scheduledFor: new Date('2026-07-09T09:00:00.000Z'),
    status: 'skipped',
    taskId: null,
    error: 'overlap: prior scheduled task still active',
    createdAt: new Date('2026-07-09T09:00:00.000Z'),
    updatedAt: new Date('2026-07-09T09:00:00.000Z'),
  });
  assert.equal(run.status, 'skipped');
  assert.equal(run.taskId, null);

  assert.doesNotThrow(() =>
    V1ListSchedulesResponseSchema.parse({ items: [schedule], nextCursor: null }),
  );
  assert.doesNotThrow(() =>
    V1ListScheduleRunsResponseSchema.parse({ items: [run], nextCursor: 'cursor' }),
  );
});
