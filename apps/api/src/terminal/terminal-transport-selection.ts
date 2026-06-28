import type {
  SandboxConnection,
  SandboxTerminalEndpointDescriptor,
  SelectedSandboxRun,
} from '@cap/sandbox';
import { AioTerminalTransport } from './aio-terminal-transport';
import { BoxLiteTerminalTransport } from './boxlite-terminal-transport';
import type { TerminalTransportFactory } from './agent-terminal-pty';

type ConnectionWithTerminalDescriptor = SandboxConnection & {
  readonly terminal?: SandboxTerminalEndpointDescriptor;
};

export function resolveTerminalDescriptor(args: {
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
}): SandboxTerminalEndpointDescriptor {
  return (
    args.selectedRun?.terminal ??
    (args.connection as ConnectionWithTerminalDescriptor).terminal ?? {
      protocol: 'aio-json-v1',
      wsUrl: args.connection.wsUrl,
    }
  );
}

export function buildTerminalTransportFactory(args: {
  readonly taskId: string;
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
}): TerminalTransportFactory {
  const descriptor = resolveTerminalDescriptor(args);
  switch (descriptor.protocol) {
    case 'aio-json-v1': {
      const wsUrl = descriptor.wsUrl ?? descriptor.url ?? args.connection.wsUrl;
      return {
        open: () => new AioTerminalTransport(args.taskId, wsUrl),
      };
    }
    case 'boxlite-v1':
      return {
        open: () => new BoxLiteTerminalTransport(args.taskId, descriptor),
      };
    default:
      throw new Error(
        `unsupported terminal transport protocol "${descriptor.protocol}" for task ${args.taskId}`,
      );
  }
}
