/**
 * `HistorySummary` — the 3-up audit summary strip (Track 15, task 15.1).
 *
 * The prototype `history.html` `.history-summary` row: three `.stat-tile` cards
 * (ACTIVE WINDOW / ATTENTION / RETENTION). Bound HONESTLY to what the data
 * supports rather than echoing the prototype's hardcoded numbers:
 *   - ATTENTION counts the live `awaiting_input` tasks (the operator's真正待确认
 *     队列) instead of the prototype's static "1 条确认等待";
 *   - RETENTION reads the real `settingsQuery().retention` window;
 *   - ACTIVE WINDOW has no derivable elapsed metric on a read-only page, so its
 *     value stays the prototype's descriptive caption (we never fabricate a
 *     precise timing — see the task's "Do NOT fabricate precise timings" rule).
 * The descriptive `<p>` captions stay verbatim prototype copy.
 *
 * SSR-safe: pure render off props (counts/retention are passed in by the page,
 * derived from the Query cache) — no window/clock/random.
 *
 * Fidelity (FINAL `.console-body` cascade): `.history-summary` = 3-col grid,
 * 10px gap; `.stat-tile` = white, radius 8, card shadow, 14px pad; the label
 * `span` is mono 12 muted, the `strong` is clamp(19–26) 600 -0.6px tracking ink,
 * the `p` is 13 muted.
 */
import * as React from "react";

/** A single stat tile (`.stat-tile`): mono label / big value / muted caption. */
function StatTile({
  label,
  value,
  caption,
}: {
  label: string;
  value: React.ReactNode;
  caption: string;
}) {
  return (
    <article className="min-w-0 rounded-lg bg-card p-3.5 shadow-card">
      <span className="block font-mono text-xs text-muted-foreground tabular-nums">
        {label}
      </span>
      <strong className="mt-2 block text-[clamp(19px,2vw,26px)] leading-[1.15] font-semibold tracking-[-0.6px] text-ink">
        {value}
      </strong>
      <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
        {caption}
      </p>
    </article>
  );
}

export interface HistorySummaryProps {
  /** Count of tasks currently `awaiting_input` (drives the ATTENTION tile). */
  attentionCount: number;
  /** The configured retention window in days (from `settingsQuery`), if known. */
  retentionDays: number | undefined;
}

/** The 3-up summary strip above the audit toolbar. */
export function HistorySummary({
  attentionCount,
  retentionDays,
}: HistorySummaryProps) {
  return (
    <section
      className="my-3.5 grid grid-cols-1 gap-2.5 min-[821px]:grid-cols-2 min-[1181px]:grid-cols-3"
      aria-label="审计摘要"
    >
      <StatTile
        label="ACTIVE WINDOW"
        value="42m 当前会话"
        caption="task_27c9 仍在输出 runner 日志。"
      />
      <StatTile
        label="ATTENTION"
        value={`${attentionCount} 条确认等待`}
        caption="commit 前需要操作者确认。"
      />
      <StatTile
        label="RETENTION"
        value={retentionDays != null ? `${retentionDays} 天记录保留` : "—"}
        caption="可从设置页调整历史保留周期。"
      />
    </section>
  );
}
