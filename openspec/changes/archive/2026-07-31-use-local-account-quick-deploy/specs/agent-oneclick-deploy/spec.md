## ADDED Requirements

### Requirement: No GitHub OAuth required via synthesized local-account env

The script SHALL boot the prebuilt images WITHOUT a GitHub OAuth app by synthesizing or updating a local-account `.env` next to the compose file. The `.env` SHALL include `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PASSWORD_AUTH_ENABLED=true`, strong `SESSION_SECRET`, strong `CODEX_CRED_ENC_KEY`, `CAP_VERSION`, and the selected sandbox provider. The script SHALL set `AUTH_TOKEN_LEGACY_ENABLED=false` for this install path so a leftover `AUTH_TOKEN` is not an active console login credential. The synthesis SHALL be IDEMPOTENT and NON-DESTRUCTIVE for secrets: existing local-account credentials and secrets SHALL be reused, missing credentials and secrets SHALL be generated, and the generated file SHALL remain gitignored so no secret is written to a tracked file.

#### Scenario: Prebuilt image boots without OAuth or legacy bearer login

- **WHEN** the script synthesizes the `.env` and brings up the stack
- **THEN** the prebuilt api boots with password login enabled
- **AND** operators authenticate through the local admin account rather than a legacy bearer token
- **AND** no GitHub OAuth app is required

#### Scenario: Existing local-account env is reused

- **WHEN** the script runs and a `.env` already contains `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, or `CODEX_CRED_ENC_KEY`
- **THEN** it reuses those values rather than regenerating them
- **AND** it updates operational pins such as `CAP_VERSION`, selected provider, and `AUTH_TOKEN_LEGACY_ENABLED=false`

#### Scenario: Generated secrets are not tracked

- **WHEN** the script generates the `.env`
- **THEN** the file is gitignored and no secret value is written into any tracked file

### Requirement: Positioned as local-account self-host, with legacy bearer kept dev-only

The script and its documentation SHALL make explicit that this path uses local account login for the release-image self-host path. It SHALL preserve the host-root-equivalent disclosure because the AIO path mounts the host `docker.sock`, and it SHALL state the localhost-only caveat for the prebuilt `cap-web` because its `VITE_*` values are baked to localhost at build time. The legacy shared bearer token path SHALL remain documented only as a dev-only or break-glass option outside the quick-deploy login flow.

#### Scenario: Positioning and caveats are disclosed

- **WHEN** a user reads the script header or the self-hosting documentation for this path
- **THEN** it states this path uses local admin email/password login
- **AND** it states the path is host-root-equivalent via `docker.sock`
- **AND** it states the prebuilt `cap-web` console is localhost-only
- **AND** it does not present a shared legacy bearer token as the release-image console login credential

## MODIFIED Requirements

### Requirement: Health verification and credential surfacing

After bringing up the stack the script SHALL wait until the api `/health` reports ready within a bounded timeout and SHALL print the admin email/password to use, along with the api and (when the web profile is enabled) web URLs and the teardown command. The script SHALL verify the printed credentials by posting to `/auth/password` after `/health` succeeds and SHALL surface whether the credential check passed. If credential verification fails because the admin already existed and has a different current password, the script SHALL warn clearly rather than claiming the printed password is definitely valid. The printed teardown command SHALL be correct for the profiles that were brought up: when the web console was started (the `web` profile), the teardown hint SHALL include the `web` profile so it actually removes the profile-gated `cap-web` (a bare `docker compose down` leaves it running). If `/health` does not become ready within the bound, the script SHALL fail loudly and point at the api logs.

#### Scenario: Healthy bring-up surfaces local admin credentials

- **WHEN** the stack starts and the api becomes healthy
- **THEN** the script prints the admin email/password and the api URL
- **AND** it reports whether `/auth/password` accepted the printed credential
- **AND** it does not print `Authorization: Bearer` as the console login credential

#### Scenario: Existing admin password mismatch is disclosed

- **WHEN** the stack starts with an existing admin whose current password differs from the `.env` `ADMIN_PASSWORD`
- **THEN** the credential check reports a non-200 result
- **AND** the script warns that the operator should use the current admin password

#### Scenario: Teardown hint matches the started profiles

- **WHEN** the bring-up started the web console (web profile enabled)
- **THEN** the printed teardown command includes the `web` profile so running it removes `cap-web` as well as the api/postgres, leaving no orphaned profile-gated container

#### Scenario: Unhealthy bring-up fails loudly

- **WHEN** the api does not report `/health` ready within the timeout
- **THEN** the script exits non-zero with a message pointing at the api logs

### Requirement: Optional provision smoke

The script SHALL support an opt-in provision smoke that creates a throwaway task, confirms the per-task sandbox provisions (the task reaches a running state), then stops it, mirroring `scripts/upgrade.sh`'s provision smoke rather than reimplementing a separate auth model. Because the seeded admin must complete a first-login password change before protected task actions are allowed, the smoke SHALL authenticate with a supplied post-first-login session cookie (`CAP_SMOKE_COOKIE`) and repo id (`CAP_SMOKE_REPO_ID`). When the smoke cannot run (no session cookie / repo available) it SHALL be skipped with a warning rather than failing the bring-up.

#### Scenario: Smoke confirms sandbox provisioning when enabled

- **WHEN** the smoke is enabled and `CAP_SMOKE_COOKIE` plus `CAP_SMOKE_REPO_ID` are available
- **THEN** the script creates a task using the session cookie, confirms it provisions a sandbox, and stops it

#### Scenario: Smoke skipped without prerequisites

- **WHEN** the smoke is enabled but no session cookie or repo id is available
- **THEN** the smoke is skipped with a warning and the bring-up still succeeds

## REMOVED Requirements

### Requirement: No GitHub OAuth required via synthesized legacy-token env

**Reason**: The release-image quick-deploy path now follows the self-hosting local-account model instead of creating a shared legacy bearer login credential.

**Migration**: Use `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `PASSWORD_AUTH_ENABLED=true` for quick-deploy-managed `.env` files. Keep legacy bearer only for explicitly enabled dev-only or break-glass operation.

### Requirement: Positioned as legacy-token self-host, not local-account production

**Reason**: The one-line release-image path is now a local-account self-host path. It should no longer describe itself as legacy-token auth.

**Migration**: Read the local-account quick-deploy output for admin email/password. Use the optional dev-only legacy token documentation only when deliberately enabling `AUTH_TOKEN_LEGACY_ENABLED=true`.
