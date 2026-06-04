## MODIFIED Requirements

### Requirement: Blocking hook forwards the approval round-trip
The runner SHALL register a blocking Codex `PermissionRequest`/`PreToolUse` hook that, on firing, forwards the event to the orchestrator, blocks until the user's decision is returned, and returns the decision to Codex in the codex `0.131` hook protocol form. The hook SHALL read the `0.131` stdin schema (`{session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id, tool_name, tool_use_id, tool_input}`), translate it to cap's `permission_request` frame for the existing approval round-trip, and emit either the `0.131` JSON decision (`{hookSpecificOutput:{hookEventName, permissionDecision:"allow"|"deny", permissionDecisionReason?}}`) or the `0.131` exit-code decision (exit `0` for allow / exit `2` + stderr message for deny). Codex SHALL be launched with `--full-auto` (which KEEPS hooks; `-s` sandbox / bypass-approvals flags DISABLE them) and the hook SHALL be trusted (config.toml `[hooks.state] trusted_hash`, or `--dangerously-bypass-hook-trust` for vetted automation). Because codex `0.131` is a research preview whose `PreToolUse` hook did NOT reliably fire in live tests (codex#16732) even with the correct format, `--full-auto`, hook trust, and matcher `.*`, this hook-fires path SHALL NOT be assumed proven and SHALL be gated behind live verification; a FALLBACK that enforces approval at a layer cap controls SHALL be provided.

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

### Requirement: Hooks baked into a version-pinned runner image
The runner image SHALL ship the hook configuration as a top-level `~/.codex/hooks.json` file (not repo-local `.codex/config.toml`, which does not fire hooks) and SHALL pin a known-good Codex version compatible with the account model in use. The `~/.codex/hooks.json` SHALL be written in the codex `0.131` hook format (`{matcher:<regex>, hooks:[{type:"command", command:<string>, timeout?}]}`), NOT cap's prior `{blocking, command:[array]}` form, and the pinned Codex version SHALL be a documented build-arg (`CODEX_VERSION`) set to a release that works with the account model (verified working: `0.131.0` with `gpt-5.5`), not `0.42.0`.

#### Scenario: Hooks live in the user-level 0.131-format hooks.json
- **WHEN** the runner image filesystem is inspected
- **THEN** the hook configuration is present at `~/.codex/hooks.json`
- **AND** the hook configuration is in the codex `0.131` format (`{matcher, hooks:[{type:"command", command, timeout?}]}`) and is not relied upon from a repo-local `.codex/config.toml`

#### Scenario: Codex version is pinned to a compatible release
- **WHEN** the runner image build definition is inspected
- **THEN** it installs a specific pinned Codex version via the `CODEX_VERSION` build-arg compatible with the account model (e.g. `0.131.0` for `gpt-5.5`) rather than an unpinned latest or the incompatible `0.42.0`
