import { z } from 'zod';

import {
  TaskProvisioningStageSchema,
  TaskProvisioningStateSchema,
} from './task.js';

/** Current durable/wire version for provisioning diagnostic evidence. */
export const TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

/** Bounded storage and public pagination limits shared by every projection. */
export const TASK_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT = 64 as const;
export const TASK_PROVISIONING_DIAGNOSTIC_MAX_DETAILED_ATTEMPTS = 8 as const;
export const TASK_PROVISIONING_DIAGNOSTIC_DEFAULT_PAGE_SIZE = 50 as const;
export const TASK_PROVISIONING_DIAGNOSTIC_MAX_PAGE_SIZE = 200 as const;
export const TASK_PROVISIONING_DIAGNOSTIC_SAFE_TEXT_MAX_LENGTH = 160 as const;

const SafeDiagnosticTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(TASK_PROVISIONING_DIAGNOSTIC_SAFE_TEXT_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);

/** Whether detailed evidence is expected and how completely it was retained. */
export const TaskProvisioningDiagnosticCoverageSchema = z.enum([
  'not_started',
  'partial',
  'complete',
  'unavailable',
]);
export type TaskProvisioningDiagnosticCoverage = z.infer<
  typeof TaskProvisioningDiagnosticCoverageSchema
>;

export const TaskProvisioningDiagnosticAdmissionModeSchema = z.enum([
  'legacy',
  'durable',
]);
export type TaskProvisioningDiagnosticAdmissionMode = z.infer<
  typeof TaskProvisioningDiagnosticAdmissionModeSchema
>;

export const TaskProvisioningDiagnosticProviderFamilySchema = z.enum([
  'aio',
  'cloud-http',
  'boxlite',
  'unknown',
]);
export type TaskProvisioningDiagnosticProviderFamily = z.infer<
  typeof TaskProvisioningDiagnosticProviderFamilySchema
>;

export const TaskProvisioningDiagnosticAttemptStateSchema = z.enum([
  'active',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TaskProvisioningDiagnosticAttemptState = z.infer<
  typeof TaskProvisioningDiagnosticAttemptStateSchema
>;

export const TaskProvisioningDiagnosticStageSchema = z.enum([
  ...TaskProvisioningStageSchema.options,
  'provider_selection',
  'sandbox_start',
  'sandbox_inspect',
  'native_execution',
  'settlement',
  'cleanup',
]);
export type TaskProvisioningDiagnosticStage = z.infer<
  typeof TaskProvisioningDiagnosticStageSchema
>;

export const TaskProvisioningDiagnosticOperationSchema = z.enum([
  'provider_select',
  'sandbox_create',
  'sandbox_start',
  'sandbox_inspect',
  'workspace_materialize',
  'credential_setup',
  'remote_ref_resolve',
  'repository_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_preflight',
  'runtime_setup',
  'native_exec_start',
  'native_exec_poll',
  'native_exec_attach',
  'native_exec_settlement',
  'agent_launch',
  'sandbox_delete',
  'sandbox_absence_confirm',
]);
export type TaskProvisioningDiagnosticOperation = z.infer<
  typeof TaskProvisioningDiagnosticOperationSchema
>;

/** Separates the controlled primary flow from physical cleanup and authority. */
export const TaskProvisioningDiagnosticChannelSchema = z.enum([
  'primary',
  'cleanup',
  'coordination',
]);
export type TaskProvisioningDiagnosticChannel = z.infer<
  typeof TaskProvisioningDiagnosticChannelSchema
>;

export const TaskProvisioningDiagnosticOutcomeSchema = z.enum([
  'started',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'degraded',
  'indeterminate',
]);
export type TaskProvisioningDiagnosticOutcome = z.infer<
  typeof TaskProvisioningDiagnosticOutcomeSchema
>;

export const TaskProvisioningDiagnosticTerminalOutcomeSchema = z.enum([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'degraded',
  'indeterminate',
]);
export type TaskProvisioningDiagnosticTerminalOutcome = z.infer<
  typeof TaskProvisioningDiagnosticTerminalOutcomeSchema
>;

/** Stable, provider-neutral causes. Human copy is derived at the read/UI edge. */
export const TaskProvisioningDiagnosticCauseSchema = z.enum([
  'capacity_exhausted',
  'authentication_failed',
  'access_denied',
  'tls_network_failed',
  'ref_not_found',
  'workspace_timeout',
  'transport_failed',
  'protocol_failed',
  'provider_unavailable',
  'settlement_unknown',
  'missing_exit_code',
  'command_failed',
  'cancelled',
  'superseded',
  'cleanup_failed',
  'cleanup_unconfirmed',
  'coordination_failed',
  'diagnostic_write_failed',
  'unknown',
]);
export type TaskProvisioningDiagnosticCause = z.infer<
  typeof TaskProvisioningDiagnosticCauseSchema
>;

/** Declared setup action identity; command text is never parsed to derive it. */
export const TaskProvisioningDiagnosticCommandKindSchema = z.enum([
  'git_remote_ref',
  'git_clone',
  'git_checkout',
  'git_submodules',
  'credential_setup',
  'credential_cleanup',
  'runtime_preflight',
  'runtime_setup',
  'agent_launch',
  'sandbox_cleanup',
]);
export type TaskProvisioningDiagnosticCommandKind = z.infer<
  typeof TaskProvisioningDiagnosticCommandKindSchema
>;

export const TaskProvisioningDiagnosticNativeStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
  'timed_out',
  'unknown',
]);

