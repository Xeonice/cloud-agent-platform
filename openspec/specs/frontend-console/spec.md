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
The `/tasks/$taskId` page SHALL be the ONLY client-only route (route option `ssr: false`): it SHALL render a `pendingComponent` terminal skeleton on the server (never touching `window`), and on the client mount the `<Terminal>` component, connect to the task's authenticated WebSocket via the reused `TerminalSocket`, render the raw byte stream directly to the terminal (raw bytes SHALL NOT pass through the TanStack Query cache), display the live connection status, and provide DIRECT 1:1 keystroke input typed straight into the live `<Terminal>` as the SOLE live-terminal input surface — the xterm `onData` path SHALL forward each keystroke verbatim (Enter as `\r`, arrows, Ctrl-C, backspace; clipboard pastes auto-wrapped in `ESC[200~`/`ESC[201~`) to the lease-gated keystroke channel, seizing the write lease on first input — with NO separate command-input box and NO delayed-carriage-return submit hack on the live path. The page SHALL provide a connection-state affordance so that typing while the socket is not OPEN is visibly inert rather than silently dropped, and SHALL focus the terminal on mount. The page SHALL show a live PER-TASK resource readout sourced from the per-task metrics read (`resource-metrics`): it SHALL show codex's OWN process CPU percent and memory as the PRIMARY figure with the container total as secondary/background context, labeled by the reading's `scope` (`process` vs the `container` fallback), replacing any hard-coded placeholder, and SHALL degrade honestly to "未运行/未采样" only when the task has no live sampled container rather than displaying fabricated zeros — a still-running task that merely missed a sampling tick SHALL keep showing its (possibly stale) reading, not flip to not-running. The page SHALL surface the task's CONFIGURED GUARDRAILS read back from the task (`idleTimeoutMs`/`deadlineMs`) as an honest readout (e.g. "空闲回收: 30 分钟 / 关闭", "运行时限: 2 小时 / 无"), reflecting the persisted values rather than fabricating them. The page SHALL provide a manual "停止任务" control that, after an explicit operator confirmation, POSTs to `POST /tasks/:taskId/stop` to transition the task to `cancelled`, and on success reconciles the cached task entry; the control SHALL be inert/hidden for a task already in a terminal state. For a freshly-created task that has not yet reached `running` (status `pending`/`queued`, sandbox not yet provisioned), the page SHALL show a friendly early-state placeholder ("排队中 / 沙箱启动中…") driven by the task status, and SHALL transition to the live terminal once the task reaches `running`, so navigating into a just-created session never lands on a blank/confusing screen. The page SHALL also present an approval surface for pending `PermissionRequest` decisions. Discrete control frames (task completion, lease/write-lock changes, approval decisions) SHALL be bridged back into the query cache via `queryClient.setQueryData(['tasks', id], …)` or invalidation. The WebSocket handshake SHALL authenticate via the existing token query parameter plus `bearer.<token>` subprotocol (browsers cannot set an `Authorization` header on WS) and SHALL NOT attempt to set request headers.

#### Scenario: Session page streams the live terminal
- **WHEN** the operator opens `/tasks/$taskId` for a running task
- **THEN** the client connects the WebSocket and writes the task's live byte stream directly to the `<Terminal>` component without routing raw bytes through the query cache

#### Scenario: Session page shows codex's own CPU and memory with scope
- **WHEN** the operator views `/tasks/$taskId` for a `running` task
- **THEN** the page shows codex's OWN process CPU percent and memory as the primary figure (with the container total as background context), labeled by the reading's `scope`, not a hard-coded placeholder and not silently the global aggregate

#### Scenario: Per-task resource degrades honestly when not running
- **WHEN** the task has no live sampled container (not running yet, or genuinely exited)
- **THEN** the per-task resource readout shows "未运行/未采样" rather than fabricated zeros

#### Scenario: A still-running task does not flicker to not-running on a missed tick
- **WHEN** the open task is still running but its latest per-task read carried forward a stale reading (a sampling tick was missed)
- **THEN** the readout keeps showing the (possibly stale) CPU/memory figure rather than flipping to "未运行/未采样"

#### Scenario: Session page shows the task's configured guardrails
- **WHEN** the operator views a task that was created with an `idleTimeoutMs` and/or `deadlineMs` (or neither)
- **THEN** the page shows the configured idle-reclaim and deadline values read back from the task (showing "关闭"/"无" when a value is absent), never fabricating a value that was not set

#### Scenario: Operator stops a task from the session page
- **WHEN** the operator activates the "停止任务" control for an active task and confirms
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
- **THEN** the page shows an approval surface offering allow/deny, and submitting a decision resolves it independently of the write lock

