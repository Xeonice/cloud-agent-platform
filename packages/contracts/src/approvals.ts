import { z } from 'zod';
import { FRAME_CHANNEL } from './ws-frames.js';

/**
 * Approval contract (agent-events-and-approvals spec, D6).
 *
 * The blocking Codex `PermissionRequest`/`PreToolUse` hook forwards an event to
 * the orchestrator, blocks until the operator decides, and prints the resulting
 * `{decision}` JSON to stdout for Codex. `PostToolUse` is post-hoc file-edit
 * reporting only (never gating/undo), backed by a git-diff fallback.
 */

// ---------------------------------------------------------------------------
// Decision shape
// ---------------------------------------------------------------------------

/** The decision behavior is constrained to exactly `allow` or `deny`. */
export const DecisionBehaviorSchema = z.enum(['allow', 'deny']);
export type DecisionBehavior = z.infer<typeof DecisionBehaviorSchema>;

/**
 * An approval decision. `behavior` is the literal `allow`/`deny`; `message` is
 * an optional human-readable note (e.g. a reason for denial).
 */
export const DecisionSchema = z.object({
  behavior: DecisionBehaviorSchema,
  message: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * The JSON the runner hook prints to stdout for Codex to consume.
 */
export const DecisionEnvelopeSchema = z.object({
  decision: DecisionSchema,
});
export type DecisionEnvelope = z.infer<typeof DecisionEnvelopeSchema>;

// ---------------------------------------------------------------------------
// PermissionRequest / PreToolUse forward-event frame
// ---------------------------------------------------------------------------

/**
 * The forwarded `PermissionRequest`/`PreToolUse` event the runner hook sends to
 * the orchestrator. Carries enough identity for the orchestrator to route the
 * round-trip approval back to the exact blocked hook invocation.
 */
export const PermissionRequestFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('permission_request'),
  /** Correlation id matching the round-trip decision back to this request. */
  requestId: z.string().min(1),
  /** The task whose runner raised the request. */
  taskId: z.string().uuid(),
  /** The Codex tool name being gated (e.g. `shell`, `apply_patch`). */
  toolName: z.string().min(1),
  /** Raw, opaque tool-call input forwarded for operator review. */
  toolInput: z.unknown(),
});
export type PermissionRequestFrame = z.infer<typeof PermissionRequestFrameSchema>;

/**
 * Server -> runner: the resolved decision for a previously forwarded
 * `permission_request`, carrying the same `requestId` correlation.
 */
export const DecisionFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('decision'),
  /** Correlates to the originating {@link PermissionRequestFrameSchema}. */
  requestId: z.string().min(1),
  decision: DecisionSchema,
});
export type DecisionFrame = z.infer<typeof DecisionFrameSchema>;

// ---------------------------------------------------------------------------
// PostToolUse file-edit report
// ---------------------------------------------------------------------------

/** How a file edit was detected: a `PostToolUse` hook event or git-diff fallback. */
export const FileEditSourceSchema = z.enum(['post_tool_use', 'git_diff']);
export type FileEditSource = z.infer<typeof FileEditSourceSchema>;

/** A single reported file change. */
export const FileEditSchema = z.object({
  /** Workspace-relative path of the changed file. */
  path: z.string().min(1),
  /** Coarse change kind. */
  change: z.enum(['created', 'modified', 'deleted']),
  /** Unified diff text for the change, when available. */
  diff: z.string().optional(),
  /** Whether this edit was surfaced by a hook event or the git-diff fallback. */
  source: FileEditSourceSchema,
});
export type FileEdit = z.infer<typeof FileEditSchema>;

/**
 * The `PostToolUse` file-edit report (post-hoc only, never gating/undo). The
 * git-diff fallback merges in edits not surfaced by a `PostToolUse` event.
 */
export const PostToolUseReportFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('post_tool_use_report'),
  taskId: z.string().uuid(),
  edits: z.array(FileEditSchema),
});
export type PostToolUseReportFrame = z.infer<typeof PostToolUseReportFrameSchema>;

// ---------------------------------------------------------------------------
// Pending-approvals read surface (be-audit-approvals 6.5)
// ---------------------------------------------------------------------------

/**
 * A single pending `PermissionRequest` decision awaiting an operator, surfaced by
 * the session-gated pending-list read endpoint (be-audit-approvals 6.5). It is
 * the operator-facing PROJECTION of an in-flight {@link PermissionRequestFrame}
 * the orchestrator is still blocking on — the transport `channel` discriminant is
 * dropped (this is a REST read, not a WS frame), but the correlation/identity
 * fields the console needs to render and resolve the request are preserved
 * verbatim, so the read surface stays consistent with the WS approval round-trip.
 */
export const PendingApprovalSchema = z.object({
  /** Correlation id matching the round-trip decision back to this request. */
  requestId: z.string().min(1),
  /** The task whose runner raised the request (deep-links to `/tasks/$taskId`). */
  taskId: z.string().uuid(),
  /** The Codex tool name being gated (e.g. `shell`, `apply_patch`). */
  toolName: z.string().min(1),
  /** Raw, opaque tool-call input forwarded for operator review. */
  toolInput: z.unknown(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

/**
 * Response body for the pending-approvals read endpoint (6.5): the list of
 * pending `PermissionRequest` decisions currently awaiting an operator.
 */
export const ListPendingApprovalsResponseSchema = z.array(PendingApprovalSchema);
export type ListPendingApprovalsResponse = z.infer<
  typeof ListPendingApprovalsResponseSchema
>;
