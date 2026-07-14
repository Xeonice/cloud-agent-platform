import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import {
  CreateTaskRequestSchema,
  DEFAULT_TASK_RUNTIME,
  DeliverSchema,
  RuntimeSchema,
  TaskFailureSchema,
  TaskStatusSchema,
} from './task.js';
import {
  V1_LIST_DEFAULT_LIMIT,
  V1_LIST_MAX_LIMIT,
} from './v1.js';
import { RuntimeModelErrorCodeSchema } from './runtime-model.js';

export const ScheduleOverlapPolicySchema = z.enum(['skip', 'enqueue']);
export type ScheduleOverlapPolicy = z.infer<typeof ScheduleOverlapPolicySchema>;

export const ScheduleMisfirePolicySchema = z.enum(['fire-once']);
export type ScheduleMisfirePolicy = z.infer<typeof ScheduleMisfirePolicySchema>;

export const ScheduleRunStatusSchema = z.enum([
  'claimed',
  'created',
  'retrying',
  'skipped',
  'failed',
]);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>;

export const ScheduleTriggerSourceSchema = z.enum(['manual', 'automatic']);
export type ScheduleTriggerSource = z.infer<typeof ScheduleTriggerSourceSchema>;

/**
 * Stable schedule-period identity. Calendar presets use the schedule's local
 * calendar, while custom cron expressions use their nominal UTC occurrence.
 */
export const SchedulePeriodIdentitySchema = z.string().regex(
  /^(?:day:\d{4}-\d{2}-\d{2}|week:\d{4}-\d{2}-\d{2}|month:\d{4}-\d{2}|cron:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/,
  'Invalid schedule period identity',
);
export type SchedulePeriodIdentity = z.infer<typeof SchedulePeriodIdentitySchema>;

const CRON_FIELD_COUNT = 5;

function isFiveFieldCron(value: string): boolean {
  return value.trim().split(/\s+/).length === CRON_FIELD_COUNT;
}

export function isValidScheduleCron(value: string): boolean {
  if (!isFiveFieldCron(value)) return false;
  try {
    CronExpressionParser.parse(value, {
      currentDate: new Date('2026-01-01T00:00:00.000Z'),
      tz: 'UTC',
    });
    return true;
  } catch {
    return false;
  }
}

export function isValidScheduleTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export const ScheduleCronExpressionSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isFiveFieldCron, 'Cron expression must use exactly five fields')
  .refine(isValidScheduleCron, 'Invalid cron expression');
export type ScheduleCronExpression = z.infer<typeof ScheduleCronExpressionSchema>;

export const ScheduleTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidScheduleTimezone, 'Invalid IANA timezone');
export type ScheduleTimezone = z.infer<typeof ScheduleTimezoneSchema>;

export const ScheduleLocalTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Local time must use HH:mm');
export type ScheduleLocalTime = z.infer<typeof ScheduleLocalTimeSchema>;

const WeekdaySchema = z.number().int().min(0).max(6);

const ScheduleRecurrenceTimezoneSchema = z.object({
  timezone: ScheduleTimezoneSchema,
});

const ScheduleCalendarRecurrenceBaseSchema =
  ScheduleRecurrenceTimezoneSchema.extend({
    time: ScheduleLocalTimeSchema,
  });

export const SCHEDULE_MINUTE_INTERVALS = [5, 10, 15, 30] as const;

export const ScheduleMinuteIntervalSchema = z.union([
  z.literal(SCHEDULE_MINUTE_INTERVALS[0]),
  z.literal(SCHEDULE_MINUTE_INTERVALS[1]),
  z.literal(SCHEDULE_MINUTE_INTERVALS[2]),
  z.literal(SCHEDULE_MINUTE_INTERVALS[3]),
]);
export type ScheduleMinuteInterval = z.infer<
  typeof ScheduleMinuteIntervalSchema
>;

