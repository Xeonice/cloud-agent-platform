import type { AuditEvent, AuditLevel, AuditQuery, TaskStatus } from '@cap/contracts';

/**
 * Pure, side-effect-free audit mapping + query-filter logic (be-audit-approvals
 * 6.3 / 6.4).
 *
 * Everything in this file is a PURE FUNCTION of its inputs — it touches no
 * `process.env`, no clock, no DB, and no NestJS context — so the resultCode↔level
 * invariant (6.3) and the query-filter/ordering rules (6.4) are unit-testable in
 * isolation. The service layer composes these with persistence; the rules
 * themselves never drift between the write path (assigning a code) and the read
 * path (validating/filtering).
 */

// ---------------------------------------------------------------------------
// 6.2/6.3 — lifecycle event kinds and their HTTP-status-like result codes
// ---------------------------------------------------------------------------

/**
 * The audit event kinds the orchestrator emits, one at EACH lifecycle transition
 * plus the force-fail causes. Kept as string literals matching the contracts
 * `AuditEventSchema.type` examples (`task.created`, `task.running`, …).
 *
 * `force_failed:*` carries the force-fail CAUSE (deadline / idle / circuit_breaker)
 * so the timeline can show why a task was reclaimed without a separate column.
 */
export type AuditEventKind =
  | 'task.created'
  | 'task.queued'
  | 'task.running'
  | 'task.awaiting_input'
  | 'task.completed'
  | 'task.failed'
  | 'task.exited'
  | 'task.cancelled'
  | 'agent_failed_to_start'
  | 'force_failed:deadline'
  | 'force_failed:idle'
  | 'force_failed:circuit_breaker'
  | 'force_failed:provision_failed'
  | 'force_failed:abnormal_exit';

/** The force-fail causes the guardrails service reclaims a task under. */
export type ForceFailCause =
  | 'deadline'
  | 'idle'
  | 'circuit_breaker'
  | 'provision_failed'
  | 'abnormal_exit';

/**
 * An HTTP-status-like result code the console renders verbatim (6.3):
 *   - `201` creation (a new resource was persisted),
 *   - `200` a read or a transition that produced NO new resource,
 *   - `409` a conflict — a rejected concurrent op or an admission/slot conflict,
 *   - `422` a validation / precondition failure.
 *
 * The level a code pairs with is constrained so the colored audit-dot and the
 * status code on a row can never contradict (see {@link levelForResultCode}).
 */
export type ResultCode = 200 | 201 | 409 | 422;

// ---------------------------------------------------------------------------
// 6.3 — the pure resultCode <-> level mapping + invariant enforcement
// ---------------------------------------------------------------------------

/**
 * The canonical severity for a result code. This is the single source of truth
 * the invariant is enforced against:
 *   - any 2xx (`200`/`201`) is `info` — a 2xx is NEVER paired with `error`;
 *   - any 4xx/5xx (`409`/`422`) is `error` — a 4xx/5xx is NEVER paired with `info`.
 *
 * `warning` is intentionally NOT producible from a result code: it is reserved
 * for level-only events that carry no HTTP-status-like code (e.g. a transient
 * advisory). An event that has BOTH a code and a level must satisfy
 * {@link isResultCodeLevelConsistent}.
 */
export function levelForResultCode(code: ResultCode): AuditLevel {
  switch (code) {
    case 200:
    case 201:
      return 'info';
    case 409:
    case 422:
      return 'error';
  }
}

/** True when `code` is a success (2xx) code. */
export function isSuccessCode(code: number): boolean {
  return code >= 200 && code < 300;
}

/** True when `code` is a client/server error (4xx/5xx) code. */
export function isErrorCode(code: number): boolean {
  return code >= 400 && code < 600;
}

/**
 * The 6.3 invariant, as a pure predicate over a (level, code) pair:
 *   - a 2xx code is consistent ONLY with `info` (never `error`);
 *   - a 4xx/5xx code is consistent ONLY with `error` (never `info`);
 *   - `warning` is consistent with NEITHER a 2xx nor a 4xx/5xx code, so a
 *     warning-level event must carry no result code.
 *
 * A pair with no code (`code === undefined`) is always consistent — the level
 * stands alone.
 */
export function isResultCodeLevelConsistent(
  level: AuditLevel,
  code: number | undefined,
): boolean {
  if (code === undefined) return true;
  if (isSuccessCode(code)) return level === 'info';
  if (isErrorCode(code)) return level === 'error';
  // Any other (1xx/3xx) code is outside the assigned vocabulary; reject so a
  // mis-assigned code cannot slip through paired with any level.
  return false;
}

/** Error thrown when a (level, resultCode) pair violates the 6.3 invariant. */
export class ResultCodeLevelMismatchError extends Error {
  constructor(
    readonly level: AuditLevel,
    readonly code: number,
  ) {
    super(
      `Audit resultCode/level mismatch: code ${code} cannot pair with level "${level}"`,
    );
    this.name = 'ResultCodeLevelMismatchError';
  }
}

