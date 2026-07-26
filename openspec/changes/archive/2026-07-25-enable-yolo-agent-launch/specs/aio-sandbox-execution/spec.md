## MODIFIED Requirements

### Requirement: codex launched in-shell over the terminal channel

For an AIO-backed interactive task, CAP SHALL launch Codex inside the sandbox over the
AIO `/v1/shell/ws` terminal transport and SHALL NOT substitute request/response exec or
MCP for the interactive TUI. `CodexRuntime` SHALL contribute
`--dangerously-bypass-approvals-and-sandbox`; the provider-neutral `@cap/sandbox`
session engine SHALL build the detached tmux launch, apply the runtime's startup policy,
and attach; `@cap/sandbox-provider-aio` SHALL own only the AIO transport and command
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

### Requirement: Browser resize reaches the detached tmux window

The shared provider-neutral session engine SHALL propagate authoritative browser
geometry to both the selected provider PTY transport and the exact detached tmux window.
The tmux resize is best-effort for stale-session races and SHALL not introduce an
AIO-specific browser or launch client.

#### Scenario: Resize updates transport and detached window

- **WHEN** the current writer supplies valid terminal columns and rows
- **THEN** the selected provider transport receives that geometry
- **AND** the exact task tmux window receives a matching resize operation

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Codex headless tasks load a file-stored credential and persist its refresh

**Reason**: A YOLO sandbox runs owner-controlled and repository-controlled code under the
same UID as Codex. Treating its mutable `auth.json` as authoritative would let the
sandbox overwrite the owner's long-lived credential. The previous capture path also
conflicted with strict private-file cleanup.

**Migration**: Continue file-store authentication through the provider-private channel,
but never copy sandbox-modified auth back to CAP. Implement future token rotation through
a host-owned broker or an independently authenticated owner/revision-bound refresh flow.

### Requirement: Blocking approval hooks re-homed via outbound HTTP callback

**Reason**: No production bypass-mode task registers the historical hook: AIO now omits
the hook artifacts and callback environment, BoxLite never shipped them, and Codex task
setup removes any inherited `~/.codex/hooks.json`. The private callback may remain as a
dormant compatibility surface, but it is not an AIO task execution contract.

**Migration**: Interactive autonomous execution relies on the per-task sandbox boundary
and post-hoc runtime/workspace evidence. `SandboxApprovalEnforcer` remains fail closed if
explicitly invoked, but it has no production exec call site and cannot be described as a
fallback. A future command-approval feature must add and verify an actual brokered caller.

### Requirement: AioPtyClient connects into the sandbox terminal without session_id

**Reason**: The API-local `AioPtyClient` no longer exists after the provider-center
refactor. Shared launch/attach behavior belongs to the provider-neutral terminal session
engine, while the AIO package owns only its normalized `/v1/shell/ws` transport.

**Migration**: Use the sandbox terminal harness and the AIO terminal transport behind
the provider descriptor. Browser code continues to use only CAP's terminal protocol.

### Requirement: Synthetic CPR injection so codex starts

**Reason**: Startup response behavior is no longer an AIO-client contract. It is driven
by each runtime's declared `terminalStartup` policy in the shared session engine.

**Migration**: Preserve the byte-exact DSR observation and runtime-selected CPR response
through the provider-neutral session engine; do not recreate an AIO-specific detector.

### Requirement: JSON to cap-frame translation preserving the browser protocol

**Reason**: The deleted API-local client no longer owns both sides of the bridge. AIO
wire translation now belongs to the AIO terminal transport, while the CAP browser
protocol remains owned by the provider-neutral gateway and sandbox terminal harness.

**Migration**: Keep `/v1/shell/ws` frame translation inside
`@cap/sandbox-provider-aio` and expose only normalized PTY events to the shared terminal
layer.
