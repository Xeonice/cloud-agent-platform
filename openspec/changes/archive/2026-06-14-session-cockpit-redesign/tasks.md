<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: visual-primitives (depends: none)

- [x] 1.1 In `apps/web/src/components/status-pill.tsx`, add a dot+text **Badge** primitive driving the canonical state vocabulary 运行中 / 等待审批 / 已停止 / 失败, where state is conveyed by BOTH the dot color AND the text label (never color-alone), keeping the existing `StatusPill` API intact for non-session consumers.
- [x] 1.2 In `apps/web/src/components/status-pill.tsx`, apply the pulse animation ONLY to the 等待审批 (in-flight) state; ensure 运行中 / 已停止 / 失败 render a STATIC dot with no animation.
- [x] 1.3 In `apps/web/src/components/status-pill.tsx`, add a non-interactive **tag chip** primitive: white background + 1px ring for neutral chips, plus an amber/warning variant reserved for the 写入前确认 chip.
- [x] 1.4 In `apps/web/src/styles/app.css`, add/adjust the supporting classes (dot-color tokens, ring chip, amber warning, pulse keyframe gated to the 等待审批 case) the new primitives reference, reusing existing tokens rather than introducing ad-hoc colors.

## 2. Track: sidebar-global (depends: none)

- [x] 2.1 In `apps/web/src/routes/_app.tsx`, change `--sidebar-width` from `244px` to `228px` (and update the matching doc-comment that pins it to 244px).
- [x] 2.2 In `apps/web/src/components/shell/app-sidebar.tsx`, replace the active-nav indicator from a solid dark pill background with a Geist-style LEFT VERTICAL ACCENT BAR on the active item.
- [x] 2.3 In `apps/web/src/components/shell/app-sidebar.tsx`, confirm/keep the active-highlight mapping so `/tasks/$taskId` (session) and `/tasks/new` (create) both highlight the 任务控制台 (dashboard) item via the new accent bar, preserving the existing router-state logic.

## 3. Track: approval-banner — DEFERRED to a follow-up approval change

- [x] 3.1 DEFERRED: the page-level amber approval banner + the `pending`/`decide`
  state-lift are descoped from this (pure-visual) change. The approval surface
  stays INSIDE the terminal exactly as it shipped previously — `approval-surface.tsx`
  keeps its in-terminal dark panel. The page-level banner restyle (shield icon,
  mono command, 批准/拒绝) lands with the follow-up approval change that also wires
  the real `permission_request` flow + payload (diffstat/commits) + its live verify.
- [x] 3.2 DEFERRED with 3.1 — no restyle this phase (the in-terminal panel is unchanged).

## 4. Track: terminal-window (depends: visual-primitives)

- [x] 4.1 In `apps/web/src/components/session/session-terminal.tsx`, re-skin the terminal-head into a three-segment DARK header keeping the `{agent} · {repo}#{branch}` label, reusing the existing WS/xterm/lease/heartbeat machinery verbatim (no input/connection semantic change).
- [x] 4.2 In `apps/web/src/components/session/session-terminal.tsx`, add the ⋯ overflow menu offering 复制 (reuse the `copySession` handle / custom copy handler, since xterm sets `user-select:none`) and 暂停滚动 (reuse the existing pause/`togglePause`), and a 全屏 button that calls the article element's `requestFullscreen` API.
- [x] 4.3 In `apps/web/src/components/session/session-terminal.tsx`, remove the hardcoded `pty: /dev/pts/4` (any pty-path) line from the terminal-head — no backend field backs it.
- [x] 4.4 In `apps/web/src/components/session/session-terminal.tsx`, append a STATUSLINE footer inside the same `<article>` showing CPU·内存 (reuse `formatTaskResource` with its 未运行/未采样 + stale-carry-forward behavior) plus a phase that degrades honestly to {等待审批 while a decision is pending | generic 运行中 otherwise}, keeping the PTY scrollback region full-width.
- [x] 4.5 DEFERRED (state-lift descoped): KEEP the `permission_request` control-frame
  consumer + socket inside `SessionTerminal` AND keep rendering `<ApprovalSurface>`
  inside the terminal `<article>` (the pre-existing behavior). No `onPendingChange` /
  `decide` lift — this change touches NO WS path. The lift moves to the follow-up
  approval change.

## 5. Track: session-header (depends: visual-primitives)

