## ADDED Requirements

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
