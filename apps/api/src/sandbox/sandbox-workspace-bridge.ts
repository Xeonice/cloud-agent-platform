import {
  AIO_SANDBOX_WORKSPACE_DIR,
  type SandboxConnection,
  type SandboxWorkspaceDescriptor,
  type SelectedSandboxRun,
  type SandboxCommandExecutor,
} from '@cap/sandbox';
import type { CloneSpec } from './provision-lookup.port';
import type {
  DeliverWorkspaceArgs,
  DeliverWorkspaceResult,
} from './sandbox-provider.port';
import {
  deliverGitWorkspaceChanges,
  materializeGitWorkspace,
} from './aio-workspace';

type ConnectionWithWorkspaceDescriptor = SandboxConnection & {
  readonly workspace?: SandboxWorkspaceDescriptor;
};

export interface SandboxWorkspaceBridge {
  readonly descriptor: SandboxWorkspaceDescriptor;
  readonly workspaceDir: string;
  materializeGit(args: {
    readonly taskId: string;
    readonly spec: CloneSpec;
  }): Promise<void>;
  deliverGit(args: {
    readonly taskId: string;
    readonly timeoutMs: number;
    readonly deliver: DeliverWorkspaceArgs;
  }): Promise<DeliverWorkspaceResult>;
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
      await materializeGitWorkspace({
        executor: args.executor,
        taskId,
        spec,
        workspaceDir,
      });
    },
    async deliverGit({ taskId, timeoutMs, deliver }) {
      assertGitDeliverySupported(descriptor, taskId);
      return deliverGitWorkspaceChanges({
        executor: args.executor,
        taskId,
        workspaceDir,
        timeoutMs,
        deliver,
      });
    },
  };
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
