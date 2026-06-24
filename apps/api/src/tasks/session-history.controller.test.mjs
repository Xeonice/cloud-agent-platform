/**
 * Focused unit test for the read-only session-history endpoint
 * (persist-session-transcripts, Track 4 read-path). Drives the REAL
 * `SessionHistoryController` (compiled with tsc, instantiated directly with
 * stubs — Nest's DI container is not involved) against a stub TasksService +
 * stub SandboxProvider + stub TranscriptStore, asserting the durable-first
 * resolution (design D4) AND the discriminated SessionHistory mapping.
 *
 * Covers (task 4.4):
 *   - durable hit              → 'available' parsed from the archive, with the
 *     CONTAINER never touched (readDurable wins; no readRolloutFromContainer)
 *   - container fallback + backfill → durable miss falls back to the container,
 *     read-through backfills the archive, and the NEXT read is a durable hit
 *     (no second container touch)
 *   - both sources gone        → 'expired' only when neither durable nor
 *     container yields a rollout (and the sandbox is gone)
 *   - completed + rollout      → status 'available' (parsed transcript)
 *   - cancelled + rollout      → 'available' (rollout up to the interruption)
 *   - failed + rollout         → 'available' (rollout up to the failure)
 *   - agent_failed_to_start    → 'empty' reason 'agent-failed-to-start' (no read)
 *   - terminal + no rollout + sandbox exists → 'empty' reason 'no-rollout'
 *   - unknown task             → the findById 404 propagates (no fabrication)
 *   - credentials-never-exported → the controller only ever asks the provider for
 *     the rollout + existence; any other provider method access throws
 *   - auth-required → enforced by the global APP_GUARD (auth.module), same as
 *     /tasks/:id and /metrics; see the controller doc. Asserted structurally
 *     here (no auth-exemption), exercised end-to-end by the guard's own tests.
 *
 * Compiled WITHOUT emitDecoratorMetadata so the type-only `TasksService` import
 * elides (no need to drag in the whole service tree); `@cap/contracts` and
 * `@nestjs/common` resolve from node_modules; the value-imported port +
 * rollout-parser are compiled alongside.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const controllerSrc = join(__dirname, 'session-history.controller.ts');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const outDir = mkdtempSync(join(apiRoot, '.session-history-test-'));
function compile() {
  execFileSync(
    tscBin,
    [
      controllerSrc,
      join(__dirname, '..', 'sandbox', 'rollout-parser.ts'),
      join(__dirname, '..', 'sandbox', 'sandbox-provider.port.ts'),
      '--outDir', outDir,
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'ES2021',
      '--experimentalDecorators', // legacy decorators (no emitDecoratorMetadata)
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const hit = findFile(outDir, 'session-history.controller.js');
  if (hit) return hit;
  throw new Error('compiled session-history.controller.js not found under ' + outDir);
}
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

// ---- stubs ------------------------------------------------------------------

const TASK_ID = 'task-abc';

/**
 * Stub TasksService.findById: returns a task with `status` (+ optional
 * `executionMode` for the headless-task-conversation-view live branch), or throws
 * (404). An omitted executionMode reads back undefined — the interactive default,
 * so existing cases keep the finished durable-first path.
 */
function makeTasks(statusOrError, executionMode) {
  return {
    async findById() {
      if (statusOrError instanceof Error) throw statusOrError;
      return { id: TASK_ID, status: statusOrError, executionMode };
    },
  };
}

/**
 * Stub SandboxProvider exposing only the two methods the controller may use.
 * Any OTHER method access throws — a controller that reached for, say, a
 * credential export would fail the test (credentials-never-exported).
 */
function makeProvider({ rollout = null, exists = false } = {}) {
  const calls = { readRollout: 0, sandboxExists: 0, other: [] };
  const base = {
    // readRolloutFromContainer returns a TranscriptSource `{ format, jsonl }` (or
    // null) — unify-transcript-parsers D3. The controller consumes `.jsonl`.
    async readRolloutFromContainer() {
      calls.readRollout++;
      return rollout == null ? null : { format: 'codex-rollout', jsonl: rollout };
    },
    async sandboxExists() { calls.sandboxExists++; return exists; },
  };
  const provider = new Proxy(base, {
    get(target, prop) {
      if (prop in target || typeof prop === 'symbol' || prop === 'then') return target[prop];
      calls.other.push(String(prop));
      return () => { throw new Error('unexpected provider method: ' + String(prop)); };
    },
  });
  return { provider, calls };
}

