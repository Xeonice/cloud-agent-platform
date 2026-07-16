import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
  SandboxEnvironmentsService,
} from './sandbox-environments.service';
import type { SandboxEnvironmentValidationRunner } from './sandbox-environments.validator';
import { decryptStored, encryptToStored } from '../settings/secret-storage';

const ENV_A = '00000000-0000-4000-a000-000000000301';
const ENV_B = '00000000-0000-4000-a000-000000000302';
const ENV_C = '00000000-0000-4000-a000-000000000303';
const ENV_D = '00000000-0000-4000-a000-000000000304';
const VALIDATION_A = '00000000-0000-4000-a000-000000000401';
const TEST_ENV: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: '0'.repeat(64) };
process.env.CODEX_CRED_ENC_KEY = TEST_ENV.CODEX_CRED_ENC_KEY;

function encryptForTest(value: string): string {
  return encryptToStored(value, TEST_ENV);
}

async function withBoxLiteDeployment<T>(
  diskSizeGb: number,
  run: () => Promise<T>,
): Promise<T> {
  const values = {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'test-only',
    BOXLITE_IMAGE: 'cap/boxlite@sha256:deployment',
    BOXLITE_IMAGE_MAP: '',
    BOXLITE_ROOTFS_PATH: '',
    BOXLITE_ROOTFS_PATH_MAP: '',
    BOXLITE_PROVIDER_ID: 'boxlite-test',
    BOXLITE_PROVIDER_PRIORITY: '0',
    BOXLITE_PROVIDER_LOCATION: 'local',
    BOXLITE_PROTOCOL_MODE: 'native',
    BOXLITE_CAPABILITIES:
      'terminal.websocket,command.exec,workspace.git.materialize',
    BOXLITE_TERMINAL_MODE: 'pty',
    BOXLITE_SANDBOX_MODE: 'danger-full-access',
    BOXLITE_PATH_PREFIX: 'default',
    BOXLITE_TIMEOUT_MS: '30000',
    BOXLITE_GIT_CLONE_TIMEOUT_MS: '900000',
    BOXLITE_DISK_SIZE_GB: String(diskSizeGb),
  } as const;
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withAioDeployment<T>(run: () => Promise<T>): Promise<T> {
  const values = {
    CAP_SANDBOX_PROVIDER: 'aio',
    AIO_SANDBOX_IMAGE: 'cap/aio@sha256:deployment',
  } as const;
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface FakeEnvironmentRow {
  id: string;
  name: string;
  source: Record<string, unknown>;
  status: string;
  resources: Record<string, unknown> | null;
  envVars: Record<string, unknown>;
  secretEnvVars: Record<string, unknown>;
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
  resolvedLocator?: string | null;
  resolvedDigest: string | null;
  resolvedChecksum: string | null;
  runtimeArtifactChecksums?: Record<string, string> | null;
  cliArtifactChecksum?: string | null;
  sandboxMetadata: unknown;
  resourceSnapshot?: Record<string, unknown> | null;
  probes: unknown;
  error: string | null;
  contractVersion: string | null;
  checkedAt: Date;
}

interface FakeEnvironmentWhere {
  isDefault?: boolean;
  status?: string;
  contractVersion?: string | null | { not?: string };
  OR?: FakeEnvironmentWhere[];
}

function makeEnvironment(overrides: Partial<FakeEnvironmentRow>): FakeEnvironmentRow {
  const createdAt = overrides.createdAt ?? new Date('2026-07-01T00:00:00.000Z');
  return {
    id: overrides.id ?? ENV_A,
    name: overrides.name ?? 'Base image',
    source: overrides.source ?? { kind: 'aio-docker-image', image: 'cap/base:latest' },
    status: overrides.status ?? 'draft',
    resources: Object.prototype.hasOwnProperty.call(overrides, 'resources')
      ? (overrides.resources ?? null)
      : null,
    envVars: overrides.envVars ?? {},
    secretEnvVars: overrides.secretEnvVars ?? {},
    providerFamilies: overrides.providerFamilies ?? ['aio'],
    runtimeIds: overrides.runtimeIds ?? [],
    isDefault: overrides.isDefault ?? false,
    lastValidationId: overrides.lastValidationId ?? null,
    contractVersion: Object.prototype.hasOwnProperty.call(overrides, 'contractVersion')
      ? (overrides.contractVersion ?? null)
      : SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
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
  validationWrites: { sandboxMetadata: unknown; resourceSnapshot: unknown }[];
  environmentReadCount(): number;
} {
  const rows = [...initialRows];
  const validations: FakeValidationRow[] = [];
  let environmentReadCount = 0;
  const validationWrites: {
    sandboxMetadata: unknown;
    resourceSnapshot: unknown;
  }[] = [];

  function matchesWhere(row: FakeEnvironmentRow, where?: FakeEnvironmentWhere): boolean {
    if (!where) return true;
    if (where.isDefault !== undefined && row.isDefault !== where.isDefault) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.contractVersion === null || typeof where.contractVersion === 'string') {
      if (row.contractVersion !== where.contractVersion) return false;
    } else if (
      where.contractVersion?.not !== undefined &&
      (row.contractVersion === null || row.contractVersion === where.contractVersion.not)
    ) {
      return false;
    }
    if (where.OR && !where.OR.some((candidate) => matchesWhere(row, candidate))) return false;
    return true;
  }

  function attachLatestValidation(row: FakeEnvironmentRow): FakeEnvironmentRow & {
    validations: FakeValidationRow[];
  } {
    const latest = validations
      .filter((validation) => validation.environmentId === row.id)
      .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime())[0];
    return {
      ...row,
      validations: latest ? [latest] : [],
    };
  }

  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    sandboxEnvironment: {
      findMany: async (args?: {
        where?: FakeEnvironmentWhere;
        include?: unknown;
      }) => {
        environmentReadCount += 1;
        const result = rows.filter((row) => matchesWhere(row, args?.where));
        result.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return args?.include ? result.map(attachLatestValidation) : result;
      },
      findUnique: async (args: { where: { id: string }; include?: unknown }) => {
        environmentReadCount += 1;
        const row = rows.find((candidate) => candidate.id === args.where.id);
        if (!row) return null;
        return args.include ? attachLatestValidation(row) : row;
      },
      create: async (args: {
        data: {
          name: string;
          source: Record<string, unknown>;
          status: string;
          resources?: Record<string, unknown> | typeof Prisma.DbNull;
          envVars?: Record<string, unknown>;
          secretEnvVars?: Record<string, unknown>;
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
          resources:
            args.data.resources === Prisma.DbNull
              ? null
              : ((args.data.resources as Record<string, unknown> | undefined) ??
                null),
          envVars: args.data.envVars ?? {},
          secretEnvVars: args.data.secretEnvVars ?? {},
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
        where?: FakeEnvironmentWhere;
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
      findUnique: async (args: { where: { id: string } }) =>
        validations.find((validation) => validation.id === args.where.id) ?? null,
      create: async (args: {
        data: Omit<FakeValidationRow, 'id' | 'checkedAt' | 'error'> & {
          error?: string | null;
        };
      }) => {
        validationWrites.push({
          sandboxMetadata: args.data.sandboxMetadata,
          resourceSnapshot: args.data.resourceSnapshot,
        });
        const resourceSnapshot = args.data.resourceSnapshot as unknown;
        const validation: FakeValidationRow = {
          id: VALIDATION_A,
          checkedAt: new Date('2026-07-01T04:00:00.000Z'),
          error: null,
          ...args.data,
          sandboxMetadata:
            args.data.sandboxMetadata === Prisma.DbNull ||
            args.data.sandboxMetadata === Prisma.JsonNull
              ? null
              : args.data.sandboxMetadata,
          resourceSnapshot:
            resourceSnapshot === Prisma.DbNull ||
            resourceSnapshot === Prisma.JsonNull
              ? null
              : (resourceSnapshot as Record<string, unknown> | null | undefined),
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
    validationWrites,
    environmentReadCount: () => environmentReadCount,
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
        sandboxMetadata: {
          schemaVersion: 1,
          sandboxVersion: 'v1.2.3',
          dependencies: { codex: '0.132.0', 'company-cli': '4.5.6' },
        },
        resourceSnapshot: target.resources ?? {},
        probes: [{ name: 'provider-probe', ok: true, output: 'ok' }],
        error: null,
      };
    },
  };
}

test('validation persists and exposes only builder-declared sandbox metadata', async () => {
  const environment = makeEnvironment({
    id: ENV_A,
    source: { kind: 'aio-docker-image', image: 'cap/aio:v1.2.3' },
    runtimeIds: ['codex'],
  });
  const { service } = buildService([environment]);

  const result = await service.validate(ENV_A);

  assert.deepEqual(result.validation.sandboxMetadata, {
    schemaVersion: 1,
    sandboxVersion: 'v1.2.3',
    dependencies: { codex: '0.132.0', 'company-cli': '4.5.6' },
  });
  assert.deepEqual(result.environment.sandboxMetadata, result.validation.sandboxMetadata);
});

test('validation persists the exact resource snapshot used by its probe', async () => {
  const environment = makeEnvironment({
    id: ENV_A,
    source: { kind: 'boxlite-image', image: 'cap/boxlite@sha256:resource' },
    providerFamilies: ['boxlite'],
    resources: { diskSizeGb: 9 },
    runtimeIds: ['codex'],
  });
  const runner: SandboxEnvironmentValidationRunner = {
    async validate(target) {
      assert.deepEqual(target.resources, { diskSizeGb: 9 });
      return {
        ...(await createPassingValidationRunner().validate(target)),
        resourceSnapshot: Object.freeze({ diskSizeGb: 9 }),
      };
    },
  };
  const { service, validations, validationWrites } = buildService(
    [environment],
    runner,
  );

  const result = await service.validate(ENV_A);

  assert.deepEqual(validationWrites[0]?.resourceSnapshot, { diskSizeGb: 9 });
  assert.deepEqual(validations[0]?.resourceSnapshot, { diskSizeGb: 9 });
  assert.deepEqual(result.validation.resourceSnapshot, { diskSizeGb: 9 });
});

test('failed validation persists absent sandbox metadata as database null', async () => {
  const environment = makeEnvironment({
    id: ENV_A,
    source: { kind: 'aio-docker-image', image: 'cap/aio:missing' },
    runtimeIds: ['codex'],
  });
  const failingRunner: SandboxEnvironmentValidationRunner = {
    async validate() {
      throw new Error('image probe failed');
    },
  };
  const { service, rows, validations, validationWrites } = buildService(
    [environment],
    failingRunner,
  );

  const result = await service.validate(ENV_A);

  assert.equal(validationWrites[0]?.sandboxMetadata, Prisma.DbNull);
  assert.equal(validations.length, 1);
  assert.equal(validations[0]?.sandboxMetadata, null);
  assert.equal(result.validation.status, 'failed');
  assert.equal(result.validation.sandboxMetadata, null);
  assert.equal(result.environment.status, 'failed');
  assert.equal(result.environment.sandboxMetadata, null);
  assert.equal(rows[0]?.lastValidationId, VALIDATION_A);
});

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

test('create stores image parameters and redacts secret values on reads', async () => {
  const { service, rows } = buildService();

  const created = await service.create({
    name: 'BoxLite gcode',
    source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
    parameters: [
      { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5' },
      { name: 'GCODE_TOKEN', value: 'gcode-secret', secret: true },
    ],
  });

  assert.deepEqual(created.parameters, [
    { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5', secret: false },
    { name: 'GCODE_TOKEN', secret: true },
  ]);
  assert.equal(rows[0]?.envVars.GCODE_API_BASE_URL, 'https://code.example/api/v5');
  assert.notEqual(rows[0]?.secretEnvVars.GCODE_TOKEN, 'gcode-secret');
  assert.equal(
    decryptStored(String(rows[0]?.secretEnvVars.GCODE_TOKEN), TEST_ENV),
    'gcode-secret',
  );
});

test('create persists bounded resources separately from guest image parameters', async () => {
  const { service, rows } = buildService();

  const created = await service.create({
    name: 'BoxLite large workspace',
    source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
    resources: { diskSizeGb: 5 },
    parameters: [
      { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5' },
    ],
  });

  assert.deepEqual(created.resources, { diskSizeGb: 5 });
  assert.deepEqual(rows[0]?.resources, { diskSizeGb: 5 });
  assert.deepEqual(rows[0]?.envVars, {
    GCODE_API_BASE_URL: 'https://code.example/api/v5',
  });
  assert.equal('diskSizeGb' in (rows[0]?.envVars ?? {}), false);
});

test('legacy null resources remain readable and invalid resource values fail centrally', async () => {
  const { service } = buildService([
    makeEnvironment({ id: ENV_A, resources: null }),
  ]);

  assert.equal((await service.list())[0]?.resources, null);

  for (const diskSizeGb of [0, 1.5, 1025]) {
    await assert.rejects(() =>
      service.create({
        name: 'Invalid resource',
        source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
        resources: { diskSizeGb },
      }),
    );
  }
});

test('create rejects duplicate image parameter names', async () => {
  const { service } = buildService();

  await assert.rejects(
    () =>
      service.create({
        name: 'bad params',
        source: { kind: 'aio-docker-image', image: 'cap/aio:latest' },
        parameters: [
          { name: 'TOKEN', value: 'a' },
          { name: 'TOKEN', value: 'b', secret: true },
        ],
      }),
    (err: unknown) => err instanceof BadRequestException,
  );
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
      resources: { diskSizeGb: 6 },
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      lastValidationId: VALIDATION_A,
    }),
    makeEnvironment({
      id: ENV_B,
      status: 'ready',
      isDefault: true,
      contractVersion: null,
      source: { kind: 'boxlite-image', image: 'cap/boxlite:no-contract' },
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      envVars: { LEGACY_VALUE: 'must-also-not-be-used' },
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
  assert.deepEqual(resolved?.resources, { diskSizeGb: 6 });
  assert.equal(Object.isFrozen(resolved?.resources), true);

  const missing = await service.resolveForTask({
    requestedEnvironmentId: null,
    runtimeId: 'claude-code',
    providerFamily: 'boxlite',
  });
  assert.equal(missing, null);
});

test('selection preserves managed default, explicit null deployment fallback, and exact UUID', async () => {
  const { service } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      isDefault: true,
      source: { kind: 'aio-docker-image', image: 'cap/aio:v1' },
      providerFamilies: ['aio'],
      runtimeIds: ['codex'],
    }),
  ]);

  assert.equal(
    (
      await service.resolveForTask({
        selection: { kind: 'managed-default' },
        runtimeId: 'codex',
        providerFamily: 'aio',
      })
    )?.environmentId,
    ENV_A,
  );
  assert.equal(
    await service.resolveForTask({
      selection: { kind: 'deployment-default' },
      runtimeId: 'codex',
      providerFamily: 'aio',
    }),
    null,
  );
  assert.equal(
    (
      await service.resolveForTask({
        selection: { kind: 'managed', environmentId: ENV_A },
        runtimeId: 'codex',
        providerFamily: 'aio',
      })
    )?.environmentId,
    ENV_A,
  );
});

test('admission resolves explicit and implicit deployment defaults before task write', async () => {
  const { service } = buildService();
  await withBoxLiteDeployment(11, async () => {
    const admission = await service.resolveTaskAdmission({
      selection: { kind: 'deployment-default' },
      runtimeId: 'codex',
    });
    const explicit = admission.provisioningPolicy.resources;
    const implicit = await service.resolveProvisioningResourcesForTask({
      selection: { kind: 'managed-default' },
      runtimeId: 'codex',
    });
    assert.deepEqual(explicit, { diskSizeGb: 11 });
    assert.deepEqual(implicit, { diskSizeGb: 11 });
    assert.equal(admission.providerId, 'boxlite-test');
    assert.equal(admission.providerFamily, 'boxlite');
    assert.equal(
      admission.provisioningPolicy.workspaceMaterializationDeadlineMs,
      900_000,
    );
    assert.equal(Object.isFrozen(explicit), true);
    assert.equal(Object.isFrozen(implicit), true);
  });
});

test('explicit-model admission validates its immutable resources over the current provider fallback', async () => {
  const { service } = buildService();
  await withBoxLiteDeployment(5, async () => {
    const admission = await service.resolveTaskAdmission({
      selection: { kind: 'deployment-default' },
      runtimeId: 'codex',
      providerFamily: 'boxlite',
      resources: { diskSizeGb: 9 },
    });
    assert.equal(admission.providerId, 'boxlite-test');
    assert.equal(admission.providerFamily, 'boxlite');
    assert.deepEqual(admission.provisioningPolicy.resources, {
      diskSizeGb: 9,
    });
    assert.equal(
      admission.provisioningPolicy.workspaceMaterializationDeadlineMs,
      900_000,
    );
  });
});

test('atomic task admission resolves managed environment and pinned policy from one row observation', async () => {
  const { service, validations, environmentReadCount } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      source: {
        kind: 'boxlite-image',
        image: 'cap/boxlite@sha256:atomic',
      },
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      lastValidationId: VALIDATION_A,
    }),
  ]);
  validations.push({
    id: VALIDATION_A,
    environmentId: ENV_A,
    status: 'passed',
    providerFamily: 'boxlite',
    runtimeId: 'codex',
    sourceKind: 'boxlite-image',
    resolvedLocator: 'cap/boxlite@sha256:atomic',
    resolvedDigest: 'sha256:atomic',
    resolvedChecksum: null,
    resourceSnapshot: { diskSizeGb: 8 },
    sandboxMetadata: null,
    probes: [],
    error: null,
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    checkedAt: new Date('2026-07-14T00:00:00.000Z'),
  });

  const admission = await withBoxLiteDeployment(15, () =>
    service.resolveTaskAdmission({
      selection: { kind: 'managed', environmentId: ENV_A },
      runtimeId: 'codex',
      providerFamily: 'boxlite',
    }),
  );
  assert.equal(environmentReadCount(), 1);
  assert.equal(admission.environment?.environmentId, ENV_A);
  assert.equal(admission.providerId, 'boxlite-test');
  assert.equal(admission.providerFamily, 'boxlite');
  assert.deepEqual(admission.environment?.resources, { diskSizeGb: 8 });
  assert.deepEqual(admission.provisioningPolicy.resources, { diskSizeGb: 8 });
  assert.equal(
    admission.provisioningPolicy.workspaceMaterializationDeadlineMs,
    900_000,
  );
  assert.equal(Object.isFrozen(admission), true);
  assert.equal(Object.isFrozen(admission.provisioningPolicy), true);
  assert.equal(Object.isFrozen(admission.provisioningPolicy.resources), true);
});

