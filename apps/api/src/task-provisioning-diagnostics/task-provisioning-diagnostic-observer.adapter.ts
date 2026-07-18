import {
  SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  createSandboxProvisioningDiagnosticEmitter,
  type SandboxProvisioningDiagnosticEmitter,
} from '@cap/sandbox';
import {
  TASK_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
  TaskProvisioningDiagnosticAdmissionModeSchema,
  TaskProvisioningDiagnosticAnomalySchema,
  TaskProvisioningDiagnosticAttemptStateSchema,
  TaskProvisioningDiagnosticCauseSchema,
  TaskProvisioningDiagnosticCommandKindSchema,
  TaskProvisioningDiagnosticCleanupSummarySchema,
  TaskProvisioningDiagnosticEventSchema,
  TaskProvisioningDiagnosticHttpStatusClassSchema,
  TaskProvisioningDiagnosticNativeStateSchema,
  TaskProvisioningDiagnosticOperationSchema,
  TaskProvisioningDiagnosticProviderFamilySchema,
  TaskProvisioningDiagnosticStageSchema,
  TaskProvisioningDiagnosticTerminalOutcomeSchema,
  type TaskProvisioningDiagnosticAttemptState,
  type TaskProvisioningDiagnosticCause,
  type TaskProvisioningDiagnosticCleanupSummary,
  type TaskProvisioningDiagnosticEvent,
  type TaskProvisioningDiagnosticProviderFamily,
  type TaskProvisioningDiagnosticStage,
} from '@cap/contracts';
import { z } from 'zod';

import {
  runWithTaskProvisioningAttemptLog,
  runWithTaskProvisioningOperationLog,
} from '../observability/log-context';
import type {
  BeginTaskProvisioningDiagnosticAttempt,
  ResumeTaskProvisioningDiagnosticAttempt,
  TaskProvisioningDiagnosticAttemptContext,
  TaskProvisioningDiagnosticRecorderPort,
} from './task-provisioning-diagnostic-recorder.port';

export const TASK_PROVISIONING_DIAGNOSTIC_OBSERVER_RECORD_ERROR =
  'task_provisioning_diagnostic_observer_record_failed' as const;

/**
 * Fixed adapter failure. Raw recorder exceptions and persistence details never
 * cross into provider or orchestration error handling.
 */
export class TaskProvisioningDiagnosticObserverRecordError extends Error {
  readonly code = TASK_PROVISIONING_DIAGNOSTIC_OBSERVER_RECORD_ERROR;

  constructor() {
    super('Task provisioning diagnostic event recording failed');
    this.name = 'TaskProvisioningDiagnosticObserverRecordError';
  }
}

export type TaskProvisioningDiagnosticObserverRecorder = Pick<
  TaskProvisioningDiagnosticRecorderPort,
  'appendEvent'
>;

export type TaskProvisioningDiagnosticObserverBeginRecorder = Pick<
  TaskProvisioningDiagnosticRecorderPort,
  | 'beginAttempt'
  | 'appendEvent'
  | 'recordPrimary'
  | 'recordCleanup'
  | 'markComplete'
>;

export type TaskProvisioningDiagnosticObserverResumeRecorder = Pick<
  TaskProvisioningDiagnosticRecorderPort,
  | 'resumeAttempt'
  | 'appendEvent'
  | 'recordPrimary'
  | 'recordCleanup'
  | 'markComplete'
>;

type TaskProvisioningDiagnosticObserverSettlementRecorder = Pick<
  TaskProvisioningDiagnosticRecorderPort,
  'appendEvent' | 'recordPrimary' | 'recordCleanup' | 'markComplete'
>;

const TaskProvisioningDiagnosticAttemptContextSchema = z
  .object({
    taskId: z.string().uuid(),
    attemptId: z.string().uuid(),
    attempt: z.number().int().positive(),
    admissionMode: TaskProvisioningDiagnosticAdmissionModeSchema,
  })
  .strict();

const ResumeTaskProvisioningDiagnosticObserverInputSchema = z
  .object({
    taskId: z.string().uuid(),
    admissionMode: TaskProvisioningDiagnosticAdmissionModeSchema,
    attempt: z.number().int().positive(),
  })
  .strict();

