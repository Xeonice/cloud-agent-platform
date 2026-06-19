## Why

The epic's headline is a **remote MCP server**: users drive the platform's sandboxes from Claude Desktop / Claude.ai / Cursor through MCP tools. Per the operator's decision, authentication is a **settings-minted token** (NOT a full OAuth 2.1 flow): the operator generates an `mcp_` token in the console settings and pastes it into their MCP client's `Authorization` header. This reuses the T1 API-key machinery (hash-only minting + revocation) and the resource-server validation, and DROPS the entire thin OAuth Authorization Server (DCR / authorize / consent / callback / token / revoke and its 4 OAuth tables) and the `.well-known` discovery surface — a large simplification. The MCP server is gated by a **settings toggle** (off by default — the most dangerous outward-facing execution surface ships inert). Depends on T1 (`api-key-machine-identity`, applied): the `mcp_` prefix slot in `resolveOperatorPrincipal` is already reserved (deny-until-bound) and `hasScope` exists. Builds Tracks T3+T4 of `docs/external-api-mcp-epic.md`, reshaped to the settings-minted token model.

## What Changes

- **Settings-minted MCP token**: an operator generates an `mcp_`-prefixed token in the console settings (show-once, like the API-keys card), stored HASH-ONLY, owner-scoped, with selectable scopes and an optional expiry; listed (prefix + last4 only) and revocable. Minting is session-authenticated only (a machine credential cannot mint another).
- **Resource-server validation**: `resolveMcpToken(rawToken)` = hash → DB lookup → reject revoked/expired → re-confirm the owner's allowlist → return a FULL `AuthInfo` `{ token, clientId, scopes, expiresAt, resource }` (G1: the SDK `requireBearerAuth` rejects a token whose `expiresAt` is unset). Bound into the reserved `mcp_` slot of `resolveOperatorPrincipal` as the `mcp` principal kind.
- **`/mcp` endpoint**: the official `@modelcontextprotocol/sdk` (v1.x) `StreamableHTTPServerTransport` (stateless) on a Nest/Express route, fronted by the SDK `requireBearerAuth` → `resolveMcpToken`; NOT `@rekog/mcp-nest`. Imports pinned to the v1.x single-package subpaths (verified at install, G2). Coexists with the `ws` `/terminal` adapter + the global JSON parser.
- **Tools** delegating to the existing services with per-tool scope gates: `create_task` (tasks:write, returns a handle immediately — never blocks), `get_task` (tasks:read), `list_tasks` (tasks:read), `stop_task` (tasks:write), `get_transcript` (tasks:read), `list_repos` (repos:read); missing scope → MCP error with 403-semantics; no standalone provisioning path.
- **Settings enable toggle**: a `SystemSettings.mcpServerEnabled` flag (default `false`, ship inert) gating whether `/mcp` is served — when off, `/mcp` is absent/410, no token resolves there, and the console hides the connect affordance. Toggled in the console settings (admin-gated), like the configurable task-slots DB setting.
- **Settings UI**: a console settings "MCP Server" section showing the enable toggle, the `/mcp` endpoint URL + connect instructions (paste the `mcp_` token into the client's `Authorization` header), and the operator's MCP tokens (mint show-once / list / revoke).
- **Guard / CORS**: the global guard exempts `/mcp` from the SESSION guard but `/mcp` stays PROTECTED by `requireBearerAuth` (never unauthenticated); route-scoped bearer-only, non-credentialed CORS for `/mcp` (never add an MCP-client origin to the cookie-credentialed list).
- **Out of scope** (vs the prior OAuth design): the full OAuth 2.1 flow / DCR / consent / `.well-known` discovery (the operator chose settings-minted tokens); webhooks (deferred); per-user task ownership (D2 shared pool — any MCP token may list/stop any task, accepted).

## Capabilities

### New Capabilities
- `mcp-server`: the settings-minted MCP-token lifecycle (mint/list/revoke, hash-only, scoped) + `resolveMcpToken` resource-server validation, the `/mcp` streamable-HTTP endpoint (official SDK v1.x) and its tools (delegating to existing services, per-tool scope, immediate-handle), and the `SystemSettings.mcpServerEnabled` gate.

### Modified Capabilities
- `multi-user-oauth`: bind the real `resolveMcpToken` into the reserved `mcp_` prefix slot of `resolveOperatorPrincipal`; exempt `/mcp` from the session guard while keeping it bearer-protected; route-scoped bearer-only CORS for `/mcp`.
- `frontend-console`: add a settings "MCP Server" section (enable toggle, endpoint URL + connect instructions, and the MCP-token mint/list/revoke card).

## Impact

- **Code**: new `apps/api/src/mcp/` (the `/mcp` controller + transport mount + tools, the MCP-token service + `resolveMcpToken`, the enable-gate); `operator-principal.ts` (bind the `mcp_` resolver); `auth.guard.ts` (exempt `/mcp`); `app.module.ts` (module wiring + `requireBearerAuth` on `/mcp`); `main.ts` (route-scoped CORS); `settings` service/controller (the toggle + token CRUD). `apps/web` settings page (the MCP section).
- **Data**: one new `McpToken` Prisma model (mirrors `ApiKey`: userId, tokenHash, prefix, last4, name, scopes[], lastUsedAt?, expiresAt?, revokedAt?) + a `mcpServerEnabled` column on `SystemSettings`; one migration. NO OAuth tables.
- **Dependencies**: `@modelcontextprotocol/sdk` (v1.x) only; install-time verification of the v1.x import subpaths (G2). No upstream-OAuth/passport deps (the thin AS is gone).
- **Deploy**: off by default (`mcpServerEnabled=false`); a deploy-time acceptance is a live connect from Claude Desktop / Cursor using a settings-minted token. The CI boot-smoke (T1) guards the new module.