test('managed task resolution keeps its validation-pinned resources across config changes', async () => {
  const { service, validations } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      isDefault: true,
      source: {
        kind: 'boxlite-image',
        image: 'cap/boxlite@sha256:managed',
      },
      resources: null,
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      lastValidationId: VALIDATION_A,
    }),
  ]);
  validations.push({
    id: VALIDATION_A,
    environmentId: ENV_A,
    status: 'passed',
    providerFamily: 'boxlite',
    runtimeId: 'codex',
    sourceKind: 'boxlite-image',
    resolvedLocator: 'cap/boxlite@sha256:managed',
    resolvedDigest: 'sha256:managed',
    resolvedChecksum: null,
    resourceSnapshot: { diskSizeGb: 7 },
    sandboxMetadata: null,
    probes: [],
    error: null,
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    checkedAt: new Date('2026-07-14T00:00:00.000Z'),
  });

  for (const mutableFallback of [13, 17]) {
    await withBoxLiteDeployment(mutableFallback, async () => {
      assert.deepEqual(
        await service.resolveProvisioningResourcesForTask({
          selection: { kind: 'managed', environmentId: ENV_A },
          runtimeId: 'codex',
          providerFamily: 'boxlite',
        }),
        { diskSizeGb: 7 },
      );
    });
  }
});

