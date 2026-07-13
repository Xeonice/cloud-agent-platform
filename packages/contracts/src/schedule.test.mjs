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
  DispatchScheduleRequestSchema,
  SCHEDULE_MINUTE_INTERVALS,
  ScheduleRecurrenceSchema,
  ScheduleOwnerRequiredErrorSchema,
  ScheduleResponseSchema,
  ScheduleRunResponseSchema,
  ScheduleTaskTemplateSchema,
  UpdateScheduleRequestSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListSchedulesResponseSchema,
  computeCurrentSchedulePeriod,
  computeNextScheduleRunAt,
  computeSchedulePeriodForOccurrence,
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
  assert.deepEqual(SCHEDULE_MINUTE_INTERVALS, [5, 10, 15, 30]);

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

  const hourly = CreateScheduleRequestSchema.parse({
    recurrence: {
      kind: 'hourly',
      minuteOfHour: 15,
      timezone: 'Asia/Shanghai',
    },
    taskTemplate: { repoId, prompt: 'hourly check' },
  });
  assert.equal(hourly.cronExpression, '15 * * * *');
  assert.equal(hourly.timezone, 'Asia/Shanghai');

  const minuteInterval = CreateScheduleRequestSchema.parse({
    recurrence: {
      kind: 'minuteInterval',
      intervalMinutes: 15,
      timezone: 'Europe/London',
    },
    taskTemplate: { repoId, prompt: 'interval check' },
  });
  assert.equal(minuteInterval.cronExpression, '*/15 * * * *');
  assert.equal(minuteInterval.timezone, 'Europe/London');

  assert.throws(() =>
    CreateScheduleRequestSchema.parse({
      recurrence: { kind: 'daily', time: '25:00', timezone: 'UTC' },
      taskTemplate: { repoId, prompt: 'bad time' },
    }),
  );
  for (const minuteOfHour of [-1, 60, 1.5]) {
    assert.throws(() =>
      ScheduleRecurrenceSchema.parse({
        kind: 'hourly',
        minuteOfHour,
        timezone: 'UTC',
      }),
    );
  }
  for (const intervalMinutes of [7, 60, 2.5]) {
    assert.throws(() =>
      ScheduleRecurrenceSchema.parse({
        kind: 'minuteInterval',
        intervalMinutes,
        timezone: 'UTC',
      }),
    );
  }
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

  const hourlyUpdate = UpdateScheduleRequestSchema.parse({
    recurrence: {
      kind: 'hourly',
      minuteOfHour: 45,
      timezone: 'Europe/London',
    },
  });
  assert.equal(hourlyUpdate.cronExpression, '45 * * * *');
  assert.equal(hourlyUpdate.timezone, 'Europe/London');

  const intervalUpdate = UpdateScheduleRequestSchema.parse({
    recurrence: {
      kind: 'minuteInterval',
      intervalMinutes: 30,
      timezone: 'UTC',
    },
  });
  assert.equal(intervalUpdate.cronExpression, '*/30 * * * *');

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
  assert.deepEqual(interval, {
    kind: 'minuteInterval',
    intervalMinutes: 5,
    timezone: 'UTC',
    label: '每 5 分钟',
  });

  const hourly = recurrenceResponseFromCron('15 * * * *', 'Asia/Shanghai');
  assert.deepEqual(hourly, {
    kind: 'hourly',
    minuteOfHour: 15,
    timezone: 'Asia/Shanghai',
    label: '每小时第 15 分钟',
  });

  const unsupportedStep = recurrenceResponseFromCron('*/7 * * * *', 'UTC');
  assert.equal(unsupportedStep.kind, 'custom');
  assert.equal(unsupportedStep.label, '自定义重复');

  const nonCanonicalInterval = recurrenceResponseFromCron(
    '0,15,30,45 * * * *',
    'UTC',
  );
  assert.equal(nonCanonicalInterval.kind, 'custom');
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

  const hourlyGap = computeNextScheduleRunAt({
    cronExpression: '30 * * * *',
    timezone: 'Europe/London',
    after: new Date('2026-03-29T00:45:00.000Z'),
  });
  assert.equal(hourlyGap.toISOString(), '2026-03-29T01:30:00.000Z');

  const firstFoldOccurrence = computeNextScheduleRunAt({
    cronExpression: '30 * * * *',
    timezone: 'Europe/London',
    after: new Date('2026-10-25T00:00:00.000Z'),
  });
  const secondFoldOccurrence = computeNextScheduleRunAt({
    cronExpression: '30 * * * *',
    timezone: 'Europe/London',
    after: firstFoldOccurrence,
  });
  assert.equal(firstFoldOccurrence.toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(secondFoldOccurrence.toISOString(), '2026-10-25T01:30:00.000Z');

  const intervalFoldOccurrences = [];
  let after = new Date('2026-11-01T04:59:59.000Z');
  for (let index = 0; index < 8; index += 1) {
    const occurrence = computeNextScheduleRunAt({
      cronExpression: '*/15 * * * *',
      timezone: 'America/New_York',
      after,
    });
    intervalFoldOccurrences.push(occurrence.toISOString());
    after = occurrence;
  }
  assert.deepEqual(intervalFoldOccurrences, [
    '2026-11-01T05:00:00.000Z',
    '2026-11-01T05:15:00.000Z',
    '2026-11-01T05:30:00.000Z',
    '2026-11-01T05:45:00.000Z',
    '2026-11-01T06:00:00.000Z',
    '2026-11-01T06:15:00.000Z',
    '2026-11-01T06:30:00.000Z',
    '2026-11-01T06:45:00.000Z',
  ]);
});

