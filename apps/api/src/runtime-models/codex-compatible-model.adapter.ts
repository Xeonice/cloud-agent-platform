import { ModelDiscoveryClient } from '../settings/model-discovery.client';
import type {
  RuntimeModelAdapterDescriptor,
  RuntimeModelAdapterResult,
} from './runtime-model-catalog.types';
import { sha256Revision } from './runtime-model-catalog.util';
import { assertRuntimeModelAdapterSnapshot } from './runtime-model-adapter-snapshot';

/** Owner-scoped OpenAI-compatible `/models` adapter using the hardened client. */
export class CodexCompatibleModelAdapter
  implements RuntimeModelAdapterDescriptor
{
  readonly runtime = 'codex' as const;
  readonly credentialMode = 'compatible' as const;
  readonly source = 'compatible-provider' as const;
  readonly completeness = 'complete' as const;
  readonly availabilityEvidence = 'account-discovered' as const;
  readonly capacityClass = 'none' as const;
  readonly adapterRevision = sha256Revision({
    adapter: 'codex-compatible-provider',
    version: 1,
  });

  constructor(private readonly client: ModelDiscoveryClient) {}

  async discover(
    input: Parameters<RuntimeModelAdapterDescriptor['discover']>[0],
  ): Promise<RuntimeModelAdapterResult> {
    if (
      input.credential.mode !== 'compatible' ||
      input.credential.ownerUserId !== input.ownerUserId
    ) {
      throw new Error('Compatible Codex credential is unavailable.');
    }
    assertRuntimeModelAdapterSnapshot(input.environment, 'codex');
    if (input.signal?.aborted || Date.now() >= input.deadlineAt) {
      throw new Error('Compatible Codex model discovery was aborted.');
    }
    const result = await this.client.discover(
      input.credential.baseUrl,
      input.credential.apiKey,
      undefined,
      { signal: input.signal, deadlineAt: input.deadlineAt },
    );
    if (!result.ok) {
      throw new Error('Compatible Codex model discovery failed.');
    }
    return {
      defaultModel: input.credential.effectiveDefaultModel,
      models: result.models.map((id) => ({
        id,
        displayName: id,
        isDefault: id === input.credential.effectiveDefaultModel,
      })),
    };
  }
}
