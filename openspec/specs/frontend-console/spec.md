# frontend-console Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Maintained component library package
`packages/ui` SHALL provide a shadcn/ui + Tailwind v4 based component library consumed by `apps/web` via `workspace:*`, and SHALL include a reusable `<Terminal>` component wrapping xterm.js with the fit, serialize, and unicode11 addons configured. `apps/web` SHALL NOT inline its own copy of these shared primitives. Both `packages/ui` and `apps/web` SHALL consume a SINGLE design-token contract (the CSS custom properties defined once in `apps/web/src/styles/app.css`); `packages/ui` styles SHALL be migrated off the legacy Tailwind v3 three-directive + HSL form so shared `Button`/`Card`/`Badge`/`Terminal` render with the same color board as new console pages and never visually diverge ("脱色").

#### Scenario: Web app consumes shared components
- **WHEN** `apps/web` renders a button, card, badge, or the terminal surface
- **THEN** it imports them from `packages/ui` rather than redefining them locally

#### Scenario: Terminal component wraps xterm with required addons
- **WHEN** the `<Terminal>` component mounts
- **THEN** it instantiates an xterm.js terminal with the fit, serialize, and unicode11 addons loaded

#### Scenario: Shared package and app share one token contract
- **WHEN** a `packages/ui` component and an `apps/web` console page both render on the same screen
- **THEN** both resolve their colors, radii, and shadows from the same CSS variables defined in `apps/web/src/styles/app.css`
- **AND** changing a token value in that single source updates both surfaces consistently with no per-package divergence

### Requirement: Session page renders the live terminal and controls
The `/tasks/$taskId` page SHALL be the ONLY client-only route (route option `ssr: false`): it SHALL render a `pendingComponent` terminal skeleton on the server (never touching `window`), and on the client mount the `<Terminal>` component, connect to the task's authenticated WebSocket via the reused `TerminalSocket`, render the raw byte stream directly to the terminal (raw bytes SHALL NOT pass through the TanStack Query cache), display the live connection status, and provide DIRECT 1:1 keystroke input typed straight into the live `<Terminal>` as the SOLE live-terminal input surface — the xterm `onData` path SHALL forward each keystroke verbatim (Enter as `\r`, arrows, Ctrl-C, backspace; clipboard pastes auto-wrapped in `ESC[200~`/`ESC[201~`) to the lease-gated keystroke channel, seizing the write lease on first input — with NO separate command-input box and NO delayed-carriage-return submit hack on the live path. The page SHALL provide a connection-state affordance so that typing while the socket is not OPEN is visibly inert rather than silently dropped, and SHALL focus the terminal on mount. The page SHALL show a live PER-TASK resource readout sourced from the per-task metrics read (`resource-metrics`): it SHALL show codex's OWN process CPU percent and memory as the PRIMARY figure with the container total as secondary/background context, labeled by the reading's `scope` (`process` vs the `container` fallback), replacing any hard-coded placeholder, and SHALL degrade honestly to "未运行/未采样" only when the task has no live sampled container rather than displaying fabricated zeros — a still-running task that merely missed a sampling tick SHALL keep showing its (possibly stale) reading, not flip to not-running. This per-task resource readout SHALL be presented in the terminal-window STATUSLINE footer (CPU·内存) rather than a separate context card. The page SHALL surface the task's CONFIGURED GUARDRAILS read back from the task (`idleTimeoutMs`/`deadlineMs`) as an honest readout (e.g. "空闲回收: 30 分钟 / 关闭", "运行时限: 2 小时 / 无"), reflecting the persisted values rather than fabricating them; this guardrail readout SHALL be presented via the header 守护栏 tag rather than a separate context-strip card. The page SHALL provide a manual stop control that, after an explicit operator confirmation, POSTs to `POST /tasks/:taskId/stop` to transition the task to `cancelled`, and on success reconciles the cached task entry; the control SHALL be inert/hidden for a task already in a terminal state. For a freshly-created task that has not yet reached `running` (status `pending`/`queued`, sandbox not yet provisioned), the page SHALL show a friendly early-state placeholder ("排队中 / 沙箱启动中…") driven by the task status, and SHALL transition to the live terminal once the task reaches `running`, so navigating into a just-created session never lands on a blank/confusing screen. The page SHALL also present an approval surface for pending `PermissionRequest` decisions; this approval surface SHALL stay rendered INSIDE the terminal window (the pre-existing in-terminal panel), resolved lock-independently (the page-level banner + the `pending`/`decide` lift are deferred to a follow-up approval change). Discrete control frames (task completion, lease/write-lock changes, approval decisions) SHALL be bridged back into the query cache via `queryClient.setQueryData(['tasks', id], …)` or invalidation. The WebSocket handshake SHALL authenticate via the existing token query parameter plus `bearer.<token>` subprotocol (browsers cannot set an `Authorization` header on WS) and SHALL NOT attempt to set request headers.

For a RUNNING interactive task, the page SHALL offer a view switch between 实时终端 and 对话记录. 实时终端 SHALL remain the only live xterm/WS input and takeover surface. 对话记录 SHALL poll the same `GET /tasks/:id/session-history` live transcript used by headless tasks and render the ordered rollout-derived conversation via `session-replay`, without opening a second terminal WebSocket and without reconstructing history from raw xterm bytes.

When the open task is in a TERMINAL lifecycle state (`completed`, `cancelled`, or `failed`), the page SHALL NOT open a live WebSocket and SHALL instead render a READ-ONLY session-history replay branch sourced from the `GET /tasks/:id/session-history` endpoint (`session-history-replay`). On the terminal-state branch the page SHALL request session history via a dedicated TanStack Query key `queryKeys.sessionHistory(id)` driving a `sessionHistoryQuery`, with `real.getSessionHistory` validating the response against the `@cap/contracts` `SessionHistoryResponse` schema with a Zod `.parse` before render and a mock fallback selected by the existing capability flag, mirroring the established per-task metrics real/mock seam (no raw bytes enter the query cache on this branch either). The terminal-state branch SHALL present the parsed rollout transcript as the PRIMARY replay source and `session.log` cold-replay as the SECONDARY replay source, and SHALL render NO live-input surface and NO stop/resume control because a terminal task is already non-operable (`canStop` is false). When the session-history response discriminates to an honest EMPTY/degraded state (agent-failed-to-start, provision-failed with no rollout, or expired/reaped), the page SHALL render an honest empty card carrying the reason rather than a fabricated transcript. The live-terminal path (WebSocket connect, xterm input, lease, approval surface, statusline) is UNCHANGED for non-terminal tasks; only the terminal-state branch gains the read-only replay.

#### Scenario: Session page streams the live terminal
- **WHEN** the operator opens `/tasks/$taskId` for a running task
- **THEN** the client connects the WebSocket and writes the task's live byte stream directly to the `<Terminal>` component without routing raw bytes through the query cache

#### Scenario: Running interactive task exposes ordered conversation history
- **WHEN** the operator opens `/tasks/$taskId` for a running `interactive-pty` task
- **THEN** the page offers 实时终端 for live xterm control and 对话记录 for the polled rollout-derived conversation
- **AND** the 对话记录 view does not reconstruct ordered history from raw xterm bytes

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

#### Scenario: Terminal-state task renders the read-only replay instead of a live socket
- **WHEN** the operator opens `/tasks/$taskId` for a task in a terminal lifecycle state (`completed`, `cancelled`, or `failed`)
- **THEN** the page does NOT open a live WebSocket and instead renders the read-only session-history replay branch driven by `GET /tasks/:id/session-history`, with the parsed rollout transcript as the primary source and `session.log` cold-replay as the secondary source

#### Scenario: Session-history data uses the real/mock contract seam
- **WHEN** the terminal-state branch requests session history
- **THEN** it uses `queryKeys.sessionHistory(id)` + `sessionHistoryQuery`, with `real.getSessionHistory` validating the payload against the `@cap/contracts` `SessionHistoryResponse` schema via Zod `.parse` and a mock fallback selected by the capability flag, mirroring the per-task metrics seam

#### Scenario: Terminal-state replay exposes no operation controls
- **WHEN** the read-only replay branch renders for a terminal task
- **THEN** it presents no live-input surface, no resume-run control, and no stop control, because the terminal task is already non-operable (`canStop` is false)

#### Scenario: Empty/degraded session-history renders an honest card
- **WHEN** the session-history response discriminates to an empty state (agent-failed-to-start, provision-failed with no rollout, or expired/reaped)
- **THEN** the page renders an honest empty card carrying the reason (e.g. "会话未能启动" with the failure reason, or "会话记录已过期" for an aged-out record) rather than a fabricated transcript

### Requirement: Dashboard lists tasks as a fleet
The `/dashboard` page (mounted under the authenticated app-shell layout) SHALL be the post-login default landing surface, presenting tasks read from `GET /tasks` via TanStack Query as an ATTENTION-FIRST INBOX with status-differentiated row actions. The page SHALL NOT render the former 4-tile operations status bar (`MetricStrip`); its information is carried by the inbox tab counts and the capacity-modern pool panel instead (the removal is an accepted, pre-made decision, not an omission).

Each inbox row's action SHALL be derived from the SINGLE exhaustive status→presentation mapping in `task-status.ts`, which SHALL cover every member of the `TaskStatus` union so that a status without a mapped action fails type-checking: an awaiting-input task gets the PRIMARY 处理输入 action; a running task gets the 接管会话 action; a successfully terminal task gets a ghost 查看记录 action; a failed task gets a ghost 查看错误 action; a queued/pending task gets a NON-PRIMARY, STILL-CLICKABLE 等待 runner affordance that is a REAL link into `/tasks/$taskId` (landing on the pre-running placeholder). The queued/pending affordance SHALL NOT carry `disabled` or `aria-disabled` — this explicitly overturns the prior `connectable: false` mapping. Awaiting-input rows SHALL sort to the top and render the alert-gradient needs-input row treatment. The toolbar SHALL provide a client-side search and a status SegmentedControl with tabs 全部/待处理/运行/排队, each tab carrying a live `CountChip` count embedded through the existing SegmentedControl ReactNode label (no SegmentedControl API change); filtering SHALL stay client-side (`useMemo`-derived, not written to the query cache).

In place of the former Agent-capacity aside, the page SHALL render the `capacity-modern` pool panel composed of: a pool-hero whose online/ceiling figure (e.g. "7/10 在线" — sample data in the design, never a constant) is computed CLIENT-SIDE from the live ceiling and occupancy; a NUMBERED slot grid (cells labeled 01–NN, zero-padded) whose cell count derives from `occupancy.slots.length` for any configured ceiling in 1–20 — never a hardcoded ten-slot layout, preserving the four archived configurable-task-slots decisions which SHALL NOT be relitigated; a pool-lane (空闲→已分配→可接管); per-runner resource rows formed by a CLIENT-SIDE JOIN of `occupancy.slots[].taskId` × the per-task resource samples carried in the `/metrics` payload × the tasks query (repo/title/status); and a pool-policy block. A slotted task without an available sample SHALL degrade honestly to a 未运行/未采样 readout, never fabricated zeros. ALL pool-panel data SHALL be consumed through the EXISTING `metricsQuery` (5-second `refetchInterval`, `select` projection) plus the existing tasks query — ONE metrics poll, with NO per-task `GET /tasks/:taskId/metrics` fan-out from the dashboard and NO SSE connection. Every metrics field the panel consumes SHALL be mirrored in `mock.ts` and `real.ts` in lockstep under one zod contract type, and the mock metrics path SHALL use the same default ceiling as the backend default (5) so the mock and real renders agree. The dashboard's mobile layout (`mobile-inbox` rules) SHALL apply on the established ≤820px CSS breakpoint convention. The task loader SHALL prefetch tasks and repos via `ensureQueryData` to avoid request waterfalls, and the task list query SHALL poll on a 5-second `refetchInterval` (with `refetchIntervalInBackground: true` if continuous background polling is required).

#### Scenario: Dashboard renders the inbox without the MetricStrip
- **WHEN** the operator opens `/dashboard`
- **THEN** the page lists tasks from `GET /tasks` as inbox rows and renders NO 4-tile MetricStrip/ops-status-bar — the tab counts and the capacity-modern pool panel are the only aggregate readouts on the page

#### Scenario: Row actions are status-differentiated from one exhaustive mapping
- **WHEN** the inbox renders rows for tasks in awaiting-input, running, successfully terminal, and failed states
- **THEN** the awaiting-input row shows the primary 处理输入 action, the running row shows 接管会话, the successful row shows a ghost 查看记录, and the failed row shows a ghost 查看错误 — all derived from the single `task-status.ts` mapping
- **AND** the mapping covers every `TaskStatus` union member, so removing a status's action entry fails the type-check

#### Scenario: Queued rows stay navigable, never disabled
- **WHEN** a queued or pending task renders its inbox row
- **THEN** its 等待 runner affordance is a real link to `/tasks/$taskId`, styled non-primary, carrying neither `disabled` nor `aria-disabled`, and activating it lands on the task's pre-running placeholder

#### Scenario: Needs-input rows are prioritized with the alert treatment
- **WHEN** the task list contains a task awaiting input
- **THEN** that row is sorted to the top and rendered with the alert-gradient needs-input row background

#### Scenario: Tab counts are live and filtering stays client-side
- **WHEN** the operator selects a tab among 全部/待处理/运行/排队 or the underlying task list changes
- **THEN** each tab's CountChip shows the live count for its status group, the list filters client-side (derived via `useMemo`, not cached), and the SegmentedControl component API is unchanged (counts ride the existing ReactNode label)

#### Scenario: Pool hero is computed from live data, not the design sample
- **WHEN** the metrics payload reports a ceiling of M slots with N busy
- **THEN** the pool-hero shows the N/M online figure computed client-side from that payload, never the design's literal 7/10 sample values

#### Scenario: Slot grid sizes to the live ceiling
- **WHEN** the dashboard renders while the metrics occupancy reports a ceiling of M slots (any M in 1–20)
- **THEN** the capacity-modern panel renders exactly M numbered slot cells (01 through the zero-padded value of M) derived from `occupancy.slots.length`, with no hardcoded ten-slot grid, and the pool-hero ceiling shows M

#### Scenario: Per-runner rows join one metrics poll with the tasks query
- **WHEN** running tasks occupy slots and the dashboard renders the per-runner resource rows
- **THEN** each row shows the task's repo/title/status (from the tasks query) joined client-side with that task's CPU/MEM sample carried inside the single `/metrics` response, and the dashboard issues no `GET /tasks/:taskId/metrics` request and opens no SSE connection

