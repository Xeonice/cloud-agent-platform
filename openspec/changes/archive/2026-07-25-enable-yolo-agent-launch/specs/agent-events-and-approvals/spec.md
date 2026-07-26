## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: PostToolUse file-edit reporting with git-diff fallback

**Reason**: Bypass-mode production images do not register the historical `PostToolUse`
hook, so it cannot be specified as a production file-edit reporting source. The retained
adapter and callback are isolated compatibility code, not runtime coverage.

**Migration**: Use structured runtime transcripts, provider/task activity, workspace
delivery, and explicit git/workspace inspection as the truthful observability paths. A
future post-tool reporting channel requires its own transport, version, and real-provider
verification before it can become a runtime guarantee.

### Requirement: Hooks baked into a version-pinned runner image

**Reason**: The AIO image's baked Codex 0.131 hook artifacts were dead: every production
Codex setup removed `~/.codex/hooks.json` before launch, the current image pin is Codex
0.144.1, and BoxLite never baked the hook. Keeping the artifacts implied an approval and
reporting boundary that did not exist.

**Migration**: Pin and probe the Codex/Claude CLIs in both images, but do not copy
`hooks.json`, `/opt/cap/dist/hooks`, or its dependency tree. Keep the isolated adapter
package only as compatibility/reference code until a future change either re-verifies or
removes it.
