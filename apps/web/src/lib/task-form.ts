import type {
  CreateScheduleRequest,
  CreateTaskRequest,
  Deliver,
  Runtime,
  ScheduleRecurrence,
  ScheduleResponse,
  UpdateScheduleRequest,
} from "@cap/contracts";

export const ENVIRONMENT_DEFAULT = "__default__";
export const ENVIRONMENT_SERVER_DEFAULT = "__server_default__";
export const DEFAULT_RECURRENCE_TIME = "09:00";
export const DEFAULT_RECURRENCE_TIMEZONE = "UTC";

export type RecurrenceFormKind = ScheduleRecurrence["kind"] | "custom";

export interface TaskTemplateFormState {
  repoId: string;
  runtime: Runtime;
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
  timezone: string;
  weekday: number;
  dayOfMonth: number;
  overlapPolicy: "skip" | "enqueue";
}

export function emptyTaskTemplateForm(
  repoId: string,
  runtime: Runtime,
): TaskTemplateFormState {
  return {
    repoId,
    runtime,
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
  return {
    repoId: template.repoId,
    runtime: template.runtime ?? defaultRuntime,
    sandboxEnvironmentId:
      template.sandboxEnvironmentId ?? ENVIRONMENT_SERVER_DEFAULT,
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
      recurrence.kind === "custom" ? DEFAULT_RECURRENCE_TIME : recurrence.time,
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
  const base = {
    time: form.recurrenceTime.trim() || DEFAULT_RECURRENCE_TIME,
    timezone: form.timezone.trim() || DEFAULT_RECURRENCE_TIMEZONE,
  };
  switch (form.recurrenceKind) {
    case "daily":
      return { kind: "daily", ...base };
    case "weekdays":
      return { kind: "weekdays", ...base };
    case "weekly":
      return { kind: "weekly", weekday: form.weekday, ...base };
    case "monthly":
      return { kind: "monthly", dayOfMonth: form.dayOfMonth, ...base };
    case "custom":
      throw new Error("Custom schedule timing cannot be converted to recurrence");
  }
}

export function recurrenceSummary(schedule: ScheduleResponse): string {
  return schedule.recurrence.label;
}
