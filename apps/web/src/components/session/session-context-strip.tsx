/**
 * `SessionContextStrip` — the session context cards in the design revision's
 * 3+1 grouping (design `.context-strip` → `.context-top` + `.context-bottom`).
 *
 * The TOP row groups the three task-context cells (任务目标 / 运行环境 / 安全边界,
 * equal thirds on desktop, stacked on ≤820px); the GUARDRAIL readout (守护栏) is
 * the separated fourth cell, rendered full-width below a divider. Bound to query
 * data where available; descriptive copy is kept where the field is not
 * derivable from the contract, labeled honestly by its provenance in the page.
 *
 * SSR-safe: pure render off props; no window/clock/random.
 */
import * as React from "react";

import { cn } from "@/utils";

export interface SessionContextItem {
  /** Eyebrow label (任务目标 / 运行环境 / 安全边界 / 守护栏). */
  label: string;
  /** Bold one-line title. */
  title: string;
  /** Supporting paragraph copy. */
  body: string;
  /** The first card carries `.primary` emphasis in the prototype. */
  primary?: boolean;
}

export interface SessionContextStripProps {
  /** The three task-context cells of the top row (design `.context-top`). */
  items: readonly SessionContextItem[];
  /** The separated guardrail readout (design `.context-bottom`). */
  guardrail: SessionContextItem;
}

function ContextCell({
  item,
  className,
}: {
  item: SessionContextItem;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-[3px] px-4 py-3.5", className)}>
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
  );
}

export function SessionContextStrip({
  items,
  guardrail,
}: SessionContextStripProps): React.ReactElement {
  return (
    <section
      aria-label="会话上下文"
      className="mb-3 grid overflow-hidden rounded-lg bg-card shadow-card"
    >
      {/* context-top — the three task-context cells grouped together */}
      <div className="grid grid-cols-[minmax(0,1fr)] min-[821px]:grid-cols-3">
        {items.map((item, index) => (
          <ContextCell
            key={item.label}
            item={item}
            className={cn(
              index < items.length - 1 &&
                "border-b border-border min-[821px]:border-b-0 min-[821px]:border-r",
              // item.primary is an unstyled prototype marker — no per-item bg.
            )}
          />
        ))}
      </div>
      {/* context-bottom — the separated guardrail readout */}
      <ContextCell item={guardrail} className="border-t border-border" />
    </section>
  );
}