test('an empty pinned AIO resource snapshot remains authoritative while admission freezes the default deadline', async () => {
  const { service, validations } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      source: { kind: 'aio-docker-image', image: 'cap/aio@sha256:pinned' },
      resources: null,
      providerFamilies: ['aio'],
      runtimeIds: ['codex'],
      lastValidationId: VALIDATION_A,
    }),
  ]);
  validations.push({
    id: VALIDATION_A,
    environmentId: ENV_A,
    status: 'passed',
    providerFamily: 'aio',
    runtimeId: 'codex',
    sourceKind: 'aio-docker-image',
    resolvedLocator: 'cap/aio@sha256:pinned',
    resolvedDigest: 'sha256:pinned',
    resolvedChecksum: null,
    resourceSnapshot: {},
    sandboxMetadata: null,
    probes: [],
    error: null,
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    checkedAt: new Date('2026-07-14T00:00:00.000Z'),
  });

  const admission = await withAioDeployment(() =>
    service.resolveTaskAdmission({
      selection: { kind: 'managed', environmentId: ENV_A },
      runtimeId: 'codex',
      providerFamily: 'aio',
    }),
  );
  assert.deepEqual(admission.provisioningPolicy.resources, {});
  assert.equal(
    admission.provisioningPolicy.workspaceMaterializationDeadlineMs,
    900_000,
  );
  assert.equal(Object.isFrozen(admission.provisioningPolicy.resources), true);
});

