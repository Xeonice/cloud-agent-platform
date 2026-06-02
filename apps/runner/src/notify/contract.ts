/**
 * Notification adapter payload contracts — single source of truth is `@cap/contracts`.
 *
 * All notification payload schemas are imported directly from the authoritative
 * contracts package and re-exported. Previously this module held local mirrors;
 * those have been removed (VR.6).
 */

// The approval `Decision` shape re-exported so notify-layer consumers have a
// single import surface.
export { DecisionSchema } from '@cap/contracts';
export type { Decision } from '@cap/contracts';

export {
  NotifyPayloadSchema,
  NotifyLevelSchema,
  RequestDecisionPayloadSchema,
  NotificationCapabilitySchema,
} from '@cap/contracts';

export type {
  NotifyPayload,
  NotifyLevel,
  RequestDecisionPayload,
  NotificationCapability,
} from '@cap/contracts';
