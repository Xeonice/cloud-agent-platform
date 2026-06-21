## ADDED Requirements

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
