import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { RuntimeModelPreflightError } from './runtime-model-preflight.error';

/**
 * Fallback REST projection for non-Public-V1 controllers.
 *
 * Public V1 handlers consume this exception in their operation-aware contract
 * interceptor first, so this global fallback cannot bypass operation.errors or
 * the registry-owned REST projector.
 */
@Catch(RuntimeModelPreflightError)
export class RuntimeModelHttpExceptionFilter
  implements ExceptionFilter<RuntimeModelPreflightError>
{
  catch(exception: RuntimeModelPreflightError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const error = exception.domainError;
    const status =
      error.code === 'runtime_model_not_available' ? 422 : 503;
    if (error.code === 'runtime_model_catalog_unavailable' && error.capacity) {
      response.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil(error.capacity.retryAfterMs / 1_000))),
      );
    }
    response.status(status).json(error);
  }
}
