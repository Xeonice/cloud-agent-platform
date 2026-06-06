/**
 * `InstallStep` — one numbered row in the login page's "进入控制台前会确认" flow
 * (Track 12 fe-page-landing-login; prototype `login.html` `.auth-flow` →
 * `.install-step`).
 *
 * A 2-column grid: a circular monospace step index + a title/description block.
 * The `active` step paints the index chip with the accent-tinted fill, swaps the
 * row surface to white, and lifts it onto the card shadow (the prototype's
 * `.install-step.active` cascade); inactive rows sit on the `#fafafa` panel fill
 * with the inset ring.
 *
 * Stateless + deterministic — pure render, no window/clock/random; safe for SSR.
 *
 * Fidelity (prototype base `.install-step` / `.step-index`, no `.console-body`
 * override applies on `login.html`):
 *   row    = grid 38px+1fr, gap 12, p 12, rounded-md(8); inactive `#fafafa` +
 *            inset ring (shadow-ring); active = white surface + shadow-card.
 *   index  = 30x30 circle, mono 11px/600; inactive `#f0f1f3` muted; active fills
 *            `color-mix(accent 16%, white)` with ink text — and the prototype's
 *            `--accent` is the GREEN `oklch(58% 0.16 145)` (NOT the blue accent
 *            surface the project token `--accent`=#ebf5ff carries), so the fill
 *            is reproduced from that literal oklch to stay faithful.
 *   strong = block ink; p = block muted 13px / line-height 1.5, margin-top 5px.
 */
import * as React from "react";

import { cn } from "@/utils";

export interface InstallStepProps {
  /** Two-digit step index shown in the leading chip (e.g. "01"). */
  index: string;
  /** The step title (full-width Chinese copy, verbatim). */
  title: string;
  /**
   * The step description body. A `ReactNode` so callers can embed the inline
   * `.mono` account span (step 01's `github.com/tanghehui`).
   */
  children: React.ReactNode;
  /** Whether this is the current step — paints the active surface + chip fill. */
  active?: boolean;
}

/**
 * Render a single numbered onboarding step. The active row mirrors the
 * prototype's `.install-step.active` treatment (white surface, lifted shadow,
 * accent-tinted index chip).
 */
export function InstallStep({ index, title, children, active = false }: InstallStepProps) {
  return (
    <div
      data-slot="install-step"
      data-active={active || undefined}
      className={cn(
        "grid grid-cols-[38px_minmax(0,1fr)] gap-3 rounded-md p-3",
        active ? "bg-background shadow-card" : "bg-[#fafafa] shadow-ring",
      )}
    >
      <span
        className={cn(
          "grid size-[30px] place-items-center rounded-full font-mono text-[11px] font-semibold tabular-nums",
          active
            ? "bg-[color-mix(in_oklch,oklch(58%_0.16_145)_16%,white)] text-ink"
            : "bg-[#f0f1f3] text-muted-foreground",
        )}
      >
        {index}
      </span>
      <div className="min-w-0">
        <strong className="block text-foreground">{title}</strong>
        <p className="mt-[5px] block text-[13px] leading-[1.5] text-muted-foreground">
          {children}
        </p>
      </div>
    </div>
  );
}
