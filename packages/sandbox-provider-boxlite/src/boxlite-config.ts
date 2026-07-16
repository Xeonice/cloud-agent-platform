import type {
  SandboxExecutionMode,
  SandboxProviderCapability,
  SandboxProviderLocation,
  SandboxResourceSnapshot,
} from '@cap/sandbox-core';
import {
  DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS,
  SANDBOX_DISK_SIZE_CAPABILITY,
  SANDBOX_DISK_SIZE_GB_MAX,
  SANDBOX_DISK_SIZE_GB_MIN,
  SANDBOX_EXECUTION_MODES,
  SANDBOX_PROVIDER_KNOWN_CAPABILITIES,
  SANDBOX_PROVIDER_LOCATIONS,
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX,
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN,
  resolveSandboxResources,
  snapshotSandboxResources,
} from '@cap/sandbox-core';

export const BOXLITE_SANDBOX_PROVIDER_ID = 'boxlite';
export const BOXLITE_DEFAULT_WORKSPACE_PATH = '/home/gem/workspace';
export const BOXLITE_DEFAULT_SANDBOX_ID_PREFIX = 'cap-boxlite-';
export const BOXLITE_DEFAULT_TIMEOUT_MS = 30_000;
/** Incident-verified capacity that completed the observed large-repo checkout. */
export const BOXLITE_DEFAULT_DISK_SIZE_GB = 5;
export const BOXLITE_DEFAULT_GIT_CLONE_TIMEOUT_MS =
  DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS;
export const BOXLITE_GIT_CLONE_TIMEOUT_MS_MIN =
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN;
export const BOXLITE_GIT_CLONE_TIMEOUT_MS_MAX =
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX;
export const BOXLITE_DEFAULT_PATH_PREFIX = 'default';

export type BoxLiteClientMode = 'rest';
export type BoxLiteProtocolMode = 'native' | 'cap-rest';
export type BoxLiteTerminalMode = 'none' | 'pty';

export interface BoxLiteProviderEnv {
  readonly BOXLITE_ENDPOINT?: string;
  readonly BOXLITE_API_TOKEN?: string;
  readonly BOXLITE_IMAGE?: string;
  readonly BOXLITE_IMAGE_MAP?: string;
  readonly BOXLITE_ROOTFS_PATH?: string;
  readonly BOXLITE_ROOTFS_PATH_MAP?: string;
  readonly BOXLITE_PROVIDER_ID?: string;
  readonly BOXLITE_PROVIDER_PRIORITY?: string;
  readonly BOXLITE_PROVIDER_LOCATION?: string;
  readonly BOXLITE_CAPABILITIES?: string;
  readonly BOXLITE_WORKSPACE_PATH?: string;
  readonly BOXLITE_SANDBOX_ID_PREFIX?: string;
  readonly BOXLITE_SANDBOX_PROXY?: string;
  readonly BOXLITE_SANDBOX_HTTP_PROXY?: string;
  readonly BOXLITE_SANDBOX_HTTPS_PROXY?: string;
  readonly BOXLITE_SANDBOX_NO_PROXY?: string;
  readonly BOXLITE_SANDBOX_MODE?: string;
  readonly BOXLITE_CLIENT_MODE?: string;
  readonly BOXLITE_PROTOCOL_MODE?: string;
  readonly BOXLITE_PATH_PREFIX?: string;
  readonly BOXLITE_TERMINAL_MODE?: string;
  readonly BOXLITE_TIMEOUT_MS?: string;
  readonly BOXLITE_DISK_SIZE_GB?: string;
  readonly BOXLITE_GIT_CLONE_TIMEOUT_MS?: string;
}

export interface BoxLiteProviderConfig {
  readonly providerId: string;
  readonly endpoint: string;
  readonly apiToken: string;
  readonly defaultImage: string;
  readonly imageByRuntime: Readonly<Record<string, string>>;
  readonly defaultRootfsPath: string;
  readonly rootfsPathByRuntime: Readonly<Record<string, string>>;
  readonly priority: number;
  readonly location: SandboxProviderLocation;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly workspacePath: string;
  readonly sandboxIdPrefix: string;
  readonly sandboxEnv: Readonly<Record<string, string>>;
  readonly sandboxMode: SandboxExecutionMode;
  readonly clientMode: BoxLiteClientMode;
  readonly protocolMode: BoxLiteProtocolMode;
  readonly pathPrefix: string;
  readonly terminalMode: BoxLiteTerminalMode;
  /** Deployment fallback used when a managed environment omits diskSizeGb. */
  readonly diskSizeGb: number;
  /** Workspace Git deadline, deliberately separate from timeoutMs. */
  readonly gitCloneTimeoutMs: number;
  /** Short REST/native BoxLite control-plane request timeout only. */
  readonly timeoutMs: number;
}

