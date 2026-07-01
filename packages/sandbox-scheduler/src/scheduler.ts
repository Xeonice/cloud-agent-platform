import type {
  GitCloneSpec,
  SandboxCapabilitySource,
  SandboxCommandEndpointDescriptor,
  SandboxConnection,
  SandboxPreflightResult,
  SandboxProviderCapability,
  SandboxProviderLocation,
  SandboxRetentionPolicy,
  SandboxTerminalEndpointDescriptor,
  SandboxWorkspaceDescriptor,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import {
  ARCHIVE_WORKSPACE_SANDBOX_FEATURE_CAPABILITIES,
  DELIVERY_SANDBOX_REQUIRED_CAPABILITIES,
  INTERACTIVE_SANDBOX_REQUIRED_CAPABILITIES,
  INTERACTIVE_SANDBOX_FEATURE_CAPABILITIES,
  MATERIALIZED_WORKSPACE_SANDBOX_REQUIRED_CAPABILITIES,
  READOPTION_SANDBOX_REQUIRED_CAPABILITIES,
  RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES,
} from '@cap/sandbox-core';

export type SandboxProviderCompatibility = 'declared' | 'legacy-assumed';

export type { GitCloneSpec, SandboxCapabilitySource } from '@cap/sandbox-core';

export interface SandboxProviderSelection<TProvider extends SandboxCapabilitySource> {
  readonly provider: TProvider;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly compatibility: SandboxProviderCompatibility;
}

export interface SandboxProviderCandidate<TProvider extends SandboxCapabilitySource> {
  readonly id: string;
  readonly provider: TProvider;
  readonly location: SandboxProviderLocation;
  readonly capabilities?: readonly SandboxProviderCapability[];
  readonly priority?: number;
}

export interface SandboxProviderCandidateSelection<
  TProvider extends SandboxCapabilitySource,
> extends SandboxProviderSelection<TProvider> {
  readonly id: string;
  readonly location: SandboxProviderLocation;
  readonly priority: number;
}

export interface SelectSandboxProviderCandidateOptions {
  /**
   * Prefer a local or cloud provider when both satisfy the requirement. Priority
   * still wins first; this only resolves candidates with equal priority.
   */
  readonly preferLocation?: SandboxProviderLocation;
  /**
   * Single-provider legacy adapters may not declare capabilities yet. Keeping
   * this opt-in prevents multi-provider scheduling from silently choosing an
   * unknown backend when explicit cloud/local candidates are configured.
   */
  readonly allowLegacyProvider?: boolean;
  /**
   * Human-readable provider-family constraint from deployment configuration
   * (for example CAP_SANDBOX_PROVIDER=boxlite). Used only for actionable errors.
   */
  readonly explicitProviderFamily?: string;
}

export interface SandboxProvisionPlan<TCloneSpec = GitCloneSpec> {
  readonly cloneSpec: TCloneSpec | null | undefined;
  readonly requiredCapabilities: readonly SandboxProviderCapability[];
  readonly featureCapabilities: readonly SandboxProviderCapability[];
}

export function provisionSandboxRequiredCapabilities(args: {
  readonly materializeGitWorkspace: boolean;
}): readonly SandboxProviderCapability[] {
  return args.materializeGitWorkspace
    ? MATERIALIZED_WORKSPACE_SANDBOX_REQUIRED_CAPABILITIES
    : INTERACTIVE_SANDBOX_REQUIRED_CAPABILITIES;
}

export function provisionSandboxFeatureCapabilities(args: {
  readonly materializeWorkspace: boolean;
  readonly archiveWorkspace?: boolean;
}): readonly SandboxProviderCapability[] {
  const out = new Set<SandboxProviderCapability>(INTERACTIVE_SANDBOX_FEATURE_CAPABILITIES);
  if (args.materializeWorkspace && args.archiveWorkspace === true) {
    for (const capability of ARCHIVE_WORKSPACE_SANDBOX_FEATURE_CAPABILITIES) {
      out.add(capability);
    }
  }
  return [...out];
}

export function buildSandboxProvisionPlan<TCloneSpec>(args: {
  readonly cloneSpec: TCloneSpec | null | undefined;
  readonly archiveWorkspace?: boolean;
}): SandboxProvisionPlan<TCloneSpec> {
  const materializeWorkspace = args.cloneSpec !== null && args.cloneSpec !== undefined;
  return {
    cloneSpec: args.cloneSpec,
    requiredCapabilities: provisionSandboxRequiredCapabilities({
      materializeGitWorkspace: materializeWorkspace,
    }),
    featureCapabilities: provisionSandboxFeatureCapabilities({
      materializeWorkspace,
      archiveWorkspace: args.archiveWorkspace,
    }),
  };
}

export interface BuildSelectedSandboxRunArgs<TProvider extends SandboxCapabilitySource> {
  readonly taskId: string;
  readonly selection: SandboxProviderCandidateSelection<TProvider>;
  readonly connection: SandboxConnection;
  readonly providerSandboxId?: string;
  readonly terminal?: SandboxTerminalEndpointDescriptor;
  readonly command?: SandboxCommandEndpointDescriptor;
  readonly workspace?: SandboxWorkspaceDescriptor;
  readonly retention?: SandboxRetentionPolicy;
  readonly preflight?: SandboxPreflightResult;
}

export function buildSelectedSandboxRun<TProvider extends SandboxCapabilitySource>(
  args: BuildSelectedSandboxRunArgs<TProvider>,
): SelectedSandboxRun<TProvider> {
  return {
    taskId: args.taskId,
    providerId: args.selection.id,
    provider: args.selection.provider,
    providerSandboxId: args.providerSandboxId,
    capabilities: args.selection.capabilities,
    connection: args.connection,
    terminal: args.terminal,
    command: args.command,
    workspace: args.workspace,
    retention: args.retention,
    preflight: args.preflight,
  };
}

/**
 * Backwards-compatible selection for the currently configured single provider.
 *
 * Declared providers are checked fail-closed. Legacy providers with no
 * declaration are allowed through so existing partial adapters and test doubles
 * keep working while real providers move to explicit capability declarations.
 */
export function selectSandboxProvider<TProvider extends SandboxCapabilitySource>(
  provider: TProvider | undefined | null,
  required: readonly SandboxProviderCapability[],
): SandboxProviderSelection<TProvider> {
  return selectConfiguredSandboxProvider(provider, required, {
    allowLegacyProvider: true,
  });
}

export function selectConfiguredSandboxProvider<
  TProvider extends SandboxCapabilitySource,
>(
  provider: TProvider | undefined | null,
  required: readonly SandboxProviderCapability[],
  options: Pick<SelectSandboxProviderCandidateOptions, 'allowLegacyProvider'> = {},
): SandboxProviderSelection<TProvider> {
  if (!provider) {
    throw new Error('No sandbox provider is configured');
  }

  const capabilities = provider.getProviderCapabilities?.();
  if (!capabilities) {
    if (options.allowLegacyProvider) {
      return {
        provider,
        capabilities: [],
        compatibility: 'legacy-assumed',
      };
    }
    throw new Error(
      `Sandbox provider "${provider.getSandboxMode()}" does not declare capabilities`,
    );
  }

  assertCapabilities(provider.getSandboxMode(), capabilities, required);
  return {
    provider,
    capabilities,
    compatibility: 'declared',
  };
}

/**
 * Select among local/cloud provider candidates.
 *
 * Candidates are sorted by priority descending, then optional location
 * preference, then declaration order. A declared candidate missing required
 * capabilities is skipped, while a candidate with no declaration is only
 * eligible when `allowLegacyProvider` is explicitly true.
 */
export function selectSandboxProviderCandidate<
  TProvider extends SandboxCapabilitySource,
>(
  candidates: readonly SandboxProviderCandidate<TProvider>[],
  required: readonly SandboxProviderCapability[],
  options: SelectSandboxProviderCandidateOptions = {},
): SandboxProviderCandidateSelection<TProvider> {
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const priorityDelta = (b.candidate.priority ?? 0) - (a.candidate.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      if (options.preferLocation) {
        const aPreferred = a.candidate.location === options.preferLocation;
        const bPreferred = b.candidate.location === options.preferLocation;
        if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
      }
      return a.index - b.index;
    });

  const rejected: string[] = [];
  for (const { candidate } of ranked) {
    const declared = candidate.capabilities ?? candidate.provider.getProviderCapabilities?.();
    if (!declared) {
      if (options.allowLegacyProvider) {
        return {
          id: candidate.id,
          provider: candidate.provider,
          location: candidate.location,
          priority: candidate.priority ?? 0,
          capabilities: [],
          compatibility: 'legacy-assumed',
        };
      }
      rejected.push(`${candidate.id}: no declared capabilities`);
      continue;
    }

    const missing = missingCapabilities(declared, required);
    if (missing.length > 0) {
      rejected.push(`${candidate.id}: missing ${missing.join(', ')}`);
      continue;
    }

    return {
      id: candidate.id,
      provider: candidate.provider,
      location: candidate.location,
      priority: candidate.priority ?? 0,
      capabilities: declared,
      compatibility: 'declared',
    };
  }

  const family = options.explicitProviderFamily
    ? ` for explicit provider family "${options.explicitProviderFamily}"`
    : '';
  throw new Error(
    rejected.length > 0
      ? `No sandbox provider candidate${family} satisfies required capabilities (${rejected.join('; ')})`
      : `No sandbox provider candidates${family} are configured`,
  );
}

