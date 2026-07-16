import { Injectable } from '@nestjs/common';
import {
  TaskProvisioningStageSchema,
  TaskStatusSchema,
  type TaskProvisioningStage,
} from '@cap/contracts';
import {
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX,
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN,
  snapshotSandboxResources,
} from '@cap/sandbox';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ProvisioningTaskFailureCode } from '../tasks/task-failure';
import {
  TaskAdmissionStore,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionClaimSourceState,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
  type TaskAdmissionSettlement,
} from './task-admission.types';

const CLAIM_SOURCE_STATES = new Set<TaskAdmissionClaimSourceState>([
  'accepted',
  'queued',
  'retrying',
  'running',
]);

const SAFE_CAUSE_CODES = new Set<ProvisioningTaskFailureCode>([
  'provisioning_capacity_exhausted',
  'provisioning_workspace_timeout',
  'provisioning_forge_auth_failed',
  'provisioning_tls_network_failed',
  'provisioning_ref_not_found',
  'provisioning_unknown',
]);

const TASK_ADMISSION_STAGE_ORDER_SQL = Prisma.sql`ARRAY[
  'accepted',
  'sandbox_creation',
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_setup',
  'readiness',
  'agent_launch',
  'complete'
]::text[]`;

interface ClaimedRow {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
  readonly sourceState: string;
  readonly attempt: number;
  readonly stage: string;
  readonly causeCode: string | null;
  readonly resolvedBranch: string | null;
  readonly resourceSnapshot: unknown;
  readonly workspaceMaterializationDeadlineMs: number | null;
  readonly taskStatus: string;
  readonly taskLifecycleVersion: number;
}

interface AuthorizedRow {
  readonly authorized: boolean;
}

/**
 * One statement owns candidate selection and lease acquisition. Values are
 * always Prisma parameters; only the fixed schema/state vocabulary is literal.
 */
export function buildTaskAdmissionClaimQuery(
  request: TaskAdmissionClaimRequest,
): Prisma.Sql {
  return Prisma.sql`
    WITH candidate AS (
      SELECT
        w."task_id",
        w."state" AS "source_state",
        t."status"::text IN (
          'completed',
          'failed',
          'cancelled',
          'agent_failed_to_start'
        ) AS "task_terminal"
      FROM "task_admission_work" AS w
      INNER JOIN "tasks" AS t ON t."id" = w."task_id"
      WHERE
        (
          w."state" IN ('accepted', 'queued', 'retrying')
          AND w."available_at" <= clock_timestamp()
        )
        OR (
          w."state" = 'running'
          AND w."lease_until" <= clock_timestamp()
        )
      ORDER BY
        CASE
          WHEN w."state" = 'running' THEN w."lease_until"
          ELSE w."available_at"
        END ASC,
        w."created_at" ASC,
        w."task_id" ASC
      FOR UPDATE OF w SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE "task_admission_work" AS w
      SET
        "state" = 'running',
        "attempt" = CASE
          WHEN w."state" = 'queued' THEN w."attempt"
          -- Terminal recovery is completing the same provisioning attempt
          -- whose Task failure already committed. Advancing it here would
          -- make a repaired detail audit disagree with the persisted failure.
          WHEN w."state" = 'running' AND c."task_terminal"
            THEN GREATEST(w."attempt", 1)
          ELSE w."attempt" + 1
        END,
        "lease_owner" = ${request.leaseToken},
        "lease_until" = clock_timestamp()
          + (${request.leaseDurationMs}::bigint * interval '1 millisecond'),
        "updated_at" = clock_timestamp()
      FROM candidate AS c
      WHERE w."task_id" = c."task_id"
      RETURNING
        w."task_id",
        w."lease_owner",
        w."lease_until",
        c."source_state",
        w."attempt",
        w."stage",
        w."cause_code",
        w."resolved_branch",
        w."resource_snapshot",
        w."workspace_materialization_deadline_ms"
    )
    SELECT
      c."task_id" AS "taskId",
      c."lease_owner" AS "leaseToken",
      c."lease_until" AS "leaseUntil",
      c."source_state" AS "sourceState",
      c."attempt" AS "attempt",
      c."stage" AS "stage",
      c."cause_code" AS "causeCode",
      c."resolved_branch" AS "resolvedBranch",
      c."resource_snapshot" AS "resourceSnapshot",
      c."workspace_materialization_deadline_ms" AS "workspaceMaterializationDeadlineMs",
      t."status"::text AS "taskStatus",
      t."lifecycle_version" AS "taskLifecycleVersion"
    FROM claimed AS c
    INNER JOIN "tasks" AS t ON t."id" = c."task_id"
  `;
}