#### Scenario: Per-runner rows degrade honestly
- **WHEN** a slotted task has no available resource sample in the metrics payload
- **THEN** its per-runner row shows the 未运行/未采样 honest readout rather than fabricated zero CPU/MEM values

#### Scenario: Mock and real metrics stay in lockstep
- **WHEN** the metrics capability is served by the mock path
- **THEN** the mock payload mirrors every field the pool panel consumes under the same zod contract type as `real.ts`, and its default ceiling is 5, matching the backend default

#### Scenario: Mobile inbox engages at the established breakpoint
- **WHEN** the dashboard renders at a viewport width of 820px or below
- **THEN** the `mobile-inbox` layout rules apply via the max-[820px] CSS convention, and at 821px and above the desktop inbox layout renders

#### Scenario: Task list polls for fresh status
- **WHEN** the dashboard is mounted
- **THEN** the task query refetches every 5 seconds so statuses stay current without a manual reload

### Requirement: New task creation from the console
The console SHALL provide BOTH a modal (on `/dashboard`) and a full-page form (`/tasks/new`) to create a task, sharing the same form, live command preview, and submit logic. The form SHALL select a registered repo (options from `GET /repos`, restricted to imported repos as the security scope), a branch, an execution strategy, an OPTIONAL multi-select of SKILLS to preinstall (e.g. OpenSpec, BMAD — options from a static catalog matching the server-side skill allowlist), an OPTIONAL idle-timeout control ("空闲自动回收") that DEFAULTS TO OFF, an OPTIONAL deadline control ("运行时限") that DEFAULTS TO none, and a prompt/description (with a live client-side word count), default the "破坏性写入前停止" checkbox to checked, and render a side preflight (3 ReviewStep cards complete/warn) plus a live `agentctl` `CommandPreview` derived from form state (including the selected skills, idle timeout, and deadline). The idle-timeout and deadline controls SHALL offer human-friendly choices (e.g. off/none plus preset durations and/or a custom value) and submit their values as integer milliseconds (`idleTimeoutMs`, `deadlineMs`); selecting "off"/"none" SHALL submit no value for that field so the task is created with no idle ceiling / no deadline. Submission SHALL POST to `POST /repos/:repoId/tasks` via a `createTaskMutation`, sending the selected skill ids and the `idleTimeoutMs`/`deadlineMs` values when set; on success it SHALL NAVIGATE the operator directly into the created task's session (`/tasks/$taskId`) using the `id` from the create response — rather than only surfacing a deep link the operator must click — persist `selectedRepo`/`branch`/`latestRunId` to local store, invalidate the tasks query, and emit a Sonner toast as a transient confirmation. On navigation the dashboard modal SHALL close (it unmounts with the route change). The console SHALL render branch and strategy controls even though the current backend treats them as inert run parameters; the page SHALL NOT misrepresent unsent/unread fields as confirmed task state. An empty skill selection submits no `skills` and preserves the no-preinstall behavior; an off idle control and a none deadline preserve the no-reclaim / no-deadline behavior.

#### Scenario: Operator creates a task from the dashboard modal
- **WHEN** the operator submits the new-task modal with a repo, branch, strategy, and prompt
- **THEN** the console POSTs to `POST /repos/:repoId/tasks` and, on success, navigates directly into the created task's `/tasks/$taskId` session (the modal closing as it unmounts) and invalidates the task list

#### Scenario: Full-page create mirrors the modal
- **WHEN** the operator opens `/tasks/new` and submits the form
- **THEN** it uses the same shared form, command preview, and `createTaskMutation` as the dashboard modal and, on success, navigates directly into the created task's `/tasks/$taskId` session

#### Scenario: Operator selects skills to preinstall
- **WHEN** the operator selects one or more skills (e.g. OpenSpec) in the create form and submits
- **THEN** the create body includes the selected skill ids in its `skills` field, and the command preview reflects the selected skills
- **AND** an empty skill selection submits no `skills` (or an empty list) and preserves the prior no-preinstall behavior

#### Scenario: Idle-timeout control defaults to off and is opt-in
- **WHEN** the operator opens the create form without touching the idle-timeout control and submits
- **THEN** the create body sends no `idleTimeoutMs` and the task is created with no idle reclamation
- **AND** when the operator instead chooses an idle-timeout value, the create body sends that value as integer milliseconds in `idleTimeoutMs` and the command preview reflects it

#### Scenario: Deadline control defaults to none and is opt-in
- **WHEN** the operator opens the create form without touching the deadline control and submits
- **THEN** the create body sends no `deadlineMs` and the task is created with no deadline
- **AND** when the operator instead chooses a deadline value, the create body sends that value as integer milliseconds in `deadlineMs` and the command preview reflects it

#### Scenario: Skill options come from the allowlisted catalog
- **WHEN** the skill multi-select is populated
- **THEN** its options come from a static catalog matching the server-side skill allowlist, so the operator cannot select a skill the orchestrator would not execute

#### Scenario: Command preview reacts to form state
- **WHEN** the operator edits any field of the create form (including the idle timeout or deadline)
- **THEN** the `CommandPreview` recomputes the `agentctl` command from form state and the word count updates, both as `useMemo`-derived values not stored in the query cache

#### Scenario: Repo options are scoped to imported repos
- **WHEN** the repo select is populated
- **THEN** its options come from `GET /repos` (the imported set) and no repo outside the imported scope is selectable

### Requirement: Configurable cross-origin API and WebSocket endpoints
`apps/web` SHALL read the API base URL and WebSocket URL from Vite environment configuration (`VITE_API_BASE_URL` / `VITE_WS_URL`, migrated from the prior `NEXT_PUBLIC_*` names) via `import.meta.env`, SHALL NOT assume the api is same-origin, and SHALL document them in `.env.example` alongside `VITE_AUTH_TOKEN`. The reused `config.ts`, `api-client.ts` (now `lib/api/real.ts`), and `ws-client.ts` (`TerminalSocket`) SHALL read endpoints from this configuration so a Vercel web-only deploy can target a separate Fly/compose api origin.

#### Scenario: Web targets a cross-origin api
- **WHEN** `VITE_API_BASE_URL`/`VITE_WS_URL` point at a different origin than the web app
- **THEN** the console issues its REST and WebSocket calls to that configured origin rather than its own

#### Scenario: Env names are migrated to the Vite convention
- **WHEN** the console reads its endpoint configuration
- **THEN** it resolves `VITE_API_BASE_URL`/`VITE_WS_URL`/`VITE_AUTH_TOKEN` via `import.meta.env` and no longer references `NEXT_PUBLIC_*` variables

### Requirement: TanStack Start application shell and build
`apps/web` SHALL be a TanStack Start application built with Vite (Vinxi-free, Vite-native), with the build plugin order `tailwindcss()` → `tanstackStart({ srcDirectory: 'src' })` → `viteReact()` → `nitro()` (this order is load-bearing; mis-ordering breaks the build). It SHALL remove all Next.js artifacts (`next.config.mjs`, `next-env.d.ts`, the Next-shaped `vercel.json`, and the `next` dependency) and SHALL define a `__root` route providing `<HeadContent>`/`<Outlet>`/`<Scripts>`, injecting the compiled `app.css`, mounting a Sonner `<Toaster>`, and running a theme pre-hydration inline script to set the `.dark` class before paint (avoiding FOUC). The router SHALL be created by a per-request `getRouter()` factory that constructs a NEW `QueryClient` per request (never a module singleton, to avoid cross-user SSR state leakage), creates the router with `{ queryClient }` context, and wires `setupRouterSsrQueryIntegration`. The TanStack Start version SHALL be pinned exactly (RC channel).

#### Scenario: App boots on TanStack Start without Next artifacts
- **WHEN** the repository is built
- **THEN** there is no `next` dependency, no `next.config.mjs`/`next-env.d.ts`/Next-shaped `vercel.json`, and `pnpm --filter @cap/web build` (a Vite build) succeeds

#### Scenario: Per-request QueryClient prevents state leakage
- **WHEN** two SSR requests are served
- **THEN** each request obtains its own `QueryClient` from `getRouter()` so no query cache state leaks across users or requests

#### Scenario: Root route prevents theme FOUC
- **WHEN** a server-rendered page hydrates
- **THEN** the `__root` inline theme script has already applied the correct `.dark`/light class before paint, the `<Toaster>` is mounted, and `app.css` is present in the document head

### Requirement: Ten-page route tree with correct layout assignment
The console SHALL implement exactly the ten prototype pages with the following routes and layout assignment. Standalone routes (no app-shell, landing-nav where applicable, server-rendered): `/` (营销落地 Landing), `/login` (GitHub 授权登录 gate), `/workspace` (工作区总览 Launcher), `/resume` (继续处理 Handoff). App-shell routes under the pathless `_app` layout: `/dashboard` (任务控制台), `/tasks/new` (创建任务), `/tasks/$taskId` (实时会话, the only `ssr:false` route), `/repositories` (仓库导入), `/history` (历史与日志), `/settings` (设置). The prototype's two pages that both claimed `/` are resolved as Landing=`/`, Launcher=`/workspace`, Resume=`/resume`. Every page SHALL faithfully reproduce its prototype layout and SHALL keep the prototype's Chinese (full-width punctuation) UI copy verbatim.

#### Scenario: All ten routes are reachable with correct chrome
- **WHEN** the operator navigates to each of `/`, `/login`, `/workspace`, `/resume`, `/dashboard`, `/tasks/new`, `/tasks/$taskId`, `/repositories`, `/history`, `/settings`
- **THEN** each route resolves; `/`, `/login`, `/workspace`, `/resume` render without the app-shell, and `/dashboard`, `/tasks/new`, `/tasks/$taskId`, `/repositories`, `/history`, `/settings` render inside the `_app` app-shell layout

#### Scenario: Standalone landing-family pages share landing-nav
- **WHEN** `/`, `/workspace`, or `/resume` renders
- **THEN** it shows the standalone landing-nav (brand mark + anchors + single CTA) and not the sidebar/topbar app-shell

#### Scenario: Chinese prototype copy is preserved
- **WHEN** any page renders its labels and headings
- **THEN** the Chinese UI copy (including full-width punctuation) from the prototype appears verbatim

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

### Requirement: Client auth gate on the app-shell
The `_app` layout SHALL enforce an authentication gate in `beforeLoad`: an unauthenticated visitor to any app-shell route SHALL be redirected to `/login`, CARRYING the attempted app path as a `redirect` search param (e.g. `/login?redirect=/tasks/abc`) so the post-login flow can return the operator to where they were headed. Authentication state SHALL be read through the auth session source (real backend session when the auth capability is enabled per the capabilities switch, otherwise the client token gate). The gate SHALL fire on a DIRECT page load / refresh / deep-link, not only on in-app soft navigation — because `beforeLoad` does NOT re-run on the client during hydration of a direct load. When the auth capability is enabled, the gate SHALL therefore resolve the session on the SERVER (forwarding the browser session cookie during SSR) as well as on the client, and SHALL treat the backend's HTTP 401 for an unauthenticated `/auth/session` as the logged-out signal (resolved to a null session) so it redirects cleanly rather than rendering a degraded shell or a raw error page; when the auth capability is disabled (local mock gate) the decision MAY be deferred to the client because the mock signal is not server-readable. When the resolved session belongs to an account with `mustChangePassword` set, the gate SHALL route the operator into a forced password-change flow instead of rendering the app-shell, granting console access only after the password is changed. Sign-out from the `AccountMenu` SHALL clear the session and navigate to the public landing `/` (NOT `/login`), because the landing is the logged-out home. Because backend tasks run under a host-root docker.sock model, this gate is a load-bearing security boundary and the console SHALL NOT render app-shell content to an unauthenticated visitor.

#### Scenario: Unauthenticated visitor is redirected with the attempted path
- **WHEN** an unauthenticated visitor requests an `_app` route (e.g. `/tasks/abc`)
- **THEN** `beforeLoad` redirects them to `/login` before any app-shell content renders, carrying the attempted path as a `redirect` search param

#### Scenario: Gate fires on a direct load / refresh / deep-link, not only soft navigation
- **WHEN** an unauthenticated visitor opens or refreshes an `_app` URL directly (e.g. pasting `/tasks/abc`, or hard-refreshing `/dashboard`) with the auth capability enabled
- **THEN** the gate resolves the session server-side (forwarding the session cookie on SSR, mapping the backend 401 to a null session) and redirects to `/login` carrying the attempted path BEFORE the app-shell or any per-page data loader renders — it does NOT render a degraded shell with failed data, nor a raw 401 error page

#### Scenario: Pending password change routes to the forced-change flow
- **WHEN** an authenticated operator whose account has `mustChangePassword` set opens an `_app` route
- **THEN** the gate presents the forced password-change flow instead of the app-shell, and only after the password is changed does console access proceed

#### Scenario: Sign-out returns to the landing
- **WHEN** the operator chooses 退出登录 in the `AccountMenu`
- **THEN** the session is cleared and the console navigates to the public landing `/` rather than `/login`

#### Scenario: Authenticated operator reaches the dashboard
- **WHEN** an authenticated operator opens an `_app` route
- **THEN** the gate allows it and the app-shell content renders

#### Scenario: Gate preserves the attempted destination for post-login return
- **WHEN** the gate bounces an unauthenticated visitor from a specific app route and the visitor subsequently completes login
- **THEN** the carried `redirect` path is threaded through the login flow so the operator is returned to that destination after authentication (subject to the open-redirect guard defined in `multi-user-oauth`), rather than always landing on a fixed page

### Requirement: Unified TanStack Query data layer with real/mock capability switch
ALL page data SHALL be read through TanStack Query `queryOptions` factories in `src/lib/api/queries.ts`, where each `queryFn` selects between `real.ts` and `mock.ts` based on a single `BACKEND_CAPABILITIES` flag map in `src/lib/api/capabilities.ts` (`tasks`/`repos`/`createTask` enabled; `auth`/`metrics`/`history`/`settings`/`githubImport`/`branches` flags toggle as those backend capabilities land). Loaders SHALL share these factories via `ensureQueryData` so prefetch and component reads use the same query keys. Mock modules SHALL be typed against `@cap/contracts` (`Repo`/`Task`/`TaskStatus`) as their base, extending with local view types for backend-absent fields, and SHALL apply a realistic `delay()` to mirror the prototype's async cadence. Switching a domain from mock to real SHALL require only flipping its capability flag and adding the corresponding `real.ts` function — no change to component code. Derived view state (command preview, word count, client search/level/status filters) SHALL be computed with `useMemo` and SHALL NOT enter the query cache.

