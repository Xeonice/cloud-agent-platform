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
The `AioPtyClient` SHALL detect task termination by LIVENESS of the detached codex session — NOT by the terminal WebSocket closing — because once codex runs in a detached named tmux session a WS close no longer means the task ended (the operator merely disconnected, or the api restarted). The system SHALL poll the named tmux session existence (`tmux has-session -t task<taskId>`) and/or the codex process liveness; only when the session/process is GONE SHALL it treat the task as terminated, and SHALL then determine the exit status using `POST /v1/shell/exec` (e.g. a recorded `$?` / a sentinel the session writes on exit) and/or `/v1/shell/wait`, mapping a zero exit status to guardrails `recordSuccess` and a non-zero or abnormal termination to guardrails `recordFailure`. A WS close while the session is still alive SHALL NOT call `recordSuccess`/`recordFailure`. The orchestrator bridge (`AioPtyClient`/gateway) SHALL ALSO persist the raw PTY output stream by appending it to `workspaces/<taskId>/session.log` as it is received, keeping the byte-offset fed to `snapshots.feed` in lockstep with the bytes written to `session.log`, so that reconnect tail-replay has a durable source of prior output.

#### Scenario: Session-gone (not WS close) triggers exit-status resolution
- **WHEN** the detached codex session for a task is observed to no longer exist (tmux session gone / codex process exited)
- **THEN** `AioPtyClient` resolves the task exit status via `/v1/shell/exec` and/or `/v1/shell/wait` and reports the terminal outcome to guardrails

#### Scenario: A WS close with a live session does not terminate the task
- **WHEN** the orchestrator's terminal WebSocket closes (operator disconnect or api restart) while the named tmux session is still alive
- **THEN** the system does NOT call guardrails `recordSuccess` or `recordFailure`, and the task remains running for re-adoption

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

### Requirement: Compatible-provider Codex credential injected into the codex run
When a task's owning account has an active `compatible`-mode Codex credential, the orchestrator SHALL inject that provider into the per-task codex run at provision time so codex calls the operator's Base URL with the operator's API key and selected default model. The compatible credential's API key SHALL be decrypted from its at-rest ciphertext and the resulting provider configuration SHALL be written into the sandbox `~/.codex/config.toml` using the SAME base64-decode file-injection idiom already used for `config.toml` (never inlined into the launch argv). Per the codex 0.131 config reference, the emitted config SHALL contain a `[model_providers.<id>]` block with `base_url` = the saved Base URL and `wire_api = "responses"` (the only supported value), plus top-level `model_provider = "<id>"` and `model = "<defaultModel>"`; the decrypted API key SHALL be delivered to that provider via `experimental_bearer_token` in the same block (or, equivalently, via an `env_key`-named environment variable set in the codex process). The orchestrator SHALL NOT write `~/.codex/auth.json` for compatible mode — `auth.json`'s `OPENAI_API_KEY` serves only the built-in `openai` provider, not a custom provider. The existing workspace `trust_level` block SHALL be preserved. The injected credential SHALL be resolved from the **task owner's** account, NOT the earliest allowlisted account — the auth source SHALL be scoped by the task's owning account identity so one operator's compatible key is never used for another operator's tasks. When the owning account has NO compatible credential, resolution SHALL fall back to the existing official/deployment-level source unchanged, so official-mode and env-configured deployments are unaffected. The Base URL SHALL pass the same host-safety validation applied at discovery time before it is written into the sandbox. Because the launch argv has no per-task substitution seam, ALL compatible provider state SHALL be carried via the provision-time config files, not the codex launch flags.

#### Scenario: Compatible credential drives codex's provider, key, and model
- **WHEN** a task is provisioned for an account whose active Codex credential is `compatible` with a saved Base URL, API key, and default model
- **THEN** the sandbox receives a `~/.codex/config.toml` with a `[model_providers.*]` block whose `base_url` is the saved Base URL and `wire_api = "responses"`, the decrypted key delivered via `experimental_bearer_token` (or an `env_key` env var), and top-level `model_provider` + `model = "<defaultModel>"`, and NO `~/.codex/auth.json` is written for the compatible credential
- **AND** codex issues its model requests against the operator's Base URL and selected model, not the default OpenAI endpoint or codex's built-in default model

