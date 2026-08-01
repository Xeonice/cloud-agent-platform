/**
 * Codex harness maker — CONSTRUCTION + ENVIRONMENT HOOKS ONLY. Every assertion
 * lives in the suite-owned scenario modules (`../scenarios/*`); this module
 * contributes the runtime construction (via the seed bridge), the launch
 * expectations, the byte-identical golden fixtures, and the credential stubs.
 *
 * Fixture provenance (moved, not regenerated):
 *   - the GOLDEN detached launch line: `apps/api/src/agent-runtime/
 *     codex-launch.test.mjs` (`GOLDEN_DETACHED`, task 1.1 golden);
 *   - the rollout transcript fixture: `apps/api/src/sandbox/
 *     rollout-parser.test.mjs` (`INTERACTIVE_ROLLOUT` — synthetic content,
 *     real codex 0.131 line shapes);
 *   - flag expectations: `apps/api/src/agent-runtime/agent-runtime.test.mjs`
 *     and `headless-execution.spec.ts`.
 */
import { headlessExitFile } from '@cap-console/sandbox';

import type {
  ConformanceLaunchContext,
  RuntimeHarness,
  RuntimeHarnessMaker,
  RuntimeSeedBridge,
} from '../harness.js';

const TASK_ID = 'b3ee3f63';
const WORKSPACE_DIR = '/home/gem/workspace';

const CONTEXT: ConformanceLaunchContext = {
  taskId: TASK_ID,
  workspaceDir: WORKSPACE_DIR,
  model: { kind: 'runtime-default' },
};

/**
 * 1.1 GOLDEN (moved byte-identical from `codex-launch.test.mjs`): the FULL
 * detached codex launch line — the tmux wrapper, the `$(cat …)` positional
 * prompt delivery, the bypass argv, and the focus-events suffix.
 */
const GOLDEN_DETACHED_LAUNCH_LINE =
  `tmux -u new-session -d -s taskb3ee3f63 -c /home/gem/workspace ` +
  `'P="$(cat /home/gem/.codex/task-prompt.txt 2>/dev/null)"; ` +
  `if [ -n "$P" ]; then codex -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox "$P"; ` +
  `else codex -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox; fi' ` +
  `\\; set-option -t taskb3ee3f63: focus-events on`;

/** One unique value reused by every secret-leak assertion (canary vocabulary). */
const CANARY = 'CANARY-cap-runtime-conformance-5f2a8e';

