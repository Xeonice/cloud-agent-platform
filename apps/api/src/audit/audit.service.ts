import { Injectable, Logger } from '@nestjs/common';
import {
  AuditEventSchema,
  type AuditEvent,
  type AuditQuery,
  type TaskStatus,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  AUDIT_KIND_DESCRIPTORS,
  applyAuditQuery,
  assertResultCodeLevelConsistent,
  forceFailKind,
  kindForStatus,
  orderTaskSequence,
  type AuditEventKind,
  type ForceFailCause,
  type TaskStatusLookup,
} from './audit-mapping';

/**
 * Audit recorder + query service (be-audit-approvals 6.2 / 6.3 / 6.4).
 *
 * WRITE PATH (6.2): one immutable, append-only {@link AuditEvent} is recorded at
 * EACH lifecycle transition (and the force-fail causes). Recording is
 * BEST-EFFORT with respect to the controlled action: every public `record*`
 * method swallows persistence failures (logging them) and NEVER throws, so a
 * failed audit insert can never roll back or block the lifecycle transition that
 * triggered it. The guardrails/tasks services call these from inside their
 * transition paths.
 *
 * RESULT CODE (6.3): the (level, resultCode) pair for every event comes from the
 * pure {@link AUDIT_KIND_DESCRIPTORS} table and is re-validated with
 * {@link assertResultCodeLevelConsistent} before persistence, so a 2xx is never
 * stored against `error` and a 4xx/5xx never against `info`.
 *
 * READ PATH (6.4): the query/sequence reads compose the pure
 * {@link applyAuditQuery} / {@link orderTaskSequence} filters over a fetched
 * candidate window, mapping rows to the contracts wire shape (DB `userId` FK ->
 * contracts `githubId`).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /**
   * A generous candidate window the query path fetches before the pure filter
   * caps to the caller's limit. Bounded so a `status` filter (applied in-memory
   * over the window) cannot force an unbounded scan; the default caller limit is
   * far smaller. Most-recent-first, so the newest events are always considered.
   */
  private static readonly QUERY_FETCH_WINDOW = 1000;

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // 6.2 — best-effort write path (never throws / never blocks the transition)
  // -------------------------------------------------------------------------

  /**
   * Record the `task.created` event (6.2). The `githubId` of the operator that
   * created the task is attributed when known. Best-effort: a persistence failure
   * is logged and swallowed.
   */
  async recordTaskCreated(taskId: string, githubId?: number): Promise<void> {
    await this.record('task.created', taskId, { githubId });
  }

  /**
   * Record a lifecycle transition event for `status` (6.2): `task.queued`,
   * `task.running`, `task.awaiting_input`, `task.completed`, `task.failed`, or
   * `agent_failed_to_start`. A `pending` target has no distinct audit kind and is
   * a no-op. Best-effort.
   */
  async recordTransition(
    taskId: string,
    status: TaskStatus,
    githubId?: number,
  ): Promise<void> {
    const kind = kindForStatus(status);
    if (kind === null) return;
    await this.record(kind, taskId, { githubId });
  }

  /**
   * Record an explicit `task.cancelled` event (6.2) — the operator-driven
   * terminal that is distinct from a generic `failed`. Best-effort.
   */
  async recordCancelled(taskId: string, githubId?: number): Promise<void> {
    await this.record('task.cancelled', taskId, { githubId });
  }

  /**
   * Record a force-fail event naming its CAUSE (deadline / idle / circuit_breaker)
   * in the description (6.2). System-originated (no attributed user). Best-effort.
   */
  async recordForceFailed(taskId: string, cause: ForceFailCause): Promise<void> {
    await this.record(forceFailKind(cause), taskId, {
      description: `任务被守护栏强制失败，原因：${this.causeLabel(cause)}`,
    });
  }

  /**
   * The single best-effort persistence primitive. Resolves the descriptor for
   * the kind, validates the (level, resultCode) invariant (6.3), maps the
   * attributed `githubId` to the `users.id` FK, and inserts the row. ANY failure
   * (descriptor lookup, invariant, FK resolution, DB write) is caught, logged,
   * and swallowed — this method never throws, so the caller's transition path is
   * never affected by an audit failure (6.2).
   */
  private async record(
    kind: AuditEventKind,
    taskId: string,
    opts: { githubId?: number; description?: string } = {},
  ): Promise<void> {
    try {
      const descriptor = AUDIT_KIND_DESCRIPTORS[kind];
      // Re-validate the pair before persistence so a contradictory (level, code)
      // can never reach the row (6.3). Throws on mismatch — caught below.
      const { level, resultCode } = assertResultCodeLevelConsistent(
        descriptor.level,
        descriptor.resultCode,
      );

      const userId =
        opts.githubId !== undefined
          ? await this.resolveUserId(opts.githubId)
          : null;

      await this.prisma.auditEvent.create({
        data: {
          taskId,
          userId,
          type: kind,
          level,
          resultCode: resultCode ?? null,
          title: descriptor.title,
          description: opts.description ?? descriptor.title,
        },
      });
    } catch (err) {
      // BEST-EFFORT (6.2): never propagate — log and continue so the lifecycle
      // transition that triggered this is never rolled back or blocked.
      this.logger.warn(
        `audit record (${kind}) for task ${taskId} failed (swallowed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Map a contracts `githubId` (the immutable GitHub numeric account id) to the
   * `users.id` FK the `AuditEvent.userId` column references. Returns `null` when
   * no user record exists for the id (the event is then system-attributed rather
   * than failing the insert on a dangling FK).
   */
  private async resolveUserId(githubId: number): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { githubId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Human-readable label for a force-fail cause, used in the description. */
  private causeLabel(cause: ForceFailCause): string {
    switch (cause) {
      case 'deadline':
        return '超出墙钟时限';
      case 'idle':
        return '空闲超时';
      case 'circuit_breaker':
        return '熔断器触发';
      case 'provision_failed':
        return '沙箱置备失败';
    }
  }

  // -------------------------------------------------------------------------
  // 6.4 — session-gated query reads (compose the pure filters)
  // -------------------------------------------------------------------------

  /**
   * Recent events most-recent-first, filtered by level and/or task status and
   * capped at the caller's limit (default {@link AUDIT_QUERY_DEFAULT_LIMIT}) — the
   * 6.4 timeline read. Fetches a bounded most-recent candidate window from the DB,
   * then applies the PURE {@link applyAuditQuery} so the filter/order/cap rules
   * are the unit-testable ones.
   */
  async query(query: AuditQuery): Promise<AuditEvent[]> {
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: AuditService.QUERY_FETCH_WINDOW,
      include: { user: { select: { githubId: true } } },
    });
    const events = rows.map((row) => this.toEvent(row));

    // The `status` filter needs each event's owning-task status; build the
    // lookup from the tasks the candidate window references (incl. terminal).
    const statusByTaskId = await this.statusLookup(events.map((e) => e.taskId));

    return applyAuditQuery(events, query, statusByTaskId);
  }

  /**
   * A single task's FULL ordered event sequence (oldest -> newest), readable even
   * after the task has reached a terminal state — the 6.4 deep-link read. No
   * level/limit cap: a task's complete history is returned.
   */
  async queryTask(taskId: string): Promise<AuditEvent[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: { taskId },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      include: { user: { select: { githubId: true } } },
    });
    return orderTaskSequence(rows.map((row) => this.toEvent(row)));
  }

  // -------------------------------------------------------------------------
  // Row -> wire-shape mapping
  // -------------------------------------------------------------------------

  /**
   * Build the `taskId -> current status` lookup the pure `status` filter consumes.
   * Distinct task ids are queried once; a task missing from the result (e.g.
   * deleted) simply yields no entry, so its events drop out of a `status` filter.
   */
  private async statusLookup(taskIds: string[]): Promise<TaskStatusLookup> {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) return new Map();
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: unique } },
      select: { id: true, status: true },
    });
    const map = new Map<string, TaskStatus>();
    for (const task of tasks) {
      map.set(task.id, task.status as TaskStatus);
    }
    return map;
  }

  /**
   * Map a persisted `AuditEvent` row to the contracts wire shape, translating the
   * `users.id` FK back to the contracts `githubId` number. A row whose user was
   * deleted (or which had no attributed user) is surfaced as a system event with
   * a sentinel `userId` of `0` rather than dropped, since the contracts wire
   * field is a required `number`.
   *
   * The mapped object is validated against {@link AuditEventSchema} so a row that
   * somehow drifted from the contract (e.g. an out-of-vocabulary level) cannot be
   * served — `parse` throws, surfaced by the caller as a 500 rather than a
   * malformed body.
   */
  private toEvent(row: AuditEventRow): AuditEvent {
    return AuditEventSchema.parse({
      id: row.id,
      taskId: row.taskId,
      // Contracts `userId` is the GitHub numeric id; the row carries the user's
      // `githubId` via the relation include. `0` is the system/unattributed
      // sentinel for an event with no (or a since-deleted) user.
      userId: row.user?.githubId ?? 0,
      type: row.type,
      level: row.level,
      title: row.title,
      description: row.description,
      timestamp: row.timestamp,
      resultCode: row.resultCode ?? undefined,
      runId: row.runId ?? undefined,
    });
  }
}

/**
 * The shape `toEvent` consumes — a persisted `audit_events` row joined to its
 * (nullable) user so the `githubId` is available for the wire mapping. Declared
 * structurally to avoid coupling to a specific generated Prisma payload type.
 */
interface AuditEventRow {
  id: string;
  taskId: string;
  type: string;
  level: string;
  title: string;
  description: string;
  timestamp: Date;
  resultCode: number | null;
  runId: string | null;
  user?: { githubId: number } | null;
}
