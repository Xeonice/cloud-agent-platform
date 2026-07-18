import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type {
  TaskProvisioningDiagnosticAnomaly,
  TaskProvisioningDiagnosticAttempt,
  TaskProvisioningDiagnosticAttemptState,
  TaskProvisioningDiagnosticCause,
  TaskProvisioningDiagnosticChannel,
  TaskProvisioningDiagnosticCleanupState,
  TaskProvisioningDiagnosticCoverage,
  TaskProvisioningDiagnosticEvent,
  TaskProvisioningDiagnosticOperation,
  TaskProvisioningDiagnosticOutcome,
  TaskProvisioningDiagnosticProviderFamily,
  TaskProvisioningDiagnosticStage,
  TaskProvisioningDiagnosticsResponse,
  TaskProvisioningState,
} from "@cap/contracts";

import { taskProvisioningDiagnosticsInfiniteQuery } from "@/lib/api/queries";
import { TASK_PROVISIONING_STATE_LABELS } from "@/lib/task-provisioning";
import {
  TaskProvisioningDiagnosticsClientError,
  type TaskProvisioningDiagnosticsClientErrorReason,
} from "@/lib/api/real";

const COVERAGE_LABELS: Record<TaskProvisioningDiagnosticCoverage, string> = {
  not_started: "尚未开始",
  partial: "证据不完整",
  complete: "证据完整",
  unavailable: "历史不可用",
};

const ATTEMPT_STATE_LABELS: Record<
  TaskProvisioningDiagnosticAttemptState,
  string
