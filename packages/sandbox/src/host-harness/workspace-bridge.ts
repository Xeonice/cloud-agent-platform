import type {
  GitCloneSpec,
  SandboxCommandExecutor,
  SandboxConnection,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
  SandboxWorkspaceDescriptor,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import {
  isSandboxLegacyDeliverWorkspaceArgs,
} from '@cap/sandbox-core';
import {
  AIO_SANDBOX_WORKSPACE_DIR,
  createAioHttpCommandExecutor,
  scrubAioExecSecrets,
} from '@cap/sandbox-provider-aio';
import {
  buildGitCloneCommand,
} from '../workspace/git.js';

interface WorkspaceExecResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface MaterializeSandboxGitWorkspaceArgs {
  readonly baseUrl?: string;
  readonly executor?: SandboxCommandExecutor;
  readonly taskId: string;
  readonly spec: GitCloneSpec;
  readonly workspaceDir: string;
}

export interface DeliverSandboxGitWorkspaceArgs {
  readonly baseUrl?: string;
  readonly executor?: SandboxCommandExecutor;
  readonly taskId: string;
  readonly workspaceDir: string;
  readonly timeoutMs: number;
  readonly deliver: SandboxDeliverWorkspaceArgs;
}

type ConnectionWithWorkspaceDescriptor = SandboxConnection & {
  readonly workspace?: SandboxWorkspaceDescriptor;
};

export interface SandboxWorkspaceBridge {
  readonly descriptor: SandboxWorkspaceDescriptor;
  readonly workspaceDir: string;
  materializeGit(args: {
    readonly taskId: string;
    readonly spec: GitCloneSpec;
  }): Promise<void>;
  deliverGit(args: {
    readonly taskId: string;
    readonly timeoutMs: number;
    readonly deliver: SandboxDeliverWorkspaceArgs;
  }): Promise<SandboxDeliverWorkspaceResult>;
}

export function resolveSandboxWorkspaceDescriptor(args: {
  readonly connection?: SandboxConnection;
  readonly selectedRun?: SelectedSandboxRun | null;
}): SandboxWorkspaceDescriptor {
  return (
    args.selectedRun?.workspace ??
    (args.connection as ConnectionWithWorkspaceDescriptor | undefined)?.workspace ?? {
      mode: 'git',
      path: AIO_SANDBOX_WORKSPACE_DIR,
      git: {
        materialized: true,
        deliverable: true,
      },
    }
  );
}

export function buildSandboxWorkspaceBridge(args: {
  readonly executor: SandboxCommandExecutor;
  readonly descriptor?: SandboxWorkspaceDescriptor;
}): SandboxWorkspaceBridge {
  const descriptor =
    args.descriptor ?? resolveSandboxWorkspaceDescriptor({});
  const workspaceDir = descriptor.path ?? AIO_SANDBOX_WORKSPACE_DIR;
  return {
    descriptor,
    workspaceDir,
    async materializeGit({ taskId, spec }) {
      assertGitMaterializationSupported(descriptor, taskId);
      await materializeSandboxGitWorkspace({
        executor: args.executor,
        taskId,
        spec,
        workspaceDir,
      });
    },
    async deliverGit({ taskId, timeoutMs, deliver }) {
      assertGitDeliverySupported(descriptor, taskId);
      return deliverSandboxGitWorkspaceChanges({
        executor: args.executor,
        taskId,
        workspaceDir,
        timeoutMs,
        deliver,
      });
    },
  };
}

export async function materializeSandboxGitWorkspace(
  args: MaterializeSandboxGitWorkspaceArgs,
): Promise<void> {
  const command = buildGitCloneCommand(args.spec, args.workspaceDir);
  const executor = resolveWorkspaceExecutor(args);
  let result: WorkspaceExecResult;
  try {
    result = await runWorkspaceCommand(executor, command);
  } catch (err) {
    throw new Error(
      `git clone into sandbox for task ${args.taskId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const { exitCode, output } = result;
  if (exitCode !== 0) {
    const scrubbed = scrubAioExecSecrets(output);
    throw new Error(
      `git clone into sandbox for task ${args.taskId} failed: exit_code ${exitCode}` +
        (scrubbed ? ` - ${scrubbed.trim()}` : ''),
    );
  }
}

export async function deliverSandboxGitWorkspaceChanges(
  args: DeliverSandboxGitWorkspaceArgs,
): Promise<SandboxDeliverWorkspaceResult> {
  return {
    hadChanges: false,
    commitSha: null,
    error: isSandboxLegacyDeliverWorkspaceArgs(args.deliver)
      ? 'Legacy raw-header Git delivery is disabled'
      : 'Credentialed delivery requires the provider staged workspace adapter',
  };
}

export async function runSandboxAioShellExec(
  baseUrl: string,
  command: string,
  timeoutMs?: number,
): Promise<WorkspaceExecResult> {
  const result = await createAioHttpCommandExecutor({ baseUrl }).exec({
    command,
    timeoutMs,
  });
  if (
    Number.isNaN(result.exitCode) &&
    result.output.startsWith('/v1/shell/exec responded')
  ) {
    throw new Error(result.output);
  }
  return { exitCode: result.exitCode, output: result.output };
}

function resolveWorkspaceExecutor(args: {
  readonly baseUrl?: string;
  readonly executor?: SandboxCommandExecutor;
}): SandboxCommandExecutor {
  if (args.executor) return args.executor;
  if (args.baseUrl) return createAioHttpCommandExecutor({ baseUrl: args.baseUrl });
  throw new Error('workspace command executor is required');
}

async function runWorkspaceCommand(
  executor: SandboxCommandExecutor,
  command: string,
  timeoutMs?: number,
): Promise<WorkspaceExecResult> {
  const result = await executor.exec({ command, timeoutMs });
  return { exitCode: result.exitCode, output: result.output };
}

function assertGitMaterializationSupported(
  descriptor: SandboxWorkspaceDescriptor,
  taskId: string,
): void {
  if (descriptor.mode === 'git' || descriptor.git?.materialized === true) return;
  throw new Error(
    `workspace for task ${taskId} does not support git materialization`,
  );
}

function assertGitDeliverySupported(
  descriptor: SandboxWorkspaceDescriptor,
  taskId: string,
): void {
  if (descriptor.mode === 'git' || descriptor.git?.deliverable === true) return;
  throw new Error(`workspace for task ${taskId} does not support git delivery`);
}