const TaskProvisioningDiagnosticRetryEvidenceSchema = z
  .object({
    stage: TaskProvisioningDiagnosticStageSchema,
    cause: TaskProvisioningDiagnosticCauseSchema,
  })
  .strict();

const BeginTaskProvisioningDiagnosticObserverInputSchema = z
  .object({
    taskId: z.string().uuid(),
    admissionMode: TaskProvisioningDiagnosticAdmissionModeSchema,
    expectedAttempt: z.number().int().positive().optional(),
    replayAttemptId: z.string().uuid().optional(),
    activeDisposition: z.enum(['reject', 'interrupt']).optional(),
    retry: TaskProvisioningDiagnosticRetryEvidenceSchema.optional(),
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

const ResumedTaskProvisioningDiagnosticAttemptSchema = z
  .object({
    context: TaskProvisioningDiagnosticAttemptContextSchema,
    state: TaskProvisioningDiagnosticAttemptStateSchema,
    providerFamily: TaskProvisioningDiagnosticProviderFamilySchema.nullable(),
    initialSequence: z
      .number()
      .int()
      .nonnegative()
      .max(TASK_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT),
  })
  .strict();

const TaskProvisioningDiagnosticPrimarySettlementInputSchema = z
  .object({
    state: TaskProvisioningDiagnosticAttemptStateSchema.exclude(['active']),
    stage: TaskProvisioningDiagnosticStageSchema,
    operation: TaskProvisioningDiagnosticOperationSchema,
    outcome: TaskProvisioningDiagnosticTerminalOutcomeSchema,
    cause: TaskProvisioningDiagnosticCauseSchema.nullable(),
    retryable: z.boolean(),
    exitCode: z.number().int().nullable(),
    commandKind:
      TaskProvisioningDiagnosticCommandKindSchema.nullable().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    httpStatusClass:
      TaskProvisioningDiagnosticHttpStatusClassSchema.nullable().optional(),
    nativeState:
      TaskProvisioningDiagnosticNativeStateSchema.nullable().optional(),
    anomaly: TaskProvisioningDiagnosticAnomalySchema.nullable().optional(),
    timeoutMs: z.number().int().positive().nullable().optional(),
    completion: z.enum(['mark_if_complete', 'leave_partial']),
  })
  .strict();

/**
 * Orchestration-only, secret-free projection of one controlled primary result.
 * The strict schema deliberately has no raw metadata or error bag escape hatch.
 */
export type TaskProvisioningDiagnosticPrimarySettlementInput = Readonly<
  z.infer<typeof TaskProvisioningDiagnosticPrimarySettlementInputSchema>
>;

export interface TaskProvisioningDiagnosticSettlementController {
  /** Diagnostic settlement is evidence only and never provisioning authority. */
  settlePrimary(
    input: TaskProvisioningDiagnosticPrimarySettlementInput,
  ): Promise<void>;

  /** Cleanup observations are serialized and may complete a retained primary. */
  settleCleanup(
    cleanup: TaskProvisioningDiagnosticCleanupSummary,
  ): Promise<void>;
}

interface BeginTaskProvisioningDiagnosticObserverBase {
  readonly taskId: string;
}

interface TaskProvisioningDiagnosticObserverRetryEvidence {
  readonly stage: TaskProvisioningDiagnosticStage;
  readonly cause: TaskProvisioningDiagnosticCause;
}

/** Legacy allocation is recorder-owned; durable admission may fence its number. */
export type BeginTaskProvisioningDiagnosticObserverInput =
  BeginTaskProvisioningDiagnosticObserverBase &
    (
      | {
          readonly admissionMode: 'legacy';
          readonly expectedAttempt?: never;
          readonly replayAttemptId?: string;
          readonly activeDisposition?: 'reject' | 'interrupt';
          readonly retry?: never;
        }
      | {
          readonly admissionMode: 'durable';
          readonly expectedAttempt?: number;
          readonly replayAttemptId?: string;
          readonly activeDisposition?: 'reject' | 'interrupt';
          readonly retry?: never;
        }
      | {
          readonly admissionMode: 'durable';
          readonly expectedAttempt: number;
          readonly replayAttemptId?: never;
          readonly activeDisposition: 'interrupt';
          readonly retry: TaskProvisioningDiagnosticObserverRetryEvidence;
        }
    );

/** Exact persisted attempt coordinates that recovery is allowed to resume. */
export type ResumeTaskProvisioningDiagnosticObserverInput = Readonly<
  z.infer<typeof ResumeTaskProvisioningDiagnosticObserverInputSchema>
>;

export interface BegunTaskProvisioningDiagnosticObserver {
  readonly context: TaskProvisioningDiagnosticAttemptContext;
  readonly diagnostics: SandboxProvisioningDiagnosticEmitter;
  /** Kept outside the provider-facing emitter so only orchestration may settle. */
  readonly settlement: TaskProvisioningDiagnosticSettlementController;
}

export interface ResumedTaskProvisioningDiagnosticObserver
  extends BegunTaskProvisioningDiagnosticObserver {
  /** Persisted state is exposed so recovery can choose active/terminal work. */
  readonly state: TaskProvisioningDiagnosticAttemptState;
}

type CanonicalEventObserver = (event: TaskProvisioningDiagnosticEvent) => void;

interface TaskProvisioningDiagnosticObserverInternalOptions {
  readonly observeCanonicalEvent?: CanonicalEventObserver;
  readonly initialSequence?: number;
  readonly providerFamily?: TaskProvisioningDiagnosticProviderFamily | null;
}

function createTaskProvisioningDiagnosticObserverInternal(
  context: TaskProvisioningDiagnosticAttemptContext,
  recorder: TaskProvisioningDiagnosticObserverRecorder,
  options: TaskProvisioningDiagnosticObserverInternalOptions = {},
): SandboxProvisioningDiagnosticEmitter {
  return createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      taskId: context.taskId,
      attemptId: context.attemptId,
      attempt: context.attempt,
      admissionMode: context.admissionMode,
      providerFamily: options.providerFamily ?? 'unknown',
    },
    ...(options.initialSequence === undefined
      ? {}
      : { initialSequence: options.initialSequence }),
    record: async (event) => {
      try {
        const result = await runWithTaskProvisioningAttemptLog(context, () =>
          runWithTaskProvisioningOperationLog(
            { stage: event.stage, operationId: event.operationId },
            () => recorder.appendEvent(context, event),
          ),
        );
        if (!result.ok) {
          throw new TaskProvisioningDiagnosticObserverRecordError();
        }
        const canonical = TaskProvisioningDiagnosticEventSchema.safeParse(
          result.value.event,
        );
        if (!canonical.success) {
          throw new TaskProvisioningDiagnosticObserverRecordError();
        }
        options.observeCanonicalEvent?.(canonical.data);
        return {
          kind: result.value.replayed ? 'duplicate' : 'recorded',
          sequence: canonical.data.sequence,
        };
      } catch {
        throw new TaskProvisioningDiagnosticObserverRecordError();
      }
    },
  });
}

