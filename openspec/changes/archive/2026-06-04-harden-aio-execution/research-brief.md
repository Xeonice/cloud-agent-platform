# harden-aio-execution — Research Brief (side-car, NOT a tracked artifact)

> Verified defect diagnosis for hardening the AIO Sandbox execution layer.
>
> Context: the change `migrate-execution-to-aio-sandbox` (NOT yet archived) introduced the
> connect-in AIO execution layer. A hands-on end-to-end test pass ("都测") against a live
> compose stack + real codex 0.131 + the operator's ChatGPT credentials exposed 10 real
> defects that `pnpm verify` (build-green) entirely masked. This change hardens that layer.
>
> `harden-aio-execution` DEPENDS ON `migrate-execution-to-aio-sandbox` being archived first
> (its specs build on the `aio-sandbox-execution` capability that `migrate` ADDs).

---

## Verified-working (regression guards)

These behaviors were proven working in the live end-to-end pass and MUST stay working —
they are regression guards, not work items:

- **Auth reuse** — codex starts logged-in from the host `~/.codex/auth.json` injected at
  `/home/gem/.codex/auth.json`.
- **codex really works** — codex 0.131 + gpt-5.5 ran an agent loop and created a file.
- **Approval HTTP round-trip #1a** — in-container hook -> `POST /v1/approvals` -> operator
  allow/deny/fail-closed, faithfully transported.
- **Exit detection** — `AioPtyClient` WS-close -> resolve -> guardrails.
- **Deadline `forceFail`.**
- **Concurrency** — 2-running-1-queued.

---

## Already-fixed defects (D1–D6)

Applied in the working tree; CONFIRM + lock down with specs/tests.

- **D1 — derived Dockerfile prune fails on pnpm 10.** `pnpm --filter X prune --prod` fails on
  pnpm 10 ("Unknown option: recursive") -> image build fails. **FIXED: removed prune.**
- **D2 — compose api dropped off the default network.** compose api declared
  `networks:[cap-net]` only -> dropped off the default network -> could not reach postgres
  (P1001). **FIXED: api joins BOTH default + cap-net** (postgres stays on default only,
  sandboxes only on cap-net).
- **D3 — non-root api cannot read root-owned docker.sock.** non-root api user cannot read
  root-owned `/var/run/docker.sock` (EACCES) -> DooD fails. **FIXED: compose api `user: root`**
  (consistent with the host-root-equivalent threat model).
- **D4 — wrong CPR detector byte sequence.** CPR detector was `\x1b[?6n` (with `?`) but codex
  emits `\x1b[6n` (verified hex `1b 5b 36 6e`) -> CPR never injected -> codex aborts on
  cursor-position read. **FIXED: `\x1b[6n`.**
- **D5 — hooks.json baked to the wrong HOME.** hooks.json baked to `/root/.codex` but codex
  runs as the `gem` user (HOME=`/home/gem`) -> hooks file never found. **FIXED: COPY to
  `/home/gem/.codex` + chown `1000:1000`** (the gem user does not exist at image-build time;
  it is created by the AIO entrypoint at runtime).
- **D6 — dangling pnpm symlink farm shipped into the image.** COPY only
  `apps/sandbox-hooks/node_modules` (a pnpm SYMLINK FARM into `/repo/node_modules/.pnpm`)
  shipped dangling symlinks -> hook `import zod`/`@cap/contracts` `ERR_MODULE_NOT_FOUND` ->
  hook fails closed (deny) on every approval. **FIXED: COPY the whole `/repo` workspace + a
  stable `/opt/cap/dist` symlink so the farm resolves.**

---

## Defects to fix (D7–D10 + config gap)

### D7 — codex version pin (P0)

The derived image pins `@openai/codex@0.42.0`, but the operator's ChatGPT account uses model
`gpt-5.5` which "requires a newer version of Codex"; 0.42 also 400s on `gpt-5`/`gpt-5-codex`/
`o4-mini` for ChatGPT accounts ("not supported when using Codex with a ChatGPT account").
Verified working: codex 0.131.0 + gpt-5.5.

