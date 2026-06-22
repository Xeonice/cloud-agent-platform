## MODIFIED Requirements

### Requirement: MCP token resolution re-confirms the allowlist and returns a full AuthInfo

A presented `mcp_` token SHALL be resolved by `resolveMcpToken` = hash → DB lookup → reject revoked/expired → re-confirm the owner is `allowed` (`User.allowed` re-checked on the owner) → success. Resolution SHALL return a FULL `AuthInfo` `{ token, clientId, scopes, expiresAt, resource }` (the resource is the canonical `/mcp` URI). A token whose `expiresAt` is unset MUST NOT be produced, because the SDK `requireBearerAuth` rejects such a token and would 401 every valid token. The owner's `allowed` flag SHALL be re-checked on EVERY request (not cached), so disabling the owner stops the token on its next call. The resolved principal SHALL funnel through `resolveOperatorPrincipal`'s reserved `mcp_` slot as the `mcp` kind, carrying the owner + the token's scopes.

#### Scenario: A valid token resolves to a full AuthInfo and an mcp principal

- **WHEN** `/mcp` is called with a non-expired, non-revoked `mcp_` token whose owner is `allowed`
- **THEN** `resolveMcpToken` returns an `AuthInfo` with `expiresAt` + `scopes` populated, and the request is admitted as an `mcp` principal carrying those scopes

#### Scenario: Disabling the owner stops the token

- **WHEN** the owner of a valid MCP token has `allowed` set to false
- **THEN** the next `/mcp` request bearing that token is rejected (owner `allowed` re-checked at resolution)