export type BoxLiteSandboxSource =
  | {
      readonly kind: 'image';
      readonly value: string;
    }
  | {
      readonly kind: 'rootfs';
      readonly value: string;
    };

export type BoxLiteProviderConfigResult =
  | {
      readonly status: 'disabled';
      readonly reason: string;
    }
  | {
      readonly status: 'invalid';
      readonly errors: readonly string[];
    }
  | {
      readonly status: 'valid';
      readonly config: BoxLiteProviderConfig;
    };

export function readBoxLiteProviderConfig(
  env: BoxLiteProviderEnv = process.env,
): BoxLiteProviderConfigResult {
  const endpointRaw = env.BOXLITE_ENDPOINT?.trim();
  if (!endpointRaw) {
    return {
      status: 'disabled',
      reason: 'BOXLITE_ENDPOINT is not set',
    };
  }

  const errors: string[] = [];
  const endpoint = parseEndpoint(endpointRaw, errors);
  const apiToken = requireNonEmpty(env.BOXLITE_API_TOKEN, 'BOXLITE_API_TOKEN', errors);
  const imageByRuntime = parseImageMap(env.BOXLITE_IMAGE_MAP, errors);
  const rootfsPathByRuntime = parsePathMap(env.BOXLITE_ROOTFS_PATH_MAP, 'BOXLITE_ROOTFS_PATH_MAP', errors);
  const defaultImage =
    nonEmpty(env.BOXLITE_IMAGE) ?? imageByRuntime.default ?? '';
  const defaultRootfsPath =
    nonEmpty(env.BOXLITE_ROOTFS_PATH) ?? rootfsPathByRuntime.default ?? '';

  const providerId =
    nonEmpty(env.BOXLITE_PROVIDER_ID) ?? BOXLITE_SANDBOX_PROVIDER_ID;
  const priority = parseInteger(
    env.BOXLITE_PROVIDER_PRIORITY,
    0,
    'BOXLITE_PROVIDER_PRIORITY',
    errors,
  );
  const timeoutMs = parsePositiveInteger(
    env.BOXLITE_TIMEOUT_MS,
    BOXLITE_DEFAULT_TIMEOUT_MS,
    'BOXLITE_TIMEOUT_MS',
    errors,
  );
  const diskSizeGb = parseStrictBoundedInteger(
    env.BOXLITE_DISK_SIZE_GB,
    BOXLITE_DEFAULT_DISK_SIZE_GB,
    'BOXLITE_DISK_SIZE_GB',
    SANDBOX_DISK_SIZE_GB_MIN,
    SANDBOX_DISK_SIZE_GB_MAX,
    errors,
  );
  const gitCloneTimeoutMs = parseStrictBoundedInteger(
    env.BOXLITE_GIT_CLONE_TIMEOUT_MS,
    BOXLITE_DEFAULT_GIT_CLONE_TIMEOUT_MS,
    'BOXLITE_GIT_CLONE_TIMEOUT_MS',
    BOXLITE_GIT_CLONE_TIMEOUT_MS_MIN,
    BOXLITE_GIT_CLONE_TIMEOUT_MS_MAX,
    errors,
  );
  const location = parseLocation(env.BOXLITE_PROVIDER_LOCATION, errors);
  const sandboxMode = parseSandboxMode(env.BOXLITE_SANDBOX_MODE, errors);
  const clientMode = parseClientMode(env.BOXLITE_CLIENT_MODE, errors);
  const protocolMode = parseProtocolMode(env.BOXLITE_PROTOCOL_MODE, errors);
  const pathPrefix =
    env.BOXLITE_PATH_PREFIX === undefined
      ? BOXLITE_DEFAULT_PATH_PREFIX
      : env.BOXLITE_PATH_PREFIX.trim().replace(/^\/+|\/+$/g, '');
  const terminalMode = parseTerminalMode(env.BOXLITE_TERMINAL_MODE, errors);
  const capabilities = resolveProtocolCapabilities(
    parseCapabilities(env.BOXLITE_CAPABILITIES, errors),
    protocolMode,
    errors,
  );
  const workspacePath =
    nonEmpty(env.BOXLITE_WORKSPACE_PATH) ?? BOXLITE_DEFAULT_WORKSPACE_PATH;
  const sandboxIdPrefix =
    nonEmpty(env.BOXLITE_SANDBOX_ID_PREFIX) ?? BOXLITE_DEFAULT_SANDBOX_ID_PREFIX;
  const sandboxEnv = parseSandboxEnv(env, errors);

  if (!workspacePath.startsWith('/')) {
    errors.push('BOXLITE_WORKSPACE_PATH must be an absolute path');
  }
  validateSandboxSources({
    defaultImage,
    imageByRuntime,
    defaultRootfsPath,
    rootfsPathByRuntime,
    protocolMode,
    errors,
  });
  validateCapabilityCombinations(capabilities, terminalMode, errors);

  if (errors.length > 0) {
    return { status: 'invalid', errors };
  }

  return {
    status: 'valid',
    config: {
      providerId,
      endpoint,
      apiToken,
      defaultImage,
      imageByRuntime,
      defaultRootfsPath,
      rootfsPathByRuntime,
      priority,
      location,
      capabilities,
      workspacePath,
      sandboxIdPrefix,
      sandboxEnv,
      sandboxMode,
      clientMode,
      protocolMode,
      pathPrefix,
      terminalMode,
      diskSizeGb,
      gitCloneTimeoutMs,
      timeoutMs,
    },
  };
}

