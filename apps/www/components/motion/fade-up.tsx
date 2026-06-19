"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `<FadeUp>` — restrained fade-up-on-scroll motion for the marketing site
 * (`@cap/www`), gated behind `prefers-reduced-motion` (task 2.3, design.md D5).
 *
 * The element starts translated down and transparent, then animates to its
 * resting position the first time it scrolls into view (via Intersection
 * Observer). When the user prefers reduced motion — or before hydration, or in
 * environments without IntersectionObserver — the content renders in its final,
 * fully-visible state with no transition, so nothing is ever hidden by motion.
 *
 * Polymorphic via `as` so it can wrap any element (e.g. a list item, a card)
 * without introducing an extra DOM node.
 */
function usePrefersReducedMotion(): boolean {
  // Default to `true` so the very first render (and SSG output) is the
  // motion-free, fully-visible state; we relax it on the client only when the
  // user has NOT asked to reduce motion.
  const [reduced, setReduced] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

type FadeUpProps<T extends React.ElementType> = {
  as?: T;
  className?: string;
  /** Delay (ms) before this element animates once in view, for stagger. */
  delayMs?: number;
  /** Visible fraction required to trigger the reveal (0–1). */
  threshold?: number;
  children?: React.ReactNode;
} & Omit<
  React.ComponentPropsWithoutRef<T>,
  "as" | "className" | "children"
>;

export function FadeUp<T extends React.ElementType = "div">({
  as,
  className,
  delayMs = 0,
  threshold = 0.15,
  children,
  ...props
}: FadeUpProps<T>) {
  const Component = (as ?? "div") as React.ElementType;
  const prefersReducedMotion = usePrefersReducedMotion();
  const ref = React.useRef<HTMLElement | null>(null);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (prefersReducedMotion) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      // No observer available — reveal immediately rather than hide content.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [prefersReducedMotion, threshold]);

  // When reduced motion is preferred (or until hydration), render the resting,
  // fully-visible state with no transition classes at all.
  const animate = !prefersReducedMotion;

  return (
    <Component
      ref={ref}
      className={cn(
        animate &&
          "motion-safe:transition-[opacity,transform] motion-safe:duration-700 motion-safe:ease-out",
        animate && !visible && "motion-safe:translate-y-3 motion-safe:opacity-0",
        animate && visible && "motion-safe:translate-y-0 motion-safe:opacity-100",
        className,
      )}
      style={
        animate && delayMs ? { transitionDelay: `${delayMs}ms` } : undefined
      }
      {...props}
    >
      {children}
    </Component>
  );
}
