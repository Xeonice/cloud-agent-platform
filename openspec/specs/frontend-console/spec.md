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
The `/tasks/$taskId` page SHALL be the ONLY client-only route (route option `ssr: false`): it SHALL render a `pendingComponent` terminal skeleton on the server (never touching `window`), and on the client mount the `<Terminal>` component, connect to the task's authenticated WebSocket via the reused `TerminalSocket`, render the raw byte stream directly to the terminal (raw bytes SHALL NOT pass through the TanStack Query cache), display the live connection status, and provide a keystroke/command input plus an approval surface for pending `PermissionRequest` decisions. Discrete control frames (task completion, lease/write-lock changes, approval decisions) SHALL be bridged back into the query cache via `queryClient.setQueryData(['tasks', id], …)` or invalidation. The WebSocket handshake SHALL authenticate via the existing token query parameter plus `bearer.<token>` subprotocol (browsers cannot set an `Authorization` header on WS) and SHALL NOT attempt to set request headers.

#### Scenario: Session page streams the live terminal
- **WHEN** the operator opens `/tasks/$taskId` for a running task
- **THEN** the client connects the WebSocket and writes the task's live byte stream directly to the `<Terminal>` component without routing raw bytes through the query cache

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
- **THEN** the session page renders a fallback DOM line view (terminal-line dim/ok/warn) plus the command input row instead of crashing

### Requirement: Dashboard lists tasks as a fleet
The `/dashboard` page (mounted under the authenticated app-shell layout) SHALL be the post-login default landing surface, list tasks read from `GET /tasks` via TanStack Query as a fleet with their status, surface running/needs-input/queued states (sorting needs-input rows to the top), and provide an action to enter a task's `/tasks/$taskId` session (queued rows SHALL be `aria-disabled` until connectable). It SHALL provide a client-side search and a status SegmentedControl (全部/等待输入/排队中) with a live visible CountChip, an operations status bar of metric tiles, and an Agent-capacity aside (slot meter + CPU/memory resource meters + scheduling config). The task loader SHALL prefetch tasks and repos via `ensureQueryData` to avoid request waterfalls, and the task list query SHALL poll on a 5-second `refetchInterval` (with `refetchIntervalInBackground: true` if continuous background polling is required).

#### Scenario: Dashboard shows tasks and links to sessions
- **WHEN** the operator opens `/dashboard`
- **THEN** the page lists existing tasks from `GET /tasks` with their status and each connectable row offers an action navigating to its `/tasks/$taskId` session

#### Scenario: Needs-input tasks are prioritized
- **WHEN** the task list contains a task awaiting input
- **THEN** that row is sorted to the top and rendered with the needs-input status indicator, and queued rows that are not yet connectable are marked `aria-disabled`

#### Scenario: Client-side status filter updates the visible count
- **WHEN** the operator types in the task search or selects a status in the SegmentedControl
- **THEN** the list filters client-side (derived via `useMemo`, not cached) and the CountChip reflects the visible row count

#### Scenario: Task list polls for fresh status
- **WHEN** the dashboard is mounted
- **THEN** the task query refetches every 5 seconds so statuses stay current without a manual reload

### Requirement: New task creation from the console
The console SHALL provide BOTH a modal (on `/dashboard`) and a full-page form (`/tasks/new`) to create a task, sharing the same form, live command preview, and submit logic. The form SHALL select a registered repo (options from `GET /repos`, restricted to imported repos as the security scope), a branch, an execution strategy, and a prompt/description (with a live client-side word count), default the "破坏性写入前停止" checkbox to checked, and render a side preflight (3 ReviewStep cards complete/warn) plus a live `agentctl` `CommandPreview` derived from form state. Submission SHALL POST to `POST /repos/:repoId/tasks` via a `createTaskMutation`; on success it SHALL surface the created run id and a deep link into `/tasks/$taskId`, persist `selectedRepo`/`branch`/`latestRunId` to local store, invalidate the tasks query, and emit a Sonner toast. The console SHALL render branch and strategy controls even though the current backend does not read these fields back (branch/strategy persistence is specified in `repo-and-task-management`); the page SHALL NOT misrepresent unsent/unread fields as confirmed task state.

#### Scenario: Operator creates a task from the dashboard modal
- **WHEN** the operator submits the new-task modal with a repo, branch, strategy, and prompt
- **THEN** the console POSTs to `POST /repos/:repoId/tasks` and, on success, surfaces the created run id with a link into its `/tasks/$taskId` session and invalidates the task list

#### Scenario: Full-page create mirrors the modal
- **WHEN** the operator opens `/tasks/new` and submits the form
- **THEN** it uses the same shared form, command preview, and `createTaskMutation` as the dashboard modal and produces an identical create result with a session deep link

