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
  missingCapabilities,
  type SandboxEnvironmentProviderFamily,
  type SandboxProviderCapability,
  type SandboxProviderLocation,
} from '@cap/sandbox-core';
import type { SandboxEnvironmentSourceDescriptor } from '@cap/sandbox-environment';
import { provisionSandboxRequiredCapabilities } from '../provider-center/selection.js';
import {
  DEFAULT_CLOUD_HTTP_CAPABILITIES,
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
            }
          : null,
    });
  }

  const required = provisionSandboxRequiredCapabilities({
    materializeGitWorkspace: false,
  });
  const preferredLocation = locationFromEnv(env, 'CAP_SANDBOX_PREFER_LOCATION');
  const selected = candidates
    .filter((candidate) => missingCapabilities(candidate.capabilities, required).length === 0)
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
