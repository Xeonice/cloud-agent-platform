import { Inject, Injectable } from '@nestjs/common';
import {
  type TaskProvisioningDiagnosticsQuery,
  type TaskProvisioningDiagnosticsResponse,
} from '@cap/contracts';

import { PublicSurfaceError } from '../public-surface/public-surface-error';
import {
  assertTaskProvisioningDiagnosticsReadOpen,
  TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
  type TaskProvisioningDiagnosticsCapabilityGatePort,
} from './task-provisioning-diagnostics-deployment-gate.port';
import { TaskProvisioningDiagnosticsService } from './task-provisioning-diagnostics.service';

/**
 * Shared Public V1/MCP owner-scoped use case. It is the only public adapter
 * seam: the deployment gate surrounds the DB read and recorder/store failures
 * are reduced to stable public codes without forwarding internal detail.
 */
@Injectable()
export class TaskProvisioningDiagnosticsPublicQueryService {
  constructor(
    private readonly diagnostics: TaskProvisioningDiagnosticsService,
    @Inject(TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE)
    private readonly capabilityGate: TaskProvisioningDiagnosticsCapabilityGatePort,
  ) {}

  async readForOwner(
    ownerUserId: string,
    taskId: string,
    query: TaskProvisioningDiagnosticsQuery,
  ): Promise<TaskProvisioningDiagnosticsResponse> {
    assertTaskProvisioningDiagnosticsReadOpen(this.capabilityGate);

    let result: Awaited<
      ReturnType<TaskProvisioningDiagnosticsService['readOwnedTaskDiagnostics']>
    >;
    try {
      result = await this.diagnostics.readOwnedTaskDiagnostics(
        ownerUserId,
        taskId,
        query,
      );
    } catch (internalCause) {
      throw unavailableError(internalCause);
    }

    // Evidence obtained across an attestation expiry/closure is withheld.
    assertTaskProvisioningDiagnosticsReadOpen(this.capabilityGate);
    if (result.ok) return result.value;

    switch (result.code) {
      case 'task_not_found':
        throw new PublicSurfaceError({ code: 'not_found' });
      case 'invalid_evidence':
        throw new PublicSurfaceError({ code: 'validation_failed' });
      default:
        throw unavailableError(result);
    }
  }
}

function unavailableError(internalCause: unknown): PublicSurfaceError {
  return new PublicSurfaceError({
    code: 'task_provisioning_diagnostics_unavailable',
    internalCause,
  });
}