#### Scenario: Components never branch on real vs mock
- **WHEN** a page component reads data
- **THEN** it consumes a `queryOptions` factory by query key and the real/mock decision happens entirely inside that factory's `queryFn` via `BACKEND_CAPABILITIES`

#### Scenario: Flipping a capability flag switches the data source
- **WHEN** a domain's flag in `BACKEND_CAPABILITIES` is toggled from `false` to `true` and its `real.ts` function exists
- **THEN** the corresponding query returns real backend data with no change to component or loader code

#### Scenario: Loaders and components share query keys
- **WHEN** a route loader prefetches data via `ensureQueryData`
- **THEN** the component reading the same `queryOptions` factory resolves from cache without a duplicate request

#### Scenario: Derived state stays out of the cache
- **WHEN** the operator types into a search field or edits the create form
- **THEN** the resulting filtered list, command preview, and word count are computed with `useMemo` and are not written to the query cache

### Requirement: Local persisted client store with mutation invalidation
Locally writable client state — `githubConnected`, `importedRepos`, `selectedRepo`, `settings` (`allowedAccount`/`retention`/`writeConfirm`), and `codexCredential` — SHALL be held in a lightweight store persisted to `localStorage` under the key `agent-control-plane-state` (reusing the prototype key). Mutations that touch this state (`importRepoMutation`, `setDefaultRepoMutation`, `saveSettingsMutation`, and the login/logout actions) SHALL write the store and then invalidate the affected queries so the UI re-renders, reproducing the prototype's read-state/render loop. The default repo SHALL be unique and the imported-repo set SHALL deduplicate.

#### Scenario: Mutation writes store and invalidates queries
- **WHEN** the operator imports a repo, changes the default repo, or saves settings
- **THEN** the store is updated, persisted to `localStorage` under `agent-control-plane-state`, and the affected queries are invalidated so the view re-renders

#### Scenario: Default repo stays unique and imports deduplicate
- **WHEN** a repo is imported or set as default
- **THEN** the imported set deduplicates and exactly one repo remains marked as default

