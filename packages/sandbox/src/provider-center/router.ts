import type {
  GitCloneSpec,
  SandboxCleanupAttemptEvidence,
  SandboxConnection,
  SandboxPhysicalCleanupResult,
  SandboxCleanupOwnershipClaim,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
  SandboxExecutionMode,
  SandboxInventoryReconcileInput,
  SandboxInventoryReconcileResult,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxProviderPort,
  SandboxProvisioningDiagnosticObserver,
  SandboxProvisionContext,
  SandboxReadoptionTarget,
  SandboxReadoptionPort,
  SandboxRunOwnerRecord,
  SandboxRunCleanupAuthorityProjection,
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
  SandboxCleanupCoordinationPendingError,
  SandboxCleanupPendingError,
  SandboxRuntimeModelSetupError,
  hasSandboxWorkspaceMaterialization,
  isSandboxLegacyDeliverWorkspaceArgs,
  missingCapabilities,
  normalizeSandboxPhysicalCleanupResult,
  resourcesForSandboxProvision,
  sandboxResourceRequiredCapabilities,
  snapshotSandboxProvisionContext,
  preserveSandboxPrimaryWithCleanup,
  runSandboxPhysicalCleanup,
  sandboxCleanupAttemptEvidence,
  sandboxPhysicalCleanupResultFromEvidence,
  isSandboxCleanupCoordinationPendingError,
  isSandboxWorkspaceTransferDetachedSignal,
  validateSandboxCleanupAttemptEvidence,
  validateSandboxPhysicalCleanupResult,
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
  /** Maximum same-process wait for a legacy provider invocation to settle. */
  readonly legacyProvisionJoinTimeoutMs?: number;
};

type RoutedSandboxCleanupResult =
  | {
      readonly kind: 'physical';
      readonly physical: SandboxPhysicalCleanupResult;
      /** Only a generation-fenced durable owner retains worker authority. */
      readonly durablePending: boolean;
    }
  | {
      readonly kind: 'coordination-pending';
      readonly durablePending: true;
      readonly physical?: SandboxPhysicalCleanupResult;
    };

type ProviderContextCleanupFinalization =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'settled-physical';
      readonly authorization: SandboxRunCleanupAuthorization;
      readonly physical: SandboxPhysicalCleanupResult;
    }
  | {
      readonly kind: 'coordination-pending';
      readonly authorization?: SandboxRunCleanupAuthorization;
    };

interface ProviderContextCleanupCallbacks {
  readonly beforeSandboxCleanup: () => Promise<SandboxRunCleanupAuthorization | null>;
  readonly afterSandboxCleanup: (
    authorization: SandboxRunCleanupAuthorization,
  ) => Promise<void>;
  readonly settleSandboxCleanupAttempt: (
    authorization: SandboxRunCleanupAuthorization,
    physical: SandboxPhysicalCleanupResult,
  ) => Promise<void>;
  readonly settleIncomplete: () => Promise<ProviderContextCleanupFinalization>;
}

interface RoutedSandboxDeliveryContext {
  readonly args: SandboxDeliverWorkspaceArgs;
  readonly cleanup?: ProviderContextCleanupCallbacks;
}

