import { Injectable, Logger } from '@nestjs/common';
import {
  AuditEventSchema,
  TaskProvisioningStageSchema,
  type AuditEvent,
  type AuditQuery,
  type TaskFailure,
  type TaskProvisioningStage,
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
  reasonForExit,
  type AuditEventKind,
  type ForceFailCause,
  type TaskStatusLookup,
} from './audit-mapping';
import {
  taskFailureMessage,
  taskFailureTitle,
} from '../tasks/task-failure';
import {
  taskCreatedAuditData,
  taskCreatedAuditDedupeKey,
} from './task-created-audit';
import type { ProvisioningAuditFailure } from './audit-recorder.port';

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
 * ATTRIBUTION (fix-local-account-task-attribution): the write path takes the
 * acting account's `users.id` PRIMARY KEY directly and stores it on
 * `AuditEvent.userId` — present for BOTH GitHub and LOCAL (password/OTP)
 * accounts, so a local account's `task.created` event is owner-attributed and the
 * owner-scoped Codex credential resolver finds it. (Previously the chain threaded
 * a numeric `githubId`, which a local account lacks → its task ran unattributed
 * and silently degraded to the env/official credential fallback.)
 *
 * READ PATH (6.4): the query/sequence reads compose the pure
 * {@link applyAuditQuery} / {@link orderTaskSequence} filters over a fetched
 * candidate window, mapping rows to the contracts wire shape (DB `userId` FK ->
 * contracts `githubId`, a local account's null githubId surfaced as the `0`
 * system sentinel — the wire field is intentionally unchanged).
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
   * Record the `task.created` event (6.2). The account `userId` (the `users.id`
   * primary key) of the operator that created the task is attributed when known —
   * present for BOTH GitHub and LOCAL accounts (fix-local-account-task-attribution),
   * so a local account's `task.created` event carries its owner FK and the codex
   * credential resolver can scope to it. Best-effort: a persistence failure is
   * logged and swallowed.
   */
  async recordTaskCreated(taskId: string, userId?: string): Promise<void> {
    try {
      const resolvedUserId =
        userId !== undefined ? await this.resolveUserId(userId) : null;
      await this.prisma.auditEvent.upsert({
        where: { dedupeKey: taskCreatedAuditDedupeKey(taskId) },
        update: {},
        create: taskCreatedAuditData(taskId, resolvedUserId),
      });
    } catch {
      this.logger.warn(
        `audit record (task.created) for task ${taskId} failed (swallowed)`,
      );
    }
  }

  async recordProvisioningProgress(
    taskId: string,
    stage: TaskProvisioningStage,
    attempt: number,
  ): Promise<void> {
    const parsedStage = TaskProvisioningStageSchema.safeParse(stage);
    if (!parsedStage.success || !isPositiveSafeInteger(attempt)) {
      this.logger.warn(
        `audit provisioning progress for task ${taskId} rejected invalid safe metadata`,
      );
      return;
    }
    const stageLabel = provisioningStageLabel(parsedStage.data);
    await this.recordIdempotent({
      dedupeKey: `task.provisioning:${taskId}:${attempt}:${parsedStage.data}`,
      taskId,
      type: `task.provisioning:${parsedStage.data}`,
      level: 'info',
      resultCode: 200,
      title: `任务环境准备：${stageLabel}`,
      description: `置备阶段：${stageLabel}；尝试次数：${attempt}`,
    });
  }

  async recordProvisioningFailure(
    taskId: string,
    stage: TaskProvisioningStage,
    attempt: number,
    failure: ProvisioningAuditFailure,
  ): Promise<boolean> {
    const parsedStage = TaskProvisioningStageSchema.safeParse(stage);
    if (
      !parsedStage.success ||
      !isPositiveSafeInteger(attempt) ||
      'runtime' in failure
    ) {
      this.logger.warn(
        `audit provisioning failure for task ${taskId} rejected invalid safe metadata`,
      );
      return false;
    }
    const title = taskFailureTitle(failure);
    const message = taskFailureMessage(failure);
    const stageLabel = provisioningStageLabel(parsedStage.data);
    // The central lifecycle event and its provisioning detail have independent
    // dedupe identities so either one can be repaired by recovery without
    // duplicating the other.
    const centralRecorded = await this.recordIdempotent({
      dedupeKey: `task.failed:provisioning:${taskId}`,
      taskId,
      type: 'task.failed',
      level: 'error',
      resultCode: 422,
      title,
      description: message,
    });
    const detailRecorded = await this.recordIdempotent({
      dedupeKey: `task.provisioning.failed:${taskId}`,
      taskId,
      type: `task.provisioning.failed:${failure.code}`,
      level: 'error',
      resultCode: 422,
      title: `任务环境准备失败：${title}`,
      description:
        `置备阶段：${stageLabel}；尝试次数：${attempt}；` +
        `安全原因：${message}`,
    });
    return centralRecorded && detailRecorded;
  }

  async recordTaskCancellation(
    taskId: string,
    userId?: string,
  ): Promise<boolean> {
    const kind = 'task.cancelled' as const;
    const dedupeKey = `task.cancelled:${taskId}`;
    try {
      const descriptor = AUDIT_KIND_DESCRIPTORS[kind];
      const { level, resultCode } = assertResultCodeLevelConsistent(
        descriptor.level,
        descriptor.resultCode,
      );
      const resolvedUserId =
        userId === undefined ? null : await this.resolveUserId(userId);
      await this.prisma.auditEvent.upsert({
        where: { dedupeKey },
        update: {},
        create: {
          taskId,
          userId: resolvedUserId,
          type: kind,
          level,
          resultCode: resultCode ?? null,
          title: descriptor.title,
          description: descriptor.title,
          dedupeKey,
        },
      });
      return true;
    } catch {
      // Recovery needs only a durability acknowledgement. Never interpolate a
      // rejected adapter value because it may carry provider/Git diagnostics.
      this.logger.warn(
        `audit idempotent cancellation record for task ${taskId} failed (swallowed)`,
      );
      return false;
    }
  }

  /**
   * Record a lifecycle transition event for `status` (6.2): `task.queued`,
   * `task.running`, `task.awaiting_input`, `task.completed`, `task.failed`,
   * `task.cancelled` (the operator-driven stop terminal), or
   * `agent_failed_to_start`. A `pending` target has no distinct audit kind and is
   * a no-op. Best-effort.
   */
  async recordTransition(
    taskId: string,
    status: TaskStatus,
    userId?: string,
    failure?: TaskFailure,
  ): Promise<void> {
    const kind = kindForStatus(status);
    if (kind === null) return;
    if (kind === 'task.cancelled') {
      await this.recordTaskCancellation(taskId, userId);
      return;
    }
    await this.record(kind, taskId, {
      userId,
      ...(failure
        ? {
            title: taskFailureTitle(failure),
            description: taskFailureMessage(failure),
          }
        : {}),
    });
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

  async recordChangeRequest(
    taskId: string,
    opts: { url: string; number: number; reused: boolean },
  ): Promise<void> {
    await this.record(
      opts.reused ? 'task.change_request_reused' : 'task.change_request_opened',
      taskId,
      {
        description:
          `${opts.reused ? '复用已有变更请求' : '已开启变更请求'} ` +
          `#${opts.number} · ${opts.url}`,
      },
    );
  }

  /**
   * Record a `task.exited` failure-detail event (record-task-failure-reason):
   * the resolved exit code + the mapped human reason + the sampled transcript
   * tail, so a failed task is diagnosable without the sandbox. A DETAIL event
   * alongside the central `task.failed` transition. System-originated. Best-effort.
   */
  async recordExited(
    taskId: string,
    code: number | null,
    abnormal: boolean,
    tail: string,
  ): Promise<void> {
    const codeLabel = code === null ? '未解析' : String(code);
    const reason = reasonForExit(code, abnormal);
    const trimmed = tail.trim();
    const description = trimmed
      ? `退出码 ${codeLabel} · ${reason}\n—— 输出末尾 ——\n${trimmed}`
      : `退出码 ${codeLabel} · ${reason}`;
    await this.record('task.exited', taskId, { description });
  }

  /**
   * The single best-effort persistence primitive. Resolves the descriptor for
   * the kind, validates the (level, resultCode) invariant (6.3), resolves the
   * attributed account `users.id` FK, and inserts the row. ANY failure (descriptor
   * lookup, invariant, FK resolution, DB write) is caught, logged, and swallowed —
   * this method never throws, so the caller's transition path is never affected by
   * an audit failure (6.2).
   */
  private async record(
    kind: AuditEventKind,
    taskId: string,
    opts: { userId?: string; title?: string; description?: string } = {},
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
        opts.userId !== undefined
          ? await this.resolveUserId(opts.userId)
          : null;

      await this.prisma.auditEvent.create({
        data: {
          taskId,
          userId,
          type: kind,
          level,
          resultCode: resultCode ?? null,
          title: opts.title ?? descriptor.title,
          description: opts.description ?? descriptor.title,
        },
      });
    } catch {
      // BEST-EFFORT (6.2): never propagate — log and continue so the lifecycle
      // transition that triggered this is never rolled back or blocked. The
      // rejected value is deliberately omitted because an adapter can include
      // provider or Git diagnostics in its error.
      this.logger.warn(
        `audit record (${kind}) for task ${taskId} failed (swallowed)`,
      );
    }
  }

  private async recordIdempotent(input: {
    readonly dedupeKey: string;
    readonly taskId: string;
    readonly type: string;
    readonly level: 'info' | 'error';
    readonly resultCode: 200 | 422;
    readonly title: string;
    readonly description: string;
  }): Promise<boolean> {
    try {
      const { level, resultCode } = assertResultCodeLevelConsistent(
        input.level,
        input.resultCode,
      );
      await this.prisma.auditEvent.upsert({
        where: { dedupeKey: input.dedupeKey },
        update: {},
        create: {
          taskId: input.taskId,
          userId: null,
          type: input.type,
          level,
          resultCode: resultCode ?? null,
          title: input.title,
          description: input.description,
          dedupeKey: input.dedupeKey,
        },
      });
      return true;
    } catch {
      this.logger.warn(
        `audit idempotent provisioning record for task ${input.taskId} failed (swallowed)`,
      );
      return false;
    }
  }

  /**
   * Resolve the attributed account `users.id` PRIMARY KEY for the
   * `AuditEvent.userId` FK (fix-local-account-task-attribution). The caller already
   * supplies the account id — present for BOTH GitHub and LOCAL accounts — so this
   * is a DIRECT existence check (no `githubId` reverse lookup), keeping the write
   * zero-migration (the column already references `users.id`). Returns `null` when
   * no user record exists for the id (the event is then system-attributed rather
   * than failing the insert on a dangling FK).
   */
  private async resolveUserId(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
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
      case 'abnormal_exit':
        return '会话异常退出';
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

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function provisioningStageLabel(stage: TaskProvisioningStage): string {
  switch (stage) {
    case 'accepted':
      return '已接受';
    case 'sandbox_creation':
      return '创建沙箱';
    case 'credential_setup':
      return '准备仓库凭据';
    case 'remote_ref_resolution':
      return '解析远端引用';
    case 'workspace_transfer':
      return '传输仓库工作区';
    case 'checkout':
      return '检出分支';
    case 'submodules':
      return '准备子模块';
    case 'credential_cleanup':
      return '清理临时凭据';
    case 'runtime_setup':
      return '准备运行时';
    case 'readiness':
      return '检查就绪状态';
    case 'agent_launch':
      return '启动智能体';
    case 'complete':
      return '准备完成';
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
  // `githubId` is nullable (add-private-account-identity): a local account has no
  // GitHub id, so `toEvent` maps an absent user OR a null githubId to the `0`
  // system/unattributed sentinel.
  user?: { githubId: number | null } | null;
}
