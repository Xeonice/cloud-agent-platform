/**
 * How the session page renders a task (headless-task-conversation-view). Pure so
 * it is unit-tested in vitest's node env (the repo convention — no React render):
 *   - finished-replay : a terminal task → read-only transcript replay
 *   - pre-running     : pending/queued → wait placeholder (no sandbox yet)
 *   - headless-live   : a RUNNING headless task → live POLLED conversation
 *                       (no WebSocket, no xterm — its output is structured events,
 *                       not a terminal stream)
 *   - live-terminal   : a RUNNING interactive task → live xterm terminal (unchanged)
 */
import type { TaskStatus, ExecutionMode } from "@cap/contracts";
import { isReplayableStatus } from "@cap/contracts";

/** Pre-running statuses: created but no provisioned sandbox/terminal yet. */
const PRE_RUNNING_STATUSES = new Set<TaskStatus>(["pending", "queued"]);

export type SessionViewMode =
  | "finished-replay"
  | "pre-running"
  | "headless-live"
  | "live-terminal";

export function sessionViewMode(
  status: TaskStatus,
  executionMode: ExecutionMode | null | undefined,
): SessionViewMode {
  // A settled task always replays, regardless of mode (a finished headless task
  // still shows its conversation — just not live).
  if (isReplayableStatus(status)) return "finished-replay";
  if (PRE_RUNNING_STATUSES.has(status)) return "pre-running";
  // Running: a headless task has no terminal — show the live polled conversation;
  // an interactive task keeps the live xterm.
  if (executionMode === "headless-exec") return "headless-live";
  return "live-terminal";
}
