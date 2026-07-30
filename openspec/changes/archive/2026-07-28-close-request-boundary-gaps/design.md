## Context

Four missing boundary checks, verified by reading `origin/main` @ v0.46.1 (details and line references in the research brief). Three concern what the server verifies about an incoming request; the fourth concerns what it lets a page it serves execute.

Two facts shape the design more than the findings themselves.

**The intended rules are already written down, one file away from each break.** `auth/admin.ts:21` says a machine principal is never an admin — three controllers re-derive admin-ness from account columns instead of calling it. `auth.guard.ts:185` says an `mcp_` token is recognised on owner-scoped routes *"while kind-gated session-only routes still reject it"* — those routes are not kind-gated. `main.ts:134` introduces its allowlist as **"CORS / WS-origin allow-listing"** — the WebSocket adapter never consults it. This is not a design that needs inventing; it is a design that was stated and then not wired.

**A single trusted-origin list already exists.** `parseWebOrigins(process.env.WEB_ORIGIN)` in `auth/auth-config` backs both the CORS delegate and the cookie's cross-origin policy. Origin verification must join it rather than introduce a second list that can disagree.

## Goals / Non-Goals

**Goals:**
- Machine and legacy credentials cannot reach administrative operations, whatever their owner's role or their scopes.
- A cookie-authenticated state change is admitted only from a trusted origin — on HTTP and on the WebSocket upgrade.
- No page served by the orchestrator executes third-party code from a floating reference.
- Each fix ships behind a test that is demonstrated to fail before it.

**Non-Goals:**
- Owner-scoping of tasks, transcripts and repos. Real, but it is a product decision (shared instance vs. private) before it is a fix.
- Audit coverage of security events; a global `ValidationPipe`; encryption-envelope versioning. Each is recorded in the brief with its reason.
- Any change to which routes are anonymously reachable. `/v1/docs` stays public; only what it loads changes.
- Rate-limit coverage and the pre-auth throttle table, which drift alongside the exemption table but are a separate concern.

## Decisions

**Route the three controllers through the existing `isAdminPrincipal` rather than adding a `kind` check to each.**
Three copies of a security predicate is how the two semantics diverged; a fourth copy would not help. The shared predicate already encodes the full rule, and `api-keys.controller.ts:101` / `mcp-tokens.controller.ts:112` are precedent that refusing machine callers is the house style. The controllers keep their DB re-read — it is what makes a mid-session demotion take effect on the next request — but it becomes a second condition after the kind gate, not the whole test.

**Verify origin in one place, ahead of the handlers, keyed on the authenticating credential.**
The rule is a property of *how the request authenticated*, not of any one route, so per-controller checks would rot the way the admin gate did. It runs after the principal is resolved (so it can see whether authentication was cookie- or bearer-based) and before any handler. Bearer-authenticated requests are exempt on purpose: a browser cannot attach an API key to a forged cross-site request, so subjecting them to an origin rule would break legitimate programmatic callers and buy nothing.

Refined during implementation, from three facts read out of the code:

- **The trigger is exactly `kind === 'session'`.** `AuthGuard.extractSessionToken` reads the session token *only* from the cookie (`readCookie`), while api-key, MCP and legacy credentials arrive *only* through `Authorization: Bearer`. So credential kind is a precise proxy for "a browser attached this automatically", not an approximation.
- **The check belongs inside `AuthGuard`.** It is already the single point every authenticated request passes through and the place the principal is resolved. A second global guard would add an ordering dependency to a module whose own comments warn that guard order carries semantics.
- **The trusted set must reuse the CORS delegate's computation, not just `WEB_ORIGIN`.** `main.ts` composes it as `resolveAutoSameHostOrigin(req) ?? allowedOrigins`, and `auth-config` documents that an unset `WEB_ORIGIN` *means* a same-origin deployment — where the cookie is already `SameSite=Lax` and the browser blocks cross-site attachment by itself. Checking against a bare `WEB_ORIGIN` list would therefore reject every same-host install's own console. The shared helper resolves same-origin, the auto-same-host origin, and the configured list together.

Rejected alternative: a synchronised CSRF token. It defends the same thing, costs a token endpoint, a client-side store and a rotation story, and would be a second mechanism beside the origin allowlist the deployment already configures. Origin verification is the smaller mechanism for the same guarantee, given the console is a known fixed origin.

**Absent `Origin` is treated as untrusted for unsafe methods — and so is an absent method.**
Same-origin browser requests carry `Origin` on unsafe methods, and the topology this protects is explicitly cross-origin. Treating absence as trusted would leave the hole open to any client that simply omits the header. The same posture applies to a request with no method at all: Express always sets one, so its absence means something synthetic is in the path, and failing closed there means a bug in method extraction cannot silently disable the check. Cost observed during implementation: four existing test fixtures built request objects without a method and had to gain one. That is the right trade — the alternative makes the check quietly skippable.

