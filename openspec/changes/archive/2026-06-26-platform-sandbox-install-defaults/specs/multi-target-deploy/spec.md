## MODIFIED Requirements

### Requirement: One-command local dev bring-up bootstraps a usable env

The docker-compose self-host target SHALL provide a single-command local bring-up (e.g. `make up` / `scripts/dev-up.sh`) that makes a freshly-cloned repo start and be usable without hand-authoring secrets or configuring a GitHub OAuth app. The command SHALL, when `apps/api/.env` is absent, generate it from `apps/api/.env.example` with strong random values for `SESSION_SECRET`, `CODEX_CRED_ENC_KEY`, and `AUTH_TOKEN`, and SHALL enable the legacy operator-token auth path (`AUTH_TOKEN_LEGACY_ENABLED=true`) plus set `WEB_ORIGIN` for local dev, so a local operator can authenticate with the generated token alone (OAuth stays optional).

The command SHALL select the default sandbox backend by host OS unless explicitly overridden: macOS defaults to a BoxLite-backed sandbox path, Linux defaults to the existing AIO-backed sandbox path, and control-plane-only remains an explicit mode rather than the macOS default. The selected provider mode SHALL be surfaced in script output and encoded in generated local configuration without overwriting existing operator-supplied env values. The command SHALL wait until the api `/health` endpoint reports ready before reporting success, printing how to authenticate (the generated token) for local use.

The bring-up SHALL be idempotent and non-destructive to existing state: it SHALL NOT overwrite an existing `apps/api/.env` (a real local env is reused as-is), the generated env SHALL remain gitignored (never committed, secrets never written to a tracked file), and re-running the command SHALL NOT recreate or wipe the Postgres `pgdata` / `workspaces` volumes. A matching teardown command SHALL stop the stack, and dropping the persistent volumes SHALL require an explicit opt-in flag rather than being the default. The committed example env and the production deploy path SHALL remain OAuth-first / fail-closed — the generated legacy-token env is for local dev only and is not committed.

#### Scenario: Fresh macOS clone starts with BoxLite by default

- **WHEN** a contributor on macOS with no `apps/api/.env` runs the one-command local bring-up
- **THEN** the command generates `apps/api/.env` from the example with random secrets and the legacy operator-token path enabled
- **AND** it configures and verifies the BoxLite sandbox provider as the default eligible provider before reporting success

#### Scenario: Fresh Linux clone starts with AIO by default

- **WHEN** a contributor on Linux with no `apps/api/.env` runs the one-command local bring-up
- **THEN** the command generates `apps/api/.env` from the example with random secrets and the legacy operator-token path enabled
- **AND** it runs the existing AIO full-stack bring-up, including the AIO sandbox image build/staging path

#### Scenario: Existing local env is never overwritten

- **WHEN** the one-command bring-up runs and `apps/api/.env` already exists
- **THEN** it reuses the existing env unchanged and does not regenerate or overwrite it
- **AND** if the existing env pins a provider, the script reports that the existing provider config is being honored

#### Scenario: Re-running is idempotent and preserves data

- **WHEN** the one-command bring-up is run again on an already-initialized checkout
- **THEN** it does not overwrite `apps/api/.env` and does not recreate or wipe the `pgdata`/`workspaces` volumes, so existing local data survives

#### Scenario: Generated secrets are never committed

- **WHEN** the bring-up generates `apps/api/.env`
- **THEN** the generated file is gitignored and no secret value is written into any tracked/committed file

#### Scenario: Teardown requires an explicit flag to drop volumes

- **WHEN** the teardown command is run without the volume-drop opt-in flag
- **THEN** it stops the stack while preserving the `pgdata`/`workspaces` volumes

## ADDED Requirements

### Requirement: Local startup exposes api and web on all host interfaces by default

The docker-compose self-host startup path SHALL make api and web host binding explicit and default those user-facing services to `0.0.0.0`. Operators SHALL be able to override the bind address to loopback or another interface through env without editing compose files. Health probes MAY use loopback locally, but output and docs SHALL distinguish local probe URLs from the actual host bind behavior. Security-sensitive observability services that are intentionally loopback-only SHALL remain loopback-only unless their own specification is changed.

#### Scenario: Compose renders all-interface api binding by default

- **WHEN** the local compose config is rendered without host-bind overrides
- **THEN** the api host port is bound on `0.0.0.0`

#### Scenario: Compose renders all-interface web binding by default

- **WHEN** the optional web profile is enabled without host-bind overrides
- **THEN** the web host port is bound on `0.0.0.0`

#### Scenario: Operator can force loopback binding

- **WHEN** the operator sets the documented api or web host-bind env to `127.0.0.1`
- **THEN** compose renders that service as loopback-bound without code changes

#### Scenario: Public networking remains operator-owned

- **WHEN** local startup prints its completion summary
- **THEN** it states that DNS, TLS, reverse proxy, OAuth callback URL, cookie scope, and firewall/public exposure are not configured by the startup script
