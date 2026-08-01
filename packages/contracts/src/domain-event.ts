import { z } from 'zod';

import { SANDBOX_PROVIDER_FAMILIES } from './provider-family.js';
import {
  ExecutionModeSchema,
  TaskStatusSchema,
  TERMINAL_TASK_STATUSES,
} from './task.js';
import { TaskProvisioningDiagnosticAdmissionModeSchema } from './task-provisioning-diagnostics.js';

/**
 * DOMAIN EVENT CATALOG v1 — the in-band declaration (add-domain-event-bus, D6/D8).
 *
 * ── What these are ────────────────────────────────────────────────────────────
 *
 * The five events below are **domain events: in-process, synchronous, and not
 * persisted.** They are published on the publisher's own call stack, delivered
 * to every registered subscriber before `publish` returns, and then forgotten.
 * They are NOT integration events: nothing outside this process may subscribe to
 * them, no delivery is retried, and no event outlives the process that raised
 * it. A subscriber that is down when an event is published simply does not see
 * that event — that is the contract, not a defect.
 *
 * ── The upgrade condition (verbatim) ──────────────────────────────────────────
 *
 * **The first cross-process consumer, or the first subscriber that requires
 * durable delivery, converts that event into an integration event and requires
 * a separate change introducing an outbox.** Neither trigger may be served by
 * bolting persistence onto this catalog: an integration event is a different
 * contract with a different lifetime, and it gets its own change, its own
 * outbox table, and its own compatibility rules.
 *
 * ── This change introduces NO outbox, and `TaskAdmissionWork` is not one of ────
 * ── these events ──────────────────────────────────────────────────────────────
 *
 * `TaskAdmissionWork` is a PRE-EXISTING durable admission outbox in
 * `apps/api/prisma/schema.prisma`. It is the admission worker's own work queue,
 * it predates this catalog, and this change does not touch it: no migration, no
 * schema edit, no code path that writes any event declared here into it or into
 * any other table. Reading "domain events, no outbox" as "the admission outbox
 * is going away" is exactly the misreading this paragraph exists to prevent —
 * the two are unrelated mechanisms that happen to sit near the same seams.
 *
 * ── Evolution: additive-only ──────────────────────────────────────────────────
 *
 * - New fields SHALL be optional. A required field added later invalidates
 *   payloads that today's publishers already produce.
 * - Unknown fields SHALL be tolerated: **no schema here uses `.strict()`**, so a
 *   producer running ahead of its consumers cannot break them.
 * - A breaking change SHALL be expressed as a NEW event type name added to
 *   {@link DOMAIN_EVENT_TYPES}, never as a mutation of an existing one.
 *
 * ── Payloads are fat by design ────────────────────────────────────────────────
 *
 * Each payload carries enough context for a subscriber to do its job WITHOUT
 * calling back into the publisher — severing that call-back dependency is the
 * entire point of the migrations these events exist for. The counterweight is
 * that payloads carry **only primitives, id strings, and plain objects composed
 * of those**: no entity instances, no provider handles, no connection objects,
 * no callbacks, no live references. Shared vocabulary (provider family, task
 * status, execution mode, admission mode) is DERIVED from its single
 * declaration elsewhere in this package, never restated here.
 *
 * ── Where validation happens ──────────────────────────────────────────────────
 *
 * The bus validates inside `publish`, before any subscriber runs, by calling
 * {@link DomainEventSchema}`.parse(event)`. Because that schema is a
 * discriminated union on `type`, parsing through it IS parsing the event's own
 * schema — one real `.parse()` call site, so `contracts-executed-schema-check`
 * is satisfied by execution rather than by an `INDIRECTION_POINTS` exemption
 * (this change adds zero such entries). A payload that fails validation is
 * dropped and logged; it is never thrown back at the publisher.
 */

