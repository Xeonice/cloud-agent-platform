<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.

     PARTITION CORRECTION (file-touch scan):
     - The draft `lock-down-applied-fixes` track (old #1) is DISSOLVED. Its six tasks are all
       ASSERTIONS against artifacts that other tracks MUTATE, so none can run in parallel with
       the track that owns the artifact:
         * 1.1/1.2/1.6 assert the `docker/aio-sandbox.Dockerfile` / built-image contract that
           codex-version (2.x) and hooks-0131-adapter (6.3) rewrite  -> integration (after both).
         * 1.3/1.4 assert the `docker-compose.yml` contract that deploy-config (5.x) rewrites
           -> integration (after deploy-config).
         * 1.5 is a CPR unit test against `apps/api/src/terminal/aio-pty-client.ts`, which
           reconnect-restore (4.1) edits -> integration (after reconnect-restore).
     - hooks-0131-adapter task 6.3 writes `docker/aio-sandbox.Dockerfile` (shared with
       codex-version 2.x) -> integration. Tasks 6.5 (live-fire GATE) and 6.6 (fallback, which
       touches the provider/gateway boundary owned by clone-fix + reconnect-restore) -> integration.
     - Remaining parallel tracks touch DISJOINT files:
         codex-version          -> docker/aio-sandbox.Dockerfile (+ matrix doc)
         clone-fix              -> apps/api/src/sandbox/aio-sandbox.provider.ts (+ .test.mjs)
         reconnect-restore      -> apps/api/src/terminal/{aio-pty-client,terminal.gateway,snapshot}.ts
         deploy-config          -> docker-compose.yml (+ open-question note)
         hooks-0131-adapter     -> apps/sandbox-hooks/hooks.json + apps/sandbox-hooks/src/hooks/**
       (hooks-0131-adapter still `depends: codex-version`: the 0.131 protocol only applies once
        the image bakes 0.131; codex-version owns the Dockerfile bump.) -->

## 1. Track: codex-version (depends: none)

<!-- D7: edits only docker/aio-sandbox.Dockerfile + a model-matrix doc. Sole draft-track owner of
     the Dockerfile. Disjoint from all source/compose tracks. -->

- [x] 1.1 Change `docker/aio-sandbox.Dockerfile` to install codex from a documented `CODEX_VERSION` build-arg (default `0.131`), replacing the hard-coded `0.42.0` pin; ensure the version is overridable at build time.
- [x] 1.2 Document the codex-version ↔ ChatGPT-account-model compatibility matrix (0.42.0 400s on gpt-5/gpt-5-codex/o4-mini and is rejected by gpt-5.5; 0.131.0 + gpt-5.5 = verified working) next to the Dockerfile so the next operator does not rediscover it by trial.
- [x] 1.3 Verify the derived image build picks up the `CODEX_VERSION` build-arg and bakes codex `0.131` (and confirm the BREAKING frame-stream change is acknowledged in the doc), satisfying aio-sandbox-execution "Derived image bakes a compatible pinned codex".

## 2. Track: clone-fix (depends: none)

<!-- D10: edits only apps/api/src/sandbox/aio-sandbox.provider.ts (+ aio-sandbox.provider.test.mjs). -->

- [x] 2.1 Change `AioSandboxProvider.provision()` to clone the task repository into a DEDICATED, EMPTY workspace directory (e.g. `/home/gem/workspace`) via `POST /v1/shell/exec`, never into the non-empty `/home/gem` HOME.
- [x] 2.2 Parse the `/v1/shell/exec` response body and treat a non-zero clone command `exit_code` (scoped to the clone's own exit code, not a trailing `| head` pipe and not merely a non-`ok` HTTP status) as a provisioning failure, raising a real error with the command `output` and never logging "cloned task repository" on a silent failure.
- [x] 2.3 Verify provisioning: a successful clone into the empty workspace dir returns the addressable `SandboxConnection` handle, and an induced clone failure (e.g. non-empty dir) raises a provision error — satisfying aio-sandbox-execution "Clone failure surfaces a provision error instead of silent success".

## 3. Track: reconnect-restore (depends: none)

<!-- D9: edits apps/api/src/terminal/aio-pty-client.ts, terminal.gateway.ts (NullHeadlessTerminal
     is DEFINED + instantiated here, not in snapshot.ts), snapshot.ts (HeadlessTerminal interface)
     — a self-contained terminal-bridge cluster, disjoint from sandbox/docker/compose. -->

- [x] 3.1 In the orchestrator bridge (`aio-pty-client.ts` / `terminal.gateway.ts`), append raw PTY `output` to `workspaces/<taskId>/session.log` as it is received, keeping the byte-offset fed to `snapshots.feed` in lockstep with the bytes written to the file (single code path so the snapshot boundary and tail align).
- [x] 3.2 Replace the `NullHeadlessTerminal` backing `SnapshotManager` (defined in `terminal.gateway.ts`; interface in `snapshot.ts`) with a REAL xterm headless terminal whose `serialize()` (via SerializeAddon, recording cols/rows) returns the actual visible frame, so periodic snapshots are non-empty.
- [x] 3.3 Verify reconnect replay: a reconnecting operator receives a NON-EMPTY snapshot from the real headless terminal followed by the tail of `workspaces/<id>/session.log` appended after the snapshot, and `buildReconnectFrames` returns prior output rather than nothing (ref realtime-terminal "Reconnect replays prior output under connect-in").

## 4. Track: deploy-config (depends: none)

<!-- Compose env passthrough + session.log volume; edits docker-compose.yml (and the open
     question note). Disjoint from the api source and Dockerfile tracks. -->

- [x] 4.1 Add `MAX_CONCURRENT_TASKS` and `TASK_REPO_URL` passthrough to the compose `api` service environment, and add a test/assertion confirming both reach the orchestrator process (ref multi-target-deploy "Concurrency and repo-URL env are passed through to the api").
- [x] 4.2 Confirm `docker-compose.yml` mounts a named volume backing the `workspaces` path that holds `session.log` so it survives an orchestrator restart, satisfying multi-target-deploy "Persistent volume for session.log survives restart" at the path the orchestrator bridge writes.
- [x] 4.3 Capture the per-task `TASK_REPO_URL` open question as a documented follow-up (global compose env is wrong for per-task semantics; record that the per-task source of record is unresolved here), so the global env is not mistaken for the intended design.

## 5. Track: hooks-0131-adapter (depends: codex-version)

<!-- D8 / #1b: the riskiest item. Parallel-safe slice edits apps/sandbox-hooks/hooks.json +
     apps/sandbox-hooks/src/hooks/** ONLY. Depends on codex-version because the 0.131 protocol only
     applies once the image bakes 0.131.
     MOVED TO INTEGRATION: 6.3 (writes docker/aio-sandbox.Dockerfile — shared with codex-version),
     6.5 (live-fire GATE), 6.6 (fallback — touches the provider/gateway boundary owned by clone-fix
     + reconnect-restore). See integration track. -->

- [x] 5.1 Rewrite the baked `apps/sandbox-hooks/hooks.json` from cap's prior `{blocking, command:[array]}` form to the codex `0.131` format `{matcher:<regex>, hooks:[{type:"command", command:<string>, timeout?}]}`.
- [x] 5.2 Rewrite the hook entry script (`apps/sandbox-hooks/src/**`) to read the `0.131` stdin schema (`{session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id, tool_name, tool_use_id, tool_input}`), translate it to cap's existing `permission_request` frame, perform the existing `POST /v1/approvals` round-trip (cap-side routing unchanged), and emit the `0.131` decision (`{hookSpecificOutput:{hookEventName, permissionDecision:"allow"|"deny", permissionDecisionReason?}}`, or exit `0` allow / exit `2` + stderr deny).
- [x] 5.3 Add a unit-level test that the adapter, given a `0.131` stdin payload, parses it (including `tool_name`/`tool_input`), produces the cap `permission_request` frame, and emits the correct `0.131` decision form — proving the adapter contract independent of codex firing.

## 6. Track: integration (depends: codex-version, clone-fix, reconnect-restore, deploy-config, hooks-0131-adapter)

<!-- Runs SERIALLY after all parallel tracks. Every task here either writes a file a draft track
     already owns (shared file) or asserts a contract a draft track mutated, so it must follow the
     owning track to observe the final state. Sub-ordering within this track:
       1) Dockerfile-final edits (6.1) before the build/image assertions (6.2/6.3/6.7).
       2) compose assertions (6.4/6.5) after deploy-config.
       3) CPR unit test (6.6) after reconnect-restore's aio-pty-client.ts edit.
       4) live-fire GATE (6.8) then conditional fallback (6.9). -->

- [x] 6.1 Launch codex with `--full-auto` (keeps hooks; `-s`/bypass-approvals disable them) and trust the baked hook via config.toml `[hooks.state] trusted_hash` or `--dangerously-bypass-hook-trust`, in the derived image / launch path (`docker/aio-sandbox.Dockerfile` — shared with codex-version; lands after the 0.131 bump and the hooks.json rewrite). [was 6.3]
- [x] 6.2 Add a CI/build smoke check that the derived runner Dockerfile builds successfully on pnpm 10 and does NOT invoke `pnpm --filter X prune --prod` (D1); fail the check if a filtered prune is reintroduced (ref multi-target-deploy "Compose self-host image builds without a filtered prune"). Asserts the final Dockerfile after codex-version + 6.1. [was 1.1]
- [x] 6.3 Add a hook resolution smoke test that `import zod` and `@cap/contracts` resolve from the compiled `dist/hooks` inside the built image with no `ERR_MODULE_NOT_FOUND` (D6: the `/repo` workspace COPY + stable `/opt/cap/dist` symlink farm resolves). Asserts the final built image. [was 1.2]
- [x] 6.4 Add an image-content assertion that `hooks.json` is present at the gem HOME (`/home/gem/.codex/hooks.json`) and owned `1000:1000` (D5: codex runs as `gem`, HOME=`/home/gem`). Asserts the final image after the hooks.json rewrite (5.1). [was 1.6]
- [x] 6.5 Add a compose assertion that the `api` service reaches Postgres AND a `cap-net` sandbox (D2: api on BOTH default + cap-net; postgres default-only; sandboxes cap-net-only) — assert no P1001. Asserts the `docker-compose.yml` contract after deploy-config. [was 1.3]
- [x] 6.6 Add a compose assertion that a DooD `docker` call from the `api` service succeeds with no EACCES because `api` runs `user: root` and can read root-owned `/var/run/docker.sock` (D3). Asserts the `docker-compose.yml` contract after deploy-config. [was 1.4]
- [x] 6.7 Add a unit test asserting the CPR detector matches the exact codex byte sequence `\x1b[6n` (hex `1b 5b 36 6e`), NOT `\x1b[?6n`, and injects the CPR reply (D4). Tests `apps/api/src/terminal/aio-pty-client.ts` after reconnect-restore's edit (3.1). [was 1.5]
- [x] 6.8 GATE — Live fire-test RUN against a real gpt-5.5 ChatGPT account: codex `0.131`'s `PreToolUse` hook does NOT fire, even with `--full-auto` + `--dangerously-bypass-hook-trust` + matcher `.*` (codex#16732 confirmed). This is a VERIFIED-not-firing outcome (not a build-green fabrication). The approval-via-codex-hook scenario is therefore NOT satisfied → the cap-controlled FALLBACK (6.9 `AioApprovalEnforcer`) is the actual approval path. [was 6.5]
  <!-- The live fire-test has now been RUN (real gpt-5.5 account, this session):
       the PreToolUse hook does NOT fire. Per the gate's rule this records a
       verified-NOT-firing outcome — the codex-hook approval scenario stays
       UNSATISFIED and the cap-controlled FALLBACK (6.9, AioApprovalEnforcer) is
       the enforcement path. The fire-test also caught a 6.1 regression: the baked
       config.toml `[hooks.state]` flat `trusted_hash` crashed codex startup
       ("invalid type: string, expected struct HookStateToml"); it was removed
       from the Dockerfile — codex now starts clean with
       `--full-auto --dangerously-bypass-hook-trust` (verified: codex replied
       STARTOK). -->
- [x] 6.9 If the fire-test (6.8) shows hooks remain unreliable, activate a cap-controlled FALLBACK enforcement layer (candidate: interception at the orchestrator–sandbox boundary cap owns — `/v1/shell/exec` + `cap-net`, i.e. `apps/api/src/sandbox/aio-sandbox.provider.ts` / `terminal.gateway.ts`) so approval never depends solely on codex firing the hook, and the gated tool call does not proceed without a decision (ref agent-events-and-approvals "Fallback enforces approval when codex hooks are unreliable"). Document the fallback's tool-surface coverage vs. gaps. [was 6.6]
