/**
 * Focused unit test for the Claude Code session-JSONL parser
 * (add-headless-execution-track + wire-transcript-real-data runtime parity +
 * unify-transcript-parsers Track 5 tool dimension).
 * Drives the REAL `claude-transcript-parser.ts` (compiled with tsc, imported)
 * against a SYNTHETIC fixture whose line shapes mirror real claude 2.1.183
 * sessions — synthetic CONTENT, real STRUCTURE.
 *
 * Covers:
 *   - user / assistant turn extraction; `stop_reason === 'end_turn'` → final answer
 *   - tool_result-only user records (no text) are skipped (no spurious user turn)
 *   - meta cwd/model/startedAt come from the first carrying line
 *   - wire-transcript-real-data: per-turn `at` carried from the line timestamp
 *     (omitted when absent); session `durationMs` = last − first timestamp;
 *     `totalTokens` is OMITTED for this runtime (no clean per-turn delta)
 *   - a malformed line never aborts the parse
 *   - unify-transcript-parsers Track 5 (D5/D6): a `tool_use` block → a tool turn
 *     via the per-tool field map (Bash.command / Grep.pattern / Read·Edit·Write
 *     .file_path), with a string-vs-object `input` guard and a stable fallback
 *     for unmapped tools / absent fields; `tool_result` (in a SUBSEQUENT user
 *     entry) pairs by `tool_use_id` → output; an unmatched call keeps
 *     `output: null`; an externalized/missing result degrades to
 *     `[output unavailable]`; `thinking` → assistant{isFinalAnswer:false}; new
 *     tool/thinking turns carry `at`; no `system` turns are ever emitted.
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
  // assistant turn that interleaves thinking → tool_use → commentary text:
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:30:05Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [
    { type: 'thinking', thinking: '先列出 src 目录看看结构。' },
    // Bash → command field map; input is a parsed OBJECT (modern claude ≥ 2.1.92):
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls src', description: 'list src' } },
    { type: 'text', text: '我先看相关文件。' },
  ], stop_reason: 'tool_use' } }),
  // the tool_result for toolu_1 lives in a SUBSEQUENT user entry (no operator text):
  jsonl({ type: 'user', timestamp: '2026-06-12T09:30:08Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'app.tsx\nlogin.tsx' }] } }),
  // assistant turn: a Read (file_path map) + an unmapped tool (stable fallback)
  // + a Grep whose input is a JSON STRING (pre-v2.1.92 shape):
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:30:20Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/home/gem/workspace/login.tsx' } },
    { type: 'tool_use', id: 'toolu_3', name: 'WebFetch', input: { url: 'https://example.com', prompt: 'fetch' } },
    { type: 'tool_use', id: 'toolu_4', name: 'Grep', input: '{"pattern":"className","path":"login.tsx"}' },
  ], stop_reason: 'tool_use' } }),
  // results for toolu_2 (object-content) and toolu_4 (string); toolu_3 has an
  // externalized/missing result → must degrade to [output unavailable]. The
  // tool_result for toolu_3 carries no readable content. toolu_2's result is an
  // array of text blocks. Mixed in the same subsequent user entry — no user turn:
  jsonl({ type: 'user', timestamp: '2026-06-12T09:30:25Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: '<div className="login" />' }] },
    { type: 'tool_result', tool_use_id: 'toolu_3', content: [] },
    { type: 'tool_result', tool_use_id: 'toolu_4', content: 'login.tsx:12: className="login"' },
  ] } }),
  // an UNMATCHED tool_use: no tool_result ever arrives → output stays null:
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:30:40Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_5', name: 'Edit', input: { file_path: '/home/gem/workspace/login.tsx', old_string: 'a', new_string: 'b' } },
  ], stop_reason: 'tool_use' } }),
  // a lifecycle/sidecar record — skipped, but its timestamp still bounds duration:
  jsonl({ type: 'system', timestamp: '2026-06-12T09:30:50Z', message: {} }),
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:31:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '已修复登录页样式。' }], stop_reason: 'end_turn' } }),
  '',
].join('\n');

async function main() {
  const { parseClaudeTranscript } = await import(pathToFileURL(compile()).href);

  const { turns, meta } = parseClaudeTranscript(SESSION);

  // ---- turn extraction: thinking → tool → text → tool → … (ordered) ----
  // Expected ordered stream:
  //   user(修复…) → assistant·thinking(先列出…) → tool(Bash) → assistant(我先看…)
  //   → tool(Read) → tool(WebFetch) → tool(Grep) → tool(Edit) → assistant(已修复…)
  const kinds = turns.map((t) => t.kind);
  assert(
    JSON.stringify(kinds) === JSON.stringify([
      'user', 'assistant', 'tool', 'assistant', 'tool', 'tool', 'tool', 'tool', 'assistant',
    ]),
    'ordered stream interleaves user / assistant(thinking+text) / tool turns; no system turns',
  );
  assert(!kinds.includes('system'), 'the parser never emits a system turn (audit-merge stays in the controller)');

  assert(turns[0].kind === 'user' && turns[0].text === '修复登录页样式', 'user turn carries the operator text');

  // ---- thinking → assistant{isFinalAnswer:false} (D6 「推理」 channel) ----
  assert(
    turns[1].kind === 'assistant' && turns[1].isFinalAnswer === false && turns[1].text === '先列出 src 目录看看结构。',
    'thinking block → assistant reasoning turn (isFinalAnswer:false)',
  );

  // ---- tool_use → tool turn via the per-tool field map (object input) ----
  assert(turns[2].kind === 'tool' && turns[2].name === 'Bash', 'tool_use → tool turn carries the tool name');
  assert(turns[2].args === 'ls src', 'Bash.command field map → args is the command (not the raw JSON blob)');
  // ---- tool_result paired by tool_use_id from the SUBSEQUENT user entry ----
  assert(turns[2].output === 'app.tsx\nlogin.tsx', 'tool_result (subsequent user entry) pairs to its tool_use by id → output');

  // commentary text after the tool, isFinalAnswer:false (stop_reason !== end_turn):
  assert(
    turns[3].kind === 'assistant' && turns[3].isFinalAnswer === false && turns[3].text === '我先看相关文件。',
    'assistant text block → commentary turn (isFinalAnswer:false)',
  );

  // ---- field map: Read.file_path, unmapped tool fallback, Grep w/ STRING input ----
  assert(turns[4].kind === 'tool' && turns[4].name === 'Read' && turns[4].args === '/home/gem/workspace/login.tsx', 'Read.file_path field map → args is the path');
  assert(turns[4].output === '<div className="login" />', 'array-of-text tool_result content joins into the paired output');
  // unmapped tool (WebFetch): stable serialization of the whole input, NOT empty:
  assert(turns[5].kind === 'tool' && turns[5].name === 'WebFetch', 'unmapped tool keeps its name');
  assert(
    turns[5].args === JSON.stringify({ url: 'https://example.com', prompt: 'fetch' }),
    'an unmapped tool falls back to a stable serialization of the whole input',
  );
  // [output unavailable] degradation for the externalized/missing result:
  assert(turns[5].output === '[output unavailable]', 'an externalized/missing frozen-sandbox result degrades to [output unavailable]');
  // Grep with a pre-v2.1.92 JSON-STRING input: the guard parses it, field map hits:
  assert(turns[6].kind === 'tool' && turns[6].name === 'Grep' && turns[6].args === 'className', 'string-input guard parses pre-v2.1.92 JSON-string input, then Grep.pattern field map applies');
  assert(turns[6].output === 'login.tsx:12: className="login"', 'string tool_result content pairs to the call output');

  // ---- unmatched tool_use: no result ever arrives → output stays null ----
  assert(turns[7].kind === 'tool' && turns[7].name === 'Edit' && turns[7].args === '/home/gem/workspace/login.tsx', 'Edit.file_path field map → args is the path');
  assert(turns[7].output === null, 'an unmatched tool_use (no tool_result) emits output: null');

  // ---- final answer ----
  assert(turns[8].kind === 'assistant' && turns[8].isFinalAnswer === true && turns[8].text === '已修复登录页样式。', 'stop_reason === end_turn → final answer');

  // ---- meta ----
  assert(meta.cwd === '/home/gem/workspace', 'meta.cwd from the first carrying line');
  assert(meta.model === 'claude-opus-4-8', 'meta.model from the assistant message');
  assert(meta.startedAt === '2026-06-12T09:30:00Z', 'meta.startedAt from the first line timestamp');

  // ---- wire-transcript-real-data runtime parity (at on new tool/thinking turns) ----
  assert(turns[0].at === '2026-06-12T09:30:00Z', 'a turn carries the producing line timestamp (at)');
  assert(turns[1].at === '2026-06-12T09:30:05Z', 'a thinking turn carries its source line timestamp (at)');
  assert(turns[2].at === '2026-06-12T09:30:05Z', 'a tool turn carries its source line timestamp (at)');
  assert(turns[8].at === '2026-06-12T09:31:00Z', 'the final-answer turn carries its line timestamp');
  // duration spans first (09:30:00) → last seen line (the 09:31:00 assistant) = 60s.
  assert(meta.durationMs === 60000, 'meta.durationMs is last line ts − startedAt');
  assert(meta.totalTokens === undefined, 'totalTokens is OMITTED for the claude runtime (no clean per-turn delta)');

  // ---- at omitted when the line has no timestamp (tool turn, honest omission) ----
  {
    const noTs = parseClaudeTranscript(jsonl({ type: 'user', message: { role: 'user', content: 'hi' } }));
    assert(noTs.turns[0] && noTs.turns[0].at === undefined, 'a turn with no source timestamp omits at (no fabrication)');
    assert(noTs.meta.durationMs === undefined, 'no resolvable start/end → durationMs omitted');

    const noTsTool = parseClaudeTranscript(
      jsonl({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' } }),
    );
    assert(noTsTool.turns[0] && noTsTool.turns[0].kind === 'tool' && noTsTool.turns[0].at === undefined, 'a tool turn with no source timestamp omits at (no fabrication)');
  }

  // ---- a tool_result-only user entry never emits a spurious user turn ----
  {
    const r = parseClaudeTranscript([
      jsonl({ type: 'assistant', timestamp: '2026-06-12T10:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'pwd' } }], stop_reason: 'tool_use' } }),
      jsonl({ type: 'user', timestamp: '2026-06-12T10:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '/home' }] } }),
    ].join('\n'));
    assert(JSON.stringify(r.turns.map((t) => t.kind)) === JSON.stringify(['tool']), 'a tool_result-only user entry is consumed without a spurious user turn');
    assert(r.turns[0].output === '/home', 'and its result still pairs to the tool turn');
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
