## ADDED Requirements

### Requirement: Guardrails publishes domain events without changing lifecycle behavior

Guardrails orchestration SHALL publish domain events at its existing seams. Publishing SHALL NOT change, block, delay, reorder, or fail any existing lifecycle transition: a publish error SHALL be swallowed so the transition, the teardown, and the slot release proceed unconditionally. Every existing synchronous collaborator call (audit, runner-minutes accounting, transcripts, provisioning diagnostics, metrics projection) SHALL be retained unchanged — this change adds a second write and removes none.

The bus SHALL be injected into `GuardrailsService` as an `@Optional()` **trailing** constructor parameter (the 11th), so that positional `new GuardrailsService(...)` construction outside `apps/api/src/guardrails/` continues to compile and run unchanged.

#### Scenario: Publishing failure does not disturb the transition

- **WHEN** a task reaches a terminal state while the injected bus's `publish` throws
- **THEN** the task still transitions to its terminal status, its timers are still cleared, its runner-minutes interval is still ended, its slot is still released, and the publish error is logged and swallowed

#### Scenario: Behaviour is identical with no bus injected

- **WHEN** `GuardrailsService` is constructed without the bus argument (the positional form used outside the guardrails directory) and the full lifecycle is exercised
- **THEN** every transition, teardown, audit call, and slot release behaves exactly as before this change, with no null-reference error

#### Scenario: Existing collaborator calls are still made

- **WHEN** a task is admitted, started, provisioned, and settled with the bus injected
- **THEN** the pre-existing audit, runner-minutes, transcript, diagnostics, and metrics calls are each invoked exactly as many times as before this change

#### Scenario: The bus is the trailing constructor parameter

- **WHEN** the `GuardrailsService` constructor signature is inspected
- **THEN** the bus is the last parameter, is marked `@Optional()`, and the preceding 10 parameters keep their existing order and types

#### Scenario: Publishing is gated by the cutover toggle

- **WHEN** the escape-hatch environment value disables publishing and a full task lifecycle is exercised
- **THEN** zero events are published and the observable lifecycle behaviour is identical to the pre-change behaviour

### Requirement: TaskRunStarted is published at exactly three declared points

`TaskRunStarted` SHALL be published at exactly the three seams that begin a run's runner-minutes interval, and nowhere else: (1) the readoption recovery path that restores a running task after restart, (2) the legacy inline path `startRunningAfterCapacity`, and (3) the durable path `armDurableRuntime`. Each SHALL publish exactly once per run start, adjacent to that path's existing `runnerMinutes.recordStart(taskId)` call, and SHALL NOT replace or move it.

#### Scenario: Readoption publishes once

- **WHEN** startup recovery readopts a task that was running before restart
- **THEN** exactly one `TaskRunStarted` is published for that task and the existing `recordStart` call still runs

#### Scenario: The legacy path publishes once

- **WHEN** a task enters RUNNING through `startRunningAfterCapacity`
- **THEN** exactly one `TaskRunStarted` is published for that task, carrying `admissionMode: legacy`

#### Scenario: The durable path publishes once

- **WHEN** a task's durable runtime is armed through `armDurableRuntime`
- **THEN** exactly one `TaskRunStarted` is published for that task, carrying `admissionMode: durable`

#### Scenario: Re-arming the durable runtime does not publish twice

- **WHEN** `armDurableRuntime` is invoked a second time for a task whose runtime is already armed and it early-returns
- **THEN** no second `TaskRunStarted` is published for that task

#### Scenario: There is no fourth publish point

- **WHEN** the tree is searched for `TaskRunStarted` publish call sites
- **THEN** exactly three are found, and each sits in one of the three declared paths

### Requirement: TaskSettled is published only at the terminal fence

`TaskSettled` SHALL be published at exactly one seam: the terminal fence that records a task's own terminal status (`fenceTerminal`). The second `runnerMinutes.recordEnd` call site — the admission-runtime teardown in `clearAdmissionRuntime` — is NOT a terminal settlement, and it SHALL NOT publish `TaskSettled`. Both `recordEnd` call sites SHALL remain in place and unchanged.

