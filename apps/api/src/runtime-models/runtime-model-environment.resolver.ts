import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  RuntimeModelEffectiveEnvironmentSchema,
  SandboxMetadataSchema,
  type Runtime,
  type RuntimeExecutionEnvironmentSnapshot,
} from '@cap/contracts';
import {
  resolveConfiguredDeploymentEnvironmentTarget,
  resolveConfiguredProviderIdForFamily,
  sourceDigest,
  sourceReference,
  type SandboxEnvironmentSourceDescriptor,
  type ResolvedSandboxEnvironment,
  type SandboxEnvironmentSelection,
} from '@cap/sandbox';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import type {
  SandboxEnvironmentValidationRunner,
  SandboxEnvironmentValidationTarget,
} from '../sandbox-environments/sandbox-environments.validator';
import type {
  RuntimeModelDeploymentEnvironmentResolver,
  RuntimeModelEnvironmentResolver,
  RuntimeModelManagedProviderResolver,
} from './runtime-model-catalog.port';
import type { ResolvedRuntimeModelEnvironment } from './runtime-model-catalog.types';
import {
  RuntimeModelCatalogOperationalError,
  RuntimeModelEnvironmentResolutionError,
} from './runtime-model-errors';
import { RuntimeModelCatalogCache } from './runtime-model-catalog-cache';
import { OwnerFairProbeScheduler } from './owner-fair-probe-scheduler';
import {
  buildRuntimeExecutionEnvironmentSnapshot,
  validateRuntimeExecutionEnvironmentSnapshot,
} from './runtime-model-snapshot';

export interface RuntimeModelEnvironmentResolverOptions {
  readonly now?: () => Date;
}

/** Builds the exact managed/deployment snapshot shared by catalog and launch. */
export class DefaultRuntimeModelEnvironmentResolver
  implements RuntimeModelEnvironmentResolver
{
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    private readonly environments: SandboxEnvironmentsService,
    private readonly managedProviders: RuntimeModelManagedProviderResolver,
    private readonly deployment: RuntimeModelDeploymentEnvironmentResolver,
    options: RuntimeModelEnvironmentResolverOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: {
    readonly ownerUserId: string;
    readonly runtime: Runtime;
    readonly selection: SandboxEnvironmentSelection;
  }): Promise<ResolvedRuntimeModelEnvironment> {
    const selection = await this.resolveOwnerDefault(
      input.ownerUserId,
      input.selection,
    );
    if (selection.kind === 'deployment-default') {
      return this.resolveDeployment(input.ownerUserId, input.runtime);
    }

    let managed: ResolvedSandboxEnvironment | null;
    try {
      managed = await this.environments.resolveImmutableForTask({
        selection,
        runtimeId: input.runtime,
      });
    } catch (error) {
      throw mapEnvironmentError(error);
    }
    if (!managed) return this.resolveDeployment(input.ownerUserId, input.runtime);
    return this.buildManaged(input.runtime, managed);
  }

  private async resolveOwnerDefault(
    ownerUserId: string,
    selection: SandboxEnvironmentSelection,
  ): Promise<SandboxEnvironmentSelection> {
    if (selection.kind !== 'managed-default') return selection;
    let row;
    try {
      row = await this.prisma.accountSettings.findUnique({
        where: { userId: ownerUserId },
        select: { defaultSandboxEnvironmentId: true },
      });
    } catch {
      throw new RuntimeModelCatalogOperationalError();
    }
    return row?.defaultSandboxEnvironmentId
      ? { kind: 'managed', environmentId: row.defaultSandboxEnvironmentId }
      : selection;
  }

  private async resolveDeployment(
    ownerUserId: string,
    runtime: Runtime,
  ): Promise<ResolvedRuntimeModelEnvironment> {
    const resolved = await this.deployment.resolve({ ownerUserId, runtime });
    return validateResolvedEnvironment(runtime, resolved, 'deployment-default');
  }

  private async buildManaged(
    runtime: Runtime,
    environment: ResolvedSandboxEnvironment,
  ): Promise<ResolvedRuntimeModelEnvironment> {
    const environmentId = environment.environmentId ?? environment.id;
    if (!environmentId || !environment.providerFamily) {
      throw new RuntimeModelCatalogOperationalError();
    }
    const provider = await this.managedProviders.resolveProviderId({
      providerFamily: environment.providerFamily,
      environmentId,
    });
    const sandboxMetadata = SandboxMetadataSchema.parse(
      environment.metadata?.sandboxMetadata,
    );
    const cliVersion = sandboxMetadata.dependencies[runtime];
    const cliArtifactChecksum = environment.cliArtifactChecksum;
    const source = managedSnapshotSource(environment);
    const providerFamily = knownProviderFamily(environment.providerFamily);
    if (
      !cliVersion ||
      !cliArtifactChecksum ||
      !environment.validationId ||
      !environment.validationVersion
    ) {
      throw new RuntimeModelCatalogOperationalError();
    }
    const snapshot = buildRuntimeExecutionEnvironmentSnapshot({
        schemaVersion: 1,
        kind: 'managed',
        managedEnvironmentId: environmentId,
        validationId: environment.validationId,
        validationContractVersion: environment.validationVersion,
        provider,
        providerFamily,
        source,
        immutableIdentity: sourceIdentity(source),
        sandboxMetadata,
        cliVersion,
        cliArtifactChecksum,
        resolvedAt: this.now().toISOString(),
      });
    return validateResolvedEnvironment(runtime, {
      effectiveEnvironment: {
        kind: 'managed',
        id: environmentId,
        name: environment.name ?? environmentId,
        provider,
        fingerprint: snapshot.fingerprint,
      },
      snapshot,
    }, 'managed');
  }
}

