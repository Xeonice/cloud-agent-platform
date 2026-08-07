## ADDED Requirements

### Requirement: Boot recovery re-offers nothing into the retired pipeline, and the rows it used to pick up fail closed

The startup coordinator SHALL NOT re-offer pending or queued work into the process-local semaphore,
and `TasksService.reofferQueuedOnStartup()` SHALL be deleted rather than left calling a collaborator
this change removed. The step existed for exactly one purpose: to hand rows with no durable admission
work to the synchronous in-request pipeline through `guardrails.admit()`. With that pipeline retired
the re-offer has no sink, so keeping it would mean keeping a boot step that calls nothing.

The removal SHALL be recorded together with the POPULATION it covered, because NO surviving query
covers those rows and a reader who assumes continuity will be wrong about which tasks a restart picks
up. The deleted re-offer selected `admissionWork: { is: null }` AND (`status: 'queued'` OR
`status: 'pending'` with `scheduleRun: { is: null }`) — direct pending work and every queued row.

⚠ An earlier statement of this requirement named `ScheduledTasksService.recoverPendingAdmissions` as
"the surviving claim query" and built a disjointness argument on it. That was wrong in a way worth
recording rather than editing away: **that sweep selected the same emptied population** — runs whose
task has `admissionWork: { is: null }` — and durable acceptance writes an admission-work row inside
the acceptance transaction, so nothing a normal acceptance produces can match it. It was retired in
the same change, for the same reason and by the same test, and is the subject of the requirement
below. There is no surviving pending-admission sweep of any kind.

Tasks WITH durable admission work are unaffected and SHALL NOT be described as part of this gap: they
are leased by the durable worker, which is the path the existing "API exits after commit" scenario
pins, and this change does not touch it.

What becomes of the uncovered rows SHALL be stated rather than left to inference. A task committed
without durable admission work cannot be admitted by anything, and the post-commit dispatch SHALL say
so at the moment it happens — returning a named `fail-closed` outcome and logging that the pipeline
which used to pick such rows up is retired — instead of returning a success outcome, or leaving the
caller to infer failure from a count. This is a FAIL-CLOSED CONTRACT, not a recovery path: nothing
retries these rows, and stating otherwise would be a false promise. The premise that such rows do not
exist in production is the USER-SUPPLIED premise recorded as D4, not a measurement from this tree.

The post-commit dispatch result SHALL be a two-member union — `durable-woken` and `fail-closed` — and
no arm for a third outcome may survive the narrowing. A branch that both guards make unreachable is
the residue of the outcome this change removed, and SHALL be deleted with it rather than left to read
as live recovery logic.

Test doubles of that dispatch SHALL return only members the union still declares, and this SHALL be
checked rather than assumed, because the type system cannot see it. The doubles are installed through
`as unknown as TasksService`, so a double returning the retired `'legacy-admitted'` compiles, runs,
and keeps the removed arm ALIVE under test while the compiler reports it as unreachable. That is
exactly what happened here: the arm read as dead code by narrowing, yet four scheduled-recovery tests
were still driving it through a stale default. Deleting the arm without moving the doubles turns a
false green into a red — which is the honest direction, but it means the doubles are part of the
narrowing, not a consequence of it. A retired union member SHALL leave the doubles in the same commit
it leaves the type.

#### Scenario: The boot re-offer leaves with the sink it fed

- **WHEN** `apps/api/src` is searched for `reofferQueuedOnStartup` on lines that are not comments
- **THEN** zero remain — no declaration, no call from a startup coordinator, and no member on the
  guardrails interface `TasksService` depends on — so the step is deleted rather than retained as an
  unreachable boot phase. Comment lines are excluded DELIBERATELY: prose that names the retired step
  and says why it went is the record this requirement wants kept, and a check that counted it would
  push a future author to erase the explanation to make the number go to zero

#### Scenario: The hand-written startup model moves with the step it modelled

- **WHEN** the no-transpile startup-recovery model is read after the production method is deleted
- **THEN** it declares no mirror of the deleted method, its fake guardrails declares no `admit` member
  (the production interface no longer has one), and no test in it asserts on a boot re-offer — because
  a model that outlives what it models keeps reporting coverage that no longer exists, and it stays
  green while doing so, which is worse than having no model at all
