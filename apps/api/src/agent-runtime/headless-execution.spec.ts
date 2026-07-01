/**
 * add-headless-execution-track — unit coverage for the headless launch lines, the
 * runtime→format mapping, and the claude transcript parser dispatch. Pure + dependency-free
 * (no Nest/Prisma/container), matching the other agent-runtime specs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CodexRuntime } from './codex-runtime';
import { ClaudeCodeRuntime } from './claude-code-runtime';
import {
  transcriptFormatForRuntime,
  type LaunchContext,
} from './agent-runtime.port';
import { parseClaudeTranscript } from '../sandbox/claude-transcript-parser';
import { parseTranscript } from '../sandbox/parse-transcript';
import {
  headlessExitFile,
  wrapHeadlessDetachedSession,
} from '../terminal/codex-launch';
import { exitCodeFromExecBody } from '@cap/sandbox';

const CTX: LaunchContext = {
  taskId: 'task-abc',
  workspaceDir: '/home/gem/workspace',
  sessionId: '11111111-2222-3333-4444-555555555555',
};

// ---------------------------------------------------------------------------
// 7.1 — codex headless / resume argv (golden)
// ---------------------------------------------------------------------------

test('CodexRuntime.buildHeadlessLine uses the codex exec bypass flag, stdin-closed, skip-git', () => {
  const line = new CodexRuntime().buildHeadlessLine(CTX);
  assert.match(line, /codex exec --json/);
  assert.match(line, /< \/dev\/null/); // MANDATORY: codex 0.131 hangs on stdin otherwise
  assert.match(line, /--skip-git-repo-check/);
  // fix-headless-execution-container-gaps: `codex exec` accepts the SINGLE bypass flag...
  assert.match(line, /--dangerously-bypass-approvals-and-sandbox/);
  // ...and REJECTS the interactive top-level flags (passing them aborted exec → no-rollout).
  assert.doesNotMatch(line, /--ask-for-approval/);
  assert.doesNotMatch(line, /--sandbox /);
  assert.doesNotMatch(line, /--dangerously-bypass-hook-trust/);
});

test('CodexRuntime.buildResumeLine is exec resume with --skip-git and NO -s', () => {
  const line = new CodexRuntime().buildResumeLine(CTX, 'sess-7');
  assert.match(line, /codex exec resume sess-7/);
  assert.match(line, /--json/);
  assert.match(line, /--skip-git-repo-check/);
  assert.match(line, /< \/dev\/null/);
  // exec resume REJECTS -s/--sandbox (sandbox inherited). Check the CODEX command
  // portion only — the tmux wrapper's own `-s <session>` flag is unrelated.
  const codexCmd = line.slice(line.indexOf('codex exec resume'));
  assert.doesNotMatch(codexCmd, /(^|\s)-s(\s|$)/);
  assert.doesNotMatch(codexCmd, /--sandbox/);
});

test('ClaudeCodeRuntime.buildHeadlessLine is claude -p stream-json with --session-id, stdin-closed', () => {
  const line = new ClaudeCodeRuntime().buildHeadlessLine(CTX);
  assert.match(line, /claude -p/);
  assert.match(line, /--output-format stream-json/);
  assert.match(line, /--verbose/); // stream-json REQUIRES --verbose — pin it
  assert.match(line, /--dangerously-skip-permissions/);
  assert.match(line, new RegExp(`--session-id ${CTX.sessionId}`));
  assert.match(line, /< \/dev\/null/);
});

test('both runtimes declare headless-exec support', () => {
  assert.ok(new CodexRuntime().executionModes.has('headless-exec'));
  assert.ok(new ClaudeCodeRuntime().executionModes.has('headless-exec'));
});

test('contract: a runtime declaring headless-exec MUST provide the headless builders', () => {
  // Catches a future runtime that lists headless-exec in `executionModes` but forgets
  // to implement buildHeadlessLine/buildResumeLine (selectLaunch would silently fall back).
  for (const rt of [new CodexRuntime(), new ClaudeCodeRuntime()]) {
    if (rt.executionModes.has('headless-exec')) {
      assert.equal(typeof rt.buildHeadlessLine, 'function', `${rt.id} buildHeadlessLine`);
      assert.equal(typeof rt.buildResumeLine, 'function', `${rt.id} buildResumeLine`);
    }
  }
});

// ---------------------------------------------------------------------------
// runtime → transcript layout + format
// ---------------------------------------------------------------------------

test('transcriptArtifact: codex declares ~/.codex/sessions + rollout glob', () => {
  const { dir, filenameGlob } = new CodexRuntime().transcriptArtifact(CTX);
  assert.equal(dir, '/home/gem/.codex/sessions');
  assert.ok(filenameGlob.test('rollout-2026-06-20T17-47-55-abc.jsonl'));
  assert.equal(filenameGlob.test('history.jsonl'), false);
});

test('transcriptArtifact: claude declares ~/.claude/projects/<slug>/<session>.jsonl', () => {
  const { dir, filenameGlob } = new ClaudeCodeRuntime().transcriptArtifact(CTX);
  assert.equal(dir, '/home/gem/.claude/projects/-home-gem-workspace');
  assert.ok(filenameGlob.test(`${CTX.sessionId}.jsonl`));
  assert.equal(filenameGlob.test('other-session.jsonl'), false);
});

test('transcriptFormatForRuntime agrees with each runtime declared transcriptFormat', () => {
  assert.equal(transcriptFormatForRuntime('codex'), new CodexRuntime().transcriptFormat);
  assert.equal(
    transcriptFormatForRuntime('claude-code'),
    new ClaudeCodeRuntime().transcriptFormat,
  );
  // absent → codex default
  assert.equal(transcriptFormatForRuntime(null), 'codex-rollout');
});

// ---------------------------------------------------------------------------
// 7.2 / 7.3 — claude JSONL parser + dispatch
// ---------------------------------------------------------------------------

const CLAUDE_JSONL = [
  JSON.stringify({ type: 'queue-operation', uuid: 'q1' }),
  JSON.stringify({ type: 'attachment', uuid: 'a1' }),
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    cwd: '/home/gem/workspace',
    timestamp: '2026-06-20T00:00:00Z',
    message: { role: 'user', content: 'summarize this repo' },
  }),
  JSON.stringify({ type: 'last-prompt', uuid: 'lp1' }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'as1',
    message: {
      role: 'assistant',
      model: 'claude-opus',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'It is a demo repo.' },
      ],
    },
  }),
  JSON.stringify({ type: 'rate_limit_event', uuid: 'rl1' }),
  // a user record whose content is purely tool_result blocks (no text) → skipped
  JSON.stringify({
    type: 'user',
    uuid: 'u2',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
  }),
  '{ torn final line', // defensive: a torn line never aborts the parse
].join('\n');

test('parseClaudeTranscript extracts user/thinking/assistant turns and skips non-conversational types', () => {
  const { turns, meta } = parseClaudeTranscript(CLAUDE_JSONL);
  // unify-transcript-parsers (D6): the assistant `thinking` block now surfaces as
  // a reasoning turn (assistant{isFinalAnswer:false}) ahead of the final answer;
  // the lifecycle/sidecar + tool_result-only records are still skipped.
  assert.deepEqual(
    turns.map((t) => t.kind),
    ['user', 'assistant', 'assistant'],
  );
  assert.equal(turns[0]!.kind === 'user' && turns[0]!.text, 'summarize this repo');
  assert.ok(
    turns[1]!.kind === 'assistant' && turns[1]!.text === 'hmm' && turns[1]!.isFinalAnswer === false,
    'the thinking block becomes a reasoning turn (isFinalAnswer false)',
  );
  assert.ok(
    turns[2]!.kind === 'assistant' &&
      turns[2]!.text === 'It is a demo repo.' &&
      turns[2]!.isFinalAnswer === true,
    'the text block becomes the final answer (stop_reason end_turn)',
  );
  assert.equal(meta.model, 'claude-opus');
  assert.equal(meta.cwd, '/home/gem/workspace');
});

test('parseTranscript dispatches claude-jsonl to the claude parser', () => {
  const direct = parseClaudeTranscript(CLAUDE_JSONL);
  const dispatched = parseTranscript(CLAUDE_JSONL, 'claude-jsonl');
  assert.deepEqual(dispatched.turns, direct.turns);
});

test('parseTranscript dispatches codex-rollout to the codex parser', () => {
  const codexRollout = [
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hi' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'hello', phase: 'final_answer' },
    }),
  ].join('\n');
  const { turns } = parseTranscript(codexRollout, 'codex-rollout');
  assert.deepEqual(
    turns.map((t) => t.kind),
    ['user', 'assistant'],
  );
});

// ---------------------------------------------------------------------------
// fix-headless-execution-container-gaps — headless exit-code sentinel wrap
// ---------------------------------------------------------------------------

test('wrapHeadlessDetachedSession appends the exit sentinel inside the single-quoted inner', () => {
  assert.equal(headlessExitFile('task-abc'), '/home/gem/.cap-headless-task-abc.exit');
  const line = wrapHeadlessDetachedSession('task-abc', 'AGENT_CMD', '/home/gem/workspace');
  // `; echo $? > <sentinel>` is appended AFTER the agent command, inside the tmux word
  assert.match(
    line,
    /'AGENT_CMD; echo \$\? > \/home\/gem\/\.cap-headless-task-abc\.exit'$/,
  );
  // exactly one single-quote PAIR — the appended segment adds no quote (invariant holds)
  assert.equal((line.match(/'/g) || []).length, 2);
});

test('headless lines write the exit sentinel; interactive lines do NOT (both runtimes)', () => {
  // headless → captures $? for resolveExitStatus to read
  assert.match(new CodexRuntime().buildHeadlessLine(CTX), /echo \$\? > .*cap-headless/);
  assert.match(new ClaudeCodeRuntime().buildHeadlessLine(CTX), /echo \$\? > .*cap-headless/);
  // interactive (console) path is unchanged — no sentinel, no behavioural drift
  assert.doesNotMatch(new CodexRuntime().buildLaunchLine(CTX), /cap-headless/);
  assert.doesNotMatch(new ClaudeCodeRuntime().buildLaunchLine(CTX), /cap-headless/);
});

test('exitCodeFromExecBody reads the live AIO data-nested exec shape (the deploy defect)', () => {
  // The live AIO server NESTS the exec result under `data`; the cat'd sentinel content
  // (the AGENT's exit code) is in output/stdout. This is the shape the first fix missed.
  assert.equal(exitCodeFromExecBody({ success: true, data: { output: '0\n' } }), 0);
  assert.equal(exitCodeFromExecBody({ data: { stdout: '1\n' } }), 1);
  // flat shape (other servers) still works via the `data ?? top` unwrap
  assert.equal(exitCodeFromExecBody({ output: '0\n' }), 0);
  // `exit_code` is `cat`'s OWN exit, NOT the agent's — it MUST NOT be read in its place
  assert.equal(exitCodeFromExecBody({ data: { exit_code: 0, output: '137\n' } }), 137);
  // missing / unparseable → null → resolveExitStatus falls back to wait/echo
  assert.equal(exitCodeFromExecBody({ data: {} }), null);
  assert.equal(exitCodeFromExecBody(null), null);
});
