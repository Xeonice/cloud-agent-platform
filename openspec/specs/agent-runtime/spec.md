# agent-runtime Specification

## Purpose
TBD - created by archiving change add-claude-code-runtime. Update Purpose after archive.
## Requirements
### Requirement: AgentRuntime port abstracts per-agent execution seams
The system SHALL define an `AgentRuntime` port that encapsulates the agent-specific
execution seams as declarative policy — `buildLaunchLine` (contributing `{ argv, env }`),
`terminalStartup`, `sandboxSetupCommands`, `preStopTrimCommands`, and `detectExit` — with
two implementations, `CodexRuntime` and `ClaudeCodeRuntime`, selected per task by the
task's `runtime` value. The port owns no I/O (see "The runtime is a policy object that
owns no I/O"). The shared execution scaffolding — the per-task AIO Sandbox container, the
detached tmux session, the `/v1/shell/ws` PTY client, the asciicast capture/replay
pipeline, the liveness poller, and boot re-adoption — SHALL remain runtime-agnostic and
SHALL NOT branch on agent identity except through the port. Extracting the existing codex
logic behind `CodexRuntime` SHALL be behavior-preserving: codex task launch, sandbox
credential/config setup, prompt submit, exit detection, and transcript capture SHALL
remain byte-for-byte unchanged.

#### Scenario: Codex extraction preserves behavior
- **WHEN** a `codex` task is provisioned and launched after the refactor
- **THEN** the codex launch argv, the `auth.json`/`config.toml` sandbox-setup writes, the
  DSR-gated prompt submit, and the `tmux has-session` exit detection are identical to
  before, and the existing codex end-to-end suite passes unchanged

#### Scenario: Runtime is selected from the task
- **WHEN** a task with `runtime = claude-code` is admitted
- **THEN** the orchestrator resolves the `ClaudeCodeRuntime` implementation, and a
  task with `runtime = codex` (or absent) resolves `CodexRuntime`

