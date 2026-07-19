import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import 'reflect-metadata';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);
const SANDBOX_METADATA = Object.freeze({
  schemaVersion: 1,
  sandboxVersion: '0.33.0',
  dependencies: Object.freeze({ codex: '0.131.0' }),
});

function findRepoRoot(start) {
  let current = start;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  throw new Error(`Could not locate repo root from ${start}`);
}

function findFile(root, fileName) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, fileName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === fileName) {
      return full;
    }
  }
  return null;
}

function compileService() {
  const apiRoot = join(repoRoot, 'apps', 'api');
  const cacheDir = join(apiRoot, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const outDir = mkdtempSync(join(cacheDir, 'cap-sandbox-run-owner-'));
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsc',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--experimentalDecorators',
      '--emitDecoratorMetadata',
      '--skipLibCheck',
      '--types',
      'node',
      '--outDir',
      outDir,
      'src/sandbox/sandbox-run-owner.service.ts',
      'src/prisma/prisma.service.ts',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const compiled = findFile(outDir, 'sandbox-run-owner.service.js');
  assert(compiled && existsSync(compiled), 'compiled sandbox-run-owner.service.js exists');
  return { outDir, compiled };
}

class FakeSandboxRunDelegate {
  runs = [];
  next = 1;

  async findFirst(args) {
    const filtered = this.runs
      .filter((run) => matchesWhere(run, args.where ?? {}))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const run = filtered[0] ?? null;
    if (!run || !args.select) return run;
    return Object.fromEntries(
      Object.entries(args.select)
        .filter(([, selected]) => selected)
        .map(([field]) => [field, run[field]]),
    );
  }

  async findMany(args) {
    let filtered = this.runs.filter((run) => matchesWhere(run, args.where ?? {}));
    if (args.orderBy?.createdAt === 'asc') {
      filtered = [...filtered].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }
    return filtered;
  }

  async create({ data }) {
    const now = new Date(1_700_000_000_000 + this.next);
    const run = {
      id: `run-${this.next++}`,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
      removedAt: null,
      ownerGeneration: null,
      resourceGeneration: null,
      cleanupAttemptInFlight: false,
      cleanupAttemptCount: 0,
      cleanupLastAttemptId: null,
      cleanupLastOutcome: null,
      cleanupLastProof: null,
      cleanupLastCause: null,
      cleanupLastRetryable: null,
      cleanupLastObservedAt: null,
      cleanupOrphanConfirmedAt: null,
      ...data,
    };
    this.runs.push(run);
    return run;
  }

  async update({ where, data }) {
    const run = this.runs.find((entry) => entry.id === where.id);
    if (!run) throw new Error(`missing run ${where.id}`);
    Object.assign(run, data, { updatedAt: new Date(run.updatedAt.getTime() + 1) });
    return run;
  }

  async updateMany({ where, data }) {
    let count = 0;
    for (const run of this.runs) {
      if (!matchesWhere(run, where ?? {})) continue;
      Object.assign(run, data, { updatedAt: new Date(run.updatedAt.getTime() + 1) });
      count += 1;
    }
    return { count };
  }
}

function matchesWhere(run, where) {
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR' && Array.isArray(expected)) {
      if (!expected.some((branch) => matchesWhere(run, branch))) return false;
    } else if (expected && typeof expected === 'object' && 'in' in expected) {
      if (!expected.in.includes(run[key])) return false;
    } else if (expected && typeof expected === 'object' && 'gt' in expected) {
      if (!(run[key] > expected.gt)) return false;
    } else if (run[key] !== expected) {
      return false;
    }
  }
  return true;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

async function settleConfirmedCleanup(
  service,
  authorization,
  { attemptId = randomUUID(), proof = 'already-absent' } = {},
) {
  const allocated = await service.beginSandboxRunCleanupAttempt(
    authorization,
    attemptId,
  );
  assert.equal(allocated.kind, 'allocated');
  const evidence = {
    attemptId,
    attempt: allocated.evidence.attempt,
    outcome: 'succeeded',
    proof,
    cause: null,
    retryable: false,
    observedAt: new Date('2026-07-17T10:00:00.000Z'),
  };
  assert.deepEqual(
    await service.settleSandboxRunCleanupAttempt(authorization, evidence),
    { kind: 'recorded' },
  );
  return evidence;
}

const { outDir, compiled } = compileService();

