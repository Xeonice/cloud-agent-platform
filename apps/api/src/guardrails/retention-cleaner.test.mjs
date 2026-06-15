/**
 * Focused unit test for the retention cleaner (session-sandbox-retention,
 * Track 5). Drives the REAL `RetentionCleaner` (compiled with tsc, instantiated
 * directly) against a fake dockerode + stub Prisma, with the free-disk reader
 * overridden per case.
 *
 * Covers (task 5.5):
 *   - Policy 1 age-trip removal with the DEFAULT 30-day window
 *   - window resolution from persisted settings (and MAX across accounts)
 *   - Policy 2 low-disk OLDEST-first eviction until free recovers
 *   - a RUNNING container is NEVER reaped (defensive guard + force:false)
 *   - the in-process overlap guard skips a re-entrant tick
 *
 * Compiled WITHOUT emitDecoratorMetadata so the type-only PrismaService import
 * elides; dockerode + @nestjs/common resolve from node_modules.
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

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const outDir = mkdtempSync(join(apiRoot, '.retention-cleaner-test-'));
function compile() {
  execFileSync(tscBin, [
    cleanerSrc,
    '--outDir', outDir,
    '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2021',
    '--experimentalDecorators', '--esModuleInterop', '--skipLibCheck',
  ], { cwd: apiRoot, stdio: 'pipe' });
  const hit = findFile(outDir, 'retention-cleaner.js');
  if (hit) return hit;
  throw new Error('compiled retention-cleaner.js not found');
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
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/**
 * Fake dockerode. `listContainers` returns ALL given containers (ignoring the
 * status filter) so the cleaner's OWN running-guard is what excludes a running
 * one — and records the filter used so the query-level intent is asserted too.
 */
