import type { Runtime, RuntimeModelCatalogQuery } from '@cap-console/contracts';
import type { SandboxEnvironmentSelection } from '@cap-console/sandbox';
import type {
  EffectiveRuntimeModelPolicy,
  ResolvedRuntimeModelEnvironment,
  RuntimeModelAdapterDescriptor,
  RuntimeModelCredentialMode,
  RuntimeModelCredentialResolution,
} from './runtime-model-catalog.types';

export const RUNTIME_MODEL_ENVIRONMENT_RESOLVER = Symbol(
  'RuntimeModelEnvironmentResolver',
);
export const RUNTIME_MODEL_CREDENTIAL_RESOLVER = Symbol(
  'RuntimeModelCredentialResolver',
);
export const RUNTIME_MODEL_POLICY_RESOLVER = Symbol(
  'RuntimeModelPolicyResolver',
);
export const RUNTIME_MODEL_CATALOG_ADAPTERS = Symbol(
  'RuntimeModelCatalogAdapters',
);
export const RUNTIME_MODEL_DEPLOYMENT_ENVIRONMENT_RESOLVER = Symbol(
  'RuntimeModelDeploymentEnvironmentResolver',
);
export const RUNTIME_MODEL_MANAGED_PROVIDER_RESOLVER = Symbol(
  'RuntimeModelManagedProviderResolver',
);

export interface RuntimeModelEnvironmentResolver {
  resolve(input: {
    readonly ownerUserId: string;
    readonly runtime: Runtime;
    readonly selection: SandboxEnvironmentSelection;
  }): Promise<ResolvedRuntimeModelEnvironment>;
}

export interface RuntimeModelDeploymentEnvironmentResolver {
  resolve(input: {
    readonly ownerUserId: string;
    readonly runtime: Runtime;
  }): Promise<ResolvedRuntimeModelEnvironment>;
}

export interface RuntimeModelManagedProviderResolver {
  resolveProviderId(input: {
    readonly providerFamily: string;
    readonly environmentId: string;
  }): Promise<string>;
}

export interface RuntimeModelCredentialResolver {
  resolve(
    ownerUserId: string,
    runtime: Runtime,
  ): Promise<RuntimeModelCredentialResolution>;
}

export interface RuntimeModelPolicyResolver {
  resolve(input: {
    readonly ownerUserId: string;
    readonly runtime: Runtime;
  }): Promise<EffectiveRuntimeModelPolicy>;
}

export class RuntimeModelAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeModelAdapterDescriptor>();

  constructor(adapters: readonly RuntimeModelAdapterDescriptor[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: RuntimeModelAdapterDescriptor): void {
    if (!SUPPORTED_AUTHORITIES[adapter.runtime][adapter.credentialMode]) {
      throw new Error(
        `Runtime model adapter combination ${adapter.runtime}/${adapter.credentialMode} is unsupported`,
      );
    }
    if (!hasValidAuthorityDescriptor(adapter)) {
      throw new Error(
        `Runtime model adapter authority metadata is invalid for ${adapter.runtime}/${adapter.credentialMode}`,
      );
    }
    const key = adapterKey(adapter.runtime, adapter.credentialMode);
    if (this.adapters.has(key)) {
      throw new Error(
        `Runtime model adapter for ${adapter.runtime}/${adapter.credentialMode} is already registered`,
      );
    }
    this.adapters.set(key, adapter);
  }

  resolve(
    runtime: Runtime,
    credentialMode: RuntimeModelCredentialMode,
  ): RuntimeModelAdapterDescriptor | null {
    return this.adapters.get(adapterKey(runtime, credentialMode)) ?? null;
  }

  keys(): readonly string[] {
    return [...this.adapters.keys()].sort();
  }
}

/**
 * The authority metadata each supported runtime/credential-mode combination must
 * carry, exactly — declared as a TOTAL mapping over runtimes.
 *
 * Previously a chain of `adapter.runtime === '…'` branches with a `return false`
 * tail. That was loud (an unlisted combination threw at registration) but it was
 * loud in the wrong place: introducing a runtime made every one of its
 * combinations invalid and surfaced at boot as "authority metadata is invalid",
 * miles from the omission. Keyed on `Record<Runtime, …>`, the omission is a
 * COMPILE error at this declaration instead.
 *
 * A mode absent from a runtime's entry is an unsupported combination.
 */
const SUPPORTED_AUTHORITIES: Record<
  Runtime,
  Partial<
    Record<
      RuntimeModelCredentialMode,
      Pick<
        RuntimeModelAdapterDescriptor,
        'source' | 'completeness' | 'availabilityEvidence' | 'capacityClass'
      >
    >
  >
> = {
  codex: {
    official: {
      source: 'codex-app-server',
      completeness: 'complete',
      availabilityEvidence: 'account-discovered',
      capacityClass: 'taskless-probe',
    },
    compatible: {
      source: 'compatible-provider',
      completeness: 'complete',
      availabilityEvidence: 'account-discovered',
      capacityClass: 'none',
    },
  },
  'claude-code': {
    subscription: {
      source: 'versioned-cli-capabilities',
      completeness: 'supported-subset',
      availabilityEvidence: 'cli-version-verified',
      capacityClass: 'none',
    },
  },
};

function hasValidAuthorityDescriptor(
  adapter: RuntimeModelAdapterDescriptor,
): boolean {
  const expected = SUPPORTED_AUTHORITIES[adapter.runtime][adapter.credentialMode];
  if (!expected) return false;
  return (
    adapter.source === expected.source &&
    adapter.completeness === expected.completeness &&
    adapter.availabilityEvidence === expected.availabilityEvidence &&
    adapter.capacityClass === expected.capacityClass
  );
}

export function environmentSelectionFromCatalogQuery(
  query: RuntimeModelCatalogQuery,
): SandboxEnvironmentSelection {
  if (query.sandboxEnvironmentId === undefined) {
    return { kind: 'managed-default' };
  }
  if (query.sandboxEnvironmentId === null) {
    return { kind: 'deployment-default' };
  }
  return { kind: 'managed', environmentId: query.sandboxEnvironmentId };
}

function adapterKey(
  runtime: Runtime,
  credentialMode: RuntimeModelCredentialMode,
): string {
  return `${runtime}\u0000${credentialMode}`;
}