/**
 * Adapt one successful provisioning attempt identity to sandbox-core's pure emitter.
 * Provider family starts unknown and may be bound exactly once after selection.
 */
export function createTaskProvisioningDiagnosticObserver(
  context: TaskProvisioningDiagnosticAttemptContext,
  recorder: TaskProvisioningDiagnosticObserverRecorder,
): SandboxProvisioningDiagnosticEmitter {
  return createTaskProvisioningDiagnosticObserverInternal(context, recorder);
}

function createTaskProvisioningDiagnosticSettlementController(
  context: TaskProvisioningDiagnosticAttemptContext,
  diagnostics: SandboxProvisioningDiagnosticEmitter,
  recorder: TaskProvisioningDiagnosticObserverSettlementRecorder,
  canonicalTerminalEvents: ReadonlyMap<string, TaskProvisioningDiagnosticEvent>,
  options: { readonly primaryPersisted?: boolean } = {},
): TaskProvisioningDiagnosticSettlementController {
  type ParsedPrimary = z.infer<
    typeof TaskProvisioningDiagnosticPrimarySettlementInputSchema
  >;

  const notRequiredCleanup: TaskProvisioningDiagnosticCleanupSummary = {
    state: 'not_required',
    cause: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    observedAt: null,
  };
  let selectedPrimary: ParsedPrimary | undefined;
  let primaryOperationId: string | undefined;
  let primaryPersisted = options.primaryPersisted ?? false;
  let primaryInFlight: Promise<void> | undefined;
  let cleanupTail: Promise<void> = Promise.resolve();
  let persistedCleanup: TaskProvisioningDiagnosticCleanupSummary | undefined;
  const cleanupInFlight = new Map<string, Promise<void>>();
  let completionMarked = false;
  let finalizeInFlight: Promise<void> | undefined;

  const maybeFinalize = (): Promise<void> => {
    if (
      !primaryPersisted ||
      persistedCleanup === undefined ||
      persistedCleanup.state === 'pending' ||
      completionMarked
    ) {
      return Promise.resolve();
    }
    if (finalizeInFlight) return finalizeInFlight;

    const running = runWithTaskProvisioningAttemptLog(context, async () => {
      try {
        // Include every provider fact accepted before this completeness fence.
        await diagnostics.flush();
        const result = await recorder.markComplete(context);
        if (result.ok) completionMarked = true;
      } catch {
        // A later exact cleanup or primary replay may retry finalization.
      }
    });
    finalizeInFlight = running;
    void running.finally(() => {
      if (finalizeInFlight === running) finalizeInFlight = undefined;
    });
    return running;
  };

  const persistCleanup = async (
    cleanup: TaskProvisioningDiagnosticCleanupSummary,
  ): Promise<void> => {
    if (sameCleanupSummary(persistedCleanup, cleanup)) {
      await maybeFinalize();
      return;
    }

    try {
      await runWithTaskProvisioningAttemptLog(context, async () => {
        const result = await recorder.recordCleanup(context, cleanup);
        if (!result.ok) return;
        persistedCleanup = cleanup;
        await maybeFinalize();
      });
    } catch {
      // Failed cleanup persistence stays retryable on the next exact call.
    }
  };

  const settleCleanup = (
    cleanup: TaskProvisioningDiagnosticCleanupSummary,
  ): Promise<void> => {
    const parsed =
      TaskProvisioningDiagnosticCleanupSummarySchema.safeParse(cleanup);
    if (!parsed.success) return Promise.resolve();

    const fingerprint = cleanupSummaryFingerprint(parsed.data);
    const joined = cleanupInFlight.get(fingerprint);
    if (joined) return joined;

    // Claim this fingerprint and append to the serialization tail before any
    // await so concurrent pending/terminal observations cannot overtake.
    const running = cleanupTail.then(() => persistCleanup(parsed.data));
    cleanupTail = running.catch(() => undefined);
    cleanupInFlight.set(fingerprint, running);
    void running.finally(() => {
      if (cleanupInFlight.get(fingerprint) === running) {
        cleanupInFlight.delete(fingerprint);
      }
    });
    return running;
  };

  const persistPrimary = async (primary: ParsedPrimary): Promise<void> => {
    if (!primaryPersisted) {
      // Drain provider facts first. When the provider already emitted the exact
      // semantic terminal, reuse it instead of fabricating another pair.
      await diagnostics.flush();
      let canonicalTerminal = findCanonicalPrimaryTerminal(
        canonicalTerminalEvents,
        primary,
      );

      if (!canonicalTerminal) {
        primaryOperationId ??= diagnostics.createOperationId();
        const common = {
          operationId: primaryOperationId,
          stage: primary.stage,
          operation: primary.operation,
          channel: 'primary' as const,
          ...(primary.commandKind === undefined
            ? {}
            : { commandKind: primary.commandKind }),
        };

        await diagnostics.emit({ ...common, outcome: 'started' });
        await diagnostics.emit({
          ...common,
          outcome: primary.outcome,
          cause: primary.cause,
          retryable: primary.retryable,
          exitCode: primary.exitCode,
          ...(primary.durationMs === undefined
            ? {}
            : { durationMs: primary.durationMs }),
          ...(primary.httpStatusClass === undefined
            ? {}
            : { httpStatusClass: primary.httpStatusClass }),
          ...(primary.nativeState === undefined
            ? {}
            : { nativeState: primary.nativeState }),
          ...(primary.anomaly === undefined
            ? {}
            : { anomaly: primary.anomaly }),
          ...(primary.timeoutMs === undefined
            ? {}
            : { timeoutMs: primary.timeoutMs }),
        });
        await diagnostics.flush();
        canonicalTerminal = canonicalTerminalEvents.get(primaryOperationId);
      }

      if (!canonicalTerminal || canonicalTerminal.outcome === 'started') return;
      const result = await recorder.recordPrimary(context, {
        state: primary.state,
        stage: canonicalTerminal.stage,
        primary: {
          outcome: canonicalTerminal.outcome,
          cause: canonicalTerminal.cause,
          retryable: canonicalTerminal.retryable,
          exitCode: canonicalTerminal.exitCode ?? null,
          observedAt: canonicalTerminal.observedAt,
        },
      });
      if (!result.ok) return;
      primaryPersisted = true;
    }

    if (
      primary.completion === 'mark_if_complete' &&
      persistedCleanup === undefined
    ) {
      await settleCleanup(notRequiredCleanup);
      return;
    }
    await maybeFinalize();
  };

  const settlePrimary = (
    input: TaskProvisioningDiagnosticPrimarySettlementInput,
  ): Promise<void> => {
    const parsed =
      TaskProvisioningDiagnosticPrimarySettlementInputSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve();

    // The first valid primary owns the semantic result for this controller.
    // Later callers join/retry that same input and cannot replace its content.
    selectedPrimary ??= parsed.data;
    if (primaryInFlight) return primaryInFlight;

    const running = runWithTaskProvisioningAttemptLog(context, () =>
      persistPrimary(selectedPrimary as ParsedPrimary),
    ).catch(() => undefined);
    primaryInFlight = running;
    void running.finally(() => {
      if (primaryInFlight === running) primaryInFlight = undefined;
    });
    return running;
  };

  return Object.freeze({ settlePrimary, settleCleanup });
}

