# aio-sandbox-execution Specification

## Purpose
TBD - created by applying change migrate-execution-to-aio-sandbox. Update Purpose after archive.
## Requirements
### Requirement: Per-task AIO Sandbox container provisioning
The system SHALL provision exactly one AIO Sandbox container per task via dockerode `createContainer`, naming it `cap-aio-<taskId>` from the pinned derived AIO image, configured with `HostConfig.SecurityOpt` containing `seccomp=unconfined`, capable of joining the `cap-net` user-defined network, with `ShmSize` of approximately 2g and `AutoRemove` DISABLED (`HostConfig.AutoRemove: false`), and with NO `PortBindings` so the container publishes no host port. After starting the container the system SHALL poll the sandbox `/v1/docs` endpoint until it responds (readiness) before treating the sandbox as usable.

Because `AutoRemove` is disabled, a terminal task's container SHALL be RETAINED in a stopped state rather than removed: `teardownSandbox` SHALL be a STOP-ONLY operation (it stops the container and SHALL NOT issue a `remove`), so the frozen container filesystem — including the codex `rollout-*.jsonl` session record under `/home/gem/.codex/sessions/` — survives for later read-only replay. BEFORE the stop, while the container is still running and its `/v1/shell/exec` surface is reachable, `teardownSandbox` SHALL trim `/home/gem/.codex` over `/v1/shell/exec` — deleting the codex cache and `logs_*.sqlite` files while KEEPING `/home/gem/.codex/sessions/` and the workspace — and SHALL clear (zero/empty) `/home/gem/.codex/auth.json` as cheap defense-in-depth, so the retained stopped container holds a bounded footprint and no usable credential. A pre-stop trim/clear failure SHALL NOT block the stop+retain. This is a **BREAKING** change for any consumer that assumed a terminal task's `cap-aio-*` container no longer exists.

#### Scenario: Container is created with required security and network options
- **WHEN** `AioSandboxProvider` provisions a sandbox for a task with id `<taskId>`
- **THEN** it calls dockerode `createContainer` with name `cap-aio-<taskId>` from the pinned AIO image
- **AND** `HostConfig.SecurityOpt` includes `seccomp=unconfined`
- **AND** the container is attached to the `cap-net` network with no `PortBindings` so no host port is published

#### Scenario: Container is created with AutoRemove disabled
- **WHEN** `AioSandboxProvider` provisions a sandbox for a task
- **THEN** `HostConfig.AutoRemove` is `false`, so the Docker daemon does not auto-remove the container when its process exits

#### Scenario: Readiness is confirmed by polling /v1/docs
- **WHEN** the container has been started
- **THEN** the provider polls `GET /v1/docs` on the sandbox and does not return the sandbox as ready until that endpoint responds successfully

#### Scenario: seccomp=unconfined is required
- **WHEN** the container is created without `seccomp=unconfined` in `HostConfig.SecurityOpt`
- **THEN** provisioning is treated as invalid and the sandbox is not used for task execution

#### Scenario: Teardown stops and retains the container without removing it
- **WHEN** a terminal task's `teardownSandbox` runs
- **THEN** the container is stopped and NOT removed, so `docker inspect cap-aio-<taskId>` after teardown reports an `Exited` (stopped) container rather than "No such container"

#### Scenario: Pre-stop trim drops caches and clears auth before stopping
- **WHEN** `teardownSandbox` runs while the container is still running
- **THEN** it trims `/home/gem/.codex` over `/v1/shell/exec` (deleting the codex cache and `logs_*.sqlite`, keeping `/home/gem/.codex/sessions/` and the workspace) and clears `/home/gem/.codex/auth.json`, BEFORE issuing the container stop
- **AND** a failure of the trim/clear does not prevent the container from being stopped and retained

### Requirement: SandboxConnection handle returned from provisioning
The `AioSandboxProvider.provision()` SHALL return a `SandboxConnection` handle carrying `taskId`, an HTTP `baseUrl` of the form `http://cap-aio-<taskId>:8080`, and a `wsUrl` of the form `ws://cap-aio-<taskId>:8080/v1/shell/ws`, so that the orchestrator can address the sandbox by container name over `cap-net` and open the terminal WebSocket. The provider SHALL also clone the task repository into a DEDICATED, EMPTY workspace directory (e.g. `/home/gem/workspace`) — never into the non-empty `/home/gem` HOME — via `POST /v1/shell/exec` before returning the handle. The provider SHALL PARSE the `/v1/shell/exec` response body, treating a non-zero command `exit_code` (not merely a non-`ok` HTTP status) as a provisioning failure, and SHALL surface a real provision error rather than logging success on a silent clone failure.