#### Scenario: Control frame bridges back into the query cache
- **WHEN** a control frame indicating task completion or a lease change arrives over the WebSocket
- **THEN** the console updates the cached task entry via `queryClient.setQueryData`/invalidation so other views reflect the new status, while raw output bytes remain out of the cache

#### Scenario: Terminal falls back when xterm is unavailable
- **WHEN** the xterm runtime is unavailable on the client
- **THEN** the session page renders a fallback DOM line view (terminal-line dim/ok/warn) plus a command input row (the fallback path retains a line input because there is no live terminal to type into) instead of crashing

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
The pathless `_app` layout SHALL render the shared app-shell for all six app pages: a shadcn `SidebarProvider` + `Sidebar` (brand mark; navigation items 任务控制台 / 仓库导入 / 历史日志 with ⌘1/⌘2/⌘3 mono hints and an active dark pill), a `SidebarInset`, a sticky blurred `Topbar` (breadcrumb eyebrow + right-side action slot), an `AccountMenu` (Avatar with `TH` initials + DropdownMenu offering 打开设置/退出登录 + an OAuth-verified status dot, shared by desktop and mobile), and a `MobileNav` (fixed bottom bar of 4 columns 控制台/仓库/历史/账户, hidden on desktop). Navigation active highlighting SHALL map `/tasks/$taskId` (session) and `/tasks/new` (create) back to the 任务控制台 (dashboard) item using router state. The `AccountMenu` SHALL close on `Escape` and outside-click and expose `aria-expanded`.

#### Scenario: App pages render the full shell
- **WHEN** any `_app` page renders on a desktop viewport
- **THEN** it shows the sidebar, the sticky topbar, and the account menu, with the matching sidebar item highlighted by an active dark pill

#### Scenario: Session and create routes highlight dashboard
- **WHEN** the operator is on `/tasks/$taskId` or `/tasks/new`
- **THEN** the sidebar highlights the 任务控制台 (dashboard) navigation item

#### Scenario: Mobile shows the bottom navigation
- **WHEN** an `_app` page renders below the mobile breakpoint
- **THEN** the fixed bottom `MobileNav` with 控制台/仓库/历史/账户 appears and the 账户 entry opens the same `AccountMenu`

#### Scenario: Account menu is keyboard and click dismissible
- **WHEN** the `AccountMenu` is open
- **THEN** pressing `Escape` or clicking outside closes it, and its trigger reflects state via `aria-expanded`

### Requirement: Client auth gate on the app-shell
The `_app` layout SHALL enforce an authentication gate in `beforeLoad`: an unauthenticated visitor to any app-shell route SHALL be redirected to `/login`, CARRYING the attempted app path as a `redirect` search param (e.g. `/login?redirect=/tasks/abc`) so the post-login flow can return the operator to where they were headed. Authentication state SHALL be read through the auth session source (real GitHub OAuth session when the auth capability is enabled per the capabilities switch, otherwise the client token gate). The gate SHALL fire on a DIRECT page load / refresh / deep-link, not only on in-app soft navigation — because `beforeLoad` does NOT re-run on the client during hydration of a direct load. When the auth capability is enabled, the gate SHALL therefore resolve the session on the SERVER (forwarding the browser session cookie during SSR) as well as on the client, and SHALL treat the backend's HTTP 401 for an unauthenticated `/auth/session` as the logged-out signal (resolved to a null session) so it redirects cleanly rather than rendering a degraded shell or a raw error page; when the auth capability is disabled (local mock gate) the decision MAY be deferred to the client because the mock signal is not server-readable. Sign-out from the `AccountMenu` SHALL clear the session and navigate to the public landing `/` (NOT `/login`), because the landing is the logged-out home. Because backend tasks run under a host-root docker.sock model, this gate is a load-bearing security boundary and the console SHALL NOT render app-shell content to an unauthenticated visitor.

#### Scenario: Unauthenticated visitor is redirected with the attempted path
- **WHEN** an unauthenticated visitor requests an `_app` route (e.g. `/tasks/abc`)
- **THEN** `beforeLoad` redirects them to `/login` before any app-shell content renders, carrying the attempted path as a `redirect` search param

