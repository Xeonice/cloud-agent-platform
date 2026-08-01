import { Injectable } from '@nestjs/common';

/**
 * The publish cutover toggle for the domain event bus (add-domain-event-bus, D14).
 *
 * SHAPE — the light template (`task-provisioning-diagnostics-write-gate.port.ts`):
 * one environment read at construction, then pure evaluation. This change makes
 * no behavioural change, so a deploy runbook and `quick-deploy.sh` wiring would
 * be out of proportion; the toggle is registered in `deploy/DEPLOY.md` with its
 * owner and retirement condition instead.
 *
 * RESULT — the heavy template's return shape (`task-admission-gate.ts`): a full
 * decision object, never a bare boolean. That file's own comment is the
 * precedent: "A `isEnabled(): boolean` here destroyed the closed reason before
 * any call site could see it." A caller must be able to log WHY publishing is
 * off, not merely THAT it is.
 *
 * DEFAULT ON — unset or unrecognised means the new path. The counter-example is
 * task-model-selection: default-closed AND bound to a hand-made build-identity
 * attestation, which silently expired on every upgrade and took a dedicated
 * change to repair. Nothing here consults an attestation, a build identity, or a
 * signature; a boolean is sufficient to open it, and no expiry can leave it
 * closed.
 *
 * CLOSED MEANS UNBOUND — `domain-events.module.ts` evaluates this once at the
 * composition root and, when it reports disabled, simply does not put the bus
 * provider in the providers array. Every `this.bus?.publish(...)` then
 * short-circuits, so the escape hatch runs the SAME code path as the nine
 * out-of-directory specs that construct their service without a bus. There is no
 * separate "toggle off" branch that only executes during a rollback.
 */

/** DI token for the cutover toggle. */
export const DOMAIN_EVENT_PUBLISHING_CUTOVER = 'DOMAIN_EVENT_PUBLISHING_CUTOVER';

/** The one environment variable this toggle reads, exactly once. */
export const DOMAIN_EVENT_PUBLISHING_ENABLED_ENV =
  'CAP_DOMAIN_EVENT_PUBLISHING_ENABLED';

/**
 * The escape-hatch values, compared after trimming and lower-casing.
 *
 * Case-normalising is not laxity: this toggle defaults to ON, so its only job is
 * to be turned OFF during a rollback. `FALSE` silently meaning "on" would be a
 * toggle that ignores the operator at the exact moment they need it. Anything
 * outside this list still means ON, which is the declared default.
 */
export const DOMAIN_EVENT_PUBLISHING_ESCAPE_HATCH_VALUES = Object.freeze([
  '0',
  'false',
  'off',
] as const);

/** Values that ask for the default explicitly. Recorded, not required. */
export const DOMAIN_EVENT_PUBLISHING_EXPLICIT_ON_VALUES = Object.freeze([
  '1',
  'true',
  'on',
] as const);

/** Machine-readable reason a decision came out the way it did. */
export type DomainEventPublishingReason =
  /** Nothing asked for anything else, so the new path stands. */
  | 'default'
  /** The environment explicitly asked for publishing. */
  | 'explicitly-enabled'
  /** The environment set a recognised escape-hatch value. */
  | 'escape-hatch';

/** Machine-readable provenance of the reading the decision was made from. */
export type DomainEventPublishingSource =
  | 'unset'
  | 'unrecognised-value'
  | 'environment';

/**
 * The whole decision, travelling together. The reason must accompany the
 * reading it was made from — two reads of one mutable state can disagree.
 */
export interface DomainEventPublishingDecision {
  readonly enabled: boolean;
  readonly reason: DomainEventPublishingReason;
  readonly source: DomainEventPublishingSource;
}

/** Read once at construction; consulted freely thereafter. */
export interface DomainEventPublishingCutoverPort {
  evaluate(): DomainEventPublishingDecision;
}

/**
 * Pure evaluator, used by the composition root, by deployment checks, and by
 * focused tests that must not mutate `process.env`.
 */
export function evaluateDomainEventPublishing(
  env: NodeJS.ProcessEnv,
): DomainEventPublishingDecision {
  const raw = env[DOMAIN_EVENT_PUBLISHING_ENABLED_ENV];
  if (raw === undefined) {
    return { enabled: true, reason: 'default', source: 'unset' };
  }

  const value = raw.trim().toLowerCase();
  if (
    (DOMAIN_EVENT_PUBLISHING_ESCAPE_HATCH_VALUES as readonly string[]).includes(
      value,
    )
  ) {
    return { enabled: false, reason: 'escape-hatch', source: 'environment' };
  }
  if (
    (DOMAIN_EVENT_PUBLISHING_EXPLICIT_ON_VALUES as readonly string[]).includes(
      value,
    )
  ) {
    return {
      enabled: true,
      reason: 'explicitly-enabled',
      source: 'environment',
    };
  }
  // Unrecognised is NOT a reason to close a default-on toggle. It is recorded as
  // such so an operator who fat-fingered the value can see that publishing is on
  // by default rather than by their instruction.
  return { enabled: true, reason: 'default', source: 'unrecognised-value' };
}

/**
 * Process-local snapshot. Construction captures the decision, so a later
 * environment mutation cannot change what an already-composed application does —
 * and the raw configuration value is neither retained nor exposed.
 */
@Injectable()
export class EnvironmentDomainEventPublishingCutover
  implements DomainEventPublishingCutoverPort
{
  readonly #decision = evaluateDomainEventPublishing(process.env);

  evaluate(): DomainEventPublishingDecision {
    return this.#decision;
  }
}
