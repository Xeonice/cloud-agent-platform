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

#### Scenario: No runtime discovery mechanism is introduced

- **WHEN** the change's added files are searched for `DiscoveryService`, `MetadataScanner`, and `@nestjs/cqrs` / `@nestjs/event-emitter` imports
- **THEN** zero matches are found, and neither package appears in the root or `apps/api` `package.json`

#### Scenario: A subscriber absent from the array token is never invoked

- **WHEN** a handler exists in the codebase but is not present in the array bound to the subscriber token, and an event of its type is published
- **THEN** that handler is not invoked

#### Scenario: This change registers zero subscribers

- **WHEN** the array bound to the subscriber token is inspected on the change's tree
- **THEN** it is empty, so no published event produces any side effect in this change

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

The toggle SHALL be registered in the repository's deploy documentation with its environment variable name, its default, its owner, and the named condition under which it is removed. Registration SHALL NOT require a deploy runbook or `scripts/quick-deploy.sh` wiring — this change makes no behavioural change, so the lightweight documented-toggle form is the proportional one.

#### Scenario: The registry entry is complete

- **WHEN** the deploy documentation entry for this toggle is read
- **THEN** it states the variable name, the default (publishing on), the owner, and the retirement condition naming the change that removes it

#### Scenario: No heavyweight cutover wiring is added

- **WHEN** the change's diff is inspected
- **THEN** it adds no new deploy runbook file and makes no edit to `scripts/quick-deploy.sh` or the compose files for this toggle

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

This change SHALL create the R11 dependency-budget ratchet baseline recording, per collaborator, the number of guardrails call sites that the phase-4 migrations must burn down, seeded from counts measured on the change's own tree rather than copied from documentation. The seed SHALL be: `this.audit` 9, `this.runnerMinutes` 6, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4, `this.transcripts` 2, metrics-projection 2. The ratchet SHALL be fail-closed in both directions: a count above baseline fails, and a stale entry whose real count is lower also fails until the baseline is reduced in the same commit.

#### Scenario: The baseline matches a live re-count

- **WHEN** the ratchet is run against the integrated tree
- **THEN** each recorded count equals the live count for that collaborator and the ratchet exits 0

#### Scenario: An added call site turns the ratchet red

- **WHEN** one extra call to a budgeted collaborator is injected into `guardrails.service.ts`
- **THEN** the ratchet fails and names the collaborator whose count rose

#### Scenario: A stale higher baseline also turns the ratchet red

- **WHEN** a call site is removed without lowering the recorded count in the same commit
- **THEN** the ratchet fails on the stale entry rather than passing because the tree is "better than baseline"

