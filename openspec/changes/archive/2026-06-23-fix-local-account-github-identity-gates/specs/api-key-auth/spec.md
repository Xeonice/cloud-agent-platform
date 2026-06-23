## ADDED Requirements

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