#### Scenario: Command preview reacts to form state
- **WHEN** the operator edits any field of the create form
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
The `_app` layout SHALL enforce an authentication gate in `beforeLoad`: an unauthenticated visitor to any app-shell route SHALL be redirected to `/login`. Authentication state SHALL be read through the auth session source (real GitHub OAuth session when the auth capability is enabled per the capabilities switch, otherwise the client token gate). Sign-out from the `AccountMenu` SHALL clear the session and navigate to `/login`. Because backend tasks run under a host-root docker.sock model, this gate is a load-bearing security boundary and the console SHALL NOT render app-shell content to an unauthenticated visitor.

#### Scenario: Unauthenticated visitor is redirected
- **WHEN** an unauthenticated visitor requests any `_app` route (e.g. `/dashboard`)
- **THEN** `beforeLoad` redirects them to `/login` before any app-shell content renders

#### Scenario: Sign-out returns to login
- **WHEN** the operator chooses 退出登录 in the `AccountMenu`
- **THEN** the session is cleared and the console navigates to `/login`

#### Scenario: Authenticated operator reaches the dashboard
- **WHEN** an authenticated operator opens an `_app` route
- **THEN** the gate allows it and the app-shell content renders

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
The four standalone pages SHALL faithfully reproduce the prototype. `/` (Landing) SHALL render the landing-nav, hero (eyebrow/title/dual CTA/trust pills/3 proof tiles), `HeroPreview` (macOS window-bar traffic dots + mini task rows + stat tiles + static terminal), a `#workflow` 3-step section, and a `#security` 3-card section, with smooth anchor scrolling (scroll-margin offsetting the fixed nav); its data is fully static with CTAs to `/login` and `/dashboard`. `/login` SHALL render the dual-column auth card (brand + GitHub 授权 button with mutually-exclusive empty/success states + a 3-step install-step sidebar + config-list); the authorize action SHALL trigger the auth/login flow, toast success, and route into 仓库导入 `/repositories` on success, and an already-authenticated visitor MAY be redirected away from `/login`. `/workspace` (Launcher) SHALL render the landing-nav, hero, a 3 stat-tile ops-strip (REPOSITORIES from the repos query; RUNNERS/QUEUE from metrics), and 6 screen-cards (each a full-card link, with a footer "open tasks" count and latest run id derived from the tasks query). `/resume` (Handoff) SHALL render the landing-nav, a main panel (eyebrow/title/lead/dual CTA), and 3 stat-tiles (NEXT ACTION derived from the highest-priority waiting-input task and used to parameterize the second CTA's task deep link; DEFAULT SCOPE from `selectedRepo`; SAFETY static). All four pages SHALL be SSR-safe (no `Date.now()`/`Math.random()` rendered directly to avoid hydration warnings).

#### Scenario: Landing renders statically with working anchors
- **WHEN** the operator opens `/` and clicks the `#workflow` or `#security` anchor
- **THEN** the page renders the hero, proof tiles, workflow steps, and security cards, and the anchor smooth-scrolls with the fixed-nav offset applied

#### Scenario: Login toggles empty and success states
- **WHEN** the operator clicks the GitHub 授权 button on `/login`
- **THEN** the empty state switches to the success state, a success toast is shown, and the operator is routed to `/repositories`

#### Scenario: Workspace counts reflect live queries
- **WHEN** `/workspace` renders
- **THEN** the REPOSITORIES tile reflects the repos query and each screen-card footer shows an open-tasks count derived from the tasks query

#### Scenario: Resume next-action drives the CTA deep link
- **WHEN** `/resume` renders with a waiting-input task present
- **THEN** the NEXT ACTION tile reflects the highest-priority waiting-input task and the second CTA links into that task's `/tasks/$taskId` session

#### Scenario: Standalone pages hydrate without warnings
- **WHEN** any of `/`, `/login`, `/workspace`, `/resume` is server-rendered and hydrated
- **THEN** no hydration mismatch occurs because no nondeterministic value is rendered directly

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
The `/settings` page SHALL render a left secondary anchor navigation grouping account/github/codex/safety, a system-strip of 3 cards, and a settings grid: an identity card (Avatar) and an access-and-defaults form (`allowedAccount`, default repo from the repos query, `retention`, `writeConfirm`), plus a Codex login section (status card + Tabs: 官方 Codex / 兼容提供方). The Codex section SHALL provide two dialogs — a direct authorize dialog (scope list + connect/connected states) and an api-key dialog (Base URL + API Key as a password field + fetch-available-models → model-picker → select default model → save/test). The credential status (未连接/未保存/已连接) SHALL stay synchronized across the status card, the tab subtitle, and the provider pill; a saved API key SHALL NOT be re-displayed in plaintext. Saving SHALL run `saveSettingsMutation` (write store + invalidate the settings query); a reset action SHALL restore defaults. The page SHALL keep GitHub OAuth (who may enter the console) and Codex credentials (which model runs tasks) as two distinct concepts and SHALL NOT conflate Codex credentials with console login.

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