/** Low-cardinality native settlement anomalies; never provider prose. */
export const TaskProvisioningDiagnosticAnomalySchema = z.enum([
  'missing_exit_code',
  'invalid_poll_settlement',
  'poll_timeout',
  'poll_transport_failure',
  'attach_degraded',
]);
export type TaskProvisioningDiagnosticAnomaly = z.infer<
  typeof TaskProvisioningDiagnosticAnomalySchema
>;

export const TaskProvisioningDiagnosticHttpStatusClassSchema = z.enum([
  '1xx',
  '2xx',
  '3xx',
  '4xx',
  '5xx',
]);

export const TaskProvisioningDiagnosticCleanupStateSchema = z.enum([
  'not_required',
  'pending',
  'succeeded',
  'failed',
]);
export type TaskProvisioningDiagnosticCleanupState = z.infer<
  typeof TaskProvisioningDiagnosticCleanupStateSchema
>;

const DiagnosticEventIdentityFields = {
  schemaVersion: z.literal(TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION),
  eventId: z.string().uuid(),
  idempotencyKey: SafeDiagnosticTextSchema,
  taskId: z.string().uuid(),
  attemptId: z.string().uuid(),
  attempt: z.number().int().positive(),
  sequence: z
    .number()
    .int()
    .positive()
    .max(TASK_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT),
  operationId: z.string().uuid(),
  admissionMode: TaskProvisioningDiagnosticAdmissionModeSchema,
  providerFamily: TaskProvisioningDiagnosticProviderFamilySchema,
  stage: TaskProvisioningDiagnosticStageSchema,
  operation: TaskProvisioningDiagnosticOperationSchema,
  channel: TaskProvisioningDiagnosticChannelSchema,
  commandKind: TaskProvisioningDiagnosticCommandKindSchema.nullable().optional(),
  observedAt: z.coerce.date(),
} as const;

const DiagnosticTerminalFactFields = {
  durationMs: z.number().int().nonnegative().optional(),
  cause: TaskProvisioningDiagnosticCauseSchema.nullable(),
  retryable: z.boolean(),
  httpStatusClass:
    TaskProvisioningDiagnosticHttpStatusClassSchema.nullable().optional(),
  nativeState: TaskProvisioningDiagnosticNativeStateSchema.nullable().optional(),
  anomaly: TaskProvisioningDiagnosticAnomalySchema.nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
} as const;

