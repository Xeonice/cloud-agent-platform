import type {
  SandboxTerminalEndpointDescriptor,
} from '@cap/sandbox-core';
import type { BoxLiteProviderConfig } from './boxlite-config.js';
import type { BoxLiteProvisionedRun } from './boxlite-types.js';

export function buildBoxLiteTerminalDescriptor(args: {
  readonly config: BoxLiteProviderConfig;
  readonly run: BoxLiteProvisionedRun;
}): SandboxTerminalEndpointDescriptor | null {
  if (
    !args.config.capabilities.includes('terminal.interactive') ||
    args.config.terminalMode !== 'pty'
  ) {
    return null;
  }
  if (!args.run.sandbox.terminalUrl && args.config.protocolMode !== 'native') {
    return null;
  }
  return {
    protocol: 'boxlite-v1',
    wsUrl:
      args.config.protocolMode === 'native'
        ? args.config.endpoint.replace(/^http/, 'ws')
        : args.run.sandbox.terminalUrl,
    metadata: {
      provider: args.config.providerId,
      sandboxId: args.run.sandbox.id,
      endpoint: args.config.endpoint,
      pathPrefix: args.config.pathPrefix,
      workspacePath: args.config.workspacePath,
      protocolMode: args.config.protocolMode,
    },
  };
}
