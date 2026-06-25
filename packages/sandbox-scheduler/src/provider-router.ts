import type {
  GitCloneSpec,
  SandboxConnection,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
  SandboxExecutionMode,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxProviderPort,
  SandboxReadoptionPort,
  SandboxTranscriptSourceBase,
} from '@cap/sandbox-core';
import {
  DELIVERY_SANDBOX_REQUIRED_CAPABILITIES,
  READOPTION_SANDBOX_REQUIRED_CAPABILITIES,
  RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES,
} from '@cap/sandbox-core';
import { SandboxProviderRegistry } from './registry.js';
import type { SelectSandboxProviderCandidateOptions } from './scheduler.js';
import {
  missingCapabilities,
  provisionSandboxRequiredCapabilities,
} from './scheduler.js';

export type RoutableSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> = SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource> &
  {
    getSandboxMode(): string;
    getProviderCapabilities?(): readonly SandboxProviderCapability[];
    listReadoptable?(): Promise<string[]>;
    reattach?(
      taskId: string,
    ): Promise<SandboxConnection | null | undefined> | SandboxConnection | null | undefined;
  };

export type SandboxProviderRouterOptions = SelectSandboxProviderCandidateOptions;

/**
 * Facade over multiple local/cloud sandbox providers.
 *
 * It gives upper layers one provider-shaped object while selection remains
 * capability-based and per operation. A provisioned or reattached task is pinned
 * to the provider that owns it; restart-time reads can probe every compatible
 * provider when ownership is not in memory.
 */
export class SandboxProviderRouter<
    TCloneSpec = GitCloneSpec,
    TRuntimeId = string,
    TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
  >
  implements SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource>,
    SandboxReadoptionPort
{
  private readonly registry: SandboxProviderRegistry<
    RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
  >;
  private readonly owners = new Map<string, string>();

  constructor(
    providers: readonly SandboxProviderDescriptor<
      RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
    >[],
    private readonly options: SandboxProviderRouterOptions = {},
  ) {
    this.registry = new SandboxProviderRegistry(providers);
  }

  getSandboxMode(): SandboxExecutionMode {
    const modes = this.registry.list().map((entry) => entry.provider.getSandboxMode());
    if (modes.includes('danger-full-access')) return 'danger-full-access';
    if (modes.includes('workspace-write')) return 'workspace-write';
    return 'read-only';
  }

  getProviderCapabilities(): readonly SandboxProviderCapability[] {
    const capabilities = new Set<SandboxProviderCapability>();
    for (const entry of this.registry.list()) {
      for (const capability of entry.capabilities) {
        capabilities.add(capability);
      }
    }
    return [...capabilities];
  }

  async provision(ctx: {
    readonly taskId: string;
    readonly cloneSpec?: TCloneSpec | null;
  }): Promise<SandboxConnection> {
    const selected = this.registry.select(
      provisionSandboxRequiredCapabilities({
        materializeGitWorkspace: ctx.cloneSpec !== null && ctx.cloneSpec !== undefined,
      }),
      this.options,
    );
    const connection = await selected.provider.provision(ctx);
    this.owners.set(ctx.taskId, selected.id);
    return connection;
  }

  async teardownSandbox(taskId: string): Promise<void> {
    const owned = this.owner(taskId);
    if (owned) {
      try {
        await owned.provider.teardownSandbox(taskId);
      } finally {
        this.owners.delete(taskId);
      }
      return;
    }

    await Promise.all(
      this.registry.list().map((entry) => entry.provider.teardownSandbox(taskId)),
    );
  }

  async readRolloutFromContainer(
    taskId: string,
    runtimeId?: TRuntimeId | null,
  ): Promise<TTranscriptSource | null> {
    const owned = this.owner(taskId);
    if (owned) {
      return this.supports(owned, RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES)
        ? owned.provider.readRolloutFromContainer(taskId, runtimeId)
        : null;
    }

    for (const entry of this.providersFor(RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES)) {
      const source = await entry.provider.readRolloutFromContainer(taskId, runtimeId);
      if (source) return source;
    }
    return null;
  }

  async sandboxExists(taskId: string): Promise<boolean> {
    const owned = this.owner(taskId);
    if (owned) return owned.provider.sandboxExists(taskId);

    for (const entry of this.registry.list()) {
      if (await entry.provider.sandboxExists(taskId)) return true;
    }
    return false;
  }

  async deliverWorkspaceChanges(
    taskId: string,
    args: SandboxDeliverWorkspaceArgs,
  ): Promise<SandboxDeliverWorkspaceResult> {
    let owned = this.owner(taskId);
    if (!owned) {
      owned = (await this.reattachOwner(taskId))?.owner ?? null;
    }
    if (owned) {
      if (!this.supports(owned, DELIVERY_SANDBOX_REQUIRED_CAPABILITIES)) {
        return {
          hadChanges: false,
          commitSha: null,
          error: `sandbox provider for task ${taskId} does not support workspace delivery`,
        };
      }
      return owned.provider.deliverWorkspaceChanges(taskId, args);
    }

    return {
      hadChanges: false,
      commitSha: null,
      error: `sandbox provider for task ${taskId} is unknown; reattach must succeed before workspace delivery`,
    };
  }

  async listReadoptable(): Promise<string[]> {
    const out = new Set<string>();
    for (const entry of this.providersFor(READOPTION_SANDBOX_REQUIRED_CAPABILITIES)) {
      const taskIds = await entry.provider.listReadoptable?.();
      for (const taskId of taskIds ?? []) out.add(taskId);
    }
    return [...out];
  }

  async reattach(taskId: string): Promise<SandboxConnection | null> {
    const owned = this.owner(taskId);
    if (owned) return (await owned.provider.reattach?.(taskId)) ?? null;

    const reattached = await this.reattachOwner(taskId);
    return reattached?.connection ?? null;
  }

  private async reattachOwner(
    taskId: string,
  ): Promise<{
    readonly owner: SandboxProviderDescriptor<
      RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
    >;
    readonly connection: SandboxConnection;
  } | null> {
    for (const entry of this.registry.list()) {
      if (!this.supports(entry, READOPTION_SANDBOX_REQUIRED_CAPABILITIES)) {
        continue;
      }
      const connection = await entry.provider.reattach?.(taskId);
      if (connection) {
        this.owners.set(taskId, entry.id);
        return { owner: entry, connection };
      }
    }
    return null;
  }

  private owner(
    taskId: string,
  ): SandboxProviderDescriptor<
    RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
  > | null {
    const id = this.owners.get(taskId);
    return id ? this.registry.get(id)! : null;
  }

  private providersFor(
    required: readonly SandboxProviderCapability[],
  ): readonly SandboxProviderDescriptor<
    RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
  >[] {
    return this.registry.list().filter((entry) => this.supports(entry, required));
  }

  private supports(
    provider: SandboxProviderDescriptor<
      RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
    >,
    required: readonly SandboxProviderCapability[],
  ): boolean {
    return missingCapabilities(provider.capabilities, required).length === 0;
  }
}
