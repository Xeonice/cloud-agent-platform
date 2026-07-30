## MODIFIED Requirements

### Requirement: Admin-only account lifecycle management

The orchestrator SHALL expose account-management operations restricted to
`role = admin` principals: create a local account (email, display name, role, and an
initial-credential choice), enable/disable any account, reset a local account's
password, and assign role. Creating a local account SHALL set `allowed = true`;
choosing "set initial password" SHALL store an argon2 hash and flag
`mustChangePassword`; choosing "verification-code only" SHALL create no password
identity. There SHALL be NO public registration — accounts come only from this admin
flow, the default-admin seed, or GitHub provisioning. A non-admin principal invoking
any management operation SHALL be denied (403).

Admin-ness is a property of the CREDENTIAL, not only of the account behind it. These
operations SHALL admit only an interactive session principal. A machine credential —
an API key or an MCP token — SHALL be denied even when its owning account is
`allowed` with `role = admin`, and irrespective of the scopes it carries; so SHALL a
legacy shared-token principal. Re-reading the owning account's `role` and `allowed`
columns SHALL NOT by itself admit a caller, because a machine credential resolves to
its owner's account row and would otherwise inherit privileges its grant never
conferred.

#### Scenario: Admin creates a local account

- **WHEN** an admin creates an account with an email, name, role, and an initial
  password
- **THEN** the account is created with `allowed = true`, a `password` identity with
  the argon2 hash, and `mustChangePassword = true`

#### Scenario: Admin creates a verification-code-only account

- **WHEN** an admin creates an account choosing "verification-code only"
- **THEN** the account is created with no password identity and can log in by email
  verification code once SMTP is configured

#### Scenario: Non-admin is denied management

- **WHEN** a non-admin principal calls any account-management operation
- **THEN** the orchestrator denies it with 403 and makes no change

#### Scenario: An admin's machine credential is denied management

- **WHEN** an API key or MCP token whose owning account is `allowed` with
  `role = admin` calls any account-management operation
- **THEN** the orchestrator denies it with 403 and makes no change
- **AND** the denial does not depend on which scopes that credential was granted
