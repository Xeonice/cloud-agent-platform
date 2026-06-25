## MODIFIED Requirements

### Requirement: Blocking hook forwards the approval round-trip

The runner SHALL register a blocking Codex `PermissionRequest`/`PreToolUse` hook that, on firing, forwards the event to the orchestrator, blocks until the user's decision is returned, and returns the decision to Codex in the codex `0.131` hook protocol form. The hook SHALL read the `0.131` stdin schema (`{session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id, tool_name, tool_use_id, tool_input}`), translate it to cap's `permission_request` frame for the existing approval round-trip, and emit either the `0.131` JSON decision (`{hookSpecificOutput:{hookEventName, permissionDecision:"allow"|"deny", permissionDecisionReason?}}`) or the `0.131` exit-code decision (exit `0` for allow / exit `2` + stderr message for deny).

Interactive task agents SHALL NOT rely on this hook path for pre-execution human approval when they are launched in documented bypass/YOLO-style mode. The interactive codex-pty surface (`/v1/shell/ws` TUI), over which codex issues its OWN autonomous agent-loop tool calls (file edits, shell commands) directly into the PTY, SHALL NOT be individually approval-gated by this requirement: on that surface cap is a byte pipe, not a command broker, and neither the codex `0.131` hook (codex#16732) nor the `AioApprovalEnforcer` mediates those calls. This coverage limit is an EXPLICITLY ACCEPTED threat-model gap, NOT a code fix: containment of the codex-pty surface relies on the per-task AIO Sandbox container, `cap-net` network isolation (no published host port), ephemeral per-task credentials, and post-hoc activity reporting rather than a pre-execution human-in-the-loop gate. The spec SHALL NOT assert that codex's autonomous pty tool calls are approval-gated.

The FALLBACK enforcement (`AioApprovalEnforcer`) SHALL gate the cap-owned `/v1/shell/exec` surface - every command the orchestrator brokers into the sandbox via `POST /v1/shell/exec` - and that gate SHALL be authoritative and FAIL CLOSED when it is wired into a production call site: a resolved `allow` decision SHALL let the command proceed, while a `deny` decision, an approval-routing error, or the absence of any decision SHALL prevent the command from running. The fallback gate's authority is independent of whether the codex hook fires.

#### Scenario: Hook blocks until a decision returns when it fires

- **WHEN** the Codex `PermissionRequest`/`PreToolUse` hook fires for a tool call
- **THEN** the hook forwards the event to the orchestrator and does not return until a decision is received
- **AND** it returns the decision to Codex in the codex `0.131` form (`{hookSpecificOutput:{permissionDecision}}` JSON, or exit `0` allow / exit `2` deny)

#### Scenario: Bypass-mode interactive tasks are not approval gated

- **WHEN** an interactive Codex task is launched with `--dangerously-bypass-approvals-and-sandbox`
- **THEN** the task is allowed to run without per-command approval prompts
- **AND** the system does not claim the codex-pty surface is pre-execution approval-gated

#### Scenario: Exec surface fails closed on deny, error, or no decision

- **WHEN** the `AioApprovalEnforcer` class is invoked for a gated tool call and the resolved decision is `allow`
- **THEN** `enforce()` returns `{allowed: true}` and `enforceThen()` proceeds to invoke the gated action
- **AND** WHEN the resolved decision is `deny`, an approval-routing error occurs, or no decision is returned within the timeout, THEN `enforce()` returns `{allowed: false}` and `enforceThen()` throws `ApprovalDeniedError` - the gate fails closed regardless of whether the codex `0.131` hook fired
- **AND** this fail-closed contract applies to the enforcer class; currently there are NO cap-owned gated `/v1/shell/exec` call sites in production code that route through it - the enforcer is wired as a DI provider (`AIO_APPROVAL_ENFORCER` in `TerminalModule`) for future use but is dormant
