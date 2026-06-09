import type { TaskStatus } from '@cap/contracts';

/**
 * Task lifecycle state machine.
 *
 * The set of states mirrors the contracts task-status enum. Transitions are
 * intentionally restrictive: only the edges declared in {@link ALLOWED_TRANSITIONS}
 * are permitted. Any other requested transition (for example `completed` back to
 * `pending`) is rejected, and callers MUST leave the persisted status unchanged.
 *
 * Terminal states (`completed`, `failed`, `cancelled`, `agent_failed_to_start`)
 * have no outgoing edges — once a task settles it cannot move again. `cancelled`
 * is the operator-initiated stop terminal, distinct from `completed` (clean agent
 * exit) and `failed` (crash / guardrail force-fail).
 */

/** States from which no further transition is allowed. */
export const TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'agent_failed_to_start',
] as const satisfies readonly TaskStatus[];

export type TerminalTaskStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * Adjacency map of permitted transitions: `from -> set of allowed `to` states.
 *
 * - `pending`        : initial state; may be admitted to `running`, held in
 *                      `queued` by the concurrency semaphore, or fail to start.
 * - `queued`         : admission-control holding state; may start running, be
 *                      stopped by the operator (`cancelled`), or, if the agent
 *                      never starts, surface `agent_failed_to_start`.
 * - `running`        : may pause for input, settle, be stopped (`cancelled`), or
 *                      surface a start failure observable once the process is up.
 * - `awaiting_input` : resumes to `running`, settles, or is stopped (`cancelled`).
 * - terminal states  : no outgoing transitions.
 *
 * An operator stop (`POST /tasks/:taskId/stop`) drives the `-> cancelled` edge
 * from any active state (`queued`/`running`/`awaiting_input`).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['queued', 'running', 'agent_failed_to_start', 'failed'],
  queued: ['running', 'agent_failed_to_start', 'failed', 'cancelled'],
  running: ['awaiting_input', 'completed', 'failed', 'agent_failed_to_start', 'cancelled'],
  awaiting_input: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  agent_failed_to_start: [],
};

/** Returns true when `status` is a terminal state with no outgoing transitions. */
export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

/**
 * Returns true iff moving from `from` to `to` is a permitted lifecycle edge.
 * A no-op transition (`from === to`) is treated as not permitted; callers that
 * want idempotent writes should short-circuit on equality before calling.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const targets = ALLOWED_TRANSITIONS[from];
  if (!targets) {
    return false;
  }
  return targets.includes(to);
}

/** Error raised when an illegal lifecycle transition is requested. */
export class IllegalTaskTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = 'IllegalTaskTransitionError';
  }
}

/**
 * Validates a transition and returns the target status when it is permitted.
 * Throws {@link IllegalTaskTransitionError} otherwise so the caller can avoid
 * persisting the change and surface the rejection.
 */
export function assertTransition(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransition(from, to)) {
    throw new IllegalTaskTransitionError(from, to);
  }
  return to;
}

/**
 * Convenience helper for the distinct failed-to-start transition. The agent
 * process exiting before it ever reaches a running state moves the task into
 * `agent_failed_to_start` — a state distinct from both `running` and the
 * generic `failed` — rather than leaving it stuck in `pending`/`queued`.
 */
export function toAgentFailedToStart(from: TaskStatus): TaskStatus {
  return assertTransition(from, 'agent_failed_to_start');
}
