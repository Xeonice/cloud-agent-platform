## MODIFIED Requirements

### Requirement: Create-task API accepts and echoes runtime, and dispatches to it
The create-task endpoint SHALL accept an OPTIONAL `runtime` field (`claude-code` | `codex`) in the
request body, validated against the shared contract schema, persist it on the created `Task`, and
include it on the create response, the list-tasks response, and the fetch-by-id response (echoing
whatever was supplied, or `codex` when omitted). At admission the task SHALL be dispatched to the
selected runtime's `AgentRuntime` implementation (see `agent-runtime`). A request selecting a runtime
that is not configured/ready SHALL be rejected or fail-closed with a distinct reason rather than
launching an unauthenticated agent.

The create path SHALL ADDITIONALLY derive the task's EXECUTION MODE from the consumer: a programmatic
consumer (MCP `create_task` / `POST /v1/tasks`) yields `headless-exec`; a console-created task yields
`interactive-pty`. The derived mode SHALL be persisted on the `Task` and drive provisioning,
exit-detection, and transcript read (see `agent-runtime`). A `headless-exec` task SHALL reach a
terminal status AUTONOMOUSLY on agent completion — no operator interaction, write-lease, or persistent
multi-turn is required or offered for it. Console (`interactive-pty`) creation is unchanged.

#### Scenario: Create a task selecting the Claude runtime
- **WHEN** a create-task request includes `runtime = claude-code` and Claude is configured
- **THEN** the task is persisted with `runtime = claude-code`, the response echoes it, and admission resolves the Claude runtime

#### Scenario: Omitted runtime defaults to codex
- **WHEN** a create-task request omits `runtime`
- **THEN** the task is created and read back as `runtime = codex`, with codex dispatched

#### Scenario: Invalid runtime value is rejected
- **WHEN** a create-task request carries a `runtime` value outside the allowed set
- **THEN** the request is rejected with HTTP 400 and no task is created

#### Scenario: Unconfigured runtime fails closed
- **WHEN** a create-task request selects `claude-code` but no Claude token is configured
- **THEN** the task does not launch an unauthenticated agent and surfaces a distinct "runtime not configured" reason

#### Scenario: Programmatic creation runs headless and reaches terminal
- **WHEN** a task is created via MCP `create_task` or `POST /v1/tasks`
- **THEN** it is persisted with execution mode `headless-exec`, launched non-interactively, and reaches a terminal status on agent completion without operator interaction

#### Scenario: Console creation stays interactive
- **WHEN** a task is created from the console
- **THEN** it is persisted with execution mode `interactive-pty` and behaves exactly as before (live terminal + operator takeover)
