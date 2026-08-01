import type { DomainEvent, DomainEventType } from '@cap-console/contracts';

/**
 * The in-process domain event bus PORT (add-domain-event-bus, D1/D3/D4).
 *
 * Shaped after `apps/api/src/audit/audit-recorder.port.ts`: a bare `interface`,
 * string DI tokens, and the best-effort contract stated in this JSDoc rather
 * than implied by the implementation. Publishers depend on THIS file only —
 * `domain-event-bus.service.ts` is bound to {@link DOMAIN_EVENT_BUS} in
 * `domain-events.module.ts`, so no publisher ever imports the implementation.
 *
 * The file's own imports are equally load-bearing: `.port.ts` classifies as the
 * `domain` layer, and `layers.allowedImports.domain === ['domain']` in
 * `docs/refactor/contexts-manifest.json`. It therefore imports the catalog types
 * from `@cap-console/contracts` (an ungoverned package edge) and NOTHING whose
 * name ends in `.service.ts`.
 *
 * CONTRACT (the guarantees `publish` owes its caller):
 *  - SYNCHRONOUS: every subscriber for the event's type has run, in registration
 *    order, before `publish` returns. No queue, no `setImmediate`, no batching,
 *    no persistence.
 *  - BEST-EFFORT PER SUBSCRIBER: each subscriber runs inside its own error
 *    boundary. A throwing subscriber neither stops the ones after it nor
 *    escapes to the publisher — `publish` returns normally either way.
 *  - NEVER SILENT: a swallowed subscriber failure produces exactly one
 *    structured warn record naming the event type, the subscriber, and the
 *    error message.
 *  - VALIDATED AT THE DOOR: the payload is parsed against the catalog before any
 *    subscriber is invoked; a payload that fails is dropped and logged, never
 *    thrown back at the publisher.
 */

/** DI token for the bus itself; publishers inject it with `@Optional()`. */
export const DOMAIN_EVENT_BUS = 'DOMAIN_EVENT_BUS';

/**
 * DI token for THE array of subscriber registrations.
 *
 * Registration is explicit and enumerable on purpose (D3): the bus does not
 * discover subscribers with `DiscoveryService`, a `MetadataScanner`, or a
 * handler decorator, because runtime discovery would move registration off a
 * typed call site and defeat the compile-time guard on {@link
 * DomainEventBusPort.subscribe}. This change binds an EMPTY array.
 */
export const DOMAIN_EVENT_SUBSCRIBERS = 'DOMAIN_EVENT_SUBSCRIBERS';

/**
 * DI token for the bus's log sink. Unbound in production — the bus falls back to
 * its own Nest `Logger` — and bound by focused tests that need to read the
 * records a swallowed failure produced.
 */
export const DOMAIN_EVENT_BUS_LOGGER = 'DOMAIN_EVENT_BUS_LOGGER';

/**
 * One structured record. The bus emits these instead of free-text lines so a
 * swallowed failure is queryable by `subscriberName` / `eventType` rather than
 * only greppable — the phase-4 subscribers include billing-adjacent work, where
 * a silent drop is a missing charge (D2).
 */
export interface DomainEventBusLogRecord {
  /** Machine-readable discriminant of what was swallowed. */
  readonly event:
    | 'domain_event.subscriber_failed'
    | 'domain_event.invalid_payload';
  /** The published event's type; `unknown` when the payload had no valid one. */
  readonly eventType: string;
  /** The failing subscriber's stable name; absent for a validation drop. */
  readonly subscriberName?: string;
  /** The thrown error's message, stringified for a non-`Error` throw. */
  readonly error: string;
  /** Human-readable one-liner carrying the same facts as the fields above. */
  readonly message: string;
}

/**
 * The narrow sink the bus reports through. `Logger` from `@nestjs/common`
 * satisfies it structurally, so the default production path needs no adapter.
 */
export interface DomainEventBusLogger {
  warn(record: DomainEventBusLogRecord): void;
}

/**
 * A handler as the bus stores it. Narrowing to a single event's payload is the
 * handler's own job through the `type` discriminant: the bus dispatches by
 * `eventType`, so a handler registered for `task.settled` is only ever called
 * with that event.
 */
export type DomainEventHandler = (event: DomainEvent) => void;

/**
 * What the bus needs to know about a subscriber besides its handler.
 *
 * The name is REQUIRED and must be non-empty: it is the only thing that makes a
 * swallowed failure attributable, and an anonymous record is barely better than
 * silence. The bus rejects a nameless registration when it is registered, not
 * when it later fails.
 */
export interface DomainEventSubscription {
  /** Stable, human-meaningful subscriber name (e.g. `metrics-projection`). */
  readonly name: string;
  /** The single event type this subscriber is registered for. */
  readonly eventType: DomainEventType;
}

/** A subscription plus the handler the bus will invoke for it. */
export interface DomainEventSubscriberRegistration extends DomainEventSubscription {
  readonly handle: DomainEventHandler;
}