function sameCleanupSummary(
  left: TaskProvisioningDiagnosticCleanupSummary | undefined,
  right: TaskProvisioningDiagnosticCleanupSummary,
): boolean {
  return (
    left !== undefined &&
    left.state === right.state &&
    left.cause === right.cause &&
    left.attemptCount === right.attemptCount &&
    left.lastAttemptOutcome === right.lastAttemptOutcome &&
    (left.observedAt?.getTime() ?? null) ===
      (right.observedAt?.getTime() ?? null)
  );
}

function cleanupSummaryFingerprint(
  cleanup: TaskProvisioningDiagnosticCleanupSummary,
): string {
  return JSON.stringify({
    ...cleanup,
    observedAt: cleanup.observedAt?.toISOString() ?? null,
  });
}

function createOrchestrationTaskProvisioningDiagnosticObserver(
  context: TaskProvisioningDiagnosticAttemptContext,
  recorder: TaskProvisioningDiagnosticObserverSettlementRecorder,
  options: Pick<
    TaskProvisioningDiagnosticObserverInternalOptions,
    'initialSequence' | 'providerFamily'
  > & { readonly primaryPersisted?: boolean } = {},
): BegunTaskProvisioningDiagnosticObserver {
  const { primaryPersisted, ...emitterOptions } = options;
  const canonicalTerminalEvents = new Map<
    string,
    TaskProvisioningDiagnosticEvent
  >();
  const diagnostics = createTaskProvisioningDiagnosticObserverInternal(
    context,
    recorder,
    {
      ...emitterOptions,
      observeCanonicalEvent: (event) => {
        if (event.outcome !== 'started') {
          canonicalTerminalEvents.set(event.operationId, event);
        }
      },
    },
  );
  return Object.freeze({
    context,
    diagnostics,
    settlement: createTaskProvisioningDiagnosticSettlementController(
      context,
      diagnostics,
      recorder,
      canonicalTerminalEvents,
      { primaryPersisted },
    ),
  });
}

