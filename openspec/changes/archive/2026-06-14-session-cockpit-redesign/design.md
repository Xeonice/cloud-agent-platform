## Context

The session detail page (`/tasks/$taskId`) is still the pixel-merge-era read-only viewer: a multi-button `SessionHeader` toolbar, a 3+1 `SessionContextStrip` card grid, and an approval surface (`ApprovalSurface`) rendered *inside* `SessionTerminal`. This fuses "page chrome" with "agent activity" and fragments operator attention across redundant context cards.

This change re-skins the page into a focused "cockpit": app-shell sidebar (228px + Geist left accent bar) + three-segment header (status H1 + tag rail + single 停止) + page-level amber approval banner + a self-contained dark terminal window (⋯ menu + 全屏 + full-width PTY + statusline footer). See `proposal.md` for full motivation and `specs/frontend-console/spec.md` for the testable requirements.

It is declared a **pure-frontend, visual-only re-skin**: the WS/xterm/lease/heartbeat pipeline and every backend contract (`permission_request`, resource-metrics, write-lock, agent-events) are reused verbatim. Two things, however, are not purely cosmetic and are why this design doc exists:

1. **The state-lift.** The current code keeps `pending`/`decide` (the `permission_request` consumer) *inside* `SessionTerminal` (`session-terminal.tsx:157,401,508`), rendered via `<ApprovalSurface>` inside the terminal `<article>`. The cockpit requires the banner to live at *page level* (above the terminal) AND to flip the page-level H1 Badge + statusline. That requires lifting `pending`/`decide` to the route — which touches the WS control-frame consumer wiring, i.e. the one place a "pure visual" change crosses into the live-data path.
2. **Cross-cutting pixel drift.** The sidebar change (`_app.tsx` `--sidebar-width` 244→228 + `app-sidebar.tsx` active-state restyle) moves the layout of *every* authed page, so the whole visual-regression baseline — not just `session` — must be re-calibrated. Current recorded thresholds (`e2e/visual/manifest.ts`: session 0.055/0.065) will fail by design.

**Constraints:** `/tasks/$taskId` must remain the only `ssr:false` route; the server-rendered `pendingComponent` skeleton must stay window-free; raw PTY bytes must never enter the TanStack Query cache; no fabricated fields (the established honest-degradation idiom). Stakeholders: the operator (audit + approve), and the verify gate (pixel baseline + live WS session).

## Goals / Non-Goals

**Goals:**
- Reorganize `/tasks/$taskId` into the cockpit layout (three-segment header, page-level approval banner, self-contained dark terminal window) as a markup/layout/style reorganization.
- Globally narrow the sidebar to 228px and switch the active indicator to a Geist left accent bar, accepting that this moves every authed page.
- Lift `pending`/`decide` to the route so the page-level banner can flip the H1 Badge + statusline — the single sanctioned non-visual delta, behind the live-verification gate.
- Re-calibrate the pixel baseline for the session page (fresh `session.html` export) and the whole manifest (sidebar shift).
- Keep every readout honest: command-only banner, degraded statusline phase, `未运行/未采样` resource fallback.

**Non-Goals:**
- No backend / contract changes (no `permission_request` payload expansion, no `codex exec --json` structured phase, no reject-with-note).
- No new live-terminal input surface — live input stays direct xterm `onData`; `terminal-command-input.tsx` survives **only** on the xterm-unavailable fallback path.
- No diffstat / commit list / 查看变更 in the banner (contract-unbacked — fabrication prohibited).
- No mobile bottom-sheet approval, no 3-tier stop, no right-side event timeline (that component does not exist — recorded as already-absent).

## Decisions

### D1 — Lift `pending`/`decide` to the route via prop callbacks, not a new context

> **DEFERRED (decided during apply):** this state-lift is descoped from this change
> and moved to a dedicated follow-up approval change. Reason: the real
> `permission_request` flow that the lift exists to surface is NOT exercisable locally
> (codex auth + a live write gate are unavailable), so the page-level approval flip
> cannot be live-verified — and the lift is the change's ONLY WebSocket-path delta, so
> keeping it would force a live-WS gate we can't satisfy. This phase therefore KEEPS
> the approval rendered inside `SessionTerminal` exactly as it shipped previously (no
> lift, no page-level banner), making the cockpit a pure-visual re-skin with no WS
> delta. The analysis below is retained as the design for the follow-up change.

The page-level banner and the H1/statusline both need the approval state. Lift `pending`/`decide` from `SessionTerminal` to `SessionPage` so a single owner drives the banner, the amber 写入前确认 tag, the H1 Badge, and the statusline phase.

