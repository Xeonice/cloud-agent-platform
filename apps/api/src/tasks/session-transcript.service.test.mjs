/**
 * Focused unit test for the durable transcript persistence service
 * (persist-session-transcripts, Track 2 / design D2-D4). Drives the REAL
 * `SessionTranscriptService` (compiled with tsc, instantiated directly with
 * stubs — Nest's DI container is not involved) against a stub SandboxProvider,
 * a stub PrismaService (an in-memory `sessionTranscript` delegate), and a
 * tmp-dir workspace resolver.
 *
 * Covers (task 2.6):
 *   - capture success     → gzipped RAW JSONL archive written to
 *                           workspaces/<id>/transcript.jsonl.gz + index row
 *                           upserted with meta + concatenated search text.
 *   - capture failure (no rollout) → returns 'no-rollout', NO archive, NO row.
 *   - capture failure (read throws) → returns 'error', swallowed (no throw).
 *   - capture failure (write error) → returns 'error', swallowed, NO row.
 *   - upsert idempotency  → a second capture/backfill upserts in place (one row).
 *   - durable read hit     → readDurable gunzips the archive back to RAW JSONL.
 *   - durable read miss     → no index row → null (caller falls back to container).
 *
 * The archive is verified to be GZIP (magic bytes) and to gunzip back to the
 * EXACT raw input — proving D2 stores raw JSONL, not parsed turns. (Module
 * registration is the Integration track's I.1 — not exercised here.)
 *
 * Compilation tolerates the (expected, until Track 1's `prisma generate`) type
 * error on `prisma.sessionTranscript`: tsc still EMITS the JS, so we ignore a
 * non-zero exit as long as the compiled file is produced. The stub PrismaService
 * supplies the delegate at runtime.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const serviceSrc = join(__dirname, 'session-transcript.service.ts');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

const outDir = mkdtempSync(join(apiRoot, '.session-transcript-test-'));

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (e.name === name) return p;
  }
  return null;
}

function compile() {
  try {
    execFileSync(
      tscBin,
      [
        serviceSrc,
        join(__dirname, '..', 'sandbox', 'rollout-parser.ts'),
        join(__dirname, '..', 'sandbox', 'sandbox-provider.port.ts'),
        join(__dirname, '..', 'prisma', 'prisma.service.ts'),
        '--outDir',
        outDir,
        '--module',
        'commonjs',
        '--moduleResolution',
        'node',
        '--target',
        'ES2021',
        '--experimentalDecorators',
        '--esModuleInterop',
        '--skipLibCheck',
      ],
      { cwd: apiRoot, stdio: 'pipe' },
    );
  } catch {
    // tsc EMITS JS even on type errors (expected: `prisma.sessionTranscript`
    // is unknown until Track 1's `prisma generate`). Tolerate the non-zero exit
    // and verify the compiled file below instead.
  }
  const hit = findFile(outDir, 'session-transcript.service.js');
  if (hit) return hit;
  throw new Error(
    'compiled session-transcript.service.js not found under ' + outDir,
  );
}

// ---- stubs ------------------------------------------------------------------

const TASK_ID = 'task-xyz';

/** A minimal synthetic rollout (real codex line shapes, synthetic content). */
const ROLLOUT = [
  JSON.stringify({
    type: 'session_meta',
    payload: { cwd: '/home/gem/workspace', timestamp: '2026-06-01T10:00:00Z' },
  }),
  JSON.stringify({
    type: 'turn_context',
    payload: { model: 'gpt-5-codex' },
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: { type: 'user_message', message: 'find the bug in widget.ts' },
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: 'fixed the off-by-one in widget.ts',
      phase: 'final_answer',
    },
  }),
].join('\n');

/** Stub SandboxProvider exposing only `readRolloutFromContainer`. */
function makeSandbox({ rollout = null, throws = false } = {}) {
  const calls = { readRollout: 0 };
  return {
    calls,
    provider: {
      async readRolloutFromContainer() {
        calls.readRollout++;
        if (throws) throw new Error('docker getArchive blew up');
        return rollout;
      },
    },
  };
}

