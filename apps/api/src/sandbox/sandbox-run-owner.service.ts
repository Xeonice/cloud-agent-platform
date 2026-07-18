import { Injectable } from '@nestjs/common';
import {
  RuntimeArtifactChecksumsSchema,
  SandboxEnvironmentResourcesSchema,
  SandboxMetadataSchema,
  Sha256ChecksumSchema,
} from '@cap/contracts';
import type {
  AcquireSandboxRunOwnerArgs,
  AcquireSandboxRunOwnerResult,
  BeginSandboxCleanupAttemptResult,
  BeginSandboxRunCreateArgs,
  BeginSandboxRunCleanupResult,
  ClaimSandboxRunCleanupResult,
  ConfirmSandboxRunCleanupOrphanArgs,
  ConfirmSandboxRunCleanupOrphanResult,
  FailSandboxRunCleanupByTerminalPolicyResult,
  JoinSandboxRunCleanupArgs,
  JoinSandboxRunCleanupResult,
  ObserveSandboxRunCreateArgs,
  RecordSandboxRunOwnerArgs,
  SandboxCleanupAttemptEvidence,
  SandboxConnection,
  SandboxDescriptorMetadata,
  SandboxResolvedEnvironmentMetadata,
  SandboxOwnershipFence,
  SandboxRunCleanupAuthorityProjection,
  SandboxRunCleanupAuthorization,
  SandboxRunCreateState,
  SandboxRunOwnerRecord,
  SandboxRunOwnerStatus,
  SandboxRunOwnerStore,
  SettleLegacySandboxRunCleanupArgs,
  SettleLegacySandboxRunCleanupResult,
  SettleSandboxCleanupAttemptResult,
} from '@cap/sandbox';
import {
  SANDBOX_CLEANUP_ATTEMPT_MAX,
  sandboxCleanupAttemptPlaceholder,
  validateSandboxCleanupAttemptEvidence,
  validateSandboxCleanupAttemptId,
} from '@cap/sandbox';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_SANDBOX_RUN_STATUSES: readonly SandboxRunOwnerStatus[] = [
  'provisioning',
  'running',
];

const RESUMABLE_SANDBOX_RUN_STATUSES: readonly SandboxRunOwnerStatus[] = [
  'running',
];

const LIVE_SANDBOX_RUN_STATUSES: readonly SandboxRunOwnerStatus[] = [
  ...ACTIVE_SANDBOX_RUN_STATUSES,
  'deleting',
];

/**
 * Prisma-backed provider-owner store for provisioned sandbox runs.
 *
 * Stores only routing metadata used to reattach/deliver/teardown after restart.
 * Secrets stay out of this table; provider credentials remain in their existing
 * encrypted settings/credential stores.
 */
@Injectable()
export class SandboxRunOwnerService implements SandboxRunOwnerStore {
  constructor(private readonly prisma: PrismaService) {}

  async getSandboxRunOwner(taskId: string): Promise<SandboxRunOwnerRecord | null> {
    const run = await this.prisma.sandboxRun.findFirst({
      where: {
        taskId,
        status: { in: [...ACTIVE_SANDBOX_RUN_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    });
    return run ? SandboxRunOwnerService.toOwnerRecord(run) : null;
  }

  async getSandboxRunCleanupAuthority(
    taskId: string,
  ): Promise<SandboxRunCleanupAuthorityProjection> {
    const run = await this.prisma.sandboxRun.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });
    return SandboxRunOwnerService.toCleanupAuthorityProjection(
      run ? SandboxRunOwnerService.toOwnerRecord(run) : undefined,
    );
  }

  async listActiveSandboxRunOwners(): Promise<readonly SandboxRunOwnerRecord[]> {
    const runs = await this.prisma.sandboxRun.findMany({
      where: {
        status: { in: [...RESUMABLE_SANDBOX_RUN_STATUSES] },
      },
      orderBy: { createdAt: 'asc' },
    });
    return runs.map((run) => SandboxRunOwnerService.toOwnerRecord(run));
  }

  async recordSandboxRunOwner(args: RecordSandboxRunOwnerArgs): Promise<void> {
    await this.withTaskOwnerLock(args.taskId, async (client) => {
      // connection.taskId is the logical CAP task id, not a provider-attested
      // physical sandbox id. Persist only an explicit provider identity.
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId: args.taskId,
          status: { in: [...LIVE_SANDBOX_RUN_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          providerId: true,
          providerSandboxId: true,
          ownerGeneration: true,
          resourceGeneration: true,
          createState: true,
          status: true,
          cleanupOrphanConfirmedAt: true,
        },
      });
      if (args.ownership) {
        if (
          !existing ||
          existing.status === 'deleting' ||
          existing.ownerGeneration !== args.ownership.ownerGeneration ||
          existing.resourceGeneration !== args.ownership.resourceGeneration
        ) {
          throw new Error('Sandbox owner generation is no longer current');
        }
      } else if (
        existing &&
        (existing.status === 'deleting' ||
          existing.ownerGeneration !== null ||
          existing.resourceGeneration !== null)
      ) {
        throw new Error('Ownerless sandbox records cannot replace a durable owner');
      }
      if (
        existing &&
        (existing.providerId !== args.providerId ||
          (existing.providerSandboxId !== null &&
            args.providerSandboxId !== undefined &&
            existing.providerSandboxId !== args.providerSandboxId &&
            !(args.ownership && existing.status === 'provisioning')))
      ) {
        throw new Error('Task already has a different active sandbox owner');
      }
      const metadata = SandboxRunOwnerService.mergeEnvironmentMetadata(
        args.metadata,
        args.environment,
      );
      const data = {
        ...(args.providerSandboxId === undefined
          ? {}
          : { providerSandboxId: args.providerSandboxId }),
        ...(args.providerSandboxId !== undefined &&
        args.providerSandboxId !== existing?.providerSandboxId
          ? { cleanupOrphanConfirmedAt: null }
          : {}),
        createState: 'idle',
        status: args.status ?? 'running',
        ...(args.ownership
          ? {
              ownerGeneration: args.ownership.ownerGeneration,
              resourceGeneration: args.ownership.resourceGeneration,
            }
          : {}),
        connectionJson: SandboxRunOwnerService.toJsonConnection(args.connection),
        metadata: SandboxRunOwnerService.toJsonMetadata(metadata),
        terminalAt: null,
        removedAt: null,
      } satisfies Prisma.SandboxRunUpdateInput;

      if (existing) {
        await client.sandboxRun.update({
          where: { id: existing.id },
          data,
        });
        return;
      }

      await client.sandboxRun.create({
        data: {
          taskId: args.taskId,
          providerId: args.providerId,
          ...data,
        },
      });
    });
  }

