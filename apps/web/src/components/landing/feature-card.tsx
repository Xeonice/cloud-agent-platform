/**
 * `BoundaryLedger` / `LedgerRow` — the landing `#security` control-boundary
 * ledger (console-design-pixel-merge Track 5, task 5.3).
 *
 * Replaces the former 3-card `FeatureGrid` with the design revision's
 * `boundary-ledger`: a card aside with a header band (eyebrow / title /
 * action) over a hairline-separated row list. Each row pairs a mono uppercase
 * key (Access/Scope/Runtime/…) with a value (bold title + muted copy) and a
 * trailing mono state pill; `tone` maps the design's `is-active` (info tint)
 * and `is-critical` (danger tint) row states.
 *
 * The aside carries the page `#security` anchor (passed via `id`), so the nav
 * and footer 安全模型 links keep resolving here after the section replacement;
 * `scroll-mt-20` clears the fixed 64px landing nav.
 *
 * SSR-safe: pure render, no window/clock/random.
 *
 * Fidelity (design index.html `.boundary-ledger`):
 *   aside = card bg, radius 6, ring shadow, padding 0.
 *   header = flex between, padding clamp(22,3vw,32), hairline bottom;
 *     h3 = clamp(24,2.6vw,32)/600, lh 1.15, -1.28px.
 *   row = grid `112px minmax(0,1fr) auto`, gap 14, min-h 78,
 *     17px clamp(22,3vw,32) padding, hairline bottom (last none);
 *     ≤1180px → `96px 1fr` with the state pill dropping under the value;
 *     ≤640px → single column, 18px side padding.
 *   key = muted mono 11px/1.4 uppercase; value strong = 15px/600 -0.2px;
 *   value copy = mt 5, muted 13px/1.5; state pill = subtle bg mono 11px,
 *     active → info-soft/info, critical → danger-soft/danger.
 */
import * as React from "react";

import { cn } from "@/utils";

/** Row accent: design `is-active` (info) / `is-critical` (danger). */
export type LedgerRowTone = "default" | "active" | "critical";

/** State-pill tint per row tone (`.ledger-state` rules). */
const STATE_TONE: Record<LedgerRowTone, string> = {
  default: "bg-[#fafafa] text-muted-foreground",
  active: "bg-info-soft text-info",
  critical: "bg-danger-soft text-danger",
};

export interface LedgerRowProps {
  /** Mono uppercase boundary key (e.g. "Access"). */
  ledgerKey: React.ReactNode;
  /** The bold boundary title (e.g. "白名单 GitHub 身份"). */
  title: React.ReactNode;
  /** The trailing mono state pill text (e.g. "required"). */
  state: React.ReactNode;
  /** Row accent tone. */
  tone?: LedgerRowTone;
  /** The supporting copy line. */
  children: React.ReactNode;
}

/** A single control-boundary ledger row. */
export function LedgerRow({
  ledgerKey,
  title,
  state,
  tone = "default",
  children,
}: LedgerRowProps) {
  return (
    <div
      data-slot="ledger-row"
      className="grid min-h-[78px] grid-cols-[112px_minmax(0,1fr)_auto] items-start gap-3.5 border-b border-line px-[clamp(22px,3vw,32px)] py-[17px] last:border-b-0 max-[1180px]:grid-cols-[96px_minmax(0,1fr)] max-[640px]:grid-cols-[minmax(0,1fr)] max-[640px]:px-[18px]"
    >
      <div className="font-mono text-[11px] leading-[1.4] text-muted-foreground uppercase">
        {ledgerKey}
      </div>
      <div className="min-w-0">
        <strong className="block text-[15px] font-semibold tracking-[-0.2px] text-foreground">
          {title}
        </strong>
        <span className="mt-[5px] block text-[13px] leading-[1.5] text-muted-foreground">
          {children}
        </span>
      </div>
      <span
        className={cn(
          "justify-self-end rounded-full px-2 py-1 font-mono text-[11px] whitespace-nowrap max-[1180px]:col-start-2 max-[1180px]:justify-self-start max-[640px]:col-start-1",
          STATE_TONE[tone],
        )}
      >
        {state}
      </span>
    </div>
  );
}

export interface BoundaryLedgerProps {
  /** The page anchor id (the landing passes "security"). */
  id?: string;
  /** Mono eyebrow above the title (e.g. "控制边界"). */
  eyebrow: React.ReactNode;
  /** The ledger heading (e.g. "入口对应限制面。"). */
  title: React.ReactNode;
  /** Optional header action (e.g. the 检查登录 button). */
  action?: React.ReactNode;
  /** The `LedgerRow` list. */
  children: React.ReactNode;
}

/** The control-boundary ledger aside (`.boundary-ledger`). */
export function BoundaryLedger({
  id,
  eyebrow,
  title,
  action,
  children,
}: BoundaryLedgerProps) {
  return (
    <aside
      id={id}
      data-slot="boundary-ledger"
      aria-label="控制边界账本"
      className="min-w-0 scroll-mt-20 rounded-md bg-card shadow-ring"
    >
      <div className="flex items-start justify-between gap-[18px] border-b border-line p-[clamp(22px,3vw,32px)] max-[640px]:px-[18px]">
        <div>
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            {eyebrow}
          </div>
          <h3 className="mt-2 text-[clamp(24px,2.6vw,32px)] leading-[1.15] font-semibold tracking-[-1.28px] text-foreground">
            {title}
          </h3>
        </div>
        {action}
      </div>
      <div className="grid">{children}</div>
    </aside>
  );
}
