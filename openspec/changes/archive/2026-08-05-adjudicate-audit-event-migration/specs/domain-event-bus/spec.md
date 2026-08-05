## ADDED Requirements

### Requirement: The non-event admission rule declares three named refusal criteria

The capability SHALL declare, alongside the event catalog, exactly three named criteria under which a collaboration is refused admission to the bus and MUST remain a direct port call. Each criterion SHALL be stated as a property of the collaboration — not as a property of the concern's name — and each SHALL name at least one adjudicated call site as its worked example:

1. `acknowledgement-required` — the caller reads the collaborator's return value and branches on it. `publish` returns `void` and swallows subscriber failures by design (the bus port's CONTRACT), so an acknowledgement cannot physically survive the hop. Worked examples: `recordProvisioningFailure` and `recordTaskCancellation`, both returning `Promise<boolean>`. The declaration SHALL name the industry term *passive-aggressive event* for this class.
2. `information-missing` — no published payload carries a field the audit write consumes, or carries the control-flow attribution that decides whether the write happens at all. Worked example: `recordForceFailed`, which needs both the `force_failed:${cause}` cause and the "only the locally confirmed CAS callback owns this row" attribution, neither of which `TaskSettled` carries.
3. `no-decoupling-gain` — the payload could only carry the missing field if the producer performed the same I/O first, so the coupling moves instead of disappearing and the dependency budget does not fall. Worked example: `recordExited`, whose `tail` argument is produced by a `gateway.readSessionLogTail` call at the producer.

Any CALL verdict recorded by a phase-4 adjudication SHALL cite exactly one of these three criterion names.

#### Scenario: A result-branching call site is refused under criterion 1

- **WHEN** the declared rule is applied to a call site whose caller assigns the collaborator's return value and branches on it
- **THEN** the verdict is CALL citing `acknowledgement-required`, and the stated reason is that `publish` returns `void` and swallows subscriber failures — not that the collaborator is named "audit"

#### Scenario: recordForceFailed is refused under criterion 2

- **WHEN** `recordForceFailed` is evaluated field-by-field against all five catalog payloads
- **THEN** no payload carries the `force_failed:${cause}` cause and none carries the local-CAS attribution, and the verdict is CALL citing `information-missing`

#### Scenario: recordExited is refused under criterion 3

- **WHEN** `recordExited` is evaluated for event migration
- **THEN** the verdict is CALL citing `no-decoupling-gain`, on the recorded ground that carrying `tail` in a payload requires the producer to keep performing the `readSessionLogTail` I/O

#### Scenario: The criteria are stated as properties, not as an exception list

- **WHEN** the declaration is read
- **THEN** each of the three criteria is expressed in terms of return semantics, payload sufficiency, or I/O ownership, and every named call site appears as a worked example of a criterion rather than as a standalone exemption

#### Scenario: Every CALL verdict cites exactly one criterion name

- **WHEN** the change's adjudication artifact rows carrying verdict CALL are read
- **THEN** each row cites exactly one of `acknowledgement-required`, `information-missing`, `no-decoupling-gain`, and zero rows cite none or more than one

### Requirement: Audit durability is classified into two named tiers

The capability SHALL name exactly two persistence tiers and SHALL classify every adjudicated audit call site into exactly one of them:

- `batch` — best-effort. The write may be lost; the caller does not learn of the failure and does not branch on it. A `batch` site is eligible for event migration once a published payload carries every field the write consumes.
- `blocking-strict` — the write's failure MUST be visible to the caller. A `blocking-strict` site SHALL remain a direct port call for as long as `publish` returns `void`, and SHALL NOT be registered as a subscriber.

The two tier names SHALL be declared once, in the capability's declaration next to the catalog; the adjudication artifact and any later phase-4 change SHALL reference those names rather than restating or renaming the definitions.

#### Scenario: Every adjudicated site carries exactly one tier

- **WHEN** the adjudication artifact's rows are read
- **THEN** each row carries exactly one of `batch` or `blocking-strict`, and zero rows carry both or neither

#### Scenario: The blocking-strict set is exactly the two acknowledgement returns

- **WHEN** the rows labelled `blocking-strict` are enumerated
- **THEN** the result is exactly the `recordProvisioningFailure` and `recordTaskCancellation` collaborations — accounting for four `this.audit` symbol references (two `if (!this.audit)` guards plus two awaited calls) — and no `batch` row returns a value the caller reads

#### Scenario: A blocking-strict method cannot be registered as a subscriber

- **WHEN** the self-invalidating typecheck fixture passes `recordProvisioningFailure` or a handler calling `recordTaskCancellation` to `subscribe`
- **THEN** `tsc --noEmit` reports an error at that call site, so the tier boundary is enforced by the compiler rather than by review

#### Scenario: A blocking-strict failure keeps the work reclaimable

- **WHEN** a terminal admission recovery cannot confirm the audit write's durability
- **THEN** `TaskAdmissionCoordinationError('checkpoint', …)` is thrown, the running work row stays leased and reclaimable, and expiry recovery retries the audit boundary

#### Scenario: The tier vocabulary is declared once

