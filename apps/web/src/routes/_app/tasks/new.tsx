/**
 * `/tasks/new` — 创建任务 / 高级派发 (app-shell, SSR; Track 17 fe-page-create-task).
 *
 * The standalone advanced create-task page rendered inside the `_app` shell
 * `<Outlet/>` (the sidebar + topbar + mobile-nav already exist — this route does
 * NOT rebuild the shell; it builds only the page body). It is the full-page
 * sibling of the dashboard's `NewTaskDialog`: same execution-boundary framing,
 * but with the preflight tiles + the side命令预览/执行边界 stack laid out as a
 * page instead of a modal.
 *
 * Form logic is REUSED from the dashboard dialog rather than re-implemented:
 *   - `buildCommandPreview` (the pure `agentctl run …` composer, exported by
 *     `@/components/dashboard/new-task-dialog`) drives the live command preview,
 *     so the preview NEVER implies an unsent field — only operator-entered
 *     values are emitted, and the prompt shows `<待填写>` until typed.
 *   - submit goes through the SAME shared `createTaskMutation` (REAL
 *     `POST /repos/:repoId/tasks`) with a `CreateTaskRequest` body composed
 *     strictly from the contract (prompt + optional branch/strategy). No bespoke
 *     POST. On success: surface the REAL `task.id` as the result run id + a
 *     deep-link into `/tasks/$taskId`, persist `selectedRepo` to the store, and
 *     toast「任务已进入远端 Agent 队列」.
 *
 * Boundary honesty (D5.5): the branch/strategy selects feed the PREVIEW; the
 * created task only reflects what was actually posted. The repo options are
 * restricted to the imported repo set (the security scope), and the branch
 * options derive from the selected repo's default branch (the contract exposes
 * no branch list — we do not fabricate the prototype's static branches).
 *
 * SSR-safe: deterministic render off `reposQuery`/`metricsQuery` data; all form
 * state is plain `useState`. No window/clock/random during render or at module
 * top-level.
 */
import * as React from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { Repo } from "@cap/contracts";
import {
  metricsQuery,
  reposQuery,
  runtimesQuery,
  sandboxEnvironmentsQuery,
  schedulesQuery,
  settingsQuery,
} from "@/lib/api/queries";
import type { RuntimeId } from "@/lib/api/real";
import {
  createScheduleMutation,
  createTaskMutation,
  updateScheduleMutation,
} from "@/lib/api/mutations";
import { setState } from "@/lib/store";
import {
  buildCommandPreview,
  RUNTIME_CATALOG,
  DEFAULT_RUNTIME,
  SKILL_CATALOG,
  IDLE_TIMEOUT_OPTIONS,
  DEADLINE_OPTIONS,
  guardrailSelectValue,
  parseGuardrailSelectValue,
  environmentCompatibleWithRuntime,
} from "@/components/dashboard/new-task-dialog";
import {
  buildSchedulePayload,
  buildTaskRequest,
  DEFAULT_RECURRENCE_TIME,
  DEFAULT_RECURRENCE_TIMEZONE,
  ENVIRONMENT_DEFAULT,
  ENVIRONMENT_SERVER_DEFAULT,
  scheduleFormFromSchedule,
  type RecurrenceFormKind,
  type ScheduleFormState,
  type TaskTemplateFormState,
} from "@/lib/task-form";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import { Panel, PanelHead } from "@/components/settings/panel";
import { StatusPill } from "@/components/status-pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils";

export const Route = createFileRoute("/_app/tasks/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    scheduleId:
      typeof search.scheduleId === "string" && search.scheduleId.length > 0
        ? search.scheduleId
        : undefined,
  }),
  loader: async ({ context }) => {
    // The repo list scopes the form to the imported set; ensure it before render
    // so the repo select is hydrated (no waterfall on the create form).
    await Promise.all([
      context.queryClient.ensureQueryData(reposQuery()),
      context.queryClient.ensureQueryData(schedulesQuery()),
    ]);
  },
  component: NewTaskPage,
});

