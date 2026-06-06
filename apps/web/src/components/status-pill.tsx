/**
 * `StatusPill` — the shared console status chip (extracted from the temporary
 * styleguide route's inline copy; task 11.x of rebuild-console-tanstack-start).
 *
 * One pill, six variants mapped to the design-token soft surfaces + ink + ring
 * documented in `app.css`. The topbar action slot uses the green variant
 * ("Runner 池正常") by default; the dashboard / repositories / history pages
 * reuse the same component for their queue/task/audit status badges so the chip
 * styling lives in exactly one place.
 *
 * SSR-safe: pure, deterministic render — no window/clock/random access.
 *
 * Fidelity (prototype `.console-body .status-pill` family, the audit-refinement
 * overrides being the FINAL values): pill = soft tinted surface + matching ink +
 * a 1px inset ring; `dark` is the solid `#171717` pill with white text.
 */
import * as React from "react";

import { cn } from "@/utils";

/** The six prototype pill tones (neutral/blue/green/warn/danger/dark). */
export type StatusPillVariant =
  | "neutral"
  | "blue"
  | "green"
  | "warn"
  | "danger"
  | "dark";

/**
 * Per-variant surface/ink/ring classes. Each non-dark variant pairs a soft
 * design-token surface with its matching ink and a 30%-opacity inset ring; the
 * `dark` variant is the solid dark pill with white text and no visible ring.
 */
const PILL_CLASSES: Record<StatusPillVariant, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  blue: "bg-info-soft text-info ring-info/30",
  green: "bg-success-soft text-success ring-success/30",
  warn: "bg-warning-soft text-warning ring-warning/30",
  danger: "bg-danger-soft text-danger ring-danger/30",
  dark: "bg-dark-pill text-background ring-transparent",
};

export interface StatusPillProps extends React.ComponentProps<"span"> {
  /** Which tone to render. Defaults to `neutral` (the prototype's排队中 pill). */
  variant?: StatusPillVariant;
}

/**
 * A small inline status chip. Renders its children inside a rounded, tinted
 * pill keyed by `variant`. Forwards `className` (merged) and any other span
 * props so callers can add an icon/dot or layout tweaks.
 */
export function StatusPill({
  variant = "neutral",
  className,
  children,
  ...props
}: StatusPillProps) {
  return (
    <span
      data-slot="status-pill"
      data-variant={variant}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        PILL_CLASSES[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
