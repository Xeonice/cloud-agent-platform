export type ConfiguredSandboxProviderFamily =
  | 'auto'
  | 'aio'
  | 'boxlite'
  | 'control-plane';

export function normalizeConfiguredSandboxProviderFamily(
  raw: string | undefined | null,
): ConfiguredSandboxProviderFamily {
  switch (raw?.trim() || 'auto') {
    case 'auto':
    case 'aio':
    case 'boxlite':
    case 'control-plane':
      return raw?.trim() as ConfiguredSandboxProviderFamily || 'auto';
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
