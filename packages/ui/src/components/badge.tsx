import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { TaskStatus } from "@cap/contracts";
import { cn } from "../lib/cn.js";

/**
 * shadcn/ui-style `<Badge>` used by the fleet dashboard and session page to
 * render a task's status. Exported from `@cap/ui` and consumed by `apps/web`.
 */
export const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
        // Status variants consume the SHARED v4 token contract (success/warning/
        // info + their soft surfaces) so the shared Badge stays color-matched
        // with apps/web's StatusPill instead of using hardcoded palette colors.
        success: "border-transparent bg-success-soft text-success",
        warning: "border-transparent bg-warning-soft text-warning",
        info: "border-transparent bg-info-soft text-info",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeVariant = NonNullable<
  VariantProps<typeof badgeVariants>["variant"]
>;

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

/**
 * Maps a contracts {@link TaskStatus} to a badge variant so the dashboard and
 * session page render status consistently. The status enum is the single
 * source of truth (`@cap/contracts`); this only chooses a visual variant.
 */
export function statusBadgeVariant(status: TaskStatus): BadgeVariant {
  switch (status) {
    case "running":
      return "default";
    case "awaiting_input":
      return "warning";
    case "pending":
      return "secondary";
    case "completed":
      return "success";
    case "failed":
    case "agent_failed_to_start":
      return "destructive";
    default:
      return "outline";
  }
}
