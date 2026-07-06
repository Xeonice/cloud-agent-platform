import type {
  SandboxCapabilitySource,
  SandboxConnection,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox-core';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  defineLocalSandboxProvider,
} from '@cap/sandbox-core';

export const AIO_LOCAL_SANDBOX_PROVIDER_ID = 'aio-local';
export const AIO_SANDBOX_CONTAINER_PREFIX = 'cap-aio-';
export const AIO_SANDBOX_PORT = 8080;
export const AIO_SANDBOX_WORKSPACE_DIR = '/home/gem/workspace';
export const AIO_SANDBOX_CODEX_HOME_DIR = '/home/gem/.codex';
export const AIO_SANDBOX_SECCOMP_UNCONFINED = 'seccomp=unconfined';
export const AIO_SANDBOX_SHM_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
export const AIO_SANDBOX_DEFAULT_NETWORK = 'cap-net';
export const AIO_SANDBOX_DEFAULT_API_PORT = '8080';
export const AIO_SANDBOX_READINESS_TIMEOUT_MS = 60_000;
export const AIO_SANDBOX_TRIM_TIMEOUT_MS = 10_000;
export const AIO_SANDBOX_SESSION_PROBE_TIMEOUT_MS = 5_000;
export const AIO_SANDBOX_SKILL_INSTALL_TIMEOUT_MS = 120_000;

export interface AioLocalSandboxEnv {
  readonly AIO_SANDBOX_IMAGE?: string;
  readonly AIO_SANDBOX_NETWORK?: string;
  readonly AIO_SANDBOX_READINESS_TIMEOUT_MS?: string;
  readonly ORCHESTRATOR_APPROVALS_BASE?: string;
  readonly PORT?: string;
}

export interface AioLocalSandboxConfig {
  readonly image: string;
  readonly network: string;
  readonly readinessTimeoutMs: number;
  readonly approvalsBase: string;
}

export interface AioLocalSandboxHostConfig {
  SecurityOpt: string[];
  ShmSize: number;
  AutoRemove: false;
  NetworkMode: string;
  LogConfig: {
    Type: 'json-file';
    Config: {
      'max-size': string;
      'max-file': string;
    };
  };
}

export interface AioLocalSandboxContainerConfig {
  Image: string;
  name: string;
  Env: string[];
  HostConfig: AioLocalSandboxHostConfig;
}

export interface AioLocalSandboxProvisionSpec {
  readonly taskId: string;
  readonly containerName: string;
  readonly connection: SandboxConnection;
  readonly containerConfig: AioLocalSandboxContainerConfig;
  readonly image: string;
  readonly network: string;
  readonly readinessTimeoutMs: number;
  readonly workspaceDir: string;
}

export interface AioLocalSandboxProviderDescriptorOptions<
  TProvider extends SandboxCapabilitySource,
> {
  readonly id?: string;
  readonly provider: TProvider;
  readonly priority?: number;
  readonly capabilities?: readonly SandboxProviderCapability[];
}

export function defineAioLocalSandboxProvider<
  TProvider extends SandboxCapabilitySource,
>(
  options: AioLocalSandboxProviderDescriptorOptions<TProvider>,
): SandboxProviderDescriptor<TProvider> {
  return defineLocalSandboxProvider({
    id: options.id ?? AIO_LOCAL_SANDBOX_PROVIDER_ID,
    provider: options.provider,
    priority: options.priority,
    capabilities:
      options.capabilities ??
      options.provider.getProviderCapabilities?.() ??
      SANDBOX_PROVIDER_CAPABILITIES,
  });
}

export function readAioLocalSandboxConfig(
  env: AioLocalSandboxEnv = process.env,
): AioLocalSandboxConfig {
  const image = requirePinnedAioSandboxImage(env.AIO_SANDBOX_IMAGE);
  return {
    image,
    network: env.AIO_SANDBOX_NETWORK ?? AIO_SANDBOX_DEFAULT_NETWORK,
    readinessTimeoutMs: readPositiveInteger(
      env.AIO_SANDBOX_READINESS_TIMEOUT_MS,
      AIO_SANDBOX_READINESS_TIMEOUT_MS,
      'AIO_SANDBOX_READINESS_TIMEOUT_MS',
    ),
    approvalsBase: normalizeUrlBase(
      env.ORCHESTRATOR_APPROVALS_BASE ??
        `http://api:${env.PORT ?? AIO_SANDBOX_DEFAULT_API_PORT}`,
    ),
  };
}