try {
  const { SandboxRunOwnerService } = await import(pathToFileURL(compiled).href);

  await test('transaction owner locks discard the PostgreSQL void result before writing', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const operations = [];
    const findFirst = delegate.findFirst.bind(delegate);
    const create = delegate.create.bind(delegate);
    delegate.findFirst = async (args) => {
      operations.push('find-first');
      return findFirst(args);
    };
    delegate.create = async (args) => {
      operations.push('create');
      return create(args);
    };
    const transactionClient = {
      sandboxRun: delegate,
      $executeRaw: async () => {
        operations.push('lock');
        return 1;
      },
      $queryRaw: async () => {
        throw new Error('PostgreSQL void results must not be deserialized');
      },
    };
    const service = new SandboxRunOwnerService({
      sandboxRun: delegate,
      $transaction: async (operation) => operation(transactionClient),
    });

    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-advisory-lock',
        providerId: 'boxlite',
      }),
      true,
    );
    assert.deepEqual(operations, ['lock', 'find-first', 'create']);
    assert.equal(delegate.runs.length, 1);
    assert.equal(delegate.runs[0].taskId, 'task-advisory-lock');
    assert.equal(delegate.runs[0].createState, 'entered');
  });

  await test('a rejected transaction owner lock never reaches the owner delegate', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({
      sandboxRun: delegate,
      $transaction: async (operation) =>
        operation({
          sandboxRun: delegate,
          $executeRaw: async () => {
            throw new Error('lock unavailable');
          },
        }),
    });

    await assert.rejects(
      service.beginSandboxRunCreate({
        taskId: 'task-advisory-lock-rejected',
        providerId: 'boxlite',
      }),
      /lock unavailable/,
    );
    assert.equal(delegate.runs.length, 0);
  });

  await test('owner store records and resolves the active provider owner', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    assert.equal(await service.getSandboxRunOwner('task-1'), null);

    await service.recordSandboxRunOwner({
      taskId: 'task-1',
      providerId: 'boxlite',
      providerSandboxId: 'box-1',
      connection: {
        taskId: 'task-1',
        baseUrl: 'https://boxlite.test/box-1',
        wsUrl: 'wss://boxlite.test/box-1/ws',
      },
      metadata: {
        sandboxMetadata: SANDBOX_METADATA,
        providerPrivateField: 'discarded',
      },
    });

    const owner = await service.getSandboxRunOwner('task-1');
    assert.equal(owner.providerId, 'boxlite');
    assert.equal(owner.providerSandboxId, 'box-1');
    assert.equal(owner.connection.baseUrl, 'https://boxlite.test/box-1');
    assert.deepEqual(owner.metadata, { sandboxMetadata: SANDBOX_METADATA });
  });

  await test('logical connection task ids are never inferred as physical sandbox ids', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    await service.recordSandboxRunOwner({
      taskId: 'task-logical-only',
      providerId: 'boxlite',
      connection: {
        taskId: 'task-logical-only',
        baseUrl: 'https://boxlite.test/logical-only',
        wsUrl: 'wss://boxlite.test/logical-only/ws',
      },
    });

    const owner = await service.getSandboxRunOwner('task-logical-only');
    assert.equal(owner.providerSandboxId, undefined);
    assert.equal(delegate.runs[0].providerSandboxId ?? null, null);
    assert.equal(owner.connection.taskId, 'task-logical-only');
  });

  await test('recording the same provider sandbox updates instead of duplicating', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });

    await service.recordSandboxRunOwner({
      taskId: 'task-1',
      providerId: 'boxlite',
      providerSandboxId: 'box-1',
      metadata: {
        sandboxMetadata: {
          ...SANDBOX_METADATA,
          sandboxVersion: '0.32.0',
        },
      },
    });
    await service.recordSandboxRunOwner({
      taskId: 'task-1',
      providerId: 'boxlite',
      providerSandboxId: 'box-1',
      metadata: { sandboxMetadata: SANDBOX_METADATA },
    });

    assert.equal(delegate.runs.length, 1);
    assert.deepEqual((await service.getSandboxRunOwner('task-1')).metadata, {
      sandboxMetadata: SANDBOX_METADATA,
    });
  });

  await test('new owner writes project connection and run metadata through a non-secret allowlist', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const canary = 'CAP_RUN_METADATA_SECRET_CANARY_8_5';

    await service.recordSandboxRunOwner({
      taskId: 'task-secret-projection',
      providerId: 'boxlite',
      providerSandboxId: 'box-secret-projection',
      connection: {
        taskId: 'task-secret-projection',
        baseUrl: 'https://boxlite.test/secret-projection',
        wsUrl: 'wss://boxlite.test/secret-projection/ws',
        token: canary,
      },
      metadata: {
        sandboxMetadata: SANDBOX_METADATA,
        debug: { token: canary },
        environment: { password: canary },
      },
      environment: {
        id: 'environment-secret-projection',
        providerId: 'boxlite',
        providerFamily: 'boxlite',
        runtimeId: 'codex',
        resources: { diskSizeGb: 12 },
        runtimeArtifactChecksums: {
          codex: `sha256:${'a'.repeat(64)}`,
        },
        metadata: {
          immutableIdentity: `sha256:${'b'.repeat(64)}`,
          sandboxMetadata: SANDBOX_METADATA,
          token: canary,
        },
        providerPrivateField: canary,
      },
    });

    const serialized = JSON.stringify(delegate.runs);
    assert.equal(serialized.includes(canary), false);
    assert.deepEqual(delegate.runs[0].connectionJson, {
      taskId: 'task-secret-projection',
      baseUrl: 'https://boxlite.test/secret-projection',
      wsUrl: 'wss://boxlite.test/secret-projection/ws',
    });
    assert.deepEqual(delegate.runs[0].metadata, {
      sandboxMetadata: SANDBOX_METADATA,
      environment: {
        id: 'environment-secret-projection',
        providerId: 'boxlite',
        providerFamily: 'boxlite',
        runtimeId: 'codex',
        runtimeArtifactChecksums: {
          codex: `sha256:${'a'.repeat(64)}`,
        },
        resources: { diskSizeGb: 12 },
        metadata: {
          immutableIdentity: `sha256:${'b'.repeat(64)}`,
          sandboxMetadata: SANDBOX_METADATA,
        },
      },
    });
  });

  await test('legacy owner reads project persisted connection and metadata through the same allowlist', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const canary = 'CAP_LEGACY_RUN_SECRET_CANARY_8_5';

    await delegate.create({
      data: {
        taskId: 'task-legacy-secret-projection',
        providerId: 'boxlite',
        providerSandboxId: 'box-legacy-secret-projection',
        status: 'running',
        createState: 'idle',
        connectionJson: {
          taskId: 'task-legacy-secret-projection',
          baseUrl: 'https://boxlite.test/legacy-secret-projection',
          wsUrl: 'wss://boxlite.test/legacy-secret-projection/ws',
          token: canary,
        },
        metadata: {
          sandboxMetadata: SANDBOX_METADATA,
          token: canary,
          environment: {
            id: 'environment-legacy-secret-projection',
            providerId: 'boxlite',
            runtimeId: 'codex',
            token: canary,
            metadata: {
              immutableIdentity: `sha256:${'c'.repeat(64)}`,
              token: canary,
            },
          },
        },
      },
    });

    const owner = await service.getSandboxRunOwner(
      'task-legacy-secret-projection',
    );
    assert(owner);
    assert.equal(JSON.stringify(owner).includes(canary), false);
    assert.deepEqual(owner.connection, {
      taskId: 'task-legacy-secret-projection',
      baseUrl: 'https://boxlite.test/legacy-secret-projection',
      wsUrl: 'wss://boxlite.test/legacy-secret-projection/ws',
    });
    assert.deepEqual(owner.metadata, {
      sandboxMetadata: SANDBOX_METADATA,
      environment: {
        id: 'environment-legacy-secret-projection',
        providerId: 'boxlite',
        runtimeId: 'codex',
        metadata: {
          immutableIdentity: `sha256:${'c'.repeat(64)}`,
        },
      },
    });
  });

  await test('recording a different active provider sandbox fails closed', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });

    await service.recordSandboxRunOwner({
      taskId: 'task-1',
      providerId: 'boxlite',
      providerSandboxId: 'box-1',
    });

    await assert.rejects(
      service.recordSandboxRunOwner({
        taskId: 'task-1',
        providerId: 'boxlite',
        providerSandboxId: 'box-2',
      }),
      /different active sandbox owner/,
    );
    assert.equal(delegate.runs.length, 1);
    assert.equal(delegate.runs[0].providerSandboxId, 'box-1');
  });

  await test('owner generation transfer preserves the physical resource and fences stale cleanup', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });

    assert.deepEqual(
      await service.acquireSandboxRunOwner({
        taskId: 'task-generation',
        providerId: 'boxlite',
        ownerGeneration: 'owner:g1',
        proposedResourceGeneration: 'resource:r1',
      }),
      {
        kind: 'acquired',
        ownership: {
          ownerGeneration: 'owner:g1',
          resourceGeneration: 'resource:r1',
        },
      },
    );
    const transferred = await service.acquireSandboxRunOwner({
      taskId: 'task-generation',
      providerId: 'boxlite',
      ownerGeneration: 'owner:g2',
      proposedResourceGeneration: 'resource:r2-proposal',
    });
    assert.equal(transferred.kind, 'acquired');
    assert.deepEqual(transferred.ownership, {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:r1',
    });
    assert.equal(
      (await service.beginSandboxRunCleanup('task-generation', {
        ownerGeneration: 'owner:g1',
        resourceGeneration: 'resource:r1',
      })).kind,
      'stale',
    );
    await service.recordSandboxRunOwner({
      taskId: 'task-generation',
      providerId: 'boxlite',
      providerSandboxId: 'box-generation',
      ownership: transferred.ownership,
      status: 'running',
    });
    assert.equal((await service.getSandboxRunOwner('task-generation')).status, 'running');
  });

  await test('a new provisioning owner preserves the exact readoption target without treating it as create state', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const first = await service.acquireSandboxRunOwner({
      taskId: 'task-clear-observation',
      providerId: 'boxlite',
      ownerGeneration: 'owner:g1',
      proposedResourceGeneration: 'resource:r1',
    });
    await service.recordSandboxRunOwner({
      taskId: 'task-clear-observation',
      providerId: 'boxlite',
      providerSandboxId: 'sandbox-r1',
      ownership: first.ownership,
      status: 'running',
      connection: {
        taskId: 'task-clear-observation',
        baseUrl: 'https://boxlite.test/r1',
        wsUrl: 'wss://boxlite.test/r1/ws',
      },
    });

    const transferred = await service.acquireSandboxRunOwner({
      taskId: 'task-clear-observation',
      providerId: 'boxlite',
      ownerGeneration: 'owner:g2',
      proposedResourceGeneration: 'resource:r2-proposal',
    });
    assert.equal(transferred.previousOwner.providerSandboxId, 'sandbox-r1');
    assert.equal(transferred.previousOwner.connection.baseUrl, 'https://boxlite.test/r1');
    const current = await service.getSandboxRunOwner('task-clear-observation');
    assert.equal(current.providerSandboxId, 'sandbox-r1');
    assert.equal(current.connection.baseUrl, 'https://boxlite.test/r1');
    assert.equal(current.createState, 'idle');
    assert.equal(current.status, 'provisioning');
  });

  await test('create entry is exact-owner fenced, survives transfer, and settles with a provider-assigned target', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const first = await service.acquireSandboxRunOwner({
      taskId: 'task-create-state',
      providerId: 'boxlite',
      ownerGeneration: 'owner:g1',
      proposedResourceGeneration: 'resource:r1',
    });
    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-create-state',
        providerId: 'boxlite',
        ownership: first.ownership,
      }),
      true,
    );
    const second = await service.acquireSandboxRunOwner({
      taskId: 'task-create-state',
      providerId: 'boxlite',
      ownerGeneration: 'owner:g2',
      proposedResourceGeneration: 'resource:r2-proposal',
    });
    assert.equal(
      (await service.getSandboxRunOwner('task-create-state')).createState,
      'entered',
    );
    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-create-state',
        providerId: 'boxlite',
        ownership: first.ownership,
      }),
      false,
    );
    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-create-state',
        providerId: 'boxlite',
        ownership: second.ownership,
      }),
      true,
      'the current owner may replay the same resource idempotently',
    );
    assert.equal(
      await service.observeSandboxRunCreate({
        taskId: 'task-create-state',
        providerId: 'boxlite',
        resourceGeneration: second.ownership.resourceGeneration,
        providerSandboxId: 'observed-r1',
      }),
      true,
    );
    assert.equal(
      (await service.getSandboxRunOwner('task-create-state')).createState,
      'idle',
    );
    await service.recordSandboxRunOwner({
      taskId: 'task-create-state',
      providerId: 'boxlite',
      providerSandboxId: 'provider-assigned-r1',
      ownership: second.ownership,
      status: 'running',
      connection: {
        taskId: 'task-create-state',
        baseUrl: 'https://boxlite.test/provider-assigned-r1',
        wsUrl: 'wss://boxlite.test/provider-assigned-r1/ws',
      },
    });
    const settled = await service.getSandboxRunOwner('task-create-state');
    assert.equal(settled.createState, 'idle');
    assert.equal(settled.providerSandboxId, 'provider-assigned-r1');
  });

  await test('ownerless legacy create is pre-registered and promoted only after exact observation', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });

    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-legacy-create-fence',
        providerId: 'boxlite',
      }),
      true,
    );
    assert.equal(delegate.runs.length, 1);
    assert.equal(delegate.runs[0].status, 'provisioning');
    assert.equal(delegate.runs[0].createState, 'entered');
    assert.equal(delegate.runs[0].ownerGeneration, null);
    assert.equal(delegate.runs[0].resourceGeneration, null);
    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-legacy-create-fence',
        providerId: 'boxlite',
      }),
      false,
      'a second replica cannot borrow the first invocation fence',
    );
    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-legacy-create-fence',
        providerId: 'different-provider',
      }),
      false,
    );
    assert.equal(
      await service.validateLegacySandboxRunCreateFence({
        taskId: 'task-legacy-create-fence',
        providerId: 'boxlite',
      }),
      true,
    );
    assert.equal(
      await service.validateLegacySandboxRunCreateFence({
        taskId: 'task-legacy-create-fence',
        providerId: 'different-provider',
      }),
      false,
    );
    await assert.rejects(
      service.recordSandboxRunOwner({
        taskId: 'task-legacy-create-fence',
        providerId: 'boxlite',
        providerSandboxId: 'box-before-observation',
        expectedProvisioningFence: 'legacy-create-observed',
      }),
      /Legacy sandbox provisioning fence is no longer current/,
    );
    assert.equal(
      await service.observeSandboxRunCreate({
        taskId: 'task-legacy-create-fence',
        providerId: 'different-provider',
        providerSandboxId: 'box-wrong',
      }),
      false,
    );
    assert.equal(
      await service.observeSandboxRunCreate({
        taskId: 'task-legacy-create-fence',
        providerId: 'boxlite',
        providerSandboxId: 'box-observed',
      }),
      true,
    );
    await service.recordSandboxRunOwner({
      taskId: 'task-legacy-create-fence',
      providerId: 'boxlite',
      providerSandboxId: 'box-observed',
      expectedProvisioningFence: 'legacy-create-observed',
    });
    assert.equal(delegate.runs.length, 1);
    assert.equal(delegate.runs[0].status, 'running');
    assert.equal(delegate.runs[0].createState, 'idle');
    assert.equal(delegate.runs[0].providerSandboxId, 'box-observed');
  });

  await test('legacy deleting persists a late exact id before cleanup settles and rejects completion', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    await service.beginSandboxRunCreate({
      taskId: 'task-legacy-late-create',
      providerId: 'boxlite',
    });
    const cleanup = await service.beginSandboxRunCleanup(
      'task-legacy-late-create',
    );
    assert.equal(cleanup.kind, 'authorized');

    assert.deepEqual(
      await service.settleLegacySandboxRunCleanup({
        taskId: 'task-legacy-late-create',
        providerId: 'boxlite',
        disposition: 'superseded-remove',
        status: 'removed',
        evidence: {
          attemptId: '11111111-1111-4111-8111-111111111111',
          attempt: 1,
          outcome: 'succeeded',
          proof: 'already-absent',
          cause: null,
          retryable: false,
          observedAt: new Date('2026-07-19T14:00:00.000Z'),
        },
      }),
      { kind: 'conflict' },
    );
    assert.equal(
      await service.observeSandboxRunCreate({
        taskId: 'task-legacy-late-create',
        providerId: 'boxlite',
        providerSandboxId: 'box-late',
      }),
      false,
    );
    assert.equal(delegate.runs[0].status, 'deleting');
    assert.equal(delegate.runs[0].createState, 'idle');
    assert.equal(delegate.runs[0].providerSandboxId, 'box-late');
    const deleting = await service.beginSandboxRunCleanup(
      'task-legacy-late-create',
    );
    assert.equal(deleting.kind, 'authorized');
    const allocated = await service.beginSandboxRunCleanupAttempt(
      deleting.authorization,
      '22222222-2222-4222-8222-222222222222',
    );
    assert.equal(allocated.kind, 'allocated');
    const settled = await service.settleSandboxRunCleanupAttempt(
      deleting.authorization,
      {
        attemptId: allocated.evidence.attemptId,
        attempt: allocated.evidence.attempt,
        outcome: 'succeeded',
        proof: 'found-and-cleaned',
        cause: null,
        retryable: false,
        observedAt: new Date('2026-07-19T14:00:01.000Z'),
      },
    );
    assert.equal(settled.kind, 'recorded');
    assert.equal(
      await service.completeSandboxRunCleanup(
        deleting.authorization,
        'removed',
      ),
      true,
    );
    assert.equal(delegate.runs[0].status, 'removed');
    await assert.rejects(
      service.recordSandboxRunOwner({
        taskId: 'task-legacy-late-create',
        providerId: 'boxlite',
        providerSandboxId: 'box-late',
        expectedProvisioningFence: 'legacy-create-observed',
      }),
      /Legacy sandbox provisioning fence is no longer current/,
    );
    assert.equal(await service.getSandboxRunOwner('task-legacy-late-create'), null);
    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-legacy-late-create',
        providerId: 'boxlite',
      }),
      false,
      'a late boundary cannot create a second row after terminal cleanup',
    );
    assert.equal(delegate.runs.length, 1);
  });

  await test('post-invocation absence closes only the matching deleting legacy create fence', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    await service.beginSandboxRunCreate({
      taskId: 'task-legacy-close-create-fence',
      providerId: 'boxlite',
    });
    const cleanup = await service.beginSandboxRunCleanup(
      'task-legacy-close-create-fence',
    );
    assert.equal(cleanup.kind, 'authorized');
    assert.equal(
      await service.validateLegacySandboxRunCreateFence({
        taskId: 'task-legacy-close-create-fence',
        providerId: 'boxlite',
      }),
      false,
      'the terminal deleting fence prevents a later physical create',
    );

    assert.equal(
      await service.closeLegacySandboxRunCreateFence({
        taskId: 'task-legacy-close-create-fence',
        providerId: 'different-provider',
      }),
      false,
    );
    assert.equal(delegate.runs[0].createState, 'entered');
    assert.equal(
      await service.closeLegacySandboxRunCreateFence({
        taskId: 'task-legacy-close-create-fence',
        providerId: 'boxlite',
      }),
      true,
    );
    assert.equal(delegate.runs[0].createState, 'idle');
    assert.equal(
      await service.closeLegacySandboxRunCreateFence({
        taskId: 'task-legacy-close-create-fence',
        providerId: 'boxlite',
      }),
      true,
      'the exact close is idempotent',
    );
  });

  await test('cleanup intent blocks takeover until exact generation cleanup completes', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const first = {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    };
    await service.acquireSandboxRunOwner({
      taskId: 'task-cleanup',
      providerId: 'boxlite',
      ownerGeneration: first.ownerGeneration,
      proposedResourceGeneration: first.resourceGeneration,
    });
    const cleanup = await service.beginSandboxRunCleanup('task-cleanup', first);
    assert.equal(cleanup.kind, 'authorized');
    assert.equal(
      (await service.acquireSandboxRunOwner({
        taskId: 'task-cleanup',
        providerId: 'boxlite',
        ownerGeneration: 'owner:g2',
        proposedResourceGeneration: 'resource:r2',
      })).kind,
      'cleanup-required',
    );
    await settleConfirmedCleanup(service, cleanup.authorization);
    assert.equal(
      await service.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
      true,
    );
    const second = await service.acquireSandboxRunOwner({
      taskId: 'task-cleanup',
      providerId: 'boxlite',
      ownerGeneration: 'owner:g2',
      proposedResourceGeneration: 'resource:r2',
    });
    assert.equal(second.kind, 'acquired');
    assert.deepEqual(second.ownership, {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:r2',
    });
  });

  await test('physical cleanup evidence is fenced, replay-idempotent, and never settles deleting authority', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const ownership = {
      ownerGeneration: 'owner:evidence-g1',
      resourceGeneration: 'resource:evidence-r1',
    };
    await service.acquireSandboxRunOwner({
      taskId: 'task-cleanup-evidence',
      providerId: 'boxlite',
      ownerGeneration: ownership.ownerGeneration,
      proposedResourceGeneration: ownership.resourceGeneration,
    });
    const cleanup = await service.beginSandboxRunCleanup(
      'task-cleanup-evidence',
      ownership,
    );
    assert.equal(cleanup.kind, 'authorized');
    assert.equal(
      await service.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
      false,
      'zero physical attempts cannot complete cleanup authority',
    );
    const firstAttemptId = '11111111-1111-4111-8111-111111111111';
    const secondAttemptId = '22222222-2222-4222-8222-222222222222';
    const allocated = await service.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      firstAttemptId,
    );
    assert.equal(allocated.kind, 'allocated');
    assert.equal(allocated.evidence.attempt, 1);
    assert.equal(delegate.runs[0].cleanupAttemptInFlight, true);
    assert.equal(delegate.runs[0].status, 'deleting');
    assert.deepEqual(
      await service.beginSandboxRunCleanupAttempt(
        cleanup.authorization,
        firstAttemptId,
      ),
      { kind: 'replayed', evidence: allocated.evidence },
    );
    assert.equal(
      (await service.beginSandboxRunCleanupAttempt(
        cleanup.authorization,
        secondAttemptId,
      )).kind,
      'in-flight',
    );
    const failedAt = new Date('2026-07-17T09:00:00.000Z');
    const failed = {
      attemptId: firstAttemptId,
      attempt: 1,
      outcome: 'failed',
      proof: null,
      cause: 'cleanup_failed',
      retryable: false,
      observedAt: failedAt,
    };
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(
        cleanup.authorization,
        failed,
      ),
      { kind: 'recorded' },
    );
    assert.equal(delegate.runs[0].status, 'deleting');
    assert.equal(delegate.runs[0].cleanupAttemptInFlight, false);
    assert.equal(delegate.runs[0].cleanupAttemptCount, 1);
    assert.equal(delegate.runs[0].cleanupLastOutcome, 'failed');
    assert.equal(
      await service.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
      false,
      'failed physical evidence cannot complete cleanup authority',
    );
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(
        cleanup.authorization,
        failed,
      ),
      { kind: 'replayed' },
    );
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        ...failed,
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
      }),
      { kind: 'conflict' },
    );
    const second = await service.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      secondAttemptId,
    );
    assert.equal(second.kind, 'allocated');
    assert.equal(second.evidence.attempt, 2);
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        attemptId: secondAttemptId,
        attempt: 2,
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
        observedAt: new Date('2026-07-17T09:01:00.000Z'),
      }),
      { kind: 'recorded' },
    );
    assert.equal(delegate.runs[0].status, 'deleting');
    assert.equal(delegate.runs[0].cleanupAttemptCount, 2);
    assert.equal(
      await service.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
      false,
      'indeterminate physical evidence cannot complete cleanup authority',
    );

    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(
        {
          ...cleanup.authorization,
          ownership: {
            ownerGeneration: ownership.ownerGeneration,
            resourceGeneration: 'resource:other',
          },
        },
        {
          attemptId: '33333333-3333-4333-8333-333333333333',
          attempt: 3,
          outcome: 'succeeded',
          proof: 'already-absent',
          cause: null,
          retryable: false,
          observedAt: new Date('2026-07-17T09:02:00.000Z'),
        },
      ),
      { kind: 'stale' },
    );
    assert.equal(delegate.runs[0].status, 'deleting');
  });

  await test('confirmed cleanup evidence remains secondary until fenced completion', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const acquired = await service.acquireSandboxRunOwner({
      taskId: 'task-confirmed-cleanup-evidence',
      providerId: 'boxlite',
      ownerGeneration: 'owner:confirmed-g1',
      proposedResourceGeneration: 'resource:confirmed-r1',
    });
    const cleanup = await service.beginSandboxRunCleanup(
      'task-confirmed-cleanup-evidence',
      acquired.ownership,
    );
    assert.equal(cleanup.kind, 'authorized');
    const attemptId = '44444444-4444-4444-8444-444444444444';
    const allocated = await service.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      attemptId,
    );
    assert.equal(allocated.kind, 'allocated');
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        attemptId,
        attempt: 1,
        outcome: 'succeeded',
        proof: 'already-absent',
        cause: null,
        retryable: false,
        observedAt: new Date('2026-07-17T09:03:00.000Z'),
      }),
      { kind: 'recorded' },
    );
    assert.equal(delegate.runs[0].status, 'deleting');
    assert.equal(
      await service.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
      true,
    );
    assert.equal(delegate.runs[0].status, 'removed');
  });

  await test('terminal policy failure is exact-owner fenced, replayable, and distinct from absence', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const ownership = {
      ownerGeneration: 'owner:terminal-policy-g1',
      resourceGeneration: 'resource:terminal-policy-r1',
    };
    await service.acquireSandboxRunOwner({
      taskId: 'task-terminal-policy',
      providerId: 'boxlite',
      ownerGeneration: ownership.ownerGeneration,
      proposedResourceGeneration: ownership.resourceGeneration,
    });
    const cleanup = await service.beginSandboxRunCleanup(
      'task-terminal-policy',
      ownership,
    );
    assert.equal(cleanup.kind, 'authorized');
    const allocated = await service.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      '99999999-9999-4999-8999-999999999999',
    );
    assert.equal(allocated.kind, 'allocated');
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        attemptId: allocated.evidence.attemptId,
        attempt: allocated.evidence.attempt,
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
        observedAt: new Date('2026-07-18T00:00:00.000Z'),
      }),
      { kind: 'recorded' },
    );
    const failed = await service.failSandboxRunCleanupByTerminalPolicy(
      cleanup.authorization,
      1,
    );
    assert.equal(failed.kind, 'failed');
    assert.equal(failed.owner.status, 'failed');
    assert.equal(delegate.runs[0].status, 'failed');
    assert.deepEqual(
      await service.failSandboxRunCleanupByTerminalPolicy(
        cleanup.authorization,
        1,
      ),
      { kind: 'replayed', owner: failed.owner },
    );
    assert.equal(
      (await service.claimSandboxRunCleanup(
        'task-terminal-policy',
        'owner:terminal-policy-g2',
      )).kind,
      'settled',
    );
    const authority = await service.getSandboxRunCleanupAuthority(
      'task-terminal-policy',
    );
    assert.equal(authority.state, 'failed');
    assert.equal(authority.ownershipKind, 'generation');
    assert.equal(authority.orphanState, 'unknown');
    assert.equal(authority.status, 'failed');
    assert.equal(authority.attemptCount, 1);
  });

  await test('terminal policy cannot relinquish an owner while create may still return', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const ownership = {
      ownerGeneration: 'owner:terminal-policy-entered-g1',
      resourceGeneration: 'resource:terminal-policy-entered-r1',
    };
    await service.acquireSandboxRunOwner({
      taskId: 'task-terminal-policy-entered',
      providerId: 'boxlite',
      ownerGeneration: ownership.ownerGeneration,
      proposedResourceGeneration: ownership.resourceGeneration,
    });
    assert.equal(
      await service.beginSandboxRunCreate({
        taskId: 'task-terminal-policy-entered',
        providerId: 'boxlite',
        ownership,
      }),
      true,
    );
    const cleanup = await service.beginSandboxRunCleanup(
      'task-terminal-policy-entered',
      ownership,
    );
    assert.equal(cleanup.kind, 'authorized');
    const allocated = await service.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      '88888888-8888-4888-8888-888888888888',
    );
    assert.equal(allocated.kind, 'allocated');
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        attemptId: allocated.evidence.attemptId,
        attempt: allocated.evidence.attempt,
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
        observedAt: new Date('2026-07-18T00:00:30.000Z'),
      }),
      { kind: 'recorded' },
    );
    assert.deepEqual(
      await service.failSandboxRunCleanupByTerminalPolicy(
        cleanup.authorization,
        1,
      ),
      { kind: 'stale' },
    );
    assert.equal(delegate.runs[0].createState, 'entered');
    assert.equal(delegate.runs[0].status, 'deleting');
  });

  await test('fresh exact inventory confirmation derives orphan state and resets for a new incarnation', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const ownership = {
      ownerGeneration: 'owner:confirmed-orphan-g1',
      resourceGeneration: 'resource:confirmed-orphan-r1',
    };
    await service.acquireSandboxRunOwner({
      taskId: 'task-confirmed-orphan',
      providerId: 'boxlite',
      ownerGeneration: ownership.ownerGeneration,
      proposedResourceGeneration: ownership.resourceGeneration,
    });
    await service.recordSandboxRunOwner({
      taskId: 'task-confirmed-orphan',
      providerId: 'boxlite',
      providerSandboxId: 'box-confirmed-orphan-r1',
      ownership,
      status: 'running',
    });
    const cleanup = await service.beginSandboxRunCleanup(
      'task-confirmed-orphan',
      ownership,
    );
    assert.equal(cleanup.kind, 'authorized');
    assert.deepEqual(
      await service.confirmSandboxRunCleanupOrphan({
        taskId: 'task-confirmed-orphan',
        providerId: 'boxlite',
        providerSandboxId: 'box-wrong-incarnation',
      }),
      { kind: 'conflict' },
    );
    assert.equal(
      (await service.getSandboxRunCleanupAuthority('task-confirmed-orphan'))
        .orphanState,
      'unknown',
    );
    const confirmed = await service.confirmSandboxRunCleanupOrphan({
      taskId: 'task-confirmed-orphan',
      providerId: 'boxlite',
      providerSandboxId: 'box-confirmed-orphan-r1',
    });
    assert.equal(confirmed.kind, 'recorded');
    assert(confirmed.owner.cleanupOrphanConfirmedAt instanceof Date);
    const replay = await service.confirmSandboxRunCleanupOrphan({
      taskId: 'task-confirmed-orphan',
      providerId: 'boxlite',
      providerSandboxId: 'box-confirmed-orphan-r1',
    });
    assert.equal(replay.kind, 'replayed');
    assert.equal(
      replay.owner.cleanupOrphanConfirmedAt.getTime(),
      confirmed.owner.cleanupOrphanConfirmedAt.getTime(),
    );
    assert.equal(
      (await service.getSandboxRunCleanupAuthority('task-confirmed-orphan'))
        .orphanState,
      'confirmed',
    );

    const allocated = await service.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      '77777777-7777-4777-8777-777777777777',
    );
    assert.equal(allocated.kind, 'allocated');
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        attemptId: allocated.evidence.attemptId,
        attempt: allocated.evidence.attempt,
        outcome: 'failed',
        proof: null,
        cause: 'cleanup_failed',
        retryable: false,
        observedAt: new Date('2026-07-18T00:02:00.000Z'),
      }),
      { kind: 'recorded' },
    );
    assert.equal(
      (
        await service.failSandboxRunCleanupByTerminalPolicy(
          cleanup.authorization,
          1,
        )
      ).kind,
      'failed',
    );
    const failedAuthority = await service.getSandboxRunCleanupAuthority(
      'task-confirmed-orphan',
    );
    assert.equal(failedAuthority.status, 'failed');
    assert.equal(failedAuthority.orphanState, 'confirmed');

    await service.acquireSandboxRunOwner({
      taskId: 'task-confirmed-orphan',
      providerId: 'boxlite',
      ownerGeneration: 'owner:confirmed-orphan-g2',
      proposedResourceGeneration: 'resource:confirmed-orphan-r2',
    });
    const replacement = await service.getSandboxRunCleanupAuthority(
      'task-confirmed-orphan',
    );
    assert.equal(replacement.status, 'provisioning');
    assert.equal(replacement.orphanState, 'none');
  });

  await test('legacy bounded cleanup evidence settles directly without a deleting row', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    await service.recordSandboxRunOwner({
      taskId: 'task-legacy-bounded',
      providerId: 'aio',
      providerSandboxId: 'legacy-aio-r1',
      status: 'running',
    });
    const evidence = {
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      attempt: 1,
      outcome: 'failed',
      proof: null,
      cause: 'cleanup_failed',
      retryable: false,
      observedAt: new Date('2026-07-18T00:01:00.000Z'),
    };
    assert.deepEqual(
      await service.settleLegacySandboxRunCleanup({
        taskId: 'task-legacy-bounded',
        providerId: 'aio',
        disposition: 'terminal-retain',
        evidence,
        status: 'failed',
      }),
      { kind: 'conflict' },
    );
    const settled = await service.settleLegacySandboxRunCleanup({
      taskId: 'task-legacy-bounded',
      providerId: 'aio',
      disposition: 'terminal-retain',
      evidence,
      status: 'terminal',
    });
    assert.equal(settled.kind, 'recorded');
    assert.equal(delegate.runs[0].status, 'terminal');
    assert.equal(delegate.runs[0].cleanupAttemptInFlight, false);
    assert.equal(delegate.runs[0].cleanupAttemptCount, 1);
    assert.deepEqual(
      await service.settleLegacySandboxRunCleanup({
        taskId: 'task-legacy-bounded',
        providerId: 'aio',
        disposition: 'terminal-retain',
        evidence,
        status: 'terminal',
      }),
      { kind: 'replayed', owner: settled.owner },
    );
    const authority = await service.getSandboxRunCleanupAuthority(
      'task-legacy-bounded',
    );
    assert.equal(authority.state, 'not_required');
    assert.equal(authority.ownershipKind, 'legacy');
    assert.equal(authority.orphanState, 'none');
    assert.equal(authority.lastAttemptOutcome, 'failed');

    await service.recordSandboxRunOwner({
      taskId: 'task-legacy-retained-success',
      providerId: 'aio',
      providerSandboxId: 'legacy-aio-retained-r1',
      status: 'running',
    });
    const retainedEvidence = {
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attempt: 1,
      outcome: 'succeeded',
      proof: 'found-and-cleaned',
      cause: null,
      retryable: false,
      observedAt: new Date('2026-07-18T00:02:00.000Z'),
    };
    assert.deepEqual(
      await service.settleLegacySandboxRunCleanup({
        taskId: 'task-legacy-retained-success',
        providerId: 'aio',
        disposition: 'terminal-retain',
        evidence: retainedEvidence,
        status: 'removed',
      }),
      { kind: 'conflict' },
    );
    const retained = await service.settleLegacySandboxRunCleanup({
      taskId: 'task-legacy-retained-success',
      providerId: 'aio',
      disposition: 'terminal-retain',
      evidence: retainedEvidence,
      status: 'terminal',
    });
    assert.equal(retained.kind, 'recorded');
    assert.equal(retained.owner.status, 'terminal');
  });

  await test('cleanup takeover closes a crashed in-flight attempt and rejects its late settle', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const ownership = {
      ownerGeneration: 'owner:crash-g1',
      resourceGeneration: 'resource:crash-r1',
    };
    await service.acquireSandboxRunOwner({
      taskId: 'task-cleanup-crash-takeover',
      providerId: 'boxlite',
      ownerGeneration: ownership.ownerGeneration,
      proposedResourceGeneration: ownership.resourceGeneration,
    });
    const first = await service.beginSandboxRunCleanup(
      'task-cleanup-crash-takeover',
      ownership,
    );
    const firstAttemptId = '55555555-5555-4555-8555-555555555555';
    const allocated = await service.beginSandboxRunCleanupAttempt(
      first.authorization,
      firstAttemptId,
    );
    assert.equal(allocated.kind, 'allocated');
    assert.equal(delegate.runs[0].cleanupAttemptInFlight, true);

    const takeover = await service.claimSandboxRunCleanup(
      'task-cleanup-crash-takeover',
      'owner:crash-g2',
    );
    assert.equal(takeover.kind, 'authorized');
    assert.equal(takeover.owner.cleanupAttemptInFlight, false);
    assert.equal(takeover.owner.cleanupLastOutcome, 'indeterminate');
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(first.authorization, {
        attemptId: firstAttemptId,
        attempt: 1,
        outcome: 'succeeded',
        proof: 'found-and-cleaned',
        cause: null,
        retryable: false,
        observedAt: new Date('2026-07-17T09:04:00.000Z'),
      }),
      { kind: 'stale' },
    );

    const retryAttemptId = '66666666-6666-4666-8666-666666666666';
    const retry = await service.beginSandboxRunCleanupAttempt(
      takeover.authorization,
      retryAttemptId,
    );
    assert.equal(retry.kind, 'allocated');
    assert.equal(retry.evidence.attempt, 2);
    const sameOwnerClaim = await service.claimSandboxRunCleanup(
      'task-cleanup-crash-takeover',
      'owner:crash-g2',
    );
    assert.equal(sameOwnerClaim.owner.cleanupAttemptInFlight, true);
    assert.equal(
      (await service.beginSandboxRunCleanupAttempt(
        takeover.authorization,
        '77777777-7777-4777-8777-777777777777',
      )).kind,
      'in-flight',
    );
  });

  await test('cleanup completion is store-fenced while a create may still return', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const acquired = await service.acquireSandboxRunOwner({
      taskId: 'task-entered-completion',
      providerId: 'boxlite',
      ownerGeneration: 'owner:g1',
      proposedResourceGeneration: 'resource:r1',
    });
    await service.beginSandboxRunCreate({
      taskId: 'task-entered-completion',
      providerId: 'boxlite',
      ownership: acquired.ownership,
    });
    const cleanup = await service.claimSandboxRunCleanup(
      'task-entered-completion',
      'owner:g2',
    );
    const firstAttempt = await service.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      '88888888-8888-4888-8888-888888888888',
    );
    assert.equal(firstAttempt.kind, 'allocated');
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        attemptId: firstAttempt.evidence.attemptId,
        attempt: firstAttempt.evidence.attempt,
        outcome: 'succeeded',
        proof: 'already-absent',
        cause: null,
        retryable: false,
        observedAt: new Date('2026-07-17T10:01:00.000Z'),
      }),
      { kind: 'conflict' },
      'absence observed before create settlement cannot become durable success proof',
    );
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        attemptId: firstAttempt.evidence.attemptId,
        attempt: firstAttempt.evidence.attempt,
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
        observedAt: new Date('2026-07-17T10:01:00.000Z'),
      }),
      { kind: 'recorded' },
    );
    await service.markSandboxRunRemoved('task-entered-completion');
    assert.equal(
      delegate.runs[0].status,
      'deleting',
      'generic status marking cannot bypass an unresolved create fence',
    );
    assert.equal(
      await service.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
      false,
    );
    await service.observeSandboxRunCreate({
      taskId: 'task-entered-completion',
      providerId: 'boxlite',
      resourceGeneration: 'resource:r1',
      providerSandboxId: 'sandbox-r1',
    });
    const secondAttempt = await service.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      '99999999-9999-4999-8999-999999999999',
    );
    assert.equal(secondAttempt.kind, 'allocated');
    assert.equal(secondAttempt.evidence.attempt, 2);
    assert.deepEqual(
      await service.settleSandboxRunCleanupAttempt(cleanup.authorization, {
        attemptId: secondAttempt.evidence.attemptId,
        attempt: secondAttempt.evidence.attempt,
        outcome: 'succeeded',
        proof: 'found-and-cleaned',
        cause: null,
        retryable: false,
        observedAt: new Date('2026-07-17T10:02:00.000Z'),
      }),
      { kind: 'recorded' },
    );
    await service.markSandboxRunRemoved('task-entered-completion');
    assert.equal(delegate.runs[0].status, 'removed');
  });

  await test('terminal cleanup claim transfers a deleting owner and preserves the resource generation', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const first = {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    };
    await service.acquireSandboxRunOwner({
      taskId: 'task-terminal-takeover',
      providerId: 'boxlite',
      ownerGeneration: first.ownerGeneration,
      proposedResourceGeneration: first.resourceGeneration,
    });
    assert.equal(
      (await service.beginSandboxRunCleanup('task-terminal-takeover', first)).kind,
      'authorized',
    );

    const claimed = await service.claimSandboxRunCleanup(
      'task-terminal-takeover',
      'owner:g2',
    );
    assert.equal(claimed.kind, 'authorized');
    assert.deepEqual(claimed.owner.ownership, {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:r1',
    });
    assert.equal(claimed.owner.status, 'deleting');
    assert.equal(
      (await service.beginSandboxRunCleanup('task-terminal-takeover', first)).kind,
      'stale',
    );
    assert.equal(
      (await service.beginSandboxRunCleanup(
        'task-terminal-takeover',
        claimed.owner.ownership,
      )).kind,
      'authorized',
    );
    await settleConfirmedCleanup(service, claimed.authorization);
    const transferred = await service.claimSandboxRunCleanup(
      'task-terminal-takeover',
      'owner:g3',
    );
    assert.equal(transferred.kind, 'authorized');
    assert.equal(
      await service.completeSandboxRunCleanup(
        claimed.authorization,
        'removed',
      ),
      true,
      'physical cleanup completion is resource-scoped across authority transfer',
    );
  });

  await test('a stale creator joins deleting cleanup only for the same physical generation', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const first = {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    };
    await service.acquireSandboxRunOwner({
      taskId: 'task-late-create',
      providerId: 'boxlite',
      ownerGeneration: first.ownerGeneration,
      proposedResourceGeneration: first.resourceGeneration,
    });
    const claimed = await service.claimSandboxRunCleanup(
      'task-late-create',
      'owner:g2',
    );
    assert.equal(claimed.kind, 'authorized');

    const joined = await service.joinSandboxRunCleanup({
      taskId: 'task-late-create',
      providerId: 'boxlite',
      ownership: first,
    });
    assert.equal(joined.kind, 'authorized');
    assert.deepEqual(joined.authorization, {
      kind: 'generation',
      taskId: 'task-late-create',
      providerId: 'boxlite',
      ownership: {
        ownerGeneration: 'owner:g2',
        resourceGeneration: 'resource:r1',
      },
    });
    assert.equal(
      (await service.joinSandboxRunCleanup({
        taskId: 'task-late-create',
        providerId: 'boxlite',
        ownership: {
          ownerGeneration: 'owner:g1',
          resourceGeneration: 'resource:other',
        },
      })).kind,
      'stale',
    );
    await settleConfirmedCleanup(service, joined.authorization);
    assert.equal(
      await service.completeSandboxRunCleanup(joined.authorization, 'removed'),
      true,
    );
  });

  await test('legacy owners retain NULL generations and use explicit serialized cleanup', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    await service.recordSandboxRunOwner({
      taskId: 'task-legacy',
      providerId: 'boxlite',
      providerSandboxId: 'box-legacy',
    });
    assert.equal(delegate.runs[0].ownerGeneration, null);
    assert.equal(delegate.runs[0].resourceGeneration, null);
    assert.equal(
      (await service.acquireSandboxRunOwner({
        taskId: 'task-legacy',
        providerId: 'boxlite',
        ownerGeneration: 'owner:new',
        proposedResourceGeneration: 'resource:new',
      })).kind,
      'cleanup-required',
    );
    const claimed = await service.claimSandboxRunCleanup(
      'task-legacy',
      'owner:new',
    );
    assert.deepEqual(claimed.authorization, {
      kind: 'legacy',
      taskId: 'task-legacy',
      providerId: 'boxlite',
    });
    assert.equal(delegate.runs[0].status, 'deleting');
    await settleConfirmedCleanup(service, claimed.authorization);
    assert.equal(
      await service.completeSandboxRunCleanup(claimed.authorization, 'removed'),
      true,
    );
  });

  await test('ownerless reattach cannot revive generated or deleting owners', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    const acquired = await service.acquireSandboxRunOwner({
      taskId: 'task-generated',
      providerId: 'boxlite',
      ownerGeneration: 'owner:g1',
      proposedResourceGeneration: 'resource:r1',
    });
    await assert.rejects(
      service.recordSandboxRunOwner({
        taskId: 'task-generated',
        providerId: 'boxlite',
        providerSandboxId: 'box-generated',
      }),
      /Ownerless sandbox records cannot replace a durable owner/,
    );
    await service.beginSandboxRunCleanup(
      'task-generated',
      acquired.ownership,
    );
    await assert.rejects(
      service.recordSandboxRunOwner({
        taskId: 'task-generated',
        providerId: 'boxlite',
        providerSandboxId: 'box-generated',
      }),
      /Ownerless sandbox records cannot replace a durable owner/,
    );
    assert.equal(delegate.runs[0].status, 'deleting');
  });

  await test('removed owners are not returned as active owners', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });

    await service.recordSandboxRunOwner({
      taskId: 'task-1',
      providerId: 'boxlite',
      providerSandboxId: 'box-1',
    });
    await service.markSandboxRunRemoved('task-1');

    assert.equal(await service.getSandboxRunOwner('task-1'), null);
    assert.equal(delegate.runs[0].status, 'removed');
    assert(delegate.runs[0].removedAt instanceof Date);
  });

  await test('cleanup authority distinguishes retained terminal from confirmed removal', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });
    await service.recordSandboxRunOwner({
      taskId: 'task-authority-terminal',
      providerId: 'boxlite',
      providerSandboxId: 'box-authority-terminal',
    });
    await service.markSandboxRunTerminal('task-authority-terminal');
    const retained = await service.getSandboxRunCleanupAuthority(
      'task-authority-terminal',
    );
    assert.equal(retained.status, 'terminal');
    assert.equal(retained.state, 'not_required');
    assert.equal(retained.lastAttemptProof, null);

    await service.recordSandboxRunOwner({
      taskId: 'task-authority-removed',
      providerId: 'boxlite',
      providerSandboxId: 'box-authority-removed',
    });
    await service.markSandboxRunRemoved('task-authority-removed');
    const removed = await service.getSandboxRunCleanupAuthority(
      'task-authority-removed',
    );
    assert.equal(removed.status, 'removed');
    assert.equal(removed.state, 'succeeded');
    assert.equal(removed.lastAttemptProof, null);
  });

  await test('active owner listing returns only resumable provider owners', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });

    await service.recordSandboxRunOwner({
      taskId: 'task-running',
      providerId: 'boxlite',
      providerSandboxId: 'box-running',
    });
    await service.acquireSandboxRunOwner({
      taskId: 'task-provisioning',
      providerId: 'boxlite',
      ownerGeneration: 'owner:provisioning',
      proposedResourceGeneration: 'resource:provisioning',
    });
    await service.recordSandboxRunOwner({
      taskId: 'task-removed',
      providerId: 'boxlite',
      providerSandboxId: 'box-removed',
    });
    await service.markSandboxRunRemoved('task-removed');

    const active = await service.listActiveSandboxRunOwners();
    assert.deepEqual(active.map((owner) => owner.taskId), ['task-running']);
    assert.equal(active[0].providerSandboxId, 'box-running');
  });

  await test('marking a missing owner is idempotent', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });

    await service.markSandboxRunTerminal('missing');
    await service.markSandboxRunRemoved('missing');
    assert.deepEqual(delegate.runs, []);
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
