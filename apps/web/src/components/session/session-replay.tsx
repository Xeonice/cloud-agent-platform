/**
 * Read-only session replay (session-sandbox-retention, Track 8).
 *
 * The body the session page renders for a FINISHED task in place of the live
 * terminal: a structured, scrollable view of the codex conversation parsed from
 * the settled sandbox's rollout — NO live WebSocket, NO input surface, NO
 * resume/stop control. Driven exclusively by `sessionHistoryQuery` (the
 * real/mock seam); the discriminated `SessionHistory` decides which of the three
 * honest faces renders: the transcript, an empty state, or an expired state.
 *
 * Layout mirrors `design-baseline/history-replay-preview.html`: a two-tab head
 * (对话记录 primary / 终端记录 secondary), a review sidebar (search + five filter
 * presets + an event tree), and the conversation pane with the three turn
 * treatments (operator bubble, commentary muted-italic, final-answer green-tinted,
 * tool-call card with token count).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  SessionHistory,
  SessionTurn,
  ReplayPresentationState,
  ExecutionMode,
} from "@cap/contracts";
import { sessionHistoryQuery } from "@/lib/api/queries";
import { cn } from "@/utils";
import { SessionCastLog } from "./session-cast-log";

/**
 * A conversation turn (user / assistant / tool) — the kinds the cockpit's 对话记录
 * pane renders. The audit-sourced `system` milestone kind (wire-transcript-real-data)
 * is excluded here; it is shown only on the dedicated transcript timeline.
 */
type ConvTurn = Exclude<SessionTurn, { kind: "system" }>;

/** The five review filter presets (borrowed from codex-transcript-viewer). */
const FILTERS = ["默认", "无工具", "用户", "答案", "全部"] as const;
type Filter = (typeof FILTERS)[number];

/** Replay-meta line text per terminal presentation state. */
const META_BY_STATE: Record<ReplayPresentationState, (n: number) => string> = {
  completed: (n) => `已结束 · 只读 · ${n} 条记录`,
  cancelled: () => "操作员已停止 · 只读 · 对话完整 / 终端为中断画面",
  failed: () => "失败 · 只读 · 对话到失败处",
  // `no-start` never reaches the available branch (it renders the empty state).
  "no-start": () => "未能启动 · 只读",
};

export interface SessionReplayProps {
  taskId: string;
  /**
   * The terminal task's replay presentation state (drives the meta line). Absent
   * for a LIVE running view (headless-task-conversation-view), which has no
   * terminal status yet.
   */
  presentationState?: ReplayPresentationState;
  /**
   * headless-task-conversation-view: a RUNNING headless task — poll the transcript
   * on a cadence and show a running indicator (the conversation grows live).
   */
  live?: boolean;
  /**
   * headless-task-conversation-view: a headless task has NO terminal record — hide
   * the 终端记录 tab and never fetch the cast. Absent/`interactive-pty` keeps it.
   */
  executionMode?: ExecutionMode;
}

export function SessionReplay({
  taskId,
  presentationState,
  live = false,
  executionMode,
}: SessionReplayProps): React.ReactElement {
  // Live (running headless) view polls the transcript so the conversation grows as
  // codex runs; a finished view reads once. Full re-parse server-side keeps this a
  // plain refetch (no offset/state) — React diffs only the changed turns.
  const { data, isLoading } = useQuery(
    live
      ? { ...sessionHistoryQuery(taskId), refetchInterval: 1500 }
      : sessionHistoryQuery(taskId),
  );

  if (isLoading || !data) {
    return <ReplayShell meta="读取会话记录…">{null}</ReplayShell>;
  }
  if (data.status === "empty") {
    // A live task whose rollout has no turns yet is STARTING, not failed.
    if (live) {
      return (
        <ReplayShell meta="运行中 · 实时 · 等待首个输出…">{null}</ReplayShell>
      );
    }
    return (
      <EmptyReplay
        icon="⚠"
        title="会话未能启动"
        detail={
          data.reason === "agent-failed-to-start"
            ? "Codex 沙箱已创建，但 agent 未能启动，没有产生可回看的对话内容。"
            : "该任务没有产生可回看的对话记录（agent 未运行或未写出记录）。"
        }
        metaLabel="未能启动"
      />
    );
  }
  if (data.status === "expired") {
    return (
      <EmptyReplay
        icon="🗄"
        title="会话记录已过期"
        detail="该任务的沙箱与会话记录已超过保留期被清理，无法回看。"
        metaLabel="已过期"
      />
    );
  }
  return (
    <AvailableReplay
      taskId={taskId}
      history={data}
      presentationState={presentationState}
      live={live}
      executionMode={executionMode}
    />
  );
}

