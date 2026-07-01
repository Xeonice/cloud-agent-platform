import type { SandboxProviderCapability } from '@cap/sandbox-core';
import {
  type ConfiguredSandboxProviderFamily,
  readConfiguredSandboxProviderFamily,
} from './config.js';

export type SandboxTerminalStoryProvider = 'auto' | 'aio' | 'boxlite';

const BOXLITE_TERMINAL_STORY_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
  'terminal.interactive',
] as const;

export interface SandboxTerminalStoryReadiness {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly requestedProvider: SandboxTerminalStoryProvider;
  readonly configuredProvider: ConfiguredSandboxProviderFamily;
  readonly providerId: string | null;
  readonly reason: string | null;
  readonly capabilities: readonly SandboxProviderCapability[];
}

export interface ResolveSandboxTerminalStoryReadinessArgs {
  readonly enabled: boolean;
  readonly rawProvider?: string;
  readonly envProvider?: string;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly requiredCapabilities: readonly SandboxProviderCapability[];
  readonly enableEnvName: string;
}

export function resolveSandboxTerminalStoryReadiness(
  args: ResolveSandboxTerminalStoryReadinessArgs,
): SandboxTerminalStoryReadiness {
  const requestedProvider = readSandboxTerminalStoryProvider(
    args.rawProvider ?? args.envProvider,
  );
  const configuredProvider = readConfiguredSandboxProviderFamily();
  if (!args.enabled) {
    return {
      enabled: false,
      ready: false,
      requestedProvider,
      configuredProvider,
      providerId: null,
      reason: `${args.enableEnvName}=1 is required to create provider-backed terminal stories`,
      capabilities: args.capabilities,
    };
  }

  const providerReadiness = validateSandboxTerminalStoryProviderReadiness({
    requestedProvider,
    configuredProvider,
    capabilities: args.capabilities,
    requiredCapabilities: args.requiredCapabilities,
  });
  return {
    enabled: true,
    ready: providerReadiness.ready,
    requestedProvider,
    configuredProvider,
    providerId: providerReadiness.providerId,
    reason: providerReadiness.reason,
    capabilities: args.capabilities,
  };
}

export function readSandboxTerminalStoryProvider(
  raw?: string,
): SandboxTerminalStoryProvider {
  const value = (raw ?? 'auto').trim();
  if (value === 'aio' || value === 'boxlite' || value === 'auto') return value;
  throw new Error(`invalid provider-backed terminal story provider: ${value}`);
}

export function providerMatchesSandboxTerminalStoryRequest(
  requested: SandboxTerminalStoryProvider,
  providerId: string,
): boolean {
  if (requested === 'auto') return true;
  const normalized = providerId.toLowerCase();
  return requested === 'aio'
    ? normalized.includes('aio')
    : normalized.includes('boxlite');
}

function validateSandboxTerminalStoryProviderReadiness(args: {
  readonly requestedProvider: SandboxTerminalStoryProvider;
  readonly configuredProvider: ConfiguredSandboxProviderFamily;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly requiredCapabilities: readonly SandboxProviderCapability[];
}): { ready: boolean; providerId: string | null; reason: string | null } {
  if (args.configuredProvider === 'control-plane') {
    return {
      ready: false,
      providerId: null,
      reason: 'CAP_SANDBOX_PROVIDER=control-plane has no sandbox provider for terminal stories',
    };
  }
  if (!hasAllCapabilities(args.capabilities, args.requiredCapabilities)) {
    return {
      ready: false,
      providerId: null,
      reason: `configured sandbox provider is missing required capabilities: ${missingCapabilities(
        args.capabilities,
        args.requiredCapabilities,
      ).join(', ')}`,
    };
  }
  if (args.requestedProvider === 'aio') {
    if (args.configuredProvider === 'boxlite') {
      return {
        ready: false,
        providerId: null,
        reason: 'provider-backed terminal story requested aio, but CAP_SANDBOX_PROVIDER=boxlite is configured',
      };
    }
    return { ready: true, providerId: 'aio-local', reason: null };
  }
  if (args.requestedProvider === 'boxlite') {
    if (args.configuredProvider !== 'boxlite') {
      return {
        ready: false,
        providerId: null,
        reason: `provider-backed terminal story requested boxlite, but CAP_SANDBOX_PROVIDER=${args.configuredProvider} is configured`,
      };
    }
    const boxLiteReadiness = validateBoxLiteInteractiveTerminalReadiness(
      args.capabilities,
    );
    if (boxLiteReadiness) return boxLiteReadiness;
    return { ready: true, providerId: 'boxlite', reason: null };
  }
  if (args.configuredProvider === 'boxlite') {
    const boxLiteReadiness = validateBoxLiteInteractiveTerminalReadiness(
      args.capabilities,
    );
    if (boxLiteReadiness) return boxLiteReadiness;
    return { ready: true, providerId: 'boxlite', reason: null };
  }
  return { ready: true, providerId: null, reason: null };
}

function validateBoxLiteInteractiveTerminalReadiness(
  capabilities: readonly SandboxProviderCapability[],
): { ready: false; providerId: null; reason: string } | null {
  const missing = missingCapabilities(
    capabilities,
    BOXLITE_TERMINAL_STORY_CAPABILITIES,
  );
  if (missing.length === 0) return null;
  return {
    ready: false,
    providerId: null,
    reason: `configured BoxLite provider is missing required capabilities for interactive terminal stories: ${missing.join(', ')}`,
  };
}

function hasAllCapabilities(
  capabilities: readonly SandboxProviderCapability[],
  required: readonly SandboxProviderCapability[],
): boolean {
  return missingCapabilities(capabilities, required).length === 0;
}

function missingCapabilities(
  capabilities: readonly SandboxProviderCapability[],
  required: readonly SandboxProviderCapability[],
): SandboxProviderCapability[] {
  return required.filter((capability) => !capabilities.includes(capability));
}