export const ScheduleRecurrenceSchema = z.discriminatedUnion('kind', [
  ScheduleCalendarRecurrenceBaseSchema.extend({
    kind: z.literal('daily'),
  }),
  ScheduleCalendarRecurrenceBaseSchema.extend({
    kind: z.literal('weekdays'),
  }),
  ScheduleCalendarRecurrenceBaseSchema.extend({
    kind: z.literal('weekly'),
    weekday: WeekdaySchema,
  }),
  ScheduleCalendarRecurrenceBaseSchema.extend({
    kind: z.literal('monthly'),
    // Kept to 1-28 so the rule can occur every month without implicit clamping.
    dayOfMonth: z.number().int().min(1).max(28),
  }),
  ScheduleRecurrenceTimezoneSchema.extend({
    kind: z.literal('hourly'),
    minuteOfHour: z.number().int().min(0).max(59),
  }),
  ScheduleRecurrenceTimezoneSchema.extend({
    kind: z.literal('minuteInterval'),
    intervalMinutes: ScheduleMinuteIntervalSchema,
  }),
]);
export type ScheduleRecurrence = z.infer<typeof ScheduleRecurrenceSchema>;

const ScheduleRecurrenceLabelSchema = z.object({
  label: z.string().min(1),
});

export const ScheduleRecurrenceResponseSchema = z.discriminatedUnion('kind', [
  ScheduleCalendarRecurrenceBaseSchema.extend({
    kind: z.literal('daily'),
  }).merge(ScheduleRecurrenceLabelSchema),
  ScheduleCalendarRecurrenceBaseSchema.extend({
    kind: z.literal('weekdays'),
  }).merge(ScheduleRecurrenceLabelSchema),
  ScheduleCalendarRecurrenceBaseSchema.extend({
    kind: z.literal('weekly'),
    weekday: WeekdaySchema,
  }).merge(ScheduleRecurrenceLabelSchema),
  ScheduleCalendarRecurrenceBaseSchema.extend({
    kind: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(28),
  }).merge(ScheduleRecurrenceLabelSchema),
  ScheduleRecurrenceTimezoneSchema.extend({
    kind: z.literal('hourly'),
    minuteOfHour: z.number().int().min(0).max(59),
  }).merge(ScheduleRecurrenceLabelSchema),
  ScheduleRecurrenceTimezoneSchema.extend({
    kind: z.literal('minuteInterval'),
    intervalMinutes: ScheduleMinuteIntervalSchema,
  }).merge(ScheduleRecurrenceLabelSchema),
  z.object({
    kind: z.literal('custom'),
    timezone: ScheduleTimezoneSchema,
    label: z.string().min(1),
  }),
]);
export type ScheduleRecurrenceResponse = z.infer<
  typeof ScheduleRecurrenceResponseSchema
>;

export const ScheduleTaskTemplateSchema = CreateTaskRequestSchema.extend({
  repoId: z.string().uuid(),
  runtime: RuntimeSchema.default(DEFAULT_TASK_RUNTIME),
  sandboxEnvironmentId: z.string().uuid().nullable(),
  deliver: DeliverSchema.default('none'),
});
export type ScheduleTaskTemplate = z.infer<typeof ScheduleTaskTemplateSchema>;

/**
 * Canonical schedule write template. Exported so transport/schema parity tests
 * can prove that recurring-task writes inherit every current and future task
 * create field rather than maintaining a second hand-written field list.
 */
export const ScheduleTaskTemplateCreateSchema = CreateTaskRequestSchema.extend({
  repoId: z.string().uuid(),
});

/**
 * Field-owning wire object advertised by REST/OpenAPI and MCP. Runtime
 * validation is layered onto this exact object below so transports never need
 * to copy the schedule field list from a refined `ZodEffects` schema.
 */
export const CreateScheduleRequestWireSchema = z.object({
  name: z.string().trim().min(1).max(120).nullable().optional(),
  recurrence: ScheduleRecurrenceSchema.optional(),
  cronExpression: ScheduleCronExpressionSchema.optional(),
  timezone: ScheduleTimezoneSchema.optional(),
  taskTemplate: ScheduleTaskTemplateCreateSchema,
  enabled: z.boolean().optional(),
  overlapPolicy: ScheduleOverlapPolicySchema.default('skip'),
  misfirePolicy: ScheduleMisfirePolicySchema.default('fire-once'),
});

