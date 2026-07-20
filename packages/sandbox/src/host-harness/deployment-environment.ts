import {
  AIO_LOCAL_SANDBOX_PROVIDER_ID,
  readAioLocalSandboxConfig,
} from '@cap/sandbox-provider-aio';
import {
  readBoxLiteProviderConfig,
  resolveBoxLiteSandboxSource,
} from '@cap/sandbox-provider-boxlite';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS,
  assertSandboxProviderSupportsResources,
  missingCapabilities,
  resolveSandboxResources,
  sandboxResourceRequiredCapabilities,
  snapshotSandboxDetachedJobLivenessPolicy,
  snapshotSandboxProvisioningPolicy,
  type SandboxDetachedJobLivenessPolicySnapshot,
  type SandboxEnvironmentProviderFamily,
  type SandboxProvisioningPolicySnapshot,
  type SandboxProviderCapability,
  type SandboxProviderLocation,
  type SandboxResourceSnapshot,
} from '@cap/sandbox-core';
import type { SandboxEnvironmentSourceDescriptor } from '@cap/sandbox-environment';
import { provisionSandboxRequiredCapabilities } from '../provider-center/selection.js';
import {
  DEFAULT_CLOUD_HTTP_CAPABILITIES,
  explicitProviderFamilyLabel,
  providerFamilyAllowsAio,
  providerFamilyAllowsBoxLite,
  providerFamilyAllowsCloudHttp,
  readConfiguredSandboxProviderFamily,
  readNumberEnv,
  readOptionalEnv,
  readSandboxLocationEnv,
  readSandboxProviderCapabilitiesEnv,
} from './config.js';

export interface ConfiguredDeploymentEnvironmentTarget {
  readonly name: string;
  readonly providerId: string;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly source: SandboxEnvironmentSourceDescriptor;
  readonly provisioningPolicy: SandboxProvisioningPolicySnapshot;
}

export interface ConfiguredProviderProvisioningPolicy
  extends SandboxProvisioningPolicySnapshot {
  readonly providerId: string;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly capabilities: readonly SandboxProviderCapability[];
  /**
   * Dual-gate liveness knobs for the detached `workspace_transfer` stage,
   * plumbed through the same deployment-environment path as
   * `gitCloneTimeoutMs`. Absent fields fall back to the sandbox-core
   * defaults (~90s no-progress heartbeat, ~1h absolute cap).
   */
  readonly workspaceTransferLiveness?: SandboxDetachedJobLivenessPolicySnapshot;
}

/** Env knobs governing detached workspace-transfer liveness (design D5). */
export const CAP_SANDBOX_TRANSFER_HEARTBEAT_WINDOW_MS_ENV =
  'CAP_SANDBOX_TRANSFER_HEARTBEAT_WINDOW_MS';
export const CAP_SANDBOX_TRANSFER_ABSOLUTE_CAP_MS_ENV =
  'CAP_SANDBOX_TRANSFER_ABSOLUTE_CAP_MS';

/**
 * Read and validate the deployment's dual-gate transfer-liveness knobs.
 * Validation follows the `snapshotSandboxProvisioningPolicy` min/max pattern
 * (delegated to `snapshotSandboxDetachedJobLivenessPolicy`); out-of-range or
 * non-numeric values fail closed rather than running with an unvalidated gate.
 */
export function readConfiguredWorkspaceTransferLiveness(
  env: NodeJS.ProcessEnv = process.env,
): SandboxDetachedJobLivenessPolicySnapshot {
  const heartbeatWindowMs = optionalIntegerFromEnv(
    env,
    CAP_SANDBOX_TRANSFER_HEARTBEAT_WINDOW_MS_ENV,
  );
  const absoluteCapMs = optionalIntegerFromEnv(
    env,
    CAP_SANDBOX_TRANSFER_ABSOLUTE_CAP_MS_ENV,
  );
  return snapshotSandboxDetachedJobLivenessPolicy({
    ...(heartbeatWindowMs === undefined ? {} : { heartbeatWindowMs }),
    ...(absoluteCapMs === undefined ? {} : { absoluteCapMs }),
  });
}

interface ConfiguredTaskPolicyCandidate
  extends ConfiguredProviderProvisioningPolicy {
  readonly order: number;
  readonly priority: number;
  readonly location: SandboxProviderLocation;
  readonly available: boolean;
}

/**
 * Resolve a managed environment's explicit resources over the configured
 * provider fallback without exposing provider-private config to API callers.
 */
