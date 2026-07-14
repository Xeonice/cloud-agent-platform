import { Injectable } from '@nestjs/common';
import type {
  RecordSandboxRunOwnerArgs,
  SandboxConnection,
  SandboxDescriptorMetadata,
  SandboxResolvedEnvironmentMetadata,
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
        status: { in: [...ACTIVE_SANDBOX_RUN_STATUSES] },
      },
      orderBy: { createdAt: 'asc' },
    });
    return runs.map((run) => SandboxRunOwnerService.toOwnerRecord(run));
  }

  async recordSandboxRunOwner(args: RecordSandboxRunOwnerArgs): Promise<void> {
    const providerSandboxId = args.providerSandboxId ?? args.connection?.taskId ?? null;
    const existing = await this.prisma.sandboxRun.findFirst({
      where: {
        taskId: args.taskId,
        providerId: args.providerId,
        providerSandboxId,
        status: { in: [...ACTIVE_SANDBOX_RUN_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const metadata = SandboxRunOwnerService.mergeEnvironmentMetadata(
      args.metadata,
      args.environment,
    );
    const data = {
      providerSandboxId,
      status: 'running',
      connectionJson: SandboxRunOwnerService.toJsonObject(args.connection),
      metadata: SandboxRunOwnerService.toJsonObject(metadata),
      terminalAt: null,
      removedAt: null,
    } satisfies Prisma.SandboxRunUpdateInput;

    if (existing) {
      await this.prisma.sandboxRun.update({
        where: { id: existing.id },
        data,
      });
      return;
    }

    await this.prisma.sandboxRun.create({
      data: {
        taskId: args.taskId,
        providerId: args.providerId,
        ...data,
      },
    });
  }

  async markSandboxRunOwnerStatus(
    taskId: string,
    status: SandboxRunOwnerStatus,
  ): Promise<void> {
    const existing = await this.prisma.sandboxRun.findFirst({
      where: {
        taskId,
        status: { in: [...ACTIVE_SANDBOX_RUN_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!existing) return;

    await this.prisma.sandboxRun.update({
      where: { id: existing.id },
      data: {
        status,
        terminalAt: status === 'terminal' ? new Date() : undefined,
        removedAt: status === 'removed' ? new Date() : undefined,
      },
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
    status: string;
    connectionJson: Prisma.JsonValue | null;
    metadata: Prisma.JsonValue | null;
  }): SandboxRunOwnerRecord {
    const metadata = SandboxRunOwnerService.toMetadata(run.metadata);
    return {
      taskId: run.taskId,
      providerId: run.providerId,
      providerSandboxId: run.providerSandboxId ?? undefined,
      status: SandboxRunOwnerService.toOwnerStatus(run.status),
      connection: SandboxRunOwnerService.toConnection(run.connectionJson),
      environment: SandboxRunOwnerService.toResolvedEnvironment(metadata?.environment),
      metadata,
    };
  }

  private static toOwnerStatus(status: string): SandboxRunOwnerStatus {
    if (
      status === 'provisioning' ||
      status === 'running' ||
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
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as SandboxDescriptorMetadata)
      : undefined;
  }

  private static mergeEnvironmentMetadata(
    metadata: SandboxDescriptorMetadata | undefined,
    environment: SandboxResolvedEnvironmentMetadata | undefined,
  ): SandboxDescriptorMetadata | undefined {
    if (!environment) return metadata;
    return {
      ...(metadata ?? {}),
      environment,
    };
  }

  private static toResolvedEnvironment(
    raw: unknown,
  ): SandboxResolvedEnvironmentMetadata | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
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
      'cliArtifactChecksum',
    ]) {
      if (typeof candidate[key] === 'string') out[key] = candidate[key];
    }
    if (
      candidate.runtimeArtifactChecksums &&
      typeof candidate.runtimeArtifactChecksums === 'object' &&
      !Array.isArray(candidate.runtimeArtifactChecksums)
    ) {
      out.runtimeArtifactChecksums = candidate.runtimeArtifactChecksums;
    }
    if (
      candidate.metadata &&
      typeof candidate.metadata === 'object' &&
      !Array.isArray(candidate.metadata)
    ) {
      out.metadata = candidate.metadata;
    }
    return Object.keys(out).length > 0
      ? (out as SandboxResolvedEnvironmentMetadata)
      : undefined;
  }

  private static toJsonObject(
    value: SandboxConnection | SandboxDescriptorMetadata | undefined,
  ): Prisma.InputJsonObject | undefined {
    return value ? ({ ...value } as Prisma.InputJsonObject) : undefined;
  }
}