export const TaskProvisioningDiagnosticStartedEventSchema = z
  .object({
    ...DiagnosticEventIdentityFields,
    outcome: z.literal('started'),
  })
  .strict();

const terminalEvent = <T extends TaskProvisioningDiagnosticTerminalOutcome>(
  outcome: T,
) =>
  z
    .object({
      ...DiagnosticEventIdentityFields,
      ...DiagnosticTerminalFactFields,
      outcome: z.literal(outcome),
    })
    .strict();

export const TaskProvisioningDiagnosticSucceededEventSchema = terminalEvent(
  'succeeded',
);
export const TaskProvisioningDiagnosticFailedEventSchema = terminalEvent(
  'failed',
);
export const TaskProvisioningDiagnosticTimedOutEventSchema = terminalEvent(
  'timed_out',
);
export const TaskProvisioningDiagnosticCancelledEventSchema = terminalEvent(
  'cancelled',
);
export const TaskProvisioningDiagnosticDegradedEventSchema = terminalEvent(
  'degraded',
);
export const TaskProvisioningDiagnosticIndeterminateEventSchema = terminalEvent(
  'indeterminate',
);

export const TaskProvisioningDiagnosticEventSchema = z.discriminatedUnion(
  'outcome',
  [
    TaskProvisioningDiagnosticStartedEventSchema,
    TaskProvisioningDiagnosticSucceededEventSchema,
    TaskProvisioningDiagnosticFailedEventSchema,
    TaskProvisioningDiagnosticTimedOutEventSchema,
    TaskProvisioningDiagnosticCancelledEventSchema,
    TaskProvisioningDiagnosticDegradedEventSchema,
    TaskProvisioningDiagnosticIndeterminateEventSchema,
  ],
);
export type TaskProvisioningDiagnosticEvent = z.infer<
  typeof TaskProvisioningDiagnosticEventSchema
>;

export const TaskProvisioningDiagnosticPrimarySummarySchema = z
  .object({
    outcome: TaskProvisioningDiagnosticTerminalOutcomeSchema,
    cause: TaskProvisioningDiagnosticCauseSchema.nullable(),
    retryable: z.boolean(),
    exitCode: z.number().int().nullable(),
    observedAt: z.coerce.date(),
  })
  .strict();
export type TaskProvisioningDiagnosticPrimarySummary = z.infer<
  typeof TaskProvisioningDiagnosticPrimarySummarySchema
>;

export const TaskProvisioningDiagnosticCleanupSummarySchema = z
  .object({
    state: TaskProvisioningDiagnosticCleanupStateSchema,
    cause: TaskProvisioningDiagnosticCauseSchema.nullable(),
    attemptCount: z.number().int().nonnegative(),
    lastAttemptOutcome:
      TaskProvisioningDiagnosticTerminalOutcomeSchema.nullable(),
    observedAt: z.coerce.date().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message,
      });
    if (
      value.state === 'not_required' &&
      (value.attemptCount !== 0 ||
        value.cause !== null ||
        value.lastAttemptOutcome !== null ||
        value.observedAt !== null)
    ) {
      issue('state', 'Cleanup that is not required cannot carry attempt evidence');
    }
    if (
      value.state === 'pending' &&
      ((value.attemptCount === 0 &&
        (value.lastAttemptOutcome !== null || value.observedAt !== null)) ||
        (value.attemptCount > 0 &&
          (value.lastAttemptOutcome === null || value.observedAt === null)))
    ) {
      issue('attemptCount', 'Pending cleanup evidence must be internally paired');
    }
    if (
      value.state === 'succeeded' &&
      (value.attemptCount < 1 ||
        value.cause !== null ||
        value.lastAttemptOutcome !== 'succeeded' ||
        value.observedAt === null)
    ) {
      issue('state', 'Successful cleanup requires one confirmed successful attempt');
    }
    if (
      value.state === 'failed' &&
      (value.attemptCount < 1 ||
        value.cause === null ||
        value.lastAttemptOutcome === null ||
        value.observedAt === null)
    ) {
      issue('state', 'Failed cleanup requires bounded terminal evidence');
    }
  });
