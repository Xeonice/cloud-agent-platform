import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  CreateSandboxEnvironmentRequestSchema,
  SandboxEnvironmentResponseSchema,
  SandboxEnvironmentResourcesSchema,
  SandboxMetadataSchema,
  SandboxEnvironmentSourceSchema,
  SandboxEnvironmentValidationSchema,
  UpdateSandboxEnvironmentParametersRequestSchema,
  type CreateSandboxEnvironmentRequest,
  type UpdateSandboxEnvironmentParametersRequest,
  type SandboxEnvironment,
  type SandboxEnvironmentParameter,
  type SandboxEnvironmentParameterInput,
  type SandboxEnvironmentResources,
  type SandboxEnvironmentSource,
  type SandboxEnvironmentValidation,
} from '@cap/contracts';
import {
  assertEnvironmentSelectable,
  normalizeResolvedEnvironment,
  providerFamiliesForEnvironmentSource,
  resolveConfiguredTaskProvisioningPolicy,
  SandboxEnvironmentError,
  snapshotSandboxProvisioningPolicy,
  sourceChecksum,
  sourceDigest,
  type ResolvedSandboxEnvironment,
  type SandboxHostImageParameterProfile,
  type SandboxEnvironmentProviderFamily,
  type SandboxEnvironmentSelection,
  type ConfiguredProviderProvisioningPolicy,
  type SandboxProvisioningPolicySnapshot,
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

export interface SandboxTaskAdmissionResolution {
  readonly environment: ResolvedSandboxEnvironment | null;
  readonly providerId: string;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly provisioningPolicy: SandboxProvisioningPolicySnapshot;
}

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
    const request = CreateSandboxEnvironmentRequestSchema.parse(input);
    const source = SandboxEnvironmentSourceSchema.parse(request.source);
    const providerFamilies = [...providerFamiliesForEnvironmentSource(source)];
    const runtimeIds = request.runtimeIds ?? [];
    const resources = request.resources ?? null;
    const parameters = this.encodeParameters(request.parameters ?? []);

    return this.prisma.$transaction(async (tx) => {
      if (request.isDefault) {
        await tx.sandboxEnvironment.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      const created = await tx.sandboxEnvironment.create({
        data: {
          name: request.name,
          source: source as unknown as Prisma.InputJsonObject,
          status: 'draft',
          resources:
            resources === null
              ? Prisma.DbNull
              : (resources as Prisma.InputJsonObject),
          envVars: parameters.plain as unknown as Prisma.InputJsonObject,
          secretEnvVars: parameters.secret as unknown as Prisma.InputJsonObject,
          providerFamilies,
          runtimeIds,
          isDefault: request.isDefault ?? false,
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

  /**
   * Replaces the image parameter set of a registered environment. Secrets stay
   * write-only: keep entries copy the stored ciphertext envelope verbatim (no
   * decrypt/re-encrypt round trip), set entries encrypt fresh values. Only the
   * parameter columns are written — status, validation records, contract
   * version, and the default flag are untouched, so no re-validation occurs.
   */
  async updateParameters(
    id: string,
    input: UpdateSandboxEnvironmentParametersRequest,
  ): Promise<SandboxEnvironment> {
    const request = UpdateSandboxEnvironmentParametersRequestSchema.parse(input);
    const current = await this.requireEnvironmentRow(id);
    if (current.status === 'disabled') {
      throw new BadRequestException({
        error: 'sandbox_environment_retired',
        message: `Sandbox environment ${id} is retired; parameters cannot be edited.`,
      });
    }
    const setEntries = request.parameters.filter(
      (entry): entry is SandboxEnvironmentParameterInput => !('keep' in entry),
    );
    const encoded = this.encodeParameters(setEntries);
    const storedSecrets = readStringRecord(current.secretEnvVars);
    for (const entry of request.parameters) {
      if (!('keep' in entry)) continue;
      const stored = storedSecrets[entry.name];
      if (stored === undefined) {
        throw new BadRequestException({
          error: 'sandbox_environment_unknown_keep_parameter',
          message: `Cannot keep unknown secret parameter: ${entry.name}`,
        });
      }
      encoded.secret[entry.name] = stored;
    }
    const updated = await this.prisma.sandboxEnvironment.update({
      where: { id },
      data: {
        envVars: encoded.plain as unknown as Prisma.InputJsonObject,
        secretEnvVars: encoded.secret as unknown as Prisma.InputJsonObject,
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
      resources: this.parseResources(row.resources),
      runtimeIds: runtimeIdsForValidation(row.runtimeIds),
      runtimeId: row.runtimeIds.length === 1 ? row.runtimeIds[0] : null,
      contractVersion: row.contractVersion,
    });
    const validation = await this.prisma.sandboxEnvironmentValidation.create({
      data: {
        environmentId: id,
        status: outcome.status,
        providerFamily: outcome.providerFamily,
        runtimeId: outcome.runtimeId ?? null,
        sourceKind: outcome.sourceKind,
        resolvedLocator: outcome.resolvedLocator ?? null,
        resolvedDigest: outcome.resolvedDigest ?? null,
        resolvedChecksum: outcome.resolvedChecksum ?? null,
        runtimeArtifactChecksums:
          outcome.runtimeArtifactChecksums == null
            ? Prisma.DbNull
            : (outcome.runtimeArtifactChecksums as Prisma.InputJsonObject),
        cliArtifactChecksum: outcome.cliArtifactChecksum ?? null,
        sandboxMetadata:
          outcome.sandboxMetadata == null
            ? Prisma.DbNull
            : (outcome.sandboxMetadata as unknown as Prisma.InputJsonValue),
        resourceSnapshot:
          outcome.resourceSnapshot == null
            ? Prisma.DbNull
            : (outcome.resourceSnapshot as Prisma.InputJsonObject),
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
    readonly selection?: SandboxEnvironmentSelection;
    /** @deprecated use selection so explicit null cannot collapse into default */
    readonly requestedEnvironmentId?: string | null;
    readonly runtimeId: string;
    readonly providerFamily?: SandboxEnvironmentProviderFamily;
  }): Promise<ResolvedSandboxEnvironment | null> {
    return this.resolveSelectedEnvironment(args, false);
  }

  /**
   * Atomic admission-time seam shared by every durable task-create surface.
   * The selected managed environment and its resource policy are derived from
   * the same database observation, so admission cannot persist an environment
   * id from one row version and resources from a later query.
   */
  async resolveTaskAdmission(args: {
    readonly selection?: SandboxEnvironmentSelection;
    readonly requestedEnvironmentId?: string | null;
    readonly runtimeId: string;
    readonly providerFamily?: SandboxEnvironmentProviderFamily;
    readonly resources?: SandboxEnvironmentResources | null;
  }): Promise<SandboxTaskAdmissionResolution> {
    const environment = await this.resolveForTask(args);
    let configuredPolicy: ConfiguredProviderProvisioningPolicy;
    if (environment !== null) {
      const providerFamily = environment.providerFamily ?? args.providerFamily;
      if (!providerFamily) {
        throw new BadRequestException({
          error: 'sandbox_environment_invalid_source',
          message: 'Sandbox environment has no provider family.',
        });
      }
      configuredPolicy = this.resolveTaskProvisioningPolicy({
        providerFamily,
        resources:
          environment.resources == null
            ? null
            : Object.freeze(
                SandboxEnvironmentResourcesSchema.parse(
                  environment.resources,
                ),
              ),
      });
    } else {
      configuredPolicy = this.resolveTaskProvisioningPolicy({
        ...(args.providerFamily
          ? { providerFamily: args.providerFamily }
          : {}),
        resources: args.resources ?? null,
      });
    }
    const provisioningPolicy = snapshotSandboxProvisioningPolicy(
      configuredPolicy,
    );
    return Object.freeze({
      environment,
      providerId: configuredPolicy.providerId,
      providerFamily: configuredPolicy.providerFamily,
      provisioningPolicy,
    });
  }

  /** Compatibility helper for non-durable catalog callers. */
  async resolveProvisioningResourcesForTask(args: {
    readonly selection?: SandboxEnvironmentSelection;
    readonly requestedEnvironmentId?: string | null;
    readonly runtimeId: string;
    readonly providerFamily?: SandboxEnvironmentProviderFamily;
  }): Promise<SandboxEnvironmentResources> {
    const { provisioningPolicy } = await this.resolveTaskAdmission(args);
    return Object.freeze(
      SandboxEnvironmentResourcesSchema.parse(
        provisioningPolicy.resources ?? {},
      ),
    );
  }

  /**
   * Catalog/preflight variant: requires the latest passed validation to carry a
   * provider-resolved digest/checksum and validated sandbox metadata. Mutable
   * tags are converted to a canonical digest locator before returning.
   */
  async resolveImmutableForTask(args: {
    readonly selection: SandboxEnvironmentSelection;
    readonly runtimeId: string;
    readonly providerFamily?: SandboxEnvironmentProviderFamily;
  }): Promise<ResolvedSandboxEnvironment | null> {
    return this.resolveSelectedEnvironment(args, true);
  }

  private async resolveSelectedEnvironment(
    args: {
      readonly selection?: SandboxEnvironmentSelection;
      readonly requestedEnvironmentId?: string | null;
      readonly runtimeId: string;
      readonly providerFamily?: SandboxEnvironmentProviderFamily;
    },
    requireImmutable: boolean,
  ): Promise<ResolvedSandboxEnvironment | null> {
    const selection = normalizeEnvironmentSelection(args);
    if (selection.kind === 'deployment-default') return null;
    const row =
      selection.kind === 'managed'
        ? await this.prisma.sandboxEnvironment.findUnique({
            where: { id: selection.environmentId },
            include: latestValidationInclude(),
          })
        : await this.findDefaultEnvironment(args);

    if (!row) {
      if (selection.kind === 'managed') {
        throw new BadRequestException({
          error: 'sandbox_environment_not_found',
          message: `Sandbox environment not found: ${selection.environmentId}`,
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

    const source = this.parseSource(row.source);
    const declaredResources = this.parseResources(row.resources);
    const validation = requireImmutable
      ? await this.findPinnedValidation(row.id, row.lastValidationId)
      : row.validations?.[0];
    const resources = this.resolveManagedProvisioningResources({
      declaredResources,
      validationResourceSnapshot: validation?.resourceSnapshot,
    });
    if (requireImmutable) {
      const runtimeArtifactChecksums = readStringRecord(
        validation?.runtimeArtifactChecksums ?? undefined,
      );
      const cliArtifactChecksum =
        runtimeArtifactChecksums[args.runtimeId] ??
        (validation?.runtimeId === args.runtimeId
          ? validation.cliArtifactChecksum
          : null);
      if (
        !validation ||
        validation.status !== 'passed' ||
        validation.providerFamily !== providerFamily ||
        validation.sourceKind !== source.kind ||
        validation.contractVersion !== row.contractVersion ||
        (validation.runtimeId !== null &&
          validation.runtimeId !== args.runtimeId) ||
        !validation.resolvedLocator ||
        (!validation.resolvedDigest && !validation.resolvedChecksum) ||
        !cliArtifactChecksum
      ) {
        throw immutableEnvironmentUnavailable(row.id);
      }
      const parsedMetadata = SandboxMetadataSchema.safeParse(
        validation.sandboxMetadata,
      );
      if (
        !parsedMetadata.success ||
        !parsedMetadata.data.dependencies[args.runtimeId]
      ) {
        throw immutableEnvironmentUnavailable(row.id);
      }
      return normalizeResolvedEnvironment({
        environment: {
          id: row.id,
          name: row.name,
          source,
          resources,
          lastValidationId: row.lastValidationId,
          contractVersion: row.contractVersion,
        },
        providerFamily,
        runtimeId: args.runtimeId,
        validationVersion: validation.contractVersion ?? undefined,
        resolvedSourceRef: validation.resolvedLocator,
        resolvedDigest: validation.resolvedDigest,
        resolvedChecksum: validation.resolvedChecksum,
        runtimeArtifactChecksums,
        cliArtifactChecksum,
        sandboxMetadata: parsedMetadata.data,
      });
    }

    return normalizeResolvedEnvironment({
      environment: {
        id: row.id,
        name: row.name,
        source,
        resources,
        lastValidationId: row.lastValidationId,
        contractVersion: row.contractVersion,
      },
      providerFamily,
      runtimeId: args.runtimeId,
    });
  }

  private async findPinnedValidation(
    environmentId: string,
    validationId: string | null,
  ) {
    if (!validationId) return null;
    const validation = await this.prisma.sandboxEnvironmentValidation.findUnique({
      where: { id: validationId },
      select: {
        id: true,
        environmentId: true,
        status: true,
        providerFamily: true,
        runtimeId: true,
        sourceKind: true,
        resolvedLocator: true,
        resolvedDigest: true,
        resolvedChecksum: true,
        runtimeArtifactChecksums: true,
        cliArtifactChecksum: true,
        sandboxMetadata: true,
        resourceSnapshot: true,
        contractVersion: true,
        checkedAt: true,
      },
    });
    return validation?.environmentId === environmentId ? validation : null;
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
      include: latestValidationInclude(),
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
    readonly resources?: SandboxEnvironmentResources | null;
    readonly runtimeIds?: readonly string[];
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
        runtimeArtifactChecksums: null,
        cliArtifactChecksum: null,
        resourceSnapshot: args.resources ?? null,
        probes: [{ name: 'validation-error', ok: false, output: message }],
        error: message,
      };
    }
  }

  private toEnvironment(row: {
    id: string;
    name: string;
    source: Prisma.JsonValue;
    resources?: Prisma.JsonValue | null;
    status: string;
    providerFamilies: string[];
    runtimeIds: string[];
    isDefault: boolean;
    lastValidationId: string | null;
    contractVersion: string | null;
    createdAt: Date;
    updatedAt: Date;
    validations?: readonly {
      checkedAt: Date;
      sandboxMetadata: Prisma.JsonValue | null;
    }[];
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
      resources: this.parseResources(row.resources),
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
    resolvedLocator: string | null;
    resolvedDigest: string | null;
    resolvedChecksum: string | null;
    runtimeArtifactChecksums: Prisma.JsonValue | null;
    cliArtifactChecksum: string | null;
    sandboxMetadata: Prisma.JsonValue | null;
    resourceSnapshot: Prisma.JsonValue | null;
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
      resolvedLocator: row.resolvedLocator,
      resolvedDigest: row.resolvedDigest,
      resolvedChecksum: row.resolvedChecksum,
      runtimeArtifactChecksums: row.runtimeArtifactChecksums,
      cliArtifactChecksum: row.cliArtifactChecksum,
      sandboxMetadata: row.sandboxMetadata,
      resourceSnapshot: this.parseResources(row.resourceSnapshot),
      probes: row.probes,
      error: row.error,
      contractVersion: row.contractVersion,
      checkedAt: row.checkedAt,
    });
  }

  private parseSource(raw: Prisma.JsonValue): SandboxEnvironmentSource {
    return SandboxEnvironmentSourceSchema.parse(raw);
  }

  private parseResources(
    raw: Prisma.JsonValue | null | undefined,
  ): SandboxEnvironmentResources | null {
    if (raw == null) return null;
    return SandboxEnvironmentResourcesSchema.parse(raw);
  }

  private resolveTaskProvisioningPolicy(args: {
    readonly providerFamily?: SandboxEnvironmentProviderFamily;
    readonly resources?: SandboxEnvironmentResources | null;
  }): ConfiguredProviderProvisioningPolicy {
    try {
      const resolved = resolveConfiguredTaskProvisioningPolicy(args);
      const provisioningPolicy = snapshotSandboxProvisioningPolicy({
        resources: Object.freeze(
          SandboxEnvironmentResourcesSchema.parse(resolved.resources ?? {}),
        ),
        ...(resolved.workspaceMaterializationDeadlineMs === undefined
          ? {}
          : {
              workspaceMaterializationDeadlineMs:
                resolved.workspaceMaterializationDeadlineMs,
            }),
      });
      return Object.freeze({
        providerId: resolved.providerId,
        providerFamily: resolved.providerFamily,
        capabilities: resolved.capabilities,
        ...provisioningPolicy,
      });
    } catch (error) {
      throw new BadRequestException({
        error: 'sandbox_environment_resource_unsupported',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveManagedProvisioningResources(args: {
    readonly declaredResources: SandboxEnvironmentResources | null;
    readonly validationResourceSnapshot?: Prisma.JsonValue | null;
  }): SandboxEnvironmentResources | null {
    if (args.validationResourceSnapshot != null) {
      return this.parseResources(args.validationResourceSnapshot);
    }
    return args.declaredResources;
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
      select: {
        id: true,
        status: true,
        providerFamily: true,
        runtimeId: true,
        sourceKind: true,
        resolvedLocator: true,
        resolvedDigest: true,
        resolvedChecksum: true,
        runtimeArtifactChecksums: true,
        cliArtifactChecksum: true,
        sandboxMetadata: true,
        resourceSnapshot: true,
        contractVersion: true,
        checkedAt: true,
      },
    },
  } as const;
}

function normalizeEnvironmentSelection(args: {
  readonly selection?: SandboxEnvironmentSelection;
  readonly requestedEnvironmentId?: string | null;
}): SandboxEnvironmentSelection {
  if (args.selection) return args.selection;
  return typeof args.requestedEnvironmentId === 'string'
    ? { kind: 'managed', environmentId: args.requestedEnvironmentId }
    : { kind: 'managed-default' };
}

function immutableEnvironmentUnavailable(id: string): BadRequestException {
  return new BadRequestException({
    error: 'sandbox_environment_immutable_identity_unavailable',
    message: `Sandbox environment ${id} has no current immutable validation snapshot.`,
  });
}

function runtimeIdsForValidation(runtimeIds: readonly string[]): readonly string[] {
  return runtimeIds.length > 0 ? runtimeIds : ['claude-code', 'codex'];
}
