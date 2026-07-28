## MODIFIED Requirements

### Requirement: Audit events are associated with tasks and linked to the session

Every audit event SHALL be associated with exactly one task by its task id, and SHALL carry enough linkage for the console to navigate from a timeline row to that task's live session (`/tasks/$taskId`) and to the most recent run identifier where one applies. Events SHALL also be attributable to the account under which the action occurred, regardless of how that account authenticates — a GitHub-linked identity and a local account SHALL both be attributed. Attribution SHALL resolve the account's own identifier directly; it SHALL NOT depend on a GitHub-id reverse lookup, because an account that has never been linked to a GitHub identity has no such id and would otherwise be recorded with no attribution at all. The association SHALL be stable across the task's lifetime: querying a task's events SHALL return its full event sequence even after the task reaches a terminal state, and an event SHALL NOT be orphaned (every persisted event references a real task id).

#### Scenario: Event links back to its task session

- **WHEN** the history timeline renders an audit event that has an associated session
- **THEN** the event exposes the task id (and run identifier where applicable) sufficient for the console to deep-link to that task's session route `/tasks/$taskId`

#### Scenario: Event is attributed to a user identity

- **WHEN** an audit event is recorded for a task action
- **THEN** the event references the account under which the action occurred, so the timeline can attribute the event to that operator

#### Scenario: A local account is attributed without a GitHub identity

- **WHEN** an audit event is recorded for an action taken by an account that has no linked GitHub identity
- **THEN** the persisted event carries that account's own identifier as its attributed user
- **AND** the attribution is not empty

#### Scenario: Task events queryable by task id

- **WHEN** the events for a specific task id are requested
- **THEN** the orchestrator returns that task's full ordered event sequence, including events recorded after the task reached a terminal state

#### Scenario: No orphaned events

- **WHEN** any persisted audit event is inspected
- **THEN** it references a real task id and is never stored without a task association