test('current periods use the schedule timezone calendar for product recurrences', () => {
  const shanghaiDaily = computeCurrentSchedulePeriod({
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    at: new Date('2026-07-10T16:30:00.000Z'),
  });
  assert.equal(shanghaiDaily.key, 'day:2026-07-11');
  assert.equal(shanghaiDaily.scheduledFor?.toISOString(), '2026-07-11T01:00:00.000Z');

  const londonWeekly = computeCurrentSchedulePeriod({
    cronExpression: '0 9 * * 0',
    timezone: 'Europe/London',
    at: new Date('2026-07-12T08:30:00.000Z'),
  });
  assert.equal(londonWeekly.key, 'week:2026-07-06');
  assert.equal(londonWeekly.scheduledFor?.toISOString(), '2026-07-12T08:00:00.000Z');

  const monthly = computeCurrentSchedulePeriod({
    cronExpression: '15 8 12 * *',
    timezone: 'Asia/Shanghai',
    at: new Date('2026-07-20T04:00:00.000Z'),
  });
  assert.equal(monthly.key, 'month:2026-07');
  assert.equal(monthly.scheduledFor?.toISOString(), '2026-07-12T00:15:00.000Z');
});

test('weekday weekends retain a day period without fabricating a nominal fire', () => {
  const saturday = computeCurrentSchedulePeriod({
    cronExpression: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    at: new Date('2026-07-11T04:00:00.000Z'),
    nextRunAt: new Date('2026-07-13T01:00:00.000Z'),
  });
  assert.deepEqual(saturday, {
    key: 'day:2026-07-11',
    scheduledFor: null,
  });
});

test('custom cron uses the next nominal occurrence and preserves an overdue nextRunAt', () => {
  const next = computeCurrentSchedulePeriod({
    cronExpression: '*/7 * * * *',
    timezone: 'UTC',
    at: new Date('2026-07-11T10:02:00.000Z'),
  });
  assert.equal(next.key, 'cron:2026-07-11T10:07:00.000Z');
  assert.equal(next.scheduledFor?.toISOString(), '2026-07-11T10:07:00.000Z');

  const overdue = computeCurrentSchedulePeriod({
    cronExpression: '*/7 * * * *',
    timezone: 'UTC',
    at: new Date('2026-07-11T10:02:00.000Z'),
    nextRunAt: new Date('2026-07-11T09:56:00.000Z'),
  });
  assert.equal(overdue.key, 'cron:2026-07-11T09:56:00.000Z');
  assert.equal(overdue.scheduledFor?.toISOString(), '2026-07-11T09:56:00.000Z');
});