/**
 * Stub TranscriptStore (the durable archive). `durable` is the persisted raw
 * JSONL returned by `readDurable` (default null = miss). `backfill` records the
 * rollout it is handed AND (by default) makes the next `readDurable` a hit, so a
 * fallback-then-reread exercises the read-through path end-to-end. A best-effort
 * store: `backfill` resolves; the controller awaits it only to sequence.
 */
function makeTranscripts({ durable = null, backfillPersists = true } = {}) {
  const calls = { readDurable: 0, backfill: 0, backfilled: [] };
  const state = { durable };
  return {
    transcripts: {
      async readDurable() { calls.readDurable++; return state.durable; },
      async backfill(taskId, rawJsonl) {
        calls.backfill++;
        calls.backfilled.push({ taskId, rawJsonl });
        if (backfillPersists) state.durable = rawJsonl;
      },
    },
    calls,
  };
}

/**
 * Stub AuditTimelineReader.queryTask: returns the given lifecycle events
 * (oldest→newest), or `[]` by default so the rollout-only behavior is preserved.
 * Pass `throws: true` to assert the merge is best-effort (read failure must NOT
 * fail the transcript read).
 */
function makeAudit(events = [], { throws = false } = {}) {
  return {
    async queryTask() {
      if (throws) throw new Error('audit read failed');
      return events;
    },
  };
}

// A minimal synthetic rollout (real codex line shapes, synthetic content).
const ROLLOUT = [
  JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/gem/workspace', timestamp: '2026-06-01T10:00:00Z' } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '改个标题' } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '已完成。', phase: 'final_answer' } }),
].join('\n');