function makeDocker(containers) {
  const removed = [];
  const removeForce = [];
  let lastFilter;
  let listCalls = 0;
  return {
    removed, removeForce, get lastFilter() { return lastFilter; }, get listCalls() { return listCalls; },
    async listContainers(opts) {
      listCalls += 1;
      lastFilter = opts?.filters;
      return containers.map((c) => ({ Id: c.Id, Names: ['/' + c.Id], State: c.state }));
    },
    getContainer(id) {
      const c = containers.find((x) => x.Id === id);
      return {
        async inspect() {
          if (!c) throw new Error('no such container');
          return { State: { FinishedAt: c.finishedAt }, Created: c.created };
        },
        async remove(opts) {
          removeForce.push(opts?.force);
          // force:false must REFUSE a running container (daemon behavior).
          if (c && c.state === 'running' && !opts?.force) {
            throw new Error('cannot remove a running container');
          }
          removed.push(id);
        },
      };
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
  const { RetentionCleaner } = await import(pathToFileURL(compile()).href);

  // helper: build a cleaner with a fake docker, prisma, fixed free-disk, high floor
  function buildCleaner(docker, prisma, { freeBytes = 1000 * GB, floorGb = 10 } = {}) {
    const c = new RetentionCleaner(prisma);
    c.docker = docker;
    c.diskFloorBytes = floorGb * GB;
    c.getFreeDiskBytes = async () => freeBytes;
    return c;
  }

  // ---- 1) Policy 1 age-trip with DEFAULT 30-day window -----------------------
  {
    const docker = makeDocker([
      { Id: 'old', state: 'exited', finishedAt: iso(40 * DAY) },
      { Id: 'young', state: 'exited', finishedAt: iso(5 * DAY) },
    ]);
    const c = buildCleaner(docker, makePrisma([])); // no rows → default 30
    await c.sweep();
    assert(docker.removed.includes('old'), 'age policy removes a container stopped past the 30-day default');
    assert(!docker.removed.includes('young'), 'age policy keeps a container stopped within the window');
    assert(docker.removeForce.every((f) => f === false), 'removal always uses force:false (never kills)');
    assert(Array.isArray(docker.lastFilter?.status) && docker.lastFilter.status.includes('exited'), 'the list query filters to stopped (exited) containers');
    assert(Array.isArray(docker.lastFilter?.name) && docker.lastFilter.name.some((n) => n.includes('cap-aio-')), 'the list query filters by the cap-aio- prefix');
  }

  // ---- 2) persisted retention window (MAX across accounts) overrides default --
  {
    const docker = makeDocker([{ Id: 'old', state: 'exited', finishedAt: iso(40 * DAY) }]);
    const c = buildCleaner(docker, makePrisma([7, 90])); // max 90 days
    await c.sweep();
    assert(!docker.removed.includes('old'), 'a 40-day-old container is KEPT when the persisted window is 90 (max across accounts)');
  }

  // ---- 2b) DB unavailable → falls back to the default window -----------------
  {
    const docker = makeDocker([{ Id: 'old', state: 'exited', finishedAt: iso(40 * DAY) }]);
    const c = buildCleaner(docker, makePrisma(null)); // findMany throws
    await c.sweep();
    assert(docker.removed.includes('old'), 'a DB failure degrades to the 30-day default (40-day-old removed)');
  }

  // ---- 3) Policy 2 low-disk OLDEST-first eviction ----------------------------
  {
    // three YOUNG containers (age policy keeps all); disk below floor.
    const docker = makeDocker([
      { Id: 'mid', state: 'exited', finishedAt: iso(2 * DAY) },
      { Id: 'oldest', state: 'exited', finishedAt: iso(3 * DAY) },
      { Id: 'newest', state: 'exited', finishedAt: iso(1 * DAY) },
    ]);
    const c = new RetentionCleaner(makePrisma([]));
    c.docker = docker;
    c.diskFloorBytes = 10 * GB;
    // free disk: 5GB (below floor) until 2 removed, then 20GB (recovered).
    c.getFreeDiskBytes = async () => (docker.removed.length >= 2 ? 20 * GB : 5 * GB);
    await c.sweep();
    assert(docker.removed.length === 2, 'disk-pressure eviction stops once free disk recovers above the floor');
    assert(docker.removed[0] === 'oldest' && docker.removed[1] === 'mid', 'disk-pressure evicts OLDEST-stopped first, then next-oldest');
    assert(!docker.removed.includes('newest'), 'the newest stopped container is spared once disk recovers');
  }

  // ---- 3b) disk above floor → Policy 2 evicts nothing ------------------------
  {
    const docker = makeDocker([{ Id: 'young', state: 'exited', finishedAt: iso(1 * DAY) }]);
    const c = buildCleaner(docker, makePrisma([]), { freeBytes: 500 * GB, floorGb: 10 });
    await c.sweep();
    assert(docker.removed.length === 0, 'no eviction when free disk is above the floor and nothing is aged out');
  }

  // ---- 4) a RUNNING container is NEVER reaped --------------------------------
  {
    const docker = makeDocker([
      { Id: 'running-old', state: 'running', finishedAt: iso(99 * DAY) }, // "old" but running
      { Id: 'stopped-old', state: 'exited', finishedAt: iso(99 * DAY) },
    ]);
    const c = buildCleaner(docker, makePrisma([])); // default window; both "old"
    await c.sweep();
    assert(!docker.removed.includes('running-old'), 'a RUNNING container is never considered for removal (defensive guard)');
    assert(docker.removed.includes('stopped-old'), 'a co-resident stopped container IS still reaped');
  }

  // ---- 5) the overlap guard skips a re-entrant tick --------------------------
  {
    const docker = makeDocker([{ Id: 'old', state: 'exited', finishedAt: iso(99 * DAY) }]);
    const c = buildCleaner(docker, makePrisma([]));
    c.sweeping = true; // simulate a sweep already in flight
    await c.sweep();
    assert(docker.listCalls === 0, 'a re-entrant sweep returns immediately without listing/removing anything');
    assert(docker.removed.length === 0, 'the overlap guard prevents the re-entrant tick from removing containers');
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
