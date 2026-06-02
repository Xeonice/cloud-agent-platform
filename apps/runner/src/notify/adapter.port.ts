import type { Decision, NotifyPayload, RequestDecisionPayload } from '@cap/contracts';

/**
 * Two-capability notification adapter port (agent-events-and-approvals spec,
 * "Two-capability notification adapter port").
 *
 * The port exposes two DISTINCT capabilities:
 *   - `notify`           — one-way push (e.g. ntfy / Bark), for signals like the
 *                          Stop "awaiting input" notification.
 *   - `requestDecision`  — round-trip approval (e.g. Telegram inline buttons via
 *                          a REST callback), the lock-independent approval path.
 *
 * An adapter MAY implement `notify` WITHOUT implementing `requestDecision`
 * (modelled by `requestDecision` being optional). Such a one-way-only adapter is
 * a valid adapter usable for push notifications; the system must never route a
 * round-trip approval request to it.
 */
export interface NotificationAdapter {
  /** Stable adapter name, for logging/selection. */
  readonly name: string;

  /**
   * One-way push. Every adapter implements this. Resolves once the notification
   * has been handed off (it does not wait for any human response).
   */
  notify(payload: NotifyPayload): Promise<void>;

  /**
   * Round-trip approval. OPTIONAL: adapters that cannot present an interactive
   * decision omit this. When present, it resolves with the operator's
   * `Decision`.
   */
  requestDecision?(payload: RequestDecisionPayload): Promise<Decision>;
}

/**
 * An adapter that additionally supports the round-trip capability. Narrowing to
 * this type guarantees `requestDecision` is callable.
 */
export interface DecisionCapableAdapter extends NotificationAdapter {
  requestDecision(payload: RequestDecisionPayload): Promise<Decision>;
}

/**
 * Type guard: does this adapter support the round-trip `request-decision`
 * capability? Used to route round-trip approvals only to capable adapters.
 */
export function supportsRequestDecision(
  adapter: NotificationAdapter,
): adapter is DecisionCapableAdapter {
  return typeof adapter.requestDecision === 'function';
}
