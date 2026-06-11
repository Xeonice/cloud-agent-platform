/**
 * `StatTile` — one cell of the `/workspace` launcher's `.ops-strip` operating
 * snapshot (Track 13 fe-page-workspace-resume, task 13.3).
 *
 * Renders a single `.stat-tile` `<article>`:
 * `<span>LABEL</span><strong>value</strong><p>caption</p>`. The container
 * (`OpsStrip`) owns the `repeat(3, …)` grid + responsive collapse; this tile is
 * presentation only — the LIVE value/caption are passed in by the page (derived
 * from `metricsQuery` / `reposQuery`), never hardcoded here.
 *
 * SSR-safe: pure render, no window/clock/random.
 *
 * Fidelity (`.stat-tile` FINAL values, NON-console-body cascade — the same rule
 * the landing `.proof-tile` resolves through): white card, radius 8,
 * `--admin-card` 1px-ring shadow (`shadow-card`), padding 14, min-w 0. Label =
 * mono 12px muted tabular-nums; value (`strong`) = 19→26px clamp / 600 ink,
 * -0.6px tracking, line-height 1.15, mt 8; caption (`p`) = 13px/1.5 muted, mt 8.
 */
import * as React from "react";

export interface StatTileProps {
  /** Mono uppercase label (e.g. "RUNNERS"). */
  label: React.ReactNode;
  /** The bold live value (e.g. "7 / 10 已占用"). */
  value: React.ReactNode;
  /** The supporting caption line. */
  children: React.ReactNode;
}

/** A single launcher operating-snapshot tile. */
export function StatTile({ label, value, children }: StatTileProps) {
  return (
    <article
      data-slot="stat-tile"
      className="min-w-0 rounded-md bg-card p-3.5 shadow-card"
    >
      <span className="block font-mono text-xs text-muted-foreground tabular-nums">
        {label}
      </span>
      <strong className="mt-2 block text-[clamp(19px,2vw,26px)] leading-[1.15] font-semibold tracking-[-0.6px] text-foreground">
        {value}
      </strong>
      <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
        {children}
      </p>
    </article>
  );
}

/** The 3-up grid wrapping the operating-snapshot tiles (`.ops-strip`). */
export function OpsStrip({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="当前运行状态"
      className="my-3.5 grid grid-cols-3 gap-2.5 max-[1180px]:grid-cols-2 max-[821px]:grid-cols-1"
    >
      {children}
    </section>
  );
}
