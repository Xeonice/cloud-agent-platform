import type { Decision, NotifyPayload, RequestDecisionPayload } from '@cap/contracts';
import {
  DecisionCapableAdapter,
  NotificationAdapter,
  supportsRequestDecision,
} from './adapter.port.js';

/**
 * Routes notifications across a set of two-capability adapters
 * (agent-events-and-approvals spec, "Two-capability notification adapter port").
 *
 * - `notify` fans out to EVERY registered adapter (all adapters implement the
 *   one-way capability).
 * - `requestDecision` is routed ONLY to adapters that support the round-trip
 *   `request-decision` capability; one-way-only adapters are never asked to make
 *   a decision.
 */
export class NotificationRouter {
  private readonly adapters: NotificationAdapter[];

  constructor(adapters: readonly NotificationAdapter[] = []) {
    this.adapters = [...adapters];
  }

  /** Register an adapter (one-way-only or decision-capable). */
  register(adapter: NotificationAdapter): void {
    this.adapters.push(adapter);
  }

  /** The subset of adapters that support the round-trip capability. */
  decisionCapableAdapters(): DecisionCapableAdapter[] {
    return this.adapters.filter(supportsRequestDecision);
  }

  /**
   * One-way push to every adapter. Failures in one adapter do not prevent the
   * others from being notified; the returned promise resolves once all have been
   * attempted.
   */
  async notify(payload: NotifyPayload): Promise<void> {
    await Promise.allSettled(this.adapters.map((adapter) => adapter.notify(payload)));
  }

  /**
   * Route a round-trip approval to the first decision-capable adapter and resolve
   * with its `Decision`. One-way-only adapters are skipped — a round-trip
   * approval is never routed to an adapter lacking `request-decision`.
   *
   * Returns `null` when no registered adapter supports the round-trip
   * capability, so the caller can fall back to another approval path rather than
   * misrouting the request.
   */
  async requestDecision(payload: RequestDecisionPayload): Promise<Decision | null> {
    const capable = this.decisionCapableAdapters();
    if (capable.length === 0) {
      return null;
    }
    return capable[0]!.requestDecision(payload);
  }
}
