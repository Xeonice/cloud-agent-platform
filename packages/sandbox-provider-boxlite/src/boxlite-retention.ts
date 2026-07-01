import type { SandboxRetentionPolicy } from '@cap/sandbox-core';
import type { BoxLiteProviderConfig } from './boxlite-config.js';
import type { BoxLiteProvisionedRun } from './boxlite-types.js';

export function buildBoxLiteRetentionPolicy(args: {
  readonly config: BoxLiteProviderConfig;
  readonly run: BoxLiteProvisionedRun;
}): SandboxRetentionPolicy {
  return {
    mode: args.config.capabilities.includes('lifecycle.snapshot')
      ? 'snapshot'
      : args.config.capabilities.includes('lifecycle.sleep')
        ? 'provider-native'
        : 'none',
    retainTranscript: args.config.capabilities.includes('transcript.retained-source'),
    cleanupEligible: true,
    metadata: {
      provider: args.config.providerId,
      sandboxId: args.run.sandbox.id,
    },
  };
}
