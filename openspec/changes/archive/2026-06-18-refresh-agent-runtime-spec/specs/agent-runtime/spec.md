## MODIFIED Requirements

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
