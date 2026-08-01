/**
 * Claude Code harness maker — CONSTRUCTION + ENVIRONMENT HOOKS ONLY. Every
 * assertion lives in the suite-owned scenario modules (`../scenarios/*`); this
 * module contributes runtime construction (via the seed bridge), launch
 * expectations, the seed fixture bytes, and the credential stubs.
 *
 * Fixture provenance (moved, not regenerated):
 *   - launch/flag expectations: `apps/api/src/agent-runtime/
 *     agent-runtime.test.mjs` and `headless-execution.spec.ts`;
 *   - the session-JSONL transcript fixture: `apps/api/src/sandbox/
 *     claude-transcript-parser.test.mjs` (`SESSION` — synthetic content, real
 *     claude 2.1.183 line shapes).
 */
import { headlessExitFile } from '@cap-console/sandbox';

import type {
  ConformanceLaunchContext,
  RuntimeHarness,
  RuntimeHarnessMaker,
  RuntimeSeedBridge,
} from '../harness.js';

const TASK_ID = 'abc';
const WORKSPACE_DIR = '/home/gem/workspace';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const CONTEXT: ConformanceLaunchContext = {
  taskId: TASK_ID,
  workspaceDir: WORKSPACE_DIR,
  sessionId: SESSION_ID,
  model: { kind: 'runtime-default' },
};

/** One unique value reused by every secret-leak assertion (canary vocabulary). */
const CANARY = 'CANARY-cap-runtime-conformance-8c4b1d';

// Session transcript fixture — moved from `claude-transcript-parser.test.mjs`
// (`SESSION`): synthetic content, real claude 2.1.183 line shapes.
const jsonl = (obj: unknown): string => JSON.stringify(obj);
const SESSION = [
  jsonl({ type: 'user', cwd: '/home/gem/workspace', timestamp: '2026-06-12T09:30:00Z', message: { role: 'user', content: '修复登录页样式' } }),
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:30:05Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [
    { type: 'thinking', thinking: '先列出 src 目录看看结构。' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls src', description: 'list src' } },
    { type: 'text', text: '我先看相关文件。' },
  ], stop_reason: 'tool_use' } }),
  jsonl({ type: 'user', timestamp: '2026-06-12T09:30:08Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'app.tsx\nlogin.tsx' }] } }),
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:30:20Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/home/gem/workspace/login.tsx' } },
    { type: 'tool_use', id: 'toolu_3', name: 'WebFetch', input: { url: 'https://example.com', prompt: 'fetch' } },
    { type: 'tool_use', id: 'toolu_4', name: 'Grep', input: '{"pattern":"className","path":"login.tsx"}' },
  ], stop_reason: 'tool_use' } }),
  jsonl({ type: 'user', timestamp: '2026-06-12T09:30:25Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: '<div className="login" />' }] },
    { type: 'tool_result', tool_use_id: 'toolu_3', content: [] },
    { type: 'tool_result', tool_use_id: 'toolu_4', content: 'login.tsx:12: className="login"' },
  ] } }),
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:30:40Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_5', name: 'Edit', input: { file_path: '/home/gem/workspace/login.tsx', old_string: 'a', new_string: 'b' } },
  ], stop_reason: 'tool_use' } }),
  jsonl({ type: 'system', timestamp: '2026-06-12T09:30:50Z', message: {} }),
  jsonl({ type: 'assistant', timestamp: '2026-06-12T09:31:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '已修复登录页样式。' }], stop_reason: 'end_turn' } }),
  '',
].join('\n');

const MALFORMED =
  'not json\n' +
  jsonl({ type: 'user', timestamp: '2026-06-12T09:30:00Z', message: { role: 'user', content: 'ok' } }) +
  '\n{bad';

export const claudeCodeHarnessMaker: RuntimeHarnessMaker = {
  runtimeId: 'claude-code',
  async make(bridge: RuntimeSeedBridge): Promise<RuntimeHarness> {
    const runtime = await bridge.constructRuntime('claude-code');
    return {
      runtime,
      hooks: {
        launch: {
          context: CONTEXT,
          mustInclude: [
            `claude --session-id ${SESSION_ID} --dangerously-skip-permissions "$P"`,
            'CLAUDE_CODE_SANDBOXED=1',
            'CLAUDE_CONFIG_DIR=/home/gem/.claude',
            'cat /home/gem/.claude/task-prompt.txt',
          ],
          mustExclude: [
            'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN',
            'claude attach',
            'claude agents',
            '--bare',
            '--no-session-persistence',
            'acceptEdits',
            '--permission-mode',
          ],
          // The `--session-id` uuid names the transcript JSONL the retention
          // path archives — a launch without it must refuse.
          requiresSessionId: true,
        },
        lifecycle: {
          context: CONTEXT,
          startup: { replyToStartupDSR: false, promptSubmit: 'none' },
        },
        transcript: {
          context: CONTEXT,
          format: 'claude-jsonl',
          strategyKind: 'single-newest-jsonl',
          artifactDir: '/home/gem/.claude/projects/-home-gem-workspace',
          matchingFilename: `${SESSION_ID}.jsonl`,
          nonMatchingFilename: 'other-session.jsonl',
          parse: (raw) => bridge.parseTranscript(raw, 'claude-jsonl'),
          fixtureJsonl: SESSION,
          expectedTurnKinds: [
            'user',
            'assistant',
            'tool',
            'assistant',
            'tool',
            'tool',
            'tool',
            'tool',
            'assistant',
          ],
          expectedFinalAnswerText: '已修复登录页样式。',
          malformed: {
            jsonl: MALFORMED,
            expectedSurvivorTexts: ['ok'],
          },
        },
        headless: {
          context: CONTEXT,
          mustInclude: [
            'claude -p "$P"',
            `--session-id ${SESSION_ID}`,
            '--output-format stream-json',
            '--verbose',
            '--dangerously-skip-permissions',
            '< /dev/null',
            'export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1',
            'CLAUDE_CODE_SANDBOXED=1',
            'CLAUDE_CONFIG_DIR=/home/gem/.claude',
          ],
          mustExclude: ['acceptEdits', '--permission-mode'],
          exitSentinelPath: headlessExitFile(TASK_ID),
          resume: {
            previousSessionId: 'previous-session',
            mustInclude: [
              'claude -p "$P"',
              '--resume previous-session',
              '--output-format stream-json',
              '--verbose',
              '--dangerously-skip-permissions',
              '< /dev/null',
              'export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1',
            ],
            mustExclude: ['--session-id', 'acceptEdits', '--permission-mode'],
          },
          exactlyOnceFlags: ['--dangerously-skip-permissions'],
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
              label: 'oauth-token',
              material: { oauthToken: CANARY },
            },
          ],
          // Claude fails CLOSED without a credential — it must never launch
          // unauthenticated (the deliberate divergence from codex).
          absentCredential: 'fail-closed',
          blankMaterial: { oauthToken: '   ' },
          trimProvesAbsent: [
            '/home/gem/.claude/launch-env.sh',
            '/home/gem/.claude/task-prompt.txt',
            '/home/gem/.claude.json',
          ],
        },
      },
    };
  },
};