The clone success path and the clone fail-closed path SHALL be VERIFIED END-TO-END on a live compose stack (not merely unit-tested), as fossilized black-box regression scenarios in the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`): cloning into the dedicated empty workspace directory SHALL succeed with an asserted zero `exit_code`; a FORCED clone failure (non-empty target directory or bad repository URL) SHALL raise a non-zero exit_code with NO silent success. The `AioApprovalEnforcer` exec-gate is NOT verified end-to-end in this change: the enforcer class is fail-closed (covered by unit tests) but is currently DORMANT — there are no cap-owned gated `/v1/shell/exec` call sites in production code that route through it (it is wired as a DI provider for future use); see the `agent-events-and-approvals` spec for the honest coverage statement.

#### Scenario: Provision returns an addressable connection handle
- **WHEN** provisioning completes for task `<taskId>`
- **THEN** the returned `SandboxConnection` has `taskId` set, `baseUrl` equal to `http://cap-aio-<taskId>:8080`, and `wsUrl` equal to `ws://cap-aio-<taskId>:8080/v1/shell/ws`

#### Scenario: Task repository is cloned into a dedicated empty workspace dir before the handle is returned
- **WHEN** the sandbox is ready and before `provision()` returns
- **THEN** the provider issues a git clone of the task repository into a dedicated, empty workspace directory (e.g. `/home/gem/workspace`) via `POST /v1/shell/exec`
- **AND** it does NOT clone into the non-empty `/home/gem` HOME directory

#### Scenario: Clone failure surfaces a provision error instead of silent success
- **WHEN** the `POST /v1/shell/exec` clone command returns a non-zero `exit_code` in its response body (for example because the destination already exists or is non-empty)
- **THEN** the provider parses the response `exit_code`/`output` and raises a provisioning error
- **AND** it does NOT log "cloned task repository" or otherwise report success on a failed clone

#### Scenario: Clone success is verified end-to-end on a live compose stack
- **WHEN** the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`) provisions a real sandbox and clones the task repository into the dedicated empty `/home/gem/workspace` via `POST /v1/shell/exec`
- **THEN** the clone command returns a zero `exit_code` and the e2e assertion passes that the repository is present in the workspace directory
- **AND** no provisioning error is raised on the success path

#### Scenario: Forced clone failure fails closed end-to-end with no silent success
- **WHEN** the compose e2e suite forces a clone failure (a non-empty target directory or a bad repository URL) via `POST /v1/shell/exec`
- **THEN** the provider parses the non-zero `exit_code` and the e2e suite observes a real provisioning error
- **AND** the suite asserts there is NO "cloned task repository" / silent success log on the failed clone

#### Scenario: Enforcer exec-gate class is fail-closed; no live gated call site exists
- **WHEN** the `AioApprovalEnforcer` class is evaluated for its fail-closed contract
- **THEN** the class resolves `allow` to `allowed:true`, and resolves `deny`, an approval error, or decision timeout to `allowed:false` (fail closed) — covered by unit tests
- **AND** this contract is NOT currently exercised end-to-end: there are no cap-owned gated `/v1/shell/exec` call sites in production code that route through the enforcer; it is registered as a DI provider (`AIO_APPROVAL_ENFORCER`) for future use but is dormant
- **AND** the spec does NOT claim this gate is live in the current production stack

### Requirement: AioPtyClient connects into the sandbox terminal without session_id
The system SHALL provide an `AioPtyClient` that opens an OUTBOUND WebSocket as a WS client to the sandbox `ws://.../v1/shell/ws` endpoint and SHALL connect WITHOUT any `session_id` query parameter, so the sandbox creates a fresh tmux-backed session per task. The client SHALL treat the server-sent `session_id` then `ready` frames as the session-established signal. The client SHALL NOT attempt to rejoin an existing session by passing `?session_id=`.

#### Scenario: Connect-in opens a new session per task
- **WHEN** `AioPtyClient` connects for a task
- **THEN** it opens an outbound WebSocket to `ws://cap-aio-<taskId>:8080/v1/shell/ws` with no `session_id` query parameter
- **AND** it waits for the server `session_id` frame followed by the `ready` frame before considering the terminal live

