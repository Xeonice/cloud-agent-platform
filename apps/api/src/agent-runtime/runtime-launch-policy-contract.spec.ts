import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertNativeCodexInteractiveLaunchArgv,
  DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
} from '@cap-console/sandbox';
import { ClaudeCodeRuntime } from './claude-code-runtime';
import { CodexRuntime } from './codex-runtime';

const REPO_ROOT = resolve(__dirname, '../../../..');
const AIO_DOCKERFILE = resolve(REPO_ROOT, 'docker/aio-sandbox.Dockerfile');
const BOXLITE_DOCKERFILE = resolve(REPO_ROOT, 'docker/boxlite-sandbox.Dockerfile');

function dockerLaunchValues(source: string): string[] {
  return [...source.matchAll(/^ENV CODEX_LAUNCH_ARGV="([^"]+)"$/gmu)].map(
    (match) => match[1]!,
  );
}

function assertYoloPolicy(value: string, source: string): void {
  assert.match(value, /--dangerously-bypass-approvals-and-sandbox/u, source);
  assert.doesNotMatch(value, /--no-alt-screen/u, source);
  assert.doesNotMatch(value, /--ask-for-approval/u, source);
  assert.doesNotMatch(value, /--sandbox danger-full-access/u, source);
  assert.doesNotMatch(value, /--dangerously-bypass-hook-trust/u, source);
  assert.doesNotMatch(value, /--full-auto/u, source);
}

test('runtime, shared compatibility seam, and both image contracts use one native Codex policy', () => {
  const expected = CodexRuntime.DEFAULT_CODEX_LAUNCH_ARGV;
  const aioValues = dockerLaunchValues(readFileSync(AIO_DOCKERFILE, 'utf8'));
  const boxliteValues = dockerLaunchValues(
    readFileSync(BOXLITE_DOCKERFILE, 'utf8'),
  );
  const shared = DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV;

  assert.deepEqual(aioValues, [expected]);
  assert.deepEqual(boxliteValues, [expected]);
  assert.equal(shared, expected);

  for (const [source, value] of [
    ['CodexRuntime', expected],
    ['SandboxTerminalSession compatibility seam', shared],
    ['AIO image', aioValues[0]!],
    ['BoxLite image', boxliteValues[0]!],
  ] as const) {
    assertYoloPolicy(value, source);
  }
});

test('stale inline or pre-YOLO Codex overrides fail closed', () => {
  for (const value of [
    'codex --no-alt-screen -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox',
    'codex -C /home/gem/workspace --full-auto',
    'codex -C /home/gem/workspace --ask-for-approval never --sandbox danger-full-access',
  ]) {
    assert.throws(() => assertNativeCodexInteractiveLaunchArgv(value));
  }
  assert.equal(
    assertNativeCodexInteractiveLaunchArgv(
      DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
    ),
    DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
  );
});

test('CodexRuntime validates CODEX_LAUNCH_ARGV before building an interactive launch', () => {
  const previous = process.env['CODEX_LAUNCH_ARGV'];
  try {
    process.env['CODEX_LAUNCH_ARGV'] =
      'codex --no-alt-screen -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox';
    assert.throws(
      () =>
        new CodexRuntime().buildLaunchLine({
          taskId: 'stale-runtime-override',
          workspaceDir: '/home/gem/workspace',
          model: { kind: 'runtime-default' },
        }),
      /forbidden legacy flag --no-alt-screen/u,
    );
  } finally {
    if (previous === undefined) delete process.env['CODEX_LAUNCH_ARGV'];
    else process.env['CODEX_LAUNCH_ARGV'] = previous;
  }
});

test('Claude changes only the interactive terminal-mode override', () => {
  const runtime = new ClaudeCodeRuntime();
  const context = {
    taskId: 'runtime-contract',
    workspaceDir: '/home/gem/workspace',
    sessionId: '11111111-2222-4333-8444-555555555555',
    model: { kind: 'runtime-default' as const },
  };
  const interactive = runtime.buildLaunchLine(context);
  const headless = runtime.buildHeadlessLine(context);
  const resume = runtime.buildResumeLine(context, 'previous-session');

  assert.doesNotMatch(interactive, /CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN/u);
  assert.match(interactive, /--dangerously-skip-permissions/u);
  assert.match(interactive, /CLAUDE_CODE_SANDBOXED=1/u);
  for (const line of [headless, resume]) {
    assert.match(line, /export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1/u);
    assert.match(line, /--dangerously-skip-permissions/u);
  }
});

test('AIO bypass image definition cannot reintroduce the dormant hook runtime', () => {
  const executable = readFileSync(AIO_DOCKERFILE, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
  assert.doesNotMatch(executable, /sandbox-hooks/u);
  assert.doesNotMatch(executable, /hooks\.json/u);
  assert.doesNotMatch(executable, /\/opt\/cap\/dist\/hooks/u);
  assert.doesNotMatch(executable, /ORCHESTRATOR_APPROVALS_URL/u);
});
