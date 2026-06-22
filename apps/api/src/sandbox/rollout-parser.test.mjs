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
    // CHANGED (D4): args is now the HUMAN-READABLE command (`arguments.cmd`), not the raw JSON envelope.
    assert(exec.args === 'ls src', 'exec_command tool turn carries the human-readable cmd (not raw JSON args)');
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

  // ---- 6) command extraction dispatches on TOOL NAME (D4) ------------------
  // For each branch: a POSITIVE case (the expected field present → readable command)
  // and an HONEST-OMISSION case (field absent/wrong-type → fall back to raw args).
  {
    const toolCall = (name, payload) =>
      jsonl({
        timestamp: '2026-06-04T10:00:01Z',
        type: 'response_item',
        payload: { type: 'function_call', name, call_id: 'c-' + name, ...payload },
      });
    const oneTool = (line) => {
      const { turns } = parseRollout(line);
      return turns.find((t) => t.kind === 'tool');
    };

    // exec_command → arguments.cmd (string)
    const exec1 = oneTool(toolCall('exec_command', { arguments: '{"cmd":"pnpm test"}' }));
    assert(exec1 && exec1.args === 'pnpm test', 'exec_command extracts arguments.cmd as the command');
    // exec_command honest omission: no `cmd` field → fall back to raw args string
    const exec2 = oneTool(toolCall('exec_command', { arguments: '{"workdir":"/w"}' }));
    assert(exec2 && exec2.args === '{"workdir":"/w"}', 'exec_command with no cmd falls back to the raw arguments string');

    // shell → arguments.command (array) joined by single spaces; workdir/timeout_ms dropped
    const shell1 = oneTool(toolCall('shell', { arguments: '{"command":["bash","-lc","ls -la"],"workdir":"/w","timeout_ms":5000}' }));
    assert(shell1 && shell1.args === 'bash -lc ls -la', 'shell joins arguments.command with single spaces (workdir/timeout_ms dropped)');
    // local_shell / container.exec share the same branch
    const localShell = oneTool(toolCall('local_shell', { arguments: '{"command":["echo","hi"]}' }));
    assert(localShell && localShell.args === 'echo hi', 'local_shell joins arguments.command');
    const containerExec = oneTool(toolCall('container.exec', { arguments: '{"command":["pwd"]}' }));
    assert(containerExec && containerExec.args === 'pwd', 'container.exec joins arguments.command');
    // shell honest omission: command is not an array → fall back to raw args
    const shell2 = oneTool(toolCall('shell', { arguments: '{"command":"not-an-array"}' }));
    assert(shell2 && shell2.args === '{"command":"not-an-array"}', 'shell with non-array command falls back to the raw arguments string');

    // apply_patch keeps its RAW input patch text verbatim (positive)
    const patchLine = jsonl({
      timestamp: '2026-06-04T10:00:02Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n+x\n*** End Patch', call_id: 'cp' },
    });
    const patchT = oneTool(patchLine);
    assert(patchT && patchT.args === '*** Begin Patch\n+x\n*** End Patch', 'apply_patch keeps its raw input patch text verbatim');

    // unknown tool / unparseable args → honest fallback to the raw arguments string
    const unknown = oneTool(toolCall('some_new_tool', { arguments: '{"foo":"bar"}' }));
    assert(unknown && unknown.args === '{"foo":"bar"}', 'an unmapped tool falls back to the raw arguments string');
    const garbled = oneTool(toolCall('exec_command', { arguments: 'not-json-at-all' }));
    assert(garbled && garbled.args === 'not-json-at-all', 'a non-JSON arguments envelope passes through unchanged');
  }

  // ---- 7) exec OUTPUT wrapper stripping is conservative (D4) ----------------
  // NEW wrapped-output fixture: the documented Exit code/Wall time/Total output
  // lines/Output:/(N lines omitted) grammar → keep only the body. Plus a format
  // mismatch that must PASS THROUGH unchanged.
  {
    const wrapped = [
      'Exit code: 0',
      'Wall time: 1.20s',
      'Total output lines: 2',
      'Output:',
      'app.tsx',
      'login.tsx',
      '(3 lines omitted)',
    ].join('\n');
    const WRAPPED_OUTPUT_ROLLOUT = [
      jsonl({ timestamp: '2026-06-05T10:00:00Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'w1' } }),
      jsonl({ timestamp: '2026-06-05T10:00:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'w1', output: wrapped } }),
    ].join('\n');
    const { turns: wturns } = parseRollout(WRAPPED_OUTPUT_ROLLOUT);
    const wtool = wturns.find((t) => t.kind === 'tool');
    assert(wtool && wtool.output === 'app.tsx\nlogin.tsx', 'exec output wrapper stripped to just the body (header + (N lines omitted) removed)');

    // A drifted/unrecognized wrapper (no header prefix) PASSES THROUGH unchanged.
    const PLAIN_OUTPUT_ROLLOUT = [
      jsonl({ timestamp: '2026-06-05T10:01:00Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'w2' } }),
      jsonl({ timestamp: '2026-06-05T10:01:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'w2', output: 'just plain output\nno wrapper here' } }),
    ].join('\n');
    const { turns: pturns } = parseRollout(PLAIN_OUTPUT_ROLLOUT);
    const ptool = pturns.find((t) => t.kind === 'tool');
    assert(ptool && ptool.output === 'just plain output\nno wrapper here', 'output with no recognized wrapper passes through unchanged');

    // A header-only wrapper that would empty a body-carrying output passes through.
    const HEADER_ONLY_ROLLOUT = [
      jsonl({ timestamp: '2026-06-05T10:02:00Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'w3' } }),
      jsonl({ timestamp: '2026-06-05T10:02:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'w3', output: 'Exit code: 0\nWall time: 0.1s' } }),
    ].join('\n');
    const { turns: hturns } = parseRollout(HEADER_ONLY_ROLLOUT);
    const htool = hturns.find((t) => t.kind === 'tool');
    assert(htool && htool.output === 'Exit code: 0\nWall time: 0.1s', 'a header-only wrapper (no Output: body) passes through, never emptied');
  }

  // ---- 8) dedup ADJACENT identical user turns; preserve non-adjacent (D4) ---
  {
    // event_msg user_message + response_item role=user double-write of the SAME
    // prompt. With a user_message event present the response_item fallback is
    // suppressed anyway, so simulate the adjacency directly via two user_message
    // events (the double-write codex emits) and a non-adjacent repeat.
    const DEDUP_ROLLOUT = [
      jsonl({ timestamp: '2026-06-06T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '同一个问题' } }),
      jsonl({ timestamp: '2026-06-06T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '同一个问题' } }),
      jsonl({ timestamp: '2026-06-06T10:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: '好的', phase: 'commentary' } }),
      // non-adjacent identical user turn (separated by the assistant turn) → KEPT
      jsonl({ timestamp: '2026-06-06T10:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: '同一个问题' } }),
    ].join('\n');
    const { turns: dturns } = parseRollout(DEDUP_ROLLOUT);
    const userTurns = dturns.filter((t) => t.kind === 'user');
    assert(userTurns.length === 2, 'an ADJACENT identical user turn is deduped (2 of 3 survive: one collapsed, one non-adjacent kept)');
    assert(
      JSON.stringify(dturns.map((t) => t.kind)) === JSON.stringify(['user', 'assistant', 'user']),
      'dedup collapses the adjacent pair but preserves the non-adjacent repeat',
    );
  }

  // ---- 9) filter <environment_context> / <system-reminder> wrappers (D4) ----
  {
    // pure-wrapper payload → NO user turn
    const PURE_WRAPPER = [
      jsonl({ timestamp: '2026-06-07T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>cwd=/w</environment_context>' } }),
      jsonl({ timestamp: '2026-06-07T10:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: '收到', phase: 'final_answer' } }),
    ].join('\n');
    const { turns: pw } = parseRollout(PURE_WRAPPER);
    assert(pw.filter((t) => t.kind === 'user').length === 0, 'a pure <environment_context> wrapper payload emits NO user turn');

    const PURE_REMINDER = [
      jsonl({ timestamp: '2026-06-07T10:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: '<system-reminder>be careful</system-reminder>' } }),
    ].join('\n');
    assert(parseRollout(PURE_REMINDER).turns.filter((t) => t.kind === 'user').length === 0, 'a pure <system-reminder> wrapper payload emits NO user turn');

    // wrapped operator message → degrade to ONLY the operator text
    const WRAPPED_OPERATOR = [
      jsonl({ timestamp: '2026-06-07T10:02:00Z', type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>cwd=/w</environment_context>真正的需求' } }),
    ].join('\n');
    const { turns: wo } = parseRollout(WRAPPED_OPERATOR);
    const woUser = wo.find((t) => t.kind === 'user');
    assert(woUser && woUser.text === '真正的需求', 'a wrapped operator message degrades to only the operator text');

    // plain operator text with no wrapper passes through unchanged
    const PLAIN_USER = [
      jsonl({ timestamp: '2026-06-07T10:03:00Z', type: 'event_msg', payload: { type: 'user_message', message: '普通需求' } }),
    ].join('\n');
    assert(parseRollout(PLAIN_USER).turns.find((t) => t.kind === 'user').text === '普通需求', 'a user_message with no wrapper passes through unchanged');
  }

  // ---- 10) UNCHANGED guarantees: diffstat, totals, phase-keyed final, no system ----
  // Re-parse the full interactive rollout and assert the behaviors Part 2 did NOT
  // touch remain exactly as before.
  {
    const { turns, meta } = parseRollout(INTERACTIVE_ROLLOUT);
    // diffstat path unchanged: apply_patch with no +/- body still omits diffstat.
    const patch = turns.find((t) => t.kind === 'tool' && t.name === 'apply_patch');
    assert(patch && patch.diffstat === undefined, 'UNCHANGED: apply_patch with no +/- body still omits diffstat');
    // session totals unchanged.
    assert(meta.totalTokens === 128 && meta.durationMs === 8000, 'UNCHANGED: session totals (totalTokens/durationMs)');
    // phase-keyed final answer unchanged.
    const finals = turns.filter((t) => t.kind === 'assistant' && t.isFinalAnswer === true);
    assert(finals.length === 1 && finals[0].text === '已修复登录页样式。', 'UNCHANGED: phase=final_answer remains the single isFinalAnswer:true turn');
    const commentaries = turns.filter((t) => t.kind === 'assistant' && t.isFinalAnswer === false);
    assert(commentaries.length === 1, 'UNCHANGED: reasoning/commentary stays assistant{isFinalAnswer:false} (the 「推理」 channel)');
    // the parser NEVER emits system turns (that merge stays in the controller/service).
    assert(turns.every((t) => t.kind !== 'system'), 'UNCHANGED: the parser emits NO system turns (audit merge stays outside the parser)');

    // diffstat still computed from a real apply_patch body (the +2/−1 fixture path).
    const DIFFSTAT_ROLLOUT = [
      jsonl({ timestamp: '2026-06-08T10:00:00Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n keep\n+a\n+b\n-c\n*** End Patch', call_id: 'dp' } }),
    ].join('\n');
    const dpatch = parseRollout(DIFFSTAT_ROLLOUT).turns.find((t) => t.kind === 'tool');
    assert(dpatch && dpatch.diffstat && dpatch.diffstat.add === 2 && dpatch.diffstat.del === 1, 'UNCHANGED: apply_patch diffstat counts +2/−1 from the raw patch body');
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