/**
 * THE declaration of which domain events exist.
 *
 * Every other artefact in this file derives from this array: the type union,
 * the per-event discriminants, and the type→schema map. There is no second list
 * of event names anywhere in the repository — adding an event means adding one
 * literal here and one schema below, and the `satisfies` on
 * {@link DOMAIN_EVENT_SCHEMAS} makes forgetting the schema a compile error.
 *
 * Naming: `<subject>.<past-tense fact>`. A domain event names something that
 * ALREADY happened, so the vocabulary is deliberately past tense — a name in
 * the imperative would be a command wearing an event's clothes.
 *
 * `error` is not, and may not become, a member: the bus dispatches by event
 * type, and an `'error'` type is the one name that turns a swallowed subscriber
 * failure into a process-level throw on Node's `EventEmitter` semantics.
 */
export const DOMAIN_EVENT_TYPES = [
  'task.admitted',
  'sandbox.provisioned',
  'task.run_started',
  'task.settled',
  'task.superseded',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** The catalog as a value-level guard (used to reject unknown wire types). */
export const DomainEventTypeSchema = z.enum(DOMAIN_EVENT_TYPES);

// The per-event discriminants, read off THE declaration rather than retyped.
// Retyping them would put a second copy of every event name in this file, which
// is the exact drift the single-array rule exists to prevent.
const [
  TASK_ADMITTED,
  SANDBOX_PROVISIONED,
  TASK_RUN_STARTED,
  TASK_SETTLED,
  TASK_SUPERSEDED,
] = DOMAIN_EVENT_TYPES;

/**
 * The envelope every domain event carries.
 *
 * - `eventId` is minted per publish and is unique per publish — two publishes
 *   from the same seam for the same task carry different ids. Later changes run
 *   a window where a subscriber is already attached and the direct call it will
 *   replace has not been removed yet; a stable per-event id is what lets those
 *   changes de-duplicate instead of re-cutting this schema.
 * - `occurredAt` is ISO-8601 **UTC** (`z.string().datetime()` rejects offsets),
 *   so no consumer has to normalise a local time.
 * - `type` is the discriminant; each event narrows it to its own literal.
 * - `taskId` is the subject every event in v1 is about.
 */
export const DomainEventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  type: DomainEventTypeSchema,
  taskId: z.string().min(1),
});
export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelopeSchema>;

/**
 * The canonical fence token carried by admission-related events (D10).
 *
 * It is the **admission transition token minted for that transition**, on both
 * paths:
 * - durable: the `transitionToken` minted by the capacity reservation in
 *   `tasks.service.ts` — NOT `claim.leaseToken`. The lease token belongs to the
 *   admission-work lease's lifetime, not to this transition, and substituting
 *   it would make the two publishers disagree silently about what the field
 *   means.
 * - legacy: the token `guardrails.admit()` fenced that admission with.
 *
 * Which path produced it is stated explicitly by `admissionMode`, so no
 * subscriber ever has to infer provenance from a token's shape.
 */
const DomainEventFenceTokenSchema = z.string().min(1);

/**
 * `durable` | `legacy`, derived from the admission-mode vocabulary this package
 * already declares for provisioning diagnostics. Deriving keeps one list: an
 * admission path added there cannot leave this catalog behind.
 */
export const DomainEventAdmissionModeSchema = z.enum(
  TaskProvisioningDiagnosticAdmissionModeSchema.options,
);
export type DomainEventAdmissionMode = z.infer<
  typeof DomainEventAdmissionModeSchema
>;

/**
 * The provider families, plus `unknown` — the same explicit, visible widening
 * `TaskProvisioningDiagnosticProviderFamilySchema` makes, for the same reason.
 * A task admitted on a runtime-default model intent has NO pinned environment
 * (`TaskLaunchContext` carries `environment` only on the explicit branch), so
 * the provisioning seam genuinely has no family to report for it. Reporting
 * `unknown` there is honest; dropping the whole event over a field the seam
 * cannot know would not be.
 *
 * The KNOWN members derive from {@link SANDBOX_PROVIDER_FAMILIES}: appending a
 * family there is accepted here with zero edits to this file.
 */
export const DomainEventProviderFamilySchema = z.enum([
  ...SANDBOX_PROVIDER_FAMILIES,
  'unknown',
]);
export type DomainEventProviderFamily = z.infer<
  typeof DomainEventProviderFamilySchema
