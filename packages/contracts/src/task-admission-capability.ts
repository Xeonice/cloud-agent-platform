import { z } from 'zod';

import {
  DeploymentCapabilityLocalReportFields,
  DeploymentCapabilitySafeTextSchema,
} from './deployment-capability.js';

/** Deployment-wide capability required before durable task admission is enabled. */
export const TASK_ADMISSION_V2_CAPABILITY = 'task-admission-v2' as const;
export const TaskAdmissionV2CapabilitySchema = z.literal(
  TASK_ADMISSION_V2_CAPABILITY,
);

/** Logical write and work-consumer roles that must be upgraded together. */
export const TaskAdmissionV2RoleSchema = z.enum(['api', 'worker']);
export type TaskAdmissionV2Role = z.infer<typeof TaskAdmissionV2RoleSchema>;

export const TaskAdmissionV2LocalRoleReportSchema = z
  .object({
    ...DeploymentCapabilityLocalReportFields,
    role: TaskAdmissionV2RoleSchema,
  })
  .strict();
export type TaskAdmissionV2LocalRoleReport = z.infer<
  typeof TaskAdmissionV2LocalRoleReportSchema
>;

export const TaskAdmissionV2ExpectedWorkerSchema = z
  .object({
    instanceId: DeploymentCapabilitySafeTextSchema,
    roles: z.array(TaskAdmissionV2RoleSchema).min(1).max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.roles).size !== value.roles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles'],
        message: 'Expected admission worker roles must be unique',
      });
    }
  });
export type TaskAdmissionV2ExpectedWorker = z.infer<
  typeof TaskAdmissionV2ExpectedWorkerSchema
>;

/**
 * Complete deployment membership supplied by the rollout orchestrator/operator.
 * Reports are deliberately secret-free and cannot be used to infer membership:
 * every expected process and its roles must be declared independently first.
 */
export const TaskAdmissionV2DeploymentAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    deploymentId: DeploymentCapabilitySafeTextSchema,
    expectedWorkers: z.array(TaskAdmissionV2ExpectedWorkerSchema).min(1),
    reports: z.array(TaskAdmissionV2LocalRoleReportSchema).min(1),
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
          message: 'Expected admission worker instance ids must be unique',
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
          message: 'Admission worker role reports must be unique',
        });
        break;
      }
      reportKeys.add(key);
    }

    if (Date.parse(value.expiresAt) <= Date.parse(value.attestedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Admission deployment attestation must expire after it was issued',
      });
    }
  });
export type TaskAdmissionV2DeploymentAttestation = z.infer<
  typeof TaskAdmissionV2DeploymentAttestationSchema
>;

/** Omission intentionally parses to disabled: the rollout is default-closed. */
export const TaskAdmissionV2GateConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    attestation: TaskAdmissionV2DeploymentAttestationSchema.optional(),
  })
  .strict();
export type TaskAdmissionV2GateConfig = z.infer<
  typeof TaskAdmissionV2GateConfigSchema
>;

export const TaskAdmissionV2GateClosedReasonSchema = z.enum([
  'disabled',
  'deployment_attestation_missing',
  'deployment_attestation_invalid',
  'deployment_attestation_expired',
  'worker_report_missing',
  'worker_report_unexpected',
  'worker_capability_missing',
  'worker_not_ready',
  'mixed_build_identity',
]);
export type TaskAdmissionV2GateClosedReason = z.infer<
  typeof TaskAdmissionV2GateClosedReasonSchema
>;

const TaskAdmissionV2GateOpenSchema = z
  .object({
    capability: TaskAdmissionV2CapabilitySchema,
    open: z.literal(true),
    verifiedRoles: z.array(TaskAdmissionV2RoleSchema).length(2),
  })
  .strict();

