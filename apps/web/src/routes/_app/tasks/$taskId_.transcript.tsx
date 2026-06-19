/**
 * `/tasks/$taskId/transcript` — 会话记录 (app-shell, SSR;
 * pixel-restore-console-to-od Track 11).
 *
 * The READ-ONLY session-transcript timeline reached from the history list's
 * 「查看会话」 entry. A standalone route (`$taskId_` opts OUT of nesting under the
 * live session page) rendered in the `_app` shell `<Outlet/>`. It renders the
 * persisted transcript (`session-transcript-persistence`) as a vertical timeline
 * of typed events — operator input / reasoning / tool call (cmd + collapsible
 * output + diffstat) / final answer / system — with a type filter
 * (全部/我的输入/工具/回答) + search that narrow the timeline together, an empty
 * state, and a link to the terminal record.
 *
 * Faithful to `design-baseline/screens/transcript.html` (the `.tx-*` rows + the
 * session-style header ported to Tailwind). SSR-safe: pure render off a constant
 * sample transcript (the live read lands with the persisted-transcript wiring,
 * design D7) + `useState` filter/search; no window/clock/random at render.
 */
import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { cn } from "@/utils";
import { SessionTag } from "@/components/status-pill";
import { SegmentedControl } from "@/components/segmented-control";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/_app/tasks/$taskId_/transcript")({
  component: TranscriptPage,
});

type EventType = "system" | "user" | "reasoning" | "tool" | "answer";
type FilterValue = "all" | "user" | "tool" | "answer";

interface ToolDetail {
  /** Collapsible <details> summary (e.g. 输出 / 查看 diff). */
  summary: string;
  /** Pre body lines; `diff` renders +/- coloring. */
  body: React.ReactNode;
  /** Render as a dark terminal pre (default) or a diff pre. */
  diff?: boolean;
}

interface TxEvent {
  id: string;
  type: EventType;
  time: string;
  search: string;
  // user / reasoning / answer
  role?: string;
  avatar?: string;
  agentAvatar?: boolean;
  text?: React.ReactNode;
  tokens?: string;
  answer?: React.ReactNode;
  // tool
  toolRole?: string;
  cmd?: string;
  result?: React.ReactNode;
  diffstat?: { add: string; del: string };
  detail?: ToolDetail;
  // system
  content?: React.ReactNode;
}