> = {
  active: "处理中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

const PROVIDER_LABELS: Record<
  TaskProvisioningDiagnosticProviderFamily,
  string
> = {
  aio: "AIO",
  "cloud-http": "Cloud HTTP",
  boxlite: "BoxLite",
  unknown: "提供方未知",
};

const STAGE_LABELS: Record<TaskProvisioningDiagnosticStage, string> = {
  accepted: "任务已接受",
  sandbox_creation: "创建沙箱",
  credential_setup: "准备凭据",
  remote_ref_resolution: "解析远端引用",
  workspace_transfer: "传输仓库工作区",
  checkout: "检出目标版本",
  submodules: "准备子模块",
  credential_cleanup: "清理临时凭据",
  runtime_setup: "准备运行时",
  readiness: "检查运行环境",
  agent_launch: "启动 Agent",
  complete: "准备完成",
  provider_selection: "选择沙箱提供方",
  sandbox_start: "启动沙箱",
  sandbox_inspect: "检查沙箱",
  native_execution: "执行沙箱原生操作",
  settlement: "确认执行结果",
  cleanup: "清理沙箱",
};

const OPERATION_LABELS: Record<TaskProvisioningDiagnosticOperation, string> = {
  provider_select: "选择提供方",
  sandbox_create: "创建沙箱",
  sandbox_start: "启动沙箱",
  sandbox_inspect: "检查沙箱",
  workspace_materialize: "准备工作区",
  credential_setup: "写入临时凭据",
  remote_ref_resolve: "解析远端引用",
  repository_transfer: "传输仓库",
  checkout: "检出版本",
  submodules: "准备子模块",
  credential_cleanup: "清理临时凭据",
  runtime_preflight: "运行时预检",
  runtime_setup: "配置运行时",
  native_exec_start: "开始原生执行",
  native_exec_poll: "等待原生执行",
  native_exec_attach: "连接原生执行",
  native_exec_settlement: "确认原生执行",
  agent_launch: "启动 Agent",
  sandbox_delete: "删除沙箱",
  sandbox_absence_confirm: "确认沙箱已移除",
};

const OUTCOME_LABELS: Record<TaskProvisioningDiagnosticOutcome, string> = {
  started: "已开始",
  succeeded: "成功",
  failed: "失败",
  timed_out: "超时",
  cancelled: "已取消",
  degraded: "降级完成",
  indeterminate: "结果未确认",
};

const CAUSE_LABELS: Record<TaskProvisioningDiagnosticCause, string> = {
  capacity_exhausted: "沙箱容量不足",
  authentication_failed: "认证失败",
  access_denied: "访问被拒绝",
  tls_network_failed: "网络或 TLS 失败",
  ref_not_found: "目标引用不存在",
  workspace_timeout: "工作区准备超时",
  transport_failed: "传输失败",
  protocol_failed: "协议响应无效",
  provider_unavailable: "沙箱提供方不可用",
  settlement_unknown: "执行结果未确认",
  missing_exit_code: "终态缺少退出码",
  command_failed: "受控命令失败",
  cancelled: "操作已取消",
  superseded: "已被新处理接管",
  cleanup_failed: "清理失败",
  cleanup_unconfirmed: "清理尚未确认",
  coordination_failed: "协调状态异常",
  diagnostic_write_failed: "诊断证据写入失败",
  unknown: "原因未知",
};

const CLEANUP_LABELS: Record<TaskProvisioningDiagnosticCleanupState, string> = {
  not_required: "无需清理",
  pending: "等待清理确认",
  succeeded: "清理成功",
  failed: "清理失败",
};

const CHANNEL_LABELS: Record<TaskProvisioningDiagnosticChannel, string> = {
  primary: "主流程",
  cleanup: "清理",
  coordination: "协调",
};

const ANOMALY_LABELS: Record<TaskProvisioningDiagnosticAnomaly, string> = {
  missing_exit_code: "终态缺少退出码",
  invalid_poll_settlement: "轮询终态无效",
  poll_timeout: "轮询超时",
  poll_transport_failure: "轮询传输失败",
  attach_degraded: "执行连接降级",
};

interface DiagnosticAttemptGroup {
  readonly attemptNumber: number;
  readonly attempt: TaskProvisioningDiagnosticAttempt | null;
  readonly events: readonly TaskProvisioningDiagnosticEvent[];
}

export interface TaskProvisioningDiagnosticsTimeline {
  readonly taskId: string;
  readonly coverage: TaskProvisioningDiagnosticCoverage;
  readonly admissionState: TaskProvisioningState | null;
  readonly groups: readonly DiagnosticAttemptGroup[];
  readonly compaction: TaskProvisioningDiagnosticsResponse["compaction"];
  readonly hasNextPage: boolean;
}

/** Merge immutable cursor pages without duplicating or reordering ledger rows. */
export function mergeTaskProvisioningDiagnosticsPages(
  pages: readonly TaskProvisioningDiagnosticsResponse[],
): TaskProvisioningDiagnosticsTimeline | null {
  const first = pages[0];
  if (!first) return null;

  const attempts = new Map<string, TaskProvisioningDiagnosticAttempt>();
  const events = new Map<string, TaskProvisioningDiagnosticEvent>();
  for (const page of pages) {
    if (page.taskId !== first.taskId) continue;
    for (const attempt of page.attempts) {
      if (attempt.taskId === first.taskId && !attempts.has(attempt.id)) {
        attempts.set(attempt.id, attempt);
      }
    }
    for (const event of page.events) {
      if (event.taskId === first.taskId && !events.has(event.eventId)) {
        events.set(event.eventId, event);
      }
    }
  }

  const attemptsByNumber = new Map<number, TaskProvisioningDiagnosticAttempt>();
  for (const attempt of attempts.values()) {
    const current = attemptsByNumber.get(attempt.attempt);
    if (!current || attempt.id.localeCompare(current.id) < 0) {
      attemptsByNumber.set(attempt.attempt, attempt);
    }
  }
  const eventsByAttempt = new Map<number, TaskProvisioningDiagnosticEvent[]>();
  for (const event of events.values()) {
    const list = eventsByAttempt.get(event.attempt) ?? [];
    list.push(event);
    eventsByAttempt.set(event.attempt, list);
  }

  const attemptNumbers = new Set([
    ...attemptsByNumber.keys(),
    ...eventsByAttempt.keys(),
  ]);
  const groups = [...attemptNumbers]
    .sort((left, right) => left - right)
    .map((attemptNumber) => ({
      attemptNumber,
      attempt: attemptsByNumber.get(attemptNumber) ?? null,
      events: (eventsByAttempt.get(attemptNumber) ?? []).sort(
        (left, right) =>
          left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
      ),
    }));

  return {
    taskId: first.taskId,
    coverage: first.coverage,
    admissionState: first.admissionState,
    groups,
    compaction: first.compaction,
    hasNextPage: pages.at(-1)?.nextCursor != null,
  };
}

/** Build copyable text from the closed projection only; all identities are omitted. */
export function buildTaskProvisioningDiagnosticsCopyText(
  timeline: TaskProvisioningDiagnosticsTimeline,
): string {
  const lines = [`准备诊断：${COVERAGE_LABELS[timeline.coverage]}`];
  if (timeline.admissionState) {
    lines.push(
      `准入状态：${TASK_PROVISIONING_STATE_LABELS[timeline.admissionState]}`,
    );
  }
  for (const group of timeline.groups) {
    const attempt = group.attempt;
    lines.push(
      `第 ${group.attemptNumber} 次处理：${
        attempt
          ? `${PROVIDER_LABELS[attempt.providerFamily ?? "unknown"]} / ${ATTEMPT_STATE_LABELS[attempt.state]}`
          : "仅保留事件证据"
      }`,
    );
    if (attempt?.primary) {
      lines.push(
        `  主流程：${OUTCOME_LABELS[attempt.primary.outcome]}${
          attempt.primary.cause ? ` / ${CAUSE_LABELS[attempt.primary.cause]}` : ""
        }`,
      );
    }
    if (attempt) {
      lines.push(
        `  清理：${CLEANUP_LABELS[attempt.cleanup.state]} / 物理尝试 ${attempt.cleanup.attemptCount} 次`,
      );
    }
    for (const event of group.events) {
      const terminal = event.outcome === "started" ? null : event;
      lines.push(
        `  ${event.sequence}. ${STAGE_LABELS[event.stage]} / ${OPERATION_LABELS[event.operation]} / ${OUTCOME_LABELS[event.outcome]}${
          terminal?.durationMs === undefined
            ? ""
            : ` / ${formatDuration(terminal.durationMs)}`
        }${terminal?.cause ? ` / ${CAUSE_LABELS[terminal.cause]}` : ""}${
          terminal?.anomaly ? ` / ${ANOMALY_LABELS[terminal.anomaly]}` : ""
        }`,
      );
    }
  }
  if (timeline.compaction) {
    lines.push(
      `较早证据已汇总：第 ${timeline.compaction.compactedAttemptFrom}-${timeline.compaction.compactedAttemptTo} 次处理`,
    );
  }
  return lines.join("\n");
}

export function taskProvisioningDiagnosticsErrorReason(
  error: unknown,
): TaskProvisioningDiagnosticsClientErrorReason | null {
  return error instanceof TaskProvisioningDiagnosticsClientError
    ? error.reason
    : error == null
      ? null
      : "request_failed";
}

export function TaskProvisioningDiagnosticsPanel({
  taskId,
}: {
  taskId: string;
}): React.ReactElement {
  const query = useInfiniteQuery(
    taskProvisioningDiagnosticsInfiniteQuery(taskId),
  );
  const timeline = React.useMemo(
    () => mergeTaskProvisioningDiagnosticsPages(query.data?.pages ?? []),
    [query.data?.pages],
  );
  const [copied, setCopied] = React.useState(false);

  async function copySafeSummary() {
    if (!timeline || typeof navigator === "undefined") return;
    try {
      await navigator.clipboard?.writeText(
        buildTaskProvisioningDiagnosticsCopyText(timeline),
      );
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <TaskProvisioningDiagnosticsView
      timeline={timeline}
      loading={query.isPending}
      refreshing={query.isFetching && !query.isFetchingNextPage}
      loadingMore={query.isFetchingNextPage}
      errorReason={taskProvisioningDiagnosticsErrorReason(query.error)}
      copied={copied}
      onCopy={() => void copySafeSummary()}
      onRefresh={() => void query.refetch()}
      onLoadMore={() => void query.fetchNextPage()}
    />
  );
}

export interface TaskProvisioningDiagnosticsViewProps {
  readonly timeline: TaskProvisioningDiagnosticsTimeline | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly loadingMore: boolean;
  readonly errorReason: TaskProvisioningDiagnosticsClientErrorReason | null;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onRefresh: () => void;
  readonly onLoadMore: () => void;
}

/** Pure view split from the query container for deterministic SSR-safe tests. */
export function TaskProvisioningDiagnosticsView({
  timeline,
  loading,
  refreshing,
  loadingMore,
  errorReason,
  copied,
  onCopy,
  onRefresh,
  onLoadMore,
}: TaskProvisioningDiagnosticsViewProps): React.ReactElement {
  if (loading) {
    return (
      <section
        aria-label="任务准备诊断"
        aria-busy="true"
        className="grid h-full min-h-0 place-items-center overflow-auto rounded-md border border-border bg-card p-6 text-sm text-muted-foreground"
      >
        正在读取安全诊断证据…
      </section>
    );
  }

  if (errorReason) {
    return <DiagnosticsErrorState reason={errorReason} onRefresh={onRefresh} />;
  }

  if (!timeline) {
    return <DiagnosticsErrorState reason="request_failed" onRefresh={onRefresh} />;
  }

  const reconciliationPending = timeline.groups.some(
    (group) => group.attempt?.cleanup.state === "pending",
  );
  const truncated =
    timeline.compaction !== null ||
    timeline.groups.some((group) => group.attempt?.truncated === true);

  return (
    <section
      aria-label="任务准备诊断"
      data-diagnostics-coverage={timeline.coverage}
      className="h-full min-h-0 overflow-auto rounded-md border border-border bg-card"
    >
      <header className="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">任务准备诊断</h2>
          <p className="mt-0.5 text-xs leading-[1.5] text-muted-foreground">
            仅展示经过约束的阶段、操作、时间与结果；主流程和清理结果彼此独立。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-foreground">
            {COVERAGE_LABELS[timeline.coverage]}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="min-h-8 rounded-md bg-secondary px-3 text-xs text-foreground shadow-ring disabled:opacity-60"
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="min-h-8 rounded-md bg-secondary px-3 text-xs text-foreground shadow-ring"
          >
            {copied ? "已复制安全摘要" : "复制安全摘要"}
          </button>
        </div>
      </header>

      <div className="grid gap-3 p-3 sm:p-4">
        <CoverageState timeline={timeline} />

        {reconciliationPending ? (
          <p
            role="status"
            className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs leading-[1.55] text-warning"
          >
            主流程已经结算，但沙箱清理仍在协调或等待确认；后续刷新会保留原始主结果并追加清理进展。
          </p>
        ) : null}

        {truncated ? (
          <p className="rounded-md border border-border bg-secondary/50 px-3 py-2 text-xs leading-[1.55] text-muted-foreground">
            详细证据已达到保留上限；较早的已结算记录以固定字段汇总，当前记录顺序不受影响。
          </p>
        ) : null}

        {timeline.groups.map((group) => (
          <AttemptCard key={group.attemptNumber} group={group} />
        ))}

        {timeline.hasNextPage ? (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="mx-auto min-h-9 rounded-md bg-secondary px-4 text-sm text-foreground shadow-ring disabled:opacity-60"
          >
            {loadingMore ? "加载中…" : "加载更早/后续证据"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function CoverageState({
  timeline,
}: {
  timeline: TaskProvisioningDiagnosticsTimeline;
}): React.ReactElement | null {
  if (timeline.coverage === "not_started") {
    return (
      <p role="status" className="rounded-md bg-info-soft px-3 py-2 text-sm text-info">
        任务已接受{timeline.admissionState ? `（${TASK_PROVISIONING_STATE_LABELS[timeline.admissionState]}）` : ""}，但尚未进入提供方处理，因此没有诊断 attempt；这不是历史缺失或提供方失败。
      </p>
    );
  }
  if (timeline.coverage === "unavailable") {
    return (
      <p role="status" className="rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground">
        该任务早于诊断证据保留能力，或当前部署无法提供证据；不会从审计文本、终端记录或日志猜测失败原因。
      </p>
    );
  }
  if (timeline.coverage === "partial") {
    return (
      <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        当前只保留了部分证据；未展示的阶段不代表成功或失败。
      </p>
    );
  }
  return null;
}

function DiagnosticsErrorState({
  reason,
  onRefresh,
}: {
  reason: TaskProvisioningDiagnosticsClientErrorReason;
  onRefresh: () => void;
}): React.ReactElement {
  const message: Record<TaskProvisioningDiagnosticsClientErrorReason, string> = {
    denied: "当前会话无权读取这个任务的准备诊断。",
    not_found: "未找到可读取的任务准备诊断。",
    unavailable: "当前部署暂时未开放任务准备诊断，请稍后重试。",
    invalid_response: "服务返回的诊断证据未通过安全校验，已拒绝展示。",
    request_failed: "暂时无法读取任务准备诊断。",
  };
  return (
    <section
      aria-label="任务准备诊断"
      role={reason === "denied" ? "alert" : "status"}
      data-diagnostics-error={reason}
      className="grid h-full min-h-0 place-items-center overflow-auto rounded-md border border-border bg-card p-6 text-center"
    >
      <div className="grid max-w-md gap-3">
        <p className="text-sm text-muted-foreground">{message[reason]}</p>
        {reason === "denied" || reason === "not_found" ? null : (
          <button
            type="button"
            onClick={onRefresh}
            className="mx-auto min-h-9 rounded-md bg-secondary px-4 text-sm text-foreground shadow-ring"
          >
            重试
          </button>
        )}
      </div>
    </section>
  );
}

function AttemptCard({
  group,
}: {
  group: DiagnosticAttemptGroup;
}): React.ReactElement {
  const attempt = group.attempt;
  return (
    <article
      data-diagnostic-attempt={group.attemptNumber}
      className="grid min-w-0 gap-3 rounded-lg border border-border bg-background p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            第 {group.attemptNumber} 次处理
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {attempt
              ? `${PROVIDER_LABELS[attempt.providerFamily ?? "unknown"]} · ${STAGE_LABELS[attempt.stage]} · ${ATTEMPT_STATE_LABELS[attempt.state]}`
              : "attempt 摘要已压缩，仅保留下面的事件证据"}
          </p>
        </div>
        {attempt ? (
          <time
            dateTime={attempt.startedAt.toISOString()}
            className="text-xs text-muted-foreground"
          >
            {formatDate(attempt.startedAt)}
          </time>
        ) : null}
      </div>

      {attempt ? (
        <div className="grid min-w-0 gap-2 md:grid-cols-2">
          <section className="min-w-0 rounded-md border border-info/25 bg-info-soft/35 p-3">
            <h4 className="text-xs font-semibold text-info">主流程结果</h4>
            {attempt.primary ? (
              <dl className="mt-2 grid gap-1 text-xs text-foreground">
                <Fact label="结果" value={OUTCOME_LABELS[attempt.primary.outcome]} />
                <Fact
                  label="原因"
                  value={
                    attempt.primary.cause
                      ? CAUSE_LABELS[attempt.primary.cause]
                      : "无失败原因"
                  }
                />
                <Fact
                  label="自动重试"
                  value={attempt.primary.retryable ? "允许" : "不允许"}
                />
              </dl>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">主流程尚未结算。</p>
            )}
          </section>

          <section
            data-cleanup-state={attempt.cleanup.state}
            className="min-w-0 rounded-md border border-warning/25 bg-warning-soft/35 p-3"
          >
            <h4 className="text-xs font-semibold text-warning">清理与确认</h4>
            <dl className="mt-2 grid gap-1 text-xs text-foreground">
              <Fact label="状态" value={CLEANUP_LABELS[attempt.cleanup.state]} />
              <Fact
                label="物理尝试"
                value={`${attempt.cleanup.attemptCount} 次`}
              />
              {attempt.cleanup.cause ? (
                <Fact label="原因" value={CAUSE_LABELS[attempt.cleanup.cause]} />
              ) : null}
              {attempt.cleanup.lastAttemptOutcome ? (
                <Fact
                  label="最近结果"
                  value={OUTCOME_LABELS[attempt.cleanup.lastAttemptOutcome]}
                />
              ) : null}
            </dl>
          </section>
        </div>
      ) : null}

      {group.events.length > 0 ? (
        <ol className="grid min-w-0 gap-2" aria-label={`第 ${group.attemptNumber} 次处理事件`}>
          {group.events.map((event) => (
            <DiagnosticEventRow key={event.eventId} event={event} />
          ))}
        </ol>
      ) : (
        <p className="rounded-md bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
          该 attempt 没有可展示的详细事件。
        </p>
      )}
    </article>
  );
}

function DiagnosticEventRow({
  event,
}: {
  event: TaskProvisioningDiagnosticEvent;
}): React.ReactElement {
  const terminal = event.outcome === "started" ? null : event;
  const channelClass =
    event.channel === "primary"
      ? "border-info/20 bg-info-soft/25"
      : event.channel === "cleanup"
        ? "border-warning/25 bg-warning-soft/25"
        : "border-border bg-secondary/40";
  return (
    <li
      data-diagnostic-channel={event.channel}
      data-diagnostic-sequence={event.sequence}
      className={`grid min-w-0 gap-1.5 rounded-md border px-3 py-2.5 ${channelClass}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-mono text-muted-foreground">#{event.sequence}</span>
        <span className="rounded-full bg-card px-2 py-0.5 text-[11px] text-muted-foreground shadow-ring">
          {CHANNEL_LABELS[event.channel]}
        </span>
        <strong className="font-medium text-foreground">
          {STAGE_LABELS[event.stage]} · {OPERATION_LABELS[event.operation]}
        </strong>
        <span className="text-muted-foreground">{OUTCOME_LABELS[event.outcome]}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <time dateTime={event.observedAt.toISOString()}>{formatDate(event.observedAt)}</time>
        {terminal?.durationMs === undefined ? null : (
          <span>耗时 {formatDuration(terminal.durationMs)}</span>
        )}
        {terminal?.cause ? <span>原因：{CAUSE_LABELS[terminal.cause]}</span> : null}
        {terminal?.anomaly ? (
          <span>异常：{ANOMALY_LABELS[terminal.anomaly]}</span>
        ) : null}
      </div>
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="flex-none text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{value}</dd>
    </div>
  );
}

function formatDate(value: Date): string {
  return value.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 60_000) {
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.floor((durationMs % 60_000) / 1_000);
    return `${minutes} 分 ${seconds} 秒`;
  }
  if (durationMs >= 1_000) {
    return `${(durationMs / 1_000).toFixed(durationMs % 1_000 === 0 ? 0 : 1)} 秒`;
  }
  return `${durationMs} 毫秒`;
}
