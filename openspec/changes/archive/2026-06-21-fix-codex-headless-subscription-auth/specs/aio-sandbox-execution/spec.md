## ADDED Requirements

### Requirement: Codex headless tasks load a file-stored credential and persist its refresh
A `headless-exec` codex task SHALL authenticate with the task's resolved codex credential via the SAME
injection path as the interactive runtime, plus two additions REQUIRED to make a non-interactive
`codex exec` run succeed against a ChatGPT-account (subscription) credential in the keyring-less Linux
sandbox: a file-store config line, and refresh-persistence of the rotating token.

The codex runtime's emitted `config.toml` SHALL set top-level `cli_auth_credentials_store = "file"` so
codex loads the injected `~/.codex/auth.json`. Without it codex defaults to `auto` (OS keyring first),
finds no keyring in the sandbox, attaches NO bearer, and every request fails `401 "Missing bearer"`.
This line SHALL be emitted for the codex runtime regardless of credential kind (it is inert for the
compatible/`model_providers` path, which carries no `auth.json`).

For a headless codex task using an OFFICIAL (ChatGPT) credential, the system SHALL capture codex's
post-run `~/.codex/auth.json` out of the container BEFORE the pre-stop `~/.codex` trim zeroes it, and
persist the (possibly refreshed) `auth.json` back to the OWNER-SCOPED stored credential. ChatGPT
`refresh_token`s are single-use/rotating; codex refreshes in place and rewrites `auth.json`, so a static
re-injected seed is revoked after first use unless the rotation is persisted. The persist SHALL be
owner-scoped (a task can write only its own owner's credential) and SHALL skip a non-parseable or empty
`auth.json` (never overwrite a good stored credential with garbage or an already-zeroed file). The
pre-stop trim SHALL still zero `auth.json` AFTER capture, so a retained container holds no live
credential. A credential that cannot be persisted back (the env fallback) used for a headless codex
task SHALL log a warning that it cannot self-heal and must be re-seeded manually.

#### Scenario: Codex headless loads the file-stored credential (no "Missing bearer")
- **WHEN** a headless-exec codex task provisions with an official ChatGPT credential
- **THEN** the emitted `config.toml` sets `cli_auth_credentials_store = "file"`, codex loads
  `~/.codex/auth.json`, and `codex exec` attaches the bearer and routes to `chatgpt.com/backend-api/codex`
  rather than failing `401 "Missing bearer"`

#### Scenario: A refreshed token is persisted across tasks
- **WHEN** codex refreshes its ChatGPT token during a headless task run (rotating the single-use refresh_token)
- **THEN** the post-run `auth.json` is captured before the pre-stop trim and written back to the owner's
  stored credential, so the next task uses the rotated token instead of a revoked seed

#### Scenario: Capture preserves the retained-container security property
- **WHEN** a headless codex task tears down
- **THEN** `auth.json` is captured-then-zeroed (trim still runs after capture), so the retained container
  holds no live credential

#### Scenario: A non-persistable (env) credential warns
- **WHEN** a headless codex task uses the env-fallback credential (which cannot be written back)
- **THEN** a warning is logged that the credential cannot self-heal and must be re-seeded; the task still
  runs with the seed as-is