/**
 * Enforce the 6.3 invariant on the write path: throws
 * {@link ResultCodeLevelMismatchError} when a code is present and inconsistent
 * with the level, otherwise returns the (validated) pair unchanged. Callers use
 * this to guarantee a persisted event can never carry a contradictory pair.
 */
export function assertResultCodeLevelConsistent(
  level: AuditLevel,
  code: number | undefined,
): { level: AuditLevel; resultCode: number | undefined } {
  if (!isResultCodeLevelConsistent(level, code)) {
    throw new ResultCodeLevelMismatchError(level, code as number);
  }
  return { level, resultCode: code };
}

// ---------------------------------------------------------------------------
// 6.2/6.3 — per-kind level + resultCode assignment (pure)
// ---------------------------------------------------------------------------

/** The (level, resultCode, title) descriptor for an audit event kind. */
export interface AuditKindDescriptor {
  readonly level: AuditLevel;
  readonly resultCode: ResultCode;
  readonly title: string;
}

/**
 * The pure mapping from a lifecycle event kind to its severity + HTTP-status-like
 * result code + default title (6.2/6.3). Each descriptor is guaranteed
 * consistent by construction: a 2xx pairs with `info`, a 4xx pairs with `error`.
 *
 *   - `task.created`           -> 201 / info  (a new task resource was persisted)
 *   - `task.queued`            -> 409 / error (held: no admission slot free)
 *   - `task.running`           -> 200 / info  (transition, no new resource)
 *   - `task.awaiting_input`    -> 200 / info  (transition)
 *   - `task.completed`         -> 200 / info  (terminal, success)
 *   - `task.failed`            -> 422 / error (terminal, failure/precondition)
 *   - `task.cancelled`         -> 200 / info  (operator-driven terminal)
 *   - `agent_failed_to_start`  -> 422 / error (precondition: never reached running)
 *   - `force_failed:*`         -> 422 / error (precondition breach: deadline/idle/breaker)
 *
 * `task.queued` is assigned `409` (admission-slot conflict) per 6.3's
 * "conflict/admission-slot 409" rule: the task could not be admitted because no
 * concurrency slot was free, so it was held rather than run.
 */
export const AUDIT_KIND_DESCRIPTORS: Readonly<Record<AuditEventKind, AuditKindDescriptor>> = {
  'task.created': { level: 'info', resultCode: 201, title: '任务已创建' },
  'task.queued': { level: 'error', resultCode: 409, title: '任务排队中（无可用并发槽）' },
  'task.running': { level: 'info', resultCode: 200, title: '任务开始运行' },
  'task.awaiting_input': { level: 'info', resultCode: 200, title: '任务等待输入' },
  'task.completed': { level: 'info', resultCode: 200, title: '任务已完成' },
  'task.failed': { level: 'error', resultCode: 422, title: '任务失败' },
  'task.exited': { level: 'error', resultCode: 422, title: '进程退出码' },
  'task.cancelled': { level: 'info', resultCode: 200, title: '任务已取消' },
  'agent_failed_to_start': {
    level: 'error',
    resultCode: 422,
    title: '智能体启动失败',
  },
  'force_failed:deadline': {
    level: 'error',
    resultCode: 422,
    title: '任务被强制失败（超出墙钟时限）',
  },
  'force_failed:idle': {
    level: 'error',
    resultCode: 422,
    title: '任务被强制失败（空闲超时）',
  },
  'force_failed:circuit_breaker': {
    level: 'error',
    resultCode: 422,
    title: '任务被强制失败（熔断器触发）',
  },
  'force_failed:provision_failed': {
    level: 'error',
    resultCode: 422,
    title: '任务被强制失败（沙箱置备失败）',
  },
  'force_failed:abnormal_exit': {
    level: 'error',
    resultCode: 422,
    title: '任务被强制失败（会话异常退出）',
  },
};

/** The force-fail kind for a given cause (6.2 force-fail causes). */
export function forceFailKind(cause: ForceFailCause): AuditEventKind {
  return `force_failed:${cause}` as AuditEventKind;
}

/**
 * Human-readable reason for a process exit code, recorded on the `task.exited`
 * failure-detail event so an operator can diagnose WHY a task failed without the
 * sandbox (record-task-failure-reason). PURE — no I/O.
 *
 * `abnormal` (the sandbox died / the WS closed before the session was
 * established / the code could not be resolved) takes precedence: a `null` /
 * unresolved code is always reported as an abnormal disconnect. Numeric codes
 * follow the Unix `128 + signal` convention for the common signals; any other
 * non-zero code is codex's own non-zero exit, whose AUTHORITATIVE reason is the
 * transcript tail (codex suppresses sub-command stderr on non-zero — see
 * openai/codex#1367 — and can hang when out of credits — openai/codex#6512 — so
 * the code is a HINT, the tail is the answer).
 */
