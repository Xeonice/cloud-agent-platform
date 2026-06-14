## Why

The session detail page (`/tasks/$taskId`) is still the pixel-merge-era read-only viewer: a multi-button toolbar, a 3+1 context-strip card grid, and an approval surface buried inside the terminal window. This shape fuses "page chrome" and "agent activity" into competing surfaces and fragments the operator's attention across redundant connection pills and context cards. The 2026 agent-UX literature is explicit that the terminal scrollback IS the audit trail (one trace = one source of truth) and that tool-use approvals must surface at the decision moment, not in a collapsed log — and that the most effective agent tools keep the raw terminal as the ground-truth medium while wrapping it with web-only affordances the bare terminal cannot provide. This change evolves the viewer into a focused "cockpit": app-shell sidebar + a three-segment header (task-status H1 + tag rail + single 停止 action), an amber write-before-confirm approval banner, and a self-contained dark terminal window (header with ⋯ menu + 全屏, full-width PTY scrollback, statusline footer). It is a pure-frontend, visual-only re-skin: the terminal data pipeline (WS/xterm/lease/heartbeat) and every backend contract are reused verbatim.

## What Changes

> **Descope (decided during apply):** the **page-level amber approval banner** and
> the **`pending`/`decide` state-lift (D1)** are DEFERRED to a dedicated follow-up
> approval change. The real `permission_request` flow is not exercisable here (codex
> auth + a live write gate are unavailable locally), so verifying a page-level
> approval flip is out of reach this phase. The permission-request approval surface
> therefore STAYS rendered inside the terminal exactly as it shipped previously, and
> this change becomes a **pure-visual cockpit re-skin with NO WebSocket-path delta**.
> The bullets below describing the page-level banner / state-lift are superseded by
> this note; everything else (header, terminal window, statusline, tags, sidebar) ships.

- **Sidebar (global, cross-cutting):** narrow the app-shell sidebar from 244px → 228px and replace the active nav state from a solid dark pill with a Geist-style left vertical accent bar. This edits `_app.tsx` (the width value) and `app-sidebar.tsx` (active-state restyle), so it shifts the layout of **every** authed page (landing/dashboard/repos/history/settings), not just the session page.
- **Three-segment header** replacing the old toolbar + screen-header band:
  - **Task-status H1** (运行中 / 等待审批 / 已停止 / 失败) rendered as **dot+text in Badge form** using canonical state vocabulary — animate only when in-flight (the amber 等待审批 pulse is the legitimate animated case; 运行中 / 已停止 / 失败 are static), never color-alone.
  - **Tag rail** folding the deleted context-strip into neutral white-bg + 1px-ring chips (分支 / Codex / AIO Sandbox / linux-amd64 / 守护栏), with the amber 写入前确认 chip as the only warning-bearing tag. Tags are non-interactive.
  - **Single 停止 action** (two-step confirm preserved) as the only header action; the old 返回任务 / 复制会话记录 / 暂停输出 buttons fold into the terminal ⋯ menu or are dropped.
- **Amber write-before-confirm approval banner** promoted from inside the terminal window to a page-level banner above it, with a shield icon, the mono command (derived from `toolName`), a clear "Codex 请求执行写入操作" ask, and approve (black primary) / reject (ghost) actions. Deciding flips the global H1 / statusline state.
- **Self-contained dark terminal window:** terminal-head becomes a three-segment dark header (⋯ menu = 复制 / 暂停滚动, plus a 全屏 button via `requestFullscreen`); the PTY scrollback stays intentionally full-width (log-scanning content, not prose); a new statusline footer (CPU·内存 + degraded phase) is appended inside the same `<article>`.
- **Deletions:**
  - `session-context-strip.tsx` — clean delete (imported only by the route); its 3+1 info folds into header tags + statusline.
  - `terminal-command-input.tsx` — **scoped deletion (live path only)**; it must survive on the xterm-unavailable fallback path, which a mandated honest-degradation requirement still depends on. There was never a separate live composer (live input is already direct xterm `onData`).
  - "Right-side event timeline" — **no-op / non-applicable**: no such component exists. Recorded as already-absent, not a removal task.
