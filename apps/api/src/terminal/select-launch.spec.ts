/**
 * add-headless-execution-track — the interactive-vs-headless launch decision, now a pure
 * function, gets DIRECT coverage (previously buried in `AioPtyClient.launchAgent` behind a
 * WebSocket and untestable). Guards the riskiest branch of the live launch path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { selectLaunch } from './select-launch';
import { CodexRuntime } from '../agent-runtime/codex-runtime';
import { ClaudeCodeRuntime } from '../agent-runtime/claude-code-runtime';
import type {
  AgentRuntime,
  LaunchContext,
} from '../agent-runtime/agent-runtime.port';

const CTX: LaunchContext = {
  taskId: 't1',
  workspaceDir: '/home/gem/workspace',
  sessionId: '11111111-2222-3333-4444-555555555555',
};

test('interactive-pty codex: buildLaunchLine + declared DSR policy + arms autosubmit', () => {
  const codex = new CodexRuntime();
  const plan = selectLaunch(codex, 'interactive-pty', CTX, true);
  assert.equal(plan.line, codex.buildLaunchLine(CTX)); // byte-identical to the legacy path
  assert.equal(plan.terminalStartup.replyToStartupDSR, true);
  assert.equal(plan.terminalStartup.promptSubmit, 'cr-on-quiesce');
  assert.equal(plan.armAutoSubmit, true);
});

test('headless-exec codex: buildHeadlessLine, NO DSR handshake, NO autosubmit', () => {
  const plan = selectLaunch(new CodexRuntime(), 'headless-exec', CTX, true);
  assert.match(plan.line, /codex exec --json/);
  assert.equal(plan.terminalStartup.replyToStartupDSR, false);
  assert.equal(plan.terminalStartup.promptSubmit, 'none');
  assert.equal(plan.armAutoSubmit, false); // headless never arms the cr-on-quiesce timer
});

test('headless-exec claude: buildHeadlessLine, no handshake, no autosubmit', () => {
  const plan = selectLaunch(new ClaudeCodeRuntime(), 'headless-exec', CTX, true);
  assert.match(plan.line, /claude -p/);
  assert.equal(plan.terminalStartup.promptSubmit, 'none');
  assert.equal(plan.armAutoSubmit, false);
});

test('interactive-pty claude: declared none-submit never arms autosubmit', () => {
  const claude = new ClaudeCodeRuntime();
  const plan = selectLaunch(claude, 'interactive-pty', CTX, true);
  assert.equal(plan.line, claude.buildLaunchLine(CTX));
  assert.equal(plan.armAutoSubmit, false);
});

test('wantAutoSubmit=false never arms even a cr-on-quiesce runtime', () => {
  const plan = selectLaunch(new CodexRuntime(), 'interactive-pty', CTX, false);
  assert.equal(plan.armAutoSubmit, false);
});

test('headless-exec falls back to interactive when the runtime has no buildHeadlessLine', () => {
  // A future/partial runtime that does NOT provide a headless builder — selectLaunch must
  // NOT crash; it falls back to the interactive launch line + declared policy.
  const fake = {
    buildLaunchLine: () => 'INTERACTIVE_LINE',
    terminalStartup: {
      replyToStartupDSR: true,
      promptSubmit: 'cr-on-quiesce' as const,
    },
    // buildHeadlessLine intentionally absent
  } as unknown as AgentRuntime;
  const plan = selectLaunch(fake, 'headless-exec', CTX, true);
  assert.equal(plan.line, 'INTERACTIVE_LINE');
  assert.equal(plan.terminalStartup.promptSubmit, 'cr-on-quiesce');
});
