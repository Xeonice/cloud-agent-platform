## ADDED Requirements

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
