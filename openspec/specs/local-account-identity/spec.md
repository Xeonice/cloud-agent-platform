# local-account-identity Specification

## Purpose
TBD - created by archiving change add-private-account-identity. Update Purpose after archive.
## Requirements
### Requirement: Account identity is decoupled from GitHub via IdentityLink

The orchestrator SHALL model a `User` as a provider-agnostic account (stable `id`,
optional unique `email`, display `name`, optional `avatarUrl`, `role`, `allowed`,
`mustChangePassword`) and SHALL represent each login identity as a separate
`IdentityLink` record `(userId, provider, providerAccountId, secret?)` with a unique
constraint on `(provider, providerAccountId)`. A `github` identity SHALL carry the
encrypted GitHub access token as its `secret`; a `password` identity SHALL carry the
argon2 password hash as its `secret`. A single `User` MAY hold more than one
`IdentityLink`. The `User` record SHALL NOT carry a `githubAccessToken` column
once migration completes (the encrypted token moves to the `github` identity's
`secret`). The legacy `githubId` column MAY be retained as a DEPRECATED, nullable
backward-compatibility column pending a follow-up migration (expand-contract, per
design.md); it SHALL NOT be the identity-resolution key — identity resolution
SHALL go through `IdentityLink`.

#### Scenario: A GitHub login resolves through its identity link

- **WHEN** a GitHub identity authenticates
- **THEN** the orchestrator resolves the `User` via the `IdentityLink` whose
  `provider="github"` and `providerAccountId` equals the GitHub numeric id, rather
  than via a `githubId` column on `User`

#### Scenario: One account can carry multiple identities

- **WHEN** an account has both a `password` identity and a `github` identity
- **THEN** both `IdentityLink` rows reference the same `User.id` and either identity
  authenticates that same account

#### Scenario: Identity uniqueness is enforced per provider

- **WHEN** a second `IdentityLink` is created with a `(provider, providerAccountId)`
  pair that already exists
- **THEN** the orchestrator rejects it rather than creating a duplicate identity

### Requirement: The runtime authorization gate is the user's allowed flag

The orchestrator SHALL gate every authenticated request on the resolved user's `allowed` flag, re-confirmed at request time (not cached) — because the backend runs tasks under a host-root `docker.sock` model, the set of identities permitted to act is exactly the set granted root-equivalent execution. A resolved principal whose user has `allowed = false` SHALL be denied fail-closed regardless of identity type (session, GitHub, password, OTP, API key, MCP token). The gate SHALL fail closed for any account that does not exist or cannot be resolved.

#### Scenario: Allowed account is admitted

- **WHEN** a request resolves to a user whose `allowed` is true
- **THEN** the request proceeds and is attributed to that user

#### Scenario: Disallowed account is denied on its next request

- **WHEN** a user's `allowed` is set to false while they hold a live session/token
- **THEN** their next request is denied fail-closed because the gate re-confirms
  `allowed` at request time

### Requirement: AUTH_ALLOWLIST is GitHub login-time provisioning, not a runtime gate

The `AUTH_ALLOWLIST` env value (numeric GitHub ids) SHALL be consulted ONLY during
a GitHub login to decide whether to provision/keep the GitHub user as `allowed`. It
SHALL match on the immutable numeric GitHub id (never solely the mutable `login`)
and SHALL fail closed when unset, empty, or unparseable (a GitHub login not on the
list SHALL NOT be granted `allowed`). The runtime request gate SHALL NOT consult
`AUTH_ALLOWLIST`; revoking an already-provisioned GitHub user SHALL be done by
setting `allowed = false`.

#### Scenario: GitHub login on the allowlist is provisioned allowed

- **WHEN** a GitHub identity whose numeric id is on `AUTH_ALLOWLIST` completes login
- **THEN** its `User` is upserted with `allowed = true`

#### Scenario: GitHub login off the allowlist is not granted access

- **WHEN** a GitHub identity whose numeric id is NOT on `AUTH_ALLOWLIST` completes
  the OAuth exchange
- **THEN** no allowed access is granted and the operator is returned to the login gate

#### Scenario: Editing the env does not revoke a live GitHub user at runtime

- **WHEN** a GitHub user is removed from `AUTH_ALLOWLIST` but their `User.allowed`
  remains true
- **THEN** their existing session continues to be admitted until an admin sets
  `allowed = false` (the documented revocation path), because the runtime gate reads
  `User.allowed`, not the env

### Requirement: GitHub access token is stored on the github identity

The encrypted GitHub access token SHALL be persisted as the `secret` of the user's
`github` `IdentityLink` and read through a single shared helper that resolves the
github identity for a user and decrypts its secret. All token consumers
(repository import, sandbox clone provisioning, and forge target resolution) SHALL
read through this helper. The global fallback that locates "an allowed user with a
GitHub token" SHALL query github `IdentityLink` rows joined to allowed users.

#### Scenario: Token consumers read through the identity helper

- **WHEN** repository import, clone provisioning, or forge resolution needs the
  operator's GitHub token
- **THEN** it obtains the token via the shared github-identity helper (decrypting the
  identity `secret`) rather than from a `User.githubAccessToken` column

#### Scenario: Owner-scoped lookup falls back to an allowed github identity

- **WHEN** the owning user has no github token but provisioning needs one
- **THEN** the lookup falls back to an allowed user's github `IdentityLink` token,
  preserving the prior owner-scoped-then-fallback behavior

### Requirement: GitHub login auto-links by verified primary email

The orchestrator SHALL attach a GitHub login's `github` IdentityLink to an existing account when the GitHub login returns a primary, verified email equal to that account's `User.email` (treating them as the same person), and SHALL record an audit event for the link. It SHALL NOT auto-link on an unverified or non-primary email. When no existing account shares the email, normal GitHub provisioning applies.

#### Scenario: Verified email links to the existing account

- **WHEN** a GitHub login returns a primary verified email matching an existing
  local account's email
- **THEN** the github identity is attached to that account and an audit event records
  the link

#### Scenario: Unverified email does not auto-link

- **WHEN** a GitHub login returns an email that is not primary+verified, even if it
  matches an existing account
- **THEN** the orchestrator does not attach the github identity to that account