export function requireBoxLiteProviderConfig(
  env: BoxLiteProviderEnv = process.env,
): BoxLiteProviderConfig {
  const result = readBoxLiteProviderConfig(env);
  if (result.status === 'valid') return result.config;
  if (result.status === 'disabled') {
    throw new Error(result.reason);
  }
  throw new Error(`Invalid BoxLite provider configuration: ${result.errors.join('; ')}`);
}

/**
 * Resolve capacity without consulting mutable process state:
 * managed environment resource > validated deployment config > product default.
 * The final two levels are already collapsed into config.diskSizeGb by the
 * configuration reader.
 */
export function resolveBoxLiteDiskSizeGb(args: {
  readonly config: Pick<BoxLiteProviderConfig, 'diskSizeGb'>;
  readonly resources?: SandboxResourceSnapshot | null;
}): number {
  const resources = snapshotSandboxResources(args.resources);
  return resources?.diskSizeGb ?? args.config.diskSizeGb;
}

export function resolveBoxLiteResourceSnapshot(args: {
  readonly config: Pick<BoxLiteProviderConfig, 'diskSizeGb'>;
  readonly resources?: SandboxResourceSnapshot | null;
}): SandboxResourceSnapshot {
  return resolveSandboxResources({
    explicit: args.resources,
    fallback: { diskSizeGb: args.config.diskSizeGb },
  })!;
}

export function resolveBoxLiteImage(args: {
  readonly config: Pick<BoxLiteProviderConfig, 'defaultImage' | 'imageByRuntime'>;
  readonly runtimeId?: string | null;
}): string {
  const runtimeImage =
    args.runtimeId === null || args.runtimeId === undefined
      ? undefined
      : args.config.imageByRuntime[args.runtimeId];
  return runtimeImage ?? args.config.defaultImage;
}

export function resolveBoxLiteSandboxSource(args: {
  readonly config: Pick<
    BoxLiteProviderConfig,
    'defaultImage' | 'imageByRuntime' | 'defaultRootfsPath' | 'rootfsPathByRuntime'
  >;
  readonly runtimeId?: string | null;
}): BoxLiteSandboxSource {
  const runtimeId = args.runtimeId ?? null;
  const image =
    runtimeId === null
      ? undefined
      : args.config.imageByRuntime[runtimeId];
  const rootfsPath =
    runtimeId === null
      ? undefined
      : args.config.rootfsPathByRuntime[runtimeId];
  const resolvedImage = image ?? args.config.defaultImage;
  const resolvedRootfsPath = rootfsPath ?? args.config.defaultRootfsPath;
  if (resolvedImage && resolvedRootfsPath) {
    throw new Error(
      `BoxLite runtime ${runtimeId ?? 'default'} resolves to both image and rootfs path`,
    );
  }
  if (resolvedRootfsPath) {
    return { kind: 'rootfs', value: resolvedRootfsPath };
  }
  if (resolvedImage) {
    return { kind: 'image', value: resolvedImage };
  }
  throw new Error(`BoxLite runtime ${runtimeId ?? 'default'} has no image or rootfs path`);
}

