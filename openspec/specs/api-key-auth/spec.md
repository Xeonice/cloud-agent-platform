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

An API key presented as a credential SHALL be resolved by hashing the presented value and looking up the stored hash. Resolution SHALL fail closed (deny) when the key is unknown, revoked, or expired, OR when the owning user is no longer allowlisted. The allowlist membership of the owner SHALL be re-confirmed on EVERY request (not cached), so a de-allowlisted owner's keys stop working on their very next call. A successful resolution SHALL yield the owner as the principal's user and the key's granted scopes.

#### Scenario: Valid key resolves to its owner with scopes

- **WHEN** a request presents a non-expired, non-revoked `cap_sk_` key whose owner is allowlisted
- **THEN** the request is admitted as an `api-key` principal whose user is the key owner and whose scopes are the key's granted scopes

#### Scenario: Revoked or expired key is denied

- **WHEN** a request presents a key that has been revoked or whose expiry has passed
- **THEN** resolution returns no principal and the request is rejected with 401, with no state change

#### Scenario: De-allowlisted owner's key stops working immediately

- **WHEN** the owner of a previously-valid key is removed from the allowlist
- **THEN** the next request presenting that key is denied, because allowlist membership is re-confirmed at resolution time

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

The system SHALL define a shared scope vocabulary (`tasks:read`, `tasks:write`, `repos:read`) used by both API keys and later machine principals. A principal that carries scopes SHALL be granted a scoped operation only when its scopes include the operation's required scope; otherwise the request SHALL be rejected with 403 (insufficient scope), distinct from the 401 returned for an absent or invalid credential. A principal that carries NO scopes (a GitHub session or the legacy operator token) SHALL be treated as allow-all, so existing behavior is unchanged.

#### Scenario: Missing scope is rejected with 403

- **WHEN** an `api-key` principal whose scopes are only `tasks:read` calls an operation requiring `tasks:write`
- **THEN** the request is rejected with 403 insufficient scope, distinct from a 401

#### Scenario: Scopeless principal retains full access

- **WHEN** a GitHub-session principal (which carries no scopes) calls any scoped operation
- **THEN** the operation is permitted, because an absent scope set means allow-all

