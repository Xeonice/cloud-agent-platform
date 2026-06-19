# mcp-server Specification

## Purpose
TBD - created by archiving change remote-mcp-server. Update Purpose after archive.
## Requirements
### Requirement: Settings-minted MCP tokens

An operator SHALL be able to mint an MCP token from the console settings, bound to their own user. The token body SHALL be cryptographically random (≥256 bits) with the reserved `mcp_` prefix; the raw value SHALL be returned EXACTLY ONCE at creation and the server SHALL persist only its SHA-256 hash (never the raw token). A minted token SHALL record its owner, a display prefix + last-4, an operator label, its granted scopes, and an optional absolute expiry. Listing SHALL show only non-secret metadata (prefix + last4, scopes, lifecycle timestamps) — never the raw token or its hash. Minting/listing/revoking SHALL be reachable ONLY by a GitHub-OAuth `session` principal (a machine credential cannot mint another). Revocation SHALL be idempotent and take effect on the token's next use.

#### Scenario: Mint returns the raw token once

- **WHEN** an operator session mints an MCP token with a name + scopes
- **THEN** the response includes the raw `mcp_…` value, and the persisted record stores only its SHA-256 hash + the owner + the metadata

#### Scenario: A machine credential cannot mint an MCP token

- **WHEN** an `mcp` or `api-key` principal calls the mint endpoint
- **THEN** it is rejected and no token is created

### Requirement: MCP token resolution re-confirms the allowlist and returns a full AuthInfo

A presented `mcp_` token SHALL be resolved by `resolveMcpToken` = hash → DB lookup → reject revoked/expired → re-confirm the owner's allowlist (`isAllowlistedRaw` on the owner's GitHub id) → success. Resolution SHALL return a FULL `AuthInfo` `{ token, clientId, scopes, expiresAt, resource }` (the resource is the canonical `/mcp` URI). A token whose `expiresAt` is unset MUST NOT be produced, because the SDK `requireBearerAuth` rejects such a token and would 401 every valid token. The owner's allowlist membership SHALL be re-checked on EVERY request (not cached), so de-allowlisting stops the token on its next call. The resolved principal SHALL funnel through `resolveOperatorPrincipal`'s reserved `mcp_` slot as the `mcp` kind, carrying the owner + the token's scopes.

#### Scenario: A valid token resolves to a full AuthInfo and an mcp principal

- **WHEN** `/mcp` is called with a non-expired, non-revoked `mcp_` token whose owner is allowlisted
- **THEN** `resolveMcpToken` returns an `AuthInfo` with `expiresAt` + `scopes` populated, and the request is admitted as an `mcp` principal carrying those scopes

#### Scenario: De-allowlisting stops the token

- **WHEN** the owner of a valid MCP token is removed from the allowlist
- **THEN** the next `/mcp` request bearing that token is rejected (allowlist re-checked at resolution)

### Requirement: The /mcp endpoint mounts the official SDK and is bearer-protected

The MCP server SHALL expose `/mcp` using the official `@modelcontextprotocol/sdk` (v1.x) `StreamableHTTPServerTransport` in stateless mode (POST/GET/DELETE), passing the pre-parsed JSON body to `transport.handleRequest`, with one `McpServer` (tools registered once) and a transport per request. It SHALL NOT depend on `@rekog/mcp-nest`. The import paths SHALL be the v1.x single-package subpaths (`@modelcontextprotocol/sdk/server/...`), verified against the installed package (not the v2-alpha `@modelcontextprotocol/express`). The endpoint SHALL coexist with the existing `ws` `/terminal` adapter + the global JSON parser. Every `/mcp` request SHALL be validated by the SDK `requireBearerAuth` → `resolveMcpToken` registered BEFORE the transport; an absent/invalid token SHALL yield 401 (authorization re-validated on every request — a transport session id is never a credential).

#### Scenario: An authorized client lists + calls a tool

- **WHEN** an MCP client connects to `/mcp` with a valid `mcp_` bearer and issues `tools/list` then a tool call
- **THEN** the SDK transport serves the JSON-RPC, the tools are advertised, and the call dispatches to its handler

#### Scenario: An unauthorized /mcp call is rejected

- **WHEN** `/mcp` is called without a valid `mcp_` bearer
- **THEN** it returns 401 and no tool runs

### Requirement: MCP tools delegate to existing services with per-tool scope gates

The MCP server SHALL expose tools delegating to the EXISTING services (one admission path, no fork): `create_task` (`tasks:write`), `get_task` (`tasks:read`), `list_tasks` (`tasks:read`), `stop_task` (`tasks:write`), `get_transcript` (`tasks:read`, the durable session-history read), `list_repos` (`repos:read`). Each tool SHALL enforce its required scope against the resolved `mcp` principal's scopes BEFORE acting, returning an MCP error with 403-semantics when missing. `create_task` SHALL return a handle (id + status) IMMEDIATELY — it SHALL NOT block until the task completes — so a tool call never conflicts with a minutes-long run; the client polls `get_task` to a terminal status then reads `get_transcript`. There SHALL be no standalone `start_sandbox` tool that bypasses the guardrails admission path. The raw PTY/WebSocket terminal stream SHALL NEVER be exposed via a tool.

#### Scenario: A scoped tool is gated

- **WHEN** an `mcp` principal whose scopes lack `tasks:write` calls `create_task` or `stop_task`
- **THEN** the tool returns an MCP error with 403-semantics and performs no state change

#### Scenario: create_task returns a handle without blocking

- **WHEN** `create_task` runs
- **THEN** it returns the task id + status immediately (provisioning proceeds asynchronously through the same admission the console uses), not after the task completes

### Requirement: A settings toggle gates whether the MCP server is served

The MCP server SHALL be gated by a `SystemSettings.mcpServerEnabled` flag defaulting to `false` (ship inert — the outward-facing execution surface is off until an operator turns it on). When `false`, `/mcp` SHALL NOT serve MCP traffic (absent or a clear disabled response), no `mcp_` token SHALL resolve a usable session there, and the console SHALL hide the connect affordance. The flag SHALL be toggled from the console settings by an admin operator. Turning it off SHALL stop new `/mcp` use without deleting any minted token.

#### Scenario: The MCP server is off by default

- **WHEN** the platform boots with no `mcpServerEnabled` override
- **THEN** `/mcp` does not serve MCP traffic and the console shows the MCP server as disabled

#### Scenario: An admin enables the MCP server

- **WHEN** an admin operator toggles `mcpServerEnabled` on
- **THEN** `/mcp` serves MCP traffic for a valid `mcp_` bearer, and toggling it back off stops new use while leaving minted tokens intact

