/**
 * `SegmentedControl` — the SHARED prototype `.segmented-control` /
 * `.filter-button` toggle group (rebuild-console-tanstack-start; Track 16).
 *
 * One generic, controlled, single-select segmented toggle reused by:
 *  - the dashboard 观察窗口 time-range switch (24h / 7d / 30d), and
 *  - the queue status filter (全部 / 等待输入 / 排队中);
 * later reused by the history page audit toolbar. The styling lives in exactly
 * one place so all three surfaces stay pixel-identical.
 *
 * SSR-safe: pure, controlled render — no window/clock/random access. Selection
 * is owned by the caller via `value` + `onValueChange` so the control never
 * holds its own latent state (and so the same render serves server + client).
 *
 * Accessibility: `role="group"` on the track, `aria-pressed` on each button
 * (the prototype's exact a11y contract). A `compact` variant maps to the
 * prototype's `.segmented-control.compact` (wraps + the queue-filter sizing).
 *
 * Fidelity (FINAL `.console-body` cascade values): track = inline-flex, 3px gap,
 * 3px padding, radius 8, surface `#f4f4f5`, 1px inset hairline ring. Buttons:
 * min-h 30, radius 6, transparent; hover → white; ACTIVE = solid ink (#171717) +
 * white text + a soft 1px drop shadow.
 */
import * as React from "react";

import { cn } from "@/utils";

/** A single segment: its stable value + the visible (verbatim) label. */
export interface SegmentedOption<T extends string> {
  /** The value emitted on selection (stable; not shown). */
  value: T;
  /** The visible label — kept verbatim from the prototype (full-width copy). */
  label: React.ReactNode;
}

export interface SegmentedControlProps<T extends string>
  extends Omit<React.ComponentProps<"div">, "onChange"> {
  /** The selectable segments, in display order. */
  options: readonly SegmentedOption<T>[];
  /** The currently-selected value (controlled). */
  value: T;
  /** Fired with the next value when a segment is pressed. */
  onValueChange: (value: T) => void;
  /** Accessible group label (e.g. "时间范围" / "任务状态"). */
  ariaLabel?: string;
  /** The prototype `.compact` variant (wraps + the queue-filter button sizing). */
  compact?: boolean;
}

/** A controlled single-select segmented toggle (the prototype filter-button group). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  compact = false,
  className,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="segmented-control"
      className={cn(
        "inline-flex w-fit gap-[3px] rounded-md bg-[#f4f4f5] p-[3px] shadow-[inset_0_0_0_1px_var(--border)]",
        compact && "flex-wrap",
        className,
      )}
      {...props}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-sm px-[11px] text-[13px] font-medium",
              "transition-colors",
              active
                ? "bg-foreground text-background shadow-[rgba(0,0,0,0.08)_0_1px_2px]"
                : "bg-transparent text-ink-soft hover:bg-background",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
