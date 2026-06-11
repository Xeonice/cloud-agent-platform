/**
 * `ProcessRail` / `WorkflowStep` — the landing `#workflow` operator-flow rail
 * (console-design-pixel-merge Track 5, task 5.3).
 *
 * Replaces the former 3-up hairline `WorkflowRow` strip with the design
 * revision's `process-rail`: a vertical rail (1px line behind the index discs)
 * carrying four numbered `workflow-step` entries, each a 38px disc column plus
 * a body (title / copy / mono meta pills). The design marks one step
 * `is-current` (dark disc) — exposed here as the `current` prop.
 *
 * SSR-safe: pure render, no window/clock/random.
 *
 * Fidelity (design index.html `.process-rail` / `.workflow-step`):
 *   rail = relative grid, mt 30, ::before 1px line at left 18px inset 18px.
 *   step = grid `38px minmax(0,1fr)`, gap 14, pb 24 (last 0).
 *   step-index = 36px circle, card bg + ring, muted mono 12px/500 tabular;
 *     is-current → foreground bg / card ink.
 *   step-body h3 = 18px/600, -0.32px; p = max-w 560, mt 7, muted 14px/1.55.
 *   step-meta = flex wrap gap 6 mt 12; pills = subtle bg, muted mono 11px,
 *     4px 8px, rounded-full.
 */
import * as React from "react";

import { cn } from "@/utils";

export interface WorkflowStepProps {
  /** Zero-padded mono rail index (e.g. "01"). */
  index: string;
  /** The step title (e.g. "GitHub 身份进入控制台"). */
  title: React.ReactNode;
  /** The design's `is-current` step (dark index disc). */
  current?: boolean;
  /** Mono meta pills under the copy (e.g. ["OAuth", "Allowlist"]). */
  meta?: readonly string[];
  /** The supporting paragraph. */
  children: React.ReactNode;
}

/** A single operator-flow step on the rail. */
export function WorkflowStep({
  index,
  title,
  current = false,
  meta,
  children,
}: WorkflowStepProps) {
  return (
    <article
      data-slot="workflow-step"
      data-current={current || undefined}
      className="relative grid min-w-0 grid-cols-[38px_minmax(0,1fr)] gap-3.5 pb-6 last:pb-0"
    >
      <span
        className={cn(
          "relative z-[1] grid size-9 place-items-center rounded-full font-mono text-xs font-medium tabular-nums shadow-ring",
          current ? "bg-foreground text-card" : "bg-card text-muted-foreground",
        )}
      >
        {index}
      </span>
      <div className="min-w-0 pt-0.5">
        <h3 className="text-lg font-semibold tracking-[-0.32px] text-foreground">
          {title}
        </h3>
        <p className="mt-[7px] max-w-[560px] text-sm leading-[1.55] text-muted-foreground">
          {children}
        </p>
        {meta && meta.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {meta.map((item) => (
              <span
                key={item}
                className="rounded-full bg-[#fafafa] px-2 py-1 font-mono text-[11px] text-muted-foreground"
              >
                {item}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** The vertical rail wrapping the workflow steps (`.process-rail`). */
export function ProcessRail({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-label="操作者流程"
      className="relative mt-[30px] grid before:absolute before:top-[18px] before:bottom-[18px] before:left-[18px] before:w-px before:bg-line before:content-['']"
    >
      {children}
    </div>
  );
}