@Injectable()
export class PrismaTaskAdmissionStore extends TaskAdmissionStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async claim(
    request: TaskAdmissionClaimRequest,
  ): Promise<TaskAdmissionClaim | null> {
    assertLeaseToken(request.leaseToken);
    assertPositiveDuration(request.leaseDurationMs, 'leaseDurationMs');
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>(
      buildTaskAdmissionClaimQuery(request),
    );
    const row = rows[0];
    return row ? parseClaimedRow(row) : null;
  }

  async authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    assertLeaseToken(request.leaseToken);
    const taskFence = buildTaskFencePredicate(request.taskFences, 't');
    const rows = await this.prisma.$queryRaw<AuthorizedRow[]>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM "task_admission_work" AS w
        INNER JOIN "tasks" AS t ON t."id" = w."task_id"
        WHERE
          w."task_id" = ${request.taskId}
          AND w."state" = 'running'
          AND w."lease_owner" = ${request.leaseToken}
          AND w."lease_until" > clock_timestamp()
          AND ${taskFence}
      ) AS "authorized"
    `);
    return rows[0]?.authorized === true;
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    assertLeaseToken(request.leaseToken);
    assertPositiveDuration(request.leaseDurationMs, 'leaseDurationMs');
    const taskFence = buildTaskFenceExistsPredicate(request.taskFences, 'w');
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "task_admission_work" AS w
      SET
        "lease_until" = clock_timestamp()
          + (${request.leaseDurationMs}::bigint * interval '1 millisecond'),
        "updated_at" = clock_timestamp()
      WHERE
        w."task_id" = ${request.taskId}
        AND w."state" = 'running'
        AND w."lease_owner" = ${request.leaseToken}
        AND w."lease_until" > clock_timestamp()
        AND ${taskFence}
    `);
    return count === 1;
  }

  async checkpoint(
    request: TaskAdmissionCheckpointRequest,
  ): Promise<boolean> {
    assertLeaseToken(request.leaseToken);
    const stage = TaskProvisioningStageSchema.parse(request.stage);
    const taskFence = buildTaskFenceExistsPredicate(request.taskFences, 'w');
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "task_admission_work" AS w
      SET
        "stage" = ${stage},
        "updated_at" = clock_timestamp()
      WHERE
        "task_id" = ${request.taskId}
        AND "state" = 'running'
        AND "lease_owner" = ${request.leaseToken}
        AND "lease_until" > clock_timestamp()
        AND ${taskFence}
        -- The canonical sequence already places credential cleanup after all
        -- Git stages. Replays may repeat a stage but cannot regress durable
        -- progress to an earlier boundary.
        AND array_position(
          ${TASK_ADMISSION_STAGE_ORDER_SQL},
          "stage"
        ) <= array_position(
          ${TASK_ADMISSION_STAGE_ORDER_SQL},
          ${stage}
        )
    `);
    return count === 1;
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    assertLeaseToken(request.leaseToken);
    const settlement = normalizeSettlement(request.settlement);
    const taskFence = buildTaskFenceExistsPredicate(request.taskFences, 'w');
    const causeCode =
      settlement.state === 'failed' ? settlement.causeCode : null;
    const availableAfterMs =
      settlement.state === 'queued' || settlement.state === 'retrying'
        ? settlement.availableAfterMs
        : 0;
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "task_admission_work" AS w
      SET
        "state" = ${settlement.state},
        "stage" = CASE
          WHEN array_position(
            ${TASK_ADMISSION_STAGE_ORDER_SQL},
            w."stage"
          ) <= array_position(
            ${TASK_ADMISSION_STAGE_ORDER_SQL},
            ${settlement.stage}
          ) THEN ${settlement.stage}
          ELSE w."stage"
        END,
        "cause_code" = ${causeCode},
        "available_at" = clock_timestamp()
          + (${availableAfterMs}::bigint * interval '1 millisecond'),
        "lease_owner" = NULL,
        "lease_until" = NULL,
        "updated_at" = clock_timestamp()
      WHERE
        "task_id" = ${request.taskId}
        AND "state" = 'running'
        AND "lease_owner" = ${request.leaseToken}
        AND "lease_until" > clock_timestamp()
        AND ${taskFence}
    `);
    return count === 1;
  }
}

