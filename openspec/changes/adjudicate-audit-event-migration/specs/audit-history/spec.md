## ADDED Requirements

### Requirement: Every provisioning stage row has a declared owner

Provisioning progress rows are written under the dedupe identity `task.provisioning:{taskId}:{attempt}:{stage}`, and more than one writer can reach that identity: the admission worker writes monotonic durable checkpoints, while the orchestrator's provider-composite progress hook writes audit-only hints for phases whose physical ordering differs. The capability SHALL declare, per provisioning stage, which writer owns that stage's row, and **every stage a provider family reports SHALL have at least one declared owner**. A stage whose only writer is the orchestrator's audit-only hint SHALL keep that hint; the hint SHALL be removable only for stages the admission worker independently checkpoints under the same dedupe identity.

Ownership SHALL be provable by execution, not by inspection of comments: a test SHALL enumerate the stages each provider family reports and assert the row for each is still recorded when the audit-only hint is absent.

#### Scenario: Two writers of the same identity produce one row

- **WHEN** the admission worker's checkpoint and the provider-composite hint both fire for the same task id, attempt, and stage
- **THEN** exactly one audit row exists for that dedupe identity, and no duplicate is produced by the second writer

#### Scenario: Every reported stage still has a row without the hint

- **WHEN** a durable admission runs to completion on a provider family with the provider-composite audit hint removed
- **THEN** an audit row exists for every provisioning stage that family reported, each under its `task.provisioning:{taskId}:{attempt}:{stage}` identity

#### Scenario: A stage the worker never checkpoints keeps its hint

- **WHEN** a stage is reported by a provider family but is never advanced through an admission-worker checkpoint
- **THEN** removing the orchestrator's audit-only hint makes the ownership test fail with that stage named, rather than silently dropping the stage from the history timeline

#### Scenario: Ownership is enumerable per stage

- **WHEN** the declared owner table is read against the provisioning stage list
- **THEN** each reported stage maps to exactly one declared owner, and no reported stage maps to none

### Requirement: Audit rows are captured synchronously inside the operation that caused them

Audit capture SHALL remain synchronous with respect to the operation that produced it: the write SHALL be issued within that operation's own execution, and SHALL NOT be enqueued, batched across ticks, deferred to a later tick, or staged in an intermediate store on its way to persistence. Re-homing an audit write onto the in-process domain event bus SHALL preserve this property, because the bus dispatches synchronously before `publish` returns; any re-homing that would introduce queueing or deferral SHALL be refused instead of implemented.

Where an audit row is written from a domain-event subscriber, its timestamp and its actor attribution SHALL be derived from the event payload, never from ambient request context, because a published event can be dispatched from a call stack (boot re-adoption, detached session reclaim) that has no such context.

#### Scenario: No deferral primitive on the audit write path

- **WHEN** the audit write paths this change touches are searched for `setTimeout`, `setImmediate`, `process.nextTick`, or an enqueue helper
- **THEN** zero matches are found

#### Scenario: A synchronously dispatched subscriber has completed before the publisher continues

- **WHEN** an audit write is reached through a subscriber of a published domain event
- **THEN** that write has been issued before `publish` returns to the orchestrator, and no part of it is scheduled onto a later tick

#### Scenario: Subscriber-written rows take their attribution from the payload

- **WHEN** an audit row is written from a domain-event subscriber
- **THEN** its occurred-at timestamp and its attributed account are read from the event payload's fields, and the write path reads zero ambient request-context values

### Requirement: An audit write that records an actor or a failure cause cannot migrate onto the current event envelope

The event envelope carries exactly `eventId`, `occurredAt`, `type`, and `taskId`; no catalog payload carries an acting account identifier or a failure cause. Because attribution is already normative — every audit event is attributed to the account under which the action occurred, including a local account with no linked GitHub identity — an audit write that records an actor or a failure cause SHALL NOT be re-homed onto a subscriber of the current catalog. Such a write is adjudicated `CALL` under the information-missing criterion, and remains a direct port call until a separate change extends the envelope or the payload and passes the same catalog review the original events received.

#### Scenario: The envelope carries no actor field

- **WHEN** the envelope's field names are enumerated
- **THEN** they are exactly `eventId`, `occurredAt`, `type`, and `taskId`, and none of them names an acting account

#### Scenario: The lifecycle transition recorder stays a direct call

- **WHEN** the task lifecycle transition recorder — which takes an acting user identifier and a failure detail — is evaluated against the catalog
- **THEN** it is adjudicated `CALL` under the information-missing criterion, and its existing call sites outside guardrails are unchanged by this change

#### Scenario: Attribution keeps working for local accounts

- **WHEN** an audit event is recorded for an action taken by an account with no linked GitHub identity, on the integrated tree
- **THEN** the persisted event still carries that account's own identifier as its attributed user, and the attribution is not empty

#### Scenario: Extending the envelope is a separate reviewed change

- **WHEN** a proposal to re-home an actor-attributed audit write is read
- **THEN** it names the envelope or payload field it needs and defers that addition to its own change, rather than deriving the actor from ambient context or recording the row without attribution
