## MODIFIED Requirements

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

## ADDED Requirements

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
