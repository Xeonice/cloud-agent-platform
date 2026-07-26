# agent-events-and-approvals Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Blocking hook forwards the approval round-trip

The repository SHALL treat any retained Codex hook adapter as isolated compatibility
code rather than a bypass-mode production gate. When that adapter
is explicitly invoked in a non-production verification path, it SHALL parse its declared
stdin schema, translate the event to CAP's `permission_request` frame, block until a
decision returns, and emit its declared allow/deny result. The internal approval callback
SHALL continue to reject proxy-forwarded requests and non-private TCP peers before
approval routing, and the public reverse proxy SHALL return 404 for the exact callback
path.

Production interactive tasks launched with
`--dangerously-bypass-approvals-and-sandbox` SHALL NOT register or depend on that hook as
a pre-execution gate. The AIO runtime image SHALL NOT bake a task-visible
`~/.codex/hooks.json` or `/opt/cap/dist/hooks`, and Codex setup SHALL ensure a stale
`~/.codex/hooks.json` is absent before launch. The interactive provider PTY carries the
agent's autonomous tool calls as terminal bytes; CAP is not a command broker on that
surface. This is an explicitly accepted trusted-owner threat-model boundary: the per-task
provider sandbox isolates host and other-task resources, while provider-private material
delivery, lifecycle cleanup, and post-hoc transcript/activity evidence protect the
control plane. The same-UID agent can read the owner-scoped credential it needs to run,
and unrestricted provider egress is not an exfiltration boundary. The system SHALL NOT
claim those PTY tool calls are human-approval-gated or prompt-injection-resistant
credential containment.

`SandboxApprovalEnforcer` SHALL remain fail closed when a caller explicitly invokes its
`enforce` or `enforceThen` contract: only `allow` proceeds; deny, routing error, or timeout
does not. In the current production stack the class is registered under
`SANDBOX_APPROVAL_ENFORCER` but has no CAP-owned exec call site. That dormant registration
SHALL NOT be represented as enforcement of ordinary `/v1/shell/exec` operations or of
interactive PTY activity.

#### Scenario: Isolated hook adapter blocks when explicitly exercised

- **WHEN** the legacy hook adapter is invoked by its isolated protocol test
- **THEN** it forwards the event, waits for a decision, and emits the declared allow/deny
  form
- **AND** this test does not imply that a bypass-mode production task registered the hook

#### Scenario: Bypass-mode interactive task has no hook gate

- **WHEN** an interactive Codex task is provisioned and launched with
  `--dangerously-bypass-approvals-and-sandbox`
- **THEN** task setup leaves no `~/.codex/hooks.json` registered for that task
- **AND** the task runs without per-command approval prompts
- **AND** the product does not claim the autonomous PTY surface is pre-execution gated

#### Scenario: Credential containment claim matches the implemented boundary

- **WHEN** a real provider canary verifies private-file delivery and teardown cleanup
- **THEN** command requests, argv, logs, and retained residue contain no credential bytes
- **AND** the result is not represented as proof that a malicious same-UID agent cannot
  read or exfiltrate its owner-scoped runtime credential

#### Scenario: Dormant enforcer class fails closed when directly invoked

- **WHEN** `SandboxApprovalEnforcer` is directly invoked and receives `allow`
- **THEN** `enforce()` returns `{allowed: true}` and `enforceThen()` may run its callback
- **AND** deny, routing error, or timeout returns/throws a fail-closed outcome without
  invoking the callback
- **AND** this class contract is not evidence of a production call site

#### Scenario: Callback network boundary remains private

- **WHEN** a request targets the internal approval callback through a proxy-forwarded,
  non-private, or public reverse-proxy path
- **THEN** it is rejected before approval routing or receives the configured public 404

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

### Requirement: Two-capability notification adapter port
The system SHALL define a notification adapter port exposing two capabilities: `notify` for one-way push (for example ntfy or Bark, used for Stop "awaiting input" signals) and `request-decision` for a round-trip approval (for example Telegram inline buttons routed back through a REST callback), and an adapter MAY implement `notify` without implementing `request-decision`.

#### Scenario: Port distinguishes notify from request-decision
- **WHEN** the notification adapter port interface is inspected
- **THEN** it declares a one-way `notify` capability and a round-trip `request-decision` capability as distinct operations

#### Scenario: One-way-only adapter is valid
- **WHEN** an adapter implements only `notify` and not `request-decision`
- **THEN** it is a valid adapter usable for push notifications
- **AND** the system does not route round-trip approval requests to it
