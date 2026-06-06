/**
 * `RepoStatStrip` / `RepoStatTile` — the `/repositories` control summary strip
 * (Track 14, fe-page-repositories-settings; task 14.1).
 *
 * The 4-up `.repo-control-strip` of stat-tiles above the imported-repos panel:
 * DEFAULT / PERMISSION / SYNC / POLICY. Each tile is the prototype's white
 * radius-8 card-shadow `.stat-tile` with a mono label, a big ink value, and a
 * muted caption. The container is a 4-column grid at desktop (2-up below), the
 * same responsive behavior as the landing/dashboard stat strips.
 *
 * SSR-safe: pure render — every value is passed in by the page (the DEFAULT
 * tile's repo name comes from `reposQuery`, NEVER hardcoded). Presentation only.
 *
 * Fidelity (`.repo-control-strip` + `.stat-tile` FINAL values): strip =
 * `repeat(4, minmax(0,1fr))`, gap 10, mb 12; tile = white, radius 8, padding 14,
 * card shadow; label = mono 12px tabular muted; value = 19–26px/600 ink,
 * mt 8, tracking -0.6px; caption = 13px/1.5 muted, mt 8.
 */
import * as React from "react";

import { cn } from "@/utils";

export interface RepoStatTileProps {
  /** Mono uppercase label (e.g. "DEFAULT"). */
  label: React.ReactNode;
  /** The big ink value (e.g. the default repo name — from query data). */
  value: React.ReactNode;
  /** Muted caption beneath the value. */
  caption: React.ReactNode;
}

/** A single `.stat-tile` of the control strip. */
export function RepoStatTile({ label, value, caption }: RepoStatTileProps) {
  return (
    <article
      data-slot="repo-stat-tile"
      className="min-w-0 rounded-lg bg-card p-3.5 shadow-card"
    >
      <span className="block font-mono text-xs tabular-nums text-muted-foreground">
        {label}
      </span>
      <strong className="mt-2 block truncate text-[clamp(19px,2vw,26px)] leading-[1.15] font-semibold tracking-[-0.6px] text-ink">
        {value}
      </strong>
      <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
        {caption}
      </p>
    </article>
  );
}

/** The 4-up control-summary strip container (`.repo-control-strip`). */
export function RepoStatStrip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label="仓库控制摘要"
      className={cn(
        "mb-3 grid grid-cols-2 gap-2.5 min-[1101px]:grid-cols-4",
        className,
      )}
    >
      {children}
    </section>
  );
}
