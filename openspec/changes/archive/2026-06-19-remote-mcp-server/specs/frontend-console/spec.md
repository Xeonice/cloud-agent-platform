## ADDED Requirements

### Requirement: Settings page has an MCP Server section

The console settings page SHALL add an "MCP Server" section that surfaces: (1) the `mcpServerEnabled` toggle (admin-gated — only an admin operator may flip it; off by default), (2) the `/mcp` endpoint URL plus connect instructions (paste the minted `mcp_` token into the MCP client's `Authorization: Bearer` header), and (3) the operator's MCP tokens — mint (a show-once dialog displaying the raw `mcp_` token once, with the same never-shown-again discipline as the API-keys card), list (prefix + last4, scopes, lifecycle state), and revoke. The raw token SHALL live only transiently in the show-once dialog and SHALL never be written to a list row. When the MCP server is disabled, the section SHALL present it as disabled (no live connect affordance) while still allowing an admin to enable it.

#### Scenario: Operator mints and sees an MCP token once

- **WHEN** an operator mints an MCP token in the settings MCP Server section
- **THEN** a show-once dialog displays the raw `mcp_…` token exactly once, the list shows only its prefix + last4 thereafter, and the operator can copy the endpoint URL + connect instructions

#### Scenario: The enable toggle is admin-gated

- **WHEN** a non-admin operator opens the MCP Server section
- **THEN** the `mcpServerEnabled` toggle is not operable by them (only an admin may flip it), while they may still mint/list/revoke their own MCP tokens
