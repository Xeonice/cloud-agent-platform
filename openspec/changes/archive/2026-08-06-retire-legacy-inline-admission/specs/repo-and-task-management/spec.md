## ADDED Requirements

### Requirement: Boot recovery re-offers nothing into the retired pipeline, and the rows it used to pick up fail closed

The startup coordinator SHALL NOT re-offer pending or queued work into the process-local semaphore,
and `TasksService.reofferQueuedOnStartup()` SHALL be deleted rather than left calling a collaborator
this change removed. The step existed for exactly one purpose: to hand rows with no durable admission
work to the synchronous in-request pipeline through `guardrails.admit()`. With that pipeline retired
the re-offer has no sink, so keeping it would mean keeping a boot step that calls nothing.

The removal SHALL be recorded together with the POPULATION it covered, because the surviving recovery
does not cover the same rows and a reader who assumes continuity will be wrong about which tasks a
restart picks up. The deleted re-offer selected `admissionWork: { is: null }` AND
(`status: 'queued'` OR `status: 'pending'` with `scheduleRun: { is: null }`) — direct pending work and
every queued row. The surviving claim query, `ScheduledTasksService.recoverPendingAdmissions`, selects
`taskScheduleRun` rows at `status: 'created'` with a non-null `taskId` whose task is `pending` with
`admissionWork: { is: null }` — SCHEDULED pending work. On the pending branch the two populations are
disjoint BY CONSTRUCTION: the deleted query required `scheduleRun: { is: null }` and the surviving one
reads through a schedule run that exists. No surviving query recovers a `queued` row at all. A change
that describes this removal as "recovered by the claim query instead" SHALL be treated as wrong;
what is true is narrower, and the startup coordinator's own docstring SHALL say the narrower thing.

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