#### Scenario: Rejoining an existing session is never attempted
- **WHEN** `AioPtyClient` establishes its terminal connection
- **THEN** it does not pass a `?session_id=` parameter to rejoin a prior session

### Requirement: Synthetic CPR injection so codex starts
The `AioPtyClient` SHALL watch the sandbox output stream and, on observing a DSR cursor-position query (`\x1b[6n` — standard DSR-6, with NO `?`), SHALL immediately send a synthetic CPR reply input frame `{type:"input",data:"\x1b[1;1R"}` to the sandbox, because codex (crossterm) emits the DSR query on startup and aborts with a cursor-position read error if no CPR reply arrives in time. The detector MUST match the no-`?` form exactly; the private-mode `\x1b[?6n` form is NOT what crossterm emits (matching it silently disables CPR injection and codex never starts — verified against the live sandbox: codex emits bytes `1b 5b 36 6e`). This injection SHALL be performed purely in the bridge layer without any AIO or tmux changes.

#### Scenario: CPR is injected on the DSR query
- **WHEN** the sandbox output stream contains the DSR cursor-position query `\x1b[6n` (standard DSR-6, no `?`)
- **THEN** `AioPtyClient` immediately sends an input frame with data `\x1b[1;1R` to the sandbox

#### Scenario: codex starts after CPR injection
- **WHEN** codex launches in the sandbox and the bridge injects the synthetic CPR reply
- **THEN** codex proceeds past startup and renders its TUI rather than aborting with a cursor-position read error

### Requirement: JSON to cap-frame translation preserving the browser protocol
The `AioPtyClient` SHALL translate between the sandbox AIO JSON WebSocket frames and the EXISTING base64 raw + control-frame protocol the front-end xterm speaks, leaving the browser-facing protocol unchanged. Sandbox `output` frames SHALL be surfaced as raw output (base64 raw chunks) into the existing terminal pipeline; operator keystrokes SHALL be sent as `{type:"input"}` frames; resize SHALL be sent as `{type:"resize",data:{cols,rows}}` frames; and a sandbox `ping` frame SHALL be answered with an internal `{type:"pong"}` that is distinct from the operator write-lease heartbeat.

#### Scenario: Sandbox output becomes raw browser output
- **WHEN** the sandbox sends an `{type:"output",data}` frame
- **THEN** `AioPtyClient` emits that data into the existing raw output pipeline so the browser xterm receives it via the unchanged base64 raw protocol

#### Scenario: Operator input and resize are forwarded as AIO frames
- **WHEN** an operator keystroke or a resize event reaches `AioPtyClient`
- **THEN** the keystroke is sent to the sandbox as a `{type:"input"}` frame and the resize as a `{type:"resize",data:{cols,rows}}` frame

#### Scenario: AIO ping is answered internally
- **WHEN** the sandbox sends a `ping` frame
- **THEN** `AioPtyClient` replies with an internal `{type:"pong"}` frame
- **AND** this pong is not conflated with the operator write-lease heartbeat

