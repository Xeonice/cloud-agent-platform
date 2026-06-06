/**
 * `ApprovalSurface` — the in-session permission-request approval panel
 * (task 18.4, approvals D6/D7).
 *
 * Surfaced when a `permission_request` control frame arrives. It shows the
 * gated tool name + requestId and offers 允许 / 拒绝. The decision is
 * lock-INDEPENDENT (D7): it resolves regardless of who holds the write lease,
 * so it is NOT gated by the keystroke lease state. The parent calls
 * `sendDecision(requestId, { behavior })` and removes the panel once decided.
 *
 * SSR-safe: pure render off props (only ever mounted client-side from a live
 * frame, but touches no window APIs).
 */
import * as React from "react";

import type { DecisionBehavior } from "@cap/contracts";

export interface PendingApprovalView {
  requestId: string;
  toolName: string;
}

export interface ApprovalSurfaceProps {
  request: PendingApprovalView;
  onDecide: (requestId: string, behavior: DecisionBehavior) => void;
}

export function ApprovalSurface({
  request,
  onDecide,
}: ApprovalSurfaceProps): React.ReactElement {
  return (
    <div
      role="alertdialog"
      aria-label="待确认的危险动作"
      className="grid gap-3 border-b border-terminal-line bg-[#160f0f] px-4 py-3"
    >
      <div className="grid gap-1">
        <span className="font-mono text-[11px] font-medium text-terminal-warn">
          写入前确认
        </span>
        <strong className="text-sm font-semibold text-terminal-fg">
          Agent 请求执行 <span className="font-mono">{request.toolName}</span>
        </strong>
        <span className="font-mono text-[11px] text-terminal-muted">
          requestId: {request.requestId}
        </span>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecide(request.requestId, "allow")}
          className="inline-flex h-8 items-center justify-center rounded-md bg-terminal-ok px-3 text-xs font-medium text-[#04140a] transition-opacity hover:opacity-90"
        >
          允许
        </button>
        <button
          type="button"
          onClick={() => onDecide(request.requestId, "deny")}
          className="inline-flex h-8 items-center justify-center rounded-md bg-terminal-err px-3 text-xs font-medium text-[#1a0606] transition-opacity hover:opacity-90"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
