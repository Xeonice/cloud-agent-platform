## ADDED Requirements

### Requirement: Create-task dialog offers a runtime selector gated on readiness
The create-task dialog SHALL present a runtime selector (`Claude Code` | `Codex`) whose
value is sent in the create-task request body as `runtime`, defaulting to `Codex`. The
selector SHALL be gated on a runtime-readiness read (see `agent-runtime`): a runtime that
is not configured/ready SHALL be shown disabled with an affordance pointing the operator to
configure it, rather than being selectable and failing at launch. The command preview SHALL
reflect the selected runtime (showing the `claude`-based invocation when Claude Code is
chosen, the `codex`-based invocation otherwise).

#### Scenario: Operator selects an available runtime
- **WHEN** both runtimes report ready and the operator selects `Claude Code`
- **THEN** the create request body carries `runtime = claude-code` and the command preview
  reflects the Claude invocation

#### Scenario: Unconfigured runtime is disabled
- **WHEN** the Claude runtime reports not ready
- **THEN** the `Claude Code` option is shown disabled with a configure hint, and `Codex`
  remains the default selectable runtime

### Requirement: The dormant stopOnWrite checkbox no longer over-promises
The create-task dialog SHALL NOT present stopOnWrite as an active per-operation gate,
because the "破坏性写入前停止" (stopOnWrite) control is unwired at every layer for both
runtimes (the agent runs ungated inside the sandbox, which is the trust boundary). It SHALL
either be removed from the dialog or relabeled to reflect that it is preview-only / advisory,
so operators are not misled into believing destructive writes are gated.

#### Scenario: stopOnWrite does not imply an active gate
- **WHEN** the operator opens the create-task dialog
- **THEN** there is no control that claims to stop the agent before a destructive write as
  an enforced gate; any remaining affordance is clearly labeled preview-only/advisory
