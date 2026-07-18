import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
  TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES,
  TaskProvisioningDiagnosticsDeploymentAttestationSchema,
  TaskProvisioningDiagnosticsGateResultSchema,
  TaskProvisioningDiagnosticsLocalRoleReportSchema,
  TaskProvisioningDiagnosticsUnavailableErrorSchema,
  evaluateTaskProvisioningDiagnosticsGate,
  type Scope,
  type TaskProvisioningDiagnosticsDeploymentAttestation,
  type TaskProvisioningDiagnosticsGateResult,
  type TaskProvisioningDiagnosticsLocalRoleReport,
  type TaskProvisioningDiagnosticsRequiredCapability,
  type TaskProvisioningDiagnosticsRole,
} from '@cap/contracts';

import type { TaskProvisioningDiagnosticsCapabilityGatePort } from './task-provisioning-diagnostics-deployment-gate.port';

export const TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED_ENV =
  'CAP_TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED';
export const TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_ENV =
  'CAP_TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_JSON';

const LOCAL_ROLES = [
  'api',
  'mcp',
] as const satisfies readonly TaskProvisioningDiagnosticsRole[];
const MAX_ATTESTATION_BYTES = 256 * 1024;
const UNAVAILABLE_ERROR =
  TaskProvisioningDiagnosticsUnavailableErrorSchema.parse({
    code: 'task_provisioning_diagnostics_unavailable',
    message: 'Task provisioning diagnostics are temporarily unavailable.',
    retryable: true,
  });

interface LoadedTaskProvisioningDiagnosticsGateConfig {
  readonly enabled: boolean;
  readonly attestation?: TaskProvisioningDiagnosticsDeploymentAttestation;
  readonly invalid: boolean;
}

/**
 * One process-local view of the complete API/MCP/Web deployment attestation.
 * This API process serves REST and MCP and therefore verifies/reports only
 * those two local roles. The complete evaluator still requires an independent
 * Web role report before the shared read/grant gate can open.
 */
@Injectable()
export class TaskProvisioningDiagnosticsCapabilityService
  implements
    TaskProvisioningDiagnosticsCapabilityGatePort,
    OnApplicationBootstrap
{
  private readonly logger = new Logger(
    TaskProvisioningDiagnosticsCapabilityService.name,
  );
  private readonly instanceId = safeIdentity(
    process.env.CAP_INSTANCE_ID ?? process.env.HOSTNAME ?? hostname(),
    `process-${randomUUID()}`,
  );
  private readonly buildIdentity = safeIdentity(
    process.env.GIT_SHA ?? process.env.CAP_VERSION,
    'unknown-build',
  );
  private readonly config = loadTaskProvisioningDiagnosticsGateConfig(
    process.env,
  );

  onApplicationBootstrap(): void {
    const result = this.evaluate();
    if (result.open) {
      this.logger.log(
        `${TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY} gate is open for ${result.verifiedRoles.join(',')}`,
      );
      return;
    }
    this.logger.warn(
      `${TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY} gate is closed (${result.reason})`,
    );
  }

  evaluate(now = new Date()): TaskProvisioningDiagnosticsGateResult {
    const result = evaluateLoadedConfig(this.config, now);
    if (!result.open || !this.config.attestation) return result;
    return this.verifyLocalProcess(this.config.attestation, now);
  }

  isOpen(now = new Date()): boolean {
    return this.evaluate(now).open;
  }

  assertReadOpen(): void {
    if (!this.evaluate().open) throwUnavailable();
  }

  assertScopesGrantable(scopes: readonly Scope[]): void {
    if (!scopes.includes('tasks:diagnostics')) return;
    if (!this.evaluate().open) throwUnavailable();
  }

  /** Safe local evidence; it never fabricates a report for the Web role. */
  localRoleReports(
    now = new Date(),
  ): readonly TaskProvisioningDiagnosticsLocalRoleReport[] {
    return LOCAL_ROLES.map((role) =>
      TaskProvisioningDiagnosticsLocalRoleReportSchema.parse({
        schemaVersion: 1,
        instanceId: this.instanceId,
        role,
        buildIdentity: this.buildIdentity,
        capabilities: [...localCapabilities(role)],
        ready: true,
        reportedAt: now.toISOString(),
      }),
    );
  }

  private verifyLocalProcess(
    attestation: TaskProvisioningDiagnosticsDeploymentAttestation,
    now: Date,
  ): TaskProvisioningDiagnosticsGateResult {
    const expected = attestation.expectedWorkers.find(
      (worker) => worker.instanceId === this.instanceId,
    );
    if (!expected) return closedGateResult('role_report_missing', LOCAL_ROLES);

    for (const role of LOCAL_ROLES) {
      const locallySupported = localCapabilities(role);
      if (
        TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES.some(
          (capability) => !locallySupported.includes(capability),
        )
      ) {
        return closedGateResult('role_capability_missing', [role]);
      }
      if (!expected.roles.includes(role)) {
        return closedGateResult('role_report_missing', [role]);
      }
      const report = attestation.reports.find(
        (candidate) =>
          candidate.instanceId === this.instanceId && candidate.role === role,
      );
      if (!report) return closedGateResult('role_report_missing', [role]);
      if (
        TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES.some(
          (capability) => !report.capabilities.includes(capability),
        )
      ) {
        return closedGateResult('role_capability_missing', [role]);
      }
      if (
        !report.ready ||
        report.buildIdentity !== this.buildIdentity ||
        Date.parse(report.reportedAt) > now.getTime()
      ) {
        return closedGateResult('role_not_ready', [role]);
      }
    }

    return TaskProvisioningDiagnosticsGateResultSchema.parse({
      capability: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
      open: true,
      verifiedRoles: ['api', 'mcp', 'web'],
    });
  }
}

