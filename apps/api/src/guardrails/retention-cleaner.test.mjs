/**
 * Focused unit test for the retention cleaner (session-sandbox-retention,
 * Track 5). Drives the REAL `RetentionCleaner` (compiled with tsc, instantiated
 * directly) against a provider-neutral fake retention store + stub Prisma, with
 * the free-disk reader overridden per case.
 *
 * Covers (task 5.5):
 *   - Policy 1 age-trip removal with the DEFAULT 30-day window
 *   - window resolution from persisted settings (and MAX across accounts)
 *   - Policy 2 low-disk OLDEST-first eviction until free recovers
 *   - the in-process overlap guard skips a re-entrant tick
 *
 * Compiled WITHOUT emitDecoratorMetadata so the type-only PrismaService import
 * elides; @nestjs/common resolves from node_modules.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const cleanerSrc = join(__dirname, 'retention-cleaner.ts');
const storeSrc = join(__dirname, 'sandbox-retention-store.ts');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const outDir = mkdtempSync(join(apiRoot, '.retention-cleaner-test-'));
function compile() {
  execFileSync(tscBin, [
    cleanerSrc,
    storeSrc,
    '--outDir', outDir,
    '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2021',
    '--experimentalDecorators', '--esModuleInterop', '--skipLibCheck',
  ], { cwd: apiRoot, stdio: 'pipe' });
  const cleaner = findFile(outDir, 'retention-cleaner.js');
  const store = findFile(outDir, 'sandbox-retention-store.js');
  if (cleaner && store) return { cleaner, store };
  throw new Error('compiled retention-cleaner.js or sandbox-retention-store.js not found');
}
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

function makeRetentionStore(candidates) {
  const removed = [];
  let listCalls = 0;
  return {
    removed,
    get listCalls() { return listCalls; },
    async listStoppedSandboxes() {
      listCalls += 1;
      return [...candidates].sort((a, b) => a.finishedAtMs - b.finishedAtMs);
    },
    async removeStopped(sandbox) {
      removed.push(sandbox.id);
    },
  };
}

function makePrisma(retentions /* number[] | null */) {
  return {
    accountSettings: {
      async findMany() {
        if (retentions === null) throw new Error('db down');
        return retentions.map((r) => ({ retention: r }));
      },
    },
  };
}

async function main() {
  const compiled = compile();
  const { RetentionCleaner } = await import(pathToFileURL(compiled.cleaner).href);

  // helper: build a cleaner with a fake docker, prisma, fixed free-disk, high floor
  function buildCleaner(store, prisma, { freeBytes = 1000 * GB, floorGb = 10 } = {}) {
    const c = new RetentionCleaner(prisma, store);
    c.diskFloorBytes = floorGb * GB;
    c.getFreeDiskBytes = async () => freeBytes;
    return c;
  }

  // ---- 1) Policy 1 age-trip with DEFAULT 30-day window -----------------------
  {
    const store = makeRetentionStore([
      { id: 'old', name: 'old', finishedAtMs: Date.now() - 40 * DAY },
      { id: 'young', name: 'young', finishedAtMs: Date.now() - 5 * DAY },
    ]);
    const c = buildCleaner(store, makePrisma([])); // no rows → default 30
    await c.sweep();
    assert(store.removed.includes('old'), 'age policy removes a container stopped past the 30-day default');
    assert(!store.removed.includes('young'), 'age policy keeps a container stopped within the window');
  }

  // ---- 2) persisted retention window (MAX across accounts) overrides default --
  {
    const store = makeRetentionStore([{ id: 'old', name: 'old', finishedAtMs: Date.now() - 40 * DAY }]);
    const c = buildCleaner(store, makePrisma([7, 90])); // max 90 days
    await c.sweep();
    assert(!store.removed.includes('old'), 'a 40-day-old container is KEPT when the persisted window is 90 (max across accounts)');
  }

  // ---- 2b) DB unavailable → falls back to the default window -----------------
  {
    const store = makeRetentionStore([{ id: 'old', name: 'old', finishedAtMs: Date.now() - 40 * DAY }]);
    const c = buildCleaner(store, makePrisma(null)); // findMany throws
    await c.sweep();
    assert(store.removed.includes('old'), 'a DB failure degrades to the 30-day default (40-day-old removed)');
  }

  // ---- 3) Policy 2 low-disk OLDEST-first eviction ----------------------------
  {
    // three YOUNG containers (age policy keeps all); disk below floor.
    const store = makeRetentionStore([
      { id: 'mid', name: 'mid', finishedAtMs: Date.now() - 2 * DAY },
      { id: 'oldest', name: 'oldest', finishedAtMs: Date.now() - 3 * DAY },
      { id: 'newest', name: 'newest', finishedAtMs: Date.now() - 1 * DAY },
    ]);
    const c = new RetentionCleaner(makePrisma([]), store);
    c.diskFloorBytes = 10 * GB;
    // free disk: 5GB (below floor) until 2 removed, then 20GB (recovered).
    c.getFreeDiskBytes = async () => (store.removed.length >= 2 ? 20 * GB : 5 * GB);
    await c.sweep();
    assert(store.removed.length === 2, 'disk-pressure eviction stops once free disk recovers above the floor');
    assert(store.removed[0] === 'oldest' && store.removed[1] === 'mid', 'disk-pressure evicts OLDEST-stopped first, then next-oldest');
    assert(!store.removed.includes('newest'), 'the newest stopped container is spared once disk recovers');
  }

  // ---- 3b) disk above floor → Policy 2 evicts nothing ------------------------
  {
    const store = makeRetentionStore([{ id: 'young', name: 'young', finishedAtMs: Date.now() - 1 * DAY }]);
    const c = buildCleaner(store, makePrisma([]), { freeBytes: 500 * GB, floorGb: 10 });
    await c.sweep();
    assert(store.removed.length === 0, 'no eviction when free disk is above the floor and nothing is aged out');
  }

  // ---- 4) cleaner trusts the retention store's stopped-only boundary ----------
  {
    const store = makeRetentionStore([
      { id: 'stopped-old', name: 'stopped-old', finishedAtMs: Date.now() - 99 * DAY },
    ]);
    const c = buildCleaner(store, makePrisma([]));
    await c.sweep();
    assert(store.removed.includes('stopped-old'), 'a stopped sandbox returned by the retention store is reaped');
  }

  // ---- 5) the overlap guard skips a re-entrant tick --------------------------
  {
    const store = makeRetentionStore([{ id: 'old', name: 'old', finishedAtMs: Date.now() - 99 * DAY }]);
    const c = buildCleaner(store, makePrisma([]));
    c.sweeping = true; // simulate a sweep already in flight
    await c.sweep();
    assert(store.listCalls === 0, 'a re-entrant sweep returns immediately without listing/removing anything');
    assert(store.removed.length === 0, 'the overlap guard prevents the re-entrant tick from removing containers');
  }

  // stop the unref'd timers the constructor started
}

let exitCode = 0;
console.log('\n=== retention-cleaner: age + disk-pressure eviction ===\n');
try { await main(); }
catch (err) { console.error('  FAIL  unexpected error'); console.error(err); failed++; }
finally { rmSync(outDir, { recursive: true, force: true }); }
console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) { console.log('ALL TESTS PASSED'); exitCode = 0; }
else { console.error('SOME TESTS FAILED'); exitCode = 1; }
process.exit(exitCode);
