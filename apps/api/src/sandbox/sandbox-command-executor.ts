import {
  buildSandboxCommandLine,
  normalizeSandboxCommandResult,
  type SandboxCommandEndpointDescriptor,
  type SandboxCommandExecutionRequest,
  type SandboxCommandExecutionResult,
  type SandboxCommandExecutor,
  type SandboxConnection,
  type SelectedSandboxRun,
} from '@cap/sandbox';

interface ProviderCommandExecutorFactory {
  createCommandExecutor?(sandboxId: string): SandboxCommandExecutor;
}

export interface AioHttpCommandExecutorOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export function createAioHttpCommandExecutor(
  options: AioHttpCommandExecutorOptions,
): SandboxCommandExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async exec(
      request: SandboxCommandExecutionRequest,
    ): Promise<SandboxCommandExecutionResult> {
      const command = buildSandboxCommandLine(request);
      const res = await fetchImpl(`${options.baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
        signal:
          request.timeoutMs === undefined
            ? undefined
            : AbortSignal.timeout(request.timeoutMs),
      });
      if (!res.ok) {
        return {
          exitCode: Number.NaN,
          output: `/v1/shell/exec responded ${res.status}`,
          stdout: '',
          stderr: `/v1/shell/exec responded ${res.status}`,
          timedOut: false,
        };
      }
      return normalizeSandboxCommandResult(await res.json().catch(() => undefined));
    },
  };
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
      return createAioHttpCommandExecutor({
        baseUrl: descriptor.baseUrl ?? args.connection.baseUrl,
        fetchImpl: args.fetchImpl,
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

export function toLegacySandboxExecResult(result: SandboxCommandExecutionResult): {
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
