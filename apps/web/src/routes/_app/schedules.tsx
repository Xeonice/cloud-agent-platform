import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ExternalLink,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import type {
  Repo,
  ScheduleResponse,
  ScheduleRunResponse,
  TaskStatus,
} from "@cap/contracts";
import {
  reposQuery,
  scheduleRunsQuery,
  schedulesQuery,
} from "@/lib/api/queries";
import { ApiError } from "@/lib/api/real";
import {
  deleteScheduleMutation,
  dispatchScheduleMutation,
  pauseScheduleMutation,
  resumeScheduleMutation,
} from "@/lib/api/mutations";
import { recurrenceSummary } from "@/lib/task-form";
import { NewTaskDialog } from "@/components/dashboard/new-task-dialog";
import { Panel, PanelHead } from "@/components/settings/panel";
import { StatusPill } from "@/components/status-pill";
import { TaskProvisioningFailureAlert } from "@/components/task-provisioning-status";
import {
  isProvisioningTaskFailure,
  provisioningFailurePresentation,
} from "@/lib/task-provisioning";
import {
  RuntimeAuthFailureBadge,
  RuntimeCredentialAlert,
} from "@/components/runtime-credential-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/utils";

export { buildSchedulePayload, type ScheduleFormState } from "@/lib/task-form";

export function immediateDispatchSuccessMessage(
  previous: ScheduleResponse,
  updated: ScheduleResponse,
): string {
  const periodRun = updated.currentPeriod?.run;
  if (periodRun) {
    const periodResult =
      periodRun.status === "created"
        ? "本周期已执行"
        : periodRun.status === "retrying"
          ? "模型目录不可用，本周期等待重试"
        : periodRun.status === "failed"
          ? "本周期派发失败"
          : periodRun.status === "skipped"
            ? "本周期已处理（已跳过）"
            : "本周期正在处理";
    if (!updated.nextRunAt) return `${periodResult}，定时任务仍为暂停状态`;
    return `${periodResult}；下次定时运行 ${formatDate(
      updated.nextRunAt,
      updated.timezone,
    )}`;
  }
  if (!updated.nextRunAt) return "已立即派发，定时任务仍为暂停状态";
  const nextRun = formatDate(updated.nextRunAt, updated.timezone);
  if (previous.nextRunAt?.getTime() === updated.nextRunAt.getTime()) {
    return `已立即派发，下次定时运行保持 ${nextRun}`;
  }
  return `已立即派发，逾期周期已处理；下次定时运行已更新为 ${nextRun}`;
}

export const Route = createFileRoute("/_app/schedules")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(schedulesQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
    ]);
  },
  component: SchedulesPage,
});

