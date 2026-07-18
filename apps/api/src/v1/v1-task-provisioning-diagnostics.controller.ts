import { Get, Req } from '@nestjs/common';
import {
  type TaskProvisioningDiagnosticsQuery,
  type TaskProvisioningDiagnosticsResponse,
} from '@cap/contracts';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import {
  PublicV1Controller,
  PublicV1Input,
  PublicV1Operation,
  requirePublicV1OwnerId,
} from '../public-surface/public-v1-operation';
import { TaskProvisioningDiagnosticsPublicQueryService } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-public-query.service';

/** Public owner-only adapter; administrator access belongs to the Console. */
@PublicV1Controller('v1/tasks')
export class V1TaskProvisioningDiagnosticsController {
  constructor(
    private readonly diagnostics: TaskProvisioningDiagnosticsPublicQueryService,
  ) {}

  @Get(':id/provisioning-diagnostics')
  @PublicV1Operation('tasks.provisioningDiagnostics')
  async read(
    @PublicV1Input('params', 'id') taskId: string,
    @PublicV1Input('query') query: TaskProvisioningDiagnosticsQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<TaskProvisioningDiagnosticsResponse> {
    const ownerUserId = requirePublicV1OwnerId(request, this.read);
    return this.diagnostics.readForOwner(ownerUserId, taskId, query);
  }
}
