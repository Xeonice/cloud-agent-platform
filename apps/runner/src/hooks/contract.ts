/**
 * Hook-layer contract shapes — single source of truth is `@cap/contracts`.
 *
 * All approval/event schemas are imported directly from the authoritative
 * contracts package and re-exported so the rest of the runner codebase has a
 * single import surface. Previously this module held local mirrors; those have
 * been removed (VR.6).
 */

import {
  DecisionSchema,
  DecisionBehaviorSchema,
  DecisionEnvelopeSchema,
  PermissionRequestFrameSchema,
  PostToolUseReportFrameSchema,
  FileEditSchema,
  FileEditSourceSchema,
} from '@cap/contracts';

export {
  DecisionBehaviorSchema,
  DecisionSchema,
  DecisionEnvelopeSchema,
  PermissionRequestFrameSchema,
  PostToolUseReportFrameSchema,
  FileEditSchema,
  FileEditSourceSchema,
};

export type {
  DecisionBehavior,
  Decision,
  DecisionEnvelope,
  PermissionRequestFrame,
  PostToolUseReportFrame,
  FileEdit,
  FileEditSource,
} from '@cap/contracts';

/**
 * Parse and validate a decision, rejecting any `behavior` outside `allow`/`deny`.
 * Returns the parsed decision, or `null` when the input is malformed so the
 * caller can refrain from emitting anything to Codex.
 */
export function parseDecision(input: unknown): import('@cap/contracts').Decision | null {
  const result = DecisionSchema.safeParse(input);
  return result.success ? result.data : null;
}