### Requirement: ClaudeCodeRuntime launch line and sandbox flags
`ClaudeCodeRuntime.buildLaunchLine()` SHALL launch the interactive Claude Code CLI in
a detached tmux session named `task<taskId>` with working directory the cloned
workspace, of the form `claude --session-id <uuid> --permission-mode acceptEdits "<prompt>"`,
where the prompt is delivered via the codex-style `$(cat <prompt-file>)` shape so the
prompt text is never inlined into the command (shell-injection-safe). The launch
environment SHALL set `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (so the TUI renders
inline in the normal buffer for capture), `CLAUDE_CODE_SANDBOXED=1` (so the workspace
trust gate is short-circuited), and `CLAUDE_CONFIG_DIR=/home/gem/.claude`. The runtime
SHALL NOT use `claude attach`, `claude agents`, `--dangerously-skip-permissions`,
`--bare`, or `--no-session-persistence` (each breaks the inline-buffer, auth, or
transcript assumptions).

#### Scenario: Claude launches autonomously with no blocking prompt
- **WHEN** a `claude-code` task is launched in a freshly provisioned sandbox
- **THEN** Claude runs the prompt without a trust dialog, theme/onboarding screen, or
  tool-approval prompt, and executes Bash and edit tools without asking

#### Scenario: Inline buffer is pinned for replay
- **WHEN** the Claude TUI byte stream is captured
- **THEN** it contains no alternate-screen enter sequence (`ESC[?1049h`) and replays
  through the existing asciicast pipeline with no buffer-mode branching

### Requirement: Provision-time trust and onboarding pre-seed
At provision time the runtime SHALL pre-seed the Claude global config file that Claude
actually reads — **`$HOME/.claude.json`** (the sandbox HOME root, e.g. `/home/gem/.claude.json`),
NOT `$CLAUDE_CONFIG_DIR/.claude.json` — with the GLOBAL onboarding keys (`theme`,
`hasCompletedOnboarding`) AND the per-project trust entry
(`projects[<canonicalized-workspace>].hasTrustDialogAccepted = true`,
`hasCompletedProjectOnboarding = true`), because the per-project trust entry alone does NOT
suppress the first-run global theme/onboarding screen. `CLAUDE_CONFIG_DIR` relocates only the
`.claude` DIRECTORY (settings, cache, `projects/` transcripts); the main `.claude.json` stays
at the HOME root regardless, so seeding it inside `$CLAUDE_CONFIG_DIR` is ignored (Claude
creates a fresh un-onboarded `$HOME/.claude.json` and runs the full onboarding). This is the
Claude analog of codex's `config.toml` trust step.

#### Scenario: First interactive launch is not blocked by onboarding
- **WHEN** Claude starts for the first time in the sandbox HOME with the pre-seed present
- **THEN** no theme-selection or onboarding screen appears and the prompt auto-runs

#### Scenario: Pre-seed targets the HOME-root config Claude reads
- **WHEN** the runtime emits the provision-time pre-seed for a `claude-code` task
- **THEN** the `.claude.json` carrying `theme` + `hasCompletedOnboarding` is written to the
  sandbox HOME root (`$HOME/.claude.json`), which is the file Claude reads on startup —
  not `$CLAUDE_CONFIG_DIR/.claude.json`

#### Scenario: Skipping onboarding lets the injected token authenticate without a prompt
- **WHEN** the HOME-root pre-seed marks `hasCompletedOnboarding:true` and `CLAUDE_CODE_OAUTH_TOKEN`
  is injected
- **THEN** Claude skips the entire onboarding flow (theme AND auth) and authenticates with the
  injected token, with no `/login` or token prompt

### Requirement: ClaudeCodeRuntime credential injection via env token
`ClaudeCodeRuntime` SHALL authenticate Claude by contributing the
`CLAUDE_CODE_OAUTH_TOKEN` environment variable to the launch environment — via its
declared launch env / `sandboxSetupCommands` rather than an `injectAuth()` method —
sourced from a `ClaudeAuthSource` port. The launch path SHALL guarantee that
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and any `apiKeyHelper` are UNSET in the
sandbox before launch, because a non-empty value silently shadows the OAuth subscription
token. When no Claude token is configured, a `claude-code` task SHALL fail-closed with a
distinct "runtime not configured" reason rather than launching unauthenticated.

#### Scenario: Token authenticates in a clean sandbox
- **WHEN** `CLAUDE_CODE_OAUTH_TOKEN` is injected into a sandbox with no keychain and no
  pre-existing `~/.claude.json` login
- **THEN** Claude reaches the API and runs the task without a `/login` prompt

#### Scenario: Stray API key is neutralized
- **WHEN** the sandbox environment would otherwise carry a non-empty `ANTHROPIC_API_KEY`
- **THEN** the launch path unsets it so the OAuth token is the credential actually used

#### Scenario: Missing token fails closed
- **WHEN** a `claude-code` task is admitted but no Claude token is configured
- **THEN** the task is marked failed with a "runtime not configured" reason and no
  unauthenticated Claude process is started

### Requirement: ClaudeAuthSource port with environment source
The system SHALL define a `ClaudeAuthSource` port returning the Claude OAuth token, with
an `EnvClaudeAuthSource` implementation that reads `CLAUDE_CODE_OAUTH_TOKEN`, mirroring
the existing `EnvCodexAuthSource` fallback. The port SHALL NOT expose the token on any
read-back/status path; only a boolean "configured" fact is exposed.

#### Scenario: Env source provides the token
- **WHEN** `CLAUDE_CODE_OAUTH_TOKEN` is set on the API host
- **THEN** `EnvClaudeAuthSource` returns the token to the runtime's credential setup and reports configured = true

#### Scenario: No secret leaks on status
- **WHEN** runtime readiness is queried
- **THEN** the response carries only a boolean and never the token value or a suffix

### Requirement: ClaudeCodeRuntime autosubmit is a no-op
`ClaudeCodeRuntime` SHALL declare `terminalStartup` with `promptSubmit: 'none'` and
`replyToStartupDSR: false`, so the shared pty mechanism injects NO carriage return and NO
synthetic CPR for a claude task. Because `claude "prompt"` auto-runs the positional
prompt, codex's DSR/CPR submit machinery (the `launchedCodex`/`dsrSeen` gating, the
quiesce timer, the synthetic CPR reply) SHALL stay inert for claude — it is driven by the
declared `terminalStartup` policy, not an agent-identity check.

#### Scenario: Prompt runs without an injected Enter
- **WHEN** a `claude-code` task launches with a pre-filled positional prompt
- **THEN** the agent begins answering with no carriage return injected by the mechanism,
  and the captured stream contains no DSR (`ESC[6n`) handshake

### Requirement: ClaudeCodeRuntime turn-completion exit detection
`ClaudeCodeRuntime` SHALL be a RESIDENT continuous-conversation session, behaviorally identical to codex: a finished turn does NOT terminate the task. After answering, Claude idles at its interactive TUI for the next input, which the operator supplies by typing into the live xterm (the same write-lease-gated keystroke path codex uses), driving multi-turn conversation in the SAME session.

`ClaudeCodeRuntime.detectExit()` SHALL resolve completion from session liveness — `tmux has-session` over the exec handle (present → `running`, GONE → `done`) — exactly like `CodexRuntime.detectExit()`. It SHALL NOT tail the transcript for `end_turn`, SHALL NOT proactively `tmux kill-session` on a finished turn, and SHALL NOT trigger the codex-style exit-status resolution (`/v1/shell/wait` / `echo $?`) on a still-alive session. A task is `done` ONLY when the session is gone — via an explicit operator stop, or (when configured) idle/deadline reclamation. The liveness watchdog SHALL still classify a session that disappears WITHOUT a stop/idle in flight as an abnormal death (`failed`), so a genuinely crashed agent is not left hanging; a clean, idling turn is NEVER probed for an exit code.

#### Scenario: A finished turn keeps the session resident
- **WHEN** a Claude turn finishes (the latest `assistant` event is `end_turn`) and the process idles for the next input
- **THEN** the task remains `running`, the tmux session is NOT killed, and no exit-status resolution runs

#### Scenario: Follow-up input continues the same conversation
- **WHEN** the operator types a follow-up into the live xterm while the task is resident
- **THEN** Claude processes it as the next turn in the same `--session-id` session, with no new task created

#### Scenario: Completion is resolved by session-gone, like codex
- **WHEN** the session is stopped (operator stop, or a configured idle/deadline reclamation) and `tmux has-session` reports GONE
- **THEN** `detectExit` returns `done` and the task transitions to a terminal state via the shared session-gone path — the SAME mechanism codex uses

#### Scenario: An unexpectedly dead session is failed, not silently completed
- **WHEN** the tmux session disappears with no operator stop and no idle/deadline reclamation in flight (the agent or tmux daemon crashed)
- **THEN** the abnormal-death watchdog resolves the task as `failed`

### Requirement: ClaudeCodeRuntime transcript capture
Claude transcript capture SHALL reuse the shared byte-stream asciicast capture unchanged
as the primary replay source; the structured `--session-id` JSONL on the sandbox
filesystem MAY ADDITIONALLY be read as an archival record by the shared retention path
(NOT a per-runtime `captureTranscript()` port method), parsing ALL record types
(threading through `attachment`/`system` records so the parent chain is not broken). The
slug SHALL be computed from the CANONICALIZED workspace path.

#### Scenario: Byte-stream replay works for Claude unchanged
- **WHEN** a completed `claude-code` task is replayed
- **THEN** the asciicast timing replay renders the session through the same pipeline used
  for codex, with no runtime-specific capture branch

### Requirement: Runtime readiness endpoint
The system SHALL expose a read endpoint reporting, per runtime id, whether it is ready to
run (e.g. its credential is configured), returning booleans only and never secrets, so the
console can offer or disable a runtime before task creation.

#### Scenario: Readiness reflects configuration
- **WHEN** a Claude token is configured and codex is configured
- **THEN** the endpoint reports both runtimes ready; if the Claude token is absent, it
  reports `claude-code` not ready while `codex` stays ready

### Requirement: The runtime is a policy object that owns no I/O
The `AgentRuntime` SHALL be a POLICY object: it contributes declarative data and PURE
functions, and SHALL NOT own any I/O (no PTY event loop, no `/v1/shell/exec` calls, no
container lifecycle). Per-agent setup SHALL be expressed as command-emitters that
RETURN shell command strings (`sandboxSetupCommands(ctx, material): string[]`,
`preStopTrimCommands(ctx): string[]`); the shared MECHANISM (the provider) runs them.
The runtime's launch contribution SHALL be `{ argv, env }` only — the detached-tmux
wrapper and the `$(cat <prompt-file>)` positional-prompt delivery are shared mechanism,
not per-runtime code. `detectExit` MAY run a probe through a provided exec handle (it
decides WHAT to probe and HOW to interpret; the exec itself is mechanism).

#### Scenario: Setup is a pure command emitter, not an I/O call
- **WHEN** the provider provisions a task of any runtime
- **THEN** it obtains the runtime's setup commands as strings and runs them via the
  shared exec, and the runtime implementation makes no exec/PTY/Docker call itself

#### Scenario: A new runtime is added without touching mechanism
- **WHEN** a third runtime is introduced
- **THEN** it is implemented as one policy object (launch spec, terminalStartup,
  setup/trim commands, detectExit, transcript), and NO change is required in the pty
  client, provider, or liveness poller

### Requirement: No agent-identity branch exists in shared scaffolding
Shared scaffolding SHALL NOT branch on agent identity (`runtime.id === 'codex'`, `!==
'codex'`, or equivalent) — this applies to the pty client, the provider, the liveness
poller, and any integration/registry wiring. Any per-agent difference SHALL be carried
by the runtime's declared policy and read by the mechanism. An identity check disguised
as a port call (e.g. an `autoSubmit()` that returns `id === 'codex'`) SHALL NOT exist.

#### Scenario: Mechanism reads policy, not identity
- **WHEN** the pty client decides whether to reply to the startup DSR or inject a
  submit Enter
- **THEN** it reads the runtime's declared `terminalStartup`, and a grep of the
  shared-scaffolding sources for `id === 'codex'` / `id !== 'codex'` finds zero matches

### Requirement: A single AgentRuntime interface with no translation adapter
There SHALL be exactly ONE `AgentRuntime` interface that consumers depend on directly;
the parallel narrow consumer interface and the `RuntimeAdapter` translation layer SHALL
be removed (any remaining `agent-runtime.integration` surface is DI wiring/registry
only, not a shape translator that re-implements the port). The port SHALL NOT carry a
dead method that no consumer calls (the previous `autoSubmit(pty,ctx)=>cleanup` is
removed in favor of declarative `terminalStartup`).

#### Scenario: Consumers use the port directly
- **WHEN** the provider, pty client, or liveness poller resolve a runtime
- **THEN** they call the single `AgentRuntime` interface's members directly with no
  adapter translating shapes, and no second `AgentRuntime` interface is defined

### Requirement: Terminal startup is declarative; the pty client owns the single mechanism
The runtime SHALL declare its terminal-startup behavior as data — `terminalStartup: {
replyToStartupDSR: boolean; promptSubmit: 'none' | 'cr-on-quiesce'; quiesceMs? }` — and
the pty client SHALL retain its SINGLE DSR/CPR/output-quiescence mechanism, driven by
that declaration. Codex SHALL declare `{ replyToStartupDSR: true, promptSubmit:
'cr-on-quiesce' }`; Claude Code SHALL declare `{ replyToStartupDSR: false, promptSubmit:
'none' }`. The mechanism code path codex exercises SHALL be unchanged by this seam
move (the gate flips from an identity check to the declared flag).

#### Scenario: Codex startup is unchanged behind the declarative gate
- **WHEN** a codex task starts and the sandbox emits the startup DSR (`\x1b[6n`)
- **THEN** the pty client injects the synthetic CPR (`\x1b[1;1R`) and, after output
  quiesces, a single Enter — byte-identical to before the refactor

#### Scenario: Claude declares no DSR reply and no submit key
- **WHEN** a claude-code task starts
- **THEN** the pty client injects no CPR reply and no Enter (claude auto-runs its
  positional prompt), because `terminalStartup` declares `replyToStartupDSR: false`
  and `promptSubmit: 'none'`

### Requirement: Codex observable outputs are byte-identical and characterization-tested
This refactor SHALL be behavior-preserving for codex, proven by characterization/golden
tests pinned on the CURRENT code BEFORE refactoring and asserted unchanged after each
step. The pinned surfaces SHALL be codex's four deterministic outputs: (1) the detached
launch-line string, (2) the DSR→CPR injection sequence, (3) the sandbox-setup
(auth.json/config.toml/prompt) exec command strings, and (4) the pre-stop trim command
strings. The compose e2e is the final integration confirmation and SHALL NOT be a
precondition for landing a golden-test-gated step.

#### Scenario: Golden tests pin codex outputs before and after the refactor
- **WHEN** any refactor step is applied
- **THEN** the golden tests for the four codex output surfaces still pass byte-for-byte,
  and they were authored against the pre-refactor code so a deviation fails the step

### Requirement: Persisted task runtime deterministically selects the provisioning runtime, guarded against silent regression

A task's persisted `runtime` value SHALL deterministically select the runtime used to provision and launch it: a `claude-code` task SHALL be provisioned by the Claude runtime, and a `codex` or runtime-absent task by the codex runtime. The orchestrator SHALL NEVER silently provision a runtime different from the one the task selected.

The selection seam SHALL be guarded against silent regression at three layers, because this exact path shipped 100% broken in v0.6.0 (a `claude-code` task was silently provisioned through codex) and had to be fixed twice:

- **Compile-time.** The runtime registry SHALL depend on the `ProvisionLookup` port's `getTaskRuntime` as a REQUIRED member (no optional/widening cast, no `typeof`-presence escape hatch). An implementation of `ProvisionLookup` that omits `getTaskRuntime` SHALL be a build-time type failure, not a runtime fallback.
- **Test-time.** A fast (CI-lane, non-skipping) test SHALL exercise the REAL registry against a real-shaped `ProvisionLookup` — and the real `PrismaProvisionLookup` against a fake persistence client — asserting that the persisted runtime resolves the matching runtime. This coverage SHALL NOT rely solely on the self-hosted, token-gated, self-skipping compose e2e.
- **Run-time.** When the runtime cannot be resolved from persistence — the lookup is genuinely unwired, the lookup errors, or the stored value is outside the known set — the orchestrator MAY fall back to the codex default but SHALL log the fallback at `warn` level. A degradation to the default SHALL NOT be silent.

#### Scenario: A claude-code task resolves the Claude runtime through the real seam

- **WHEN** a task persisted with `runtime = "claude-code"` is resolved for provisioning through the real `IntegrationRuntimeRegistry` backed by a `ProvisionLookup` that returns the persisted value
- **THEN** the resolved runtime is the `ClaudeCodeRuntime` (id `claude-code`), never the codex runtime

#### Scenario: A codex or runtime-absent task resolves the codex runtime

- **WHEN** a task persisted with `runtime = "codex"` — or with no runtime value — is resolved for provisioning through the real registry + lookup
- **THEN** the resolved runtime is the `CodexRuntime` (id `codex`)

#### Scenario: The persistence lookup actually returns the stored runtime

- **WHEN** the real `PrismaProvisionLookup.getTaskRuntime(taskId)` is invoked against a persistence client holding `runtime = "claude-code"` for that task
- **THEN** it returns `"claude-code"` (proving the read path the DOA bug omitted is wired and exercised)

#### Scenario: Omitting getTaskRuntime from a lookup implementation is a build-time failure

- **WHEN** a `ProvisionLookup` implementation does not provide `getTaskRuntime`
- **THEN** the type check fails at build time (the registry depends on the required port member), rather than the registry silently defaulting every task to codex at run time

#### Scenario: An unresolvable runtime is logged, never silently defaulted

- **WHEN** the registry cannot resolve a task's runtime because the lookup is unwired, the lookup throws, or the stored value is outside the known set
- **THEN** the registry logs the fallback to the codex default at `warn` level (it does not swallow the condition silently)