- [x] 5.1 In `apps/web/src/components/session/session-header.tsx`, rewrite into the THREE-SEGMENT header rendering, in order: the TASK-STATUS H1 Badge (using the dot+text primitive + canonical vocabulary), the tag rail, then a single 停止 action.
- [x] 5.2 In `apps/web/src/components/session/session-header.tsx`, build the TAG RAIL as non-interactive ring chips 分支 / Codex / AIO Sandbox / linux-amd64 / 守护栏 (white bg + 1px ring; 守护栏 fed by the honest `idleTimeoutMs`/`deadlineMs` readout), plus the amber 写入前确认 chip as the ONLY warning-colored tag, rendered only while a decision is pending.
- [x] 5.3 In `apps/web/src/components/session/session-header.tsx`, make 停止 the SOLE header action retaining the existing two-step (explicit confirm) stop semantics that POST to `POST /tasks/:taskId/stop`, inert/hidden for terminal-state tasks; remove the former 返回任务 / 复制会话记录 / 暂停输出 buttons from the header (they fold into the terminal ⋯ menu or are dropped).

## 6. Track: route-cockpit (depends: session-header, terminal-window, approval-banner, sidebar-global)

- [x] 6.1 DEFERRED (no page-level banner this phase): the route does NOT hold a lifted
  `pending`/`decide` state and does NOT render a page-level `<ApprovalSurface>`. The
  approval stays in-terminal (4.5). This lands with the follow-up approval change.
- [x] 6.2 In `apps/web/src/routes/_app/tasks/$taskId.tsx`, drive the three-segment `SessionHeader` (H1 Badge + tag rail + single 停止) from the route's task/guardrail/resource state. The H1 Badge reflects the task LIFECYCLE (运行中/已停止/失败); the 等待审批 gate state + the amber 写入前确认 tag are DEFERRED to the follow-up approval change (no `pending` source this phase).
- [x] 6.3 In `apps/web/src/routes/_app/tasks/$taskId.tsx`, remove the `SessionContextStrip` usage and its `contextItems`/`guardrailItem` plumbing (folding the 3+1 info into the header tags + statusline), then delete `apps/web/src/components/session/session-context-strip.tsx`.
- [x] 6.4 In `apps/web/src/routes/_app/tasks/$taskId.tsx`, preserve the route invariants verbatim: `/tasks/$taskId` stays the only `ssr:false` route, the server still emits the window-free `pendingComponent` terminal skeleton, raw PTY bytes still bypass the TanStack Query cache, and the pre-running 排队中 / 沙箱启动中… placeholder still drives off task status.
- [x] 6.5 In `apps/web/src/components/session/terminal-command-input.tsx`, confirm it is RETAINED for the xterm-unavailable fallback path only (no live composer) and that the fallback `terminal-fallback.tsx` line-input scenario still references it honestly.
- [x] 6.6 Live-backend check. With the state-lift descoped (4.5/6.1), this change has
  NO WS-input/connection/state-lift diff, so the design-revision live-verification
  scenario reduces to confirming the reorganized terminal still connects. VERIFIED
  against the running compose backend (api + postgres + cap-aio-sandbox:pinned): a
  real task (repo cloned, AioPtyClient attached to the sandbox `/v1/shell/ws`) drove
  the cockpit session page to 已连接 in a real browser, with the cockpit (crumb / H1 /
  tags / terminal window) rendering correctly off live REST data. The keystroke-`\r`
  + reconnect + approval-decision-flip verification moves to the follow-up approval
  change (the live `permission_request` flow needs codex auth + a real write gate,
  not available locally).

## 7. Track: pixel-baseline (depends: route-cockpit, sidebar-global)

- [x] 7.1 Export the rendered cockpit session page into a fresh `session.html` design baseline for this change (cockpit shell: three-segment header + page-level amber banner + self-contained dark terminal + statusline), placing it under this change's `design-baseline/screens/` directory.
- [x] 7.2 In `apps/web/e2e/serve-design-baseline.mjs`, re-point the `ROOT` static-serve directory from the archived `2026-06-11-console-design-pixel-merge/design-baseline` to this change's fresh design-baseline directory.
- [x] 7.3 In `apps/web/e2e/visual/manifest.ts`, re-point the session `designPath` to the fresh `session.html` and keep the masking convention (`section.terminal-shell` + `[data-connection]` / `.status-pill`) consistent with the new markup.
- [x] 7.4 Re-calibrate thresholds via `VV_MEASURE=1 pnpm test:visual` for the WHOLE manifest (the 244→228 sidebar shift moves every authed page, not just session), then update every page's recorded `maxDiffPixelRatio` and the calibration-record comment block in `apps/web/e2e/visual/manifest.ts` (the old session 0.055/0.065 will fail by design).
- [x] 7.5 Re-run `pnpm test:visual` (non-measure) to confirm every page passes its re-pinned blocking threshold, refreshing `apps/web/e2e/visual/__screenshots__/` as needed.
