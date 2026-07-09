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

export const ScheduleTaskTemplateSchema = CreateTaskRequestSchema.extend({
  repoId: z.string().uuid(),
  runtime: RuntimeSchema.default(DEFAULT_TASK_RUNTIME),
  sandboxEnvironmentId: z.string().uuid().nullable(),
  deliver: DeliverSchema.default('none'),
});
export type ScheduleTaskTemplate = z.infer<typeof ScheduleTaskTemplateSchema>;

export const CreateScheduleRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).nullable().optional(),
  cronExpression: ScheduleCronExpressionSchema,
  timezone: ScheduleTimezoneSchema.default('UTC'),
  taskTemplate: CreateTaskRequestSchema.extend({
    repoId: z.string().uuid(),
  }),
  enabled: z.boolean().optional(),
  overlapPolicy: ScheduleOverlapPolicySchema.default('skip'),
  misfirePolicy: ScheduleMisfirePolicySchema.default('fire-once'),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const ScheduleOwnerRequiredErrorSchema = z.object({
  error: z.literal('schedule_owner_required'),
  message: z.string().min(1),
});
export type ScheduleOwnerRequiredError = z.infer<typeof ScheduleOwnerRequiredErrorSchema>;

export const UpdateScheduleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable().optional(),
    cronExpression: ScheduleCronExpressionSchema.optional(),
    timezone: ScheduleTimezoneSchema.optional(),
    taskTemplate: CreateTaskRequestSchema.extend({
      repoId: z.string().uuid(),
    }).optional(),
    enabled: z.boolean().optional(),
    overlapPolicy: ScheduleOverlapPolicySchema.optional(),
    misfirePolicy: ScheduleMisfirePolicySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one schedule field must be provided',
  });
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