- **WHEN** the repository is searched for the tier names `batch` and `blocking-strict` in phase-4 artifacts
- **THEN** exactly one file defines them and every other occurrence references that definition instead of restating it

### Requirement: Migrating an audit write SHALL NOT make it asynchronous, queued, or deferred

Moving an audit write onto the bus SHALL preserve synchronous capture within the operation that caused it. No audit write path introduced or touched by a phase-4 migration SHALL enqueue the write, batch it across ticks, schedule it onto a later tick, or stage it in an intermediate store. The capability SHALL state the upgrade condition verbatim: moving a `blocking-strict` site onto the bus requires a durable publication registry (one row per event/listener pair, written in the originating transaction, replayed on restart), which requires its own change with a schema migration; until such a change exists, the migration is refused rather than approximated.

#### Scenario: No deferral primitive appears on an audit write path

- **WHEN** the audit write paths this change touches are searched for `setTimeout`, `setImmediate`, `process.nextTick`, and queue/enqueue helpers
- **THEN** zero matches are found

#### Scenario: The change persists no events and adds no migration

- **WHEN** the change's diff is inspected
- **THEN** it contains zero edits to `apps/api/prisma/schema.prisma`, zero new migration directories, and no code path that writes a published event to any table

#### Scenario: The upgrade condition for blocking-strict is stated, not implied

- **WHEN** the declaration is read
- **THEN** it names the publication-registry precondition and states that a `blocking-strict` site is refused admission until that registry exists

### Requirement: Each event type's registered subscriber set is asserted as an exact set

A table-driven test SHALL assert, for every event type in the catalog, the **exact set** of registered subscriber names bound to the `DOMAIN_EVENT_SUBSCRIBERS` array token. The assertion SHALL be set equality — not a count, not a superset check — so that both an unlisted registration and a silently dropped registration turn it red. The table's keys SHALL be derived from the exported event-type literals so a new event type cannot be added without a corresponding row.

#### Scenario: The table covers every catalog type

- **WHEN** the test's table keys are compared with the exported event type literals
- **THEN** the two sets are equal, and adding a sixth event type without a table row fails the test

#### Scenario: An unlisted subscriber turns the test red

- **WHEN** a subscriber registration is added to the array token without updating the table
- **THEN** the test fails, naming the event type and the unexpected subscriber name

#### Scenario: A silently dropped subscriber turns the test red

- **WHEN** a registration listed in the table is removed from the array token
- **THEN** the test fails naming the missing subscriber, rather than passing because the observed set is a subset

#### Scenario: The expected set on this change's tree is empty for every event type

- **WHEN** the test runs on the integrated tree
- **THEN** all five expected sets are empty and the test passes, recording that this change adjudicated the audit call sites without registering a subscriber

### Requirement: A removed synchronous call SHALL have a provably reachable owner

Every synchronous collaborator call a phase-4 change removes SHALL have its recorded semantics reachable after the removal by at least one of: (i) a registered subscriber path for a published event, or (ii) another owner that writes the same audit row identity (the same dedupe key). A call site with no such owner MUST be retained as a call. A removal SHALL be accompanied by an executable proof — a test that exercises the operation with the call removed and asserts the row is still recorded — and not by a prose argument alone.

#### Scenario: Removal ships with an executable proof

- **WHEN** the change's diff removes a synchronous audit call site
- **THEN** the same change contains a test that exercises the affected operation and asserts the corresponding audit row is still written by its declared other owner

#### Scenario: An unowned call site is retained

- **WHEN** adjudication finds a call site whose audit row no other owner writes
- **THEN** the call remains in place, its symbol references stay counted in the dependency-budget baseline, and the artifact records the verdict CALL with its refusal criterion

#### Scenario: Reconciliation is bidirectional

- **WHEN** the adjudication artifact's rows are read
- **THEN** each row records both directions — the outbound collaborator the orchestrator calls, and the inbound dependents that rely on that write's timing or result (the durable admission reclaim path and the tests that assert on it)

## MODIFIED Requirements

### Requirement: Subscribers are registered explicitly and only registered subscribers run

Subscriber registration SHALL go through one explicitly declared injection token holding an array of subscriber registrations (for example `DOMAIN_EVENT_SUBSCRIBERS`). The bus SHALL NOT discover subscribers by runtime scanning: it SHALL NOT use `DiscoveryService`, `MetadataScanner`, or a custom handler decorator, because runtime discovery defeats the compile-time subscriber guard below.

The bound array SHALL remain enumerable at test time so the registered set can be asserted as an exact set per event type. A subscriber SHALL be added to that array only by a change that has first proven, per the coverage-reconciliation requirement, that the published payload carries every field the subscriber's write consumes.

#### Scenario: No runtime discovery mechanism is introduced

- **WHEN** the change's added files are searched for `DiscoveryService`, `MetadataScanner`, and `@nestjs/cqrs` / `@nestjs/event-emitter` imports
- **THEN** zero matches are found, and neither package appears in the root or `apps/api` `package.json`

#### Scenario: A subscriber absent from the array token is never invoked

