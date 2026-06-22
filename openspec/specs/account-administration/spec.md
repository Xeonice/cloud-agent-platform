# account-administration Specification

## Purpose
TBD - created by archiving change add-private-account-identity. Update Purpose after archive.
## Requirements
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

### Requirement: Disabling any account revokes access on next request

Disabling an account SHALL set `allowed = false`, taking effect on that account's
next request (its sessions and tokens stop resolving). This SHALL apply to
GitHub-linked accounts as well as local accounts, so a GitHub user can be revoked
from the console even though `AUTH_ALLOWLIST` is no longer the runtime gate.
Re-enabling SHALL set `allowed = true`.

#### Scenario: Disabling a GitHub-linked account revokes it

- **WHEN** an admin disables a GitHub-linked account
- **THEN** `allowed` is set false and the account's next request is denied, providing
  the revocation path under the DB-based runtime gate

#### Scenario: Re-enabling restores access

- **WHEN** an admin re-enables a previously disabled account
- **THEN** `allowed` is set true and the account can authenticate again

### Requirement: Account administration page in the console

The console SHALL provide a dedicated account-administration page, reachable from the
account menu, visible to admins. The page SHALL list all accounts (local and
GitHub-linked) in a table showing identity (email or GitHub handle), role, login
methods, and enabled/disabled status, with a filter and a new-account action. Local
rows SHALL offer reset-password and enable/disable; GitHub-linked rows SHALL show
role read-only and offer enable/disable (no password reset). The page SHALL make
clear that role gates only the admin panel and does NOT isolate execution (every
enabled account is host-root).

#### Scenario: Account menu opens the administration page

- **WHEN** an admin selects 账号管理 in the account menu
- **THEN** the console navigates to the account-administration page

#### Scenario: Table lists local and GitHub accounts with the right actions

- **WHEN** the page renders
- **THEN** local accounts show reset-password and enable/disable actions while
  GitHub-linked accounts show role read-only with enable/disable only

#### Scenario: Filtering narrows the account list

- **WHEN** the admin selects a filter (e.g. disabled) or types a search term
- **THEN** the table shows only matching accounts and the count reflects the visible
  rows