export type TaskProvisioningDiagnosticCleanupSummary = z.infer<
  typeof TaskProvisioningDiagnosticCleanupSummarySchema
>;

export const TaskProvisioningDiagnosticAttemptSchema = z
  .object({
    schemaVersion: z.literal(TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION),
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    attempt: z.number().int().positive(),
    admissionMode: TaskProvisioningDiagnosticAdmissionModeSchema,
    providerFamily:
      TaskProvisioningDiagnosticProviderFamilySchema.nullable(),
    state: TaskProvisioningDiagnosticAttemptStateSchema,
    stage: TaskProvisioningDiagnosticStageSchema,
    coverage: TaskProvisioningDiagnosticCoverageSchema,
    primary: TaskProvisioningDiagnosticPrimarySummarySchema.nullable(),
    cleanup: TaskProvisioningDiagnosticCleanupSummarySchema,
    eventCount: z
      .number()
      .int()
      .nonnegative()
      .max(TASK_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT),
    truncated: z.boolean(),
    startedAt: z.coerce.date(),
    finishedAt: z.coerce.date().nullable(),
    completenessMarkedAt: z.coerce.date().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'active' && value.finishedAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finishedAt'],
        message: 'An active diagnostic attempt cannot have a finish time',
      });
    }
    if (value.state === 'active' && value.primary !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['primary'],
        message: 'An active diagnostic attempt cannot carry a terminal primary',
      });
    }
    if (
      value.state !== 'active' &&
      (value.primary === null || value.finishedAt === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['primary'],
        message: 'A terminal diagnostic attempt requires primary evidence and finish time',
      });
    }
    if (value.primary !== null) {
      const compatible =
        (value.state === 'succeeded' &&
          (value.primary.outcome === 'succeeded' ||
            value.primary.outcome === 'degraded')) ||
        (value.state === 'failed' &&
          (value.primary.outcome === 'failed' ||
            value.primary.outcome === 'timed_out' ||
            value.primary.outcome === 'indeterminate')) ||
        (value.state === 'cancelled' &&
          value.primary.outcome === 'cancelled') ||
        (value.state === 'interrupted' &&
          value.primary.outcome === 'indeterminate');
      if (!compatible) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['primary', 'outcome'],
          message: 'Attempt state and primary outcome are inconsistent',
        });
      }
    }
    if (value.cleanup.state === 'pending' && value.completenessMarkedAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completenessMarkedAt'],
        message: 'Cleanup-pending evidence cannot be marked complete',
      });
    }
    if (
      (value.coverage === 'complete') !==
      (value.completenessMarkedAt !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coverage'],
        message: 'Complete coverage requires its explicit durable marker',
      });
    }
  });
export type TaskProvisioningDiagnosticAttempt = z.infer<
  typeof TaskProvisioningDiagnosticAttemptSchema
>;

const PrimaryOutcomeCountsSchema = z
  .object({
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    timedOut: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    indeterminate: z.number().int().nonnegative(),
  })
  .strict();

const CleanupStateCountsSchema = z
  .object({
    notRequired: z.number().int().nonnegative(),
    pending: z.literal(0),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();

export const TaskProvisioningDiagnosticCompactionSummarySchema = z
  .object({
    compactedAttemptFrom: z.number().int().positive(),
    compactedAttemptTo: z.number().int().positive(),
    compactedAttemptCount: z.number().int().positive(),
    compactedEventCount: z.number().int().nonnegative(),
    truncationCount: z.number().int().positive(),
    primaryOutcomeCounts: PrimaryOutcomeCountsSchema,
    cleanupStateCounts: CleanupStateCountsSchema,
    compactedAt: z.coerce.date(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.compactedAttemptFrom > value.compactedAttemptTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['compactedAttemptTo'],
        message: 'Compacted attempt range must be ordered',
      });
    }
    const primaryCount = Object.values(value.primaryOutcomeCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    const cleanupCount = Object.values(value.cleanupStateCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (
      primaryCount !== value.compactedAttemptCount ||
      cleanupCount !== value.compactedAttemptCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['compactedAttemptCount'],
        message: 'Compaction outcome counts must equal the compacted attempt count',
      });
    }
  });
