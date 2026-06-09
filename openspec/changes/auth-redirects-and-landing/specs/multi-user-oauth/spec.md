## ADDED Requirements

### Requirement: Post-login redirect target with open-redirect-safe deep-link return
After a successful OAuth exchange + allowlist admission, the orchestrator SHALL
redirect the browser to the CONSOLE by default — the dashboard (`/dashboard`) —
rather than to the repository-import page. The authorization-initiation endpoint
MAY accept an optional `redirect` parameter naming the app destination the
operator was originally trying to reach (so the auth gate can return them there
after login); when present it SHALL be carried through the OAuth round trip
ALONGSIDE the anti-CSRF `state` (in the signed state payload or a paired signed
cookie), never weakening or replacing the `state` verification. At the callback,
the orchestrator SHALL resolve the post-login location as follows: if a carried
`redirect` is present AND passes the open-redirect guard, redirect to
`${webOrigin}${redirect}`; otherwise redirect to `${webOrigin}/dashboard`.

The open-redirect guard is load-bearing because login grants host-root execution,
so a reflected redirect is a phishing vector: the orchestrator SHALL accept a
`redirect` ONLY when it is a SAME-ORIGIN RELATIVE path — it MUST begin with a
single `/`, MUST NOT begin with `//` or `/\`, MUST NOT contain a scheme or
authority (no `http:`/`https:`/`\\`), and any other value SHALL be rejected and
treated as absent (falling back to `/dashboard`). The redirect SHALL never cause
the browser to leave the configured web origin.

#### Scenario: Default post-login lands on the console
- **WHEN** an allowlisted identity completes the OAuth exchange with no `redirect` carried
- **THEN** the orchestrator redirects the browser to `${webOrigin}/dashboard`

#### Scenario: A safe same-origin redirect is honored
- **WHEN** the flow was initiated with a `redirect` of a same-origin relative app path (e.g. `/tasks/abc`) that passes the guard, and the OAuth exchange + allowlist admit succeed
- **THEN** the orchestrator redirects the browser to `${webOrigin}/tasks/abc` rather than the default dashboard

#### Scenario: An unsafe redirect is rejected and falls back to the dashboard
- **WHEN** the carried `redirect` is an absolute URL, protocol-relative (`//evil.example`), scheme-bearing, or otherwise not a same-origin relative path
- **THEN** the orchestrator ignores it and redirects to `${webOrigin}/dashboard`, never sending the browser off the configured web origin

#### Scenario: The redirect never weakens anti-CSRF state
- **WHEN** the callback verifies the round trip
- **THEN** the anti-CSRF `state` is verified exactly as before and a mismatched/missing `state` is still rejected, independent of whether a `redirect` was carried

### Requirement: Session cookie has a single canonical scope (no shadow cookies)
When the deployment is cross-subdomain (a parent `SESSION_COOKIE_DOMAIN` is configured so the session cookie is domain-scoped and the web SSR can read it on the browser's top-level request), the orchestrator SHALL ensure the browser never holds MORE THAN ONE `cap_session` cookie for the api host. Because two same-name cookies (a domain-scoped one plus a stale host-only one left by an earlier cookie-domain config) are sent together to the api and the server reads only the FIRST, a stale shadow makes EVERY browser→api request fail authentication (401) even with a valid session — while the web SSR, which only ever sees the single domain-scoped cookie on the web host, still authenticates, so the console renders its shell but all client-side data and the session-aware UI break.

To prevent this, on BOTH login (when setting the domain-scoped session cookie) and logout (when clearing it) the orchestrator SHALL also emit a `Set-Cookie` that EXPIRES the HOST-ONLY variant of the session cookie (same name + path, no `Domain`), so a stale host-only shadow is purged. Logout SHALL clear every scope the cookie could have been set under (both the host-only and the configured parent-domain variant), so sign-out is complete and leaves no cookie behind. A host-only clear and a domain-scoped set target different cookies and do not conflict.

#### Scenario: Login purges a stale host-only shadow cookie
- **WHEN** an allowlisted identity completes the OAuth exchange on a cross-subdomain deploy (parent `SESSION_COOKIE_DOMAIN` configured)
- **THEN** the callback sets the domain-scoped session cookie (`SameSite=None; Secure; Domain=<parent>`) AND also emits a host-only `cap_session` clear (`Max-Age=0`, no `Domain`), so any stale host-only shadow from an earlier config is removed and cannot 401 subsequent browser→api requests

#### Scenario: Logout clears every cookie scope
- **WHEN** the operator logs out on a cross-subdomain deploy
- **THEN** the orchestrator emits clears for BOTH the host-only and the parent-domain variant of the session cookie, so neither lingers to shadow a later login and sign-out leaves no session cookie behind
