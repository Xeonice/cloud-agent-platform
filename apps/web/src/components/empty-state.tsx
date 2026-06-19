/**
 * `EmptyState` — the shared console empty-state block (pixel-restore-console-to-od
 * Track 4). One centered stack — optional icon + title + body + optional action —
 * matching the prototype `.empty-state` (svg 28px muted-2, 14px semibold title,
 * 13px muted body capped ~300px, action with a small top gap). Used by the list
 * surfaces (history / repositories / transcript / api) so "无匹配/无数据" reads
 * the same everywhere.
 *
 * SSR-safe: pure, deterministic render.
 */
import * as React from "react";

import { cn } from "@/utils";

export interface EmptyStateProps
  extends Omit<React.ComponentProps<"div">, "title"> {
  /** Optional 24×24 SVG icon (rendered muted, ~28px). */
  icon?: React.ReactNode;
  /** Bold one-line headline. */
  title: React.ReactNode;
  /** Optional supporting line (muted, capped width). */
  description?: React.ReactNode;
  /** Optional action (e.g. a primary Button) shown below the copy. */
  action?: React.ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "grid justify-items-center gap-1.5 px-5 py-11 text-center",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="mb-0.5 text-muted-foreground [&>svg]:h-7 [&>svg]:w-7"
        >
          {icon}
        </span>
      ) : null}
      <strong className="text-sm font-semibold text-foreground">{title}</strong>
      {description ? (
        <p className="m-0 max-w-[300px] text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
