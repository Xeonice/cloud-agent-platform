import {
  RuntimeModelErrorSchema,
  TaskModelSelectorSchema,
  type RuntimeModelCatalogQuery,
} from '@cap/contracts';
import { RuntimeModelCatalogService } from './runtime-model-catalog.service';
import type {
  RuntimeModelDomainResult,
  RuntimeModelPreflightSuccess,
} from './runtime-model-catalog.types';

export class RuntimeModelPreflightService {
  constructor(private readonly catalogs: RuntimeModelCatalogService) {}

  async preflight(input: {
    readonly ownerUserId: string;
    readonly query: RuntimeModelCatalogQuery;
    readonly model?: string;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeModelDomainResult<RuntimeModelPreflightSuccess>> {
    if (input.model === undefined) {
      return {
        ok: true,
        value: {
          intent: 'runtime-default',
          model: null,
          executionEnvironmentSnapshot: null,
        },
      };
    }

    const model = TaskModelSelectorSchema.parse(input.model);
    const resolved = await this.catalogs.resolveCatalog(
      input.ownerUserId,
      input.query,
      input.signal,
    );
    if (!resolved.ok) return resolved;
    if (!resolved.value.catalog.models.some((item) => item.id === model)) {
      return {
        ok: false,
        error: RuntimeModelErrorSchema.parse({
          code: 'runtime_model_not_available',
          message: 'The requested runtime model is not available.',
          retryable: false,
          context: {
            runtime: input.query.runtime,
            model,
            ...(Object.prototype.hasOwnProperty.call(
              input.query,
              'sandboxEnvironmentId',
            )
              ? { sandboxEnvironmentId: input.query.sandboxEnvironmentId }
              : {}),
          },
        }),
      };
    }
    return {
      ok: true,
      value: {
        intent: 'explicit',
        model,
        executionEnvironmentSnapshot:
          resolved.value.executionEnvironmentSnapshot,
      },
    };
  }
}
