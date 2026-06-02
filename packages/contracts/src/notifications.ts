import { z } from 'zod';

/**
 * Two-capability notification adapter port payloads
 * (agent-events-and-approvals spec).
 *
 * `notify` is one-way push (e.g. ntfy/Bark, used for Stop "awaiting input"
 * signals). `request-decision` is a round-trip approval (e.g. Telegram inline
 * buttons routed back through a REST callback). An adapter MAY implement
 * `notify` without `request-decision`; round-trip approvals are only routed to
 * adapters that support `request-decision`.
 */

/** Severity / category hint for one-way notifications. */
export const NotifyLevelSchema = z.enum(['info', 'awaiting_input', 'warning', 'error']);
export type NotifyLevel = z.infer<typeof NotifyLevelSchema>;

/**
 * Payload for the one-way `notify` capability.
 */
export const NotifyPayloadSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().min(1),
  body: z.string(),
  level: NotifyLevelSchema.default('info'),
});
export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;

/**
 * Payload for the round-trip `request-decision` capability. The adapter
 * presents the choices and routes the operator's pick back via the REST
 * callback keyed by `requestId`.
 */
export const RequestDecisionPayloadSchema = z.object({
  taskId: z.string().uuid(),
  /** Correlation id the REST callback echoes to resolve this request. */
  requestId: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  /** The selectable decision behaviors offered to the operator. */
  choices: z.array(z.enum(['allow', 'deny'])).nonempty(),
});
export type RequestDecisionPayload = z.infer<typeof RequestDecisionPayloadSchema>;

/** The two capabilities a notification adapter may advertise. */
export const NotificationCapabilitySchema = z.enum(['notify', 'request-decision']);
export type NotificationCapability = z.infer<typeof NotificationCapabilitySchema>;
