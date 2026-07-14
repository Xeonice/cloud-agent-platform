import { z } from 'zod';
import { RuntimeModelCatalogUnavailableErrorSchema } from './runtime-model.js';

/** Deployment-wide capability required before any explicit-model write is accepted. */
export const TASK_MODEL_SELECTION_CAPABILITY =
  'task-model-selection-v1' as const;
export const TaskModelSelectionCapabilitySchema = z.literal(
  TASK_MODEL_SELECTION_CAPABILITY,
);

export const TaskModelSelectionWorkerRoleSchema = z.enum([
  'api',
  'admission',
  'scheduler',
  'runtime',
]);
export type TaskModelSelectionWorkerRole = z.infer<
  typeof TaskModelSelectionWorkerRoleSchema
>;

const SafeCapabilityTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:@/+-]+$/u);

/**
 * One process-local report. It is evidence about one worker only and is never,
 * by itself, proof that every deployment replica is model-aware.
 */
export const TaskModelSelectionLocalRoleReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: SafeCapabilityTextSchema,
    role: TaskModelSelectionWorkerRoleSchema,
    buildIdentity: SafeCapabilityTextSchema,
    capabilities: z.array(SafeCapabilityTextSchema).max(64),
    ready: z.boolean(),
    reportedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type TaskModelSelectionLocalRoleReport = z.infer<
  typeof TaskModelSelectionLocalRoleReportSchema
>;

export const TaskModelSelectionExpectedWorkerSchema = z
  .object({
    instanceId: SafeCapabilityTextSchema,
    roles: z.array(TaskModelSelectionWorkerRoleSchema).min(1).max(4),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.roles).size !== value.roles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles'],
        message: 'Expected worker roles must be unique',
      });
    }
  });
export type TaskModelSelectionExpectedWorker = z.infer<
  typeof TaskModelSelectionExpectedWorkerSchema
>;

/**
 * Orchestrator/operator attestation for the complete N-worker membership. The
 * maintenance facts are explicit because an N-only feature flag cannot stop an
 * N-1 REST/MCP schema from stripping an unknown model field.
 */
export const TaskModelSelectionDeploymentAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    deploymentId: SafeCapabilityTextSchema,
    expectedWorkers: z.array(TaskModelSelectionExpectedWorkerSchema).min(1),
    reports: z.array(TaskModelSelectionLocalRoleReportSchema).min(1),
    databaseMigrationComplete: z.boolean(),
    writeIngressClosedDuringCutover: z.boolean(),
    mcpWritersDisabledDuringCutover: z.boolean(),
    legacyWorkersRemoved: z.boolean(),
    compatibilityChecksPassed: z.boolean(),
    attestedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedIds = new Set<string>();
    for (const worker of value.expectedWorkers) {
      if (expectedIds.has(worker.instanceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expectedWorkers'],
          message: 'Expected worker instance ids must be unique',
        });
        break;
      }
      expectedIds.add(worker.instanceId);
    }

    const reportKeys = new Set<string>();
    for (const report of value.reports) {
      const key = `${report.instanceId}\0${report.role}`;
      if (reportKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reports'],
          message: 'Worker role reports must be unique',
        });
        break;
      }
      reportKeys.add(key);
    }

    if (Date.parse(value.expiresAt) <= Date.parse(value.attestedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Deployment attestation must expire after it was issued',
      });
    }
  });
export type TaskModelSelectionDeploymentAttestation = z.infer<
  typeof TaskModelSelectionDeploymentAttestationSchema
>;

/** Omission intentionally parses to disabled: the deployment gate is default-closed. */
export const TaskModelSelectionGateConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    attestation: TaskModelSelectionDeploymentAttestationSchema.optional(),
  })
  .strict();
export type TaskModelSelectionGateConfig = z.infer<
  typeof TaskModelSelectionGateConfigSchema
>;

export const TaskModelSelectionGateClosedReasonSchema = z.enum([
  'disabled',
  'deployment_attestation_missing',
  'deployment_attestation_invalid',
  'deployment_attestation_expired',
  'database_migration_incomplete',
  'maintenance_cutover_incomplete',
  'legacy_workers_present',
  'compatibility_checks_failed',
  'worker_report_missing',
  'worker_capability_missing',
  'worker_not_ready',
]);
export type TaskModelSelectionGateClosedReason = z.infer<
  typeof TaskModelSelectionGateClosedReasonSchema
>;

