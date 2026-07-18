# api-key-auth Specification

## Purpose
TBD - created by archiving change api-key-machine-identity. Update Purpose after archive.
## Requirements
### Requirement: API key minting

An allowlisted operator SHALL be able to mint an API key bound to their own user. The key body SHALL be cryptographically random (≥256 bits of entropy), carry the reserved `cap_sk_` prefix, and the raw key value SHALL be returned to the caller EXACTLY ONCE at creation. The server SHALL persist only the SHA-256 hash of the raw key, never the raw key itself. A minted key SHALL record its owner (`userId`), a display prefix and last-4 characters, an operator-chosen name, its granted scopes, and an optional absolute expiry.

#### Scenario: Mint returns the raw key once

- **WHEN** an authenticated operator mints an API key with a name and a set of scopes
- **THEN** the response includes the raw `cap_sk_…` key value, the key id, name, scopes, prefix, and last-4
- **AND** the persisted record stores only the SHA-256 hash of the raw key, the owner's `userId`, and the metadata — never the raw key value

#### Scenario: Listing never reveals the raw key or hash

- **WHEN** an operator lists their API keys
- **THEN** each entry shows id, name, scopes, prefix, last-4, lastUsedAt, expiresAt, and revokedAt
- **AND** neither the raw key value nor the stored hash appears in any list response

### Requirement: API key resolution re-confirms the allowlist on every request

An API key presented as a credential SHALL be resolved by hashing the presented value and looking up the stored hash. Resolution SHALL fail closed (deny) when the key is unknown, revoked, or expired, OR when the owning user is no longer `allowed`. The owner's `allowed` flag SHALL be re-confirmed on EVERY request (not cached), so a disabled owner's keys stop working on their very next call. A successful resolution SHALL yield the owner as the principal's user and the key's granted scopes.

#### Scenario: Valid key resolves to its owner with scopes

- **WHEN** a request presents a non-expired, non-revoked `cap_sk_` key whose owner is `allowed`
- **THEN** the request is admitted as an `api-key` principal whose user is the key owner and whose scopes are the key's granted scopes

#### Scenario: Revoked or expired key is denied

- **WHEN** a request presents a key that has been revoked or whose expiry has passed
- **THEN** resolution returns no principal and the request is rejected with 401, with no state change

#### Scenario: Disabled owner's key stops working immediately

- **WHEN** the owner of a previously-valid key has `allowed` set to false
- **THEN** the next request presenting that key is denied, because the owner's `allowed` flag is re-confirmed at resolution time

### Requirement: API key revocation

An operator SHALL be able to revoke one of their own API keys. Revocation SHALL be idempotent and take effect on the key's next use. Revoked keys SHALL remain listed (showing a revoked timestamp) but SHALL never resolve to a principal.

#### Scenario: Revoke takes effect on next use

- **WHEN** an operator revokes a key and then a request presents that key
- **THEN** the request is denied as if the key did not exist

### Requirement: API key CRUD is session-authenticated only

The API-key management endpoints (mint, list, revoke) SHALL be reachable ONLY by a GitHub-OAuth session principal. An `api-key` principal SHALL NOT be able to mint, list, or revoke API keys, so a key cannot be used to create another key (no privilege-escalation chain).

#### Scenario: An API key cannot mint another key

- **WHEN** a request authenticated by an `api-key` principal calls the mint endpoint
- **THEN** the request is rejected and no key is created

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

### Requirement: Local accounts manage their own API keys

API-key management (mint / list / revoke) SHALL be available to every authenticated, allowed account
scoped by the account primary key (`user.id`), INCLUDING a local (password/OTP, no GitHub identity)
account. A local account SHALL NOT be rejected with `github_identity_required`. The first gate SHALL
remain: an identity-less principal (a machine `api-key`/`mcp` credential or a legacy token with no
account) SHALL still be rejected (`session_required`) before any key operation. Scope SHALL remain
per-account: one account SHALL NOT see or revoke another account's keys.

#### Scenario: Local account mints/lists/revokes its own API keys

- **WHEN** a local (github_id=null) authenticated, allowed account mints, lists, or revokes an API key
- **THEN** the operation is scoped to its account id and succeeds, never returning `github_identity_required`

#### Scenario: GitHub account is unaffected

- **WHEN** a GitHub account manages its API keys
- **THEN** behavior is unchanged (same account id)

#### Scenario: Identity-less principal is still rejected

- **WHEN** a machine credential or legacy token (no account) calls an api-key endpoint
- **THEN** it is rejected before any key operation

#### Scenario: Per-account isolation

- **WHEN** account A lists its API keys
- **THEN** account B's keys are never returned, and A cannot revoke B's key

