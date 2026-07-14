import {
  Injectable,
  type ExecutionContext,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  RuntimeModelErrorSchema,
  type PublicV1OperationId,
} from '@cap/contracts';
import type { OperatorPrincipal } from '../auth/operator-principal';
import {
  publicV1HttpExceptionForOperation,
  publicV1OperationIdForHandler,
  type PublicV1Handler,
} from '../public-surface/public-v1-operation';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';
import { principalTrackerKey } from './principal.throttler-guard';
import { RUNTIME_MODEL_CATALOG_THROTTLE_NAME } from './throttler.options';

const RUNTIME_MODEL_CATALOG_OPERATION_ID =
  'runtimeModels.query' satisfies PublicV1OperationId;

interface LimitDetail {
  readonly ttl: number;
  readonly limit: number;
  readonly key: string;
  readonly tracker: string;
  readonly totalHits: number;
  readonly timeToExpire: number;
  readonly isBlocked: boolean;
  readonly timeToBlockExpire: number;
}

/** Independent per-principal throttle for potentially probe-backed catalogs. */
@Injectable()
export class RuntimeModelCatalogThrottleGuard extends ThrottlerGuard {
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter(
      (tier) => tier.name === RUNTIME_MODEL_CATALOG_THROTTLE_NAME,
    );
  }

  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    const handler = context.getHandler() as PublicV1Handler | undefined;
    return (
      handler === undefined ||
      publicV1OperationIdForHandler(handler) !==
        RUNTIME_MODEL_CATALOG_OPERATION_ID
    );
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const principal = req.operatorPrincipal as OperatorPrincipal | undefined;
    return principal
      ? Promise.resolve(principalTrackerKey(principal))
      : super.getTracker(req);
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: LimitDetail,
  ): Promise<void> {
    const retryAfterMs = Math.max(1_000, detail.timeToBlockExpire * 1_000);
    const { res } = this.getRequestResponse(context);
    const domainError = RuntimeModelErrorSchema.parse({
      code: 'runtime_model_catalog_unavailable',
      message: 'Runtime model catalog request capacity is temporarily exhausted.',
      retryable: true,
      capacity: {
        scope: 'principal',
        retryAfterMs,
      },
    });
    throw publicV1HttpExceptionForOperation(
      RUNTIME_MODEL_CATALOG_OPERATION_ID,
      new RuntimeModelPreflightError(domainError),
      res,
    );
  }
}