export function resolveConfiguredProviderProvisioningPolicyForFamily(
  args: {
    readonly providerFamily: SandboxEnvironmentProviderFamily;
    readonly resources?: SandboxResourceSnapshot | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredProviderProvisioningPolicy {
  const configuredFamily = readConfiguredSandboxProviderFamily(env);
  const transferLiveness = workspaceTransferLivenessSpread(env);
  if (
    args.providerFamily === 'aio' &&
    providerFamilyAllowsAio(configuredFamily)
  ) {
    readAioLocalSandboxConfig(env);
    const policy = snapshotSandboxProvisioningPolicy({
      resources: resolveSandboxResources({ explicit: args.resources }),
    });
    assertSandboxProviderSupportsResources(
      SANDBOX_PROVIDER_CAPABILITIES,
      policy.resources,
    );
    return Object.freeze({
      providerId: AIO_LOCAL_SANDBOX_PROVIDER_ID,
      providerFamily: 'aio',
      capabilities: SANDBOX_PROVIDER_CAPABILITIES,
      ...policy,
      ...transferLiveness,
    });
  }
  if (
    args.providerFamily === 'boxlite' &&
    providerFamilyAllowsBoxLite(configuredFamily)
  ) {
    const result = readBoxLiteProviderConfig(env);
    if (result.status !== 'valid') {
      throw new Error('Configured BoxLite provider is unavailable.');
    }
    const policy = snapshotSandboxProvisioningPolicy({
      resources: resolveSandboxResources({
        explicit: args.resources,
        fallback: { diskSizeGb: result.config.diskSizeGb },
      }),
      workspaceMaterializationDeadlineMs: result.config.gitCloneTimeoutMs,
    });
    assertSandboxProviderSupportsResources(
      result.config.capabilities,
      policy.resources,
    );
    return Object.freeze({
      providerId: result.config.providerId,
      providerFamily: 'boxlite',
      capabilities: result.config.capabilities,
      ...policy,
      ...transferLiveness,
    });
  }
  throw new Error('Configured provider family is unavailable.');
}

/**
 * Resolve the immutable resource policy for an ordinary task provision.
 *
 * Candidate construction intentionally mirrors createConfiguredSandboxProvider:
 * AIO, cloud HTTP, and BoxLite are included under the same family gates, with
 * the same ids, priorities, locations, and declared capabilities. Unlike the
 * runtime-model deployment target resolver, this path does not require an
 * immutable image source and does require Git workspace materialization.
 */
export function resolveConfiguredTaskProvisioningPolicy(
  args: {
    readonly providerFamily?: SandboxEnvironmentProviderFamily;
    readonly resources?: SandboxResourceSnapshot | null;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredProviderProvisioningPolicy {
  const configuredFamily = readConfiguredSandboxProviderFamily(env);
  const candidates: ConfiguredTaskPolicyCandidate[] = [];
  const pushCandidate = (
    candidate: Omit<ConfiguredTaskPolicyCandidate, 'order'>,
  ): void => {
    candidates.push(Object.freeze({ order: candidates.length, ...candidate }));
  };

  if (providerFamilyAllowsAio(configuredFamily)) {
    const provisioningPolicy = snapshotSandboxProvisioningPolicy({
      resources: resolveSandboxResources({ explicit: args.resources }),
      workspaceMaterializationDeadlineMs:
        DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS,
    });
    try {
      readAioLocalSandboxConfig(env);
      pushCandidate({
        providerId: AIO_LOCAL_SANDBOX_PROVIDER_ID,
        providerFamily: 'aio',
        priority: numberFromEnv(env, 'CAP_SANDBOX_LOCAL_PRIORITY', 10),
        location: 'local',
        capabilities: SANDBOX_PROVIDER_CAPABILITIES,
        available: true,
        ...provisioningPolicy,
      });
    } catch {
      pushCandidate({
        providerId: AIO_LOCAL_SANDBOX_PROVIDER_ID,
        providerFamily: 'aio',
        priority: numberFromEnv(env, 'CAP_SANDBOX_LOCAL_PRIORITY', 10),
        location: 'local',
        capabilities: SANDBOX_PROVIDER_CAPABILITIES,
        available: false,
        ...provisioningPolicy,
      });
    }
  }

  const cloudBaseUrl = stringFromEnv(env, 'CAP_SANDBOX_CLOUD_HTTP_BASE_URL');
  if (cloudBaseUrl && providerFamilyAllowsCloudHttp(configuredFamily)) {
    const provisioningPolicy = snapshotSandboxProvisioningPolicy({
      resources: resolveSandboxResources({ explicit: args.resources }),
      workspaceMaterializationDeadlineMs:
        DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS,
    });
    pushCandidate({
      providerId:
        stringFromEnv(env, 'CAP_SANDBOX_CLOUD_HTTP_ID') ?? 'cloud-http',
      providerFamily: 'cloud-http',
      priority: numberFromEnv(env, 'CAP_SANDBOX_CLOUD_HTTP_PRIORITY', 50),
      location: 'cloud',
      capabilities: capabilitiesFromEnv(
        env,
        'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
        DEFAULT_CLOUD_HTTP_CAPABILITIES,
      ),
      available: true,
      ...provisioningPolicy,
    });
  }

  const boxlite = readBoxLiteProviderConfig(env);
  if (configuredFamily === 'boxlite' && boxlite.status !== 'valid') {
    throw new Error('Configured BoxLite provider is unavailable.');
  }
  if (
    boxlite.status === 'valid' &&
    providerFamilyAllowsBoxLite(configuredFamily)
  ) {
    const provisioningPolicy = snapshotSandboxProvisioningPolicy({
      resources: resolveSandboxResources({
        explicit: args.resources,
        fallback: { diskSizeGb: boxlite.config.diskSizeGb },
      }),
      workspaceMaterializationDeadlineMs: boxlite.config.gitCloneTimeoutMs,
    });
    pushCandidate({
      providerId: boxlite.config.providerId,
      providerFamily: 'boxlite',
      priority: boxlite.config.priority,
      location: boxlite.config.location,
      capabilities: boxlite.config.capabilities,
      available: true,
      ...provisioningPolicy,
    });
  }

  const preferredLocation = locationFromEnv(
    env,
    'CAP_SANDBOX_PREFER_LOCATION',
  );
  const requiredBase = provisionSandboxRequiredCapabilities({
    materializeGitWorkspace: true,
  });
  const ranked = candidates
    .filter(
      (candidate) =>
        args.providerFamily === undefined ||
        candidate.providerFamily === args.providerFamily,
    )
    .sort((left, right) => {
      const priority = right.priority - left.priority;
      if (priority !== 0) return priority;
      if (preferredLocation) {
        const leftPreferred = left.location === preferredLocation;
        const rightPreferred = right.location === preferredLocation;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
      }
      return left.order - right.order;
    });
  const rejected: string[] = [];
  for (const candidate of ranked) {
    const required = [
      ...requiredBase,
      ...sandboxResourceRequiredCapabilities(candidate.resources),
    ];
    const missing = missingCapabilities(candidate.capabilities, required);
    if (missing.length > 0) {
      rejected.push(`${candidate.providerId}: missing ${missing.join(', ')}`);
      continue;
    }
    if (!candidate.available) {
      throw new Error(
        `Selected sandbox provider candidate ${candidate.providerId} is unavailable.`,
      );
    }
    const {
      order: _order,
      priority: _priority,
      location: _location,
      available: _available,
      ...policy
    } = candidate;
    return Object.freeze({
      ...policy,
      ...workspaceTransferLivenessSpread(env),
    });
  }

  const family = explicitProviderFamilyLabel(configuredFamily);
  const familyLabel = family ? ` for explicit provider family "${family}"` : '';
  throw new Error(
    rejected.length > 0
      ? `No sandbox provider candidate${familyLabel} satisfies required capabilities (${rejected.join('; ')})`
      : `No sandbox provider candidates${familyLabel} are configured`,
  );
}

export function resolveConfiguredProviderIdForFamily(
  providerFamily: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredFamily = readConfiguredSandboxProviderFamily(env);
  if (providerFamily === 'aio' && providerFamilyAllowsAio(configuredFamily)) {
    // Provisioning still reads the base AIO config for network/readiness even
    // when a managed image overrides its image field.
    readAioLocalSandboxConfig(env);
    return AIO_LOCAL_SANDBOX_PROVIDER_ID;
  }
  if (
    providerFamily === 'boxlite' &&
    providerFamilyAllowsBoxLite(configuredFamily)
  ) {
    const boxlite = readBoxLiteProviderConfig(env);
    if (boxlite.status === 'valid') return boxlite.config.providerId;
  }
  throw new Error('Configured provider family is unavailable.');
}

interface Candidate {
  readonly order: number;
  readonly providerId: string;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly priority: number;
  readonly location: SandboxProviderLocation;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly target: ConfiguredDeploymentEnvironmentTarget | null;
}

/**
 * Resolves the same baseline provider ranking used for a task without managed
 * environment overrides. Provider secrets stay inside provider config readers;
 * only the non-secret image source needed for immutable validation is returned.
 */
export function resolveConfiguredDeploymentEnvironmentTarget(
  runtimeId: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredDeploymentEnvironmentTarget {
  const configuredFamily = readConfiguredSandboxProviderFamily(env);
  if (configuredFamily === 'control-plane') {
    throw new Error('Deployment sandbox provider has no local runtime source.');
  }

  const candidates: Candidate[] = [];
  if (providerFamilyAllowsAio(configuredFamily)) {
    let target: ConfiguredDeploymentEnvironmentTarget | null = null;
    try {
      const config = readAioLocalSandboxConfig(env);
      target = {
        name: 'Deployment AIO',
        providerId: AIO_LOCAL_SANDBOX_PROVIDER_ID,
        providerFamily: 'aio',
        source: { kind: 'aio-docker-image', image: config.image },
        provisioningPolicy: snapshotSandboxProvisioningPolicy({}),
      };
    } catch {
      // Keep the candidate in ranking so a missing selected AIO source fails
      // closed instead of silently switching to a lower-priority provider.
    }
    candidates.push({
      order: candidates.length,
      providerId: AIO_LOCAL_SANDBOX_PROVIDER_ID,
      providerFamily: 'aio',
      priority: numberFromEnv(env, 'CAP_SANDBOX_LOCAL_PRIORITY', 10),
      location: 'local',
      capabilities: SANDBOX_PROVIDER_CAPABILITIES,
      target,
    });
  }

  const cloudBaseUrl = stringFromEnv(env, 'CAP_SANDBOX_CLOUD_HTTP_BASE_URL');
  if (cloudBaseUrl && providerFamilyAllowsCloudHttp(configuredFamily)) {
    candidates.push({
      order: candidates.length,
      providerId: stringFromEnv(env, 'CAP_SANDBOX_CLOUD_HTTP_ID') ?? 'cloud-http',
      providerFamily: 'cloud-http',
      priority: numberFromEnv(env, 'CAP_SANDBOX_CLOUD_HTTP_PRIORITY', 50),
      location: 'cloud',
      capabilities: capabilitiesFromEnv(
        env,
        'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
        DEFAULT_CLOUD_HTTP_CAPABILITIES,
      ),
      // The current cloud-http provider does not expose an immutable runtime
      // source/checksum port, so explicit model selection remains unavailable.
      target: null,
    });
  }

  const boxlite = readBoxLiteProviderConfig(env);
  if (configuredFamily === 'boxlite' && boxlite.status !== 'valid') {
    throw new Error('Configured BoxLite deployment source is unavailable.');
  }
  if (boxlite.status === 'valid' && providerFamilyAllowsBoxLite(configuredFamily)) {
    const source = resolveBoxLiteSandboxSource({
      config: boxlite.config,
      runtimeId,
    });
    candidates.push({
      order: candidates.length,
      providerId: boxlite.config.providerId,
      providerFamily: 'boxlite',
      priority: boxlite.config.priority,
      location: boxlite.config.location,
      capabilities: boxlite.config.capabilities,
      target:
        source.kind === 'image'
          ? {
              name: 'Deployment BoxLite',
              providerId: boxlite.config.providerId,
              providerFamily: 'boxlite',
              source: { kind: 'boxlite-image', image: source.value },
              provisioningPolicy: snapshotSandboxProvisioningPolicy({
                resources: resolveSandboxResources({
                  fallback: { diskSizeGb: boxlite.config.diskSizeGb },
                }),
                workspaceMaterializationDeadlineMs:
                  boxlite.config.gitCloneTimeoutMs,
              }),
            }
          : null,
    });
  }

  const baseRequired = provisionSandboxRequiredCapabilities({
    materializeGitWorkspace: false,
  });
  const preferredLocation = locationFromEnv(env, 'CAP_SANDBOX_PREFER_LOCATION');
  const selected = candidates
    .filter((candidate) => {
      const required = [
        ...baseRequired,
        ...sandboxResourceRequiredCapabilities(
          candidate.target?.provisioningPolicy.resources,
        ),
      ];
      return missingCapabilities(candidate.capabilities, required).length === 0;
    })
    .sort((left, right) => {
      const priority = right.priority - left.priority;
      if (priority !== 0) return priority;
      if (preferredLocation) {
        const leftPreferred = left.location === preferredLocation;
        const rightPreferred = right.location === preferredLocation;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
      }
      return left.order - right.order;
    })[0];
  if (!selected?.target) {
    throw new Error('Deployment provider cannot prove an immutable runtime source.');
  }
  return selected.target;
}

function workspaceTransferLivenessSpread(
  env: NodeJS.ProcessEnv,
): Pick<ConfiguredProviderProvisioningPolicy, 'workspaceTransferLiveness'> {
  const liveness = readConfiguredWorkspaceTransferLiveness(env);
  return Object.keys(liveness).length === 0
    ? {}
    : { workspaceTransferLiveness: liveness };
}

function optionalIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = readOptionalEnv(name, env);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer number of milliseconds`);
  }
  return value;
}

function stringFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return readOptionalEnv(name, env);
}

function numberFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  return readNumberEnv(name, fallback, env);
}

function locationFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): SandboxProviderLocation | undefined {
  return readSandboxLocationEnv(name, env);
}

function capabilitiesFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: readonly SandboxProviderCapability[],
): readonly SandboxProviderCapability[] {
  return readSandboxProviderCapabilitiesEnv(name, fallback, env);
}
