import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  TASK_PROVISIONING_DIAGNOSTIC_MAX_DETAILED_ATTEMPTS,
  TASK_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticAdmissionModeSchema,
  TaskProvisioningDiagnosticAttemptSchema,
  TaskProvisioningDiagnosticAttemptStateSchema,
  TaskProvisioningDiagnosticCleanupSummarySchema,
  TaskProvisioningDiagnosticCauseSchema,
  TaskProvisioningDiagnosticEventSchema,
  TaskProvisioningDiagnosticPrimarySummarySchema,
  TaskProvisioningDiagnosticProviderFamilySchema,
  TaskProvisioningDiagnosticStageSchema,
  TaskProvisioningDiagnosticsQuerySchema,
  TaskProvisioningDiagnosticsResponseSchema,
  type TaskProvisioningDiagnosticAttempt,
  type TaskProvisioningDiagnosticCleanupSummary,
  type TaskProvisioningDiagnosticCompactionSummary,
  type TaskProvisioningDiagnosticCause,
  type TaskProvisioningDiagnosticEvent,
  type TaskProvisioningDiagnosticProviderFamily,
  type TaskProvisioningDiagnosticStage,
  type TaskProvisioningDiagnosticsResponse,
} from '@cap/contracts';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import {
  admissionStateFromTask,
  attemptFromRecord,
  compactionFromRecord,
  decodeTaskProvisioningDiagnosticCursor,
  deriveTaskDiagnosticCoverage,
  encodeTaskProvisioningDiagnosticCursor,
  eventFromRecord,
  hasCompleteEventInvariants,
  type DiagnosticAttemptRecord,
} from './task-provisioning-diagnostics.projection';
import type {
  AppendedTaskProvisioningDiagnosticEvent,
  BeginTaskProvisioningDiagnosticAttempt,
  RecordTaskProvisioningDiagnosticPrimary,
  ResumedTaskProvisioningDiagnosticAttempt,
  ResumeTaskProvisioningDiagnosticAttempt,
  TaskProvisioningDiagnosticAttemptContext,
  TaskProvisioningDiagnosticRecorderFailureCode,
  TaskProvisioningDiagnosticRecorderPort,
  TaskProvisioningDiagnosticRecorderResult,
} from './task-provisioning-diagnostic-recorder.port';
import { toTaskProvisioningDiagnosticLogRecord } from './task-provisioning-diagnostic-log';
import { TaskProvisioningDiagnosticsMetricsService } from './task-provisioning-diagnostics-metrics.service';

const UUIDSchema = z.string().uuid();
const AttemptContextSchema = z
  .object({
    taskId: UUIDSchema,
    attemptId: UUIDSchema,
    attempt: z.number().int().positive(),
    admissionMode: TaskProvisioningDiagnosticAdmissionModeSchema,
  })
  .strict();

const BeginAttemptSchema = z
  .object({
    taskId: UUIDSchema,
    admissionMode: TaskProvisioningDiagnosticAdmissionModeSchema,
    expectedAttempt: z.number().int().positive().optional(),
    providerFamily:
      TaskProvisioningDiagnosticProviderFamilySchema.nullable().optional(),
    stage: TaskProvisioningDiagnosticStageSchema.optional(),
    replayAttemptId: UUIDSchema.optional(),
    activeDisposition: z.enum(['reject', 'interrupt']).optional(),
    retry: z
      .object({
        stage: TaskProvisioningDiagnosticStageSchema,
        cause: TaskProvisioningDiagnosticCauseSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.admissionMode === 'legacy' &&
      value.expectedAttempt !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedAttempt'],
        message: 'legacy attempts are recorder allocated',
      });
    }
    if (
      value.retry !== undefined &&
      (value.admissionMode !== 'durable' ||
        value.expectedAttempt === undefined ||
        value.activeDisposition !== 'interrupt' ||
        value.replayAttemptId !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retry'],
        message:
          'retry evidence requires a new fenced durable interrupt attempt',
      });
    }
  });

const ResumeAttemptSchema = z
  .object({
    taskId: UUIDSchema,
    admissionMode: TaskProvisioningDiagnosticAdmissionModeSchema,
    attempt: z.number().int().positive(),
  })
  .strict();

const RecordPrimarySchema = z
  .object({
    state: TaskProvisioningDiagnosticAttemptStateSchema.exclude(['active']),
    stage: TaskProvisioningDiagnosticStageSchema,
    primary: TaskProvisioningDiagnosticPrimarySummarySchema,
  })
  .strict();

const PartialAttemptInputSchema = z
  .object({
    providerFamily:
      TaskProvisioningDiagnosticProviderFamilySchema.nullable().optional(),
    stage: TaskProvisioningDiagnosticStageSchema.optional(),
    startedAt: z.coerce.date().optional(),
  })
  .strict();

type DiagnosticResult<T> = TaskProvisioningDiagnosticRecorderResult<T>;

interface CommittedRetryMetricObservation {
  readonly kind: 'retry';
  readonly providerFamily: TaskProvisioningDiagnosticProviderFamily;
  readonly stage: TaskProvisioningDiagnosticStage;
  readonly cause: TaskProvisioningDiagnosticCause;
}

const ATTEMPT_SELECT = {
  id: true,
  taskId: true,
  schemaVersion: true,
  attempt: true,
  admissionMode: true,
  providerFamily: true,
  state: true,
  stage: true,
  coverage: true,
  primaryOutcome: true,
  primaryCause: true,
  primaryRetryable: true,
  primaryExitCode: true,
  primaryObservedAt: true,
  cleanupState: true,
  cleanupCause: true,
  cleanupAttemptCount: true,
  cleanupLastAttemptOutcome: true,
  cleanupObservedAt: true,
  eventCount: true,
  truncated: true,
  startedAt: true,
  finishedAt: true,
  completenessMarkedAt: true,
} as const;

const EVENT_SELECT = {
  id: true,
  attemptId: true,
  taskId: true,
  schemaVersion: true,
  idempotencyKey: true,
  sequence: true,
  operationId: true,
  admissionMode: true,
  providerFamily: true,
  stage: true,
  operation: true,
  channel: true,
  commandKind: true,
  outcome: true,
  observedAt: true,
  durationMs: true,
  cause: true,
  retryable: true,
  httpStatusClass: true,
  nativeState: true,
  anomaly: true,
  exitCode: true,
  timeoutMs: true,
} as const;

const COMPACTION_SELECT = {
  compactedAttemptFrom: true,
  compactedAttemptTo: true,
  compactedAttemptCount: true,
  compactedEventCount: true,
  truncationCount: true,
  primarySucceededCount: true,
  primaryFailedCount: true,
  primaryTimedOutCount: true,
  primaryCancelledCount: true,
  primaryDegradedCount: true,
  primaryIndeterminateCount: true,
  cleanupNotRequiredCount: true,
  cleanupPendingCount: true,
  cleanupSucceededCount: true,
  cleanupFailedCount: true,
  compactedAt: true,
} as const;

/**
 * Prisma-backed bounded diagnostics ledger.
 *
 * Every mutation takes a task-scoped advisory lock inside one transaction.  It
 * serializes attempt allocation, event sequence allocation, completeness and
 * compaction without turning diagnostic persistence into admission authority.
 */
