import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DomainEventSchema, type DomainEvent } from '@cap-console/contracts';

import {
  DOMAIN_EVENT_BUS_LOGGER,
  DOMAIN_EVENT_SUBSCRIBERS,
  defineDomainEventSubscriber,
  type DomainEventBusLogger,
  type DomainEventBusPort,
  type DomainEventSubscriberRegistration,
  type DomainEventSubscription,
  type VoidOnlyDomainEventHandler,
} from './domain-event-bus.port';

/**
 * The in-process domain event bus (add-domain-event-bus, D1/D2/D7).
 *
 * ── Why this is hand-written and not an `EventEmitter` ────────────────────────
 *
 * Node's `EventEmitter` does not provide the guarantee this bus exists to give.
 * Measured on Node v22.22.0: when the second of three synchronous listeners
 * throws, the third is never invoked AND the exception propagates out of
 * `emit()` into the publisher. Wrapping `emit()` in one outer `try`/`catch`
 * cannot recover the isolation, because by the time the outer catch runs the
 * later listeners have already been skipped. The dispatch loop below therefore
 * owns one error boundary PER SUBSCRIBER, and this file imports no
 * `EventEmitter`.
 *
 * ── What `publish` guarantees ─────────────────────────────────────────────────
 *
 *  1. Validation happens first, inside `publish`, against the catalog.
 *  2. Every subscriber for the event's type runs, in registration order, on the
 *     publisher's own stack, before `publish` returns. Nothing is queued,
 *     deferred to a later tick, batched, awaited, or persisted.
 *  3. A subscriber that throws — anything, `Error` or not — is isolated: later
 *     subscribers still run and the publisher sees no exception.
 *  4. Every swallowed failure produces exactly one structured warn record.
 *     Silence is not an accepted outcome (D2): phase 4 moves billing-adjacent
 *     work onto subscribers, where a silent drop is a missing charge.
 *
 * A publisher consequently never needs a `try`/`catch` around a publish, and a
 * subscriber can never fail a lifecycle transition.
 */
@Injectable()
export class DomainEventBusService implements DomainEventBusPort {
  /**
   * Registration order IS dispatch order, so this stays an array. Subscribers
   * are not grouped by event type: the array is short by construction (it is
   * empty in this change and gains one entry per phase-4 migration), and one
   * ordered list is what makes "in registration order" observable rather than a
   * property of a map's iteration.
   */
  readonly #subscribers: DomainEventSubscriberRegistration[];

  readonly #logger: DomainEventBusLogger;

  constructor(
    @Optional()
    @Inject(DOMAIN_EVENT_SUBSCRIBERS)
    subscribers?: readonly DomainEventSubscriberRegistration[],
    @Optional()
    @Inject(DOMAIN_EVENT_BUS_LOGGER)
    logger?: DomainEventBusLogger,
  ) {
    this.#subscribers = (subscribers ?? []).map((registration, index) => {
      assertSubscriberName(registration.name, `registration #${index}`);
      return registration;
    });
    this.#logger = logger ?? new Logger(DomainEventBusService.name);
  }

  publish(event: DomainEvent): void {
    if (!this.#validate(event)) return;

    // Snapshot before dispatch: a subscriber that registers another subscriber
    // must not extend the loop it is running inside.
    const recipients = this.#subscribers.filter(
      (subscriber) => subscriber.eventType === event.type,
    );

    for (const subscriber of recipients) {
      try {
        subscriber.handle(event);
      } catch (thrown) {
        // The whole point of the per-subscriber boundary. Reporting is a plain
        // logger call — never a re-entrant `publish`, which would make one
        // subscriber's failure another subscriber's problem.
        this.#logger.warn({
          event: 'domain_event.subscriber_failed',
          eventType: event.type,
          subscriberName: subscriber.name,
          error: describeThrown(thrown),
          message: `domain event ${event.type}: subscriber ${subscriber.name} failed and was isolated — ${describeThrown(thrown)}`,
        });
      }
    }
  }

  subscribe<
    /* See {@link VoidOnlyDomainEventHandler}: `any` is what makes rejection possible. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends (event: DomainEvent) => any,
  >(
    handler: VoidOnlyDomainEventHandler<T>,
    subscription: DomainEventSubscription,
  ): void {
    assertSubscriberName(subscription.name, 'subscribe()');
    this.#subscribers.push(
      defineDomainEventSubscriber(subscription, handler),
    );
  }

  /**
   * Parse the event against the catalog BEFORE any subscriber is invoked.
   *
   * {@link DomainEventSchema} is the catalog's discriminated union on `type`, so
   * parsing through it IS parsing the published event's own schema — one real
   * `.parse()` call site rather than a hand-maintained switch, and rather than
   * an `INDIRECTION_POINTS` exemption in `contracts-executed-schema-check`
   * (this change adds zero such entries, D7).
   *
   * A failure is dropped, logged once, and NOT thrown: the same best-effort
   * discipline as a subscriber failure. A publisher must not lose a lifecycle
   * transition over a malformed payload.
   */
  #validate(event: DomainEvent): boolean {
    try {
      DomainEventSchema.parse(event);
      return true;
    } catch (thrown) {
      const eventType = readEventType(event);
      this.#logger.warn({
        event: 'domain_event.invalid_payload',
        eventType,
        error: describeThrown(thrown),
        message: `domain event ${eventType}: payload failed catalog validation and was dropped before dispatch — ${describeThrown(thrown)}`,
      });
      return false;
    }
  }
}

/**
 * A nameless subscriber can only ever produce an anonymous failure record, which
 * is barely better than the silence this bus refuses. Rejecting at registration
 * turns that into a boot-time error with a stack pointing at the wiring.
 */
function assertSubscriberName(name: unknown, where: string): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(
      `domain event subscriber ${where} has no name — every registration needs a stable name so a swallowed failure can be attributed`,
    );
  }
}

/** The published event's type, or `unknown` when the payload has no usable one. */
function readEventType(event: DomainEvent): string {
  const type: unknown = (event as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' && type !== '' ? type : 'unknown';
}

/**
 * A subscriber may throw a string, `undefined`, or an object with no prototype.
 * Isolation is worth nothing if describing the throw can itself throw.
 */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error && typeof thrown.message === 'string') {
    return thrown.message;
  }
  try {
    return String(thrown);
  } catch {
    return 'non-Error value that could not be stringified';
  }
}
