import type {
  SandboxCommandExecutionRequest,
  SandboxCommandExecutor,
} from '@cap/sandbox-core';
import { createSandboxCommandExecutor } from '@cap/sandbox-core';
import type { BoxLiteClient } from './boxlite-client.js';

export function createBoxLiteCommandExecutor(args: {
  readonly client: BoxLiteClient;
  readonly sandboxId: string;
}): SandboxCommandExecutor {
  return createSandboxCommandExecutor((request: SandboxCommandExecutionRequest) =>
    args.client.exec({
      sandboxId: args.sandboxId,
      command: request.command,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    }),
  );
}