test('sub-day recurrences use distinct nominal occurrence identities', () => {
  const current = computeCurrentSchedulePeriod({
    cronExpression: '*/5 * * * *',
    timezone: 'UTC',
    at: new Date('2026-07-11T10:02:00.000Z'),
  });
  assert.deepEqual(current, {
    key: 'cron:2026-07-11T10:05:00.000Z',
    scheduledFor: new Date('2026-07-11T10:05:00.000Z'),
  });

  const first = computeSchedulePeriodForOccurrence({
    cronExpression: '*/5 * * * *',
    timezone: 'UTC',
    scheduledFor: new Date('2026-07-11T10:05:00.000Z'),
  });
  const second = computeSchedulePeriodForOccurrence({
    cronExpression: '*/5 * * * *',
    timezone: 'UTC',
    scheduledFor: new Date('2026-07-11T10:10:00.000Z'),
  });
  assert.equal(first, 'cron:2026-07-11T10:05:00.000Z');
  assert.equal(second, 'cron:2026-07-11T10:10:00.000Z');
  assert.notEqual(first, second);

  const firstFold = computeSchedulePeriodForOccurrence({
    cronExpression: '30 * * * *',
    timezone: 'Europe/London',
    scheduledFor: new Date('2026-10-25T00:30:00.000Z'),
  });
  const secondFold = computeSchedulePeriodForOccurrence({
    cronExpression: '30 * * * *',
    timezone: 'Europe/London',
    scheduledFor: new Date('2026-10-25T01:30:00.000Z'),
  });
  assert.equal(firstFold, 'cron:2026-10-25T00:30:00.000Z');
  assert.equal(secondFold, 'cron:2026-10-25T01:30:00.000Z');
});

test('automatic occurrence period keys honor calendar presets and DST resolution', () => {
  assert.equal(
    computeSchedulePeriodForOccurrence({
      cronExpression: '30 2 * * *',
      timezone: 'Europe/London',
      scheduledFor: new Date('2026-03-29T01:30:00.000Z'),
    }),
    'day:2026-03-29',
  );
  assert.equal(
    computeSchedulePeriodForOccurrence({
      cronExpression: '*/5 * * * *',
      timezone: 'UTC',
      scheduledFor: new Date('2026-07-11T10:05:00.000Z'),
    }),
    'cron:2026-07-11T10:05:00.000Z',
  );
});

test('dispatch request accepts an optional expected period identity', () => {
  assert.deepEqual(DispatchScheduleRequestSchema.parse(undefined), {});
  assert.deepEqual(
    DispatchScheduleRequestSchema.parse({ expectedPeriodKey: 'day:2026-07-11' }),
    { expectedPeriodKey: 'day:2026-07-11' },
  );
  assert.throws(() =>
    DispatchScheduleRequestSchema.parse({ expectedPeriodKey: 'today', extra: true }),
  );
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
      periodKey: 'day:2026-07-09',
      triggerSource: 'automatic',
      triggeredAt: new Date('2026-07-09T09:00:01.000Z'),
      status: 'created',
      taskId,
      taskStatus: 'failed',
      error: null,
      createdAt: new Date('2026-07-09T09:00:01.000Z'),
    },
    currentPeriod: {
      key: 'day:2026-07-10',
      scheduledFor: new Date('2026-07-10T09:00:00.000Z'),
      run: null,
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
    periodKey: 'day:2026-07-09',
    triggerSource: 'automatic',
    triggeredAt: new Date('2026-07-09T09:00:00.000Z'),
    status: 'skipped',
    taskId: null,
    taskStatus: null,
    error: 'overlap: prior scheduled task still active',
    createdAt: new Date('2026-07-09T09:00:00.000Z'),
    updatedAt: new Date('2026-07-09T09:00:00.000Z'),
  });
  assert.equal(run.status, 'skipped');
  assert.equal(run.taskId, null);
  assert.equal(run.periodKey, 'day:2026-07-09');
  assert.equal(schedule.currentPeriod?.key, 'day:2026-07-10');
  assert.equal(schedule.latestRun?.taskStatus, 'failed');
  assert.equal(
    schedule.latestRun?.createdAt.toISOString(),
    '2026-07-09T09:00:01.000Z',
  );

  assert.doesNotThrow(() =>
    V1ListSchedulesResponseSchema.parse({ items: [schedule], nextCursor: null }),
  );
  assert.doesNotThrow(() =>
    V1ListScheduleRunsResponseSchema.parse({ items: [run], nextCursor: 'cursor' }),
  );
});