function findCanonicalPrimaryTerminal(
  canonicalTerminalEvents: ReadonlyMap<string, TaskProvisioningDiagnosticEvent>,
  input: z.infer<typeof TaskProvisioningDiagnosticPrimarySettlementInputSchema>,
): TaskProvisioningDiagnosticEvent | undefined {
  const events = [...canonicalTerminalEvents.values()];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.channel === 'primary' &&
      event.stage === input.stage &&
      event.operation === input.operation &&
      (input.commandKind === undefined ||
        event.commandKind === input.commandKind)
    ) {
      return event.outcome === input.outcome ? event : undefined;
    }
  }
  return undefined;
}

/**
 * Best-effort begin boundary used after admission has won running capacity.
 * Deployment gating and recorder selection stay with the caller. Diagnostic
 * unavailability never blocks provider processing.
 */
export async function tryBeginTaskProvisioningDiagnosticObserver(
  recorder: TaskProvisioningDiagnosticObserverBeginRecorder,
  input: BeginTaskProvisioningDiagnosticObserverInput,
): Promise<BegunTaskProvisioningDiagnosticObserver | undefined> {
  const parsedInput =
    BeginTaskProvisioningDiagnosticObserverInputSchema.safeParse(input);
  if (!parsedInput.success) return undefined;

  const beginInput: BeginTaskProvisioningDiagnosticAttempt = {
    taskId: parsedInput.data.taskId,
    admissionMode: parsedInput.data.admissionMode,
    providerFamily: 'unknown',
    stage: 'provider_selection',
    ...(parsedInput.data.replayAttemptId === undefined
      ? {}
      : { replayAttemptId: parsedInput.data.replayAttemptId }),
    ...(parsedInput.data.activeDisposition === undefined
      ? {}
      : { activeDisposition: parsedInput.data.activeDisposition }),
    ...(parsedInput.data.admissionMode === 'durable' &&
    parsedInput.data.expectedAttempt !== undefined
      ? { expectedAttempt: parsedInput.data.expectedAttempt }
      : {}),
    ...(parsedInput.data.retry === undefined
      ? {}
      : { retry: parsedInput.data.retry }),
  };

  try {
    const result = await recorder.beginAttempt(beginInput);
    if (!result.ok) return undefined;
    return createOrchestrationTaskProvisioningDiagnosticObserver(
      result.value,
      recorder,
    );
  } catch {
    return undefined;
  }
}

