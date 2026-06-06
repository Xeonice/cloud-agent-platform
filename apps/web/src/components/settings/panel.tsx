/**
 * `Panel` / `PanelHead` — the shared settings panel chrome (Track 14).
 *
 * Mirrors the prototype `.console-body .panel` + `.panel-head` FINAL cascade:
 * the panel is a white card (radius 6 / `rounded-md`, a 1px ring via
 * `shadow-ring`, 18px padding); the head is a `#fafafa` hairline strip that
 * bleeds to the panel edges (negative `-18px` margins), min-height 40, 10/18
 * padding, a bottom hairline, top-rounded corners — a `space-between` flex row
 * (title slot ⟷ trailing slot). The body content follows the head.
 *
 * Kept local to `settings/` so the account + form + Codex panels share exactly
 * one chrome implementation. SSR-safe: pure render.
 */
import * as React from "react";

import { cn } from "@/utils";

/** A white settings card (`.console-body .panel`). */
export function Panel({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-panel"
      className={cn(
        "min-w-0 rounded-md bg-card p-[18px] shadow-ring",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * The panel head hairline strip (`.console-body .panel-head`). Negative margins
 * bleed it to the card edges; the trailing slot (`right`) sits at the far end.
 */
export function PanelHead({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="m-[-18px_-18px_14px] flex min-h-10 items-center justify-between gap-3 rounded-t-md border-b border-border bg-[#f6f8fa] px-[18px] py-2.5">
      <div className="min-w-0">{children}</div>
      {right != null ? <div className="flex-none">{right}</div> : null}
    </div>
  );
}