async function main() {
  const controllerJs = compile();
  const { SessionHistoryController } = await import(pathToFileURL(controllerJs).href);

  // ---- completed / cancelled / failed + rollout → 'available' ----------------
  // (durable miss → container fallback; see the dedicated backfill case below.)
  for (const status of ['completed', 'cancelled', 'failed']) {
    const { provider, calls } = makeProvider({ rollout: ROLLOUT });
    const { transcripts } = makeTranscripts();
    const ctrl = new SessionHistoryController(makeTasks(status), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'available', `${status} + rollout → status 'available'`);
    assert(res.meta?.taskId === TASK_ID, `${status}: meta.taskId is the requested id`);
    assert(Array.isArray(res.turns) && res.turns.length >= 1, `${status}: the parsed transcript carries turns`);
    assert(calls.other.length === 0, `${status}: the controller never touches any non-transcript provider method`);
    // V.1 — the interrupted-terminal indication is on the WIRE response: a
    // cancelled task ended mid-run (interrupted), completed/failed did not.
    assert(
      res.isInterrupted === (status === 'cancelled'),
      `${status}: isInterrupted is ${status === 'cancelled'} on the wire response`,
    );
  }

  // ---- durable hit → 'available' WITHOUT touching the container ---------------
  {
    const { provider, calls } = makeProvider({ rollout: null /* container empty on purpose */ });
    const { transcripts, calls: tCalls } = makeTranscripts({ durable: ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks('completed'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'available', 'durable hit → status available (parsed from the archive)');
    assert(Array.isArray(res.turns) && res.turns.length >= 1, 'durable hit: the archive parses into turns');
    assert(tCalls.readDurable === 1, 'durable hit: readDurable was consulted');
    assert(calls.readRollout === 0 && calls.sandboxExists === 0, 'durable hit: the CONTAINER is never read (durable-first)');
    assert(tCalls.backfill === 0, 'durable hit: no backfill on a hit (already durable)');
  }

  // ---- container fallback + backfill; next read is a durable hit --------------
  {
    const { provider, calls } = makeProvider({ rollout: ROLLOUT });
    const { transcripts, calls: tCalls } = makeTranscripts({ durable: null });
    const ctrl = new SessionHistoryController(makeTasks('completed'), provider, transcripts, makeAudit());

    const first = await ctrl.get(TASK_ID);
    assert(first.status === 'available', 'fallback: durable miss → container read → available');
    assert(tCalls.readDurable === 1 && calls.readRollout === 1, 'fallback: readDurable missed, then the container was read once');
    assert(tCalls.backfill === 1, 'fallback: the container rollout is read-through backfilled');
    assert(tCalls.backfilled[0]?.rawJsonl === ROLLOUT && tCalls.backfilled[0]?.taskId === TASK_ID, 'fallback: backfill persists the RAW rollout keyed by taskId');

    const second = await ctrl.get(TASK_ID);
    assert(second.status === 'available', 'fallback: the NEXT read is still available');
    assert(tCalls.readDurable === 2, 'fallback: the next read consults the durable store again');
    assert(calls.readRollout === 1, 'fallback: the next read is a durable hit — the container is NOT read a second time');
  }

  // ---- running headless → LIVE read from the sandbox (headless-task-conversation-view) -
  // No durable-first (would serve a stale/older snapshot) and NO backfill (would
  // freeze the in-flight rollout as the durable copy, making later reads stale).
  {
    const { provider, calls } = makeProvider({ rollout: ROLLOUT });
    // durable is SET on purpose — if the live branch wrongly consulted it, the test
    // would catch the read (readDurable === 0 below).
    const { transcripts, calls: tCalls } = makeTranscripts({ durable: ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks('running', 'headless-exec'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'available', 'running headless → available parsed from the LIVE sandbox rollout');
    assert(Array.isArray(res.turns) && res.turns.length >= 1, 'running headless: the live rollout parses into turns');
    assert(calls.readRollout === 1, 'running headless: the live sandbox rollout IS read');
    assert(tCalls.readDurable === 0, 'running headless: durable-first is SKIPPED (live read wins — no stale archive)');
    assert(tCalls.backfill === 0, 'running headless: the in-flight rollout is NOT backfilled (no freezing incomplete as durable)');
  }

  // ---- running headless + no rollout yet → empty/no-rollout (starting, not failed) -----
  {
    const { provider, calls } = makeProvider({ rollout: null });
    const { transcripts, calls: tCalls } = makeTranscripts({ durable: null });
    const ctrl = new SessionHistoryController(makeTasks('awaiting_input', 'headless-exec'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'empty' && res.reason === 'no-rollout', 'running headless + no rollout yet → empty/no-rollout (starting, not failed)');
    assert(calls.readRollout === 1, 'running headless (no rollout): the live read was attempted');
    assert(tCalls.readDurable === 0 && tCalls.backfill === 0, 'running headless (no rollout): never reads/backfills durable');
  }

  // ---- running INTERACTIVE → the headless live branch is NOT taken (unchanged path) ----
  {
    const { provider, calls } = makeProvider({ rollout: ROLLOUT });
    const { transcripts, calls: tCalls } = makeTranscripts({ durable: ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks('running', 'interactive-pty'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'available', 'running interactive → available (existing durable-first path, unchanged)');
    assert(tCalls.readDurable === 1, 'running interactive: durable-first IS consulted (the headless live branch is not taken)');
    assert(calls.readRollout === 0, 'running interactive: no live container read (durable hit wins)');
  }

  // ---- agent_failed_to_start → 'empty' (no archive/container read at all) -----
  {
    const { provider, calls } = makeProvider({ rollout: ROLLOUT });
    const { transcripts, calls: tCalls } = makeTranscripts({ durable: ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks('agent_failed_to_start'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'empty' && res.reason === 'agent-failed-to-start', 'agent_failed_to_start → empty/agent-failed-to-start');
    assert(calls.readRollout === 0 && calls.sandboxExists === 0, 'agent_failed_to_start: NO container is read (nothing ever existed)');
    assert(tCalls.readDurable === 0, 'agent_failed_to_start: NO durable archive is read either');
  }

  // ---- both sources gone (no durable + no rollout + sandbox reaped) → expired -
  {
    const { provider } = makeProvider({ rollout: null, exists: false });
    const { transcripts } = makeTranscripts({ durable: null });
    const ctrl = new SessionHistoryController(makeTasks('completed'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'expired', 'no durable AND no rollout AND sandbox reaped → expired (aged-out record)');
  }

  // ---- terminal + no rollout + sandbox exists → 'empty' / no-rollout ----------
  {
    const { provider } = makeProvider({ rollout: null, exists: true });
    const { transcripts } = makeTranscripts({ durable: null });
    const ctrl = new SessionHistoryController(makeTasks('failed'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'empty' && res.reason === 'no-rollout', 'no durable + no rollout + sandbox still present → empty/no-rollout');
  }

  // ---- unknown task: the findById 404 propagates ------------------------------
  {
    const err = Object.assign(new Error('Task not found'), { status: 404 });
    const { provider } = makeProvider({ rollout: ROLLOUT });
    const { transcripts } = makeTranscripts({ durable: ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks(err), provider, transcripts, makeAudit());
    let threw = false;
    try { await ctrl.get('nope'); } catch (e) { threw = e === err; }
    assert(threw, 'an unknown task propagates the 404 (no fabricated transcript)');
  }

  // ---- credentials-never-exported (explicit): served payload carries no secret-
  {
    const { provider } = makeProvider({ rollout: ROLLOUT });
    const { transcripts } = makeTranscripts({ durable: ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks('completed'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    const serialized = JSON.stringify(res).toLowerCase();
    assert(
      !serialized.includes('auth.json') && !serialized.includes('access_token') && !serialized.includes('refresh_token'),
      'the served SessionHistory never contains a credential field',
    );
  }

  // ---- audit milestones merge into the stream as ordered system turns ---------
  {
    // A rollout WITH per-line timestamps so the merge interleaves by time.
    const TS_ROLLOUT = [
      JSON.stringify({ timestamp: '2026-06-01T10:00:01Z', type: 'session_meta', payload: { cwd: '/w', timestamp: '2026-06-01T10:00:01Z' } }),
      JSON.stringify({ timestamp: '2026-06-01T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '改个标题' } }),
      JSON.stringify({ timestamp: '2026-06-01T10:00:09Z', type: 'event_msg', payload: { type: 'agent_message', message: '已完成。', phase: 'final_answer' } }),
    ].join('\n');
    // Audit rows oldest→newest: one BEFORE the user turn, one AFTER the answer.
    const events = [
      { type: 'task.created', title: '任务创建', description: 'cloud-agent-platform', level: 'info', timestamp: new Date('2026-06-01T10:00:00Z') },
      { type: 'task.completed', title: '任务完成', description: '', level: 'info', timestamp: new Date('2026-06-01T10:00:10Z') },
    ];
    const { provider } = makeProvider({ rollout: null });
    const { transcripts } = makeTranscripts({ durable: TS_ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks('completed'), provider, transcripts, makeAudit(events));
    const res = await ctrl.get(TASK_ID);

    const kinds = res.turns.map((t) => t.kind);
    assert(
      JSON.stringify(kinds) === JSON.stringify(['system', 'user', 'assistant', 'system']),
      'audit rows merge as system turns ordered by timestamp (created → user → answer → completed)',
    );
    const created = res.turns[0];
    assert(created.kind === 'system' && created.title === '任务创建' && created.detail === 'cloud-agent-platform' && created.level === 'info', 'a system turn carries the audit title/detail/level');
    assert(created.at === '2026-06-01T10:00:00.000Z', 'a system turn carries the audit timestamp as the merge key');
    const completed = res.turns[3];
    assert(completed.kind === 'system' && completed.detail === undefined, 'an empty audit description yields no fabricated detail');
    // The pure rollout (no audit) emits NO system turns.
    assert(res.turns.filter((t) => t.kind === 'system').length === 2, 'system turns come ONLY from the audit merge, not the rollout parser');
  }

  // ---- audit read failure is best-effort: transcript still served ------------
  {
    const { provider } = makeProvider({ rollout: null });
    const { transcripts } = makeTranscripts({ durable: ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks('completed'), provider, transcripts, makeAudit([], { throws: true }));
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'available' && res.turns.every((t) => t.kind !== 'system'), 'an audit read failure degrades to the rollout-only turns (no throw)');
  }

  // ---- an OLD durable archive (no new fields) reads back without error --------
  {
    // A pre-change archive: turns have no `at`, meta has no totals. Still valid.
    const { provider } = makeProvider({ rollout: null });
    const { transcripts } = makeTranscripts({ durable: ROLLOUT });
    const ctrl = new SessionHistoryController(makeTasks('completed'), provider, transcripts, makeAudit());
    const res = await ctrl.get(TASK_ID);
    assert(res.status === 'available', 'an old archive (no per-turn at / no totals) still parses to available');
    assert(res.turns.every((t) => t.at === undefined), 'old-archive turns simply carry no `at` (additive-optional, no error)');
    assert(res.meta.totalTokens === undefined && res.meta.durationMs === undefined, 'old-archive meta omits the new totals without error');
  }
}

let exitCode = 0;
console.log('\n=== session-history.controller: discriminated replay mapping ===\n');
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
if (failed === 0) { console.log('ALL TESTS PASSED'); exitCode = 0; }
else { console.error('SOME TESTS FAILED'); exitCode = 1; }
process.exit(exitCode);
