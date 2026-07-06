import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  SandboxEnvironmentResponseSchema,
  SandboxEnvironmentSourceSchema,
  SandboxEnvironmentValidationSchema,
  type CreateSandboxEnvironmentRequest,
  type SandboxEnvironment,
  type SandboxEnvironmentSource,
  type SandboxEnvironmentValidation,
} from '@cap/contracts';
import {
  assertEnvironmentSelectable,
  normalizeResolvedEnvironment,
  providerFamiliesForEnvironmentSource,
  SandboxEnvironmentError,
  sourceChecksum,
  sourceDigest,
  type ResolvedSandboxEnvironment,
  type SandboxEnvironmentProviderFamily,
} from '@cap/sandbox';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const SANDBOX_ENVIRONMENT_CONTRACT_VERSION = 'sandbox-environment-v1';

@Injectable()
export class SandboxEnvironmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<SandboxEnvironment[]> {
    const rows = await this.prisma.sandboxEnvironment.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: latestValidationInclude(),
    });
    return rows.map((row) => this.toEnvironment(row));
  }

  async create(input: CreateSandboxEnvironmentRequest): Promise<SandboxEnvironment> {
    const source = SandboxEnvironmentSourceSchema.parse(input.source);
    const providerFamilies = [...providerFamiliesForEnvironmentSource(source)];
    const runtimeIds = input.runtimeIds ?? [];

    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.sandboxEnvironment.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      const created = await tx.sandboxEnvironment.create({
        data: {
          name: input.name,
          source: source as unknown as Prisma.InputJsonObject,
          status: 'draft',
          providerFamilies,
          runtimeIds,
          isDefault: input.isDefault ?? false,
          contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
        },
        include: latestValidationInclude(),
      });
      return this.toEnvironment(created);
    });
  }

  async setDefault(id: string): Promise<SandboxEnvironment> {
    const current = await this.requireEnvironmentRow(id);
    if (current.status !== 'ready') {
      throw new BadRequestException({
        error: 'sandbox_environment_not_ready',
        message: `Sandbox environment ${id} is not ready.`,
      });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.sandboxEnvironment.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      const updated = await tx.sandboxEnvironment.update({
        where: { id },
        data: { isDefault: true },
        include: latestValidationInclude(),
      });
      return this.toEnvironment(updated);
    });
  }

  async validate(id: string): Promise<{
    environment: SandboxEnvironment;
    validation: SandboxEnvironmentValidation;
  }> {
    const row = await this.requireEnvironmentRow(id);
    const source = this.parseSource(row.source);
    const providerFamily = providerFamiliesForEnvironmentSource(source)[0];
    if (!providerFamily) {
      throw new BadRequestException({
        error: 'sandbox_environment_invalid_source',
        message: `Sandbox environment ${id} has no provider-compatible source.`,
      });
    }

    const validation = await this.prisma.sandboxEnvironmentValidation.create({
      data: {
        environmentId: id,
        status: 'passed',
        providerFamily,
        runtimeId: row.runtimeIds[0] ?? null,
        sourceKind: source.kind,
        resolvedDigest: sourceDigest(source) ?? null,
        resolvedChecksum: sourceChecksum(source) ?? null,
        probes: [
          {
            name: 'source-descriptor',
            ok: true,
            output: 'source descriptor accepted; provider probe pending',
          },
        ] as Prisma.InputJsonValue,
        contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
      },
    });
    const updated = await this.prisma.sandboxEnvironment.update({
      where: { id },
      data: {
        status: 'ready',
        lastValidationId: validation.id,
        contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
      },
      include: latestValidationInclude(),
    });
    return {
      environment: this.toEnvironment(updated),
      validation: this.toValidation(validation),
    };
  }

  async listValidations(id: string): Promise<SandboxEnvironmentValidation[]> {
    await this.requireEnvironmentRow(id);
    const rows = await this.prisma.sandboxEnvironmentValidation.findMany({
      where: { environmentId: id },
      orderBy: { checkedAt: 'desc' },
    });
    return rows.map((row) => this.toValidation(row));
  }

  async resolveForTask(args: {
    readonly requestedEnvironmentId?: string | null;
    readonly runtimeId: string;
    readonly providerFamily?: SandboxEnvironmentProviderFamily;
  }): Promise<ResolvedSandboxEnvironment | null> {
    const row = args.requestedEnvironmentId
      ? await this.prisma.sandboxEnvironment.findUnique({
          where: { id: args.requestedEnvironmentId },
        })
      : await this.findDefaultEnvironment(args);

    if (!row) {
      if (args.requestedEnvironmentId) {
        throw new BadRequestException({
          error: 'sandbox_environment_not_found',
          message: `Sandbox environment not found: ${args.requestedEnvironmentId}`,
        });
      }
      return null;
    }

    const providerFamily =
      args.providerFamily ??
      (row.providerFamilies[0] as SandboxEnvironmentProviderFamily | undefined);
    if (!providerFamily) {
      throw new BadRequestException({
        error: 'sandbox_environment_invalid_source',
        message: `Sandbox environment ${row.id} has no provider family.`,
      });
    }

    try {
      assertEnvironmentSelectable({
        environment: {
          id: row.id,
          status: row.status as never,
          compatibility: {
            providerFamilies: row.providerFamilies as SandboxEnvironmentProviderFamily[],
            runtimeIds: row.runtimeIds.length > 0 ? row.runtimeIds : undefined,
          },
        },
        providerFamily,
        runtimeId: args.runtimeId,
      });
    } catch (err) {
      if (err instanceof SandboxEnvironmentError) {
        throw new BadRequestException({
          error: err.code,
          message: err.message,
        });
      }
      throw err;
    }

    return normalizeResolvedEnvironment({
      environment: {
        id: row.id,
        name: row.name,
        source: this.parseSource(row.source),
        lastValidationId: row.lastValidationId,
        contractVersion: row.contractVersion,
      },
      providerFamily,
      runtimeId: args.runtimeId,
      validationVersion: row.lastValidationId ? '1' : undefined,
    });
  }

  async markCustomEnvironmentsStale(contractVersion: string): Promise<number> {
    const result = await this.prisma.sandboxEnvironment.updateMany({
      where: {
        status: 'ready',
        contractVersion: { not: contractVersion },
      },
      data: { status: 'stale' },
    });
    return result.count;
  }

  private async findDefaultEnvironment(args: {
    readonly runtimeId: string;
    readonly providerFamily?: SandboxEnvironmentProviderFamily;
  }) {
    const rows = await this.prisma.sandboxEnvironment.findMany({
      where: {
        isDefault: true,
        status: 'ready',
      },
      orderBy: { createdAt: 'asc' },
    });
    return (
      rows.find((row) => {
        if (
          args.providerFamily &&
          !row.providerFamilies.includes(args.providerFamily)
        ) {
          return false;
        }
        return row.runtimeIds.length === 0 || row.runtimeIds.includes(args.runtimeId);
      }) ?? null
    );
  }

  private async requireEnvironmentRow(id: string) {
    const row = await this.prisma.sandboxEnvironment.findUnique({
      where: { id },
      include: latestValidationInclude(),
    });
    if (!row) {
      throw new NotFoundException(`Sandbox environment not found: ${id}`);
    }
    return row;
  }

  private toEnvironment(row: {
    id: string;
    name: string;
    source: Prisma.JsonValue;
    status: string;
    providerFamilies: string[];
    runtimeIds: string[];
    isDefault: boolean;
    lastValidationId: string | null;
    contractVersion: string | null;
    createdAt: Date;
    updatedAt: Date;
    validations?: readonly { checkedAt: Date }[];
  }): SandboxEnvironment {
    return SandboxEnvironmentResponseSchema.parse({
      id: row.id,
      name: row.name,
      status: row.status,
      source: this.parseSource(row.source),
      compatibility: {
        providerFamilies: row.providerFamilies,
        runtimeIds: row.runtimeIds.length > 0 ? row.runtimeIds : undefined,
      },
      isDefault: row.isDefault,
      lastValidationId: row.lastValidationId,
      lastValidatedAt: row.validations?.[0]?.checkedAt ?? null,
      contractVersion: row.contractVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private toValidation(row: {
    id: string;
    environmentId: string;
    status: string;
    providerFamily: string;
    runtimeId: string | null;
    sourceKind: string;
    resolvedDigest: string | null;
    resolvedChecksum: string | null;
    probes: Prisma.JsonValue | null;
    error: string | null;
    contractVersion: string | null;
    checkedAt: Date;
  }): SandboxEnvironmentValidation {
    return SandboxEnvironmentValidationSchema.parse({
      id: row.id,
      environmentId: row.environmentId,
      status: row.status,
      providerFamily: row.providerFamily,
      runtimeId: row.runtimeId,
      sourceKind: row.sourceKind,
      resolvedDigest: row.resolvedDigest,
      resolvedChecksum: row.resolvedChecksum,
      probes: row.probes,
      error: row.error,
      contractVersion: row.contractVersion,
      checkedAt: row.checkedAt,
    });
  }

  private parseSource(raw: Prisma.JsonValue): SandboxEnvironmentSource {
    return SandboxEnvironmentSourceSchema.parse(raw);
  }
}

function latestValidationInclude() {
  return {
    validations: {
      orderBy: { checkedAt: 'desc' as const },
      take: 1,
      select: { checkedAt: true },
    },
  } as const;
}
