import { z } from 'zod';

import {
  DeploymentCapabilityLocalReportFields,
  DeploymentCapabilitySafeTextSchema,
} from './deployment-capability.js';

/** Deployment-wide capability required before diagnostic reads or grants open. */
export const TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY =
  'task-provisioning-diagnostics' as const;
export const TaskProvisioningDiagnosticsCapabilitySchema = z.literal(
  TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
);

/**
 * Independently attested compatibility facts. Keeping these facts separate
 * prevents a role that only knows the response schema from claiming support
 * for owner isolation, scope parsing, registry metadata, or wire parity.
 */
export const TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES = [
  'task-provisioning-diagnostics-schema-v1',
  'task-provisioning-diagnostics-owner-required-v1',
  'task-provisioning-diagnostics-scope-parser-v1',
  'task-provisioning-diagnostics-registry-v1',
  'task-provisioning-diagnostics-wire-fixture-v1',
] as const;
export const TaskProvisioningDiagnosticsRequiredCapabilitySchema = z.enum(
  TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES,
);
export type TaskProvisioningDiagnosticsRequiredCapability = z.infer<
  typeof TaskProvisioningDiagnosticsRequiredCapabilitySchema
>;

/** Every serving surface must be represented by complete deployment evidence. */
export const TaskProvisioningDiagnosticsRoleSchema = z.enum([
  'api',
  'mcp',
  'web',
]);
export type TaskProvisioningDiagnosticsRole = z.infer<
  typeof TaskProvisioningDiagnosticsRoleSchema
>;

export const TaskProvisioningDiagnosticsLocalRoleReportSchema = z
  .object({
    ...DeploymentCapabilityLocalReportFields,
    role: TaskProvisioningDiagnosticsRoleSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message: 'Provisioning diagnostics capabilities must be unique',
      });
    }
  });
export type TaskProvisioningDiagnosticsLocalRoleReport = z.infer<
  typeof TaskProvisioningDiagnosticsLocalRoleReportSchema
>;

export const TaskProvisioningDiagnosticsExpectedWorkerSchema = z
  .object({
    instanceId: DeploymentCapabilitySafeTextSchema,
    roles: z.array(TaskProvisioningDiagnosticsRoleSchema).min(1).max(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.roles).size !== value.roles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles'],
        message: 'Expected provisioning diagnostics roles must be unique',
      });
    }
  });
export type TaskProvisioningDiagnosticsExpectedWorker = z.infer<
  typeof TaskProvisioningDiagnosticsExpectedWorkerSchema
>;

/**
 * Complete deployment membership supplied independently by the rollout
 * orchestrator. A process-local report can never infer or fabricate another
 * serving role (notably the separately deployed Web surface).
 */
export const TaskProvisioningDiagnosticsDeploymentAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    deploymentId: DeploymentCapabilitySafeTextSchema,
    expectedWorkers: z
      .array(TaskProvisioningDiagnosticsExpectedWorkerSchema)
      .min(1)
      .max(256),
    reports: z
      .array(TaskProvisioningDiagnosticsLocalRoleReportSchema)
      .min(1)
      .max(768),
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
          message:
            'Expected provisioning diagnostics worker instance ids must be unique',
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
          message:
            'Provisioning diagnostics instance-role reports must be unique',
        });
        break;
      }
      reportKeys.add(key);
    }

    const attestedAt = Date.parse(value.attestedAt);
    if (Date.parse(value.expiresAt) <= attestedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message:
          'Provisioning diagnostics attestation must expire after it was issued',
      });
    }
    if (
      value.reports.some(
        (report) => Date.parse(report.reportedAt) > attestedAt,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reports'],
        message:
          'Provisioning diagnostics reports cannot postdate the attestation',
      });
    }
  });
export type TaskProvisioningDiagnosticsDeploymentAttestation = z.infer<
  typeof TaskProvisioningDiagnosticsDeploymentAttestationSchema
>;

/** Omission intentionally parses to disabled: mixed deployments fail closed. */
export const TaskProvisioningDiagnosticsGateConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    attestation:
      TaskProvisioningDiagnosticsDeploymentAttestationSchema.optional(),
  })
  .strict();
export type TaskProvisioningDiagnosticsGateConfig = z.infer<
  typeof TaskProvisioningDiagnosticsGateConfigSchema
>;

export const TaskProvisioningDiagnosticsUnavailableErrorSchema = z
  .object({
    code: z.literal('task_provisioning_diagnostics_unavailable'),
    message: z.literal(
      'Task provisioning diagnostics are temporarily unavailable.',
    ),
    retryable: z.literal(true),
  })
  .strict();
export type TaskProvisioningDiagnosticsUnavailableError = z.infer<
  typeof TaskProvisioningDiagnosticsUnavailableErrorSchema
>;

