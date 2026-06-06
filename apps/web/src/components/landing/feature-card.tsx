/**
 * `FeatureCard` — one cell of the landing `#security` section's `.feature-grid`
 * (Track 12).
 *
 * Renders a single `.feature-card.product-window` `<article>`:
 * `<h3>title</h3><p>copy</p>`. The grid container (`FeatureGrid`) owns the
 * `repeat(3, …)` layout; this card is presentation only.
 *
 * SSR-safe: pure render, no window/clock/random.
 *
 * Fidelity (`.feature-card` + `.product-window` base): white surface card,
 * radius 8, card-shadow 1px-ring, overflow hidden, padding 22. Title (the
 * `.feature-card h3` rule) = 22px / 600 ink, -0.76px tracking, line-height 1.2;
 * copy (`.feature-card p`) = muted, 1.55 line-height, mt 10.
 */
import * as React from "react";

export interface FeatureCardProps {
  /** The card title (e.g. "白名单登录"). */
  title: React.ReactNode;
  /** The supporting paragraph. */
  children: React.ReactNode;
}

/** A single security feature card. */
export function FeatureCard({ title, children }: FeatureCardProps) {
  return (
    <article
      data-slot="feature-card"
      className="overflow-hidden rounded-md bg-card p-[22px] shadow-card"
    >
      <h3 className="text-[22px] leading-[1.2] font-semibold tracking-[-0.76px] text-foreground">
        {title}
      </h3>
      <p className="mt-2.5 leading-[1.55] text-muted-foreground">{children}</p>
    </article>
  );
}

/** The 3-up grid wrapping the feature cards (`.feature-grid`). */
export function FeatureGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 max-[1180px]:grid-cols-2 max-[820px]:grid-cols-1">
      {children}
    </div>
  );
}
