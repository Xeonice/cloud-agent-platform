/**
 * @cap/contracts — read-only session-history replay model
 * (session-sandbox-retention).
 *
 * The shape returned by `GET /tasks/:id/session-history`: a structured,
 * already-parsed transcript of a FINISHED task's codex conversation, derived by
 * the api from the rollout JSONL kept inside the (stopped, retained) sandbox
 * container. The web NEVER sees raw rollout JSONL — the api parses it into this
 * typed read-model (design D3).
 *
 * The top-level response is a discriminated union on `status` so the session
 * page can render the transcript, an honest empty state, or an expired state
 * without re-deriving anything:
 *   - `available` — the transcript was read + parsed; render the conversation.
 *   - `empty`     — the task settled but produced no rollout (codex never ran:
 *                   provision_failed / agent_failed_to_start); render the honest
 *                   "no record" state with the reason.
 *   - `expired`   — the retained container was reclaimed past its retention
 *                   window, so the transcript is gone; render the expired state.
 *
 * A `SessionTurn` is itself a discriminated union on `kind` (user / assistant /
 * tool) so the renderer styles each event distinctly (matching the design
 * baseline: user bubble, assistant commentary vs final-answer, tool-call card).
 */
import { z } from "zod";

import { TERMINAL_TASK_STATUSES, type TaskStatus } from "./task.js";

/** A single user instruction turn. */
export const UserTurnSchema = z.object({
  kind: z.literal("user"),
  /** The operator's instruction text (developer/system wrapper stripped). */
  text: z.string(),
});

/**
 * An assistant turn. `isFinalAnswer` is set from codex's own final-answer marker
 * (the rollout `phase`/final field — design D3), NEVER inferred from ordering;
 * commentary (process narration) is `isFinalAnswer: false`.
 */
export const AssistantTurnSchema = z.object({
  kind: z.literal("assistant"),
  text: z.string(),
  isFinalAnswer: z.boolean(),
});

/**
 * A tool call + its output. `output` is nullable so an abnormal stop mid-tool
 * (a `function_call` with no matching `function_call_output`) still yields a
 * turn rather than being dropped. `tokenCount` is the inline usage when present.
 */
export const ToolTurnSchema = z.object({
  kind: z.literal("tool"),
  /** The tool/function name (e.g. `shell`) or a short command label. */
  name: z.string(),
  /** The raw arguments / command, rendered monospace. */
  args: z.string(),
  /** The tool output; `null` when the call was interrupted before output. */
  output: z.string().nullable(),
  /** Inline token usage attributed to the turn, when the rollout carried it. */
  tokenCount: z.number().int().nonnegative().optional(),
});

/** A single transcript event (discriminated on `kind`). */
export const SessionTurnSchema = z.discriminatedUnion("kind", [
  UserTurnSchema,
  AssistantTurnSchema,
  ToolTurnSchema,
]);

export type UserTurn = z.infer<typeof UserTurnSchema>;
export type AssistantTurn = z.infer<typeof AssistantTurnSchema>;
export type ToolTurn = z.infer<typeof ToolTurnSchema>;
export type SessionTurn = z.infer<typeof SessionTurnSchema>;

/** Session-level metadata surfaced in the replay header (all optional/honest). */
export const SessionHistoryMetaSchema = z.object({
  taskId: z.string(),
  /** Codex model label from `session_meta`, when present. */
  model: z.string().optional(),
  /** The sandbox working directory from `session_meta`, when present. */
  cwd: z.string().optional(),
  /** ISO timestamp of the first rollout line, when present. */
  startedAt: z.string().optional(),
});
export type SessionHistoryMeta = z.infer<typeof SessionHistoryMetaSchema>;

/** Why an `empty` history carries no transcript (codex never produced one). */
export const SessionHistoryEmptyReasonSchema = z.enum([
  "no-rollout",
  "agent-failed-to-start",
]);
export type SessionHistoryEmptyReason = z.infer<
  typeof SessionHistoryEmptyReasonSchema
>;

/** The discriminated read-model returned by `GET /tasks/:id/session-history`. */
export const SessionHistorySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    turns: z.array(SessionTurnSchema),
    meta: SessionHistoryMetaSchema,
    /**
     * Whether the session was INTERRUPTED mid-run (an operator `cancelled` stop,
     * vs a clean `completed`/`failed` end). Carried ON THE WIRE — not inferred
     * client-side from the task status — so the replay can show the
     * terminal-replay source as a mid-run interrupted frame (the `cancelled`
     * scenario). `false` for a clean completion or a natural failure.
     */
    isInterrupted: z.boolean(),
  }),
  z.object({
    status: z.literal("empty"),
    reason: SessionHistoryEmptyReasonSchema,
  }),
  z.object({
    status: z.literal("expired"),
  }),
]);
export type SessionHistory = z.infer<typeof SessionHistorySchema>;

/**
 * The replay PRESENTATION state the session page renders for a TERMINAL task —
 * the canonical mapping shared by web + api so neither re-derives it. `expired`
 * is NOT in this map: it is a runtime outcome (the retained container was
 * reaped) determined when the history is read, not a task status.
 *
 * - `completed`  → the clean transcript.
 * - `cancelled`  → transcript + the terminal's interrupted (half-painted) frame.
 * - `failed`     → transcript up to the failure.
 * - `no-start`   → no transcript (codex never started); honest empty state.
 */
export const REPLAY_PRESENTATION_STATES = [
  "completed",
  "cancelled",
  "failed",
  "no-start",
] as const;
export type ReplayPresentationState =
  (typeof REPLAY_PRESENTATION_STATES)[number];

/** Map a TERMINAL task status to its replay presentation state (total). */
export function replayPresentationState(
  status: TaskStatus,
): ReplayPresentationState {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "agent_failed_to_start":
      return "no-start";
    default:
      // Non-terminal statuses have no replay state; callers gate on
      // TERMINAL_TASK_STATUSES first. Default keeps the function total.
      return "completed";
  }
}

/** True when a status is terminal (has a replay presentation state at all). */
export function isReplayableStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}
