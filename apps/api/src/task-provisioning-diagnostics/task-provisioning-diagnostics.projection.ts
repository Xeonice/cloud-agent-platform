import {
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticAttemptSchema,
  TaskProvisioningDiagnosticCompactionSummarySchema,
  TaskProvisioningDiagnosticEventSchema,
  TaskProvisioningDiagnosticCoverageSchema,
  TaskProvisioningStateSchema,
  type TaskProvisioningDiagnosticAttempt,
  type TaskProvisioningDiagnosticCompactionSummary,
  type TaskProvisioningDiagnosticCoverage,
  type TaskProvisioningDiagnosticEvent,
  type TaskProvisioningState,
} from '@cap/contracts';
import { z } from 'zod';

export interface DiagnosticAttemptRecord {
  readonly id: string;
  readonly taskId: string;
  readonly schemaVersion: number;
  readonly attempt: number;
  readonly admissionMode: string;
  readonly providerFamily: string | null;
  readonly state: string;
  readonly stage: string;
  readonly coverage: string;
  readonly primaryOutcome: string | null;
  readonly primaryCause: string | null;
  readonly primaryRetryable: boolean | null;
  readonly primaryExitCode: number | null;
  readonly primaryObservedAt: Date | null;
  readonly cleanupState: string;
  readonly cleanupCause: string | null;
  readonly cleanupAttemptCount: number;
  readonly cleanupLastAttemptOutcome: string | null;
  readonly cleanupObservedAt: Date | null;
  readonly eventCount: number;
  readonly truncated: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly completenessMarkedAt: Date | null;
}

export interface DiagnosticEventRecord {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly schemaVersion: number;
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly operationId: string;
  readonly admissionMode: string;
  readonly providerFamily: string;
  readonly stage: string;
  readonly operation: string;
  readonly channel: string;
  readonly commandKind: string | null;
  readonly outcome: string;
  readonly observedAt: Date;
  readonly durationMs: number | null;
  readonly cause: string | null;
  readonly retryable: boolean | null;
  readonly httpStatusClass: string | null;
  readonly nativeState: string | null;
  readonly anomaly: string | null;
  readonly exitCode: number | null;
  readonly timeoutMs: number | null;
}

export interface DiagnosticCompactionRecord {
  readonly compactedAttemptFrom: number;
  readonly compactedAttemptTo: number;
  readonly compactedAttemptCount: number;
  readonly compactedEventCount: number;
  readonly truncationCount: number;
  readonly primarySucceededCount: number;
  readonly primaryFailedCount: number;
  readonly primaryTimedOutCount: number;
  readonly primaryCancelledCount: number;
  readonly primaryDegradedCount: number;
  readonly primaryIndeterminateCount: number;
  readonly cleanupNotRequiredCount: number;
  readonly cleanupPendingCount: number;
  readonly cleanupSucceededCount: number;
  readonly cleanupFailedCount: number;
  readonly compactedAt: Date;
}

export function attemptFromRecord(
  row: DiagnosticAttemptRecord,
): TaskProvisioningDiagnosticAttempt {
  return TaskProvisioningDiagnosticAttemptSchema.parse({
    schemaVersion: row.schemaVersion,
    id: row.id,
    taskId: row.taskId,
    attempt: row.attempt,
    admissionMode: row.admissionMode,
    providerFamily: row.providerFamily,
    state: row.state,
    stage: row.stage,
    coverage: row.coverage,
    primary:
      row.primaryOutcome === null
        ? null
        : {
            outcome: row.primaryOutcome,
            cause: row.primaryCause,
            retryable: row.primaryRetryable,
            exitCode: row.primaryExitCode,
            observedAt: row.primaryObservedAt,
          },
    cleanup: {
      state: row.cleanupState,
      cause: row.cleanupCause,
      attemptCount: row.cleanupAttemptCount,
      lastAttemptOutcome: row.cleanupLastAttemptOutcome,
      observedAt: row.cleanupObservedAt,
    },
    eventCount: row.eventCount,
    truncated: row.truncated,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    completenessMarkedAt: row.completenessMarkedAt,
  });
}

