import type {
  SandboxExecutionMode,
  SandboxProviderCapability,
  SandboxProviderLocation,
} from '@cap/sandbox-core';
import {
  SANDBOX_EXECUTION_MODES,
  SANDBOX_PROVIDER_KNOWN_CAPABILITIES,
  SANDBOX_PROVIDER_LOCATIONS,
} from '@cap/sandbox-core';

export const BOXLITE_SANDBOX_PROVIDER_ID = 'boxlite';
export const BOXLITE_DEFAULT_WORKSPACE_PATH = '/workspace';
export const BOXLITE_DEFAULT_SANDBOX_ID_PREFIX = 'cap-boxlite-';
export const BOXLITE_DEFAULT_TIMEOUT_MS = 30_000;

export type BoxLiteClientMode = 'rest';
export type BoxLiteTerminalMode = 'none' | 'pty';

export interface BoxLiteProviderEnv {
  readonly BOXLITE_ENDPOINT?: string;
  readonly BOXLITE_API_TOKEN?: string;
  readonly BOXLITE_IMAGE?: string;
  readonly BOXLITE_IMAGE_MAP?: string;
  readonly BOXLITE_PROVIDER_ID?: string;
  readonly BOXLITE_PROVIDER_PRIORITY?: string;
  readonly BOXLITE_PROVIDER_LOCATION?: string;
  readonly BOXLITE_CAPABILITIES?: string;
  readonly BOXLITE_WORKSPACE_PATH?: string;
  readonly BOXLITE_SANDBOX_ID_PREFIX?: string;
  readonly BOXLITE_SANDBOX_MODE?: string;
  readonly BOXLITE_CLIENT_MODE?: string;
  readonly BOXLITE_TERMINAL_MODE?: string;
  readonly BOXLITE_TIMEOUT_MS?: string;
}

export interface BoxLiteProviderConfig {
  readonly providerId: string;
  readonly endpoint: string;
  readonly apiToken: string;
  readonly defaultImage: string;
  readonly imageByRuntime: Readonly<Record<string, string>>;
  readonly priority: number;
  readonly location: SandboxProviderLocation;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly workspacePath: string;
  readonly sandboxIdPrefix: string;
  readonly sandboxMode: SandboxExecutionMode;
  readonly clientMode: BoxLiteClientMode;
  readonly terminalMode: BoxLiteTerminalMode;
  readonly timeoutMs: number;
}

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
  const defaultImage =
    nonEmpty(env.BOXLITE_IMAGE) ?? imageByRuntime.default ?? '';
  if (!defaultImage) {
    errors.push('BOXLITE_IMAGE must be set or BOXLITE_IMAGE_MAP must include a default image');
  }

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
  const location = parseLocation(env.BOXLITE_PROVIDER_LOCATION, errors);
  const sandboxMode = parseSandboxMode(env.BOXLITE_SANDBOX_MODE, errors);
  const clientMode = parseClientMode(env.BOXLITE_CLIENT_MODE, errors);
  const terminalMode = parseTerminalMode(env.BOXLITE_TERMINAL_MODE, errors);
  const capabilities = parseCapabilities(env.BOXLITE_CAPABILITIES, errors);
  const workspacePath =
    nonEmpty(env.BOXLITE_WORKSPACE_PATH) ?? BOXLITE_DEFAULT_WORKSPACE_PATH;
  const sandboxIdPrefix =
    nonEmpty(env.BOXLITE_SANDBOX_ID_PREFIX) ?? BOXLITE_DEFAULT_SANDBOX_ID_PREFIX;

  if (!workspacePath.startsWith('/')) {
    errors.push('BOXLITE_WORKSPACE_PATH must be an absolute path');
  }
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
      priority,
      location,
      capabilities,
      workspacePath,
      sandboxIdPrefix,
      sandboxMode,
      clientMode,
      terminalMode,
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
  if (has('workspace.archive.transfer') && !has('command.exec')) {
    errors.push('BOXLITE_CAPABILITIES workspace.archive.transfer requires command.exec');
  }
  if (has('transcript.retained-source') && !has('command.exec')) {
    errors.push('BOXLITE_CAPABILITIES transcript.retained-source requires command.exec');
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