export class ConfiguredManagedRuntimeModelProviderResolver
  implements RuntimeModelManagedProviderResolver
{
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolveProviderId(input: {
    readonly providerFamily: string;
  }): Promise<string> {
    try {
      return resolveConfiguredProviderIdForFamily(
        input.providerFamily,
        this.env,
      );
    } catch {
      throw new RuntimeModelCatalogOperationalError();
    }
  }
}

/** Deployment snapshots stay closed until a configured provider proves identity. */
export class UnavailableDeploymentRuntimeModelEnvironmentResolver
  implements RuntimeModelDeploymentEnvironmentResolver
{
  async resolve(): Promise<ResolvedRuntimeModelEnvironment> {
    throw new RuntimeModelCatalogOperationalError();
  }
}

export interface ConfiguredDeploymentRuntimeModelEnvironmentResolverOptions {
  readonly validationRunner: SandboxEnvironmentValidationRunner;
  readonly cache: RuntimeModelCatalogCache<ResolvedRuntimeModelEnvironment>;
  readonly scheduler: OwnerFairProbeScheduler;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

/** Resolves and validates the real configured fallback into an exact snapshot. */
export class ConfiguredDeploymentRuntimeModelEnvironmentResolver
  implements RuntimeModelDeploymentEnvironmentResolver
{
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;

  constructor(
    private readonly options: ConfiguredDeploymentRuntimeModelEnvironmentResolverOptions,
  ) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: {
    readonly ownerUserId: string;
    readonly runtime: Runtime;
  }): Promise<ResolvedRuntimeModelEnvironment> {
    const resolveImmutableTarget =
      this.options.validationRunner.resolveImmutableTarget;
    if (!resolveImmutableTarget) {
      throw new RuntimeModelCatalogOperationalError();
    }
    let configured;
    let immutableTarget: SandboxEnvironmentValidationTarget;
    try {
      configured = resolveConfiguredDeploymentEnvironmentTarget(
        input.runtime,
        this.env,
      );
      immutableTarget = await resolveImmutableTarget.call(
        this.options.validationRunner,
        {
          id: 'deployment-default',
          name: configured.name,
          source: configured.source,
          providerFamily: configured.providerFamily,
          runtimeIds: [input.runtime],
          runtimeId: input.runtime,
        },
      );
    } catch {
      throw new RuntimeModelCatalogOperationalError();
    }
    const identity = sourceDigest(immutableTarget.source);
    if (!identity) throw new RuntimeModelCatalogOperationalError();
    const cacheKey = JSON.stringify({
      ownerUserId: input.ownerUserId,
      runtime: input.runtime,
      provider: configured.providerId,
      providerFamily: configured.providerFamily,
      sourceKind: immutableTarget.source.kind,
      sourceReference: sourceReference(immutableTarget.source),
      identity,
    });

    return this.options.cache.getOrLoad(
      cacheKey,
      input.ownerUserId,
      () =>
        this.options.scheduler.run(input.ownerUserId, async () => {
          const outcome = await this.options.validationRunner.validate({
            ...immutableTarget,
            probeTaskId: `runtime-model-env-probe-${randomUUID()}`,
          });
          if (outcome.status !== 'passed') {
            throw new RuntimeModelCatalogOperationalError();
          }
          const sandboxMetadata = SandboxMetadataSchema.parse(
            outcome.sandboxMetadata,
          );
          const cliVersion = sandboxMetadata.dependencies[input.runtime];
          const cliArtifactChecksum =
            outcome.runtimeArtifactChecksums?.[input.runtime] ??
            outcome.cliArtifactChecksum;
          const source = deploymentSnapshotSource(
            immutableTarget.source,
            outcome.resolvedLocator,
            outcome.resolvedDigest,
            outcome.resolvedChecksum,
          );
          if (!cliVersion || !cliArtifactChecksum) {
            throw new RuntimeModelCatalogOperationalError();
          }
          const snapshot = buildRuntimeExecutionEnvironmentSnapshot({
            schemaVersion: 1,
            kind: 'deployment-default',
            managedEnvironmentId: null,
            validationId: null,
            validationContractVersion: null,
            provider: configured.providerId,
            providerFamily: knownProviderFamily(configured.providerFamily),
            source,
            immutableIdentity: sourceIdentity(source),
            sandboxMetadata,
            cliVersion,
            cliArtifactChecksum,
            resolvedAt: this.now().toISOString(),
          });
          return validateResolvedEnvironment(input.runtime, {
            effectiveEnvironment: {
              kind: 'deployment-default',
              id: null,
              name: configured.name,
              provider: configured.providerId,
              fingerprint: snapshot.fingerprint,
            },
            snapshot,
          }, 'deployment-default');
        }),
    );
  }
}

