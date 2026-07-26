/**
 * Focused unit test for the read-only cast endpoint (session-terminal-replay,
 * Track 3). Reuses the package's formally built dist (the package test pre-step
 * builds it), instantiates the controller with a stub TasksService, and drives
 * the real filesystem path by pointing `WORKSPACES_DIR` at a temp dir.
 *
 * Covers: default disabled → explicit 503 without opening a file; available cast
 * → bounded text; oversized → 413 without a read; absent/empty → ''; unknown
 * task → findById 404 propagates (no fabrication).
 *
 * Run: `node session-cast.controller.test.mjs` (self-compiles).
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}
const wsRoot = mkdtempSync(join(apiRoot, '.session-cast-ws-'));
process.env.WORKSPACES_DIR = wsRoot;

try {
  const compiled = join(apiRoot, 'dist', 'tasks', 'session-cast.controller.js');
  const {
    SessionCastController,
    readBoundedSessionCast,
  } = await import(pathToFileURL(compiled).href);

  const TASK_ID = 'task-cast-1';
  const makeTasks = (statusOrError) => ({
    async findById() {
      if (statusOrError instanceof Error) throw statusOrError;
      return { id: TASK_ID, status: statusOrError };
    },
  });

  delete process.env.CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED;
  delete process.env.CAP_TERMINAL_RAW_CAST_MAX_BYTES;

  // Default-off fails explicitly before any filesystem read.
  const disabled = new SessionCastController(makeTasks('completed'));
  let disabledStatus = null;
  try {
    await disabled.get(TASK_ID);
  } catch (error) {
    disabledStatus = error?.getStatus?.();
  }
  check(disabledStatus === 503, 'default-off cast returns explicit 503');
  let disabledOpens = 0;
  let disabledHelperStatus = null;
  try {
    await readBoundedSessionCast(
      'disabled-cast',
      { enabled: false, maxBytes: 1024 },
      async () => {
        disabledOpens += 1;
        throw new Error('disabled cast must not open a file');
      },
    );
  } catch (error) {
    disabledHelperStatus = error?.getStatus?.();
  }
  check(disabledHelperStatus === 503, 'disabled helper returns explicit 503');
  check(disabledOpens === 0, 'disabled cast is rejected before opening a file');

  const castBudget = 1024;
  process.env.CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED = 'true';
  process.env.CAP_TERMINAL_RAW_CAST_MAX_BYTES = String(castBudget);

  // available
  const dir = join(wsRoot, TASK_ID);
  mkdirSync(dir, { recursive: true });
  const castText = '{"version":2,"width":80,"height":24}\n[0,"o","hi"]\n';
  writeFileSync(join(dir, 'session.cast'), castText, 'utf8');
  const c1 = new SessionCastController(makeTasks('completed'));
  const out1 = await c1.get(TASK_ID);
  check(out1 === castText, 'available cast returns the file text');

  // Oversize is rejected after stat and before any handle read.
  let reads = 0;
  let closes = 0;
  let oversizeStatus = null;
  try {
    await readBoundedSessionCast(
      'fake-cast',
      { enabled: true, maxBytes: castBudget },
      async () => ({
        async stat() { return { size: castBudget + 1 }; },
        async read() { reads += 1; return { bytesRead: 0 }; },
        async close() { closes += 1; },
      }),
    );
  } catch (error) {
    oversizeStatus = error?.getStatus?.();
  }
  check(oversizeStatus === 413, 'oversized cast returns explicit 413');
  check(reads === 0, 'oversized cast is rejected before reading bytes');
  check(closes === 1, 'oversized cast handle is still closed');

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
  rmSync(wsRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