- **WHEN** a handler exists in the codebase but is not present in the array bound to the subscriber token, and an event of its type is published
- **THEN** that handler is not invoked

#### Scenario: The registered set is still empty after the audit adjudication

- **WHEN** the array bound to the subscriber token is inspected on this change's tree
- **THEN** it is empty, because all nine adjudicated guardrails audit references resolved to CALL or REMOVED and none resolved to EVENT, so no published event produces any side effect

#### Scenario: The registered set is asserted, not merely observed

- **WHEN** the subscriber array is read by the table-driven set test
- **THEN** the observed registration names are compared for set equality against the declared expectation for each event type, so a future registration cannot appear or vanish without a failing test

### Requirement: The dependency budget ratchet is seeded with measured counts

The R11 dependency-budget ratchet records, per collaborator, the number of guardrails symbol references that the phase-4 migrations must burn down. Counts SHALL be measured live on the change's own tree rather than copied from documentation. The measured seed established when the baseline was created was: `this.audit` 9, `this.runnerMinutes` 6, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4, `this.transcripts` 2, metrics-projection 2. The ratchet SHALL be fail-closed in both directions: a count above baseline fails, and a stale entry whose real count is lower also fails until the baseline is reduced in the same commit.

A change that lowers a recorded count SHALL lower it only by deleting symbol references, and SHALL prove that in the same commit: the measured symbol string SHALL be unchanged (renaming the field is a forged burn-down, since the counter is a `\b`-anchored regex over that exact symbol), and the delta from the previous count SHALL equal the number of references the change's adjudication artifact marks REMOVED. An entry SHALL be reduced, never deleted, while its live count is above zero. The `samples` array is documentation and does not participate in comparison; a change that edits an entry SHALL refresh its stale sample lines in the same commit.

#### Scenario: The baseline matches a live re-count

- **WHEN** the ratchet is run against the integrated tree
- **THEN** each recorded count equals the live count for that collaborator and the ratchet exits 0

#### Scenario: An added call site turns the ratchet red

- **WHEN** one extra call to a budgeted collaborator is injected into `guardrails.service.ts`
- **THEN** the ratchet fails and names the collaborator whose count rose

#### Scenario: A stale higher baseline also turns the ratchet red

- **WHEN** a call site is removed without lowering the recorded count in the same commit
- **THEN** the ratchet fails on the stale entry rather than passing because the tree is "better than baseline"

#### Scenario: The audit delta equals the adjudicated removals

- **WHEN** the recorded `this.audit` count on the integrated tree is compared with the seed of 9
- **THEN** the difference equals the number of adjudication rows marked REMOVED (0 if the provisioning-progress hint is retained, 1 if its coverage proof succeeded), and no other collaborator's count changed

#### Scenario: A renamed field cannot be presented as a burn-down

- **WHEN** the measured symbol is compared before and after the change
- **THEN** it is still `this.audit`, so the count reflects deleted references rather than a symbol the regex no longer matches

#### Scenario: A non-zero entry is reduced rather than deleted

- **WHEN** the `this.audit` entry is inspected after the change
- **THEN** it is still present with its remaining count and refreshed sample lines, because deletion is reserved for entries whose live count reaches zero

### Requirement: The cutover toggle is registered with an owner and a retirement condition

The toggle SHALL be registered in the repository's deploy documentation with its environment variable name, its default, its owner, and the named condition under which it is removed. Registration SHALL NOT require a deploy runbook or `scripts/quick-deploy.sh` wiring — the documented-toggle form is the proportional one.

The registered description SHALL remain factually true of the tree it ships with. Specifically, the claim that closing the toggle restores byte-identical pre-change behaviour SHALL stand only while zero synchronous collaborator calls have been removed; once a change removes one, the registration SHALL be rewritten in the same commit to state how many direct calls have been removed and to name what closing the toggle does **not** restore. No second cutover toggle SHALL be introduced by a change that does not create a second live code path.

#### Scenario: The registry entry is complete

- **WHEN** the deploy documentation entry for this toggle is read
- **THEN** it states the variable name, the default (publishing on), the owner, and the retirement condition naming the change that removes it

#### Scenario: No heavyweight cutover wiring is added

- **WHEN** the change's diff is inspected
- **THEN** it adds no new deploy runbook file and makes no edit to `scripts/quick-deploy.sh` or the compose files for this toggle

#### Scenario: The entry's counts match the tree

- **WHEN** the registration's claims are checked against the integrated tree
- **THEN** the number of registered subscribers it claims equals the length of the bound subscriber array, and the number of removed direct calls it claims equals the count of adjudication rows marked REMOVED

#### Scenario: The byte-identical claim is withdrawn once a call is removed

- **WHEN** a synchronous collaborator call has been removed and the registration is read
- **THEN** it no longer claims that closing the toggle reproduces the pre-change behaviour byte-for-byte, and instead names the removed call and its new owner

#### Scenario: No second toggle row appears

- **WHEN** the deploy documentation's registered-toggle table is diffed on this change
- **THEN** it still has exactly one row, because this change introduces no second live path and its escape hatch is a version rollback