#### Scenario: The terminal fence publishes once with the terminal status

- **WHEN** a task reaches `completed`, `failed`, or `cancelled` and `fenceTerminal` runs
- **THEN** exactly one `TaskSettled` is published carrying that terminal status, and the existing `recordEnd` call still runs

#### Scenario: Admission-runtime teardown publishes nothing

- **WHEN** `clearAdmissionRuntime` runs for a superseded legacy provisioning attempt whose task has not reached a terminal status
- **THEN** zero `TaskSettled` events are published, while the existing `recordEnd`, connection removal, and session unregistration still happen

#### Scenario: A superseded attempt does not fabricate a settlement

- **WHEN** a legacy provisioning attempt is discarded as superseded and the task is subsequently settled for real
- **THEN** exactly one `TaskSettled` is published for that task in total, and it carries the real terminal status rather than the teardown moment

#### Scenario: There is exactly one publish point

- **WHEN** the tree is searched for `TaskSettled` publish call sites
- **THEN** exactly one is found and it is inside the terminal fence

### Requirement: SandboxProvisioned is published on both provisioning paths after the provider boundary succeeds

`SandboxProvisioned` SHALL be published on exactly the two orchestration paths that cross the provider boundary: the durable path in `GuardrailsService` and the legacy path in the inline admission pipeline. Each SHALL publish once, only after `provider.provision(...)` has returned successfully and the resulting connection has been registered, using the environment snapshot and selected-run data already in hand — no new data pipeline SHALL be introduced to populate the payload.

#### Scenario: The durable path publishes after a successful provision

- **WHEN** the durable orchestration completes `provider.provision(...)`, re-verifies ownership, and registers the connection
- **THEN** exactly one `SandboxProvisioned` is published carrying the task id, sandbox reference, provider family, and the environment snapshot already built for the provision context

#### Scenario: The legacy path publishes after a successful provision

- **WHEN** the inline admission pipeline completes `provider.provision(...)` and registers the connection
- **THEN** exactly one `SandboxProvisioned` is published for that task

#### Scenario: A failed provision publishes nothing

- **WHEN** `provider.provision(...)` throws, is cancelled, or unwinds for a detaching transfer
- **THEN** zero `SandboxProvisioned` events are published for that attempt

#### Scenario: A superseded provision publishes nothing

- **WHEN** the ownership re-check after `provision(...)` shows the attempt lost its fence and the sandbox is discarded
- **THEN** zero `SandboxProvisioned` events are published for that attempt

#### Scenario: No new pipeline is added to build the payload

- **WHEN** the diff at both publish points is inspected
- **THEN** the payload is assembled from values already present at that seam (provision plan environment, selected run, connection reference), with no new provider call, no new database read, and no new resolver

### Requirement: TaskAdmitted is published on both admission paths

`TaskAdmitted` SHALL be published on exactly the two admission paths: the durable path, once the capacity reservation has committed the task's transition, and the legacy path, once `admit()` has determined its outcome. Each event SHALL carry the transition token that fenced that admission, the resulting admission outcome (`running` or `queued`), and the `admissionMode` discriminant. A refused or superseded reservation SHALL NOT publish `TaskAdmitted`.

#### Scenario: The durable path publishes on a committed reservation

- **WHEN** the durable reservation commits a transition to `running` or `queued`
- **THEN** exactly one `TaskAdmitted` is published carrying that outcome, `admissionMode: durable`, and the transition token minted for that reservation

#### Scenario: The legacy path publishes on its admission outcome

- **WHEN** `admit()` resolves to `running` or `queued` on the legacy path
- **THEN** exactly one `TaskAdmitted` is published carrying that outcome and `admissionMode: legacy`

#### Scenario: A superseded reservation publishes no admission

- **WHEN** the durable reservation returns the `superseded` outcome and the lease transition is rolled back
- **THEN** zero `TaskAdmitted` events are published for that attempt

#### Scenario: Repeated in-flight admission publishes once

- **WHEN** `admit()` is called concurrently for the same task and the second call joins the in-flight admission promise
- **THEN** exactly one `TaskAdmitted` is published for that admission