### Requirement: codex launched in-shell over the terminal channel
The system SHALL launch codex INSIDE the AIO shell over the `/v1/shell/ws` terminal channel (execution model A), preserving the interactive TUI, and SHALL NOT run codex via the request/response `exec`/MCP surfaces for the interactive terminal channel. The launch SHALL carry the task's operator-supplied prompt (`task.prompt`) as codex's positional initial-session prompt so the operator never re-enters the goal. The prompt SHALL be made available to the launch via the provisioning lookup (NOT hard-coded, NOT omitted), written into the sandbox at provision time as a FILE under `/home/gem/.codex` using the SAME base64-decode injection idiom used for `config.toml`/`auth.json` (so arbitrary prompt text — quotes, backticks, `$`, newlines — is shell-injection-safe and is NEVER inlined into the launch argv), and passed to codex as the positional `[PROMPT]` argument via a `"$(cat <promptfile>)"` shell expansion. The launch-argv guard that refuses hook-disabling flags (`-s`/`--yolo`/`bypass-approvals`) SHALL inspect ONLY the fixed launch flags, NOT the operator prompt text, so a prompt mentioning those tokens is not falsely rejected. Because codex's positional prompt PRE-FILLS the composer but does NOT auto-submit, the system SHALL auto-submit the pre-filled prompt by injecting a single carriage return EXACTLY ONCE, AFTER the codex-startup DSR (`\x1b[6n`) has been observed AND the terminal output has quiesced — a condition that guarantees codex's TUI (not the shell) is live and the composer is rendered — so zero operator keystrokes are required to begin the run. If the auto-submit misfires it SHALL degrade to a still-pre-filled composer the operator can submit manually, NEVER to a lost goal, and a prompt-file injection failure SHALL fail the provision CLOSED rather than launching goal-less. When the task prompt is empty the launch SHALL open codex with no positional prompt (a blank composer) rather than failing. The system SHALL NOT use `codex exec` for this path (it is non-interactive and can hang on inherited non-TTY stdin). The derived sandbox image SHALL be baked FROM the pinned AIO image with codex, `~/.codex/hooks.json`, and the compiled `dist/hooks` included. The provisioned codex version SHALL be PINNED via a documented `CODEX_VERSION` build-arg to a release compatible with the account model in use (verified working: codex `0.131.0` with model `gpt-5.5`); the prior `0.42.0` pin SHALL NOT be used because it 400s on `gpt-5`/`gpt-5-codex`/`o4-mini` for ChatGPT accounts and is unusable with `gpt-5.5`. The baked `~/.codex/hooks.json` and the compiled `dist/hooks` SHALL conform to the codex `0.131` hook protocol.