function validateScheduleTimingInput(
  value: {
    readonly recurrence?: unknown;
    readonly cronExpression?: unknown;
    readonly timezone?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.recurrence && value.cronExpression) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recurrence'],
      message: 'Provide recurrence or cronExpression, not both',
    });
  }
}

export const CreateScheduleRequestParseSchema = CreateScheduleRequestWireSchema
  .superRefine((value, ctx) => {
    validateScheduleTimingInput(value, ctx);
    if (!value.recurrence && !value.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recurrence'],
        message: 'Schedule recurrence or cronExpression is required',
      });
    }
  })
  .transform((value) => ({
    ...value,
    ...normalizeScheduleTiming(value),
  }));
/** Backward-compatible name for the canonical runtime parser. */
export const CreateScheduleRequestSchema = CreateScheduleRequestParseSchema;
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

/** Historical ownerless schedule body (400 rather than the default 403). */
export const ScheduleOwnerRequiredErrorSchema = z
  .object({
    error: z.literal('schedule_owner_required'),
    message: z.literal('Schedules require an authenticated account owner.'),
  })
  .strict();
export type ScheduleOwnerRequiredError = z.infer<typeof ScheduleOwnerRequiredErrorSchema>;

/** Field-owning update object; refinements remain derived from this schema. */
export const UpdateScheduleRequestWireSchema = z.object({
  name: z.string().trim().min(1).max(120).nullable().optional(),
  recurrence: ScheduleRecurrenceSchema.optional(),
  cronExpression: ScheduleCronExpressionSchema.optional(),
  timezone: ScheduleTimezoneSchema.optional(),
  taskTemplate: ScheduleTaskTemplateCreateSchema.optional(),
  enabled: z.boolean().optional(),
  overlapPolicy: ScheduleOverlapPolicySchema.optional(),
  misfirePolicy: ScheduleMisfirePolicySchema.optional(),
});

export const UpdateScheduleRequestParseSchema = UpdateScheduleRequestWireSchema
  .superRefine((value, ctx) => {
    validateScheduleTimingInput(value, ctx);
    if (value.recurrence && value.timezone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timezone'],
        message: 'Timezone is part of recurrence; omit top-level timezone',
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one schedule field must be provided',
  })
  .transform((value) => ({
    ...value,
    ...(value.recurrence ? normalizeScheduleTiming(value) : {}),
  }));
/** Backward-compatible name for the canonical runtime parser. */
export const UpdateScheduleRequestSchema = UpdateScheduleRequestParseSchema;
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequestSchema>;

/** Field-owning dispatch body; its parser adds only the historical `{}` default. */
export const DispatchScheduleRequestWireSchema = z
  .object({
    expectedPeriodKey: SchedulePeriodIdentitySchema.optional(),
  })
  .strict();
export const DispatchScheduleRequestParseSchema =
  DispatchScheduleRequestWireSchema.default({});
/** Backward-compatible name for the canonical runtime parser. */
export const DispatchScheduleRequestSchema = DispatchScheduleRequestParseSchema;
export type DispatchScheduleRequest = z.infer<typeof DispatchScheduleRequestSchema>;

const ScheduleRunRetryFields = {
  errorCode: RuntimeModelErrorCodeSchema.nullable().optional(),
  retryAt: z.coerce.date().nullable().optional(),
  retryAttempt: z.number().int().positive().nullable().optional(),
} as const;

function validateScheduleRunRetryState(
  value: {
    readonly status: z.infer<typeof ScheduleRunStatusSchema>;
    readonly taskId: string | null;
    readonly errorCode?: z.infer<typeof RuntimeModelErrorCodeSchema> | null;
    readonly retryAt?: Date | null;
    readonly retryAttempt?: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.status !== 'retrying') return;
  if (value.taskId !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taskId'],
      message: 'A retrying pre-task occurrence cannot have a Task',
    });
  }
  if (value.errorCode !== 'runtime_model_catalog_unavailable') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['errorCode'],
      message: 'A retrying occurrence requires the catalog-unavailable code',
    });
  }
  if (!(value.retryAt instanceof Date)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['retryAt'],
      message: 'A retrying occurrence requires its next retry time',
    });
  }
  if (typeof value.retryAttempt !== 'number') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['retryAttempt'],
      message: 'A retrying occurrence requires its attempt number',
    });
  }
}