function SchedulesPage() {
  const queryClient = useQueryClient();
  const schedules = useQuery(schedulesQuery());
  const repos = useQuery(reposQuery());
  const scheduleList = schedules.data ?? [];
  const repoList = repos.data ?? [];
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [dispatchingScheduleId, setDispatchingScheduleId] =
    React.useState<string | null>(null);
  const dispatchInFlightRef = React.useRef(false);
  const [editingSchedule, setEditingSchedule] =
    React.useState<ScheduleResponse | null>(null);
  const selectedSchedule =
    scheduleList.find((schedule) => schedule.id === selectedId) ??
    scheduleList[0] ??
    null;
  const runs = useQuery({
    ...scheduleRunsQuery(selectedSchedule?.id ?? ""),
    enabled: Boolean(selectedSchedule?.id),
  });

  const pauseMutation = useMutation(pauseScheduleMutation(queryClient));
  const resumeMutation = useMutation(resumeScheduleMutation(queryClient));
  const dispatchMutation = useMutation(dispatchScheduleMutation(queryClient));
  const deleteMutation = useMutation(deleteScheduleMutation(queryClient));
  const dispatchInFlight =
    dispatchingScheduleId !== null || dispatchMutation.isPending;

  function editSchedule(schedule: ScheduleResponse) {
    setSelectedId(schedule.id);
    setEditingSchedule(schedule);
  }

  async function dispatchSchedule(schedule: ScheduleResponse) {
    if (schedule.currentPeriod?.run || dispatchInFlightRef.current) return;
    dispatchInFlightRef.current = true;
    setDispatchingScheduleId(schedule.id);
    try {
      const updated = await dispatchMutation.mutateAsync({
        id: schedule.id,
        expectedPeriodKey: schedule.currentPeriod?.key,
      });
      setSelectedId(updated.id);
      toast.success(immediateDispatchSuccessMessage(schedule, updated));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.info("本周期已变化，已刷新最新状态");
      } else {
        toast.error("立即执行失败，请稍后重试");
      }
    } finally {
      dispatchInFlightRef.current = false;
      setDispatchingScheduleId(null);
    }
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
        toast.success("定时任务已删除");
      },
    });
  }

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
        <StatusPill variant="dark">{scheduleList.length}</StatusPill>
      </section>

      <section className="grid items-start gap-3 min-[1181px]:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <Panel>
          <PanelHead right={<StatusPill variant="dark">{scheduleList.length}</StatusPill>}>
            <h2 className="text-[15px] font-semibold text-foreground">总览</h2>
          </PanelHead>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>仓库</TableHead>
                <TableHead>重复</TableHead>
                <TableHead>本周期</TableHead>
                <TableHead>下次定时运行</TableHead>
                <TableHead>最近运行</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scheduleList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
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
                    onClick={() => setSelectedId(schedule.id)}
                  >
                    <TableCell className="min-w-[180px] whitespace-normal">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(schedule.id);
                        }}
                        className="text-left font-semibold text-foreground hover:underline"
                      >
                        {scheduleName(schedule)}
                      </button>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {runtimeLabel(schedule)} · {overlapLabel(schedule.overlapPolicy)}
                      </div>
                    </TableCell>
                    <TableCell>{repoLabel(repoList, schedule.repoId)}</TableCell>
                    <TableCell>
                      <span className="font-medium text-foreground">
                        {recurrenceSummary(schedule)}
                      </span>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {schedule.timezone}
                      </div>
                    </TableCell>
                    <TableCell>
                      <CurrentPeriodSummary
                        period={schedule.currentPeriod}
                        timeZone={schedule.timezone}
                      />
                    </TableCell>
                    <TableCell>
                      <ScheduleDate
                        value={schedule.nextRunAt}
                        label="下次定时运行"
                        timeZone={schedule.timezone}
                      />
                    </TableCell>
                    <TableCell>
                      <LatestRunSummary
                        run={schedule.latestRun ?? null}
                        timeZone={schedule.timezone}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={currentPeriodActionLabel(
                            schedule,
                            dispatchingScheduleId === schedule.id,
                          )}
                          disabled={
                            Boolean(schedule.currentPeriod?.run) ||
                            dispatchInFlight
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            dispatchSchedule(schedule);
                          }}
                        >
                          {schedule.currentPeriod?.run ? (
                            <Check className="size-4" />
                          ) : dispatchingScheduleId === schedule.id ? (
                            <LoaderCircle className="size-4 animate-spin" />
                          ) : (
                            <Send className="size-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="编辑"
                          onClick={(event) => {
                            event.stopPropagation();
                            editSchedule(schedule);
                          }}
                        >
                          <Pencil className="size-4" />
                        </Button>
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
              right={selectedSchedule ? enabledPill(selectedSchedule.enabled) : null}
            >
              <h2 className="text-[15px] font-semibold text-foreground">详情</h2>
            </PanelHead>
            {selectedSchedule ? (
              <ScheduleDetail
                schedule={selectedSchedule}
                repos={repoList}
                onEdit={() => editSchedule(selectedSchedule)}
                onDispatch={() => dispatchSchedule(selectedSchedule)}
                onPauseResume={() => pauseOrResume(selectedSchedule)}
                onDelete={() => deleteSchedule(selectedSchedule)}
                dispatchPending={
                  dispatchingScheduleId === selectedSchedule.id
                }
                dispatchDisabled={dispatchInFlight}
              />
            ) : (
              <p className="text-sm text-muted-foreground">暂无定时任务</p>
            )}
          </Panel>

          <Panel>
            <PanelHead
              right={
                selectedSchedule ? (
                  <RunResultBadges
                    run={selectedSchedule.latestRun ?? null}
                    showFailure={false}
                  />
                ) : null
              }
            >
              <h2 className="text-[15px] font-semibold text-foreground">最近运行</h2>
            </PanelHead>
            {selectedSchedule ? (
              <RunList
                runs={runs.data ?? []}
                timeZone={selectedSchedule.timezone}
              />
            ) : (
              <p className="text-sm text-muted-foreground">暂无运行记录</p>
            )}
          </Panel>
        </div>
      </section>
      <NewTaskDialog
        open={editingSchedule !== null}
        onOpenChange={(open) => {
          if (!open) setEditingSchedule(null);
        }}
        repos={repoList}
        scheduleToEdit={editingSchedule}
        onScheduleSaved={(schedule) => {
          setSelectedId(schedule.id);
          toast.success("定时任务已更新");
        }}
      />
    </>
  );
}

