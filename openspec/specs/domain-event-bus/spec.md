# domain-event-bus Specification

## Purpose
TBD - created by archiving change add-domain-event-bus. Update Purpose after archive.
## Requirements
### Requirement: The domain event bus is a declared in-process port with synchronous dispatch

The system SHALL provide a process-local domain event bus declared as a narrow port file whose name ends in `.port.ts` (interface + string DI token, shaped after `apps/api/src/audit/audit-recorder.port.ts`), with its concrete implementation in a file whose name ends in `.service.ts` and its cross-module binding declared in a `*.module.ts` / `app.module.ts`. Publishers SHALL depend only on the port; no publisher SHALL import the implementation file.

`publish(event)` SHALL deliver the event to every registered subscriber for that event type **synchronously**, in registration order, and SHALL complete that delivery before `publish` returns to its caller. The bus SHALL NOT await subscriber return values, SHALL NOT queue, defer, batch, or schedule delivery onto a later tick, and SHALL NOT persist any event.

#### Scenario: Delivery completes before publish returns

- **WHEN** three subscribers are registered for an event type and a publisher calls `publish(event)` followed by a statement that records a marker
- **THEN** all three subscribers have run, in registration order, before the marker statement executes

#### Scenario: Publishing with no subscribers is a no-op

- **WHEN** `publish(event)` is called for an event type with zero registered subscribers
- **THEN** the call returns normally, throws nothing, and performs no I/O, no database access, and no logging at error level

#### Scenario: Publishers depend only on the port file

- **WHEN** every file that calls `publish` in the change's tree is inspected for its import of the bus
- **THEN** each imports the bus interface and DI token from the `.port.ts` file, and zero of them import the `.service.ts` implementation

#### Scenario: The port file itself imports no service

- **WHEN** the bus `.port.ts` file's import list is inspected
- **THEN** it imports no file whose name ends in `.service.ts` (its layer classification is `domain`, whose only allowed import layer is `domain`)

### Requirement: Subscriber failures are isolated per subscriber

The bus SHALL invoke each subscriber inside its own error boundary. A subscriber that throws SHALL NOT prevent any subsequently registered subscriber from being invoked, SHALL NOT abort the dispatch loop, and SHALL NOT propagate its exception to the publisher: `publish` SHALL return normally in that case. The bus SHALL NOT rely on a bare `EventEmitter` for this guarantee (on Node v22 a throwing listener both skips later listeners and re-throws out of `emit()`).

#### Scenario: A throwing subscriber does not stop the ones after it

- **WHEN** three subscribers `A`, `B`, `C` are registered in that order, `B` throws, and an event is published
- **THEN** `A` and `C` are both invoked exactly once, `publish` returns normally, and the publisher observes no exception

#### Scenario: Every subscriber failing still returns normally

- **WHEN** every registered subscriber for an event type throws on invocation
- **THEN** each one is invoked exactly once, `publish` returns normally, and the publisher's next statement executes

#### Scenario: A subscriber throwing a non-Error value is still isolated

- **WHEN** a subscriber throws a string, `undefined`, or a non-`Error` object
- **THEN** the dispatch loop continues to the next subscriber and `publish` returns normally

### Requirement: Swallowed subscriber failures are observable

Every subscriber registration SHALL carry a stable subscriber name. When the bus swallows a subscriber failure it SHALL emit exactly one structured log record at warning level or higher carrying at minimum the event type, the failing subscriber's name, and the error's message. Silence SHALL NOT be an accepted outcome of a swallowed failure.

#### Scenario: A swallowed failure produces one named log record

- **WHEN** a subscriber registered under the name `metrics-projection` throws `new Error('boom')` while handling event type `task.settled`
- **THEN** exactly one log record is emitted whose fields include the event type `task.settled`, the subscriber name `metrics-projection`, and the message `boom`

#### Scenario: Two failing subscribers produce two distinguishable records

- **WHEN** two differently named subscribers both throw while handling the same published event
- **THEN** two log records are emitted, each naming its own subscriber, and neither record is collapsed into or replaced by the other

#### Scenario: A registration without a name is rejected

