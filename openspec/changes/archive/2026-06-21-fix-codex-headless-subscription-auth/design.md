# Design — fix-codex-headless-subscription-auth

## Context

Empirically proven (production image, single clean run): `codex exec` authenticates with a ChatGPT
subscription when (a) the injected `config.toml` sets `cli_auth_credentials_store = "file"` and (b) the
`auth.json` carries a fresh, unused `refresh_token`. The two production gaps map to two fixes — a config
line and a refresh-persist loop. codex STAYS on `headless-exec` (do NOT revert to interactive). claude
is unaffected (separate baked auth). Compatible-provider (API-key) codex is unaffected (no `auth.json`).

## D1 — `cli_auth_credentials_store = "file"` in the emitted config.toml (the unblock)

`CodexRuntime.sandboxSetupCommands` builds `config.toml` from a trust table
(codex-runtime.ts:148 — `[projects."<ws>"]\ntrust_level = "trusted"`). The Linux sandbox has no OS
keyring, but codex defaults to `cli_auth_credentials_store = "auto"` (keyring-first) → it never loads
the injected file `auth.json` → `401 "Missing bearer"`. Fix: PREPEND a top-level
`cli_auth_credentials_store = "file"` line to `config.toml` for the codex runtime, ALWAYS (it is
harmless for the compatible/`model_providers` path, which carries no `auth.json`). This is the minimal
change that makes codex load the credential and route to `chatgpt.com/backend-api/codex` correctly.

## D2 — refresh-and-persist: write codex's refreshed auth.json back to the store

ChatGPT `refresh_token`s are SINGLE-USE/rotating. codex refreshes in place (>~8 days, or a 401-retry)
and rewrites `~/.codex/auth.json`. Our model re-injects a STATIC seed every task and the pre-stop trim
zeroes `auth.json`, so the rotation is discarded → the seed is revoked after first use. Fix: persist
codex's post-run `auth.json` back to the resolving credential.

- **Port:** `CodexAuthSource` (codex-auth-source.port.ts) gains
  `persistRefreshedAuth(taskId: string, authJson: string): Promise<void>`.
- **prisma impl:** for an OFFICIAL (ChatGPT) credential, re-encrypt + UPDATE the owner-scoped
  `CodexCredential` row's stored `auth.json` blob. For COMPATIBLE (API-key) material → no-op (it never
  refreshes). Keyed by `taskId` → owner → credential row (the SAME owner-scoped resolution as
  `getCodexAuth`, so a task can only persist into its own owner's credential — no cross-owner write).
- **env impl** (`EnvCodexAuthSource`): no-op + a one-line WARN that the env seed cannot self-heal and
  must be re-seeded manually. (The env fallback is bootstrap-only; sustained programmatic codex needs a
  stored credential.)

## D3 — capture timing: BEFORE the pre-stop trim, preserve the retained-container security property

The provider's teardown runs `preStopTrimCommands()` which zeroes `auth.json` (D4 of the retention
design — a kept container must hold no live credential). The persist step is inserted in teardown
strictly BEFORE the trim:

  resolve task → **capture `~/.codex/auth.json` from the container → `persistRefreshedAuth`** →
  `preStopTrimCommands` (zero auth.json) → stop container.

The trim still zeroes the file after capture, so the retained container holds no live `auth.json` —
the security property is unchanged. Capture only runs for codex `headless-exec` tasks with an OFFICIAL
credential; interactive/claude/compatible are untouched.

## D4 — reading auth.json out of the container

Read via the AIO `/v1/shell/exec` `cat /home/gem/.codex/auth.json` (or `docker exec` cat). The live AIO
exec response NESTS its result under `data` (`{data:{output,...}}`) — reuse the SAME `data ?? top`
unwrap the exit-code reader already uses (see `exitCodeFromExecBody`), so the captured JSON is read off
the right field. Guard: only persist if the captured content is a non-empty, JSON-parseable `auth.json`
with `tokens.refresh_token` (else skip — never overwrite a good stored credential with garbage or an
already-zeroed file if capture races the trim).

## D5 — concurrency caveat (documented, not solved here)

A ChatGPT credential is single-account; two concurrent headless codex tasks for the SAME owner both
refresh → `refresh_token` rotation races (one rotation invalidates the other's). Last-write-wins on
persist; the loser's next run hits a 401 and codex's built-in 401-retry-refresh recovers IF the stored
token is current. True fix (per-task credential leasing / serialization) is out of scope; this change
makes the common (sequential) case self-heal and logs when a refresh-persist write is superseded.

## D6 — what stays untouched (regression surface)

- `executionMode` routing: codex remains `headless-exec`; NOT reverted to interactive.
- v0.12.1 fixes (codex exec argv `--dangerously-bypass-approvals-and-sandbox`, the `< /dev/null`, the
  exit-code sentinel) — all correct, kept.
- claude auth (baked Claude CLI), the compatible-provider `model_providers` path, the transcript
  read/parse, the interactive/console launch path.

## Risks

- **Re-seed required.** The fix is inert until the stored codex credential is seeded fresh once (the env
  seed from 2026-06-07 is revoked). Verification (V) gates on a freshly-seeded credential.
- **Capture vs trim race.** Mitigated by D4's parse-guard (skip persisting an empty/garbage file).
