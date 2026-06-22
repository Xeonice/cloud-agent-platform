## ADDED Requirements

### Requirement: Idempotent default-admin seed on boot

On startup the orchestrator SHALL ensure a default administrator account exists,
identified by `ADMIN_EMAIL`, with `role = admin` and `allowed = true`. The seed
SHALL be idempotent (safe to run on every boot without creating duplicates or
resetting an already-customized admin) and SHALL be self-contained — it MUST NOT
depend on the ordering of other providers' bootstrap hooks. If `ADMIN_PASSWORD` is
provided, the admin's `password` identity SHALL be set from it; the DB SHALL store
only the argon2 hash. The seeded admin SHALL be flagged `mustChangePassword` on
initial creation.

#### Scenario: Fresh deploy gets a usable admin

- **WHEN** the orchestrator boots against a database with no admin account
- **THEN** it creates an admin keyed by `ADMIN_EMAIL` with `role = admin`,
  `allowed = true`, and `mustChangePassword = true`

#### Scenario: Re-boot does not duplicate or reset the admin

- **WHEN** the orchestrator boots again after the admin already exists (and may have
  changed its password)
- **THEN** the seed leaves the existing admin intact and creates no duplicate

### Requirement: Random admin password with one-time reveal

When `ADMIN_PASSWORD` is not provided, the seed SHALL generate a strong random
password, store only its argon2 hash, and hold the plaintext ONLY in process memory
(never persisted to the database or logs as plaintext beyond the reveal channel).
The orchestrator SHALL expose a one-time reveal that returns the admin email and
generated password exactly once; after it is consumed, a persisted flag (e.g.
`SystemSettings.adminRevealConsumedAt`) SHALL prevent any further reveal and the
in-memory plaintext SHALL be cleared. If the process restarts before the reveal is
consumed, a new random password SHALL be generated (the database never holds the
plaintext to re-serve).

#### Scenario: Generated password is revealed exactly once

- **WHEN** the admin was seeded with a generated password and the reveal has not been
  consumed
- **THEN** the first reveal returns the admin email and password, and the reveal is
  marked consumed so a second attempt returns nothing

#### Scenario: Plaintext is never persisted

- **WHEN** the admin password is generated
- **THEN** only its argon2 hash is stored in the database, and the plaintext exists
  only in process memory until the reveal is consumed or the process restarts

#### Scenario: Restart before reveal regenerates the password

- **WHEN** the process restarts before the reveal was consumed
- **THEN** a new random password is generated and hashed, because no plaintext was
  persisted to re-serve the previous one
