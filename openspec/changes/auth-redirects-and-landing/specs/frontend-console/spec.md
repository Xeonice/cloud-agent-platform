## MODIFIED Requirements

### Requirement: Client auth gate on the app-shell
The `_app` layout SHALL enforce an authentication gate in `beforeLoad`: an unauthenticated visitor to any app-shell route SHALL be redirected to `/login`, CARRYING the attempted app path as a `redirect` search param (e.g. `/login?redirect=/tasks/abc`) so the post-login flow can return the operator to where they were headed. Authentication state SHALL be read through the auth session source (real GitHub OAuth session when the auth capability is enabled per the capabilities switch, otherwise the client token gate). Sign-out from the `AccountMenu` SHALL clear the session and navigate to the public landing `/` (NOT `/login`), because the landing is the logged-out home. Because backend tasks run under a host-root docker.sock model, this gate is a load-bearing security boundary and the console SHALL NOT render app-shell content to an unauthenticated visitor.

#### Scenario: Unauthenticated visitor is redirected with the attempted path
- **WHEN** an unauthenticated visitor requests an `_app` route (e.g. `/tasks/abc`)
- **THEN** `beforeLoad` redirects them to `/login` before any app-shell content renders, carrying the attempted path as a `redirect` search param

#### Scenario: Sign-out returns to the landing
- **WHEN** the operator chooses 退出登录 in the `AccountMenu`
- **THEN** the session is cleared and the console navigates to the public landing `/` rather than `/login`

#### Scenario: Authenticated operator reaches the dashboard
- **WHEN** an authenticated operator opens an `_app` route
- **THEN** the gate allows it and the app-shell content renders

#### Scenario: Gate preserves the attempted destination for post-login return
- **WHEN** the gate bounces an unauthenticated visitor from a specific app route and the visitor subsequently completes login
- **THEN** the carried `redirect` path is threaded through the login flow so the operator is returned to that destination after authentication (subject to the open-redirect guard defined in `multi-user-oauth`), rather than always landing on a fixed page

### Requirement: Landing-family standalone pages
The four standalone pages SHALL faithfully reproduce the prototype's design language. `/` (Landing) SHALL render the landing-nav, hero (eyebrow/title/CTA/trust pills/3 proof tiles), `HeroPreview` (macOS window-bar traffic dots + mini task rows + stat tiles + static terminal), a `#workflow` 3-step section, a `#security` 3-card section, and a minimal footer, with smooth anchor scrolling (scroll-margin offsetting the fixed nav). The landing SHALL be SESSION-AWARE: when the operator is authenticated it SHALL present a primary "进入控制台" CTA routing to `/dashboard` (and an account affordance) in place of the login CTA; when unauthenticated it SHALL present the "GitHub 登录" CTA. The anonymous console entries (the nav "控制台" link and the hero "查看控制台" action) SHALL NOT silently dead-bounce through the auth gate — for an unauthenticated visitor they SHALL route to `/login` (or scroll to the in-page preview) rather than appearing to open the console and being gated. The landing's visual presentation SHALL be polished within the existing design language (not a new visual system): the trust pills SHALL render as discrete chips rather than bare link-colored text; the large CJK display headings SHALL control line-breaking so words are not split mid-token; the hero CTA hierarchy SHALL present a single clear primary action; and inter-section spacing/card density SHALL avoid large dead bands. `/login` SHALL render the dual-column auth card (brand + GitHub 授权 button with mutually-exclusive empty/success states + a 3-step install-step sidebar + config-list); the authorize action SHALL trigger the auth/login flow and, on success, route into the CONSOLE — `/dashboard` by default, or the `redirect` deep-link destination when one was carried (per `multi-user-oauth`) — with copy that reflects the console destination; an already-authenticated visitor MAY be redirected away from `/login`. `/workspace` (Launcher) SHALL render the landing-nav, hero, a 3 stat-tile ops-strip (REPOSITORIES from the repos query; RUNNERS/QUEUE from metrics), and 6 screen-cards (each a full-card link, with a footer "open tasks" count and latest run id derived from the tasks query). `/resume` (Handoff) SHALL render the landing-nav, a main panel (eyebrow/title/lead/dual CTA), and 3 stat-tiles (NEXT ACTION derived from the highest-priority waiting-input task and used to parameterize the second CTA's task deep link; DEFAULT SCOPE from `selectedRepo`; SAFETY static). All four pages SHALL be SSR-safe (no `Date.now()`/`Math.random()` rendered directly to avoid hydration warnings); the landing's session-aware swap in particular SHALL render the unauthenticated state on the server/first paint and reconcile to the authenticated affordance after client hydration so no hydration mismatch occurs.

#### Scenario: Landing renders with working anchors and a footer
- **WHEN** the operator opens `/` and clicks the `#workflow` or `#security` anchor
- **THEN** the page renders the hero, proof tiles, workflow steps, security cards, and a footer, and the anchor smooth-scrolls with the fixed-nav offset applied

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
