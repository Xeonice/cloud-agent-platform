import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
  SandboxEnvironmentsService,
} from './sandbox-environments.service';
import type { SandboxEnvironmentValidationRunner } from './sandbox-environments.validator';

const ENV_A = '00000000-0000-4000-a000-000000000301';
const ENV_B = '00000000-0000-4000-a000-000000000302';
const VALIDATION_A = '00000000-0000-4000-a000-000000000401';

interface FakeEnvironmentRow {
  id: string;
  name: string;
  source: Record<string, unknown>;
  status: string;
  providerFamilies: string[];
  runtimeIds: string[];
  isDefault: boolean;
  lastValidationId: string | null;
  contractVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeValidationRow {
  id: string;
  environmentId: string;
  status: string;
  providerFamily: string;
  runtimeId: string | null;
  sourceKind: string;
  resolvedDigest: string | null;
  resolvedChecksum: string | null;
  probes: unknown;
  error: string | null;
  contractVersion: string | null;
  checkedAt: Date;
}

function makeEnvironment(overrides: Partial<FakeEnvironmentRow>): FakeEnvironmentRow {
  const createdAt = overrides.createdAt ?? new Date('2026-07-01T00:00:00.000Z');
  return {
    id: overrides.id ?? ENV_A,
    name: overrides.name ?? 'Base image',
    source: overrides.source ?? { kind: 'aio-docker-image', image: 'cap/base:latest' },
    status: overrides.status ?? 'draft',
    providerFamilies: overrides.providerFamilies ?? ['aio'],
    runtimeIds: overrides.runtimeIds ?? [],
    isDefault: overrides.isDefault ?? false,
    lastValidationId: overrides.lastValidationId ?? null,
    contractVersion: overrides.contractVersion ?? SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  };
}

function buildService(
  initialRows: FakeEnvironmentRow[] = [],
  validationRunner: SandboxEnvironmentValidationRunner = createPassingValidationRunner(),
): {
  service: SandboxEnvironmentsService;
  rows: FakeEnvironmentRow[];
  validations: FakeValidationRow[];
} {
  const rows = [...initialRows];
  const validations: FakeValidationRow[] = [];

  function attachLatestValidation(row: FakeEnvironmentRow): FakeEnvironmentRow & {
    validations: { checkedAt: Date }[];
  } {
    const latest = validations
      .filter((validation) => validation.environmentId === row.id)
      .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime())[0];
    return {
      ...row,
      validations: latest ? [{ checkedAt: latest.checkedAt }] : [],
    };
  }

  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    sandboxEnvironment: {
      findMany: async (args?: {
        where?: {
          isDefault?: boolean;
          status?: string;
          contractVersion?: { not?: string };
        };
        include?: unknown;
      }) => {
        let result = [...rows];
        if (args?.where?.isDefault !== undefined) {
          result = result.filter((row) => row.isDefault === args.where?.isDefault);
        }
        if (args?.where?.status !== undefined) {
          result = result.filter((row) => row.status === args.where?.status);
        }
        if (args?.where?.contractVersion?.not !== undefined) {
          result = result.filter(
            (row) => row.contractVersion !== args.where?.contractVersion?.not,
          );
        }
        result.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return args?.include ? result.map(attachLatestValidation) : result;
      },
      findUnique: async (args: { where: { id: string }; include?: unknown }) => {
        const row = rows.find((candidate) => candidate.id === args.where.id);
        if (!row) return null;
        return args.include ? attachLatestValidation(row) : row;
      },
      create: async (args: {
        data: {
          name: string;
          source: Record<string, unknown>;
          status: string;
          providerFamilies: string[];
          runtimeIds: string[];
          isDefault: boolean;
          contractVersion: string;
        };
        include?: unknown;
      }) => {
        const row = makeEnvironment({
          id: ENV_B,
          name: args.data.name,
          source: args.data.source,
          status: args.data.status,
          providerFamilies: args.data.providerFamilies,
          runtimeIds: args.data.runtimeIds,
          isDefault: args.data.isDefault,
          contractVersion: args.data.contractVersion,
          createdAt: new Date('2026-07-01T01:00:00.000Z'),
        });
        rows.push(row);
        return args.include ? attachLatestValidation(row) : row;
      },
      update: async (args: {
        where: { id: string };
        data: Partial<FakeEnvironmentRow>;
        include?: unknown;
      }) => {
        const row = rows.find((candidate) => candidate.id === args.where.id);
        if (!row) throw new Error(`missing env ${args.where.id}`);
        Object.assign(row, args.data, { updatedAt: new Date('2026-07-01T02:00:00.000Z') });
        return args.include ? attachLatestValidation(row) : row;
      },
      updateMany: async (args: {
        where?: {
          isDefault?: boolean;
          status?: string;
          contractVersion?: { not?: string };
        };
        data: Partial<FakeEnvironmentRow>;
      }) => {
        const targets = await prisma.sandboxEnvironment.findMany({ where: args.where });
        for (const row of targets) {
          Object.assign(row, args.data, { updatedAt: new Date('2026-07-01T03:00:00.000Z') });
        }
        return { count: targets.length };
      },
    },
    sandboxEnvironmentValidation: {
      create: async (args: {
        data: Omit<FakeValidationRow, 'id' | 'checkedAt' | 'error'> & {
          error?: string | null;
        };
      }) => {
        const validation: FakeValidationRow = {
          id: VALIDATION_A,
          checkedAt: new Date('2026-07-01T04:00:00.000Z'),
          error: null,
          ...args.data,
        };
        validations.push(validation);
        return validation;
      },
      findMany: async (args: { where: { environmentId: string } }) =>
        validations
          .filter((validation) => validation.environmentId === args.where.environmentId)
          .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime()),
    },
  } as unknown as PrismaService & {
    sandboxEnvironment: {
      findMany(args?: unknown): Promise<FakeEnvironmentRow[]>;
    };
  };

  return {
    service: new SandboxEnvironmentsService(prisma, validationRunner),
    rows,
    validations,
  };
}

