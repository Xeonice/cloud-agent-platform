/**
 * `/tasks/$taskId/transcript` — 会话记录 (app-shell; wire-transcript-real-data).
 *
 * The READ-ONLY session-transcript timeline reached from the history list's
 * 「查看会话」 entry. A standalone route (`$taskId_` opts OUT of nesting under the
 * live session page) rendered in the `_app` shell `<Outlet/>`. It renders the
 * REAL persisted transcript (`GET /tasks/:id/session-history` via
 * `sessionHistoryQuery`, keyed by the route's `taskId`) as a vertical timeline of
 * typed events — system milestone / operator input / reasoning (commentary) /
 * tool call (cmd + collapsible output + diffstat) / final answer — with a type
 * filter (全部/我的输入/工具/回答) + search that narrow the timeline together, the
 * honest empty/expired states, and a link to the terminal record.
 *
 * Header identity comes from the REAL task (`taskQuery` + `taskContextQuery`);
 * the per-row time gutter and the header totals (tokens / duration) come from the
 * session-history payload. NO hardcoded sample. SSR is off (`ssr: false`) so the
 * query-driven render and the UTC time-slice are client-deterministic.
 */
import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import type { SessionTurn } from "@cap/contracts";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import { SessionTag } from "@/components/status-pill";
import { SegmentedControl } from "@/components/segmented-control";
import { EmptyState } from "@/components/empty-state";
import {
  sessionHistoryQuery,
  taskQuery,
  taskContextQuery,
} from "@/lib/api/queries";
import {
  clock,
  formatDuration,
  filterTurns,
  type TranscriptFilter,
} from "@/lib/transcript-timeline";

export const Route = createFileRoute("/_app/tasks/$taskId_/transcript")({
  ssr: false,
  component: TranscriptPage,
});

const FILTER_OPTIONS = [
  { value: "all" as const, label: "全部" },
  { value: "user" as const, label: "我的输入" },
  { value: "tool" as const, label: "工具" },
  { value: "answer" as const, label: "回答" },
];

