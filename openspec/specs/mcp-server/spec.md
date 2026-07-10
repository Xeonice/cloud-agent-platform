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

A presented `mcp_` token SHALL be resolved by `resolveMcpToken` = hash → DB lookup → reject revoked/expired → re-confirm the owner is `allowed` (`User.allowed` re-checked on the owner) → success. Resolution SHALL return a FULL `AuthInfo` `{ token, clientId, scopes, expiresAt, resource }` (the resource is the canonical `/mcp` URI). A token whose `expiresAt` is unset MUST NOT be produced, because the SDK `requireBearerAuth` rejects such a token and would 401 every valid token. The owner's `allowed` flag SHALL be re-checked on EVERY request (not cached), so disabling the owner stops the token on its next call. The resolved principal SHALL funnel through `resolveOperatorPrincipal`'s reserved `mcp_` slot as the `mcp` kind, carrying the owner + the token's scopes.

#### Scenario: A valid token resolves to a full AuthInfo and an mcp principal

- **WHEN** `/mcp` is called with a non-expired, non-revoked `mcp_` token whose owner is `allowed`
- **THEN** `resolveMcpToken` returns an `AuthInfo` with `expiresAt` + `scopes` populated, and the request is admitted as an `mcp` principal carrying those scopes

#### Scenario: Disabling the owner stops the token

- **WHEN** the owner of a valid MCP token has `allowed` set to false
- **THEN** the next `/mcp` request bearing that token is rejected (owner `allowed` re-checked at resolution)

### Requirement: The /mcp endpoint mounts the official SDK and is bearer-protected

