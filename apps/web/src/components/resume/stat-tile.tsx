/**
 * `StatTile` — one card in the `/resume` Handoff "当前操作" stack (Track 13.3).
 *
 * Faithful to the prototype `agent-control-launcher.html` `.stat-tile`. Because
 * that page has NO `<body class="console-body">`, the FINAL cascade is the base
 * `assets/styles.css` `.stat-tile` rule (no console-body override applies):
 *   tile  → padding 14px, radius 8px, white surface, `--admin-card` shadow.
 *   <span> (label)  → block, mono 12px, muted, tabular-nums.
 *   <strong> (value) → block, mt 8px, ink, clamp(19px,2vw,26px), 600, -0.6px, 1.15.
 *   <p> (caption)    → mt 8px, muted, 13px, line-height 1.5.
 *
 * Local to the `/resume` folder (not shared) so it never collides with the
 * parallel `/workspace` agent's own tiles. Pure presentational + SSR-safe: it
 * only renders the props it is handed (no window/clock/random).
 */
import type * as React from "react";

export interface StatTileProps {
  /** The mono uppercase label (e.g. "NEXT ACTION"). */
  label: string;
  /** The primary value line. */
  value: string;
  /** The supporting caption. */
  children: React.ReactNode;
}

export function StatTile({ label, value, children }: StatTileProps) {
  return (
    <article className="min-w-0 rounded-md bg-card p-3.5 shadow-card">
      <span className="block font-mono text-xs tabular-nums text-muted-foreground">
        {label}
      </span>
      <strong className="mt-2 block text-[clamp(19px,2vw,26px)] leading-[1.15] font-semibold tracking-[-0.6px] text-ink">
        {value}
      </strong>
      <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
        {children}
      </p>
    </article>
  );
}
