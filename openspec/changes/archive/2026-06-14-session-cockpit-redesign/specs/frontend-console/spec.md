# frontend-console Spec Delta — session-cockpit-redesign

## MODIFIED Requirements

### Requirement: Session page design-revision layout
The `/tasks/$taskId` page SHALL adopt the COCKPIT layout as a MARKUP/LAYOUT/STYLE-ONLY reorganization: toolbar action behavior, input semantics, connection semantics, AND the approval surface SHALL NOT change — there is NO WebSocket-path delta in this change. The page body SHALL be composed as: (1) a THREE-SEGMENT header and (2) a single self-contained dark terminal window. The permission-request APPROVAL surface SHALL stay rendered INSIDE the terminal `<article>` exactly as it shipped previously; the page-level amber approval banner + the lift of `pending`/`decide` to the route are DEFERRED to a follow-up approval change (alongside the real `permission_request` flow + payload).

The THREE-SEGMENT header SHALL render, in this order:
- a TASK-STATUS H1 rendered as a dot+text Badge where the state is conveyed by BOTH the dot color AND the text label (never color-alone). The route drives the task LIFECYCLE states 运行中 / 已停止 / 失败 (all static dots) this phase; the Badge primitive also supports an in-flight 等待审批 state (animated pulse), reserved for the follow-up approval change that lifts the pending request;
- a TAG RAIL folding the deleted context strip into NON-INTERACTIVE chips for 分支 / Codex / AIO Sandbox / linux-amd64 / 守护栏, each rendered with a white background and a 1px ring (the amber 写入前确认 chip is DEFERRED to the follow-up approval change);
- a SINGLE 停止 action as the only header action, retaining the existing two-step (explicit confirm) stop semantics that POST to `POST /tasks/:taskId/stop`; the former 返回任务 / 复制会话记录 / 暂停输出 buttons SHALL NOT appear in the header (they fold into the terminal ⋯ menu or are dropped).

The permission-request APPROVAL surface SHALL remain INSIDE the terminal `<article>` exactly as it shipped previously (an in-terminal panel offering 允许 / 拒绝, resolved lock-independently). The page-level amber banner restyle + the lift of `pending`/`decide` to the route so deciding flips the page-level H1/statusline are DEFERRED to a follow-up approval change (which also wires the real `permission_request` flow + the diffstat/commits payload).

The self-contained dark TERMINAL WINDOW SHALL render inside a single `<article>` with: a three-segment dark terminal header keeping the `{agent} · {repo}#{branch}` label, a ⋯ overflow menu offering 复制 and 暂停滚动, and a 全屏 button that requests fullscreen via the element's `requestFullscreen` API; a full-width PTY scrollback region (the scrollback is intentionally NOT prose-width-constrained because it is log-scanning content); and a STATUSLINE footer appended inside the same `<article>` showing CPU·内存 plus a degraded phase. The terminal-head SHALL NOT display the hardcoded `pty: /dev/pts/4` line (or any pty path): no backend field backs it. The statusline phase SHALL degrade honestly to the task lifecycle label (a generic 运行中 for a live task) because the raw PTY exposes no semantic phase to parse (the 等待审批 phase lands with the follow-up approval change); CPU·内存 SHALL reuse the established 未运行/未采样 honest-render pattern rather than fabricating zeros.

The route SHALL preserve its established invariants — it remains the ONLY `ssr:false` route, the server renders the `pendingComponent` terminal skeleton, and raw terminal bytes continue to bypass the TanStack Query cache. This change introduces NO WebSocket input/connection/state-lift delta, so the cockpit reorganization is layout-only on the WS path; it SHALL nonetheless be confirmed against a live running backend session that the reorganized terminal still connects.

#### Scenario: Header renders three segments in order
- **WHEN** the operator opens the session page for a running task after the cockpit redesign
- **THEN** the header shows, in order, the task-status H1 Badge, the non-interactive tag rail, and a single 停止 action
- **AND** the header shows NO 返回任务, 复制会话记录, or 暂停输出 button

