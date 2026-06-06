/**
 * `ScreenCard` — one full-card entry of the `/workspace` launcher's
 * `.launcher-grid` (Track 13 fe-page-workspace-resume, task 13.4).
 *
 * The ENTIRE card is a TanStack `<Link>` (the prototype `<a class="screen-card">`)
 * routing into a console destination. It renders a `.pill` (one of three tones —
 * blue / default / dark), an `<h3>` title, a paragraph of copy, and a
 * `.surface-card-footer` with a live left-hand meta value + a right-hand action
 * verb. The footer meta (open-task count, latest run id, …) is passed in by the
 * page from query data; this card is otherwise presentation only.
 *
 * The link target is supplied as full `<Link>` props (`to` + optional `params`)
 * so the 实时会话 card can deep-link `/tasks/$taskId` with a REAL task id while
 * the other five cards link to static routes — all type-checked against the
 * route tree (no `any`).
 *
 * SSR-safe: pure render, no window/clock/random.
 *
 * Fidelity (`.screen-card` FINAL values, NON-console-body cascade): surface card,
 * radius `--radius`, `--card-shadow` 1px-ring (`shadow-card`), padding 22,
 * min-h 150 (audit-refinement), grid with `align-content: space-between`,
 * position relative + overflow hidden, the decorative `::after` corner is
 * globally `display:none`, hover lifts the ring (`shadow-ring` on hover). Title
 * (`.screen-card h3`) = 22px / 600 ink, -0.76px tracking, line-height 1.2; copy
 * (`.screen-card p`) = muted, 1.55 line-height, mt 10. The `.pill` inside a
 * screen-card is flattened to a bare mono 11px label (transparent bg, no ring):
 * muted by default, ink when `.dark`. The footer (`.surface-card-footer`) = mono
 * 12px muted, flex space-between, mt 18.
 */
import * as React from "react";
import { Link, type LinkProps } from "@tanstack/react-router";

import { cn } from "@/utils";

/** The flattened pill tone inside a screen-card (transparent — label only). */
export type ScreenCardPillTone = "blue" | "default" | "dark";

/** Per-tone label color (the audit-refinement `.screen-card .pill[.dark]` rule). */
const PILL_TONE_CLASS: Record<ScreenCardPillTone, string> = {
  // Base `.pill` color (#0068d6) survives — the screen-card override only resets
  // bg/box-shadow/padding/font, not the blue text.
  blue: "text-info",
  // Non-`.dark` screen-card pill = muted mono label.
  default: "text-muted-foreground",
  // `.screen-card .pill.dark` = ink label.
  dark: "text-ink",
};

export interface ScreenCardProps {
  /** The flattened pill label (e.g. "Command center"). */
  pill: React.ReactNode;
  /** Which flattened pill tone to render. */
  pillTone: ScreenCardPillTone;
  /** The card title (e.g. "任务控制台"). */
  title: React.ReactNode;
  /** The supporting paragraph copy. */
  children: React.ReactNode;
  /** The live left-hand footer meta (e.g. "3 open tasks"). */
  footerMeta: React.ReactNode;
  /** The right-hand action verb (e.g. "进入"). */
  footerAction: React.ReactNode;
  /** The TanStack route target. */
  to: LinkProps["to"];
  /** Optional route params (for the `/tasks/$taskId` deep link). */
  params?: LinkProps["params"];
}

/** A single full-card launcher entry. */
export function ScreenCard({
  pill,
  pillTone,
  title,
  children,
  footerMeta,
  footerAction,
  to,
  params,
}: ScreenCardProps) {
  return (
    <Link
      data-slot="screen-card"
      to={to}
      params={params}
      className="relative grid min-h-[150px] content-between overflow-hidden rounded-md bg-card p-[22px] shadow-card transition-shadow hover:shadow-ring"
    >
      <div>
        <span
          className={cn(
            "inline-flex w-fit font-mono text-[11px] font-medium",
            PILL_TONE_CLASS[pillTone],
          )}
        >
          {pill}
        </span>
        <h3 className="mt-3 text-[22px] leading-[1.2] font-semibold tracking-[-0.76px] text-ink">
          {title}
        </h3>
        <p className="mt-2.5 leading-[1.55] text-muted-foreground">
          {children}
        </p>
      </div>
      <span className="mt-[18px] flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-muted-foreground">
        <span>{footerMeta}</span>
        <span>{footerAction}</span>
      </span>
    </Link>
  );
}

/** The 3-up grid wrapping the screen cards (`.launcher-grid`). */
export function LauncherGrid({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="工作区入口"
      className="grid grid-cols-3 gap-2.5 max-[1180px]:grid-cols-2 max-[820px]:grid-cols-1"
    >
      {children}
    </section>
  );
}