export function reasonForExit(code: number | null, abnormal: boolean): string {
  if (abnormal || code === null) {
    return '沙箱异常断开（会话建立前 WS 关闭 / 退出码未解析，疑似容器被杀或网络中断）';
  }
  switch (code) {
    case 124:
      return '超时（timeout 终止）';
    case 130:
      return 'SIGINT（中断 / Ctrl-C）';
    case 137:
      return 'SIGKILL（被强杀，疑似 OOM 或容器被杀）';
    case 143:
      return 'SIGTERM（被终止，常见于部署 / 重启）';
    default:
      return `codex 自身错误或任务提交失败（退出码 ${code}，见输出末尾）`;
  }
}

/**
 * The lifecycle event kind for a `TaskStatus` transition target, or `null` for a
 * status with no distinct audit kind. `failed` is the generic failure kind; the
 * force-fail CAUSES use {@link forceFailKind} instead so the cause is preserved.
 */
export function kindForStatus(status: TaskStatus): AuditEventKind | null {
  switch (status) {
    case 'queued':
      return 'task.queued';
    case 'running':
      return 'task.running';
    case 'awaiting_input':
      return 'task.awaiting_input';
    case 'completed':
      return 'task.completed';
    case 'failed':
      return 'task.failed';
    case 'cancelled':
      return 'task.cancelled';
    case 'agent_failed_to_start':
      return 'agent_failed_to_start';
    case 'pending':
      // `pending` is the creation default; the distinct `task.created` event is
      // emitted on create, not as a transition to `pending`.
      return null;
  }
}

// ---------------------------------------------------------------------------
// 6.4 — pure query-filter + ordering logic
// ---------------------------------------------------------------------------

/**
 * Default cap on returned events, re-exported from contracts so the pure filter
 * and the service share one constant.
 */
export { AUDIT_QUERY_DEFAULT_LIMIT } from '@cap/contracts';

/**
 * A status lookup for the events being filtered: maps a `taskId` to that task's
 * current lifecycle status, so the `status` filter (6.4) can be applied without
 * the pure function reaching into the DB. The service supplies this map.
 */
export type TaskStatusLookup = ReadonlyMap<string, TaskStatus>;

/**
 * The fully-pure query application (6.4): given a candidate set of events, apply
 * the level filter, the per-task status filter, order MOST-RECENT-FIRST, and cap
 * at the resolved limit.
 *
 *   - `level` omitted (the "全部"/all selection) returns every severity;
 *   - `status` omitted returns events for tasks in any lifecycle state; when set,
 *     only events whose owning task is currently in that status are returned
 *     (looked up via `statusByTaskId`);
 *   - ordering is by `timestamp` DESC, ties broken by `id` DESC for a stable,
 *     deterministic order (so two events at the same instant never reorder
 *     between reads);
 *   - the result is capped at `query.limit` (already defaulted by the contracts
 *     schema to {@link AUDIT_QUERY_DEFAULT_LIMIT}).
 *
 * This is a pure transform: it neither mutates `events` nor reads any ambient
 * state. The service is responsible for fetching a reasonable candidate window;
 * this function does the contract-defined filtering/ordering/capping on it.
 */
export function applyAuditQuery(
  events: readonly AuditEvent[],
  query: AuditQuery,
  statusByTaskId: TaskStatusLookup,
): AuditEvent[] {
  const filtered = events.filter((event) => {
    if (query.level !== undefined && event.level !== query.level) return false;
    if (query.status !== undefined) {
      const status = statusByTaskId.get(event.taskId);
      if (status !== query.status) return false;
    }
    return true;
  });

  const ordered = [...filtered].sort(compareMostRecentFirst);

  return ordered.slice(0, query.limit);
}

/**
 * Order two events most-recent-first: `timestamp` DESC, then `id` DESC as a
 * deterministic tiebreaker so equal-timestamp events keep a stable order across
 * reads. Pure and total.
 */
export function compareMostRecentFirst(a: AuditEvent, b: AuditEvent): number {
  const at = a.timestamp.getTime();
  const bt = b.timestamp.getTime();
  if (at !== bt) return bt - at;
  // Stable, deterministic tiebreak on the unique id (descending).
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/**
 * Order a SINGLE task's events for the full-ordered-sequence read (6.4): oldest
 * -> newest by `timestamp`, ties broken by `id` ASC. This is the natural reading
 * order for one task's timeline (incl. after it has reached a terminal state),
 * the mirror of {@link compareMostRecentFirst}. Pure; does not mutate the input.
 */
export function orderTaskSequence(events: readonly AuditEvent[]): AuditEvent[] {
  return [...events].sort((a, b) => {
    const at = a.timestamp.getTime();
    const bt = b.timestamp.getTime();
    if (at !== bt) return at - bt;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}
