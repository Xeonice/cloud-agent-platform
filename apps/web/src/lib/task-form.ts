import {
  SCHEDULE_MINUTE_INTERVALS,
  type CreateScheduleRequest,
  type CreateTaskRequest,
  type Deliver,
  type Runtime,
  type ScheduleMinuteInterval,
  type ScheduleRecurrence,
  type ScheduleResponse,
  type UpdateScheduleRequest,
} from "@cap/contracts";

import { SCHEDULE_TIMEZONE_FALLBACK } from "./schedule-timezone";

export const ENVIRONMENT_DEFAULT = "__default__";
export const ENVIRONMENT_SERVER_DEFAULT = "__server_default__";
export const DEFAULT_RECURRENCE_TIME = "09:00";
export const DEFAULT_RECURRENCE_TIMEZONE = SCHEDULE_TIMEZONE_FALLBACK;
export const DEFAULT_RECURRENCE_MINUTE_OF_HOUR = 0;
export const DEFAULT_RECURRENCE_INTERVAL_MINUTES =
  SCHEDULE_MINUTE_INTERVALS[0];

export type RecurrenceFormKind = ScheduleRecurrence["kind"] | "custom";

export interface TaskTemplateFormState {
  repoId: string;
  runtime: Runtime;
  /** Null keeps the selected runtime's default model. */
  model: string | null;
  sandboxEnvironmentId: string;
  deliver: Deliver;
  branch: string;
  strategy: string;
  skills: string[];
  idleTimeoutMs: number | null;
  deadlineMs: number | null;
  prompt: string;
}

export interface ScheduleFormState extends TaskTemplateFormState {
  id: string | null;
  name: string;
  recurrenceKind: RecurrenceFormKind;
  recurrenceTime: string;
  minuteOfHour: number;
  intervalMinutes: ScheduleMinuteInterval;
  timezone: string;
  weekday: number;
  dayOfMonth: number;
  overlapPolicy: "skip" | "enqueue";
}

/**
 * Project a verified persisted repository default into the Select form value.
 * An empty value intentionally means "omit branch" so legacy repositories can
 * use the authenticated backend resolution path instead of inventing a ref.
 */
export function taskBranchFormValue(
  defaultBranch: string | null | undefined,
): string {
  return defaultBranch ?? "";
}

/**
 * Build the branch Select options without ever emitting Radix's forbidden
 * empty item. The current value is retained for schedule edits whose explicit
 * branch differs from the repository default.
 */
export function taskBranchOptions(
  defaultBranch: string | null | undefined,
  currentBranch: string,
): string[] {
  const options = new Set<string>();
  if (defaultBranch) options.add(defaultBranch);
  if (currentBranch) options.add(currentBranch);
  return [...options];
}

export function emptyTaskTemplateForm(
  repoId: string,
  runtime: Runtime,
): TaskTemplateFormState {
  return {
    repoId,
    runtime,
    model: null,
    sandboxEnvironmentId: ENVIRONMENT_DEFAULT,
    deliver: "none",
    branch: "",
    strategy: "",
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    prompt: "",
  };
}

export function emptyScheduleForm(
  repoId: string,
  runtime: Runtime,
): ScheduleFormState {
  return {
    ...emptyTaskTemplateForm(repoId, runtime),
    id: null,
    name: "",
    recurrenceKind: "weekdays",
    recurrenceTime: DEFAULT_RECURRENCE_TIME,
    minuteOfHour: DEFAULT_RECURRENCE_MINUTE_OF_HOUR,
    intervalMinutes: DEFAULT_RECURRENCE_INTERVAL_MINUTES,
    timezone: DEFAULT_RECURRENCE_TIMEZONE,
    weekday: 1,
    dayOfMonth: 1,
    overlapPolicy: "skip",
  };
}

export function taskTemplateFormFromSchedule(
  schedule: ScheduleResponse,
  defaultRuntime: Runtime,
): TaskTemplateFormState {
  const template = schedule.taskTemplate;
  let sandboxEnvironmentId = ENVIRONMENT_DEFAULT;
  if (Object.prototype.hasOwnProperty.call(template, "sandboxEnvironmentId")) {
    if (template.sandboxEnvironmentId === null) {
      sandboxEnvironmentId = ENVIRONMENT_SERVER_DEFAULT;
    } else if (template.sandboxEnvironmentId !== undefined) {
      sandboxEnvironmentId = template.sandboxEnvironmentId;
    }
  }
  return {
    repoId: template.repoId,
    runtime: template.runtime ?? defaultRuntime,
    model: template.model ?? null,
    sandboxEnvironmentId,
    deliver: template.deliver ?? "none",
    branch: template.branch ?? "",
    strategy: template.strategy ?? "",
    skills: template.skills ?? [],
    idleTimeoutMs: template.idleTimeoutMs ?? null,
    deadlineMs: template.deadlineMs ?? null,
    prompt: template.prompt,
  };
}

