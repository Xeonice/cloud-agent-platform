/**
 * `HeroPreview` — the landing hero's right-column control-console preview
 * (`.hero-preview`, Track 12).
 *
 * A fully STATIC mock of the running console: a window bar, a light topology
 * pane (a 3-row task mini-list + a 2-up runner/control stat pair), and a dark
 * terminal pane streaming 6 literal log lines. Everything is hard literal text
 * from the prototype — there is NO live data, clock, or random here, so the
 * server renders the exact same markup the client hydrates (SSR-safe).
 *
 * Status chips reuse the shared `StatusPill` (green 执行中 / warn 等待输入 /
 * neutral 排队中). The terminal severities map to the project terminal scope
 * tokens (`text-terminal-ok` / `-warn` / `-muted` / `-fg`).
 *
 * Fidelity (audit-refinement NON-console-body cascade FINAL values):
 *   .hero-preview = grid gap 1px, radius 12, bg line (the 1px hairlines), large
 *     ambient shadow.
 *   .window-bar = flex between, min-h 38, px 12, bg #fafafa, ring, muted mono
 *     12px; .traffic dots 10px red/warn/green.
 *   .preview-topology = grid `1fr 220px` (1-col ≤1180px), gap 1px, bg line.
 *   .preview-pane = white, padding 16; .preview-pane.dark = #050505 / #e8e8e8.
 *   .preview-mini-row = grid `auto 1fr auto`, gap 8, min-h 34, px 10, radius 7,
 *     bg #fafafa, ring, ink-soft 12px; .dot 8px green glow / .dot.warn warn glow.
 *   .stat-tile = white, radius 8, admin-card shadow, padding 14 (label mono 12
 *     muted / value 19→26 clamp 600 ink / copy 13 muted).
 *   .preview-terminal-body = min-h 245, padding 0, mono 13px / line-height 1.6,
 *     pre-wrap; .terminal-line.dim/.ok/.warn tints.
 */
import { StatusPill, type StatusPillVariant } from "@/components/status-pill";
import { cn } from "@/utils";

/** One task mini-row in the light topology pane. */
interface MiniRow {
  /** Whether the leading status dot is the warn tone. */
  warn?: boolean;
  /** The task label (mono task id + title). */
  label: string;
  /** The trailing status pill text + tone. */
  status: { label: string; variant: StatusPillVariant };
}

const MINI_ROWS: readonly MiniRow[] = [
  {
    label: "task_27c9 · 重构调度租约",
    status: { label: "执行中", variant: "green" },
  },
  {
    warn: true,
    label: "task_24ab · OAuth 边界审查",
    status: { label: "等待输入", variant: "warn" },
  },
  {
    label: "api-gateway · 审计事件",
    status: { label: "排队中", variant: "neutral" },
  },
];

/** One stat tile in the light pane's stat pair. */
interface StatTile {
  label: string;
  value: string;
  copy: string;
}

const STAT_TILES: readonly StatTile[] = [
  { label: "RUNNERS", value: "7 / 10", copy: "3 个槽位可接入。" },
  {
    label: "CONTROL",
    value: "实时通道",
    copy: "输出、暂停和输入命令都归属到 task。",
  },
];

/** One terminal log line; `tone` selects the prototype `.terminal-line` tint. */
interface TermLine {
  tone: "dim" | "ok" | "warn" | "default";
  text: string;
}

const TERMINAL_LINES: readonly TermLine[] = [
  {
    tone: "dim",
    text: "$ agentctl task create --repo tanghehui/agent-orchestrator --branch main",
  },
  { tone: "ok", text: "[github] 已验证 @tanghehui 的登录身份" },
  { tone: "ok", text: "[agent] 已租用 iad-02 runner · 2 vCPU / 4GB" },
  { tone: "default", text: "[agent] 正在读取 AGENTS.md 与仓库目录" },
  { tone: "warn", text: "[operator] 写入前可随时暂停输出并确认" },
  { tone: "ok", text: "[ready] 输入命令即可操控远端 Agent" },
];

const TERM_TONE: Record<TermLine["tone"], string> = {
  dim: "text-terminal-muted",
  ok: "text-terminal-ok",
  warn: "text-terminal-warn",
  default: "text-terminal-fg",
};

/** The static control-console hero preview. */
export function HeroPreview() {
  return (
    <div
      data-slot="hero-preview"
      aria-label="控制台预览"
      className="grid gap-px overflow-hidden rounded-xl bg-line shadow-[rgba(0,0,0,0.08)_0_0_0_1px,rgba(0,0,0,0.12)_0_28px_80px_-48px]"
    >
      {/* Window bar */}
      <div className="flex min-h-[38px] items-center justify-between bg-[#fafafa] px-3 font-mono text-xs text-muted-foreground shadow-ring">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-red" />
          <span className="size-2.5 rounded-full bg-warning" />
          <span className="size-2.5 rounded-full bg-success" />
        </div>
        <span>agent-control · iad-02</span>
      </div>

      {/* Topology: light topology pane + dark terminal pane */}
      <div className="grid gap-px bg-line min-[1181px]:grid-cols-[minmax(0,1fr)_220px]">
        {/* Light pane */}
        <div className="min-w-0 bg-card p-4">
          {/* Task mini-list */}
          <div className="grid gap-2">
            {MINI_ROWS.map((row) => (
              <div
                key={row.label}
                className="grid min-h-[34px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-[#fafafa] px-2.5 text-xs text-ink-soft shadow-ring"
              >
                <span
                  className={cn(
                    "size-2 rounded-full",
                    row.warn
                      ? "bg-warning shadow-[0_0_0_4px_color-mix(in_oklch,var(--warning)_18%,transparent)]"
                      : "bg-success shadow-[0_0_0_4px_color-mix(in_oklch,var(--success)_16%,transparent)]",
                  )}
                />
                <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-foreground">
                  {row.label}
                </strong>
                <StatusPill variant={row.status.variant}>
                  {row.status.label}
                </StatusPill>
              </div>
            ))}
          </div>

          {/* Stat pair */}
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {STAT_TILES.map((tile) => (
              <article
                key={tile.label}
                className="min-w-0 rounded-md bg-card p-3.5 shadow-card"
              >
                <span className="block font-mono text-xs text-muted-foreground">
                  {tile.label}
                </span>
                <strong className="mt-2 block text-[clamp(19px,2vw,26px)] leading-[1.15] font-semibold tracking-[-0.6px] text-foreground">
                  {tile.value}
                </strong>
                <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
                  {tile.copy}
                </p>
              </article>
            ))}
          </div>
        </div>

        {/* Dark terminal pane */}
        <div className="min-w-0 bg-terminal-bg p-4 text-terminal-fg">
          <div className="min-h-[245px] font-mono text-[13px] leading-[1.6] whitespace-pre-wrap">
            {TERMINAL_LINES.map((line) => (
              <span
                key={line.text}
                className={cn("block", TERM_TONE[line.tone])}
              >
                {line.text}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
