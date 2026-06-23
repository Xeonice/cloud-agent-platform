## ADDED Requirements

### Requirement: Forge credentials are scoped by account id, available to local accounts

Forge credentials (per-forge Personal Access Tokens and the self-hosted connection registry) SHALL
be owner-scoped by the operator's account id (the user primary key), available to every
authenticated, allowed account INCLUDING a local (non-GitHub) account with no GitHub identity. A
local account SHALL NOT be rejected with `account_scope_required` when connecting, listing, or
removing a forge credential. Owner isolation SHALL remain: one account SHALL NOT see or use another
account's forge credentials.

#### Scenario: Local account connects a forge credential

- **WHEN** a local (no GitHub id) authenticated, allowed account connects, lists, or removes a forge PAT or registry entry
- **THEN** the operation is scoped to that account's id and succeeds, never returning `account_scope_required`

#### Scenario: Forge owner isolation across accounts

- **WHEN** account A lists its forge credentials
- **THEN** account B's forge credentials are never returned
