## ADDED Requirements

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
