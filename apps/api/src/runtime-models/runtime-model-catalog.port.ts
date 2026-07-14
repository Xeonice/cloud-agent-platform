import type { Runtime, RuntimeModelCatalogQuery } from '@cap/contracts';
import type { SandboxEnvironmentSelection } from '@cap/sandbox';
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
    if (
      (adapter.runtime === 'codex' && adapter.credentialMode === 'subscription') ||
      (adapter.runtime === 'claude-code' &&
        adapter.credentialMode !== 'subscription')
    ) {
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

function hasValidAuthorityDescriptor(
  adapter: RuntimeModelAdapterDescriptor,
): boolean {
  if (adapter.runtime === 'codex' && adapter.credentialMode === 'official') {
    return (
      adapter.source === 'codex-app-server' &&
      adapter.completeness === 'complete' &&
      adapter.availabilityEvidence === 'account-discovered' &&
      adapter.capacityClass === 'taskless-probe'
    );
  }
  if (adapter.runtime === 'codex' && adapter.credentialMode === 'compatible') {
    return (
      adapter.source === 'compatible-provider' &&
      adapter.completeness === 'complete' &&
      adapter.availabilityEvidence === 'account-discovered' &&
      adapter.capacityClass === 'none'
    );
  }
  if (
    adapter.runtime === 'claude-code' &&
    adapter.credentialMode === 'subscription'
  ) {
    return (
      adapter.source === 'versioned-cli-capabilities' &&
      adapter.completeness === 'supported-subset' &&
      adapter.availabilityEvidence === 'cli-version-verified' &&
      adapter.capacityClass === 'none'
    );
  }
  return false;
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
