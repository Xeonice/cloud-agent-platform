# aio-sandbox-execution Specification

## Purpose
TBD - created by applying change migrate-execution-to-aio-sandbox. Update Purpose after archive.
## Requirements
### Requirement: Per-task AIO Sandbox container provisioning

The system SHALL provision exactly one AIO Sandbox container per task via dockerode
`createContainer`, name it `cap-aio-<taskId>`, use the selected pinned image, keep
`AutoRemove=false`, attach it to the configured AIO network without host port bindings,
and confirm `/v1/docs` readiness before use. Destructive lifecycle operations SHALL pin
the freshly inspected immutable container id and, when ownership metadata is present,
the resource generation.

A terminal container MAY be stopped and retained only after every runtime-private path
(including Codex auth/config/prompt, Claude launch env/settings/onboarding/prompt, and
CAP image parameters) has been removed and absence-checked while the container is
running. Cache trimming may be non-essential, but private-material cleanup is a strict
retention gate. A non-zero or unresolved exit, timeout, thrown/lost response, malformed
result, or a container that was already stopped before cleanup SHALL force-remove the
exact container id and require authoritative not-found confirmation. The primary task
outcome remains authoritative, but an unproven credential-bearing filesystem SHALL NOT
be retained.

#### Scenario: Container is created with required isolation and readiness options

- **WHEN** AIO provisions `<taskId>`
- **THEN** it creates `cap-aio-<taskId>` from the selected image with
  `seccomp=unconfined`, the configured AIO network, `AutoRemove=false`, and no host port
  bindings
- **AND** it returns only after `/v1/docs` readiness succeeds

#### Scenario: Confirmed private cleanup permits stopped retention

- **WHEN** every selected runtime and image-parameter private path is removed and
  absence-checked successfully
- **THEN** AIO may stop and retain the exact container so declared transcript artifacts
  remain readable
- **AND** credential/config/prompt files are absent from that retained filesystem

#### Scenario: Unconfirmed cleanup sacrifices retention

- **WHEN** any private cleanup command is non-zero, unresolved, timed out, throws, or
  loses its response
- **THEN** AIO force-removes the exact immutable container id and confirms it is absent
- **AND** it does not stop-retain the container merely to preserve history

#### Scenario: Externally stopped container has no cleanup proof

- **WHEN** teardown finds the exact task container already stopped before its cleanup
  hook can run
- **THEN** AIO removes and confirms absence of that container instead of treating the
  stopped state as cleanup success

### Requirement: SandboxConnection handle returned from provisioning
The `AioSandboxProvider.provision()` SHALL accept a provider-neutral provision context carrying the task id and optional clone spec. The clone spec SHALL be resolved before provider selection and passed into the selected provider, so the local AIO provider does not need API-local task lookup logic. The provider SHALL return a `SandboxConnection` handle carrying `taskId`, an HTTP `baseUrl` of the form `http://cap-aio-<taskId>:8080`, and a `wsUrl` of the form `ws://cap-aio-<taskId>:8080/v1/shell/ws`, so that the orchestrator can address the sandbox by container name over `cap-net` and open the terminal WebSocket. The provider SHALL also clone the task repository into a DEDICATED, EMPTY workspace directory (e.g. `/home/gem/workspace`) — never into the non-empty `/home/gem` HOME — via `POST /v1/shell/exec` before returning the handle. The provider SHALL PARSE the `/v1/shell/exec` response body, treating a non-zero command `exit_code` (not merely a non-`ok` HTTP status) as a provisioning failure, and SHALL surface a real provision error rather than logging success on a silent clone failure.

