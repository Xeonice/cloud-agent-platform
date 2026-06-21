/**
 * Focused unit test for the codex rollout parser (session-sandbox-retention,
 * Track 2). Drives the REAL `rollout-parser.ts` (compiled with tsc, imported)
 * against a SYNTHETIC fixture whose line shapes mirror real codex 0.131 rollouts
 * (verified against 211 on-disk rollouts) — synthetic CONTENT, real STRUCTURE,
 * so no private conversation is embedded and the parser is exercised on the
 * exact `{timestamp,type,payload}` shapes it must handle in production.
 *
 * Covers (per tasks 2.2–2.5):
 *   - phase split: agent_message phase `commentary` vs `final_answer` → isFinalAnswer
 *   - call_id linkage: function_call_output attaches to its function_call turn
 *   - custom_tool_call (apply_patch) + its output linkage
 *   - token_count attaches to the preceding tool turn (per-turn delta)
 *   - the wrapped/encrypted response_item duplicates are NOT double-rendered
 *   - wrapper stripping on the exec-mode fallback (no user_message events)
 *
 * Mirrors the repo's `.test.mjs` convention (compile the real `.ts`, plain
 * `node`, inline assertions, no framework). The `@cap/contracts` imports in the
 * parser are type-only and elide at compile, so this compiles standalone.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const parserSrc = join(__dirname, 'rollout-parser.ts');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const outDir = mkdtempSync(join(apiRoot, '.rollout-parser-test-'));
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
  const flat = join(outDir, 'rollout-parser.js');
  if (existsSync(flat)) return flat;
  const hit = findFile(outDir, 'rollout-parser.js');
  if (hit) return hit;
  throw new Error('compiled rollout-parser.js not found under ' + outDir);
}
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

// ---- synthetic fixture (real codex 0.131 line shapes, synthetic content) ----
const jsonl = (obj) => JSON.stringify(obj);
const INTERACTIVE_ROLLOUT = [
  jsonl({ timestamp: '2026-06-01T10:00:00Z', type: 'session_meta', payload: { id: 'sess-1', timestamp: '2026-06-01T10:00:00Z', cwd: '/home/gem/workspace', cli_version: '0.131.0', source: 'cap' } }),
  jsonl({ timestamp: '2026-06-01T10:00:01Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5-codex', cwd: '/home/gem/workspace' } }),
  jsonl({ timestamp: '2026-06-01T10:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
  // operator's CLEAN typed prompt (the user-facing event):
  jsonl({ timestamp: '2026-06-01T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '修复登录页的样式问题', images: [] } }),
  // the wrapped DUPLICATE the model sees — must NOT become a 2nd user turn:
  jsonl({ timestamp: '2026-06-01T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>no rm -rf</permissions instructions>' }] } }),
  jsonl({ timestamp: '2026-06-01T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md ...\n修复登录页的样式问题' }] } }),
  // encrypted reasoning duplicate — skipped:
  jsonl({ timestamp: '2026-06-01T10:00:03Z', type: 'response_item', payload: { type: 'reasoning', summary: [], content: [], encrypted_content: 'REDACTED' } }),
  // commentary (process narration):
  jsonl({ timestamp: '2026-06-01T10:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: '我先看一下相关文件。', phase: 'commentary' } }),
  // tool 1: shell exec + its output linked by call_id:
  jsonl({ timestamp: '2026-06-01T10:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls src"}', call_id: 'call-1' } }),
  jsonl({ timestamp: '2026-06-01T10:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'app.tsx\nlogin.tsx' } }),
  // per-turn token delta — attaches to the exec tool turn:
  jsonl({ timestamp: '2026-06-01T10:00:05Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 }, last_token_usage: { total_tokens: 128 } } } }),
  // tool 2: apply_patch (custom_tool_call) + output:
  jsonl({ timestamp: '2026-06-01T10:00:06Z', type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call-2' } }),
  jsonl({ timestamp: '2026-06-01T10:00:07Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: 'Success' } }),
  // the FINAL answer (phase marker, not ordering):
  jsonl({ timestamp: '2026-06-01T10:00:08Z', type: 'event_msg', payload: { type: 'agent_message', message: '已修复登录页样式。', phase: 'final_answer' } }),
  jsonl({ timestamp: '2026-06-01T10:00:08Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '已修复登录页样式。' } }),
  '', // a trailing blank line (rollouts end with a newline) — must be tolerated
].join('\n');

// A non-interactive (`codex exec`) rollout: NO user_message events, so the user
// prompt is recovered from response_item role=user with the wrapper stripped.
const EXEC_ROLLOUT = [
  jsonl({ timestamp: '2026-06-02T10:00:00Z', type: 'session_meta', payload: { cwd: '/home/gem/workspace' } }),
  jsonl({ timestamp: '2026-06-02T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>be terse</user_instructions>把按钮改成蓝色' }] } }),
  jsonl({ timestamp: '2026-06-02T10:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: '完成。', phase: 'final_answer' } }),
].join('\n');

async function main() {
  const parserJs = compile();
  const { parseRollout, stripPromptWrapper } = await import(pathToFileURL(parserJs).href);

  // ---- 1) the interactive rollout parses into the expected ordered turns ----
  {
    const { turns, meta } = parseRollout(INTERACTIVE_ROLLOUT);

    assert(meta.cwd === '/home/gem/workspace', 'meta.cwd comes from session_meta');
    assert(meta.model === 'gpt-5-codex', 'meta.model comes from turn_context');
    assert(meta.startedAt === '2026-06-01T10:00:00Z', 'meta.startedAt comes from session_meta timestamp');
    // session totals (D5): one token delta (128) summed; duration = 10:00:08 − 10:00:00.
    assert(meta.totalTokens === 128, 'meta.totalTokens sums the rollout token deltas');
    assert(meta.durationMs === 8000, 'meta.durationMs is last line ts − startedAt');

    const kinds = turns.map((t) => t.kind);
    assert(
      JSON.stringify(kinds) === JSON.stringify(['user', 'assistant', 'tool', 'tool', 'assistant']),
      'turns are user → commentary → exec → apply_patch → final answer (wrapped/reasoning duplicates excluded)',
    );

    const user = turns[0];
    assert(user.kind === 'user' && user.text === '修复登录页的样式问题', 'user turn is the CLEAN operator prompt (from user_message)');
    assert(user.at === '2026-06-01T10:00:02Z', 'a turn carries the producing line timestamp (at)');

    const commentary = turns[1];
    assert(commentary.kind === 'assistant' && commentary.isFinalAnswer === false, 'phase=commentary → isFinalAnswer false');

    const exec = turns[2];
    assert(exec.kind === 'tool' && exec.name === 'exec_command', 'tool turn carries the function name');
    assert(exec.args === '{"cmd":"ls src"}', 'tool turn carries the raw arguments string');
    assert(exec.output === 'app.tsx\nlogin.tsx', 'function_call_output is linked to its call by call_id');
    assert(exec.tokenCount === 128, 'token_count last_token_usage attaches to the preceding tool turn');

    const patch = turns[3];
    assert(patch.kind === 'tool' && patch.name === 'apply_patch' && patch.args === '*** Begin Patch', 'custom_tool_call maps name + input → tool turn');
    assert(patch.output === 'Success', 'custom_tool_call_output links by call_id');
    assert(patch.tokenCount === undefined, 'a tool turn with no following token_count carries no count');
    assert(patch.diffstat === undefined, 'an apply_patch with no +/- lines carries no diffstat (honest omission)');
    assert(exec.diffstat === undefined, 'a non-apply_patch tool carries no diffstat');

    const final = turns[4];
    assert(final.kind === 'assistant' && final.isFinalAnswer === true && final.text === '已修复登录页样式。', 'phase=final_answer → isFinalAnswer true');

    // No empty/fabricated turns, and exactly ONE user turn (the duplicate role=user was skipped).
    assert(turns.filter((t) => t.kind === 'user').length === 1, 'the wrapped response_item role=user duplicate is NOT rendered as a second user turn');
  }

  // ---- 2) exec-mode fallback: user prompt recovered + wrapper stripped ----
  {
    const { turns } = parseRollout(EXEC_ROLLOUT);
    const user = turns.find((t) => t.kind === 'user');
    assert(user !== undefined, 'a rollout with no user_message events still recovers the user prompt from role=user');
    assert(user && user.text === '把按钮改成蓝色', 'the <user_instructions> wrapper is stripped, leaving only the operator text');
  }

  // ---- 3) stripPromptWrapper is conservative (passthrough when no wrapper) ----
  {
    assert(stripPromptWrapper('<permissions instructions>x</permissions instructions>真正的需求') === '真正的需求', 'strips a leading tagged instruction block');
    assert(stripPromptWrapper('# 我的标题\n正文') === '# 我的标题\n正文', 'a free-form prompt that merely starts with a heading is NOT stripped');
    assert(stripPromptWrapper('普通需求') === '普通需求', 'plain text passes through unchanged');
  }

  // ---- 4) empty / malformed input degrades honestly (never throws) ----
  {
    let threw = false;
    let result;
    try {
      result = parseRollout('not json\n{"type":"event_msg","payload":{"type":"user_message","message":"ok"}}\n{bad');
    } catch { threw = true; }
    assert(!threw, 'a malformed line never aborts the parse');
    assert(result && result.turns.length === 1 && result.turns[0].text === 'ok', 'the parseable lines still yield their turns');
    assert(parseRollout('').turns.length === 0, 'empty input yields zero turns (no fabrication)');
  }

  // ---- 5) diffstat from an apply_patch body; honest omission of at/totals ----
  {
    // An apply_patch whose patch body adds 2 and removes 1 line (context/headers
    // are not counted).
    const DIFFSTAT_ROLLOUT = [
      jsonl({ timestamp: '2026-06-03T10:00:00Z', type: 'session_meta', payload: { cwd: '/w' } }),
      jsonl({
        timestamp: '2026-06-03T10:00:01Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Update File: a.ts\n keep this\n+added one\n+added two\n-removed one\n*** End Patch',
          call_id: 'p1',
        },
      }),
    ].join('\n');
    const { turns: dturns } = parseRollout(DIFFSTAT_ROLLOUT);
    const patched = dturns.find((t) => t.kind === 'tool');
    assert(
      patched && patched.diffstat && patched.diffstat.add === 2 && patched.diffstat.del === 1,
      'apply_patch diffstat counts +2/−1 from the patch body (headers/context excluded)',
    );

    // A rollout with NO line timestamps and NO token data: at + totals omitted.
    const NO_META_ROLLOUT = [
      jsonl({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
    ].join('\n');
    const { turns: nturns, meta: nmeta } = parseRollout(NO_META_ROLLOUT);
    assert(nturns[0] && nturns[0].at === undefined, 'a turn with no source timestamp omits at (no fabrication)');
    assert(nmeta.totalTokens === undefined, 'no token data → totalTokens omitted (not zeroed)');
    assert(nmeta.durationMs === undefined, 'no resolvable start/end → durationMs omitted');
  }
}

let exitCode = 0;
console.log('\n=== rollout-parser: codex 0.131 rollout → render-contract ===\n');
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