export function scheduleFormFromSchedule(
  schedule: ScheduleResponse,
  defaultRuntime: Runtime,
): ScheduleFormState {
  const recurrence = schedule.recurrence;
  return {
    ...taskTemplateFormFromSchedule(schedule, defaultRuntime),
    id: schedule.id,
    name: schedule.name ?? "",
    recurrenceKind: recurrence.kind,
    recurrenceTime:
      recurrence.kind === "daily" ||
      recurrence.kind === "weekdays" ||
      recurrence.kind === "weekly" ||
      recurrence.kind === "monthly"
        ? recurrence.time
        : DEFAULT_RECURRENCE_TIME,
    minuteOfHour:
      recurrence.kind === "hourly"
        ? recurrence.minuteOfHour
        : DEFAULT_RECURRENCE_MINUTE_OF_HOUR,
    intervalMinutes:
      recurrence.kind === "minuteInterval"
        ? recurrence.intervalMinutes
        : DEFAULT_RECURRENCE_INTERVAL_MINUTES,
    timezone: recurrence.timezone,
    weekday: recurrence.kind === "weekly" ? recurrence.weekday : 1,
    dayOfMonth: recurrence.kind === "monthly" ? recurrence.dayOfMonth : 1,
    overlapPolicy: schedule.overlapPolicy,
  };
}

export function buildTaskRequest(form: TaskTemplateFormState): CreateTaskRequest {
  const body: CreateTaskRequest = { prompt: form.prompt.trim() };
  if (form.branch.trim()) body.branch = form.branch.trim();
  if (form.strategy.trim()) body.strategy = form.strategy.trim();
  if (form.skills.length > 0) body.skills = form.skills;
  if (form.runtime !== "codex") body.runtime = form.runtime;
  if (form.model !== null) body.model = form.model;
  if (form.sandboxEnvironmentId === ENVIRONMENT_SERVER_DEFAULT) {
    body.sandboxEnvironmentId = null;
  } else if (form.sandboxEnvironmentId !== ENVIRONMENT_DEFAULT) {
    body.sandboxEnvironmentId = form.sandboxEnvironmentId;
  }
  if (form.deliver !== "none") body.deliver = form.deliver;
  if (form.idleTimeoutMs != null) body.idleTimeoutMs = form.idleTimeoutMs;
  if (form.deadlineMs != null) body.deadlineMs = form.deadlineMs;
  return body;
}

export function buildSchedulePayload(
  form: ScheduleFormState,
  currentSchedule?: Pick<ScheduleResponse, "cronExpression" | "timezone">,
): CreateScheduleRequest & UpdateScheduleRequest {
  const taskTemplate: CreateScheduleRequest["taskTemplate"] = {
    repoId: form.repoId,
    ...buildTaskRequest(form),
  };
  const payload = {
    name: form.name.trim() || null,
    overlapPolicy: form.overlapPolicy,
    misfirePolicy: "fire-once" as const,
    taskTemplate,
    ...buildScheduleTiming(form, currentSchedule),
  };
  return payload as CreateScheduleRequest & UpdateScheduleRequest;
}

function buildScheduleTiming(
  form: ScheduleFormState,
  currentSchedule?: Pick<ScheduleResponse, "cronExpression" | "timezone">,
): Pick<CreateScheduleRequest, "recurrence"> |
  Pick<CreateScheduleRequest, "cronExpression" | "timezone"> {
  if (form.recurrenceKind === "custom") {
    if (!currentSchedule) {
      throw new Error("Custom schedule timing requires an existing schedule");
    }
    return {
      cronExpression: currentSchedule.cronExpression,
      timezone: currentSchedule.timezone,
    };
  }
  return {
    recurrence: buildRecurrence(form),
  };
}

export function buildRecurrence(form: ScheduleFormState): ScheduleRecurrence {
  const timezone = {
    timezone: form.timezone.trim() || DEFAULT_RECURRENCE_TIMEZONE,
  };
  const calendar = {
    ...timezone,
    time: form.recurrenceTime.trim() || DEFAULT_RECURRENCE_TIME,
  };
  switch (form.recurrenceKind) {
    case "daily":
      return { kind: "daily", ...calendar };
    case "weekdays":
      return { kind: "weekdays", ...calendar };
    case "weekly":
      return { kind: "weekly", weekday: form.weekday, ...calendar };
    case "monthly":
      return { kind: "monthly", dayOfMonth: form.dayOfMonth, ...calendar };
    case "hourly":
      return { kind: "hourly", minuteOfHour: form.minuteOfHour, ...timezone };
    case "minuteInterval":
      return {
        kind: "minuteInterval",
        intervalMinutes: form.intervalMinutes,
        ...timezone,
      };
    case "custom":
      throw new Error("Custom schedule timing cannot be converted to recurrence");
  }
}

export function recurrenceSummary(schedule: ScheduleResponse): string {
  return schedule.recurrence.label;
}
