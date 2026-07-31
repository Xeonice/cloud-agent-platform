## Why

The cockpit redesign (`session-cockpit-redesign`) deliberately DESCOPED the approval
work: it kept the permission-request approval surface rendered INSIDE the terminal
(as it shipped previously) rather than promoting it to a page-level banner, because
the real `permission_request` flow could not be exercised or live-verified locally
(codex auth + a live write gate are unavailable), and the state-lift it required was
the only WebSocket-path delta in an otherwise pure-visual change. This follow-up does
the approval as one cohesive, verifiable change: the page-level amber banner, the
`pending`/`decide` state-lift, the richer payload, and a real live-verification.

## What Changes

- **Page-level amber approval banner** (the OD cockpit design): promote the approval
  surface from inside the terminal to a page-level banner ABOVE it — shield icon, the
  mono command, "Codex 请求执行写入操作" ask, 批准 (black primary) / 拒绝 (ghost).
- **State-lift (design D1, carried over):** lift `pending`/`decide` out of
  `SessionTerminal` to the route via the existing `SessionTerminalHandle` ref / an
  `onPendingChange` callback (socket + control-frame consumer stay in `SessionTerminal`;
  only the derived `PendingApprovalView` crosses the seam). Deciding flips the page-level
  H1 Badge to/from the 等待审批 (gate) state + the statusline phase + the amber
  写入前确认 tag (the `SessionStatusBadge` gate variant + `SessionTag` warning variant
  already exist from the cockpit change).
- **Richer approval payload (BACKEND, contract):** expand the `permission_request`
  payload beyond `requestId + taskId + toolName + opaque toolInput` to carry a structured
  command + diffstat + commit list + force/remote flags, so the banner can show
  "N commits · +X −Y · 非 force · 查看变更" instead of a bare command. Touches
  `@cap/contracts` (`PermissionRequestFrameSchema`) + `approvals.controller.ts` +
  the sandbox codex hook that POSTs it.
- **Reject-with-note (optional):** allow 拒绝 to carry a short message injected as the
  next instruction (deny-with-message).
- **Live verification:** with a real codex write gate (requires codex auth wired into
  the local/staging sandbox), drive the cockpit session page in a browser and verify the
  full round-trip: codex hits a write gate → `permission_request` → page-level banner +
  H1 flips to 等待审批 → operator 批准/拒绝 → decision returns to the blocked hook → H1
  flips back. (The cockpit change already live-verified that the terminal connects to a
  real backend PTY; this change adds the approval round-trip.)

## Capabilities

### New Capabilities
<!-- No new capability — extends the existing approval surface + frontend-console. -->

### Modified Capabilities
- `frontend-console`: MODIFY the session-page approval requirement back to a page-level
  banner + the state-lift (re-introducing the scenarios the cockpit change deferred:
  banner page-level + command/diffstat, deciding flips the H1/statusline, the amber
  写入前确认 tag while pending, and the live-verification gate on the state-lift WS wiring).
- `agent-events-and-approvals` (or `write-lock-and-takeover`): MODIFY the
  `permission_request` payload contract to carry the structured command + diffstat +
  commit list, and the reject-with-note decision shape.

## Impact

- **Frontend:** `approval-surface.tsx` (re-style to the page-level amber banner),
  `session-terminal.tsx` (re-introduce the `onPendingChange` producer + `decide` on the
  handle; stop rendering the in-terminal panel), `$taskId.tsx` (hold lifted `pending`,
  render the page-level banner, drive the gate state + 写入前确认 tag), `session-header.tsx`
  (re-add the `writeGatePending` 写入前确认 tag). All of these were built then reverted in
  `session-cockpit-redesign` — the diffs are recoverable from that change's history.
- **Backend / contract:** `@cap/contracts` `PermissionRequestFrameSchema` payload
  expansion; `apps/api` approvals controller + the sandbox codex hook that assembles +
  POSTs the structured request; the decision shape for reject-with-note.
- **Verification:** a live codex write gate needs codex auth configured in the sandbox
  (`CodexAuthSource`), which was absent in the cockpit-change local run — this change must
  arrange a real or faithfully-stubbed write gate to live-verify the round-trip.
- **Pixel baseline:** the session design baseline (`session-cockpit-redesign`
  design-baseline) must gain the gated-state variant (banner visible, H1 等待审批,
  写入前确认 tag) for a deterministic approval-state visual gate.