test('legacy null validation resources use current fallback without rewriting environment', async () => {
  const row = makeEnvironment({
    id: ENV_A,
    status: 'ready',
    source: { kind: 'boxlite-image', image: 'cap/boxlite@sha256:legacy' },
    resources: null,
    providerFamilies: ['boxlite'],
    runtimeIds: ['codex'],
    lastValidationId: VALIDATION_A,
  });
  const { service, validations } = buildService([row]);
  validations.push({
    id: VALIDATION_A,
    environmentId: ENV_A,
    status: 'passed',
    providerFamily: 'boxlite',
    runtimeId: 'codex',
    sourceKind: 'boxlite-image',
    resolvedLocator: 'cap/boxlite@sha256:legacy',
    resolvedDigest: 'sha256:legacy',
    resolvedChecksum: null,
    resourceSnapshot: null,
    sandboxMetadata: null,
    probes: [],
    error: null,
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    checkedAt: new Date('2026-07-14T00:00:00.000Z'),
  });

  await withBoxLiteDeployment(12, async () => {
    assert.deepEqual(
      await service.resolveProvisioningResourcesForTask({
        selection: { kind: 'managed', environmentId: ENV_A },
        runtimeId: 'codex',
        providerFamily: 'boxlite',
      }),
      { diskSizeGb: 12 },
    );
  });
  assert.equal(row.resources, null);
});

