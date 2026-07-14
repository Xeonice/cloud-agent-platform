import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  TASK_MODEL_SELECTION_CAPABILITY,
  TaskModelSelectionDeploymentAttestationSchema,
  TaskModelSelectionGateResultSchema,
  TaskModelSelectionLocalRoleReportSchema,
  evaluateTaskModelSelectionGate,
  type TaskModelSelectionGateResult,
  type TaskModelSelectionLocalRoleReport,
  type TaskModelSelectionWorkerRole,
  type TaskModelSelectionDeploymentAttestation,
} from '@cap/contracts';
import { RuntimeModelPreflightError } from './runtime-model-preflight.error';

export const TASK_MODEL_SELECTION_ENABLED_ENV =
  'CAP_TASK_MODEL_SELECTION_ENABLED';
export const TASK_MODEL_SELECTION_ATTESTATION_ENV =
  'CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON';

const WORKER_ROLES = [
  'api',
  'admission',
  'scheduler',
  'runtime',
] as const satisfies readonly TaskModelSelectionWorkerRole[];
const MAX_ATTESTATION_BYTES = 256 * 1024;

/**
 * Process-local view of the deployment-wide model-selection cutover gate.
 *
 * The attestation is operator supplied and contains the complete expected
 * membership. This service deliberately never derives membership from its own
 * reports: one N process cannot prove that an N-1 writer is absent.
 */
@Injectable()
export class TaskModelCapabilityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TaskModelCapabilityService.name);
  private readonly instanceId = safeIdentity(
    process.env.CAP_INSTANCE_ID ?? process.env.HOSTNAME ?? hostname(),
    `process-${randomUUID()}`,
  );
  private readonly buildIdentity = safeIdentity(
    process.env.GIT_SHA ?? process.env.CAP_VERSION,
    'unknown-build',
  );
  private readonly config = loadGateConfig(process.env);

  onApplicationBootstrap(): void {
    const result = this.evaluate();
    if (result.open) {
      this.logger.log(
        `${TASK_MODEL_SELECTION_CAPABILITY} gate is open for ${result.verifiedRoles.join(',')}`,
      );
      return;
    }
    this.logger.warn(
      `${TASK_MODEL_SELECTION_CAPABILITY} gate is closed (${result.reason})`,
    );
  }

  evaluate(now = new Date()): TaskModelSelectionGateResult {
    if (this.config.invalid) {
      return closedGateResult('deployment_attestation_invalid');
    }
    const result = TaskModelSelectionGateResultSchema.parse(
      evaluateTaskModelSelectionGate(
        {
          enabled: this.config.enabled,
          ...(this.config.attestation
            ? { attestation: this.config.attestation }
            : {}),
        },
        now,
      ),
    );
    if (!result.open || !this.config.attestation) return result;
    return this.verifyLocalProcess(this.config.attestation, now);
  }

  /** Fail with the shared transport-neutral 503 domain object before side effects. */
  assertOpen(now = new Date()): void {
    const result = this.evaluate(now);
    if (!result.open) throw new RuntimeModelPreflightError(result.error);
  }

  /**
   * Safe process-local evidence for deployment tooling. These reports are input
   * to an external complete-membership attestation, never an attestation by
   * themselves.
   */
  localRoleReports(now = new Date()): readonly TaskModelSelectionLocalRoleReport[] {
    return WORKER_ROLES.map((role) =>
      TaskModelSelectionLocalRoleReportSchema.parse({
        schemaVersion: 1,
        instanceId: this.instanceId,
        role,
        buildIdentity: this.buildIdentity,
        capabilities: [TASK_MODEL_SELECTION_CAPABILITY],
        ready: true,
        reportedAt: now.toISOString(),
      }),
    );
  }

  private verifyLocalProcess(
    attestation: TaskModelSelectionDeploymentAttestation,
    now: Date,
  ): TaskModelSelectionGateResult {
    const expected = attestation.expectedWorkers.find(
      (worker) => worker.instanceId === this.instanceId,
    );
    if (!expected) {
      return closedGateResult('worker_report_missing', WORKER_ROLES);
    }
    for (const role of WORKER_ROLES) {
      if (!expected.roles.includes(role)) {
        return closedGateResult('worker_report_missing', [role]);
      }
      const report = attestation.reports.find(
        (candidate) =>
          candidate.instanceId === this.instanceId && candidate.role === role,
      );
      if (!report) return closedGateResult('worker_report_missing', [role]);
      if (!report.capabilities.includes(TASK_MODEL_SELECTION_CAPABILITY)) {
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
    return TaskModelSelectionGateResultSchema.parse({
      capability: TASK_MODEL_SELECTION_CAPABILITY,
      open: true,
      verifiedRoles: [...WORKER_ROLES],
    });
  }
}

function parseEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw?.trim().toLowerCase() === 'true';
}

function safeIdentity(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  return value && /^[A-Za-z0-9._:@/+-]{1,256}$/u.test(value)
    ? value
    : fallback;
}

function loadGateConfig(env: NodeJS.ProcessEnv): {
  readonly enabled: boolean;
  readonly attestation?: TaskModelSelectionDeploymentAttestation;
  readonly invalid: boolean;
} {
  const enabled = parseEnabled(env[TASK_MODEL_SELECTION_ENABLED_ENV]);
  const raw = env[TASK_MODEL_SELECTION_ATTESTATION_ENV];
  if (!raw?.trim()) return { enabled, invalid: false };
  if (Buffer.byteLength(raw, 'utf8') > MAX_ATTESTATION_BYTES) {
    return { enabled, invalid: true };
  }
  try {
    return {
      enabled,
      attestation: TaskModelSelectionDeploymentAttestationSchema.parse(
        JSON.parse(raw),
      ),
      invalid: false,
    };
  } catch {
    return { enabled, invalid: true };
  }
}

function closedGateResult(
  reason: Exclude<
    TaskModelSelectionGateResult,
    { readonly open: true }
  >['reason'],
  missingRoles: readonly TaskModelSelectionWorkerRole[] = [],
): TaskModelSelectionGateResult {
  return TaskModelSelectionGateResultSchema.parse({
    capability: TASK_MODEL_SELECTION_CAPABILITY,
    open: false,
    reason,
    missingRoles: [...missingRoles],
    error: {
      code: 'runtime_model_catalog_unavailable',
      message: 'Runtime model selection is temporarily unavailable.',
      retryable: true,
    },
  });
}
