import type {
  AgentTerminalPty,
  SandboxConnection,
  SelectedSandboxRun,
  TerminalExitStatus,
  TerminalTransportFactory,
  TerminalViewerAttachmentFactory,
} from '@cap-console/sandbox-core';
import {
  createAioTerminalExitStatusResolver,
  createAioTerminalTransportFactory,
  isCompleteAioTerminalOwnershipScope,
  type AioTerminalOwnershipScope,
} from '@cap-console/sandbox-provider-aio';
import { createBoxLiteTerminalTransportFactory } from '@cap-console/sandbox-provider-boxlite';
import { buildSandboxCommandExecutor } from './command-executor.js';
import {
  createTerminalTransportRegistry,
  resolveTerminalDescriptor,
} from '../terminal/transport.js';
import {
  SandboxTerminalSession,
  type SandboxTerminalOwnerRecoveryPolicy,
  type SandboxTerminalSessionMode,
} from '../terminal/session-engine.js';
import type { SandboxResolvedTaskLaunchContext } from '../terminal/runtime.js';
import {
  SandboxTerminalViewerAttachmentFactory,
  type TerminalViewerAttachmentPolicy,
} from '../terminal/viewer-attachment.js';
import { materializeTaskModel } from './model-material.js';
import { SandboxRuntimeModelSetupError } from '@cap-console/sandbox-core';

export interface SandboxTerminalTransportLogger {
  warn(message: string): void;
}

export type SandboxTerminalPtyMode = SandboxTerminalSessionMode;
export type SandboxTerminalExitStatus = TerminalExitStatus;

export interface BuildSandboxTerminalTransportFactoryArgs {
  readonly taskId: string;
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
  readonly logger?: SandboxTerminalTransportLogger;
  readonly enableOpaqueInput?: boolean;
}

export interface OpenSandboxTerminalPtyArgs {
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
  readonly onExit?: (status: TerminalExitStatus) => void;
  readonly mode?: SandboxTerminalSessionMode;
  readonly signal?: AbortSignal;
  readonly beforeAgentLaunch?: () => Promise<void>;
  readonly resolveTaskLaunchContext?: () => Promise<SandboxResolvedTaskLaunchContext>;
  readonly onRuntimeSetupFailure?: (
    code: 'runtime_model_setup_failed',
  ) => void;
  /** Bounded owner-redial policy and identity-free recovery telemetry. */
  readonly ownerRecoveryPolicy?: SandboxTerminalOwnerRecoveryPolicy;
}

export interface BuildSandboxTerminalViewerAttachmentFactoryArgs
  extends BuildSandboxTerminalTransportFactoryArgs {
  readonly policy?: TerminalViewerAttachmentPolicy;
}

export { resolveTerminalDescriptor };

const terminalTransports = createTerminalTransportRegistry()
  .register(
    'aio-json-v1',
    ({ taskId, connection, descriptor, selectedRun, enableOpaqueInput }) => {
      const wsUrl = descriptor.wsUrl ?? descriptor.url ?? connection.wsUrl;
      return createAioTerminalTransportFactory({
        taskId,
        wsUrl,
        baseUrl: connection.baseUrl,
        enableOpaqueInput,
        ownershipScope: resolveAioTerminalOwnershipScope(taskId, selectedRun),
      });
    },
  )
  .register('boxlite-v1', ({ taskId, descriptor }) =>
    createBoxLiteTerminalTransportFactory({ taskId, descriptor }),
  );

export function buildSandboxTerminalTransportFactory(
  args: BuildSandboxTerminalTransportFactoryArgs,
): TerminalTransportFactory {
  return terminalTransports.build(args);
}

function resolveAioTerminalOwnershipScope(
  taskId: string,
  selectedRun: SelectedSandboxRun | null | undefined,
): AioTerminalOwnershipScope | undefined {
  const owner = selectedRun?.owner;
  const providerSandboxId = selectedRun?.providerSandboxId;
  if (
    !owner?.ownership ||
    !providerSandboxId ||
    selectedRun.taskId !== taskId ||
    owner.taskId !== taskId ||
    owner.providerId !== selectedRun.providerId ||
    owner.providerSandboxId !== providerSandboxId
  ) {
    return undefined;
  }
  const scope: AioTerminalOwnershipScope = {
    taskId,
    providerSandboxId,
    ownership: owner.ownership,
  };
  return isCompleteAioTerminalOwnershipScope(scope, taskId)
    ? scope
    : undefined;
}

/**
 * Resolve a repeatable browser-viewer factory from the same provider descriptor
 * as the task owner. Provider endpoint and credential details remain captured
 * below this seam and are never returned to the gateway/browser.
 */
export function buildSandboxTerminalViewerAttachmentFactory(
  args: BuildSandboxTerminalViewerAttachmentFactoryArgs,
): TerminalViewerAttachmentFactory {
  return new SandboxTerminalViewerAttachmentFactory({
    taskId: args.taskId,
    transportFactory: buildSandboxTerminalTransportFactory({
      ...args,
      enableOpaqueInput: true,
    }),
    commandExecutor: buildSandboxCommandExecutor({
      connection: args.connection,
      selectedRun: args.selectedRun,
    }),
    policy: args.policy,
  });
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
  const descriptor = resolveTerminalDescriptor({
    connection: args.connection,
    selectedRun: args.selectedRun,
  });
  const resolveProviderExitStatus =
    descriptor.protocol === 'aio-json-v1'
      ? createAioTerminalExitStatusResolver({ baseUrl })
      : undefined;
  return new SandboxTerminalSession(
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
      // AIO uses its independent management/input socket to detach this
      // owner's exact tmux client when the transport closes. This keeps an API
      // restart or reconnect from leaving a stale attached client behind.
      enableOpaqueInput: descriptor.protocol === 'aio-json-v1',
    }),
    commandExecutor,
    (intent) => materializeTaskModel(commandExecutor, intent),
    args.onRuntimeSetupFailure,
    args.signal,
    args.beforeAgentLaunch,
    resolveProviderExitStatus,
    args.ownerRecoveryPolicy,
  );
}