- **Honest degradation (no fabrication), per the established spec idiom:** the approval banner shows the mono command only — diffstat / commits / 查看变更 are contract-unbacked (`permission_request` carries only requestId + taskId + toolName + opaque toolInput) and stay out of scope; the statusline phase degrades to {等待审批 when pending | generic 运行中 otherwise} because the raw PTY has no semantic phase parse; CPU/MEM reuse the existing 未运行/未采样 honest-render pattern.
- **Pixel gate evolved (required verify gate):** re-export the cockpit `session.html` into a fresh live design-baseline for this change, re-point the session `designPath` in `e2e/visual/manifest.ts`, and re-calibrate the session threshold via `VV_MEASURE=1` (the structural rewrite will fail the old 0.055/0.065 by design). Because the sidebar change moves all pages, the whole-manifest baseline needs re-calibration too. The masking convention (terminal surface + `[data-connection]`) carries forward.

## Capabilities

### New Capabilities
<!-- No new capabilities — this change re-skins an existing session-page surface. -->

### Modified Capabilities
- `frontend-console`: MODIFY the existing `### Requirement: Session page design-revision layout` requirement. Replace its 3+1 context-strip / multi-button-toolbar scenario language with the cockpit form (sidebar 244→228 + Geist left active bar, three-segment header = task-status H1 + tag rail + single 停止, amber write-before-confirm approval banner, self-contained dark terminal window with ⋯ menu + 全屏 + full-width PTY + statusline), while **preserving the three invariant scenarios verbatim** (ssr:false / pendingComponent / raw-bytes-bypass-Query + the live-verification gate on any WS-path diff). Light layout-prose touch-ups may be needed on the larger behavioral requirement `### Requirement: Session page renders the live terminal and controls` (its xterm-unavailable fallback scenario still references a command input row, which the scoped deletion must keep honest), but its behavioral guarantees stay intact. The app-shell composition requirement may need a small MODIFY to reflect the 244→228 sidebar width.

## Impact

- **Affected routes/components (frontend only):**
  - `apps/web/src/routes/_app/tasks/$taskId.tsx` — page composition reorganized into the cockpit shell; lifts pending-approval state to page level.
  - `apps/web/src/components/session/session-header.tsx` — rewritten to the three-segment header (status H1 + tag rail + single 停止).
  - `apps/web/src/components/session/session-terminal.tsx` — re-skinned to the self-contained dark window (three-segment dark header, ⋯ menu, 全屏, statusline footer); WS/xterm/lease/heartbeat machinery reused verbatim.
  - `apps/web/src/components/session/approval-surface.tsx` — restyled to the amber page-level banner.
  - `apps/web/src/components/session/session-context-strip.tsx` — deleted.
  - `apps/web/src/components/session/terminal-command-input.tsx` — retained for the xterm-fallback path only.
  - `apps/web/src/routes/_app.tsx` (`--sidebar-width`) and `apps/web/src/components/app-sidebar.tsx` (active-state restyle) — global sidebar change touching all authed pages.
  - StatusPill usages evolve to gain a dot+text primitive and the white-bg+ring tag — genuinely new visual vocabulary.
- **No backend / contract impact:** no changes to the terminal data pipeline, the `permission_request` payload, resource-metrics, write-lock-and-takeover, or agent-events-and-approvals. Existing data bindings (branch, taskContextQuery, taskResourceQuery, guardrail readout) map 1:1 onto the cockpit tags/statusline.
- **Risk — the one place "pure visual" leaks:** promoting the approval banner to page level AND making it flip global H1/statusline state requires lifting `pending`/`decide` out of `SessionTerminal` to the route (or exposing them via the imperative handle). This touches the WS control-frame consumer wiring, so the live-verification gate applies. (Documented fully in design.md.)
- **Risk — cross-cutting pixel drift:** the global sidebar change moves every page's baseline; the pixel gate for all pages (not just session) needs re-calibration. This is the primary cross-cutting risk.
- **Deferred to backend-contract follow-ups (not gaps in this change):** approval-banner payload expansion (diffstat / commits / 非force detection), `codex exec --json` structured-event statusline phase, reject-with-note, timeline offset, mobile bottom sheet, 3-tier stop. Competitor models (Devin / Cursor) confirm these are the mature roadmap.
- **a11y implementation note:** xterm.js sets `user-select:none` on its a11y tree, which can block native copy/selection — the ⋯ menu 复制 item may need a custom copy handler rather than relying on native selection.
