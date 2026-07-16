## ADDED Requirements

### Requirement: Durable task admission is leased, idempotent, and restart-recoverable

Guardrails admission SHALL consume a durable work item uniquely associated with
the committed Task rather than the originating HTTP/MCP request lifetime. A
worker SHALL claim work with a database lease, re-read the Task's terminal and
version fence plus immutable preparation inputs, and renew the lease while a
long provider operation is active. Concurrent workers and expired-lease replay
SHALL NOT admit the same task twice or leave more than one live provider sandbox
for the task. Retryable infrastructure failures SHALL use a bounded persisted
retry policy; deterministic capacity/config/auth/ref failures SHALL settle the
task with their structured cause rather than retry forever.

On application bootstrap, unfinished accepted/admitting work SHALL be recovered
in addition to the existing running-task re-adoption and queued-task re-offer
phases. Recovery SHALL preserve the effective concurrency ceiling and SHALL use
provider idempotency/readoption when a sandbox was created before a worker
crash. A cancelled or otherwise terminal task SHALL never be re-admitted, and a
late superseded worker SHALL tear down any sandbox it no longer owns.

#### Scenario: Two workers contend for one admission

- **WHEN** two workers attempt to claim the same accepted task concurrently
- **THEN** only one holds the valid lease and enters guardrails admission
- **AND** exactly one concurrency slot and at most one live provider sandbox are owned by the task

#### Scenario: Worker crashes after sandbox creation

- **WHEN** a worker exits after the provider creates the task sandbox but before admission work is marked complete
- **THEN** recovery reuses/readopts the provider-idempotent sandbox or safely removes a superseded duplicate
- **AND** the task continues without consuming two slots

#### Scenario: Restart recovers accepted work

- **WHEN** the API restarts with committed admission work still accepted or leased by an expired worker
- **THEN** bootstrap/poll recovery makes it claimable and resumes it in durable order
- **AND** existing running-task re-adoption and queued FIFO semantics remain intact

#### Scenario: Cancellation fences a late worker

- **WHEN** a task becomes cancelled while its worker is blocked in provider provisioning
- **THEN** the post-boundary status/version check prevents runtime launch
- **AND** teardown and slot release complete idempotently exactly once