### Requirement: Landing-family standalone pages
The four standalone pages SHALL faithfully reproduce the design revision's design language. `/` (Landing) SHALL render the landing-nav (the brand, plus an account affordance when the operator is authenticated), a hero (eyebrow, the CJK display title + subline, the lead copy, a dual CTA, trust pills rendered as discrete chips, and a live `runner-capsule` demo — a native React port of the design's vanilla `runner-capsule.js` Web Component preserving the same loop state machine), and a minimal footer (brand + a minimal link set + the copyright line), with smooth anchor scrolling for any in-page anchor (scroll-margin offsetting the fixed nav). The Landing SHALL NOT render a proof-tile grid, a `#workflow` `process-rail` section, or a `#security` `boundary-ledger` section (these are dropped in the simplified design revision), and SHALL carry NO nav or footer anchor links targeting those removed sections (no dead anchors). The runner-capsule demo SHALL be SSR-SAFE under the established mounted-flag pattern: the server render and the first client paint SHALL use the reduced-motion branch (no `window`/`matchMedia` access during render), and the full animation loop SHALL be enabled only after mount when `matchMedia('(prefers-reduced-motion: no-preference)')` matches; a visitor with `prefers-reduced-motion: reduce` SHALL keep the reduced branch. The landing SHALL be SESSION-AWARE: when the operator is authenticated it SHALL present a primary "进入控制台" CTA routing to `/dashboard` (and an account affordance) in place of the login CTA; when unauthenticated it SHALL present the "登录控制台" CTA as the single clear primary action and a secondary "查看演示" action that scrolls to the in-page `runner-capsule` preview. No anonymous landing entry SHALL silently dead-bounce through the auth gate — an unauthenticated visitor's primary action SHALL go to `/login` (or scroll to the in-page preview) rather than appearing to open the console and being gated. The landing's visual presentation SHALL stay within the existing design language (not a new visual system): the trust pills SHALL render as discrete chips rather than bare link-colored text; the large CJK display headings SHALL control line-breaking so words are not split mid-token; the hero CTA hierarchy SHALL present a single clear primary action; and inter-section spacing/card density SHALL avoid large dead bands. `/login` SHALL render a centered login modal offering a method switch among email+password, email verification code (OTP), and GitHub authorization, rendering ONLY the methods whose backend capability flags are enabled; the password method SHALL submit to the password-login endpoint, the OTP method SHALL drive the request-code → enter-code flow, and the GitHub method SHALL trigger the GitHub authorize flow; on success the page SHALL route into the CONSOLE — `/dashboard` by default, or the `redirect` deep-link destination when one was carried (per `multi-user-oauth`) — with copy that reflects the console destination; when the authenticated account has `mustChangePassword` set, a forced password-change dialog SHALL be presented before console access is granted; an already-authenticated visitor MAY be redirected away from `/login`. `/workspace` (Launcher) SHALL render the landing-nav, hero, a 3 stat-tile ops-strip (REPOSITORIES from the repos query; RUNNERS/QUEUE from metrics), and 6 screen-cards (each a full-card link, with a footer "open tasks" count and latest run id derived from the tasks query). `/resume` (Handoff) SHALL render the landing-nav, a main panel (eyebrow/title/lead/dual CTA), and 3 stat-tiles (NEXT ACTION derived from the highest-priority waiting-input task and used to parameterize the second CTA's task deep link; DEFAULT SCOPE from `selectedRepo`; SAFETY static). All four pages SHALL be SSR-safe (no `Date.now()`/`Math.random()` rendered directly to avoid hydration warnings); the landing's session-aware swap in particular SHALL render the unauthenticated state on the server/first paint and reconcile to the authenticated affordance after client hydration so no hydration mismatch occurs.

#### Scenario: Landing renders the simplified hero and footer

- **WHEN** the operator opens `/`
- **THEN** the page renders the landing-nav, the hero (eyebrow, title + subline, lead copy, dual CTA, trust-pill chips, and the runner-capsule demo), and a minimal footer
- **AND** it renders NO proof-tile grid, NO `#workflow` process-rail section, and NO `#security` boundary-ledger section

#### Scenario: No dead anchors remain after the section removal

- **WHEN** `/` is rendered
- **THEN** neither the nav nor the footer contains a link targeting `#workflow` or `#security`, and the only in-page anchor target is the `runner-capsule` preview reached by the "查看演示" action

#### Scenario: Runner-capsule demo is the hero preview

- **WHEN** `/` renders on a client with no reduced-motion preference
- **THEN** the hero demo region is the React runner-capsule advancing through the same ordered loop phases as the design's `runner-capsule.js` state machine (and looping), with no static HeroPreview markup rendered

#### Scenario: Demo animation is SSR-safe and honors reduced motion

- **WHEN** `/` is server-rendered and hydrated
- **THEN** the server render and first client paint show the reduced-motion branch without accessing `window`/`matchMedia` during render, and the animation upgrades only after mount via `matchMedia`
- **AND** when the visitor has `prefers-reduced-motion: reduce`, the demo stays in the reduced branch instead of animating

#### Scenario: Landing is session-aware

- **WHEN** an authenticated operator opens `/`
- **THEN** the landing presents a primary "进入控制台" CTA to `/dashboard` (and an account affordance) instead of a "登录控制台" CTA
- **AND** an unauthenticated visitor instead sees the "登录控制台" primary CTA and a "查看演示" secondary action

#### Scenario: Anonymous primary action does not dead-bounce

- **WHEN** an unauthenticated visitor activates the landing's primary action
- **THEN** they are taken to `/login` (or, for "查看演示", scrolled to the in-page preview) rather than appearing to open the console and being silently redirected by the gate

#### Scenario: Login routes to the console on success

- **WHEN** the operator completes any login method on `/login` with no deep-link carried
- **THEN** the operator is routed to `/dashboard` (the console), and the page copy reflects the console destination rather than the repository-import page

#### Scenario: Login honors a carried deep-link destination

- **WHEN** the login flow was reached with a `redirect` destination and authentication succeeds
- **THEN** the operator is returned to that destination (subject to the `multi-user-oauth` open-redirect guard) rather than the default dashboard

#### Scenario: Standalone pages hydrate without warnings

- **WHEN** any of `/`, `/login`, `/workspace`, `/resume` is server-rendered and hydrated
- **THEN** no hydration mismatch occurs because no nondeterministic value is rendered directly, and the landing renders its unauthenticated state on first paint before reconciling to the authenticated affordance after hydration

#### Scenario: Workspace counts reflect live queries

- **WHEN** `/workspace` renders
- **THEN** the REPOSITORIES tile reflects the repos query and each screen-card footer shows an open-tasks count derived from the tasks query

#### Scenario: Resume next-action drives the CTA deep link

- **WHEN** `/resume` renders with a waiting-input task present
- **THEN** the NEXT ACTION tile reflects the highest-priority waiting-input task and the second CTA links into that task's `/tasks/$taskId` session

### Requirement: Repositories import page
The `/repositories` page SHALL render a screen-header (添加仓库 button), 4 stat-tiles (the DEFAULT tile bound to `selectedRepo`), an imported-repos panel (Card list with column headers and an imported-count Badge sourced from the repos query), and an import Dialog with a pending-empty → loading → filterable-list flow (the candidate list from the GitHub import query, the imported list from the repos query). Importing SHALL add to `importedRepos`, set the default, and toast; the page SHALL provide `setAsDefault`. The Dialog SHALL be accessible (`role`/`aria-modal`/`aria-labelledby`, `Escape`, backdrop dismiss, focus management).

The `/repositories` import dialog SHALL provide a URL import path for forge repositories in addition to the existing list-based picker. For GitLab, Gitee, GitHub, and self-hosted forge sources, an operator SHALL be able to paste an HTTP(S) git URL, select or confirm the forge kind when it cannot be inferred, and submit the repo through the create-repo mutation without first syncing the repository list. The URL form SHALL reject credential-bearing URLs and SHALL explain that credentials are managed through the code-hosting connection settings. When the list-based sync for a selected forge fails because the token cannot list repositories or the forge API is unavailable, the dialog SHALL keep the URL import path visible and present the failure as "listing unavailable" rather than "not connected" or "no repositories". The dialog SHALL continue to show the list picker when listing succeeds.

#### Scenario: Import flow proceeds through its states
- **WHEN** the operator opens the import Dialog
- **THEN** it shows the pending-empty state, then a loading state, then a filterable candidate list, and selecting a repo imports it (adding to `importedRepos`, setting it default, and toasting)

#### Scenario: Imported list and candidate list use distinct sources
- **WHEN** the page renders
- **THEN** the imported-repos panel reads the repos query (real when enabled) and the import Dialog candidate list reads the GitHub import query

#### Scenario: Import Dialog is accessible
- **WHEN** the import Dialog is open
- **THEN** it exposes `role="dialog"`/`aria-modal`/`aria-labelledby`, traps focus, and closes on `Escape` or backdrop click

#### Scenario: Import by URL without syncing the list
- **WHEN** an operator opens the repository import dialog, selects Gitee, and pastes `https://gitee.internal/team/app.git`
- **THEN** the dialog can submit `POST /repos` with the pasted `gitSource` and `forge='gitee'` without first calling the repository list API

#### Scenario: Listing failure keeps URL import available
- **WHEN** the operator's connected Gitee credential cannot call the repository listing API
- **THEN** the dialog shows a list-unavailable message and keeps the URL import controls usable
- **AND** it does not render the state as an empty repository list

#### Scenario: Credential-bearing URL is rejected in the browser
- **WHEN** an operator pastes a URL that includes username/password/token userinfo
- **THEN** the dialog blocks submission and tells the operator to store the token in code-hosting settings instead

#### Scenario: API-unverified forge credential is described honestly
- **WHEN** settings or import UI shows a connected forge credential whose API access is unverified
- **THEN** the UI indicates that clone/push may work but repository listing and PR/MR creation may require broader API permissions

### Requirement: Settings page with account, GitHub, and Codex sections
The `/settings` page SHALL render a left secondary anchor navigation grouping account/github/codex/safety, a system-strip of 3 cards, and a settings grid: an identity card (Avatar) and an access-and-defaults form (`allowedAccount`, default repo from the repos query, `retention`, `writeConfirm`, and a task slot ceiling numeric control bound to the system-level `maxConcurrentTasks` setting, client-validated as an integer in the range 1–20 with default 5), plus a Codex login section (status card + Tabs: 官方 Codex / 兼容提供方). The slot ceiling control SHALL be presented as a system-wide value shared by all allowlisted operators (not a per-account preference), and a value outside 1–20 (or a non-integer) SHALL NOT be submitted. The Codex section SHALL provide two dialogs — a direct authorize dialog (scope list + connect/connected states) and an api-key dialog (Base URL + API Key as a password field + fetch-available-models → model-picker → select default model → save/test). The credential status (未连接/未保存/已连接) SHALL stay synchronized across the status card, the tab subtitle, and the provider pill; a saved API key SHALL NOT be re-displayed in plaintext. Saving SHALL run `saveSettingsMutation` (write store + invalidate the settings query, ADDITIONALLY invalidating the metrics query on success so a changed slot ceiling is reflected on the dashboard capacity surfaces before the next 5-second poll); a reset action SHALL restore defaults (including the slot ceiling default of 5). The page SHALL keep GitHub OAuth (who may enter the console) and Codex credentials (which model runs tasks) as two distinct concepts and SHALL NOT conflate Codex credentials with console login.

#### Scenario: Saving settings persists and re-renders
- **WHEN** the operator edits the access-and-defaults form and saves
- **THEN** `saveSettingsMutation` writes the store and invalidates the settings query so the UI reflects the new values, and a reset restores defaults

#### Scenario: Codex credential status stays synchronized
- **WHEN** the operator connects or saves a Codex credential
- **THEN** the status card, tab subtitle, and provider pill all reflect the same 未连接/未保存/已连接 state

#### Scenario: Saved API key is masked
- **WHEN** an API key has been saved
- **THEN** it is not shown again in plaintext in the api-key dialog

#### Scenario: Console login and Codex credential are not conflated
- **WHEN** the settings copy describes GitHub OAuth and Codex credentials
- **THEN** GitHub OAuth is presented as console access identity and Codex credentials as the task model credential, as two separate concerns

#### Scenario: Slot ceiling field accepts only integers in 1–20
- **WHEN** the operator enters 0, 21, a negative number, or a non-integer in the slot ceiling control and attempts to save
- **THEN** client-side validation blocks the submission (no save request carries the invalid value) and the stored ceiling is unchanged
- **AND** entering an integer between 1 and 20 and saving persists that value and a reload reads it back

#### Scenario: Saving the slot ceiling refreshes capacity surfaces
- **WHEN** the operator saves a changed slot ceiling and the save succeeds
- **THEN** the mutation invalidates both the settings query and the metrics query, so the dashboard capacity aside and slot meter reflect the new ceiling without waiting for the next 5-second metrics poll

### Requirement: History audit page
The `/history` page SHALL render a screen-header and a single "运行记录" panel containing an audit-toolbar (search Input + a status SegmentedControl 全部/运行中/等待输入/排队/已完成/失败 + a CountChip "N 条记录") and a Vercel-style task-row list sourced from the tasks query. Each row SHALL render the task's result as a status pill in a kicker line with the task id, the task title, the repo·branch (mono), the Agent runtime, the elapsed time, and a single dark "查看会话" action linking to that task's 会话记录 (queued tasks show a disabled "等待接入" instead). The client-side filter (search + status) SHALL drive the list and update the CountChip live, with an empty state when nothing matches. The page SHALL NOT render the former ACTIVE WINDOW/ATTENTION/RETENTION summary tiles or the right-hand audit event-stream. It SHALL be read-only (no terminal/WebSocket) and SSR-friendly.

#### Scenario: History renders as a single task-row list
- **WHEN** the operator opens `/history`
- **THEN** it shows the 运行记录 panel with task rows (status pill + title + repo·branch + Agent + 耗时 + 查看会话), and no summary tiles or audit event-stream

#### Scenario: Status filter and search narrow the list
- **WHEN** the operator types a search term or selects a status segment
- **THEN** the task-row list filters and the CountChip updates to the visible count, with an empty state when nothing matches

#### Scenario: View-session navigates from history
- **WHEN** the operator activates a row's 查看会话 action
- **THEN** the console navigates to that task's 会话记录 (transcript) view

#### Scenario: History is read-only and SSR-rendered
- **WHEN** `/history` is server-rendered
- **THEN** it renders without any terminal/WebSocket connection and hydrates without errors

### Requirement: Ported design tokens and shadcn visual layer
The console SHALL define its design tokens once in `src/styles/app.css` (Tailwind v4, no `tailwind.config.js`): `@import "tailwindcss"`, `@import "tw-animate-css"`, a `@custom-variant dark`, a `:root` mapping the prototype's `admin-*` final values onto the shadcn semantic token contract (including the full sidebar token set and `--chart-1..5`), additional brand/semantic tokens (`--success`/`-soft`, `--warning`/`-soft`, `--info`/`-soft`, `--danger-soft`, terminal-scoped `--terminal-*`), a `@theme inline` block exposing all `--xxx` as `--color-*` utilities plus sans/mono fonts and the radius/box-shadow scale, and a synthesized `.dark` block. Because the prototype's "borders" are predominantly 1px box-shadow rings, the visual layer SHALL prefer `shadow-ring`/`shadow-card` utilities over CSS `border` to match the prototype. The shadcn components listed in the blueprint SHALL be installed, a `StatusPill` SHALL extend the shadcn Badge with success/warning/info/dark/neutral soft variants (inset ring), and the xterm terminal (which does not consume Tailwind classes) SHALL be themed by resolving the `--terminal-*` variables to hex and passing them to xterm's `theme` option.

#### Scenario: Tokens live in a single source
- **WHEN** the console resolves any color, radius, or shadow
- **THEN** it comes from the `:root`/`@theme inline` definitions in `src/styles/app.css` and there is no `tailwind.config.js`

#### Scenario: Box-shadow rings reproduce prototype borders
- **WHEN** a card or input is rendered that the prototype draws with a 1px ring
- **THEN** the console uses a `shadow-ring`/`shadow-card` utility rather than a CSS `border` to reproduce the look

#### Scenario: StatusPill exposes the prototype variants
- **WHEN** a `StatusPill` is rendered with success/warning/info/dark/neutral
- **THEN** it renders the corresponding soft color pair with an inset ring matching the prototype status-pill colors

#### Scenario: Terminal is themed from terminal tokens
- **WHEN** the xterm terminal mounts
- **THEN** the `--terminal-*` variables are resolved to hex and supplied to xterm's `theme` (background/foreground/cursor/ANSI), since xterm does not read Tailwind classes

### Requirement: Nitro deployment target for Vercel
`apps/web` SHALL build through the Nitro `vercel` preset (replacing the Next-shaped `vercel.json`) so the TanStack Start app deploys to Vercel as a web-only target, while still reading `VITE_API_BASE_URL`/`VITE_WS_URL` so the api/WS origin can differ from the web origin.

#### Scenario: App builds for the Vercel target
- **WHEN** `apps/web` is built for deployment
- **THEN** it produces a Nitro `vercel`-preset output (not a Next.js build) and the cross-origin `VITE_*` endpoint configuration is honored at runtime

### Requirement: Session page design-revision layout
The `/tasks/$taskId` page SHALL adopt the COCKPIT layout as a MARKUP/LAYOUT/STYLE-ONLY reorganization: toolbar action behavior, input semantics, connection semantics, AND the approval surface SHALL NOT change — there is NO WebSocket-path delta in this change. The page body SHALL be composed as: (1) a THREE-SEGMENT header and (2) a single self-contained dark terminal window. The permission-request APPROVAL surface SHALL stay rendered INSIDE the terminal `<article>` exactly as it shipped previously; the page-level amber approval banner + the lift of `pending`/`decide` to the route are DEFERRED to a follow-up approval change (alongside the real `permission_request` flow + payload).

The THREE-SEGMENT header SHALL render, in this order:
- a TASK-STATUS H1 rendered as a dot+text Badge where the state is conveyed by BOTH the dot color AND the text label (never color-alone). The route drives the task LIFECYCLE states 运行中 / 已停止 / 失败 (all static dots) this phase; the Badge primitive also supports an in-flight 等待审批 state (animated pulse), reserved for the follow-up approval change that lifts the pending request;
- a TAG RAIL folding the deleted context strip into NON-INTERACTIVE chips for 分支 / {agent-runtime} / {sandbox-provider} / 守护栏, each rendered with a white background and a 1px ring. The agent chip SHALL render the task's PERSISTED `runtime` as a human-readable label (`codex` → `Codex`, `claude-code` → `Claude Code`, absent/null → `Codex`) via a SINGLE shared runtime-label helper that is also used by the history page, so the agent label cannot drift between the two surfaces; it SHALL NOT be a hardcoded `Codex` literal. The sandbox-provider chip SHALL render from the task response's public `sandboxProvider.label` when present (for example `AIO Sandbox` or `BoxLite Sandbox`) and SHALL render an honest pending/unassigned fallback when `sandboxProvider` is null or absent; it SHALL NOT hardcode `AIO Sandbox`, infer the provider from frontend environment variables, or treat AIO as the sole provider. The tag rail SHALL NOT render a platform-arch (`linux-amd64`) chip, because no task field backs it (D5.5 — never render an unsent field); the 守护栏 chip is computed from the task's `idleTimeoutMs`/`deadlineMs`. (the amber 写入前确认 chip is DEFERRED to the follow-up approval change);
- a SINGLE 停止 action as the only header action, retaining the existing two-step (explicit confirm) stop semantics that POST to `POST /tasks/:taskId/stop`; the former 返回任务 / 复制会话记录 / 暂停输出 buttons SHALL NOT appear in the header (they fold into the terminal ⋯ menu or are dropped).

The permission-request APPROVAL surface SHALL remain INSIDE the terminal `<article>` exactly as it shipped previously (an in-terminal panel offering 允许 / 拒绝, resolved lock-independently). The page-level amber banner restyle + the lift of `pending`/`decide` to the route so deciding flips the page-level H1/statusline are DEFERRED to a follow-up approval change (which also wires the real `permission_request` flow + the diffstat/commits payload).

The self-contained dark TERMINAL WINDOW SHALL render inside a single `<article>` with: a three-segment dark terminal header keeping the `{agent} · {repo}#{branch}` label (the `{agent}` segment SHALL use the SAME shared runtime-derived label as the tag rail agent chip, not a hardcoded `Codex`), a ⋯ overflow menu offering 复制 and 暂停滚动, and a 全屏 button that requests fullscreen via the element's `requestFullscreen` API; a full-width PTY scrollback region (the scrollback is intentionally NOT prose-width-constrained because it is log-scanning content); and a STATUSLINE footer appended inside the same `<article>` showing CPU·内存 plus a degraded phase. The terminal-head SHALL NOT display the hardcoded `pty: /dev/pts/4` line (or any pty path): no backend field backs it. The statusline phase SHALL degrade honestly to the task lifecycle label (a generic 运行中 for a live task) because the raw PTY exposes no semantic phase to parse (the 等待审批 phase lands with the follow-up approval change); CPU·内存 SHALL reuse the established 未运行/未采样 honest-render pattern rather than fabricating zeros.

When the open task is in a TERMINAL lifecycle state (`completed`, `cancelled`, or `failed`), the terminal-state branch of this layout SHALL replace the live terminal window with a READ-ONLY structured session-history REPLAY region driven by `GET /tasks/:id/session-history` (`session-history-replay`), preserving the same three-segment header (the H1 Badge shows the terminal label 已停止/失败/完成 with a static dot, the tag rail and the inert 停止 action remain). The replay region SHALL offer exactly two tabs — 对话记录 (conversation, PRIMARY, the parsed rollout transcript) and 终端回放 (terminal, SECONDARY, `session.log` cold-replay) — and a review sidebar carrying a search input and exactly the FIVE sticky filter presets 默认 / 无工具 / 用户 / 答案 / 全部. The conversation rendering SHALL visually distinguish three item kinds: a FINAL-ANSWER assistant turn SHALL render green-tinted with a "最终回答" label; a COMMENTARY assistant turn SHALL render muted italic, visually distinct from the final answer; a TOOL-CALL SHALL render as a bordered card showing the tool badge, the command summary, and an inline token count. The replay region SHALL present NO operation controls (no resume-run, no stop on the replay surface). When the session-history response discriminates to an honest EMPTY/degraded state, the replay region SHALL render an honest empty card (e.g. "会话未能启动" with the reason, or "会话记录已过期" for an aged-out record) in place of the transcript, never a fabricated transcript.

The route SHALL preserve its established invariants — it remains the ONLY `ssr:false` route, the server renders the `pendingComponent` terminal skeleton, and raw terminal bytes continue to bypass the TanStack Query cache. This change introduces NO WebSocket input/connection/state-lift delta for non-terminal tasks, so the cockpit reorganization is layout-only on the WS path; it SHALL nonetheless be confirmed against a live running backend session that the reorganized terminal still connects. The session-history replay region is a READ-ONLY REST surface and SHALL NOT open, mutate, or depend on the live WebSocket / PTY / write-lease path.

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
- **WHEN** the header tag rail renders for a task with a selected sandbox provider summary
- **THEN** it shows the 分支 / agent-runtime / sandbox-provider / 守护栏 chips each with a white background and a 1px ring, and clicking any chip performs no navigation or action (the chips are non-interactive)
- **AND** NO platform-arch (linux-amd64) chip is rendered

#### Scenario: Sandbox provider chip reflects the task response
- **WHEN** the header tag rail renders for a task whose task response contains `sandboxProvider.label = "BoxLite Sandbox"`
- **THEN** the sandbox-provider chip reads `BoxLite Sandbox`
- **AND** the page does not render `AIO Sandbox` for that chip unless the task response selected an AIO provider

#### Scenario: Sandbox provider chip degrades honestly before provider selection
- **WHEN** the header tag rail renders for a task whose task response has `sandboxProvider = null` or no `sandboxProvider` field during a mixed deploy
- **THEN** the sandbox-provider chip renders an honest pending/unassigned sandbox label
- **AND** it does not guess `AIO Sandbox` from frontend constants, deployment env, or mock defaults

#### Scenario: Agent chip reflects the task's persisted runtime
- **WHEN** the tag rail and the terminal-head `{agent}` label render for a task persisted with `runtime = claude-code`
- **THEN** the agent chip and the terminal-head agent segment both read `Claude Code`, derived from the task's runtime via the shared runtime-label helper rather than a hardcoded literal

#### Scenario: Agent chip defaults to Codex for codex or absent runtime
- **WHEN** the tag rail renders for a task persisted with `runtime = codex` or with no runtime value
- **THEN** the agent chip reads `Codex`, derived from the runtime via the shared helper (the default), never a hardcoded literal that ignores the task's runtime

#### Scenario: Agent label helper is shared with the history page
- **WHEN** the session detail page and the history page both render an agent label for the same task
- **THEN** both derive the label from the SAME shared runtime-label helper, so a `claude-code` task reads `Claude Code` on both surfaces and the two cannot drift

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

#### Scenario: Terminal-state layout renders the structured replay with two tabs
- **WHEN** the operator opens the session page for a task in a terminal lifecycle state whose rollout is available
- **THEN** the live terminal window is replaced by the read-only replay region, which offers a 对话记录 tab (primary, the parsed rollout transcript) and a 终端回放 tab (secondary, `session.log` cold-replay), inside the same cockpit three-segment header

#### Scenario: Five filter presets and a search input render on the review sidebar
- **WHEN** the replay region renders for a terminal task with a rollout
- **THEN** the review sidebar shows a search input and exactly the five filter presets 默认 / 无工具 / 用户 / 答案 / 全部
- **AND** selecting 无工具 hides tool-call turns, 用户 shows only user turns, and 答案 shows user prompts plus final answers

#### Scenario: Final answer, commentary, and tool-call render with distinct treatments
- **WHEN** the conversation transcript renders a final-answer assistant turn, a commentary assistant turn, and a tool-call
- **THEN** the final-answer turn is green-tinted with a "最终回答" label, the commentary turn is muted italic and visually distinct from the final answer, and the tool-call is a bordered card showing the tool badge, the command summary, and an inline token count

#### Scenario: Replay region presents no operation controls
- **WHEN** the read-only replay region renders for a terminal task
- **THEN** it exposes no resume-run control and no stop control on the replay surface, consistent with the task being non-operable (`canStop` is false)

#### Scenario: Empty/aged-out session-history renders an honest empty card
- **WHEN** the session-history response for the terminal task discriminates to an empty state (agent-failed-to-start, provision-failed with no rollout, or expired/reaped)
- **THEN** the replay region renders an honest empty card (e.g. "会话未能启动" with the reason, or "会话记录已过期" for an aged-out record) instead of a fabricated transcript

#### Scenario: Replay region stays off the live terminal pipeline
- **WHEN** the read-only replay region renders and fetches session history
- **THEN** it reads only via the `GET /tasks/:id/session-history` REST endpoint and does not open, mutate, or depend on the live WebSocket / PTY / write-lease path

### Requirement: Design-revision token merge in one source
The `apps/web/src/styles/app.css` token source SHALL gain `--console` and `--muted-2` as first-class tokens in its `@theme`/`:root` contract, SHALL retune `--shadow-card` to the design values `0 0 0 1px rgba(0,0,0,0.08), 0 2px 2px rgba(0,0,0,0.04), 0 8px 8px -8px rgba(0,0,0,0.04)`, and SHALL apply the console background at BODY level via an `@layer base` rule referencing `var(--console)`. The one-off `bg-[#f8f9fb]` arbitrary class SHALL be removed from `_app.tsx`. All of these values SHALL live only in the single `app.css` source so `@cap/ui` components pick them up automatically with no per-package divergence.

#### Scenario: New tokens are defined once and the arbitrary value is gone
- **WHEN** the stylesheet and app-shell sources are inspected after the merge
- **THEN** `--console` and `--muted-2` are defined in `app.css`'s token contract, and no source file uses the `bg-[#f8f9fb]` arbitrary class

#### Scenario: Shadow-card resolves to the design values
- **WHEN** an element styled with the shadow-card utility renders
- **THEN** its computed box-shadow equals `0 0 0 1px rgba(0,0,0,0.08), 0 2px 2px rgba(0,0,0,0.04), 0 8px 8px -8px rgba(0,0,0,0.04)`

#### Scenario: Console background is applied at body level
- **WHEN** any console page renders
- **THEN** the document body's background resolves to `var(--console)` via the `@layer base` rule, rather than relying on a per-layout wrapper class

#### Scenario: Token changes propagate to the shared UI package
- **WHEN** a `@cap/ui` component (e.g. Card) and an `apps/web` surface render on the same page
- **THEN** both resolve the retuned shadow and the new tokens from the same `app.css` definitions with no visual divergence between packages

### Requirement: Guardrail preset ladders match the design revision
The single shared guardrail option catalog (consumed by BOTH the dashboard new-task dialog and `/tasks/new`) SHALL offer the design revision's preset ladders: idle-timeout presets exactly 关闭 / 15 分钟 / 30 分钟, and deadline presets exactly 无 / 1 小时 / 4 小时. A selected duration preset SHALL submit as integer milliseconds (`idleTimeoutMs` 900000 or 1800000; `deadlineMs` 3600000 or 14400000); selecting 关闭/无 SHALL submit no value for that field. The catalog SHALL remain one shared module so the two create surfaces cannot drift, and the change is contract-safe: the request fields remain free integer milliseconds.

#### Scenario: Both create surfaces show the same updated ladders
- **WHEN** the dashboard new-task dialog and the `/tasks/new` page each render the guardrail controls
- **THEN** both list exactly 关闭/15 分钟/30 分钟 for idle timeout and 无/1 小时/4 小时 for deadline, sourced from the one shared catalog module

#### Scenario: Presets submit milliseconds and off/none submit nothing
- **WHEN** the operator selects 15 分钟 idle and 4 小时 deadline and submits
- **THEN** the create body carries `idleTimeoutMs: 900000` and `deadlineMs: 14400000`
- **AND** selecting 关闭 and 无 instead submits neither field, preserving the no-reclaim/no-deadline behavior

### Requirement: Mobile breakpoint convention is recorded at 820px
The console's responsive design rules introduced by the design revision (`mobile-inbox`, `mobile-workbench-meta`, `mobile-pool-summary`, and peers) SHALL be implemented on the established ≤820px CSS breakpoint convention (`max-[821px]` / `min-[821px]` utilities — Tailwind v4 compiles max-* to the STRICT `width < N`, so `max-[821px]` is the inclusive ≤820px the design's `max-width: 820px` media query means; the previously-named `max-[820px]` form compiled to `width < 820px` and left exactly 820px in a desktop/mobile dead zone, violating the scenario below), matching the existing shell and MobileNav behavior. No new JavaScript-driven breakpoint SHALL be introduced for these rules.

