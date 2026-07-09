import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pause, Play, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type {
  CreateScheduleRequest,
  Deliver,
  Repo,
  Runtime,
  ScheduleResponse,
  ScheduleRunResponse,
  UpdateScheduleRequest,
} from "@cap/contracts";
import {
  reposQuery,
  runtimesQuery,
  sandboxEnvironmentsQuery,
  scheduleRunsQuery,
  schedulesQuery,
  settingsQuery,
} from "@/lib/api/queries";
import {
  createScheduleMutation,
  deleteScheduleMutation,
  pauseScheduleMutation,
  resumeScheduleMutation,
  updateScheduleMutation,
} from "@/lib/api/mutations";
import {
  DEADLINE_OPTIONS,
  DEFAULT_RUNTIME,
  IDLE_TIMEOUT_OPTIONS,
  RUNTIME_CATALOG,
  SKILL_CATALOG,
  environmentCompatibleWithRuntime,
  guardrailSelectValue,
  parseGuardrailSelectValue,
} from "@/components/dashboard/new-task-dialog";
import { Panel, PanelHead } from "@/components/settings/panel";
import { StatusPill } from "@/components/status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/utils";

export const Route = createFileRoute("/_app/schedules")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(schedulesQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
      context.queryClient.ensureQueryData(runtimesQuery()),
      context.queryClient.ensureQueryData(sandboxEnvironmentsQuery()),
      context.queryClient.ensureQueryData(settingsQuery()),
    ]);
  },
  component: SchedulesPage,
});

