## ADDED Requirements

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