The clone success path and the clone fail-closed path SHALL be VERIFIED END-TO-END on a live compose stack (not merely unit-tested), as fossilized black-box regression scenarios in the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`): cloning into the dedicated empty workspace directory SHALL succeed with an asserted zero `exit_code`; a FORCED clone failure (non-empty target directory or bad repository URL) SHALL raise a non-zero exit_code with NO silent success. The `AioApprovalEnforcer` exec-gate is NOT verified end-to-end in this change: the enforcer class is fail-closed (covered by unit tests) but is currently DORMANT — there are no cap-owned gated `/v1/shell/exec` call sites in production code that route through it (it is wired as a DI provider for future use); see the `agent-events-and-approvals` spec for the honest coverage statement.

#### Scenario: Provision receives an explicit clone spec
- **WHEN** the API admits a task and selects the local AIO provider
- **THEN** it passes a provision context containing the task id and the resolved clone spec
- **AND** the provider uses that clone spec for repository setup instead of reading task state through API internals

#### Scenario: AIO remains the default local provider
- **WHEN** no cloud sandbox provider is configured
- **THEN** task provisioning uses the local AIO provider through the shared sandbox facade
- **AND** the returned connection remains addressable by container name over `cap-net`

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

### Requirement: codex launched in-shell over the terminal channel

For an AIO-backed interactive task, CAP SHALL launch Codex inside the sandbox over the
AIO `/v1/shell/ws` terminal transport and SHALL NOT substitute request/response exec or
MCP for the interactive TUI. `CodexRuntime` SHALL contribute
`--dangerously-bypass-approvals-and-sandbox`; the provider-neutral `@cap-console/sandbox`
session engine SHALL build the detached tmux launch, apply the runtime's startup policy,
and attach; `@cap-console/sandbox-provider-aio` SHALL own only the AIO transport and command
execution mechanics. API terminal code SHALL NOT recreate an AIO-specific launch helper.

The task's operator prompt SHALL be obtained through the host-harness provisioning
lookup, written through the selected provider's opaque private-file transport to
`/home/gem/.codex/task-prompt.txt`, and passed as one positional argument through a
`$(cat <prompt-file>)` shell expansion. Prompt content, including quotes, substitutions,
newlines, or flag-like text, SHALL never be inlined into the launch command or ordinary
exec request. Empty prompt opens a blank composer. A prompt write failure fails
provisioning closed.

Because the positional prompt pre-fills rather than submits the Codex composer, the
shared session engine SHALL inject one carriage return exactly once only after the
runtime-declared startup DSR has been observed and output has quiesced. A failure to
auto-submit SHALL degrade to a still-prefilled composer, never a goal silently executed
by the shell.

The derived AIO image SHALL be built from the pinned AIO base and install the release
workflow's documented `CODEX_VERSION` (currently 0.144.1 at this change boundary). It
SHALL expose a compatibility `CODEX_LAUNCH_ARGV` matching the runtime bypass policy, but
that image ENV SHALL NOT override the selected runtime policy in the orchestrator. The
image SHALL NOT bake the obsolete `~/.codex/hooks.json`, hook dependency tree, or
`/opt/cap/dist/hooks`; bypass-mode tasks do not claim hook-based approval or reporting.

#### Scenario: AIO interactive Codex uses the provider-neutral launch path

- **WHEN** an AIO-backed interactive Codex task begins execution
- **THEN** the shared session engine starts it over `/v1/shell/ws` in the exact task tmux
  session
- **AND** the argv includes `--dangerously-bypass-approvals-and-sandbox`
- **AND** it does not contain the legacy
  `--ask-for-approval never --sandbox danger-full-access` combination
- **AND** API code does not instantiate an AIO-specific launch client

#### Scenario: Task prompt is injected as a shell-safe file

- **WHEN** a non-empty task prompt is provisioned
- **THEN** it is written through the provider-private file channel at
  `/home/gem/.codex/task-prompt.txt`
- **AND** the launch reads it through `$(cat ...)` as one positional prompt argument
- **AND** prompt text that mentions `-s`, `--yolo`, or bypass flags remains data

#### Scenario: Prefilled prompt is auto-submitted after verified startup

- **WHEN** the startup DSR has been observed and the initial TUI render quiesces
- **THEN** the shared mechanism injects exactly one carriage return
- **AND** it never injects that key while the shell, rather than Codex, owns the terminal

#### Scenario: Derived image pins parsable YOLO launch flags without dead hooks

- **WHEN** the exact released AIO image is inspected and parser-probed
- **THEN** its Codex version matches the documented build arg/release workflow
- **AND** interactive and `codex exec` help accept the required bypass flag
- **AND** `~/.codex/hooks.json` and `/opt/cap/dist/hooks` are absent from the final image

#### Scenario: Empty prompt and injection failure remain deterministic

- **WHEN** the prompt is empty
- **THEN** Codex starts with a blank composer and no empty-string positional argument
- **AND** WHEN a non-empty prompt cannot be written, provisioning fails closed before
  launch

### Requirement: Exit detection mapped to guardrails

The provider-neutral session engine SHALL determine task termination from the selected
runtime's exact detached-session liveness and settled exit evidence, not from a provider
PTY or browser WebSocket close. A disconnect while the detached session is alive SHALL
not report a terminal outcome. A settled zero exit maps to success; non-zero or abnormal
termination maps to failure; unresolved settlement SHALL never be promoted to success.
At this transitional archive boundary, owner PTY output SHALL continue through the
provider-neutral gateway recording/replay path rather than an AIO-specific client.

#### Scenario: Transport close does not finish a live task

- **WHEN** a browser or provider PTY closes while the exact detached task session is
  still alive
- **THEN** no success or failure is reported and the task remains eligible for
  re-adoption

#### Scenario: Settled lifecycle evidence determines the outcome

- **WHEN** the runtime reports the session gone and exit settlement completes
- **THEN** exit zero reports success and non-zero or abnormal termination reports
  failure
- **AND** an unresolved result is not treated as success

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

Per-task provisioning, launch, transcript declaration, and pre-stop cleanup SHALL
delegate to the task's selected `AgentRuntime` rather than hard-code one agent in the
provider. Runtime credential, config, onboarding, and prompt bytes SHALL use the
provider-private one-shot file channel; ordinary exec requests SHALL contain only fixed
paths, modes, and verification logic. Codex cleanup SHALL preserve `sessions/` while
removing and proving absence of `auth.json`, `config.toml`, and the prompt. Claude cleanup
SHALL preserve `projects/` while removing and proving absence of `launch-env.sh`,
settings/onboarding state, and the prompt. Any failed private cleanup SHALL activate the
exact-container removal gate.

#### Scenario: Codex and Claude use one strict runtime hook path

- **WHEN** Codex and Claude tasks provision and later tear down
- **THEN** the provider invokes each selected runtime's private files, setup commands,
  transcript artifact, and cleanup commands through the same neutral hook surface
- **AND** no runtime credential or prompt appears in an ordinary exec request

#### Scenario: Runtime-private cleanup is fail closed

- **WHEN** a selected runtime cannot prove its private paths absent
- **THEN** the provider removes the exact sandbox instead of retaining it

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

Per-task provisioning SHALL consume the selected runtime's ordered setup plan through
one provider-neutral path. Secret-bearing configuration, credential, onboarding, and
prompt bytes SHALL be emitted as opaque `privateFiles` and transferred only through the
selected provider's private-file port. The accompanying ordinary setup command SHALL
contain fixed paths, modes, and verification logic only. Neither AIO nor the shared host
harness SHALL reconstruct those bytes as base64 shell commands or branch on the runtime
id. Any private-file or required setup-command failure SHALL fail provisioning closed.

#### Scenario: Both runtimes use the same private setup path

- **WHEN** Codex and Claude Code setup plans are provisioned on AIO
- **THEN** every private file is consumed by the provider-private transport before its
  associated ordinary setup command
- **AND** the ordinary command and serialized plan contain no raw or derived secret
  material

#### Scenario: A required setup result is unresolved

- **WHEN** a private write, mode verification, or required setup command has a non-zero,
  timed-out, thrown, malformed, or otherwise unresolved result
- **THEN** provisioning fails closed and exact sandbox cleanup runs

### Requirement: Pre-stop trim runs runtime-emitted trim commands uniformly

Pre-stop teardown SHALL run every selected runtime's emitted cleanup command through the
shared command executor. A command succeeds only with a settled, non-timeout exit code
zero. Arbitrary guest output or transport error text SHALL NOT be copied into persistent
logs or public errors. A failure SHALL block stopped retention and trigger exact sandbox
removal; it SHALL NOT be downgraded to a warning.

#### Scenario: Uniform cleanup succeeds before retention

- **WHEN** all runtime cleanup commands settle with exit zero
- **THEN** teardown may proceed to stop-retain the sandbox

#### Scenario: Uniform cleanup uncertainty removes the sandbox

- **WHEN** a runtime cleanup command fails or its settlement is unknown
- **THEN** teardown force-removes and confirms absence of the exact sandbox
- **AND** the surfaced diagnostic contains stable stage/task context but no guest output

### Requirement: The pty client's terminal mechanism is driven by declared policy

The provider-neutral terminal session engine SHALL drive startup DSR/CPR and prompt
submission from the selected runtime's declared `terminalStartup` policy. It SHALL build
the detached tmux launch and file-backed prompt mechanism once for every runtime, and
SHALL call the runtime's `detectExit` rather than duplicate an agent-specific liveness
probe. Provider packages SHALL contribute only normalized PTY transport and command
execution mechanics.

#### Scenario: One shared launch mechanism consumes runtime policy

- **WHEN** either supported runtime starts an interactive task
- **THEN** the shared session engine composes its launch, startup, and liveness policy
- **AND** neither the AIO transport nor API terminal code branches on the runtime id

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

### Requirement: Detached tmux terminal sessions are UTF-8 aware
The shared terminal launch and attach path SHALL run tmux in UTF-8 mode for interactive detached sessions so multibyte terminal output is preserved even when the sandbox login environment does not expose a UTF-8 locale. This SHALL apply to fresh detached session creation and to attaching or re-attaching the provider terminal bridge to the task's named tmux session.

#### Scenario: Fresh detached session uses UTF-8 tmux mode
- **WHEN** the orchestrator builds the detached tmux launch command for an interactive task
- **THEN** the command invokes tmux in UTF-8 mode before creating the named session

#### Scenario: Re-attach uses UTF-8 tmux mode
- **WHEN** the terminal bridge attaches to an existing task tmux session
- **THEN** the attach command invokes tmux in UTF-8 mode so non-ASCII output is not rendered as underscores

### Requirement: Browser resize reaches the detached tmux window

The shared provider-neutral session engine SHALL propagate authoritative browser
geometry to both the selected provider PTY transport and the exact detached tmux window.
The tmux resize is best-effort for stale-session races and SHALL not introduce an
AIO-specific browser or launch client.

#### Scenario: Resize updates transport and detached window

- **WHEN** the current writer supplies valid terminal columns and rows
- **THEN** the selected provider transport receives that geometry
- **AND** the exact task tmux window receives a matching resize operation

### Requirement: AIO provisions from a resolved Docker-image environment

The AIO provider SHALL provision a task container from the resolved sandbox
environment when the environment source is compatible with AIO Docker-image
execution. If task creation omits an environment and no managed default exists,
AIO SHALL continue to use the existing deployment-level `AIO_SANDBOX_IMAGE`
fallback. The effective image SHALL remain pinned or resolved to immutable digest
metadata for auditability.

#### Scenario: Selected AIO environment overrides deployment image

- **WHEN** a task selects a ready AIO-compatible Docker-image environment
- **THEN** AIO creates the task container from that resolved image source
- **AND** it does not use `AIO_SANDBOX_IMAGE` for that task

#### Scenario: Omitted environment preserves current AIO default

- **WHEN** a task omits `sandboxEnvironmentId` and no managed default environment
  is configured
- **THEN** AIO provisions from the existing pinned `AIO_SANDBOX_IMAGE`
- **AND** existing deployments continue to provision as before

#### Scenario: Incompatible environment never reaches createContainer

- **WHEN** a task selects a BoxLite-only rootfs environment on an AIO deployment
- **THEN** task admission or provider selection rejects the task before
  dockerode `createContainer` is called
- **AND** no fallback AIO container is created from the deployment image

#### Scenario: AIO run records effective image metadata

- **WHEN** AIO provisions a task from a managed environment
- **THEN** the sandbox run metadata records the environment id and effective
  image reference or digest used for the container

### Requirement: AIO provisions selected image parameters and clears them before retention

The AIO provisioning path SHALL write selected image parameters through the opaque
provider-private file channel to `/home/gem/.cap/image-env` before runtime setup. Neither
raw values nor derived encodings SHALL enter ordinary exec requests, argv, serialized
plans, logs, or public errors. Before retention, teardown SHALL remove the file and prove
it absent; cleanup uncertainty SHALL force exact sandbox removal.

#### Scenario: AIO task receives image parameters privately before agent launch

- **WHEN** an AIO task has selected image parameters
- **THEN** the provider-private channel writes mode-0600 `/home/gem/.cap/image-env`
  before runtime launch
- **AND** ordinary setup requests contain paths and verification only

#### Scenario: Image parameter cleanup is a retention gate

- **WHEN** `/home/gem/.cap/image-env` deletion or absence verification fails
- **THEN** the exact AIO sandbox is removed and confirmed absent

#### Scenario: Arbitrary setup diagnostics disclose no parameter material

- **WHEN** private-file transfer, verification, or later setup fails with attacker-chosen
  output
- **THEN** raw, base64, base64url, hex, and split parameter sentinels occur zero times in
  persistent logs, serialized errors, and command requests

### Requirement: AIO workspace materialization injects the repo copy via read-only subpath mount

The aio-local provider SHALL materialize the task workspace from the Repo's stored copy by mounting only that repo's bare mirror into the sandbox container read-only (docker volume subpath mount of `/repo-store/<repoId>.git`, requiring Docker Engine ≥ 26 semantics) and then performing a local `git clone` from the mounted path into the workspace directory inside the sandbox. The in-sandbox local clone SHALL handle git ownership checks (`safe.directory`) for the mounted path. No network git clone SHALL run inside the sandbox on this path.

#### Scenario: Materialization is a local clone from the mount
- **WHEN** an aio-local task provisions with a ready copy
- **THEN** the container is created with a read-only subpath mount of that repo's bare mirror
- **AND** the workspace is produced by a local clone from the mount, succeeding under the sandbox's non-root user

#### Scenario: Mount grants no write and no cross-repo visibility
- **WHEN** the agent inspects the mount path
- **THEN** it is read-only and contains only the task's repo copy

### Requirement: Optional cloud sandbox provider configuration is capability gated
The API MAY register a managed HTTP sandbox provider when `CAP_SANDBOX_CLOUD_HTTP_BASE_URL` is configured. That provider SHALL advertise only configured capabilities, SHALL default to `terminal.websocket` when no explicit capability list is provided, and SHALL NOT be selected for requirements it does not advertise. Local AIO priority and cloud priority SHALL be configurable, and `CAP_SANDBOX_PREFER_LOCATION` MAY bias equivalent candidates.

#### Scenario: Cloud provider is not registered without a base URL
- **WHEN** `CAP_SANDBOX_CLOUD_HTTP_BASE_URL` is unset
- **THEN** no cloud HTTP provider is registered
- **AND** local AIO remains available as the default provider

#### Scenario: Cloud capabilities gate selection
- **WHEN** the cloud HTTP provider is configured with a limited capability set
- **THEN** it is only eligible for tasks whose required capabilities are fully covered by that set
- **AND** tasks requiring unsupported capabilities select another provider or fail closed

#### Scenario: No eligible provider fails closed
- **WHEN** task provisioning requires capabilities that no registered provider satisfies
- **THEN** the task is failed with a provision failure rather than silently falling back to an incompatible provider

### Requirement: AIO provider orchestration lives in the AIO provider package

The full AIO backend implementation SHALL live in `@cap-console/sandbox-provider-aio`, including Docker lifecycle, readiness, runtime setup hooks, workspace materialization, terminal and command descriptors, AIO transport lifecycle and wire translation, command executor protocol handling, retention behavior, transcript/readoption support, and provider descriptor registration. The provider-neutral agent terminal session engine SHALL live in `@cap-console/sandbox` and compose the AIO transport through its descriptor. API code SHALL only provide neutral host harness ports such as persistence adapters, runtime registries, auth/material lookup, skill installers, approval sinks, and Nest wiring.

#### Scenario: AIO provision does not require API provider class logic
- **WHEN** `@cap-console/sandbox-provider-aio` is built and tested independently
- **THEN** it can provision, describe, command, retain, readopt, and tear down AIO sandboxes through its exported provider implementation
- **AND** it does not rely on `apps/api/src/sandbox/aio-sandbox.provider.ts` for lifecycle orchestration

#### Scenario: AIO is registered by the sandbox host harness
- **WHEN** CAP registers configured sandbox providers
- **THEN** `@cap-console/sandbox` creates the AIO descriptor from `@cap-console/sandbox-provider-aio` using neutral host harness hooks
- **AND** API code does not import AIO provider factories, controllers, Docker clients, AIO env readers, AIO command executors, or AIO terminal transports

#### Scenario: AIO terminal backend is composed with the shared session engine
- **WHEN** an AIO-backed task terminal is opened
- **THEN** `@cap-console/sandbox` provides launch-or-attach, initial-ready sequencing, runtime-declared DSR/CPR behavior, tmux liveness, and normalized exit handling through its shared session engine
- **AND** `@cap-console/sandbox-provider-aio` provides AIO frame translation, provider transport lifecycle, and AIO command/wait protocol handling behind the descriptor factory
- **AND** `apps/api/src/terminal` does not instantiate an AIO PTY client or AIO terminal transport

### Requirement: AIO provider e2e runs without CAP API backend

The AIO provider package SHALL include an e2e suite that starts real AIO resources and validates the provider lifecycle without starting the CAP API backend or production web app.

#### Scenario: AIO e2e validates real provision and exec
- **WHEN** AIO provider e2e runs with Docker and the AIO e2e image available
- **THEN** it creates a real task-scoped AIO container through the provider package
- **AND** it waits for readiness and verifies command execution inside that container

#### Scenario: AIO e2e validates selected-run descriptors
- **WHEN** AIO provider e2e provisions a sandbox
- **THEN** it verifies the selected run contains the AIO provider id, provider sandbox id, connection, `aio-json-v1` terminal descriptor, `aio-http-exec-v1` command descriptor, workspace descriptor, capabilities, and retention policy

#### Scenario: AIO e2e validates readoption after provider instance restart
- **WHEN** the AIO e2e suite creates a sandbox and then constructs a new provider instance
- **THEN** the new instance can discover or reattach the existing task sandbox through provider readoption
- **AND** operations route through the readopted provider owner

#### Scenario: AIO e2e cleans up real resources
- **WHEN** an AIO provider e2e test completes or fails
- **THEN** it removes or stops all task-scoped e2e AIO containers and any e2e-only Docker network it created

### Requirement: Codex headless tasks load file-stored credentials without sandbox-to-owner writeback

A `headless-exec` Codex task SHALL set `cli_auth_credentials_store = "file"` and load the
task owner's resolved official `auth.json` through the same provider-private injection
path used by interactive Codex. CAP SHALL NOT read a post-run `auth.json` from an
autonomous YOLO sandbox or persist sandbox-modified credential bytes back to the owner's
database row. Rotation that requires durable owner credential renewal needs a future
host-owned auth broker or independently authenticated refresh flow.

#### Scenario: Codex headless loads the file-stored credential

- **WHEN** an official-credential headless Codex task starts
- **THEN** config selects the file credential store and Codex loads the injected private
  auth file without a keyring

#### Scenario: Autonomous sandbox cannot overwrite owner credential

- **WHEN** Codex or task code modifies `/home/gem/.codex/auth.json`
- **THEN** teardown never reads that file into CAP and never updates the owner's stored
  credential from it
- **AND** cleanup removes the sandbox copy or removes the whole sandbox