export function eventFromRecord(
  row: DiagnosticEventRecord,
  attemptNumber: number,
): TaskProvisioningDiagnosticEvent {
  const common = {
    schemaVersion: row.schemaVersion,
    eventId: row.id,
    idempotencyKey: row.idempotencyKey,
    taskId: row.taskId,
    attemptId: row.attemptId,
    sequence: row.sequence,
    operationId: row.operationId,
    admissionMode: row.admissionMode,
    providerFamily: row.providerFamily,
    stage: row.stage,
    operation: row.operation,
    channel: row.channel,
    commandKind: row.commandKind,
    observedAt: row.observedAt,
  };
  const withAttempt = { ...common, attempt: attemptNumber };
  if (row.outcome === 'started') {
    return TaskProvisioningDiagnosticEventSchema.parse({
      ...withAttempt,
      outcome: 'started',
    });
  }
  return TaskProvisioningDiagnosticEventSchema.parse({
    ...withAttempt,
    outcome: row.outcome,
    ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    cause: row.cause,
    retryable: row.retryable,
    httpStatusClass: row.httpStatusClass,
    nativeState: row.nativeState,
    anomaly: row.anomaly,
    exitCode: row.exitCode,
    timeoutMs: row.timeoutMs,
  });
}

export function compactionFromRecord(
  row: DiagnosticCompactionRecord,
): TaskProvisioningDiagnosticCompactionSummary {
  return TaskProvisioningDiagnosticCompactionSummarySchema.parse({
    compactedAttemptFrom: row.compactedAttemptFrom,
    compactedAttemptTo: row.compactedAttemptTo,
    compactedAttemptCount: row.compactedAttemptCount,
    compactedEventCount: row.compactedEventCount,
    truncationCount: row.truncationCount,
    primaryOutcomeCounts: {
      succeeded: row.primarySucceededCount,
      failed: row.primaryFailedCount,
      timedOut: row.primaryTimedOutCount,
      cancelled: row.primaryCancelledCount,
      degraded: row.primaryDegradedCount,
      indeterminate: row.primaryIndeterminateCount,
    },
    cleanupStateCounts: {
      notRequired: row.cleanupNotRequiredCount,
      pending: row.cleanupPendingCount,
      succeeded: row.cleanupSucceededCount,
      failed: row.cleanupFailedCount,
    },
    compactedAt: row.compactedAt,
  });
}

/** Explicit completeness proof used both by the writer and fail-closed reader. */
export function hasCompleteEventInvariants(
  attempt: TaskProvisioningDiagnosticAttempt,
  events: readonly TaskProvisioningDiagnosticEvent[],
): boolean {
  if (
    attempt.schemaVersion !== TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION ||
    attempt.state === 'active' ||
    attempt.state === 'interrupted' ||
    attempt.primary === null ||
    attempt.cleanup.state === 'pending' ||
    attempt.truncated ||
    attempt.eventCount !== events.length ||
    events.length === 0
  ) {
    return false;
  }

  const operations = new Map<
    string,
    {
      started: number;
      terminal: number;
      providerFamily: string;
      stage: string;
      operation: string;
      channel: string;
      commandKind: string | null;
    }
  >();
  for (const [index, event] of events.entries()) {
    if (
      event.schemaVersion !== TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION ||
      event.attemptId !== attempt.id ||
      event.taskId !== attempt.taskId ||
      event.attempt !== attempt.attempt ||
      event.sequence !== index + 1
    ) {
      return false;
    }
    const operation = operations.get(event.operationId) ?? {
      started: 0,
      terminal: 0,
      providerFamily: event.providerFamily,
      stage: event.stage,
      operation: event.operation,
      channel: event.channel,
      commandKind: event.commandKind ?? null,
    };
    if (
      operation.providerFamily !== event.providerFamily ||
      operation.stage !== event.stage ||
      operation.operation !== event.operation ||
      operation.channel !== event.channel ||
      operation.commandKind !== (event.commandKind ?? null)
    ) {
      return false;
    }
    if (event.outcome === 'started') operation.started += 1;
    else operation.terminal += 1;
    if (operation.started > 1 || operation.terminal > 1) return false;
    operations.set(event.operationId, operation);
  }

  const paired = [...operations.values()].every(
    (operation) => operation.started === 1 && operation.terminal === 1,
  );
  if (!paired) return false;

  // The attempt's terminal primary projection must be backed by one retained
  // primary terminal event. Otherwise a separately-written summary could
  // contradict an internally paired event stream while still claiming
  // complete coverage.
  return events.some(
    (event) =>
      event.outcome !== 'started' &&
      event.channel === 'primary' &&
      event.stage === attempt.stage &&
      event.outcome === attempt.primary?.outcome &&
      event.cause === attempt.primary.cause &&
      event.retryable === attempt.primary.retryable &&
      (event.exitCode ?? null) === attempt.primary.exitCode &&
      event.observedAt.getTime() === attempt.primary.observedAt.getTime(),
  );
}

