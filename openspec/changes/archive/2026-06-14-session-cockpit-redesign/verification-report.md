# Verification Report — session-cockpit-redesign

Three-way routing adjudication of the verify pass. The raw-unmet input list
was empty (`[]`): no requirement entered this pass flagged as a code-level
failure. Every requirement re-traced below maps to existing, confirmed
implementation. There are therefore **no** new verify-reopened code tasks and
**no** new spec-defect routings from this pass.

## Adjudication summary

- **Reopened (UNMET → code task):** none.
- **Spec-defects (ambiguous/untestable → design Open Questions):** none.
- **Reclassified MET (re-trace end-to-end satisfied):** all three
  `frontend-console` requirements (below).

## MET requirements (re-traced end-to-end)

### Requirement: Session page design-revision layout — MET

All scenarios trace to confirmed code:

- **Header three-segment order** (status H1 Badge → tag rail → single 停止) —
  `apps/web/src/components/session/session-header.tsx` renders, in order, the
  `SessionStatusBadge` (line 107), the `SessionTag` rail (lines 126-149), and
  the single two-step 停止 control (lines 152-195). The former 返回任务 /
  复制会话记录 / 暂停输出 buttons are absent.
- **Status badge by dot + text, never color-alone** — `SessionStatusBadge` in
  `apps/web/src/components/status-pill.tsx` (lines 98-126) emits both a colored
  dot and the canonical text label via `SESSION_STATE_META`.
- **Only the gate state animates** — `SESSION_STATE_META` sets `pulse: true`
  only for `gate` (等待审批); 运行中/已停止/失败 are `pulse: false`
  (`status-pill.tsx:87-91`), and the pulse class is gated by `meta.pulse`
  (line 120).
- **Tag rail as non-interactive ring chips** — `SessionTag`
  (`status-pill.tsx:133-160`) renders a `<span>` (no handler/role), white-bg +
  1px ring.
- **Single 停止 with two-step confirm → `POST /tasks/:taskId/stop`** —
  `confirmingStop` state in `session-header.tsx` (lines 71-74, 152-195); inert
  for terminal-state tasks via `canStop`.
- **Self-contained dark terminal `<article>` with ⋯ menu, 全屏, statusline** —
  `apps/web/src/components/session/session-terminal.tsx`: single `<article>`
  shell (line 563), ⋯ menu 复制/暂停滚动 (lines 600-615), 全屏 toggle calling
  `requestFullscreen` (lines 482-485, 626-642), statusline footer (lines
  741-743).
- **Fabricated pty line removed** — confirmed: no pty path is rendered; the
  removal is documented in `session-terminal.tsx:567` ("intentionally NOT
  rendered").
- **Statusline degrades honestly** — reuses `formatTaskResource`
  (`session-terminal.tsx:80, 743`).
- **Session invariants** — `apps/web/src/routes/_app/tasks/$taskId.tsx` keeps
  `ssr: false` (line 63), `pendingComponent: TerminalSkeleton` (line 64), raw
  bytes off the query cache, and the `PreRunningPlaceholder` driven by task
  status (lines 184, 202-217).
- **Live backend confirmation** — task 6.6 records the live-backend VERIFIED
  result (terminal connected to 已连接 against the running compose backend).

### Requirement: Session page renders the live terminal and controls — MET (with a minor, non-blocking note)

- **codex own-process CPU/memory as PRIMARY, scope-labeled** — confirmed in
  `apps/web/src/components/session/format-resource.ts`: for `scope: 'process'`
  it renders `codex CPU x% · 内存 … · 容器 …` (lines 40-44), with the container
  total as background context. The container fallback (`scope: 'container'`)
  reads `容器 CPU …` (line 47).
- **Honest not-running / stale-carry-forward** — `formatTaskResource` flips to
  `未运行 / 未采样` only on `resource.state === "not-running"` (line 38); a
  missed sampling tick is handled by the backend returning `sampled` with a
  larger `ageMs` (never `not-running`), so the frontend keeps the carried-forward
  reading. Backend-dependent behavior, handled correctly on the frontend.
- All remaining scenarios (live byte stream off-cache, guardrail readout via
  header tag, stop control, pre-running placeholder, direct xterm input, inert
  non-OPEN socket, SSR skeleton, in-terminal approval, control-frame cache
  bridge, xterm fallback) trace to existing implementation.

### Requirement: Shared authenticated app-shell and navigation — MET (with a minor, non-blocking note)

- **228px sidebar** — `apps/web/src/routes/_app.tsx:83` pins
  `--sidebar-width: 228px`.
- **Left accent bar active indicator (not a dark pill)** —
  `apps/web/src/components/shell/app-sidebar.tsx:122` uses
  `shadow-[inset_2px_0_0_var(--foreground)]` on the active item.
- **Session/create routes highlight dashboard** — `activeNavKey`
  (`app-sidebar.tsx:47`) maps `/tasks/$taskId` and `/tasks/new` to the
  任务控制台 (dashboard) item.
- **MobileNav 4 columns** — implemented in `mobile-nav.tsx`.
- **AccountMenu Escape + outside-click + aria-expanded** — provided by the
  shadcn/Radix `DropdownMenu`. **Minor note (non-blocking):** the
  `aria-expanded` attribute is injected by Radix's `DropdownMenuTrigger` via the
  `asChild`/Slot pattern (`account-menu.tsx:81`) rather than being explicitly
  written in the component code; Radix forwards it onto the trigger element, so
  the scenario assertion holds. This is a met-as-written behavior, not a gap
  that blocks the primary scenario.

## Gap finding (scope: met-as-written)

Re-tracing each requirement and scenario against the implementation, every
requirement has a traceable implementation and no requirement is unimplemented;
all scenarios across all three requirements map to existing code. The single
subtle point — that `aria-expanded` is contributed by Radix's `asChild` Slot on
`DropdownMenuTrigger` rather than being hand-written — does not block the
"account menu reflects state via `aria-expanded`" scenario, so it is folded in
as a met-as-written minor note rather than a defect.

## Scope findings (implemented behaviors that map to no spec requirement)

These are behaviors present in the implementation that no requirement in
`specs/frontend-console/spec.md` mandates. They are recorded here for
traceability; none indicates an unmet requirement. Most are honest, additive
resilience/UX affordances consistent with the change's intent (and several are
pre-existing machinery the pure-visual re-skin reused verbatim).

