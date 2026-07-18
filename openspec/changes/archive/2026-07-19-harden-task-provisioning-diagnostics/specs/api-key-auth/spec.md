## MODIFIED Requirements

### Requirement: Authorization scopes gate scoped operations

The system SHALL define a shared scope vocabulary (`tasks:read`, `tasks:write`,
`tasks:diagnostics`, `repos:read`) used by both API keys and later machine
principals. A principal that carries scopes SHALL be granted a scoped operation
only when its scopes include the operation's required scope; otherwise the
request SHALL be rejected with 403 (insufficient scope), distinct from the 401
returned for an absent or invalid credential. A principal that carries NO
scopes (a GitHub session or the legacy operator token) SHALL be treated as
allow-all, so existing behavior is unchanged. `tasks:diagnostics` SHALL be an
independent, explicitly granted scope: neither `tasks:read` nor `tasks:write`
implies it, and existing scoped API keys and MCP tokens SHALL NOT gain it during
deployment or migration. Scope compatibility SHALL NOT satisfy an operation's
independent required-owner policy: an identity-less legacy token may pass the
scope helper but SHALL still fail `owner_required` for provisioning diagnostics.

#### Scenario: Missing scope is rejected with 403

- **WHEN** an `api-key` principal whose scopes are only `tasks:read` calls an operation requiring `tasks:write`
- **THEN** the request is rejected with 403 insufficient scope, distinct from a 401

#### Scenario: Scopeless principal retains full access

- **WHEN** a GitHub-session principal (which carries no scopes) calls any scoped operation
- **THEN** the operation is permitted, because an absent scope set means allow-all

#### Scenario: Task read and write scopes do not imply diagnostics

- **WHEN** a scoped API key or MCP token has `tasks:read`, `tasks:write`, or both but does not have `tasks:diagnostics`
- **THEN** a task provisioning-diagnostics read is rejected with 403
- **AND** no diagnostic ledger row is returned or disclosed

#### Scenario: Existing machine credentials do not gain diagnostics during upgrade

- **WHEN** the deployment adds `tasks:diagnostics` to the shared scope vocabulary
- **THEN** every previously minted scoped API key and MCP token retains exactly its persisted scopes
- **AND** an owner must explicitly mint or update a credential with `tasks:diagnostics` before it can call the diagnostic operation

#### Scenario: Scopeless legacy token still lacks a required owner

- **WHEN** the identity-less legacy token calls the owner-required provisioning-diagnostics operation
- **THEN** the request fails the owner boundary even though its absent scope set retains allow-all compatibility
- **AND** no task or diagnostic row is read
