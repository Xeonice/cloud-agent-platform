import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import type {
  SandboxEnvironmentValidationRunner,
  SandboxEnvironmentValidationTarget,
} from '../sandbox-environments/sandbox-environments.validator';
import {
  ConfiguredDeploymentRuntimeModelEnvironmentResolver,
  ConfiguredManagedRuntimeModelProviderResolver,
  DefaultRuntimeModelEnvironmentResolver,
} from './runtime-model-environment.resolver';
import {
  RuntimeModelCatalogOperationalError,
  RuntimeModelEnvironmentResolutionError,
} from './runtime-model-errors';
import { sha256Revision } from './runtime-model-catalog.util';
import { RuntimeModelCatalogCache } from './runtime-model-catalog-cache';
import { OwnerFairProbeScheduler } from './owner-fair-probe-scheduler';

const OWNER = '00000000-0000-4000-a000-000000000101';
const ENVIRONMENT_ID = '00000000-0000-4000-a000-000000000201';
const VALIDATION_ID = '00000000-0000-4000-a000-000000000301';

function managedEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    id: ENVIRONMENT_ID,
    environmentId: ENVIRONMENT_ID,
    name: 'Managed AIO',
    providerFamily: 'aio',
    runtimeId: 'codex',
    sourceKind: 'aio-docker-image',
    sourceRef: 'sha256:image-a',
    digest: 'sha256:image-a',
    validationId: VALIDATION_ID,
    validationVersion: 'v2',
    contractVersion: 'v2',
    cliArtifactChecksum: `sha256:${'a'.repeat(64)}`,
    metadata: {
      sandboxMetadata: {
        schemaVersion: 1,
        sandboxVersion: '1.2.3',
        dependencies: { codex: '0.144.1' },
      },
    },
    source: {
      kind: 'aio-docker-image',
      image: 'registry.example/cap/aio:v1',
    },
    ...overrides,
  };
}

function deploymentEnvironment() {
  const sandboxMetadata = {
    schemaVersion: 1 as const,
    sandboxVersion: '1.2.3',
    dependencies: { codex: '0.144.1' },
  };
  const sandboxMetadataChecksum = sha256Revision(sandboxMetadata);
  const snapshotBase = {
    schemaVersion: 1 as const,
    kind: 'deployment-default' as const,
    managedEnvironmentId: null,
    validationId: null,
    validationContractVersion: null,
    provider: 'aio-local',
    providerFamily: 'aio' as const,
    source: {
      kind: 'aio-docker-image' as const,
      locator: 'sha256:deployment-image',
      digest: 'sha256:deployment-image',
      checksum: null,
    },
    immutableIdentity: 'sha256:deployment-image',
    sandboxMetadata,
    sandboxMetadataChecksum,
    cliVersion: '0.144.1',
    cliArtifactChecksum: `sha256:${'b'.repeat(64)}`,
    resolvedAt: '2026-07-14T00:00:00.000Z',
  };
  const fingerprint = sha256Revision({
    kind: snapshotBase.kind,
    managedEnvironmentId: snapshotBase.managedEnvironmentId,
    validationId: snapshotBase.validationId,
    validationContractVersion: snapshotBase.validationContractVersion,
    provider: snapshotBase.provider,
    providerFamily: snapshotBase.providerFamily,
    source: snapshotBase.source,
    immutableIdentity: snapshotBase.immutableIdentity,
    sandboxMetadataChecksum: snapshotBase.sandboxMetadataChecksum,
    cliVersion: snapshotBase.cliVersion,
    cliArtifactChecksum: snapshotBase.cliArtifactChecksum,
  });
  const snapshot = { ...snapshotBase, fingerprint };
  return {
    snapshot,
    effectiveEnvironment: {
      kind: 'deployment-default' as const,
      id: null,
      name: 'Deployment AIO',
      provider: 'aio-local',
      fingerprint,
    },
  };
}