#### Scenario: Injected credential is scoped to the task owner
- **WHEN** two allowlisted operators each have a different compatible credential and operator B launches a task
- **THEN** the credential injected into operator B's task is operator B's, not the earliest-created allowlisted operator's

#### Scenario: Accounts without a compatible credential keep the official/env path
- **WHEN** a task is provisioned for an account that has no compatible credential (official mode, or none)
- **THEN** the orchestrator injects the existing official/deployment-level codex auth unchanged and does NOT write a compatible `[model_providers.*]` block

#### Scenario: Unsafe provider Base URL is not written into the sandbox
- **WHEN** a compatible credential's Base URL resolves to a loopback/private/link-local/metadata host or a non-http(s) scheme
- **THEN** the orchestrator does not write that Base URL into the codex config (the credential is treated as unusable for injection rather than fetched/targeted)

### Requirement: Provisioning and teardown delegate to the selected AgentRuntime
Per-task provisioning and pre-stop teardown SHALL delegate credential/config injection
and the launch command to the task's selected `AgentRuntime` (see `agent-runtime`)
instead of hard-coding codex auth.json + codex launch. For a `codex` task the behavior
SHALL be unchanged (inject `/home/gem/.codex/auth.json` + `config.toml`, trim
`/home/gem/.codex` and clear `auth.json` before stop). For a `claude-code` task,
provisioning SHALL instead inject the Claude credential as the `CLAUDE_CODE_OAUTH_TOKEN`
launch env (no auth file) and pre-seed `/home/gem/.claude/.claude.json` (global
onboarding + per-project trust), and the pre-stop trim SHALL target `/home/gem/.claude`
(removing cached/credential state while keeping the session transcript under
`/home/gem/.claude/projects/`) as the defense-in-depth analog of the codex trim. A
pre-stop trim failure SHALL NOT block the stop+retain.

#### Scenario: Codex provisioning/teardown is unchanged
- **WHEN** a `codex` task is provisioned and later torn down
- **THEN** auth.json/config.toml are injected and the `/home/gem/.codex` trim + auth.json
  clear run before stop, exactly as before

#### Scenario: Claude provisioning injects an env token and pre-seed, not an auth file
- **WHEN** a `claude-code` task is provisioned
- **THEN** the launch env carries `CLAUDE_CODE_OAUTH_TOKEN`, `/home/gem/.claude/.claude.json`
  is pre-seeded with global onboarding + per-project trust, and no `~/.codex/auth.json`
  is written

#### Scenario: Claude pre-stop trim targets the Claude HOME and keeps the transcript
- **WHEN** a `claude-code` task reaches a terminal state and the container is stopped+retained
- **THEN** `/home/gem/.claude` cached/credential state is trimmed while
  `/home/gem/.claude/projects/<slug>/<session-id>.jsonl` is kept, and a trim failure does
  not block the stop

### Requirement: The derived AIO image bakes a pinned Claude Code CLI
The derived AIO Sandbox image SHALL bake the Claude Code CLI at a PINNED version
alongside the pinned codex CLI (never `latest`), because the Claude launch relies on
`CLAUDE_CODE_SANDBOXED` and onboarding-suppression flags that are undocumented binary
internals and must not drift. The image SHALL be able to launch a `claude-code` task
without installing the CLI at provision time.

#### Scenario: Claude is present at a pinned version in the image
- **WHEN** the derived image is built and a `claude-code` task starts
- **THEN** `claude --version` reports the pinned version and no runtime install step is needed

### Requirement: Provisioning runs runtime-emitted setup commands uniformly, with no codex-inline code
Per-task provisioning SHALL obtain the selected runtime's `sandboxSetupCommands` and run
them via the shared `/v1/shell/exec` surface for EVERY runtime, with no codex-specific
inline injection in the provider. The provider SHALL NOT retain `injectCodexAuth`,
`injectTaskPrompt`, a `CODEX_HOME_DIR` constant used for inline writes, or any
`runtime.id === 'codex'` branch on the provision path. The prompt-file write (from
`task.prompt`) is shared mechanism applied uniformly; the credential/config bytes are
whatever the runtime's setup commands write. Provisioning SHALL still FAIL CLOSED on a
non-zero exit (tearing the container down) exactly as before.

#### Scenario: Codex and claude both provision through the same uniform path
- **WHEN** a `codex` task and a `claude-code` task are each provisioned
- **THEN** the provider runs each runtime's emitted setup commands via the same exec
  helper, the provider source contains no `injectCodexAuth`/`id === 'codex'`, and the
  exec commands codex produces are byte-identical to the v0.6.0 inline `injectCodexAuth`
  (golden-tested)

