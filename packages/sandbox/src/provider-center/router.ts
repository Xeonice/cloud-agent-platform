import type {
  GitCloneSpec,
  SandboxConnection,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
  SandboxExecutionMode,
  SandboxInventoryReconcileInput,
  SandboxInventoryReconcileResult,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxProviderPort,
  SandboxProvisionContext,
  SandboxReadoptionTarget,
  SandboxReadoptionPort,
  SandboxRunOwnerRecord,
  SandboxOwnershipFence,
  SandboxRunCleanupAuthorization,
  SandboxTeardownDisposition,
  SandboxSelectedRunPort,
  SandboxRunOwnerStore,
  SandboxCommandEndpointDescriptor,
  SandboxRetentionPolicy,
  SandboxTerminalEndpointDescriptor,
  SandboxTranscriptSourceBase,
  SandboxWorkspaceDescriptor,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import { randomUUID } from 'node:crypto';
import {
  DELIVERY_SANDBOX_REQUIRED_CAPABILITIES,
  READOPTION_SANDBOX_REQUIRED_CAPABILITIES,
  RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES,
  SandboxCleanupPendingError,
  SandboxRuntimeModelSetupError,
  hasSandboxWorkspaceMaterialization,
  isSandboxLegacyDeliverWorkspaceArgs,
  missingCapabilities,
  resourcesForSandboxProvision,
  sandboxResourceRequiredCapabilities,
  snapshotSandboxProvisionContext,
} from '@cap/sandbox-core';
import { SandboxProviderRegistry } from './registry.js';
import type { SelectSandboxProviderCandidateOptions } from './selection.js';
import {
  provisionSandboxRequiredCapabilities,
} from './selection.js';

export type RoutableSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> = SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource> &
  {
    getSandboxMode(): string;
    getProviderCapabilities?(): readonly SandboxProviderCapability[];
    listReadoptable?(): Promise<string[]>;
    reconcileSandboxInventory?(
      input: SandboxInventoryReconcileInput,
    ): Promise<SandboxInventoryReconcileResult>;
    reattach?(
      taskId: string,
      target?: SandboxReadoptionTarget,
    ): Promise<SandboxConnection | null | undefined> | SandboxConnection | null | undefined;
    getSelectedSandboxRun?(
      taskId: string,
    ):
      | Promise<SelectedSandboxRun | null | undefined>
      | SelectedSandboxRun
      | null
      | undefined;
    getTerminalDescriptor?(
      taskId: string,
    ):
      | Promise<SandboxTerminalEndpointDescriptor | null | undefined>
      | SandboxTerminalEndpointDescriptor
      | null
      | undefined;
    getCommandDescriptor?(
      taskId: string,
    ):
      | Promise<SandboxCommandEndpointDescriptor | null | undefined>
      | SandboxCommandEndpointDescriptor
      | null
      | undefined;
    getWorkspaceDescriptor?(
      taskId: string,
    ):
      | Promise<SandboxWorkspaceDescriptor | null | undefined>
      | SandboxWorkspaceDescriptor
      | null
      | undefined;
    getRetentionPolicy?(
      taskId: string,
    ):
      | Promise<SandboxRetentionPolicy | null | undefined>
      | SandboxRetentionPolicy
      | null
      | undefined;
  };

export type SandboxProviderRouterOptions = SelectSandboxProviderCandidateOptions & {
  readonly ownerStore?: SandboxRunOwnerStore;
  /** Persisted task constraint used during restart-time owner recovery. */
  readonly resolveTaskProviderId?: (taskId: string) => Promise<string | null>;
};

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
    SandboxSelectedRunPort,
    SandboxReadoptionPort
{
  private readonly registry: SandboxProviderRegistry<
    RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
  >;
  private readonly owners = new Map<string, string>();
  /**
   * Same-process proof that a provider still exposes the exact run persisted
   * immediately after provision. This is deliberately not reconstructed from
   * the owner store: after restart, delivery must exact-reattach before use.
   */
  private readonly verifiedDeliveryTargets = new Map<
    string,
    { readonly providerId: string; readonly target: SandboxReadoptionTarget }
  >();

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

  async provision(ctx: SandboxProvisionContext<TCloneSpec>): Promise<SandboxConnection> {
    this.verifiedDeliveryTargets.delete(ctx.taskId);
    const requiredProviderId = await this.requiredProviderIdForProvision(ctx);
    const requiredCapabilities = new Set(
      provisionSandboxRequiredCapabilities({
        materializeGitWorkspace: hasSandboxWorkspaceMaterialization(ctx),
      }),
    );
    for (const capability of sandboxResourceRequiredCapabilities(
      resourcesForSandboxProvision(ctx),
    )) {
      requiredCapabilities.add(capability);
    }
    let selected;
    try {
      selected = this.registry.select(
        [...requiredCapabilities],
        { ...this.options, requiredProviderId },
      );
    } catch (error) {
      if (ctx.modelIntent.kind === 'explicit') {
        throw new SandboxRuntimeModelSetupError('provider-selection');
      }
      throw error;
    }
    const ownership = ctx.ownership
      ? await this.acquireProvisionOwnership(
          ctx.taskId,
          selected.id,
          ctx.ownership,
        )
      : undefined;
    const cleanupUpstreamAuthorizations = new Map<
      SandboxRunCleanupAuthorization,
      SandboxRunCleanupAuthorization | undefined
    >();
    const providerContext = snapshotSandboxProvisionContext({
      ...ctx,
      ...(ownership ? { ownership } : {}),
      ...(ownership
        ? {
            // A stale create may join a cleanup already transferred to a newer
            // owner, but only for the same immutable physical generation.
            beforeSandboxCleanup: async () => {
              let upstreamAuthorization: SandboxRunCleanupAuthorization | undefined;
              if (ctx.beforeSandboxCleanup) {
                upstreamAuthorization =
                  (await ctx.beforeSandboxCleanup()) ?? undefined;
                if (!upstreamAuthorization) return null;
              }
              const cleanup = await this.options.ownerStore?.joinSandboxRunCleanup?.({
                taskId: ctx.taskId,
                providerId: selected.id,
                ownership,
              });
              if (cleanup?.kind !== 'authorized') return null;
              cleanupUpstreamAuthorizations.set(
                cleanup.authorization,
                upstreamAuthorization,
              );
              return cleanup.authorization;
            },
            externalBoundaryGuard: async (event) => {
              await ctx.externalBoundaryGuard?.(event);
              if (
                event.action === 'sandbox.create' &&
                event.position === 'before'
              ) {
                const entered = await this.options.ownerStore
                  ?.beginSandboxRunCreate?.({
                    taskId: ctx.taskId,
                    providerId: selected.id,
                    ownership,
                  });
                if (entered !== true) {
                  throw new Error(
                    'Sandbox create owner generation is no longer current',
                  );
                }
              }
            },
            onSandboxCreateObserved: async (observation) => {
              const observed = await this.options.ownerStore
                ?.observeSandboxRunCreate?.({
                  taskId: ctx.taskId,
                  providerId: selected.id,
                  resourceGeneration: ownership.resourceGeneration,
                  ...(observation.kind !== 'created' ||
                  observation.providerSandboxId === undefined
                    ? {}
                    : { providerSandboxId: observation.providerSandboxId }),
                });
              if (observed !== true) {
                throw new Error(
                  'Sandbox create resource generation is no longer current',
                );
              }
              await ctx.onSandboxCreateObserved?.(observation);
            },
            afterSandboxCleanup: async (
              authorization: SandboxRunCleanupAuthorization,
            ) => {
              const completed = await this.options.ownerStore?.completeSandboxRunCleanup?.(
                authorization,
                'removed',
              );
              if (completed !== true) {
                throw new Error('Sandbox cleanup generation was superseded');
              }
              const upstreamAuthorization =
                cleanupUpstreamAuthorizations.get(authorization);
              cleanupUpstreamAuthorizations.delete(authorization);
              if (upstreamAuthorization) {
                await ctx.afterSandboxCleanup?.(upstreamAuthorization);
              }
            },
          }
        : {}),
    });
    let connection: SandboxConnection;
    try {
      connection = await selected.provider.provision(providerContext);
    } catch (error) {
      this.owners.delete(ctx.taskId);
      if (ownership) {
        await this.teardownSandbox(ctx.taskId, {
          ownership,
          disposition: 'superseded-remove',
        }).catch(() => undefined);
      }
      throw error;
    }
    try {
      this.owners.set(ctx.taskId, selected.id);
      if (this.options.ownerStore) {
        const providerRun = await this.selectedRunFor(ctx.taskId, selected);
        const environment = providerRun?.environment ?? ctx.environment ?? undefined;
        await this.options.ownerStore.recordSandboxRunOwner({
          taskId: ctx.taskId,
          providerId: selected.id,
          ...(providerRun?.providerSandboxId === undefined
            ? {}
            : { providerSandboxId: providerRun.providerSandboxId }),
          ownership,
          status: 'running',
          connection,
          environment,
          metadata: providerRun?.preflight?.metadata,
        });
        this.rememberVerifiedDeliveryTarget(ctx.taskId, selected.id, {
          ...(providerRun?.providerSandboxId === undefined
            ? {}
            : { providerSandboxId: providerRun.providerSandboxId }),
          ...(ownership === undefined ? {} : { ownership }),
        });
      }
    } catch (error) {
      this.owners.delete(ctx.taskId);
      this.verifiedDeliveryTargets.delete(ctx.taskId);
      if (ownership) {
        // Close the provider-return / owner-record crash gap.  The exact CAS is
        // stale after a takeover and therefore cannot delete the newer owner.
        await this.teardownSandbox(ctx.taskId, {
          ownership,
          disposition: 'superseded-remove',
        });
      }
      throw error;
    }
    return connection;
  }

  async teardownSandbox(
    taskId: string,
    options: {
      readonly ownership?: SandboxOwnershipFence;
      readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
      readonly disposition?: SandboxTeardownDisposition;
    } = {},
  ): Promise<void> {
    this.verifiedDeliveryTargets.delete(taskId);
    const ownerStore = this.options.ownerStore;
    if (ownerStore?.beginSandboxRunCleanup) {
      let expectedAuthorization = options.cleanupAuthorization;
      if (
        !expectedAuthorization &&
        !options.ownership &&
        ownerStore.claimSandboxRunCleanup
      ) {
        const claimed = await ownerStore.claimSandboxRunCleanup(
          taskId,
          `cleanup:${randomUUID()}`,
        );
        if (claimed.kind === 'absent') return;
        if (claimed.kind !== 'authorized') {
          throw new Error('Sandbox cleanup owner cannot be claimed');
        }
        expectedAuthorization = claimed.authorization;
      }
      if (expectedAuthorization && expectedAuthorization.taskId !== taskId) {
        throw new Error('Sandbox cleanup authorization task does not match');
      }
      const expectedOwnership =
        expectedAuthorization?.kind === 'generation'
          ? expectedAuthorization.ownership
          : options.ownership;
      const cleanup = await ownerStore.beginSandboxRunCleanup(
        taskId,
        expectedOwnership,
      );
      if (cleanup.kind !== 'authorized') {
        if (cleanup.kind === 'absent') this.owners.delete(taskId);
        return;
      }
      if (
        expectedAuthorization &&
        !sameCleanupAuthorization(cleanup.authorization, expectedAuthorization)
      ) {
        return;
      }
      const entry = this.registry.get(cleanup.owner.providerId);
      if (!entry) {
        throw new Error('Persisted sandbox owner provider is not registered');
      }
      const result = await entry.provider.teardownSandbox(taskId, {
        ...(cleanup.authorization.kind === 'generation'
          ? { ownership: cleanup.authorization.ownership }
          : {}),
        cleanupAuthorization: cleanup.authorization,
        ...(cleanup.owner.providerSandboxId === undefined
          ? {}
          : { providerSandboxId: cleanup.owner.providerSandboxId }),
        disposition: options.disposition ?? 'terminal-retain',
      });
      if (
        cleanup.authorization.kind === 'generation' &&
        result === undefined
      ) {
        // A resolved legacy void carries no physical cleanup proof. Generated
        // resources require an explicit found/absent outcome from the provider.
        throw new SandboxCleanupPendingError();
      }
      const createMayStillReturn =
        cleanup.authorization.kind === 'generation' &&
        cleanup.owner.createState !== 'idle';
      if (createMayStillReturn) {
        // Deleting a currently visible resource is not enough while a replayed
        // create may still return after that delete. Keep the tombstone until
        // the create response is observed idle and the final target is cleaned.
        const pending = cleanup.authorization.kind === 'generation'
          ? await ownerStore.joinSandboxRunCleanup?.({
              taskId,
              providerId: cleanup.authorization.providerId,
              ownership: cleanup.authorization.ownership,
            })
          : await ownerStore.beginSandboxRunCleanup(taskId);
        if (!pending || pending.kind !== 'absent') {
          throw new SandboxCleanupPendingError();
        }
        this.owners.delete(taskId);
        // Only an absent durable row proves another actor completed this exact
        // cleanup. A stale/conflicting newer owner is still live work for a
        // terminal task and must be reclaimed by the next cleanup attempt.
        return;
      }
      const completed = await ownerStore.completeSandboxRunCleanup?.(
        cleanup.authorization,
        (options.disposition ?? 'terminal-retain') === 'terminal-retain'
          ? 'terminal'
          : 'removed',
      );
      if (completed !== true) {
        throw new Error('Sandbox cleanup generation was superseded');
      }
      this.owners.delete(taskId);
      return;
    }
    if (options.ownership || options.cleanupAuthorization) {
      throw new Error('Sandbox ownership cleanup store is unavailable');
    }
    const owned = await this.owner(taskId);
    if (owned) {
      await owned.provider.teardownSandbox(taskId, {
        disposition: options.disposition ?? 'terminal-retain',
      });
      this.owners.delete(taskId);
      await this.options.ownerStore?.markSandboxRunOwnerStatus?.(taskId, 'removed');
      return;
    }

    await Promise.all(
      this.registry.list().map((entry) => entry.provider.teardownSandbox(taskId, {
        disposition: options.disposition ?? 'terminal-retain',
      })),
    );
  }

  async claimSandboxCleanupOwnership(
    taskId: string,
    ownerGeneration: string,
  ): Promise<SandboxRunCleanupAuthorization | null> {
    const ownerStore = this.options.ownerStore;
    if (!ownerStore?.claimSandboxRunCleanup) {
      throw new Error('Durable sandbox cleanup ownership store is unavailable');
    }
    const claimed = await ownerStore.claimSandboxRunCleanup(
      taskId,
      ownerGeneration,
    );
    if (claimed.kind === 'absent') {
      this.owners.delete(taskId);
      return null;
    }
    if (claimed.kind !== 'authorized') {
      throw new Error('Sandbox cleanup owner cannot be claimed');
    }
    return claimed.authorization;
  }

  private async acquireProvisionOwnership(
    taskId: string,
    providerId: string,
    requested: SandboxOwnershipFence,
  ): Promise<SandboxOwnershipFence> {
    const ownerStore = this.options.ownerStore;
    if (
      !ownerStore?.acquireSandboxRunOwner ||
      !ownerStore.beginSandboxRunCreate ||
      !ownerStore.observeSandboxRunCreate ||
      !ownerStore.claimSandboxRunCleanup ||
      !ownerStore.joinSandboxRunCleanup ||
      !ownerStore.beginSandboxRunCleanup ||
      !ownerStore.completeSandboxRunCleanup
    ) {
      throw new Error('Durable sandbox ownership store is unavailable');
    }
    let acquired = await ownerStore.acquireSandboxRunOwner({
      taskId,
      providerId,
      ownerGeneration: requested.ownerGeneration,
      proposedResourceGeneration:
        requested.resourceGeneration || randomUUID(),
    });
    if (acquired.kind === 'cleanup-required') {
      const cleanupAuthorization = await this.claimSandboxCleanupOwnership(
        taskId,
        requested.ownerGeneration,
      );
      if (!cleanupAuthorization) {
        throw new Error('Sandbox cleanup owner disappeared before cleanup');
      }
      await this.teardownSandbox(taskId, {
        cleanupAuthorization,
        disposition: 'superseded-remove',
      });
      acquired = await ownerStore.acquireSandboxRunOwner({
        taskId,
        providerId,
        ownerGeneration: requested.ownerGeneration,
        proposedResourceGeneration: requested.resourceGeneration || randomUUID(),
      });
    }
    if (acquired.kind !== 'acquired') {
      throw new Error('Task already has an incompatible active sandbox owner');
    }
    return acquired.ownership;
  }

  async readRolloutFromContainer(
    taskId: string,
    runtimeId?: TRuntimeId | null,
  ): Promise<TTranscriptSource | null> {
    const resolved = await this.ownerWithRecord(taskId);
    if (resolved) {
      await resolved.owner.provider.reattach?.(
        taskId,
        readoptionTargetFor(resolved.ownerRecord),
      );
      return this.supports(
        resolved.owner,
        RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES,
      )
        ? resolved.owner.provider.readRolloutFromContainer(taskId, runtimeId)
        : null;
    }

    for (const entry of this.providersFor(RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES)) {
      const source = await entry.provider.readRolloutFromContainer(taskId, runtimeId);
      if (source) return source;
    }
    return null;
  }

  async sandboxExists(taskId: string): Promise<boolean> {
    const resolved = await this.ownerWithRecord(taskId);
    if (resolved) {
      await resolved.owner.provider.reattach?.(
        taskId,
        readoptionTargetFor(resolved.ownerRecord),
      );
      return resolved.owner.provider.sandboxExists(taskId);
    }

    for (const entry of this.registry.list()) {
      if (await entry.provider.sandboxExists(taskId)) return true;
    }
    return false;
  }

  async deliverWorkspaceChanges(
    taskId: string,
    args: SandboxDeliverWorkspaceArgs,
  ): Promise<SandboxDeliverWorkspaceResult> {
    let resolved = await this.ownerWithRecord(taskId);
    if (!resolved) {
      const reattached = await this.reattachOwner(taskId);
      resolved = reattached
        ? {
            owner: reattached.owner,
            ownerRecord:
              (await this.options.ownerStore?.getSandboxRunOwner(taskId)) ??
              undefined,
            connection: reattached.connection,
            providerRun: reattached.providerRun,
          }
        : null;
    }
    if (resolved) {
      const persistedTarget = readoptionTargetFor(resolved.ownerRecord);
      if (!isSandboxLegacyDeliverWorkspaceArgs(args) && resolved.ownerRecord) {
        if (!persistedTarget) {
          return deliveryReattachFailure(taskId);
        }
        const locallyVerified = await this.isVerifiedDeliveryTarget(
          taskId,
          resolved.owner,
          persistedTarget,
        );
        if (!locallyVerified) {
          const reattach = resolved.owner.provider.reattach;
          if (!reattach) return deliveryReattachFailure(taskId);
          const connection = await reattach.call(
            resolved.owner.provider,
            taskId,
            persistedTarget,
          );
          if (!connection) return deliveryReattachFailure(taskId);
          this.rememberVerifiedDeliveryTarget(
            taskId,
            resolved.owner.id,
            persistedTarget,
          );
        }
      } else {
        await resolved.owner.provider.reattach?.(taskId, persistedTarget);
      }
      if (!this.supports(resolved.owner, DELIVERY_SANDBOX_REQUIRED_CAPABILITIES)) {
        return {
          hadChanges: false,
          commitSha: null,
          error: `sandbox provider for task ${taskId} does not support workspace delivery`,
        };
      }
      return resolved.owner.provider.deliverWorkspaceChanges(
        taskId,
        this.deliveryArgsForOwner(
          taskId,
          resolved.owner.id,
          resolved.ownerRecord,
          args,
        ),
      );
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

  async reconcileSandboxInventory(
    input: SandboxInventoryReconcileInput,
  ): Promise<SandboxInventoryReconcileResult> {
    let inspected = 0;
    let reaped = 0;
    const protectedTaskIds = [...new Set(input.protectedTaskIds)];
    const results = await Promise.all(
      this.providersFor(READOPTION_SANDBOX_REQUIRED_CAPABILITIES).map(
        (entry) =>
          entry.provider.reconcileSandboxInventory?.({
            protectedTaskIds,
            canReap: async (candidate) => {
              const activeOwner = await this.options.ownerStore?.getSandboxRunOwner(
                candidate.taskId,
              );
              if (activeOwner) return false;
              return input.canReap(candidate);
            },
          }),
      ),
    );
    for (const result of results) {
      inspected += result?.inspected ?? 0;
      reaped += result?.reaped ?? 0;
    }
    return { inspected, reaped };
  }

  async reattach(taskId: string): Promise<SandboxConnection | null> {
    const resolved = await this.ownerWithRecord(taskId);
    if (resolved) {
      const target = readoptionTargetFor(resolved.ownerRecord);
      const connection =
        (await resolved.owner.provider.reattach?.(taskId, target)) ?? null;
      if (connection && target) {
        this.rememberVerifiedDeliveryTarget(
          taskId,
          resolved.owner.id,
          target,
        );
      } else if (!connection) {
        this.verifiedDeliveryTargets.delete(taskId);
      }
      return connection;
    }

    const reattached = await this.reattachOwner(taskId);
    return reattached?.connection ?? null;
  }

  async getSelectedSandboxRun(
    taskId: string,
  ): Promise<
    SelectedSandboxRun<
      RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
    > | null
  > {
    let resolved = await this.ownerWithRecord(taskId);
    if (!resolved) {
      const reattached = await this.reattachOwner(taskId, {
        includeSelectedRun: true,
      });
      if (!reattached) return null;
      resolved = {
        owner: reattached.owner,
        ownerRecord:
          (await this.options.ownerStore?.getSandboxRunOwner(taskId)) ?? undefined,
        connection: reattached.connection,
        providerRun: reattached.providerRun,
      };
    }

    const providerRun =
      resolved.providerRun !== undefined
        ? resolved.providerRun
        : (await (async () => {
            await resolved.owner.provider.reattach?.(
              taskId,
              readoptionTargetFor(resolved.ownerRecord),
            );
            return resolved.owner.provider.getSelectedSandboxRun?.(taskId);
          })()) ?? null;
    const connection =
      providerRun?.connection ??
      resolved.ownerRecord?.connection ??
      resolved.connection;
    if (!connection) return null;
    const terminal =
      providerRun?.terminal ??
      (await resolved.owner.provider.getTerminalDescriptor?.(taskId)) ??
      undefined;
    const command =
      providerRun?.command ??
      (await resolved.owner.provider.getCommandDescriptor?.(taskId)) ??
      undefined;
    const workspace =
      providerRun?.workspace ??
      (await resolved.owner.provider.getWorkspaceDescriptor?.(taskId)) ??
      undefined;
    const retention =
      providerRun?.retention ??
      (await resolved.owner.provider.getRetentionPolicy?.(taskId)) ??
      undefined;

    return {
      taskId,
      providerId: resolved.owner.id,
      provider: resolved.owner.provider,
      providerSandboxId:
        providerRun?.providerSandboxId ??
        resolved.ownerRecord?.providerSandboxId,
      capabilities: resolved.owner.capabilities,
      connection,
      terminal,
      command,
      workspace,
      retention,
      preflight: providerRun?.preflight,
      environment: providerRun?.environment ?? resolved.ownerRecord?.environment,
      owner: resolved.ownerRecord,
    };
  }

  private async reattachOwner(
    taskId: string,
    options: { readonly includeSelectedRun?: boolean } = {},
  ): Promise<{
    readonly owner: SandboxProviderDescriptor<
      RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
    >;
    readonly connection: SandboxConnection;
    readonly providerRun?: SelectedSandboxRun | null;
  } | null> {
    const requiredProviderId = await this.resolveRequiredProviderId(taskId);
    const candidates = requiredProviderId
      ? [this.registry.get(requiredProviderId)].filter(
          (entry): entry is NonNullable<typeof entry> => entry !== undefined,
        )
      : this.registry.list();
    if (requiredProviderId && candidates.length === 0) {
      throw new SandboxRuntimeModelSetupError('provider-selection');
    }
    for (const entry of candidates) {
      if (!this.supports(entry, READOPTION_SANDBOX_REQUIRED_CAPABILITIES)) {
        continue;
      }
      const connection = await entry.provider.reattach?.(taskId);
      if (connection) {
        const providerRun =
          options.includeSelectedRun || this.options.ownerStore
            ? await this.selectedRunFor(taskId, entry)
            : null;
        await this.options.ownerStore?.recordSandboxRunOwner({
          taskId,
          providerId: entry.id,
          ...(providerRun?.providerSandboxId === undefined
            ? {}
            : { providerSandboxId: providerRun.providerSandboxId }),
          connection,
          environment: providerRun?.environment,
        });
        this.owners.set(taskId, entry.id);
        return { owner: entry, connection, providerRun };
      }
    }
    return null;
  }

  private async owner(
    taskId: string,
  ): Promise<SandboxProviderDescriptor<
    RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
  > | null> {
    return (await this.ownerWithRecord(taskId))?.owner ?? null;
  }

  private async ownerWithRecord(
    taskId: string,
  ): Promise<{
    readonly owner: SandboxProviderDescriptor<
      RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
    >;
    readonly ownerRecord?: SandboxRunOwnerRecord;
    readonly connection?: SandboxConnection;
    readonly providerRun?: SelectedSandboxRun | null;
  } | null> {
    const requiredProviderId = await this.resolveRequiredProviderId(taskId);
    const stored = await this.options.ownerStore?.getSandboxRunOwner(taskId);
    if (stored) {
      if (requiredProviderId && stored.providerId !== requiredProviderId) {
        throw new SandboxRuntimeModelSetupError('provider-selection');
      }
      const provider = this.registry.get(stored.providerId);
      if (!provider) return null;
      this.owners.set(taskId, provider.id);
      return { owner: provider, ownerRecord: stored, connection: stored.connection };
    }
    if (this.options.ownerStore) {
      this.owners.delete(taskId);
      return null;
    }

    const id = this.owners.get(taskId);
    if (id) {
      if (requiredProviderId && id !== requiredProviderId) {
        throw new SandboxRuntimeModelSetupError('provider-selection');
      }
      const provider = this.registry.get(id)!;
      return { owner: provider };
    }
    return null;
  }

  private requiredProviderIdFromProvision(
    ctx: SandboxProvisionContext<TCloneSpec>,
  ): string | undefined {
    if (ctx.modelIntent.kind === 'runtime-default') return undefined;
    const providerId = ctx.environment?.providerId;
    if (!providerId) {
      throw new SandboxRuntimeModelSetupError('snapshot');
    }
    return providerId;
  }

  private async requiredProviderIdForProvision(
    ctx: SandboxProvisionContext<TCloneSpec>,
  ): Promise<string | undefined> {
    const immutableProviderId = this.requiredProviderIdFromProvision(ctx);
    if (!ctx.ownership || !this.options.ownerStore) {
      return immutableProviderId;
    }

    // A durable replay owns the same physical resource generation as the
    // persisted active record. Provider ranking may change between attempts,
    // but it must not redirect that generation to a different backend.
    const persistedOwner = await this.options.ownerStore.getSandboxRunOwner(
      ctx.taskId,
    );
    if (!persistedOwner) return immutableProviderId;
    if (
      immutableProviderId &&
      persistedOwner.providerId !== immutableProviderId
    ) {
      throw new SandboxRuntimeModelSetupError('provider-selection');
    }
    if (!this.registry.get(persistedOwner.providerId)) {
      throw new SandboxRuntimeModelSetupError('provider-selection');
    }
    return persistedOwner.providerId;
  }

  private async resolveRequiredProviderId(taskId: string): Promise<string | null> {
    if (!this.options.resolveTaskProviderId) return null;
    return this.options.resolveTaskProviderId(taskId);
  }

  /**
   * Caller-supplied cleanup authority is never forwarded through the provider
   * center. Only the persisted selected owner may authorize destructive
   * delivery fencing, and completion removes that exact physical generation.
   */
  private deliveryArgsForOwner(
    taskId: string,
    providerId: string,
    ownerRecord: SandboxRunOwnerRecord | undefined,
    args: SandboxDeliverWorkspaceArgs,
  ): SandboxDeliverWorkspaceArgs {
    if (isSandboxLegacyDeliverWorkspaceArgs(args)) {
      return Object.freeze({
        branch: args.branch,
        commitMessage: args.commitMessage,
        authHeader: args.authHeader,
      });
    }

    const safeArgs = {
      branch: args.branch,
      commitMessage: args.commitMessage,
      credential: args.credential,
      ...(args.cancellationSignal === undefined
        ? {}
        : { cancellationSignal: args.cancellationSignal }),
      ...(args.deadlineMs === undefined ? {} : { deadlineMs: args.deadlineMs }),
    };
    if (!ownerRecord) return Object.freeze(safeArgs);
    const ownership = ownerRecord.ownership;

    const ownerStore = this.options.ownerStore;
    if (
      !ownerStore?.beginSandboxRunCleanup ||
      !ownerStore.completeSandboxRunCleanup
    ) {
      throw new Error('Durable sandbox delivery cleanup store is unavailable');
    }
    const beginCleanup = ownerStore.beginSandboxRunCleanup.bind(ownerStore);
    const completeCleanup =
      ownerStore.completeSandboxRunCleanup.bind(ownerStore);

    let cleanupAuthorization: SandboxRunCleanupAuthorization | undefined;
    return Object.freeze({
      ...safeArgs,
      ...(ownership ? { ownership } : {}),
      beforeSandboxCleanup: async () => {
        this.verifiedDeliveryTargets.delete(taskId);
        if (cleanupAuthorization) return cleanupAuthorization;
        const cleanup = await beginCleanup(
          taskId,
          ownership,
        );
        if (cleanup.kind !== 'authorized') return null;
        const expectedAuthorization: SandboxRunCleanupAuthorization = ownership
          ? { kind: 'generation', taskId, providerId, ownership }
          : { kind: 'legacy', taskId, providerId };
        if (
          !sameCleanupAuthorization(
            cleanup.authorization,
            expectedAuthorization,
          )
        ) {
          throw new Error(
            'Sandbox delivery cleanup authorization does not match the selected owner',
          );
        }
        cleanupAuthorization = cleanup.authorization;
        return cleanupAuthorization;
      },
      afterSandboxCleanup: async (
        authorization: SandboxRunCleanupAuthorization,
      ) => {
        if (
          !cleanupAuthorization ||
          !sameCleanupAuthorization(authorization, cleanupAuthorization)
        ) {
          throw new Error(
            'Sandbox delivery cleanup completion is not authorized',
          );
        }
        const completed = await completeCleanup(
          cleanupAuthorization,
          'removed',
        );
        if (completed !== true) {
          throw new Error('Sandbox delivery cleanup generation was superseded');
        }
        cleanupAuthorization = undefined;
        // The durable CAS is authoritative. A newer generation may provision
        // between completion and this callback resuming; never clear its
        // process-local provider cache from the superseded delivery closure.
      },
    });
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

  private async selectedRunFor(
    taskId: string,
    provider: SandboxProviderDescriptor<
      RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
    >,
  ): Promise<SelectedSandboxRun | null> {
    try {
      return (await provider.provider.getSelectedSandboxRun?.(taskId)) ?? null;
    } catch {
      return null;
    }
  }

  private rememberVerifiedDeliveryTarget(
    taskId: string,
    providerId: string,
    target: SandboxReadoptionTarget,
  ): void {
    if (
      target.providerSandboxId === undefined &&
      target.ownership === undefined
    ) {
      this.verifiedDeliveryTargets.delete(taskId);
      return;
    }
    this.verifiedDeliveryTargets.set(taskId, {
      providerId,
      target: Object.freeze({
        ...(target.providerSandboxId === undefined
          ? {}
          : { providerSandboxId: target.providerSandboxId }),
        ...(target.ownership === undefined
          ? {}
          : { ownership: Object.freeze({ ...target.ownership }) }),
      }),
    });
  }

  private async isVerifiedDeliveryTarget(
    taskId: string,
    provider: SandboxProviderDescriptor<
      RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
    >,
    target: SandboxReadoptionTarget,
  ): Promise<boolean> {
    const verified = this.verifiedDeliveryTargets.get(taskId);
    if (
      !verified ||
      verified.providerId !== provider.id ||
      !sameReadoptionTarget(verified.target, target) ||
      target.providerSandboxId === undefined
    ) {
      return false;
    }
    const selected = await this.selectedRunFor(taskId, provider);
    const current =
      selected?.providerId === provider.id &&
      selected.providerSandboxId === target.providerSandboxId;
    if (!current) this.verifiedDeliveryTargets.delete(taskId);
    return current;
  }
}

function sameCleanupAuthorization(
  left: SandboxRunCleanupAuthorization,
  right: SandboxRunCleanupAuthorization,
): boolean {
  if (
    left.kind !== right.kind ||
    left.taskId !== right.taskId ||
    left.providerId !== right.providerId
  ) {
    return false;
  }
  if (left.kind === 'legacy' || right.kind === 'legacy') return true;
  return (
    left.ownership.ownerGeneration === right.ownership.ownerGeneration &&
    left.ownership.resourceGeneration === right.ownership.resourceGeneration
  );
}

function sameReadoptionTarget(
  left: SandboxReadoptionTarget,
  right: SandboxReadoptionTarget,
): boolean {
  if (left.providerSandboxId !== right.providerSandboxId) return false;
  if (left.ownership === undefined || right.ownership === undefined) {
    return left.ownership === right.ownership;
  }
  return (
    left.ownership.ownerGeneration === right.ownership.ownerGeneration &&
    left.ownership.resourceGeneration === right.ownership.resourceGeneration
  );
}

function deliveryReattachFailure(
  taskId: string,
): SandboxDeliverWorkspaceResult {
  return {
    hadChanges: false,
    commitSha: null,
    error: `sandbox provider for task ${taskId} could not reattach its persisted target before workspace delivery`,
  };
}

function readoptionTargetFor(
  owner: SandboxRunOwnerRecord | undefined,
): SandboxReadoptionTarget | undefined {
  if (!owner) return undefined;
  if (owner.providerSandboxId === undefined && owner.ownership === undefined) {
    return undefined;
  }
  return {
    ...(owner.providerSandboxId === undefined
      ? {}
      : { providerSandboxId: owner.providerSandboxId }),
    ...(owner.ownership === undefined ? {} : { ownership: owner.ownership }),
  };
}