#### Scenario: Design-revision mobile rules engage at the convention breakpoint
- **WHEN** a console page carrying a design-revision mobile rule renders at a viewport width of 820px
- **THEN** the mobile layout rules apply, and at 821px the desktop layout applies, consistent with the existing shell breakpoint

#### Scenario: No parallel JS breakpoint is introduced
- **WHEN** the design-revision mobile rules are inspected
- **THEN** they are expressed as ≤820px CSS utilities rather than a new JavaScript viewport hook with a different threshold

### Requirement: Required per-page pixel comparison against the design baselines
Visual verification SHALL be a REQUIRED gate for this change (promoted from the rebuild's optional gate): a Playwright `toHaveScreenshot()` suite SHALL compare every merged console page — at minimum `/` (landing), `/login`, `/dashboard`, `/tasks/new`, `/tasks/$taskId`, `/repositories`, `/history`, `/settings` — at both the desktop breakpoint and the ≤820px mobile breakpoint, against baselines captured from the corresponding local design HTML files (the design source served locally as living baselines). Each comparison SHALL run with explicit, recorded diff thresholds (`maxDiffPixels` and/or `maxDiffPixelRatio`/`threshold`) configured in the suite, and dynamic data regions SHALL be stabilized (mock/fixed data or masking) so comparisons are deterministic. A page exceeding its recorded threshold SHALL FAIL the suite — the gate blocks, it does not warn.

#### Scenario: Every page is compared per breakpoint against the design baseline
- **WHEN** the visual verification suite runs
- **THEN** it produces a `toHaveScreenshot()` pass/fail result for each listed page at each of the two breakpoints against its design-derived baseline, with no page or breakpoint skipped

#### Scenario: Thresholds are explicit and the gate blocks on failure
- **WHEN** a page's rendered screenshot differs from its baseline beyond the suite's recorded `maxDiffPixels`/`maxDiffPixelRatio` threshold
- **THEN** the suite fails (and the change's verify gate fails with it), rather than logging a warning and passing

#### Scenario: Comparisons are deterministic across runs
- **WHEN** the suite runs twice against the same build with no code change
- **THEN** both runs produce the same pass/fail result per page because dynamic regions are stabilized with fixed mock data or masks

### Requirement: Dialog surfaces use a fixed-width, height-capped, internally-scrolling shell

All `role="dialog"` surfaces in `apps/web` SHALL be built on the shared `ui/dialog.tsx`
primitives and SHALL present a STABLE outer shell whose size does not change with inner content:
the shell SHALL keep a FIXED WIDTH (each dialog retains its configured width) and SHALL CAP its
height at `max-h-[85vh]` so a dialog NEVER exceeds the viewport. When content would exceed the
cap, overflow SHALL be contained and scrolled WITHIN the dialog rather than growing the outer
frame or overflowing the screen.

`ui/dialog.tsx` SHALL provide this regime at the primitive layer: `DialogContent` SHALL carry the
`max-h-[85vh]` cap (and, on the default `grid` path, `overflow-y-auto` so simple dialogs scroll as
one block); it SHALL export a `DialogBody` primitive that designates a SINGLE scroll region
(`flex-1 min-h-0` with NATIVE `overflow-x-hidden overflow-y-auto`); and `DialogHeader` /
`DialogFooter` SHALL be pinned (`shrink-0`) so they stay fixed while `DialogBody` scrolls. The
scroll region SHALL NOT clip its content horizontally: content inside the capped, fixed-width shell
SHALL fit the shell's inner width (the dialog body SHALL NOT use Radix `ScrollArea`, whose
`display:table` viewport lets `minmax`/grid content overflow the right edge; row/column layouts
inside a fixed-width dialog SHALL size their column minimums to fit that dialog width). The content-rich panel dialogs (新建任务, 导入仓库, Codex 直连,
Codex API Key) SHALL adopt a `flex flex-col max-h-[85vh] overflow-hidden` shell, keep their
existing fixed widths, pin their header/footer, and route their middle content through
`DialogBody`. This change SHALL be layout/style-only: no dialog's form logic, validation,
state machine, or dismissal behavior (including `new-task-dialog`'s `onInteractOutside`
Select-portal guard) SHALL change.

#### Scenario: Outer frame stays constant across content/state changes
- **WHEN** a panel dialog's inner content changes (e.g. import-dialog switches 待拉取 → 加载中 →
  长列表, or new-task-dialog expands its form)
- **THEN** the dialog's outer width AND height stay constant
- **AND** only the `DialogBody` region scrolls, while the header and footer stay pinned

#### Scenario: Dialog never exceeds the viewport
- **WHEN** a dialog's content is taller than the available viewport
- **THEN** the dialog height is capped at `max-h-[85vh]` and its overflow scrolls within the
  dialog rather than overflowing the screen

#### Scenario: Short-content dialogs are visually unchanged
- **WHEN** a dialog's content fits well within `85vh`
- **THEN** the `max-h` cap and overflow handling are inert and the dialog renders at its natural
  (unchanged) size

#### Scenario: Content is not clipped horizontally inside the fixed-width shell
- **WHEN** a fixed-width dialog renders content with multi-column rows (e.g. the repo import list)
- **THEN** the row content fits the dialog's inner width and all controls (e.g. the per-row action
  buttons) are fully visible — never clipped past the right edge — while the dialog stays centered

### Requirement: Compatible-provider dialog is backed by real model discovery
The settings compatible-provider (api-key) dialog SHALL drive its connection test and model list from the **real** discovery endpoint (`POST /settings/codex/models`) via the shared `@cap/contracts` discovery schema, NOT from a hardcoded/mock model list or a client-only non-empty-field check. "测试连接/测试凭据" SHALL issue the real probe and reflect its actual outcome class (success vs auth-failure vs unreachable), the default-model picker SHALL be populated from the models the probe returns, and selecting a returned model SHALL be REQUIRED before the credential can be saved. The save action SHALL remain disabled until a real successful probe has populated the picker and a model is selected, so the operator cannot persist a credential whose Base URL/key were never validated or whose default model is not a real capability of the provider. The save payload SHALL carry `{mode: 'compatible', baseUrl, apiKey, defaultModel}` to `PUT /settings/codex` (the existing, correct transport). The dialog copy SHALL state that the provider must be **OpenAI Responses-API compatible** (codex 0.131 speaks only the Responses API), so operators do not configure a chat-completions-only endpoint that lists models successfully but fails at task run time.

#### Scenario: Test calls the real discovery endpoint
- **WHEN** the operator runs the connection test with a Base URL and API key
- **THEN** the dialog issues a real `POST /settings/codex/models` request and reflects its outcome (connected with a model list, or a descriptive auth/unreachable failure) rather than a client-side non-empty check

#### Scenario: Picker is populated from real discovered models and selection is required
- **WHEN** a discovery probe succeeds
- **THEN** the default-model picker is populated from the returned model identifiers and the operator must select one before save is enabled

#### Scenario: Save is gated on a real successful probe
- **WHEN** no real successful discovery has occurred (or no model is selected)
- **THEN** the save action is disabled, so an unvalidated compatible credential cannot be persisted from the dialog

#### Scenario: Dialog states the Responses-API requirement
- **WHEN** the operator opens the compatible-provider dialog
- **THEN** the copy states the provider must be OpenAI Responses-API compatible (not chat-completions-only), so a models-listing-only endpoint is not mistaken for a working provider

### Requirement: Create-task dialog offers a runtime selector gated on readiness
The create-task dialog SHALL present a runtime selector (`Claude Code` | `Codex`) whose
value is sent in the create-task request body as `runtime`, defaulting to `Codex`. The
selector SHALL be gated on a runtime-readiness read (see `agent-runtime`): a runtime that
is not configured/ready SHALL be shown disabled with an affordance pointing the operator to
configure it, rather than being selectable and failing at launch. The command preview SHALL
reflect the selected runtime (showing the `claude`-based invocation when Claude Code is
chosen, the `codex`-based invocation otherwise).

#### Scenario: Operator selects an available runtime
- **WHEN** both runtimes report ready and the operator selects `Claude Code`
- **THEN** the create request body carries `runtime = claude-code` and the command preview
  reflects the Claude invocation

#### Scenario: Unconfigured runtime is disabled
- **WHEN** the Claude runtime reports not ready
- **THEN** the `Claude Code` option is shown disabled with a configure hint, and `Codex`
  remains the default selectable runtime

### Requirement: Session transcript (会话记录) view
The console SHALL provide a read-only session-transcript view for a task, reached from the history list's 「查看会话」 entry, rendering the persisted session transcript (from `session-transcript-persistence`) as a vertical timeline of typed events: operator input, reasoning summary, tool call (command/patch with a collapsible output and diff stat), final agent answer, and system events (created/ready/completed). The view SHALL provide a type filter (全部/我的输入/工具/回答) and a text search that filter the timeline together, an empty state when nothing matches, and a link to the task's terminal record. It SHALL be SSR-safe and read-only (no terminal/WebSocket).

#### Scenario: Transcript renders typed events
- **WHEN** the operator opens a task's 会话记录
- **THEN** the timeline renders operator input, reasoning, tool calls with collapsible output, the final answer, and system events in chronological order

#### Scenario: Type filter and search narrow the timeline
- **WHEN** the operator selects 工具 or types a search term
- **THEN** only matching events remain and an empty state shows when nothing matches

### Requirement: API debug (API 调试) console view
The console SHALL provide an authenticated API debug view at `/api`, with a sidebar and mobile-nav entry "API 调试", visible only to a logged-in operator, for exercising the platform v1 API (`public-v1-api`). It SHALL render a resource-grouped endpoint collection (tasks/repos/sessions/system, each item a method badge + path), a request region with a read-only method+host+path bar (the endpoint is selected from the collection, not free-typed) and Request tabs (Body/参数/Headers), and a Response region with status/time/size plus Body/Headers tabs. Credentials SHALL be presented as auto-injected from the current operator session (no manual token field). The Request and Response regions SHALL be explicitly labeled and visually distinct.

#### Scenario: API debug view is gated and reachable
- **WHEN** an authenticated operator activates the "API 调试" nav entry
- **THEN** the `/api` view opens within the app shell, and an unauthenticated visitor is gated like other `_app` routes

#### Scenario: Endpoint selection drives a read-only request line
- **WHEN** the operator selects an endpoint from the collection
- **THEN** the method + host + path bar reflects it as read-only text (not an editable URL field), and the Request and Response regions are separately labeled