/** Pure environment/attestation evaluation used by focused rollout tests. */
export function evaluateTaskProvisioningDiagnosticsEnvironment(
  env: NodeJS.ProcessEnv,
  now = new Date(),
): TaskProvisioningDiagnosticsGateResult {
  return evaluateLoadedConfig(
    loadTaskProvisioningDiagnosticsGateConfig(env),
    now,
  );
}

function evaluateLoadedConfig(
  config: LoadedTaskProvisioningDiagnosticsGateConfig,
  now: Date,
): TaskProvisioningDiagnosticsGateResult {
  if (config.invalid) {
    return closedGateResult('deployment_attestation_invalid');
  }
  return TaskProvisioningDiagnosticsGateResultSchema.parse(
    evaluateTaskProvisioningDiagnosticsGate(
      {
        enabled: config.enabled,
        ...(config.attestation ? { attestation: config.attestation } : {}),
      },
      now,
    ),
  );
}

function loadTaskProvisioningDiagnosticsGateConfig(
  env: NodeJS.ProcessEnv,
): LoadedTaskProvisioningDiagnosticsGateConfig {
  const enabled = parseEnabled(
    env[TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED_ENV],
  );
  const raw = env[TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_ENV];
  if (!raw?.trim()) return { enabled, invalid: false };
  if (Buffer.byteLength(raw, 'utf8') > MAX_ATTESTATION_BYTES) {
    return { enabled, invalid: true };
  }
  try {
    return {
      enabled,
      attestation: TaskProvisioningDiagnosticsDeploymentAttestationSchema.parse(
        JSON.parse(raw),
      ),
      invalid: false,
    };
  } catch {
    return { enabled, invalid: true };
  }
}

function parseEnabled(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function localCapabilities(
  _role: (typeof LOCAL_ROLES)[number],
): readonly TaskProvisioningDiagnosticsRequiredCapability[] {
  return TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES;
}

function safeIdentity(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  return value && /^[A-Za-z0-9._:@/+-]{1,256}$/u.test(value)
    ? value
    : fallback;
}

function closedGateResult(
  reason: Exclude<
    TaskProvisioningDiagnosticsGateResult,
    { readonly open: true }
  >['reason'],
  missingRoles: readonly TaskProvisioningDiagnosticsRole[] = [],
): TaskProvisioningDiagnosticsGateResult {
  return TaskProvisioningDiagnosticsGateResultSchema.parse({
    capability: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
    open: false,
    reason,
    missingRoles: [...missingRoles],
    error: UNAVAILABLE_ERROR,
  });
}

function throwUnavailable(): never {
  throw new ServiceUnavailableException(UNAVAILABLE_ERROR);
}
