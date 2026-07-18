import { Injectable } from '@nestjs/common';

/**
 * Independent rollback/cutover switch for task-provisioning diagnostic writes.
 *
 * This switch intentionally does not reuse the admission-v2 gate: diagnostics
 * must be able to cover both legacy and durable admission. It is also separate
 * from the future public-read and scope-grant capability gates, which require
 * compatible API/MCP/Web deployment evidence before they can open.
 *
 * A deployment capability attestation may replace this production binding in a
 * later rollout step. Until then this port is only the fail-closed write switch;
 * it must not be presented as proof of whole-deployment compatibility.
 */
export const TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE =
  'TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE';

export const TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV =
  'CAP_TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED';

/** Read once at a provisioning boundary; callers never receive gate config. */
export interface TaskProvisioningDiagnosticsWriteGatePort {
  isEnabled(): boolean;
}

/**
 * Process-local, snapshot-style write switch. Construction captures only the
 * boolean decision, so later environment mutation cannot affect an in-flight
 * provisioning attempt and raw configuration is never retained or exposed.
 */
@Injectable()
export class EnvironmentTaskProvisioningDiagnosticsWriteGate
  implements TaskProvisioningDiagnosticsWriteGatePort
{
  readonly #enabled = taskProvisioningDiagnosticsWritesEnabled(process.env);

  isEnabled(): boolean {
    return this.#enabled;
  }
}

/** Pure fail-closed evaluator used by deployment checks and focused tests. */
export function taskProvisioningDiagnosticsWritesEnabled(
  env: NodeJS.ProcessEnv,
): boolean {
  const value = env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV];
  return value === '1' || value === 'true';
}