**FIX:** bump `CODEX_VERSION` to a compatible release (0.131) and/or make it build-arg
configurable, and DOCUMENT the codex-version <-> account-model compatibility (the 0.42 pin
was chosen for live-frame byte-identity but is unusable with the real account model).

### D8 + #1b — hooks adapter to codex 0.131 (P1, design-heavy, RISKY)

See the dedicated section below — this is the largest, riskiest item.

### D9 — reconnect restore is a no-op under connect-in (P0)

There is NO session.log writer: the old runner producer was deleted; `AioPtyClient` output
flows `onPtyOutput -> snapshots.feed` which only advances a byte-offset and NEVER
`appendFile`s `workspaces/<id>/session.log`. And `SnapshotManager` is backed by a
`NullHeadlessTerminal` whose `serialize()` is empty. So `buildReconnectFrames` returns nothing
and a reconnecting operator gets no replay — the realtime-terminal "Snapshot plus tail-replay
reconnect" requirement is unsatisfied after the AIO migration.

**FIX:**
- (a) persist raw PTY output to `workspaces/<id>/session.log` on the orchestrator
  (`AioPtyClient`/gateway), keeping `snapshots.feed`'s byte-offset in lockstep;
- (b) back `SnapshotManager` with a REAL xterm headless terminal so the visible-frame
  snapshot is non-empty;
- (c) verify a reconnecting operator replays prior output.

### D10 — git clone silently fails (P0)

The provider runs `git clone <url> .` into cwd `/home/gem` which is NON-EMPTY -> `fatal:
destination path "." already exists and is not an empty directory`. AND the provider only
checks the HTTP `res.ok` of `/v1/shell/exec`, NOT the command `exit_code` (the response was
`{success:true, exit_code:0}` because `exit_code` came from the trailing `| head` pipe), so it
LOGGED "cloned task repository" on a silent failure. Verified: cloning into an empty dir works
(cap-net reaches github).

**FIX:** clone into a dedicated EMPTY workspace dir (e.g. `/home/gem/workspace`) and PARSE the
`/v1/shell/exec` response `exit_code`/`output`, surfacing a real provision error when the clone
fails (no silent success).

### Config gap — compose env passthrough + per-task repo URL

compose did not pass `MAX_CONCURRENT_TASKS` / `TASK_REPO_URL` to the api service though the
code reads them (`readGuardrailsConfig` / provider). A passthrough was added.

Also: `TASK_REPO_URL` as a GLOBAL env is wrong for per-task semantics — the repo URL should be
sourced PER TASK (it is an open question from the `migrate` design). Capture this.

---

## Codex 0.131 hook protocol (the D8/#1b adapter target + the firing risk)

cap's baked `hooks.json` + hook scripts target an OLD/custom codex hook spec, INCOMPATIBLE
with codex 0.131's Claude-Code-style hooks on three axes:

- **hooks.json format:** cap `{blocking, command:[array]}` vs 0.131
  `{matcher:<regex>, hooks:[{type:"command", command:<string>, timeout?}]}`.
- **hook STDIN:** cap parses `PermissionRequestFrame {requestId, taskId, toolName, toolInput}`
  vs 0.131 sends `{session_id, transcript_path, cwd, hook_event_name, model, permission_mode,
  turn_id, tool_name, tool_use_id, tool_input}`.
- **hook STDOUT:** cap prints `{decision:{behavior:allow|deny}}` vs 0.131 expects exit 0
  (allow) / exit 2 + stderr (deny), or JSON `{hookSpecificOutput:{hookEventName,
  permissionDecision:"allow"|"deny", permissionDecisionReason?}}`.
- **launch + trust:** codex must launch with `--full-auto` (which KEEPS hooks; `-s` sandbox
  flags / bypass-approvals DISABLE them) AND the hook must be trusted (config.toml
  `[hooks.state]` `trusted_hash`, or `--dangerously-bypass-hook-trust` for vetted automation).