- **WHEN** a subscriber is registered with an empty or missing name
- **THEN** the registration is rejected at construction time rather than producing an anonymous log record at failure time

### Requirement: A subscriber failure never escalates into a process-level failure

The bus SHALL NOT use `'error'` as an event type, SHALL NOT route its own failure reporting through a published event (no re-entrant `publish` from the failure path), and SHALL NOT allow a subscriber failure to surface as an uncaught exception or an `unhandledRejection`.

#### Scenario: No catalog entry is named error

- **WHEN** the declared list of event type literals is inspected
- **THEN** no literal equals `error`, and every literal is unique

#### Scenario: Failure reporting does not re-enter the bus

- **WHEN** a subscriber throws and the bus reports the failure
- **THEN** the failure path calls the logger and performs zero additional `publish` calls

#### Scenario: No process-level handler is triggered

- **WHEN** an event is published while a registered subscriber throws
- **THEN** no `uncaughtException` and no `unhandledRejection` handler fires during that publish

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

### Requirement: Subscriber handlers must return void, enforced at compile time

The subscriber registration signature SHALL reject, at TypeScript compile time, any handler whose return type is not `void` — including handlers returning a value, and including `async` handlers returning `Promise<void>`. The registration signature SHALL take the shape verified against tsc 5.9.3 strict:

```ts
subscribe<T extends (e: DomainEvent) => any>(
  handler: T & (ReturnType<T> extends void ? unknown : BrandedNonEventError),
): void;
```

where the rejection type is an object type carrying a human-readable explanation key, so the compiler prints the explanation verbatim in the error. A subscriber that must perform I/O SHALL start that work inside a `void`-returning method that owns its own error handling, and SHALL NOT return the promise to the bus — this is the declared escape hatch for the later transcript and diagnostics subscribers.

#### Scenario: A handler returning a value fails to compile

- **WHEN** `(e) => ({ durable: true })` is passed to `subscribe`
- **THEN** `tsc --noEmit` under the repository's strict configuration reports an error on that call

#### Scenario: An async handler fails to compile

- **WHEN** `async (e) => {}` is passed to `subscribe`
- **THEN** `tsc --noEmit` reports an error on that call, because `Promise<void>` does not extend `void`

#### Scenario: Legitimate synchronous handlers compile clean

- **WHEN** `(e) => {}`, `(e) => someVoidMethod(e)`, and `subscriberInstance.onSettled.bind(subscriberInstance)` (a `void`-returning method) are each passed to `subscribe`
- **THEN** `tsc --noEmit` reports zero errors for those three call sites

#### Scenario: The fire-and-forget escape hatch compiles clean

- **WHEN** a handler body starts asynchronous work with its own `.catch(...)` and returns nothing
- **THEN** the call site compiles, and `publish` returns without awaiting that asynchronous work

#### Scenario: The rejection message names the rule

- **WHEN** a rejected handler's compile error text is read
- **THEN** it contains the branded explanation stating that subscribers must return void and that a collaborator returning an acknowledgement is a CALL, not an EVENT

### Requirement: The non-event admission rule is declared and mechanically enforced

The capability SHALL declare the admission rule in prose next to the catalog: **a collaboration that requires an acknowledgement, that can be refused, or whose result the publisher depends on is a CALL, not an EVENT.** The rule SHALL be stated in terms of return/acknowledgement semantics, not in terms of concern names. The three collaborations currently classified as non-events — the terminal provisioning audit detail's durability acknowledgement (`recordProvisioningFailure`/`recordTaskCancellation`, returning `Promise<boolean>`), the admission-work state transitions (`lease.authorize()`/`lease.checkpoint()`, awaited for authority), and the provisioning diagnostics write gate (`isEnabled(): boolean`) — SHALL be named in that declaration, and a self-invalidating `*.typecheck.ts` fixture SHALL prove each of them cannot be registered as a subscriber.

#### Scenario: The audit acknowledgement port cannot be registered

- **WHEN** the fixture passes the real `recordProvisioningFailure` method (returns `Promise<boolean>`) to `subscribe`
- **THEN** `tsc --noEmit` reports an error at that call site

#### Scenario: The diagnostics write gate cannot be registered

