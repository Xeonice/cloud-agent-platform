import { Global, Module, type ModuleMetadata, type Provider } from '@nestjs/common';

import {
  DOMAIN_EVENT_BUS,
  DOMAIN_EVENT_SUBSCRIBERS,
  type DomainEventSubscriberRegistration,
} from './domain-event-bus.port';
import { DomainEventBusService } from './domain-event-bus.service';
import {
  DOMAIN_EVENT_PUBLISHING_CUTOVER,
  EnvironmentDomainEventPublishingCutover,
  type DomainEventPublishingDecision,
} from './domain-event-publishing-cutover.port';

/**
 * Composition for the in-process domain event bus (add-domain-event-bus, D1/D14).
 *
 * `@Global()` + `useExisting`, exactly like `audit.module.ts`: the publishers
 * (`GuardrailsService`, `TasksService`, the inline admission pipeline) inject the
 * bus BY TOKEN with `@Optional()`, so they never import this module and no new
 * module cycle is created. This module imports nothing, so making it global adds
 * no edge to the import graph at all.
 */

/**
 * THE subscriber array — empty, and empty on purpose.
 *
 * This change builds the mechanism and migrates nothing onto it, so no published
 * event produces any side effect anywhere. Each phase-4 migration adds exactly
 * one entry here, built through `defineDomainEventSubscriber` so the
 * compile-time void guard applies to array registrations too.
 */
export const DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS: readonly DomainEventSubscriberRegistration[] =
  Object.freeze([]);

/**
 * The cutover decision, taken ONCE at the composition root.
 *
 * Module metadata is static, so this is read while this module is loaded —
 * before Nest instantiates anything — which is precisely the "evaluate once at
 * the composition root" the design asks for.
 */
export const DOMAIN_EVENT_PUBLISHING_DECISION: DomainEventPublishingDecision =
  new EnvironmentDomainEventPublishingCutover().evaluate();

/**
 * The bindings for a given cutover decision.
 *
 * When the decision is closed, the bus provider is simply ABSENT from the
 * providers array — not bound to a null object, not bound to a disabled
 * implementation. Every publisher's `this.bus?.publish(...)` then short-circuits
 * on an unresolved optional dependency, which is the same code path the nine
 * out-of-directory specs already exercise by constructing their service without
 * a bus. The escape hatch is therefore covered by the characterization baseline
 * instead of by a branch that only runs during a rollback.
 *
 * Exported as a pure function of the decision so both branches are testable
 * without mutating `process.env` and re-importing this module.
 */
export function domainEventBusBindings(
  decision: DomainEventPublishingDecision,
): {
  providers: Provider[];
  exports: NonNullable<ModuleMetadata['exports']>;
} {
  const providers: Provider[] = [
    {
      provide: DOMAIN_EVENT_SUBSCRIBERS,
      useValue: DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS,
    },
    EnvironmentDomainEventPublishingCutover,
    {
      provide: DOMAIN_EVENT_PUBLISHING_CUTOVER,
      useExisting: EnvironmentDomainEventPublishingCutover,
    },
  ];
  const moduleExports: NonNullable<ModuleMetadata['exports']> = [
    DOMAIN_EVENT_SUBSCRIBERS,
    DOMAIN_EVENT_PUBLISHING_CUTOVER,
  ];

  if (decision.enabled) {
    providers.push(DomainEventBusService, {
      provide: DOMAIN_EVENT_BUS,
      useExisting: DomainEventBusService,
    });
    moduleExports.push(DOMAIN_EVENT_BUS);
  }

  return { providers, exports: moduleExports };
}

const bindings = domainEventBusBindings(DOMAIN_EVENT_PUBLISHING_DECISION);

@Global()
@Module({
  providers: bindings.providers,
  exports: bindings.exports,
})
export class DomainEventsModule {}