function buildResolver(input: {
  readonly ownerDefault?: string | null;
  readonly managed?: ReturnType<typeof managedEnvironment> | null;
  readonly managedError?: Error;
  readonly deployment?: ReturnType<typeof deploymentEnvironment>;
} = {}) {
  const selections: unknown[] = [];
  let deploymentCalls = 0;
  const prisma = {
    accountSettings: {
      findUnique: async () => ({
        defaultSandboxEnvironmentId: input.ownerDefault ?? null,
      }),
    },
  } as unknown as PrismaService;
  const environments = {
    resolveImmutableForTask: async (args: unknown) => {
      selections.push(args);
      if (input.managedError) throw input.managedError;
      return input.managed === undefined ? managedEnvironment() : input.managed;
    },
  } as unknown as SandboxEnvironmentsService;
  const deployment = {
    resolve: async () => {
      deploymentCalls += 1;
      return input.deployment ?? deploymentEnvironment();
    },
  };
  const resolver = new DefaultRuntimeModelEnvironmentResolver(
    prisma,
    environments,
    new ConfiguredManagedRuntimeModelProviderResolver({
      CAP_SANDBOX_PROVIDER: 'aio',
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
      BOXLITE_PROVIDER_ID: 'boxlite-custom',
    }),
    deployment,
    { now: () => new Date('2026-07-14T01:00:00.000Z') },
  );
  return { resolver, selections, deploymentCalls: () => deploymentCalls };
}

test('omitted environment uses exact owner default and builds an immutable snapshot', async () => {
  const harness = buildResolver({ ownerDefault: ENVIRONMENT_ID });
  const result = await harness.resolver.resolve({
    ownerUserId: OWNER,
    runtime: 'codex',
    selection: { kind: 'managed-default' },
  });
  assert.deepEqual(harness.selections, [
    {
      selection: { kind: 'managed', environmentId: ENVIRONMENT_ID },
      runtimeId: 'codex',
    },
  ]);
  assert.equal(result.effectiveEnvironment.kind, 'managed');
  assert.equal(result.snapshot.managedEnvironmentId, ENVIRONMENT_ID);
  assert.equal(result.snapshot.validationId, VALIDATION_ID);
  assert.equal(result.snapshot.source.locator, 'sha256:image-a');
  assert.equal(result.snapshot.cliVersion, '0.144.1');
  assert.equal(
    result.snapshot.cliArtifactChecksum,
    `sha256:${'a'.repeat(64)}`,
  );
  assert.equal(result.snapshot.resolvedAt, '2026-07-14T01:00:00.000Z');
});

test('explicit null bypasses every managed lookup and resolves deployment default', async () => {
  const harness = buildResolver({ ownerDefault: ENVIRONMENT_ID });
  const result = await harness.resolver.resolve({
    ownerUserId: OWNER,
    runtime: 'codex',
    selection: { kind: 'deployment-default' },
  });
  assert.deepEqual(harness.selections, []);
  assert.equal(harness.deploymentCalls(), 1);
  assert.equal(result.effectiveEnvironment.kind, 'deployment-default');
  assert.equal(result.snapshot.managedEnvironmentId, null);
});

test('no owner/global managed default falls through to deployment without identity guessing', async () => {
  const harness = buildResolver({ ownerDefault: null, managed: null });
  const result = await harness.resolver.resolve({
    ownerUserId: OWNER,
    runtime: 'codex',
    selection: { kind: 'managed-default' },
  });
  assert.equal(harness.deploymentCalls(), 1);
  assert.equal(result.snapshot.kind, 'deployment-default');
});

