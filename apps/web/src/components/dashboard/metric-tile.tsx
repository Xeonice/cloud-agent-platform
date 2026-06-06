/**
 * `MetricTile` — one cell of the dashboard `.ops-status-bar` (Track 16, task 16.2).
 *
 * Renders a single `<article>` of the prototype's 4-up metric strip:
 * `<span>label</span><strong>value</strong><small>caption</small>` laid out in the
 * prototype's "label / value spanning / copy" grid (label top-left, big mono value
 * spanning both rows on the right, caption bottom-left). The strip container
 * (`MetricStrip`) owns the white rounded card + the per-cell right hairlines.
 *
 * SSR-safe: pure render. Values are passed in by the page from `metricsQuery`
 * (never hardcoded) — `MetricTile` is presentation only.
 *
 * Fidelity (audit-refinement `.ops-status-bar` FINAL values): strip = white,
 * radius 10, card shadow, overflow hidden, `repeat(4, minmax(0,1fr))`. Each
 * article: 13px/16px padding, right 1px border (last cell none), label = mono
 * 11px/500 muted, value = mono 24px/600 ink, caption = muted 12px.
 */
import * as React from "react";

import { cn } from "@/utils";

export interface MetricTileProps {
  /** Top-left label (verbatim prototype copy, e.g. "活跃任务"). */
  label: React.ReactNode;
  /** The big mono value spanning both rows (e.g. the live active-task count). */
  value: React.ReactNode;
  /** Bottom-left caption (e.g. "10 个总槽位"). */
  caption: React.ReactNode;
}

/** A single ops-status-bar metric cell. */
export function MetricTile({ label, value, caption }: MetricTileProps) {
  return (
    <article
      data-slot="metric-tile"
      className={cn(
        "grid min-w-0 gap-x-3 gap-y-0.5 px-4 py-[13px]",
        "[grid-template-areas:'label_value''copy_value'] grid-cols-[minmax(0,1fr)_auto]",
        // 4-up at ≥1101px (right hairline, last cell none); 2-up below, where the
        // first two cells carry a bottom hairline + the 2nd drops its right rule.
        "border-border",
        "max-[1100px]:[&:nth-child(-n+2)]:border-b max-[1100px]:[&:nth-child(odd)]:border-r",
        "min-[1101px]:border-r min-[1101px]:last:border-r-0",
      )}
    >
      <span className="[grid-area:label] font-mono text-[11px] font-medium text-muted-foreground">{label}</span>
      <strong className="[grid-area:value] self-center font-mono text-2xl font-semibold text-foreground">
        {value}
      </strong>
      <small className="[grid-area:copy] text-xs text-muted-foreground">{caption}</small>
    </article>
  );
}

/** The white rounded card wrapping the 4 metric tiles (the `.ops-status-bar`). */
export function MetricStrip({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="任务指标"
      className="mb-3 grid grid-cols-2 overflow-hidden rounded-lg bg-card shadow-card min-[1101px]:grid-cols-4"
    >
      {children}
    </section>
  );
}