const SAMPLE: readonly TxEvent[] = [
  {
    id: "s1",
    type: "system",
    time: "17:08:23",
    search: "任务创建 cloud-agent-platform aio-execution-hardening",
    content: (
      <>
        任务创建于{" "}
        <span className="font-mono">cloud-agent-platform · aio-execution-hardening</span>
      </>
    ),
  },
  {
    id: "s2",
    type: "system",
    time: "17:08:31",
    search: "沙箱就绪 iad-02 已分配",
    content: (
      <>
        沙箱就绪 · 已分配 <span className="font-mono">iad-02-01</span>
      </>
    ),
  },
  {
    id: "u1",
    type: "user",
    time: "17:08",
    search: "操作者 迁移 console TanStack Start loader query 缓存",
    role: "操作者",
    avatar: "TH",
    text: "迁移 console 至 TanStack Start 并补齐数据层：建立 file-based 路由、迁移现有 loader 到 route loader，并接入 query 缓存层；保持既有页面行为不变。",
  },
  {
    id: "r1",
    type: "reasoning",
    time: "17:08",
    search: "推理 规划 路由 loader query createBrowserRouter",
    role: "推理",
    text: "先读现有 console 的路由与数据获取方式，确认 createBrowserRouter 的使用点，再规划迁移：1) 建立 file-based 路由树 2) 把页面级 loader 迁到 route loader 3) 用 query 客户端缓存收口数据层。",
  },
  {
    id: "t1",
    type: "tool",
    time: "17:09",
    search: "shell rg createBrowserRouter apps/web/src 工具调用",
    toolRole: "Shell",
    cmd: 'rg -l "createBrowserRouter" apps/web/src',
    result: "2 个文件",
    detail: {
      summary: "输出",
      body: "apps/web/src/router.tsx\napps/web/src/main.tsx",
    },
  },
  {
    id: "t2",
    type: "tool",
    time: "17:09",
    search: "读取文件 router.tsx 工具调用",
    toolRole: "读取文件",
    cmd: "apps/web/src/router.tsx · 1–86",
  },
  {
    id: "t3",
    type: "tool",
    time: "17:10",
    search: "应用补丁 patch __root.tsx routes diff 工具调用",
    toolRole: "应用补丁",
    cmd: "apps/web/src/routes/__root.tsx",
    diffstat: { add: "+120", del: "−0" },
    detail: {
      summary: "查看 diff",
      diff: true,
      body: (
        <>
          <span className="text-[#4ade80]">
            + import {"{"} createRootRoute, Outlet {"}"} from '@tanstack/react-router'
          </span>
          {"\n"}
          <span className="text-[#4ade80]">
            + export const Route = createRootRoute({"{"} component: () =&gt; &lt;Outlet /&gt; {"}"})
          </span>
        </>
      ),
    },
  },
  {
    id: "t4",
    type: "tool",
    time: "17:12",
    search: "shell pnpm typecheck 0 errors 工具调用",
    toolRole: "Shell",
    cmd: "pnpm -w typecheck",
    result: (
      <>
        <span className="text-success">✓</span> 0 errors
      </>
    ),
  },
  {
    id: "t5",
    type: "tool",
    time: "17:12",
    search: "shell pnpm vitest 12 passed 测试 工具调用",
    toolRole: "Shell",
    cmd: "pnpm vitest run",
    result: (
      <>
        <span className="text-success">✓</span> 12 passed
      </>
    ),
  },
  {
    id: "a1",
    type: "answer",
    time: "17:13",
    search: "Codex 最终回答 完成 迁移 路由 loader query typecheck",
    role: "Codex",
    avatar: "CX",
    agentAvatar: true,
    tokens: "3,420 tokens",
    answer: (
      <>
        <p className="m-0 mb-2">已完成 console 到 TanStack Start 的迁移：</p>
        <ul className="my-1.5 grid list-disc gap-1 pl-[18px]">
          <li>
            新增 <span className="font-mono">routes/</span> file-based 路由树，
            <span className="font-mono">__root.tsx</span> 承载布局与 Outlet。
          </li>
          <li>页面级 loader 迁移到 route loader，数据在进入路由前预取。</li>
          <li>接入 query 缓存层统一收口请求；typecheck 与 12 个测试全部通过。</li>
        </ul>
        <p className="m-0">
          既有页面行为保持不变，可直接合并到{" "}
          <span className="font-mono">aio-execution-hardening</span>。
        </p>
      </>
    ),
  },
  {
    id: "s3",
    type: "system",
    time: "17:13:09",
    search: "任务完成 耗时 8m",
    content: <>任务完成 · 耗时 8m 04s</>,
  },
] as const;

const FILTER_OPTIONS = [
  { value: "all" as const, label: "全部" },
  { value: "user" as const, label: "我的输入" },
  { value: "tool" as const, label: "工具" },
  { value: "answer" as const, label: "回答" },
];

