## Why

The Open Design prototype (`680d21c4`) is now the finalized, fully-reviewed visual contract for the console, but `apps/web` was last visually aligned on 2026-06-11 ("pixel-merge") and has fallen many design iterations behind: the history page, session page, settings credentials, dashboard density, and the simplified landing all diverged, and two designed screens — **会话记录 (transcript)** and **API 调试 (api)** — have no frontend at all. This change does a single, faithful frame-by-frame restoration of `apps/web` to the frozen design baseline so the shipped product matches the design that was signed off.

## What Changes

- **Adopt the residual design tokens** the prototype moved to but the app never picked up: **Geist Sans / Geist Mono** fonts and flatter card surfaces (1px `shadow-ring` over multi-layer shadow). (Color tokens already match — `app.css` is the mirrored contract.)
- **Restore existing console screens** to the baseline, screen by screen:
  - **Landing** (`index.tsx`): drop the ACCESS/CONTROL/SAFETY proof-grid, the "操作者模型" 4-step + boundary-ledger section, and the header nav links — minimal brand + hero + footer.
  - **History**: rewrite the summary-tiles + recent-tasks-table + audit event-stream into a single Vercel-style task-row list (status pill + title + repo·branch + Agent/耗时 + black 「查看会话」), with status filter and empty state. **BREAKING** (removes the audit event-stream and ACTIVE WINDOW/ATTENTION/RETENTION tiles from the UI).
  - **Session**: **remove the approval / write-gate surface**, add a stop-confirmation dialog, 2-line prompt clamp, header alignment. **BREAKING** (removes `approval-surface`).
  - **Dashboard**: compact task rows, simplify the runner pool (slot grid + flow lane → capacity bar), no multi-select.
  - **Repositories / 高级派发**: RUNTIME card, GitHub-connected dialog copy, execution-strategy + sandbox guardrail copy, empty states.
  - **Settings**: reorganize Agent model credentials **by runtime** — Codex (官方账号 / 兼容提供方) and **Claude Code (setup-token / Anthropic API Key)**; drop the write-confirm toggle; single-column layout.
- **Build two new console views** from the baseline:
  - **会话记录 (transcript)**: a session-transcript timeline (user / reasoning / tool call+output / final answer / system events) with type filter, search, and empty state.
  - **API 调试 (api)**: an authenticated API debug console (resource-grouped endpoint rail + read-only request bar + Request/Response sections with tabs) that calls the public v1 API.
- **Navigation**: add "API 调试 ⌘4" to the console sidebar and mobile nav.
- **Cross-cutting**: empty states on every list, `prefers-reduced-motion`, and removal of all residual approval/write-gate language across screens.
- **Absorb** the unfinished frontend-visual work from `redesign-settings-single-column` and leave the terminal-log mechanism (`static-terminal-log`) intact, only restyling it.

## Capabilities

### New Capabilities
<!-- None — the new transcript and API-debug views are requirements of the existing console capability, not standalone capabilities. -->

### Modified Capabilities
- `frontend-console`: console screens re-aligned to the frozen design baseline; adds the 会话记录 (transcript) and API 调试 views and the sidebar entry; removes the approval/write-gate surface from the session view; history becomes a task-row list (event-stream/summary-tiles removed); Geist fonts + flatter surfaces adopted.
- `account-settings`: Agent model credentials reorganized by runtime; adds a Claude Code credential entry (setup-token + Anthropic API Key) alongside the existing Codex options; the write-before-confirm toggle is removed.

## Impact

- **Code**: `apps/web/src/routes/{index,login}.tsx`, `apps/web/src/routes/_app/{dashboard,history,repositories,settings}.tsx`, `apps/web/src/routes/_app/tasks/{new,$taskId}.tsx`, plus new routes for transcript and `_app/api`; components under `apps/web/src/components/{landing,dashboard,history,session,settings,repositories,shell}`; shared primitives in `packages/ui`; tokens/fonts in `apps/web/src/styles/app.css` (and `@cap/ui` styles).
- **Removed**: `components/session/approval-surface.tsx` and the session approval UI path; history `audit-timeline` + summary tiles; settings write-confirm toggle.
- **Dependencies**: API 调试 view consumes the `public-v1-api` contract (`@cap/contracts`); transcript view reads `session-transcript-persistence` data. The only backend touch is extending the creds module to persist/mask a Claude Code runtime credential (mirroring the Codex auth-source); everything else is frontend.
- **In-flight coordination**: supersedes the remaining frontend tasks of `redesign-settings-single-column`; reuses (does not rebuild) the `static-terminal-log` terminal record.
- **Verification**: Playwright per-screen visual diff against the frozen `design-baseline/` snapshot.
- **Design baseline**: frozen at `openspec/changes/pixel-restore-console-to-od/design-baseline/` (10 screens + `platform.css` + `platform.js`).
