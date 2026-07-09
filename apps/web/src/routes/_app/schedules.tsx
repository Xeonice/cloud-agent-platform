import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pause, Pencil, Play, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { Repo, ScheduleResponse, ScheduleRunResponse } from "@cap/contracts";
import { reposQuery, scheduleRunsQuery, schedulesQuery } from "@/lib/api/queries";
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

  function editSchedule(schedule: ScheduleResponse) {
    setSelectedId(schedule.id);
    setEditingSchedule(schedule);
  }

  function dispatchSchedule(schedule: ScheduleResponse) {
    dispatchMutation.mutate(schedule.id, {
      onSuccess: (updated) => {
        setSelectedId(updated.id);
        toast.success("已立即派发，本周期已完成");
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
                    <TableCell>{formatDate(schedule.nextRunAt)}</TableCell>
                    <TableCell>{runBadge(schedule.latestRun ?? null)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="立即派发"
                          disabled={dispatchMutation.isPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            dispatchSchedule(schedule);
                          }}
                        >
                          <Send className="size-4" />
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
                dispatchPending={dispatchMutation.isPending}
              />
            ) : (
              <p className="text-sm text-muted-foreground">暂无定时任务</p>
            )}
          </Panel>

          <Panel>
            <PanelHead
              right={
                selectedSchedule ? runBadge(selectedSchedule.latestRun ?? null) : null
              }
            >
              <h2 className="text-[15px] font-semibold text-foreground">最近运行</h2>
            </PanelHead>
            {selectedSchedule ? (
              <RunList runs={runs.data ?? []} />
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
}: {
  schedule: ScheduleResponse;
  repos: readonly Repo[];
  onEdit: () => void;
  onDispatch: () => void;
  onPauseResume: () => void;
  onDelete: () => void;
  dispatchPending?: boolean;
}) {
  return (
    <div className="grid gap-3">
      <div className="grid overflow-hidden rounded-md border border-border">
        <DetailRow label="任务" value={schedule.taskTemplate.prompt} />
        <DetailRow label="仓库" value={repoLabel(repos, schedule.repoId)} />
        <DetailRow label="运行时" value={runtimeLabel(schedule)} />
        <DetailRow label="重复" value={recurrenceSummary(schedule)} />
        <DetailRow label="时区" value={schedule.timezone} />
        <DetailRow label="下次运行" value={formatDate(schedule.nextRunAt)} />
        <DetailRow label="重叠策略" value={overlapLabel(schedule.overlapPolicy)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="gap-2"
          onClick={onDispatch}
          disabled={dispatchPending}
        >
          <Send className="size-4" />
          立即派发
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
