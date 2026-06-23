# smtp-configuration Specification

## Purpose
TBD - created by archiving change add-smtp-config-ui. Update Purpose after archive.
## Requirements
### Requirement: Admin-managed SMTP configuration stored with the password encrypted

The orchestrator SHALL persist a single deployment-level SMTP configuration (host, port, user,
from, and the password) so an administrator can manage it from the console. The password SHALL be
stored ENCRYPTED at rest (reusing the platform's at-rest secret encryption), and the configuration
SHALL be a singleton (one config per deployment, not per user). When no encryption key is
configured, saving a configuration SHALL fail closed — the plaintext password SHALL NEVER be
persisted. A read of the configuration SHALL project the non-secret fields plus a masked password
indicator (e.g. a last-4 suffix and a `hasPassword` flag) and SHALL NEVER return the plaintext
password.

#### Scenario: Saving a config encrypts the password at rest

- **WHEN** an admin saves an SMTP configuration with a password
- **THEN** the stored row holds the password only as ciphertext (never plaintext) alongside the non-secret host/port/user/from and a masked suffix

#### Scenario: Reading the config never returns the plaintext password

- **WHEN** the SMTP configuration is read
- **THEN** the response carries host/port/user/from and a masked password indicator, and does not include the plaintext password

#### Scenario: Saving fails closed without an encryption key

- **WHEN** a save is attempted while no at-rest encryption key is configured
- **THEN** the save is rejected and no plaintext password is persisted

### Requirement: Outbound mail resolves DB config first, env as fallback

Outbound mail SHALL resolve its SMTP transport from the stored DB configuration first and SHALL
fall back to the `SMTP_*` environment when no DB configuration exists. A stored DB configuration
SHALL take precedence over the env. The fallback SHALL preserve existing env-only deployments
unchanged until a DB configuration is saved.

#### Scenario: DB config takes precedence

- **WHEN** a DB SMTP configuration exists and a verification email is sent
- **THEN** the mail is sent using the DB configuration (its password decrypted at send time)

#### Scenario: Env is the fallback when no DB config exists

- **WHEN** no DB SMTP configuration exists but the `SMTP_*` env is configured and a mail is sent
- **THEN** the mail is sent using the env configuration, exactly as before this change

### Requirement: Admin SMTP API with a test-send action

The orchestrator SHALL expose admin-only endpoints to read (masked), save, and TEST the SMTP
configuration. Every endpoint SHALL enforce that the caller is an `admin` (re-checked against the
live account, fail-closed for non-admins) in addition to the global authentication gate. The
test-send endpoint SHALL send a real email to the requesting admin's own account email to verify
connectivity, and SHALL surface a clear success/failure result without leaking the password.

#### Scenario: Non-admin is denied

- **WHEN** a non-admin authenticated operator calls any SMTP config endpoint (read, save, or test)
- **THEN** the request is denied by the admin gate and no configuration is read, written, or used

#### Scenario: Test-send verifies connectivity to the admin's own email

- **WHEN** an admin invokes the test-send endpoint with a candidate configuration
- **THEN** the orchestrator attempts to send a test email to the requesting admin's own email and returns whether it succeeded, without persisting on failure and without returning the password

### Requirement: One-time migration of env SMTP config to the DB on boot

The orchestrator SHALL, on boot, perform a ONE-TIME migration of the env SMTP config into the DB:
when no DB SMTP configuration exists, the `SMTP_*` env is fully configured, and the migration marker
is unset, it SHALL seed the env values into the DB configuration (with the password encrypted) and
SHALL set the marker so the migration runs AT MOST ONCE. The migration SHALL be idempotent and
fail-closed: when no encryption key is available it SHALL skip
(leaving the env fallback in effect); once the marker is set it SHALL NOT re-seed — so an admin who
later edits or deletes the DB config is never overwritten on a subsequent boot. The migration SHALL
be self-contained (independent of other boot-hook ordering) and SHALL never crash boot.

#### Scenario: Env config is migrated to the DB on first boot

- **WHEN** the orchestrator boots with the env SMTP configured, no DB config present, and the migration not yet run
- **THEN** it creates the DB config from the env values (password encrypted) and marks the migration done

#### Scenario: Migration runs at most once

- **WHEN** the orchestrator boots again after the migration marker is set
- **THEN** it does not re-seed, even if the DB config was since edited or deleted

#### Scenario: Migration skips fail-closed without an encryption key

- **WHEN** the env SMTP is configured but no encryption key is available
- **THEN** the migration is skipped and outbound mail continues via the env fallback