export const ScheduleLatestRunSchema = z
  .object({
    id: z.string().uuid(),
    scheduledFor: z.coerce.date(),
    periodKey: SchedulePeriodIdentitySchema.nullable().optional(),
    triggerSource: ScheduleTriggerSourceSchema.nullable().optional(),
    triggeredAt: z.coerce.date().nullable().optional(),
    status: ScheduleRunStatusSchema,
    taskId: z.string().uuid().nullable(),
    taskStatus: TaskStatusSchema.nullable().optional(),
    /** Structured failure of the linked task; distinct from dispatch `error`. */
    taskFailure: TaskFailureSchema.nullable().optional(),
    error: z.string().nullable(),
    ...ScheduleRunRetryFields,
    createdAt: z.coerce.date().optional(),
  })
  .superRefine(validateScheduleRunRetryState);
export type ScheduleLatestRun = z.infer<typeof ScheduleLatestRunSchema>;

export const ScheduleCurrentPeriodSchema = z.object({
  key: SchedulePeriodIdentitySchema,
  scheduledFor: z.coerce.date().nullable(),
  run: ScheduleLatestRunSchema.nullable(),
});
export type ScheduleCurrentPeriod = z.infer<typeof ScheduleCurrentPeriodSchema>;

export const ScheduleResponseSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().min(1),
  repoId: z.string().uuid(),
  name: z.string().nullable(),
  cronExpression: ScheduleCronExpressionSchema,
  timezone: ScheduleTimezoneSchema,
  recurrence: ScheduleRecurrenceResponseSchema,
  enabled: z.boolean(),
  nextRunAt: z.coerce.date().nullable(),
  overlapPolicy: ScheduleOverlapPolicySchema,
  misfirePolicy: ScheduleMisfirePolicySchema,
  taskTemplate: ScheduleTaskTemplateSchema,
  latestRun: ScheduleLatestRunSchema.nullable().optional(),
  currentPeriod: ScheduleCurrentPeriodSchema.optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;

export const ScheduleRunResponseSchema = z
  .object({
    id: z.string().uuid(),
    scheduleId: z.string().uuid(),
    scheduledFor: z.coerce.date(),
    periodKey: SchedulePeriodIdentitySchema.nullable().optional(),
    triggerSource: ScheduleTriggerSourceSchema.nullable().optional(),
    triggeredAt: z.coerce.date().nullable().optional(),
    status: ScheduleRunStatusSchema,
    taskId: z.string().uuid().nullable(),
    taskStatus: TaskStatusSchema.nullable().optional(),
    /** Structured failure of the linked task; distinct from dispatch `error`. */
    taskFailure: TaskFailureSchema.nullable().optional(),
    error: z.string().nullable(),
    ...ScheduleRunRetryFields,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .superRefine(validateScheduleRunRetryState);
export type ScheduleRunResponse = z.infer<typeof ScheduleRunResponseSchema>;

export const ListSchedulesResponseSchema = z.array(ScheduleResponseSchema);
export type ListSchedulesResponse = z.infer<typeof ListSchedulesResponseSchema>;

export const ListScheduleRunsResponseSchema = z.array(ScheduleRunResponseSchema);
export type ListScheduleRunsResponse = z.infer<typeof ListScheduleRunsResponseSchema>;

const paginatedEnvelope = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().min(1).nullable(),
  });

export const V1ListSchedulesResponseSchema = paginatedEnvelope(ScheduleResponseSchema);
export type V1ListSchedulesResponse = z.infer<typeof V1ListSchedulesResponseSchema>;

export const V1ListScheduleRunsResponseSchema = paginatedEnvelope(ScheduleRunResponseSchema);
export type V1ListScheduleRunsResponse = z.infer<typeof V1ListScheduleRunsResponseSchema>;