### Requirement: Settings model credentials organized by Agent runtime
The settings model-credential section SHALL be organized by Agent runtime and expose both runtimes the platform supports: a Codex group (官方 Codex 账号 / 兼容模型提供方) and a Claude Code group (Claude 订阅 setup-token / Anthropic API Key). Each runtime SHALL show its own connection status, and the Claude Code group SHALL provide an entry to configure a `claude setup-token` subscription token and an Anthropic API Key. Saved secrets SHALL be masked (suffix only) and never re-displayed in plaintext.

#### Scenario: Claude Code credential entry is present
- **WHEN** the operator opens the Agent model-credential section
- **THEN** a Claude Code runtime group is shown with a setup-token entry and an Anthropic API Key entry, alongside the Codex group

#### Scenario: Saved Claude credential is masked
- **WHEN** a Claude setup-token or Anthropic API Key has been saved
- **THEN** it is not shown again in plaintext

### Requirement: Geist typeface and flattened card surfaces
The console design tokens SHALL adopt the prototype's Geist Sans / Geist Mono typefaces for `--font-sans` / `--font-mono` (bundled as app assets with a `system-ui` / monospace fallback, not a render-blocking external import), and card surfaces SHALL use the flattened single-ring shadow the finalized baseline uses rather than a multi-layer drop shadow.

#### Scenario: Console renders in Geist
- **WHEN** any console page renders
- **THEN** sans text resolves to Geist Sans and mono text to Geist Mono, falling back gracefully if a face fails to load

### Requirement: Console restored to the finalized design baseline
The console screens SHALL match the finalized Open Design baseline (the 2026-06-19 frozen snapshot: 10 screens + `platform.css`), and that baseline's HTML/CSS source SHALL live at the STABLE location `apps/web/e2e/design-baseline/` — it SHALL NOT live inside an `openspec/changes/<name>/` directory, because a change directory is moved on archive and breaks the visual gate (this recurred across the 2026-06-11 and 2026-06-19 snapshots, each re-pointing the server at a soon-to-be-archived change path). Per-page pixel comparison SHALL use this snapshot — including the two added screens (transcript, api) — as the oracle, superseding the earlier 2026-06-11 baseline. The visual harness (`serve-design-baseline.mjs`, `baseline.capture.ts`, `manifest.ts`, and the one-off `verify-replay.mjs`) SHALL resolve the baseline from this stable location and SHALL NOT reference a change-scoped path. A screen is considered restored only when it visually matches its baseline at a fixed viewport.

#### Scenario: Screens are verified against the frozen baseline
- **WHEN** a restored console screen is compared to its `apps/web/e2e/design-baseline/` reference at a matched viewport
- **THEN** it visually matches, and the comparison target is the 2026-06-19 frozen snapshot served from the stable location

#### Scenario: Baseline source survives change archival
- **WHEN** any OpenSpec change is archived (its `openspec/changes/<name>/` directory is moved under `archive/`)
- **THEN** the visual gate's baseline source remains resolvable because it lives at `apps/web/e2e/design-baseline/`, outside any change directory, and `serve-design-baseline.mjs` / `verify-replay.mjs` still resolve their roots without edit

### Requirement: Settings page has an MCP Server section