- **AND** the assertions in it that survive are kept rather than deleted wholesale: the ones whose
  subject was only the re-offer go under a (c) ledger entry, and the ones that carried a surviving
  concern alongside a re-offer observation are re-expressed against that concern under (a)

#### Scenario: The startup coordinator states the narrower truth

- **WHEN** the startup coordinator's own documentation of its boot phases is read
- **THEN** it says there is no boot re-offer step and names the retired in-request pipeline as the
  reason, and it does not claim that the surviving claim query recovers the rows the re-offer covered,
  because on the pending branch those two populations are disjoint

#### Scenario: A committed row with no durable admission work fails closed and says why

- **WHEN** post-commit dispatch runs for a task that was committed with no durable admission work item
- **THEN** it writes the creation audit exactly as the acceptance transaction would have, returns the
  named `fail-closed` outcome rather than a success outcome, and logs that the task cannot be admitted
  because the synchronous in-request pipeline that used to pick such rows up is retired

#### Scenario: No residual arm survives the union narrowing

- **WHEN** every caller of post-commit dispatch is read after the result union narrows to two members
- **THEN** each caller handles exactly `durable-woken` and `fail-closed`, and no statement sits after
  the two guards where the outcome has narrowed to `never`
- **AND** no test double of that dispatch returns the retired member: `'legacy-admitted'` appears on
  no code line anywhere in `apps` / `packages` / `scripts` outside archived changes, so the arm cannot
  be kept alive under test while the compiler calls it unreachable

### Requirement: Acceptance resolves the sandbox environment before it writes

Task acceptance SHALL resolve the sandbox environment — provider candidate, capabilities, and the
immutable resource snapshot — BEFORE the acceptance write, unconditionally. Removing the admission
mode branch removed the guard that used to skip it (`tasks.service.ts`, `if (admissionMode ===
'durable-v2')` at `main:1253`), so there is no longer a path that accepts a task and resolves later.
The preparation type enforces it rather than a reviewer: `PreparedTaskCreate` is one shape requiring
`resolvedBranch` and `resourceSnapshot`, so a fixture that omits them fails to compile instead of
being silently accepted as a different kind of preparation.

The CONSEQUENCE SHALL be stated rather than described as "unchanged", because it is observable on the
public surface. A deployment whose sandbox provider cannot be resolved — no pinned image, an
unavailable candidate, a capability shortfall — now fails task creation with **400**
`sandbox_environment_resource_unsupported`. The retired in-request path returned **201** and failed
later. This is fail-fast and matches the rest of this change's posture (an unadmittable task says so
at the moment it happens rather than sitting pending), but it is a behaviour change and an artifact
that writes "POST /tasks still returns 201" without qualification is WRONG. What is unqualified is
narrower: the admission CAPABILITY gate introduces no refusal, no `503`, and no new `AdmissionMode`
member. Sandbox resolution is a different failure, on a different code path, with a different status.

This was found by CI, not by verification: four adversarial verify passes did not cover it, because
the false claim lived in `proposal.md` and `surface-impact.json` — prose with no requirement behind
it — and verify enumerates requirements. A claim about runtime behaviour SHALL be carried by a
requirement, or it is unverifiable by construction.

Any CI job that creates a task SHALL provide a pinned `AIO_SANDBOX_IMAGE`, for the same reason: with
resolution unconditional, an unpinned runner turns every creation into a 400.

#### Scenario: Resolution precedes the acceptance write

- **WHEN** a task is accepted through any surface
- **THEN** the sandbox environment is resolved first and its resource snapshot is part of the row that
  is written, with no branch that reaches the write without one

#### Scenario: An unresolvable provider fails creation instead of deferring

- **WHEN** the selected sandbox provider candidate is unavailable at acceptance time
- **THEN** creation responds **400** `sandbox_environment_resource_unsupported` carrying the
  underlying reason, rather than responding 201 and failing during provisioning

#### Scenario: A snapshot-less acceptance is unrepresentable

- **WHEN** a fixture or caller constructs a task preparation without `resolvedBranch` or
  `resourceSnapshot`
