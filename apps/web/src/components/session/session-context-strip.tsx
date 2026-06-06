/**
 * `SessionContextStrip` — the 3-up session context cards
 * (prototype `.session-context-strip`, task 18.x).
 *
 * Three `.session-context-item` cards (the first `.primary`): 任务目标 / 运行环境
 * / 安全边界. Bound to query data where available; prototype DESCRIPTIVE copy is
 * kept VERBATIM where the field is not derivable from the contract (worktree/pty
 * detail), and labeled honestly as such by its provenance in the page.
 *
 * SSR-safe: pure render off props; no window/clock/random.
 */
import * as React from "react";

import { cn } from "@/utils";

export interface SessionContextItem {
  /** Eyebrow label (任务目标 / 运行环境 / 安全边界). */
  label: string;
  /** Bold one-line title. */
  title: string;
  /** Supporting paragraph copy. */
  body: string;
  /** The first card carries `.primary` emphasis in the prototype. */
  primary?: boolean;
}

export interface SessionContextStripProps {
  items: readonly SessionContextItem[];
}

export function SessionContextStrip({
  items,
}: SessionContextStripProps): React.ReactElement {
  return (
    <section
      aria-label="会话上下文"
      className="mb-2.5 grid overflow-hidden rounded-lg bg-card shadow-card grid-cols-[minmax(0,1fr)] min-[821px]:grid-cols-[minmax(280px,1.35fr)_minmax(230px,1fr)_minmax(230px,1fr)]"
    >
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "grid min-w-0 gap-[3px] px-3.5 py-[11px]",
            index < items.length - 1 &&
              "border-b border-border min-[821px]:border-b-0 min-[821px]:border-r",
            // item.primary is an unstyled prototype marker — no per-item bg.
          )}
        >
          <span className="font-mono text-[11px] font-medium text-muted-foreground">
            {item.label}
          </span>
          <strong className="min-w-0 truncate text-sm font-semibold text-foreground">
            {item.title}
          </strong>
          <p className="m-0 text-xs leading-[1.35] text-muted-foreground">
            {item.body}
          </p>
        </div>
      ))}
    </section>
  );
}