>;

/**
 * Which of the three run-start seams began this run. The publish site knows
 * this statically, and a subscriber that must tell a fresh start from a
 * post-restart readoption cannot recover it from anything else in the payload.
 */
export const DomainEventRunStartPointSchema = z.enum([
  'readoption',
  'legacy_capacity',
  'durable_arm',
]);
export type DomainEventRunStartPoint = z.infer<
  typeof DomainEventRunStartPointSchema
>;

/**
 * Where a supersession was OBSERVED. Supersession is only ever observed (a CAS
 * that returned no rows, or a later lifecycle state read at a boundary), so the
 * observation point is the most specific thing any observer holds about it.
 */
export const DomainEventSupersessionObservationPointSchema = z.enum([
  'durable_capacity_reservation',
  'durable_admission_transition',
  'inline_pipeline_run',
]);
export type DomainEventSupersessionObservationPoint = z.infer<
  typeof DomainEventSupersessionObservationPointSchema
>;

/** The sandbox a successful provision produced, as primitives only. */
export const DomainEventSandboxReferenceSchema = z.object({
  baseUrl: z.string().min(1),
  wsUrl: z.string().min(1),
  // Optional because the legacy seam reads them from a selected-run lookup that
  // is allowed to come back empty; the connection reference above always exists
  // at both publish points.
  providerId: z.string().min(1).optional(),
  providerSandboxId: z.string().min(1).optional(),
});
export type DomainEventSandboxReference = z.infer<
  typeof DomainEventSandboxReferenceSchema
>;

/**
 * The environment a sandbox was provisioned from, flattened to primitives.
 *
 * `runtimeId` and `executionMode` are required because both provisioning paths
 * hold them unconditionally (they are required fields of the provision
 * context). Everything else comes from the pinned environment snapshot, which
 * exists only for an explicit model intent — hence optional.
 */
export const DomainEventEnvironmentSnapshotSchema = z.object({
  runtimeId: z.string().min(1),
  executionMode: ExecutionModeSchema,
  environmentId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  sourceKind: z.string().min(1).optional(),
  sourceRef: z.string().min(1).optional(),
  digest: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
});
export type DomainEventEnvironmentSnapshot = z.infer<
  typeof DomainEventEnvironmentSnapshotSchema
>;

/**
 * A task was admitted — the admission decision is committed and fenced.
 *
 * `outcome` is narrowed FROM the task-status declaration rather than restated,
 * so a rename over there fails here instead of drifting. A refused or
 * superseded admission publishes nothing at all (there is no `outcome` value
 * for it): supersession is its own event.
 */
export const TaskAdmittedEventSchema = DomainEventEnvelopeSchema.extend({
  type: z.literal(TASK_ADMITTED),
  admissionMode: DomainEventAdmissionModeSchema,
  outcome: TaskStatusSchema.extract(['running', 'queued']),
  fenceToken: DomainEventFenceTokenSchema,
});
export type TaskAdmittedEvent = z.infer<typeof TaskAdmittedEventSchema>;

/**
 * A sandbox was provisioned and its connection registered.
 *
 * Fat on purpose: task id, sandbox reference, provider family and environment
 * snapshot together are enough for a subscriber to record the provisioning
 * without calling back into guardrails — which is the dependency the phase-4
 * migrations exist to cut.
 */
export const SandboxProvisionedEventSchema = DomainEventEnvelopeSchema.extend({
  type: z.literal(SANDBOX_PROVISIONED),
  admissionMode: DomainEventAdmissionModeSchema,
  providerFamily: DomainEventProviderFamilySchema,
  sandbox: DomainEventSandboxReferenceSchema,
  environment: DomainEventEnvironmentSnapshotSchema,
});
export type SandboxProvisionedEvent = z.infer<
  typeof SandboxProvisionedEventSchema
>;

/**
 * A run started — the moment a run's runner-minutes interval begins.
 *
 * `admissionMode` is OPTIONAL here and required on {@link TaskAdmittedEventSchema}
 * on purpose: the readoption recovery seam restores a run after a restart and
 * genuinely does not know which admission path originally admitted it. Reporting
 * a guess would be fabricated data; `startPoint` already tells a subscriber
 * which seam it came from.
 */