  async acquireSandboxRunOwner(
    args: AcquireSandboxRunOwnerArgs,
  ): Promise<AcquireSandboxRunOwnerResult> {
    assertGeneration(args.ownerGeneration, 'ownerGeneration');
    assertGeneration(args.proposedResourceGeneration, 'resourceGeneration');
    return this.withTaskOwnerLock(args.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId: args.taskId,
          status: { in: [...LIVE_SANDBOX_RUN_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) {
        await client.sandboxRun.create({
          data: {
            taskId: args.taskId,
            providerId: args.providerId,
            providerSandboxId: null,
            ownerGeneration: args.ownerGeneration,
            resourceGeneration: args.proposedResourceGeneration,
            createState: 'idle',
            status: 'provisioning',
            connectionJson: undefined,
            metadata: undefined,
            terminalAt: null,
            removedAt: null,
          },
        });
        return {
          kind: 'acquired',
          ownership: Object.freeze({
            ownerGeneration: args.ownerGeneration,
            resourceGeneration: args.proposedResourceGeneration,
          }),
        };
      }

      const owner = SandboxRunOwnerService.toOwnerRecord(existing);
      if (existing.status === 'deleting') {
        return { kind: 'cleanup-required', owner };
      }
      if (existing.providerId !== args.providerId) {
        return { kind: 'conflict', owner };
      }
      if (!owner.ownership) {
        return { kind: 'cleanup-required', owner };
      }

      const ownership = Object.freeze({
        ownerGeneration: args.ownerGeneration,
        resourceGeneration: owner.ownership.resourceGeneration,
      });
      await client.sandboxRun.update({
        where: { id: existing.id },
        data: {
          ownerGeneration: ownership.ownerGeneration,
          status: 'provisioning',
          terminalAt: null,
          removedAt: null,
        },
      });
      return { kind: 'acquired', ownership, previousOwner: owner };
    });
  }

