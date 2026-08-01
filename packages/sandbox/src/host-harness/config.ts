import type { SandboxProviderFamily } from '@cap-console/contracts';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  type SandboxProviderCapability,
  type SandboxProviderLocation,
} from '@cap-console/sandbox-core';

export const DEFAULT_CLOUD_HTTP_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
] as const;

/**
 * The family-named members of the operator vocabulary, proven by `satisfies`
 * to be a SUBSET of the selectable provider-family vocabulary: an operator can
 * only pin a family that actually exists, and a member here that stops being a
 * provider family is a compile error.
 */
const OPERATOR_SELECTABLE_PROVIDER_FAMILIES = [
  'aio',
  'boxlite',
  'cloud-http',
] as const satisfies readonly SandboxProviderFamily[];

/**
 * The OPERATOR vocabulary for `CAP_SANDBOX_PROVIDER` — what a deployment may
 * write to select provider composition.
 *
 * D14 ruling, recorded in place: this is a DELIBERATE independent declaration,
 * not a derivation from the provider-family vocabulary. `auto` and
 * `control-plane` are operator selections that are not provider families, and
 * a family appears here only once an operator can meaningfully pin it. The two
 * vocabularies are reconciled by the R8 parity gate
 * (`scripts/operator-provider-vocabulary-parity.mjs`) rather than by
 * derivation, so a family that becomes selectable without an operator spelling
 * turns a gate red instead of silently being unnameable.
 */
export const CONFIGURED_SANDBOX_PROVIDER_FAMILIES = [
  'auto',
  ...OPERATOR_SELECTABLE_PROVIDER_FAMILIES,
  'control-plane',
] as const;

export type ConfiguredSandboxProviderFamily =
  (typeof CONFIGURED_SANDBOX_PROVIDER_FAMILIES)[number];

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
  if (
    (CONFIGURED_SANDBOX_PROVIDER_FAMILIES as readonly string[]).includes(value)
  ) {
    return value as ConfiguredSandboxProviderFamily;
  }
  if (value === 'control-plane-only') return 'control-plane';
  throw new Error(
    `invalid CAP_SANDBOX_PROVIDER: ${raw} (expected ${CONFIGURED_SANDBOX_PROVIDER_FAMILIES.join('|')})`,
  );
}

export function readConfiguredSandboxProviderFamily(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfiguredSandboxProviderFamily {
  return normalizeConfiguredSandboxProviderFamily(env.CAP_SANDBOX_PROVIDER);
}

/**
 * ONE total allowance table (design D4): configured operator family → the
 * provider families it admits into composition. This replaces the three
 * `providerFamilyAllows*` boolean predicates — the Nth family no longer costs
 * an Nth function, and because the Record is total over the operator
 * vocabulary, a new configured family without a row here is a compile error
 * rather than an allowance that silently reads as "deny".
 */
export const CONFIGURED_FAMILY_ALLOWED_PROVIDER_FAMILIES: Record<
  ConfiguredSandboxProviderFamily,
  readonly SandboxProviderFamily[]
> = Object.freeze({
  auto: ['aio', 'boxlite', 'cloud-http'],
  aio: ['aio'],
  boxlite: ['boxlite'],
  'cloud-http': ['cloud-http'],
  'control-plane': [],
});

export function configuredFamilyAllowsProviderFamily(
  configured: ConfiguredSandboxProviderFamily,
  providerFamily: SandboxProviderFamily,
): boolean {
  return CONFIGURED_FAMILY_ALLOWED_PROVIDER_FAMILIES[configured].includes(
    providerFamily,
  );
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