export const TaskRunStartedEventSchema = DomainEventEnvelopeSchema.extend({
  type: z.literal(TASK_RUN_STARTED),
  startPoint: DomainEventRunStartPointSchema,
  admissionMode: DomainEventAdmissionModeSchema.optional(),
});
export type TaskRunStartedEvent = z.infer<typeof TaskRunStartedEventSchema>;

/**
 * A task reached its own terminal status at the terminal fence.
 *
 * `status` is narrowed to the terminal statuses by derivation from
 * {@link TERMINAL_TASK_STATUSES}, which is what makes "an admission-runtime
 * teardown may not publish this event" checkable rather than aspirational: the
 * teardown seam has no terminal status to put here.
 */
export const TaskSettledEventSchema = DomainEventEnvelopeSchema.extend({
  type: z.literal(TASK_SETTLED),
  status: z.enum(TERMINAL_TASK_STATUSES),
});
export type TaskSettledEvent = z.infer<typeof TaskSettledEventSchema>;

/**
 * A task was observed to have been superseded.
 *
 * **There is deliberately no superseder identity field, and adding one would be
 * fabricating data** (D9): every observation point learns about supersession
 * from a CAS that affected no rows or from a later lifecycle state it read —
 * none of them holds a handle to whichever task, lease, worker or request won.
 * The payload therefore carries only what the loser actually has: its own task
 * id (envelope), the fence token it held, where it observed the loss, and the
 * status it saw when one was available.
 *
 * `fenceToken` is optional because not every observation boundary holds one;
 * `observedStatus` is optional for the same reason.
 */
export const TaskSupersededEventSchema = DomainEventEnvelopeSchema.extend({
  type: z.literal(TASK_SUPERSEDED),
  observationPoint: DomainEventSupersessionObservationPointSchema,
  fenceToken: DomainEventFenceTokenSchema.optional(),
  observedStatus: TaskStatusSchema.optional(),
});
export type TaskSupersededEvent = z.infer<typeof TaskSupersededEventSchema>;

/**
 * type → schema, total over {@link DOMAIN_EVENT_TYPES} by construction.
 *
 * The `satisfies` is the totality check: a new member of the declaration array
 * without a schema here is a compile error, and a key that is not a member is
 * likewise rejected. That is why this map — and not a hand-maintained switch at
 * each publish point — is what the bus dispatches validation through.
 */
export const DOMAIN_EVENT_SCHEMAS = {
  [TASK_ADMITTED]: TaskAdmittedEventSchema,
  [SANDBOX_PROVISIONED]: SandboxProvisionedEventSchema,
  [TASK_RUN_STARTED]: TaskRunStartedEventSchema,
  [TASK_SETTLED]: TaskSettledEventSchema,
  [TASK_SUPERSEDED]: TaskSupersededEventSchema,
} satisfies Record<DomainEventType, z.ZodTypeAny>;

/**
 * The whole catalog as one parser, with its members read out of
 * {@link DOMAIN_EVENT_SCHEMAS} so the union cannot list a different set than the
 * map does. This is the schema the bus calls `.parse()` on: the discriminated
 * union routes to the published event's own schema.
 */
export const DomainEventSchema = z.discriminatedUnion('type', [
  DOMAIN_EVENT_SCHEMAS[TASK_ADMITTED],
  DOMAIN_EVENT_SCHEMAS[SANDBOX_PROVISIONED],
  DOMAIN_EVENT_SCHEMAS[TASK_RUN_STARTED],
  DOMAIN_EVENT_SCHEMAS[TASK_SETTLED],
  DOMAIN_EVENT_SCHEMAS[TASK_SUPERSEDED],
]);

/** The event a given type resolves to — derived from the map, not restated. */
export type DomainEventOf<TType extends DomainEventType> = z.infer<
  (typeof DOMAIN_EVENT_SCHEMAS)[TType]
>;

/** The discriminated union of every catalogued event. */
export type DomainEvent = DomainEventOf<DomainEventType>;
