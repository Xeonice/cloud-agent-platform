## MODIFIED Requirements

### Requirement: Landing-family standalone pages
The four standalone pages SHALL faithfully reproduce the design revision's design language. `/` (Landing) SHALL render the landing-nav (the brand, plus an account affordance when the operator is authenticated), a hero (eyebrow, the CJK display title + subline, the lead copy, a dual CTA, trust pills rendered as discrete chips, and a live `runner-capsule` demo — a native React port of the design's vanilla `runner-capsule.js` Web Component preserving the same loop state machine), and a minimal footer (brand + a minimal link set + the copyright line), with smooth anchor scrolling for any in-page anchor (scroll-margin offsetting the fixed nav). The Landing SHALL NOT render a proof-tile grid, a `#workflow` `process-rail` section, or a `#security` `boundary-ledger` section (these are dropped in the simplified design revision), and SHALL carry NO nav or footer anchor links targeting those removed sections (no dead anchors). The runner-capsule demo SHALL be SSR-SAFE under the established mounted-flag pattern: the server render and the first client paint SHALL use the reduced-motion branch (no `window`/`matchMedia` access during render), and the full animation loop SHALL be enabled only after mount when `matchMedia('(prefers-reduced-motion: no-preference)')` matches; a visitor with `prefers-reduced-motion: reduce` SHALL keep the reduced branch. The landing SHALL be SESSION-AWARE: when the operator is authenticated it SHALL present a primary "进入控制台" CTA routing to `/dashboard` (and an account affordance) in place of the login CTA; when unauthenticated it SHALL present the "GitHub 登录" CTA as the single clear primary action and a secondary "查看演示" action that scrolls to the in-page `runner-capsule` preview. No anonymous landing entry SHALL silently dead-bounce through the auth gate — an unauthenticated visitor's primary action SHALL go to `/login` (or scroll to the in-page preview) rather than appearing to open the console and being gated. The landing's visual presentation SHALL stay within the existing design language (not a new visual system): the trust pills SHALL render as discrete chips rather than bare link-colored text; the large CJK display headings SHALL control line-breaking so words are not split mid-token; the hero CTA hierarchy SHALL present a single clear primary action; and inter-section spacing/card density SHALL avoid large dead bands. `/login` SHALL render the dual-column auth card (brand + GitHub 授权 button with mutually-exclusive empty/success states + a 3-step install-step sidebar + config-list); the authorize action SHALL trigger the auth/login flow and, on success, route into the CONSOLE — `/dashboard` by default, or the `redirect` deep-link destination when one was carried (per `multi-user-oauth`) — with copy that reflects the console destination; an already-authenticated visitor MAY be redirected away from `/login`. `/workspace` (Launcher) SHALL render the landing-nav, hero, a 3 stat-tile ops-strip (REPOSITORIES from the repos query; RUNNERS/QUEUE from metrics), and 6 screen-cards (each a full-card link, with a footer "open tasks" count and latest run id derived from the tasks query). `/resume` (Handoff) SHALL render the landing-nav, a main panel (eyebrow/title/lead/dual CTA), and 3 stat-tiles (NEXT ACTION derived from the highest-priority waiting-input task and used to parameterize the second CTA's task deep link; DEFAULT SCOPE from `selectedRepo`; SAFETY static). All four pages SHALL be SSR-safe (no `Date.now()`/`Math.random()` rendered directly to avoid hydration warnings); the landing's session-aware swap in particular SHALL render the unauthenticated state on the server/first paint and reconcile to the authenticated affordance after client hydration so no hydration mismatch occurs.

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
- **THEN** the landing presents a primary "进入控制台" CTA to `/dashboard` (and an account affordance) instead of a "GitHub 登录" CTA
- **AND** an unauthenticated visitor instead sees the "GitHub 登录" primary CTA and a "查看演示" secondary action

#### Scenario: Anonymous primary action does not dead-bounce

- **WHEN** an unauthenticated visitor activates the landing's primary action
- **THEN** they are taken to `/login` (or, for "查看演示", scrolled to the in-page preview) rather than appearing to open the console and being silently redirected by the gate

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
