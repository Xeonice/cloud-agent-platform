/**
 * add-headless-execution-track — unit coverage for the headless launch lines, the
 * runtime→format mapping, and the claude transcript parser dispatch. Pure + dependency-free
 * (no Nest/Prisma/container), matching the other agent-runtime specs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexRuntime } from './codex-runtime';
import { ClaudeCodeRuntime } from './claude-code-runtime';
import {
  transcriptFormatForRuntime,
  type LaunchContext,
} from './agent-runtime.port';
import { parseClaudeTranscript } from '../sandbox/claude-transcript-parser';
import { parseTranscript } from '../sandbox/parse-transcript';
import {
  CODEX_PROMPT_FILE_PATH,
  headlessExitFile,
  wrapHeadlessDetachedSession,
} from '../terminal/codex-launch';
import {
  exitCodeFromExecBody,
  TASK_MODEL_MATERIAL_PATH,
} from '@cap/sandbox';

const CTX: LaunchContext = {
  taskId: 'task-abc',
  workspaceDir: '/home/gem/workspace',
  sessionId: '11111111-2222-3333-4444-555555555555',
  model: { kind: 'runtime-default' },
};

const EXPLICIT_CTX: LaunchContext = {
  ...CTX,
  model: {
    kind: 'explicit',
    path: '/home/gem/.cap/task-model.txt',
    checksum:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
};

function countModelArguments(line: string): number {
  return line.split('--model "$M"').length - 1;
}

function detachedInner(line: string): string {
  const firstQuote = line.indexOf("'");
  const lastQuote = line.lastIndexOf("'");
  assert.ok(firstQuote >= 0 && lastQuote > firstQuote);
  return line
    .slice(firstQuote + 1, lastQuote)
    .replace(/; echo \$\? > \/home\/gem\/\.cap-headless-[^ ]+\.exit$/, '');
}

let tmuxSessionSequence = 0;

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function waitForFile(path: string, timeoutMs = 3_000): void {
  const deadline = Date.now() + timeoutMs;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path) && Date.now() < deadline) {
    Atomics.wait(waitCell, 0, 0, 20);
  }
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

function waitForTmuxSessionGone(session: string, timeoutMs = 3_000): void {
  const deadline = Date.now() + timeoutMs;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (
    spawnSync('tmux', ['has-session', '-t', session]).status === 0 &&
    Date.now() < deadline
  ) {
    Atomics.wait(waitCell, 0, 0, 20);
  }
  assert.notEqual(
    spawnSync('tmux', ['has-session', '-t', session]).status,
    0,
    `timed out waiting for tmux session ${session} to exit`,
  );
}

function readCapturedArgv(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function replaceRuntimeExecutable(
  line: string,
  runtime: CodexRuntime | ClaudeCodeRuntime,
  executable: string,
): string {
  if (runtime.id === 'codex') {
    if (line.includes('codex --no-alt-screen')) {
      return line.replace('codex --no-alt-screen', `${executable} --no-alt-screen`);
    }
    return line.replace('codex exec', `${executable} exec`);
  }
  if (line.includes('claude --session-id')) {
    return line.replace('claude --session-id', `${executable} --session-id`);
  }
  return line.replace('claude -p', `${executable} -p`);
}

function captureRealTmuxArgv(
  runtime: CodexRuntime | ClaudeCodeRuntime,
  mode: 'interactive-pty' | 'headless-exec' | 'resume',
  explicit: boolean,
  materialState: 'valid' | 'missing' | 'empty' | 'checksum-mismatch' = 'valid',
): { argv: string[]; selector: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cap-model-tmux-'));
  const taskId = `modelargv-${process.pid}-${++tmuxSessionSequence}`;
  const tmuxSession = `task${taskId}`;
  const marker = join(dir, 'argv.txt');
  const executable = join(dir, runtime.id === 'codex' ? 'codex' : 'claude');
  const promptFile = join(dir, 'task-prompt.txt');
  const authFile = join(dir, 'launch-env.sh');
  const modelFile = join(dir, 'task-model.txt');
  const exitFile = join(dir, 'headless.exit');
  const selector = `provider/model: alpha;$(touch /tmp/must-not-run) "quoted" --config=unsafe`;
  const checksum = createHash('sha256').update(selector).digest('hex');
  const context: LaunchContext = {
    taskId,
    workspaceDir: dir,
    sessionId: '11111111-2222-4333-8444-555555555555',
    model: explicit
      ? {
          kind: 'explicit',
          path: TASK_MODEL_MATERIAL_PATH,
          checksum: `sha256:${checksum}`,
        }
      : { kind: 'runtime-default' },
  };

  try {
    writeFileSync(promptFile, 'tmux argv fixture prompt');
    if (materialState === 'valid') writeFileSync(modelFile, selector);
    if (materialState === 'empty') writeFileSync(modelFile, '');
    if (materialState === 'checksum-mismatch') {
      writeFileSync(modelFile, `${selector}-tampered`);
    }
    writeFileSync(
      authFile,
      'export CLAUDE_CODE_OAUTH_TOKEN=fixture-owner-token\n' +
        'unset ANTHROPIC_API_KEY\n' +
        'unset ANTHROPIC_AUTH_TOKEN\n',
    );
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellSingleQuote(marker)}\n`,
    );
    chmodSync(executable, 0o755);

    let line =
      mode === 'interactive-pty'
        ? runtime.buildLaunchLine(context)
        : mode === 'headless-exec'
          ? runtime.buildHeadlessLine(context)
          : runtime.buildResumeLine(context, 'previous-session');
    line = line
      .replaceAll(CODEX_PROMPT_FILE_PATH, promptFile)
      .replaceAll(ClaudeCodeRuntime.PROMPT_FILE_PATH, promptFile)
      .replaceAll(ClaudeCodeRuntime.AUTH_ENV_FILE_PATH, authFile)
      .replaceAll(TASK_MODEL_MATERIAL_PATH, modelFile)
      .replaceAll(headlessExitFile(taskId), exitFile);
    line = replaceRuntimeExecutable(line, runtime, executable);

    const launched = spawnSync('/bin/sh', ['-c', line], {
      encoding: 'utf8',
      timeout: 3_000,
    });
    assert.equal(
      launched.status,
      0,
      `tmux launch failed: ${launched.stderr || launched.stdout}`,
    );
    if (explicit && materialState !== 'valid' && mode !== 'resume') {
      waitForTmuxSessionGone(tmuxSession);
      assert.equal(
        existsSync(marker),
        false,
        `${runtime.id}/${mode} must not invoke the CLI with ${materialState} model material`,
      );
      if (mode === 'headless-exec') {
        waitForFile(exitFile);
        assert.notEqual(readFileSync(exitFile, 'utf8').trim(), '0');
      }
      return { argv: [], selector };
    }
    waitForFile(marker);
    if (mode !== 'interactive-pty') waitForFile(exitFile);
    return { argv: readCapturedArgv(marker), selector };
  } finally {
    spawnSync('tmux', ['kill-session', '-t', tmuxSession]);
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test('fresh Codex launch builders use one file-backed model argument and default stays unchanged', () => {
  const runtime = new CodexRuntime();
  const interactiveDefault = runtime.buildLaunchLine(CTX);
  const headlessDefault = runtime.buildHeadlessLine(CTX);
  assert.equal(countModelArguments(interactiveDefault), 0);
  assert.equal(countModelArguments(headlessDefault), 0);
  assert.doesNotMatch(interactiveDefault, /task-model\.txt/);
  assert.doesNotMatch(headlessDefault, /task-model\.txt/);

  const interactiveExplicit = runtime.buildLaunchLine(EXPLICIT_CTX);
  const headlessExplicit = runtime.buildHeadlessLine(EXPLICIT_CTX);
  assert.equal(countModelArguments(interactiveExplicit), 1);
  assert.equal(countModelArguments(headlessExplicit), 1);
  assert.match(interactiveExplicit, /test -r \/home\/gem\/\.cap\/task-model\.txt/);
  assert.match(headlessExplicit, /test -r \/home\/gem\/\.cap\/task-model\.txt/);
  assert.match(
    headlessExplicit,
    /test "\$actual" = "[a-f0-9]{64}" && \{ P=/,
    'the entire Codex launch must remain behind the verified selector checksum guard',
  );

  assert.equal(
    runtime.buildResumeLine(CTX, 'sess-7'),
    runtime.buildResumeLine(EXPLICIT_CTX, 'sess-7'),
  );
});

test('fresh Claude Code launch builders use one file-backed model argument and resume is unchanged', () => {
  const runtime = new ClaudeCodeRuntime();
  const interactiveDefault = runtime.buildLaunchLine(CTX);
  const headlessDefault = runtime.buildHeadlessLine(CTX);
  assert.equal(countModelArguments(interactiveDefault), 0);
  assert.equal(countModelArguments(headlessDefault), 0);
  assert.doesNotMatch(interactiveDefault, /task-model\.txt/);
  assert.doesNotMatch(headlessDefault, /task-model\.txt/);

  const interactiveExplicit = runtime.buildLaunchLine(EXPLICIT_CTX);
  const headlessExplicit = runtime.buildHeadlessLine(EXPLICIT_CTX);
  assert.equal(countModelArguments(interactiveExplicit), 1);
  assert.equal(countModelArguments(headlessExplicit), 1);
  assert.match(interactiveExplicit, /test -r \/home\/gem\/\.cap\/task-model\.txt/);
  assert.match(headlessExplicit, /test -r \/home\/gem\/\.cap\/task-model\.txt/);

  assert.equal(
    runtime.buildResumeLine(CTX, 'sess-7'),
    runtime.buildResumeLine(EXPLICIT_CTX, 'sess-7'),
  );
});

test('real tmux and shell boundary preserves one hostile model argv across both runtimes and fresh modes', () => {
  for (const runtime of [new CodexRuntime(), new ClaudeCodeRuntime()]) {
    for (const mode of ['interactive-pty', 'headless-exec'] as const) {
      for (const explicit of [false, true]) {
        const { argv, selector } = captureRealTmuxArgv(
          runtime,
          mode,
          explicit,
        );
        const positions = argv.flatMap((argument, index) =>
          argument === '--model' ? [index] : [],
        );
        assert.equal(
          positions.length,
          explicit ? 1 : 0,
          `${runtime.id}/${mode} model argv count`,
        );
        if (explicit) {
          assert.equal(argv[positions[0]! + 1], selector);
          assert.equal(
            argv.includes('--config=unsafe'),
            false,
            'hostile selector suffix must remain data inside one argv entry',
          );
        }
      }
    }

    const resumed = captureRealTmuxArgv(runtime, 'resume', true);
    assert.equal(
      resumed.argv.includes('--model'),
      false,
      `${runtime.id} resume must preserve the previously selected session model`,
    );
  }
});

test('real tmux boundary fails closed before CLI invocation for missing, empty, or checksum-mismatched model material', () => {
  for (const runtime of [new CodexRuntime(), new ClaudeCodeRuntime()]) {
    for (const mode of ['interactive-pty', 'headless-exec'] as const) {
      for (const materialState of [
        'missing',
        'empty',
        'checksum-mismatch',
      ] as const) {
        assert.deepEqual(
          captureRealTmuxArgv(runtime, mode, true, materialState).argv,
          [],
        );
      }
    }
  }
});

test('every Claude launch mode refuses missing, empty, or invalid auth material', () => {
  const runtime = new ClaudeCodeRuntime();
  const lines = [
    runtime.buildLaunchLine(CTX),
    runtime.buildHeadlessLine(CTX),
    runtime.buildResumeLine(CTX, 'previous-session'),
  ];
  const fixtures: Array<{ name: string; contents: string | null }> = [
    { name: 'missing', contents: null },
    { name: 'empty', contents: '' },
    { name: 'source failure', contents: 'false\n' },
    { name: 'no exported token', contents: 'true\n' },
  ];

  for (const [lineIndex, line] of lines.entries()) {
    for (const fixture of fixtures) {
      const dir = mkdtempSync(join(tmpdir(), 'cap-claude-auth-'));
      try {
        const authFile = join(dir, 'launch-env.sh');
        const promptFile = join(dir, 'task-prompt.txt');
        const binDir = join(dir, 'bin');
        const marker = join(dir, 'invoked');
        mkdirSync(binDir);
        const fakeClaude = join(binDir, 'claude');
        writeFileSync(
          fakeClaude,
          '#!/bin/sh\nprintf %s "${CLAUDE_CODE_OAUTH_TOKEN:-missing}" > "$CAP_TEST_MARKER"\n',
        );
        chmodSync(fakeClaude, 0o755);
        if (fixture.contents !== null) writeFileSync(authFile, fixture.contents);
        const inner = detachedInner(line)
          .replaceAll(ClaudeCodeRuntime.AUTH_ENV_FILE_PATH, authFile)
          .replaceAll(ClaudeCodeRuntime.PROMPT_FILE_PATH, promptFile);
        const result = spawnSync('/bin/sh', ['-c', inner], {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            CAP_TEST_MARKER: marker,
            CLAUDE_CODE_OAUTH_TOKEN: 'inherited-token-must-be-cleared',
          },
        });
        assert.notEqual(
          result.status,
          0,
          `launch ${lineIndex} must reject ${fixture.name} auth`,
        );
        assert.equal(
          existsSync(marker),
          false,
          `launch ${lineIndex} must not invoke Claude for ${fixture.name} auth`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test('every Claude launch mode accepts sourced auth while a missing prompt remains optional', () => {
  const runtime = new ClaudeCodeRuntime();
  const lines = [
    runtime.buildLaunchLine(CTX),
    runtime.buildHeadlessLine(CTX),
    runtime.buildResumeLine(CTX, 'previous-session'),
  ];

  for (const [lineIndex, line] of lines.entries()) {
    const dir = mkdtempSync(join(tmpdir(), 'cap-claude-auth-'));
    try {
      const authFile = join(dir, 'launch-env.sh');
      const promptFile = join(dir, 'missing-task-prompt.txt');
      const binDir = join(dir, 'bin');
      const marker = join(dir, 'invoked');
      mkdirSync(binDir);
      writeFileSync(
        authFile,
        'export CLAUDE_CODE_OAUTH_TOKEN=fixture-sourced-token\n' +
          'unset ANTHROPIC_API_KEY\n' +
          'unset ANTHROPIC_AUTH_TOKEN\n',
      );
      const fakeClaude = join(binDir, 'claude');
      writeFileSync(
        fakeClaude,
        '#!/bin/sh\nprintf %s "$CLAUDE_CODE_OAUTH_TOKEN" > "$CAP_TEST_MARKER"\n',
      );
      chmodSync(fakeClaude, 0o755);
      const inner = detachedInner(line)
        .replaceAll(ClaudeCodeRuntime.AUTH_ENV_FILE_PATH, authFile)
        .replaceAll(ClaudeCodeRuntime.PROMPT_FILE_PATH, promptFile);
      const result = spawnSync('/bin/sh', ['-c', inner], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          CAP_TEST_MARKER: marker,
        },
      });
      assert.equal(result.status, 0, `launch ${lineIndex} should run Claude`);
      assert.equal(readFileSync(marker, 'utf8'), 'fixture-sourced-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
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
