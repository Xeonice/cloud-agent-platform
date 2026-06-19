"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `<Spotlight>` — a Vercel-style cursor-follow hover glow for cards.
 *
 * On pointer move it writes the local cursor position to the `--mx`/`--my` CSS
 * vars; the paired `.spotlight-bg` layer (see `globals.css`) paints a soft
 * monochrome radial at that point, fading in on hover/focus. The glow layer is
 * rendered as a `-z-10` child inside an `isolate` stacking context, so it sits
 * above the card's own surface but beneath its content — text stays crisp.
 *
 * It is purely additive: with no pointer (touch, keyboard, reduced motion) the
 * card simply shows no glow. The fade respects `prefers-reduced-motion` via the
 * global rule; the pointer tracking is not itself an animation.
 */
export interface SpotlightProps
  extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function Spotlight({
  className,
  children,
  ...props
}: SpotlightProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      node.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      node.style.setProperty("--my", `${event.clientY - rect.top}px`);
    },
    [],
  );

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      className={cn(
        "spotlight-card relative isolate overflow-hidden",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="spotlight-bg pointer-events-none absolute inset-0 -z-10"
      />
      {children}
    </div>
  );
}

export default Spotlight;