#### Scenario: Task-status H1 conveys state by dot plus text and never color alone
- **WHEN** the task is in any of the lifecycle states running / stopped / failed
- **THEN** the H1 Badge renders the matching label 运行中 / 已停止 / 失败 alongside its status dot, so the state is readable from the text even with color removed (the 等待审批 label is the Badge primitive's gate state, reserved for the follow-up approval change)

#### Scenario: Only the awaiting-input status animates (Badge primitive)
- **WHEN** the H1 Badge primitive renders the 等待审批 state (driven only by the follow-up approval change)
- **THEN** the dot pulses (animated), and for the 运行中, 已停止, and 失败 states the dot is static with no pulse animation

#### Scenario: Tag rail folds the context strip into non-interactive ring chips
- **WHEN** the header tag rail renders for a task
- **THEN** it shows the 分支 / Codex / AIO Sandbox / linux-amd64 / 守护栏 chips each with a white background and a 1px ring, and clicking any chip performs no navigation or action (the chips are non-interactive)

#### Scenario: Single stop action keeps two-step confirm semantics
- **WHEN** the operator activates the single header 停止 action for an active task and confirms the second step
- **THEN** the console POSTs to `POST /tasks/:taskId/stop`, the task transitions to `cancelled`, and the cached task entry is reconciled
- **AND** the 停止 action is inert/hidden for a task already in a terminal state

#### Scenario: Terminal window is self-contained with menu, fullscreen, and statusline
- **WHEN** the terminal window renders for a running task
- **THEN** a single `<article>` contains a dark terminal header showing the `{agent} · {repo}#{branch}` label with a ⋯ menu (复制 / 暂停滚动) and a 全屏 button, a full-width PTY scrollback region, and a statusline footer showing CPU·内存 and a phase, all within the same `<article>`
- **AND** activating 全屏 requests fullscreen via the element's `requestFullscreen` API

#### Scenario: Fabricated pty line is removed
- **WHEN** the terminal-head renders
- **THEN** it shows the `{agent} · {repo}#{branch}` label and no pty path value appears anywhere on the session page

#### Scenario: Statusline phase degrades honestly
- **WHEN** the statusline footer renders its phase
- **THEN** it shows the task lifecycle label (a generic 运行中 for a live task), never a fabricated semantic phase parsed from the raw PTY (the 等待审批 phase lands with the follow-up approval change)
- **AND** the CPU·内存 readout shows 未运行/未采样 when no live sample exists rather than fabricated zeros

#### Scenario: Session invariants survive the reorganization
- **WHEN** the route tree is built and the session page is server-rendered
- **THEN** `/tasks/$taskId` is still the only route with `ssr: false`, the server emits the `pendingComponent` skeleton without touching `window`, and raw output bytes still write directly to the terminal without entering the query cache

#### Scenario: The cockpit reorganization is confirmed against a live backend
- **WHEN** the cockpit layout reorganization is complete (no WebSocket input/connection/state-lift delta)
- **THEN** the reorganized session page is confirmed against a live running backend session to still connect its terminal (已连接) and render the cockpit off live REST data, before being marked complete

### Requirement: Session page renders the live terminal and controls
The `/tasks/$taskId` page SHALL be the ONLY client-only route (route option `ssr: false`): it SHALL render a `pendingComponent` terminal skeleton on the server (never touching `window`), and on the client mount the `<Terminal>` component, connect to the task's authenticated WebSocket via the reused `TerminalSocket`, render the raw byte stream directly to the terminal (raw bytes SHALL NOT pass through the TanStack Query cache), display the live connection status, and provide DIRECT 1:1 keystroke input typed straight into the live `<Terminal>` as the SOLE live-terminal input surface — the xterm `onData` path SHALL forward each keystroke verbatim (Enter as `\r`, arrows, Ctrl-C, backspace; clipboard pastes auto-wrapped in `ESC[200~`/`ESC[201~`) to the lease-gated keystroke channel, seizing the write lease on first input — with NO separate command-input box and NO delayed-carriage-return submit hack on the live path. The page SHALL provide a connection-state affordance so that typing while the socket is not OPEN is visibly inert rather than silently dropped, and SHALL focus the terminal on mount. The page SHALL show a live PER-TASK resource readout sourced from the per-task metrics read (`resource-metrics`): it SHALL show codex's OWN process CPU percent and memory as the PRIMARY figure with the container total as secondary/background context, labeled by the reading's `scope` (`process` vs the `container` fallback), replacing any hard-coded placeholder, and SHALL degrade honestly to "未运行/未采样" only when the task has no live sampled container rather than displaying fabricated zeros — a still-running task that merely missed a sampling tick SHALL keep showing its (possibly stale) reading, not flip to not-running. This per-task resource readout SHALL be presented in the terminal-window STATUSLINE footer (CPU·内存) rather than a separate context card. The page SHALL surface the task's CONFIGURED GUARDRAILS read back from the task (`idleTimeoutMs`/`deadlineMs`) as an honest readout (e.g. "空闲回收: 30 分钟 / 关闭", "运行时限: 2 小时 / 无"), reflecting the persisted values rather than fabricating them; this guardrail readout SHALL be presented via the header 守护栏 tag rather than a separate context-strip card. The page SHALL provide a manual stop control that, after an explicit operator confirmation, POSTs to `POST /tasks/:taskId/stop` to transition the task to `cancelled`, and on success reconciles the cached task entry; the control SHALL be inert/hidden for a task already in a terminal state. For a freshly-created task that has not yet reached `running` (status `pending`/`queued`, sandbox not yet provisioned), the page SHALL show a friendly early-state placeholder ("排队中 / 沙箱启动中…") driven by the task status, and SHALL transition to the live terminal once the task reaches `running`, so navigating into a just-created session never lands on a blank/confusing screen. The page SHALL also present an approval surface for pending `PermissionRequest` decisions; this approval surface SHALL stay rendered INSIDE the terminal window (the pre-existing in-terminal panel), resolved lock-independently (the page-level banner + the `pending`/`decide` lift are deferred to a follow-up approval change). Discrete control frames (task completion, lease/write-lock changes, approval decisions) SHALL be bridged back into the query cache via `queryClient.setQueryData(['tasks', id], …)` or invalidation. The WebSocket handshake SHALL authenticate via the existing token query parameter plus `bearer.<token>` subprotocol (browsers cannot set an `Authorization` header on WS) and SHALL NOT attempt to set request headers.

#### Scenario: Session page streams the live terminal
- **WHEN** the operator opens `/tasks/$taskId` for a running task
- **THEN** the client connects the WebSocket and writes the task's live byte stream directly to the `<Terminal>` component without routing raw bytes through the query cache

#### Scenario: Session page shows codex's own CPU and memory with scope
- **WHEN** the operator views `/tasks/$taskId` for a `running` task
- **THEN** the page shows codex's OWN process CPU percent and memory as the primary figure (with the container total as background context), labeled by the reading's `scope`, in the terminal statusline footer, not a hard-coded placeholder and not silently the global aggregate

#### Scenario: Per-task resource degrades honestly when not running
- **WHEN** the task has no live sampled container (not running yet, or genuinely exited)
- **THEN** the per-task resource readout shows "未运行/未采样" rather than fabricated zeros

#### Scenario: A still-running task does not flicker to not-running on a missed tick
- **WHEN** the open task is still running but its latest per-task read carried forward a stale reading (a sampling tick was missed)
- **THEN** the readout keeps showing the (possibly stale) CPU/memory figure rather than flipping to "未运行/未采样"

#### Scenario: Session page shows the task's configured guardrails
- **WHEN** the operator views a task that was created with an `idleTimeoutMs` and/or `deadlineMs` (or neither)
- **THEN** the page shows the configured idle-reclaim and deadline values read back from the task (showing "关闭"/"无" when a value is absent) via the header 守护栏 tag, never fabricating a value that was not set

#### Scenario: Operator stops a task from the session page
- **WHEN** the operator activates the stop control for an active task and confirms
- **THEN** the console POSTs to `POST /tasks/:taskId/stop`, the task transitions to `cancelled`, and the cached task entry is reconciled so other views reflect the new status
- **AND** the control is inert/hidden for a task already in a terminal state

#### Scenario: Freshly created task shows a friendly pre-running placeholder
- **WHEN** the operator lands on `/tasks/$taskId` for a task still in `pending`/`queued` (sandbox not yet provisioned)
- **THEN** the page shows a friendly "排队中 / 沙箱启动中…" state and transitions to the live terminal once the task reaches `running`, instead of a blank or stuck "正在连接" screen

#### Scenario: Direct xterm typing is the sole live input and Enter submits
- **WHEN** the operator types into the live terminal and presses Enter
- **THEN** each keystroke is forwarded verbatim through the xterm `onData` path to the lease-gated keystroke channel (the write lease is seized on first input), and Enter is delivered as `\r` so the agent composer submits — with no separate command-input box and no delayed-carriage-return hack mediating the live path

#### Scenario: Typing into a non-deliverable socket is visibly inert
- **WHEN** the operator types while the WebSocket is not OPEN (closed/reconnecting/errored)
- **THEN** the page shows a connection-state affordance making the terminal visibly inert, rather than silently discarding the keystrokes

#### Scenario: Session route is server-rendered as a skeleton only
- **WHEN** the server renders `/tasks/$taskId`
- **THEN** it emits the terminal `pendingComponent` skeleton and accesses no `window`/browser-only globals, and the live terminal is constructed only after client hydration in an effect

#### Scenario: Pending approval surfaces on the session page
- **WHEN** a `PermissionRequest` is pending for the open task
- **THEN** the page shows the in-terminal approval panel offering allow/deny, and submitting a decision resolves it independently of the write lock

#### Scenario: Control frame bridges back into the query cache
- **WHEN** a control frame indicating task completion or a lease change arrives over the WebSocket
- **THEN** the console updates the cached task entry via `queryClient.setQueryData`/invalidation so other views reflect the new status, while raw output bytes remain out of the cache

#### Scenario: Terminal falls back when xterm is unavailable
- **WHEN** the xterm runtime is unavailable on the client
- **THEN** the session page renders a fallback DOM line view (terminal-line dim/ok/warn) plus a command input row (the fallback path retains a line input because there is no live terminal to type into) instead of crashing

### Requirement: Shared authenticated app-shell and navigation
The pathless `_app` layout SHALL render the shared app-shell for all six app pages: a shadcn `SidebarProvider` + `Sidebar` of width 228px (brand mark; navigation items 任务控制台 / 仓库导入 / 历史日志 with ⌘1/⌘2/⌘3 mono hints), a `SidebarInset`, a sticky blurred `Topbar` (breadcrumb eyebrow + right-side action slot), an `AccountMenu` (Avatar with `TH` initials + DropdownMenu offering 打开设置/退出登录 + an OAuth-verified status dot, shared by desktop and mobile), and a `MobileNav` (fixed bottom bar of 4 columns 控制台/仓库/历史/账户, hidden on desktop). The sidebar's ACTIVE navigation item SHALL be indicated by a Geist-style LEFT VERTICAL ACCENT BAR on the active item — NOT a solid dark pill background. Navigation active highlighting SHALL map `/tasks/$taskId` (session) and `/tasks/new` (create) back to the 任务控制台 (dashboard) item using router state. The `AccountMenu` SHALL close on `Escape` and outside-click and expose `aria-expanded`.

#### Scenario: App pages render the full shell with the 228px sidebar
- **WHEN** any `_app` page renders on a desktop viewport
- **THEN** it shows the sidebar at 228px width, the sticky topbar, and the account menu, with the matching sidebar item highlighted by a left vertical accent bar

#### Scenario: Active item uses a left accent bar, not a dark pill
- **WHEN** a sidebar navigation item is the active item
- **THEN** it renders a left vertical accent bar as its active indicator and does NOT render a solid dark pill background

#### Scenario: Session and create routes highlight dashboard
- **WHEN** the operator is on `/tasks/$taskId` or `/tasks/new`
- **THEN** the sidebar highlights the 任务控制台 (dashboard) navigation item with the left accent bar

#### Scenario: Mobile shows the bottom navigation
- **WHEN** an `_app` page renders below the mobile breakpoint
- **THEN** the fixed bottom `MobileNav` with 控制台/仓库/历史/账户 appears and the 账户 entry opens the same `AccountMenu`

#### Scenario: Account menu is keyboard and click dismissible
- **WHEN** the `AccountMenu` is open
- **THEN** pressing `Escape` or clicking outside closes it, and its trigger reflects state via `aria-expanded`