The console settings page SHALL add an "MCP Server" section that surfaces: (1) the `mcpServerEnabled` toggle (admin-gated — only an admin operator may flip it; off by default), (2) the `/mcp` endpoint URL plus connect instructions (paste the minted `mcp_` token into the MCP client's `Authorization: Bearer` header), and (3) the operator's MCP tokens — mint (a show-once dialog displaying the raw `mcp_` token once, with the same never-shown-again discipline as the API-keys card), list (prefix + last4, scopes, lifecycle state), and revoke. The raw token SHALL live only transiently in the show-once dialog and SHALL never be written to a list row. When the MCP server is disabled, the section SHALL present it as disabled (no live connect affordance) while still allowing an admin to enable it.

#### Scenario: Operator mints and sees an MCP token once

- **WHEN** an operator mints an MCP token in the settings MCP Server section
- **THEN** a show-once dialog displays the raw `mcp_…` token exactly once, the list shows only its prefix + last4 thereafter, and the operator can copy the endpoint URL + connect instructions

#### Scenario: The enable toggle is admin-gated

- **WHEN** a non-admin operator opens the MCP Server section
- **THEN** the `mcpServerEnabled` toggle is not operable by them (only an admin may flip it), while they may still mint/list/revoke their own MCP tokens

### Requirement: The API Playground page is in the route tree and navigation

The console SHALL add an `/api` route under the authed `_app` shell (a new page beside dashboard/repositories/history/settings), so it is behind the client auth gate and renders inside the existing shell (sidebar / topbar / mobile-nav). An "API 调试" entry SHALL be added to the app sidebar AND the mobile nav, routing to `/api`. The page SHALL NOT rebuild the shell — it composes inside the `<Outlet/>` like the other `_app` pages.

#### Scenario: /api is gated and reachable from the nav

- **WHEN** an authenticated operator activates the "API 调试" sidebar (or mobile-nav) entry
- **THEN** they navigate to `/api`, which renders inside the existing app shell behind the auth gate; an unauthenticated visitor to `/api` is gated like every other `_app` route

### Requirement: The /api page has a per-page pixel baseline

The `/api` page SHALL carry a per-page pixel comparison against its `screens/api.html` design baseline under the visual harness (desktop + the ≤820px mobile breakpoint), registered in the visual manifest, rendered deterministically in mock mode (a fixed selected endpoint + a sample request body + a placeholder/empty response, with any dynamic/timing region masked) so the comparison is stable.

#### Scenario: The /api page is pixel-compared against its design baseline

- **WHEN** the visual suite runs
- **THEN** the `/api` page is captured at both breakpoints and compared against its `screens/api.html` baseline under a recorded threshold, with dynamic regions masked

### Requirement: MCP Server settings operate against the live backend

The console's `mcpServer` capability flag SHALL be enabled (`true`) so the
settings "MCP Server" section mints, lists, revokes, and toggles against the
live backend endpoints (`/mcp-tokens` CRUD and `/settings/mcp-server`) rather
than the in-memory mock seam. A minted token's raw value SHALL be the SERVER's
one-time mint response — a real, persisted `mcp_` credential that resolves at the
`/mcp` endpoint — never a client-fabricated stand-in. Consistent with the
ship-inert posture, enabling this flag SHALL NOT by itself serve MCP traffic: the
`/mcp` endpoint SHALL remain gated by the backend `mcpServerEnabled` toggle, so
an admin MUST enable it for a minted token to drive a live session.

#### Scenario: MCP token mint hits the real backend

- **WHEN** an operator mints an MCP token in the settings "MCP Server" section
- **THEN** the request goes to the real `/mcp-tokens` endpoint and the show-once
  raw token is the server's one-time response, not a mock-fabricated value

#### Scenario: A minted token connects once the server is enabled

- **WHEN** an admin has enabled the backend `mcpServerEnabled` toggle and an
  operator presents a real minted token to the `/mcp` endpoint
- **THEN** the bearer is resolved and the MCP session is served — no `401
  invalid_token`, no `503` disabled

#### Scenario: Flag enabled but backend server still disabled

- **WHEN** the `mcpServer` flag is `true` but the backend `mcpServerEnabled`
  toggle is off
- **THEN** the settings section still mints / lists / revokes real tokens, while
  the `/mcp` endpoint reports the server is disabled (no live session) until an
  admin enables it

### Requirement: The forge-token help page is in the route tree behind the auth gate and reachable from the forge-credentials card

The console SHALL add a `/help/forge-tokens` route under the authed `_app` shell (a new page beside dashboard/repositories/history/settings/api), registered via `createFileRoute` so the auto-generated route tree wires it without a manual `routeTree.gen.ts` edit. The page SHALL therefore be behind the client auth gate and SHALL render inside the existing `_app` shell (sidebar / topbar / mobile-nav) via the `<Outlet/>` — it SHALL NOT rebuild the shell. The forge-credentials card (`forge-credentials-card.tsx`) SHALL expose two contextual navigation points to this page: (1) a per-row "如何申请令牌?" link next to each forge's scope hint, and (2) an in-dialog link near the connect `DialogDescription`. Each link SHALL navigate to `/help/forge-tokens` with the hash set to the matching forge kind (`#github` / `#gitlab` / `#gitee`). Consistent with the page being reached contextually from the forge card, the console SHALL NOT add a global sidebar or mobile-nav entry for the help page.

#### Scenario: The help route is gated like every other app-shell route

- **WHEN** an unauthenticated visitor requests `/help/forge-tokens` directly
- **THEN** the `_app` auth gate redirects them to `/login` before any help-page content renders, exactly as it gates `/dashboard` / `/settings` / `/api`

#### Scenario: The help page renders inside the existing shell

- **WHEN** an authenticated operator navigates to `/help/forge-tokens`
- **THEN** the page renders inside the existing `_app` shell (sidebar / topbar / mobile-nav) via the `<Outlet/>`, without rebuilding the shell

#### Scenario: Per-row card link opens the matching forge anchor

- **WHEN** the operator activates the per-row "如何申请令牌?" link for a given forge in the forge-credentials card
- **THEN** the console navigates to `/help/forge-tokens` with the hash equal to that forge's kind (`#github` for the GitHub row, `#gitlab` for GitLab, `#gitee` for Gitee)

#### Scenario: In-dialog card link opens the matching forge anchor

- **WHEN** the connect dialog for a given forge is open and the operator activates the link near its `DialogDescription`
- **THEN** the console navigates to `/help/forge-tokens` with the hash equal to the dialog's forge kind (`#github` / `#gitlab` / `#gitee`)

#### Scenario: No global nav entry is added for the help page

- **WHEN** the app sidebar and mobile nav render
- **THEN** neither contains an entry for the forge-token help page — it is reachable only from the forge-credentials card links

### Requirement: Login methods are gated by backend capability flags
The console SHALL read backend capability flags indicating which login methods are available (`passwordAuthEnabled`, and an OTP flag that is true only when SMTP is configured) and SHALL render only the enabled methods in the login modal. When OTP is disabled, the verification-code method SHALL NOT be shown; when password is disabled, the password method SHALL NOT be shown. GitHub SHALL be shown when the GitHub OAuth capability is enabled. The method switch SHALL never present a method whose backend prerequisite is absent.

#### Scenario: OTP method is hidden when SMTP is unconfigured
- **WHEN** the backend reports the OTP capability as false
- **THEN** the login modal does not render the verification-code method and offers only the remaining enabled methods

#### Scenario: All enabled methods are offered
- **WHEN** password, OTP, and GitHub capabilities are all enabled
- **THEN** the login modal presents all three methods in its switch

### Requirement: Settings shows GitHub access read-only and points to account administration
The settings page SHALL present the GitHub allowlist as a read-only display (the env-managed `AUTH_ALLOWLIST` is not editable in the UI) and SHALL surface the current operator's role. The settings page SHALL NOT provide account creation or per-account management; those SHALL live on the dedicated account-administration page reachable from the account menu (see `account-administration`). Settings SHALL continue to keep console login identity and Codex/Claude model credentials as separate concepts.

#### Scenario: GitHub allowlist is read-only in settings
- **WHEN** the operator views the GitHub section of settings
- **THEN** the allowlist entries are shown read-only with a note that they are managed by the deployment environment, and there is no in-UI edit/save of the allowlist

#### Scenario: Settings directs account management to the administration page
- **WHEN** the operator looks for account creation/management in settings
- **THEN** settings does not offer it inline and the operator reaches it via the account menu's 账号管理 entry

### Requirement: Post-login navigation performs a full document load

The console SHALL enter the authenticated console with a FULL DOCUMENT LOAD (e.g.
`window.location.assign`), NOT an in-app soft navigation, after a credential login succeeds
(email+password or email OTP) and after a forced first-login password change completes. A full
load guarantees the
react-query cache is discarded and the `_app` auth gate re-resolves the session from the existing
session cookie, so a pre-warmed STALE `authSession` value — the `null` cached by the public
landing page, or a `mustChangePassword: true` session cached before the change — cannot cause the
gate to bounce the just-authenticated operator back to `/login`. The destination SHALL remain the
open-redirect-guarded relative `redirect` deep-link when present, otherwise `/dashboard`. The
GitHub OAuth method, which already performs a full-page redirect, is unchanged; the local mock
gate path (sessionStorage) is unaffected.

#### Scenario: Password/OTP login from a landing-prewarmed session reaches the dashboard

- **WHEN** an operator opens the public landing (which pre-warms `authSession` to null), then logs in with email+password or email OTP in REAL/auth-on mode
- **THEN** the console performs a full document load into `/dashboard` (or the carried redirect) and the auth gate admits the operator instead of bouncing back to `/login`

#### Scenario: Forced-change completion reaches the console without looping

- **WHEN** a must-change operator, whose cached session still carries `mustChangePassword`, completes the forced password change
- **THEN** the console performs a full document load into the console and the gate admits the operator, rather than bouncing back into the forced-change dialog

#### Scenario: Post-login navigation does not depend on react-query cache freshness

- **WHEN** the post-login or forced-change-completion navigation runs
- **THEN** it uses a full document load rather than a soft `navigate` into the gate, so a stale in-memory `authSession` cache value cannot reject the freshly established session

### Requirement: Settings page has an admin-only Resend SMTP section

The Settings page SHALL present an admin-only 邮件发送（Resend）section where an administrator can
view the current configuration status (masked — the API Key shown only as a suffix, NEVER plaintext),
open a Resend-shaped config dialog, and send a test email. The dialog SHALL collect only what Resend
needs — the **API Key** (which IS the SMTP password) and the **sender (from) address** — and SHALL
present the fixed parameters (`smtp.resend.com` / port `465` / username `resend`) as fixed copy,
NOT editable fields. The API Key field SHALL NEVER be pre-filled (empty = keep the existing key);
the sender field SHALL carry a hint that the domain must be verified at Resend while the local part
is free (no real mailbox needed). The section and dialog SHALL link to the Resend help page.
Non-admin operators SHALL NOT be shown the management controls — a UX gate only; the backend
independently enforces admin-only on every SMTP endpoint.

#### Scenario: Admin configures Resend with only API Key + sender

- **WHEN** an admin opens the Resend SMTP config dialog
- **THEN** it asks only for the API Key and the sender address (the host/port/username are shown as fixed Resend values, not inputs) and offers a 发送测试 action

#### Scenario: The API Key is never pre-filled

- **WHEN** the dialog opens for an existing configuration
- **THEN** the API Key field is empty (the server returned only a masked suffix) while the sender address may be pre-filled

#### Scenario: Non-admin does not see the controls

- **WHEN** a non-admin operator opens Settings
- **THEN** the Resend SMTP management controls are not presented (and the backend denies any SMTP endpoint regardless)

### Requirement: Resend SMTP help page

The console SHALL provide a Resend SMTP help page behind the auth gate, reachable from the SMTP
section and dialog, rendering app-authored markdown through the SAME trusted pipeline as the
forge-token help (react-markdown + remark-gfm, no raw HTML execution; content loaded at build time).
It SHALL document, in order: verifying a sending domain, creating an API Key, filling the console
(API Key + sender), the fixed parameters, and the mainland-email caveat.

#### Scenario: Help page is reachable from the SMTP section

- **WHEN** an admin clicks the help link in the SMTP section or the config dialog
- **THEN** the Resend SMTP help page opens behind the auth gate with the step-by-step setup

#### Scenario: Help renders trusted app-authored markdown

- **WHEN** the help page renders
- **THEN** it shows the app-authored markdown via the trusted renderer (GFM, no raw HTML execution)

### Requirement: Console exposes sandbox image management

The console SHALL expose a left-sidebar `镜像管理` product navigation entry that
opens an authenticated `/images` page for task startup image/default management.
The `/settings` access/defaults form SHALL render a user-scoped default image
selector as a plain dropdown backed by account settings; the saved value SHALL
follow the current user and SHALL be used for new task creation when no per-task
override is supplied. The `/images` page SHALL be dedicated to the admin-only
image library. Image-library controls SHALL be separate from the user default
selector and SHALL be hidden behind an explicit image-reference registration
action rather than occupying the settings form. The image library SHALL list
sandbox environments with name, provider family/source kind, runtime
compatibility, readiness status, and last validation time. Admins SHALL be able
to register an existing AIO or BoxLite registry image reference, run validation,
and inspect validation errors. The settings area SHALL NOT surface
image-library management controls. The image library SHALL NOT present upload,
build, registry-hosting, registry-credential, loaded-image, or rootfs-source
controls.

#### Scenario: Admin opens image management from the sidebar

- **WHEN** an admin opens the console sidebar
- **THEN** the sidebar includes `镜像管理`
- **WHEN** the admin opens `/images`
- **THEN** the page shows the admin image library with configured environments,
  readiness, and compatibility information
- **AND** validation details are available without crowding the main list

#### Scenario: Admin registers an existing image reference

- **WHEN** an admin opens the image registration form
- **THEN** the form asks for a display name, provider family, already-published
  image reference, and optional runtime ids
- **AND** the primary action uses registration/reference language rather than
  upload/build language
- **AND** the form links to the external build/push guide and base-image
  templates

#### Scenario: Operator chooses their own default image

- **WHEN** an authenticated operator opens `/settings`
- **THEN** the access/defaults form shows a plain default-image dropdown
- **WHEN** the operator selects a ready image and saves
- **THEN** the account settings response stores that image id as
  `defaultSandboxEnvironmentId`
- **AND** a later task created without an explicit sandbox environment uses that
  user's saved image

#### Scenario: Non-admin cannot edit environments

- **WHEN** a non-admin operator opens image management or settings
- **THEN** the operator can still set their own default image
- **AND** environment management actions are absent or disabled
- **AND** direct API attempts to mutate environments are rejected by the backend

#### Scenario: Validation failure is visible

- **WHEN** an environment validation fails
- **THEN** the image-library detail view shows the latest failure reason and probe
  summary
- **AND** the environment is shown as not selectable for new tasks

### Requirement: Create-task surfaces ready environment selection

The create-task dialog and full create-task page SHALL provide a compact
`运行环境` selector. The selector SHALL be filtered by the selected agent runtime
and SHALL only allow ready compatible environments. It SHALL include a
`使用我的默认镜像` choice that omits `sandboxEnvironmentId` so the backend resolves
the current user's `defaultSandboxEnvironmentId`, and it MAY include a separate
`使用服务端默认` choice that sends `sandboxEnvironmentId: null` to bypass the
user default for that task.

#### Scenario: Selector filters by runtime

- **WHEN** the operator switches the task runtime from Codex to Claude Code
- **THEN** the environment selector updates to show only ready environments
  compatible with `claude-code`
- **AND** incompatible environments are not selectable

#### Scenario: Selected environment is submitted

- **WHEN** the operator selects a ready environment and submits a task
- **THEN** the create request body carries that environment's
  `sandboxEnvironmentId`
- **AND** the command preview or task summary reflects the selected environment
  without exposing provider secrets

#### Scenario: No ready custom environment still allows default

- **WHEN** no ready managed environment exists for the selected runtime
- **THEN** the selector still offers the current user's default-image path
- **AND** the operator can explicitly choose the service default path for this
  task when they do not want to follow their account default

### Requirement: Image library exposes environment retirement and validation guidance

The console image library SHALL let admins retire failed or obsolete sandbox
environment records from the management surface while preserving their
diagnostic validation history. The UI SHALL refresh the environment list after
retirement, SHALL NOT expose retired environments in the settings default-image
selector, and SHALL present provider validation failures with enough context for
operators to distinguish registry reachability, authorization, architecture, and
missing-tool problems.

#### Scenario: Admin retires an image from the image library

- **WHEN** an admin activates the retire action for a sandbox image record
- **THEN** the console calls the admin lifecycle API
- **AND** the retired image no longer appears as selectable for task creation or
  user default-image settings

#### Scenario: Validation failure shows actionable detail

- **WHEN** image validation fails and the validation record contains provider
  failure details
- **THEN** the image library displays the non-secret failure reason and probe
  details
- **AND** the operator can tell whether the likely issue is registry access,
  image architecture, missing runtime tools, or provider configuration

### Requirement: Custom image help keeps product and deployment paths separate

The console custom image help SHALL present registry image references as the
managed image-library path and SHALL present BoxLite OCI rootfs customization as
an advanced deployment-level server-default path. The help SHALL instruct
operators to extend the official AIO or BoxLite base image, build and push it
with their own Docker/CI/registry tooling, register the resulting reference in
CAP, and validate it before users can select it. The help SHALL NOT describe
BoxLite rootfs paths, loaded Docker images, upload artifacts, or CAP-built
images as image-library source types.

#### Scenario: Image-library instructions use registry references

- **WHEN** an operator reads the console custom image guide for `/images`
- **THEN** the guide instructs them to build, tag, push, register, and validate
  a pinned AIO or BoxLite image reference
- **AND** it does not ask them to select rootfs or loaded-image source types
- **AND** it states that CAP does not build, upload, host, or publish the image

#### Scenario: BoxLite rootfs guide is labeled deployment-level

- **WHEN** an operator reads the BoxLite rootfs customization guidance
- **THEN** the guide labels it as a deployment-level server default using
  `BOXLITE_ROOTFS_PATH`
- **AND** it states that this path is used only when no managed image
  environment is selected
- **AND** it does not describe rootfs as a user-selectable image-library option

### Requirement: Console manages scheduled tasks
The authenticated console SHALL provide recurring task management for the
current account. Operators SHALL create recurring work from the same task
creation surfaces used for immediate task dispatch by choosing a "run once" or
"run repeatedly" mode. The `/schedules` route SHALL be an overview and
management surface for existing recurring automation definitions: operators can
list schedules, inspect recent schedule runs, open linked tasks, pause and
resume schedules when those controls are available, edit future schedule
settings through the task creation form, and delete a schedule after
confirmation. The console SHALL present schedules as recurring automation
definitions, not as task statuses, and SHALL NOT expose cron expressions to
ordinary operators.

#### Scenario: Operator creates a recurring task from task fields
- **WHEN** the operator selects "run repeatedly" while submitting the task
  creation form with repo, prompt, recurrence, timezone, runtime, environment,
  delivery, skills, idle timeout, and deadline selections
- **THEN** the console calls the schedule create API with those fields
- **AND** the created schedule appears in the schedule overview without creating
  an immediate task unless the recurrence is due

#### Scenario: Operator creates an immediate task from the same surface
- **WHEN** the operator selects "run once" while submitting the task creation
  form
- **THEN** the console calls the existing task create API
- **AND** no schedule definition is created

#### Scenario: Schedules overview does not create schedules
- **WHEN** the operator opens `/schedules`
- **THEN** the page shows existing recurring task definitions and their recent
  run state
- **AND** it does not render a standalone schedule creation form or a "new
  schedule" action

#### Scenario: Operator edits future schedule settings
- **WHEN** the operator chooses to edit a schedule from `/schedules`
- **THEN** the console opens the task creation form in edit-recurring mode with
  the schedule's task template and recurrence prefilled
- **AND** saving updates the existing schedule for future fires without creating
  an immediate task

#### Scenario: Operator pauses and resumes a schedule
- **WHEN** the operator pauses an enabled schedule
- **THEN** the console calls the pause API and the schedule no longer fires
  future occurrences while paused
- **AND** when the operator resumes it, the console calls the resume API and the
  schedule computes a future `nextRunAt`

#### Scenario: Operator views schedule runs and opens tasks
- **WHEN** the operator opens a schedule's recent run history
- **THEN** the console shows each occurrence status, scheduled fire time, and
  linked task when one exists
- **AND** selecting a linked task navigates to the ordinary `/tasks/$taskId`
  session or replay route

### Requirement: Schedule UI surfaces missed and skipped fires honestly
The console SHALL display failed and skipped schedule runs as schedule-run
outcomes rather than fabricating task rows. Overlap skips, invalid owner/runtime
failures, deleted repos, and invalid sandbox environments SHALL be visible in
the run history with non-secret reasons returned by the API.

#### Scenario: Skipped overlap is visible without a task link
- **WHEN** a schedule occurrence is skipped because the prior scheduled task is
  still active
- **THEN** the schedule run history shows a skipped-overlap outcome
- **AND** it shows no linked task id for that occurrence

#### Scenario: Failed fire shows a non-secret reason
- **WHEN** a schedule occurrence fails before task creation
- **THEN** the run history shows a failed outcome and the non-secret API reason
- **AND** it does not link to a fabricated task

### Requirement: Schedule list reflects next fire and enabled state
The schedule list SHALL show each schedule's name or prompt summary, repo,
runtime, enabled/paused state, human-readable recurrence summary, timezone, next
run time, overlap policy, and last run outcome when available. The list SHALL
refresh on the same kind of lightweight polling used by task/dashboard surfaces
so operators can see recent fires without a manual reload. The list SHALL NOT
display raw cron expressions.

#### Scenario: Schedule list shows next run
- **WHEN** the operator opens the schedule management view
- **THEN** each schedule row shows its next run time, timezone, enabled state,
  recurrence summary, and latest run outcome when present
- **AND** the row does not show a cron expression

#### Scenario: Custom recurrence does not expose cron
- **WHEN** a schedule was created from a cron expression that cannot be mapped
  to the console's supported recurrence presets
- **THEN** the schedule row shows an opaque custom recurrence summary and the
  next run time
- **AND** it does not show the raw cron expression

#### Scenario: Schedule list refreshes after a fire
- **WHEN** a schedule fires while the management view is open
- **THEN** the list refreshes and shows the updated next run time and latest run
  outcome

### Requirement: Task creation surfaces support recurring mode
The task creation dialog and the full-page advanced task creation route SHALL
let operators choose whether the submitted task runs once or repeatedly. The
repeated mode SHALL reuse the same task-template controls as immediate task
creation and SHALL add recurrence controls that do not require cron syntax.

#### Scenario: Recurrence controls use human choices
- **WHEN** the operator configures repeated execution
- **THEN** the console offers supported human-readable recurrence choices such
  as daily, weekdays, weekly, or monthly at a local time
- **AND** it submits recurrence fields rather than a user-entered cron string

#### Scenario: Existing task template controls are shared
- **WHEN** the operator switches between run-once and run-repeatedly modes
- **THEN** repo, prompt, runtime, sandbox environment, delivery, skills, idle
  timeout, and deadline selections remain in one shared task-template form
- **AND** the selected mode only changes the submit target and recurrence
  controls

### Requirement: Task startup shows the effective sandbox toolchain versions

The console SHALL show the effective sandbox version and every builder-declared dependency version from the task's persisted sandbox metadata snapshot in the task startup/session surface. The console SHALL use friendly labels for the official `codex`, `claude-code`, and `openspec` keys and SHALL render unknown custom dependency keys without requiring a frontend catalog entry. It SHALL NOT infer versions from the CAP release, image tag, current environment validation, or locally configured defaults.

#### Scenario: Official sandbox starts with version details
- **WHEN** an operator opens a task whose official sandbox has completed metadata preflight
- **THEN** the startup/session surface shows the effective sandbox, Codex, Claude Code, and OpenSpec versions
- **AND** those values come from the task's persisted effective snapshot

#### Scenario: Custom dependency is displayed generically
- **WHEN** a task snapshot includes a builder-declared dependency key that the console does not recognize
- **THEN** the startup/session surface displays that key and version without dropping it

#### Scenario: Metadata is not yet available
- **WHEN** the sandbox is still provisioning and no effective metadata snapshot has been persisted
- **THEN** the console retains the existing sandbox-starting state without fabricating version values

#### Scenario: Metadata preflight fails
- **WHEN** sandbox startup fails because required metadata is missing or invalid
- **THEN** the task surface shows the resulting concrete preflight failure
- **AND** it does not display versions from the requested image or environment as though launch succeeded

### Requirement: Official Codex authorization is a two-stage recoverable flow
The Codex direct-authorize dialog SHALL keep the operator in the existing dialog while a session is preparing and SHALL NOT open an about:blank, placeholder, or external browser tab before the server provides a verification URL and user code. Once the session is awaiting authorization, the dialog SHALL display the server-provided code and URL and provide a distinct user-activated action that opens that exact URL in a new tab with opener and referrer isolation. The dialog SHALL visibly represent preparing, awaiting authorization, finalizing, connected, expired, cancelled, and error outcomes; closing, cancelling, or retrying SHALL target the exact sessionId and late responses SHALL NOT restore a dismissed or superseded UI state.

#### Scenario: Starting login does not open a blank tab
- **WHEN** the operator activates Connect and the server reports preparing
- **THEN** the existing dialog shows preparation progress and no about:blank, placeholder, or OpenAI tab is opened

#### Scenario: Authorization link requires a fresh user action
- **WHEN** the session reaches awaiting_authorization
- **THEN** the dialog shows the returned user code and verification URL and presents an explicit Open OpenAI authorization action
- **AND** activating that action opens the server-provided URL with target=_blank and rel containing noopener and noreferrer

#### Scenario: Closing during preparation cancels the exact attempt
- **WHEN** the operator closes or cancels the dialog while the session is preparing or awaiting authorization
- **THEN** the Web client requests cancellation for that sessionId, stops polling it, and ignores all later responses belonging to it

#### Scenario: Terminal failure is visible and retryable
- **WHEN** the session becomes expired, cancelled, or error
- **THEN** the dialog shows a clear secret-free outcome and offers a retry that creates or recovers only one active attempt

#### Scenario: Connected status remains synchronized
- **WHEN** the session reaches connected
- **THEN** the dialog closes or shows success according to the existing settings interaction and the Codex credential status surfaces refresh to the same connected state

### Requirement: Device-code copying works on supported console origins
The direct-authorize dialog SHALL provide a copy operation whenever a user code is present. It SHALL prefer the asynchronous Clipboard API when available in a secure context, provide a compatibility copy path when that API is unavailable or rejects the operation on a supported HTTP origin, and always report the outcome. If no programmatic copy path succeeds, the dialog SHALL select or focus the visible code and instruct the operator to use the platform copy shortcut. A copy failure SHALL NOT be silently ignored, and the copy control SHALL be unavailable before a code exists.

#### Scenario: Modern clipboard copy succeeds
- **WHEN** a user code is present and the browser permits asynchronous clipboard writing
- **THEN** activating Copy writes the exact code and shows an explicit copied confirmation

#### Scenario: Non-secure HTTP origin uses compatibility copying
- **WHEN** CAP is opened on a supported non-loopback HTTP origin where navigator.clipboard is absent or clipboard writing is denied
- **THEN** activating Copy attempts the compatibility path within the user action and reports success when the code reaches the clipboard

#### Scenario: All programmatic copy paths fail
- **WHEN** neither modern nor compatibility copying succeeds
- **THEN** the visible user code is selected or focused and the dialog tells the operator to press Ctrl+C or Command+C

#### Scenario: Copy is disabled before code issuance
- **WHEN** the login session is idle or preparing and no user code is present
- **THEN** the copy control is disabled or absent and cannot report a false success

### Requirement: Task creation uses the effective runtime model catalog

The console's one-off and recurring task-creation surfaces SHALL offer a model
selector driven by the shared runtime-model catalog for the currently selected
runtime and sandbox-environment state. The default choice SHALL submit no
`model` and be labeled as using the effective runtime default. The selector
SHALL represent loading, empty, constrained, unavailable, and ready catalog
states without falling back to a frontend-maintained static model list or an
unvalidated arbitrary text value.

#### Scenario: Runtime and environment drive the choices

- **WHEN** an operator changes the selected runtime or sandbox environment
- **THEN** the console queries the catalog for that exact three-state execution context
- **AND** the selector displays only the returned choices and their safe metadata

#### Scenario: Default model leaves the request field absent

- **WHEN** the operator keeps the "runtime default" choice
- **THEN** the one-off task or recurring template is submitted without a `model` selector

#### Scenario: A constrained catalog is not presented as complete

- **WHEN** the catalog response says its model set is constrained or best-known
- **THEN** the console communicates that limitation while allowing only the validated returned selectors

#### Scenario: Catalog failure is actionable

- **WHEN** model catalog loading fails
- **THEN** the console shows a retryable, non-secret error and a retry action
- **AND** it does not silently substitute a static list or submit a stale explicit selection

### Requirement: Context changes cannot silently submit a stale model

The console SHALL associate a selected model with the catalog context that
produced it. After runtime, environment, credential readiness, or returned
catalog revision changes, it SHALL retain the selector only if it is present in
the refreshed catalog; otherwise it SHALL clear the explicit selection to the
runtime default and inform the operator. A server-side unavailable/catalog
error at submit time SHALL refresh the catalog and preserve all unrelated form
input for correction.

#### Scenario: Selected model remains valid after refresh

- **WHEN** catalog context refreshes and the selected id remains available
- **THEN** the console retains the operator's selection

#### Scenario: Selected model disappears after context change

- **WHEN** the runtime or environment changes and the previously selected id is absent from the new catalog
- **THEN** the console clears that explicit selection, informs the operator, and does not submit it silently

#### Scenario: Server rejects a stale selection

- **WHEN** task or schedule submission returns `runtime_model_not_available` or `runtime_model_catalog_unavailable`
- **THEN** the form preserves prompt, repository, schedule, and guardrail inputs, refreshes the model state, and presents the safe server error

### Requirement: Task views distinguish requested and actual models

Task details and history surfaces SHALL display the requested model (or runtime
default when null) separately from a runtime-reported actual model when that
fact is available. If the values differ, the console SHALL show both without
claiming that the task request was rewritten.

#### Scenario: Requested alias resolves to an actual model

- **WHEN** a task requested an alias and session history reports a concrete actual model
- **THEN** the console labels and displays both the requested selector and actual model

#### Scenario: Actual model is unknown

- **WHEN** the runtime has not reported an actual model
- **THEN** the console displays the requested choice or runtime-default intent and does not invent an actual value

### Requirement: Schedule views expose model preflight and retry state

The console SHALL distinguish a permanent unavailable-model occurrence from a
transient catalog outage that is retrying. It SHALL display the stable error
code and safe message, and for retrying occurrences SHALL display attempt and
next-retry information without claiming that a Task has started.

#### Scenario: Catalog outage is waiting to retry

- **WHEN** a schedule run has status `retrying` with `runtime_model_catalog_unavailable`
- **THEN** the schedule UI shows the next retry and attempt state with no Task link

#### Scenario: Model failure is terminal

- **WHEN** a schedule run has terminal `runtime_model_not_available`
- **THEN** the schedule UI explains that the selector must be changed and does not present the occurrence as still retrying

### Requirement: Console task creation uses verified branches and durable acceptance

Both Console create-task entry points SHALL use the shared task mutation and
SHALL preselect only a persisted verified repository default branch. When no
real branch is known for a legacy repo, the form SHALL omit the branch and let
the authenticated backend resolution path decide; it SHALL NOT fabricate
`main` or `master`. After the create response returns a committed task id, the
modal/page SHALL stop its creating state, navigate to `/tasks/$taskId`,
invalidate task queries, and observe provisioning through canonical polling/SSE.
The creating spinner SHALL NOT remain coupled to sandbox creation or clone
duration.

The task page SHALL render secret-free provisioning stages and actionable
capacity, timeout, forge-authentication, network/TLS, missing-branch/ref, and
platform-dependency failures from the canonical Task response. A
`provisioning_platform_dependency_unavailable` failure SHALL direct the
operator to repair or upgrade the deployment and SHALL NOT suggest reconnecting
the forge or retrying a TLS connection. The Console SHALL not parse raw server
logs or Git output to infer a cause. URL import and refresh SHALL display the
owner-aware typed failure and SHALL not add or overwrite a repository after
failed verification.
Schedule latest-run and run-history surfaces SHALL apply the same
deployment-repair presentation when their canonical nested `taskFailure`
contains this code; they SHALL NOT silently omit it merely because existing
credential-only badges do not recognize the action.

#### Scenario: Create navigates while clone is still running

- **WHEN** the create mutation receives the committed task response while workspace transfer remains active
- **THEN** the Console closes or unmounts the create UI and navigates immediately to `/tasks/$taskId`
- **AND** the task page renders the current provisioning stage from polling/SSE

#### Scenario: Master is preselected from repository data

- **WHEN** the selected repository's verified `defaultBranch` is `master`
- **THEN** both create entry points preselect `master`
- **AND** no code path replaces it with `main`

#### Scenario: GitHub trunk is not replaced by a conventional default

- **WHEN** the selected GitHub repository's verified `defaultBranch` is `trunk`
- **THEN** both create entry points preselect and submit `trunk`
- **AND** neither `main` nor `master` is fabricated

#### Scenario: Unknown legacy branch is not fabricated

- **WHEN** a legacy repository has a null default branch
- **THEN** the Console submits no invented branch value
- **AND** it renders the backend's resolved branch or structured resolution failure after durable acceptance

#### Scenario: Provisioning failure is actionable

- **WHEN** a task fails workspace transfer because its sandbox disk is exhausted
- **THEN** the task page renders the capacity-specific safe message/action
- **AND** the create modal is no longer shown as indefinitely creating

#### Scenario: Platform dependency failure points to deployment repair

- **WHEN** a task exposes `provisioning_platform_dependency_unavailable`
- **THEN** the task page renders deployment-repair guidance from the canonical failure code
- **AND** it does not label the failure as forge authentication, network, or TLS

#### Scenario: Schedule run shows the same platform dependency action

- **WHEN** a schedule latest run or history item nests `provisioning_platform_dependency_unavailable`
- **THEN** the schedule surface renders the same deployment-repair guidance as the task page
- **AND** it does not hide the failure behind a credential-only badge or generic dispatch status

### Requirement: Console refreshes verified repository default branches

The repositories Console SHALL offer a refresh action for every imported
GitHub, Gitee, or GitLab repository instead of rendering the already-imported
state as permanently disabled. The action SHALL call the authenticated
Console/Internal default-branch refresh endpoint without sending a branch
value. On success it SHALL display the returned verified branch and invalidate
repository reads plus both task-create surfaces. On failure it SHALL retain and
display the prior verified branch and map the stable import error to safe
operator guidance without parsing Git output or guessing `main` or `master`.

#### Scenario: Refresh updates task-create defaults

- **WHEN** an operator refreshes an imported repository after remote symbolic HEAD changes to `trunk`
- **THEN** the repository UI and both task-create entry points use the returned `trunk` value
- **AND** the browser does not submit or fabricate another branch

#### Scenario: Failed refresh preserves visible verified state

- **WHEN** refresh fails with authentication, access, network, ref, or platform dependency error
- **THEN** the Console renders code-based safe guidance and keeps the previous verified branch visible
- **AND** it does not optimistically overwrite repository data

#### Scenario: Already imported candidate is refreshable without duplication

- **WHEN** a GitHub, Gitee, or GitLab picker candidate reconciles to an existing Repo
- **THEN** the Console offers branch refresh for that Repo rather than a second import
- **AND** successful refresh retains the same platform Repo id

### Requirement: Console renders owner and administrator provisioning diagnostics safely

The session-authenticated Console task detail SHALL provide a provisioning
diagnostics view backed by the same task-owned diagnostic query service and
canonical strict response schema as Public V1 and MCP. A non-administrator
account SHALL read only its own task; an administrator MAY inspect a cross-owner
or ownerless historical task. The Internal Console route SHALL accept only a
session principal, and before cross-owner access it SHALL re-read the live User
row and require `allowed = true` plus current `role = admin`; it SHALL NOT trust
a stale session role snapshot. The Console SHALL enforce this authorization on
the server before returning data and SHALL NOT rely on hiding a tab or route in
the browser as the access-control boundary.

The view SHALL group the bounded timeline by provisioning attempt and render
safe stage/operation, outcome, timing, retry, settlement-degradation, and
evidence-availability facts from the canonical union. It SHALL display the
primary provisioning failure separately from any secondary cleanup failure or
cleanup-confirmation state so cleanup cannot visually replace the original
cause. Pagination SHALL use the canonical `limit`/`cursor` contract and stable
ordering; loading another page SHALL append records without duplicating or
reordering the timeline.

For accepted tasks that have not started provider processing and for tasks that
predate diagnostic persistence or have only partial evidence, the view SHALL
render the canonical not-started/empty/degraded state rather than reconstructing
a cause from audit prose, terminal replay, or rotated logs. The view SHALL never display command text,
stdout/stderr, request or response bodies, headers, authenticated repository
URLs, credentials or temporary paths, prompts, environment dumps, lease
owners, provider endpoints, stacks, or arbitrary diagnostic fields. Ordinary
task status, transcript, terminal, and schedule projections SHALL continue to
consume the existing Task schemas and SHALL NOT be widened with the diagnostic
ledger.

API-key and MCP-token scope selectors in Settings SHALL offer
`tasks:diagnostics` as an explicit opt-in permission with a warning that it
grants deeper task provisioning evidence. Existing defaults and previously
minted credentials SHALL remain unchanged; selecting `tasks:read` or
`tasks:write` SHALL NOT automatically select it.

#### Scenario: Task owner sees a safe attempt timeline

- **WHEN** an authenticated non-administrator opens provisioning diagnostics for a task owned by that account
- **THEN** the Console renders the canonical attempt-grouped timeline in stable order
- **AND** primary provisioning and secondary cleanup outcomes are visually distinct

#### Scenario: Administrator inspects a cross-owner task

- **WHEN** an authenticated administrator opens diagnostics for another account's task
- **THEN** the server-authorized canonical query returns the safe timeline
- **AND** the UI does not bypass or duplicate the shared query service

#### Scenario: Administrator authorization is rechecked live

- **WHEN** a session snapshot says admin but the current User row is disabled or no longer has `role = admin`
- **THEN** the Internal Console route denies the cross-owner diagnostic read
- **AND** no Public V1, MCP, API-key, or legacy-token principal receives the Console administrator exception

#### Scenario: Non-owner access fails closed

- **WHEN** an authenticated non-administrator navigates directly to diagnostics for another account's task
- **THEN** the server rejects the read without returning timeline data
- **AND** hiding or showing the client view has no bearing on the authorization result

#### Scenario: Legacy task renders an honest degraded state

- **WHEN** an authorized operator opens a task created before complete provisioning diagnostics were retained
- **THEN** the view shows the canonical partial or unavailable evidence state
- **AND** it does not invent a command failure, provider cause, or cleanup result from generic history

#### Scenario: Accepted task renders not-started evidence

- **WHEN** durable work is committed or capacity-queued but no provider attempt has begun
- **THEN** the view shows its canonical admission state with not-started diagnostic coverage
- **AND** it does not label the empty attempt timeline as unavailable history or provider failure

#### Scenario: Pagination preserves timeline order

- **WHEN** an operator loads successive diagnostic pages
- **THEN** each record appears once in stable ledger order under its attempt
- **AND** no page load reorders earlier events or merges primary and cleanup outcomes

#### Scenario: Console never renders forbidden diagnostic material

- **WHEN** provider and cleanup failures contain a unique secret canary, commands, output, endpoints, or stack text
- **THEN** none of that material appears in the diagnostics view, browser query cache, error toast, or copied text

#### Scenario: Diagnostic credential scope is opt-in

- **WHEN** an operator configures scopes for a new API key or MCP token
- **THEN** `tasks:diagnostics` is available as a separate unchecked permission
- **AND** selecting ordinary task read or write permissions does not grant it