#### Scenario: Gate fires on a direct load / refresh / deep-link, not only soft navigation
- **WHEN** an unauthenticated visitor opens or refreshes an `_app` URL directly (e.g. pasting `/tasks/abc`, or hard-refreshing `/dashboard`) with the auth capability enabled
- **THEN** the gate resolves the session server-side (forwarding the session cookie on SSR, mapping the backend 401 to a null session) and redirects to `/login` carrying the attempted path BEFORE the app-shell or any per-page data loader renders — it does NOT render a degraded shell with failed data, nor a raw 401 error page

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
The four standalone pages SHALL faithfully reproduce the design revision's design language. `/` (Landing) SHALL render the landing-nav, hero (eyebrow/title/CTA/trust pills/3 proof tiles), a live `runner-capsule` demo — a native React port of the design's vanilla `runner-capsule.js` Web Component preserving the same loop state machine, replacing the former static `HeroPreview` — a `#workflow` `process-rail` section (replacing the 3-step WorkflowRow), a `#security` `boundary-ledger` section (replacing the 3-card FeatureGrid; the existing `#security` anchor, including the footer link, SHALL resolve to the boundary-ledger), and a minimal footer, with smooth anchor scrolling (scroll-margin offsetting the fixed nav). The runner-capsule demo SHALL be SSR-SAFE under the established mounted-flag pattern: the server render and the first client paint SHALL use the reduced-motion branch (no `window`/`matchMedia` access during render), and the full animation loop SHALL be enabled only after mount when `matchMedia('(prefers-reduced-motion: no-preference)')` matches; a visitor with `prefers-reduced-motion: reduce` SHALL keep the reduced branch. The landing SHALL be SESSION-AWARE: when the operator is authenticated it SHALL present a primary "进入控制台" CTA routing to `/dashboard` (and an account affordance) in place of the login CTA; when unauthenticated it SHALL present the "GitHub 登录" CTA. The anonymous console entries (the nav "控制台" link and the hero "查看控制台" action) SHALL NOT silently dead-bounce through the auth gate — for an unauthenticated visitor they SHALL route to `/login` (or scroll to the in-page preview) rather than appearing to open the console and being gated. The landing's visual presentation SHALL be polished within the existing design language (not a new visual system): the trust pills SHALL render as discrete chips rather than bare link-colored text; the large CJK display headings SHALL control line-breaking so words are not split mid-token; the hero CTA hierarchy SHALL present a single clear primary action; and inter-section spacing/card density SHALL avoid large dead bands. `/login` SHALL render the dual-column auth card (brand + GitHub 授权 button with mutually-exclusive empty/success states + a 3-step install-step sidebar + config-list); the authorize action SHALL trigger the auth/login flow and, on success, route into the CONSOLE — `/dashboard` by default, or the `redirect` deep-link destination when one was carried (per `multi-user-oauth`) — with copy that reflects the console destination; an already-authenticated visitor MAY be redirected away from `/login`. `/workspace` (Launcher) SHALL render the landing-nav, hero, a 3 stat-tile ops-strip (REPOSITORIES from the repos query; RUNNERS/QUEUE from metrics), and 6 screen-cards (each a full-card link, with a footer "open tasks" count and latest run id derived from the tasks query). `/resume` (Handoff) SHALL render the landing-nav, a main panel (eyebrow/title/lead/dual CTA), and 3 stat-tiles (NEXT ACTION derived from the highest-priority waiting-input task and used to parameterize the second CTA's task deep link; DEFAULT SCOPE from `selectedRepo`; SAFETY static). All four pages SHALL be SSR-safe (no `Date.now()`/`Math.random()` rendered directly to avoid hydration warnings); the landing's session-aware swap in particular SHALL render the unauthenticated state on the server/first paint and reconcile to the authenticated affordance after client hydration so no hydration mismatch occurs.

#### Scenario: Landing renders with working anchors and a footer
- **WHEN** the operator opens `/` and clicks the `#workflow` or `#security` anchor
- **THEN** the page renders the hero, proof tiles, the runner-capsule demo, the process-rail, the boundary-ledger, and a footer, and the anchor smooth-scrolls to the process-rail (`#workflow`) or boundary-ledger (`#security`) with the fixed-nav offset applied

#### Scenario: Runner-capsule demo replaces the static HeroPreview
- **WHEN** `/` renders on a client with no reduced-motion preference
- **THEN** the hero demo region is the React runner-capsule advancing through the same ordered loop phases as the design's `runner-capsule.js` state machine (and looping), and the former static HeroPreview markup is no longer rendered

#### Scenario: Demo animation is SSR-safe and honors reduced motion
- **WHEN** `/` is server-rendered and hydrated
- **THEN** the server render and first client paint show the reduced-motion branch without accessing `window`/`matchMedia` during render, and the animation upgrades only after mount via `matchMedia`
- **AND** when the visitor has `prefers-reduced-motion: reduce`, the demo stays in the reduced branch instead of animating

#### Scenario: Footer #security anchor resolves to the boundary-ledger
- **WHEN** the visitor activates the footer's `#security` link
- **THEN** the page smooth-scrolls to the boundary-ledger section — the anchor target exists and is not dead after the section replacement

#### Scenario: Landing is session-aware
- **WHEN** an authenticated operator opens `/`
- **THEN** the landing presents a primary "进入控制台" CTA to `/dashboard` (and an account affordance) instead of a "GitHub 登录" CTA
- **AND** an unauthenticated visitor instead sees the "GitHub 登录" CTA

