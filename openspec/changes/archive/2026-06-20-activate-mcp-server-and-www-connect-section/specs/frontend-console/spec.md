## ADDED Requirements

### Requirement: MCP Server settings operate against the live backend

The console's `mcpServer` capability flag SHALL be enabled (`true`) so the
settings "MCP Server" section mints, lists, revokes, and toggles against the
live backend endpoints (`/mcp-tokens` CRUD and `/settings/mcp-server`) rather
than the in-memory mock seam. A minted token's raw value SHALL be the SERVER's
one-time mint response — a real, persisted `mcp_` credential that resolves at the
`/mcp` endpoint — never a client-fabricated stand-in. Consistent with the
ship-inert posture, enabling this flag SHALL NOT by itself serve MCP traffic: the
`/mcp` endpoint SHALL remain gated by the backend `mcpServerEnabled` toggle, so
an admin MUST enable it for a minted token to drive a live session.

#### Scenario: MCP token mint hits the real backend

- **WHEN** an operator mints an MCP token in the settings "MCP Server" section
- **THEN** the request goes to the real `/mcp-tokens` endpoint and the show-once
  raw token is the server's one-time response, not a mock-fabricated value

#### Scenario: A minted token connects once the server is enabled

- **WHEN** an admin has enabled the backend `mcpServerEnabled` toggle and an
  operator presents a real minted token to the `/mcp` endpoint
- **THEN** the bearer is resolved and the MCP session is served — no `401
  invalid_token`, no `503` disabled

#### Scenario: Flag enabled but backend server still disabled

- **WHEN** the `mcpServer` flag is `true` but the backend `mcpServerEnabled`
  toggle is off
- **THEN** the settings section still mints / lists / revokes real tokens, while
  the `/mcp` endpoint reports the server is disabled (no live session) until an
  admin enables it