- **WHEN** the fixture passes the real write-gate `isEnabled()` (returns `boolean`) to `subscribe`
- **THEN** `tsc --noEmit` reports an error at that call site

#### Scenario: The fixture self-invalidates when the guard stops working

- **WHEN** any of the fixture's negative cases stops producing an error (for example because the guard was weakened to a plain `(e) => void` parameter type)
- **THEN** `tsc --noEmit` fails on that fixture with TS2578 for the now-unused `@ts-expect-error` directive, so a weakened guard cannot pass silently

#### Scenario: The declaration is testable prose, not a list of three exceptions

- **WHEN** the declared admission rule is read
- **THEN** it states the return/acknowledgement criterion as the general test and names the three current collaborations only as worked examples of it

### Requirement: Event catalog v1 declares exactly five events sharing one envelope

`packages/contracts` SHALL declare exactly five domain event payload schemas in one catalog: `TaskAdmitted`, `SandboxProvisioned`, `TaskRunStarted`, `TaskSettled`, `TaskSuperseded`. Every event SHALL carry the envelope fields `eventId` (a UUID string, unique per publish), `occurredAt` (an ISO-8601 UTC timestamp), `type` (the event's literal discriminant), and `taskId` (the subject). The five type literals SHALL be declared once, in a single exported const, from which the discriminated union and the type-to-schema map derive; no second list of event names SHALL exist.

#### Scenario: The catalog holds exactly the five declared events

- **WHEN** the exported catalog's event type literals are enumerated
- **THEN** the result is exactly the five declared literals, with no sixth entry and no duplicate

#### Scenario: A payload missing an envelope field is rejected

- **WHEN** a payload lacking `eventId`, or lacking `occurredAt`, or lacking `taskId` is parsed against its schema
- **THEN** the parse fails

#### Scenario: Each publish produces a distinct event id

- **WHEN** the same publish point publishes twice for the same task
- **THEN** the two events carry different `eventId` values and both carry the same `type`

#### Scenario: Event names derive from one declaration

- **WHEN** the contracts package is searched for the five event type literals
- **THEN** each literal appears in exactly one declaring array, and the union type plus the type-to-schema map are derived from that array rather than restating it

### Requirement: Payload validation happens inside publish and cannot fail the publisher

The bus SHALL validate every published event against its catalog schema by calling that schema's `.parse()` (satisfying `contracts-executed-schema-check` by real execution rather than by an `INDIRECTION_POINTS` exemption; no `INDIRECTION_POINTS` entry SHALL be added by this change). Validation SHALL happen inside `publish`, before any subscriber is invoked. A payload that fails validation SHALL NOT be delivered to any subscriber, SHALL produce one structured log record naming the event type and the validation failure, and SHALL NOT throw to the publisher.

#### Scenario: An invalid payload is dropped, logged, and not thrown

- **WHEN** `publish` is called with a payload whose `taskId` is missing
- **THEN** zero subscribers are invoked, one structured log record naming the event type and the validation failure is emitted, and `publish` returns normally without throwing

#### Scenario: Validation precedes delivery

- **WHEN** a valid event is published to a registered subscriber
- **THEN** the schema's `.parse()` has executed before the subscriber is invoked

#### Scenario: No indirection exemption is claimed

- **WHEN** `scripts/contracts-executed-schema-check.mjs` and its `INDIRECTION_POINTS` list are diffed on this change
- **THEN** the list gains zero entries, and the check passes with the five event schemas counted as executed

### Requirement: Event payloads are fat, primitive-only, and derive shared vocabulary

Payloads SHALL be fat by design — carrying enough context that a subscriber never has to call back into the publisher to do its job, because breaking that call-back dependency is the purpose of the later migrations. Payloads SHALL carry only primitives, ID strings, and plain objects composed of those; they SHALL NOT carry entity instances, provider handles, connection objects, callbacks, or any live reference. Any provider-family field SHALL derive from `SANDBOX_PROVIDER_FAMILIES` in `packages/contracts/src/provider-family.ts`, never from a restated `z.enum`.

#### Scenario: Provider family derives from the single declaration

- **WHEN** a new member is appended to `SANDBOX_PROVIDER_FAMILIES`
- **THEN** the event schema accepts the new member with zero edits to the event schema file

#### Scenario: No provider family literals are restated

- **WHEN** the catalog's schema files are searched for the literals `aio`, `boxlite`, and `cloud-http`
- **THEN** zero matches are found

#### Scenario: A live reference is rejected by the schema

- **WHEN** a payload carries a function, a class instance, or a connection handle in place of a declared primitive field
- **THEN** the parse fails and the event is not delivered

#### Scenario: Provisioning payload carries a usable snapshot

- **WHEN** a `SandboxProvisioned` event is parsed
- **THEN** it carries the task id, the sandbox reference, the provider family, and an environment snapshot expressed as primitive fields — sufficient for a subscriber to record provisioning without calling back into guardrails

### Requirement: TaskSuperseded carries no superseder identity

Because no observation point in the codebase holds a handle to whichever actor superseded the task, the `TaskSuperseded` payload SHALL NOT contain any field naming, identifying, or implying the superseding task, lease, worker, or request. It SHALL carry only what the observer actually holds: the superseded task id, the fence token the loser held, the observation point, and the observed status when one is available.

#### Scenario: The schema has no superseder field

- **WHEN** the `TaskSuperseded` schema's field names are enumerated
- **THEN** none of them names a superseding actor (no `supersededBy`, `supersederTaskId`, `winnerToken`, or equivalent)

#### Scenario: The payload reports only what the observer holds

- **WHEN** a `TaskSuperseded` event is parsed
- **THEN** it carries the superseded task id, the fence token held by the losing observer, and an observation-point discriminant, and it parses successfully without any superseder information

### Requirement: The canonical fence token is the admission transition token

Both admission paths mint a per-transition token (`transitionToken = randomUUID()`), and that token — not the durable path's admission-work `leaseToken` — SHALL be the canonical `fenceToken` carried by admission-related events. The durable admission-work lease token SHALL NOT be substituted for it. Events that need to distinguish the two paths SHALL carry an explicit `admissionMode` discriminant (`durable` or `legacy`) rather than leaving the token's provenance implicit.

#### Scenario: Both paths publish the same kind of token

- **WHEN** the durable path and the legacy path each publish `TaskAdmitted` for their own task
- **THEN** both events' `fenceToken` is the transition token minted for that admission transition, and neither carries the admission-work lease token in that field

#### Scenario: The admission path is explicit in the payload

- **WHEN** a `TaskAdmitted` event is parsed
- **THEN** it carries an `admissionMode` value of exactly `durable` or `legacy`, so a subscriber never has to infer the path from the token's shape

### Requirement: Catalog v1 is in-process, additive-only, and declares its upgrade condition

The catalog SHALL declare in-band that these five events are **domain events (in-process, synchronous, not persisted)**, distinct from integration events, and SHALL declare the upgrade condition verbatim: the first cross-process consumer or the first subscriber that requires durable delivery converts the event into an integration event and requires a separate change introducing an outbox. That declaration SHALL explicitly distinguish "this change introduces no outbox" from the already-existing `TaskAdmissionWork` admission outbox, which it does not touch. Schema evolution SHALL be additive-only: unknown fields SHALL be tolerated by consumers, new fields SHALL be optional, and any breaking change SHALL be expressed as a new event type name rather than a mutation of an existing one.

#### Scenario: Unknown fields are tolerated

- **WHEN** a payload carrying an extra field not present in its schema is parsed
- **THEN** the parse succeeds (no schema uses `.strict()`), so a future producer can add fields without breaking today's consumers

#### Scenario: This change persists nothing

- **WHEN** the change's diff is inspected
- **THEN** it contains zero edits to `apps/api/prisma/schema.prisma`, zero new migration directories, and no code path that writes a published event to any table

#### Scenario: The existing admission outbox is untouched and distinguished

- **WHEN** the catalog's "no outbox" declaration is read and the diff is checked against `TaskAdmissionWork`
- **THEN** the declaration names `TaskAdmissionWork` as a pre-existing, unaffected durable admission outbox, and the diff makes no change to that model or its handling

#### Scenario: The upgrade condition is stated, not implied

- **WHEN** the catalog is read
- **THEN** it names the two triggers (a cross-process consumer; a subscriber requiring durable delivery) and states that either one requires a separate change introducing an outbox

### Requirement: The publish cutover toggle is snapshot-once, result-shaped, default-on, and attestation-free

Publishing SHALL sit behind an environment-driven cutover toggle that: reads its environment input exactly once at construction and never re-reads it afterwards; returns a full decision object (at minimum `enabled` plus a machine-readable reason/source) rather than a bare boolean; defaults to the new path (publishing ON) when the environment variable is unset or unrecognised; disables publishing when explicitly set to the escape-hatch value, restoring byte-identical pre-change behaviour; and consults no attestation, no build identity, and no signed artifact — a boolean is sufficient to open it.

#### Scenario: The decision is frozen at construction

- **WHEN** the environment variable is mutated after the toggle is constructed and the toggle is consulted again
- **THEN** the decision is unchanged from the value snapshotted at construction

#### Scenario: Unset environment means publishing is on

- **WHEN** the toggle is constructed with the environment variable unset
- **THEN** the decision object reports `enabled: true` with a reason identifying "default"

#### Scenario: The escape hatch restores the previous behaviour

- **WHEN** the toggle is constructed with the escape-hatch value set and a lifecycle transition that would otherwise publish is executed
- **THEN** zero `publish` calls are made, every existing synchronous collaborator call still runs, and the transition's observable outcome is identical to the pre-change behaviour

#### Scenario: A closed decision explains itself

- **WHEN** the toggle reports publishing disabled
- **THEN** the returned object carries the reason that closed it, so the caller can log why rather than only that

#### Scenario: No attestation is consulted

- **WHEN** the toggle's implementation is inspected
- **THEN** it references no build identity, no attestation artifact, and no signature check, and it cannot be left closed by an expired or missing attestation

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

### Requirement: The bus lands in a declared context with classified file names

Every new directory this change creates under `apps/api/src` SHALL be declared in `docs/refactor/contexts-manifest.json` in the same commit, and every new source file SHALL use one of the manifest's classified filename suffixes so that no `unclassified-file` finding — and therefore no new `scripts/ratchets/r7.json` key — is produced. Cross-context imports of the bus SHALL be legal only in their declared forms (port-suffixed target, or a DI composition file). The manifest's `crossContextRules.machineReadable` SHALL gain the domain-event-subscription encoding whose slot is reserved by the existing `$comment`.

#### Scenario: The layout gate passes on the change's tree

- **WHEN** `pnpm test:context-layout-v2` is run on the integrated tree
- **THEN** it exits 0 and reports zero unmapped directories

#### Scenario: The dependency ratchet does not rise

- **WHEN** the r7 comparator is run against `scripts/ratchets/r7.json` on the integrated tree
- **THEN** it reports no new key and no increased count, and any entry the change eliminates is deleted from the baseline file in the same commit

#### Scenario: The reserved manifest slot is filled

- **WHEN** `crossContextRules.machineReadable` is read after this change
- **THEN** it carries a machine-readable encoding for domain-event subscription, so a later subscriber's cross-context import can be scored by the gate instead of guessed at

#### Scenario: New tests are actually discovered

- **WHEN** the repository's test-discovery gate and `pnpm test:scripts` are run
- **THEN** every test file this change adds is reported as executed, and `api-module-layout-check` passes with `ALLOWED_CYCLES` still empty

### Requirement: The dependency budget ratchet is seeded with measured counts

The R11 dependency-budget ratchet records, per collaborator, the number of guardrails symbol references that the phase-4 migrations must burn down. Counts SHALL be measured live on the change's own tree rather than copied from documentation. The measured seed established when the baseline was created was: `this.audit` 9, `this.runnerMinutes` 6, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4, `this.transcripts` 2, metrics-projection 2. The ratchet SHALL be fail-closed in both directions: a count above baseline fails, and a stale entry whose real count is lower also fails until the baseline is reduced in the same commit.

A change that lowers a recorded count SHALL lower it only by deleting symbol references, and SHALL prove that in the same commit: the measured symbol string SHALL be unchanged (renaming the field is a forged burn-down, since the counter is a `\b`-anchored regex over that exact symbol), and the delta from the previous count SHALL equal the number of references that change removes, as named in that change's durable removal record (the adjudication table where the change produces one). An entry SHALL be reduced, never deleted, while its live count is above zero. The `samples` array is documentation and does not participate in comparison; a change that edits an entry SHALL refresh its stale sample lines in the same commit.

The reconciliation is stated **per collaborator and per change**, not against the original seed forever: each change reconciles only the entries it lowers, SHALL leave every entry it does not touch byte-identical, and its "no other collaborator moved" obligation is measured against the counts at the START of that change rather than against the seed. A later change lowering a different collaborator therefore does not retroactively falsify an earlier change's reconciliation.

#### Scenario: The baseline matches a live re-count

- **WHEN** the ratchet is run against the integrated tree
- **THEN** each recorded count equals the live count for that collaborator and the ratchet exits 0

#### Scenario: An added call site turns the ratchet red

- **WHEN** one extra call to a budgeted collaborator is injected into `guardrails.service.ts`
- **THEN** the ratchet fails and names the collaborator whose count rose

#### Scenario: A stale higher baseline also turns the ratchet red

- **WHEN** a call site is removed without lowering the recorded count in the same commit
- **THEN** the ratchet fails on the stale entry rather than passing because the tree is "better than baseline"

#### Scenario: The audit delta equals that change's adjudicated removals

- **WHEN** the recorded `this.audit` count on the audit-adjudication change's integrated tree is compared with that change's starting count of 9
- **THEN** the difference equals the number of adjudication rows marked REMOVED (0 if the provisioning-progress hint is retained, 1 if its coverage proof succeeded), and no other collaborator's count was changed **by that change**

#### Scenario: A change reconciles only the entries it lowers

- **WHEN** a change lowers exactly one collaborator's recorded count
- **THEN** its own entry carries the delta reconciliation, and the other five entries in `scripts/ratchets/r11.json` are byte-identical to their form at the start of that change

#### Scenario: A renamed field cannot be presented as a burn-down

- **WHEN** the measured symbol of the entry a change lowered is compared before and after that change
- **THEN** it is unchanged (`this.audit` for the audit adjudication, `this.runnerMinutes` for the runner-minutes ownership move), so the count reflects deleted references rather than a symbol the regex no longer matches

#### Scenario: A non-zero entry is reduced rather than deleted

- **WHEN** any entry whose live count is still above zero is inspected after the change that lowered it
- **THEN** it is still present with its remaining count and refreshed sample lines, because deletion is reserved for entries whose live count reaches zero

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

### Requirement: The runner-minutes budget entry falls from 6 to 5 as a measured first decrease, not a burn-down

The `guardrails-symbol-reference:this.runnerMinutes` entry SHALL be lowered from 6 to 5 in the
same commit that deletes the read reference, and SHALL NOT be deleted, because its live count
stays above zero. Reaching 0 is structurally unreachable while guardrails still writes to the
ledger — R11 counts symbol references and the five write references survive by design — so the
recorded outcome SHALL be stated as a FIRST DECREASE and SHALL NOT be described as a burn-down of
the runner collaborator.

The change SHALL additionally record, in a durable artifact, the ceiling that the event-subscriber
route could reach for this collaborator and why, so that a later change does not re-derive it from
scratch or assume 0 is available. That ceiling is **1, not 0**: three `recordStart` references are
covered by `TaskRunStarted` and the `fenceTerminal` `recordEnd` by `TaskSettled`, but the second
`recordEnd` — the `clearAdmissionRuntime` teardown of a superseded attempt whose task is still
alive — has no lawful covering event, because publishing `TaskSettled` there is forbidden by a
standing negative requirement written expressly so a later change cannot "fix" the 2-call-sites-to-1-event
asymmetry. The record SHALL also name the two costs that route carries beyond the spec conflict:
every reflective runner-minutes assertion in `guardrails.service.spec.ts` is a NEGATIVE assertion
(`intervals()` deep-equals `[]`, or no interval has a null `endedAt`), so a guardrails that stopped
recording would make all of them pass **vacuously** — zero-diff satisfied while the assertions stop
testing anything; and accounting driven by subscribers becomes fail-open under the publish
escape-hatch, which the retained-calls scenario keeps it immune to today. The entry's `change` field SHALL carry the anti-forgery reconciliation:
the delta of 1 equals exactly the one removed read reference, and the measured symbol string is
still `this.runnerMinutes`. The entry's `samples`, stale by one generation at lines
1566/2038/2623/2949/2971/3555 against the live 1824/2319/2917/3264/3286/3880, SHALL be refreshed
to the five surviving references at their live line numbers in the same commit.
`scripts/ratchets/r11-dependency-budget.test.mjs` hard-codes the expected mapping (`:73`) and
SHALL be updated in that same commit; it and the two shared writer source files
(`guardrails.service.ts`, `metrics.service.ts`) SHALL be integrated on a single serial track
rather than in parallel tracks.

Reaching 5 is a property of HOW the orchestrator obtains the collaborator, not only of the deletion:
the counter scans raw source text line by line and strips nothing, so a re-assignment of the
measured symbol, a type annotation naming it, or a comment quoting it each counts as one. A change
that deletes a reference and reintroduces the symbol elsewhere in the same file has moved the
reference, not removed it, and SHALL NOT record a decrease. The entry's recorded count SHALL
therefore be reconciled against the gate's own measurement of the post-change file rather than
against the count of deleted call sites.

#### Scenario: The entry reads 5 and the live count agrees

- **WHEN** `pnpm test:dependency-budget` is run on the integrated tree
- **THEN** it exits 0, the recorded `this.runnerMinutes` count is 5, and a live re-count of
  `this.runnerMinutes` in `guardrails.service.ts` is also 5

#### Scenario: The symbol is not reintroduced by the resolution plumbing or by a comment

- **WHEN** the gate's own `measureSource` is run over the post-change `guardrails.service.ts`, whose
  text includes every comment the change added
- **THEN** it returns 5, so no re-assignment, type annotation, or comment restored the reference the
  deletion removed — a design in which the orchestrator re-names the collaborator to obtain it
  would return 6 and is refused

#### Scenario: The delta is reconciled to exactly the removed read

- **WHEN** the entry's `change` field is read
- **THEN** it states that 6 − 5 = 1 equals the single removed reference
  (`return this.runnerMinutes.intervals();`) and that the measured symbol string is unchanged

#### Scenario: The entry is refreshed, not deleted

- **WHEN** `scripts/ratchets/r11.json` is read after the change
- **THEN** the `this.runnerMinutes` entry is still present with `count: 5`, its `symbol` is still
  `this.runnerMinutes`, and its `samples` list the five surviving call sites at their live line
  numbers with zero lines carried over from the stale generation

#### Scenario: No other collaborator entry moves

- **WHEN** the other five entries are compared with their form at the start of this change
- **THEN** `this.audit` 9, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4,
  `this.transcripts` 2, and metrics-projection 2 are unchanged in count and byte-identical in
  `symbol`

#### Scenario: The outcome is recorded as a first decrease

- **WHEN** the change's records describing the R11 result are read
- **THEN** they state 6 → 5 together with the reason 6 → 0 is unreachable while the five write
  references remain, and zero records claim the runner collaborator is burned down or that its
  entry may now be deleted

#### Scenario: The event-route ceiling is recorded as 1 with its blocking evidence

- **WHEN** the durable artifact's entry for the runner group is read
- **THEN** it states the ceiling as 1 rather than 0, cites the `clearAdmissionRuntime` `recordEnd`
  as the one reference no event may lawfully cover together with the standing requirement that
  forbids publishing `TaskSettled` at that seam, and names both further costs — that the reflective
  runner-minutes assertions would pass vacuously rather than fail, and that subscriber-driven
  accounting becomes fail-open under the publish escape-hatch

#### Scenario: The hard-coded ratchet test moves in the same commit

- **WHEN** the commit that edits `scripts/ratchets/r11.json` is inspected and
  `scripts/ratchets/r11-dependency-budget.test.mjs` is run on the integrated tree
- **THEN** both files appear in that same commit, and the test passes with its expected
  `this.runnerMinutes` mapping at 5