function parseEndpoint(raw: string, errors: string[]): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push('BOXLITE_ENDPOINT must use http or https');
    }
    return raw.replace(/\/+$/, '');
  } catch {
    errors.push(`BOXLITE_ENDPOINT must be a valid URL, received: ${raw}`);
    return raw;
  }
}

function parseImageMap(
  raw: string | undefined,
  errors: string[],
): Readonly<Record<string, string>> {
  const value = raw?.trim();
  if (!value) return {};
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return sanitizeStringMap(
        parsed,
        'BOXLITE_IMAGE_MAP',
        errors,
      );
    } catch {
      errors.push('BOXLITE_IMAGE_MAP must be valid JSON when it starts with "{"');
      return {};
    }
  }

  const out: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const [runtime, image, ...rest] = entry.split('=');
    if (rest.length > 0 || !runtime?.trim() || !image?.trim()) {
      errors.push(`BOXLITE_IMAGE_MAP entry must be runtime=image, received: ${entry}`);
      continue;
    }
    out[runtime.trim()] = image.trim();
  }
  return out;
}

function parsePathMap(
  raw: string | undefined,
  label: string,
  errors: string[],
): Readonly<Record<string, string>> {
  const parsed = parseStringMap(raw, label, errors);
  for (const [runtime, value] of Object.entries(parsed)) {
    if (!value.startsWith('/')) {
      errors.push(`${label} entry for ${runtime} must be an absolute path`);
    }
  }
  return parsed;
}

function parseStringMap(
  raw: string | undefined,
  label: string,
  errors: string[],
): Readonly<Record<string, string>> {
  const value = raw?.trim();
  if (!value) return {};
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return sanitizeStringMap(parsed, label, errors);
    } catch {
      errors.push(`${label} must be valid JSON when it starts with "{"`);
      return {};
    }
  }

  const out: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const [runtime, mappedValue, ...rest] = entry.split('=');
    if (rest.length > 0 || !runtime?.trim() || !mappedValue?.trim()) {
      errors.push(`${label} entry must be runtime=value, received: ${entry}`);
      continue;
    }
    out[runtime.trim()] = mappedValue.trim();
  }
  return out;
}

function sanitizeStringMap(
  raw: Record<string, unknown>,
  label: string,
  errors: string[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || typeof value !== 'string' || !value.trim()) {
      errors.push(`${label} values must be non-empty strings`);
      continue;
    }
    out[key.trim()] = value.trim();
  }
  return out;
}

function validateSandboxSources(args: {
  readonly defaultImage: string;
  readonly imageByRuntime: Readonly<Record<string, string>>;
  readonly defaultRootfsPath: string;
  readonly rootfsPathByRuntime: Readonly<Record<string, string>>;
  readonly protocolMode: BoxLiteProtocolMode;
  readonly errors: string[];
}): void {
  if (!args.defaultImage && !args.defaultRootfsPath) {
    args.errors.push(
      'BOXLITE_IMAGE/BOXLITE_IMAGE_MAP or BOXLITE_ROOTFS_PATH/BOXLITE_ROOTFS_PATH_MAP must provide a default sandbox source',
    );
  }
  if (args.defaultImage && args.defaultRootfsPath) {
    args.errors.push('BoxLite default sandbox source is ambiguous: set either BOXLITE_IMAGE or BOXLITE_ROOTFS_PATH, not both');
  }
  const runtimes = new Set([
    ...Object.keys(args.imageByRuntime),
    ...Object.keys(args.rootfsPathByRuntime),
  ]);
  for (const runtime of runtimes) {
    if (args.imageByRuntime[runtime] && args.rootfsPathByRuntime[runtime]) {
      args.errors.push(`BoxLite runtime ${runtime} has both image and rootfs path configured`);
    }
  }
  if ((args.defaultRootfsPath || Object.keys(args.rootfsPathByRuntime).length > 0) && args.protocolMode !== 'native') {
    args.errors.push('BOXLITE_ROOTFS_PATH requires BOXLITE_PROTOCOL_MODE=native');
  }
}

