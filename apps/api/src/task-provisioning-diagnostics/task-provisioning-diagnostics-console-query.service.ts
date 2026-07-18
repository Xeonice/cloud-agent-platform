import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  TaskProvisioningDiagnosticsUnavailableErrorSchema,
  type TaskProvisioningDiagnosticsQuery,
  type TaskProvisioningDiagnosticsResponse,
} from '@cap/contracts';

import { PrismaService } from '../prisma/prisma.service';
import {
  assertTaskProvisioningDiagnosticsReadOpen,
  TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
  type TaskProvisioningDiagnosticsCapabilityGatePort,
} from './task-provisioning-diagnostics-deployment-gate.port';
import { TaskProvisioningDiagnosticsService } from './task-provisioning-diagnostics.service';

const ACCESS_DENIED_ERROR = Object.freeze({
  statusCode: 403,
  error: 'Forbidden',
  message: 'Task provisioning diagnostics access is denied.',
});

const NOT_FOUND_ERROR = Object.freeze({
  statusCode: 404,
  error: 'Not Found',
  message: 'Task provisioning diagnostics were not found.',
});

const INVALID_REQUEST_ERROR = Object.freeze({
  statusCode: 400,
  error: 'Bad Request',
  message: 'Task provisioning diagnostics request is invalid.',
});

const UNAVAILABLE_ERROR = Object.freeze(
  TaskProvisioningDiagnosticsUnavailableErrorSchema.parse({
    code: 'task_provisioning_diagnostics_unavailable',
    message: 'Task provisioning diagnostics are temporarily unavailable.',
    retryable: true,
  }),
);

/**
 * Session-only Console query boundary.
 *
 * The controller supplies only the resolved session account id. Authorization
 * is rebuilt from the live User row on every call, so a role stored in an old
 * session snapshot can never select the administrator read path. Members use
 * the owner-constrained store query from its very first Task lookup; only a
 * currently-enabled administrator may use the unrestricted canonical read for
 * cross-owner and ownerless historical tasks.
 */
@Injectable()
export class TaskProvisioningDiagnosticsConsoleQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly diagnostics: TaskProvisioningDiagnosticsService,
    @Inject(TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE)
    private readonly capabilityGate: TaskProvisioningDiagnosticsCapabilityGatePort,
  ) {}

  async readForSessionAccount(
    accountId: string,
    taskId: string,
    query: TaskProvisioningDiagnosticsQuery,
  ): Promise<TaskProvisioningDiagnosticsResponse> {
    assertTaskProvisioningDiagnosticsReadOpen(this.capabilityGate);

    let account: { readonly allowed: boolean; readonly role: string } | null;
    try {
      account = await this.prisma.user.findUnique({
        where: { id: accountId },
        select: { allowed: true, role: true },
      });
    } catch {
      throw unavailableError();
    }

    if (
      account === null ||
      account.allowed !== true ||
      (account.role !== 'admin' && account.role !== 'member')
    ) {
      throw new ForbiddenException(ACCESS_DENIED_ERROR);
    }

    let result: Awaited<
      ReturnType<TaskProvisioningDiagnosticsService['readTaskDiagnostics']>
    >;
    try {
      result =
        account.role === 'admin'
          ? await this.diagnostics.readTaskDiagnostics(taskId, query)
          : await this.diagnostics.readOwnedTaskDiagnostics(
              accountId,
              taskId,
              query,
            );
    } catch {
      throw unavailableError();
    }

    // Evidence obtained across a deployment-attestation change is withheld.
    assertTaskProvisioningDiagnosticsReadOpen(this.capabilityGate);
    if (result.ok) return result.value;

    switch (result.code) {
      case 'task_not_found':
        throw new NotFoundException(NOT_FOUND_ERROR);
      case 'invalid_evidence':
        throw new BadRequestException(INVALID_REQUEST_ERROR);
      default:
        throw unavailableError();
    }
  }
}

function unavailableError(): ServiceUnavailableException {
  return new ServiceUnavailableException(UNAVAILABLE_ERROR);
}
