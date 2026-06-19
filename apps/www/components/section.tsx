import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `<Section>` — the vertical-rhythm primitive for the marketing site
 * (`@cap/www`).
 *
 * Renders a `<section>` landmark with consistent top/bottom spacing so the
 * landing page's stacked sections (Hero, Features, How-it-works, Security,
 * Self-host CTA) share one rhythm. The `id` doubles as an in-page anchor target
 * for the nav, and `scroll-mt-*` offsets the sticky header so anchored sections
 * are not hidden beneath it.
 */
export interface SectionProps
  extends React.HTMLAttributes<HTMLElement> {
  /** Anchor id used by in-page navigation links. */
  id?: string;
}

export const Section = React.forwardRef<HTMLElement, SectionProps>(
  function Section({ className, id, ...props }, ref) {
    return (
      <section
        ref={ref}
        id={id}
        className={cn(
          "scroll-mt-20 py-20 sm:py-24 lg:py-28",
          className,
        )}
        {...props}
      />
    );
  },
);
