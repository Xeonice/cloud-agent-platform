import type {
  TaskProvisioningDiagnosticAdmissionMode,
  TaskProvisioningDiagnosticAttempt,
  TaskProvisioningDiagnosticAttemptState,
  TaskProvisioningDiagnosticCause,
  TaskProvisioningDiagnosticCleanupSummary,
  TaskProvisioningDiagnosticPrimarySummary,
  TaskProvisioningDiagnosticProviderFamily,
  TaskProvisioningDiagnosticStage,
  TaskProvisioningDiagnosticEvent,
} from '@cap/contracts';

/**
 * Global leaf-module token used by Guardrails and provider adapters.  Callers
 * depend on this narrow port rather than Prisma or the concrete read service.
 */
export const TASK_PROVISIONING_DIAGNOSTIC_RECORDER =
  'TASK_PROVISIONING_DIAGNOSTIC_RECORDER';

/** Stable CAP identity carried across every boundary in one processing attempt. */
export interface TaskProvisioningDiagnosticAttemptContext {
  readonly taskId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly admissionMode: TaskProvisioningDiagnosticAdmissionMode;
}

/**
 * Admission-proven retry intent. This contains only closed safe evidence; the
 * recorder derives provider/stage/cause dimensions from the committed prior
 * attempt when that evidence is available.
 */
export interface TaskProvisioningDiagnosticRetryEvidence {
  readonly stage: TaskProvisioningDiagnosticStage;
  readonly cause: TaskProvisioningDiagnosticCause;
}

/**
 * A caller may reuse only the exact active identity it already owns.  Starting
 * after an expired claim must explicitly interrupt the prior identity first;
 * silently adopting an unrelated active attempt would merge two histories.
 */
export interface BeginTaskProvisioningDiagnosticAttempt {
  readonly taskId: string;
  readonly admissionMode: TaskProvisioningDiagnosticAdmissionMode;
  /**
   * Optional admission-owned compare-and-allocate fence. Durable admission may
   * supply the exact task-local number it proved while winning running
   * capacity; legacy admission leaves allocation entirely to the recorder.
   */
  readonly expectedAttempt?: number;
  readonly providerFamily?: TaskProvisioningDiagnosticProviderFamily | null;
  readonly stage?: TaskProvisioningDiagnosticStage;
  readonly replayAttemptId?: string;
  readonly activeDisposition?: 'reject' | 'interrupt';
  readonly retry?: TaskProvisioningDiagnosticRetryEvidence;
}

/** Exact persisted identity that recovery is allowed to resume read-only. */
export interface ResumeTaskProvisioningDiagnosticAttempt {
  readonly taskId: string;
  readonly admissionMode: TaskProvisioningDiagnosticAdmissionMode;
  readonly attempt: number;
}

/**
 * Strict resume snapshot. `initialSequence` is the retained event count, so a
 * resumed emitter can allocate only the next sequence without rewriting any
 * existing evidence or advancing the task-local attempt counter.
 */
export interface ResumedTaskProvisioningDiagnosticAttempt {
  readonly context: TaskProvisioningDiagnosticAttemptContext;
  readonly state: TaskProvisioningDiagnosticAttemptState;
  readonly providerFamily: TaskProvisioningDiagnosticProviderFamily | null;
  readonly initialSequence: number;
  /**
   * Safe persisted settlement facts used to converge controllers/replicas.
   * Optionality preserves compatibility with pre-convergence recorder doubles;
   * the Prisma recorder always returns both fields.
   */
  readonly primaryPersisted?: boolean;
  readonly cleanup?: TaskProvisioningDiagnosticCleanupSummary;
}

export interface RecordTaskProvisioningDiagnosticPrimary {
  readonly state: Exclude<
    TaskProvisioningDiagnosticAttemptState,
    'active'
  >;
  readonly stage: TaskProvisioningDiagnosticStage;
  readonly primary: TaskProvisioningDiagnosticPrimarySummary;
}

export type TaskProvisioningDiagnosticRecorderFailureCode =
  | 'invalid_evidence'
  | 'task_not_found'
  | 'diagnostics_unavailable'
  | 'attempt_number_conflict'
  | 'active_attempt_conflict'
  | 'attempt_not_found'
  | 'immutable_evidence_conflict'
  | 'event_limit_reached'
  | 'attempt_limit_reached'
  | 'incomplete_evidence'
  | 'diagnostic_write_failed';

/**
 * Recorder failures are data, not provisioning control-flow exceptions.  The
 * underlying admission result remains authoritative and may continue safely.
 */
export type TaskProvisioningDiagnosticRecorderResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: TaskProvisioningDiagnosticRecorderFailureCode;
      readonly safeCause: 'diagnostic_write_failed' | 'coordination_failed';
    };

export interface AppendedTaskProvisioningDiagnosticEvent {
  readonly event: TaskProvisioningDiagnosticEvent;
  readonly replayed: boolean;
}

/**
 * Persistence-facing recorder seam.  The attempt-scoped emitter supplies one
 * fully validated CAP event identity so structured logs and the durable row use
 * the same event id/sequence/timestamp.  The store revalidates that envelope and
 * returns the canonical retained event on replay; callers never receive a
 * generic metadata/error bag.
 */
export interface TaskProvisioningDiagnosticRecorderPort {
  beginAttempt(
    input: BeginTaskProvisioningDiagnosticAttempt,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttemptContext>
  >;

  /**
   * Resume only a caller-proven task/mode/attempt tuple. This lookup is
   * read-only: it never creates or interrupts attempts and never advances the
   * task-local counter.
   */
  resumeAttempt(
    input: ResumeTaskProvisioningDiagnosticAttempt,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<ResumedTaskProvisioningDiagnosticAttempt>
  >;

  appendEvent(
    context: TaskProvisioningDiagnosticAttemptContext,
    event: unknown,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<AppendedTaskProvisioningDiagnosticEvent>
  >;

  recordPrimary(
    context: TaskProvisioningDiagnosticAttemptContext,
    input: RecordTaskProvisioningDiagnosticPrimary,
  ): Promise<TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttempt>>;

  recordCleanup(
    context: TaskProvisioningDiagnosticAttemptContext,
    cleanup: TaskProvisioningDiagnosticCleanupSummary,
  ): Promise<TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttempt>>;

  markComplete(
    context: TaskProvisioningDiagnosticAttemptContext,
  ): Promise<TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttempt>>;

  /**
   * Best-effort recovery after an earlier store failure.  It may create only a
   * caller-proven partial attempt and can never manufacture completeness.
   */
  upsertPartialAttempt(
    context: TaskProvisioningDiagnosticAttemptContext,
    input?: {
      readonly providerFamily?: TaskProvisioningDiagnosticProviderFamily | null;
      readonly stage?: TaskProvisioningDiagnosticStage;
      readonly startedAt?: Date;
    },
  ): Promise<TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttempt>>;
}
