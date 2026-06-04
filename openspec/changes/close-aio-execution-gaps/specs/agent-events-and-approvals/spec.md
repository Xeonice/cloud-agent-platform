## MODIFIED Requirements

### Requirement: Blocking hook forwards the approval round-trip
The runner SHALL register a blocking Codex `PermissionRequest`/`PreToolUse` hook that, on firing, forwards the event to the orchestrator, blocks until the user's decision is returned, and returns the decision to Codex in the codex `0.131` hook protocol form. The hook SHALL read the `0.131` stdin schema (`{session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id, tool_name, tool_use_id, tool_input}`), translate it to cap's `permission_request` frame for the existing approval round-trip, and emit either the `0.131` JSON decision (`{hookSpecificOutput:{hookEventName, permissionDecision:"allow"|"deny", permissionDecisionReason?}}`) or the `0.131` exit-code decision (exit `0` for allow / exit `2` + stderr message for deny). Codex SHALL be launched with `--full-auto` (which KEEPS hooks; `-s` sandbox / bypass-approvals flags DISABLE them) and the hook SHALL be trusted (config.toml `[hooks.state] trusted_hash`, or `--dangerously-bypass-hook-trust` for vetted automation). Because codex `0.131` is a research preview whose `PreToolUse` hook did NOT reliably fire in live tests (codex#16732) even with the correct format, `--full-auto`, hook trust, and matcher `.*`, this hook-fires path SHALL NOT be assumed proven and SHALL be gated behind live verification; a FALLBACK that enforces approval at a layer cap controls SHALL be provided.

The FALLBACK enforcement (`AioApprovalEnforcer`) SHALL gate the cap-owned `/v1/shell/exec` surface — every command the orchestrator brokers into the sandbox via `POST /v1/shell/exec` — and that gate SHALL be authoritative and FAIL CLOSED: a resolved `allow` decision SHALL let the command proceed, while a `deny` decision, an approval-routing error, or the absence of any decision SHALL prevent the command from running. The fallback gate's authority is independent of whether the codex hook fires.

The interactive codex-pty surface (`/v1/shell/ws` TUI), over which codex issues its OWN autonomous agent-loop tool calls (file edits, shell commands) directly into the PTY, SHALL NOT be individually approval-gated by this requirement: on that surface cap is a byte pipe, not a command broker, and neither the codex `0.131` hook (codex#16732) nor the `AioApprovalEnforcer` mediates those calls. This coverage limit is an EXPLICITLY ACCEPTED threat-model gap (closure option c), NOT a code fix: containment of the codex-pty surface relies on `cap-net` network isolation (no published host port), ephemeral per-task credentials, and a post-hoc activity report rather than a pre-execution human-in-the-loop gate. The spec SHALL NOT assert that codex's autonomous pty tool calls are approval-gated.

#### Scenario: Hook blocks until a decision returns
- **WHEN** the Codex `PermissionRequest`/`PreToolUse` hook fires for a tool call
- **THEN** the hook forwards the event to the orchestrator and does not return until a decision is received
- **AND** it returns the decision to Codex in the codex `0.131` form (`{hookSpecificOutput:{permissionDecision}}` JSON, or exit `0` allow / exit `2` deny)

#### Scenario: Hook reads the codex 0.131 stdin schema and codex is launched with full-auto plus trust
- **WHEN** codex is launched for a task
- **THEN** codex is started with `--full-auto` so hooks are kept, and the baked hook is trusted via `[hooks.state] trusted_hash` or `--dangerously-bypass-hook-trust`
- **AND** when the hook fires, it parses the `0.131` stdin schema (including `tool_name` and `tool_input`) and translates it to cap's `permission_request` frame

#### Scenario: Fallback enforces approval when codex hooks are unreliable
- **WHEN** live verification shows the codex `0.131` `PreToolUse` hook does not reliably fire (codex#16732) for a tool call that requires approval
- **THEN** approval is enforced at a cap-controlled layer rather than relying on codex firing the hook
- **AND** the system does not allow the gated tool call to proceed without an approval decision

#### Scenario: Exec surface fails closed on deny, error, or no decision
- **WHEN** the orchestrator brokers a command into the sandbox via `POST /v1/shell/exec` and the `AioApprovalEnforcer` resolves the decision to `allow`
- **THEN** the command is permitted to run on the cap exec surface
- **AND** WHEN the resolved decision is `deny`, an approval-routing error occurs, or no decision is returned, THEN the command does NOT run (the gate fails closed) regardless of whether the codex `0.131` hook fired

#### Scenario: codex-pty surface is not individually gated and is an accepted threat-model gap
- **WHEN** codex issues its own autonomous agent-loop tool calls (file edits, shell commands) directly over the interactive `/v1/shell/ws` PTY surface
- **THEN** those calls are NOT mediated by the `AioApprovalEnforcer` and NOT gated by the codex `0.131` hook (codex#16732), so this surface has no pre-execution approval gate
- **AND** this coverage limit is documented as an explicitly accepted threat model — containment relies on `cap-net` network isolation (no host port) plus ephemeral per-task credentials plus a post-hoc activity report — and the spec does NOT claim codex's autonomous pty tool calls are approval-gated
