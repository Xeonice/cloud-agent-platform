import {
  SANDBOX_PROVIDER_CAPABILITIES,
  type SandboxProviderCapability,
  type SandboxProviderLocation,
} from '@cap/sandbox-core';

export const DEFAULT_CLOUD_HTTP_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
] as const;

export type ConfiguredSandboxProviderFamily =
  | 'auto'
  | 'aio'
  | 'boxlite'
  | 'control-plane';

export const DEFAULT_BOXLITE_RUNTIME_REQUIRED_TOOLS = [
  'bash',
  'claude',
  'codex',
  'git',
  'gzip',
  'node',
  'openspec',
  'sh',
  'tar',
  'tmux',
] as const;

export function readOptionalEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function readNumberEnv(
  name: string,
  fallback: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = readOptionalEnv(name, env);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readSandboxLocationEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SandboxProviderLocation | undefined {
  const value = readOptionalEnv(name, env);
  return value === 'local' || value === 'cloud' ? value : undefined;
}

export function readSandboxProviderCapabilitiesEnv(
  name: string,
  fallback: readonly SandboxProviderCapability[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly SandboxProviderCapability[] {
  const raw = readOptionalEnv(name, env);
  if (!raw) return fallback;

  if (raw.toLowerCase() === 'all') {
    return SANDBOX_PROVIDER_CAPABILITIES;
  }

  const allowed = new Set<string>(SANDBOX_PROVIDER_CAPABILITIES);
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parsed.length === 0) {
    throw new Error(`${name} must contain at least one sandbox provider capability`);
  }

  const unknown = parsed.filter((entry) => !allowed.has(entry));
  if (unknown.length > 0) {
    throw new Error(
      `${name} contains unknown sandbox provider capabilities: ${unknown.join(', ')}`,
    );
  }

  return [...new Set(parsed)] as SandboxProviderCapability[];
}

export function normalizeConfiguredSandboxProviderFamily(
  raw: string | undefined | null,
): ConfiguredSandboxProviderFamily {
  const value = raw?.trim() || 'auto';
  switch (value) {
    case 'auto':
    case 'aio':
    case 'boxlite':
    case 'control-plane':
      return value;
    case 'control-plane-only':
      return 'control-plane';
    default:
      throw new Error(
        `invalid CAP_SANDBOX_PROVIDER: ${raw} (expected auto|aio|boxlite|control-plane)`,
      );
  }
}

export function readConfiguredSandboxProviderFamily(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfiguredSandboxProviderFamily {
  return normalizeConfiguredSandboxProviderFamily(env.CAP_SANDBOX_PROVIDER);
}

export function providerFamilyAllowsAio(
  family: ConfiguredSandboxProviderFamily,
): boolean {
  return family === 'auto' || family === 'aio';
}

export function providerFamilyAllowsBoxLite(
  family: ConfiguredSandboxProviderFamily,
): boolean {
  return family === 'auto' || family === 'boxlite';
}

export function providerFamilyAllowsCloudHttp(
  family: ConfiguredSandboxProviderFamily,
): boolean {
  return family === 'auto';
}

export function explicitProviderFamilyLabel(
  family: ConfiguredSandboxProviderFamily,
): string | undefined {
  return family === 'auto' ? undefined : family;
}

export function readBoxLiteRuntimeRequiredTools(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  return normalizeBoxLiteRuntimeRequiredTools(
    env.BOXLITE_RUNTIME_REQUIRED_TOOLS ??
      env.CAP_BOXLITE_RUNTIME_REQUIRED_TOOLS,
  );
}

export function normalizeBoxLiteRuntimeRequiredTools(
  raw: string | undefined,
): readonly string[] {
  const value = raw?.trim();
  if (!value) return [...DEFAULT_BOXLITE_RUNTIME_REQUIRED_TOOLS];

  const tools = value
    .split(/[,\s]+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const tool of tools) {
    if (!/^[A-Za-z0-9._+-]+$/.test(tool)) {
      throw new Error(
        `BOXLITE_RUNTIME_REQUIRED_TOOLS contains invalid tool name: ${tool}`,
      );
    }
    if (!out.includes(tool)) out.push(tool);
  }
  return out;
}