#### Scenario: A broken runtime setup still fails closed
- **WHEN** a runtime's setup commands exit non-zero (e.g. claude with no token)
- **THEN** provisioning tears the container down and surfaces the failure rather than
  starting an unusable sandbox — unchanged from before

### Requirement: Pre-stop trim runs runtime-emitted trim commands uniformly
Pre-stop teardown SHALL obtain the selected runtime's `preStopTrimCommands` and run them
via the shared exec for EVERY runtime, with no `runtime.id === 'codex'` branch and no
inline `trimCodexHomeBeforeStop` in the provider. Codex's trim commands SHALL keep the
session transcript while removing cache/credential state, byte-identical to the prior
inline trim (golden-tested); a trim failure SHALL NOT block the stop+retain.

#### Scenario: Trim is uniform and codex-byte-identical
- **WHEN** a terminal codex task is stopped+retained
- **THEN** the provider runs codex's emitted trim commands (which match the prior
  inline trim byte-for-byte) via the shared exec, with no codex-specific branch, and a
  trim error does not block the stop

### Requirement: The pty client's terminal mechanism is driven by declared policy
The pty client SHALL drive its DSR/CPR/output-quiescence handshake from the runtime's
declared `terminalStartup` policy rather than an agent-identity flag (`launchedCodex` /
`runtime.id === 'codex'`). The detached-tmux launch wrapper and `$(cat <prompt-file>)`
positional-prompt delivery SHALL be built once as shared mechanism from the runtime's
`{ argv, env }`, identically for all runtimes. The completion probe SHALL call only
`runtime.detectExit` (no inline `hasSession` duplicate of codex's probe).

#### Scenario: One launch mechanism, runtime supplies only argv/env
- **WHEN** any runtime's task launches
- **THEN** the pty client wraps the runtime's `{ argv, env }` in the SAME detached-tmux
  + `$(cat <prompt-file>)` shell line, and the codex launch-line string is byte-identical
  to v0.6.0 (golden-tested)

#### Scenario: Liveness uses the runtime's single exit source
- **WHEN** the liveness poller checks whether a task is done
- **THEN** it calls `runtime.detectExit` (codex: `tmux has-session`; claude: transcript
  `end_turn` then `kill-session`) and contains no inline codex has-session duplicate

### Requirement: Container transcript read resolves the per-runtime artifact path
The in-place container transcript read (`readRolloutFromContainer`) SHALL resolve the directory and
filename glob to pull FROM the task's runtime via the declared `transcriptArtifact(ctx)`, rather than
hardcoding `~/.codex/sessions` + `rollout-*.jsonl`. It reads a retained/stopped `cap-aio-<taskId>`
container's frozen layer in place (without restarting it), and SHALL stream ONLY that transcript path
out of the container (never `auth.json` or any credential file), return the newest matching file's raw
text, and return `null` on a miss (no artifact present, container reaped/expired, or read error) so
callers fall back honestly. This read feeds every transcript surface (MCP `get_transcript`, `/v1`
transcript, session-history, durable capture); consequently a finished `claude-code` task SHALL no
longer report `no-rollout`.

#### Scenario: Codex task reads its rollout path
- **WHEN** the transcript of a finished `codex` task is read from its retained container
- **THEN** the read pulls `~/.codex/sessions/**/rollout-*.jsonl` (the runtime-declared artifact) and returns the newest rollout's raw JSONL

#### Scenario: Claude task reads its projects JSONL (no more no-rollout)
- **WHEN** the transcript of a finished `claude-code` task is read from its retained container
- **THEN** the read pulls `~/.claude/projects/<slug>/<session-id>.jsonl` (the runtime-declared artifact) and returns its raw JSONL — not an empty `no-rollout`

#### Scenario: Only the transcript is pulled, never credentials
- **WHEN** the container transcript read runs for any runtime
- **THEN** it streams only the declared transcript directory out of the container and never extracts `auth.json` or other credential files

#### Scenario: A missing artifact returns null
- **WHEN** the runtime's transcript path is absent (agent never produced one, or the container was reaped)
- **THEN** the read returns `null` and the caller maps it to an honest `empty`/`expired` state

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

