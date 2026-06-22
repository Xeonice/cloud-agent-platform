## MODIFIED Requirements

### Requirement: Idempotent default-admin seed on boot

On startup the orchestrator SHALL ensure a default administrator account exists, identified by
`ADMIN_EMAIL`, with `role = admin` and `allowed = true`. The seed SHALL be idempotent (safe to run
on every boot without creating duplicates or resetting an already-customized admin) and SHALL be
self-contained — it MUST NOT depend on the ordering of other providers' bootstrap hooks. If
`ADMIN_PASSWORD` is provided, the admin's `password` identity SHALL be set from it; the DB SHALL
store only the argon2 hash. The seeded admin SHALL be flagged `mustChangePassword` on initial
creation. When the `ADMIN_EMAIL` account ALREADY EXISTS (however it was created — including via
GitHub OAuth, which defaults new accounts to `role = member`) and its `role` is not `admin`, the
seed SHALL idempotently promote that account to `role = admin`. The promotion SHALL change ONLY the
role — it SHALL NOT reset the password, the `allowed` flag, or `mustChangePassword`, preserving the
"never reset an already-customized admin" discipline. When the account is already `admin`, the seed
SHALL make no change.

#### Scenario: Fresh deploy gets a usable admin

- **WHEN** the orchestrator boots against a database with no admin account
- **THEN** it creates an admin keyed by `ADMIN_EMAIL` with `role = admin`, `allowed = true`, and `mustChangePassword = true`

#### Scenario: Re-boot does not duplicate or reset the admin

- **WHEN** the orchestrator boots again after the admin already exists (and may have changed its password)
- **THEN** the seed leaves the existing admin intact and creates no duplicate

#### Scenario: An existing non-admin ADMIN_EMAIL account is promoted to admin

- **WHEN** the `ADMIN_EMAIL` account already exists with `role = member` (e.g. it was first created via GitHub OAuth) and the orchestrator boots
- **THEN** the seed updates that account to `role = admin` and leaves its password, `allowed`, and `mustChangePassword` unchanged

#### Scenario: Promotion is idempotent for an already-admin account

- **WHEN** the `ADMIN_EMAIL` account already exists with `role = admin` and the orchestrator boots
- **THEN** the seed issues no role change