The MCP server SHALL expose `/mcp` using the official `@modelcontextprotocol/sdk` (v1.x) `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), with a fresh `McpServer` and transport pair per request so concurrent requests never share the SDK's single-transport protocol object. ONLY `POST` SHALL be passed to `transport.handleRequest` (with the pre-parsed JSON body). `GET` and `DELETE` SHALL return `405 Method Not Allowed` — a JSON-RPC error body with an `Allow: POST` header — and SHALL NOT be routed to `transport.handleRequest`: because stateless + `enableJsonResponse` mode serves NO server→client SSE stream, handing `GET` to `transport.handleRequest` opens an empty SSE stream that hangs until timeout and breaks a real MCP client's handshake. The `405` is a method-layer verdict that does NOT consult the enable toggle. It SHALL NOT depend on `@rekog/mcp-nest`. The import paths SHALL be the v1.x single-package subpaths (`@modelcontextprotocol/sdk/server/...`), verified against the installed package (not the v2-alpha `@modelcontextprotocol/express`). The endpoint SHALL coexist with the existing `ws` `/terminal` adapter + the global JSON parser. Every `/mcp` request SHALL be validated by the SDK `requireBearerAuth` → `resolveMcpToken` registered BEFORE the transport; an absent/invalid token SHALL yield 401 (authorization re-validated on every request — a transport session id is never a credential). Status-code precedence: a missing/invalid bearer on ANY method yields 401 (the middleware runs first); a valid bearer on `GET`/`DELETE` yields 405; a valid bearer on `POST` is then subject to the enable toggle (503 when off).

#### Scenario: An authorized client lists + calls a tool

- **WHEN** an MCP client connects to `/mcp` with a valid `mcp_` bearer and issues `tools/list` then a tool call
- **THEN** the SDK transport serves the JSON-RPC, the tools are advertised, and the call dispatches to its handler

#### Scenario: An unauthorized /mcp call is rejected

- **WHEN** `/mcp` is called without a valid `mcp_` bearer
- **THEN** it returns 401 and no tool runs

#### Scenario: An authorized GET or DELETE is rejected with 405 without hanging

- **WHEN** `GET /mcp` or `DELETE /mcp` is called with a valid `mcp_` bearer
- **THEN** it returns `405 Method Not Allowed` (a JSON-RPC error body + `Allow: POST`) IMMEDIATELY — it does not open an SSE stream and does not hang — so a real streamable-HTTP client falls back to POST-only request/response and completes its handshake

#### Scenario: A real MCP client completes the handshake over POST

- **WHEN** a streamable-HTTP MCP client (e.g. Claude Code via `claude mcp add --transport http`) connects, receives 405 on its GET stream attempt, and proceeds over POST
- **THEN** the connection succeeds and the client fetches the tool list (no `tools fetch failed` hang)

### Requirement: MCP tools delegate to existing services with per-tool scope gates

The MCP server SHALL expose tools delegating to the EXISTING services (one admission path, no fork): `create_task` (`tasks:write`), `get_task` (`tasks:read`), `list_tasks` (`tasks:read`), `stop_task` (`tasks:write`), `get_transcript` (`tasks:read`, the canonical Console/REST transcript read), `list_repos` and `get_repo` (`repos:read`), `create_schedule` (`tasks:write`), `list_schedules` (`tasks:read`), `get_schedule` (`tasks:read`), `update_schedule`, `pause_schedule`, `resume_schedule`, `dispatch_schedule`, and `delete_schedule` (`tasks:write`), and `list_schedule_runs` (`tasks:read`). The tool inventory SHALL stay in parity with each explicit MCP mapping in `PUBLIC_V1_OPERATIONS`; streaming SSE is an explicit REST-only exclusion rather than an accidental missing tool.

`create_task` SHALL use the exact shared `V1CreateTaskRequestSchema`, including UUID `repoId`, `skills`, `deadlineMs`, `idleTimeoutMs`, `runtime`, `sandboxEnvironmentId`, and `deliver`, and SHALL parse the callback input against that schema before admission. The HTTP-only `Idempotency-Key` header SHALL be recorded as an explicit MCP protocol difference: it is not a tool argument, and each MCP call is a distinct create. `list_tasks`, `list_repos`, `list_schedules`, and `list_schedule_runs` SHALL accept the corresponding public `limit`/`cursor` query contract (`limit` maximum 200) and return the same `{ items, nextCursor }` keyset envelope as `/v1`. Task and repo pagination SHALL use one shared query implementation with `/v1`; schedule pagination SHALL delegate to the scheduled-task service page methods.

`create_task` structured content and `outputSchema` SHALL match the canonical `TaskResponseSchema` returned by `POST /v1/tasks`. Its JSON text content MAY retain the historical `{ id, status, task }` wrapper for compatibility with existing text-rendering clients.

Schedule tools SHALL delegate to the existing scheduled-task service, SHALL scope every operation to the account id in `AuthInfo.extra.userId`, and SHALL fail closed before acting when that owner id is absent. Each tool SHALL enforce its required scope against the resolved `mcp` principal's scopes BEFORE acting, returning an MCP error with 403-semantics when missing. `create_task` SHALL return a handle (id + status) IMMEDIATELY — it SHALL NOT block until the task completes — so a tool call never conflicts with a minutes-long run; the client polls `get_task` to a terminal status then reads `get_transcript`. `get_transcript` SHALL call the same shared transcript reader as Console and `/v1`, including live running-task reads and audit-derived system turns. Every tool SHALL advertise an SDK `outputSchema` and return matching `structuredContent`, while retaining JSON text `content` for existing clients. There SHALL be no standalone `start_sandbox` tool that bypasses the guardrails admission path. The raw PTY/WebSocket terminal stream SHALL NEVER be exposed via a tool.

#### Scenario: A scoped tool is gated

- **WHEN** an `mcp` principal whose scopes lack `tasks:write` calls `create_task` or `stop_task`
- **THEN** the tool returns an MCP error with 403-semantics and performs no state change

#### Scenario: create_task returns a handle without blocking

- **WHEN** `create_task` runs
- **THEN** it returns the task id + status immediately (provisioning proceeds asynchronously through the same admission the console uses), not after the task completes

#### Scenario: MCP task input stays aligned with the public task contract

- **WHEN** an MCP caller creates a task with skills, guardrail timeouts, runtime, sandbox environment, or delivery fields accepted by `POST /v1/tasks`
- **THEN** `create_task` accepts and forwards the same fields after shared-contract validation
- **AND** an invalid non-UUID `repoId` is rejected before task admission
- **AND** each MCP invocation remains a distinct create because the REST-only `Idempotency-Key` header is not mapped

#### Scenario: MCP list tools page identically to the public API

- **WHEN** an MCP caller supplies `limit` and follows `nextCursor` on a task, repo, schedule, or schedule-run list
- **THEN** each result is a `{ items, nextCursor }` envelope with the same maximum limit and keyset semantics as `/v1`

#### Scenario: MCP clients receive structured and text results

- **WHEN** a client lists and calls an MCP tool
- **THEN** the advertised tool includes an `outputSchema` and the result includes matching `structuredContent`
- **AND** the result retains JSON text content for clients that do not consume structured output

#### Scenario: MCP client manages its own schedules

- **WHEN** an MCP principal with `tasks:read`, `tasks:write`, and an account id in `AuthInfo.extra.userId` creates, reads, updates, dispatches, deletes, or lists runs for a schedule
- **THEN** the corresponding MCP tool delegates to the existing scheduled-task service with that account id
- **AND** schedule request bodies are validated by the shared schedule contracts before the service acts

#### Scenario: MCP pauses and resumes an owned schedule

- **WHEN** an owner-scoped MCP caller invokes `pause_schedule` or `resume_schedule` with `tasks:write`
- **THEN** the existing scheduled-task pause or resume method runs with the token owner's account id

#### Scenario: Schedule tools fail closed without scope or owner

- **WHEN** an MCP principal calls a schedule tool without its required `tasks:read` or `tasks:write` scope, or without `AuthInfo.extra.userId`
- **THEN** the tool returns an MCP error with 403-semantics
- **AND** no scheduled-task service method runs

### Requirement: A settings toggle gates whether the MCP server is served

The MCP server SHALL be gated by a `SystemSettings.mcpServerEnabled` flag defaulting to `false` (ship inert — the outward-facing execution surface is off until an operator turns it on). When `false`, `/mcp` SHALL NOT serve MCP traffic (absent or a clear disabled response), no `mcp_` token SHALL resolve a usable session there, and the console SHALL hide the connect affordance. The flag SHALL be toggled from the console settings by an admin operator. Turning it off SHALL stop new `/mcp` use without deleting any minted token.

#### Scenario: The MCP server is off by default

- **WHEN** the platform boots with no `mcpServerEnabled` override
- **THEN** `/mcp` does not serve MCP traffic and the console shows the MCP server as disabled

#### Scenario: An admin enables the MCP server

- **WHEN** an admin operator toggles `mcpServerEnabled` on
- **THEN** `/mcp` serves MCP traffic for a valid `mcp_` bearer, and toggling it back off stops new use while leaving minted tokens intact

### Requirement: Local accounts manage their own MCP tokens

MCP-token management (mint / list / revoke) SHALL be available to every authenticated, allowed
account scoped by the account primary key (`user.id`), INCLUDING a local (password/OTP, no GitHub
identity) account. A local account SHALL NOT be rejected with `github_identity_required`. A machine
(`mcp` / `api-key`) credential or the identity-less legacy operator SHALL still be rejected with
`session_operator_required`. Scope SHALL remain per-account: one account SHALL see and revoke only
its own tokens.

#### Scenario: Local account manages its own MCP tokens

- **WHEN** a local (github_id=null) authenticated, allowed account mints, lists, or revokes an MCP token
- **THEN** the operation is scoped to its account id and succeeds (no `github_identity_required`), and it sees only its own tokens

#### Scenario: Machine credential cannot mint

- **WHEN** an `mcp`/`api-key` principal, or the identity-less legacy operator, calls the mint endpoint
- **THEN** it is rejected with `session_operator_required` and no token is created
