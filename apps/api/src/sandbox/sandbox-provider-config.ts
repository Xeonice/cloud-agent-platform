import {
  SANDBOX_PROVIDER_CAPABILITIES,
  type SandboxProviderCapability,
  type SandboxProviderLocation,
} from '@cap/sandbox';

export const DEFAULT_CLOUD_HTTP_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
] as const;

export function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function readNumberEnv(name: string, fallback: number): number {
  const raw = readOptionalEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readSandboxLocationEnv(
  name: string,
): SandboxProviderLocation | undefined {
  const value = readOptionalEnv(name);
  return value === 'local' || value === 'cloud' ? value : undefined;
}

export function readSandboxProviderCapabilitiesEnv(
  name: string,
  fallback: readonly SandboxProviderCapability[],
): readonly SandboxProviderCapability[] {
  const raw = readOptionalEnv(name);
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