@Injectable()
export class TaskProvisioningDiagnosticsService
  implements TaskProvisioningDiagnosticRecorderPort
{
  private readonly logger = new Logger(TaskProvisioningDiagnosticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly metrics?: TaskProvisioningDiagnosticsMetricsService,
  ) {}

  async beginAttempt(
    input: BeginTaskProvisioningDiagnosticAttempt,
  ): Promise<DiagnosticResult<TaskProvisioningDiagnosticAttemptContext>> {
    const parsed = BeginAttemptSchema.safeParse(input);
    if (!parsed.success) return this.failure('invalid_evidence');

    try {
      let interruptedAttempt: TaskProvisioningDiagnosticAttempt | undefined;
      let committedRetryObservation:
        | CommittedRetryMetricObservation
        | undefined;
      const result = await this.withTaskLock<
        DiagnosticResult<TaskProvisioningDiagnosticAttemptContext>
      >(parsed.data.taskId, async (tx) => {
        const task = await tx.task.findUnique({
          where: { id: parsed.data.taskId },
          select: {
            id: true,
            provisioningDiagnosticSchemaVersion: true,
            provisioningDiagnosticNextAttempt: true,
          },
        });
        if (!task) return this.failure('task_not_found');
        if (
          task.provisioningDiagnosticSchemaVersion !==
            TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION ||
          task.provisioningDiagnosticNextAttempt === null
        ) {
          return this.failure('diagnostics_unavailable');
        }
        if (
          parsed.data.expectedAttempt !== undefined &&
          parsed.data.expectedAttempt <
            task.provisioningDiagnosticNextAttempt
        ) {
          return this.failure('attempt_number_conflict');
        }

        const active = await tx.taskProvisioningDiagnosticAttempt.findFirst({
          where: { taskId: task.id, state: 'active' },
          orderBy: { attempt: 'desc' },
          select: ATTEMPT_SELECT,
        });

        if (parsed.data.replayAttemptId) {
          const replay = await tx.taskProvisioningDiagnosticAttempt.findFirst({
            where: {
              id: parsed.data.replayAttemptId,
              taskId: task.id,
              attempt: task.provisioningDiagnosticNextAttempt - 1,
              admissionMode: parsed.data.admissionMode,
            },
            select: ATTEMPT_SELECT,
          });
          if (replay && (!active || active.id === replay.id)) {
            return this.success(this.contextFromAttempt(replay));
          }
          return this.failure('active_attempt_conflict');
        }

        if (active) {
          if ((parsed.data.activeDisposition ?? 'reject') !== 'interrupt') {
            return this.failure('active_attempt_conflict');
          }
          const interruptedAt = new Date();
          const interruptedRow =
            await tx.taskProvisioningDiagnosticAttempt.update({
              where: { id: active.id },
              data: {
                state: 'interrupted',
                coverage: 'partial',
                primaryOutcome: active.primaryOutcome ?? 'indeterminate',
                primaryCause: active.primaryCause ?? 'settlement_unknown',
                primaryRetryable: active.primaryRetryable ?? true,
                primaryExitCode: active.primaryExitCode,
                primaryObservedAt: active.primaryObservedAt ?? interruptedAt,
                finishedAt: active.finishedAt ?? interruptedAt,
                completenessMarkedAt: null,
              },
              select: ATTEMPT_SELECT,
            });
          interruptedAttempt = attemptFromRecord(interruptedRow);
        }

        const attemptNumber =
          parsed.data.expectedAttempt ??
          task.provisioningDiagnosticNextAttempt;
        let retryObservationCandidate:
          | CommittedRetryMetricObservation
          | undefined;
        if (parsed.data.retry !== undefined) {
          const previousRow =
            await tx.taskProvisioningDiagnosticAttempt.findFirst({
              where: {
                taskId: task.id,
                attempt: attemptNumber - 1,
              },
              select: ATTEMPT_SELECT,
            });
          let previousAttempt:
            | TaskProvisioningDiagnosticAttempt
            | undefined;
          if (previousRow) {
            try {
              previousAttempt = attemptFromRecord(previousRow);
            } catch {
              // Malformed historical evidence is not a metrics authority. The
              // admission-proven safe retry evidence remains an honest fallback.
            }
          }
          const previousPrimary = previousAttempt?.primary;
          retryObservationCandidate = {
            kind: 'retry',
            providerFamily: previousAttempt?.providerFamily ?? 'unknown',
            stage:
              previousAttempt !== undefined &&
              previousPrimary?.retryable === true
                ? previousAttempt.stage
                : parsed.data.retry.stage,
            cause:
              previousPrimary?.retryable === true &&
              previousPrimary.cause !== null
                ? previousPrimary.cause
                : parsed.data.retry.cause,
          };
        }

        const compacted = await this.compactBeforeNextAttempt(tx, task.id);
        if (!compacted) return this.failure('attempt_limit_reached');

        const attemptId = randomUUID();
        const startedAt = new Date();
        const candidate = TaskProvisioningDiagnosticAttemptSchema.parse({
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          id: attemptId,
          taskId: task.id,
          attempt: attemptNumber,
          admissionMode: parsed.data.admissionMode,
          providerFamily: parsed.data.providerFamily ?? null,
          state: 'active',
          stage: parsed.data.stage ?? 'provider_selection',
          coverage: 'partial',
          primary: null,
          cleanup: {
            state: 'not_required',
            cause: null,
            attemptCount: 0,
            lastAttemptOutcome: null,
            observedAt: null,
          },
          eventCount: 0,
          truncated: false,
          startedAt,
          finishedAt: null,
          completenessMarkedAt: null,
        });

        const advanced = await tx.task.updateMany({
          where: {
            id: task.id,
            provisioningDiagnosticSchemaVersion:
              TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
            provisioningDiagnosticNextAttempt:
              task.provisioningDiagnosticNextAttempt,
          },
          data: { provisioningDiagnosticNextAttempt: attemptNumber + 1 },
        });
        if (advanced.count !== 1) {
          return this.failure('diagnostic_write_failed');
        }
        await tx.taskProvisioningDiagnosticAttempt.create({
          data: {
            id: candidate.id,
            taskId: candidate.taskId,
            schemaVersion: candidate.schemaVersion,
            attempt: candidate.attempt,
            admissionMode: candidate.admissionMode,
            providerFamily: candidate.providerFamily,
            state: candidate.state,
            stage: candidate.stage,
            coverage: candidate.coverage,
            cleanupState: candidate.cleanup.state,
            cleanupCause: candidate.cleanup.cause,
            cleanupAttemptCount: candidate.cleanup.attemptCount,
            cleanupLastAttemptOutcome: candidate.cleanup.lastAttemptOutcome,
            cleanupObservedAt: candidate.cleanup.observedAt,
            eventCount: candidate.eventCount,
            truncated: candidate.truncated,
            startedAt: candidate.startedAt,
          },
        });
        committedRetryObservation = retryObservationCandidate;
        return this.success(this.contextFromAttempt(candidate));
      });
      if (interruptedAttempt) {
        this.observeCommittedAttemptOutcome(interruptedAttempt);
      }
      if (committedRetryObservation) {
        this.observeCommittedRetry(committedRetryObservation);
      }
      return result;
    } catch {
      return this.storeFailure('begin_attempt');
    }
  }

  async resumeAttempt(
    input: ResumeTaskProvisioningDiagnosticAttempt,
  ): Promise<DiagnosticResult<ResumedTaskProvisioningDiagnosticAttempt>> {
    const parsed = ResumeAttemptSchema.safeParse(input);
    if (!parsed.success) return this.failure('invalid_evidence');

    try {
      const row =
        await this.prisma.taskProvisioningDiagnosticAttempt.findFirst({
          where: {
            taskId: parsed.data.taskId,
            admissionMode: parsed.data.admissionMode,
            attempt: parsed.data.attempt,
          },
          select: ATTEMPT_SELECT,
        });
      if (!row) return this.failure('attempt_not_found');

      // Parse the whole retained row, not only the coordinates returned to the
      // caller. Recovery must never resume malformed state/provider/sequence
      // evidence or silently normalize unsupported persisted values.
      const attempt = attemptFromRecord(row);
      if (
        attempt.taskId !== parsed.data.taskId ||
        attempt.admissionMode !== parsed.data.admissionMode ||
        attempt.attempt !== parsed.data.attempt
      ) {
        throw new Error('diagnostic resume lookup returned a mismatched row');
      }
      return this.success({
        context: this.contextFromAttempt(attempt),
        state: attempt.state,
        providerFamily: attempt.providerFamily,
        initialSequence: attempt.eventCount,
      });
    } catch {
      return this.storeFailure('resume_attempt');
    }
  }

  async appendEvent(
    context: TaskProvisioningDiagnosticAttemptContext,
    event: unknown,
  ): Promise<DiagnosticResult<AppendedTaskProvisioningDiagnosticEvent>> {
    const parsedContext = AttemptContextSchema.safeParse(context);
    if (!parsedContext.success || typeof event !== 'object' || event === null) {
      return this.failure('invalid_evidence');
    }

    const parsedEvent = TaskProvisioningDiagnosticEventSchema.safeParse(event);
    if (
      !parsedEvent.success ||
      !this.eventMatchesContext(parsedEvent.data, parsedContext.data)
    ) {
      return this.failure('invalid_evidence');
    }
    const candidate = parsedEvent.data;

    try {
      const result = await this.withTaskLock<
        DiagnosticResult<AppendedTaskProvisioningDiagnosticEvent>
      >(context.taskId, async (tx) => {
        const attempt = await tx.taskProvisioningDiagnosticAttempt.findFirst({
          where: { id: context.attemptId, taskId: context.taskId },
          select: ATTEMPT_SELECT,
        });
        if (!attempt || !this.contextMatches(parsedContext.data, attempt)) {
          return this.failure('attempt_not_found');
        }
        if (attempt.completenessMarkedAt !== null) {
          return this.failure('immutable_evidence_conflict');
        }
        if (
          attempt.providerFamily !== null &&
          attempt.providerFamily !== 'unknown' &&
          attempt.providerFamily !== candidate.providerFamily
        ) {
          return this.failure('immutable_evidence_conflict');
        }
        if (attempt.state !== 'active' && candidate.channel === 'primary') {
          return this.failure('immutable_evidence_conflict');
        }

        const replay = await tx.taskProvisioningDiagnosticEvent.findFirst({
          where: {
            attemptId: attempt.id,
            idempotencyKey: candidate.idempotencyKey,
          },
          select: EVENT_SELECT,
        });
        if (replay) {
          const parsedReplay = eventFromRecord(replay, attempt.attempt);
          return this.sameEventFacts(parsedReplay, candidate)
            ? this.success({ event: parsedReplay, replayed: true })
            : this.failure('immutable_evidence_conflict');
        }

        const logicalReplay =
          await tx.taskProvisioningDiagnosticEvent.findFirst({
            where: {
              attemptId: attempt.id,
              operationId: candidate.operationId,
              ...(candidate.outcome === 'started'
                ? { outcome: 'started' }
                : { outcome: { not: 'started' } }),
            },
            orderBy: { sequence: 'asc' },
            select: EVENT_SELECT,
          });
        if (logicalReplay) {
          const parsedReplay = eventFromRecord(logicalReplay, attempt.attempt);
          return this.sameEventFacts(parsedReplay, candidate)
            ? this.success({ event: parsedReplay, replayed: true })
            : this.failure('immutable_evidence_conflict');
        }

        if (
          attempt.eventCount >=
          TASK_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT
        ) {
          await tx.taskProvisioningDiagnosticAttempt.update({
            where: { id: attempt.id },
            data: {
              truncated: true,
              coverage: 'partial',
              completenessMarkedAt: null,
            },
          });
          return this.failure('event_limit_reached');
        }

        if (candidate.sequence !== attempt.eventCount + 1) {
          return this.failure('immutable_evidence_conflict');
        }

        await tx.taskProvisioningDiagnosticEvent.create({
          data: this.eventCreateData(candidate),
        });
        const advanced =
          await tx.taskProvisioningDiagnosticAttempt.updateMany({
            where: { id: attempt.id, eventCount: attempt.eventCount },
            data: {
              eventCount: { increment: 1 },
              providerFamily:
                attempt.providerFamily === null ||
                attempt.providerFamily === 'unknown'
                  ? candidate.providerFamily
                  : attempt.providerFamily,
              stage: candidate.stage,
              coverage: 'partial',
              completenessMarkedAt: null,
            },
          });
        if (advanced.count !== 1) {
          throw new Error('diagnostic event sequence allocation lost');
        }
        return this.success({ event: candidate, replayed: false });
      });
      if (result.ok && !result.value.replayed) {
        this.mirrorEventToStructuredLog(result.value.event);
        this.observeCommittedEvent(result.value.event);
      }
      return result;
    } catch {
      return this.storeFailure('append_event');
    }
  }

  async recordPrimary(
    context: TaskProvisioningDiagnosticAttemptContext,
    input: RecordTaskProvisioningDiagnosticPrimary,
  ): Promise<DiagnosticResult<TaskProvisioningDiagnosticAttempt>> {
    const parsedContext = AttemptContextSchema.safeParse(context);
    const parsedInput = RecordPrimarySchema.safeParse(input);
    if (
      !parsedContext.success ||
      !parsedInput.success ||
      !this.primaryMatchesState(parsedInput.data)
    ) {
      return this.failure('invalid_evidence');
    }

    try {
      let committedAttempt: TaskProvisioningDiagnosticAttempt | undefined;
      const result = await this.withTaskLock<
        DiagnosticResult<TaskProvisioningDiagnosticAttempt>
      >(context.taskId, async (tx) => {
        const attempt = await tx.taskProvisioningDiagnosticAttempt.findFirst({
          where: { id: context.attemptId, taskId: context.taskId },
          select: ATTEMPT_SELECT,
        });
        if (!attempt || !this.contextMatches(parsedContext.data, attempt)) {
          return this.failure('attempt_not_found');
        }
        if (attempt.primaryOutcome !== null) {
          const existing = attemptFromRecord(attempt);
          return this.samePrimary(existing, parsedInput.data)
            ? this.success(existing)
            : this.failure('immutable_evidence_conflict');
        }
        if (attempt.state !== 'active') {
          return this.failure('immutable_evidence_conflict');
        }

        const primary = parsedInput.data.primary;
        const row = await tx.taskProvisioningDiagnosticAttempt.update({
          where: { id: attempt.id },
          data: {
            state: parsedInput.data.state,
            stage: parsedInput.data.stage,
            coverage: 'partial',
            primaryOutcome: primary.outcome,
            primaryCause: primary.cause,
            primaryRetryable: primary.retryable,
            primaryExitCode: primary.exitCode,
            primaryObservedAt: primary.observedAt,
            finishedAt: primary.observedAt,
            completenessMarkedAt: null,
          },
          select: ATTEMPT_SELECT,
        });
        const updated = attemptFromRecord(row);
        committedAttempt = updated;
        return this.success(updated);
      });
      if (committedAttempt) {
        this.observeCommittedAttemptOutcome(committedAttempt);
      }
      return result;
    } catch {
      return this.storeFailure('record_primary');
    }
  }

  async recordCleanup(
    context: TaskProvisioningDiagnosticAttemptContext,
    cleanup: TaskProvisioningDiagnosticCleanupSummary,
  ): Promise<DiagnosticResult<TaskProvisioningDiagnosticAttempt>> {
    const parsedContext = AttemptContextSchema.safeParse(context);
    const parsedCleanup = TaskProvisioningDiagnosticCleanupSummarySchema.safeParse(
      cleanup,
    );
    if (
      !parsedContext.success ||
      !parsedCleanup.success
    ) {
      return this.failure('invalid_evidence');
    }

    try {
      let committedCleanupAttempt:
        | TaskProvisioningDiagnosticAttempt
        | undefined;
      const result = await this.withTaskLock<
        DiagnosticResult<TaskProvisioningDiagnosticAttempt>
      >(context.taskId, async (tx) => {
        const attempt = await tx.taskProvisioningDiagnosticAttempt.findFirst({
          where: { id: context.attemptId, taskId: context.taskId },
          select: ATTEMPT_SELECT,
        });
        if (!attempt || !this.contextMatches(parsedContext.data, attempt)) {
          return this.failure('attempt_not_found');
        }
        const existing = attemptFromRecord(attempt);
        if (this.sameCleanup(existing.cleanup, parsedCleanup.data)) {
          return this.success(existing);
        }
        if (
          attempt.completenessMarkedAt !== null ||
          parsedCleanup.data.attemptCount < attempt.cleanupAttemptCount ||
          (attempt.cleanupState === 'succeeded' ||
            attempt.cleanupState === 'failed')
        ) {
          return this.failure('immutable_evidence_conflict');
        }
        const isInitialPendingTransition =
          attempt.cleanupState === 'not_required' &&
          parsedCleanup.data.state === 'pending' &&
          parsedCleanup.data.attemptCount === 0;
        const isAuthoritativeTerminalTransition =
          attempt.cleanupState === 'pending' &&
          (parsedCleanup.data.state === 'succeeded' ||
            parsedCleanup.data.state === 'failed') &&
          parsedCleanup.data.attemptCount === attempt.cleanupAttemptCount &&
          parsedCleanup.data.lastAttemptOutcome ===
            attempt.cleanupLastAttemptOutcome &&
          (parsedCleanup.data.observedAt?.getTime() ?? null) ===
            (attempt.cleanupObservedAt?.getTime() ?? null);
        if (
          parsedCleanup.data.attemptCount === attempt.cleanupAttemptCount &&
          !isInitialPendingTransition &&
          !isAuthoritativeTerminalTransition
        ) {
          return this.failure('immutable_evidence_conflict');
        }

        const row = await tx.taskProvisioningDiagnosticAttempt.update({
          where: { id: attempt.id },
          data: {
            cleanupState: parsedCleanup.data.state,
            cleanupCause: parsedCleanup.data.cause,
            cleanupAttemptCount: parsedCleanup.data.attemptCount,
            cleanupLastAttemptOutcome:
              parsedCleanup.data.lastAttemptOutcome,
            cleanupObservedAt: parsedCleanup.data.observedAt,
            coverage: 'partial',
            completenessMarkedAt: null,
          },
          select: ATTEMPT_SELECT,
        });
        const updated = attemptFromRecord(row);
        if (
          updated.cleanup.attemptCount > existing.cleanup.attemptCount &&
          updated.cleanup.lastAttemptOutcome !== null
        ) {
          committedCleanupAttempt = updated;
        }
        return this.success(updated);
      });
      if (committedCleanupAttempt) {
        this.observeCommittedCleanupTransition(committedCleanupAttempt);
      }
      return result;
    } catch {
      return this.storeFailure('record_cleanup');
    }
  }

  async markComplete(
    context: TaskProvisioningDiagnosticAttemptContext,
  ): Promise<DiagnosticResult<TaskProvisioningDiagnosticAttempt>> {
    const parsedContext = AttemptContextSchema.safeParse(context);
    if (!parsedContext.success) return this.failure('invalid_evidence');

    try {
      return await this.withTaskLock(context.taskId, async (tx) => {
        const attemptRow =
          await tx.taskProvisioningDiagnosticAttempt.findFirst({
            where: { id: context.attemptId, taskId: context.taskId },
            select: ATTEMPT_SELECT,
          });
        if (
          !attemptRow ||
          !this.contextMatches(parsedContext.data, attemptRow)
        ) {
          return this.failure('attempt_not_found');
        }
        const eventRows = await tx.taskProvisioningDiagnosticEvent.findMany({
          where: { attemptId: attemptRow.id },
          orderBy: { sequence: 'asc' },
          select: EVENT_SELECT,
        });
        let attempt: TaskProvisioningDiagnosticAttempt;
        let events: TaskProvisioningDiagnosticEvent[];
        try {
          attempt = attemptFromRecord(attemptRow);
          events = eventRows.map((row) =>
            eventFromRecord(row, attemptRow.attempt),
          );
        } catch {
          if (attemptRow.completenessMarkedAt === null) {
            await this.markPartialWithin(tx, attemptRow.id);
          }
          return this.failure('incomplete_evidence');
        }
        if (!hasCompleteEventInvariants(attempt, events)) {
          if (attempt.completenessMarkedAt === null) {
            await this.markPartialWithin(tx, attempt.id);
          }
          return this.failure('incomplete_evidence');
        }

        // Completeness is a replay-stable proof, not a fresh observation. Once
        // the immutable marker exists, return the retained projection rather
        // than manufacturing a new timestamp that the database must reject.
        if (
          attempt.coverage === 'complete' &&
          attempt.completenessMarkedAt !== null
        ) {
          return this.success(attempt);
        }

        const markedAt = new Date();
        const candidate = TaskProvisioningDiagnosticAttemptSchema.parse({
          ...attempt,
          coverage: 'complete',
          completenessMarkedAt: markedAt,
        });
        const row = await tx.taskProvisioningDiagnosticAttempt.update({
          where: { id: attempt.id },
          data: { coverage: 'complete', completenessMarkedAt: markedAt },
          select: ATTEMPT_SELECT,
        });
        return this.success(
          TaskProvisioningDiagnosticAttemptSchema.parse({
            ...attemptFromRecord(row),
            coverage: candidate.coverage,
          }),
        );
      });
    } catch {
      return this.storeFailure('mark_complete');
    }
  }

  async upsertPartialAttempt(
    context: TaskProvisioningDiagnosticAttemptContext,
    input: {
      readonly providerFamily?:
        | 'aio'
        | 'cloud-http'
        | 'boxlite'
        | 'unknown'
        | null;
      readonly stage?: z.infer<typeof TaskProvisioningDiagnosticStageSchema>;
      readonly startedAt?: Date;
    } = {},
  ): Promise<DiagnosticResult<TaskProvisioningDiagnosticAttempt>> {
    const parsedContext = AttemptContextSchema.safeParse(context);
    const parsedInput = PartialAttemptInputSchema.safeParse(input);
    if (!parsedContext.success || !parsedInput.success) {
      return this.failure('invalid_evidence');
    }

    try {
      return await this.withTaskLock(context.taskId, async (tx) => {
        const task = await tx.task.findUnique({
          where: { id: context.taskId },
          select: {
            id: true,
            provisioningDiagnosticSchemaVersion: true,
            provisioningDiagnosticNextAttempt: true,
          },
        });
        if (!task) return this.failure('task_not_found');
        if (
          task.provisioningDiagnosticSchemaVersion !==
            TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION ||
          task.provisioningDiagnosticNextAttempt === null
        ) {
          return this.failure('diagnostics_unavailable');
        }

        const existing =
          await tx.taskProvisioningDiagnosticAttempt.findFirst({
            where: { id: context.attemptId, taskId: context.taskId },
            select: ATTEMPT_SELECT,
          });
        if (existing) {
          if (!this.contextMatches(parsedContext.data, existing)) {
            return this.failure('immutable_evidence_conflict');
          }
          if (existing.completenessMarkedAt !== null) {
            return existing.coverage === 'complete'
              ? this.success(attemptFromRecord(existing))
              : this.failure('immutable_evidence_conflict');
          }
          const row = await tx.taskProvisioningDiagnosticAttempt.update({
            where: { id: existing.id },
            data: { coverage: 'partial', completenessMarkedAt: null },
            select: ATTEMPT_SELECT,
          });
          return this.success(attemptFromRecord(row));
        }

        const conflictingNumber =
          await tx.taskProvisioningDiagnosticAttempt.findFirst({
            where: { taskId: context.taskId, attempt: context.attempt },
            select: { id: true },
          });
        if (conflictingNumber) {
          return this.failure('immutable_evidence_conflict');
        }
        const activeAttempt =
          await tx.taskProvisioningDiagnosticAttempt.findFirst({
            where: { taskId: context.taskId, state: 'active' },
            select: { id: true },
          });
        if (activeAttempt) {
          return this.failure('active_attempt_conflict');
        }
        if (
          context.attempt < task.provisioningDiagnosticNextAttempt - 1 ||
          context.attempt > task.provisioningDiagnosticNextAttempt
        ) {
          return this.failure('immutable_evidence_conflict');
        }
        const priorCompaction =
          await tx.taskProvisioningDiagnosticCompaction.findUnique({
            where: { taskId: task.id },
            select: { compactedAttemptTo: true },
          });
        if (
          priorCompaction &&
          context.attempt <= priorCompaction.compactedAttemptTo
        ) {
          return this.failure('immutable_evidence_conflict');
        }
        const compacted = await this.compactBeforeNextAttempt(tx, task.id);
        if (!compacted) return this.failure('attempt_limit_reached');

        const candidate = TaskProvisioningDiagnosticAttemptSchema.parse({
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          id: context.attemptId,
          taskId: context.taskId,
          attempt: context.attempt,
          admissionMode: context.admissionMode,
          providerFamily: parsedInput.data.providerFamily ?? null,
          state: 'active',
          stage: parsedInput.data.stage ?? 'provider_selection',
          coverage: 'partial',
          primary: null,
          cleanup: {
            state: 'not_required',
            cause: null,
            attemptCount: 0,
            lastAttemptOutcome: null,
            observedAt: null,
          },
          eventCount: 0,
          truncated: false,
          startedAt: parsedInput.data.startedAt ?? new Date(),
          finishedAt: null,
          completenessMarkedAt: null,
        });

        if (task.provisioningDiagnosticNextAttempt <= context.attempt) {
          await tx.task.update({
            where: { id: task.id },
            data: { provisioningDiagnosticNextAttempt: context.attempt + 1 },
          });
        }
        const row = await tx.taskProvisioningDiagnosticAttempt.create({
          data: {
            id: candidate.id,
            taskId: candidate.taskId,
            schemaVersion: candidate.schemaVersion,
            attempt: candidate.attempt,
            admissionMode: candidate.admissionMode,
            providerFamily: candidate.providerFamily,
            state: candidate.state,
            stage: candidate.stage,
            coverage: candidate.coverage,
            cleanupState: candidate.cleanup.state,
            cleanupCause: candidate.cleanup.cause,
            cleanupAttemptCount: candidate.cleanup.attemptCount,
            cleanupLastAttemptOutcome: candidate.cleanup.lastAttemptOutcome,
            cleanupObservedAt: candidate.cleanup.observedAt,
            eventCount: 0,
            truncated: false,
            startedAt: candidate.startedAt,
          },
          select: ATTEMPT_SELECT,
        });
        return this.success(attemptFromRecord(row));
      });
    } catch {
      return this.storeFailure('upsert_partial_attempt');
    }
  }

  /** Canonical bounded read; authorization is deliberately applied by adapters. */
  async readTaskDiagnostics(
    taskId: string,
    query: unknown = {},
  ): Promise<DiagnosticResult<TaskProvisioningDiagnosticsResponse>> {
    return this.readTaskDiagnosticsWithOwner(taskId, query);
  }

  /**
   * Public/MCP owner boundary. Ownership is part of the first Task lookup so a
   * cross-owner or ownerless task is indistinguishable from an unknown task and
   * no attempt/event row can be touched before that decision.
   */
  async readOwnedTaskDiagnostics(
    ownerUserId: string,
    taskId: string,
    query: unknown = {},
  ): Promise<DiagnosticResult<TaskProvisioningDiagnosticsResponse>> {
    return this.readTaskDiagnosticsWithOwner(taskId, query, ownerUserId);
  }

  private async readTaskDiagnosticsWithOwner(
    taskId: string,
    query: unknown,
    ownerUserId?: string,
  ): Promise<DiagnosticResult<TaskProvisioningDiagnosticsResponse>> {
    const parsedTaskId = UUIDSchema.safeParse(taskId);
    const parsedQuery = TaskProvisioningDiagnosticsQuerySchema.safeParse(query);
    if (!parsedTaskId.success || !parsedQuery.success) {
      return this.failure('invalid_evidence');
    }
    const cursor = parsedQuery.data.cursor
      ? decodeTaskProvisioningDiagnosticCursor(parsedQuery.data.cursor)
      : null;
    if (parsedQuery.data.cursor && !cursor) {
      return this.failure('invalid_evidence');
    }

    try {
      const select = {
        id: true,
        status: true,
        provisioningDiagnosticSchemaVersion: true,
        provisioningDiagnosticNextAttempt: true,
        admissionWork: { select: { state: true } },
      } as const;
      const task =
        ownerUserId === undefined
          ? await this.prisma.task.findUnique({
              where: { id: parsedTaskId.data },
              select,
            })
          : await this.prisma.task.findFirst({
              where: {
                id: parsedTaskId.data,
                ownerUserId,
              },
              select,
            });
      if (!task) return this.failure('task_not_found');
      const admissionState = admissionStateFromTask({
        taskStatus: task.status,
        admissionWorkState: task.admissionWork?.state,
      });

      if (task.provisioningDiagnosticSchemaVersion === null) {
        return this.success(
          TaskProvisioningDiagnosticsResponseSchema.parse({
            schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
            taskId: task.id,
            coverage: 'unavailable',
            admissionState,
            attempts: [],
            events: [],
            compaction: null,
            nextCursor: null,
          }),
        );
      }

      const [attemptRows, allEventRows, pageRows, compactionRow] =
        await Promise.all([
          this.prisma.taskProvisioningDiagnosticAttempt.findMany({
            where: { taskId: task.id },
            orderBy: { attempt: 'desc' },
            take: TASK_PROVISIONING_DIAGNOSTIC_MAX_DETAILED_ATTEMPTS + 1,
            select: ATTEMPT_SELECT,
          }),
          this.prisma.taskProvisioningDiagnosticEvent.findMany({
            where: { taskId: task.id },
            orderBy: [{ attemptId: 'asc' }, { sequence: 'asc' }],
            select: {
              ...EVENT_SELECT,
              attempt: { select: { attempt: true } },
            },
          }),
          this.prisma.taskProvisioningDiagnosticEvent.findMany({
            where: {
              taskId: task.id,
              schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
              ...(cursor
                ? {
                    OR: [
                      { observedAt: { gt: cursor.observedAt } },
                      {
                        observedAt: cursor.observedAt,
                        id: { gt: cursor.eventId },
                      },
                    ],
                  }
                : {}),
            },
            orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
            take: parsedQuery.data.limit + 1,
            select: {
              ...EVENT_SELECT,
              attempt: { select: { attempt: true } },
            },
          }),
          this.prisma.taskProvisioningDiagnosticCompaction.findUnique({
            where: { taskId: task.id },
            select: COMPACTION_SELECT,
          }),
        ]);

      let hasUnsupportedEvidence = false;
      const attempts: TaskProvisioningDiagnosticAttempt[] = [];
      if (
        attemptRows.length >
        TASK_PROVISIONING_DIAGNOSTIC_MAX_DETAILED_ATTEMPTS
      ) {
        hasUnsupportedEvidence = true;
      }
      const retainedAttemptRows = attemptRows
        .slice(0, TASK_PROVISIONING_DIAGNOSTIC_MAX_DETAILED_ATTEMPTS)
        .sort((left, right) => left.attempt - right.attempt);
      for (const row of retainedAttemptRows) {
        try {
          attempts.push(attemptFromRecord(row));
        } catch {
          hasUnsupportedEvidence = true;
        }
      }

      const eventsByAttempt = new Map<
        string,
        TaskProvisioningDiagnosticEvent[]
      >();
      for (const row of allEventRows) {
        try {
          const event = eventFromRecord(row, row.attempt.attempt);
          const existing = eventsByAttempt.get(event.attemptId) ?? [];
          existing.push(event);
          eventsByAttempt.set(event.attemptId, existing);
        } catch {
          hasUnsupportedEvidence = true;
        }
      }

      let compaction: TaskProvisioningDiagnosticCompactionSummary | null = null;
      if (compactionRow) {
        try {
          compaction = compactionFromRecord(compactionRow);
        } catch {
          hasUnsupportedEvidence = true;
        }
      }

      const hasMore = pageRows.length > parsedQuery.data.limit;
      const visibleRows = pageRows.slice(0, parsedQuery.data.limit);
      const events: TaskProvisioningDiagnosticEvent[] = [];
      for (const row of visibleRows) {
        try {
          events.push(eventFromRecord(row, row.attempt.attempt));
        } catch {
          hasUnsupportedEvidence = true;
        }
      }
      const lastRow = visibleRows.at(-1);
      const nextCursor =
        hasMore && lastRow
          ? encodeTaskProvisioningDiagnosticCursor({
              observedAt: lastRow.observedAt,
              eventId: lastRow.id,
            })
          : null;
      if (
        compactionRow === null &&
        !this.hasContinuousAttemptAllocation(
          task.provisioningDiagnosticNextAttempt,
          attempts,
        )
      ) {
        hasUnsupportedEvidence = true;
      }
      const coverage = deriveTaskDiagnosticCoverage({
        expectedSchemaVersion: task.provisioningDiagnosticSchemaVersion,
        taskStatus: task.status,
        admissionState,
        attempts,
        eventsByAttempt,
        hasCompaction: compactionRow !== null,
        hasUnsupportedEvidence,
      });
      return this.success(
        TaskProvisioningDiagnosticsResponseSchema.parse({
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          taskId: task.id,
          coverage,
          admissionState,
          attempts,
          events,
          compaction,
          nextCursor,
        }),
      );
    } catch {
      return this.storeFailure('read_projection');
    }
  }

  async compactTask(taskId: string): Promise<DiagnosticResult<number>> {
    const parsed = UUIDSchema.safeParse(taskId);
    if (!parsed.success) return this.failure('invalid_evidence');
    try {
      return await this.withTaskLock(parsed.data, async (tx) => {
        const before = await tx.taskProvisioningDiagnosticAttempt.count({
          where: { taskId: parsed.data },
        });
        const compacted = await this.compactBeforeNextAttempt(
          tx,
          parsed.data,
          false,
        );
        if (!compacted) return this.failure('attempt_limit_reached');
        const after = await tx.taskProvisioningDiagnosticAttempt.count({
          where: { taskId: parsed.data },
        });
        return this.success(before - after);
      });
    } catch {
      return this.storeFailure('compact_task');
    }
  }

  private async compactBeforeNextAttempt(
    tx: Prisma.TransactionClient,
    taskId: string,
    reserveNextSlot = true,
  ): Promise<boolean> {
    const attempts = await tx.taskProvisioningDiagnosticAttempt.findMany({
      where: { taskId },
      orderBy: { attempt: 'asc' },
      select: ATTEMPT_SELECT,
    });
    const retainedCeiling =
      TASK_PROVISIONING_DIAGNOSTIC_MAX_DETAILED_ATTEMPTS -
      (reserveNextSlot ? 1 : 0);
    const removeCount = attempts.length - retainedCeiling;
    if (removeCount <= 0) return true;

    const latest = attempts.at(-1);
    const eligible: typeof attempts = [];
    for (const attempt of attempts) {
      if (
        attempt.id === latest?.id ||
        attempt.state === 'active' ||
        attempt.cleanupState === 'pending'
      ) {
        break;
      }
      eligible.push(attempt);
    }
    if (eligible.length < removeCount) return false;
    const selected = eligible.slice(0, removeCount);
    const existing = await tx.taskProvisioningDiagnosticCompaction.findUnique({
      where: { taskId },
      select: COMPACTION_SELECT,
    });

    const increment = this.compactionCounts(selected);
    const combined = {
      compactedAttemptFrom: Math.min(
        existing?.compactedAttemptFrom ?? selected[0]!.attempt,
        selected[0]!.attempt,
      ),
      compactedAttemptTo: Math.max(
        existing?.compactedAttemptTo ?? selected.at(-1)!.attempt,
        selected.at(-1)!.attempt,
      ),
      compactedAttemptCount:
        (existing?.compactedAttemptCount ?? 0) + selected.length,
      compactedEventCount:
        (existing?.compactedEventCount ?? 0) +
        selected.reduce((sum, attempt) => sum + attempt.eventCount, 0),
      // Removing one detailed attempt is itself one honest truncation of detail;
      // per-attempt event truncation is already retained in the same count.
      truncationCount:
        (existing?.truncationCount ?? 0) +
        selected.reduce(
          (sum, attempt) => sum + 1 + (attempt.truncated ? 1 : 0),
          0,
        ),
      primarySucceededCount:
        (existing?.primarySucceededCount ?? 0) + increment.primary.succeeded,
      primaryFailedCount:
        (existing?.primaryFailedCount ?? 0) + increment.primary.failed,
      primaryTimedOutCount:
        (existing?.primaryTimedOutCount ?? 0) + increment.primary.timedOut,
      primaryCancelledCount:
        (existing?.primaryCancelledCount ?? 0) + increment.primary.cancelled,
      primaryDegradedCount:
        (existing?.primaryDegradedCount ?? 0) + increment.primary.degraded,
      primaryIndeterminateCount:
        (existing?.primaryIndeterminateCount ?? 0) +
        increment.primary.indeterminate,
      cleanupNotRequiredCount:
        (existing?.cleanupNotRequiredCount ?? 0) +
        increment.cleanup.notRequired,
      cleanupPendingCount: 0,
      cleanupSucceededCount:
        (existing?.cleanupSucceededCount ?? 0) + increment.cleanup.succeeded,
      cleanupFailedCount:
        (existing?.cleanupFailedCount ?? 0) + increment.cleanup.failed,
      compactedAt: new Date(),
    };
    // Validate the fixed aggregate before either writing it or deleting detail.
    compactionFromRecord(combined);
    await tx.taskProvisioningDiagnosticCompaction.upsert({
      where: { taskId },
      create: { taskId, ...combined },
      update: combined,
    });
    await tx.$executeRaw(Prisma.sql`
      SET LOCAL cap.diagnostic_compaction = 'on'
    `);
    await tx.taskProvisioningDiagnosticAttempt.deleteMany({
      where: { id: { in: selected.map((attempt) => attempt.id) } },
    });
    return true;
  }

  private compactionCounts(attempts: readonly DiagnosticAttemptRecord[]) {
    const primary = {
      succeeded: 0,
      failed: 0,
      timedOut: 0,
      cancelled: 0,
      degraded: 0,
      indeterminate: 0,
    };
    const cleanup = { notRequired: 0, succeeded: 0, failed: 0 };
    for (const attempt of attempts) {
      switch (attempt.primaryOutcome) {
        case 'succeeded':
          primary.succeeded += 1;
          break;
        case 'failed':
          primary.failed += 1;
          break;
        case 'timed_out':
          primary.timedOut += 1;
          break;
        case 'cancelled':
          primary.cancelled += 1;
          break;
        case 'degraded':
          primary.degraded += 1;
          break;
        default:
          primary.indeterminate += 1;
      }
      switch (attempt.cleanupState) {
        case 'not_required':
          cleanup.notRequired += 1;
          break;
        case 'succeeded':
          cleanup.succeeded += 1;
          break;
        case 'failed':
          cleanup.failed += 1;
          break;
      }
    }
    return { primary, cleanup };
  }

  private eventCreateData(event: TaskProvisioningDiagnosticEvent) {
    return {
      id: event.eventId,
      attemptId: event.attemptId,
      taskId: event.taskId,
      schemaVersion: event.schemaVersion,
      idempotencyKey: event.idempotencyKey,
      sequence: event.sequence,
      operationId: event.operationId,
      admissionMode: event.admissionMode,
      providerFamily: event.providerFamily,
      stage: event.stage,
      operation: event.operation,
      channel: event.channel,
      commandKind: event.commandKind ?? null,
      outcome: event.outcome,
      observedAt: event.observedAt,
      durationMs: event.outcome === 'started' ? null : event.durationMs ?? null,
      cause: event.outcome === 'started' ? null : event.cause,
      retryable: event.outcome === 'started' ? null : event.retryable,
      httpStatusClass:
        event.outcome === 'started' ? null : event.httpStatusClass ?? null,
      nativeState:
        event.outcome === 'started' ? null : event.nativeState ?? null,
      anomaly: event.outcome === 'started' ? null : event.anomaly ?? null,
      exitCode: event.outcome === 'started' ? null : event.exitCode ?? null,
      timeoutMs: event.outcome === 'started' ? null : event.timeoutMs ?? null,
    };
  }

  private eventMatchesContext(
    event: TaskProvisioningDiagnosticEvent,
    context: TaskProvisioningDiagnosticAttemptContext,
  ): boolean {
    return (
      event.schemaVersion ===
        TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION &&
      event.taskId === context.taskId &&
      event.attemptId === context.attemptId &&
      event.attempt === context.attempt &&
      event.admissionMode === context.admissionMode
    );
  }

  /**
   * Replays may arrive with a freshly generated candidate event id, sequence or
   * observation time after restart.  Those recorder-owned coordinates resolve
   * to the already retained canonical row; every operation/failure fact must be
   * byte-for-byte stable or the replay is rejected.
   */
  private sameEventFacts(
    retained: TaskProvisioningDiagnosticEvent,
    candidate: TaskProvisioningDiagnosticEvent,
  ): boolean {
    const facts = (event: TaskProvisioningDiagnosticEvent) => ({
      schemaVersion: event.schemaVersion,
      idempotencyKey: event.idempotencyKey,
      taskId: event.taskId,
      attemptId: event.attemptId,
      attempt: event.attempt,
      operationId: event.operationId,
      admissionMode: event.admissionMode,
      providerFamily: event.providerFamily,
      stage: event.stage,
      operation: event.operation,
      channel: event.channel,
      commandKind: event.commandKind ?? null,
      outcome: event.outcome,
      durationMs:
        event.outcome === 'started' ? null : event.durationMs ?? null,
      cause: event.outcome === 'started' ? null : event.cause,
      retryable: event.outcome === 'started' ? null : event.retryable,
      httpStatusClass:
        event.outcome === 'started' ? null : event.httpStatusClass ?? null,
      nativeState:
        event.outcome === 'started' ? null : event.nativeState ?? null,
      anomaly: event.outcome === 'started' ? null : event.anomaly ?? null,
      exitCode: event.outcome === 'started' ? null : event.exitCode ?? null,
      timeoutMs: event.outcome === 'started' ? null : event.timeoutMs ?? null,
    });
    return JSON.stringify(facts(retained)) === JSON.stringify(facts(candidate));
  }

  private primaryMatchesState(input: z.infer<typeof RecordPrimarySchema>): boolean {
    switch (input.state) {
      case 'succeeded':
        return (
          input.primary.outcome === 'succeeded' ||
          input.primary.outcome === 'degraded'
        );
      case 'cancelled':
        return input.primary.outcome === 'cancelled';
      case 'interrupted':
        return input.primary.outcome === 'indeterminate';
      case 'failed':
        return (
          input.primary.outcome === 'failed' ||
          input.primary.outcome === 'timed_out' ||
          input.primary.outcome === 'indeterminate'
        );
    }
  }

  private samePrimary(
    attempt: TaskProvisioningDiagnosticAttempt,
    input: z.infer<typeof RecordPrimarySchema>,
  ): boolean {
    const primary = attempt.primary;
    return (
      primary !== null &&
      attempt.state === input.state &&
      attempt.stage === input.stage &&
      primary.outcome === input.primary.outcome &&
      primary.cause === input.primary.cause &&
      primary.retryable === input.primary.retryable &&
      primary.exitCode === input.primary.exitCode &&
      primary.observedAt.getTime() === input.primary.observedAt.getTime()
    );
  }

  private sameCleanup(
    left: TaskProvisioningDiagnosticCleanupSummary,
    right: TaskProvisioningDiagnosticCleanupSummary,
  ): boolean {
    return (
      left.state === right.state &&
      left.cause === right.cause &&
      left.attemptCount === right.attemptCount &&
      left.lastAttemptOutcome === right.lastAttemptOutcome &&
      (left.observedAt?.getTime() ?? null) ===
        (right.observedAt?.getTime() ?? null)
    );
  }

  private contextMatches(
    context: TaskProvisioningDiagnosticAttemptContext,
    attempt: {
      id: string;
      taskId: string;
      attempt: number;
      admissionMode: string;
    },
  ): boolean {
    return (
      attempt.id === context.attemptId &&
      attempt.taskId === context.taskId &&
      attempt.attempt === context.attempt &&
      attempt.admissionMode === context.admissionMode
    );
  }

  /**
   * Without a compaction summary, every allocated task-local number must still
   * have one retained detail row. A drifted/invalid counter or any gap is
   * incomplete evidence even when the newest retained attempt is complete.
   */
  private hasContinuousAttemptAllocation(
    nextAttempt: number | null,
    attempts: readonly TaskProvisioningDiagnosticAttempt[],
  ): boolean {
    if (!Number.isSafeInteger(nextAttempt) || nextAttempt === null || nextAttempt < 1) {
      return false;
    }
    if (attempts.length !== nextAttempt - 1) return false;
    return attempts.every((attempt, index) => attempt.attempt === index + 1);
  }

  private contextFromAttempt(attempt: {
    id: string;
    taskId: string;
    attempt: number;
    admissionMode: string;
  }): TaskProvisioningDiagnosticAttemptContext {
    return AttemptContextSchema.parse({
      taskId: attempt.taskId,
      attemptId: attempt.id,
      attempt: attempt.attempt,
      admissionMode: attempt.admissionMode,
    });
  }

  private async markPartialWithin(
    tx: Prisma.TransactionClient,
    attemptId: string,
  ): Promise<void> {
    await tx.taskProvisioningDiagnosticAttempt.update({
      where: { id: attemptId },
      data: { coverage: 'partial', completenessMarkedAt: null },
    });
  }

  private async withTaskLock<T>(
    taskId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // Lightweight/in-memory recorder implementations have no database lock
    // primitive. They retain the existing single-process execution path.
    if (typeof this.prisma.$transaction !== 'function') {
      return operation(this.prisma as unknown as Prisma.TransactionClient);
    }
    return this.prisma.$transaction(async (tx) => {
      const lockRows = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${taskId}, 0)) AS acquired
      `);
      if (lockRows.length !== 1 || lockRows[0]?.acquired !== true) {
        // Do not expose database/lock details. The enclosing recorder operation
        // converts this fixed sentinel into its normal safe persistence result.
        throw new Error('task_provisioning_diagnostic_lock_unavailable');
      }
      return operation(tx);
    });
  }

  private success<T>(value: T): DiagnosticResult<T> {
    return { ok: true, value };
  }

  private failure<T>(
    code: TaskProvisioningDiagnosticRecorderFailureCode,
  ): DiagnosticResult<T> {
    return {
      ok: false,
      code,
      safeCause:
        code === 'diagnostic_write_failed'
          ? 'diagnostic_write_failed'
          : 'coordination_failed',
    };
  }

  private storeFailure<T>(operation: string): DiagnosticResult<T> {
    this.logger.warn(
      {
        event: 'task_provisioning_diagnostic_store_failure',
        operation,
        cause: 'diagnostic_write_failed',
      },
      'Provisioning diagnostic persistence failed',
    );
    return this.failure('diagnostic_write_failed');
  }

  /**
   * Mirror committed evidence only. Logging is best-effort observability and
   * must never change the result of an event already accepted by the ledger.
   */
  private mirrorEventToStructuredLog(
    event: TaskProvisioningDiagnosticEvent,
  ): void {
    try {
      this.logger.log(toTaskProvisioningDiagnosticLogRecord(event));
    } catch {
      // The database remains the historical source of truth. Do not retry here:
      // replay logging would violate the one-record-per-canonical-event bound.
    }
  }

  /**
   * Project committed ledger evidence into bounded, identifier-free metrics.
   * Metrics remain best-effort and can never change recorder persistence or
   * replay semantics.
   */
  private observeCommittedEvent(event: TaskProvisioningDiagnosticEvent): void {
    try {
      this.metrics?.observeEvent({
        providerFamily: event.providerFamily,
        stage: event.stage,
        operation: event.operation,
        outcome: event.outcome,
        durationMs:
          event.outcome === 'started' ? null : event.durationMs ?? null,
        anomaly: event.outcome === 'started' ? null : event.anomaly ?? null,
      });
    } catch {
      // Observability failure cannot become diagnostic-store authority.
    }
  }

  private observeCommittedAttemptOutcome(
    attempt: TaskProvisioningDiagnosticAttempt,
  ): void {
    if (!attempt.primary) return;
    const durationMs = attempt.finishedAt
      ? nonnegativeSafeDuration(
          attempt.startedAt.getTime(),
          attempt.finishedAt.getTime(),
        )
      : null;
    try {
      this.metrics?.observeAttemptOutcome({
        providerFamily: attempt.providerFamily ?? 'unknown',
        outcome: attempt.primary.outcome,
        cause: attempt.primary.cause,
        retryable: attempt.primary.retryable,
        durationMs,
      });
    } catch {
      // Observability failure cannot become diagnostic-store authority.
    }
  }

  private observeCommittedCleanupTransition(
    attempt: TaskProvisioningDiagnosticAttempt,
  ): void {
    try {
      this.metrics?.observeCleanupTransition({
        providerFamily: attempt.providerFamily ?? 'unknown',
        cleanupState: attempt.cleanup.state,
        cause: attempt.cleanup.cause,
      });
    } catch {
      // Observability failure cannot become diagnostic-store authority.
    }
  }

  private observeCommittedRetry(
    observation: CommittedRetryMetricObservation,
  ): void {
    try {
      this.metrics?.observeRetry(observation);
    } catch {
      // Observability failure cannot become diagnostic-store authority.
    }
  }
}

function nonnegativeSafeDuration(startedAtMs: number, finishedAtMs: number) {
  const durationMs = finishedAtMs - startedAtMs;
  return Number.isSafeInteger(durationMs) && durationMs >= 0
    ? durationMs
    : null;
}