/** The available transcript: tabs + review sidebar + conversation pane. */
function AvailableReplay({
  taskId,
  history,
  presentationState,
  live,
  executionMode,
}: {
  taskId: string;
  history: Extract<SessionHistory, { status: "available" }>;
  presentationState?: ReplayPresentationState;
  live?: boolean;
  executionMode?: ExecutionMode;
}): React.ReactElement {
  const [tab, setTab] = React.useState<"conv" | "term">("conv");
  const [filter, setFilter] = React.useState<Filter>("默认");
  const [search, setSearch] = React.useState("");
  const turnRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  // The cockpit's 对话记录 pane is conversation-only: audit-sourced `system`
  // milestone turns (wire-transcript-real-data, merged server-side for ALL
  // session-history consumers) belong on the dedicated transcript timeline, not
  // here — drop them so this surface stays unchanged.
  const turns = history.turns.filter(
    (t): t is ConvTurn => t.kind !== "system",
  );
  const query = search.trim().toLowerCase();

  // Filter + search applied together; indices are kept so the event tree and
  // the conversation pane reference the SAME turn (scroll-to works).
  const visible = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => passesFilter(turn, filter))
    .filter(({ turn }) => (query ? turnMatches(turn, query) : true));

  // The interrupted framing is driven by the WIRE field `history.isInterrupted`
  // (V.1) — authoritative over the client-derived presentationState; the latter
  // still distinguishes completed vs failed for a clean end.
  const meta = live
    ? `运行中 · 实时 · ${turns.length} 条记录`
    : history.isInterrupted
      ? META_BY_STATE.cancelled(turns.length)
      : META_BY_STATE[presentationState ?? "completed"](turns.length);

  return (
    <ReplayShell
      meta={meta}
      tab={tab}
      onTab={setTab}
      // headless-task-conversation-view: a headless task has no terminal record,
      // so the 终端记录 tab is hidden for it (conversation is the only surface).
      showTermTab={executionMode !== "headless-exec"}
    >
      {tab === "conv" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[212px_minmax(0,1fr)]">
          <ReviewSidebar
            turns={turns}
            filter={filter}
            onFilter={setFilter}
            search={search}
            onSearch={setSearch}
            onJump={(i) =>
              turnRefs.current[i]?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              })
            }
          />
          <div className="overflow-auto px-[22px] py-[18px]">
            <div className="flex max-w-[760px] flex-col gap-4">
              {visible.length === 0 ? (
                <p className="py-10 text-center text-[12.5px] text-muted-2">
                  没有匹配的记录
                </p>
              ) : (
                visible.map(({ turn, index }) => (
                  <TurnItem
                    key={index}
                    turn={turn}
                    ref={(el) => {
                      turnRefs.current[index] = el;
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
        // static-terminal-log — the read-only static, scrollable terminal log.
        <SessionCastLog taskId={taskId} />
      )}
    </ReplayShell>
  );
}

/** The card chrome: head (tabs + meta) wrapping the body, + the retention note. */
function ReplayShell({
  meta,
  tab = "conv",
  onTab,
  showTermTab = false,
  children,
}: {
  meta: string;
  tab?: "conv" | "term";
  onTab?: (t: "conv" | "term") => void;
  showTermTab?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col">
      <section className="flex min-h-[560px] flex-1 flex-col overflow-hidden rounded-[10px] bg-card ring-1 ring-border">
        <div className="flex min-h-[42px] items-center justify-between gap-3 border-b border-border px-3.5">
          <div className="inline-flex rounded-lg bg-secondary p-[3px]">
            <SegButton on={tab === "conv"} onClick={() => onTab?.("conv")}>
              对话记录
            </SegButton>
            {showTermTab && (
              <SegButton on={tab === "term"} onClick={() => onTab?.("term")}>
                终端记录
              </SegButton>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{meta}</span>
        </div>
        {children}
      </section>
      <p className="mt-3.5 flex items-center gap-2 text-xs text-muted-2">
        <span className="text-muted-foreground">ⓘ</span>
        会话记录在任务结束后按设置的保留期保留，过期自动清理。
      </p>
    </div>
  );
}

function SegButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-md px-3 py-[5px] text-xs font-medium",
        on
          ? "bg-card text-foreground ring-1 ring-border"
          : "bg-transparent text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Review sidebar: search + the five filter presets + the event tree. */
function ReviewSidebar({
  turns,
  filter,
  onFilter,
  search,
  onSearch,
  onJump,
}: {
  turns: ConvTurn[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  search: string;
  onSearch: (s: string) => void;
  onJump: (index: number) => void;
}): React.ReactElement {
  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-[#fcfcfd]">
      <div className="m-3 flex h-8 items-center gap-[7px] rounded-[7px] bg-card px-2.5 ring-1 ring-border">
        <span className="text-muted-2">⌕</span>
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="搜索本次会话…"
          className="w-full bg-transparent text-xs outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-1 px-3 pb-2.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onFilter(f)}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium",
              filter === f
                ? "bg-foreground text-white"
                : "bg-secondary text-muted-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-px overflow-auto px-2 pb-3">
        {turns.map((turn, index) => {
          const { icon, klass, label } = treeEntry(turn);
          return (
            <button
              key={index}
              type="button"
              onClick={() => onJump(index)}
              className="flex items-center gap-[7px] rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-secondary"
            >
              <span className={cn("w-3.5 flex-none text-center text-[11px]", klass)}>
                {icon}
              </span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** One conversation turn rendered in its kind-specific treatment. */
const TurnItem = React.forwardRef<HTMLDivElement, { turn: ConvTurn }>(
  function TurnItem({ turn }, ref) {
    if (turn.kind === "user") {
      return (
        <div ref={ref} className="grid scroll-mt-3 gap-1.5">
          <Role dot="bg-foreground" label="操作员指令" />
          <div className="rounded-lg bg-secondary px-3 py-2.5 text-[13px] font-medium leading-[1.6]">
            {turn.text}
          </div>
        </div>
      );
    }
    if (turn.kind === "assistant") {
      if (turn.isFinalAnswer) {
        return (
          <div ref={ref} className="grid scroll-mt-3 gap-1.5">
            <Role dot="bg-success" label="Codex" />
            <div className="rounded-lg bg-success-soft px-3.5 py-3 text-[13px] leading-[1.6] ring-1 ring-success/15">
              <span className="mb-2 inline-flex items-center gap-[5px] rounded bg-card px-1.5 py-px text-[10px] font-bold text-success ring-1 ring-success/25">
                ✓ 最终回答
              </span>
              <div>{turn.text}</div>
            </div>
          </div>
        );
      }
      return (
        <div ref={ref} className="grid scroll-mt-3 gap-1.5">
          <Role dot="bg-success" label="Codex · 过程" />
          <div className="border-l-2 border-border pl-2.5 text-[13px] italic leading-[1.6] text-muted-foreground">
            {turn.text}
          </div>
        </div>
      );
    }
    // tool turn
    return (
      <div ref={ref} className="grid scroll-mt-3 gap-1.5">
        <Role dot="bg-info" label="工具调用" />
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 bg-secondary px-3 py-2 font-mono text-xs">
            <span className="rounded bg-info-soft px-1.5 py-px font-sans text-[10px] font-semibold text-info">
              {turn.name}
            </span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
              {summarizeArgs(turn.args)}
            </span>
            {turn.tokenCount != null && (
              <span className="ml-auto flex-none font-sans text-[10px] text-muted-2">
                {turn.tokenCount} tok
              </span>
            )}
          </div>
          <div className="whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-[1.5] text-muted-foreground">
            {turn.output ?? "（调用被中断，无输出）"}
          </div>
        </div>
      </div>
    );
  },
);

function Role({ dot, label }: { dot: string; label: string }): React.ReactElement {
  return (
    <div className="inline-flex items-center gap-[7px] text-[11px] font-semibold text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </div>
  );
}

/** The empty / expired honest face (no tabs, no transcript). */
function EmptyReplay({
  icon,
  title,
  detail,
  metaLabel,
}: {
  icon: string;
  title: string;
  detail: string;
  metaLabel: string;
}): React.ReactElement {
  return (
    <ReplayShell meta={metaLabel}>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-12 py-12 text-center text-muted-foreground">
        <div className="grid h-11 w-11 place-items-center rounded-[11px] bg-secondary text-[22px] text-muted-2">
          {icon}
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="max-w-[380px] text-[12.5px] leading-[1.5]">{detail}</div>
      </div>
    </ReplayShell>
  );
}

// ---- pure helpers -----------------------------------------------------------

/** Filter-preset semantics (task 8.3). */
function passesFilter(turn: ConvTurn, filter: Filter): boolean {
  switch (filter) {
    case "无工具":
      return turn.kind !== "tool";
    case "用户":
      return turn.kind === "user";
    case "答案":
      return (
        turn.kind === "user" ||
        (turn.kind === "assistant" && turn.isFinalAnswer)
      );
    default: // 默认 / 全部
      return true;
  }
}

/** Case-insensitive search over a turn's visible text. */
function turnMatches(turn: ConvTurn, query: string): boolean {
  if (turn.kind === "user" || turn.kind === "assistant") {
    return turn.text.toLowerCase().includes(query);
  }
  return (
    turn.name.toLowerCase().includes(query) ||
    turn.args.toLowerCase().includes(query) ||
    (turn.output?.toLowerCase().includes(query) ?? false)
  );
}

/** Event-tree entry: icon glyph + color class + truncated label per kind. */
function treeEntry(turn: ConvTurn): {
  icon: string;
  klass: string;
  label: string;
} {
  if (turn.kind === "user") return { icon: "›", klass: "text-foreground", label: turn.text };
  if (turn.kind === "assistant") {
    return turn.isFinalAnswer
      ? { icon: "✓", klass: "text-success", label: "最终回答" }
      : { icon: "•", klass: "text-success", label: turn.text };
  }
  return { icon: "⌘", klass: "text-info", label: `${turn.name} ${summarizeArgs(turn.args)}` };
}

/** A compact one-line summary of a tool's raw arguments for the head/tree. */
function summarizeArgs(args: string): string {
  // function_call arguments are usually a JSON object; pull the obvious command
  // field when present, else show a trimmed first line.
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const cmd = parsed.cmd ?? parsed.command ?? parsed.path ?? parsed.file;
    if (typeof cmd === "string") return cmd;
  } catch {
    // not JSON (e.g. apply_patch input) — fall through to the raw first line.
  }
  const firstLine = args.split("\n")[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}
