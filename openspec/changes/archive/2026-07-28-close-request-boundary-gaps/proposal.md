## Why

Four boundary checks that the surrounding code assumes exist do not exist. All were re-verified against `origin/main` @ v0.46.1 by reading the code, not inherited from a report.

1. **A machine credential can administer accounts.** `accounts.controller.ts:132` re-reads the owner's `role`/`allowed` but never checks `principal.kind`, while `auth/admin.ts:21` — the strict judgement one file away — states *"a machine or legacy principal is never an admin"*. Machine principals carry the full owning account (`operator-principal.ts:192`, `auth.guard.ts:192`), so a `cap_sk_` key minted by an admin with `scopes: ['tasks:read']` passes the gate and can `PATCH /accounts/:id/password`. Scopes never enter the decision. The same omission is in `smtp.controller.ts:205` and `sandbox-environments.controller.ts`. The invariant is written down in `auth.guard.ts:185`: an `mcp_` token is recognised on owner-scoped REST routes *"while kind-gated session-only routes still reject it"* — these are the routes that were supposed to be kind-gated.

2. **No CSRF defence in the cross-origin shape.** `session-cookie.ts:42` sets `sameSite: 'None'` when console and API are on different origins — the production topology. Repository-wide, `csrf`/`xsrf`/`sec-fetch-site` appear in exactly one comment. CORS governs whether a response may be read, not whether a request is sent, so `POST /tasks/:id/stop`, `POST /accounts` and `POST /self-update` remain reachable cross-site with the operator's cookie.

3. **The WebSocket handshake never checks `Origin`.** `main.ts:132` uses a bare `new WsAdapter(app)` with no `verifyClient`/`allowRequest`, and the gateway authenticates from the handshake cookie. Browsers do not apply same-origin policy to WebSockets and the HTTP CORS allowlist does not cover them, so with (2) any page can open a terminal socket and drive a PTY.

4. **An anonymous page executes unverified third-party code on the API origin.** `openapi.registry.ts:436,440` loads `swagger-ui` from `unpkg` with no version pin and no `integrity` (`crossorigin` is a CORS mode, a precondition for SRI, not SRI). `/v1/docs` is in the unauthenticated allowlist.

These are independent of the refactor programme and gate nothing else, which is why they go first.

## What Changes

Each fix lands behind a reproduction test that fails before it.

- **Kind-gate every admin route.** Route the three controllers' `requireAdmin` through the existing strict `isAdminPrincipal`, so a machine or legacy principal is rejected regardless of its owner's role. Corroborated as the intended design by the credential-minting endpoints, which already refuse machine callers.
- **Verify request origin for state-changing HTTP.** Reject unsafe-method requests that authenticate by cookie and carry an untrusted or absent `Origin`, reusing the `WEB_ORIGIN` allowlist that already backs CORS so there is one trusted-origin list, not two. Requests authenticating by bearer token are unaffected — they cannot be forged by a browser.
- **Validate the WebSocket handshake origin** against that same allowlist before the gateway sees the connection.
- **Pin and verify the docs assets** — a fixed `swagger-ui-dist` version with `integrity` hashes, or self-hosted assets. Whichever is chosen, the rendered HTML must not reference a floating third-party URL.

## Capabilities

### New Capabilities
- `request-trust-boundary`: what the server SHALL verify about an incoming authenticated request before acting on it — the principal kind an operation demands, and the origin a cookie-authenticated state change must come from, on both HTTP and WebSocket — and what it SHALL guarantee about executable code in pages it serves.

### Modified Capabilities
- `account-administration`: its "Admin-only account lifecycle management" requirement is explicit that the caller must be an `allowed`, `role = admin` account, but silent on credential kind. It gains the constraint that the admin gate rejects machine and legacy principals, so a scoped machine credential owned by an admin is not an admin.

## Impact

- **Auth surface**: `apps/api/src/accounts/accounts.controller.ts`, `apps/api/src/mail/smtp.controller.ts`, `apps/api/src/sandbox-environments/sandbox-environments.controller.ts` (kind gate); `apps/api/src/main.ts` (origin verification for HTTP and the WS adapter); `apps/api/src/auth/` (shared trusted-origin resolution).
- **Public surface**: `apps/api/src/openapi/openapi.registry.ts` (docs assets). `/v1/docs` stays anonymously reachable; only what it loads changes.
- **Tests**: four reproduction suites, each asserted to fail before its fix. Three are unit/integration; the WebSocket one needs a booted app, so it belongs with `scripts/boot-smoke.sh`, which already boots the built application against a throwaway Postgres.
- **Operator-visible**: a deployment whose `WEB_ORIGIN` is unset or wrong will now have cross-origin state changes rejected rather than silently accepted. That is the point, but it is a behaviour change for a misconfigured install and must be called out in the deployment notes.
- **Not in scope** (each recorded in the research brief with its reason): owner-scoping of tasks/transcripts/repos, audit coverage of security events, a global `ValidationPipe`, and encryption-envelope versioning.