// Rollout transcript fixture — moved from `rollout-parser.test.mjs`
// (`INTERACTIVE_ROLLOUT`): synthetic content, real codex 0.131 line shapes.
const jsonl = (obj: unknown): string => JSON.stringify(obj);
const INTERACTIVE_ROLLOUT = [
  jsonl({ timestamp: '2026-06-01T10:00:00Z', type: 'session_meta', payload: { id: 'sess-1', timestamp: '2026-06-01T10:00:00Z', cwd: '/home/gem/workspace', cli_version: '0.131.0', source: 'cap' } }),
  jsonl({ timestamp: '2026-06-01T10:00:01Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5-codex', cwd: '/home/gem/workspace' } }),
  jsonl({ timestamp: '2026-06-01T10:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
  jsonl({ timestamp: '2026-06-01T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '修复登录页的样式问题', images: [] } }),
  jsonl({ timestamp: '2026-06-01T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>no rm -rf</permissions instructions>' }] } }),
  jsonl({ timestamp: '2026-06-01T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md ...\n修复登录页的样式问题' }] } }),
  jsonl({ timestamp: '2026-06-01T10:00:03Z', type: 'response_item', payload: { type: 'reasoning', summary: [], content: [], encrypted_content: 'REDACTED' } }),
  jsonl({ timestamp: '2026-06-01T10:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: '我先看一下相关文件。', phase: 'commentary' } }),
  jsonl({ timestamp: '2026-06-01T10:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls src"}', call_id: 'call-1' } }),
  jsonl({ timestamp: '2026-06-01T10:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'app.tsx\nlogin.tsx' } }),
  jsonl({ timestamp: '2026-06-01T10:00:05Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 }, last_token_usage: { total_tokens: 128 } } } }),
  jsonl({ timestamp: '2026-06-01T10:00:06Z', type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call-2' } }),
  jsonl({ timestamp: '2026-06-01T10:00:07Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: 'Success' } }),
  jsonl({ timestamp: '2026-06-01T10:00:08Z', type: 'event_msg', payload: { type: 'agent_message', message: '已修复登录页样式。', phase: 'final_answer' } }),
  jsonl({ timestamp: '2026-06-01T10:00:08Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '已修复登录页样式。' } }),
  '', // trailing blank line (rollouts end with a newline) — must be tolerated
].join('\n');

export const codexHarnessMaker: RuntimeHarnessMaker = {
  runtimeId: 'codex',
  async make(bridge: RuntimeSeedBridge): Promise<RuntimeHarness> {
    const runtime = await bridge.constructRuntime('codex');
    return {
      runtime,
      hooks: {
        launch: {
          context: CONTEXT,
          goldenDetachedLine: GOLDEN_DETACHED_LAUNCH_LINE,
          mustInclude: [
            'cat /home/gem/.codex/task-prompt.txt',
            '2>/dev/null',
            'if [ -n "$P" ]',
            'codex -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox',
          ],
          mustExclude: [
            '--no-alt-screen',
            '--ask-for-approval',
            '--dangerously-bypass-hook-trust',
            '--full-auto',
          ],
          requiresSessionId: false,
        },
        lifecycle: {
          context: CONTEXT,
          startup: { replyToStartupDSR: true, promptSubmit: 'cr-on-quiesce' },
          quiesceTunable: {
            envVar: 'CODEX_AUTOSUBMIT_QUIESCE_MS',
            defaultMs: 800,
          },
        },
        transcript: {
          context: CONTEXT,
          format: 'codex-rollout',
          strategyKind: 'single-newest-jsonl',
          artifactDir: '/home/gem/.codex/sessions',
          matchingFilename: 'rollout-2026-06-01T10-00-00-sess-1.jsonl',
          nonMatchingFilename: 'notes.txt',
          parse: (raw) => bridge.parseTranscript(raw, 'codex-rollout'),
          fixtureJsonl: INTERACTIVE_ROLLOUT,
          expectedTurnKinds: ['user', 'assistant', 'tool', 'tool', 'assistant'],
          expectedFinalAnswerText: '已修复登录页样式。',
        },
        headless: {
          context: CONTEXT,
          mustInclude: [
            'codex exec --json',
            '--dangerously-bypass-approvals-and-sandbox',
            '--skip-git-repo-check',
            '< /dev/null',
            'cat /home/gem/.codex/task-prompt.txt',
          ],
          mustExclude: [
            '--ask-for-approval',
            '--sandbox ',
            '--dangerously-bypass-hook-trust',
          ],
          exitSentinelPath: headlessExitFile(TASK_ID),
          resume: {
            previousSessionId: 'previous-session',
            mustInclude: [
              'codex exec resume',
              'previous-session',
              '--json',
              '--dangerously-bypass-approvals-and-sandbox',
              '--skip-git-repo-check',
              '< /dev/null',
            ],
            mustExclude: ['--sandbox '],
          },
          hostileResume: {
            sessionId: 'session; touch /tmp/escaped',
            rejectionPattern: 'safe runtime identifier',
          },
        },
        secretCanary: {
          setupContext: {
            taskId: TASK_ID,
            workspaceDir: WORKSPACE_DIR,
            prompt: 'conformance canary prompt',
          },
          canary: CANARY,
          variants: [
            {
              label: 'official-auth-json',
              material: {
                authJson: `{"auth_mode":"chatgpt","tokens":{"access_token":"${CANARY}"}}`,
              },
            },
            {
              label: 'compatible-provider',
              material: {
                codexCompatible: {
                  baseUrl: 'https://api.example.com/v1',
                  apiKey: CANARY,
                  model: 'gpt-4o',
                },
              },
            },
          ],
          // Codex degrades to a config-only unauthenticated launch — an absent
          // credential is NOT a hidden failure (the documented divergence from
          // claude's fail-closed policy).
          absentCredential: 'degrades',
          trimProvesAbsent: [
            '/home/gem/.codex/config.toml',
            '/home/gem/.codex/task-prompt.txt',
            '/home/gem/.codex/auth.json',
          ],
        },
      },
    };
  },
};
