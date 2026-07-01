import type {
  SandboxCommandEndpointDescriptor,
  SandboxCommandExecutionResult,
  SandboxCommandExecutor,
  SandboxConnection,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import {
  createAioHttpCommandExecutor as createProviderAioHttpCommandExecutor,
  type AioFetch,
} from '@cap/sandbox-provider-aio';

interface ProviderCommandExecutorFactory {
  createCommandExecutor?(sandboxId: string): SandboxCommandExecutor;
}

type ConnectionWithCommandDescriptor = SandboxConnection & {
  readonly command?: SandboxCommandEndpointDescriptor;
};

export function resolveSandboxCommandDescriptor(args: {
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
}): SandboxCommandEndpointDescriptor {
  return (
    args.selectedRun?.command ??
    (args.connection as ConnectionWithCommandDescriptor).command ?? {
      protocol: 'aio-http-exec-v1',
      baseUrl: args.connection.baseUrl,
    }
  );
}

export function buildSandboxCommandExecutor(args: {
  readonly connection: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
  readonly fetchImpl?: typeof fetch;
}): SandboxCommandExecutor {
  const descriptor = resolveSandboxCommandDescriptor(args);
  switch (descriptor.protocol) {
    case 'aio-http-exec-v1':
      return createProviderAioHttpCommandExecutor({
        baseUrl: descriptor.baseUrl ?? args.connection.baseUrl,
        fetch: args.fetchImpl as AioFetch | undefined,
      });
    case 'boxlite-exec-v1': {
      const sandboxId =
        stringMetadataValue(descriptor.metadata?.sandboxId) ??
        args.selectedRun?.providerSandboxId;
      const provider = args.selectedRun?.provider as
        | ProviderCommandExecutorFactory
        | undefined;
      if (sandboxId && provider?.createCommandExecutor) {
        return provider.createCommandExecutor(sandboxId);
      }
      throw new Error(
        `boxlite command executor for task ${args.connection.taskId} requires selected provider executor and sandbox id`,
      );
    }
    default:
      throw new Error(
        `unsupported command executor protocol "${descriptor.protocol}" for task ${args.connection.taskId}`,
      );
  }
}

export function toLegacySandboxExecResult(
  result: SandboxCommandExecutionResult,
): {
  readonly exitCode: number;
  readonly output: string;
} {
  return {
    exitCode: result.exitCode,
    output: result.output,
  };
}

function stringMetadataValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
