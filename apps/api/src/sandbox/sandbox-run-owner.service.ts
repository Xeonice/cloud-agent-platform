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
  BeginSandboxRunCreateArgs,
  BeginSandboxRunCleanupResult,
  ClaimSandboxRunCleanupResult,
  JoinSandboxRunCleanupArgs,
  JoinSandboxRunCleanupResult,
  ObserveSandboxRunCreateArgs,
  RecordSandboxRunOwnerArgs,
  SandboxConnection,
  SandboxDescriptorMetadata,
  SandboxResolvedEnvironmentMetadata,
  SandboxOwnershipFence,
  SandboxRunCleanupAuthorization,
  SandboxRunCreateState,
  SandboxRunOwnerRecord,
  SandboxRunOwnerStatus,
  SandboxRunOwnerStore,
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
          status: { in: [...LIVE_SANDBOX_RUN_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'absent' } as const;
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
          status: { in: [...LIVE_SANDBOX_RUN_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'absent' } as const;
      if (
        (existing.ownerGeneration === null) !==
        (existing.resourceGeneration === null)
      ) {
        return { kind: 'conflict' } as const;
      }
      const owner = existing.ownerGeneration && existing.resourceGeneration
        ? SandboxRunOwnerService.toOwnerRecord({
            ...existing,
            ownerGeneration,
            status: 'deleting',
          })
        : SandboxRunOwnerService.toOwnerRecord({
            ...existing,
            status: 'deleting',
          });
      await client.sandboxRun.update({
        where: { id: existing.id },
        data: {
          status: 'deleting',
          ...(existing.ownerGeneration && existing.resourceGeneration
            ? { ownerGeneration }
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
          status: { in: [...LIVE_SANDBOX_RUN_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) return { kind: 'absent' } as const;
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
    status: Extract<SandboxRunOwnerStatus, 'removed' | 'terminal' | 'failed'>,
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
            status === 'terminal' || status === 'failed'
              ? new Date()
              : undefined,
          removedAt: status === 'removed' ? new Date() : undefined,
        },
      });
      return changed.count === 1;
    });
  }

  async markSandboxRunOwnerStatus(
    taskId: string,
    status: SandboxRunOwnerStatus,
  ): Promise<void> {
    await this.withTaskOwnerLock(taskId, async (client) => {
      await client.sandboxRun.updateMany({
        where: {
          taskId,
          status: { in: [...LIVE_SANDBOX_RUN_STATUSES] },
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
      client: Pick<Prisma.TransactionClient, 'sandboxRun'>,
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
  }): SandboxRunOwnerRecord {
    const metadata = SandboxRunOwnerService.toMetadata(run.metadata);
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
    };
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