test('immutable managed resolution joins passed validation and canonicalizes digest source', async () => {
  const { service, validations } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      isDefault: true,
      source: { kind: 'aio-docker-image', image: 'registry.example/cap/aio:mutable' },
      providerFamilies: ['aio'],
      runtimeIds: ['codex'],
      lastValidationId: VALIDATION_A,
    }),
  ]);
  validations.push({
    id: VALIDATION_A,
    environmentId: ENV_A,
    status: 'passed',
    providerFamily: 'aio',
    runtimeId: 'codex',
    sourceKind: 'aio-docker-image',
    resolvedLocator: 'registry.example/cap/aio:mutable@sha256:resolved-image',
    resolvedDigest: 'sha256:resolved-image',
    resolvedChecksum: null,
    cliArtifactChecksum: `sha256:${'a'.repeat(64)}`,
    sandboxMetadata: {
      schemaVersion: 1,
      sandboxVersion: '1.2.3',
      dependencies: { codex: '0.144.1' },
    },
    probes: [],
    error: null,
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    checkedAt: new Date('2026-07-14T00:00:00.000Z'),
  });

  const resolved = await service.resolveImmutableForTask({
    selection: { kind: 'managed', environmentId: ENV_A },
    runtimeId: 'codex',
    providerFamily: 'aio',
  });
  assert.equal(
    resolved?.sourceRef,
    'registry.example/cap/aio:mutable@sha256:resolved-image',
  );
  assert.equal(resolved?.digest, 'sha256:resolved-image');
  assert.deepEqual(resolved?.metadata?.sandboxMetadata, {
    schemaVersion: 1,
    sandboxVersion: '1.2.3',
    dependencies: { codex: '0.144.1' },
  });
});