function createPassingValidationRunner(): SandboxEnvironmentValidationRunner {
  return {
    async validate(target) {
      const source = target.source as {
        readonly kind: string;
        readonly digest?: string;
      };
      return {
        status: 'passed',
        providerFamily: target.providerFamily,
        runtimeId: target.runtimeId ?? null,
        sourceKind: source.kind,
        resolvedDigest: source.digest ?? null,
        resolvedChecksum: null,
        probes: [{ name: 'provider-probe', ok: true, output: 'ok' }],
        error: null,
      };
    },
  };
}

test('create accepts registry image references and derives provider compatibility', async () => {
  const { service, rows } = buildService();

  const created = await service.create({
    name: 'AIO base',
    source: { kind: 'aio-docker-image', image: 'cap/aio:latest' },
  });

  assert.equal(created.id, ENV_B);
  assert.deepEqual(created.compatibility.providerFamilies, ['aio']);
  assert.equal(rows[0]?.source.kind, 'aio-docker-image');
  assert.equal(rows[0]?.source.image, 'cap/aio:latest');
});

test('create derives provider compatibility from BoxLite image and moves the default pointer', async () => {
  const existing = makeEnvironment({
    id: ENV_A,
    status: 'ready',
    isDefault: true,
  });
  const { service, rows } = buildService([existing]);

  const created = await service.create({
    name: 'BoxLite base',
    source: { kind: 'boxlite-image', image: 'cap/boxlite:latest' },
    runtimeIds: ['codex'],
    isDefault: true,
  });

  assert.equal(created.id, ENV_B);
  assert.deepEqual(created.compatibility.providerFamilies, ['boxlite']);
  assert.deepEqual(created.compatibility.runtimeIds, ['codex']);
  assert.equal(created.isDefault, true);
  assert.equal(rows.find((row) => row.id === ENV_A)?.isDefault, false);
});

test('create rejects removed source kinds instead of applying compatibility shims', async () => {
  const { service } = buildService();

  for (const source of [
    {
      kind: 'aio-loaded-docker-image',
      image: 'cap-aio-custom:v1',
    },
    {
      kind: 'boxlite-rootfs',
      rootfsPath: '/var/lib/cap/rootfs/custom',
    },
    {
      kind: 'oci-upload',
      uploadId: 'upload-1',
    },
  ]) {
    await assert.rejects(
      () =>
        service.create({
          name: `Legacy ${source.kind}`,
          source,
        } as unknown as Parameters<SandboxEnvironmentsService['create']>[0]),
      /Invalid discriminator value/,
    );
  }
});

test('validate records a provider-specific validation and marks the environment ready', async () => {
  const { service, validations } = buildService([
    makeEnvironment({
      id: ENV_A,
      source: { kind: 'aio-docker-image', image: 'cap/aio:latest', digest: 'sha256:abc' },
      providerFamilies: ['aio'],
      runtimeIds: ['codex'],
    }),
  ]);

  const result = await service.validate(ENV_A);

  assert.equal(result.environment.status, 'ready');
  assert.equal(result.environment.lastValidationId, VALIDATION_A);
  assert.equal(result.validation.providerFamily, 'aio');
  assert.equal(result.validation.runtimeId, 'codex');
  assert.equal(result.validation.sourceKind, 'aio-docker-image');
  assert.equal(result.validation.resolvedDigest, 'sha256:abc');
  assert.equal(validations.length, 1);
});

test('validate records failed provider probes and marks the environment failed', async () => {
  const { service, validations } = buildService(
    [
      makeEnvironment({
        id: ENV_A,
        source: { kind: 'boxlite-image', image: 'cap/boxlite:latest' },
        providerFamilies: ['boxlite'],
      }),
    ],
    {
      async validate(target) {
        return {
          status: 'failed',
          providerFamily: target.providerFamily,
          runtimeId: target.runtimeId ?? null,
          sourceKind: target.source.kind,
          resolvedDigest: null,
          resolvedChecksum: null,
          probes: [{ name: 'create-sandbox', ok: false, output: 'No such image' }],
          error: 'No such image',
        };
      },
    },
  );

  const result = await service.validate(ENV_A);

  assert.equal(result.environment.status, 'failed');
  assert.equal(result.validation.status, 'failed');
  assert.equal(result.validation.error, 'No such image');
  assert.equal(validations.length, 1);
});