export type TaskProvisioningDiagnosticCompactionSummary = z.infer<
  typeof TaskProvisioningDiagnosticCompactionSummarySchema
>;

export const TaskProvisioningDiagnosticExpectationSchema = z
  .object({
    schemaVersion: z.literal(TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION),
    nextAttempt: z.number().int().positive(),
  })
  .strict();
export type TaskProvisioningDiagnosticExpectation = z.infer<
  typeof TaskProvisioningDiagnosticExpectationSchema
>;

export const TaskProvisioningDiagnosticsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(TASK_PROVISIONING_DIAGNOSTIC_MAX_PAGE_SIZE)
      .default(TASK_PROVISIONING_DIAGNOSTIC_DEFAULT_PAGE_SIZE),
    cursor: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict();
export type TaskProvisioningDiagnosticsQuery = z.infer<
  typeof TaskProvisioningDiagnosticsQuerySchema
>;

export const TaskProvisioningDiagnosticsResponseSchema = z
  .object({
    schemaVersion: z.literal(TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION),
    taskId: z.string().uuid(),
    coverage: TaskProvisioningDiagnosticCoverageSchema,
    admissionState: TaskProvisioningStateSchema.nullable(),
    attempts: z
      .array(TaskProvisioningDiagnosticAttemptSchema)
      .max(TASK_PROVISIONING_DIAGNOSTIC_MAX_DETAILED_ATTEMPTS),
    events: z
      .array(TaskProvisioningDiagnosticEventSchema)
      .max(TASK_PROVISIONING_DIAGNOSTIC_MAX_PAGE_SIZE),
    compaction: TaskProvisioningDiagnosticCompactionSummarySchema.nullable(),
    nextCursor: z.string().trim().min(1).max(2_048).nullable(),
  })
  .strict();
export type TaskProvisioningDiagnosticsResponse = z.infer<
  typeof TaskProvisioningDiagnosticsResponseSchema
>;

/**
 * Canonical, JSON-wire examples shared by the operation registry, generated
 * OpenAPI, and API Playground. Values stay as JSON timestamps here; the same
 * response schema validates and coerces them at every runtime boundary.
 */
