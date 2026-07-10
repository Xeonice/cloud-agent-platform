import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  SandboxEnvironmentResponseSchema,
  SandboxEnvironmentSourceSchema,
  SandboxEnvironmentValidationSchema,
  type CreateSandboxEnvironmentRequest,
  type SandboxEnvironment,
  type SandboxEnvironmentParameter,
  type SandboxEnvironmentParameterInput,
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
  type SandboxHostImageParameterProfile,
  type SandboxEnvironmentProviderFamily,
} from '@cap/sandbox';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decryptStored, encryptToStored } from '../settings/secret-storage';
import {
  DefaultSandboxEnvironmentValidationRunner,
  SANDBOX_ENVIRONMENT_VALIDATION_RUNNER,
  type SandboxEnvironmentValidationOutcome,
  type SandboxEnvironmentValidationRunner,
} from './sandbox-environments.validator';

export const SANDBOX_ENVIRONMENT_CONTRACT_VERSION = 'sandbox-environment-v2';

@Injectable()
export class SandboxEnvironmentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SANDBOX_ENVIRONMENT_VALIDATION_RUNNER)
    private readonly validationRunner: SandboxEnvironmentValidationRunner = new DefaultSandboxEnvironmentValidationRunner(),
  ) {}

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
    const parameters = this.encodeParameters(input.parameters ?? []);

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
          envVars: parameters.plain as unknown as Prisma.InputJsonObject,
          secretEnvVars: parameters.secret as unknown as Prisma.InputJsonObject,
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

  async retire(id: string): Promise<SandboxEnvironment> {
    await this.requireEnvironmentRow(id);
    const updated = await this.prisma.sandboxEnvironment.update({
      where: { id },
      data: {
        status: 'disabled',
        isDefault: false,
      },
      include: latestValidationInclude(),
    });
    return this.toEnvironment(updated);
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

    await this.prisma.sandboxEnvironment.update({
      where: { id },
      data: { status: 'validating' },
    });
    const outcome = await this.runProviderValidation({
      id: row.id,
      name: row.name,
      source,
      providerFamily,
      runtimeId: row.runtimeIds[0] ?? null,
      contractVersion: row.contractVersion,
    });
    const validation = await this.prisma.sandboxEnvironmentValidation.create({
      data: {
        environmentId: id,
        status: outcome.status,
        providerFamily: outcome.providerFamily,
        runtimeId: outcome.runtimeId ?? null,
        sourceKind: outcome.sourceKind,
        resolvedDigest: outcome.resolvedDigest ?? null,
        resolvedChecksum: outcome.resolvedChecksum ?? null,
        sandboxMetadata:
          outcome.sandboxMetadata == null
            ? Prisma.DbNull
            : (outcome.sandboxMetadata as unknown as Prisma.InputJsonValue),
        probes: (outcome.probes ?? []) as unknown as Prisma.InputJsonValue,
        error: outcome.error ?? null,
        contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
      },
    });
    const updated = await this.prisma.sandboxEnvironment.update({
      where: { id },
      data: {
        status: outcome.status === 'passed' ? 'ready' : 'failed',
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
    this.assertCurrentContract(row);

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

  async resolveImageParameterProfileForTask(args: {
    readonly requestedEnvironmentId?: string | null;
    readonly runtimeId: string;
    readonly providerFamily: SandboxEnvironmentProviderFamily;
  }): Promise<SandboxHostImageParameterProfile | null> {
    const row = args.requestedEnvironmentId
      ? await this.prisma.sandboxEnvironment.findUnique({
          where: { id: args.requestedEnvironmentId },
        })
      : await this.findDefaultEnvironment(args);
    if (!row) return null;
    this.assertCurrentContract(row);

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
        providerFamily: args.providerFamily,
        runtimeId: args.runtimeId,
      });
    } catch {
      return null;
    }

    const plain = readStringRecord(row.envVars);
    const secretStored = readStringRecord(row.secretEnvVars);
    const parameters = [
      ...Object.entries(plain).map(([name, value]) => ({
        name,
        value,
        secret: false,
      })),
      ...Object.entries(secretStored)
        .map(([name, stored]) => {
          const value = decryptStored(stored);
          return value === null ? null : { name, value, secret: true };
        })
        .filter((entry): entry is { name: string; value: string; secret: true } => entry !== null),
    ].sort((a, b) => a.name.localeCompare(b.name));
    return parameters.length > 0 ? { parameters } : null;
  }

  async markCustomEnvironmentsStale(contractVersion: string): Promise<number> {
    const result = await this.prisma.sandboxEnvironment.updateMany({
      where: {
        status: 'ready',
        OR: [
          { contractVersion: { not: contractVersion } },
          { contractVersion: null },
        ],
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
        contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
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

  private assertCurrentContract(row: { id: string; contractVersion: string | null }): void {
    if (row.contractVersion === SANDBOX_ENVIRONMENT_CONTRACT_VERSION) return;
    throw new BadRequestException({
      error: 'sandbox_environment_contract_stale',
      message:
        `Sandbox environment ${row.id} was validated against ` +
        `${row.contractVersion ?? 'no contract'}; revalidate it against ` +
        `${SANDBOX_ENVIRONMENT_CONTRACT_VERSION}.`,
    });
  }

  private async runProviderValidation(args: {
    readonly id: string;
    readonly name: string;
    readonly source: SandboxEnvironmentSource;
    readonly providerFamily: SandboxEnvironmentProviderFamily;
    readonly runtimeId?: string | null;
    readonly contractVersion?: string | null;
  }): Promise<SandboxEnvironmentValidationOutcome> {
    try {
      return await this.validationRunner.validate(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        providerFamily: args.providerFamily,
        runtimeId: args.runtimeId ?? null,
        sourceKind: args.source.kind,
        resolvedDigest: sourceDigest(args.source) ?? null,
        resolvedChecksum: sourceChecksum(args.source) ?? null,
        probes: [{ name: 'validation-error', ok: false, output: message }],
        error: message,
      };
    }
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
    validations?: readonly { checkedAt: Date; sandboxMetadata: Prisma.JsonValue | null }[];
    envVars?: Prisma.JsonValue;
    secretEnvVars?: Prisma.JsonValue;
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
      parameters: this.toParameterDescriptors(row.envVars, row.secretEnvVars),
      isDefault: row.isDefault,
      lastValidationId: row.lastValidationId,
      lastValidatedAt: row.validations?.[0]?.checkedAt ?? null,
      contractVersion: row.contractVersion,
      sandboxMetadata: row.validations?.[0]?.sandboxMetadata ?? null,
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
    sandboxMetadata: Prisma.JsonValue | null;
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
      sandboxMetadata: row.sandboxMetadata,
      probes: row.probes,
      error: row.error,
      contractVersion: row.contractVersion,
      checkedAt: row.checkedAt,
    });
  }

  private parseSource(raw: Prisma.JsonValue): SandboxEnvironmentSource {
    return SandboxEnvironmentSourceSchema.parse(raw);
  }

  private encodeParameters(
    parameters: readonly SandboxEnvironmentParameterInput[],
  ): { plain: Record<string, string>; secret: Record<string, string> } {
    const plain: Record<string, string> = {};
    const secret: Record<string, string> = {};
    const seen = new Set<string>();
    for (const parameter of parameters) {
      if (seen.has(parameter.name)) {
        throw new BadRequestException({
          error: 'sandbox_environment_duplicate_parameter',
          message: `Duplicate image parameter: ${parameter.name}`,
        });
      }
      seen.add(parameter.name);
      if (parameter.secret) {
        secret[parameter.name] = encryptToStored(parameter.value);
      } else {
        plain[parameter.name] = parameter.value;
      }
    }
    return { plain, secret };
  }

  private toParameterDescriptors(
    plainRaw: Prisma.JsonValue | undefined,
    secretRaw: Prisma.JsonValue | undefined,
  ): SandboxEnvironmentParameter[] {
    const plain = readStringRecord(plainRaw);
    const secret = readStringRecord(secretRaw);
    return [
      ...Object.entries(plain).map(([name, value]) => ({
        name,
        value,
        secret: false,
      })),
      ...Object.keys(secret).map((name) => ({
        name,
        secret: true,
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }
}

function readStringRecord(raw: Prisma.JsonValue | undefined): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
}

function latestValidationInclude() {
  return {
    validations: {
      orderBy: { checkedAt: 'desc' as const },
      take: 1,
      select: { checkedAt: true, sandboxMetadata: true },
    },
  } as const;
}
