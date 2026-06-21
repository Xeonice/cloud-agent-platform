/**
 * Focused unit test for the Claude Code session-JSONL parser
 * (add-headless-execution-track + wire-transcript-real-data runtime parity).
 * Drives the REAL `claude-transcript-parser.ts` (compiled with tsc, imported)
 * against a SYNTHETIC fixture whose line shapes mirror real claude 2.1.183
 * sessions — synthetic CONTENT, real STRUCTURE.
 *
 * Covers:
 *   - user / assistant turn extraction; `stop_reason === 'end_turn'` → final answer
 *   - tool_result-only user records (no text) are skipped
 *   - meta cwd/model/startedAt come from the first carrying line
 *   - wire-transcript-real-data: per-turn `at` carried from the line timestamp
 *     (omitted when absent); session `durationMs` = last − first timestamp;
 *     `totalTokens` is OMITTED for this runtime (no clean per-turn delta)
 *   - a malformed line never aborts the parse
 *
 * Mirrors the repo's `.test.mjs` convention (compile the real `.ts`, plain
 * `node`, inline assertions, no framework). The `@cap/contracts` imports are
 * type-only and elide at compile, so this compiles standalone.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const parserSrc = join(__dirname, 'claude-transcript-parser.ts');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const outDir = mkdtempSync(join(apiRoot, '.claude-transcript-test-'));
function compile() {
  execFileSync(
    tscBin,
    [
      parserSrc,
      '--outDir', outDir,
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'ES2021',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const hit = findFile(outDir, 'claude-transcript-parser.js');
  if (hit) return hit;
  throw new Error('compiled claude-transcript-parser.js not found under ' + outDir);
}
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

const jsonl = (obj) => JSON.stringify(obj);
const SESSION = [
  jsonl({ type: 'user', cwd: '/home/gem/workspace', timestamp: '2026-06-12T09:30:00Z', message: { role: 'user', content: '修复登录页样式' } }),
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:30:05Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: '我先看相关文件。' }], stop_reason: null } }),
  // a tool_result-only user record (no text) — must be skipped:
  jsonl({ type: 'user', timestamp: '2026-06-12T09:30:08Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'app.tsx' }] } }),
  // a lifecycle/sidecar record — skipped, but its timestamp still bounds duration:
  jsonl({ type: 'system', timestamp: '2026-06-12T09:30:12Z', message: {} }),
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:31:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '已修复登录页样式。' }], stop_reason: 'end_turn' } }),
  '',
].join('\n');

async function main() {
  const { parseClaudeTranscript } = await import(pathToFileURL(compile()).href);

  const { turns, meta } = parseClaudeTranscript(SESSION);

  // ---- turn extraction (tool_result-only user record skipped) ----
  const kinds = turns.map((t) => t.kind);
  assert(
    JSON.stringify(kinds) === JSON.stringify(['user', 'assistant', 'assistant']),
    'turns are user → commentary → final answer (tool_result-only user record skipped)',
  );
  assert(turns[0].kind === 'user' && turns[0].text === '修复登录页样式', 'user turn carries the operator text');
  assert(turns[1].isFinalAnswer === false, 'stop_reason !== end_turn → not the final answer');
  assert(turns[2].isFinalAnswer === true && turns[2].text === '已修复登录页样式。', 'stop_reason === end_turn → final answer');

  // ---- meta ----
  assert(meta.cwd === '/home/gem/workspace', 'meta.cwd from the first carrying line');
  assert(meta.model === 'claude-opus-4-8', 'meta.model from the assistant message');
  assert(meta.startedAt === '2026-06-12T09:30:00Z', 'meta.startedAt from the first line timestamp');

  // ---- wire-transcript-real-data runtime parity ----
  assert(turns[0].at === '2026-06-12T09:30:00Z', 'a turn carries the producing line timestamp (at)');
  assert(turns[2].at === '2026-06-12T09:31:00Z', 'the final-answer turn carries its line timestamp');
  // duration spans first (09:30:00) → last seen line (the 09:31:00 assistant) = 60s.
  assert(meta.durationMs === 60000, 'meta.durationMs is last line ts − startedAt');
  assert(meta.totalTokens === undefined, 'totalTokens is OMITTED for the claude runtime (no clean per-turn delta)');

  // ---- at omitted when the line has no timestamp ----
  {
    const noTs = parseClaudeTranscript(jsonl({ type: 'user', message: { role: 'user', content: 'hi' } }));
    assert(noTs.turns[0] && noTs.turns[0].at === undefined, 'a turn with no source timestamp omits at (no fabrication)');
    assert(noTs.meta.durationMs === undefined, 'no resolvable start/end → durationMs omitted');
  }

  // ---- malformed line never aborts the parse ----
  {
    let threw = false;
    let result;
    try {
      result = parseClaudeTranscript('not json\n' + jsonl({ type: 'user', timestamp: '2026-06-12T09:30:00Z', message: { role: 'user', content: 'ok' } }) + '\n{bad');
    } catch { threw = true; }
    assert(!threw, 'a malformed line never aborts the parse');
    assert(result && result.turns.length === 1 && result.turns[0].text === 'ok', 'the parseable lines still yield their turns');
  }
}

let exitCode = 0;
console.log('\n=== claude-transcript-parser: claude session JSONL → render-contract ===\n');
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
