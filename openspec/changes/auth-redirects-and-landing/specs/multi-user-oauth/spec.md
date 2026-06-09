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
