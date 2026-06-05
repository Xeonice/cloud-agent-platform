## Context

The `migrate-execution-to-aio-sandbox` change introduced the connect-in AIO execution layer
(orchestrator drives a separate AIO Sandbox container over HTTP + a PTY WebSocket bridge,
rather than the deleted in-container runner producer). `pnpm verify` reported build-green and
the migration looked complete. But a hands-on end-to-end pass against a **live compose stack**,
**real codex 0.131**, and the **operator's ChatGPT credentials** (model `gpt-5.5`) exposed
**10 verified defects** that the build-green signal entirely masked. Build-green proved nothing
about runtime: image build vs. runtime HOME, HTTP `res.ok` vs. command `exit_code`, a
`NullHeadlessTerminal` that compiles but serializes nothing, and a codex hook protocol that the
type checker never exercises.

This change hardens that layer so the migrated path actually works against a real account and a
reconnecting operator. It does **not** re-architect the connect-in model — the cap-side
approval path (hook bundle → `POST /v1/approvals` → operator allow/deny/fail-closed),
WS-close exit detection, deadline `forceFail`, and 2-running-1-queued concurrency were all
**proven working** in the live pass and are regression guards, not work items.

**Dependency:** `harden-aio-execution` DEPENDS ON `migrate-execution-to-aio-sandbox` being
**archived first** — its specs MODIFY the `aio-sandbox-execution` capability that `migrate`
ADDs (still unarchived). All four touched capabilities (`aio-sandbox-execution`,
`realtime-terminal`, `agent-events-and-approvals`, `multi-target-deploy`) are MODIFIED, not new.

The defects split into three classes:
- **D1–D6** — already fixed in the working tree; this change CONFIRMS + locks them down with
  specs/tests so build-green can no longer mask a regression.
- **D7, D9, D10 + config gap** — P0 runtime correctness fixes that are independent and
  mechanically well-understood.