/** The 3 prototype execution strategies (verbatim copy; the value == the label). */
const STRATEGIES = [
  "先读仓库与 AGENTS.md，再给出计划",
  "允许直接修改，但提交前停止",
  "只读审查，不写入文件",
] as const;

const WEEKDAY_OPTIONS = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
] as const;

/** Resolve a repo's display full-name (`owner/name` slug from gitSource, or name). */
function repoFullName(repo: Repo): string {
  const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? repo.name;
}

/** One preflight stat-tile (eyebrow mono label / strong headline / caption). */
function PreflightTile({
  label,
  headline,
  caption,
}: {
  label: string;
  headline: string;
  caption: string;
}) {
  return (
    <article className="min-w-0 rounded-lg bg-card p-3.5 shadow-card">
      <span className="block font-mono text-xs tabular-nums text-muted-foreground">
        {label}
      </span>
      <strong className="mt-2 block text-[clamp(19px,2vw,26px)] leading-[1.15] font-semibold tracking-[-0.6px] text-ink">
        {headline}
      </strong>
      <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
        {caption}
      </p>
    </article>
  );
}

/** The dark mono command-preview block (same dark style as the dashboard dialog). */
function CommandPreview({ lines }: { lines: readonly string[] }) {
  return (
    <pre
      data-command-preview
      className="flex max-h-[230px] min-w-0 flex-col gap-1.5 overflow-auto rounded-md bg-[#080808] p-3.5 font-mono text-xs leading-[1.6] text-[#e8e8e8]"
    >
      {lines.map((line, i) => (
        // `whitespace-pre-wrap` keeps the command indentation but WRAPS long
        // content (a long --prompt) inside the box; `overflow-wrap:anywhere`
        // breaks an unbroken token so the line can never force the preview wider
        // than its column (which previously broke the whole new-task layout).
        <code key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {line}
        </code>
      ))}
    </pre>
  );
}

/** One execution-boundary row (label muted / value strong, right-aligned). */
function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-3 text-[13px] last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <strong className="text-right font-semibold text-ink">{value}</strong>
    </div>
  );
}

function NewTaskPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { scheduleId } = Route.useSearch();
  const { data: repos } = useQuery(reposQuery());
  const { data: metrics } = useQuery(metricsQuery());
  const schedules = useQuery({
    ...schedulesQuery(),
    enabled: Boolean(scheduleId),
  });
  const mutation = useMutation(createTaskMutation(queryClient));
  const createSchedule = useMutation(createScheduleMutation(queryClient));
  const updateSchedule = useMutation(updateScheduleMutation(queryClient));

  const repoList = repos ?? [];
  const editingSchedule =
    scheduleId && schedules.data
      ? schedules.data.find((schedule) => schedule.id === scheduleId) ?? null
      : null;

  const firstRepoId = repoList[0]?.id ?? "";
  const [repoId, setRepoId] = React.useState(firstRepoId);

  // Keep the selected repo valid as the repo list resolves/changes.
  React.useEffect(() => {
    const first = repoList[0];
    if (first && !repoList.some((r) => r.id === repoId)) {
      setRepoId(first.id);
    }
  }, [repoList, repoId]);

  const selectedRepo = repoList.find((r) => r.id === repoId) ?? null;
  const defaultBranch = selectedRepo?.defaultBranch ?? "main";

  const [branch, setBranch] = React.useState(defaultBranch);
  const [strategy, setStrategy] = React.useState<string>(STRATEGIES[0]);
  const [skills, setSkills] = React.useState<string[]>([]);
  const [prompt, setPrompt] = React.useState("");
  // add-claude-code-runtime VR-2: stopOnWrite is ADVISORY only, never an enforced
  // gate — the agent runs ungated inside the sandbox (the sandbox is the trust
  // boundary, matching codex). Forced off so the command preview never emits the
  // misleading `--confirm-before-write` flag.
  const stopOnWrite = false;
  // add-claude-code-runtime: the runtime selector, mirroring the dashboard dialog
  // (shares RUNTIME_CATALOG/DEFAULT_RUNTIME so the two create surfaces never drift).
  // Gated on the booleans-only `/runtimes` readiness read — an unconfigured runtime
  // is shown disabled with a configure hint, never selectable-and-failing-at-launch.
  const [runtime, setRuntime] = React.useState<RuntimeId>(DEFAULT_RUNTIME);
  const runtimesReadiness = useQuery(runtimesQuery());
  const sandboxEnvironments = useQuery(sandboxEnvironmentsQuery());
  const settings = useQuery(settingsQuery());
  const readyById = React.useMemo(() => {
    const map = new Map<RuntimeId, boolean>();
    for (const r of runtimesReadiness.data ?? []) map.set(r.id, r.ready);
    return map;
  }, [runtimesReadiness.data]);
  const isRuntimeReady = (id: RuntimeId): boolean => readyById.get(id) === true;
  const [sandboxEnvironmentId, setSandboxEnvironmentId] =
    React.useState(ENVIRONMENT_DEFAULT);
  // Guardrails are OPT-IN, default off/none (task-guardrail-controls).
  const [idleTimeoutMs, setIdleTimeoutMs] = React.useState<number | null>(null);
  const [deadlineMs, setDeadlineMs] = React.useState<number | null>(null);
  const [createdTaskId, setCreatedTaskId] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"once" | "repeated">(
    scheduleId ? "repeated" : "once",
  );
  const [loadedScheduleId, setLoadedScheduleId] = React.useState<string | null>(null);
  const [scheduleName, setScheduleName] = React.useState("");
  const [recurrenceKind, setRecurrenceKind] =
    React.useState<RecurrenceFormKind>("weekdays");
  const [recurrenceTime, setRecurrenceTime] = React.useState(DEFAULT_RECURRENCE_TIME);
  const [timezone, setTimezone] = React.useState(DEFAULT_RECURRENCE_TIMEZONE);
  const [weekday, setWeekday] = React.useState(1);
  const [dayOfMonth, setDayOfMonth] = React.useState(1);
  const [overlapPolicy, setOverlapPolicy] =
    React.useState<ScheduleFormState["overlapPolicy"]>("skip");

  function toggleSkill(id: string) {
    setSkills((cur) =>
      cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id],
    );
  }

  // When the selected repo changes, reset the branch to that repo's default
  // (the contract exposes no branch list — the runner gets a clean workspace
  // for the repo default, mirroring the dashboard dialog).
  React.useEffect(() => {
    if (scheduleId) return;
    setBranch(defaultBranch);
  }, [defaultBranch, scheduleId]);

  const readyEnvironments = React.useMemo(
    () =>
      (sandboxEnvironments.data?.environments ?? []).filter((environment) =>
        environmentCompatibleWithRuntime(environment, runtime),
      ),
    [sandboxEnvironments.data?.environments, runtime],
  );
  const selectedEnvironment =
    readyEnvironments.find((environment) => environment.id === sandboxEnvironmentId) ??
    null;
  const accountDefaultEnvironmentId =
    settings.data?.defaultSandboxEnvironmentId ?? null;
  const accountDefaultEnvironment =
    accountDefaultEnvironmentId === null
      ? null
      : readyEnvironments.find(
          (environment) => environment.id === accountDefaultEnvironmentId,
        ) ?? null;
  const accountDefaultUnavailable =
    sandboxEnvironmentId === ENVIRONMENT_DEFAULT &&
    accountDefaultEnvironmentId !== null &&
    sandboxEnvironments.isSuccess &&
    !accountDefaultEnvironment;
  const previewEnvironment =
    selectedEnvironment ??
    (sandboxEnvironmentId === ENVIRONMENT_DEFAULT
      ? accountDefaultEnvironment
      : null);

  React.useEffect(() => {
    if (
      sandboxEnvironmentId === ENVIRONMENT_DEFAULT ||
      sandboxEnvironmentId === ENVIRONMENT_SERVER_DEFAULT
    ) {
      return;
    }
    if (readyEnvironments.some((environment) => environment.id === sandboxEnvironmentId)) {
      return;
    }
    setSandboxEnvironmentId(ENVIRONMENT_DEFAULT);
  }, [readyEnvironments, sandboxEnvironmentId]);

  React.useEffect(() => {
    if (!editingSchedule || loadedScheduleId === editingSchedule.id) return;
    const form = scheduleFormFromSchedule(editingSchedule, DEFAULT_RUNTIME);
    setMode("repeated");
    setLoadedScheduleId(editingSchedule.id);
    setRepoId(form.repoId);
    setRuntime(form.runtime);
    setSandboxEnvironmentId(form.sandboxEnvironmentId);
    setBranch(form.branch);
    setStrategy(form.strategy);
    setSkills(form.skills);
    setIdleTimeoutMs(form.idleTimeoutMs);
    setDeadlineMs(form.deadlineMs);
    setPrompt(form.prompt);
    setScheduleName(form.name);
    setRecurrenceKind(form.recurrenceKind);
    setRecurrenceTime(form.recurrenceTime);
    setTimezone(form.timezone);
    setWeekday(form.weekday);
    setDayOfMonth(form.dayOfMonth);
    setOverlapPolicy(form.overlapPolicy);
  }, [editingSchedule, loadedScheduleId]);

  const branchOptions = React.useMemo(() => {
    const set = new Set<string>([defaultBranch]);
    if (branch) set.add(branch);
    return [...set];
  }, [branch, defaultBranch]);

  // CJK-aware character count over the spread code points (prototype cadence).
  const charCount = [...prompt.trim()].length;

  const commandLines = buildCommandPreview({
    repoFullName: selectedRepo ? repoFullName(selectedRepo) : null,
    branch: branch || null,
    strategy: strategy || null,
    runtime,
    prompt,
    stopOnWrite,
    skills,
    idleTimeoutMs,
    deadlineMs,
    sandboxEnvironmentName: previewEnvironment?.name ?? null,
  });

  // Free remote slots, when the (mock-today) metrics resolve; else keep the
  // prototype copy verbatim rather than fabricate a number.
  const free = metrics?.capacity.free;
  const runnerCaption =
    typeof free === "number"
      ? `当前还有 ${free} 个空闲远端槽位。`
      : "当前还有 3 个空闲远端槽位。";

  const createdTask = mutation.data;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repoId || prompt.trim().length === 0) return;
    if (accountDefaultUnavailable) return;
    const taskForm: TaskTemplateFormState = {
      repoId,
      runtime,
      sandboxEnvironmentId,
      deliver: "none",
      branch,
      strategy,
      skills,
      idleTimeoutMs,
      deadlineMs,
      prompt,
    };
    if (mode === "repeated") {
      const scheduleForm: ScheduleFormState = {
        ...taskForm,
        id: editingSchedule?.id ?? null,
        name: scheduleName,
        recurrenceKind,
        recurrenceTime,
        timezone,
        weekday,
        dayOfMonth,
        overlapPolicy,
      };
      const body = buildSchedulePayload(scheduleForm, editingSchedule ?? undefined);
      if (editingSchedule) {
        updateSchedule.mutate(
          { id: editingSchedule.id, body },
          {
            onSuccess: () => {
              setState({ selectedRepo: repoId });
              toast.success("定时任务已更新");
              void navigate({ to: "/schedules" });
            },
          },
        );
        return;
      }
      createSchedule.mutate(body, {
        onSuccess: () => {
          setState({ selectedRepo: repoId });
          toast.success("定时任务已创建");
          void navigate({ to: "/schedules" });
        },
      });
      return;
    }
    const body = buildTaskRequest(taskForm);
    mutation.mutate(
      { repoId, body },
      {
        onSuccess: (task) => {
          setCreatedTaskId(task.id);
          // Persist the operator's last repo selection for re-entry.
          setState({ selectedRepo: repoId });
          toast.success("任务已进入远端 Agent 队列");
          // Navigate straight into the created task's session (mirrors the
          // dashboard dialog); the session page shows a friendly pre-running
          // state until the sandbox is provisioned.
          void navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
        },
      },
    );
  }

  const submitDisabled =
    mutation.isPending ||
    createSchedule.isPending ||
    updateSchedule.isPending ||
    prompt.trim().length === 0 ||
    accountDefaultUnavailable ||
    (mode === "repeated" && recurrenceKind === "custom" && !editingSchedule);
  const submitting =
    mutation.isPending || createSchedule.isPending || updateSchedule.isPending;

  return (
    <>
      {/* Screen header */}
      <section className="mb-[18px] grid items-center gap-4">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            新建任务
          </div>
          <h1 className="mt-1 max-w-[880px] text-[clamp(24px,3vw,32px)] leading-[1.18] font-semibold tracking-[-0.8px] text-foreground">
            高级派发
          </h1>
          <p className="mt-2.5 max-w-[780px] text-base leading-[1.6] text-muted-foreground">
            当任务需要更明确的边界时，从这里预检仓库、策略和写入保护；轻量任务仍可直接在控制台弹窗创建。
          </p>
        </div>
      </section>

      {/* Preflight grid */}
      <section
        aria-label="任务预检"
        className="my-[14px] grid grid-cols-1 gap-2.5 min-[821px]:grid-cols-2 min-[1181px]:grid-cols-3"
      >
        <PreflightTile
          label="REPOSITORY"
          headline="已导入仓库"
          caption="只允许从仓库范围里选择任务上下文。"
        />
        <PreflightTile
          label="RUNNER"
          headline="iad-02 可接入"
          caption={runnerCaption}
        />
        <PreflightTile
          label="GUARDRAIL"
          headline="沙箱即信任边界"
          caption="Agent 在隔离容器内自主执行，凭据用后即焚。"
        />
      </section>

      {/* Form grid */}
      <section className="grid gap-3 min-[1181px]:grid-cols-[minmax(0,0.9fr)_minmax(320px,1.1fr)]">
        {/* Left: the task form */}
        <form
          onSubmit={handleSubmit}
          className="grid content-start gap-3.5 rounded-md bg-card p-5 shadow-card"
        >
          <div className="grid gap-2">
            <span className="text-[13px] font-semibold text-ink">执行方式</span>
            <div className="grid grid-cols-2 overflow-hidden rounded-md border border-line bg-card p-1">
              <button
                type="button"
                onClick={() => setMode("once")}
                disabled={Boolean(editingSchedule)}
                className={cn(
                  "h-8 rounded-sm text-sm font-medium disabled:pointer-events-none disabled:opacity-50",
                  mode === "once"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                立即运行
              </button>
              <button
                type="button"
                onClick={() => setMode("repeated")}
                className={cn(
                  "h-8 rounded-sm text-sm font-medium",
                  mode === "repeated"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                重复运行
              </button>
            </div>
          </div>

          {mode === "repeated" ? (
            <div className="grid gap-3 rounded-md border border-line bg-[#fafafa] p-3">
              <div className="grid gap-2">
                <label htmlFor="scheduleName" className="text-[13px] font-semibold text-ink">
                  计划名称
                </label>
                <input
                  id="scheduleName"
                  value={scheduleName}
                  onChange={(event) => setScheduleName(event.target.value)}
                  placeholder="工作日检查"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="grid gap-3 min-[821px]:grid-cols-2">
                <div className="grid gap-2">
                  <label
                    htmlFor="recurrenceKind"
                    className="text-[13px] font-semibold text-ink"
                  >
                    重复频率
                  </label>
                  <Select
                    value={recurrenceKind}
                    onValueChange={(value) =>
                      setRecurrenceKind(value as RecurrenceFormKind)
                    }
                  >
                    <SelectTrigger id="recurrenceKind" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {recurrenceKind === "custom" ? (
                        <SelectItem value="custom">自定义重复（保留）</SelectItem>
                      ) : null}
                      <SelectItem value="daily">每天</SelectItem>
                      <SelectItem value="weekdays">工作日</SelectItem>
                      <SelectItem value="weekly">每周</SelectItem>
                      <SelectItem value="monthly">每月</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <label
                    htmlFor="recurrenceTime"
                    className="text-[13px] font-semibold text-ink"
                  >
                    触发时间
                  </label>
                  <input
                    id="recurrenceTime"
                    type="time"
                    value={recurrenceTime}
                    onChange={(event) => setRecurrenceTime(event.target.value)}
                    disabled={recurrenceKind === "custom"}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  />
                </div>
              </div>
              {recurrenceKind === "weekly" ? (
                <div className="grid gap-2">
                  <label htmlFor="weekday" className="text-[13px] font-semibold text-ink">
                    每周哪一天
                  </label>
                  <Select
                    value={String(weekday)}
                    onValueChange={(value) => setWeekday(Number(value))}
                  >
                    <SelectTrigger id="weekday" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={String(option.value)}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {recurrenceKind === "monthly" ? (
                <div className="grid gap-2">
                  <label
                    htmlFor="dayOfMonth"
                    className="text-[13px] font-semibold text-ink"
                  >
                    每月哪一天
                  </label>
                  <Select
                    value={String(dayOfMonth)}
                    onValueChange={(value) => setDayOfMonth(Number(value))}
                  >
                    <SelectTrigger id="dayOfMonth" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 28 }, (_, index) => index + 1).map(
                        (day) => (
                          <SelectItem key={day} value={String(day)}>
                            {day} 日
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="grid gap-3 min-[821px]:grid-cols-2">
                <div className="grid gap-2">
                  <label htmlFor="timezone" className="text-[13px] font-semibold text-ink">
                    时区
                  </label>
                  <input
                    id="timezone"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    disabled={recurrenceKind === "custom"}
                    placeholder="UTC"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  />
                </div>
                <div className="grid gap-2">
                  <label
                    htmlFor="overlapPolicy"
                    className="text-[13px] font-semibold text-ink"
                  >
                    上次未结束时
                  </label>
                  <Select
                    value={overlapPolicy}
                    onValueChange={(value) =>
                      setOverlapPolicy(value as ScheduleFormState["overlapPolicy"])
                    }
                  >
                    <SelectTrigger id="overlapPolicy" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="skip">跳过本次</SelectItem>
                      <SelectItem value="enqueue">继续排队</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ) : null}

          <div className="grid gap-2">
            <label htmlFor="runtime" className="text-[13px] font-semibold text-ink">
              运行时
            </label>
            <Select
              value={runtime}
              onValueChange={(v) => setRuntime(v as RuntimeId)}
            >
              <SelectTrigger id="runtime" className="w-full">
                <SelectValue placeholder="选择运行时" />
              </SelectTrigger>
              <SelectContent>
                {RUNTIME_CATALOG.map((rt) => {
                  const ready = isRuntimeReady(rt.id);
                  return (
                    <SelectItem key={rt.id} value={rt.id} disabled={!ready}>
                      {ready ? rt.label : `${rt.label}（未配置）`}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <small className="text-xs text-muted-foreground">
              选择派发到哪个 Agent；未配置凭据的运行时会被禁用，请先在设置中连接。
            </small>
          </div>

          <div className="grid gap-2">
            <label htmlFor="environment" className="text-[13px] font-semibold text-ink">
              沙箱运行环境
            </label>
            <Select
              value={sandboxEnvironmentId}
              onValueChange={setSandboxEnvironmentId}
            >
              <SelectTrigger id="environment" className="w-full">
                <SelectValue placeholder="使用默认环境" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ENVIRONMENT_DEFAULT}>
                  使用我的默认镜像
                  <small className="ml-1.5 text-xs text-muted-foreground">
                    未设置时沿用服务端默认
                  </small>
                </SelectItem>
                <SelectItem value={ENVIRONMENT_SERVER_DEFAULT}>
                  使用服务端默认
                  <small className="ml-1.5 text-xs text-muted-foreground">
                    本次任务不跟随账号默认
                  </small>
                </SelectItem>
                {readyEnvironments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name}
                    <small className="ml-1.5 text-xs text-muted-foreground">
                      {environment.source.kind}
                    </small>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <small className="text-xs text-muted-foreground">
              {accountDefaultUnavailable
                ? "当前账号默认镜像不兼容此运行时，请选择其他镜像或服务端默认。"
                : accountDefaultEnvironment
                  ? `当前账号默认：${accountDefaultEnvironment.name}`
                  : "未设置账号默认时，会沿用服务端部署默认。"}
            </small>
          </div>

          <div className="grid gap-2">
            <label htmlFor="repo" className="text-[13px] font-semibold text-ink">
              仓库
            </label>
            <Select value={repoId} onValueChange={setRepoId}>
              <SelectTrigger id="repo" className="w-full">
                <SelectValue placeholder="选择仓库" />
              </SelectTrigger>
              <SelectContent>
                {repoList.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repoFullName(repo)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <small className="text-xs text-muted-foreground">
              仓库列表来自已导入仓库。
            </small>
          </div>

          <div className="grid gap-2">
            <label htmlFor="branch" className="text-[13px] font-semibold text-ink">
              分支
            </label>
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger id="branch" className="w-full">
                <SelectValue placeholder="选择分支" />
              </SelectTrigger>
              <SelectContent>
                {branchOptions.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <small className="text-xs text-muted-foreground">
              Agent 会为这个分支获得一个干净的远端工作区。
            </small>
          </div>

          <div className="grid gap-2">
            <label htmlFor="strategy" className="text-[13px] font-semibold text-ink">
              执行策略
            </label>
            <Select value={strategy} onValueChange={setStrategy}>
              <SelectTrigger id="strategy" className="w-full">
                <SelectValue placeholder="选择策略" />
              </SelectTrigger>
              <SelectContent>
                {STRATEGIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <small className="text-xs text-muted-foreground">
              策略会进入命令预览，帮助操作者在派发前确认边界。
            </small>
          </div>

          <div className="grid gap-2">
            <span className="text-[13px] font-semibold text-ink">
              预装技能（可选）
            </span>
            <div className="grid gap-2">
              {SKILL_CATALOG.map((sk) => (
                <label
                  key={sk.id}
                  htmlFor={`skill-${sk.id}`}
                  className="flex items-start gap-2.5 text-[13px] text-ink"
                >
                  <Checkbox
                    id={`skill-${sk.id}`}
                    checked={skills.includes(sk.id)}
                    onCheckedChange={() => toggleSkill(sk.id)}
                  />
                  <span>
                    {sk.label}
                    <small className="ml-1.5 text-xs text-muted-foreground">
                      {sk.hint}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <small className="text-xs text-muted-foreground">
              选中的技能会在沙箱创建时预装进工作区，codex 启动即可用。
            </small>
          </div>

          <div className="grid gap-2 min-[821px]:grid-cols-2">
            <div className="grid gap-2">
              <label htmlFor="idleTimeout" className="text-[13px] font-semibold text-ink">
                空闲自动回收
              </label>
              <Select
                value={guardrailSelectValue(idleTimeoutMs)}
                onValueChange={(v) => setIdleTimeoutMs(parseGuardrailSelectValue(v))}
              >
                <SelectTrigger id="idleTimeout" className="w-full">
                  <SelectValue placeholder="关闭" />
                </SelectTrigger>
                <SelectContent>
                  {IDLE_TIMEOUT_OPTIONS.map((o) => (
                    <SelectItem key={o.label} value={guardrailSelectValue(o.ms)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <label htmlFor="deadline" className="text-[13px] font-semibold text-ink">
                运行时限
              </label>
              <Select
                value={guardrailSelectValue(deadlineMs)}
                onValueChange={(v) => setDeadlineMs(parseGuardrailSelectValue(v))}
              >
                <SelectTrigger id="deadline" className="w-full">
                  <SelectValue placeholder="无" />
                </SelectTrigger>
                <SelectContent>
                  {DEADLINE_OPTIONS.map((o) => (
                    <SelectItem key={o.label} value={guardrailSelectValue(o.ms)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <small className="text-xs text-muted-foreground min-[821px]:col-span-2">
              默认不回收、不限时；仅在此选择后，任务空闲 / 超时才会被自动结束。运行中可随时手动停止。
            </small>
          </div>

          <div className="grid gap-2">
            <label htmlFor="task" className="text-[13px] font-semibold text-ink">
              任务描述
            </label>
            <Textarea
              id="task"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="清楚描述远端 Agent 需要完成什么。"
              className="min-h-[190px] resize-y"
            />
            <small data-task-count className="text-xs text-muted-foreground">
              {charCount} 字
            </small>
          </div>

          {/* add-claude-code-runtime VR-2: the former interactive "破坏性写入前停止"
              checkbox is replaced by a non-interactive advisory note. It was unwired
              at every layer (no contract field, no backend enforcement) — the agent
              runs ungated inside the sandbox, which is the trust boundary. */}
          <div className="flex items-start gap-2.5 rounded-lg bg-[#fafafa] p-3 shadow-ring">
            <span>
              <strong className="text-[13px] font-semibold text-foreground">
                安全边界
              </strong>
              <br />
              <small className="text-xs text-muted-foreground">
                Agent 在沙箱内自主执行（沙箱即信任边界，Codex 与 Claude Code 一致），不做逐操作写入门控。
              </small>
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={submitDisabled}
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            >
              {submitting
                ? "保存中…"
                : editingSchedule
                  ? "保存定时任务"
                  : mode === "repeated"
                    ? "创建定时任务"
                    : "创建任务"}
            </button>
            <Link
              to="/dashboard"
              className="inline-flex h-9 items-center justify-center rounded-md bg-card px-4 text-sm font-medium text-foreground shadow-ring hover:bg-secondary"
            >
              返回任务控制台
            </Link>
          </div>

          {mutation.isError || createSchedule.isError || updateSchedule.isError ? (
            <p className="text-xs text-danger" role="alert">
              创建失败：
              {mutation.error?.message ??
                createSchedule.error?.message ??
                updateSchedule.error?.message}
            </p>
          ) : null}

          {createdTask && createdTaskId ? (
            <div
              data-task-result
              className="mt-3 flex items-center justify-between gap-2.5 rounded-lg bg-[#f7fbf8] p-2.5 shadow-ring"
            >
              <StatusPill variant="green">
                已创建{" "}
                <span className="font-mono" data-run-id>
                  {shortTaskId(createdTaskId)}
                </span>{" "}
                · 正在 iad-02 排队
              </StatusPill>
              <Link
                to="/tasks/$taskId"
                params={{ taskId: createdTaskId }}
                data-open-created-task
                className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                进入该任务会话
              </Link>
            </div>
          ) : null}
        </form>

        {/* Right: command preview + execution boundary */}
        <aside className="grid min-w-0 content-start gap-3">
          <Panel>
            <PanelHead right={<StatusPill variant="dark">agentctl</StatusPill>}>
              <h3 className="text-[15px] font-semibold text-foreground">命令预览</h3>
            </PanelHead>
            <CommandPreview lines={commandLines} />
          </Panel>

          <Panel>
            <PanelHead right={<StatusPill variant="green">私有</StatusPill>}>
              <h3 className="text-[15px] font-semibold text-foreground">执行边界</h3>
            </PanelHead>
            <div className="grid overflow-hidden rounded-md shadow-ring">
              <ConfigRow label="身份来源" value="本地账号" />
              <ConfigRow label="仓库范围" value="已导入仓库" />
              <ConfigRow label="运行时" value="Codex / Claude Code" />
              <ConfigRow label="写入动作" value="沙箱内自主" />
            </div>
          </Panel>
        </aside>
      </section>
    </>
  );
}