### Requirement: TaskSuperseded is published once per observation at three declared producer boundaries

`TaskSuperseded` SHALL be published where a supersession is actually observed, at exactly three producer boundaries: (1) the durable capacity reservation returning the `superseded` outcome, (2) the durable admission transition returning `superseded`, and (3) the inline admission pipeline run returning `superseded`. The pipeline's multiple internal `superseded` early-returns SHALL NOT each publish: a single pipeline run SHALL produce at most one `TaskSuperseded`. Each event SHALL carry only what the observer holds — the superseded task id, the fence token the loser held, and the observation-point discriminant — and SHALL NOT carry any superseder identity.

#### Scenario: A superseded reservation publishes once

- **WHEN** the durable capacity reservation returns the `superseded` outcome
- **THEN** exactly one `TaskSuperseded` is published carrying the observation point for that boundary and the fence token the loser held

#### Scenario: A superseded admission transition publishes once

- **WHEN** the durable admission transition returns `superseded`
- **THEN** exactly one `TaskSuperseded` is published carrying that boundary's observation point

#### Scenario: One pipeline run publishes at most one supersession

- **WHEN** an inline pipeline run reaches its `superseded` outcome after passing more than one internal supersession check
- **THEN** exactly one `TaskSuperseded` is published for that run

#### Scenario: No superseder is fabricated

- **WHEN** any published `TaskSuperseded` payload is inspected
- **THEN** it contains no field naming the superseding task, lease, worker, or request — because no observation point in the code holds that handle

#### Scenario: A non-superseded outcome publishes nothing

- **WHEN** a pipeline run or reservation completes with any outcome other than `superseded`
- **THEN** zero `TaskSuperseded` events are published for it

### Requirement: Existing guardrails behavior is proven unchanged by characterization

Behavioral equivalence SHALL be proven as characterization: the existing tests pass **unmodified**. Concretely, on the change's tree no `*.spec.ts` file inside `apps/api/src/guardrails/` SHALL be modified — the directory's 120 `test()` cases across its 5 spec files (57 + 54 + 3 + 3 + 3) and its 8 `.test.mjs` assertion scripts (which include 6 inline source mirrors) SHALL pass as-is. Outside that directory, the only permitted edit to a `*.spec.ts` is adding or omitting the trailing optional bus argument in a positional `new GuardrailsService(...)` construction; no assertion, expected value, counter, or scenario SHALL be edited. Source-text-scanning tests (for example `sandbox-host-harness-wiring.test.mjs`) SHALL be enumerated separately from behavioral tests, and any edit to one SHALL preserve its per-file assertion strength.

#### Scenario: Zero in-directory spec files are modified

- **WHEN** the change's diff is filtered to `apps/api/src/guardrails/**/*.spec.ts`
- **THEN** zero files appear, and all 120 `test()` cases plus the 8 `.test.mjs` scripts pass on the integrated tree

#### Scenario: Out-of-directory specs change only their construction argument

- **WHEN** the diff is filtered to the 9 files outside `apps/api/src/guardrails/` that construct `GuardrailsService` positionally (6 under `tasks/`, 2 under `public-surface/`, 1 under `task-admission/`)
- **THEN** every hunk is limited to the trailing optional bus argument, and no assertion, expected value, or counter is changed

#### Scenario: A text-scanning test keeps its strength

- **WHEN** a source-text-scanning test must be updated because a publish call was added to a file it scans
- **THEN** the update keeps its per-file assertions (each provisioning path still resolves its workspace source; the provision-context count remains pinned per file) rather than relaxing to an aggregate total

#### Scenario: Publish points carry their own new tests

- **WHEN** the change's new tests are enumerated
- **THEN** each of the declared publish points has a test asserting that publishing happens exactly once with a payload that parses against its schema — because publishing is new behavior that no pre-existing test can cover

#### Scenario: The bus is absent from the characterization baseline

- **WHEN** the unmodified in-directory guardrails specs run without a bus injected
- **THEN** they pass, proving the added publish calls are conditional on the injected collaborator and change nothing when it is absent
