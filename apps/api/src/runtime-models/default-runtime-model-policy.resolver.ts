import type { RuntimeModelPolicyResolver } from './runtime-model-catalog.port';
import type { EffectiveRuntimeModelPolicy } from './runtime-model-catalog.types';
import { sha256Revision } from './runtime-model-catalog.util';

const ALLOW_ALL_POLICY = {
  version: 1 as const,
  allow: null,
  deny: [] as readonly string[],
};

/** Explicit allow-all policy until account-scoped model restrictions exist. */
export class DefaultRuntimeModelPolicyResolver
  implements RuntimeModelPolicyResolver
{
  async resolve(): Promise<EffectiveRuntimeModelPolicy> {
    return {
      ...ALLOW_ALL_POLICY,
      revision: sha256Revision(ALLOW_ALL_POLICY),
    };
  }
}
