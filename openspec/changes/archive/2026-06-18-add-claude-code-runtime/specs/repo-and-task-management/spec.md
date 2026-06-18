## ADDED Requirements

### Requirement: Task carries an agent-runtime selector
The `Task` model SHALL hold an OPTIONAL `runtime` value selecting the agent runtime
(`claude-code` | `codex`), defaulting to `codex` when absent so existing tasks and
omitted requests remain valid. The `Task.runtime` column SHALL persist the value
supplied by the create-task request so it is readable on every task read path. The
column is additive and nullable; a prior task with no `runtime` SHALL read back as
`codex`.

#### Scenario: Migration adds a nullable runtime column defaulting to codex
- **WHEN** the migration runs against an existing database
- **THEN** the `Task` table gains a nullable `runtime` column, and pre-existing rows
  read back as `codex`

#### Scenario: Runtime survives a write/read round trip
- **WHEN** a task is created with `runtime = claude-code`
- **THEN** the persisted record carries `runtime = claude-code` and every read path
  returns it unchanged

### Requirement: Create-task API accepts and echoes runtime, and dispatches to it
The create-task endpoint SHALL accept an OPTIONAL `runtime` field (`claude-code` |
`codex`) in the request body, validated against the shared contract schema, persist it
on the created `Task`, and include it on the create response, the list-tasks response,
and the fetch-by-id response (echoing whatever was supplied, or `codex` when omitted).
At admission the task SHALL be dispatched to the selected runtime's `AgentRuntime`
implementation (see `agent-runtime`). A request selecting a runtime that is not
configured/ready SHALL be rejected or fail-closed with a distinct reason rather than
launching an unauthenticated agent.

#### Scenario: Create a task selecting the Claude runtime
- **WHEN** a create-task request includes `runtime = claude-code` and Claude is configured
- **THEN** the task is persisted with `runtime = claude-code`, the response echoes it, and
  admission resolves the Claude runtime

#### Scenario: Omitted runtime defaults to codex
- **WHEN** a create-task request omits `runtime`
- **THEN** the task is created and read back as `runtime = codex`, with codex dispatched

#### Scenario: Invalid runtime value is rejected
- **WHEN** a create-task request carries a `runtime` value outside the allowed set
- **THEN** the request is rejected with HTTP 400 and no task is created

#### Scenario: Unconfigured runtime fails closed
- **WHEN** a create-task request selects `claude-code` but no Claude token is configured
- **THEN** the task does not launch an unauthenticated agent and surfaces a distinct
  "runtime not configured" reason
