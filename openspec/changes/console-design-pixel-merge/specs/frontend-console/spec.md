# frontend-console Spec Delta — console-design-pixel-merge

## MODIFIED Requirements

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

## ADDED Requirements

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
