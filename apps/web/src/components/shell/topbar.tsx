/**
 * `Topbar` — the console main-area header (task 11.x).
 *
 * Renders the prototype `.topbar`: a sticky bar that spans the full main width
 * (via negative horizontal margins matching the `SidebarInset` padding) with a
 * bottom hairline. LEFT is the mono eyebrow ("tanghehui / agent-control",
 * hidden ≤820px); RIGHT is an action slot that defaults to the green
 * "Runner 池正常" `StatusPill`.
 *
 * Both the eyebrow and the actions are overridable props so later pages can
 * supply their own (e.g. a page-specific breadcrumb / toolbar) while keeping the
 * shell's default chrome when they don't.
 *
 * SSR-safe: pure render, no client-only access.
 *
 * Fidelity (audit-refinement `.console-body .topbar` FINAL values): min-h 54px,
 * white@78% + blur, bottom 1px shadow hairline, margin
 * `-18px calc(clamp(18px,3vw,40px) * -1) 18px`, padding `0 clamp(18px,3vw,40px)`.
 */
import * as React from "react";

import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";

export interface TopbarProps {
  /** The mono eyebrow text on the left. Defaults to the host/repo identity. */
  eyebrow?: React.ReactNode;
  /** The right-hand action slot. Defaults to the green Runner-pool status pill. */
  actions?: React.ReactNode;
}

export function Topbar({
  eyebrow = "tanghehui / agent-control",
  actions = <StatusPill variant="green">Runner 池正常</StatusPill>,
}: TopbarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-10 flex min-h-[54px] items-center justify-between",
        "-mx-[clamp(18px,3vw,40px)] -mt-[18px] mb-[18px] px-[clamp(18px,3vw,40px)]",
        "bg-[rgba(255,255,255,0.78)] backdrop-blur-md",
        "shadow-[0_1px_0_0_rgba(0,0,0,0.08)]",
        "max-[820px]:-mx-[14px] max-[820px]:px-[14px]",
      )}
    >
      <div className="font-mono text-xs text-muted-foreground max-[820px]:hidden">
        {eyebrow}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </header>
  );
}