#### Scenario: Anonymous console entries do not dead-bounce
- **WHEN** an unauthenticated visitor activates the nav "控制台" link or the hero "查看控制台" action
- **THEN** they are taken to `/login` (or scrolled to the in-page preview) rather than appearing to open the console and being silently redirected by the gate

#### Scenario: Login routes to the console on success
- **WHEN** the operator completes authorization on `/login` with no deep-link carried
- **THEN** the operator is routed to `/dashboard` (the console), and the page copy reflects the console destination rather than the repository-import page

#### Scenario: Login honors a carried deep-link destination
- **WHEN** the login flow was reached with a `redirect` destination and authorization succeeds
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

#### Scenario: Import flow proceeds through its states
- **WHEN** the operator opens the import Dialog
- **THEN** it shows the pending-empty state, then a loading state, then a filterable candidate list, and selecting a repo imports it (adding to `importedRepos`, setting it default, and toasting)

#### Scenario: Imported list and candidate list use distinct sources
- **WHEN** the page renders
- **THEN** the imported-repos panel reads the repos query (real when enabled) and the import Dialog candidate list reads the GitHub import query

#### Scenario: Import Dialog is accessible
- **WHEN** the import Dialog is open
- **THEN** it exposes `role="dialog"`/`aria-modal`/`aria-labelledby`, traps focus, and closes on `Escape` or backdrop click

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
The `/history` page SHALL render a screen-header, a history-summary of 3 stat-tiles (ACTIVE WINDOW / ATTENTION derived from tasks; RETENTION from settings/metrics), and an audit-toolbar (search Input + level SegmentedControl 全部/信息/警告/错误 + a visible CountChip). It SHALL render a two-column grid: a left 最近任务 Table (任务/仓库/结果/耗时/会话记录 with result StatusPills and a session link to `/tasks/$taskId`) sourced from the tasks query, and a right `AuditTimeline` (audit-events: time + warn/danger dot + title/description + right-side HTTP status code 200/201/409/422) sourced from the history events query. A single client-side filter (search + level) SHALL drive BOTH the left table rows and the right events simultaneously, with the visible count updating live. The page SHALL be read-only (no terminal/WS) and SSR-friendly.

#### Scenario: One filter drives both columns
- **WHEN** the operator types a search term or selects a level in the toolbar
- **THEN** both the left task table and the right audit timeline filter together and the CountChip updates to the visible count

#### Scenario: Session link navigates from history
- **WHEN** the operator clicks a 会话记录 link in the task table
- **THEN** the console navigates to that task's `/tasks/$taskId` session

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
The `/tasks/$taskId` page SHALL adopt the design revision's session-toolbar placement and the 3+1 grouping of the context strip (the three task-context items grouped together, with the guardrail readout as the separated fourth item) as a MARKUP/LAYOUT-ONLY reorganization: toolbar action behavior, input semantics, and connection semantics SHALL NOT change. The route SHALL preserve its established invariants — it remains the ONLY `ssr:false` route, the server renders the `pendingComponent` terminal skeleton, and raw terminal bytes continue to bypass the TanStack Query cache. The terminal-head SHALL keep its `{agent} · {repo}#{branch}` label and SHALL NOT display the hardcoded `pty: /dev/pts/4` line (or any pty path): no backend field backs it, and fabricated values are prohibited. Any merge task whose diff touches the WebSocket input or connection path SHALL be verified against a live running backend session (typing, Enter submit, reconnect) before it is marked complete.

#### Scenario: Toolbar and context strip regroup without behavior change
- **WHEN** the operator opens the session page for a running task after the merge
- **THEN** the session-toolbar occupies the design revision's placement, the context strip renders the 3+1 grouping, and the toolbar actions (返回任务/复制会话记录/暂停输出/停止任务) and the connection pill behave identically to the pre-merge implementation

#### Scenario: Fabricated pty line is removed
- **WHEN** the terminal-head renders
- **THEN** it shows the `{agent} · {repo}#{branch}` label and no pty path value appears anywhere on the session page

#### Scenario: Session invariants survive the reorganization
- **WHEN** the route tree is built and the session page is server-rendered
- **THEN** `/tasks/$taskId` is still the only route with `ssr: false`, the server emits the `pendingComponent` skeleton without touching `window`, and raw output bytes still write directly to the terminal without entering the query cache

#### Scenario: Input/connection-path changes are gated on live verification
- **WHEN** a merge task's diff touches the WebSocket input or connection code path
- **THEN** that task is verified against a live backend session (keystrokes delivered, Enter submits, reconnect behavior intact) before being marked complete, and a layout-only diff requires no live gate

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