/**
 * Best-effort read-only recovery boundary. It resumes only the exact persisted
 * task/mode/attempt tuple and never allocates, interrupts, or advances an
 * attempt. Diagnostic recovery remains non-authoritative and non-blocking.
 */
export async function tryResumeTaskProvisioningDiagnosticObserver(
  recorder: TaskProvisioningDiagnosticObserverResumeRecorder,
  input: ResumeTaskProvisioningDiagnosticObserverInput,
): Promise<ResumedTaskProvisioningDiagnosticObserver | undefined> {
  const parsedInput =
    ResumeTaskProvisioningDiagnosticObserverInputSchema.safeParse(input);
  if (!parsedInput.success) return undefined;

  const resumeInput: ResumeTaskProvisioningDiagnosticAttempt = parsedInput.data;
  try {
    const result = await recorder.resumeAttempt(resumeInput);
    if (!result.ok) return undefined;

    const parsedResume =
      ResumedTaskProvisioningDiagnosticAttemptSchema.safeParse(result.value);
    if (!parsedResume.success) return undefined;
    const resumed = parsedResume.data;
    if (
      resumed.context.taskId !== resumeInput.taskId ||
      resumed.context.admissionMode !== resumeInput.admissionMode ||
      resumed.context.attempt !== resumeInput.attempt
    ) {
      return undefined;
    }

    const observer = createOrchestrationTaskProvisioningDiagnosticObserver(
      resumed.context,
      recorder,
      {
        providerFamily: resumed.providerFamily,
        initialSequence: resumed.initialSequence,
        primaryPersisted: resumed.state !== 'active',
      },
    );
    return Object.freeze({ ...observer, state: resumed.state });
  } catch {
    return undefined;
  }
}
