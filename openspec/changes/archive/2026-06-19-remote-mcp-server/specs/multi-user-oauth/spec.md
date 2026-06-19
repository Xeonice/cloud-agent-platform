## ADDED Requirements

### Requirement: /mcp is session-guard-exempt but bearer-protected

The global operator auth guard SHALL exempt `/mcp` from the SESSION guard so the MCP server's own bearer validation runs instead — but `/mcp` SHALL remain PROTECTED by the SDK `requireBearerAuth` → `resolveMcpToken`, never unauthenticated. The exemption SHALL be EXACT-MATCH on `/mcp` (never a broad `/mcp`-prefix that could expose another route). A test SHALL assert `/mcp` is `401` without a valid `mcp_` bearer while a `/v1` data route also stays `401` without a credential. There is NO OAuth `.well-known` discovery surface to exempt (the settings-minted-token model needs none).

#### Scenario: /mcp is bearer-gated, not session-gated

- **WHEN** `/mcp` is requested without a GitHub session but WITH a valid `mcp_` bearer
- **THEN** it is admitted (the session guard is exempt; `requireBearerAuth` validates the bearer)

#### Scenario: /mcp without a bearer is rejected

- **WHEN** `/mcp` is requested with neither a session nor a valid `mcp_` bearer
- **THEN** it returns 401 — the exemption removes only the session guard, not authentication

### Requirement: The reserved mcp_ slot binds the real resolver and reuses the GitHub allowlist

This change SHALL bind the real `resolveMcpToken` into the reserved `mcp_` prefix slot of `resolveOperatorPrincipal` (replacing the deny-until-bound default), so a `mcp_` credential resolves to an `mcp` principal — still routed by prefix to EXACTLY that domain (never tried against the session / legacy / api-key domains). The MCP token reuses the SAME hard allowlist (`isAllowlistedRaw`) that governs who may obtain a console session or an API key, so one allowlist governs all three credential kinds.

#### Scenario: A bound mcp_ token resolves to an mcp principal

- **WHEN** a credential with the `mcp_` prefix is presented and resolves
- **THEN** `resolveOperatorPrincipal` routes it to `resolveMcpToken` and returns an `mcp` principal, never tried against the other domains

### Requirement: /mcp uses route-scoped, bearer-only CORS

`/mcp` SHALL use a route-scoped, bearer-only, NON-credentialed CORS policy distinct from the console's cookie-credentialed CORS. An MCP-client browser origin SHALL NOT be added to the cookie-credentialed origin allowlist (that would let it carry the `cap_session` cookie).

#### Scenario: MCP CORS never carries the session cookie

- **WHEN** CORS is configured for `/mcp`
- **THEN** it is bearer-only / non-credentialed and route-scoped, and no MCP-client origin is added to the console's credentialed CORS allowlist