test('immutable managed resolution follows lastValidationId instead of a newer unrelated row', async () => {
  const pinnedValidationId = '00000000-0000-4000-a000-000000000402';
  const newerValidationId = '00000000-0000-4000-a000-000000000403';
  const { service, validations } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      source: { kind: 'aio-docker-image', image: 'registry.example/cap/aio:mutable' },
      providerFamilies: ['aio'],
      runtimeIds: ['codex'],
      lastValidationId: pinnedValidationId,
    }),
  ]);
  const metadata = {
    schemaVersion: 1,
    sandboxVersion: '1.2.3',
    dependencies: { codex: '0.144.1' },
  };
  validations.push(
    {
      id: pinnedValidationId,
      environmentId: ENV_A,
      status: 'passed',
      providerFamily: 'aio',
      runtimeId: 'codex',
      sourceKind: 'aio-docker-image',
      resolvedLocator: 'sha256:pinned-image',
      resolvedDigest: 'sha256:pinned-image',
      resolvedChecksum: null,
      cliArtifactChecksum: `sha256:${'b'.repeat(64)}`,
      sandboxMetadata: metadata,
      probes: [],
      error: null,
      contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
      checkedAt: new Date('2026-07-14T00:00:00.000Z'),
    },
    {
      id: newerValidationId,
      environmentId: ENV_A,
      status: 'passed',
      providerFamily: 'aio',
      runtimeId: 'codex',
      sourceKind: 'aio-docker-image',
      resolvedLocator: 'sha256:newer-but-unpinned-image',
      resolvedDigest: 'sha256:newer-but-unpinned-image',
      resolvedChecksum: null,
      cliArtifactChecksum: `sha256:${'c'.repeat(64)}`,
      sandboxMetadata: metadata,
      probes: [],
      error: null,
      contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
      checkedAt: new Date('2026-07-14T01:00:00.000Z'),
    },
  );

  const resolved = await service.resolveImmutableForTask({
    selection: { kind: 'managed', environmentId: ENV_A },
    runtimeId: 'codex',
    providerFamily: 'aio',
  });

  assert.equal(resolved?.digest, 'sha256:pinned-image');
  assert.equal(
    resolved?.sourceRef,
    'sha256:pinned-image',
  );
});