const ENVIRONMENT_DEFAULT = "__default__";
const ENVIRONMENT_SERVER_DEFAULT = "__server_default__";
const DEFAULT_CRON = "0 9 * * 1-5";
const DEFAULT_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export interface ScheduleFormState {
  id: string | null;
  name: string;
  cronExpression: string;
  timezone: string;
  overlapPolicy: "skip" | "enqueue";
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

export function buildSchedulePayload(
  form: ScheduleFormState,
): CreateScheduleRequest {
  const taskTemplate: CreateScheduleRequest["taskTemplate"] = {
    repoId: form.repoId,
    prompt: form.prompt.trim(),
  };
  if (form.runtime !== DEFAULT_RUNTIME) taskTemplate.runtime = form.runtime;
  if (form.sandboxEnvironmentId === ENVIRONMENT_SERVER_DEFAULT) {
    taskTemplate.sandboxEnvironmentId = null;
  } else if (form.sandboxEnvironmentId !== ENVIRONMENT_DEFAULT) {
    taskTemplate.sandboxEnvironmentId = form.sandboxEnvironmentId;
  }
  if (form.deliver !== "none") taskTemplate.deliver = form.deliver;
  if (form.branch.trim()) taskTemplate.branch = form.branch.trim();
  if (form.strategy.trim()) taskTemplate.strategy = form.strategy.trim();
  if (form.skills.length > 0) taskTemplate.skills = form.skills;
  if (form.idleTimeoutMs != null) taskTemplate.idleTimeoutMs = form.idleTimeoutMs;
  if (form.deadlineMs != null) taskTemplate.deadlineMs = form.deadlineMs;
  return {
    name: form.name.trim() || null,
    cronExpression: form.cronExpression.trim(),
    timezone: form.timezone.trim() || "UTC",
    overlapPolicy: form.overlapPolicy,
    misfirePolicy: "fire-once",
    taskTemplate,
  };
}

function emptyForm(repoId: string): ScheduleFormState {
  return {
    id: null,
    name: "",
    cronExpression: DEFAULT_CRON,
    timezone: DEFAULT_TIMEZONE,
    overlapPolicy: "skip",
    repoId,
    runtime: DEFAULT_RUNTIME,
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

function formFromSchedule(schedule: ScheduleResponse): ScheduleFormState {
  const template = schedule.taskTemplate;
  return {
    id: schedule.id,
    name: schedule.name ?? "",
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
    overlapPolicy: schedule.overlapPolicy,
    repoId: template.repoId,
    runtime: template.runtime ?? DEFAULT_RUNTIME,
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

function SchedulesPage() {
  const queryClient = useQueryClient();
  const schedules = useQuery(schedulesQuery());
  const repos = useQuery(reposQuery());
  const runtimes = useQuery(runtimesQuery());
  const sandboxEnvironments = useQuery(sandboxEnvironmentsQuery());
  const settings = useQuery(settingsQuery());

  const repoList = repos.data ?? [];
  const scheduleList = schedules.data ?? [];
  const firstRepoId = repoList[0]?.id ?? "";
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selectedSchedule =
    scheduleList.find((schedule) => schedule.id === selectedId) ??
    scheduleList[0] ??
    null;
  const runs = useQuery({
    ...scheduleRunsQuery(selectedSchedule?.id ?? ""),
    enabled: Boolean(selectedSchedule?.id),
  });
  const [form, setForm] = React.useState<ScheduleFormState>(() =>
    emptyForm(firstRepoId),
  );

  React.useEffect(() => {
    if (!form.repoId && firstRepoId) {
      setForm((current) => ({ ...current, repoId: firstRepoId }));
    }
  }, [firstRepoId, form.repoId]);

  const createMutation = useMutation(createScheduleMutation(queryClient));
  const updateMutation = useMutation(updateScheduleMutation(queryClient));
  const pauseMutation = useMutation(pauseScheduleMutation(queryClient));
  const resumeMutation = useMutation(resumeScheduleMutation(queryClient));
  const deleteMutation = useMutation(deleteScheduleMutation(queryClient));

  const readyByRuntime = React.useMemo(() => {
    const map = new Map<Runtime, boolean>();
    for (const row of runtimes.data ?? []) map.set(row.id, row.ready);
    return map;
  }, [runtimes.data]);

  const readyEnvironments = React.useMemo(
    () =>
      (sandboxEnvironments.data?.environments ?? []).filter((environment) =>
        environmentCompatibleWithRuntime(environment, form.runtime),
      ),
    [sandboxEnvironments.data?.environments, form.runtime],
  );
  const accountDefaultEnvironmentId =
    settings.data?.defaultSandboxEnvironmentId ?? null;
  const accountDefaultEnvironment =
    accountDefaultEnvironmentId === null
      ? null
      : readyEnvironments.find(
          (environment) => environment.id === accountDefaultEnvironmentId,
        ) ?? null;

  function startCreate() {
    setForm(emptyForm(firstRepoId));
  }

  function startEdit(schedule: ScheduleResponse) {
    setSelectedId(schedule.id);
    setForm(formFromSchedule(schedule));
  }

  function toggleSkill(id: string) {
    setForm((current) => ({
      ...current,
      skills: current.skills.includes(id)
        ? current.skills.filter((skill) => skill !== id)
        : [...current.skills, id],
    }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.repoId || !form.prompt.trim()) return;
    const payload = buildSchedulePayload(form);
    if (form.id) {
      const body: UpdateScheduleRequest = payload;
      updateMutation.mutate(
        { id: form.id, body },
        { onSuccess: (schedule) => {
          setSelectedId(schedule.id);
          toast.success("定时任务已更新");
        } },
      );
      return;
    }
    createMutation.mutate(payload, {
      onSuccess: (schedule) => {
        setSelectedId(schedule.id);
        setForm(formFromSchedule(schedule));
        toast.success("定时任务已创建");
      },
    });
  }

  function pauseOrResume(schedule: ScheduleResponse) {
    if (schedule.enabled) {
      pauseMutation.mutate(schedule.id, {
        onSuccess: () => toast.success("定时任务已暂停"),
      });
    } else {
      resumeMutation.mutate(schedule.id, {
        onSuccess: () => toast.success("定时任务已恢复"),
      });
    }
  }

  function deleteSchedule(schedule: ScheduleResponse) {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`删除定时任务「${scheduleName(schedule)}」？`)
    ) {
      return;
    }
    deleteMutation.mutate(schedule.id, {
      onSuccess: () => {
        if (selectedId === schedule.id) setSelectedId(null);
        if (form.id === schedule.id) startCreate();
        toast.success("定时任务已删除");
      },
    });
  }

  const submitting = createMutation.isPending || updateMutation.isPending;
  const selectedRuns = runs.data ?? [];

  return (
    <>
      <section className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            自动化
          </div>
          <h1 className="mt-1 text-[32px] leading-[1.15] font-semibold tracking-tight text-foreground max-[821px]:text-2xl">
            定时任务
          </h1>
        </div>
        <Button type="button" onClick={startCreate} className="gap-2">
          <Plus className="size-4" />
          新建
        </Button>
      </section>

      <section className="grid items-start gap-3 min-[1181px]:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <Panel>
          <PanelHead right={<StatusPill variant="dark">{scheduleList.length}</StatusPill>}>
            <h2 className="text-[15px] font-semibold text-foreground">任务列表</h2>
          </PanelHead>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>仓库</TableHead>
                <TableHead>计划</TableHead>
                <TableHead>下次运行</TableHead>
                <TableHead>最近结果</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scheduleList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    暂无定时任务
                  </TableCell>
                </TableRow>
              ) : (
                scheduleList.map((schedule) => (
                  <TableRow
                    key={schedule.id}
                    className={cn(
                      "cursor-pointer",
                      selectedSchedule?.id === schedule.id && "bg-secondary/60",
                    )}
                    onClick={() => {
                      setSelectedId(schedule.id);
                    }}
                  >
                    <TableCell className="min-w-[180px] whitespace-normal">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          startEdit(schedule);
                        }}
                        className="text-left font-semibold text-foreground hover:underline"
                      >
                        {scheduleName(schedule)}
                      </button>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {schedule.taskTemplate.runtime} · {schedule.overlapPolicy}
                      </div>
                    </TableCell>
                    <TableCell>{repoLabel(repoList, schedule.repoId)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {schedule.cronExpression}
                      <div className="mt-1 text-muted-foreground">
                        {schedule.timezone}
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(schedule.nextRunAt)}</TableCell>
                    <TableCell>{runBadge(schedule.latestRun ?? null)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={schedule.enabled ? "暂停" : "恢复"}
                          onClick={(event) => {
                            event.stopPropagation();
                            pauseOrResume(schedule);
                          }}
                        >
                          {schedule.enabled ? (
                            <Pause className="size-4" />
                          ) : (
                            <Play className="size-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="删除"
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteSchedule(schedule);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Panel>

        <div className="grid gap-3">
          <Panel>
            <PanelHead
              right={
                form.id ? (
                  <StatusPill variant="green">编辑</StatusPill>
                ) : (
                  <StatusPill variant="dark">新建</StatusPill>
                )
              }
            >
              <h2 className="text-[15px] font-semibold text-foreground">
                {form.id ? "编辑计划" : "创建计划"}
              </h2>
            </PanelHead>
            <form onSubmit={handleSubmit} className="grid gap-3">
              <Field label="名称">
                <Input
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="工作日检查"
                />
              </Field>
              <div className="grid gap-3 min-[821px]:grid-cols-2">
                <Field label="Cron">
                  <Input
                    value={form.cronExpression}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        cronExpression: event.target.value,
                      }))
                    }
                    className="font-mono"
                    placeholder="0 9 * * 1-5"
                  />
                </Field>
                <Field label="时区">
                  <Input
                    value={form.timezone}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        timezone: event.target.value,
                      }))
                    }
                    placeholder="UTC"
                  />
                </Field>
              </div>
              <div className="grid gap-3 min-[821px]:grid-cols-2">
                <Field label="仓库">
                  <Select
                    value={form.repoId}
                    onValueChange={(repoId) =>
                      setForm((current) => ({ ...current, repoId }))
                    }
                  >
                    <SelectTrigger>
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
                </Field>
                <Field label="运行时">
                  <Select
                    value={form.runtime}
                    onValueChange={(runtime) =>
                      setForm((current) => ({
                        ...current,
                        runtime: runtime as Runtime,
                        sandboxEnvironmentId: ENVIRONMENT_DEFAULT,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择运行时" />
                    </SelectTrigger>
                    <SelectContent>
                      {RUNTIME_CATALOG.map((runtime) => {
                        const ready = readyByRuntime.get(runtime.id) === true;
                        return (
                          <SelectItem
                            key={runtime.id}
                            value={runtime.id}
                            disabled={!ready}
                          >
                            {ready ? runtime.label : `${runtime.label}（未配置）`}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="沙箱环境">
                <Select
                  value={form.sandboxEnvironmentId}
                  onValueChange={(sandboxEnvironmentId) =>
                    setForm((current) => ({ ...current, sandboxEnvironmentId }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="使用默认环境" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ENVIRONMENT_DEFAULT}>
                      使用我的默认镜像
                      {accountDefaultEnvironment ? ` · ${accountDefaultEnvironment.name}` : ""}
                    </SelectItem>
                    <SelectItem value={ENVIRONMENT_SERVER_DEFAULT}>
                      使用服务端默认
                    </SelectItem>
                    {readyEnvironments.map((environment) => (
                      <SelectItem key={environment.id} value={environment.id}>
                        {environment.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid gap-3 min-[821px]:grid-cols-2">
                <Field label="结果交付">
                  <Select
                    value={form.deliver}
                    onValueChange={(deliver) =>
                      setForm((current) => ({ ...current, deliver: deliver as Deliver }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">不交付</SelectItem>
                      <SelectItem value="branch">推送分支</SelectItem>
                      <SelectItem value="pr">创建 PR/MR</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="重叠策略">
                  <Select
                    value={form.overlapPolicy}
                    onValueChange={(overlapPolicy) =>
                      setForm((current) => ({
                        ...current,
                        overlapPolicy: overlapPolicy as "skip" | "enqueue",
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="skip">跳过</SelectItem>
                      <SelectItem value="enqueue">入队</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-3 min-[821px]:grid-cols-2">
                <Field label="空闲回收">
                  <Select
                    value={guardrailSelectValue(form.idleTimeoutMs)}
                    onValueChange={(value) =>
                      setForm((current) => ({
                        ...current,
                        idleTimeoutMs: parseGuardrailSelectValue(value),
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {IDLE_TIMEOUT_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.label}
                          value={guardrailSelectValue(option.ms)}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="运行时限">
                  <Select
                    value={guardrailSelectValue(form.deadlineMs)}
                    onValueChange={(value) =>
                      setForm((current) => ({
                        ...current,
                        deadlineMs: parseGuardrailSelectValue(value),
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEADLINE_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.label}
                          value={guardrailSelectValue(option.ms)}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-3 min-[821px]:grid-cols-2">
                <Field label="分支">
                  <Input
                    value={form.branch}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        branch: event.target.value,
                      }))
                    }
                    placeholder="main"
                  />
                </Field>
                <Field label="策略">
                  <Input
                    value={form.strategy}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        strategy: event.target.value,
                      }))
                    }
                    placeholder="先读仓库再计划"
                  />
                </Field>
              </div>
              <Field label="预装技能">
                <div className="flex flex-wrap gap-3">
                  {SKILL_CATALOG.map((skill) => (
                    <label
                      key={skill.id}
                      className="inline-flex items-center gap-2 text-[13px]"
                    >
                      <Checkbox
                        checked={form.skills.includes(skill.id)}
                        onCheckedChange={() => toggleSkill(skill.id)}
                      />
                      {skill.label}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="任务描述">
                <Textarea
                  value={form.prompt}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, prompt: event.target.value }))
                  }
                  className="min-h-[132px] resize-y"
                  placeholder="描述每次触发时 Agent 要完成的工作"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={submitting || !form.repoId || !form.prompt.trim()}
                  className="gap-2"
                >
                  <Save className="size-4" />
                  {form.id ? "保存" : "创建"}
                </Button>
                {form.id ? (
                  <Button type="button" variant="secondary" onClick={startCreate}>
                    取消编辑
                  </Button>
                ) : null}
              </div>
              {createMutation.isError || updateMutation.isError ? (
                <p role="alert" className="text-xs text-danger">
                  {createMutation.error?.message ?? updateMutation.error?.message}
                </p>
              ) : null}
            </form>
          </Panel>

          <Panel>
            <PanelHead right={selectedSchedule ? runBadge(selectedSchedule.latestRun ?? null) : null}>
              <h2 className="text-[15px] font-semibold text-foreground">最近运行</h2>
            </PanelHead>
            {selectedSchedule ? (
              <RunList runs={selectedRuns} />
            ) : (
              <p className="text-sm text-muted-foreground">暂无运行记录</p>
            )}
          </Panel>
        </div>
      </section>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-2 text-[13px] font-semibold text-ink">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function RunList({ runs }: { runs: readonly ScheduleRunResponse[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无运行记录</p>;
  }
  return (
    <div className="grid gap-2">
      {runs.map((run) => (
        <div
          key={run.id}
          className="grid gap-2 rounded-md border border-border px-3 py-2 text-sm min-[821px]:grid-cols-[minmax(0,1fr)_auto]"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {runBadge(run)}
              <span className="font-mono text-xs text-muted-foreground">
                {formatDate(run.scheduledFor)}
              </span>
            </div>
            {run.error ? (
              <p className="mt-1 text-xs text-muted-foreground">{run.error}</p>
            ) : null}
          </div>
          {run.taskId ? (
            <Button asChild variant="secondary" size="sm" className="gap-2">
              <Link to="/tasks/$taskId" params={{ taskId: run.taskId }}>
                <ExternalLink className="size-3.5" />
                任务
              </Link>
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function runBadge(run: ScheduleRunResponse | ScheduleResponse["latestRun"] | null) {
  if (!run) return <Badge variant="outline">无记录</Badge>;
  if (run.status === "created") return <Badge className="bg-success text-white">已创建</Badge>;
  if (run.status === "skipped") return <Badge variant="secondary">已跳过</Badge>;
  if (run.status === "failed") return <Badge variant="destructive">失败</Badge>;
  return <Badge variant="outline">处理中</Badge>;
}

function scheduleName(schedule: ScheduleResponse): string {
  return schedule.name || schedule.taskTemplate.prompt.slice(0, 48);
}

function repoLabel(repos: readonly Repo[], repoId: string): string {
  return repos.find((repo) => repo.id === repoId)?.name ?? repoId.slice(0, 8);
}

function repoFullName(repo: Repo): string {
  const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? repo.name;
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "暂停";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