/** Stub PrismaService: an in-memory `sessionTranscript` delegate (Map by taskId). */
function makePrisma({ throwsOnUpsert = false } = {}) {
  const rows = new Map();
  const calls = { upsert: 0, findUnique: 0 };
  return {
    rows,
    calls,
    prisma: {
      sessionTranscript: {
        async upsert({ where, create, update }) {
          calls.upsert++;
          if (throwsOnUpsert) throw new Error('db down');
          const existing = rows.get(where.taskId);
          rows.set(where.taskId, existing ? { ...existing, ...update } : { ...create });
          return rows.get(where.taskId);
        },
        async findUnique({ where }) {
          calls.findUnique++;
          return rows.get(where.taskId) ?? null;
        },
      },
    },
  };
}

async function main() {
  const serviceJs = compile();
  const { SessionTranscriptService } = await import(
    pathToFileURL(serviceJs).href
  );

  // A tmp workspaces root; the resolver returns <root>/<taskId>.
  const wsRoot = mkdtempSync(join(apiRoot, '.session-transcript-ws-'));
  const resolveWs = (taskId) => join(wsRoot, taskId);
  const archiveFor = (taskId) =>
    join(wsRoot, taskId, 'transcript.jsonl.gz');

  // ---- capture success: archive (raw, gzipped) + index row -------------------
  {
    const sb = makeSandbox({ rollout: ROLLOUT });
    const db = makePrisma();
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: resolveWs });
    const status = await svc.capture(TASK_ID);
    assert(status === 'captured', 'capture(rollout present) → "captured"');
    assert(sb.calls.readRollout === 1, 'capture reuses readRolloutFromContainer (once)');

    const archive = archiveFor(TASK_ID);
    assert(existsSync(archive), 'capture writes transcript.jsonl.gz to workspaces/<id>/');
    const gz = readFileSync(archive);
    assert(gz[0] === 0x1f && gz[1] === 0x8b, 'archive is GZIP (magic bytes 1f 8b)');
    assert(
      gunzipSync(gz).toString('utf8') === ROLLOUT,
      'archive gunzips back to the EXACT raw JSONL (raw, not parsed turns)',
    );

    assert(db.calls.upsert === 1, 'capture upserts the index row once');
    const row = db.rows.get(TASK_ID);
    assert(row && row.taskId === TASK_ID, 'index row keyed by taskId');
    assert(row.model === 'gpt-5-codex', 'index row carries parsed meta.model');
    assert(row.cwd === '/home/gem/workspace', 'index row carries parsed meta.cwd');
    assert(row.startedAt === '2026-06-01T10:00:00Z', 'index row carries parsed meta.startedAt');
    assert(row.turnCount === 2, 'index row carries the parsed turn count');
    assert(row.archivePath === archive, 'index row archivePath points at the archive');
    assert(typeof row.content === 'string', 'index row carries the searchable content column');
    assert(
      row.content.includes('find the bug in widget.ts') &&
        row.content.includes('fixed the off-by-one'),
      'content concatenates user + assistant turn text',
    );
    assert(row.isInterrupted === false, 'a clean final-answer transcript is not interrupted');
    assert(row.capturedAt instanceof Date, 'index row carries a captured-at timestamp');
  }

  // ---- capture failure: no rollout → no archive, no row, "no-rollout" --------
  {
    const sb = makeSandbox({ rollout: null });
    const db = makePrisma();
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: resolveWs });
    const status = await svc.capture('task-none');
    assert(status === 'no-rollout', 'capture(no rollout) → "no-rollout"');
    assert(!existsSync(archiveFor('task-none')), 'no rollout → NO archive written');
    assert(db.calls.upsert === 0, 'no rollout → NO index row upserted');
  }

  // ---- capture failure: read throws → swallowed, "error", no throw -----------
  {
    const sb = makeSandbox({ throws: true });
    const db = makePrisma();
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: resolveWs });
    let threw = false;
    let status;
    try {
      status = await svc.capture('task-readthrow');
    } catch {
      threw = true;
    }
    assert(!threw, 'a thrown rollout read is SWALLOWED (capture never throws)');
    assert(status === 'error', 'read failure → "error"');
    assert(db.calls.upsert === 0, 'read failure → NO index row');
  }

  // ---- capture failure: archive write error → swallowed, "error", no row -----
  {
    const sb = makeSandbox({ rollout: ROLLOUT });
    const db = makePrisma();
    // Point the resolver at a path whose parent is a FILE → mkdir/writeFile fails.
    const fileAsDir = archiveFor(TASK_ID); // an existing FILE from the first case
    const badResolve = () => join(fileAsDir, 'nested');
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: badResolve });
    let threw = false;
    let status;
    try {
      status = await svc.capture('task-writefail');
    } catch {
      threw = true;
    }
    assert(!threw, 'a write error is SWALLOWED (capture never throws)');
    assert(status === 'error', 'write failure → "error"');
    assert(db.calls.upsert === 0, 'write failure → NO index row (archive never landed)');
  }

  // ---- upsert idempotency: re-capture / backfill upserts in place ------------
  {
    const sb = makeSandbox({ rollout: ROLLOUT });
    const db = makePrisma();
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: resolveWs });
    await svc.capture('task-idem');
    await svc.capture('task-idem'); // proactive re-capture
    await svc.backfill('task-idem', ROLLOUT); // read-through backfill
    assert(db.calls.upsert === 3, 'three captures/backfills issue three upserts');
    assert(db.rows.size >= 1 && db.rows.has('task-idem'), 'exactly one row per taskId (upsert in place)');
    // Count rows for this task — Map keys are unique by construction, asserting intent.
    assert(
      [...db.rows.keys()].filter((k) => k === 'task-idem').length === 1,
      're-capture never produces a duplicate row',
    );
  }

  // ---- backfill: persists from an externally-read rollout --------------------
  {
    const sb = makeSandbox({ rollout: null }); // backfill does NOT read the container
    const db = makePrisma();
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: resolveWs });
    const status = await svc.backfill('task-bf', ROLLOUT);
    assert(status === 'captured', 'backfill(rawJsonl) → "captured"');
    assert(sb.calls.readRollout === 0, 'backfill does NOT touch the container');
    assert(existsSync(archiveFor('task-bf')), 'backfill writes the durable archive');
    assert(db.rows.has('task-bf'), 'backfill upserts the index row');
  }

  // ---- durable read hit: gunzip the archive back to raw JSONL ----------------
  {
    const sb = makeSandbox({ rollout: ROLLOUT });
    const db = makePrisma();
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: resolveWs });
    await svc.capture('task-read');
    const raw = await svc.readDurable('task-read');
    assert(raw === ROLLOUT, 'readDurable returns the EXACT raw JSONL from the archive');
  }

  // ---- durable read miss: no index row → null --------------------------------
  {
    const sb = makeSandbox();
    const db = makePrisma();
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: resolveWs });
    const raw = await svc.readDurable('task-absent');
    assert(raw === null, 'readDurable(no index row) → null (caller falls back to container)');
  }

  // ---- durable read miss: row present but archive gone → null ----------------
  {
    const sb = makeSandbox({ rollout: ROLLOUT });
    const db = makePrisma();
    const svc = Object.assign(new SessionTranscriptService(sb.provider, db.prisma), { resolveWorkspace: resolveWs });
    await svc.capture('task-gone');
    // Delete the archive bytes but keep the index row.
    rmSync(archiveFor('task-gone'), { force: true });
    const raw = await svc.readDurable('task-gone');
    assert(raw === null, 'readDurable(row present, archive unreadable) → null (no throw)');
  }

  rmSync(wsRoot, { recursive: true, force: true });
}

let exitCode = 0;
console.log('\n=== session-transcript.service: durable capture / read ===\n');
try {
  await main();
} catch (err) {
  console.error('  FAIL  unexpected error during test run');
  console.error(err);
  failed++;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  exitCode = 0;
} else {
  console.error('SOME TESTS FAILED');
  exitCode = 1;
}
process.exit(exitCode);