export function selectDeliverySandboxProvider<TProvider extends SandboxCapabilitySource>(
  provider: TProvider | undefined | null,
): SandboxProviderSelection<TProvider> {
  return selectSandboxProvider(provider, DELIVERY_SANDBOX_REQUIRED_CAPABILITIES);
}

export function selectReadoptionSandboxProvider<TProvider extends SandboxCapabilitySource>(
  provider: TProvider | undefined | null,
): SandboxProviderSelection<TProvider> {
  return selectSandboxProvider(provider, READOPTION_SANDBOX_REQUIRED_CAPABILITIES);
}

export function selectRetainedTranscriptSandboxProvider<
  TProvider extends SandboxCapabilitySource,
>(provider: TProvider | undefined | null): SandboxProviderSelection<TProvider> {
  return selectSandboxProvider(provider, RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES);
}

export function missingCapabilities(
  declared: readonly SandboxProviderCapability[],
  required: readonly SandboxProviderCapability[],
): readonly SandboxProviderCapability[] {
  const set = new Set(declared);
  return required.filter((capability) => !hasDeclaredCapability(set, capability));
}

function assertCapabilities(
  providerName: string,
  declared: readonly SandboxProviderCapability[],
  required: readonly SandboxProviderCapability[],
): void {
  const missing = missingCapabilities(declared, required);
  if (missing.length > 0) {
    throw new Error(
      `Sandbox provider "${providerName}" missing required capabilities: ${missing.join(
        ', ',
      )}`,
    );
  }
}

function hasDeclaredCapability(
  declared: ReadonlySet<SandboxProviderCapability>,
  required: SandboxProviderCapability,
): boolean {
  if (declared.has(required)) return true;
  if (
    (required === 'lifecycle.readopt' && declared.has('lifecycle.readoption')) ||
    (required === 'lifecycle.readoption' && declared.has('lifecycle.readopt'))
  ) {
    return true;
  }
  return false;
}
