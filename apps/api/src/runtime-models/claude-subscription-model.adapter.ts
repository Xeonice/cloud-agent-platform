import type {
  RuntimeModelAdapterDescriptor,
  RuntimeModelAdapterResult,
} from './runtime-model-catalog.types';
import { sha256Revision } from './runtime-model-catalog.util';
import { assertRuntimeModelAdapterSnapshot } from './runtime-model-adapter-snapshot';
import {
  loadClaudeModelCapabilityManifest,
  type ClaudeModelCapabilityManifest,
} from './claude-model-capability-manifest';

/** Checksum-bound, evidence-only Claude subscription selector subset. */
export class ClaudeSubscriptionModelAdapter
  implements RuntimeModelAdapterDescriptor
{
  readonly runtime = 'claude-code' as const;
  readonly credentialMode = 'subscription' as const;
  readonly source = 'versioned-cli-capabilities' as const;
  readonly completeness = 'supported-subset' as const;
  readonly availabilityEvidence = 'cli-version-verified' as const;
  readonly capacityClass = 'none' as const;
  readonly adapterRevision: string;

  constructor(
    private readonly manifest: ClaudeModelCapabilityManifest =
      loadClaudeModelCapabilityManifest(),
  ) {
    this.adapterRevision = sha256Revision({
      adapter: 'claude-subscription-manifest',
      manifest,
    });
  }

  async discover(
    input: Parameters<RuntimeModelAdapterDescriptor['discover']>[0],
  ): Promise<RuntimeModelAdapterResult> {
    if (
      input.credential.mode !== 'subscription' ||
      input.credential.ownerUserId !== input.ownerUserId
    ) {
      throw new Error('Claude subscription credential is unavailable.');
    }
    assertRuntimeModelAdapterSnapshot(input.environment, 'claude-code');
    const artifact = this.manifest.artifacts.find(
      (candidate) =>
        candidate.cliVersion === input.environment.cliVersion &&
        candidate.cliArtifactChecksum ===
          input.environment.cliArtifactChecksum,
    );
    if (!artifact || artifact.selectors.length === 0) {
      throw new Error('Claude model capability evidence is unavailable.');
    }
    const providerFamily = input.environment.providerFamily;
    if (providerFamily !== 'aio' && providerFamily !== 'boxlite') {
      throw new Error('Claude model capability evidence is unavailable.');
    }
    const selectors = artifact.selectors.filter((selector) =>
      selector.providerSeams.includes(providerFamily),
    );
    if (selectors.length === 0) {
      throw new Error('Claude model capability evidence is unavailable.');
    }
    return {
      defaultModel: null,
      models: selectors.map((selector) => ({
        id: selector.id,
        displayName: selector.displayName,
        isDefault: false,
      })),
    };
  }
}