export const V1ScheduleListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(V1_LIST_MAX_LIMIT)
    .default(V1_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});
export type V1ScheduleListQuery = z.infer<typeof V1ScheduleListQuerySchema>;

export interface ComputeNextScheduleRunAtInput {
  readonly cronExpression: string;
  readonly timezone: string;
  readonly after: Date;
}

export function computeNextScheduleRunAt(
  input: ComputeNextScheduleRunAtInput,
): Date {
  const cronExpression = ScheduleCronExpressionSchema.parse(input.cronExpression);
  const timezone = ScheduleTimezoneSchema.parse(input.timezone);
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: input.after,
    tz: timezone,
  });
  return interval.next().toDate();
}

export interface ComputeCurrentSchedulePeriodInput {
  readonly cronExpression: string;
  readonly timezone: string;
  readonly at: Date;
  readonly nextRunAt?: Date | null;
}

export interface ComputedSchedulePeriod {
  readonly key: SchedulePeriodIdentity;
  readonly scheduledFor: Date | null;
}

export interface ComputeSchedulePeriodForOccurrenceInput {
  readonly cronExpression: string;
  readonly timezone: string;
  readonly scheduledFor: Date;
}

/**
 * Resolves the period containing `at` in the schedule's timezone. Product
 * calendar recurrence presets use calendar identities; sub-day presets and
 * custom cron use their next nominal occurrence, retaining an overdue persisted
 * `nextRunAt` as the missed period.
 */
export function computeCurrentSchedulePeriod(
  input: ComputeCurrentSchedulePeriodInput,
): ComputedSchedulePeriod {
  const cronExpression = ScheduleCronExpressionSchema.parse(input.cronExpression);
  const timezone = ScheduleTimezoneSchema.parse(input.timezone);
  const at = validDate(input.at, 'at');
  const nextRunAt =
    input.nextRunAt == null ? null : validDate(input.nextRunAt, 'nextRunAt');
  const recurrence = recurrenceResponseFromCron(cronExpression, timezone);

  if (!isCalendarRecurrenceKind(recurrence.kind)) {
    const scheduledFor =
      nextRunAt && nextRunAt.getTime() <= at.getTime()
        ? nextRunAt
        : nextScheduleOccurrenceAtOrAfter(cronExpression, timezone, at);
    return {
      key: customPeriodKey(scheduledFor),
      scheduledFor,
    };
  }

  const key = calendarPeriodKey(recurrence.kind, timezone, at);
  if (recurrence.kind === 'weekdays' && isWeekend(timezone, at)) {
    return { key, scheduledFor: null };
  }

  const candidates = [
    nextRunAt,
    nextScheduleOccurrenceAtOrAfter(cronExpression, timezone, at),
    previousScheduleOccurrenceAtOrBefore(cronExpression, timezone, at),
  ];
  const scheduledFor =
    candidates.find(
      (candidate): candidate is Date =>
        candidate !== null &&
        computeSchedulePeriodForOccurrence({
          cronExpression,
          timezone,
          scheduledFor: candidate,
        }) === key,
    ) ?? null;

  return { key, scheduledFor };
}

/** Returns the canonical period key for an automatic nominal occurrence. */
export function computeSchedulePeriodForOccurrence(
  input: ComputeSchedulePeriodForOccurrenceInput,
): SchedulePeriodIdentity {
  const cronExpression = ScheduleCronExpressionSchema.parse(input.cronExpression);
  const timezone = ScheduleTimezoneSchema.parse(input.timezone);
  const scheduledFor = validDate(input.scheduledFor, 'scheduledFor');
  const recurrence = recurrenceResponseFromCron(cronExpression, timezone);
  return isCalendarRecurrenceKind(recurrence.kind)
    ? calendarPeriodKey(recurrence.kind, timezone, scheduledFor)
    : customPeriodKey(scheduledFor);
}

