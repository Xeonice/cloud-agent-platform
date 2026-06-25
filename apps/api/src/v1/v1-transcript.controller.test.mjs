/**
 * Focused unit test for the public `/v1/tasks/:id/transcript` controller
 * (wire-transcript-real-data, Track v1-public). Drives the REAL
 * `V1TranscriptController` (compiled with tsc, instantiated directly with stubs)
 * to assert the additive transcript fields serialize on the /v1 surface and that
 * an old archive (without them) stays backward-compatible.
 *
 * Covers (task 4.3):
 *   - the /v1 response carries per-turn `at`, tool `diffstat`, audit-sourced
 *     `system` turns, and meta totals — serialized from the shared
 *     `SessionHistorySchema` (the merge mirrors the console controller, D3);
 *   - an old durable archive (no new fields) reads back valid (no new fields).
 *
 * Mirrors the repo's `.test.mjs` convention (compile the real `.ts`, plain
 * `node`, inline assertions). A scopeless operator principal is allow-all, so the
 * read-scope gate passes with a minimal `req`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const controllerSrc = join(__dirname, 'v1-transcript.controller.ts');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const outDir = mkdtempSync(join(apiRoot, '.v1-transcript-test-'));
function compile() {
  execFileSync(
    tscBin,
    [
      controllerSrc,
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
  const hit = findFile(outDir, 'v1-transcript.controller.js');
  if (hit) return hit;
  throw new Error('compiled v1-transcript.controller.js not found under ' + outDir);
}
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

const TASK_ID = 'task-v1';
// A scopeless principal → allow-all on the read-scope gate.
const REQ = { operatorPrincipal: {} };

const makeTasks = (status) => ({ async findById() { return { id: TASK_ID, status }; } });
function makeProvider({ capabilities = null } = {}) {
  const calls = { readRollout: 0, sandboxExists: 0 };
  return {
    provider: {
      getSandboxMode() { return 'test'; },
      getProviderCapabilities: capabilities ? () => capabilities : undefined,
      async readRolloutFromContainer() { calls.readRollout++; return null; },
      async sandboxExists() { calls.sandboxExists++; return false; },
    },
    calls,
  };
}
const makeTranscripts = (durable) => ({ async readDurable() { return durable; }, async backfill() {} });
const makeAudit = (events = []) => ({ async queryTask() { return events; } });

// A rollout WITH per-line timestamps + an apply_patch with a +2/−1 body, so the
// serialized response exercises `at` and `diffstat`.
const RICH_ROLLOUT = [
  JSON.stringify({ timestamp: '2026-06-01T10:00:01Z', type: 'session_meta', payload: { cwd: '/w', timestamp: '2026-06-01T10:00:01Z' } }),
  JSON.stringify({ timestamp: '2026-06-01T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '改标题' } }),
  JSON.stringify({ timestamp: '2026-06-01T10:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n+a\n+b\n-c\n*** End Patch', call_id: 'p1' } }),
  JSON.stringify({ timestamp: '2026-06-01T10:00:04Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 50 } } } }),
  JSON.stringify({ timestamp: '2026-06-01T10:00:05Z', type: 'event_msg', payload: { type: 'agent_message', message: '完成。', phase: 'final_answer' } }),
].join('\n');

// An OLD archive: no per-line timestamps, no token data → no at / diffstat / totals.
const OLD_ROLLOUT = [
  JSON.stringify({ type: 'session_meta', payload: { cwd: '/w' } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'done', phase: 'final_answer' } }),
].join('\n');

async function main() {
  const { V1TranscriptController } = await import(pathToFileURL(compile()).href);

  // ---- the /v1 response carries the enriched fields --------------------------
  {
    const events = [
      { type: 'task.created', title: '任务创建', description: 'repo', level: 'info', timestamp: new Date('2026-06-01T10:00:00Z') },
    ];
    const ctrl = new V1TranscriptController(
      makeTasks('completed'), makeProvider().provider, makeTranscripts(RICH_ROLLOUT), makeAudit(events),
    );
    const res = await ctrl.get(TASK_ID, REQ);
    assert(res.status === 'available', '/v1 transcript resolves to available');

    const system = res.turns.find((t) => t.kind === 'system');
    assert(system && system.title === '任务创建', '/v1 response carries audit-sourced system turns');
    const tool = res.turns.find((t) => t.kind === 'tool');
    assert(tool && tool.diffstat && tool.diffstat.add === 2 && tool.diffstat.del === 1, '/v1 response carries tool diffstat');
    assert(res.turns.some((t) => t.kind === 'user' && t.at === '2026-06-01T10:00:02Z'), '/v1 response carries per-turn at');
    assert(res.meta.totalTokens === 50 && typeof res.meta.durationMs === 'number', '/v1 response carries meta totals');
  }

  // ---- backward-compatible: an old archive omits the new fields, still valid -
  {
    const ctrl = new V1TranscriptController(
      makeTasks('completed'), makeProvider().provider, makeTranscripts(OLD_ROLLOUT), makeAudit([]),
    );
    const res = await ctrl.get(TASK_ID, REQ);
    assert(res.status === 'available', '/v1 old archive still resolves to available');
    assert(res.turns.every((t) => t.at === undefined), '/v1 old-archive turns omit at (additive-optional)');
    assert(res.meta.totalTokens === undefined && res.meta.durationMs === undefined, '/v1 old-archive meta omits totals (no error)');
  }

  // ---- no durable + declared provider without retained-read → no container touch -
  {
    const { provider, calls } = makeProvider({ capabilities: ['terminal.websocket'] });
    const ctrl = new V1TranscriptController(
      makeTasks('completed'), provider, makeTranscripts(null), makeAudit([]),
    );
    const res = await ctrl.get(TASK_ID, REQ);
    assert(res.status === 'expired', '/v1 missing retained-read capability + durable miss → expired');
    assert(calls.readRollout === 0 && calls.sandboxExists === 0, '/v1 missing retained-read: container is never read');
  }
}

let exitCode = 0;
console.log('\n=== v1-transcript.controller: enriched transcript on /v1 ===\n');
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