test('one immutable validation carries distinct CLI artifacts for both supported runtimes', async () => {
  const { service, validations } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      source: { kind: 'aio-docker-image', image: 'registry.example/cap/aio:mutable' },
      providerFamilies: ['aio'],
      runtimeIds: [],
      lastValidationId: VALIDATION_A,
    }),
  ]);
  const codexChecksum = `sha256:${'a'.repeat(64)}`;
  const claudeChecksum = `sha256:${'b'.repeat(64)}`;
  validations.push({
    id: VALIDATION_A,
    environmentId: ENV_A,
    status: 'passed',
    providerFamily: 'aio',
    runtimeId: null,
    sourceKind: 'aio-docker-image',
    resolvedLocator: 'sha256:multi-runtime-image',
    resolvedDigest: 'sha256:multi-runtime-image',
    resolvedChecksum: null,
    runtimeArtifactChecksums: {
      codex: codexChecksum,
      'claude-code': claudeChecksum,
    },
    cliArtifactChecksum: null,
    sandboxMetadata: {
      schemaVersion: 1,
      sandboxVersion: '1.2.3',
      dependencies: { codex: '0.144.1', 'claude-code': '2.1.207' },
    },
    probes: [],
    error: null,
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    checkedAt: new Date('2026-07-14T00:00:00.000Z'),
  });

  const codex = await service.resolveImmutableForTask({
    selection: { kind: 'managed', environmentId: ENV_A },
    runtimeId: 'codex',
    providerFamily: 'aio',
  });
  const claude = await service.resolveImmutableForTask({
    selection: { kind: 'managed', environmentId: ENV_A },
    runtimeId: 'claude-code',
    providerFamily: 'aio',
  });

  assert.equal(codex?.cliArtifactChecksum, codexChecksum);
  assert.equal(claude?.cliArtifactChecksum, claudeChecksum);
  assert.deepEqual(codex?.runtimeArtifactChecksums, {
    codex: codexChecksum,
    'claude-code': claudeChecksum,
  });
});

test('immutable resolution fails closed for stale or identity-less validation', async () => {
  const { service, validations } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      source: { kind: 'boxlite-image', image: 'cap/boxlite:mutable' },
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      lastValidationId: VALIDATION_A,
    }),
  ]);
  validations.push({
    id: VALIDATION_A,
    environmentId: ENV_A,
    status: 'passed',
    providerFamily: 'boxlite',
    runtimeId: 'codex',
    sourceKind: 'boxlite-image',
    resolvedLocator: 'cap/boxlite@sha256:unresolved',
    resolvedDigest: null,
    resolvedChecksum: null,
    cliArtifactChecksum: `sha256:${'d'.repeat(64)}`,
    sandboxMetadata: {
      schemaVersion: 1,
      sandboxVersion: '1.2.3',
      dependencies: { codex: '0.144.1' },
    },
    probes: [],
    error: null,
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    checkedAt: new Date('2026-07-14T00:00:00.000Z'),
  });

  await assert.rejects(
    () =>
      service.resolveImmutableForTask({
        selection: { kind: 'managed', environmentId: ENV_A },
        runtimeId: 'codex',
        providerFamily: 'boxlite',
      }),
    (error: unknown) => {
      if (!(error instanceof BadRequestException)) return false;
      const response = error.getResponse();
      return (
        typeof response === 'object' &&
        response !== null &&
        'error' in response &&
        response.error === 'sandbox_environment_immutable_identity_unavailable'
      );
    },
  );
});