interface LegacyProvisioningInFlight {
  readonly providerId: string;
  readonly settled: Promise<void>;
  settle(): void;
}

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
  /** Coalesces replay of one in-flight physical attempt for one resource. */
  private readonly cleanupAttemptsInFlight = new Map<
    string,
    Promise<RoutedSandboxCleanupResult>
  >();
  /**
   * Legacy admission is process-local, but its provider create fence is
   * persisted. This promise lets a same-process terminal cleanup join the
   * provider continuation before making its final absence check.
   */
  private readonly legacyProvisioningInFlight = new Map<
    string,
    LegacyProvisioningInFlight
  >();
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
    const legacyCreateFence =
      ownership === undefined &&
      this.options.ownerStore?.beginSandboxRunCreate !== undefined &&
      this.options.ownerStore.observeSandboxRunCreate !== undefined;
    const legacyProvisioning = legacyCreateFence
      ? createLegacyProvisioningInFlight(selected.id)
      : undefined;
    let legacyCreateBoundaryEntered = false;
    let legacyCreateObserved = false;
    const providerCleanup = ownership
      ? this.createProviderContextCleanupCallbacks({
          authorize: async () => {
            let upstreamAuthorization: SandboxRunCleanupAuthorization | undefined;
            if (ctx.beforeSandboxCleanup) {
              upstreamAuthorization =
                (await ctx.beforeSandboxCleanup()) ?? undefined;
              if (!upstreamAuthorization) {
                // An upstream lease/authority refusal is load-bearing. Never
                // bypass it by falling back through this router's local fence.
                throw new SandboxCleanupCoordinationPendingError();
              }
            }
            // A stale create may join cleanup after authority transferred, but
            // only for its immutable physical generation. Allocation happens
            // inside the returned callback before the provider may perform I/O.
            const cleanup = await this.options.ownerStore?.joinSandboxRunCleanup?.({
              taskId: ctx.taskId,
              providerId: selected.id,
              ownership,
            });
            if (cleanup?.kind === 'absent') return null;
            if (cleanup?.kind !== 'authorized') {
              throw new SandboxCleanupCoordinationPendingError();
            }
            return {
              authorization: cleanup.authorization,
              confirmedAbsenceIsFinal: cleanup.owner.createState === 'idle',
              ...(upstreamAuthorization === undefined
                ? {}
                : {
                    afterSettlement: async (
                      physical: SandboxPhysicalCleanupResult,
                    ) => {
                      if (ctx.settleSandboxCleanupAttempt) {
                        await ctx.settleSandboxCleanupAttempt(
                          upstreamAuthorization,
                          physical,
                        );
                        return;
                      }
                      if (
                        physical.outcome === 'succeeded' &&
                        ctx.afterSandboxCleanup
                      ) {
                        await ctx.afterSandboxCleanup(upstreamAuthorization);
                        return;
                      }
                      // Never infer callback semantics from Function.length:
                      // default/rest parameters make arity an unsafe signal.
                      throw new SandboxCleanupCoordinationPendingError();
                    },
                  }),
            };
          },
          completedStatus: 'removed',
        })
      : undefined;
    const providerContext = snapshotSandboxProvisionContext({
      ...ctx,
      ...(ownership ? { ownership } : {}),
      ...(ownership || legacyCreateFence
        ? {
            externalBoundaryGuard: async (event) => {
              await ctx.externalBoundaryGuard?.(event);
              if (
                event.action === 'sandbox.create' &&
                event.position === 'before'
              ) {
                if (ownership === undefined) {
                  if (!legacyCreateBoundaryEntered) {
                    throw new Error(
                      'Legacy sandbox invocation fence is not current',
                    );
                  }
                  const current = await this.options.ownerStore
                    ?.validateLegacySandboxRunCreateFence?.({
                      taskId: ctx.taskId,
                      providerId: selected.id,
                    });
                  if (current !== true) {
                    throw new Error(
                      'Legacy sandbox create fence is no longer current',
                    );
                  }
                } else {
                  const entered = await this.options.ownerStore
                    ?.beginSandboxRunCreate?.({
                      taskId: ctx.taskId,
                      providerId: selected.id,
                      ownership,
                    });
                  if (entered !== true) {
                    throw new Error(
                      'Sandbox create fence is no longer current',
                    );
                  }
                }
              }
            },
            onSandboxCreateObserved: async (observation) => {
              const observed = await this.options.ownerStore
                ?.observeSandboxRunCreate?.({
                  taskId: ctx.taskId,
                  providerId: selected.id,
                  ...(ownership === undefined
                    ? {}
                    : { resourceGeneration: ownership.resourceGeneration }),
                  ...(observation.kind !== 'created' ||
                  observation.providerSandboxId === undefined
                    ? {}
                    : { providerSandboxId: observation.providerSandboxId }),
                });
              if (observed !== true) {
                throw new Error(
                  'Sandbox create observation is no longer current',
                );
              }
              if (ownership === undefined) legacyCreateObserved = true;
              await ctx.onSandboxCreateObserved?.(observation);
            },
            ...(providerCleanup
              ? {
                  beforeSandboxCleanup: providerCleanup.beforeSandboxCleanup,
                  afterSandboxCleanup: providerCleanup.afterSandboxCleanup,
                  settleSandboxCleanupAttempt:
                    providerCleanup.settleSandboxCleanupAttempt,
                }
              : {}),
          }
        : {}),
    });
    if (legacyProvisioning) {
      if (this.legacyProvisioningInFlight.has(ctx.taskId)) {
        throw new Error('Task already has an in-flight legacy provision');
      }
      this.legacyProvisioningInFlight.set(ctx.taskId, legacyProvisioning);
    }
    try {
      if (legacyProvisioning) {
        const entered = await this.options.ownerStore?.beginSandboxRunCreate?.({
          taskId: ctx.taskId,
          providerId: selected.id,
        });
        if (entered !== true) {
          throw new Error('Sandbox create fence is no longer current');
        }
        legacyCreateBoundaryEntered = true;
      }
      let connection: SandboxConnection;
    try {
      if (legacyProvisioning) {
        // Close the Task-CAS / ownerless-fence insertion interval even for a
        // compatibility provider that never invokes the create callback. Keep
        // this check inside the provider-failure cleanup boundary: a rejected
        // upstream lifecycle check must retire the fence it just published.
        // Callback-aware providers may invoke the same idempotent boundary
        // again immediately before their physical I/O.
        await providerContext.externalBoundaryGuard?.({
          taskId: ctx.taskId,
          action: 'sandbox.create',
          position: 'before',
        });
      }
      connection = await selected.provider.provision(providerContext);
    } catch (error) {
      // A detaching workspace transfer is a control-flow signal, not a
      // provisioning failure: the sandbox and its detached clone job survive
      // parking, so the router-level cleanup funnel must not run and the
      // durable owner record stays live for the resuming claim's re-stamp.
      if (isSandboxWorkspaceTransferDetachedSignal(error)) throw error;
      this.owners.delete(ctx.taskId);
      if (legacyProvisioning) {
        legacyProvisioning.settle();
      }
      const finalization =
        (await providerCleanup?.settleIncomplete()) ?? { kind: 'none' as const };
      if (
        isSandboxCleanupCoordinationPendingError(error) &&
        !legacyProvisioning
      ) {
        throw error;
      }
      if (finalization.kind === 'coordination-pending') {
        throw new SandboxCleanupCoordinationPendingError(error);
      }
      if (ownership) {
        try {
          await this.rethrowPrimaryAfterCleanup(error, ctx.taskId, {
            ownership,
            disposition: 'superseded-remove',
            diagnostics: ctx.diagnostics,
          });
        } finally {
          this.forgetLegacyProvisioning(ctx.taskId, legacyProvisioning);
        }
      }
      if (legacyProvisioning) {
        try {
          await this.rethrowPrimaryAfterCleanup(error, ctx.taskId, {
            disposition: 'superseded-remove',
            diagnostics: ctx.diagnostics,
          });
        } finally {
          this.forgetLegacyProvisioning(ctx.taskId, legacyProvisioning);
        }
      }
      this.forgetLegacyProvisioning(ctx.taskId, legacyProvisioning);
      throw error;
    }
    legacyProvisioning?.settle();
    const providerCleanupFinalization =
      (await providerCleanup?.settleIncomplete()) ?? { kind: 'none' as const };
    if (providerCleanupFinalization.kind === 'coordination-pending') {
      throw new SandboxCleanupCoordinationPendingError();
    }
    if (providerCleanupFinalization.kind === 'settled-physical') {
      // A provider returned a connection after beginning destructive cleanup
      // without confirming it. Finish the physical fallback as attempt N+1,
      // but never expose the now-untrustworthy connection as provisioned.
      let fallback: RoutedSandboxCleanupResult;
      try {
        fallback = await this.teardownSandboxResult(ctx.taskId, {
          cleanupAuthorization: providerCleanupFinalization.authorization,
          disposition: 'superseded-remove',
          diagnostics: ctx.diagnostics,
        });
      } catch {
        throw new SandboxCleanupCoordinationPendingError();
      }
      if (fallback.kind === 'coordination-pending') {
        throw new SandboxCleanupCoordinationPendingError();
      }
      throw new SandboxCleanupCoordinationPendingError();
    }
    try {
      this.owners.set(ctx.taskId, selected.id);
      if (this.options.ownerStore) {
        const providerRun = await this.selectedRunFor(ctx.taskId, selected);
        const environment = providerRun?.environment ?? ctx.environment ?? undefined;
        if (legacyProvisioning && !legacyCreateObserved) {
          const observed = await this.options.ownerStore.observeSandboxRunCreate?.({
            taskId: ctx.taskId,
            providerId: selected.id,
            ...(providerRun?.providerSandboxId === undefined
              ? {}
              : { providerSandboxId: providerRun.providerSandboxId }),
          });
          if (observed !== true) {
            throw new Error('Sandbox create observation is no longer current');
          }
          legacyCreateObserved = true;
        }
        await this.options.ownerStore.recordSandboxRunOwner({
          taskId: ctx.taskId,
          providerId: selected.id,
          ...(providerRun?.providerSandboxId === undefined
            ? {}
            : { providerSandboxId: providerRun.providerSandboxId }),
          ownership,
          ...(legacyProvisioning
            ? { expectedProvisioningFence: 'legacy-create-observed' as const }
            : {}),
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
        await this.rethrowPrimaryAfterCleanup(error, ctx.taskId, {
          ownership,
          disposition: 'superseded-remove',
          diagnostics: ctx.diagnostics,
        });
      }
      if (legacyProvisioning) {
        try {
          await this.rethrowPrimaryAfterCleanup(error, ctx.taskId, {
            disposition: 'superseded-remove',
            diagnostics: ctx.diagnostics,
          });
        } finally {
          this.forgetLegacyProvisioning(ctx.taskId, legacyProvisioning);
        }
      }
      this.forgetLegacyProvisioning(ctx.taskId, legacyProvisioning);
      throw error;
    }
    this.forgetLegacyProvisioning(ctx.taskId, legacyProvisioning);
    return connection;
    } finally {
      legacyProvisioning?.settle();
      this.forgetLegacyProvisioning(ctx.taskId, legacyProvisioning);
    }
  }

  async teardownSandbox(
    taskId: string,
    options: {
      readonly ownership?: SandboxOwnershipFence;
      readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
      readonly disposition?: SandboxTeardownDisposition;
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    } = {},
  ): Promise<void | SandboxPhysicalCleanupResult> {
    let result: RoutedSandboxCleanupResult;
    try {
      result = await this.teardownSandboxResult(taskId, options);
    } catch {
      throw new SandboxCleanupCoordinationPendingError();
    }
    if (result.kind === 'coordination-pending') {
      throw new SandboxCleanupCoordinationPendingError();
    }
    if (
      result.durablePending === true &&
      result.physical.outcome !== 'succeeded'
    ) {
      // Durable callers already use this safe control signal to retain their
      // lease/slot. The typed physical facts have been persisted separately.
      throw new SandboxCleanupPendingError();
    }
    return result.physical;
  }

  private async rethrowPrimaryAfterCleanup(
    primary: unknown,
    taskId: string,
    options: {
      readonly ownership?: SandboxOwnershipFence;
      readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
      readonly disposition?: SandboxTeardownDisposition;
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    },
  ): Promise<never> {
    let cleanup: RoutedSandboxCleanupResult;
    try {
      cleanup = await this.teardownSandboxResult(taskId, options);
    } catch {
      throw new SandboxCleanupCoordinationPendingError(primary);
    }
    if (cleanup.kind === 'coordination-pending') {
      throw new SandboxCleanupCoordinationPendingError(primary);
    }
    throw preserveSandboxPrimaryWithCleanup(primary, cleanup.physical).primary;
  }

  private async teardownSandboxResult(
    taskId: string,
    options: {
      readonly ownership?: SandboxOwnershipFence;
      readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
      readonly disposition?: SandboxTeardownDisposition;
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    } = {},
  ): Promise<RoutedSandboxCleanupResult> {
    flushSandboxProvisioningDiagnostics(options.diagnostics);
    this.verifiedDeliveryTargets.delete(taskId);
    const ownerStore = this.options.ownerStore;
    const beginSandboxRunCleanup = ownerStore?.beginSandboxRunCleanup?.bind(
      ownerStore,
    );
    if (ownerStore && beginSandboxRunCleanup) {
      if (!options.cleanupAuthorization && !options.ownership) {
        return this.teardownLegacySandboxResult(taskId, options);
      }
      const expectedAuthorization = options.cleanupAuthorization;
      if (expectedAuthorization && expectedAuthorization.taskId !== taskId) {
        throw new Error('Sandbox cleanup authorization task does not match');
      }
      const expectedOwnership =
        expectedAuthorization?.kind === 'generation'
          ? expectedAuthorization.ownership
          : options.ownership;
      const cleanup = await beginSandboxRunCleanup(taskId, expectedOwnership);
      if (cleanup.kind !== 'authorized') {
        if (cleanup.kind === 'absent') this.owners.delete(taskId);
        if (cleanup.kind === 'settled') {
          this.owners.delete(taskId);
          return routedCleanup(
            physicalCleanupForSettledOwner(cleanup.owner),
            false,
          );
        }
        return cleanup.kind === 'absent'
          ? routedCleanup(confirmedAbsentCleanup(), false)
          : coordinationPendingCleanup();
      }
      if (
        expectedAuthorization &&
        !sameCleanupAuthorization(cleanup.authorization, expectedAuthorization)
      ) {
        return coordinationPendingCleanup();
      }
      const entry = this.registry.get(cleanup.owner.providerId);
      if (!entry) {
        throw new Error('Persisted sandbox owner provider is not registered');
      }
      const disposition = options.disposition ?? 'terminal-retain';
      const previouslySettled = cleanupEvidenceForOwner(cleanup.owner);
      if (
        cleanup.owner.cleanupAttemptInFlight !== true &&
        previouslySettled?.outcome === 'succeeded'
      ) {
        const physical = sandboxPhysicalCleanupResultFromEvidence(
          previouslySettled,
        );
        const completed = await ownerStore.completeSandboxRunCleanup?.(
          cleanup.authorization,
          disposition === 'terminal-retain' ? 'terminal' : 'removed',
        );
        if (completed !== true) {
          return coordinationPendingCleanup(physical);
        }
        this.owners.delete(taskId);
        return routedCleanup(physical, false);
      }
      if (
        !ownerStore.beginSandboxRunCleanupAttempt ||
        !ownerStore.settleSandboxRunCleanupAttempt
      ) {
        return coordinationPendingCleanup();
      }
      const attemptKey = sandboxCleanupAttemptKey(
        cleanup.authorization,
        disposition,
      );
      const replay = this.cleanupAttemptsInFlight.get(attemptKey);
      if (replay) return replay;
      const attempt = (async (): Promise<RoutedSandboxCleanupResult> => {
        const allocated = await ownerStore.beginSandboxRunCleanupAttempt!(
          cleanup.authorization,
          randomUUID(),
        );
        if (allocated.kind !== 'allocated') {
          return coordinationPendingCleanup(
            'evidence' in allocated
              ? sandboxPhysicalCleanupResultFromEvidence(allocated.evidence)
              : undefined,
          );
        }
        let result = await runSandboxPhysicalCleanup(() =>
          entry.provider.teardownSandbox(taskId, {
            ...(cleanup.authorization.kind === 'generation'
              ? { ownership: cleanup.authorization.ownership }
              : {}),
            cleanupAuthorization: cleanup.authorization,
            ...(cleanup.owner.providerSandboxId === undefined
              ? {}
              : { providerSandboxId: cleanup.owner.providerSandboxId }),
            disposition,
            ...(options.diagnostics === undefined
              ? {}
              : { diagnostics: options.diagnostics }),
          }),
        );
        const createMayStillReturn =
          cleanup.authorization.kind === 'generation' &&
          cleanup.owner.createState !== 'idle';
        if (createMayStillReturn) {
          // Deleting a currently visible resource is not enough while a
          // replayed create may still return after that delete.
          const pending = cleanup.authorization.kind === 'generation'
            ? await ownerStore.joinSandboxRunCleanup?.({
                taskId,
                providerId: cleanup.authorization.providerId,
                ownership: cleanup.authorization.ownership,
              })
            : await beginSandboxRunCleanup(taskId);
          if (pending?.kind === 'absent') {
            this.owners.delete(taskId);
            return routedCleanup(result, false);
          }
          if (pending?.kind === 'settled') {
            this.owners.delete(taskId);
            return routedCleanup(
              physicalCleanupForSettledOwner(pending.owner),
              false,
            );
          }
          if (result.outcome === 'succeeded') {
            result = unconfirmedCleanup();
          }
          if (
            !pending ||
            pending.kind !== 'authorized' ||
            !sameCleanupAuthorization(
              pending.authorization,
              cleanup.authorization,
            )
          ) {
            return coordinationPendingCleanup(result);
          }
        }
        const evidence = sandboxCleanupAttemptEvidence(
          allocated.evidence.attempt,
          allocated.evidence.attemptId,
          result,
        );
        const recorded = await ownerStore.settleSandboxRunCleanupAttempt!(
          cleanup.authorization,
          evidence,
        );
        if (recorded.kind === 'stale' || recorded.kind === 'conflict') {
          return coordinationPendingCleanup(result);
        }
        if (result.outcome !== 'succeeded' || createMayStillReturn) {
          return routedCleanup(
            result,
            cleanup.authorization.kind === 'generation',
          );
        }
        const completed = await ownerStore.completeSandboxRunCleanup?.(
          cleanup.authorization,
          disposition === 'terminal-retain' ? 'terminal' : 'removed',
        );
        if (completed !== true) {
          return coordinationPendingCleanup(result);
        }
        this.owners.delete(taskId);
        return routedCleanup(result, false);
      })();
      this.cleanupAttemptsInFlight.set(attemptKey, attempt);
      try {
        return await attempt;
      } finally {
        if (this.cleanupAttemptsInFlight.get(attemptKey) === attempt) {
          this.cleanupAttemptsInFlight.delete(attemptKey);
        }
      }
    }
    if (options.ownership || options.cleanupAuthorization) {
      throw new Error('Sandbox ownership cleanup store is unavailable');
    }
    const owned = await this.owner(taskId);
    if (owned) {
      const result = await runSandboxPhysicalCleanup(() =>
        owned.provider.teardownSandbox(taskId, {
          disposition: options.disposition ?? 'terminal-retain',
          ...(options.diagnostics === undefined
            ? {}
            : { diagnostics: options.diagnostics }),
        }),
      );
      // Legacy admission owns only this process-local route. Release it after
      // the bounded best-effort disposition even when deletion is unconfirmed;
      // retaining it would accidentally create a second recovery authority.
      this.owners.delete(taskId);
      if (result.outcome === 'succeeded') {
        await this.options.ownerStore?.markSandboxRunOwnerStatus?.(
          taskId,
          'removed',
        );
      }
      return routedCleanup(result, false);
    }

    const results = await Promise.all(
      this.registry.list().map((entry) =>
        runSandboxPhysicalCleanup(() =>
          entry.provider.teardownSandbox(taskId, {
            disposition: options.disposition ?? 'terminal-retain',
            ...(options.diagnostics === undefined
              ? {}
              : { diagnostics: options.diagnostics }),
          }),
        ),
      ),
    );
    return routedCleanup(aggregateCleanupResults(results), false);
  }

  private async teardownLegacySandboxResult(
    taskId: string,
    options: {
      readonly disposition?: SandboxTeardownDisposition;
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    },
  ): Promise<RoutedSandboxCleanupResult> {
    const disposition = options.disposition ?? 'terminal-retain';
    const attemptKey = `legacy:${taskId}:${disposition}`;
    const replay = this.cleanupAttemptsInFlight.get(attemptKey);
    if (replay) return replay;
    const attempt = this.runLegacySandboxCleanup(taskId, options);
    this.cleanupAttemptsInFlight.set(attemptKey, attempt);
    try {
      return await attempt;
    } finally {
      if (this.cleanupAttemptsInFlight.get(attemptKey) === attempt) {
        this.cleanupAttemptsInFlight.delete(attemptKey);
      }
    }
  }

  private async runLegacySandboxCleanup(
    taskId: string,
    options: {
      readonly disposition?: SandboxTeardownDisposition;
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    },
  ): Promise<RoutedSandboxCleanupResult> {
    const ownerStore = this.options.ownerStore;
    if (!ownerStore) return coordinationPendingCleanup();
    let resumedDurableLegacy = false;
    let owner = await ownerStore.getSandboxRunOwner(taskId);
    if (!owner) {
      const authority = await this.getSandboxCleanupAuthority(taskId);
      this.owners.delete(taskId);
      const inFlight = this.legacyProvisioningInFlight.get(taskId);
      if (authority.status === null) {
        const physical = await this.runLegacyProviderBackedCleanup(
          taskId,
          options,
          inFlight?.providerId,
        );
        if (
          inFlight &&
          !(await waitForLegacyProvisioningSettled(
            inFlight.settled,
            this.options.legacyProvisionJoinTimeoutMs,
          ))
        ) {
          return coordinationPendingCleanup(
            physical.outcome === 'succeeded' ? unconfirmedCleanup() : physical,
          );
        }
        if (inFlight) {
          const refreshedAuthority = await this.getSandboxCleanupAuthority(taskId);
          if (refreshedAuthority.status !== null) {
            return this.runLegacySandboxCleanup(taskId, options);
          }
        }
        // A provider invocation may have crossed create after the first probe.
        // Once it settles, repeat the idempotent check to close that interval.
        const settledPhysical = inFlight
          ? await this.runLegacyProviderBackedCleanup(
              taskId,
              options,
              inFlight.providerId,
            )
          : physical;
        return routedCleanup(settledPhysical, false);
      }
      if (
        authority.state === 'pending' &&
        authority.ownershipKind === 'legacy' &&
        ownerStore.beginSandboxRunCleanup
      ) {
        const resumed = await ownerStore.beginSandboxRunCleanup(taskId);
        if (
          resumed.kind === 'authorized' &&
          resumed.authorization.kind === 'legacy'
        ) {
          owner = resumed.owner;
          resumedDurableLegacy = true;
        } else if (resumed.kind === 'settled') {
          return routedCleanup(
            physicalCleanupForSettledOwner(resumed.owner),
            false,
          );
        } else {
          return coordinationPendingCleanup(
            physicalCleanupForAuthority(authority),
          );
        }
      }
      if (owner) {
        // Continue below with the resumed ownerless deleting authority.
      } else {
        const physical = physicalCleanupForAuthority(authority);
        // `getSandboxRunOwner` deliberately excludes deleting rows. Seeing no
        // active owner therefore does not mean cleanup authority is absent: an
        // ordinary caller must not bypass generation-fenced cleanup or release
        // its slot before the authoritative status settles.
        return authority.state === 'pending'
          ? coordinationPendingCleanup(physical)
          : routedCleanup(physical, false);
      }
    }
    // A generation owner must be claimed by an admission/reconciliation lease.
    // Never invent a synthetic generation from the ordinary terminal path.
    if (owner.ownership) return coordinationPendingCleanup();
    if (!resumedDurableLegacy && owner.createState !== 'entered') {
      return this.runDirectLegacySandboxCleanup(taskId, owner, options);
    }
    const beginCleanup = ownerStore.beginSandboxRunCleanup;
    if (!beginCleanup) return coordinationPendingCleanup();
    const cleanup = await beginCleanup.call(ownerStore, taskId);
    if (cleanup.kind === 'settled') {
      return routedCleanup(physicalCleanupForSettledOwner(cleanup.owner), false);
    }
    if (cleanup.kind !== 'authorized' || cleanup.authorization.kind !== 'legacy') {
      return coordinationPendingCleanup();
    }
    owner = cleanup.owner;
    const initialCleanupOwner = owner;
    const entry = this.registry.get(initialCleanupOwner.providerId);
    if (!entry) return coordinationPendingCleanup();
    const disposition = options.disposition ?? 'terminal-retain';
    let preliminaryPhysical: SandboxPhysicalCleanupResult | undefined;
    if (initialCleanupOwner.createState === 'entered') {
      preliminaryPhysical = await runSandboxPhysicalCleanup(() =>
        entry.provider.teardownSandbox(taskId, {
          ...(initialCleanupOwner.providerSandboxId === undefined
            ? {}
            : { providerSandboxId: initialCleanupOwner.providerSandboxId }),
          disposition,
          ...(options.diagnostics === undefined
            ? {}
            : { diagnostics: options.diagnostics }),
        }),
      );
      this.owners.delete(taskId);
      const inFlight = this.legacyProvisioningInFlight.get(taskId);
      if (!inFlight || inFlight.providerId !== initialCleanupOwner.providerId) {
        return coordinationPendingCleanup(
          preliminaryPhysical.outcome === 'succeeded'
            ? unconfirmedCleanup()
            : preliminaryPhysical,
        );
      }
      if (
        !(await waitForLegacyProvisioningSettled(
          inFlight.settled,
          this.options.legacyProvisionJoinTimeoutMs,
        ))
      ) {
        return coordinationPendingCleanup(
          preliminaryPhysical.outcome === 'succeeded'
            ? unconfirmedCleanup()
            : preliminaryPhysical,
        );
      }
      const refreshed = await beginCleanup.call(ownerStore, taskId);
      if (
        refreshed.kind !== 'authorized' ||
        refreshed.authorization.kind !== 'legacy'
      ) {
        return refreshed.kind === 'settled'
          ? routedCleanup(
              physicalCleanupForSettledOwner(refreshed.owner),
              false,
            )
          : coordinationPendingCleanup(preliminaryPhysical);
      }
      owner = refreshed.owner;
    }
    if (
      !ownerStore.beginSandboxRunCleanupAttempt ||
      !ownerStore.settleSandboxRunCleanupAttempt ||
      !ownerStore.completeSandboxRunCleanup ||
      (owner.createState === 'entered' &&
        !ownerStore.closeLegacySandboxRunCreateFence)
    ) {
      return coordinationPendingCleanup(preliminaryPhysical);
    }
    const authorization = Object.freeze({
      kind: 'legacy' as const,
      taskId,
      providerId: owner.providerId,
    });
    const previouslySettled = cleanupEvidenceForOwner(owner);
    if (
      owner.cleanupAttemptInFlight !== true &&
      owner.createState === 'idle' &&
      previouslySettled?.outcome === 'succeeded'
    ) {
      const physical = sandboxPhysicalCleanupResultFromEvidence(
        previouslySettled,
      );
      const completed = await ownerStore.completeSandboxRunCleanup(
        authorization,
        disposition === 'superseded-remove' ? 'removed' : 'terminal',
      );
      return completed
        ? routedCleanup(physical, false)
        : coordinationPendingCleanup(physical);
    }
    const allocated = await ownerStore.beginSandboxRunCleanupAttempt(
      authorization,
      randomUUID(),
    );
    if (allocated.kind !== 'allocated') {
      return coordinationPendingCleanup(
        'evidence' in allocated
          ? sandboxPhysicalCleanupResultFromEvidence(allocated.evidence)
          : preliminaryPhysical,
      );
    }
    const cleanupOwner = owner;
    let physical: SandboxPhysicalCleanupResult;
    try {
      physical = await runSandboxPhysicalCleanup(() =>
        entry.provider.teardownSandbox(taskId, {
          ...(cleanupOwner.providerSandboxId === undefined
            ? {}
            : { providerSandboxId: cleanupOwner.providerSandboxId }),
          disposition,
          ...(options.diagnostics === undefined
            ? {}
            : { diagnostics: options.diagnostics }),
        }),
      );
    } finally {
      this.owners.delete(taskId);
    }
    let effectivePhysical = physical;
    if (physical.outcome === 'succeeded' && cleanupOwner.createState === 'entered') {
      const closed = await ownerStore.closeLegacySandboxRunCreateFence?.({
        taskId,
        providerId: cleanupOwner.providerId,
        ...(cleanupOwner.providerSandboxId === undefined
          ? {}
          : { providerSandboxId: cleanupOwner.providerSandboxId }),
      });
      if (closed !== true) effectivePhysical = unconfirmedCleanup();
    }
    const evidence = sandboxCleanupAttemptEvidence(
      allocated.evidence.attempt,
      allocated.evidence.attemptId,
      effectivePhysical,
    );
    const settled = await ownerStore.settleSandboxRunCleanupAttempt(
      authorization,
      evidence,
    );
    if (settled.kind === 'stale' || settled.kind === 'conflict') {
      return coordinationPendingCleanup(effectivePhysical);
    }
    if (effectivePhysical.outcome !== 'succeeded') {
      // This is the exceptional terminal-winner/create-in-flight path. Keep
      // its deleting fence until a later bounded attempt can prove absence;
      // ordinary idle legacy owners use the direct terminal settlement path.
      return coordinationPendingCleanup(effectivePhysical);
    }
    const completed = await ownerStore.completeSandboxRunCleanup(
      authorization,
      disposition === 'superseded-remove' ? 'removed' : 'terminal',
    );
    return completed
      ? routedCleanup(effectivePhysical, false)
      : coordinationPendingCleanup(effectivePhysical);
  }

  private async runDirectLegacySandboxCleanup(
    taskId: string,
    owner: SandboxRunOwnerRecord,
    options: {
      readonly disposition?: SandboxTeardownDisposition;
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    },
  ): Promise<RoutedSandboxCleanupResult> {
    const ownerStore = this.options.ownerStore;
    const entry = this.registry.get(owner.providerId);
    if (!ownerStore?.settleLegacySandboxRunCleanup || !entry) {
      return coordinationPendingCleanup();
    }
    const disposition = options.disposition ?? 'terminal-retain';
    let physical: SandboxPhysicalCleanupResult;
    try {
      physical = await runSandboxPhysicalCleanup(() =>
        entry.provider.teardownSandbox(taskId, {
          ...(owner.providerSandboxId === undefined
            ? {}
            : { providerSandboxId: owner.providerSandboxId }),
          disposition,
          ...(options.diagnostics === undefined
            ? {}
            : { diagnostics: options.diagnostics }),
        }),
      );
    } finally {
      this.owners.delete(taskId);
    }
    const evidence = sandboxCleanupAttemptEvidence(
      (owner.cleanupAttemptCount ?? 0) + 1,
      randomUUID(),
      physical,
    );
    const settled = await ownerStore.settleLegacySandboxRunCleanup({
      taskId,
      providerId: owner.providerId,
      disposition,
      evidence,
      status:
        disposition === 'superseded-remove' &&
        physical.outcome === 'succeeded'
          ? 'removed'
          : 'terminal',
    });
    return settled.kind === 'recorded' || settled.kind === 'replayed'
      ? routedCleanup(physical, false)
      : coordinationPendingCleanup(physical);
  }

  private async runLegacyProviderBackedCleanup(
    taskId: string,
    options: {
      readonly disposition?: SandboxTeardownDisposition;
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    },
    providerId?: string,
  ): Promise<SandboxPhysicalCleanupResult> {
    const selectedEntry =
      providerId === undefined ? undefined : this.registry.get(providerId);
    const entries =
      providerId === undefined
        ? this.registry.list()
        : selectedEntry
          ? [selectedEntry]
          : [];
    if (entries.length === 0) return unconfirmedCleanup();
    const results = await Promise.all(
      entries.map((entry) =>
        runSandboxPhysicalCleanup(() =>
          entry.provider.teardownSandbox(taskId, {
            disposition: options.disposition ?? 'terminal-retain',
            ...(options.diagnostics === undefined
              ? {}
              : { diagnostics: options.diagnostics }),
          }),
        ),
      ),
    );
    return aggregateCleanupResults(results);
  }

  private forgetLegacyProvisioning(
    taskId: string,
    attempt: LegacyProvisioningInFlight | undefined,
  ): void {
    if (
      attempt &&
      this.legacyProvisioningInFlight.get(taskId) === attempt
    ) {
      this.legacyProvisioningInFlight.delete(taskId);
    }
  }

  /**
   * Bridge provider-internal cleanup callbacks onto the durable owner-store
   * attempt protocol. The provider sees only authorization callbacks; the
   * router owns allocation, evidence settlement, and authoritative completion.
   */
  private createProviderContextCleanupCallbacks(options: {
    readonly authorize: () => Promise<{
      readonly authorization: SandboxRunCleanupAuthorization;
      /** True only when no create response can still materialize this resource. */
      readonly confirmedAbsenceIsFinal: boolean;
      /** Propagate the effective physical result through an outer owner fence. */
      readonly afterSettlement?: (
        physical: SandboxPhysicalCleanupResult,
      ) => Promise<void>;
    } | null>;
    readonly completedStatus: 'removed' | 'terminal';
  }): ProviderContextCleanupCallbacks {
    const ownerStore = this.options.ownerStore;
    if (
      !ownerStore?.beginSandboxRunCleanupAttempt ||
      !ownerStore.settleSandboxRunCleanupAttempt ||
      !ownerStore.completeSandboxRunCleanup
    ) {
      throw new Error('Durable provider cleanup attempt store is unavailable');
    }
    const beginAttempt =
      ownerStore.beginSandboxRunCleanupAttempt.bind(ownerStore);
    const settleAttempt =
      ownerStore.settleSandboxRunCleanupAttempt.bind(ownerStore);
    const completeCleanup =
      ownerStore.completeSandboxRunCleanup.bind(ownerStore);

    let coordinationPending = false;
    let active:
      | {
          readonly authorization: SandboxRunCleanupAuthorization;
          readonly allocation: SandboxCleanupAttemptEvidence;
          readonly afterSettlement?: (
            physical: SandboxPhysicalCleanupResult,
          ) => Promise<void>;
          settled: boolean;
          completed: boolean;
          settledEvidence?: SandboxCleanupAttemptEvidence;
          attemptPhysical?: SandboxPhysicalCleanupResult;
          attemptEvidence?: SandboxCleanupAttemptEvidence;
          afterPromise?: Promise<void>;
          settlementAcknowledged: boolean;
          readonly confirmedAbsenceIsFinal: boolean;
        }
      | undefined;

    const failCoordination = (): void => {
      coordinationPending = true;
    };

    const settle = async (
      evidence: SandboxCleanupAttemptEvidence,
    ): Promise<boolean> => {
      if (!active) return false;
      let result;
      try {
        result = await settleAttempt(active.authorization, evidence);
      } catch {
        coordinationPending = true;
        return false;
      }
      if (result.kind !== 'recorded' && result.kind !== 'replayed') {
        coordinationPending = true;
        return false;
      }
      active.settled = true;
      active.settledEvidence = evidence;
      return true;
    };

    const acknowledgeProviderCleanupSettlement = async (
      current: NonNullable<typeof active>,
    ): Promise<boolean> => {
      if (current.settlementAcknowledged) return true;
      if (current.afterSettlement) {
        try {
          await current.afterSettlement(
            current.attemptPhysical ?? unconfirmedCleanup(),
          );
        } catch {
          return false;
        }
      }
      current.settlementAcknowledged = true;
      return true;
    };

    const settleProviderCleanupAttempt = async (
      authorization: SandboxRunCleanupAuthorization,
      suppliedPhysical: SandboxPhysicalCleanupResult,
    ): Promise<void> => {
      if (
        !active ||
        !sameCleanupAuthorization(active.authorization, authorization)
      ) {
        failCoordination();
        return;
      }
      const current = active;
      let reportedPhysical: SandboxPhysicalCleanupResult;
      try {
        reportedPhysical = validateSandboxPhysicalCleanupResult(suppliedPhysical);
      } catch {
        failCoordination();
        return;
      }
      // Absence observed while the create closure can still return is useful
      // physical evidence, but it is not final proof for durable authority.
      const effectivePhysical =
        !current.confirmedAbsenceIsFinal &&
        reportedPhysical.outcome === 'succeeded'
          ? unconfirmedCleanup()
          : reportedPhysical;
      if (
        current.attemptPhysical &&
        !samePhysicalCleanupResult(current.attemptPhysical, effectivePhysical)
      ) {
        failCoordination();
        return;
      }
      current.attemptPhysical ??= effectivePhysical;
      current.attemptEvidence ??= sandboxCleanupAttemptEvidence(
        current.allocation.attempt,
        current.allocation.attemptId,
        current.attemptPhysical,
      );
      if (current.afterPromise) {
        await current.afterPromise;
        return;
      }
      current.afterPromise = (async () => {
        if (!current.settled && !(await settle(current.attemptEvidence!))) {
          failCoordination();
          return;
        }
        if (current.attemptPhysical!.outcome !== 'succeeded') {
          if (!(await acknowledgeProviderCleanupSettlement(current))) {
            failCoordination();
          }
          return;
        }

        let completed = false;
        try {
          completed = await completeCleanup(
            current.authorization,
            options.completedStatus,
          );
        } catch {
          failCoordination();
          return;
        }
        if (!completed) {
          failCoordination();
          return;
        }
        current.completed = true;
        if (!(await acknowledgeProviderCleanupSettlement(current))) {
          failCoordination();
        }
      })();
      await current.afterPromise;
    };

    return Object.freeze({
      beforeSandboxCleanup: async () => {
        // A second physical action cannot be authorized while this provider
        // invocation still owns an unsettled attempt.
        if (active && !active.completed) {
          coordinationPending = true;
          return null;
        }
        let authorized;
        try {
          authorized = await options.authorize();
        } catch {
          coordinationPending = true;
          return null;
        }
        if (!authorized) return null;

        let allocated;
        try {
          allocated = await beginAttempt(
            authorized.authorization,
            randomUUID(),
          );
        } catch {
          coordinationPending = true;
          return null;
        }
        if (allocated.kind !== 'allocated') {
          coordinationPending = true;
          return null;
        }
        active = {
          authorization: authorized.authorization,
          allocation: allocated.evidence,
          afterSettlement: authorized.afterSettlement,
          confirmedAbsenceIsFinal: authorized.confirmedAbsenceIsFinal,
          settled: false,
          completed: false,
          settlementAcknowledged: false,
        };
        return active.authorization;
      },
      afterSandboxCleanup: async (
        authorization: SandboxRunCleanupAuthorization,
      ) => {
        await settleProviderCleanupAttempt(
          authorization,
          confirmedAbsentCleanup(),
        );
      },
      settleSandboxCleanupAttempt: settleProviderCleanupAttempt,
      settleIncomplete: async (): Promise<ProviderContextCleanupFinalization> => {
        if (coordinationPending) {
          return {
            kind: 'coordination-pending',
            ...(active === undefined
              ? {}
              : { authorization: active.authorization }),
          };
        }
        if (!active || active.completed) {
          return { kind: 'none' };
        }
        if (active.settled) {
          if (!active.settledEvidence) {
            return {
              kind: 'coordination-pending',
              authorization: active.authorization,
            };
          }
          const physical = sandboxPhysicalCleanupResultFromEvidence(
            active.settledEvidence,
          );
          return physical.outcome === 'succeeded'
            ? { kind: 'none' }
            : {
                kind: 'settled-physical',
                authorization: active.authorization,
                physical,
              };
        }
        // Once either settlement seam supplied a physical result, never
        // overwrite an ambiguous store acknowledgement with a fabricated
        // indeterminate result.
        if (active.attemptEvidence) {
          return {
            kind: 'coordination-pending',
            authorization: active.authorization,
          };
        }
        const evidence = sandboxCleanupAttemptEvidence(
          active.allocation.attempt,
          active.allocation.attemptId,
          unconfirmedCleanup(),
        );
        if (!(await settle(evidence))) {
          return {
            kind: 'coordination-pending',
            authorization: active.authorization,
          };
        }
        const physical = sandboxPhysicalCleanupResultFromEvidence(evidence);
        if (!(await acknowledgeProviderCleanupSettlement(active))) {
          return {
            kind: 'coordination-pending',
            authorization: active.authorization,
          };
        }
        return {
          kind: 'settled-physical',
          authorization: active.authorization,
          physical,
        };
      },
    });
  }

  /**
   * Legacy delivery may need to fence credential material by removing its
   * sandbox, but it has no restart-safe generation owner. Keep that one
   * provider invocation best-effort and settle its bounded evidence directly
   * from the active row to a final status; never manufacture `deleting` and
   * thereby create a second automatic recovery authority.
   */
  private createLegacyProviderContextCleanupCallbacks(
    taskId: string,
    providerId: string,
  ): ProviderContextCleanupCallbacks {
    const ownerStore = this.options.ownerStore;
    const settleLegacy = ownerStore?.settleLegacySandboxRunCleanup?.bind(
      ownerStore,
    );
    if (!ownerStore || !settleLegacy) {
      throw new Error('Legacy provider cleanup evidence store is unavailable');
    }

    let coordinationPending = false;
    let active:
      | {
          readonly authorization: Extract<
            SandboxRunCleanupAuthorization,
            { readonly kind: 'legacy' }
          >;
          readonly attempt: number;
          readonly attemptId: string;
          physical?: SandboxPhysicalCleanupResult;
          evidence?: SandboxCleanupAttemptEvidence;
          settlement?: Promise<void>;
          settled: boolean;
        }
      | undefined;

    const settlePhysical = async (
      authorization: SandboxRunCleanupAuthorization,
      suppliedPhysical: SandboxPhysicalCleanupResult,
    ): Promise<void> => {
      if (
        !active ||
        authorization.kind !== 'legacy' ||
        !sameCleanupAuthorization(active.authorization, authorization)
      ) {
        coordinationPending = true;
        return;
      }
      let physical: SandboxPhysicalCleanupResult;
      try {
        physical = validateSandboxPhysicalCleanupResult(suppliedPhysical);
      } catch {
        coordinationPending = true;
        return;
      }
      if (active.physical && !samePhysicalCleanupResult(active.physical, physical)) {
        coordinationPending = true;
        return;
      }
      active.physical ??= physical;
      active.evidence ??= sandboxCleanupAttemptEvidence(
        active.attempt,
        active.attemptId,
        active.physical,
      );
      if (!active.settlement) {
        const current = active;
        current.settlement = (async () => {
          let settled;
          try {
            settled = await settleLegacy({
              taskId,
              providerId,
              disposition: 'superseded-remove',
              evidence: current.evidence!,
              status:
                current.physical!.outcome === 'succeeded'
                  ? 'removed'
                  : 'terminal',
            });
          } catch {
            coordinationPending = true;
            return;
          }
          if (settled.kind !== 'recorded' && settled.kind !== 'replayed') {
            coordinationPending = true;
            return;
          }
          current.settled = true;
          this.owners.delete(taskId);
          this.verifiedDeliveryTargets.delete(taskId);
        })();
      }
      await active.settlement;
    };

    return Object.freeze({
      beforeSandboxCleanup: async () => {
        if (active) {
          coordinationPending = true;
          return null;
        }
        let owner: SandboxRunOwnerRecord | null;
        try {
          owner = await ownerStore.getSandboxRunOwner(taskId);
        } catch {
          coordinationPending = true;
          return null;
        }
        if (!owner) return null;
        if (owner.providerId !== providerId || owner.ownership) {
          coordinationPending = true;
          return null;
        }
        const authorization = Object.freeze({
          kind: 'legacy' as const,
          taskId,
          providerId,
        });
        active = {
          authorization,
          attempt: (owner.cleanupAttemptCount ?? 0) + 1,
          attemptId: randomUUID(),
          settled: false,
        };
        return authorization;
      },
      afterSandboxCleanup: async (
        authorization: SandboxRunCleanupAuthorization,
      ) => {
        await settlePhysical(authorization, confirmedAbsentCleanup());
      },
      settleSandboxCleanupAttempt: settlePhysical,
      settleIncomplete: async (): Promise<ProviderContextCleanupFinalization> => {
        if (!active) {
          return coordinationPending
            ? { kind: 'coordination-pending' }
            : { kind: 'none' };
        }
        if (!active.evidence) {
          await settlePhysical(active.authorization, unconfirmedCleanup());
        } else if (active.settlement) {
          await active.settlement;
        }
        if (coordinationPending || !active.settled || !active.evidence) {
          return {
            kind: 'coordination-pending',
            authorization: active.authorization,
          };
        }
        const physical = sandboxPhysicalCleanupResultFromEvidence(
          active.evidence,
        );
        return physical.outcome === 'succeeded'
          ? { kind: 'none' }
          : {
              kind: 'settled-physical',
              authorization: active.authorization,
              physical,
            };
      },
    });
  }

  async claimSandboxCleanupOwnership(
    taskId: string,
    ownerGeneration: string,
  ): Promise<SandboxCleanupOwnershipClaim> {
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
      return {
        kind: 'absent',
        authority: absentCleanupAuthority(),
      };
    }
    if (claimed.kind === 'settled') {
      this.owners.delete(taskId);
      return {
        kind: 'settled',
        authority: cleanupAuthorityForOwner(claimed.owner),
      };
    }
    if (
      claimed.kind !== 'authorized' ||
      claimed.authorization.kind !== 'generation'
    ) {
      throw new Error('Sandbox cleanup owner cannot be claimed');
    }
    return {
      kind: 'authorized',
      authorization: claimed.authorization,
      authority: cleanupAuthorityForOwner(claimed.owner),
    };
  }

  async getSandboxCleanupAuthority(
    taskId: string,
  ): Promise<SandboxRunCleanupAuthorityProjection> {
    const ownerStore = this.options.ownerStore;
    if (!ownerStore) return absentCleanupAuthority();
    if (!ownerStore.getSandboxRunCleanupAuthority) {
      throw new SandboxCleanupCoordinationPendingError();
    }
    return ownerStore.getSandboxRunCleanupAuthority(taskId);
  }

  async failSandboxCleanupByTerminalPolicy(
    authorization: Extract<
      SandboxRunCleanupAuthorization,
      { readonly kind: 'generation' }
    >,
    expectedAttempt: number,
  ): Promise<SandboxRunCleanupAuthorityProjection> {
    const settle = this.options.ownerStore
      ?.failSandboxRunCleanupByTerminalPolicy;
    if (!settle) throw new SandboxCleanupCoordinationPendingError();
    let result;
    try {
      result = await settle.call(
        this.options.ownerStore,
        authorization,
        expectedAttempt,
      );
    } catch {
      throw new SandboxCleanupCoordinationPendingError();
    }
    if (result.kind !== 'failed' && result.kind !== 'replayed') {
      throw new SandboxCleanupCoordinationPendingError();
    }
    this.owners.delete(authorization.taskId);
    return cleanupAuthorityForOwner(result.owner);
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
      !ownerStore.beginSandboxRunCleanupAttempt ||
      !ownerStore.settleSandboxRunCleanupAttempt ||
      !ownerStore.completeSandboxRunCleanup ||
      !ownerStore.failSandboxRunCleanupByTerminalPolicy ||
      !ownerStore.getSandboxRunCleanupAuthority ||
      !ownerStore.settleLegacySandboxRunCleanup
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
      if (!acquired.owner.ownership) {
        await this.teardownSandbox(taskId, {
          disposition: 'superseded-remove',
        });
      } else {
        const cleanupClaim = await this.claimSandboxCleanupOwnership(
          taskId,
          requested.ownerGeneration,
        );
        if (cleanupClaim.kind === 'absent') {
          throw new Error('Sandbox cleanup owner disappeared before cleanup');
        }
        if (cleanupClaim.kind === 'settled') {
          if (cleanupClaim.authority.state === 'failed') {
            throw new Error('Previous sandbox cleanup reached terminal policy');
          }
        } else {
          await this.teardownSandbox(taskId, {
            cleanupAuthorization: cleanupClaim.authorization,
            disposition: 'superseded-remove',
          });
        }
      }
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
      const delivery = this.deliveryContextForOwner(
        taskId,
        resolved.owner.id,
        resolved.ownerRecord,
        args,
      );
      let result: SandboxDeliverWorkspaceResult;
      try {
        result = await resolved.owner.provider.deliverWorkspaceChanges(
          taskId,
          delivery.args,
        );
      } catch (error) {
        const finalization =
          (await delivery.cleanup?.settleIncomplete()) ?? {
            kind: 'none' as const,
          };
        if (isSandboxCleanupCoordinationPendingError(error)) throw error;
        if (finalization.kind === 'coordination-pending') {
          throw new SandboxCleanupCoordinationPendingError(error);
        }
        if (finalization.kind === 'settled-physical') {
          await this.rethrowPrimaryAfterCleanup(error, taskId, {
            cleanupAuthorization: finalization.authorization,
            disposition: 'superseded-remove',
          });
        }
        throw error;
      }

      const finalization =
        (await delivery.cleanup?.settleIncomplete()) ?? {
          kind: 'none' as const,
        };
      if (finalization.kind === 'coordination-pending') {
        throw new SandboxCleanupCoordinationPendingError();
      }
      if (finalization.kind === 'settled-physical') {
        let fallback: RoutedSandboxCleanupResult;
        try {
          fallback = await this.teardownSandboxResult(taskId, {
            cleanupAuthorization: finalization.authorization,
            disposition: 'superseded-remove',
          });
        } catch {
          throw new SandboxCleanupCoordinationPendingError();
        }
        if (fallback.kind === 'coordination-pending') {
          throw new SandboxCleanupCoordinationPendingError();
        }
        // The provider returned without acknowledging its destructive cleanup
        // callback. Even when fallback confirms absence, its delivery result
        // cannot be trusted as a usable live-sandbox outcome.
        throw new SandboxCleanupCoordinationPendingError();
      }
      return result;
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
    const ownerStore = this.options.ownerStore;
    const confirmCleanupOrphan =
      ownerStore?.confirmSandboxRunCleanupOrphan?.bind(ownerStore);
    const cleanupObservationTaskIds = new Set<string>();
    if (ownerStore) {
      if (
        !ownerStore.getSandboxRunCleanupAuthority ||
        !confirmCleanupOrphan
      ) {
        throw new SandboxCleanupCoordinationPendingError();
      }
      await Promise.all(
        protectedTaskIds.map(async (taskId) => {
          const authority =
            await ownerStore.getSandboxRunCleanupAuthority!(taskId);
          if (
            authority.status === 'deleting' &&
            authority.ownershipKind === 'generation'
          ) {
            cleanupObservationTaskIds.add(taskId);
          }
        }),
      );
    }
    // Provider inventory must freshly inspect a deleting generation before we
    // can confirm an orphan. Remove only those exact cleanup-authority tasks
    // from the provider's stale snapshot filter; the callback below remains an
    // unconditional no-reap fence for every candidate carrying that task id.
    const providerProtectedTaskIds = protectedTaskIds.filter(
      (taskId) => !cleanupObservationTaskIds.has(taskId),
    );
    const results = await Promise.all(
      this.providersFor(READOPTION_SANDBOX_REQUIRED_CAPABILITIES).map(
        (entry) =>
          entry.provider.reconcileSandboxInventory?.({
            protectedTaskIds: providerProtectedTaskIds,
            canReap: async (candidate) => {
              if (ownerStore && confirmCleanupOrphan) {
                const confirmation =
                  await confirmCleanupOrphan({
                    taskId: candidate.taskId,
                    providerId: entry.id,
                    providerSandboxId: candidate.providerSandboxId,
                  });
                if (
                  confirmation.kind === 'recorded' ||
                  confirmation.kind === 'replayed'
                ) {
                  // The exact deleting generation remains canonical cleanup
                  // authority. Inventory presence is evidence for diagnosis,
                  // not permission for startup orphan reaping.
                  return false;
                }
                const activeOwner = await ownerStore.getSandboxRunOwner(
                  candidate.taskId,
                );
                if (activeOwner) return false;
                if (cleanupObservationTaskIds.has(candidate.taskId)) {
                  // A mismatched resource for the same task is not proof about
                  // the canonical generation, but removing the task from the
                  // provider snapshot must never widen reap authority.
                  return false;
                }
              }
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
  private deliveryContextForOwner(
    taskId: string,
    providerId: string,
    ownerRecord: SandboxRunOwnerRecord | undefined,
    args: SandboxDeliverWorkspaceArgs,
  ): RoutedSandboxDeliveryContext {
    if (isSandboxLegacyDeliverWorkspaceArgs(args)) {
      return Object.freeze({
        args: Object.freeze({
          branch: args.branch,
          commitMessage: args.commitMessage,
          authHeader: args.authHeader,
        }),
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
    if (!ownerRecord) return Object.freeze({ args: Object.freeze(safeArgs) });
    const ownership = ownerRecord.ownership;

    const ownerStore = this.options.ownerStore;
    if (!ownership) {
      const cleanup = this.createLegacyProviderContextCleanupCallbacks(
        taskId,
        providerId,
      );
      return Object.freeze({
        args: Object.freeze({
          ...safeArgs,
          beforeSandboxCleanup: cleanup.beforeSandboxCleanup,
          afterSandboxCleanup: cleanup.afterSandboxCleanup,
          settleSandboxCleanupAttempt: cleanup.settleSandboxCleanupAttempt,
        }),
        cleanup,
      });
    }
    if (
      !ownerStore?.beginSandboxRunCleanup ||
      !ownerStore.beginSandboxRunCleanupAttempt ||
      !ownerStore.settleSandboxRunCleanupAttempt ||
      !ownerStore.completeSandboxRunCleanup
    ) {
      throw new Error('Durable sandbox delivery cleanup store is unavailable');
    }
    const beginCleanup = ownerStore.beginSandboxRunCleanup.bind(ownerStore);
    const cleanup = this.createProviderContextCleanupCallbacks({
      authorize: async () => {
        this.verifiedDeliveryTargets.delete(taskId);
        const authorized = await beginCleanup(taskId, ownership);
        if (authorized.kind === 'absent') return null;
        if (authorized.kind !== 'authorized') {
          throw new SandboxCleanupCoordinationPendingError();
        }
        const expectedAuthorization: SandboxRunCleanupAuthorization = {
          kind: 'generation',
          taskId,
          providerId,
          ownership,
        };
        if (
          !sameCleanupAuthorization(
            authorized.authorization,
            expectedAuthorization,
          )
        ) {
          throw new Error(
            'Sandbox delivery cleanup authorization does not match the selected owner',
          );
        }
        return {
          authorization: authorized.authorization,
          confirmedAbsenceIsFinal: authorized.owner.createState === 'idle',
        };
      },
      completedStatus: 'removed',
    });
    return Object.freeze({
      args: Object.freeze({
        ...safeArgs,
        ...(ownership ? { ownership } : {}),
        beforeSandboxCleanup: cleanup.beforeSandboxCleanup,
        afterSandboxCleanup: cleanup.afterSandboxCleanup,
        settleSandboxCleanupAttempt: cleanup.settleSandboxCleanupAttempt,
      }),
      cleanup,
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

function sandboxCleanupAttemptKey(
  authorization: SandboxRunCleanupAuthorization,
  disposition: SandboxTeardownDisposition,
): string {
  return authorization.kind === 'generation'
    ? [
        'generation',
        authorization.taskId,
        authorization.providerId,
        authorization.ownership.resourceGeneration,
        disposition,
      ].join('\u0000')
    : [
        'legacy',
        authorization.taskId,
        authorization.providerId,
        disposition,
      ].join('\u0000');
}

/**
 * Diagnostics are evidence, never cleanup authority. When the task-scoped
 * observer supports the sequencing barrier, wait for already-enqueued primary
 * facts before fallback physical I/O; an unavailable/failed recorder remains a
 * partial-diagnostics concern and cannot block cleanup recovery.
 */
function flushSandboxProvisioningDiagnostics(
  diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
): void {
  const flush = (
    diagnostics as
      | (SandboxProvisioningDiagnosticObserver & {
          readonly flush?: () => Promise<void>;
        })
      | undefined
  )?.flush;
  if (typeof flush !== 'function') return;
  try {
    void Promise.resolve(flush.call(diagnostics)).catch(() => undefined);
  } catch {
    // Diagnostic persistence cannot become provider cleanup authority.
  }
}

function samePhysicalCleanupResult(
  left: SandboxPhysicalCleanupResult,
  right: SandboxPhysicalCleanupResult,
): boolean {
  return (
    left.outcome === right.outcome &&
    left.proof === right.proof &&
    left.cause === right.cause &&
    left.retryable === right.retryable
  );
}

function routedCleanup(
  physical: SandboxPhysicalCleanupResult,
  durablePending: boolean,
): RoutedSandboxCleanupResult {
  return Object.freeze({ kind: 'physical' as const, physical, durablePending });
}

function coordinationPendingCleanup(
  physical?: SandboxPhysicalCleanupResult,
): RoutedSandboxCleanupResult {
  return Object.freeze({
    kind: 'coordination-pending' as const,
    durablePending: true as const,
    ...(physical === undefined ? {} : { physical }),
  });
}

function cleanupEvidenceForOwner(
  owner: SandboxRunOwnerRecord,
): SandboxCleanupAttemptEvidence | null {
  const attempt = owner.cleanupAttemptCount ?? 0;
  if (attempt === 0) return null;
  if (
    owner.cleanupLastAttemptId === undefined ||
    owner.cleanupLastOutcome === undefined ||
    owner.cleanupLastProof === undefined ||
    owner.cleanupLastCause === undefined ||
    owner.cleanupLastRetryable === undefined ||
    owner.cleanupLastObservedAt === undefined
  ) {
    throw new Error('Sandbox cleanup evidence is incomplete');
  }
  return validateSandboxCleanupAttemptEvidence({
    attemptId: owner.cleanupLastAttemptId,
    attempt,
    outcome: owner.cleanupLastOutcome,
    proof: owner.cleanupLastProof,
    cause: owner.cleanupLastCause,
    retryable: owner.cleanupLastRetryable,
    observedAt: owner.cleanupLastObservedAt,
  });
}

function absentCleanupAuthority(): SandboxRunCleanupAuthorityProjection {
  return Object.freeze({
    state: 'not_required' as const,
    ownershipKind: 'none' as const,
    orphanState: 'none' as const,
    status: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    lastAttemptProof: null,
    lastAttemptCause: null,
    lastAttemptRetryable: null,
    lastAttemptObservedAt: null,
  });
}

function cleanupAuthorityForOwner(
  owner: SandboxRunOwnerRecord,
): SandboxRunCleanupAuthorityProjection {
  const status = owner.status;
  return Object.freeze({
    state:
      status === 'deleting'
        ? 'pending'
        : status === 'removed'
          ? 'succeeded'
          : status === 'failed'
            ? 'failed'
            : 'not_required',
    ownershipKind: owner.ownership ? 'generation' : 'legacy',
    orphanState:
      status === 'deleting' || status === 'failed'
        ? owner.cleanupOrphanConfirmedAt
          ? 'confirmed'
          : 'unknown'
        : 'none',
    status,
    attemptCount: owner.cleanupAttemptCount ?? 0,
    lastAttemptOutcome: owner.cleanupLastOutcome ?? null,
    lastAttemptProof: owner.cleanupLastProof ?? null,
    lastAttemptCause: owner.cleanupLastCause ?? null,
    lastAttemptRetryable: owner.cleanupLastRetryable ?? null,
    lastAttemptObservedAt: owner.cleanupLastObservedAt
      ? new Date(owner.cleanupLastObservedAt)
      : null,
  });
}

function physicalCleanupForSettledOwner(
  owner: SandboxRunOwnerRecord & {
    readonly status: 'terminal' | 'removed' | 'failed';
  },
): SandboxPhysicalCleanupResult {
  const evidence = cleanupEvidenceForOwner(owner);
  if (evidence) return sandboxPhysicalCleanupResultFromEvidence(evidence);
  return owner.status === 'removed'
    ? confirmedAbsentCleanup()
    : unconfirmedCleanup();
}

function physicalCleanupForAuthority(
  authority: SandboxRunCleanupAuthorityProjection,
): SandboxPhysicalCleanupResult {
  if (
    authority.attemptCount > 0 &&
    authority.lastAttemptOutcome !== null &&
    authority.lastAttemptRetryable !== null
  ) {
    return validateSandboxPhysicalCleanupResult({
      outcome: authority.lastAttemptOutcome,
      proof: authority.lastAttemptProof,
      cause: authority.lastAttemptCause,
      retryable: authority.lastAttemptRetryable,
    } as SandboxPhysicalCleanupResult);
  }
  return authority.status === 'removed'
    ? confirmedAbsentCleanup()
    : unconfirmedCleanup();
}

function confirmedAbsentCleanup(): SandboxPhysicalCleanupResult {
  return normalizeSandboxPhysicalCleanupResult({ kind: 'already-absent' });
}

function unconfirmedCleanup(): SandboxPhysicalCleanupResult {
  return normalizeSandboxPhysicalCleanupResult(undefined);
}

function createLegacyProvisioningInFlight(
  providerId: string,
): LegacyProvisioningInFlight {
  let resolveSettled!: () => void;
  let didSettle = false;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return Object.freeze({
    providerId,
    settled,
    settle: () => {
      if (didSettle) return;
      didSettle = true;
      resolveSettled();
    },
  });
}

const DEFAULT_LEGACY_PROVISION_JOIN_TIMEOUT_MS = 1_000;

async function waitForLegacyProvisioningSettled(
  settled: Promise<void>,
  configuredTimeoutMs: number | undefined,
): Promise<boolean> {
  const timeoutMs =
    configuredTimeoutMs !== undefined &&
    Number.isFinite(configuredTimeoutMs) &&
    configuredTimeoutMs > 0
      ? Math.floor(configuredTimeoutMs)
      : DEFAULT_LEGACY_PROVISION_JOIN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function aggregateCleanupResults(
  results: readonly SandboxPhysicalCleanupResult[],
): SandboxPhysicalCleanupResult {
  const failed = results.find((result) => result.outcome === 'failed');
  if (failed) return failed;
  const indeterminate = results.find(
    (result) => result.outcome === 'indeterminate',
  );
  if (indeterminate) return indeterminate;
  const cleaned = results.find(
    (result) => result.proof === 'found-and-cleaned',
  );
  return cleaned ?? confirmedAbsentCleanup();
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