const TaskModelSelectionGateOpenSchema = z
  .object({
    capability: TaskModelSelectionCapabilitySchema,
    open: z.literal(true),
    verifiedRoles: z.array(TaskModelSelectionWorkerRoleSchema).length(4),
  })
  .strict();

const TaskModelSelectionGateClosedSchema = z
  .object({
    capability: TaskModelSelectionCapabilitySchema,
    open: z.literal(false),
    reason: TaskModelSelectionGateClosedReasonSchema,
    missingRoles: z.array(TaskModelSelectionWorkerRoleSchema).max(4),
    error: RuntimeModelCatalogUnavailableErrorSchema,
  })
  .strict();

export const TaskModelSelectionGateResultSchema = z.discriminatedUnion('open', [
  TaskModelSelectionGateOpenSchema,
  TaskModelSelectionGateClosedSchema,
]);
export type TaskModelSelectionGateResult = z.infer<
  typeof TaskModelSelectionGateResultSchema
>;

export const TaskModelSelectionCapabilityStatusSchema = z
  .object({
    capability: TaskModelSelectionCapabilitySchema,
    gate: TaskModelSelectionGateResultSchema,
    localReports: z.array(TaskModelSelectionLocalRoleReportSchema).min(1).max(4),
  })
  .strict();
export type TaskModelSelectionCapabilityStatus = z.infer<
  typeof TaskModelSelectionCapabilityStatusSchema
>;

const ALL_TASK_MODEL_SELECTION_ROLES =
  TaskModelSelectionWorkerRoleSchema.options;

function closedGate(
  reason: TaskModelSelectionGateClosedReason,
  missingRoles: readonly TaskModelSelectionWorkerRole[] = [],
): TaskModelSelectionGateResult {
  return {
    capability: TASK_MODEL_SELECTION_CAPABILITY,
    open: false,
    reason,
    missingRoles: [...missingRoles],
    error: {
      code: 'runtime_model_catalog_unavailable',
      message: 'Runtime model selection is temporarily unavailable.',
      retryable: true,
    },
  };
}

/**
 * Deterministically evaluates a complete deployment attestation. Callers must
 * not synthesize expected membership from only the workers that happened to
 * report; that would turn an N-only view into false deployment readiness.
 */
export function evaluateTaskModelSelectionGate(
  input: unknown,
  now = new Date(),
): TaskModelSelectionGateResult {
  const config = TaskModelSelectionGateConfigSchema.parse(input);
  if (!config.enabled) return closedGate('disabled');
  const attestation = config.attestation;
  if (!attestation) return closedGate('deployment_attestation_missing');
  if (Date.parse(attestation.expiresAt) <= now.getTime()) {
    return closedGate('deployment_attestation_expired');
  }
  if (!attestation.databaseMigrationComplete) {
    return closedGate('database_migration_incomplete');
  }
  if (!attestation.legacyWorkersRemoved) {
    return closedGate('legacy_workers_present');
  }
  if (
    !attestation.writeIngressClosedDuringCutover ||
    !attestation.mcpWritersDisabledDuringCutover
  ) {
    return closedGate('maintenance_cutover_incomplete');
  }
  if (!attestation.compatibilityChecksPassed) {
    return closedGate('compatibility_checks_failed');
  }

  const reports = new Map(
    attestation.reports.map((report) => [
      `${report.instanceId}\0${report.role}`,
      report,
    ]),
  );
  const expectedRoles = new Set<TaskModelSelectionWorkerRole>();
  for (const worker of attestation.expectedWorkers) {
    for (const role of worker.roles) {
      expectedRoles.add(role);
      const report = reports.get(`${worker.instanceId}\0${role}`);
      if (!report) return closedGate('worker_report_missing', [role]);
      if (!report.capabilities.includes(TASK_MODEL_SELECTION_CAPABILITY)) {
        return closedGate('worker_capability_missing', [role]);
      }
      if (!report.ready) return closedGate('worker_not_ready', [role]);
    }
  }

  const missingRoles = ALL_TASK_MODEL_SELECTION_ROLES.filter(
    (role) => !expectedRoles.has(role),
  );
  if (missingRoles.length > 0) {
    return closedGate('worker_report_missing', missingRoles);
  }
  return {
    capability: TASK_MODEL_SELECTION_CAPABILITY,
    open: true,
    verifiedRoles: [...ALL_TASK_MODEL_SELECTION_ROLES],
  };
}
