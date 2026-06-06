/**
 * `CountChip` — the SHARED prototype `.count-chip` (rebuild-console-tanstack-start;
 * Track 16). A small mono pill that reports a live visible count next to a filter
 * group (the queue's "N 个任务", later the history toolbar). Styling lives in one
 * place so every count chip across the console matches.
 *
 * SSR-safe: pure render; the count is passed in by the caller (derived from query
 * data + client view state), never read off `window`.
 *
 * Fidelity: the queue uses the `.queue-filter-actions .count-chip` FINAL override
 * (min-h 30, transparent, NO ring); the base `.count-chip` is the ringed white
 * pill. The `bare` prop selects the queue-filter (transparent, ringless) variant.
 */
import * as React from "react";

import { cn } from "@/utils";

export interface CountChipProps extends React.ComponentProps<"span"> {
  /**
   * The queue-filter variant: transparent + ringless (the
   * `.queue-filter-actions .count-chip` FINAL override). Defaults to the base
   * white-ringed pill.
   */
  bare?: boolean;
}

/** A small mono count pill (the prototype `.count-chip`). */
export function CountChip({ bare = false, className, children, ...props }: CountChipProps) {
  return (
    <span
      data-slot="count-chip"
      className={cn(
        "inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-full px-[9px]",
        "font-mono text-xs text-muted-foreground",
        bare
          ? "bg-transparent"
          : "bg-background shadow-[inset_0_0_0_1px_var(--border)]",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
