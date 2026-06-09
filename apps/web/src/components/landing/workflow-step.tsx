/**
 * `WorkflowStep` — one cell of the landing `#workflow` section's `.workflow-row`
 * (Track 12).
 *
 * Renders a single `<article>` of the prototype's 3-up operator-flow strip:
 * `<div class="eyebrow">01 连接</div><h3>title</h3><p>copy</p>`. The row
 * container (`WorkflowRow`) owns the hairline-separated 3-up grid; this step is
 * presentation only.
 *
 * The eyebrow is tinted per step via the `step` prop, matching the prototype's
 * `[data-step]` accent rules: develop → blue, preview → pink, ship → red.
 *
 * IMPORTANT fidelity note: the prototype defines NO `.workflow-step h3` /
 * `.workflow-step p` rule, so in the (non-Tailwind, non-reset) prototype the
 * `<h3>`/`<p>` render with browser UA defaults. Our Tailwind v4 build resets
 * headings/paragraphs, so we re-apply the UA-default metrics explicitly here:
 * h3 = 1.17em / bold / 1em block margins; p = 1em block margins / muted body.
 *
 * SSR-safe: pure render, no window/clock/random.
 *
 * Fidelity (`.workflow-step` base): white surface, padding 22, min-h 220 (the
 * `.workflow-row` supplies the 1px hairline grid + rounded clip).
 */
import * as React from "react";

import { cn } from "@/utils";

/** The three prototype steps, each keying an eyebrow accent color. */
export type WorkflowStepKind = "develop" | "preview" | "ship";

/** Per-step eyebrow accent (prototype `[data-step] .eyebrow` rules). */
const EYEBROW_ACCENT: Record<WorkflowStepKind, string> = {
  develop: "text-blue",
  preview: "text-pink",
  ship: "text-red",
};

export interface WorkflowStepProps {
  /** Which step (drives the eyebrow accent color). */
  step: WorkflowStepKind;
  /** Mono numbered eyebrow (e.g. "01 连接"). */
  eyebrow: React.ReactNode;
  /** The step title (e.g. "GitHub 授权登录"). */
  title: React.ReactNode;
  /** The supporting paragraph. */
  children: React.ReactNode;
}

/** A single operator-flow step. */
export function WorkflowStep({
  step,
  eyebrow,
  title,
  children,
}: WorkflowStepProps) {
  return (
    <article
      data-slot="workflow-step"
      data-step={step}
      className="min-h-[180px] bg-card p-[22px]"
    >
      <div
        className={cn(
          "font-mono text-xs font-semibold",
          EYEBROW_ACCENT[step],
        )}
      >
        {eyebrow}
      </div>
      <h3 className="my-[1em] text-[1.17em] font-bold text-foreground">
        {title}
      </h3>
      <p className="my-[1em] leading-normal text-foreground">{children}</p>
    </article>
  );
}

/** The hairline-separated 3-up row wrapping the workflow steps (`.workflow-row`). */
export function WorkflowRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md bg-line shadow-ring max-[820px]:grid-cols-1">
      {children}
    </div>
  );
}
