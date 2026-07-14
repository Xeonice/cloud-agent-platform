import {
  Post,
  Req,
} from '@nestjs/common';
import {
  type RuntimeModelCatalog,
  type RuntimeModelCatalogQuery,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import {
  PublicV1Controller,
  PublicV1Input,
  PublicV1Operation,
  requirePublicV1OwnerId,
} from '../public-surface/public-v1-operation';
import { RuntimeModelCatalogService } from '../runtime-models/runtime-model-catalog.service';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';
import { TaskModelCapabilityService } from '../runtime-models/task-model-capability.service';

/** Public/Console shared owner-scoped runtime-model catalog endpoint. */
@PublicV1Controller('v1/runtime-models')
export class V1RuntimeModelsController {
  constructor(
    private readonly catalogs: RuntimeModelCatalogService,
    private readonly capability: TaskModelCapabilityService,
  ) {}

  @Post('query')
  @PublicV1Operation('runtimeModels.query')
  async query(
    @PublicV1Input('body') query: RuntimeModelCatalogQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<RuntimeModelCatalog> {
    const ownerUserId = requirePublicV1OwnerId(req, this.query);
    // Gate before environment resolution or any taskless probe.
    this.capability.assertOpen();
    const result = await this.catalogs.query(ownerUserId, query);
    if (!result.ok) throw new RuntimeModelPreflightError(result.error);
    // Do not return a catalog obtained across an attestation expiry/closure.
    this.capability.assertOpen();
    return result.value;
  }
}