function nextScheduleOccurrenceAtOrAfter(
  cronExpression: string,
  timezone: string,
  at: Date,
): Date {
  return computeNextScheduleRunAt({
    cronExpression,
    timezone,
    after: new Date(at.getTime() - 1),
  });
}

function previousScheduleOccurrenceAtOrBefore(
  cronExpression: string,
  timezone: string,
  at: Date,
): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: new Date(at.getTime() + 1),
    tz: timezone,
  });
  return interval.prev().toDate();
}

type CalendarPeriodKind = Extract<
  ScheduleRecurrenceResponse['kind'],
  'daily' | 'weekdays' | 'weekly' | 'monthly'
>;

function isCalendarRecurrenceKind(
  kind: ScheduleRecurrenceResponse['kind'],
): kind is CalendarPeriodKind {
  return (
    kind === 'daily' ||
    kind === 'weekdays' ||
    kind === 'weekly' ||
    kind === 'monthly'
  );
}

function calendarPeriodKey(
  kind: CalendarPeriodKind,
  timezone: string,
  instant: Date,
): SchedulePeriodIdentity {
  const local = localDateParts(timezone, instant);
  switch (kind) {
    case 'daily':
    case 'weekdays':
      return SchedulePeriodIdentitySchema.parse(`day:${formatLocalDate(local)}`);
    case 'weekly':
      return SchedulePeriodIdentitySchema.parse(
        `week:${formatLocalDate(isoWeekStart(local))}`,
      );
    case 'monthly':
      return SchedulePeriodIdentitySchema.parse(
        `month:${local.year.toString().padStart(4, '0')}-${local.month
          .toString()
          .padStart(2, '0')}`,
      );
  }
}

function customPeriodKey(scheduledFor: Date): SchedulePeriodIdentity {
  return SchedulePeriodIdentitySchema.parse(`cron:${scheduledFor.toISOString()}`);
}

interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function localDateParts(timezone: string, instant: Date): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (!value) throw new Error(`Unable to resolve local schedule ${type}`);
    return Number(value);
  };
  return { year: part('year'), month: part('month'), day: part('day') };
}

