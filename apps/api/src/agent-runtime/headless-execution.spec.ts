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

const CTX: LaunchContext = {
  taskId: 'task-abc',
  workspaceDir: '/home/gem/workspace',
  sessionId: '11111111-2222-3333-4444-555555555555',
};

// ---------------------------------------------------------------------------
// 7.1 — codex headless / resume argv (golden)
// ---------------------------------------------------------------------------

test('CodexRuntime.buildHeadlessLine is exec --json, stdin-closed, skip-git, danger-full-access', () => {
  const line = new CodexRuntime().buildHeadlessLine(CTX);
  assert.match(line, /codex exec --json/);
  assert.match(line, /< \/dev\/null/); // MANDATORY: codex 0.131 hangs on stdin otherwise
  assert.match(line, /--skip-git-repo-check/);
  assert.match(line, /--sandbox danger-full-access/);
  assert.match(line, /--ask-for-approval never/);
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

test('parseClaudeTranscript extracts user/assistant turns and skips non-conversational types', () => {
  const { turns, meta } = parseClaudeTranscript(CLAUDE_JSONL);
  assert.deepEqual(
    turns.map((t) => t.kind),
    ['user', 'assistant'],
  );
  assert.equal(turns[0]!.kind === 'user' && turns[0]!.text, 'summarize this repo');
  assert.ok(turns[1]!.kind === 'assistant' && turns[1]!.text === 'It is a demo repo.');
  assert.ok(turns[1]!.kind === 'assistant' && turns[1]!.isFinalAnswer === true);
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
