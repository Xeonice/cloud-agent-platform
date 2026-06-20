# Wire codex headless to authenticate with the ChatGPT subscription

## Why

After `fix-headless-execution-container-gaps` (v0.12.1), claude headless via MCP works end-to-end
(verified: tasks reach `completed`, transcripts readable, tool calls execute). codex headless,
however, returned `401` on every production smoke. A deep, instrumented investigation (SSH into the
sandbox, raw requests, JWT decode, a 5-agent research workflow) corrected an earlier WRONG conclusion
("codex exec has a transport bug / can't use the subscription / must fall back to interactive") and
proved the real cause:

- **codex `exec` DOES work with a ChatGPT subscription.** Proven empirically in the production image:
  with `cli_auth_credentials_store = "file"` + a fresh file-based `auth.json`, `codex exec --json …`
  returns `exit=0`, `turn.completed`, and the correct answer (`"4"`).
- The production failures had two causes, BOTH on our side:
  1. The injected `config.toml` did NOT set `cli_auth_credentials_store = "file"`. codex defaults to
     `auto` (OS keyring first); the Linux sandbox has no keyring, so codex never loaded the injected
     `~/.codex/auth.json` → `401 "Missing bearer"` (no credential attached at all).
  2. The ChatGPT `refresh_token` is SINGLE-USE / rotating. We inject a static credential snapshot every
     task and the retention trim zeroes `auth.json` on teardown, so codex's refreshed token is never
     persisted. After the first refresh the seed is revoked → `refresh_token_invalidated`. (The
     production env seed `CODEX_CHATGPT_AUTH_JSON_B64` is from 2026-06-07 and is already revoked.)

This is the exact anti-pattern OpenAI's CI/CD auth docs warn against: codex refreshes ChatGPT tokens
in place and the refreshed `auth.json` MUST be persisted for the next run.

## What Changes

- **Config (the unblock).** The codex runtime's emitted `config.toml` SHALL set
  `cli_auth_credentials_store = "file"` so codex reads the injected `~/.codex/auth.json` in the
  keyring-less sandbox. This alone turns `401 "Missing bearer"` into a loaded, correctly-routed
  credential (`codex login status` → "Logged in using ChatGPT", requests go to
  `chatgpt.com/backend-api/codex`).
- **Refresh-and-persist (durability).** `CodexAuthSource` gains a write-back path. On task teardown,
  BEFORE the `~/.codex` trim zeroes `auth.json`, the provider captures the (possibly refreshed)
  `auth.json` out of the container and persists it back to the resolving credential, so the next task
  uses the rotated token instead of a revoked seed. The credential self-heals via codex's own refresh.
- **Stored over env for programmatic codex.** Refresh-persist targets a STORED (owner-scoped, DB)
  credential; the static env fallback cannot be written back. The env seed stays bootstrap-only; a
  warning is logged if a non-persistable (env) credential is used for a headless codex task.
- **Acceptance is empirical.** Re-run the production MCP smoke (one codex task, freshly seeded
  credential): it MUST reach `completed` with a readable transcript answer.

## Impact

- **Code:** `apps/api/src/agent-runtime/codex-runtime.ts` (config.toml: add file-store line),
  `apps/api/src/sandbox/codex-auth-source.port.ts` + `prisma-codex-auth-source.ts` +
  `env-codex-auth-source.ts` (persist-back method), `apps/api/src/sandbox/aio-sandbox.provider.ts`
  (capture auth.json before the pre-stop trim + persist).
- **Specs (MODIFIED):** `aio-sandbox-execution` (codex credential injection now sets the file store +
  persists the refreshed auth.json before trim).
- **Out of scope / unchanged:** claude headless (works, separate auth); the `executionMode` routing
  (codex STAYS on `headless-exec` — NOT reverted to interactive); the v0.12.1 flag + exit-detection
  fixes (correct, kept). Compatible-provider (API-key) codex is unaffected (it uses a `model_providers`
  block, not `auth.json`).
- **Operational:** the production env codex credential must be re-seeded fresh once; thereafter
  refresh-persist keeps a stored credential alive. The retained-container security property (no live
  `auth.json` after stop) is preserved — capture happens before the trim, the trim still zeroes it.
- **Constraint:** bound by [[codex-headless-chatgpt-auth]] (the proven setup) and
  [[headless-execution-spike-findings]]; codex 0.131 stays pinned for gpt-5.5.
