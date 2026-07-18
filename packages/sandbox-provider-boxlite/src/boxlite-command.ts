import type {
  SandboxCommandExecutionRequest,
  SandboxCommandExecutor,
  SandboxProvisioningDiagnosticCommandKind,
  SandboxProvisioningDiagnosticObserver,
} from '@cap/sandbox-core';
import { createSandboxCommandExecutor } from '@cap/sandbox-core';
import type { BoxLiteClient } from './boxlite-client.js';

export function createBoxLiteCommandExecutor(args: {
  readonly client: BoxLiteClient;
  readonly sandboxId: string;
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
}): SandboxCommandExecutor {
  return createSandboxCommandExecutor((request: SandboxCommandExecutionRequest) =>
    args.client.exec({
      sandboxId: args.sandboxId,
      command: request.command,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      cancellationSignal: request.signal,
      diagnostics: args.diagnostics,
      commandKind:
        request.diagnosticDescriptor?.commandKind ?? args.commandKind,
    }),
  );
}
