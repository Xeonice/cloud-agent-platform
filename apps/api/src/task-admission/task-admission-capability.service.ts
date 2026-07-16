import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  TASK_ADMISSION_V2_CAPABILITY,
  TaskAdmissionV2DeploymentAttestationSchema,
  TaskAdmissionV2GateResultSchema,
  TaskAdmissionV2LocalRoleReportSchema,
  evaluateTaskAdmissionV2Gate,
  type TaskAdmissionV2DeploymentAttestation,
  type TaskAdmissionV2GateResult,
  type TaskAdmissionV2LocalRoleReport,
  type TaskAdmissionV2Role,
} from '@cap/contracts';

export const TASK_ADMISSION_V2_ENABLED_ENV =
  'CAP_TASK_ADMISSION_V2_ENABLED';
export const TASK_ADMISSION_V2_ATTESTATION_ENV =
  'CAP_TASK_ADMISSION_V2_ATTESTATION_JSON';

const LOCAL_ROLES = [
  'api',
  'worker',
] as const satisfies readonly TaskAdmissionV2Role[];
const MAX_ATTESTATION_BYTES = 256 * 1024;

interface LoadedTaskAdmissionV2GateConfig {
  readonly enabled: boolean;
  readonly attestation?: TaskAdmissionV2DeploymentAttestation;
  readonly invalid: boolean;
}

/**
 * Process-local view of the complete deployment admission-v2 attestation.
 * Membership always comes from the operator/orchestrator document; local role
 * reports are safe evidence only and never synthesize deployment completeness.
 */
@Injectable()
export class TaskAdmissionCapabilityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TaskAdmissionCapabilityService.name);
  private readonly instanceId = safeIdentity(
    process.env.CAP_INSTANCE_ID ?? process.env.HOSTNAME ?? hostname(),
    `process-${randomUUID()}`,
  );
  private readonly buildIdentity = safeIdentity(
    process.env.GIT_SHA ?? process.env.CAP_VERSION,
    'unknown-build',
  );
  private readonly config = loadTaskAdmissionV2GateConfig(process.env);

  onApplicationBootstrap(): void {
    const result = this.evaluate();
    if (result.open) {
      this.logger.log(
        `${TASK_ADMISSION_V2_CAPABILITY} gate is open for ${result.verifiedRoles.join(',')}`,
      );
      return;
    }
    this.logger.warn(
      `${TASK_ADMISSION_V2_CAPABILITY} gate is closed (${result.reason})`,
    );
  }

  evaluate(now = new Date()): TaskAdmissionV2GateResult {
    const result = evaluateLoadedConfig(this.config, now);
    if (!result.open || !this.config.attestation) return result;
    return this.verifyLocalProcess(this.config.attestation, now);
  }

  isOpen(now = new Date()): boolean {
    return this.evaluate(now).open;
  }

  /** Safe local evidence for the read-only operational capability endpoint. */
  localRoleReports(now = new Date()): readonly TaskAdmissionV2LocalRoleReport[] {
    return LOCAL_ROLES.map((role) =>
      TaskAdmissionV2LocalRoleReportSchema.parse({
        schemaVersion: 1,
        instanceId: this.instanceId,
        role,
        buildIdentity: this.buildIdentity,
        capabilities: [TASK_ADMISSION_V2_CAPABILITY],
        ready: true,
        reportedAt: now.toISOString(),
      }),
    );
  }

  private verifyLocalProcess(
    attestation: TaskAdmissionV2DeploymentAttestation,
    now: Date,
  ): TaskAdmissionV2GateResult {
    const expected = attestation.expectedWorkers.find(
      (worker) => worker.instanceId === this.instanceId,
    );
    if (!expected) return closedGateResult('worker_report_missing', LOCAL_ROLES);

    for (const role of LOCAL_ROLES) {
      if (!expected.roles.includes(role)) {
        return closedGateResult('worker_report_missing', [role]);
      }
      const report = attestation.reports.find(
        (candidate) =>
          candidate.instanceId === this.instanceId && candidate.role === role,
      );
      if (!report) return closedGateResult('worker_report_missing', [role]);
      if (!report.capabilities.includes(TASK_ADMISSION_V2_CAPABILITY)) {
        return closedGateResult('worker_capability_missing', [role]);
      }
      if (
        !report.ready ||
        report.buildIdentity !== this.buildIdentity ||
        Date.parse(report.reportedAt) > now.getTime()
      ) {
        return closedGateResult('worker_not_ready', [role]);
      }
    }

    return TaskAdmissionV2GateResultSchema.parse({
      capability: TASK_ADMISSION_V2_CAPABILITY,
      open: true,
      verifiedRoles: [...LOCAL_ROLES],
    });
  }
}

/** Pure environment evaluation used by focused gate tests and diagnostics. */
export function evaluateTaskAdmissionV2Environment(
  env: NodeJS.ProcessEnv,
  now = new Date(),
): TaskAdmissionV2GateResult {
  return evaluateLoadedConfig(loadTaskAdmissionV2GateConfig(env), now);
}

function evaluateLoadedConfig(
  config: LoadedTaskAdmissionV2GateConfig,
  now: Date,
): TaskAdmissionV2GateResult {
  if (config.invalid) return closedGateResult('deployment_attestation_invalid');
  return TaskAdmissionV2GateResultSchema.parse(
    evaluateTaskAdmissionV2Gate(
      {
        enabled: config.enabled,
        ...(config.attestation ? { attestation: config.attestation } : {}),
      },
      now,
    ),
  );
}

function loadTaskAdmissionV2GateConfig(
  env: NodeJS.ProcessEnv,
): LoadedTaskAdmissionV2GateConfig {
  const enabled = parseEnabled(env[TASK_ADMISSION_V2_ENABLED_ENV]);
  const raw = env[TASK_ADMISSION_V2_ATTESTATION_ENV];
  if (!raw?.trim()) return { enabled, invalid: false };
  if (Buffer.byteLength(raw, 'utf8') > MAX_ATTESTATION_BYTES) {
    return { enabled, invalid: true };
  }
  try {
    return {
      enabled,
      attestation: TaskAdmissionV2DeploymentAttestationSchema.parse(
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

function safeIdentity(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  return value && /^[A-Za-z0-9._:@/+-]{1,256}$/u.test(value)
    ? value
    : fallback;
}

function closedGateResult(
  reason: Exclude<
    TaskAdmissionV2GateResult,
    { readonly open: true }
  >['reason'],
  missingRoles: readonly TaskAdmissionV2Role[] = [],
): TaskAdmissionV2GateResult {
  return TaskAdmissionV2GateResultSchema.parse({
    capability: TASK_ADMISSION_V2_CAPABILITY,
    open: false,
    reason,
    missingRoles: [...missingRoles],
  });
}