**The WebSocket handshake treats an absent `Origin` as trusted, unlike HTTP.**
Deliberately asymmetric. A browser attaches `Origin` to every WebSocket handshake it opens and a page cannot suppress it, so absence means the caller is not a browser — a CLI or a probe — which is not the threat this guards. On HTTP the same reasoning does not hold, because a non-browser caller there may legitimately be replaying a copied session cookie.

**Check the WebSocket origin at the handshake, not in the gateway.**
Refusing during the upgrade means no session is created and no gateway state is touched. `WsAdapter` is subclassed (or configured) to consult the shared allowlist — which is what its own introductory comment already claims it does.

**Pin the docs assets with integrity hashes rather than self-hosting them.**
Self-hosting removes the third party entirely, but adds a vendored bundle to the image and a manual upgrade path. Pinning plus SRI closes the same hole — a swapped artefact fails the integrity check and does not execute — while keeping the asset out of the repository. The spec permits either, so a later change may self-host without contradicting it.

**Reproduction tests first, each demonstrated to fail.**
For every finding: write the test, run it, record that it fails, then fix, then run it again. A security test that never failed proves nothing about the hole it claims to cover. Three are unit/integration; the WebSocket handshake needs a booted app and joins `scripts/boot-smoke.sh`, which already boots the built application against a throwaway Postgres.

## Risks / Trade-offs

**A misconfigured deployment starts rejecting writes** → An install whose `WEB_ORIGIN` is unset or wrong currently accepts cross-origin state changes and will now refuse them. That is the intended behaviour, but it turns a silent misconfiguration into a visible outage. Mitigation: the rejection must name the cause distinctly enough to diagnose without reading source, and the deployment notes must state that `WEB_ORIGIN` is now load-bearing for writes, not only for response sharing.

**The origin check lands on every unsafe request** → A wrong exemption rule would either break the console or leave the hole open. Mitigation: the exemption is expressed once, in terms of the resolved principal's credential kind, and is covered by tests from both sides — a cookie request from a foreign origin is rejected, a bearer request without an origin is admitted.

**Kind-gating may break a real workflow** → If any operator drives account or SMTP administration from a script using an API key, this change breaks it. Mitigation: that is precisely the privilege the change removes, and it must be called out in the change notes rather than discovered. There is no in-repo caller: the console uses session cookies.

**SRI pins go stale** → A pinned `swagger-ui-dist` will not pick up upstream fixes, and a hash mismatch after a careless bump is a blank docs page. Accepted: a blank docs page is a visible, harmless failure, whereas the current state is silent execution of whatever the CDN serves.

**WebSocket refusal is opaque to the browser** → A rejected upgrade surfaces to the client as a generic connection failure. Mitigation: log the refused origin server-side so the cause is recoverable from logs.

## Migration Plan

Each step is independently revertible, and no step depends on a later one:

1. Reproduction tests for all four, each run and recorded as failing.
2. Kind-gate the three admin surfaces; confirm test 1 passes.
3. Shared origin verification for unsafe cookie-authenticated HTTP; confirm test 2 passes.
4. WebSocket handshake origin check; confirm test 3 passes via boot-smoke.
5. Pin and hash the docs assets; confirm test 4 passes.
6. Deployment notes: `WEB_ORIGIN` is now required for cross-origin writes; machine credentials no longer administer.

Rollback: each fix is separable. Reverting the origin verification restores prior behaviour without touching the kind gate, and vice versa.

## Open Questions

- Does any deployment currently rely on an API key for account or SMTP administration? No in-repo caller does. If an operator does, the fix breaks it by design, and the change notes must say so rather than let it be discovered in production.
- ~~Should the origin rule also cover the legacy shared-token path?~~ **Resolved during implementation: exempt, on evidence rather than convention.** `AuthGuard.extractBearerToken` is the only way a legacy token enters, and it reads `Authorization: Bearer` exclusively — there is no cookie or query-parameter path for it. A browser cannot attach that header to a forged cross-site request, so the legacy principal is bearer-shaped in the sense the rule cares about. A test encodes the decision so it cannot silently drift.
- An unsafe request that authenticates by session cookie and sends no `Origin` at all is treated as untrusted, which also refuses a non-browser client scripting with a copied session cookie. That is the intended posture — such a caller should hold an API key — but it is a real behaviour change and belongs in the deployment notes alongside the `WEB_ORIGIN` one.