export const TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES = Object.freeze({
  notStarted: {
    summary: 'Accepted work is queued but has not opened a processing attempt.',
    value: {
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      taskId: '00000000-0000-4000-8000-000000000101',
      coverage: 'not_started',
      admissionState: 'queued',
      attempts: [],
      events: [],
      compaction: null,
      nextCursor: null,
    },
  },
  partialPrimaryAndCleanup: {
    summary:
      'Partial retained evidence keeps the primary command failure separate from cleanup failure.',
    value: {
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      taskId: '00000000-0000-4000-8000-000000000102',
      coverage: 'partial',
      admissionState: 'failed',
      attempts: [
        {
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          id: '00000000-0000-4000-8000-000000000201',
          taskId: '00000000-0000-4000-8000-000000000102',
          attempt: 1,
          admissionMode: 'durable',
          providerFamily: 'boxlite',
          state: 'failed',
          stage: 'runtime_setup',
          coverage: 'partial',
          primary: {
            outcome: 'failed',
            cause: 'command_failed',
            retryable: false,
            exitCode: 17,
            observedAt: '2026-07-18T01:02:03.400Z',
          },
          cleanup: {
            state: 'failed',
            cause: 'cleanup_failed',
            attemptCount: 1,
            lastAttemptOutcome: 'failed',
            observedAt: '2026-07-18T01:02:04.600Z',
          },
          eventCount: 5,
          truncated: false,
          startedAt: '2026-07-18T01:02:03.000Z',
          finishedAt: '2026-07-18T01:02:03.400Z',
          completenessMarkedAt: null,
        },
      ],
      events: [
        {
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          eventId: '00000000-0000-4000-8000-000000000301',
          idempotencyKey: 'example:primary:start',
          taskId: '00000000-0000-4000-8000-000000000102',
          attemptId: '00000000-0000-4000-8000-000000000201',
          attempt: 1,
          sequence: 1,
          operationId: '00000000-0000-4000-8000-000000000401',
          admissionMode: 'durable',
          providerFamily: 'boxlite',
          stage: 'runtime_setup',
          operation: 'runtime_setup',
          channel: 'primary',
          commandKind: 'runtime_setup',
          observedAt: '2026-07-18T01:02:03.000Z',
          outcome: 'started',
        },
        {
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          eventId: '00000000-0000-4000-8000-000000000302',
          idempotencyKey: 'example:primary:terminal',
          taskId: '00000000-0000-4000-8000-000000000102',
          attemptId: '00000000-0000-4000-8000-000000000201',
          attempt: 1,
          sequence: 2,
          operationId: '00000000-0000-4000-8000-000000000401',
          admissionMode: 'durable',
          providerFamily: 'boxlite',
          stage: 'runtime_setup',
          operation: 'runtime_setup',
          channel: 'primary',
          commandKind: 'runtime_setup',
          observedAt: '2026-07-18T01:02:03.400Z',
          outcome: 'failed',
          durationMs: 400,
          cause: 'command_failed',
          retryable: false,
          nativeState: 'failed',
          anomaly: null,
          exitCode: 17,
        },
        {
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          eventId: '00000000-0000-4000-8000-000000000303',
          idempotencyKey: 'example:cleanup:start',
          taskId: '00000000-0000-4000-8000-000000000102',
          attemptId: '00000000-0000-4000-8000-000000000201',
          attempt: 1,
          sequence: 3,
          operationId: '00000000-0000-4000-8000-000000000402',
          admissionMode: 'durable',
          providerFamily: 'boxlite',
          stage: 'cleanup',
          operation: 'sandbox_delete',
          channel: 'cleanup',
          commandKind: 'sandbox_cleanup',
          observedAt: '2026-07-18T01:02:04.000Z',
          outcome: 'started',
        },
        {
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          eventId: '00000000-0000-4000-8000-000000000304',
          idempotencyKey: 'example:cleanup:terminal',
          taskId: '00000000-0000-4000-8000-000000000102',
          attemptId: '00000000-0000-4000-8000-000000000201',
          attempt: 1,
          sequence: 4,
          operationId: '00000000-0000-4000-8000-000000000402',
          admissionMode: 'durable',
          providerFamily: 'boxlite',
          stage: 'cleanup',
          operation: 'sandbox_delete',
          channel: 'cleanup',
          commandKind: 'sandbox_cleanup',
          observedAt: '2026-07-18T01:02:04.600Z',
          outcome: 'failed',
          durationMs: 600,
          cause: 'cleanup_failed',
          retryable: true,
        },
      ],
      compaction: null,
      nextCursor:
        'eyJ2ZXJzaW9uIjoxLCJvYnNlcnZlZEF0IjoiMjAyNi0wNy0xOFQwMTowMjowNC42MDBaIiwiZXZlbnRJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDMwNCJ9',
    },
  },
  historicalUnavailable: {
    summary: 'A historical task predates the diagnostic expectation and ledger.',
    value: {
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      taskId: '00000000-0000-4000-8000-000000000103',
      coverage: 'unavailable',
      admissionState: null,
      attempts: [],
      events: [],
      compaction: null,
      nextCursor: null,
    },
  },
} as const);