function parseSandboxEnv(
  env: BoxLiteProviderEnv,
  errors: string[],
): Readonly<Record<string, string>> {
  const proxy = parseOptionalProxyUrl(
    env.BOXLITE_SANDBOX_PROXY,
    'BOXLITE_SANDBOX_PROXY',
    errors,
  );
  const httpProxy =
    parseOptionalProxyUrl(
      env.BOXLITE_SANDBOX_HTTP_PROXY,
      'BOXLITE_SANDBOX_HTTP_PROXY',
      errors,
    ) ?? proxy;
  const httpsProxy =
    parseOptionalProxyUrl(
      env.BOXLITE_SANDBOX_HTTPS_PROXY,
      'BOXLITE_SANDBOX_HTTPS_PROXY',
      errors,
    ) ?? proxy;
  const noProxy = nonEmpty(env.BOXLITE_SANDBOX_NO_PROXY);
  const sandboxEnv: Record<string, string> = {};
  if (httpProxy) {
    sandboxEnv.HTTP_PROXY = httpProxy;
    sandboxEnv.http_proxy = httpProxy;
  }
  if (httpsProxy) {
    sandboxEnv.HTTPS_PROXY = httpsProxy;
    sandboxEnv.https_proxy = httpsProxy;
  }
  if (noProxy) {
    sandboxEnv.NO_PROXY = noProxy;
    sandboxEnv.no_proxy = noProxy;
  }
  return sandboxEnv;
}

function parseOptionalProxyUrl(
  raw: string | undefined,
  label: string,
  errors: string[],
): string | undefined {
  const value = nonEmpty(raw);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!isSupportedProxyProtocol(url.protocol)) {
      errors.push(
        `${label} must use http, https, socks4, socks4a, socks5, or socks5h`,
      );
    }
    return value;
  } catch {
    errors.push(`${label} must be a valid proxy URL, received: ${value}`);
    return value;
  }
}

function isSupportedProxyProtocol(protocol: string): boolean {
  return (
    protocol === 'http:' ||
    protocol === 'https:' ||
    protocol === 'socks4:' ||
    protocol === 'socks4a:' ||
    protocol === 'socks5:' ||
    protocol === 'socks5h:'
  );
}

function parseCapabilities(
  raw: string | undefined,
  errors: string[],
): readonly SandboxProviderCapability[] {
  const value = raw?.trim();
  if (!value) return [];
  const known = new Set<string>(SANDBOX_PROVIDER_KNOWN_CAPABILITIES);
  const out: SandboxProviderCapability[] = [];
  for (const item of value.split(',')) {
    const capability = item.trim();
    if (!capability) continue;
    if (!known.has(capability)) {
      errors.push(`BOXLITE_CAPABILITIES includes unknown capability: ${capability}`);
      continue;
    }
    if (!out.includes(capability as SandboxProviderCapability)) {
      out.push(capability as SandboxProviderCapability);
    }
  }
  return out;
}

function resolveProtocolCapabilities(
  declared: readonly SandboxProviderCapability[],
  protocolMode: BoxLiteProtocolMode,
  errors: string[],
): readonly SandboxProviderCapability[] {
  if (protocolMode === 'native') {
    return declared.includes(SANDBOX_DISK_SIZE_CAPABILITY)
      ? declared
      : [...declared, SANDBOX_DISK_SIZE_CAPABILITY];
  }
  if (declared.includes(SANDBOX_DISK_SIZE_CAPABILITY)) {
    errors.push(
      'BOXLITE_PROTOCOL_MODE=cap-rest cannot advertise resource.disk-size-gb',
    );
  }
  return declared.filter(
    (capability) => capability !== SANDBOX_DISK_SIZE_CAPABILITY,
  );
}

