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
  type AioPtyClientMode,
  type AioResolvedTaskLaunchContext,
} from '@cap/sandbox-provider-aio';
import { createBoxLiteTerminalTransportFactory } from '@cap/sandbox-provider-boxlite';
import { buildSandboxCommandExecutor } from './command-executor.js';
import {
  createTerminalTransportRegistry,
  resolveTerminalDescriptor,
} from '../terminal/transport.js';
import { materializeTaskModel } from './model-material.js';
import { SandboxRuntimeModelSetupError } from '@cap/sandbox-core';

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
  readonly signal?: AbortSignal;
  readonly beforeAgentLaunch?: () => Promise<void>;
  readonly resolveTaskLaunchContext?: () => Promise<AioResolvedTaskLaunchContext>;
  readonly onRuntimeSetupFailure?: (
    code: 'runtime_model_setup_failed',
  ) => void;
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
  const mode = args.mode ?? 'launch-or-attach';
  // Only a fresh launch needs model/runtime material. Startup re-adoption uses
  // attach-only and must be able to probe legacy sessions without manufacturing
  // a launch context that it will never execute.
  if (mode === 'launch-or-attach' && !args.resolveTaskLaunchContext) {
    throw new SandboxRuntimeModelSetupError('launch-context');
  }
  const commandExecutor = buildSandboxCommandExecutor({
    connection: args.connection,
    selectedRun: args.selectedRun,
  });
  return new AioPtyClient(
    taskId,
    wsUrl,
    baseUrl,
    args.onExit,
    mode,
    args.resolveTaskLaunchContext,
    buildSandboxTerminalTransportFactory({
      taskId,
      connection: args.connection,
      selectedRun: args.selectedRun,
    }),
    commandExecutor,
    (intent) => materializeTaskModel(commandExecutor, intent),
    args.onRuntimeSetupFailure,
    args.signal,
    args.beforeAgentLaunch,
  );
}