function TranscriptPage() {
  const [filter, setFilter] = React.useState<FilterValue>("all");
  const [search, setSearch] = React.useState("");

  const query = search.trim().toLowerCase();
  const visible = SAMPLE.filter((ev) => {
    const typeOk = filter === "all" ? true : ev.type === filter;
    const searchOk = query === "" ? true : ev.search.toLowerCase().includes(query);
    return typeOk && searchOk;
  });

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
            task_aaaa
          </h1>
          <span
            aria-label="任务状态"
            className="inline-flex flex-none items-center gap-2 text-xs font-medium text-muted-foreground/80"
          >
            <span aria-hidden="true" className="size-2 flex-none rounded-full bg-muted-foreground" />
            已完成
          </span>
        </div>
        <p className="max-w-[880px] truncate text-[13px] leading-relaxed text-muted-foreground/80">
          迁移 console 至 TanStack Start 并补齐数据层：建立 file-based 路由、迁移现有 loader 到 route loader，并接入 query 缓存层；保持既有页面行为不变。
        </p>
        <div aria-label="会话元数据" className="flex flex-wrap gap-1.5">
          <SessionTag mono>
            <BranchIcon />
            aio-execution-hardening
          </SessionTag>
          <SessionTag>cloud-agent-platform</SessionTag>
          <SessionTag>Codex</SessionTag>
          <SessionTag>8m 04s</SessionTag>
          <SessionTag>3,420 tokens</SessionTag>
        </div>
      </section>

      {/* Transcript panel */}
      <section className="mt-3 rounded-[8px] bg-card p-[18px] shadow-ring">
        {/* Panel head */}
        <div className="-mx-[18px] -mt-[18px] mb-3.5 flex items-center justify-between border-b border-border px-[18px] pb-3.5 pt-[18px]">
          <div>
            <h2 className="text-sm font-semibold text-foreground">会话记录</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              10 个事件 · 5 次工具调用 · 1 个最终回答
            </p>
          </div>
          <Link
            to="/tasks/$taskId"
            params={{ taskId: Route.useParams().taskId }}
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

        {/* Timeline */}
        {visible.length > 0 ? (
          <div className="grid">
            {visible.map((ev) => (
              <TxRow key={ev.id} ev={ev} />
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
function TxRow({ ev }: { ev: TxEvent }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-3.5 border-t border-border py-[7px] first:border-t-0">
      <span className="pt-0.5 font-mono text-[11px] leading-normal text-muted-foreground/70">
        {ev.time}
      </span>
      <div className="grid min-w-0 gap-1.5">
        {ev.type === "system" ? (
          <div className="self-center text-xs text-muted-foreground">{ev.content}</div>
        ) : null}

        {ev.type === "user" ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-[18px] flex-none place-items-center rounded-[5px] bg-foreground font-mono text-[9px] font-semibold text-background">
                {ev.avatar}
              </span>
              <span className="flex-none text-xs font-semibold text-foreground">{ev.role}</span>
            </div>
            <div className="text-[13px] leading-relaxed text-foreground">{ev.text}</div>
          </>
        ) : null}

        {ev.type === "reasoning" ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex-none text-xs font-semibold text-muted-foreground">{ev.role}</span>
            </div>
            <div className="text-[13px] italic leading-relaxed text-muted-foreground">{ev.text}</div>
          </>
        ) : null}

        {ev.type === "tool" ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <WrenchIcon />
              <span className="flex-none text-xs font-semibold text-muted-foreground">
                {ev.toolRole}
              </span>
              {ev.cmd ? (
                <code className="min-w-0 truncate rounded-[5px] bg-secondary px-[7px] py-0.5 text-xs text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
                  {ev.cmd}
                </code>
              ) : null}
              {ev.result ? (
                <span className="ml-auto flex-none text-[11px] text-muted-foreground">
                  {ev.result}
                </span>
              ) : null}
              {ev.diffstat ? (
                <span className="ml-auto flex-none font-mono text-[11px]">
                  <span className="text-success">{ev.diffstat.add}</span>{" "}
                  <span className="text-danger">{ev.diffstat.del}</span>
                </span>
              ) : null}
            </div>
            {ev.detail ? (
              <details className="group">
                <summary className="cursor-pointer list-none text-[11px] text-muted-foreground marker:hidden">
                  <span className="text-muted-foreground/70 group-open:hidden">▸ </span>
                  <span className="hidden text-muted-foreground/70 group-open:inline">▾ </span>
                  {ev.detail.summary}
                </summary>
                <pre className="mt-1.5 overflow-x-auto rounded-md bg-terminal-bg px-3 py-2.5 font-mono text-xs leading-normal text-terminal-fg">
                  {ev.detail.body}
                </pre>
              </details>
            ) : null}
          </>
        ) : null}

        {ev.type === "answer" ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "grid size-[18px] flex-none place-items-center rounded-[5px] font-mono text-[9px] font-semibold text-background",
                  ev.agentAvatar ? "bg-success" : "bg-foreground",
                )}
              >
                {ev.avatar}
              </span>
              <span className="flex-none text-xs font-semibold text-foreground">{ev.role}</span>
              {ev.tokens ? (
                <span className="ml-auto flex-none font-mono text-[11px] text-muted-foreground">
                  {ev.tokens}
                </span>
              ) : null}
            </div>
            <div className="rounded-[8px] bg-success-soft px-3 py-2.5 text-[13px] leading-relaxed text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--success)_18%,transparent)]">
              {ev.answer}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

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
