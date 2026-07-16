import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    if (expected && typeof expected === 'object' && 'in' in expected) {
      if (!expected.in.includes(run[key])) return false;
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

const { outDir, compiled } = compileService();

try {
  const { SandboxRunOwnerService } = await import(pathToFileURL(compiled).href);

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
    assert.equal(
      await service.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
      true,
    );
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