test('validate catches validator exceptions and stores a failed validation', async () => {
  const { service } = buildService(
    [
      makeEnvironment({
        id: ENV_A,
        source: { kind: 'aio-docker-image', image: 'cap/aio:latest' },
        providerFamilies: ['aio'],
      }),
    ],
    {
      async validate() {
        throw new Error('docker unavailable');
      },
    },
  );

  const result = await service.validate(ENV_A);

  assert.equal(result.environment.status, 'failed');
  assert.equal(result.validation.status, 'failed');
  assert.equal(result.validation.error, 'docker unavailable');
  assert.deepEqual(result.validation.probes, [
    { name: 'validation-error', ok: false, output: 'docker unavailable' },
  ]);
});

test('resolveForTask returns a compatible ready default and ignores incompatible defaults', async () => {
  const { service } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      isDefault: true,
      source: { kind: 'boxlite-image', image: 'cap/boxlite:latest' },
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      lastValidationId: VALIDATION_A,
    }),
  ]);

  const resolved = await service.resolveForTask({
    requestedEnvironmentId: null,
    runtimeId: 'codex',
    providerFamily: 'boxlite',
  });
  assert.equal(resolved?.environmentId, ENV_A);
  assert.equal(resolved?.sourceKind, 'boxlite-image');
  assert.equal(resolved?.sourceRef, 'cap/boxlite:latest');

  const missing = await service.resolveForTask({
    requestedEnvironmentId: null,
    runtimeId: 'claude-code',
    providerFamily: 'boxlite',
  });
  assert.equal(missing, null);
});

test('resolveForTask returns null when no managed environment is selected or defaulted', async () => {
  const { service } = buildService();

  const resolved = await service.resolveForTask({
    requestedEnvironmentId: null,
    runtimeId: 'codex',
    providerFamily: 'aio',
  });

  assert.equal(resolved, null);
});

test('resolveForTask rejects an explicit environment that is not ready or compatible', async () => {
  const { service } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'draft',
      providerFamilies: ['aio'],
    }),
  ]);

  await assert.rejects(
    () =>
      service.resolveForTask({
        requestedEnvironmentId: ENV_A,
        runtimeId: 'codex',
        providerFamily: 'boxlite',
      }),
    (err: unknown) => err instanceof BadRequestException,
  );
});

test('retire disables an environment, clears default, and preserves validation history', async () => {
  const { service, rows, validations } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'failed',
      isDefault: true,
      lastValidationId: VALIDATION_A,
    }),
  ]);
  validations.push({
    id: VALIDATION_A,
    environmentId: ENV_A,
    status: 'failed',
    providerFamily: 'aio',
    runtimeId: null,
    sourceKind: 'aio-docker-image',
    resolvedDigest: null,
    resolvedChecksum: null,
    probes: [{ name: 'create-sandbox', ok: false, output: 'No such image' }],
    error: 'No such image',
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    checkedAt: new Date('2026-07-01T04:00:00.000Z'),
  });

  const retired = await service.retire(ENV_A);

  assert.equal(retired.status, 'disabled');
  assert.equal(retired.isDefault, false);
  assert.equal(retired.lastValidationId, VALIDATION_A);
  assert.equal(retired.lastValidatedAt?.toISOString(), '2026-07-01T04:00:00.000Z');
  assert.equal(rows.find((row) => row.id === ENV_A)?.status, 'disabled');
  assert.equal(validations.length, 1);
});

test('retired environments are not resolved explicitly or as defaults', async () => {
  const { service } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'disabled',
      isDefault: true,
      providerFamilies: ['aio'],
      lastValidationId: VALIDATION_A,
    }),
  ]);

  const implicit = await service.resolveForTask({
    requestedEnvironmentId: null,
    runtimeId: 'codex',
    providerFamily: 'aio',
  });
  assert.equal(implicit, null);

  await assert.rejects(
    () =>
      service.resolveForTask({
        requestedEnvironmentId: ENV_A,
        runtimeId: 'codex',
        providerFamily: 'aio',
      }),
    (err: unknown) => err instanceof BadRequestException,
  );
});

test('markCustomEnvironmentsStale only marks ready rows with an old contract version', async () => {
  const { service, rows } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      contractVersion: 'old-version',
    }),
    makeEnvironment({
      id: ENV_B,
      status: 'draft',
      contractVersion: 'old-version',
    }),
  ]);

  const count = await service.markCustomEnvironmentsStale(
    SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
  );

  assert.equal(count, 1);
  assert.equal(rows.find((row) => row.id === ENV_A)?.status, 'stale');
  assert.equal(rows.find((row) => row.id === ENV_B)?.status, 'draft');
});
