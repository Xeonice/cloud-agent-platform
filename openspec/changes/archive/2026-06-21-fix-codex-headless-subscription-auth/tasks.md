# Tasks — fix-codex-headless-subscription-auth

## 1. Config: file-store credential (the unblock)

- [x] 1.1 In `apps/api/src/agent-runtime/codex-runtime.ts` `sandboxSetupCommands`, PREPEND a top-level
  `cli_auth_credentials_store = "file"\n` line to the emitted `config.toml` (before the
  `[projects."<ws>"]` trust table at ~:148). Emit it for the codex runtime regardless of credential kind
  (inert for the compatible/`model_providers` path).
- [x] 1.2 Golden test: `CodexRuntime.sandboxSetupCommands` (official + compatible) produces a
  `config.toml` whose decoded content contains `cli_auth_credentials_store = "file"`.

## 2. Refresh-and-persist: port + implementations

- [x] 2.1 `apps/api/src/sandbox/codex-auth-source.port.ts`: add
  `persistRefreshedAuth(taskId: string, authJson: string): Promise<void>` to the `CodexAuthSource`
  interface (doc: owner-scoped write-back of codex's refreshed official `auth.json`).
- [x] 2.2 `apps/api/src/sandbox/prisma-codex-auth-source.ts`: implement — resolve `taskId` → owner (SAME
  resolution as `getCodexAuth`); if the owner's credential is OFFICIAL (ChatGPT), re-encrypt (CODEX_CRED_ENC_KEY)
  + UPDATE the `CodexCredential` row's stored `auth.json` blob; if COMPATIBLE (API-key) → no-op. Never
  cross-owner.
- [x] 2.3 `apps/api/src/sandbox/env-codex-auth-source.ts`: implement `persistRefreshedAuth` as a no-op +
  one `logger.warn` (env seed cannot self-heal; must be re-seeded).
- [x] 2.4 Update any other `CodexAuthSource` implementers + test fakes to satisfy the new method.

## 3. Provider: capture auth.json before the pre-stop trim

- [x] 3.1 In `apps/api/src/sandbox/aio-sandbox.provider.ts` teardown, BEFORE running
  `preStopTrimCommands()`, and ONLY for a `headless-exec` codex task with an OFFICIAL credential: read
  `/home/gem/.codex/auth.json` from the container via `/v1/shell/exec` `cat` (unwrap the live `data`-nested
  response the same way `exitCodeFromExecBody` does), then call `codexAuthSource.persistRefreshedAuth(taskId, authJson)`.
- [x] 3.2 Guard the capture: only persist when the read content is non-empty and JSON-parseable with a
  `tokens.refresh_token` (skip a zeroed/garbage file so a capture-vs-trim race never overwrites a good
  stored credential). The pre-stop trim still zeroes `auth.json` AFTER capture (retained-container
  security preserved). Capture must NOT run for interactive / claude / compatible tasks.

## 4. Tests

- [x] 4.1 `persistRefreshedAuth`: prisma impl UPDATEs an official credential row; no-ops a compatible
  credential; env impl warns. Owner-scoping enforced (a task cannot write another owner's credential).
- [x] 4.2 Capture guard: an empty / non-parseable / refresh_token-less `auth.json` is NOT persisted.
- [x] 4.3 Characterization: the interactive/console + claude + compatible-provider paths are unchanged —
  config.toml still valid for them, and the capture step does NOT run for them.

## 5. Verify (empirical — the real gate)

- [x] 5.1 `pnpm --filter @cap/api typecheck` green; full `test` suite green.
- [ ] 5.2 **Re-seed a fresh stored codex credential** (ops) then **re-run the production MCP smoke**: one
  codex task via MCP `create_task` MUST reach `completed` with a readable transcript answer (matching the
  manual single-run proof: `exit=0`, `turn.completed`, correct answer). Confirm a SECOND codex task also
  succeeds (proving refresh-persist carried the rotated token across tasks).
- [ ] 5.3 Update `docs/external-api-mcp-epic.md` / `docs/codex-*` note: codex headless + ChatGPT
  subscription requires `cli_auth_credentials_store="file"` + refresh-persist (at archive time).