**FIX:** rewrite the baked `hooks.json` to 0.131 format; rewrite the hook entry script to read
the 0.131 stdin schema, translate to cap's `permission_request` frame, `POST /v1/approvals`
(the EXISTING routing — #1a proved allow/deny/fail-closed works), and emit the 0.131
`{hookSpecificOutput:{permissionDecision}}` (or exit-code) decision; launch codex with
`--full-auto` + hook trust.

### ★ HARD RISK (must be in the design + a spec scenario)

Even with the correct 0.131 format + `--full-auto` + `--dangerously-bypass-hook-trust` +
matcher `.*`, the `PreToolUse` hook STILL did not fire in live tests (codex#16732 — hooks
unreliable for non-shell tool calls; codex 0.131 is a research preview).

So the rewrite MUST be gated behind a live verification, and the design MUST specify a FALLBACK
if codex hooks remain unreliable (e.g. approval enforced at a layer cap controls rather than
relying on codex firing the hook). Do NOT write a spec that asserts "codex fires the hook" as
already-true.

**NOTE:** #1a already PROVED the cap-side approval path (hook bundle runs, HTTP round-trip,
operator decision) — the ONLY gap is the codex->hook adapter + codex actually firing it.

---

## Capabilities touched

All MODIFIED. `harden` depends on `migrate` being archived first.

### aio-sandbox-execution

Covers D7 (codex version/model), D8 (hook adapter to 0.131), D9 (session.log persistence in
the bridge), D10 (provision clone target + exit-code check). The base requirements live in
`openspec/changes/migrate-execution-to-aio-sandbox/specs/aio-sandbox-execution/spec.md` — COPY
the affected requirement text from there into the MODIFIED block and edit it. Affected base
requirements:

- **SandboxConnection handle returned from provisioning** — its "Task repository is cloned
  before the handle is returned" scenario is the D10 surface (clone into an EMPTY workspace dir
  + parse `/v1/shell/exec` `exit_code`/`output`).
- **codex launched in-shell over the terminal channel** — its "Derived image bakes codex and
  hooks" scenario is the D7 (CODEX_VERSION pin/build-arg) + D8 (0.131-format `hooks.json` /
  `dist/hooks`) surface.
- **Blocking approval hooks re-homed via outbound HTTP callback** — the D8/#1b adapter target;
  the orchestrator approvals endpoint + `onPermissionRequest`/`onDecision` routing is unchanged,
  only the codex-facing hook protocol changes.

### realtime-terminal

D9 — the "Snapshot plus tail-replay reconnect" requirement must be satisfied under connect-in
(session.log persisted + non-empty snapshot). COPY from
`openspec/specs/realtime-terminal/spec.md`. The base requirement today states the orchestrator
restores by writing a periodic headless SerializeAddon snapshot (recording cols/rows) then
replaying the tail of `session.log` appended after the snapshot — which is exactly what D9
shows is currently a no-op (no `session.log` writer; `NullHeadlessTerminal.serialize()` empty).

### agent-events-and-approvals

D8/#1b — the blocking approval hook must speak the codex 0.131 hook protocol (format +
stdin/stdout), launched with `--full-auto` + trust, WITH a documented fallback if codex hooks
remain unreliable. COPY from `openspec/specs/agent-events-and-approvals/spec.md`. The base
"Blocking hook forwards the approval round-trip" requirement (forward event, block until
decision, print `{decision}` JSON) and the "Hooks baked into a version-pinned runner image"
requirement (`~/.codex/hooks.json`, pinned Codex version) are the requirements re-cast onto the
0.131 protocol + the firing-risk fallback.

### multi-target-deploy

D1/D2/D3 (compose build/network/docker.sock fixes) + the `MAX_CONCURRENT_TASKS`/`TASK_REPO_URL`
passthrough (with the per-task-repo-URL open question captured). COPY from
`openspec/specs/multi-target-deploy/spec.md`. The base "API target is Fly.io or docker-compose"
and "Persistent volume for session.log survives restart" requirements are the surfaces these
compose fixes and the session.log volume (tying back to D9) attach to.