/**
 * ── THE NON-EVENT ADMISSION RULE ──────────────────────────────────────────────
 *
 * **A collaboration that requires an acknowledgement, that can be refused, or
 * whose result the publisher depends on is a CALL, not an EVENT.**
 *
 * The rule is about return/acknowledgement semantics, not about which concern is
 * involved — see `README.md` in this directory for the full declaration and for
 * the three collaborations in this codebase that it currently classifies as
 * calls.
 *
 * THE SENTENCES BELOW ARE THE COMPILER ERROR. They are the only copy: the
 * rejection type is a mapped type over this union, so the compiler prints them
 * verbatim at the offending call site.
 */
export type NonEventAdmissionRule =
  | 'A domain event subscriber MUST return void'
  | 'A collaboration that returns an acknowledgement is a CALL, not an EVENT — call the collaborator directly, or start the work inside a void-returning method that owns its own .catch(...) and never hands the promise back to the bus';

/**
 * The rejection type: an object type no function can satisfy, whose keys ARE the
 * explanation.
 *
 * ⚠ The guard below deliberately writes this mapped type INLINE rather than
 * referring to this alias. Measured on tsc 5.9.3: when the rejection type has a
 * name, the diagnostic collapses to "…is not assignable to type
 * 'BrandedNonEventError'" and the explanation never reaches the developer;
 * written inline, the same diagnostic prints both sentences in full. The
 * sentences themselves are not duplicated — both spellings map over
 * {@link NonEventAdmissionRule}, so this alias and the guard are the same type
 * by construction.
 */
export type BrandedNonEventError = {
  readonly [K in NonEventAdmissionRule]: never;
};

/**
 * The compile-time guard, applied to a handler position.
 *
 * `ReturnType<T> extends void ? unknown : BrandedNonEventError` intersects
 * nothing onto a legitimate `void` handler and intersects an unsatisfiable
 * object type onto every other one — including `async` handlers, whose
 * `Promise<void>` does not extend `void`.
 *
 * ⚠ The obvious spelling — declaring the parameter `(event: DomainEvent) => void`
 * — is a FAKE guard: `void` in a return position means "the return value is
 * ignored", so tsc accepts a handler returning an object or a promise there with
 * zero errors. `domain-event-bus.typecheck.ts` pins this distinction with
 * `@ts-expect-error`, so weakening the guard turns that fixture red (TS2578)
 * instead of quietly widening what may be registered.
 */
export type VoidOnlyDomainEventHandler<
  /*
   * The `any` return is the guard's mechanism, not laziness: the constraint must
   * ADMIT every return type in order to inspect and reject the wrong ones.
   * `=> void` here is the fake guard described above, and `=> unknown` rejects
   * legitimate delegation such as `(e) => someVoidMethod(e)`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends (event: DomainEvent) => any,
> = T &
  (ReturnType<T> extends void
    ? unknown
    : { readonly [K in NonEventAdmissionRule]: never });

/**
 * Builds a registration for the {@link DOMAIN_EVENT_SUBSCRIBERS} array under the
 * same guard {@link DomainEventBusPort.subscribe} applies.
 *
 * A bare object literal would NOT be guarded — assigning `async (e) => {}` to a
 * `handle: (e: DomainEvent) => void` field is legal TypeScript — so array
 * registrations are built here rather than written inline.
 */
export function defineDomainEventSubscriber<
  /* See {@link VoidOnlyDomainEventHandler}: `any` is what makes rejection possible. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends (event: DomainEvent) => any,
>(
  subscription: DomainEventSubscription,
  handle: VoidOnlyDomainEventHandler<T>,
): DomainEventSubscriberRegistration {
  return {
    name: subscription.name,
    eventType: subscription.eventType,
    handle: handle as DomainEventHandler,
  };
}

/** The bus as its publishers see it. */
export interface DomainEventBusPort {
  /**
   * Deliver `event` to every subscriber registered for its type, synchronously
   * and in registration order, completing delivery before returning.
   *
   * Best-effort by contract: this method does not throw. A subscriber failure is
   * isolated and logged; an invalid payload is dropped and logged. A publisher
   * therefore never needs a `try`/`catch` around a publish, and a lifecycle
   * transition can never be failed by a subscriber.
   */
  publish(event: DomainEvent): void;

  /**
   * Register `handler` for `subscription.eventType` under `subscription.name`.
   *
   * The handler position carries the {@link VoidOnlyDomainEventHandler} guard,
   * whose shape is fixed by the capability spec and verified under tsc 5.9.3
   * strict:
   *
   * ```ts
   * subscribe<T extends (e: DomainEvent) => any>(
   *   handler: T & (ReturnType<T> extends void ? unknown : BrandedNonEventError),
   * ): void;
   * ```
   *
   * A subscriber that must perform I/O starts it inside a `void`-returning
   * method that owns its own `.catch(...)` and does NOT hand the promise back —
   * that is the declared escape hatch for the later transcript and diagnostics
   * subscribers, not a loophole to be closed.
   */
  subscribe<
    /* See {@link VoidOnlyDomainEventHandler}: `any` is what makes rejection possible. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends (event: DomainEvent) => any,
  >(
    handler: VoidOnlyDomainEventHandler<T>,
    subscription: DomainEventSubscription,
  ): void;
}
