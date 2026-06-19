<!-- Track-annotated tasks. Global layer (tokens) lands first; screens re-sync in
     parallel against the frozen design-baseline/; new views and verification last. -->

## 1. Track: design-tokens (depends: none)

- [x] 1.1 Bundle Geist Sans + Geist Mono as app assets (OFL, self-hosted; no render-blocking external import) and point `--font-sans` / `--font-mono` in `apps/web/src/styles/app.css` at them with the existing `system-ui` / monospace fallback chain
- [x] 1.2 Flatten card surfaces to the baseline's single-ring shadow (the `shadow-card` utility → ring), keeping `shadow-ring` semantics; verify no regression on already-aligned pages
- [x] 1.3 Ensure `@cap/ui` styles.css re-import still resolves the updated font/shadow tokens (shared primitives stay color/typeface-matched)

## 2. Track: baseline-harness (depends: none)

- [x] 2.1 Add a Playwright helper that serves the frozen `openspec/changes/pixel-restore-console-to-od/design-baseline/` over a static server and screenshots a given baseline screen at a fixed viewport
- [x] 2.2 Add a per-screen visual-diff spec scaffold (baseline screenshot vs the matching `apps/web` route) wired into `apps/web/e2e`, parameterized by screen so each restore track can assert its screen

## 3. Track: claude-credential-backend (depends: none)

- [x] 3.1 Extend the creds module (`apps/api/src/creds`) to store a Claude Code runtime credential — `claude setup-token` subscription token and Anthropic API Key — encrypted at rest, owner-scoped, mirroring the Codex auth-source handling
- [x] 3.2 Return only masked suffixes for the Claude credential (never plaintext) and expose connection status, consistent with the Codex credential contract
- [x] 3.3 Make the stored Claude credential selectable by the Claude Code runtime at task launch (runtime ↔ credential wiring)

## 4. Track: shared-primitives (depends: design-tokens)

- [x] 4.1 Add a shared `EmptyState` primitive in `apps/web/src/components` (icon + title + body + optional action) for list empty states
- [x] 4.2 Status dot+text variant — N/A: the finalized lists (history/dashboard) use the filled `StatusPill` which already exists; no separate dot variant needed
- [x] 4.3 Transcript event-row primitives — built within Track 11 (transcript-view) under the visual loop, not blind
- [x] 4.4 API request/response shell primitives — built within Track 12 (api-view) under the visual loop, not blind

## 5. Track: landing-restore (depends: design-tokens)

- [x] 5.1 Simplify `apps/web/src/routes/index.tsx` + `components/landing/*` to the baseline: drop the ACCESS/CONTROL/SAFETY proof-grid, the 操作者模型 process-rail, and the boundary-ledger section
- [x] 5.2 Reduce the landing header to brand-only (remove 流程/权限/控制台/GitHub登录 nav links); keep the hero (CTA + trust pills + runner-capsule) and footer (drop the dead 安全模型 anchor)
- [x] 5.3 Diff `/` vs `design-baseline/index.html`; fix drift

## 6. Track: dashboard-restore (depends: design-tokens)

- [x] 6.1 Compact the task rows in `components/dashboard/queue-panel.tsx` to the baseline density; ensure no multi-select affordance
- [x] 6.2 Simplify `components/dashboard/capacity-aside.tsx`: replace the runner slot-grid + flow lane with a single capacity bar + legend; keep runner list
- [x] 6.3 Update `components/dashboard/new-task-dialog.tsx` and `routes/_app/tasks/new.tsx` to the baseline copy (沙箱即信任边界 guardrail, execution-strategy options) and remove any stopOnWrite/write-gate control
- [x] 6.4 Diff `/dashboard` and `/tasks/new` vs `design-baseline/{dashboard,queue}.html`; fix drift

## 7. Track: repositories-restore (depends: design-tokens)

- [x] 7.1 Update `routes/_app/repositories.tsx` + `components/repositories/*`: RUNTIME summary card (Codex · Claude Code), "已连接 GitHub" import-dialog copy, repo-list empty state
- [x] 7.2 Diff `/repositories` vs `design-baseline/agents.html`; fix drift

## 8. Track: session-restore (depends: design-tokens, shared-primitives)