- **Chosen:** `SessionTerminal` continues to *consume* the `permission_request` control frame (it owns the socket), but reports `pending` up via an `onPendingChange(view | null)` callback and accepts a `decide` it can invoke, OR exposes both through the existing `SessionTerminalHandle` imperative ref (already used for `copySession`/`togglePause`, `session-terminal.tsx:462`). The route holds `pending` in `useState` and renders `<ApprovalSurface>` (restyled to the page-level amber banner) itself, above the `<article>`.
- **Alternatives considered:** (a) a React context provider straddling header + terminal — rejected as over-engineered for one consumer/one producer; (b) move the whole socket to the route — rejected, it would gut the encapsulation that keeps raw bytes out of Query and would be a far larger, riskier diff. The callback/handle path keeps the socket inside `SessionTerminal` and only surfaces the already-derived `PendingApprovalView`.
- **Rationale:** the existing imperative-handle pattern is the lowest-delta seam; it touches the control-frame wiring (hence the live gate) but leaves the byte pipeline untouched.

### D2 — New visual primitives extend StatusPill rather than replace it

The cockpit needs a dot+text **Badge** (H1 status, animated only for 等待审批) and a white-bg + 1px-ring **tag chip** (non-interactive). Add these as variants/siblings of the existing StatusPill vocabulary rather than ad-hoc one-offs, so the canonical state vocabulary (运行中 / 等待审批 / 已停止 / 失败) and the never-color-alone rule stay centralized. Pulse is applied **only** to 等待审批; 运行中 / 已停止 / 失败 are static.

### D3 — Honest degradation carries forward verbatim

No payload is richer than today, so every cockpit readout reuses the established honest-render idiom:
- **Banner:** mono command derived from `toolName` only (no diffstat/commits/查看变更 — `permission_request` carries only requestId + taskId + toolName + opaque toolInput).
- **Statusline phase:** `{等待审批 while pending | generic 运行中 otherwise}` — the raw PTY exposes no semantic phase to parse.
- **CPU·内存:** reuse `formatTaskResource` and its 未运行/未采样 / stale-carry-forward behavior; never fabricate zeros.
- **Drop the fabricated `pty: /dev/pts/4` line** — no backend field backs it.

### D4 — Sidebar change is acknowledged global and gated by a whole-manifest re-calibration

The 244→228 + accent-bar edit lives in `_app.tsx` (`--sidebar-width`) and `app-sidebar.tsx` (active state). Rather than scope it down, accept it as cross-cutting and make the pixel gate the safety net: re-run `VV_MEASURE=1 pnpm test:visual` to re-pin **every** page's threshold (not just `session`), update the calibration record block in `e2e/visual/manifest.ts`, and re-export a fresh `session.html` design baseline + re-point the session `designPath`. The terminal-surface + `[data-connection]` masking convention carries forward unchanged.

### D5 — Artifact deletions are scoped, not blanket

- `session-context-strip.tsx` — clean delete (imported only by the route); its 3+1 info folds into header tags + statusline.
- `terminal-command-input.tsx` — **retained for the xterm-unavailable fallback path only** (the honest-degradation fallback scenario still depends on a line input; there is no live composer to delete — live input is already direct `onData`).

## Risks / Trade-offs

- **State-lift leaks into the live-data path** → Mitigation: keep the socket inside `SessionTerminal` (D1); only the derived `PendingApprovalView` + `decide` cross the boundary; gate any task whose diff touches WS input/connection/state-lift wiring on a live backend session (typing, Enter submit, reconnect, approval decision flipping the header), per the spec's live-verification scenario.
- **Cross-cutting pixel drift across all pages** → Mitigation: D4 whole-manifest re-calibration; the pixel gate is blocking, so an un-recalibrated page fails the suite rather than shipping silent drift.
- **xterm a11y blocks native copy** → Mitigation: xterm.js sets `user-select:none` on its a11y tree; the ⋯-menu 复制 item should use a custom copy handler (reuse the existing `copySession` on the handle) rather than relying on native selection.
- **Banner appears thinner than competitor approvals (no diffstat)** → Accepted trade-off: honesty over richness; payload expansion is a documented backend follow-up, not a gap in this change.

## Migration Plan

Pure-frontend; no DB/migration. Deploy = the standard Vercel front-end push. Rollback = revert the front-end commit (no backend coupling). Sequencing: land the visual reorg + state-lift, run the live-WS verification, then re-calibrate the pixel baseline (fresh `session.html` + `VV_MEASURE=1` whole-manifest) as the final blocking verify gate before archive.

## Open Questions

- Surface `pending`/`decide` via a new `onPendingChange` prop **or** through the existing `SessionTerminalHandle` ref? (D1 allows either; the implementer picks the lowest-delta seam — lean toward the handle since `copySession`/`togglePause` already ride it.) Resolve during apply.