export const TaskProvisioningDiagnosticsGateClosedReasonSchema = z.enum([
  'disabled',
  'deployment_attestation_missing',
  'deployment_attestation_invalid',
  'deployment_attestation_expired',
  'deployment_attestation_not_yet_valid',
  'role_report_missing',
  'role_report_unexpected',
  'role_capability_missing',
  'role_not_ready',
  'mixed_build_identity',
]);
export type TaskProvisioningDiagnosticsGateClosedReason = z.infer<
  typeof TaskProvisioningDiagnosticsGateClosedReasonSchema
>;

const TaskProvisioningDiagnosticsGateOpenSchema = z
  .object({
    capability: TaskProvisioningDiagnosticsCapabilitySchema,
    open: z.literal(true),
    verifiedRoles: z.tuple([
      z.literal('api'),
      z.literal('mcp'),
      z.literal('web'),
    ]),
  })
  .strict();

const TaskProvisioningDiagnosticsGateClosedSchema = z
  .object({
    capability: TaskProvisioningDiagnosticsCapabilitySchema,
    open: z.literal(false),
    reason: TaskProvisioningDiagnosticsGateClosedReasonSchema,
    missingRoles: z.array(TaskProvisioningDiagnosticsRoleSchema).max(3),
    error: TaskProvisioningDiagnosticsUnavailableErrorSchema,
  })
  .strict();

export const TaskProvisioningDiagnosticsGateResultSchema =
  z.discriminatedUnion('open', [
    TaskProvisioningDiagnosticsGateOpenSchema,
    TaskProvisioningDiagnosticsGateClosedSchema,
  ]);
export type TaskProvisioningDiagnosticsGateResult = z.infer<
  typeof TaskProvisioningDiagnosticsGateResultSchema
>;

const ALL_TASK_PROVISIONING_DIAGNOSTICS_ROLES =
  TaskProvisioningDiagnosticsRoleSchema.options;
const TASK_PROVISIONING_DIAGNOSTICS_UNAVAILABLE_ERROR = Object.freeze({
  code: 'task_provisioning_diagnostics_unavailable',
  message: 'Task provisioning diagnostics are temporarily unavailable.',
  retryable: true,
} as const satisfies TaskProvisioningDiagnosticsUnavailableError);

function closedGate(
  reason: TaskProvisioningDiagnosticsGateClosedReason,
  missingRoles: readonly TaskProvisioningDiagnosticsRole[] = [],
): TaskProvisioningDiagnosticsGateResult {
  return {
    capability: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
    open: false,
    reason,
    missingRoles: [...missingRoles],
    error: TASK_PROVISIONING_DIAGNOSTICS_UNAVAILABLE_ERROR,
  };
}

/**
 * Evaluate complete API/MCP/Web membership deterministically. Expected
 * membership is an input, never inferred from the reports that happened to
 * arrive, and every expected instance-role pair must report every required
 * compatibility fact.
 */
export function evaluateTaskProvisioningDiagnosticsGate(
  input: unknown,
  now = new Date(),
): TaskProvisioningDiagnosticsGateResult {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    return closedGate('deployment_attestation_invalid');
  }
  const parsed = TaskProvisioningDiagnosticsGateConfigSchema.safeParse(input);
  if (!parsed.success) return closedGate('deployment_attestation_invalid');

  const config = parsed.data;
  if (!config.enabled) return closedGate('disabled');
  const attestation = config.attestation;
  if (!attestation) return closedGate('deployment_attestation_missing');
  if (Date.parse(attestation.attestedAt) > nowMs) {
    return closedGate('deployment_attestation_not_yet_valid');
  }
  if (Date.parse(attestation.expiresAt) <= nowMs) {
    return closedGate('deployment_attestation_expired');
  }

  const expectedReportKeys = new Set<string>();
  const expectedRoles = new Set<TaskProvisioningDiagnosticsRole>();
  for (const worker of attestation.expectedWorkers) {
    for (const role of worker.roles) {
      expectedRoles.add(role);
      expectedReportKeys.add(`${worker.instanceId}\0${role}`);
    }
  }

  for (const report of attestation.reports) {
    if (!expectedReportKeys.has(`${report.instanceId}\0${report.role}`)) {
      return closedGate('role_report_unexpected');
    }
  }

  const missingDeploymentRoles = ALL_TASK_PROVISIONING_DIAGNOSTICS_ROLES.filter(
    (role) => !expectedRoles.has(role),
  );
  if (missingDeploymentRoles.length > 0) {
    return closedGate('role_report_missing', missingDeploymentRoles);
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
      if (!report) return closedGate('role_report_missing', [role]);
      if (
        TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES.some(
          (capability) => !report.capabilities.includes(capability),
        )
      ) {
        return closedGate('role_capability_missing', [role]);
      }
      if (!report.ready || Date.parse(report.reportedAt) > nowMs) {
        return closedGate('role_not_ready', [role]);
      }
      buildIdentities.add(report.buildIdentity);
    }
  }

  if (buildIdentities.size !== 1) {
    return closedGate('mixed_build_identity');
  }
  return {
    capability: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
    open: true,
    verifiedRoles: [...ALL_TASK_PROVISIONING_DIAGNOSTICS_ROLES],
  };
}
