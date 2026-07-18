import { Controller, ForbiddenException, Get, Param, Query, Req } from '@nestjs/common';
import {
  TaskProvisioningDiagnosticsParamsSchema,
  TaskProvisioningDiagnosticsQuerySchema,
  TaskProvisioningDiagnosticsResponseSchema,
  type TaskProvisioningDiagnosticsQuery,
  type TaskProvisioningDiagnosticsResponse,
} from '@cap/contracts';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import { zodParam, zodQuery } from '../repos/zod-validation.pipe';
import { TaskProvisioningDiagnosticsConsoleQueryService } from './task-provisioning-diagnostics-console-query.service';

/**
 * Session-only Internal Console adapter for the canonical task diagnostics read.
 *
 * The global AuthGuard establishes the principal. This adapter deliberately
 * narrows it to a human session before invoking the Console query service, so an
 * API key, MCP token, legacy shared token, or missing principal cannot inherit
 * the Console-only administrator exception. Ownership and the live enabled-admin
 * recheck belong to the shared Console query service.
 */
@Controller('tasks')
export class TaskProvisioningDiagnosticsConsoleController {
  constructor(
    private readonly diagnostics: TaskProvisioningDiagnosticsConsoleQueryService,
  ) {}

  @Get(':id/provisioning-diagnostics')
  async read(
    @Param(zodParam(TaskProvisioningDiagnosticsParamsSchema))
    params: { id: string },
    @Query(zodQuery(TaskProvisioningDiagnosticsQuerySchema))
    query: TaskProvisioningDiagnosticsQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<TaskProvisioningDiagnosticsResponse> {
    const principal = request.operatorPrincipal;
    const accountId = principal?.user?.id;
    if (
      principal?.kind !== 'session' ||
      typeof accountId !== 'string' ||
      accountId.length === 0
    ) {
      throw new ForbiddenException({
        error: 'session_operator_required',
        message:
          'Task provisioning diagnostics require an authenticated Console session.',
      });
    }

    const response = await this.diagnostics.readForSessionAccount(
      accountId,
      params.id,
      query,
    );
    return TaskProvisioningDiagnosticsResponseSchema.parse(response);
  }
}