function buildTaskFenceExistsPredicate(
  fences: readonly import('./task-admission.types').TaskAdmissionTaskFence[],
  admissionAlias: 'w',
): Prisma.Sql {
  const predicate = buildTaskFencePredicate(fences, 't');
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "tasks" AS t
    WHERE t."id" = ${Prisma.raw(`${admissionAlias}."task_id"`)}
      AND ${predicate}
  )`;
}

function buildTaskFencePredicate(
  fences: readonly import('./task-admission.types').TaskAdmissionTaskFence[],
  taskAlias: 't',
): Prisma.Sql {
  if (fences.length === 0) {
    throw new Error('Task admission authority requires at least one task fence');
  }
  const normalized = fences.map((fence) => ({
    status: TaskStatusSchema.parse(fence.status),
    lifecycleVersion: assertLifecycleVersion(fence.lifecycleVersion),
  }));
  const clauses = normalized.map(
    (fence) => Prisma.sql`(
      ${Prisma.raw(`${taskAlias}."status"`)}::text = ${fence.status}
      AND ${Prisma.raw(`${taskAlias}."lifecycle_version"`)} = ${fence.lifecycleVersion}
    )`,
  );
  return Prisma.sql`(${Prisma.join(clauses, ' OR ')})`;
}

function assertLifecycleVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid task lifecycle fence version');
  }
  return value;
}

function parseClaimedRow(row: ClaimedRow): TaskAdmissionClaim {
  if (!CLAIM_SOURCE_STATES.has(row.sourceState as TaskAdmissionClaimSourceState)) {
    throw new Error('Task admission claim returned an invalid source state');
  }
  if (!Number.isSafeInteger(row.attempt) || row.attempt < 1) {
    throw new Error('Task admission claim returned an invalid attempt');
  }
  if (
    !Number.isSafeInteger(row.taskLifecycleVersion) ||
    row.taskLifecycleVersion < 0
  ) {
    throw new Error('Task admission claim returned an invalid lifecycle fence');
  }
  if (!(row.leaseUntil instanceof Date)) {
    throw new Error('Task admission claim returned an invalid lease expiry');
  }
  if (
    row.workspaceMaterializationDeadlineMs !== null &&
    (!Number.isSafeInteger(row.workspaceMaterializationDeadlineMs) ||
      row.workspaceMaterializationDeadlineMs <
        SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN ||
      row.workspaceMaterializationDeadlineMs >
        SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX)
  ) {
    throw new Error(
      'Task admission claim returned an invalid workspace materialization deadline',
    );
  }
  assertLeaseToken(row.leaseToken);
  const resources = snapshotSandboxResources(
    row.resourceSnapshot as { readonly diskSizeGb?: number } | null,
  );
  const causeCode =
    row.causeCode === null || row.causeCode === undefined
      ? null
      : SAFE_CAUSE_CODES.has(row.causeCode as ProvisioningTaskFailureCode)
        ? (row.causeCode as ProvisioningTaskFailureCode)
        : (() => {
            throw new Error('Task admission claim returned an unsafe cause code');
          })();
  return Object.freeze({
    taskId: row.taskId,
    leaseToken: row.leaseToken,
    leaseUntil: row.leaseUntil,
    sourceState: row.sourceState as TaskAdmissionClaimSourceState,
    attempt: row.attempt,
    stage: TaskProvisioningStageSchema.parse(row.stage),
    ...(causeCode === null ? {} : { causeCode }),
    resolvedBranch: row.resolvedBranch,
    resourceSnapshot: resources ?? Object.freeze({}),
    workspaceMaterializationDeadlineMs:
      row.workspaceMaterializationDeadlineMs,
    taskStatus: TaskStatusSchema.parse(row.taskStatus),
    taskLifecycleVersion: row.taskLifecycleVersion,
  });
}

function normalizeSettlement(
  settlement: TaskAdmissionSettlement,
): TaskAdmissionSettlement {
  const stage = TaskProvisioningStageSchema.parse(settlement.stage);
  if (settlement.state === 'succeeded') {
    if (stage !== 'complete') {
      throw new Error('Succeeded admission work must settle at complete');
    }
    return { state: 'succeeded', stage: 'complete' };
  }
  if (settlement.state === 'failed') {
    if (!SAFE_CAUSE_CODES.has(settlement.causeCode)) {
      throw new Error('Task admission settlement has an unsafe cause code');
    }
    return { ...settlement, stage };
  }
  if (settlement.state === 'queued' || settlement.state === 'retrying') {
    assertNonnegativeDuration(
      settlement.availableAfterMs,
      'availableAfterMs',
    );
    return { ...settlement, stage };
  }
  return { state: 'cancelled', stage };
}

function assertLeaseToken(value: string): void {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    containsControlCharacter(value)
  ) {
    throw new Error('Invalid task admission lease token');
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertNonnegativeDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}

export function isSafeTaskAdmissionCause(
  value: string,
): value is ProvisioningTaskFailureCode {
  return SAFE_CAUSE_CODES.has(value as ProvisioningTaskFailureCode);
}

export function parseTaskAdmissionStage(
  value: unknown,
): TaskProvisioningStage {
  return TaskProvisioningStageSchema.parse(value);
}