export function ScheduleDetail({
  schedule,
  repos,
  onEdit,
  onDispatch,
  onPauseResume,
  onDelete,
  dispatchPending = false,
  dispatchDisabled = false,
}: {
  schedule: ScheduleResponse;
  repos: readonly Repo[];
  onEdit: () => void;
  onDispatch: () => void;
  onPauseResume: () => void;
  onDelete: () => void;
  dispatchPending?: boolean;
  dispatchDisabled?: boolean;
}) {
  const latestActualAt = actualRunAt(schedule.latestRun ?? null);
  const latestActualLabel =
    schedule.latestRun?.status === "created"
      ? "最近实际执行"
      : "最近实际处理";
  return (
    <div className="grid gap-3">
      <div className="grid overflow-hidden rounded-md border border-border">
        <DetailRow label="任务" value={schedule.taskTemplate.prompt} />
        <DetailRow label="仓库" value={repoLabel(repos, schedule.repoId)} />
        <DetailRow label="运行时" value={runtimeLabel(schedule)} />
        <DetailRow
          label="请求模型"
          value={schedule.taskTemplate.model ?? "运行时默认"}
        />
        <DetailRow label="重复" value={recurrenceSummary(schedule)} />
        <DetailRow label="时区" value={schedule.timezone} />
        <DetailRow
          label="本周期"
          value={
            <CurrentPeriodSummary
              period={schedule.currentPeriod}
              timeZone={schedule.timezone}
            />
          }
        />
        <DetailRow
          label={latestActualLabel}
          value={
            latestActualAt ? (
              <time dateTime={latestActualAt.toISOString()}>
                {formatDate(latestActualAt, schedule.timezone)}
              </time>
            ) : schedule.latestRun ? (
              "时间不可用"
            ) : (
              "无记录"
            )
          }
        />
        <DetailRow
          label="最近运行状态"
          value={
            schedule.latestRun ? (
              <span className="grid gap-1.5">
                <RunResultBadges run={schedule.latestRun} />
                <RunModelFailureDetails
                  run={schedule.latestRun}
                  timeZone={schedule.timezone}
                />
              </span>
            ) : (
              "无记录"
            )
          }
        />
        <DetailRow
          label="下次定时运行"
          value={
            <ScheduleDate
              value={schedule.nextRunAt}
              label="下次定时运行"
              timeZone={schedule.timezone}
            />
          }
        />
        <DetailRow label="重叠策略" value={overlapLabel(schedule.overlapPolicy)} />
      </div>
      <RuntimeCredentialAlert
        failure={schedule.latestRun?.taskFailure}
        compact
        contextLabel="最近一次任务失败原因"
      />
      <TaskProvisioningFailureAlert
        failure={schedule.latestRun?.taskFailure ?? null}
        contextLabel="最近一次任务失败原因"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="gap-2"
          onClick={onDispatch}
          disabled={
            dispatchDisabled ||
            dispatchPending ||
            Boolean(schedule.currentPeriod?.run)
          }
        >
          {schedule.currentPeriod?.run ? (
            <Check className="size-4" />
          ) : dispatchPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {currentPeriodActionLabel(schedule, dispatchPending)}
        </Button>
        <Button type="button" variant="secondary" className="gap-2" onClick={onEdit}>
          <Pencil className="size-4" />
          编辑
        </Button>
        <Button type="button" variant="secondary" className="gap-2" onClick={onPauseResume}>
          {schedule.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
          {schedule.enabled ? "暂停" : "恢复"}
        </Button>
        <Button type="button" variant="destructive" className="gap-2" onClick={onDelete}>
          <Trash2 className="size-4" />
          删除
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid min-h-11 grid-cols-[92px_minmax(0,1fr)] items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <strong className="min-w-0 break-words font-medium text-foreground">{value}</strong>
    </div>
  );
}

export function CurrentPeriodSummary({
  period,
  timeZone,
}: {
  period: ScheduleResponse["currentPeriod"];
  timeZone: string;
}) {
  if (!period) {
    return <Badge variant="outline">状态不可用</Badge>;
  }
  const status = period.run
    ? period.run.status === "created"
      ? "本周期已执行"
      : period.run.status === "retrying"
        ? "本周期等待重试"
      : period.run.status === "claimed"
        ? "本周期处理中"
        : "本周期已处理"
    : "本周期未执行";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={period.run ? "secondary" : "outline"}>{status}</Badge>
      {period.run ? <RunResultBadges run={period.run} /> : null}
      {period.scheduledFor ? (
        <time
          dateTime={period.scheduledFor.toISOString()}
          aria-label={`周期计划时间 ${formatDate(
            period.scheduledFor,
            timeZone,
          )} ${timeZone}`}
          className="font-mono text-xs text-muted-foreground"
        >
          {formatDate(period.scheduledFor, timeZone)}
        </time>
      ) : null}
    </span>
  );
}

function ScheduleDate({
  value,
  label,
  timeZone,
}: {
  value: Date | null;
  label: string;
  timeZone: string;
}) {
  if (!value) return <>暂停</>;
  const formatted = formatDate(value, timeZone);
  return (
    <time
      dateTime={value.toISOString()}
      aria-label={`${label} ${formatted} ${timeZone}`}
    >
      {formatted}
    </time>
  );
}

export function RunList({
  runs,
  timeZone,
}: {
  runs: readonly ScheduleRunResponse[];
  timeZone: string;
}) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无运行记录</p>;
  }
  return (
    <div className="grid gap-2">
      {runs.map((run) => (
        <article
          key={run.id}
          className="grid gap-2 rounded-md border border-border px-3 py-2 text-sm min-[821px]:grid-cols-[minmax(0,1fr)_auto]"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <RunResultBadges run={run} />
              <span className="text-xs text-muted-foreground">
                {run.status === "created" ? "实际执行" : "实际处理"}
              </span>
              <time
                dateTime={actualRunAt(run)!.toISOString()}
                aria-label={`${
                  run.status === "created" ? "实际执行时间" : "实际处理时间"
                } ${formatDate(actualRunAt(run), timeZone)} ${timeZone}`}
                className="font-mono text-xs text-muted-foreground"
              >
                {formatDate(actualRunAt(run), timeZone)}
              </time>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>周期计划时间</span>
              <time
                dateTime={run.scheduledFor.toISOString()}
                aria-label={`周期计划时间 ${formatDate(
                  run.scheduledFor,
                  timeZone,
                )} ${timeZone}`}
                className="font-mono"
              >
                {formatDate(run.scheduledFor, timeZone)}
              </time>
            </div>
            <RunModelFailureDetails
              run={run}
              timeZone={timeZone}
              className="mt-1"
            />
            <RuntimeCredentialAlert
              failure={run.taskFailure}
              compact
              contextLabel="本次任务失败原因"
              className="mt-2"
            />
            <TaskProvisioningFailureAlert
              failure={run.taskFailure}
              contextLabel="本次任务失败原因"
              className="mt-2"
            />
          </div>
          {run.taskId ? (
            <Button asChild variant="secondary" size="sm" className="gap-2">
              <Link to="/tasks/$taskId" params={{ taskId: run.taskId }}>
                <ExternalLink className="size-3.5" />
                任务
              </Link>
            </Button>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function LatestRunSummary({
  run,
  timeZone,
}: {
  run: ScheduleResponse["latestRun"] | null;
  timeZone: string;
}) {
  if (!run) return <RunResultBadges run={null} />;
  const actualAt = actualRunAt(run);
  const actualLabel = run.status === "created" ? "最近实际执行" : "最近实际处理";
  return (
    <div className="grid gap-1">
      <RunResultBadges run={run} />
      <RunModelFailureDetails run={run} timeZone={timeZone} />
      {actualAt ? (
        <time
          dateTime={actualAt.toISOString()}
          aria-label={`${actualLabel} ${formatDate(actualAt, timeZone)} ${timeZone}`}
          className="font-mono text-xs text-muted-foreground"
        >
          {formatDate(actualAt, timeZone)}
        </time>
      ) : (
        <span className="text-xs text-muted-foreground">时间不可用</span>
      )}
    </div>
  );
}

export function RunResultBadges({
  run,
  showFailure = true,
}: {
  run: ScheduleRunResponse | ScheduleResponse["latestRun"] | null;
  showFailure?: boolean;
}) {
  if (!run) return <Badge variant="outline">无记录</Badge>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {dispatchBadge(run)}
      {taskStatusBadge(run.taskStatus ?? null)}
      {showFailure && run.taskFailure ? (
        isProvisioningTaskFailure(run.taskFailure) ? (
          <Badge
            variant="destructive"
            data-provisioning-failure={run.taskFailure.code}
          >
            {provisioningFailurePresentation(run.taskFailure).title}
          </Badge>
        ) : (
          <RuntimeAuthFailureBadge failure={run.taskFailure} />
        )
      ) : null}
    </span>
  );
}

function dispatchBadge(
  run: ScheduleRunResponse | NonNullable<ScheduleResponse["latestRun"]>,
) {
  if (run.status === "created") {
    return <Badge className="bg-success text-white">派发成功</Badge>;
  }
  if (run.status === "skipped") return <Badge variant="secondary">已跳过</Badge>;
  if (run.status === "retrying") {
    return <Badge variant="outline">模型目录不可用，等待重试</Badge>;
  }
  if (run.status === "failed") {
    if (run.errorCode === "runtime_model_not_available") {
      return <Badge variant="destructive">所选模型不可用</Badge>;
    }
    if (run.errorCode === "runtime_model_catalog_unavailable") {
      return <Badge variant="destructive">模型目录不可用，重试已结束</Badge>;
    }
    return <Badge variant="destructive">派发失败</Badge>;
  }
  return <Badge variant="outline">派发处理中</Badge>;
}

function RunModelFailureDetails({
  run,
  timeZone,
  className,
}: {
  run: ScheduleRunResponse | NonNullable<ScheduleResponse["latestRun"]>;
  timeZone: string;
  className?: string;
}) {
  if (!run.errorCode && !run.error && run.status !== "retrying") return null;
  return (
    <span
      className={cn(
        "grid gap-1 text-xs font-normal text-muted-foreground",
        className,
      )}
    >
      {run.errorCode ? (
        <span>
          错误代码：<code className="font-mono">{run.errorCode}</code>
        </span>
      ) : null}
      {run.error ? <span>错误信息：{run.error}</span> : null}
      {run.status === "retrying" ? (
        <>
          <span>重试尝试：第 {run.retryAttempt ?? "?"} 次</span>
          {run.retryAt ? (
            <span>
              下次重试：
              <time dateTime={run.retryAt.toISOString()}>
                {formatDate(run.retryAt, timeZone)}
              </time>
            </span>
          ) : null}
        </>
      ) : run.errorCode === "runtime_model_not_available" ? (
        <span>请编辑定时任务并选择当前可用模型。</span>
      ) : null}
    </span>
  );
}

function taskStatusBadge(status: TaskStatus | null) {
  if (!status) return null;
  if (status === "completed") {
    return <Badge className="bg-success text-white">任务已完成</Badge>;
  }
  if (status === "failed") return <Badge variant="destructive">任务失败</Badge>;
  if (status === "agent_failed_to_start") {
    return <Badge variant="destructive">任务启动失败</Badge>;
  }
  if (status === "cancelled") return <Badge variant="secondary">任务已停止</Badge>;
  if (status === "running") return <Badge variant="outline">任务运行中</Badge>;
  if (status === "awaiting_input") {
    return <Badge variant="secondary">任务等待输入</Badge>;
  }
  if (status === "queued") return <Badge variant="secondary">任务排队中</Badge>;
  return <Badge variant="outline">任务待接入</Badge>;
}

function actualRunAt(
  run: ScheduleRunResponse | ScheduleResponse["latestRun"] | null,
): Date | null {
  return run?.triggeredAt ?? run?.createdAt ?? null;
}

function currentPeriodActionLabel(
  schedule: ScheduleResponse,
  dispatchPending = false,
): string {
  if (dispatchPending) return "正在执行";
  const run = schedule.currentPeriod?.run;
  if (!run) return "立即执行";
  if (run.status === "created") return "本周期已执行";
  if (run.status === "retrying") return "等待模型目录重试";
  if (run.status === "claimed") return "本周期处理中";
  return "本周期已处理";
}

function enabledPill(enabled: boolean) {
  return enabled ? (
    <StatusPill variant="green">启用</StatusPill>
  ) : (
    <StatusPill variant="dark">暂停</StatusPill>
  );
}

function scheduleName(schedule: ScheduleResponse): string {
  return schedule.name || schedule.taskTemplate.prompt.slice(0, 48);
}

function repoLabel(repos: readonly Repo[], repoId: string): string {
  return repos.find((repo) => repo.id === repoId)?.name ?? repoId.slice(0, 8);
}

function runtimeLabel(schedule: ScheduleResponse): string {
  return schedule.taskTemplate.runtime === "claude-code" ? "Claude Code" : "Codex";
}

function overlapLabel(value: ScheduleResponse["overlapPolicy"]): string {
  return value === "enqueue" ? "继续排队" : "跳过重叠";
}

function formatDate(
  value: Date | string | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "暂停";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    ...(timeZone ? { timeZone } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