test('resolveImageParameterProfileForTask returns selected image params without exposing them in metadata', async () => {
  const { service } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      isDefault: true,
      source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      envVars: { GCODE_API_BASE_URL: 'https://code.example/api/v5' },
      secretEnvVars: { GCODE_TOKEN: encryptForTest('gcode-secret') },
      lastValidationId: VALIDATION_A,
    }),
  ]);

  const resolved = await service.resolveForTask({
    requestedEnvironmentId: null,
    runtimeId: 'codex',
    providerFamily: 'boxlite',
  });
  assert.equal(JSON.stringify(resolved).includes('gcode-secret'), false);

  assert.deepEqual(
    await service.resolveImageParameterProfileForTask({
      requestedEnvironmentId: null,
      runtimeId: 'codex',
      providerFamily: 'boxlite',
    }),
    {
      parameters: [
        {
          name: 'GCODE_API_BASE_URL',
          value: 'https://code.example/api/v5',
          secret: false,
        },
        { name: 'GCODE_TOKEN', value: 'gcode-secret', secret: true },
      ],
    },
  );
});

test('task selection and image parameter lookup reject non-current contracts', async () => {
  const { service } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      isDefault: true,
      contractVersion: 'sandbox-environment-v1',
      source: { kind: 'boxlite-image', image: 'cap/boxlite:legacy' },
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      envVars: { LEGACY_VALUE: 'must-not-be-used' },
      lastValidationId: VALIDATION_A,
    }),
    makeEnvironment({
      id: ENV_B,
      status: 'ready',
      isDefault: true,
      contractVersion: null,
      source: { kind: 'boxlite-image', image: 'cap/boxlite:no-contract' },
      providerFamilies: ['boxlite'],
      runtimeIds: ['codex'],
      envVars: { LEGACY_VALUE: 'must-also-not-be-used' },
      lastValidationId: VALIDATION_A,
    }),
  ]);

  assert.equal(
    await service.resolveForTask({
      requestedEnvironmentId: null,
      runtimeId: 'codex',
      providerFamily: 'boxlite',
    }),
    null,
  );
  assert.equal(
    await service.resolveImageParameterProfileForTask({
      requestedEnvironmentId: null,
      runtimeId: 'codex',
      providerFamily: 'boxlite',
    }),
    null,
  );

  for (const environmentId of [ENV_A, ENV_B]) {
    for (const resolve of [
      () =>
        service.resolveForTask({
          requestedEnvironmentId: environmentId,
          runtimeId: 'codex',
          providerFamily: 'boxlite',
        }),
      () =>
        service.resolveImageParameterProfileForTask({
          requestedEnvironmentId: environmentId,
          runtimeId: 'codex',
          providerFamily: 'boxlite',
        }),
    ]) {
      await assert.rejects(resolve, (error: unknown) => {
        if (!(error instanceof BadRequestException)) return false;
        const response = error.getResponse();
        return (
          typeof response === 'object' &&
          response !== null &&
          'error' in response &&
          response.error === 'sandbox_environment_contract_stale'
        );
      });
    }
  }
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
    sandboxMetadata: null,
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

test('v2 contract marks v1 ready environments stale and preserves current or draft rows', async () => {
  assert.equal(SANDBOX_ENVIRONMENT_CONTRACT_VERSION, 'sandbox-environment-v2');
  const { service, rows } = buildService([
    makeEnvironment({
      id: ENV_A,
      status: 'ready',
      contractVersion: 'sandbox-environment-v1',
    }),
    makeEnvironment({
      id: ENV_B,
      status: 'ready',
      contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    }),
    makeEnvironment({
      id: ENV_C,
      status: 'ready',
      contractVersion: null,
    }),
    makeEnvironment({
      id: ENV_D,
      status: 'draft',
      contractVersion: 'sandbox-environment-v1',
    }),
  ]);

  const count = await service.markCustomEnvironmentsStale(
    SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
  );

  assert.equal(count, 2);
  assert.equal(rows.find((row) => row.id === ENV_A)?.status, 'stale');
  assert.equal(rows.find((row) => row.id === ENV_B)?.status, 'ready');
  assert.equal(rows.find((row) => row.id === ENV_C)?.status, 'stale');
  assert.equal(rows.find((row) => row.id === ENV_D)?.status, 'draft');
});