  async beginSandboxRunCreate(args: BeginSandboxRunCreateArgs): Promise<boolean> {
    assertGeneration(args.ownership.ownerGeneration, 'ownerGeneration');
    assertGeneration(args.ownership.resourceGeneration, 'resourceGeneration');
    return this.withTaskOwnerLock(args.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId: args.taskId,
          providerId: args.providerId,
          status: 'provisioning',
          ownerGeneration: args.ownership.ownerGeneration,
          resourceGeneration: args.ownership.resourceGeneration,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return false;
      if (existing.createState !== 'entered') {
        await client.sandboxRun.update({
          where: { id: existing.id },
          data: { createState: 'entered' },
        });
      }
      return true;
    });
  }

  async observeSandboxRunCreate(
    args: ObserveSandboxRunCreateArgs,
  ): Promise<boolean> {
    assertGeneration(args.resourceGeneration, 'resourceGeneration');
    return this.withTaskOwnerLock(args.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId: args.taskId,
          providerId: args.providerId,
          resourceGeneration: args.resourceGeneration,
          status: { in: [...LIVE_SANDBOX_RUN_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return false;
      if (
        existing.createState === 'idle' &&
        args.providerSandboxId !== undefined &&
        existing.providerSandboxId !== null &&
        existing.providerSandboxId !== args.providerSandboxId
      ) {
        return false;
      }
      await client.sandboxRun.update({
        where: { id: existing.id },
        data: {
          createState: 'idle',
          ...(args.providerSandboxId === undefined
            ? {}
            : { providerSandboxId: args.providerSandboxId }),
          ...(args.providerSandboxId !== undefined &&
          args.providerSandboxId !== existing.providerSandboxId
            ? { cleanupOrphanConfirmedAt: null }
            : {}),
        },
      });
      return true;
    });
  }

  async beginSandboxRunCleanup(
    taskId: string,
    ownership?: SandboxOwnershipFence,
  ): Promise<BeginSandboxRunCleanupResult> {
    if (ownership) {
      assertGeneration(ownership.ownerGeneration, 'ownerGeneration');
      assertGeneration(ownership.resourceGeneration, 'resourceGeneration');
    }
    return this.withTaskOwnerLock(taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'absent' } as const;
      if (SandboxRunOwnerService.isSettledStatus(existing.status)) {
        return {
          kind: 'settled',
          owner: SandboxRunOwnerService.toSettledOwnerRecord(existing),
        } as const;
      }
      if (
        (ownership &&
          (existing.ownerGeneration !== ownership.ownerGeneration ||
            existing.resourceGeneration !== ownership.resourceGeneration)) ||
        (!ownership &&
          (existing.ownerGeneration !== null || existing.resourceGeneration !== null))
      ) {
        return { kind: 'stale' } as const;
      }
      if (existing.status !== 'deleting') {
        await client.sandboxRun.update({
          where: { id: existing.id },
          data: { status: 'deleting' },
        });
      }
      const owner = {
        ...SandboxRunOwnerService.toOwnerRecord(existing),
        status: 'deleting' as const,
      };
      return {
        kind: 'authorized',
        owner,
        authorization: SandboxRunOwnerService.cleanupAuthorizationFor(owner),
      } as const;
    });
  }

  async claimSandboxRunCleanup(
    taskId: string,
    ownerGeneration: string,
  ): Promise<ClaimSandboxRunCleanupResult> {
    assertGeneration(ownerGeneration, 'ownerGeneration');
    return this.withTaskOwnerLock(taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'absent' } as const;
      if (SandboxRunOwnerService.isSettledStatus(existing.status)) {
        return {
          kind: 'settled',
          owner: SandboxRunOwnerService.toSettledOwnerRecord(existing),
        } as const;
      }
      if (
        (existing.ownerGeneration === null) !==
        (existing.resourceGeneration === null)
      ) {
        return { kind: 'conflict' } as const;
      }
      const isTakeover = existing.ownerGeneration
        ? existing.ownerGeneration !== ownerGeneration
        : false;
      const settledExisting =
        isTakeover && existing.cleanupAttemptInFlight
          ? { ...existing, cleanupAttemptInFlight: false }
          : existing;
      const owner = settledExisting.ownerGeneration && settledExisting.resourceGeneration
        ? SandboxRunOwnerService.toOwnerRecord({
            ...settledExisting,
            ownerGeneration,
            status: 'deleting',
          })
        : SandboxRunOwnerService.toOwnerRecord({
            ...settledExisting,
            status: 'deleting',
          });
      await client.sandboxRun.update({
        where: { id: existing.id },
        data: {
          status: 'deleting',
          ...(settledExisting.ownerGeneration && settledExisting.resourceGeneration
            ? { ownerGeneration }
            : {}),
          ...(isTakeover && existing.cleanupAttemptInFlight
            ? { cleanupAttemptInFlight: false }
            : {}),
        },
      });
      return {
        kind: 'authorized',
        owner,
        authorization: SandboxRunOwnerService.cleanupAuthorizationFor(owner),
      } as const;
    });
  }

  async joinSandboxRunCleanup(
    args: JoinSandboxRunCleanupArgs,
  ): Promise<JoinSandboxRunCleanupResult> {
    assertGeneration(args.ownership.ownerGeneration, 'ownerGeneration');
    assertGeneration(args.ownership.resourceGeneration, 'resourceGeneration');
    return this.withTaskOwnerLock(args.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId: args.taskId,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'absent' } as const;
      if (SandboxRunOwnerService.isSettledStatus(existing.status)) {
        return {
          kind: 'settled',
          owner: SandboxRunOwnerService.toSettledOwnerRecord(existing),
        } as const;
      }
      if (
        existing.providerId !== args.providerId ||
        !existing.ownerGeneration ||
        !existing.resourceGeneration
      ) {
        return { kind: 'conflict' } as const;
      }
      if (existing.resourceGeneration !== args.ownership.resourceGeneration) {
        return { kind: 'stale' } as const;
      }
      if (
        existing.status !== 'deleting' &&
        existing.ownerGeneration !== args.ownership.ownerGeneration
      ) {
        return { kind: 'stale' } as const;
      }
      if (existing.status !== 'deleting') {
        await client.sandboxRun.update({
          where: { id: existing.id },
          data: { status: 'deleting' },
        });
      }
      const owner = SandboxRunOwnerService.toOwnerRecord({
        ...existing,
        status: 'deleting',
      });
      const authorization = SandboxRunOwnerService.cleanupAuthorizationFor(owner);
      if (authorization.kind !== 'generation') {
        return { kind: 'conflict' } as const;
      }
      return { kind: 'authorized', owner, authorization } as const;
    });
  }

  async completeSandboxRunCleanup(
    authorization: SandboxRunCleanupAuthorization,
    status: Extract<SandboxRunOwnerStatus, 'removed' | 'terminal'>,
  ): Promise<boolean> {
    if (authorization.kind === 'generation') {
      assertGeneration(authorization.ownership.ownerGeneration, 'ownerGeneration');
      assertGeneration(authorization.ownership.resourceGeneration, 'resourceGeneration');
    }
    return this.withTaskOwnerLock(authorization.taskId, async (client) => {
      const changed = await client.sandboxRun.updateMany({
        where: {
          taskId: authorization.taskId,
          providerId: authorization.providerId,
          status: 'deleting',
          cleanupAttemptInFlight: false,
          cleanupAttemptCount: { gt: 0 },
          cleanupLastOutcome: 'succeeded',
          cleanupLastProof: {
            in: ['found-and-cleaned', 'already-absent'],
          },
          cleanupLastCause: null,
          cleanupLastRetryable: false,
          ...(authorization.kind === 'generation'
            ? {
                resourceGeneration: authorization.ownership.resourceGeneration,
                createState: 'idle',
              }
            : { ownerGeneration: null, resourceGeneration: null }),
        },
        data: {
          status,
          terminalAt:
            status === 'terminal' ? new Date() : undefined,
          removedAt: status === 'removed' ? new Date() : undefined,
        },
      });
      return changed.count === 1;
    });
  }

  async beginSandboxRunCleanupAttempt(
    authorization: SandboxRunCleanupAuthorization,
    attemptId: string,
  ): Promise<BeginSandboxCleanupAttemptResult> {
    validateSandboxCleanupAttemptId(attemptId);
    if (authorization.kind === 'generation') {
      assertGeneration(authorization.ownership.ownerGeneration, 'ownerGeneration');
      assertGeneration(
        authorization.ownership.resourceGeneration,
        'resourceGeneration',
      );
    }
    return this.withTaskOwnerLock(authorization.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId: authorization.taskId,
          providerId: authorization.providerId,
          status: 'deleting',
          ...(authorization.kind === 'generation'
            ? {
                ownerGeneration: authorization.ownership.ownerGeneration,
                resourceGeneration:
                  authorization.ownership.resourceGeneration,
              }
            : { ownerGeneration: null, resourceGeneration: null }),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'stale' } as const;
      const current = SandboxRunOwnerService.toCleanupEvidence(existing);
      if (current?.attemptId === attemptId) {
        return { kind: 'replayed', evidence: current } as const;
      }
      if (existing.cleanupAttemptInFlight) {
        return current
          ? ({ kind: 'in-flight', evidence: current } as const)
          : ({ kind: 'conflict' } as const);
      }
      if (existing.cleanupAttemptCount >= SANDBOX_CLEANUP_ATTEMPT_MAX) {
        return { kind: 'conflict' } as const;
      }
      const evidence = sandboxCleanupAttemptPlaceholder(
        existing.cleanupAttemptCount + 1,
        attemptId,
      );
      await client.sandboxRun.update({
        where: { id: existing.id },
        data: {
          cleanupAttemptInFlight: true,
          cleanupAttemptCount: evidence.attempt,
          cleanupLastAttemptId: evidence.attemptId,
          cleanupLastOutcome: evidence.outcome,
          cleanupLastProof: evidence.proof,
          cleanupLastCause: evidence.cause,
          cleanupLastRetryable: evidence.retryable,
          cleanupLastObservedAt: evidence.observedAt,
        },
      });
      return { kind: 'allocated', evidence } as const;
    });
  }

  async settleSandboxRunCleanupAttempt(
    authorization: SandboxRunCleanupAuthorization,
    evidence: SandboxCleanupAttemptEvidence,
  ): Promise<SettleSandboxCleanupAttemptResult> {
    const candidate = validateSandboxCleanupAttemptEvidence(evidence);
    if (authorization.kind === 'generation') {
      assertGeneration(authorization.ownership.ownerGeneration, 'ownerGeneration');
      assertGeneration(
        authorization.ownership.resourceGeneration,
        'resourceGeneration',
      );
    }
    return this.withTaskOwnerLock(authorization.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: {
          taskId: authorization.taskId,
          providerId: authorization.providerId,
          status: 'deleting',
          ...(authorization.kind === 'generation'
            ? {
                ownerGeneration: authorization.ownership.ownerGeneration,
                resourceGeneration:
                  authorization.ownership.resourceGeneration,
              }
            : { ownerGeneration: null, resourceGeneration: null }),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'stale' } as const;
      if (candidate.attempt < existing.cleanupAttemptCount) {
        return { kind: 'stale' } as const;
      }
      if (
        candidate.attempt !== existing.cleanupAttemptCount ||
        candidate.attemptId !== existing.cleanupLastAttemptId
      ) {
        return { kind: 'conflict' } as const;
      }
      if (
        candidate.outcome === 'succeeded' &&
        existing.createState !== 'idle'
      ) {
        return { kind: 'conflict' } as const;
      }
      if (!existing.cleanupAttemptInFlight) {
        return SandboxRunOwnerService.sameCleanupEvidence(existing, candidate)
          ? ({ kind: 'replayed' } as const)
          : ({ kind: 'conflict' } as const);
      }
      await client.sandboxRun.update({
        where: { id: existing.id },
        data: {
          cleanupAttemptInFlight: false,
          cleanupLastOutcome: candidate.outcome,
          cleanupLastProof: candidate.proof,
          cleanupLastCause: candidate.cause,
          cleanupLastRetryable: candidate.retryable,
          cleanupLastObservedAt: candidate.observedAt,
        },
      });
      return { kind: 'recorded' } as const;
    });
  }

  async failSandboxRunCleanupByTerminalPolicy(
    authorization: Extract<
      SandboxRunCleanupAuthorization,
      { readonly kind: 'generation' }
    >,
    expectedAttempt: number,
  ): Promise<FailSandboxRunCleanupByTerminalPolicyResult> {
    assertGeneration(authorization.ownership.ownerGeneration, 'ownerGeneration');
    assertGeneration(
      authorization.ownership.resourceGeneration,
      'resourceGeneration',
    );
    if (
      !Number.isSafeInteger(expectedAttempt) ||
      expectedAttempt < 1 ||
      expectedAttempt > SANDBOX_CLEANUP_ATTEMPT_MAX
    ) {
      return { kind: 'conflict' };
    }
    return this.withTaskOwnerLock(authorization.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: { taskId: authorization.taskId },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'stale' } as const;
      const exact =
        existing.createState === 'idle' &&
        existing.providerId === authorization.providerId &&
        existing.ownerGeneration === authorization.ownership.ownerGeneration &&
        existing.resourceGeneration ===
          authorization.ownership.resourceGeneration &&
        existing.cleanupAttemptCount === expectedAttempt;
      if (existing.status === 'failed') {
        return exact &&
          !existing.cleanupAttemptInFlight &&
          existing.cleanupLastOutcome !== null &&
          existing.cleanupLastOutcome !== 'succeeded'
          ? ({
              kind: 'replayed',
              owner: {
                ...SandboxRunOwnerService.toSettledOwnerRecord(existing),
                status: 'failed' as const,
              },
            } as const)
          : ({ kind: 'stale' } as const);
      }
      if (existing.status !== 'deleting' || !exact) {
        return { kind: 'stale' } as const;
      }
      if (
        existing.cleanupAttemptInFlight ||
        existing.cleanupLastOutcome === null ||
        existing.cleanupLastOutcome === 'succeeded'
      ) {
        return { kind: 'conflict' } as const;
      }
      await SandboxRunOwnerService.enableCleanupTransition(
        client,
        'terminal_policy',
      );
      const changed = await client.sandboxRun.updateMany({
        where: {
          id: existing.id,
          status: 'deleting',
          createState: 'idle',
          providerId: authorization.providerId,
          ownerGeneration: authorization.ownership.ownerGeneration,
          resourceGeneration: authorization.ownership.resourceGeneration,
          cleanupAttemptInFlight: false,
          cleanupAttemptCount: expectedAttempt,
          cleanupLastOutcome: { in: ['failed', 'indeterminate'] },
        },
        data: { status: 'failed' },
      });
      if (changed.count !== 1) return { kind: 'stale' } as const;
      return {
        kind: 'failed',
        owner: {
          ...SandboxRunOwnerService.toSettledOwnerRecord({
            ...existing,
            status: 'failed',
          }),
          status: 'failed' as const,
        },
      } as const;
    });
  }

  async settleLegacySandboxRunCleanup(
    args: SettleLegacySandboxRunCleanupArgs,
  ): Promise<SettleLegacySandboxRunCleanupResult> {
    const evidence = validateSandboxCleanupAttemptEvidence(args.evidence);
    if (
      !SandboxRunOwnerService.legacySettlementStatusMatches(
        args.status,
        args.disposition,
        evidence,
      )
    ) {
      return { kind: 'conflict' };
    }
    return this.withTaskOwnerLock(args.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: { taskId: args.taskId },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing || existing.providerId !== args.providerId) {
        return { kind: 'stale' } as const;
      }
      if (SandboxRunOwnerService.isSettledStatus(existing.status)) {
        return existing.status === args.status &&
          SandboxRunOwnerService.sameCleanupEvidence(existing, evidence)
          ? ({
              kind: 'replayed',
              owner: SandboxRunOwnerService.toSettledOwnerRecord(existing),
            } as const)
          : ({ kind: 'stale' } as const);
      }
      if (
        existing.status === 'deleting' ||
        existing.ownerGeneration !== null ||
        existing.resourceGeneration !== null ||
        existing.cleanupAttemptInFlight ||
        evidence.attempt !== existing.cleanupAttemptCount + 1
      ) {
        return { kind: 'conflict' } as const;
      }
      await SandboxRunOwnerService.enableCleanupTransition(
        client,
        'legacy_settlement',
      );
      const changed = await client.sandboxRun.updateMany({
        where: {
          id: existing.id,
          status: { in: [...ACTIVE_SANDBOX_RUN_STATUSES] },
          ownerGeneration: null,
          resourceGeneration: null,
          cleanupAttemptInFlight: false,
          cleanupAttemptCount: existing.cleanupAttemptCount,
        },
        data: {
          status: args.status,
          cleanupAttemptInFlight: false,
          cleanupAttemptCount: evidence.attempt,
          cleanupLastAttemptId: evidence.attemptId,
          cleanupLastOutcome: evidence.outcome,
          cleanupLastProof: evidence.proof,
          cleanupLastCause: evidence.cause,
          cleanupLastRetryable: evidence.retryable,
          cleanupLastObservedAt: evidence.observedAt,
          terminalAt: args.status === 'terminal' ? new Date() : undefined,
          removedAt: args.status === 'removed' ? new Date() : undefined,
        },
      });
      if (changed.count !== 1) return { kind: 'stale' } as const;
      return {
        kind: 'recorded',
        owner: SandboxRunOwnerService.toSettledOwnerRecord({
          ...existing,
          status: args.status,
          cleanupAttemptInFlight: false,
          cleanupAttemptCount: evidence.attempt,
          cleanupLastAttemptId: evidence.attemptId,
          cleanupLastOutcome: evidence.outcome,
          cleanupLastProof: evidence.proof,
          cleanupLastCause: evidence.cause,
          cleanupLastRetryable: evidence.retryable,
          cleanupLastObservedAt: evidence.observedAt,
        }),
      } as const;
    });
  }

  async confirmSandboxRunCleanupOrphan(
    args: ConfirmSandboxRunCleanupOrphanArgs,
  ): Promise<ConfirmSandboxRunCleanupOrphanResult> {
    return this.withTaskOwnerLock(args.taskId, async (client) => {
      const existing = await client.sandboxRun.findFirst({
        where: { taskId: args.taskId },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'stale' } as const;
      if (
        existing.status !== 'deleting' ||
        existing.ownerGeneration === null ||
        existing.resourceGeneration === null ||
        existing.providerId !== args.providerId ||
        existing.providerSandboxId !== args.providerSandboxId
      ) {
        return { kind: 'conflict' } as const;
      }
      if (existing.cleanupOrphanConfirmedAt) {
        return {
          kind: 'replayed',
          owner: SandboxRunOwnerService.toOwnerRecord(existing),
        } as const;
      }
      await SandboxRunOwnerService.enableCleanupTransition(
        client,
        'orphan_confirmation',
      );
      const confirmedAt = new Date();
      const changed = await client.sandboxRun.updateMany({
        where: {
          id: existing.id,
          status: 'deleting',
          providerId: args.providerId,
          providerSandboxId: args.providerSandboxId,
          ownerGeneration: existing.ownerGeneration,
          resourceGeneration: existing.resourceGeneration,
          cleanupOrphanConfirmedAt: null,
        },
        data: { cleanupOrphanConfirmedAt: confirmedAt },
      });
      if (changed.count !== 1) return { kind: 'stale' } as const;
      return {
        kind: 'recorded',
        owner: SandboxRunOwnerService.toOwnerRecord({
          ...existing,
          cleanupOrphanConfirmedAt: confirmedAt,
        }),
      } as const;
    });
  }

  async markSandboxRunOwnerStatus(
    taskId: string,
    status: SandboxRunOwnerStatus,
  ): Promise<void> {
    // Cleanup entry and terminal-policy failure have dedicated fenced methods.
    if (status === 'deleting' || status === 'failed') return;
    await this.withTaskOwnerLock(taskId, async (client) => {
      await client.sandboxRun.updateMany({
        where: {
          taskId,
          status:
            status === 'removed' || status === 'terminal'
              ? { in: [...LIVE_SANDBOX_RUN_STATUSES] }
              : { in: [...ACTIVE_SANDBOX_RUN_STATUSES] },
          ...(status === 'removed' || status === 'terminal'
            ? {
                OR: [
                  // Preserve the existing non-cleanup terminal transition.
                  // Only a deleting row is governed by the cleanup protocol.
                  { status: { in: [...ACTIVE_SANDBOX_RUN_STATUSES] } },
                  {
                    status: 'deleting',
                    createState: 'idle',
                    cleanupAttemptInFlight: false,
                    cleanupAttemptCount: { gt: 0 },
                    cleanupLastOutcome: 'succeeded',
                    cleanupLastProof: {
                      in: ['found-and-cleaned', 'already-absent'],
                    },
                    cleanupLastCause: null,
                    cleanupLastRetryable: false,
                  },
                ],
              }
            : {}),
        },
        data: {
          status,
          terminalAt: status === 'terminal' ? new Date() : undefined,
          removedAt: status === 'removed' ? new Date() : undefined,
        },
      });
    });
  }

  private async withTaskOwnerLock<T>(
    taskId: string,
    operation: (
      client: Pick<Prisma.TransactionClient, 'sandboxRun'> & {
        readonly $executeRaw?: Prisma.TransactionClient['$executeRaw'];
      },
    ) => Promise<T>,
  ): Promise<T> {
    // Small unit adapters predating transaction support remain usable; the
    // production PrismaService always takes the advisory-lock transaction.
    if (typeof this.prisma.$transaction !== 'function') {
      return operation(this.prisma);
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${taskId}, 0))
      `);
      return operation(tx);
    });
  }

  markSandboxRunTerminal(taskId: string): Promise<void> {
    return this.markSandboxRunOwnerStatus(taskId, 'terminal');
  }

  markSandboxRunRemoved(taskId: string): Promise<void> {
    return this.markSandboxRunOwnerStatus(taskId, 'removed');
  }

  private static toOwnerRecord(run: {
    taskId: string;
    providerId: string;
    providerSandboxId: string | null;
    ownerGeneration: string | null;
    resourceGeneration: string | null;
    createState: string;
    status: string;
    connectionJson: Prisma.JsonValue | null;
    metadata: Prisma.JsonValue | null;
    cleanupAttemptInFlight?: boolean;
    cleanupAttemptCount?: number;
    cleanupLastAttemptId?: string | null;
    cleanupLastOutcome?: string | null;
    cleanupLastProof?: string | null;
    cleanupLastCause?: string | null;
    cleanupLastRetryable?: boolean | null;
    cleanupLastObservedAt?: Date | null;
    cleanupOrphanConfirmedAt?: Date | null;
  }): SandboxRunOwnerRecord {
    const metadata = SandboxRunOwnerService.toMetadata(run.metadata);
    const cleanupEvidence = SandboxRunOwnerService.toCleanupEvidence(run);
    return {
      taskId: run.taskId,
      providerId: run.providerId,
      providerSandboxId: run.providerSandboxId ?? undefined,
      ownership:
        run.ownerGeneration && run.resourceGeneration
          ? Object.freeze({
              ownerGeneration: run.ownerGeneration,
              resourceGeneration: run.resourceGeneration,
            })
          : undefined,
      createState: SandboxRunOwnerService.toCreateState(run.createState),
      status: SandboxRunOwnerService.toOwnerStatus(run.status),
      connection: SandboxRunOwnerService.toConnection(run.connectionJson),
      environment: SandboxRunOwnerService.toResolvedEnvironment(metadata?.environment),
      metadata,
      cleanupAttemptInFlight: run.cleanupAttemptInFlight ?? false,
      cleanupAttemptCount: run.cleanupAttemptCount ?? 0,
      ...(run.cleanupOrphanConfirmedAt
        ? { cleanupOrphanConfirmedAt: new Date(run.cleanupOrphanConfirmedAt) }
        : {}),
      ...(cleanupEvidence
        ? {
            cleanupLastAttemptId: cleanupEvidence.attemptId,
            cleanupLastOutcome: cleanupEvidence.outcome,
            cleanupLastProof: cleanupEvidence.proof,
            cleanupLastCause: cleanupEvidence.cause,
            cleanupLastRetryable: cleanupEvidence.retryable,
            cleanupLastObservedAt: cleanupEvidence.observedAt,
          }
        : {}),
    };
  }

  private static toCleanupAuthorityProjection(
    owner: SandboxRunOwnerRecord | undefined,
  ): SandboxRunCleanupAuthorityProjection {
    const status = owner?.status ?? null;
    const state =
      status === 'deleting'
        ? 'pending'
        : status === 'removed'
          ? 'succeeded'
          : status === 'failed'
            ? 'failed'
            : 'not_required';
    return Object.freeze({
      state,
      ownershipKind: owner
        ? owner.ownership
          ? 'generation'
          : 'legacy'
        : 'none',
      orphanState:
        status === 'deleting' || status === 'failed'
          ? owner?.cleanupOrphanConfirmedAt
            ? 'confirmed'
            : 'unknown'
          : 'none',
      status,
      attemptCount: owner?.cleanupAttemptCount ?? 0,
      lastAttemptOutcome: owner?.cleanupLastOutcome ?? null,
      lastAttemptProof: owner?.cleanupLastProof ?? null,
      lastAttemptCause: owner?.cleanupLastCause ?? null,
      lastAttemptRetryable: owner?.cleanupLastRetryable ?? null,
      lastAttemptObservedAt: owner?.cleanupLastObservedAt
        ? new Date(owner.cleanupLastObservedAt)
        : null,
    });
  }

  private static isSettledStatus(
    status: string,
  ): status is 'terminal' | 'removed' | 'failed' {
    return status === 'terminal' || status === 'removed' || status === 'failed';
  }

  private static toSettledOwnerRecord(
    run: Parameters<typeof SandboxRunOwnerService.toOwnerRecord>[0],
  ): SandboxRunOwnerRecord & {
    readonly status: 'terminal' | 'removed' | 'failed';
  } {
    const owner = SandboxRunOwnerService.toOwnerRecord(run);
    if (!SandboxRunOwnerService.isSettledStatus(owner.status)) {
      throw new Error('Sandbox cleanup authority is not settled');
    }
    return owner as SandboxRunOwnerRecord & {
      readonly status: 'terminal' | 'removed' | 'failed';
    };
  }

  private static legacySettlementStatusMatches(
    status: SettleLegacySandboxRunCleanupArgs['status'],
    disposition: SettleLegacySandboxRunCleanupArgs['disposition'],
    evidence: SandboxCleanupAttemptEvidence,
  ): boolean {
    return status ===
      (disposition === 'superseded-remove' &&
      evidence.outcome === 'succeeded'
        ? 'removed'
        : 'terminal');
  }

  private static async enableCleanupTransition(
    client: {
      readonly $executeRaw?: Prisma.TransactionClient['$executeRaw'];
    },
    kind:
      | 'terminal_policy'
      | 'legacy_settlement'
      | 'orphan_confirmation',
  ): Promise<void> {
    if (typeof client.$executeRaw !== 'function') return;
    if (kind === 'terminal_policy') {
      await client.$executeRaw(
        Prisma.sql`SET LOCAL cap.sandbox_cleanup_terminal_policy = 'on'`,
      );
      return;
    }
    if (kind === 'orphan_confirmation') {
      await client.$executeRaw(
        Prisma.sql`SET LOCAL cap.sandbox_cleanup_orphan_confirmation = 'on'`,
      );
      return;
    }
    await client.$executeRaw(
      Prisma.sql`SET LOCAL cap.sandbox_cleanup_legacy_settlement = 'on'`,
    );
  }

  private static sameCleanupEvidence(
    run: {
      cleanupLastAttemptId: string | null;
      cleanupLastOutcome: string | null;
      cleanupLastProof: string | null;
      cleanupLastCause: string | null;
      cleanupLastRetryable: boolean | null;
      cleanupLastObservedAt: Date | null;
    },
    evidence: SandboxCleanupAttemptEvidence,
  ): boolean {
    return (
      run.cleanupLastAttemptId === evidence.attemptId &&
      run.cleanupLastOutcome === evidence.outcome &&
      run.cleanupLastProof === evidence.proof &&
      run.cleanupLastCause === evidence.cause &&
      run.cleanupLastRetryable === evidence.retryable &&
      run.cleanupLastObservedAt?.getTime() === evidence.observedAt.getTime()
    );
  }

  private static toCleanupEvidence(run: {
    cleanupAttemptCount?: number;
    cleanupLastAttemptId?: string | null;
    cleanupLastOutcome?: string | null;
    cleanupLastProof?: string | null;
    cleanupLastCause?: string | null;
    cleanupLastRetryable?: boolean | null;
    cleanupLastObservedAt?: Date | null;
  }): SandboxCleanupAttemptEvidence | null {
    const attempt = run.cleanupAttemptCount ?? 0;
    if (attempt === 0) return null;
    if (
      run.cleanupLastAttemptId === null ||
      run.cleanupLastAttemptId === undefined ||
      run.cleanupLastOutcome === null ||
      run.cleanupLastOutcome === undefined ||
      run.cleanupLastRetryable === null ||
      run.cleanupLastRetryable === undefined ||
      run.cleanupLastObservedAt === null ||
      run.cleanupLastObservedAt === undefined
    ) {
      throw new Error('Sandbox cleanup evidence is incomplete');
    }
    return validateSandboxCleanupAttemptEvidence({
      attemptId: run.cleanupLastAttemptId,
      attempt,
      outcome: run.cleanupLastOutcome as SandboxCleanupAttemptEvidence['outcome'],
      proof: (run.cleanupLastProof ?? null) as SandboxCleanupAttemptEvidence['proof'],
      cause: (run.cleanupLastCause ?? null) as SandboxCleanupAttemptEvidence['cause'],
      retryable: run.cleanupLastRetryable,
      observedAt: run.cleanupLastObservedAt,
    });
  }

  private static toCreateState(value: string): SandboxRunCreateState {
    if (value === 'idle' || value === 'entered') return value;
    throw new Error(`Unknown sandbox create state: ${value}`);
  }

  private static cleanupAuthorizationFor(
    owner: SandboxRunOwnerRecord,
  ): SandboxRunCleanupAuthorization {
    return owner.ownership
      ? Object.freeze({
          kind: 'generation' as const,
          taskId: owner.taskId,
          providerId: owner.providerId,
          ownership: owner.ownership,
        })
      : Object.freeze({
          kind: 'legacy' as const,
          taskId: owner.taskId,
          providerId: owner.providerId,
        });
  }

  private static toOwnerStatus(status: string): SandboxRunOwnerStatus {
    if (
      status === 'provisioning' ||
      status === 'running' ||
      status === 'deleting' ||
      status === 'terminal' ||
      status === 'removed' ||
      status === 'failed'
    ) {
      return status;
    }
    return 'failed';
  }

  private static toConnection(raw: Prisma.JsonValue | null): SandboxConnection | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const candidate = raw as Record<string, unknown>;
    return typeof candidate.taskId === 'string' &&
      typeof candidate.baseUrl === 'string' &&
      typeof candidate.wsUrl === 'string'
      ? {
          taskId: candidate.taskId,
          baseUrl: candidate.baseUrl,
          wsUrl: candidate.wsUrl,
        }
      : undefined;
  }

  private static toMetadata(raw: Prisma.JsonValue | null): SandboxDescriptorMetadata | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const candidate = raw as SandboxDescriptorMetadata;
    return SandboxRunOwnerService.mergeEnvironmentMetadata(
      candidate,
      SandboxRunOwnerService.toResolvedEnvironment(candidate.environment),
    );
  }

  private static mergeEnvironmentMetadata(
    metadata: SandboxDescriptorMetadata | undefined,
    environment: SandboxResolvedEnvironmentMetadata | undefined,
  ): SandboxDescriptorMetadata | undefined {
    const projectedMetadata = SandboxRunOwnerService.projectRunMetadata(metadata);
    const projectedEnvironment = environment
      ? SandboxRunOwnerService.projectResolvedEnvironment(environment)
      : undefined;
    if (!projectedMetadata && !projectedEnvironment) return undefined;
    return {
      ...(projectedMetadata ?? {}),
      ...(projectedEnvironment ? { environment: projectedEnvironment } : {}),
    };
  }

  private static toResolvedEnvironment(
    raw: unknown,
  ): SandboxResolvedEnvironmentMetadata | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return SandboxRunOwnerService.projectResolvedEnvironment(
      raw as SandboxResolvedEnvironmentMetadata,
    );
  }

  /**
   * Persist only the provider preflight fact consumed by task/readoption paths.
   * Descriptor metadata is intentionally open-ended at provider boundaries, but
   * the durable owner table is not an extension bag: unknown values are dropped
   * before Prisma ever receives them.
   */
  private static projectRunMetadata(
    raw: SandboxDescriptorMetadata | undefined,
  ): SandboxDescriptorMetadata | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const parsed = SandboxMetadataSchema.safeParse(raw.sandboxMetadata);
    return parsed.success ? { sandboxMetadata: parsed.data } : undefined;
  }

  /** Allowlisted, non-secret environment snapshot used for restart readoption. */
  private static projectResolvedEnvironment(
    raw: SandboxResolvedEnvironmentMetadata,
  ): SandboxResolvedEnvironmentMetadata | undefined {
    const candidate = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of [
      'id',
      'environmentId',
      'name',
      'providerId',
      'providerFamily',
      'runtimeId',
      'sourceKind',
      'sourceRef',
      'digest',
      'checksum',
      'validationId',
      'validationVersion',
      'contractVersion',
    ]) {
      if (typeof candidate[key] === 'string') out[key] = candidate[key];
    }
    const checksums = RuntimeArtifactChecksumsSchema.safeParse(
      candidate.runtimeArtifactChecksums,
    );
    if (checksums.success) out.runtimeArtifactChecksums = checksums.data;
    const cliArtifactChecksum = Sha256ChecksumSchema.safeParse(
      candidate.cliArtifactChecksum,
    );
    if (cliArtifactChecksum.success) {
      out.cliArtifactChecksum = cliArtifactChecksum.data;
    }
    if (candidate.resources !== undefined) {
      const resources = SandboxEnvironmentResourcesSchema.safeParse(
        candidate.resources,
      );
      if (resources.success) out.resources = resources.data;
    }
    const nested = SandboxRunOwnerService.projectEnvironmentMetadata(
      candidate.metadata,
    );
    if (nested) out.metadata = nested;
    return Object.keys(out).length > 0
      ? (out as SandboxResolvedEnvironmentMetadata)
      : undefined;
  }

  private static projectEnvironmentMetadata(
    raw: unknown,
  ): SandboxDescriptorMetadata | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const candidate = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of [
      'immutableIdentity',
      'fingerprint',
      'cliVersion',
    ]) {
      if (typeof candidate[key] === 'string') out[key] = candidate[key];
    }
    const sandboxMetadata = SandboxMetadataSchema.safeParse(
      candidate.sandboxMetadata,
    );
    if (sandboxMetadata.success) {
      out.sandboxMetadata = sandboxMetadata.data;
    }
    const sandboxMetadataChecksum = Sha256ChecksumSchema.safeParse(
      candidate.sandboxMetadataChecksum,
    );
    if (sandboxMetadataChecksum.success) {
      out.sandboxMetadataChecksum = sandboxMetadataChecksum.data;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private static toJsonConnection(
    value: SandboxConnection | undefined,
  ): Prisma.InputJsonObject | undefined {
    return value
      ? ({
          taskId: value.taskId,
          baseUrl: value.baseUrl,
          wsUrl: value.wsUrl,
        } as Prisma.InputJsonObject)
      : undefined;
  }

  private static toJsonMetadata(
    value: SandboxDescriptorMetadata | undefined,
  ): Prisma.InputJsonObject | undefined {
    return value ? (value as Prisma.InputJsonObject) : undefined;
  }
}

function assertGeneration(value: string, label: string): void {
  if (
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    value !== value.trim() ||
    hasAsciiControlCharacter(value)
  ) {
    throw new Error(`Invalid sandbox ${label}`);
  }
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}
