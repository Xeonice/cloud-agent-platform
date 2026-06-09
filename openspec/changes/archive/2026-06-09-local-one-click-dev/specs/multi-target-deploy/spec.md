## ADDED Requirements

### Requirement: One-command local dev bring-up bootstraps a usable env
The docker-compose self-host target SHALL provide a SINGLE-COMMAND local
bring-up (e.g. `make up` / `scripts/dev-up.sh`) that makes a freshly-cloned repo
start AND be usable without hand-authoring secrets or configuring a GitHub OAuth
app. The command SHALL, when `apps/api/.env` is ABSENT, generate it from
`apps/api/.env.example` with strong random values for `SESSION_SECRET`,
`CODEX_CRED_ENC_KEY`, and `AUTH_TOKEN`, and SHALL enable the LEGACY operator-token
auth path (`AUTH_TOKEN_LEGACY_ENABLED=true`) plus set `WEB_ORIGIN` for local dev,
so a local operator can authenticate with the generated token alone (OAuth stays
optional). The command SHALL then run `docker compose up -d --build` — which also
builds the per-task sandbox image `cap-aio-sandbox:pinned` — and SHALL wait until
the api `/health` endpoint reports ready before reporting success, printing how to
authenticate (the generated token) for local use.

The bring-up SHALL be IDEMPOTENT and NON-DESTRUCTIVE to existing state: it SHALL
NOT overwrite an existing `apps/api/.env` (a real local env is reused as-is), the
generated env SHALL remain gitignored (never committed, secrets never written to a
tracked file), and re-running the command SHALL NOT recreate or wipe the Postgres
`pgdata` / `workspaces` volumes. A matching teardown command SHALL stop the stack,
and dropping the persistent volumes SHALL require an EXPLICIT opt-in flag rather
than being the default. The committed example env and the production deploy path
SHALL remain OAuth-first / fail-closed — the generated legacy-token env is for
local dev only and is not committed.

#### Scenario: Fresh clone starts and is usable with one command
- **WHEN** a contributor with no `apps/api/.env` runs the one-command local bring-up
- **THEN** the command generates `apps/api/.env` from the example with random secrets and the legacy operator-token path enabled, runs `docker compose up -d --build`, waits for the api `/health` to report ready, and prints the generated token for local authentication
- **AND** the operator can authenticate and use the api without configuring a GitHub OAuth app

#### Scenario: Existing local env is never overwritten
- **WHEN** the one-command bring-up runs and `apps/api/.env` already exists
- **THEN** it reuses the existing env unchanged and does not regenerate or overwrite it

#### Scenario: Re-running is idempotent and preserves data
- **WHEN** the one-command bring-up is run again on an already-initialized checkout
- **THEN** it does not overwrite `apps/api/.env` and does not recreate or wipe the `pgdata`/`workspaces` volumes, so existing local data survives

#### Scenario: Generated secrets are never committed
- **WHEN** the bring-up generates `apps/api/.env`
- **THEN** the generated file is gitignored and no secret value is written into any tracked/committed file

#### Scenario: Teardown requires an explicit flag to drop volumes
- **WHEN** the teardown command is run without the volume-drop opt-in flag
- **THEN** it stops and removes the containers but PRESERVES the `pgdata`/`workspaces` volumes
- **AND** the volumes are removed only when the explicit opt-in flag is passed

#### Scenario: One command builds the per-task sandbox image too
- **WHEN** the one-command bring-up completes
- **THEN** `docker compose up -d --build` has built the `cap-aio-sandbox:pinned` image (via the build-only `aio-sandbox-image` compose service) so that creating a task can provision a `cap-aio-<taskId>` sandbox without a separate manual build step