function validateCapabilityCombinations(
  capabilities: readonly SandboxProviderCapability[],
  terminalMode: BoxLiteTerminalMode,
  errors: string[],
): void {
  const has = (capability: SandboxProviderCapability) =>
    capabilities.includes(capability);
  if (has('terminal.interactive') && !has('terminal.websocket')) {
    errors.push('BOXLITE_CAPABILITIES terminal.interactive requires terminal.websocket');
  }
  if (
    (has('terminal.interactive') || has('terminal.websocket')) &&
    terminalMode !== 'pty'
  ) {
    errors.push('BOXLITE_TERMINAL_MODE must be pty before advertising terminal capabilities');
  }
  if (has('workspace.git.deliver') && !has('command.exec')) {
    errors.push('BOXLITE_CAPABILITIES workspace.git.deliver requires command.exec');
  }
  if (has('workspace.git.materialize') && !has('command.exec')) {
    errors.push('BOXLITE_CAPABILITIES workspace.git.materialize requires command.exec');
  }
  if (has('workspace.archive.transfer') && !has('command.exec')) {
    errors.push('BOXLITE_CAPABILITIES workspace.archive.transfer requires command.exec');
  }
  if (has('transcript.retained-source') && !has('command.exec')) {
    errors.push('BOXLITE_CAPABILITIES transcript.retained-source requires command.exec');
  }
  if (has('transcript.retained-read') && !has('command.exec')) {
    errors.push('BOXLITE_CAPABILITIES transcript.retained-read requires command.exec');
  }
}

function parseLocation(
  raw: string | undefined,
  errors: string[],
): SandboxProviderLocation {
  const value = nonEmpty(raw) ?? 'cloud';
  if ((SANDBOX_PROVIDER_LOCATIONS as readonly string[]).includes(value)) {
    return value as SandboxProviderLocation;
  }
  errors.push(`BOXLITE_PROVIDER_LOCATION must be local or cloud, received: ${value}`);
  return 'cloud';
}

function parseSandboxMode(
  raw: string | undefined,
  errors: string[],
): SandboxExecutionMode {
  const value = nonEmpty(raw) ?? 'workspace-write';
  if ((SANDBOX_EXECUTION_MODES as readonly string[]).includes(value)) {
    return value as SandboxExecutionMode;
  }
  errors.push(`BOXLITE_SANDBOX_MODE must be one of ${SANDBOX_EXECUTION_MODES.join(', ')}`);
  return 'workspace-write';
}

function parseClientMode(raw: string | undefined, errors: string[]): BoxLiteClientMode {
  const value = nonEmpty(raw) ?? 'rest';
  if (value === 'rest') return value;
  errors.push(`BOXLITE_CLIENT_MODE must be rest, received: ${value}`);
  return 'rest';
}

function parseProtocolMode(
  raw: string | undefined,
  errors: string[],
): BoxLiteProtocolMode {
  const value = nonEmpty(raw) ?? 'native';
  if (value === 'native' || value === 'cap-rest') return value;
  errors.push(`BOXLITE_PROTOCOL_MODE must be native or cap-rest, received: ${value}`);
  return 'native';
}

function parseTerminalMode(
  raw: string | undefined,
  errors: string[],
): BoxLiteTerminalMode {
  const value = nonEmpty(raw) ?? 'none';
  if (value === 'none' || value === 'pty') return value;
  errors.push(`BOXLITE_TERMINAL_MODE must be none or pty, received: ${value}`);
  return 'none';
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
  errors: string[],
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    errors.push(`${label} must be an integer, received: ${raw}`);
    return fallback;
  }
  return parsed;
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
  errors: string[],
): number {
  const parsed = parseInteger(raw, fallback, label, errors);
  if (parsed <= 0) {
    errors.push(`${label} must be a positive integer, received: ${raw}`);
    return fallback;
  }
  return parsed;
}

function parseStrictBoundedInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
  errors: string[],
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^[0-9]+$/u.test(value)) {
    errors.push(
      `${label} must be a base-10 integer from ${minimum} to ${maximum}, received: ${raw}`,
    );
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    errors.push(
      `${label} must be an integer from ${minimum} to ${maximum}, received: ${raw}`,
    );
    return fallback;
  }
  return parsed;
}

function requireNonEmpty(
  raw: string | undefined,
  label: string,
  errors: string[],
): string {
  const value = nonEmpty(raw);
  if (!value) {
    errors.push(`${label} must be set`);
    return '';
  }
  return value;
}

function nonEmpty(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}