- **THEN** it fails to compile, because the preparation type is a single shape rather than a union
  with a snapshot-free member

### Requirement: The pending-admission sweep is retired with the population it served

The pending-admission sweep SHALL be deleted whole: `ScheduledTasksService.recoverPendingAdmissions`,
the wrapper `runRecoverySafely` that guarded it, and both call sites — bootstrap's disabled branch and
the pre-tick step of every poll cycle. The sweep selected `taskScheduleRun` rows at `status: 'created'` whose task was `pending`
with `admissionWork: { is: null }`. Durable acceptance writes an admission-work row INSIDE the
acceptance transaction, so no row a normal acceptance produces can ever match that filter — the
sweep's population is empty by construction, exactly as the boot re-offer's was.

The one shape that can still reach `admissionWork: null` is the FAIL-CLOSED row, and the sweep is not
a safety net for it: recovery would call post-commit dispatch again, find no work again, and return
`fail-closed` again, forever. A retained sweep that cannot make progress is worse than no sweep,
because it reads like a recovery path to whoever finds it next.

This is the SECOND recovery path this retirement empties, and the pair SHALL be read together: the
boot re-offer fed the retired in-request pipeline directly, while this one fed the population that
pipeline used to leave behind. Retiring the producer without retiring the consumers leaves machinery
whose only remaining behaviour is to look like it is doing something.

The deletion SHALL take its tests with it under a (c) subject-retired ledger rather than leaving them
green against a method that no longer exists — the failure mode this change already found twice, in
`startup-recovery.test.mjs` and in the scheduled-tasks stub that returned a retired union member.

#### Scenario: No pending-admission sweep survives

- **WHEN** `apps/api/src` is searched for `recoverPendingAdmissions` or `runRecoverySafely` on lines
  that are not comments
- **THEN** zero remain — no declaration, no wrapper, and no call from the bootstrap or poll paths

#### Scenario: The poll cycle ticks without a recovery step

- **WHEN** the scheduled-task poll cycle runs
- **THEN** it calls `tick` directly, one cycle at a time, and a throwing tick does not stop the
  poller — the resilience the sweep's failure path used to demonstrate is unchanged, only its source

#### Scenario: The retired tests are ledgered, not silently dropped

- **WHEN** the api suite's test count is compared before and after
- **THEN** the difference is accounted for name by name in the change's task ledger, classified (c)
  where the subject is the sweep itself and (a) where a surviving concern was re-expressed against a
  different seam

### Requirement: A durable lifecycle transition is attributed to the task owner

An audit event for a lifecycle transition SHALL carry an attributed user even when no request context
supplied one. A durable admission runs on a worker, so `DurableAdmissionCapacityRequest.userId` is
absent by construction — the field exists and is optional precisely for that case — and the
transition SHALL fall back to the task's own `ownerUserId`, read in the same authority row the
capacity reservation already locks (`FOR UPDATE OF t, w`), rather than being written ownerless.

This mirrors the convention `task.created` already follows: the post-commit dispatch resolves the
owner (`resolveTaskOwnerId`) and attributes the creation audit to them even on the fail-closed path.
An audit trail where creation has an owner and the very next lifecycle row does not is not a design,
it is an omission.

The omission SHALL be recorded as PRE-EXISTING rather than as a regression of the retirement: `main`'s
call site does not pass a user either. What the retirement changed is the BLAST RADIUS — before it,
only a deployment with durable admission enabled took this path, so ownerless lifecycle rows were a
property of an opt-in mode; after it, every deployment takes it, so the gap became universal. A latent
gap that a change makes universal is that change's to close.

#### Scenario: An automatically dispatched task keeps its owner on the running row

- **WHEN** a scheduled task is dispatched with no acting user and the durable admission transitions it
  to `running`
- **THEN** the `task.running` audit event carries the task's owner as its user, the same owner the
  `task.created` row carries

#### Scenario: An explicit acting user still wins

- **WHEN** a caller does supply `userId` on the capacity request
- **THEN** that user is attributed and the owner fallback is not consulted, so an operator-initiated
  transition is never misattributed to the owner