function TranscriptPage() {
  const { taskId } = Route.useParams();
  const [filter, setFilter] = React.useState<TranscriptFilter>("all");
  const [search, setSearch] = React.useState("");

  const { data: task } = useQuery(taskQuery(taskId));
  const { data: context } = useQuery(taskContextQuery(taskId));
  const { data: history, isLoading } = useQuery(sessionHistoryQuery(taskId));

  const shortId = shortTaskId(taskId);
  const repo = context?.repo ?? "—";
  const branch = task?.branch ?? context?.branch ?? "main";
  const agent = context?.agent ?? "—";
  const statusLabel = STATUS_LABEL[task?.status ?? ""] ?? "—";

  const turns = history?.status === "available" ? history.turns : [];
  const meta = history?.status === "available" ? history.meta : undefined;
  const toolCount = turns.filter((t) => t.kind === "tool").length;
  const answerCount = turns.filter(
    (t) => t.kind === "assistant" && t.isFinalAnswer,
  ).length;

  const visible = filterTurns(turns, filter, search);

  return (
    <>
      {/* Transcript header (session-style: crumb → history, title, state, prompt, tags) */}
      <section className="mb-[18px] grid gap-2">
        <Link
          to="/history"
          aria-label="返回历史日志"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <BackIcon />
          历史日志
        </Link>
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="min-w-0 text-2xl font-semibold leading-tight tracking-[-0.9px] text-foreground">
            {shortId}
          </h1>
          <span
            aria-label="任务状态"
            className="inline-flex flex-none items-center gap-2 text-xs font-medium text-muted-foreground/80"
          >
            <span aria-hidden="true" className="size-2 flex-none rounded-full bg-muted-foreground" />
            {statusLabel}
          </span>
        </div>
        <p className="max-w-[880px] truncate text-[13px] leading-relaxed text-muted-foreground/80">
          {task?.prompt ?? "正在加载任务目标…"}
        </p>
        <div aria-label="会话元数据" className="flex flex-wrap gap-1.5">
          <SessionTag mono>
            <BranchIcon />
            {branch}
          </SessionTag>
          <SessionTag>{repo}</SessionTag>
          <SessionTag>{agent}</SessionTag>
          {meta?.durationMs != null ? (
            <SessionTag>{formatDuration(meta.durationMs)}</SessionTag>
          ) : null}
          {meta?.totalTokens != null ? (
            <SessionTag>{meta.totalTokens.toLocaleString()} tokens</SessionTag>
          ) : null}
        </div>
      </section>

      {/* Transcript panel */}
      <section className="mt-3 rounded-[8px] bg-card p-[18px] shadow-ring">
        {/* Panel head */}
        <div className="-mx-[18px] -mt-[18px] mb-3.5 flex items-center justify-between border-b border-border px-[18px] pb-3.5 pt-[18px]">
          <div>
            <h2 className="text-sm font-semibold text-foreground">会话记录</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {turns.length} 个事件 · {toolCount} 次工具调用 · {answerCount} 个最终回答
            </p>
          </div>
          <Link
            to="/tasks/$taskId"
            params={{ taskId }}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-card px-3 text-xs font-medium text-foreground shadow-ring transition-colors hover:bg-secondary"
          >
            <TerminalIcon />
            终端记录
          </Link>
        </div>

        {/* Toolbar */}
        <div className="mb-3 grid grid-cols-1 items-center gap-3 min-[821px]:grid-cols-[minmax(220px,1fr)_auto]">
          <label className="grid min-h-9 grid-cols-[32px_minmax(0,1fr)] items-center rounded-md bg-card shadow-[inset_0_0_0_1px_var(--border)]">
            <span aria-hidden="true" className="grid place-items-center font-mono text-muted-foreground">
              ⌕
            </span>
            <input
              type="search"
              aria-label="搜索会话记录"
              placeholder="搜索消息、命令或文件"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-h-9 min-w-0 border-0 bg-transparent pr-2 text-[13px] outline-none placeholder:text-muted-foreground"
            />
          </label>
          <SegmentedControl
            ariaLabel="按类型筛选"
            options={FILTER_OPTIONS}
            value={filter}
            onValueChange={setFilter}
          />
        </div>

        {/* Timeline / honest states */}
        {history?.status === "expired" ? (
          <EmptyState
            icon={<SearchIcon />}
            title="会话记录已过期"
            description="该任务的沙箱与会话记录已超过保留期被清理，无法回看。"
          />
        ) : history?.status === "empty" ? (
          <EmptyState
            icon={<SearchIcon />}
            title="没有可回看的记录"
            description={
              history.reason === "agent-failed-to-start"
                ? "Codex 沙箱已创建，但 agent 未能启动，没有产生对话内容。"
                : "该任务没有产生可回看的对话记录（agent 未运行或未写出记录）。"
            }
          />
        ) : isLoading ? (
          <EmptyState
            icon={<SearchIcon />}
            title="读取会话记录…"
            description="正在加载该任务的会话记录。"
          />
        ) : visible.length > 0 ? (
          <div className="grid">
            {visible.map((ev, i) => (
              <TxRow key={i} ev={ev} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<SearchIcon />}
            title="没有匹配的记录"
            description="换个关键词，或切换到其它类型筛选。"
          />
        )}
      </section>
    </>
  );
}

/** One timeline row — 56px time gutter + content, top hairline (first has none). */
function TxRow({ ev }: { ev: SessionTurn }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-3.5 border-t border-border py-[7px] first:border-t-0">
      <span className="pt-0.5 font-mono text-[11px] leading-normal text-muted-foreground/70">
        {clock(ev.at)}
      </span>
      <div className="grid min-w-0 gap-1.5">
        {ev.kind === "system" ? (
          <div className="self-center text-xs text-muted-foreground">
            {ev.title}
            {ev.detail ? (
              <span className="ml-1.5 font-mono text-muted-foreground/70">· {ev.detail}</span>
            ) : null}
          </div>
        ) : null}

        {ev.kind === "user" ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-[18px] flex-none place-items-center rounded-[5px] bg-foreground font-mono text-[9px] font-semibold text-background">
                我
              </span>
              <span className="flex-none text-xs font-semibold text-foreground">操作者</span>
            </div>
            <div className="text-[13px] leading-relaxed text-foreground">{ev.text}</div>
          </>
        ) : null}

        {ev.kind === "assistant" && !ev.isFinalAnswer ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex-none text-xs font-semibold text-muted-foreground">推理</span>
            </div>
            <div className="text-[13px] italic leading-relaxed text-muted-foreground">
              {ev.text}
            </div>
          </>
        ) : null}

        {ev.kind === "tool" ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <WrenchIcon />
              <span className="flex-none text-xs font-semibold text-muted-foreground">
                {ev.name}
              </span>
              <code className="min-w-0 truncate rounded-[5px] bg-secondary px-[7px] py-0.5 text-xs text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
                {ev.args}
              </code>
              {ev.diffstat ? (
                <span className="ml-auto flex-none font-mono text-[11px]">
                  <span className="text-success">+{ev.diffstat.add}</span>{" "}
                  <span className="text-danger">−{ev.diffstat.del}</span>
                </span>
              ) : ev.tokenCount != null ? (
                <span className="ml-auto flex-none text-[11px] text-muted-foreground">
                  {ev.tokenCount.toLocaleString()} tokens
                </span>
              ) : null}
            </div>
            {ev.output ? (
              <details className="group">
                <summary className="cursor-pointer list-none text-[11px] text-muted-foreground marker:hidden">
                  <span className="text-muted-foreground/70 group-open:hidden">▸ </span>
                  <span className="hidden text-muted-foreground/70 group-open:inline">▾ </span>
                  输出
                </summary>
                <pre className="mt-1.5 overflow-x-auto rounded-md bg-terminal-bg px-3 py-2.5 font-mono text-xs leading-normal text-terminal-fg">
                  {ev.output}
                </pre>
              </details>
            ) : null}
          </>
        ) : null}

        {ev.kind === "assistant" && ev.isFinalAnswer ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-[18px] flex-none place-items-center rounded-[5px] bg-success font-mono text-[9px] font-semibold text-background">
                {agentInitials(ev)}
              </span>
              <span className="flex-none text-xs font-semibold text-foreground">最终回答</span>
            </div>
            <div className="rounded-[8px] bg-success-soft px-3 py-2.5 text-[13px] leading-relaxed text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--success)_18%,transparent)]">
              {ev.text}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Two-letter avatar for the final-answer agent bubble (static). */
function agentInitials(_turn: SessionTurn): string {
  return "AI";
}

/** Lifecycle status → Chinese label for the header pill (honest "—" fallback). */
const STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  agent_failed_to_start: "未能启动",
  running: "运行中",
  pending: "等待中",
  queued: "排队中",
};

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-[13px] flex-none">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}
function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3 flex-none text-muted-foreground">
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3.5">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}
function WrenchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-[13px] flex-none text-info">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
