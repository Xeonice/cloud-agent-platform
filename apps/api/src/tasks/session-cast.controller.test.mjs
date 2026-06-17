/**
 * Focused unit test for the read-only cast endpoint (session-terminal-replay,
 * Track 3). Compiles `SessionCastController` standalone with tsc (its value-dep
 * chain: session-transcript.service for `resolveWorkspaceDir`, snapshot for the
 * filename, + the sandbox port / rollout-parser those drag in), instantiates it
 * directly with a stub TasksService, and drives the REAL filesystem path
 * resolution by pointing `WORKSPACES_DIR` at a temp dir.
 *
 * Covers: available cast → text; absent → ''; empty file → ''; unknown task →
 * findById 404 propagates (no fabrication).
 *
 * Run: `node session-cast.controller.test.mjs` (self-compiles).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

const outDir = mkdtempSync(join(apiRoot, '.session-cast-test-'));
const wsRoot = mkdtempSync(join(apiRoot, '.session-cast-ws-'));
process.env.WORKSPACES_DIR = wsRoot;

try {
  execFileSync(
    tscBin,
    [
      join(__dirname, 'session-cast.controller.ts'),
      join(__dirname, 'session-transcript.service.ts'),
      join(__dirname, '..', 'terminal', 'snapshot.ts'),
      join(__dirname, '..', 'sandbox', 'sandbox-provider.port.ts'),
      join(__dirname, '..', 'sandbox', 'rollout-parser.ts'),
      '--outDir', outDir,
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'ES2021',
      '--experimentalDecorators',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const compiled = findFile(outDir, 'session-cast.controller.js');
  if (!compiled) throw new Error('compiled session-cast.controller.js not found');
  const { SessionCastController } = await import(pathToFileURL(compiled).href);

  const TASK_ID = 'task-cast-1';
  const makeTasks = (statusOrError) => ({
    async findById() {
      if (statusOrError instanceof Error) throw statusOrError;
      return { id: TASK_ID, status: statusOrError };
    },
  });

  // available
  const dir = join(wsRoot, TASK_ID);
  mkdirSync(dir, { recursive: true });
  const castText = '{"version":2,"width":80,"height":24}\n[0,"o","hi"]\n';
  writeFileSync(join(dir, 'session.cast'), castText, 'utf8');
  const c1 = new SessionCastController(makeTasks('completed'));
  const out1 = await c1.get(TASK_ID);
  check(out1 === castText, 'available cast returns the file text');

  // empty file → ''
  writeFileSync(join(dir, 'session.cast'), '   \n', 'utf8');
  const out2 = await c1.get(TASK_ID);
  check(out2 === '', 'empty/whitespace cast returns empty body');

  // absent → '' (unknown task id with no dir)
  const c3 = new SessionCastController(makeTasks('completed'));
  const out3 = await c3.get('task-no-file');
  check(out3 === '', 'absent cast returns empty body (no 500)');

  // unknown task → findById error propagates
  const err = new Error('not found');
  const c4 = new SessionCastController(makeTasks(err));
  let threw = false;
  try { await c4.get('nope'); } catch (e) { threw = e === err; }
  check(threw, 'unknown task → findById 404 propagates (no fabrication)');
} finally {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
