# agent-events-and-approvals Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Blocking hook forwards the approval round-trip
The runner SHALL register a blocking Codex `PermissionRequest`/`PreToolUse` hook that, on firing, forwards the event to the orchestrator, blocks until the user's decision is returned, and prints the resulting `{decision}` JSON to stdout so Codex consumes it.

#### Scenario: Hook blocks until a decision returns
- **WHEN** the Codex `PermissionRequest`/`PreToolUse` hook fires for a tool call
- **THEN** the hook forwards the event to the orchestrator and does not return until a decision is received
- **AND** it prints the received `{decision}` JSON to stdout for Codex to consume

### Requirement: Allow/deny/message decision contract
The contracts package SHALL encode the approval decision shape as `decision.behavior` constrained to exactly `allow` or `deny`, with an optional `message` string, and the runner SHALL emit decisions conforming to this schema.

#### Scenario: Decision schema constrains behavior
- **WHEN** the approval-decision schema in the contracts package is inspected
- **THEN** `decision.behavior` is constrained to the literal set `{ "allow", "deny" }`
- **AND** `message` is an optional string field

#### Scenario: Malformed decision is rejected
- **WHEN** a decision with a `behavior` value outside `allow`/`deny` is parsed against the schema
- **THEN** parsing fails and no decision is emitted to Codex

### Requirement: Any-deny-wins resolution
When more than one matching decision is produced for a single permission request, the runner SHALL resolve the outcome to `deny` if any contributing decision is `deny`, and only resolve to `allow` when every contributing decision is `allow`.

#### Scenario: A single deny overrides allows
- **WHEN** the contributing decisions for one permission request are `allow` and `deny`
- **THEN** the resolved decision printed to Codex is `deny`

#### Scenario: All-allow resolves to allow
- **WHEN** every contributing decision for one permission request is `allow`
- **THEN** the resolved decision printed to Codex is `allow`

### Requirement: PostToolUse file-edit reporting with git-diff fallback
The runner SHALL use the post-hoc `PostToolUse` hook only to report file edits after they occur and SHALL NOT use it to gate or undo a command, and SHALL additionally compute a git diff of the workspace as a fallback report because hook tool coverage is partial.

#### Scenario: PostToolUse reports edits without gating
- **WHEN** a `PostToolUse` hook fires after a file-editing tool call
- **THEN** the runner emits a file-edit report for that change
- **AND** it does not attempt to block or reverse the already-executed command

#### Scenario: Git-diff fallback covers uninstrumented edits
- **WHEN** a file change occurs that was not surfaced by a `PostToolUse` hook event
- **THEN** the runner detects it via a git diff of the workspace and includes it in the file-edit report

### Requirement: Hooks baked into a version-pinned runner image
The runner image SHALL ship the hook configuration as a top-level `~/.codex/hooks.json` file (not repo-local `.codex/config.toml`, which does not fire hooks) and SHALL pin a known-good Codex version.

#### Scenario: Hooks live in the user-level hooks.json
- **WHEN** the runner image filesystem is inspected
- **THEN** the hook configuration is present at `~/.codex/hooks.json`
- **AND** the hook configuration is not relied upon from a repo-local `.codex/config.toml`

#### Scenario: Codex version is pinned
- **WHEN** the runner image build definition is inspected
- **THEN** it installs a specific pinned Codex version rather than an unpinned latest

### Requirement: Two-capability notification adapter port
The system SHALL define a notification adapter port exposing two capabilities: `notify` for one-way push (for example ntfy or Bark, used for Stop "awaiting input" signals) and `request-decision` for a round-trip approval (for example Telegram inline buttons routed back through a REST callback), and an adapter MAY implement `notify` without implementing `request-decision`.

#### Scenario: Port distinguishes notify from request-decision
- **WHEN** the notification adapter port interface is inspected
- **THEN** it declares a one-way `notify` capability and a round-trip `request-decision` capability as distinct operations

#### Scenario: One-way-only adapter is valid
- **WHEN** an adapter implements only `notify` and not `request-decision`
- **THEN** it is a valid adapter usable for push notifications
- **AND** the system does not route round-trip approval requests to it