function managedSnapshotSource(
  environment: ResolvedSandboxEnvironment,
): RuntimeExecutionEnvironmentSnapshot['source'] {
  if (
    environment.sourceKind === 'aio-docker-image' &&
    environment.sourceRef &&
    environment.digest
  ) {
    return {
      kind: 'aio-docker-image',
      locator: environment.sourceRef,
      digest: environment.digest,
      checksum: null,
    };
  }
  if (
    environment.sourceKind === 'boxlite-image' &&
    environment.sourceRef &&
    environment.digest
  ) {
    return {
      kind: 'boxlite-image',
      locator: environment.sourceRef,
      digest: environment.digest,
      checksum: null,
    };
  }
  throw new RuntimeModelCatalogOperationalError();
}

function deploymentSnapshotSource(
  configured: SandboxEnvironmentSourceDescriptor,
  resolvedLocator?: string | null,
  resolvedDigest?: string | null,
  resolvedChecksum?: string | null,
): RuntimeExecutionEnvironmentSnapshot['source'] {
  const locator = resolvedLocator ?? sourceReference(configured);
  const digest = resolvedDigest ?? sourceDigest(configured);
  if (configured.kind === 'aio-docker-image' && digest) {
    return {
      kind: 'aio-docker-image',
      locator,
      digest,
      checksum: null,
    };
  }
  if (configured.kind === 'boxlite-image' && digest) {
    return {
      kind: 'boxlite-image',
      locator,
      digest,
      checksum: null,
    };
  }
  if (resolvedChecksum) {
    return {
      kind: 'provider-snapshot',
      locator,
      digest: digest ?? null,
      checksum: resolvedChecksum,
    };
  }
  throw new RuntimeModelCatalogOperationalError();
}

function knownProviderFamily(
  family: string,
): RuntimeExecutionEnvironmentSnapshot['providerFamily'] {
  if (family === 'aio' || family === 'boxlite' || family === 'cloud-http') {
    return family;
  }
  throw new RuntimeModelCatalogOperationalError();
}

function sourceIdentity(
  source: RuntimeExecutionEnvironmentSnapshot['source'],
): string {
  const identity = source.digest ?? source.checksum;
  if (!identity) throw new RuntimeModelCatalogOperationalError();
  return identity;
}

function validateResolvedEnvironment(
  runtime: Runtime,
  resolved: ResolvedRuntimeModelEnvironment,
  expectedKind: RuntimeExecutionEnvironmentSnapshot['kind'],
): ResolvedRuntimeModelEnvironment {
  try {
    const snapshot = validateRuntimeExecutionEnvironmentSnapshot(
      runtime,
      resolved.snapshot,
    );
    const effectiveEnvironment = RuntimeModelEffectiveEnvironmentSchema.parse(
      resolved.effectiveEnvironment,
    );
    if (
      snapshot.kind !== expectedKind ||
      effectiveEnvironment.kind !== expectedKind ||
      effectiveEnvironment.provider !== snapshot.provider ||
      effectiveEnvironment.fingerprint !== snapshot.fingerprint ||
      (snapshot.kind === 'managed' &&
        effectiveEnvironment.id !== snapshot.managedEnvironmentId) ||
      (snapshot.kind === 'deployment-default' && effectiveEnvironment.id !== null)
    ) {
      throw new RuntimeModelCatalogOperationalError();
    }
    return { effectiveEnvironment, snapshot };
  } catch (error) {
    if (error instanceof RuntimeModelCatalogOperationalError) throw error;
    throw new RuntimeModelCatalogOperationalError();
  }
}

const SAFE_ENVIRONMENT_ERROR_CODES = new Set([
  'sandbox_environment_not_found',
  'sandbox_environment_not_ready',
  'sandbox_environment_invalid_source',
  'sandbox_environment_contract_stale',
  'sandbox_environment_immutable_identity_unavailable',
  'sandbox_environment_compatibility_error',
  'sandbox_environment_source_error',
]);

function mapEnvironmentError(error: unknown): Error {
  if (!(error instanceof BadRequestException)) {
    return error instanceof RuntimeModelEnvironmentResolutionError
      ? error
      : new RuntimeModelCatalogOperationalError();
  }
  const response = error.getResponse();
  if (typeof response === 'object' && response !== null) {
    const code = 'error' in response ? response.error : undefined;
    const message = 'message' in response ? response.message : undefined;
    if (
      typeof code === 'string' &&
      typeof message === 'string' &&
      SAFE_ENVIRONMENT_ERROR_CODES.has(code)
    ) {
      return new RuntimeModelEnvironmentResolutionError(code, message);
    }
  }
  return new RuntimeModelEnvironmentResolutionError(
    'sandbox_environment_invalid',
    'The selected sandbox environment is invalid.',
  );
}
