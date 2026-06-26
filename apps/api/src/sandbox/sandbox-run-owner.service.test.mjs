import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import 'reflect-metadata';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);

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
    return run && args.select?.id ? { id: run.id } : run;
  }

  async create({ data }) {
    const now = new Date(1_700_000_000_000 + this.next);
    const run = {
      id: `run-${this.next++}`,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
      removedAt: null,
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
      metadata: { image: 'codex-boxlite' },
    });

    const owner = await service.getSandboxRunOwner('task-1');
    assert.equal(owner.providerId, 'boxlite');
    assert.equal(owner.providerSandboxId, 'box-1');
    assert.equal(owner.connection.baseUrl, 'https://boxlite.test/box-1');
    assert.deepEqual(owner.metadata, { image: 'codex-boxlite' });
  });

  await test('recording the same provider sandbox updates instead of duplicating', async () => {
    const delegate = new FakeSandboxRunDelegate();
    const service = new SandboxRunOwnerService({ sandboxRun: delegate });

    await service.recordSandboxRunOwner({
      taskId: 'task-1',
      providerId: 'boxlite',
      providerSandboxId: 'box-1',
      metadata: { image: 'old' },
    });
    await service.recordSandboxRunOwner({
      taskId: 'task-1',
      providerId: 'boxlite',
      providerSandboxId: 'box-1',
      metadata: { image: 'new' },
    });

    assert.equal(delegate.runs.length, 1);
    assert.deepEqual((await service.getSandboxRunOwner('task-1')).metadata, {
      image: 'new',
    });
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
