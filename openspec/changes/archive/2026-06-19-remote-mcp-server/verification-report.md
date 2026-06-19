# Verification Report — remote-mcp-server

This report records the adjudication of verify findings via three-way routing:
UNMET → `tasks.md` (verify-reopened Track); SPEC-DEFECT → `design.md` Open
Questions; MET → folded here (re-traces end-to-end as satisfied despite a
skeptic's refutation, including met-as-written with a minor non-blocking gap).

## Reclassified MET (raw-unmet that re-traces as satisfied)

### `/mcp` uses route-scoped, bearer-only CORS — MET

Capability: `multi-user-oauth`. Spec:
`specs/multi-user-oauth/spec.md:26-33` — "`/mcp` SHALL use a route-scoped,
bearer-only, NON-credentialed CORS policy distinct from the console's
cookie-credentialed CORS. An MCP-client browser origin SHALL NOT be added to
the cookie-credentialed origin allowlist."

End-to-end re-trace against the actual code (all three spec clauses satisfied):

1. **Route-scoped, bearer-only, non-credentialed CORS for `/mcp`.**
   `apps/api/src/main.ts:206-230` (`mcpCorsMiddleware`) sets
   `Access-Control-Allow-Origin: *` with deliberately NO
   `Access-Control-Allow-Credentials` (line 222 comment + verified absence).
   Mounted route-scoped at `apps/api/src/main.ts:161`
   (`app.use('/mcp', mcpCorsMiddleware())`), so it owns `/mcp` CORS exclusively.

2. **Distinct from the console's credentialed CORS; no credentialed header on
   `/mcp`.** The global `enableCors` delegate (`apps/api/src/main.ts:136-147`)
   calls `isMcpPath(req.url)` and returns `{ origin:false, credentials:false }`
   for `/mcp`, so the credentialed global handler writes NO headers there.
   `isMcpPath` (`apps/api/src/main.ts:190-193`) strips the query string and a
   trailing slash and matches `path === '/mcp'` (exact match — not a `/mcp*`
   prefix), mirroring the guard's exact-match exemption.

3. **No MCP-client origin folded into the console allowlist.** The console
   allowlist is `parseWebOrigins(process.env.WEB_ORIGIN)`
   (`apps/api/src/main.ts:126`) — a static env-derived list; `/mcp` advertises a
   wildcard `*` via a separate middleware and is never added to that list.

Corroboration on the session-guard side: `MCP_EXEMPT_PATHS = ['/mcp']`
(`apps/api/src/auth/auth.guard.ts:147`) with exact-match `isMcpEndpoint` /
`normalizePath` (`:228-229`), and `apps/api/src/auth/auth.guard.spec.ts:255-272`
confirms `/mcp` passes the session guard while `/mcp/extra` does NOT (exact
match only). `/mcp` remains bearer-protected downstream by
`mcpBearerAuthMiddleware` (`apps/api/src/main.ts:162`). The dedicated ground-truth
test `apps/api/src/mcp/mcp-cors.spec.ts` (Scenarios A-F) asserts the wildcard
origin (B), the absence of `Allow-Credentials` (C), the OPTIONS 204 preflight
(D), pass-through for GET/POST/DELETE (E), and the global-delegate opt-out for
`/mcp` / `/mcp/` while `/tasks` and `/mcp-tokens` stay credentialed (A, F).

**Skeptic's refutation considered & rejected as non-blocking.** The only
credible refutation is that `mcp-cors.spec.ts` reproduces `isMcpPath` and
`mcpCorsMiddleware` *verbatim* (they are module-private in `main.ts`) rather than
importing the live functions, so the test pins a copy. A line-by-line comparison
of the copy against the live `main.ts` source shows they are byte-identical, and
the live wiring (`app.use('/mcp', ...)`, the delegate branch) is present and
correct. This is a test-fidelity nuance (a minor gap that does not block the
primary scenario), not a code defect — the primary scenario ("MCP CORS never
carries the session cookie; no MCP origin in the credentialed allowlist") is
satisfied by the actual code. Routes to MET.

## Gap findings (requirements with no traceable implementation)

None. Every spec requirement across `mcp-server/spec.md`,
`frontend-console/spec.md`, and `multi-user-oauth/spec.md` cross-references to a
concrete implementation in the codebase; there are no zero-implementation
requirements.

## Scope findings (implemented behaviors beyond the spec text)

These are scope-creep observations — behaviors present in the code that the spec
does not require. They are informational (no code task; none refute a spec
requirement). One overlaps a design.md Open Question (default scopes), already
tracked there.

1. `lastUsedAt` bump on every token resolution (fire-and-forget DB write) — the
   specs require only hash→revoke→expiry→allowlist→AuthInfo; no last-use
   tracking is specified.
   `apps/api/src/auth/auth-session.service.ts:379-386`.

2. `ownerGithubId` field on `McpAuthInfo` and threading it via `AuthInfo.extra`
   into tool callbacks for audit attribution — the spec lists the AuthInfo shape
   as `{ token, clientId, scopes, expiresAt, resource }` with no
   `extra`/`ownerGithubId`.
   `apps/api/src/auth/auth-session.service.ts:56,399` and
   `apps/api/src/mcp/mcp.server.ts:180-183`.

3. `MCP_NON_EXPIRING_AUTHINFO_EXPIRES_AT` far-future (year-9999) synthetic expiry
   injected for tokens with no `expiresAt` — the spec says only "a token whose
   `expiresAt` is unset MUST NOT be produced"; the year-9999 sentinel is an
   unspecified mechanism.
   `apps/api/src/auth/auth-session.service.ts:393-398` and
   `apps/api/src/auth/mcp-slot-allowlist.test.mjs:33`.

4. `Vary: Origin` response header set by the MCP CORS middleware — not mentioned
   in the route-scoped bearer-only non-credentialed CORS requirement.
   `apps/api/src/mcp/mcp-cors.spec.ts:59` (mirrors `apps/api/src/main.ts:209`).

5. `Access-Control-Expose-Headers: Mcp-Session-Id, Mcp-Protocol-Version` set by
   the MCP CORS middleware — not listed in the CORS requirement.
   `apps/api/src/mcp/mcp-cors.spec.ts:66-70` (mirrors `apps/api/src/main.ts:218-221`).

6. `503` response with a structured JSON-RPC 2.0 error body (code `-32000`,
   message "MCP server is disabled") when the toggle is off — the spec says only
   "absent or a clear disabled response", not a specific JSON-RPC envelope.
   `apps/api/src/mcp/mcp.controller.ts:99-108`.

7. Default scope pre-selection (`tasks:read` + `repos:read`) in the mint dialog —
   the spec says the dialog has name + scopes fields but does not specify a
   default selection. NOTE: design.md Open Questions already tracks the default
   scope decision (recommends explicit selection defaulting to `tasks:read`);
   this is a known consideration, not a new finding.
   `apps/web/src/components/settings/mcp-server-card.tsx:78`.