- [x] 8.1 Remove `components/session/approval-surface.tsx` and its render path from the session view (no write-gate banner)
- [x] 8.2 Add a stop-confirmation dialog to the session header's 停止 action; align the header (breadcrumb + title + status + 2-line prompt clamp that auto-hides 展开 when not overflowing); reframe the terminal as 终端记录 with a link to 会话记录
- [x] 8.3 Diff `/tasks/$taskId` vs `design-baseline/session.html`; fix drift

## 9. Track: history-restore (depends: design-tokens, shared-primitives)

- [x] 9.1 Replace `components/history/{history-summary,recent-tasks-table,audit-timeline}` with a single Vercel-style task-row list (status pill + id + title + repo·branch + Agent + 耗时 + dark 「查看会话」; queued → disabled 等待接入)
- [x] 9.2 Rebuild the `/history` toolbar: search + status SegmentedControl (全部/运行中/等待输入/排队/已完成/失败) + CountChip "N 条记录" + empty state; one client filter drives the list
- [x] 9.3 Point 「查看会话」 at the task's 会话记录 (transcript) route; remove ACTIVE WINDOW/ATTENTION/RETENTION tiles and the audit event-stream
- [x] 9.4 Diff `/history` vs `design-baseline/history.html`; fix drift

## 10. Track: settings-restore (depends: design-tokens, claude-credential-backend)

- [x] 10.1 Single-column settings layout DONE: removed the side-nav 2-col wrapper + the system-strip + the #safety write-confirm section; the page is now a single max-640px `settings-stack` of stacked panels (当前身份 / 访问与默认值 / Codex / Claude Code / API Keys / MCP) matching design-baseline `.settings-stack`. Deleted orphaned settings-side-nav.tsx + system-strip.tsx. (VV_MEASURE desktop 0.04→0.03 — improved.)
- [x] 10.2 Added the Claude Code credential UI by runtime: `claude-credential.tsx` (status card + setup-token / Anthropic API Key entries + mode-aware dialog, masked, status-synced) wired via claudeCredentialQuery + saveClaudeCredentialMutation → /settings/claude (Track 3 backend). Codex group kept.
- [x] 10.3 /settings passes the pixel gate (0.04 < 0.055) with the Claude credential section added + safety removed.

## 11. Track: transcript-view (depends: shared-primitives, session-restore)

- [x] 11.1 Add the 会话记录 route (e.g. `_app/tasks/$taskId/transcript`) reading persisted transcript data; render the typed-event timeline via the shared transcript primitives
- [x] 11.2 Add the type filter (全部/我的输入/工具/回答) + search + empty state + a link to the terminal record
- [x] 11.3 Diff the transcript view vs `design-baseline/transcript.html`; fix drift

## 12. Track: api-view (depends: shared-primitives)

- [x] 12.1 /api delivered by the in-flight **add-api-playground** change (components/api/* + runner + SSE in the shared worktree) — NOT this change. My from-scratch version was correctly reverted to it; pixel-restore only contributes the nav entry (13.1).
- [x] 12.2 (covered by add-api-playground — see 12.1)
- [x] 12.3 /api passes the pixel gate (add-api-playground impl, verified in shared tree)

## 13. Track: nav-and-crosscutting (depends: design-tokens)

- [x] 13.1 Add the "API 调试 ⌘4" entry to the console sidebar and mobile nav in `components/shell/*`
- [x] 13.2 Add a global `prefers-reduced-motion` reduction and sweep residual approval/write-gate copy out of all screens
- [x] 13.3 Confirm `@cap/ui` and route tree (`routeTree.gen.ts`) include the new transcript/api routes and the typecheck+lint gate passes

## 14. Track: verify-and-archive (depends: landing-restore, dashboard-restore, repositories-restore, session-restore, history-restore, settings-restore, transcript-view, api-view, nav-and-crosscutting)

- [x] 14.1 Run the full per-screen Playwright visual diff against `design-baseline/`; all 10 screens match at the fixed viewport
- [x] 14.2 Coordination noted: this change absorbed `redesign-settings-single-column`s by-runtime-credential + safety-removal scope (single-column LAYOUT still its scope) and verified the landing simplification owed by `simplify-landing-homepage` (landing passes the gate). Both screens green against the frozen baseline.
- [x] 14.3 Run `openspec validate pixel-restore-console-to-od --strict` and the web build/typecheck/lint gate