export function deriveTaskDiagnosticCoverage(input: {
  readonly expectedSchemaVersion: number | null;
  readonly taskStatus: string;
  readonly admissionState: TaskProvisioningState | null;
  readonly attempts: readonly TaskProvisioningDiagnosticAttempt[];
  readonly eventsByAttempt: ReadonlyMap<
    string,
    readonly TaskProvisioningDiagnosticEvent[]
  >;
  readonly hasCompaction: boolean;
  readonly hasUnsupportedEvidence: boolean;
}): TaskProvisioningDiagnosticCoverage {
  if (input.expectedSchemaVersion === null) return 'unavailable';
  if (
    input.expectedSchemaVersion !==
      TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION ||
    input.hasCompaction ||
    input.hasUnsupportedEvidence
  ) {
    return 'partial';
  }
  if (input.attempts.length === 0) {
    const notStarted =
      input.admissionState === 'accepted' ||
      input.admissionState === 'queued' ||
      (input.admissionState === null && input.taskStatus === 'pending');
    return notStarted ? 'not_started' : 'partial';
  }
  const complete = input.attempts.every(
    (attempt) =>
      attempt.coverage === 'complete' &&
      attempt.completenessMarkedAt !== null &&
      hasCompleteEventInvariants(
        attempt,
        input.eventsByAttempt.get(attempt.id) ?? [],
      ),
  );
  return TaskProvisioningDiagnosticCoverageSchema.parse(
    complete ? 'complete' : 'partial',
  );
}

export function admissionStateFromTask(input: {
  readonly taskStatus: string;
  readonly admissionWorkState?: string | null;
}): TaskProvisioningState | null {
  const persisted = TaskProvisioningStateSchema.safeParse(
    input.admissionWorkState,
  );
  if (persisted.success) return persisted.data;
  const mapped: Record<string, TaskProvisioningState> = {
    pending: 'accepted',
    queued: 'queued',
    running: 'running',
    awaiting_input: 'running',
    completed: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    agent_failed_to_start: 'failed',
  };
  return mapped[input.taskStatus] ?? null;
}

const DiagnosticCursorSchema = z
  .object({
    version: z.literal(1),
    observedAt: z.string().datetime({ offset: true }),
    eventId: z.string().uuid(),
  })
  .strict();

export interface TaskProvisioningDiagnosticCursor {
  readonly observedAt: Date;
  readonly eventId: string;
}

export function encodeTaskProvisioningDiagnosticCursor(
  cursor: TaskProvisioningDiagnosticCursor,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      observedAt: cursor.observedAt.toISOString(),
      eventId: cursor.eventId,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeTaskProvisioningDiagnosticCursor(
  cursor: string,
): TaskProvisioningDiagnosticCursor | null {
  if (cursor.length === 0 || cursor.length > 2_048) return null;
  try {
    const decoded = DiagnosticCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return { observedAt: new Date(decoded.observedAt), eventId: decoded.eventId };
  } catch {
    return null;
  }
}