const TaskAdmissionV2GateClosedSchema = z
  .object({
    capability: TaskAdmissionV2CapabilitySchema,
    open: z.literal(false),
    reason: TaskAdmissionV2GateClosedReasonSchema,
    missingRoles: z.array(TaskAdmissionV2RoleSchema).max(2),
  })
  .strict();

export const TaskAdmissionV2GateResultSchema = z.discriminatedUnion('open', [
  TaskAdmissionV2GateOpenSchema,
  TaskAdmissionV2GateClosedSchema,
]);
export type TaskAdmissionV2GateResult = z.infer<
  typeof TaskAdmissionV2GateResultSchema
>;

export const TaskAdmissionV2CapabilityStatusSchema = z
  .object({
    capability: TaskAdmissionV2CapabilitySchema,
    gate: TaskAdmissionV2GateResultSchema,
    localReports: z.array(TaskAdmissionV2LocalRoleReportSchema).min(1).max(2),
  })
  .strict();
export type TaskAdmissionV2CapabilityStatus = z.infer<
  typeof TaskAdmissionV2CapabilityStatusSchema
>;

const ALL_TASK_ADMISSION_V2_ROLES = TaskAdmissionV2RoleSchema.options;

function closedGate(
  reason: TaskAdmissionV2GateClosedReason,
  missingRoles: readonly TaskAdmissionV2Role[] = [],
): TaskAdmissionV2GateResult {
  return {
    capability: TASK_ADMISSION_V2_CAPABILITY,
    open: false,
    reason,
    missingRoles: [...missingRoles],
  };
}

/** Evaluate a complete admission-v2 deployment attestation deterministically. */
export function evaluateTaskAdmissionV2Gate(
  input: unknown,
  now = new Date(),
): TaskAdmissionV2GateResult {
  const parsed = TaskAdmissionV2GateConfigSchema.safeParse(input);
  if (!parsed.success) return closedGate('deployment_attestation_invalid');

  const config = parsed.data;
  if (!config.enabled) return closedGate('disabled');
  const attestation = config.attestation;
  if (!attestation) return closedGate('deployment_attestation_missing');
  if (Date.parse(attestation.expiresAt) <= now.getTime()) {
    return closedGate('deployment_attestation_expired');
  }

  const expectedReportKeys = new Set<string>();
  const expectedRoles = new Set<TaskAdmissionV2Role>();
  for (const worker of attestation.expectedWorkers) {
    for (const role of worker.roles) {
      expectedRoles.add(role);
      expectedReportKeys.add(`${worker.instanceId}\0${role}`);
    }
  }

  for (const report of attestation.reports) {
    if (!expectedReportKeys.has(`${report.instanceId}\0${report.role}`)) {
      return closedGate('worker_report_unexpected');
    }
  }

  const reports = new Map(
    attestation.reports.map((report) => [
      `${report.instanceId}\0${report.role}`,
      report,
    ]),
  );
  const buildIdentities = new Set<string>();
  for (const worker of attestation.expectedWorkers) {
    for (const role of worker.roles) {
      const report = reports.get(`${worker.instanceId}\0${role}`);
      if (!report) return closedGate('worker_report_missing', [role]);
      if (!report.capabilities.includes(TASK_ADMISSION_V2_CAPABILITY)) {
        return closedGate('worker_capability_missing', [role]);
      }
      if (!report.ready || Date.parse(report.reportedAt) > now.getTime()) {
        return closedGate('worker_not_ready', [role]);
      }
      buildIdentities.add(report.buildIdentity);
    }
  }

  const missingRoles = ALL_TASK_ADMISSION_V2_ROLES.filter(
    (role) => !expectedRoles.has(role),
  );
  if (missingRoles.length > 0) {
    return closedGate('worker_report_missing', missingRoles);
  }
  if (buildIdentities.size !== 1) return closedGate('mixed_build_identity');

  return {
    capability: TASK_ADMISSION_V2_CAPABILITY,
    open: true,
    verifiedRoles: [...ALL_TASK_ADMISSION_V2_ROLES],
  };
}
