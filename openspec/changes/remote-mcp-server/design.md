## Context

The remote MCP server (Tracks T3+T4 of `docs/external-api-mcp-epic.md`), reshaped to a **settings-minted token** model per the operator's decision: instead of a full OAuth 2.1 Authorization Server, the operator mints an `mcp_` token in the console settings and pastes it into their MCP client's `Authorization` header. This drops the heaviest, most security-critical part of the prior design (the thin AS: DCR / authorize / consent / callback / token / revoke + 4 OAuth tables + `.well-known` discovery) and reuses the T1 API-key machinery. The earlier exploration (epic §7, Lane C) already established that DCR is NOT mandatory and that Claude Desktop / Cursor / VS Code all support static credential paths, so a static-bearer token is a viable connect path. Depends on T1 (applied): `resolveOperatorPrincipal` reserves the `mcp_` slot (deny-until-bound), `hasScope` exists, and `ApiKey` is the model/lifecycle template.

## Goals / Non-Goals

**Goals:**
- A remote MCP server connectable from Claude/Cursor with a settings-minted `mcp_` token pasted into the client's `Authorization` header.
- `/mcp` tools driving sandboxes through the existing services, scope-gated, immediate-handle.
- An operator toggle gating whether the MCP server is served (off by default).

**Non-Goals:**
- The full OAuth 2.1 flow / DCR / consent / `.well-known` discovery (the operator chose settings-minted tokens). JWTs. Webhooks. Per-user task ownership (D2 shared pool stays).

## Decisions

### D1 — Settings-minted `mcp_` token, reusing the API-key machinery (drop the thin AS)
The MCP credential is an `mcp_` token the operator mints in settings — a `McpToken` model mirroring `ApiKey` (hash-only, owner-scoped, scoped, revocable, show-once). No OAuth AS, no DCR/consent/callback, no OAuth tables, no `.well-known`.
- **Why**: the operator's decision; a much smaller, lower-risk surface that reuses proven T1 minting/revocation; the target clients support a static bearer header.
- **Token vs API key**: a distinct `McpToken` model + `mcp_` prefix (not the `cap_sk_` ApiKey) keeps the two audiences/principals separate (`mcp` vs `api-key`) and lets MCP tokens be listed/revoked independently in their own settings card.

### D2 — `resolveMcpToken` returns a FULL `AuthInfo` (G1)
`resolveMcpToken` = `resolveApiKey` near-clone (hash → lookup → reject revoked/expired → `isAllowlistedRaw(owner)` re-check) returning `{ token, clientId: 'settings', scopes, expiresAt, resource: canonical /mcp URI }`.
- **Why / G1**: the SDK `requireBearerAuth` REJECTS a token whose `AuthInfo.expiresAt` is unset (it would 401 every valid token); the full shape is mandatory. The `resource` is a fixed canonical `/mcp` URI (no OAuth audience negotiation needed).

### D3 — Official SDK v1.x transport, NOT mcp-nest; verify imports (G2)
Mount the official `@modelcontextprotocol/sdk` (v1.x) `StreamableHTTPServerTransport` (stateless) fronted by the SDK `requireBearerAuth`. **G2**: `node -e require(...)` the exact installed v1.x subpaths (`@modelcontextprotocol/sdk/server/...`) before writing imports — NOT the v2-alpha `@modelcontextprotocol/express`.

### D4 — Tools delegate to existing services; per-tool scope; immediate handle
The 6 tools call the existing `TasksService`/`ReposService`/transcript store (one admission path). Each enforces its scope against the `mcp` principal before acting (403-semantics). `create_task` returns a handle immediately (never blocks); no standalone provisioning path; the raw PTY stream is never exposed.

### D5 — `SystemSettings.mcpServerEnabled` gate, off by default
A `mcpServerEnabled` flag on the existing `SystemSettings` (default `false`) gates whether `/mcp` serves traffic; admin-toggled in the console (like the configurable task-slots DB setting). Off → `/mcp` inert, console shows disabled.
- **Why**: the outward-facing sandbox-execution surface is the most dangerous; ship inert and require a deliberate admin enable. Turning off stops new use without deleting minted tokens.

### D6 — Guard exempts `/mcp` (bearer-protected); route-scoped CORS (G13)
Exempt `/mcp` from the SESSION guard by EXACT-MATCH; `/mcp` stays protected by `requireBearerAuth`. Route-scoped bearer-only, non-credentialed CORS for `/mcp`; never add an MCP-client origin to the console's credentialed CORS.

### D7 — Bind the `mcp_` slot; reuse the allowlist
Bind `resolveMcpToken` into the reserved `mcp_` slot. Reuse `isAllowlistedRaw` so one allowlist governs session + api-key + MCP. The mint endpoints are session-only (a machine credential cannot mint another).

## Risks / Trade-offs

- **Partial `AuthInfo` (no `expiresAt`) → SDK 401s every valid token** (G1). → Mitigation: D2 full `AuthInfo` + a test that a valid token passes `requireBearerAuth`.
- **v2-alpha import paths don't resolve** (G2). → Mitigation: pin v1.x; `node -e require` the installed subpaths first.
- **`/mcp` prefix exemption silently exposes a route** (G8). → Mitigation: exact-match `/mcp` + a test that it is 401 without a bearer.
- **A target MCP client can't pass a static `Authorization` header** → can't connect with a settings-minted token. → Mitigation: Cursor (mcp.json headers) / VS Code / mcp-remote support it; document the per-client config; the deploy-time connect test confirms. (If Claude.ai web specifically needs OAuth, that is a follow-up, not this change.)
- **New module triggers the DI crash class.** → Mitigation: the T1 CI boot-smoke (required).
- **Outward sandbox-execution surface.** → Mitigation: D5 off-by-default + admin enable; scope gates; the shared-pool list/stop reach is documented.

## Migration Plan

1. Add `@modelcontextprotocol/sdk` (v1.x); `node -e require` the v1.x subpaths (G2). Add the `McpToken` model + `SystemSettings.mcpServerEnabled` column + migration.
2. Land the token service + `resolveMcpToken` + bind the `mcp_` slot → the `/mcp` transport + tools + the enable gate + `requireBearerAuth` + guard exemption + route-scoped CORS → the settings backend (toggle + token CRUD) → the web settings MCP section.
3. Run the CI boot-smoke; then a deploy-time live connect from Claude Desktop / Cursor with a settings-minted token (paste into the client `Authorization` header), with `mcpServerEnabled` on.
4. **Rollback**: additive + inert (off by default); reverting unbinds the `mcp_` slot (reverts to deny) and removes `/mcp`; the `McpToken` table can be dropped. No console/auth path changes.

## Open Questions

- The exact v1.x SDK import subpaths + `requireBearerAuth` API surface — confirm at install (G2).
- Whether Claude.ai WEB (vs Desktop/Cursor) accepts a static bearer header or needs OAuth — confirm in the deploy-time connect test; OAuth auto-connect remains a possible future add-on, out of scope here.
- Default scopes on a minted MCP token (recommend explicit selection, defaulting to `tasks:read`).
