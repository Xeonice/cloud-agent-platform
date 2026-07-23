import type {
  SandboxCapabilitySource,
  SandboxConnection,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox-core';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  SANDBOX_REPO_SOURCE_MOUNT_DIR,
  defineLocalSandboxProvider,
} from '@cap/sandbox-core';

export const AIO_LOCAL_SANDBOX_PROVIDER_ID = 'aio-local';
export const AIO_SANDBOX_CONTAINER_PREFIX = 'cap-aio-';
/** Immutable physical-incarnation fence shared with durable sandbox ownership. */
export const AIO_SANDBOX_RESOURCE_GENERATION_LABEL =
  'cap.resourceGeneration';
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

/**
 * Read-only per-repo mount of the shared repo-store volume
 * (add-repo-content-store D4, aio row). `VolumeOptions.Subpath` scopes the
 * mount to ONE repo's bare mirror, so a task can neither write the stored copy
 * nor enumerate other repos' copies. Subpath mounts require Docker Engine >= 26
 * (production and dev are both 29.x, API 1.54).
 */
export interface AioLocalSandboxVolumeMount {
  Type: 'volume';
  Source: string;
  Target: string;
  ReadOnly: true;
  VolumeOptions: {
    Subpath: string;
  };
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
  Mounts?: AioLocalSandboxVolumeMount[];
}

/**
 * Container-side mount point of the task's injected repo copy. Alias of the
 * provider-neutral constant so orchestration and this provider cannot drift.
 */
export const AIO_SANDBOX_REPO_SOURCE_MOUNT_DIR = SANDBOX_REPO_SOURCE_MOUNT_DIR;

/** The repo-copy mount a provision may attach to the sandbox container. */
export interface AioLocalSandboxRepoMount {
  /** Docker named volume holding the repo-store. */
  readonly volumeName: string;
  /** Path of the copy relative to the volume root, e.g. `<repoId>.git`. */
  readonly subpath: string;
  /** Absolute container path the copy is exposed at (read-only). */
  readonly mountPath: string;
}

export interface AioLocalSandboxContainerConfig {
  Image: string;
  name: string;
  Env: string[];
  Labels?: Readonly<Record<string, string>>;
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
  readonly labels?: Readonly<Record<string, string>>;
  /** Repo-copy injection mount; absent keeps the container mount-free. */
  readonly repoMount?: AioLocalSandboxRepoMount | null;
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
      ...(args.labels && Object.keys(args.labels).length > 0
        ? { Labels: { ...args.labels } }
        : {}),
      HostConfig: {
        SecurityOpt: securityOpt,
        ShmSize: AIO_SANDBOX_SHM_SIZE_BYTES,
        AutoRemove: false,
        NetworkMode: config.network,
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '20m', 'max-file': '5' },
        },
        ...(args.repoMount
          ? { Mounts: [buildAioRepoSourceMount(args.repoMount)] }
          : {}),
      },
    },
  };
}

/**
 * Docker mount descriptor for the task's repo copy. Read-only and subpath
 * scoped by construction: the sandbox may read exactly one bare mirror.
 */
export function buildAioRepoSourceMount(
  mount: AioLocalSandboxRepoMount,
): AioLocalSandboxVolumeMount {
  assertAioRepoMountSubpath(mount.subpath);
  if (!mount.volumeName.trim()) {
    throw new Error('AIO repo-store mount requires a volume name');
  }
  if (!mount.mountPath.startsWith('/')) {
    throw new Error('AIO repo-store mount path must be absolute');
  }
  return {
    Type: 'volume',
    Source: mount.volumeName,
    Target: mount.mountPath,
    ReadOnly: true,
    VolumeOptions: { Subpath: mount.subpath },
  };
}

function assertAioRepoMountSubpath(subpath: string): void {
  if (
    subpath.length === 0 ||
    subpath.startsWith('/') ||
    subpath.split('/').includes('..')
  ) {
    throw new Error(
      'AIO repo-store mount subpath must be relative to the volume root without parent segments',
    );
  }
}

function resolveAioSandboxImage(args: {
  readonly configImage: string;
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
}): string {
  if (!args.environment) return args.configImage;
  if (args.environment.sourceKind !== 'aio-docker-image') {
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
    `ORCHESTRATOR_APPROVALS_URL=${normalizeUrlBase(args.approvalsBase)}/internal/sandbox/approvals`,
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
