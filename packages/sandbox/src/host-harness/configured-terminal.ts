import type {
  AgentTerminalPty,
  SandboxConnection,
  SelectedSandboxRun,
  TerminalExitStatus,
  TerminalTransportFactory,
} from '@cap/sandbox-core';
import {
  AioPtyClient,
  createAioTerminalTransportFactory,
  type AioExecutionMode,
  type AioPtyClientMode,
  type AioTerminalRuntime,
} from '@cap/sandbox-provider-aio';
import { createBoxLiteTerminalTransportFactory } from '@cap/sandbox-provider-boxlite';
import { buildSandboxCommandExecutor } from './command-executor.js';
import {
  createTerminalTransportRegistry,
  resolveTerminalDescriptor,
} from '../terminal/transport.js';

export interface SandboxTerminalTransportLogger {
  warn(message: string): void;
}

export type SandboxTerminalPtyMode = AioPtyClientMode;
export type SandboxTerminalExitStatus = TerminalExitStatus;

export interface BuildSandboxTerminalTransportFactoryArgs {
  readonly taskId: string;
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
  readonly logger?: SandboxTerminalTransportLogger;
}

export interface OpenSandboxTerminalPtyArgs {
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
  readonly onExit?: (status: TerminalExitStatus) => void;
  readonly mode?: AioPtyClientMode;
  readonly resolveRuntime?: () => Promise<AioTerminalRuntime | undefined>;
  readonly resolveExecutionMode?: () => Promise<
    AioExecutionMode | null | undefined
  >;
}

export { resolveTerminalDescriptor };

const terminalTransports = createTerminalTransportRegistry()
  .register('aio-json-v1', ({ taskId, connection, descriptor }) => {
    const wsUrl = descriptor.wsUrl ?? descriptor.url ?? connection.wsUrl;
    return createAioTerminalTransportFactory({ taskId, wsUrl });
  })
  .register('boxlite-v1', ({ taskId, descriptor }) =>
    createBoxLiteTerminalTransportFactory({ taskId, descriptor }),
  );

export function buildSandboxTerminalTransportFactory(
  args: BuildSandboxTerminalTransportFactoryArgs,
): TerminalTransportFactory {
  return terminalTransports.build(args);
}

export function openSandboxTerminalPty(
  args: OpenSandboxTerminalPtyArgs,
): AgentTerminalPty {
  const { taskId, wsUrl, baseUrl } = args.connection;
  return new AioPtyClient(
    taskId,
    wsUrl,
    baseUrl,
    args.onExit,
    args.mode ?? 'launch-or-attach',
    args.resolveRuntime,
    args.resolveExecutionMode,
    buildSandboxTerminalTransportFactory({
      taskId,
      connection: args.connection,
      selectedRun: args.selectedRun,
    }),
    buildSandboxCommandExecutor({
      connection: args.connection,
      selectedRun: args.selectedRun,
    }),
  );
}