test('managed environment errors retain their stable environment semantics', async () => {
  const harness = buildResolver({
    managedError: new BadRequestException({
      error: 'sandbox_environment_contract_stale',
      message: 'Revalidate this environment.',
    }),
  });
  await assert.rejects(
    harness.resolver.resolve({
      ownerUserId: OWNER,
      runtime: 'codex',
      selection: { kind: 'managed', environmentId: ENVIRONMENT_ID },
    }),
    (error: unknown) =>
      error instanceof RuntimeModelEnvironmentResolutionError &&
      error.code === 'sandbox_environment_contract_stale' &&
      error.message === 'Revalidate this environment.',
  );
});

test('missing CLI artifact evidence fails closed instead of inventing a snapshot', async () => {
  const harness = buildResolver({
    managed: managedEnvironment({ cliArtifactChecksum: undefined }),
  });
  await assert.rejects(
    harness.resolver.resolve({
      ownerUserId: OWNER,
      runtime: 'codex',
      selection: { kind: 'managed', environmentId: ENVIRONMENT_ID },
    }),
    RuntimeModelCatalogOperationalError,
  );
});

test('deployment snapshots reject forged metadata, CLI and environment fingerprints', async () => {
  const deployment = deploymentEnvironment();
  const harness = buildResolver({
    deployment: {
      ...deployment,
      snapshot: {
        ...deployment.snapshot,
        cliVersion: 'forged-version',
      },
    },
  });
  await assert.rejects(
    harness.resolver.resolve({
      ownerUserId: OWNER,
      runtime: 'codex',
      selection: { kind: 'deployment-default' },
    }),
    RuntimeModelCatalogOperationalError,
  );
});

test('configured deployment resolver pins identity, validates once and caches by exact digest', async () => {
  let validations = 0;
  const checksum = `sha256:${'c'.repeat(64)}`;
  const validationRunner: SandboxEnvironmentValidationRunner = {
    resolveImmutableTarget: async (
      target: SandboxEnvironmentValidationTarget,
    ) => ({
      ...target,
      source: {
        kind: 'aio-docker-image' as const,
        image: `sha256:${'d'.repeat(64)}`,
        digest: `sha256:${'d'.repeat(64)}`,
      },
    }),
    validate: async (target: SandboxEnvironmentValidationTarget) => {
      validations += 1;
      return {
        status: 'passed' as const,
        providerFamily: 'aio' as const,
        runtimeId: 'codex',
        sourceKind: 'aio-docker-image',
        resolvedLocator: target.source.image,
        resolvedDigest: target.source.digest ?? null,
        resolvedChecksum: null,
        runtimeArtifactChecksums: { codex: checksum },
        cliArtifactChecksum: checksum,
        sandboxMetadata: {
          schemaVersion: 1 as const,
          sandboxVersion: '1.2.3',
          dependencies: { codex: '0.144.1' },
        },
        probes: [],
        error: null,
      };
    },
  };
  const resolver = new ConfiguredDeploymentRuntimeModelEnvironmentResolver({
    validationRunner,
    cache: new RuntimeModelCatalogCache({
      ttlMs: 10_000,
      maxEntries: 4,
      maxInFlight: 2,
      maxInFlightPerOwner: 1,
    }),
    scheduler: new OwnerFairProbeScheduler({
      globalConcurrency: 2,
      perOwnerConcurrency: 1,
      globalQueueLimit: 4,
      perOwnerQueueLimit: 2,
      queueWaitTimeoutMs: 1_000,
    }),
    env: {
      CAP_SANDBOX_PROVIDER: 'aio',
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
    },
    now: () => new Date('2026-07-14T02:00:00.000Z'),
  });

  const first = await resolver.resolve({ ownerUserId: OWNER, runtime: 'codex' });
  const second = await resolver.resolve({ ownerUserId: OWNER, runtime: 'codex' });
  assert.equal(validations, 1);
  assert.equal(first.snapshot.kind, 'deployment-default');
  assert.equal(first.snapshot.source.locator, `sha256:${'d'.repeat(64)}`);
  assert.equal(first.snapshot.cliArtifactChecksum, checksum);
  assert.equal(second.snapshot.fingerprint, first.snapshot.fingerprint);
});
