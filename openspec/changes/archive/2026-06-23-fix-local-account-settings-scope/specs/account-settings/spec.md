## ADDED Requirements

### Requirement: Per-account settings are scoped by account id, available to every authenticated account

Per-account settings (account preferences, the Codex credential, and Codex device login) SHALL be
scoped by the operator's account id (the user primary key) — NOT by a GitHub identity. Every
authenticated, allowed account SHALL be able to read and write its OWN per-account settings,
INCLUDING a local (non-GitHub) account that has no GitHub identity. A local account SHALL NOT be
rejected with `account_scope_required`; that error SHALL be reserved for a principal with no account
identity at all (e.g. an identity-less machine credential or legacy token). Scope SHALL remain
per-account: one account SHALL NOT read or write another account's settings.

#### Scenario: Local account reads/writes its own Codex credential

- **WHEN** a local (password/OTP, no GitHub id) authenticated, allowed account reads or saves its Codex credential
- **THEN** the request is scoped to that account's id and succeeds, never returning `account_scope_required`

#### Scenario: GitHub account is unaffected (no regression)

- **WHEN** an existing GitHub account reads a previously-saved Codex credential
- **THEN** the credential still resolves under the same account id

#### Scenario: Codex device login works for a local account

- **WHEN** a local account starts, polls, or cancels a Codex device login
- **THEN** the device-login session is keyed by that account's id and proceeds

#### Scenario: An identity-less principal still has no per-account settings

- **WHEN** a principal with no account identity (machine credential / legacy token) calls a per-account settings endpoint
- **THEN** it is rejected and no shared row is read or written

#### Scenario: Per-account isolation is preserved

- **WHEN** account A reads or writes account settings
- **THEN** it never reads or writes account B's settings
