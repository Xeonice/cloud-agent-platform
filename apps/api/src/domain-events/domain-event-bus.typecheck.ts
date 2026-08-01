import type { DomainEvent } from '@cap-console/contracts';

import type { AuditRecorderPort } from '@/audit/audit-recorder.port';
import type { TaskAdmissionLeaseControls } from '@/admission-coordination/task-admission.types';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '@/task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import type {
  BrandedNonEventError,
  DomainEventBusPort,
  DomainEventSubscription,
  NonEventAdmissionRule,
} from './domain-event-bus.port';

/**
 * Compile-fail fixtures for the subscriber void guard (add-domain-event-bus, D4/D5).
 *
 * The runtime spec can prove what the bus does with the handlers it accepts.
 * Only the compiler can prove what it REFUSES to accept — and the refusal is the
 * mechanism that keeps the non-event admission rule from decaying into a comment:
 *
 *   A collaboration that requires an acknowledgement, that can be refused, or
 *   whose result the publisher depends on is a CALL, not an EVENT.
 *
 * Every negative below sits behind `@ts-expect-error`. If the guard is ever
 * weakened — most plausibly by "simplifying" the handler parameter to
 * `(event: DomainEvent) => void`, which tsc accepts value-returning and `async`
 * handlers against with ZERO errors — these directives become unused and the
 * ordinary `tsc --noEmit` fails with TS2578. The fixture cannot be defeated by
 * relaxing the thing it guards.
 *
 * The positives matter just as much: a guard that rejected legitimate handlers
 * would be removed by the first change it blocked, so the delegation, `.bind()`,
 * and fire-and-forget forms are pinned here as MUST-COMPILE.
 */

declare const bus: DomainEventBusPort;
declare const subscription: DomainEventSubscription;

/**
 * The guard writes its rejection type inline so tsc prints the explanation
 * instead of collapsing it to an alias name. This pins the documented name to
 * the very same type, so the two spellings cannot drift apart.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const brandedAliasIsTheGuardsRejectionType: MutuallyAssignable<
  BrandedNonEventError,
  { readonly [K in NonEventAdmissionRule]: never }
> = true;
void brandedAliasIsTheGuardsRejectionType;

// ── Negatives: handlers that return something ────────────────────────────────

// @ts-expect-error A subscriber that returns a value is a call in disguise.
bus.subscribe((event: DomainEvent) => ({ durable: event.type === 'task.admitted' }), subscription);

// @ts-expect-error `Promise<void>` does not extend `void`: async handlers are rejected.
bus.subscribe(async (event: DomainEvent) => { void event; }, subscription);

// @ts-expect-error A handler may not hand its promise back to the bus.
bus.subscribe((event: DomainEvent) => Promise.resolve(event.taskId), subscription);

// ── Negatives: today's three non-events, as worked examples of the rule ──────
//
// Each appears twice: once as the real method (which the bus cannot accept in
// any shape) and once wrapped so its PARAMETERS fit a subscriber and only its
// RETURN disqualifies it. The wrapped form is what proves the guard — not merely
// an arity mismatch — is what does the rejecting.

declare const audit: AuditRecorderPort;
declare const writeGate: TaskProvisioningDiagnosticsWriteGatePort;
declare const lease: TaskAdmissionLeaseControls;

/** The real method's own parameter types, so only its RETURN is under test. */
type ProvisioningFailureArgs = Parameters<
  AuditRecorderPort['recordProvisioningFailure']
>;
declare const stage: ProvisioningFailureArgs[1];
declare const attempt: ProvisioningFailureArgs[2];
declare const failure: ProvisioningFailureArgs[3];

// @ts-expect-error Terminal provisioning audit detail returns a durability ack.
bus.subscribe(audit.recordProvisioningFailure, subscription);

// @ts-expect-error ...and it is still a call when its parameters are adapted.
bus.subscribe((event: DomainEvent) => audit.recordProvisioningFailure(event.taskId, stage, attempt, failure), subscription);

// @ts-expect-error Operator-driven cancellation returns a durability ack too.
bus.subscribe((event: DomainEvent) => audit.recordTaskCancellation(event.taskId), subscription);

// @ts-expect-error The diagnostics write gate answers a question the caller branches on.
bus.subscribe(writeGate.isEnabled, subscription);

// @ts-expect-error ...adapting its parameters does not make a boolean answer an event.
bus.subscribe((event: DomainEvent) => { void event; return writeGate.isEnabled(); }, subscription);

// @ts-expect-error `lease.authorize()` is awaited for authority and can refuse.
bus.subscribe((event: DomainEvent) => { void event; return lease.authorize(); }, subscription);

// @ts-expect-error `lease.checkpoint(stage)` is the same collaboration, awaited.
bus.subscribe((event: DomainEvent) => { void event; return lease.checkpoint(stage); }, subscription);

// ── Positives: these MUST compile ───────────────────────────────────────────

declare function someVoidMethod(event: DomainEvent): void;
declare function archiveTranscript(event: DomainEvent): Promise<void>;
declare const subscriberInstance: { onSettled(event: DomainEvent): void };
declare function report(error: unknown): void;

/** The empty handler, with the event type supplied by inference. */
bus.subscribe((event) => {
  void event;
}, subscription);

/** Delegation to a void-returning collaborator. */
bus.subscribe((event: DomainEvent) => someVoidMethod(event), subscription);

/** A bound void method — how a class-shaped subscriber registers itself. */
bus.subscribe(subscriberInstance.onSettled.bind(subscriberInstance), subscription);

/**
 * THE DECLARED I/O ESCAPE HATCH: asynchronous work started inside a
 * `void`-returning handler that owns its own `.catch(...)` and never returns the
 * promise. `publish` does not await it, so a subscriber's I/O can neither hold a
 * lifecycle transition open nor escape as an `unhandledRejection`.
 */
bus.subscribe((event: DomainEvent) => {
  void archiveTranscript(event).catch((error: unknown) => report(error));
}, subscription);
