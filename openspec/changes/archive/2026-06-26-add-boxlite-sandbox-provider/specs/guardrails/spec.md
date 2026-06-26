## ADDED Requirements

### Requirement: Guardrails carry selected provider context through the task lifecycle

After provisioning succeeds, guardrails SHALL retain or resolve the selected provider run context for terminal monitoring, delivery, transcript capture, teardown, and slot release. Guardrails SHALL NOT rediscover a provider by concrete implementation class once a task is provisioned.

#### Scenario: Terminal completion uses the owning provider
- **WHEN** a BoxLite-backed task reaches terminal completion
- **THEN** guardrails performs transcript capture, delivery if requested, teardown, and slot release through the BoxLite owner context

#### Scenario: Provision failure does not leave owner state
- **WHEN** provider provisioning or runtime preflight fails before a selected run is established
- **THEN** guardrails marks the task failed through the existing provision-failure path
- **AND** no durable provider owner is recorded for that failed attempt

### Requirement: Provider preflight happens before long-running admission is committed

Static provider preflight and selected runtime/image preflight SHALL run before a task is treated as successfully admitted to a long-running sandbox session. A failed preflight SHALL fail the task with a distinct provider preflight reason and SHALL release or avoid consuming the concurrency slot.

#### Scenario: BoxLite image preflight fails before launch
- **WHEN** the selected BoxLite image is missing required runtime tooling
- **THEN** the task fails with a provider preflight error before terminal launch and credential injection

#### Scenario: Failed preflight releases the slot
- **WHEN** a task has been admitted but provider preflight fails
- **THEN** guardrails releases the task's concurrency slot and offers the next queued task according to existing FIFO rules

### Requirement: Bootstrap recovery delegates to provider registry

Startup recovery SHALL re-adopt or reclaim running tasks by asking the owning provider or compatible readoption providers, not by scanning only local AIO container names. The bootstrap reap SHALL spare running tasks that a provider re-adopts and SHALL spare stopped retained artifacts from every provider.

#### Scenario: BoxLite running task is re-adopted on restart
- **WHEN** the API restarts while a BoxLite-backed task is running and its detached session is alive
- **THEN** bootstrap re-adopts the task through the BoxLite provider and keeps it running

#### Scenario: Bootstrap reap is not AIO-only
- **WHEN** bootstrap recovery encounters AIO and BoxLite sandboxes
- **THEN** it delegates ownership and cleanup decisions to provider registry/retention surfaces
- **AND** it does not force-remove provider artifacts solely because they are not `cap-aio-*` containers

### Requirement: Teardown is provider-specific and idempotent

Guardrails SHALL call teardown through the owning provider's selected run context or durable owner. Provider teardown SHALL be idempotent and SHALL free the task lifecycle even if provider cleanup is already complete, partially failed, or repeated by concurrent terminal-close handling.

#### Scenario: Repeated BoxLite teardown is safe
- **WHEN** terminal close handling and force-fail handling both attempt to tear down the same BoxLite-backed task
- **THEN** the provider teardown runs safely at most once in effect
- **AND** guardrails releases the task slot exactly once
