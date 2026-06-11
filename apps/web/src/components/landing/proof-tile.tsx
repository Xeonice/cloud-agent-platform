/**
 * `ProofTile` — one cell of the landing hero's `.hero-proof-grid` (Track 12).
 *
 * Renders a single `<article>` of the prototype's 3-up product-boundary strip:
 * `<span>EYEBROW</span><strong>title</strong><p>copy</p>`. The grid container
 * (`ProofGrid`) owns the `repeat(3, …)` layout + responsive collapse; this tile
 * is presentation only.
 *
 * SSR-safe: pure render, no window/clock/random.
 *
 * Fidelity (audit-refinement `.proof-tile` FINAL values, NON-console-body
 * cascade): white card, radius 8, `--admin-card` 1px-ring shadow, padding 14,
 * min-h 108. Label = mono 12px muted; title = 19→26px clamp / 600 ink, -0.6px
 * tracking, mt 8; copy = 13px/1.5 muted, mt 8.
 */
import * as React from "react";

export interface ProofTileProps {
  /** Mono uppercase label (e.g. "ACCESS"). */
  label: React.ReactNode;
  /** The bold title (e.g. "单用户白名单"). */
  title: React.ReactNode;
  /** The supporting paragraph. */
  children: React.ReactNode;
}

/** A single hero product-boundary tile. */
export function ProofTile({ label, title, children }: ProofTileProps) {
  return (
    <article
      data-slot="proof-tile"
      className="min-h-[108px] min-w-0 rounded-md bg-card p-3.5 shadow-card"
    >
      <span className="block font-mono text-xs text-muted-foreground">
        {label}
      </span>
      <strong className="mt-2 block text-[clamp(19px,2vw,26px)] leading-[1.15] font-semibold tracking-[-0.6px] text-foreground">
        {title}
      </strong>
      <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
        {children}
      </p>
    </article>
  );
}

/** The 3-up grid wrapping the proof tiles (`.hero-proof-grid`). */
export function ProofGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-label="产品边界"
      className="mt-6 grid grid-cols-3 gap-2.5 max-[1180px]:grid-cols-2 max-[821px]:grid-cols-1"
    >
      {children}
    </div>
  );
}
