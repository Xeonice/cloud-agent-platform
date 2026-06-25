import type {
  SandboxCapabilitySource,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxProviderLocation,
} from '@cap/sandbox-core';
import type {
  SandboxProviderCandidateSelection,
  SelectSandboxProviderCandidateOptions,
} from './scheduler.js';
import { selectSandboxProviderCandidate } from './scheduler.js';

export interface SandboxProviderRegistryListOptions {
  readonly location?: SandboxProviderLocation;
}

export interface SandboxProviderRegistrySnapshot<TProvider extends SandboxCapabilitySource> {
  readonly providers: readonly SandboxProviderDescriptor<TProvider>[];
  readonly local: readonly SandboxProviderDescriptor<TProvider>[];
  readonly cloud: readonly SandboxProviderDescriptor<TProvider>[];
}

/**
 * Provider registry for local/cloud sandbox candidates.
 *
 * This is intentionally pure state: no Nest, Docker, HTTP clients, or cloud SDKs.
 * Apps/adapters register provider descriptors, then scheduling asks the registry
 * for a capability-compatible candidate.
 */
export class SandboxProviderRegistry<TProvider extends SandboxCapabilitySource> {
  private readonly providers = new Map<string, SandboxProviderDescriptor<TProvider>>();

  constructor(initialProviders: readonly SandboxProviderDescriptor<TProvider>[] = []) {
    for (const provider of initialProviders) {
      this.register(provider);
    }
  }

  register(provider: SandboxProviderDescriptor<TProvider>): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Sandbox provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): SandboxProviderDescriptor<TProvider> | undefined {
    return this.providers.get(id);
  }

  list(
    options: SandboxProviderRegistryListOptions = {},
  ): readonly SandboxProviderDescriptor<TProvider>[] {
    const all = [...this.providers.values()];
    return options.location
      ? all.filter((provider) => provider.location === options.location)
      : all;
  }

  snapshot(): SandboxProviderRegistrySnapshot<TProvider> {
    const providers = this.list();
    return {
      providers,
      local: providers.filter((provider) => provider.location === 'local'),
      cloud: providers.filter((provider) => provider.location === 'cloud'),
    };
  }

  select(
    required: readonly SandboxProviderCapability[],
    options: SelectSandboxProviderCandidateOptions = {},
  ): SandboxProviderCandidateSelection<TProvider> {
    return selectSandboxProviderCandidate(this.list(), required, options);
  }
}