function formatLocalDate(parts: LocalDateParts): string {
  return `${parts.year.toString().padStart(4, '0')}-${parts.month
    .toString()
    .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

function isoWeekStart(parts: LocalDateParts): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function isWeekend(timezone: string, instant: Date): boolean {
  const local = localDateParts(timezone, instant);
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return value;
}

export interface NormalizeScheduleTimingInput {
  readonly recurrence?: ScheduleRecurrence;
  readonly cronExpression?: string;
  readonly timezone?: string;
}

export interface NormalizedScheduleTiming {
  readonly cronExpression: ScheduleCronExpression;
  readonly timezone: ScheduleTimezone;
}

export function normalizeScheduleTiming(
  input: NormalizeScheduleTimingInput,
): NormalizedScheduleTiming {
  if (input.recurrence) {
    return recurrenceToScheduleTiming(input.recurrence);
  }
  return {
    cronExpression: ScheduleCronExpressionSchema.parse(input.cronExpression),
    timezone: ScheduleTimezoneSchema.parse(input.timezone ?? 'UTC'),
  };
}

export function recurrenceToScheduleTiming(
  recurrence: ScheduleRecurrence,
): NormalizedScheduleTiming {
  const parsed = ScheduleRecurrenceSchema.parse(recurrence);
  if (parsed.kind === 'hourly') {
    return {
      cronExpression: `${parsed.minuteOfHour} * * * *`,
      timezone: parsed.timezone,
    };
  }
  if (parsed.kind === 'minuteInterval') {
    return {
      cronExpression: `*/${parsed.intervalMinutes} * * * *`,
      timezone: parsed.timezone,
    };
  }
  const [hour, minute] = parsed.time.split(':').map((part) => Number(part));
  const prefix = `${minute} ${hour}`;
  switch (parsed.kind) {
    case 'daily':
      return { cronExpression: `${prefix} * * *`, timezone: parsed.timezone };
    case 'weekdays':
      return { cronExpression: `${prefix} * * 1-5`, timezone: parsed.timezone };
    case 'weekly':
      return {
        cronExpression: `${prefix} * * ${parsed.weekday}`,
        timezone: parsed.timezone,
      };
    case 'monthly':
      return {
        cronExpression: `${prefix} ${parsed.dayOfMonth} * *`,
        timezone: parsed.timezone,
      };
  }
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function recurrenceResponseFromCron(
  cronExpression: string,
  timezone: string,
): ScheduleRecurrenceResponse {
  const cron = ScheduleCronExpressionSchema.parse(cronExpression);
  const tz = ScheduleTimezoneSchema.parse(timezone);
  const [
    minute = '0',
    hour = '0',
    dayOfMonth = '*',
    month = '*',
    dayOfWeek = '*',
  ] = cron.split(/\s+/);
  if (month === '*' && dayOfMonth === '*' && dayOfWeek === '*' && hour === '*') {
    const minuteOfHour = parseCronNumber(minute, 0, 59);
    if (minuteOfHour !== null) {
      return withRecurrenceLabel({
        kind: 'hourly',
        minuteOfHour,
        timezone: tz,
      });
    }
    const intervalMinutes = parseSupportedMinuteInterval(minute);
    if (intervalMinutes !== null) {
      return withRecurrenceLabel({
        kind: 'minuteInterval',
        intervalMinutes,
        timezone: tz,
      });
    }
  }
  const minuteNumber = parseCronNumber(minute, 0, 59);
  const hourNumber = parseCronNumber(hour, 0, 23);
  if (minuteNumber === null || hourNumber === null) {
    return { kind: 'custom', timezone: tz, label: '自定义重复' };
  }
  const time = `${hourNumber.toString().padStart(2, '0')}:${minuteNumber
    .toString()
    .padStart(2, '0')}`;
  if (month === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    return withRecurrenceLabel({ kind: 'daily', time, timezone: tz });
  }
  if (month === '*' && dayOfMonth === '*' && dayOfWeek === '1-5') {
    return withRecurrenceLabel({ kind: 'weekdays', time, timezone: tz });
  }
  if (month === '*' && dayOfMonth === '*' && /^[0-6]$/.test(dayOfWeek)) {
    return withRecurrenceLabel({
      kind: 'weekly',
      weekday: Number(dayOfWeek),
      time,
      timezone: tz,
    });
  }
  if (
    month === '*' &&
    dayOfWeek === '*' &&
    /^(?:[1-9]|1\d|2[0-8])$/.test(dayOfMonth)
  ) {
    return withRecurrenceLabel({
      kind: 'monthly',
      dayOfMonth: Number(dayOfMonth),
      time,
      timezone: tz,
    });
  }
  return { kind: 'custom', timezone: tz, label: '自定义重复' };
}

function parseSupportedMinuteInterval(
  value: string,
): ScheduleMinuteInterval | null {
  const match = /^\*\/(\d+)$/.exec(value);
  if (!match) return null;
  const interval = Number(match[1]);
  return SCHEDULE_MINUTE_INTERVALS.includes(
    interval as ScheduleMinuteInterval,
  )
    ? (interval as ScheduleMinuteInterval)
    : null;
}

function parseCronNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

export function withRecurrenceLabel(
  recurrence: ScheduleRecurrence,
): ScheduleRecurrenceResponse {
  const parsed = ScheduleRecurrenceSchema.parse(recurrence);
  switch (parsed.kind) {
    case 'daily':
      return { ...parsed, label: `每天 ${parsed.time}` };
    case 'weekdays':
      return { ...parsed, label: `工作日 ${parsed.time}` };
    case 'weekly':
      return {
        ...parsed,
        label: `每${WEEKDAY_LABELS[parsed.weekday]} ${parsed.time}`,
      };
    case 'monthly':
      return { ...parsed, label: `每月 ${parsed.dayOfMonth} 日 ${parsed.time}` };
    case 'hourly':
      return { ...parsed, label: `每小时第 ${parsed.minuteOfHour} 分钟` };
    case 'minuteInterval':
      return { ...parsed, label: `每 ${parsed.intervalMinutes} 分钟` };
  }
}
