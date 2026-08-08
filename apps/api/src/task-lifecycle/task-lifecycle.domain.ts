import {
  TERMINAL_TASK_STATUSES,
  type TaskStatus,
  type TerminalTaskStatus,
} from '@cap-console/contracts';

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
 *
 * The terminal SET itself is not declared here. It is
 * {@link TERMINAL_TASK_STATUSES} in `@cap-console/contracts`, and this module
 * consumes it. A second declaration with the same members and a different name
 * lived here until this change; it had no consumers outside this file and its
 * only effect was to make the vocabulary answerable in two places. Nothing is
 * re-exported under the old name on purpose — an alias would put both names back
 * while looking like the fix.
 */

/**
 * Adjacency map of permitted transitions: `from -> set of allowed `to` states.
 *
 * - `pending`        : initial durable-acceptance state; may be admitted to
 *                      `running`, held in `queued`, stopped before admission,
 *                      or fail to start.
 * - `queued`         : admission-control holding state; may start running, be
 *                      stopped by the operator (`cancelled`), or, if the agent
 *                      never starts, surface `agent_failed_to_start`.
 * - `running`        : may pause for input, settle, be stopped (`cancelled`), or
 *                      surface a start failure observable once the process is up.
 * - `awaiting_input` : resumes to `running`, settles, or is stopped (`cancelled`).
 * - terminal states  : no outgoing transitions.
 *
 * An operator stop (`POST /tasks/:taskId/stop`) drives the `-> cancelled` edge
 * from any active state (`pending`/`queued`/`running`/`awaiting_input`).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['queued', 'running', 'agent_failed_to_start', 'failed', 'cancelled'],
  queued: ['running', 'agent_failed_to_start', 'failed', 'cancelled'],
  running: ['awaiting_input', 'completed', 'failed', 'agent_failed_to_start', 'cancelled'],
  awaiting_input: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  agent_failed_to_start: [],
};

/**
 * Returns true when `status` is a terminal state with no outgoing transitions.
 *
 * Declared as a type guard so callers that must NARROW to the terminal union get
 * it from here rather than keeping a second predicate of their own — which is
 * what the orchestrator did until this change, spelling out the four literals a
 * fifth time to do it.
 */
export function isTerminal(status: TaskStatus): status is TerminalTaskStatus {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status);
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

/**
 * The transitions admission owns, as one table: `pending -> queued`,
 * `pending -> running`, `queued -> running`.
 *
 * This rule used to exist three times in two forms that no tool related to each
 * other — a prose comment in the tasks service and two `Extract<TaskStatus, …>`
 * unions, one in that service and one in the task-operations port. A sentence
 * and a type expression cannot disagree loudly; they disagree silently. Every
 * position below is now a projection of this one table, so a change here reaches
 * all of them or fails to compile.
 *
 * A LATER lifecycle state than the one admission expected means another actor
 * superseded the attempt; the caller must treat that as supersession rather than
 * move the task backward or provision it again.
 */
export const ADMISSION_OWNED_TRANSITIONS = {
  queued: ['pending'],
  running: ['pending', 'queued'],
} as const satisfies Partial<Record<TaskStatus, readonly TaskStatus[]>>;

/** A state admission may move a task INTO. */
export type AdmissionTargetStatus = keyof typeof ADMISSION_OWNED_TRANSITIONS;

/** A state admission may move a task OUT OF. */
export type AdmissionSourceStatus =
  (typeof ADMISSION_OWNED_TRANSITIONS)[AdmissionTargetStatus][number];

/**
 * Either endpoint of an admission-owned transition.
 *
 * This is the domain of a durable capacity request's `expectedStatus`: the
 * compare-and-set may legitimately expect the state admission is moving out of
 * OR the one it already moved into, and those two sets together are exactly the
 * endpoints of the table above.
 */
export type AdmissionEndpointStatus =
  | AdmissionTargetStatus
  | AdmissionSourceStatus;

/** Returns true iff moving `from -> to` is a transition admission owns. */
export function isAdmissionOwnedTransition(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  const sources: readonly TaskStatus[] | undefined =
    ADMISSION_OWNED_TRANSITIONS[to as AdmissionTargetStatus];
  return sources !== undefined && sources.includes(from);
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
