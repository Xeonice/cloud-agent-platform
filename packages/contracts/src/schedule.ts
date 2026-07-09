import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import {
  CreateTaskRequestSchema,
  DEFAULT_TASK_RUNTIME,
  DeliverSchema,
  RuntimeSchema,
} from './task.js';
import {
  V1_LIST_DEFAULT_LIMIT,
  V1_LIST_MAX_LIMIT,
} from './v1.js';

export const ScheduleOverlapPolicySchema = z.enum(['skip', 'enqueue']);
export type ScheduleOverlapPolicy = z.infer<typeof ScheduleOverlapPolicySchema>;

export const ScheduleMisfirePolicySchema = z.enum(['fire-once']);
export type ScheduleMisfirePolicy = z.infer<typeof ScheduleMisfirePolicySchema>;

export const ScheduleRunStatusSchema = z.enum(['claimed', 'created', 'skipped', 'failed']);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>;

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

const ScheduleRecurrenceBaseSchema = z.object({
  time: ScheduleLocalTimeSchema,
  timezone: ScheduleTimezoneSchema,
});

export const ScheduleRecurrenceSchema = z.discriminatedUnion('kind', [
  ScheduleRecurrenceBaseSchema.extend({
    kind: z.literal('daily'),
  }),
  ScheduleRecurrenceBaseSchema.extend({
    kind: z.literal('weekdays'),
  }),
  ScheduleRecurrenceBaseSchema.extend({
    kind: z.literal('weekly'),
    weekday: WeekdaySchema,
  }),
  ScheduleRecurrenceBaseSchema.extend({
    kind: z.literal('monthly'),
    // Kept to 1-28 so the rule can occur every month without implicit clamping.
    dayOfMonth: z.number().int().min(1).max(28),
  }),
]);
export type ScheduleRecurrence = z.infer<typeof ScheduleRecurrenceSchema>;

const ScheduleRecurrenceLabelSchema = z.object({
  label: z.string().min(1),
});

export const ScheduleRecurrenceResponseSchema = z.discriminatedUnion('kind', [
  ScheduleRecurrenceBaseSchema.extend({
    kind: z.literal('daily'),
  }).merge(ScheduleRecurrenceLabelSchema),
  ScheduleRecurrenceBaseSchema.extend({
    kind: z.literal('weekdays'),
  }).merge(ScheduleRecurrenceLabelSchema),
  ScheduleRecurrenceBaseSchema.extend({
    kind: z.literal('weekly'),
    weekday: WeekdaySchema,
  }).merge(ScheduleRecurrenceLabelSchema),
  ScheduleRecurrenceBaseSchema.extend({
    kind: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(28),
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

const ScheduleTaskTemplateCreateSchema = CreateTaskRequestSchema.extend({
  repoId: z.string().uuid(),
});

const CreateScheduleRequestBaseSchema = z.object({
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

export const CreateScheduleRequestSchema = CreateScheduleRequestBaseSchema
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
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const ScheduleOwnerRequiredErrorSchema = z.object({
  error: z.literal('schedule_owner_required'),
  message: z.string().min(1),
});
export type ScheduleOwnerRequiredError = z.infer<typeof ScheduleOwnerRequiredErrorSchema>;

export const UpdateScheduleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable().optional(),
    recurrence: ScheduleRecurrenceSchema.optional(),
    cronExpression: ScheduleCronExpressionSchema.optional(),
    timezone: ScheduleTimezoneSchema.optional(),
    taskTemplate: ScheduleTaskTemplateCreateSchema.optional(),
    enabled: z.boolean().optional(),
    overlapPolicy: ScheduleOverlapPolicySchema.optional(),
    misfirePolicy: ScheduleMisfirePolicySchema.optional(),
  })
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
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequestSchema>;

export const ScheduleLatestRunSchema = z.object({
  id: z.string().uuid(),
  scheduledFor: z.coerce.date(),
  status: ScheduleRunStatusSchema,
  taskId: z.string().uuid().nullable(),
  error: z.string().nullable(),
});
export type ScheduleLatestRun = z.infer<typeof ScheduleLatestRunSchema>;

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
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;

export const ScheduleRunResponseSchema = z.object({
  id: z.string().uuid(),
  scheduleId: z.string().uuid(),
  scheduledFor: z.coerce.date(),
  status: ScheduleRunStatusSchema,
  taskId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
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
  }
}