export function buildAioLocalSandboxProvisionSpec(args: {
  readonly taskId: string;
  readonly config?: AioLocalSandboxConfig;
  readonly env?: AioLocalSandboxEnv;
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
}): AioLocalSandboxProvisionSpec {
  const config = args.config ?? readAioLocalSandboxConfig(args.env);
  const image = resolveAioSandboxImage({
    configImage: config.image,
    environment: args.environment,
  });
  const containerName = buildAioSandboxContainerName(args.taskId);
  const connection = buildAioSandboxConnection(args.taskId);
  const securityOpt = [AIO_SANDBOX_SECCOMP_UNCONFINED];
  assertAioSeccompUnconfined(securityOpt);
  return {
    taskId: args.taskId,
    containerName,
    connection,
    image,
    network: config.network,
    readinessTimeoutMs: config.readinessTimeoutMs,
    workspaceDir: AIO_SANDBOX_WORKSPACE_DIR,
    containerConfig: {
      Image: image,
      name: containerName,
      Env: buildAioSandboxEnv({
        taskId: args.taskId,
        approvalsBase: config.approvalsBase,
      }),
      HostConfig: {
        SecurityOpt: securityOpt,
        ShmSize: AIO_SANDBOX_SHM_SIZE_BYTES,
        AutoRemove: false,
        NetworkMode: config.network,
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '20m', 'max-file': '5' },
        },
      },
    },
  };
}

function resolveAioSandboxImage(args: {
  readonly configImage: string;
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
}): string {
  if (!args.environment) return args.configImage;
  if (
    args.environment.sourceKind !== 'aio-docker-image' &&
    args.environment.sourceKind !== 'aio-loaded-docker-image'
  ) {
    throw new Error(
      `Sandbox environment ${args.environment.environmentId ?? args.environment.id ?? 'unknown'} source ${args.environment.sourceKind ?? 'unknown'} is not compatible with AIO`,
    );
  }
  return requirePinnedAioSandboxImage(args.environment.sourceRef);
}

export function requirePinnedAioSandboxImage(image: string | undefined): string {
  const value = image?.trim();
  if (!value) {
    throw new Error('AIO_SANDBOX_IMAGE must be set to provision an AIO sandbox container');
  }
  const slash = value.lastIndexOf('/');
  const tagSeparator = value.lastIndexOf(':');
  const hasTag = tagSeparator > slash;
  const tag = hasTag ? value.slice(tagSeparator + 1) : '';
  if (!hasTag || tag === 'latest') {
    throw new Error(
      `AIO_SANDBOX_IMAGE must be a pinned tag (not ':latest' / untagged) for reproducible provisioning, received: ${value}`,
    );
  }
  return value;
}

export function buildAioSandboxContainerName(taskId: string): string {
  return `${AIO_SANDBOX_CONTAINER_PREFIX}${taskId}`;
}

export function buildAioSandboxBaseUrl(taskId: string): string {
  return `http://${buildAioSandboxContainerName(taskId)}:${AIO_SANDBOX_PORT}`;
}

export function buildAioSandboxWsUrl(taskId: string): string {
  return `ws://${buildAioSandboxContainerName(taskId)}:${AIO_SANDBOX_PORT}/v1/shell/ws`;
}

export function buildAioSandboxConnection(taskId: string): SandboxConnection {
  return {
    taskId,
    baseUrl: buildAioSandboxBaseUrl(taskId),
    wsUrl: buildAioSandboxWsUrl(taskId),
  };
}

export function buildAioSandboxEnv(args: {
  readonly taskId: string;
  readonly approvalsBase: string;
}): string[] {
  return [
    `TASK_ID=${args.taskId}`,
    `ORCHESTRATOR_APPROVALS_URL=${normalizeUrlBase(args.approvalsBase)}/v1/approvals`,
  ];
}

export function parseAioTaskIdFromContainerNames(
  names: readonly string[] | undefined,
): string | null {
  for (const raw of names ?? []) {
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    if (
      name.startsWith(AIO_SANDBOX_CONTAINER_PREFIX) &&
      name.length > AIO_SANDBOX_CONTAINER_PREFIX.length
    ) {
      return name.slice(AIO_SANDBOX_CONTAINER_PREFIX.length);
    }
  }
  return null;
}

export function assertAioSeccompUnconfined(securityOpt: readonly string[]): void {
  if (!securityOpt.includes(AIO_SANDBOX_SECCOMP_UNCONFINED)) {
    throw new Error(
      `AIO sandbox container is invalid: HostConfig.SecurityOpt must include '${AIO_SANDBOX_SECCOMP_UNCONFINED}'`,
    );
  }
}

export function normalizeUrlBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function readPositiveInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received: ${raw}`);
  }
  return parsed;
}
