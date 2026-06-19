## MODIFIED Requirements

### Requirement: The /mcp endpoint mounts the official SDK and is bearer-protected

The MCP server SHALL expose `/mcp` using the official `@modelcontextprotocol/sdk` (v1.x) `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), with one `McpServer` (tools registered once) and a transport per request. ONLY `POST` SHALL be passed to `transport.handleRequest` (with the pre-parsed JSON body). `GET` and `DELETE` SHALL return `405 Method Not Allowed` — a JSON-RPC error body with an `Allow: POST` header — and SHALL NOT be routed to `transport.handleRequest`: because stateless + `enableJsonResponse` mode serves NO server→client SSE stream, handing `GET` to `transport.handleRequest` opens an empty SSE stream that hangs until timeout and breaks a real MCP client's handshake. The `405` is a method-layer verdict that does NOT consult the enable toggle. It SHALL NOT depend on `@rekog/mcp-nest`. The import paths SHALL be the v1.x single-package subpaths (`@modelcontextprotocol/sdk/server/...`), verified against the installed package (not the v2-alpha `@modelcontextprotocol/express`). The endpoint SHALL coexist with the existing `ws` `/terminal` adapter + the global JSON parser. Every `/mcp` request SHALL be validated by the SDK `requireBearerAuth` → `resolveMcpToken` registered BEFORE the transport; an absent/invalid token SHALL yield 401 (authorization re-validated on every request — a transport session id is never a credential). Status-code precedence: a missing/invalid bearer on ANY method yields 401 (the middleware runs first); a valid bearer on `GET`/`DELETE` yields 405; a valid bearer on `POST` is then subject to the enable toggle (503 when off).

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