1. **Back-link crumb `← 任务控制台`** rendered as a `Link` above the H1. The
   spec's three header segments do not include a navigable back crumb.
   `apps/web/src/components/session/session-header.tsx:82-101`
2. **Task prompt** rendered as a click-to-expand truncated line (展开/收起) inside
   the header. The spec's three-segment header has no prompt/commit-message slot.
   `apps/web/src/components/session/session-header.tsx:110-124`
3. **Inline connection-state readout** (dot + 已连接/连接中) in the terminal-head
   alongside the `{agent}·{repo}#{branch}` label. The spec's terminal-head lists
   the label, ⋯ menu, and 全屏 button only.
   `apps/web/src/components/session/session-terminal.tsx:570-580`
4. **Non-blocking corner badge overlay** (`○ 正在连接…键入暂不发送`) inside the
   xterm viewport when the socket is not OPEN. The spec requires the typing-inert
   affordance but does not specify a corner overlay inside the PTY region.
   `apps/web/src/components/session/session-terminal.tsx:724-737`
5. **WebSocket auto-reconnect** with exponential full-jitter backoff (≤15
   attempts, 30 s cap) + a 12 s connect-watchdog. Resilient reconnect mechanics
   are unspecified. `apps/web/src/lib/ws-client.ts:63-77`
6. **Tab-visibility / network-online recovery** — eager `ensureConnected()` on
   `visibilitychange` + `online`. No requirement covers eager re-connect on
   focus/network return.
   `apps/web/src/components/session/session-terminal.tsx:407-420`
7. **15 s write-lease heartbeat** (`sendHeartbeat` on `setInterval`). The spec
   specifies the stop POST and lock-independent approval but not a recurring
   lease-renewal heartbeat.
   `apps/web/src/components/session/session-terminal.tsx:390-398`
8. **Fullscreen toggle icon** (expand ↔ compress) keyed off
   `document.fullscreenElement`. The spec requires a 全屏 button that calls
   `requestFullscreen` but does not require a toggle icon or exit state.
   `apps/web/src/components/session/session-terminal.tsx:641-657`
9. **Font-family from `--font-mono`** resolved client-only and applied to the
   xterm canvas. No terminal-typography requirement.
   `apps/web/src/components/session/session-terminal.tsx:228-229`
10. **Responsive font-size** (12 px ≤820 px, else 13 px) applied to xterm. Not
    mentioned in the spec.
    `apps/web/src/components/session/session-terminal.tsx:231-234`
11. **Topbar suppressed for `/tasks/:id`** (rendered `null`), kept for
    `/tasks/new`. The spec defines the three-segment header and the removed
    toolbar buttons, but does not specify conditionally hiding the shared Topbar.
    `apps/web/src/routes/_app.tsx:92-97`
12. **`invalidateQueries` on WS open** (`onConnectionChange → 'open'`). The spec
    requires bridging discrete control frames into the cache, not a blanket
    invalidation on socket-open.
    `apps/web/src/routes/_app/tasks/$taskId.tsx:142-151`
13. **PreRunningPlaceholder pulse dot** (`animate-pulse '○ {label}'`). The spec
    requires a friendly 排队中 / 沙箱启动中… state; the pulsing dot is an
    unspecified embellishment.
    `apps/web/src/routes/_app/tasks/$taskId.tsx:217-218`
14. **AccountMenu OAuth status dot + `⌄` caret glyph.** The spec mentions an
    OAuth-verified status dot (so the dot is in-scope), but the `⌄` mono caret is
    not specified. `apps/web/src/components/shell/account-menu.tsx:99-104`
15. **`sendResize` after `sendReconnect` on socket open** to sync PTY cols/rows.
    PTY resize-on-reconnect is not listed as a requirement.
    `apps/web/src/components/session/session-terminal.tsx:343-344`

None of the above changes the three-way tally: 0 reopened, 0 spec-defects, 3
reclassified-MET.
