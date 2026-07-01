import type {
  SandboxConnection,
  SandboxTerminalEndpointDescriptor,
  SandboxTerminalProtocol,
  SelectedSandboxRun,
  TerminalTransportFactory,
} from '@cap/sandbox-core';

export type {
  TerminalTransport,
  TerminalTransportFactory,
  TerminalTransportFrame,
  TerminalTransportReadyState,
} from '@cap/sandbox-core';

export interface TerminalTransportBuildArgs {
  readonly taskId: string;
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
}

export interface TerminalTransportFactoryContext extends TerminalTransportBuildArgs {
  readonly descriptor: SandboxTerminalEndpointDescriptor;
}

export type TerminalTransportFactoryBuilder = (
  context: TerminalTransportFactoryContext,
) => TerminalTransportFactory;

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

export class TerminalTransportRegistry {
  private readonly builders = new Map<
    string,
    TerminalTransportFactoryBuilder
  >();

  register(
    protocol: SandboxTerminalProtocol,
    builder: TerminalTransportFactoryBuilder,
  ): this {
    this.builders.set(protocol, builder);
    return this;
  }

  build(args: TerminalTransportBuildArgs): TerminalTransportFactory {
    const descriptor = resolveTerminalDescriptor(args);
    const builder = this.builders.get(descriptor.protocol);
    if (!builder) {
      throw new Error(
        `unsupported terminal transport protocol "${descriptor.protocol}" for task ${args.taskId}`,
      );
    }
    return builder({ ...args, descriptor });
  }
}

export function createTerminalTransportRegistry(): TerminalTransportRegistry {
  return new TerminalTransportRegistry();
}