- **D8 / #1b** — the largest, riskiest item: re-cast the blocking approval hook onto the codex
  0.131 hook protocol, WITH an explicit firing risk (codex#16732) that forces a fallback.

## Goals / Non-Goals

**Goals:**
- Lock down D1–D6 with specs + tests so the build-green gap that masked them cannot recur.
- Make codex usable against a real ChatGPT account by bumping the version pin and documenting
  the codex-version ↔ account-model compatibility matrix (D7).
- Restore real reconnect under connect-in: persist `session.log` in the orchestrator bridge and
  back snapshots with a real headless xterm so a reconnecting operator replays prior output (D9).
- Make provisioning honest: clone into an empty workspace dir and surface a real error on clone
  failure by parsing `exit_code`/`output`, not HTTP `res.ok` (D10).
- Re-cast the blocking approval hook onto the codex 0.131 protocol (format + stdin/stdout +
  `--full-auto` + trust), **gated behind live verification**, with a documented fallback if
  codex hooks remain unreliable (D8 / #1b).
- Confirm compose env passthrough (`MAX_CONCURRENT_TASKS`, `TASK_REPO_URL`) and capture the
  per-task-repo-URL open question.

**Non-Goals:**
- Re-architecting the connect-in model or the orchestrator approvals endpoint / `onPermissionRequest`
  / `onDecision` routing — those are unchanged and proven (#1a).
- Asserting "codex fires the PreToolUse hook" as already-true — it did not fire in live tests; a
  spec scenario must NOT encode that as a passing guarantee.
- Resolving per-task repo URL sourcing in this change — captured as an open question only.
- Changing the host-root-equivalent threat model (D3 `user: root` is consistent with it).
- Restoring the deleted in-container runner producer.

## Decisions

### D1–D6 — confirm + lock down the already-applied fixes (P1, low risk)

These are already fixed in the working tree; the decision is to ADD specs + tests so the
build-green signal can never again mask their absence. The root cause class was identical
across all six: **build-time correctness ≠ runtime correctness**.

| Fix | Decision | Test that locks it |
| --- | --- | --- |
| D1 | Derived Dockerfile no longer runs `pnpm --filter X prune --prod` (pnpm 10 rejects `--recursive`); prune removed. | Image build step in CI (build must succeed on pnpm 10). |
| D2 | compose `api` joins BOTH `default` + `cap-net`; postgres stays `default`-only, sandboxes stay `cap-net`-only. | Compose assertion: api reaches postgres AND a `cap-net` sandbox. |
| D3 | compose `api` runs `user: root` so it can read root-owned `/var/run/docker.sock`. | Compose assertion: DooD `docker` call from api succeeds (no EACCES). |
| D4 | CPR detector byte sequence is `\x1b[6n` (hex `1b 5b 36 6e`), not `\x1b[?6n`. | Unit test asserts the detector matches the exact codex byte sequence and injects the CPR reply. |
| D5 | `hooks.json` COPYed to `/home/gem/.codex` + chown `1000:1000` (codex runs as `gem`, HOME=`/home/gem`; gem is created by the AIO entrypoint at runtime). | Image-content assertion: `hooks.json` present + owned `1000:1000` at the gem HOME. |
| D6 | Dockerfile COPYs the whole `/repo` workspace + a stable `/opt/cap/dist` symlink so the pnpm symlink farm resolves. | Hook smoke test: `import zod` / `@cap/contracts` resolves in-image (no `ERR_MODULE_NOT_FOUND`). |

**Rationale:** specs/tests are the only durable guard. The alternative (trust the working-tree
fix) is what produced the 10-defect surprise in the first place — each fix is one regression
away from silently reverting under a build-green check.

### D7 — bump codex to a compatible version + document the model/version matrix (P0)

The derived image pins `@openai/codex@0.42.0`. That pin was chosen during `migrate` for
**live-frame byte-identity**, but it is unusable with the operator's real account: codex 0.42
400s on `gpt-5` / `gpt-5-codex` / `o4-mini` for ChatGPT accounts ("not supported when using
Codex with a ChatGPT account"), and the operator's model `gpt-5.5` "requires a newer version of
Codex." Verified working: **codex 0.131.0 + gpt-5.5**.

**Decision:** bump `CODEX_VERSION` to `0.131` AND expose it as a configurable build-arg (default
`0.131`), and document a compatibility matrix so the next operator does not rediscover this by
trial. This is **BREAKING**: the bump changes the baked runner image and the agent frame stream
(byte-identity with the 0.42 frame capture is intentionally abandoned).

Documented matrix (the load-bearing rows):

| codex version | ChatGPT-account model | Status |
| --- | --- | --- |
| 0.42.0 | gpt-5 / gpt-5-codex / o4-mini | 400 — not supported for ChatGPT accounts |
| 0.42.0 | gpt-5.5 | rejected — requires a newer codex |
| 0.131.0 | gpt-5.5 | **verified working** |

**Alternatives considered:** (a) keep 0.42 and force an older model — rejected, the operator's
account is on `gpt-5.5` and cannot downgrade; (b) hard-pin 0.131 with no build-arg — rejected,
the matrix will move again (0.131 is a research preview) and a build-arg costs nothing.

### D8 / #1b — re-cast the blocking approval hook onto the codex 0.131 protocol (P1, ★ RISKY)

cap's baked `hooks.json` + hook scripts target an OLD/custom codex hook spec, incompatible with
codex 0.131's Claude-Code-style hooks on three axes plus launch/trust. The cap-side approval
path itself is unchanged and already proven (#1a) — **only the codex-facing adapter changes**.

**Decision:** rewrite the baked `hooks.json` to 0.131 format and rewrite the hook entry script
to read the 0.131 stdin schema, translate to cap's existing `permission_request` frame,
`POST /v1/approvals` (existing routing), and emit the 0.131 decision; launch codex with
`--full-auto` + hook trust.

Protocol table (the exact adapter contract):

| Axis | cap (old/custom) | codex 0.131 target |
| --- | --- | --- |
| `hooks.json` format | `{blocking, command:[array]}` | `{matcher:<regex>, hooks:[{type:"command", command:<string>, timeout?}]}` |
| hook STDIN | `PermissionRequestFrame {requestId, taskId, toolName, toolInput}` | `{session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id, tool_name, tool_use_id, tool_input}` |
| hook STDOUT | `{decision:{behavior:allow\|deny}}` | exit 0 (allow) / exit 2 + stderr (deny), OR JSON `{hookSpecificOutput:{hookEventName, permissionDecision:"allow"\|"deny", permissionDecisionReason?}}` |
| launch + trust | (implicit) | codex launched with `--full-auto` (KEEPS hooks; `-s` sandbox / bypass-approvals DISABLE them) AND hook trusted via config.toml `[hooks.state] trusted_hash`, or `--dangerously-bypass-hook-trust` for vetted automation |

The adapter is a thin translation: 0.131 stdin → cap `permission_request` frame → `POST /v1/approvals`
(allow/deny/fail-closed already proven by #1a) → 0.131 `{hookSpecificOutput:{permissionDecision}}`
(or exit-code) back to codex.

**★ HARD FIRING RISK (must be in the design + a spec scenario):** even with the correct 0.131
format + `--full-auto` + `--dangerously-bypass-hook-trust` + matcher `.*`, the `PreToolUse` hook
**STILL did not fire** in live tests (codex#16732 — hooks unreliable for non-shell tool calls;
codex 0.131 is a research preview). The cap-side path is proven; the gap is the adapter PLUS
codex actually firing it.

**Decision (FALLBACK):** the rewrite is **gated behind a live verification**. We do NOT write a
spec that asserts "codex fires the hook" as already-true. The spec scenario states the adapter
emits the correct protocol AND that approval enforcement does not depend on codex firing the
hook. If live verification shows hooks remain unreliable, approval is enforced at **a layer cap
controls** rather than relying on codex — i.e. cap mediates the tool-affecting boundary
(the candidate: cap-controlled egress / shell-exec interception at the orchestrator–sandbox
boundary, since cap owns `/v1/shell/exec` and the network). The exact fallback enforcement
shape is an Open Question; the **decision** is that one MUST exist and the hook MUST NOT be the
sole gate.

**Alternatives considered:** (a) ship the hook adapter and trust it — rejected, codex#16732
means a configured hook can silently not fire, which fails OPEN on approvals (unacceptable);
(b) pin an older codex where the custom hook worked — rejected, conflicts with D7 (0.42 is
unusable with the real account). This is **BREAKING** (hook protocol change).

### D9 — reconnect: persist session.log in the bridge + real xterm headless terminal (P0)

Under connect-in there is **no session.log writer**: the old runner producer was deleted, and
`AioPtyClient` output flows `onPtyOutput → snapshots.feed`, which only advances a byte-offset and
never `appendFile`s `workspaces/<id>/session.log`. And `SnapshotManager` is backed by a
`NullHeadlessTerminal` whose `serialize()` is empty. So `buildReconnectFrames` returns nothing —
the realtime-terminal "Snapshot plus tail-replay reconnect" requirement is unsatisfied after the
migration. (This compiles and is build-green; nothing in the type system catches an empty
serialize.)

**Decision:**
- (a) Persist raw PTY output to `workspaces/<id>/session.log` **on the orchestrator**
  (`AioPtyClient` / gateway), keeping `snapshots.feed`'s byte-offset in lockstep with the file so
  the snapshot boundary and the tail align.
- (b) Back `SnapshotManager` with a **REAL xterm headless terminal** (replacing
  `NullHeadlessTerminal`) so the visible-frame snapshot (recording cols/rows via SerializeAddon)
  is non-empty.
- (c) Verify a reconnecting operator replays prior output (snapshot + tail of `session.log`
  appended after the snapshot).

**Rationale:** the base realtime-terminal requirement already specifies snapshot + tail-replay;
the migration relocated PTY output to the orchestrator bridge but dropped the writer. The fix
restores the writer at the new location rather than re-introducing an in-container producer.
The session.log persistent volume (multi-target-deploy "Persistent volume for session.log
survives restart") is the storage surface this attaches to.

### D10 — clone into an empty dir + verify exit_code (P0)

The provider runs `git clone <url> .` into cwd `/home/gem`, which is **NON-EMPTY** → `fatal:
destination path "." already exists and is not an empty directory`. Worse, the provider only
checks the HTTP `res.ok` of `/v1/shell/exec`, NOT the command `exit_code` — and the response was
`{success:true, exit_code:0}` because `exit_code` came from the **trailing `| head` pipe**, not
the clone. So it LOGGED "cloned task repository" on a silent failure. Verified: cloning into an
empty dir works (cap-net reaches github).

**Decision:** clone into a dedicated EMPTY workspace dir (e.g. `/home/gem/workspace`) and PARSE
the `/v1/shell/exec` response `exit_code` / `output`, surfacing a real provision error when the
clone fails (no silent success). The "Task repository is cloned before the handle is returned"
scenario becomes the D10 surface.

**Rationale:** the `| head` pipe masking the real exit code is the exact build-green analogue at
runtime — a success signal sourced from the wrong place. Parsing the actual command exit code is
the minimal honest fix; the empty-dir target removes the deterministic clone failure.

### Config passthrough + per-task TASK_REPO_URL

compose did not pass `MAX_CONCURRENT_TASKS` / `TASK_REPO_URL` to the api service though the code
reads them (`readGuardrailsConfig` / provider); a passthrough was added.

**Decision:** confirm the compose passthrough with a test. SEPARATELY, capture that
`TASK_REPO_URL` as a GLOBAL env is **wrong for per-task semantics** — the repo URL should be
sourced PER TASK (carried from the `migrate` design). This change does NOT implement per-task
sourcing; it records the open question so the global env is not mistaken for the intended design.

## Risks / Trade-offs

- **[D8 codex-hook firing unreliability — the dominant risk]** codex#16732: a correctly
  configured `PreToolUse` hook can silently not fire (research preview; non-shell tool calls).
  Relying on it fails OPEN on approvals. → **Mitigation:** gate the rewrite behind live
  verification; do NOT spec "codex fires the hook" as true; require a cap-controlled fallback
  enforcement layer so approval never depends solely on codex firing.
- **[D7 BREAKING frame-stream change]** bumping 0.42 → 0.131 abandons the live-frame
  byte-identity the 0.42 pin was chosen for; downstream frame consumers may see different bytes.
  → **Mitigation:** build-arg keeps the version pinnable; document the matrix; accept that
  byte-identity is moot because 0.42 is unusable with the real account.
- **[D3 root container]** `user: root` widens the api blast radius. → **Mitigation:** consistent
  with the already-accepted host-root-equivalent threat model (DooD already implies host root);
  no net new exposure.
- **[D9 session.log unbounded growth]** persisting raw PTY output to disk can grow without
  bound. → **Mitigation:** snapshot boundary lets the tail be bounded; persistent-volume sizing
  is the multi-target-deploy surface; rotation is out of scope here but flagged.
- **[D9 snapshot/offset drift]** if the file write and `snapshots.feed` byte-offset diverge, the
  tail replays the wrong bytes. → **Mitigation:** keep the offset in lockstep with the append in
  a single code path; verify with a reconnect replay test.
- **[D10 over-strict exit parsing]** parsing `exit_code` could surface transient/benign non-zero
  codes as provision failures. → **Mitigation:** scope the check to the clone command's own exit
  code (not the pipe), with the real `output` in the error for diagnosis.

## Migration Plan

The fixes are **independent** — each can land and be verified on its own. Sequence by priority,
not by coupling.

1. **Precondition:** archive `migrate-execution-to-aio-sandbox` first (this change MODIFIES the
   `aio-sandbox-execution` capability it ADDs). Without the archive, the MODIFIED spec blocks
   have no base text.
2. **P0 — D9, D10, D7** (runtime correctness; mechanically well-understood, no external
   unknowns):
   - **D10** clone-into-empty-dir + exit_code parsing — unblocks honest provisioning.
   - **D9** session.log writer in the bridge + real headless xterm — restores reconnect; ties to
     the session.log persistent volume.
   - **D7** CODEX_VERSION → 0.131 build-arg + matrix doc — makes the real account usable.
     BREAKING (new image + frame stream); ship behind the build-arg.
3. **P1 — D8 / #1b** (design-heavy, RISKY; depends on live verification): rewrite `hooks.json` +
   hook entry script to the 0.131 protocol, launch `--full-auto` + trust. Land the adapter, then
   **live-verify firing**. If hooks do not fire reliably, activate the cap-controlled fallback
   enforcement layer. Do NOT mark the approval-via-codex-hook scenario satisfied on build-green
   alone.
4. **D1–D6 lock-down specs/tests** can land alongside any phase (the fixes already exist; the
   tests are the deliverable).
5. **Config passthrough** confirm-test lands with P0.

**Rollback:** every item is independently revertible. D7's build-arg allows pinning back to a
prior codex without a code change. D8 is the highest rollback value — if live verification fails
and no acceptable fallback ships, the hook-protocol rewrite can be held while the cap-side path
(already proven, #1a) continues to mediate what cap controls. D9/D10 are additive and safe to
revert to the prior (silent) behavior if needed, though that re-opens the masked defects.

## Open Questions

- **Per-task TASK_REPO_URL:** `TASK_REPO_URL` as a GLOBAL compose env is wrong for per-task
  semantics — the repo URL should be sourced PER TASK (carried from the `migrate` design). What
  is the per-task source of record (task record field? request payload? creds-scoped?), and how
  does it reach the provider at provision time without a global env? Not resolved here.
- **Codex-hook fallback shape (D8):** if codex hooks remain unreliable, what is the exact
  cap-controlled enforcement layer? The candidate is interception at the orchestrator–sandbox
  boundary cap already owns (`/v1/shell/exec` + the `cap-net` network), mediating the
  tool-affecting boundary instead of relying on codex firing `PreToolUse`. What tool surface does
  that cover vs. miss (shell-exec yes; in-process non-shell tool calls?), and is partial coverage
  acceptable as fail-closed? Must be answered by live verification before the D8 scenario is
  marked satisfied.
- **session.log retention/rotation (D9):** the writer is restored, but bounded growth and
  rotation policy on the persistent volume are not specified here.