The derived image SHALL be SLIMMED: instead of COPYing the whole built `/repo` workspace (so the hooks' pnpm symlink farm resolves at runtime), the build SHALL use `pnpm deploy` (`--prod`; `--legacy` if pnpm 10 requires it) to generate a SELF-CONTAINED `node_modules` tree for `@cap/sandbox-hooks`, and the image SHALL COPY only that self-contained `node_modules` plus the compiled `dist` — dropping the full `/repo` COPY. The slimmed image SHALL still resolve the hook dependencies at runtime: `import zod` and `@cap/contracts` SHALL load without `ERR_MODULE_NOT_FOUND` and the hook SHALL still run.

#### Scenario: codex runs over the interactive terminal channel
- **WHEN** a task begins execution
- **THEN** codex is started inside the AIO shell over the `/v1/shell/ws` terminal channel
- **AND** codex is not launched through the request/response `exec` or MCP surfaces for the interactive terminal channel

#### Scenario: Derived image bakes a compatible pinned codex and 0.131-format hooks
- **WHEN** the derived sandbox image is inspected
- **THEN** it is built FROM the pinned AIO image and includes codex, `~/.codex/hooks.json`, and the compiled `dist/hooks`
- **AND** the codex version is set from a documented `CODEX_VERSION` build-arg pinned to a release compatible with the account model (e.g. `0.131.0` for `gpt-5.5`), not `0.42.0`
- **AND** the baked `~/.codex/hooks.json` is in the codex `0.131` hook format

#### Scenario: Task prompt is injected as a shell-safe file and passed positionally
- **WHEN** a task with a non-empty `task.prompt` is provisioned
- **THEN** the orchestrator writes the prompt into the sandbox at `/home/gem/.codex/task-prompt.txt` via the base64-decode injection idiom (the raw text is never inlined into the launch argv)
- **AND** codex is launched with the positional prompt supplied as `"$(cat /home/gem/.codex/task-prompt.txt)"`, pre-filling the composer with the operator goal

#### Scenario: Pre-filled prompt is auto-submitted after the TUI is confirmed started
- **WHEN** codex has been launched with a pre-filled positional prompt, the codex-startup DSR `\x1b[6n` has been observed, and terminal output has quiesced
- **THEN** the orchestrator injects a single carriage return exactly once so the pre-filled goal is submitted and the run begins with zero operator keystrokes
- **AND** the carriage return is never injected while the shell (not codex) holds the terminal, so the goal cannot be silently dropped into the shell

#### Scenario: A prompt mentioning hook-disabling tokens is not rejected
- **WHEN** `task.prompt` contains text such as `-s`, `--yolo`, or `bypass-approvals`
- **THEN** the hook-disabling launch guard inspects only the fixed launch flags and launches codex normally, because the prompt is supplied via the injected file rather than inlined into the argv

#### Scenario: Empty prompt opens a blank composer
- **WHEN** a task has an empty `task.prompt`
- **THEN** codex is launched with no positional prompt and opens a blank composer rather than failing the launch

#### Scenario: Prompt-file injection failure fails the provision closed
- **WHEN** writing the prompt file into the sandbox returns a non-zero exit
- **THEN** the provision fails closed rather than launching codex without the operator goal

#### Scenario: Derived image uses pnpm deploy for a real, self-contained node_modules (no /repo COPY, no symlinks)
- **WHEN** the derived sandbox image build for `@cap/sandbox-hooks` is inspected
- **THEN** it uses `pnpm deploy` (`--prod --legacy`) to produce a self-contained `node_modules` tree and COPYs only that tree plus the compiled `dist` into `/opt/cap/`
- **AND** it does NOT COPY the full built `/repo` workspace into the final stage, and `/opt/cap/dist` is a real directory (no symlink indirection)
- **AND** the hook deps (`zod`, `@cap/contracts`) resolve as real, hoisted entries in the deploy tree with no dangling symlinks or `ERR_MODULE_NOT_FOUND`
- **NOTE** the structural change is the goal (real node_modules, no symlink farm, no /repo COPY); the overall image size is comparable to the prior approach because the hooks-build stage was already a selective workspace COPY, not the full host repo

#### Scenario: Hook dependencies still resolve at runtime in the slimmed image
- **WHEN** the slimmed derived image runs the baked hook
- **THEN** `import zod` and `@cap/contracts` resolve without `ERR_MODULE_NOT_FOUND`
- **AND** the hook executes successfully

### Requirement: Blocking approval hooks re-homed via outbound HTTP callback
The blocking approval hooks (`permission_request` and `post_tool_use`) SHALL be re-homed to make an OUTBOUND HTTP callback from the sandbox to a NEW orchestrator approvals endpoint reachable over `cap-net`, reusing the EXISTING `onPermissionRequest`/`onDecision` approval routing so that only the transport changes. The approval semantics and routing above the transport SHALL remain unchanged. The in-sandbox hook adapter SHALL speak the codex `0.131` hook protocol: it SHALL read the `0.131` stdin schema (`{session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id, tool_name, tool_use_id, tool_input}`), translate it to cap's `permission_request` frame for the existing `POST /v1/approvals` routing, and emit the `0.131` decision form (`{hookSpecificOutput:{hookEventName, permissionDecision:"allow"|"deny", permissionDecisionReason?}}`, or exit `0` for allow / exit `2` + stderr for deny).

#### Scenario: Approval request travels over HTTP callback to the orchestrator
- **WHEN** a hook inside the sandbox fires a `permission_request` or `post_tool_use`
- **THEN** the sandbox makes an outbound HTTP call to the orchestrator approvals endpoint over `cap-net`
- **AND** the orchestrator handles it through the existing `onPermissionRequest`/`onDecision` routing

#### Scenario: Approval routing is unchanged above the transport
- **WHEN** an approval decision is produced for a re-homed hook
- **THEN** the decision flows through the same `onDecision` routing used before the migration, with only the sandbox-to-orchestrator transport changed to an HTTP callback

#### Scenario: Hook adapter speaks the codex 0.131 stdin/stdout protocol
- **WHEN** the codex `0.131` hook fires and writes its `0.131` stdin payload to the in-sandbox hook adapter
- **THEN** the adapter parses the `0.131` stdin schema (including `tool_name` and `tool_input`), translates it to cap's `permission_request` frame, and performs the existing `POST /v1/approvals` round-trip
- **AND** it returns the decision in the codex `0.131` form (`{hookSpecificOutput:{permissionDecision}}`, or exit `0` allow / exit `2` deny)

### Requirement: Exit detection mapped to guardrails
Because the node-pty `onExit` signal no longer exists, the `AioPtyClient` SHALL detect task termination by observing the terminal WebSocket close and SHALL determine the exit status using `POST /v1/shell/exec` running `echo $?` and/or `/v1/shell/wait`, mapping a zero exit status to guardrails `recordSuccess` and a non-zero or abnormal termination to guardrails `recordFailure`. The orchestrator bridge (`AioPtyClient`/gateway) SHALL ALSO persist the raw PTY output stream by appending it to `workspaces/<taskId>/session.log` as it is received, keeping the byte-offset fed to `snapshots.feed` in lockstep with the bytes written to `session.log`, so that reconnect tail-replay has a durable source of prior output.

#### Scenario: WS close triggers exit-status resolution
- **WHEN** the sandbox terminal WebSocket closes
- **THEN** `AioPtyClient` resolves the task exit status via `/v1/shell/exec` `echo $?` and/or `/v1/shell/wait`

#### Scenario: Exit status maps to guardrails outcome
- **WHEN** the resolved exit status is zero
- **THEN** the system calls guardrails `recordSuccess`
- **AND** when the resolved exit status is non-zero or the termination is abnormal, the system calls guardrails `recordFailure`

#### Scenario: Raw PTY output is persisted to session.log in the orchestrator bridge
- **WHEN** the sandbox emits raw `output` for a task with id `<taskId>`
- **THEN** the orchestrator bridge appends those raw bytes to `workspaces/<taskId>/session.log`
- **AND** the byte-offset advanced in `snapshots.feed` stays in lockstep with the bytes written to `session.log`

### Requirement: Selected skills are preinstalled into the task workspace at provision time
When a task selects one or more skills (the optional `skills` run parameter — see `repo-and-task-management`), the orchestrator SHALL preinstall each selected skill into the cloned task workspace at provision time, AFTER the repo clone and BEFORE the codex launch handle is returned, so codex starts already equipped with that workflow. Each skill SHALL be installed by running its OFFICIAL non-interactive installer against `/home/gem/workspace` over the existing `/v1/shell/exec` channel (the same surface used for clone/auth injection) — for example OpenSpec via `openspec init --tools codex --force /home/gem/workspace`. The set of installable skills SHALL be a SERVER-SIDE ALLOWLIST mapping a skill id to a fixed, pinned installer command; the operator only ever submits skill IDS, which the orchestrator validates against the allowlist — raw operator free-text SHALL NEVER be executed as an installer command. When a skill's generated SKILL.md files shell out to that skill's CLI at runtime (OpenSpec's skills invoke the `openspec` CLI), that CLI SHALL be available on the sandbox PATH — and because the `/v1/shell/exec` provision channel runs as the unprivileged `gem` user (which cannot `npm install -g` to the root-owned prefix), such a CLI SHALL be BAKED into the derived image (e.g. `openspec` baked from a pinned `OPENSPEC_VERSION`, mirroring the Codex CLI bake) rather than installed per-task. codex SHALL consume the preinstalled skill through the agent-instruction files the installer drops into the workspace — a workspace-level `.codex/skills/<name>/SKILL.md` (auto-discovered because codex launches with `-C /home/gem/workspace`) and/or `.agents/skills/<name>/SKILL.md` and/or a root `AGENTS.md`. The codex plugin MARKETPLACE is NOT used for per-task preinstall.

Skill preinstall SHALL FAIL SOFT, in deliberate contrast to the fail-CLOSED auth/clone steps: a skill whose installer exits non-zero or times out SHALL be logged and recorded as a per-task "skill failed to preinstall" signal, but SHALL NOT abort the provision — codex SHALL still launch (without that skill), because a missing skill is a degraded-but-usable session, not a security gate. Each selected skill SHALL install independently, so one skill failing does not block the others. When a task selects no skills, the preinstall step SHALL be a no-op and provision behavior SHALL be unchanged.

#### Scenario: A selected allowlisted skill is installed into the workspace before launch
- **WHEN** a task selecting the `openspec` skill is provisioned
- **THEN** after the repo clone the orchestrator runs the allowlisted OpenSpec installer (`openspec init --tools codex --force /home/gem/workspace`, using the baked `openspec` CLI) against the workspace, and codex then launches with the skill's generated instruction files present AND the `openspec` CLI on PATH for those skills to invoke

#### Scenario: Only allowlisted skill ids are ever executed
- **WHEN** a task's `skills` selection contains an id not in the server-side allowlist
- **THEN** the orchestrator does NOT execute any command for that id (no operator free-text reaches the shell as an installer command)

#### Scenario: A failing skill install degrades rather than failing the task
- **WHEN** a selected skill's installer exits non-zero or times out
- **THEN** the orchestrator logs and records a per-task "skill failed to preinstall" signal but still launches codex (without that skill), and any other selected skills still install

#### Scenario: No skills selected is a no-op
- **WHEN** a task selects no skills
- **THEN** the provision runs no skill installer and behaves exactly as before this change

