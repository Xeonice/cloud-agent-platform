/**
 * Unit tests for the AgentRuntime port + both runtimes (add-claude-code-runtime,
 * task 2.9). Covers:
 *   - the runtime registry resolves by task `runtime` (codex default, claude-code,
 *     unknown throws, duplicate-id wiring bug throws);
 *   - CODEX PARITY: CodexRuntime reproduces today's launch line, auth.json write,
 *     DSR-gated single-CR autosubmit, and `tmux has-session` exit detection;
 *   - CLAUDE end_turn detection: the last-ASSISTANT (not last-line) record decides,
 *     a mid-turn `tool_use` is NOT done, and a clarifying-question ending IS done;
 *   - CLAUDE auth: the OAuth token is set and ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/
 *     apiKeyHelper are UNSET on the launch env, with a missing token failing closed;
 *   - CLAUDE launch flags (acceptEdits, sandboxed/inline-buffer/config-dir env, the
 *     `$(cat)` positional prompt) and the forbidden flags are absent;
 *   - CLAUDE autosubmit is a no-op (no CR injected, no DSR/CPR machinery).
 *
 * Compiles the REAL agent-runtime sources with tsc, imports them; plain node with
 * inline assertions (mirrors the repo's `.test.mjs` convention — see
 * `terminal/codex-launch.test.mjs`).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');

/**
 * Resolve the repo `tsc`. Normally it sits at `<repoRoot>/node_modules/.bin/tsc`
 * (the repo convention). When this runs from a git WORKTREE that has no installed
 * node_modules of its own, walk up to the first ancestor that does, so the test
 * compiles against the same toolchain without an install in the worktree.
 */
function resolveTsc() {
  let dir = repoRoot;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(repoRoot, 'node_modules', '.bin', 'tsc');
}
const tscBin = resolveTsc();

/**
 * Resolve a `node_modules/@types` directory holding the node types. The runtimes
 * use `Buffer`/`process`, so the compile needs `@types/node`. Walk up from apiRoot
 * to the first ancestor whose `node_modules/@types/node` exists (apps/api when
 * installed; the main checkout when this runs from a dependency-free worktree).
 */
function resolveTypeRoots() {
  let dir = apiRoot;
  for (let i = 0; i < 10; i++) {
    // Direct: this dir's own node_modules/@types (the installed apps/api case).
    const own = join(dir, 'node_modules', '@types');
    if (existsSync(join(own, 'node'))) return own;
    // pnpm isolates @types/node under apps/api, not the repo root — so when this
    // runs from a dependency-free worktree, also probe an ancestor's apps/api.
    const apiTypes = join(dir, 'apps', 'api', 'node_modules', '@types');
    if (existsSync(join(apiTypes, 'node'))) return apiTypes;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(apiRoot, 'node_modules', '@types');
}
const typeRoots = resolveTypeRoots();

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// Emit INSIDE apps/api so module resolution can walk up to repo node_modules.
const outDir = mkdtempSync(join(apiRoot, '.agent-runtime-test-'));

// Compile the whole agent-runtime dir + the codex-launch leaf it imports, then
// resolve a compiled module path (the tsc layout may be flat or nested).
function compile() {
  const srcs = [
    join(__dirname, 'agent-runtime.port.ts'),
    join(__dirname, 'agent-runtime.registry.ts'),
    join(__dirname, 'codex-runtime.ts'),
    join(__dirname, 'claude-code-runtime.ts'),
    join(__dirname, 'claude-transcript.ts'),
  ];
  execFileSync(
    tscBin,
    [
      ...srcs,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'ES2021',
      '--esModuleInterop',
      '--skipLibCheck',
      '--types',
      'node',
      '--typeRoots',
      typeRoots,
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  // tsc preserves the relative tree from the common root of the inputs. The
  // sources span `agent-runtime/` (the inputs) and `terminal/` (codex-launch,
  // pulled in by import), so the common root is `src/` and modules land under
  // `<outDir>/agent-runtime/...`. Tolerate a flat emit too.
  const candidates = [
    join(outDir, 'agent-runtime'),
    outDir,
    join(outDir, 'src', 'agent-runtime'),
  ];
  for (const base of candidates) {
    const reg = join(base, 'agent-runtime.registry.js');
    if (existsSync(reg)) return base;
  }
  throw new Error('compiled agent-runtime modules not found under ' + outDir);
}

/** A minimal in-memory SandboxExec recording every command, with scripted replies. */
function makeExec(responder) {
  const calls = [];
  return {
    calls,
    exec: async (command) => {
      calls.push(command);
      const reply = responder ? responder(command) : undefined;
      return reply ?? { stdout: '', code: 0 };
    },
  };
}

/** Build a Claude transcript JSONL string from record objects. */
function jsonl(...records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

async function main() {
  const base = compile();
  const { AgentRuntimeRegistry } = await import(
    pathToFileURL(join(base, 'agent-runtime.registry.js')).href
  );
  const { CodexRuntime } = await import(
    pathToFileURL(join(base, 'codex-runtime.js')).href
  );
  const { ClaudeCodeRuntime } = await import(
    pathToFileURL(join(base, 'claude-code-runtime.js')).href
  );
  const transcript = await import(
    pathToFileURL(join(base, 'claude-transcript.js')).href
  );

  const codex = new CodexRuntime();
  const claude = new ClaudeCodeRuntime();

  // ====================================================================
  // Registry: resolve by task runtime
  // ====================================================================
  const registry = new AgentRuntimeRegistry([codex, claude]);
  assert(registry.resolve('codex') === codex, 'registry resolves "codex"');
  assert(
    registry.resolve('claude-code') === claude,
    'registry resolves "claude-code"',
  );
  assert(
    registry.resolve(null) === codex && registry.resolve(undefined) === codex,
    'registry resolves null/undefined runtime to codex (default)',
  );
  let threwUnknown = false;
  try {
    registry.resolve('gemini');
  } catch {
    threwUnknown = true;
  }
  assert(threwUnknown, 'registry throws on an unregistered runtime id');
  let threwDup = false;
  try {
    new AgentRuntimeRegistry([codex, new CodexRuntime()]);
  } catch {
    threwDup = true;
  }
  assert(threwDup, 'registry throws on a duplicate runtime id (wiring bug)');
  assert(
    registry.has('codex') &&
      registry.has('claude-code') &&
      registry.ids().includes('codex') &&
      registry.ids().includes('claude-code'),
    'registry exposes has()/ids() for readiness enumeration',
  );

  // ====================================================================
  // CodexRuntime PARITY
  // ====================================================================
  assert(codex.id === 'codex', 'CodexRuntime.id === "codex"');

  const codexLine = codex.buildLaunchLine({
    taskId: 'b3ee3f63',
    workspaceDir: '/home/gem/workspace',
  });
  assert(
    codexLine.startsWith('tmux new-session -d -s taskb3ee3f63 '),
    'codex launches in the detached named tmux session `task<taskId>`',
  );
  assert(
    codexLine.includes('-c /home/gem/workspace'),
    'codex detached session cwd is the cloned workspace',
  );
  assert(
    codexLine.includes('cat /home/gem/.codex/task-prompt.txt') &&
      codexLine.includes('if [ -n "$P" ]'),
    'codex preserves the `"$(cat …)"` positional-prompt contract',
  );
  assert(
    codexLine.includes(CodexRuntime.DEFAULT_CODEX_LAUNCH_ARGV) ||
      codexLine.includes(
        'codex -C /home/gem/workspace --ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust',
      ),
    'codex launch line carries the unchanged default argv',
  );

  // injectAuth: official material writes auth.json (0600); no material degrades ok.
  const codexExec = makeExec();
  const okWrite = await codex.injectAuth(codexExec, {
    authJson: '{"auth_mode":"chatgpt"}',
  });
  assert(okWrite.ok === true, 'codex injectAuth(ok) with material');
  const wroteAuth = codexExec.calls.join('\n');
  assert(
    wroteAuth.includes('/home/gem/.codex/auth.json') &&
      wroteAuth.includes('base64 -d') &&
      wroteAuth.includes('chmod 600'),
    'codex injectAuth writes ~/.codex/auth.json (base64-decoded, chmod 600)',
  );
  const codexExec2 = makeExec();
  const degraded = await codex.injectAuth(codexExec2, null);
  assert(
    degraded.ok === true && codexExec2.calls.length === 0,
    'codex injectAuth with NO material degrades ok (no write, no failure) — codex parity',
  );

  // terminalStartup (refactor-agent-runtime-policy-mechanism): codex DECLARES the
  // DSR-reply + cr-on-quiesce policy the SHARED pty mechanism (AioPtyClient) reads;
  // claude declares neither (its prompt auto-runs). The DSR/CPR/quiesce MECHANISM is
  // unchanged and lives in the pty client — only its gate now reads this declared
  // policy (no agent-identity branch; the dead `CodexRuntime.autoSubmit` is deleted).
  process.env['CODEX_AUTOSUBMIT_QUIESCE_MS'] = '20';
  assert(
    codex.terminalStartup.replyToStartupDSR === true &&
      codex.terminalStartup.promptSubmit === 'cr-on-quiesce',
    'codex declares { replyToStartupDSR: true, promptSubmit: cr-on-quiesce }',
  );
  assert(
    codex.terminalStartup.quiesceMs === 20,
    'codex terminalStartup.quiesceMs reads CODEX_AUTOSUBMIT_QUIESCE_MS at access (test-tunable)',
  );
  delete process.env['CODEX_AUTOSUBMIT_QUIESCE_MS'];
  assert(
    codex.terminalStartup.quiesceMs === 800,
    'codex terminalStartup.quiesceMs defaults to 800 (the prior pty-client default)',
  );
  assert(
    claude.terminalStartup.replyToStartupDSR === false &&
      claude.terminalStartup.promptSubmit === 'none',
    'claude declares { replyToStartupDSR: false, promptSubmit: none }',
  );

  // detectExit: gone session => done; existing session => running.
  const goneExec = makeExec((cmd) =>
    cmd.includes('has-session') ? { stdout: '__cap_has__1\n', code: 0 } : undefined,
  );
  const goneSignal = await codex.detectExit(goneExec, {
    taskId: 't',
    workspaceDir: '/home/gem/workspace',
  });
  assert(goneSignal.status === 'done', 'codex detectExit: a GONE tmux session is done');
  assert(
    goneExec.calls.some((c) => c.includes('tmux has-session -t taskt')),
    'codex detectExit probes `tmux has-session` (codex parity)',
  );
  const aliveExec = makeExec((cmd) =>
    cmd.includes('has-session') ? { stdout: '__cap_has__0\n', code: 0 } : undefined,
  );
  const aliveSignal = await codex.detectExit(aliveExec, {
    taskId: 't',
    workspaceDir: '/home/gem/workspace',
  });
  assert(
    aliveSignal.status === 'running',
    'codex detectExit: an EXISTING tmux session is still running',
  );
  const blipExec = makeExec(() => ({ stdout: 'no sentinel here', code: 0 }));
  const blipSignal = await codex.detectExit(blipExec, {
    taskId: 't',
    workspaceDir: '/home/gem/workspace',
  });
  assert(
    blipSignal.status === 'running',
    'codex detectExit: an inconclusive probe (no sentinel) reads as running',
  );

  // ====================================================================
  // ClaudeCodeRuntime
  // ====================================================================
  assert(claude.id === 'claude-code', 'ClaudeCodeRuntime.id === "claude-code"');

  // ---- 2.4 launch line --------------------------------------------------
  const claudeLine = claude.buildLaunchLine({
    taskId: 'abc',
    workspaceDir: '/home/gem/workspace',
    sessionId: '11111111-2222-3333-4444-555555555555',
  });
  assert(
    claudeLine.startsWith('tmux new-session -d -s taskabc -c /home/gem/workspace '),
    'claude launches in the detached named tmux session with the workspace cwd',
  );
  assert(
    claudeLine.includes(
      'claude --session-id 11111111-2222-3333-4444-555555555555 --permission-mode acceptEdits "$P"',
    ),
    'claude launch line is `claude --session-id <uuid> --permission-mode acceptEdits "$P"`',
  );
  assert(
    claudeLine.includes('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1') &&
      claudeLine.includes('CLAUDE_CODE_SANDBOXED=1') &&
      claudeLine.includes('CLAUDE_CONFIG_DIR=/home/gem/.claude'),
    'claude launch env sets inline-buffer + sandboxed + config-dir flags',
  );
  assert(
    claudeLine.includes('cat /home/gem/.claude/task-prompt.txt'),
    'claude prompt rides the `$(cat <file>)` shape (never inlined)',
  );
  assert(
    !claudeLine.includes('claude attach') &&
      !claudeLine.includes('claude agents') &&
      !claudeLine.includes('--dangerously-skip-permissions') &&
      !claudeLine.includes('--bare') &&
      !claudeLine.includes('--no-session-persistence'),
    'claude launch line uses NONE of the forbidden flags',
  );
  let threwNoSession = false;
  try {
    claude.buildLaunchLine({ taskId: 'abc', workspaceDir: '/home/gem/workspace' });
  } catch {
    threwNoSession = true;
  }
  assert(
    threwNoSession,
    'claude buildLaunchLine REQUIRES a sessionId (the transcript JSONL name)',
  );

  // ---- 2.5 credential injection (set token, UNSET ANTHROPIC_*) -----------
  const claudeExec = makeExec();
  const authOk = await claude.injectAuth(claudeExec, { oauthToken: 'sk-ant-oat-XYZ' });
  assert(authOk.ok === true, 'claude injectAuth(ok) with a token');
  const authCmd = claudeExec.calls.join('\n');
  assert(
    authCmd.includes('base64 -d') && authCmd.includes('chmod 600'),
    'claude injectAuth writes the launch-env snippet (base64-decoded, chmod 600)',
  );
  // Decode the embedded base64 snippet to prove the exports/unsets it will source.
  const b64 = /printf %s '([A-Za-z0-9+/=]+)'/.exec(authCmd);
  assert(b64 !== null, 'claude injectAuth embeds the snippet as base64');
  const snippet = Buffer.from(b64[1], 'base64').toString('utf8');
  assert(
    /export CLAUDE_CODE_OAUTH_TOKEN=/.test(snippet),
    'claude launch env EXPORTS CLAUDE_CODE_OAUTH_TOKEN',
  );
  assert(
    /unset ANTHROPIC_API_KEY/.test(snippet) &&
      /unset ANTHROPIC_AUTH_TOKEN/.test(snippet) &&
      /unset apiKeyHelper/.test(snippet),
    'claude launch env UNSETS ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / apiKeyHelper',
  );
  assert(
    !authCmd.includes('sk-ant-oat-XYZ'),
    'claude injectAuth never puts the raw token in the exec command (base64 only)',
  );
  const claudeExecNoTok = makeExec();
  const failClosed = await claude.injectAuth(claudeExecNoTok, null);
  assert(
    failClosed.ok === false && failClosed.reason === 'runtime not configured',
    'claude injectAuth fails CLOSED with "runtime not configured" when no token',
  );
  assert(
    claudeExecNoTok.calls.length === 0,
    'claude injectAuth writes nothing when failing closed',
  );
  const blankFail = await claude.injectAuth(claudeExec, { oauthToken: '   ' });
  assert(
    blankFail.ok === false,
    'claude injectAuth fails closed on a blank/whitespace token',
  );

  // (claude's terminal-startup no-op is asserted via `claude.terminalStartup`
  // above — the dead `autoSubmit` method is removed in this refactor.)

  // ---- 2.7 detectExit: end_turn detection -------------------------------
  const slug = transcript.claudeProjectSlug('/home/gem/workspace');
  assert(
    slug === '-home-gem-workspace',
    'claude project slug canonicalizes the workspace path',
  );
  const tpath = transcript.claudeTranscriptPath(
    '/home/gem/.claude',
    '/home/gem/workspace',
    'SID',
  );
  assert(
    tpath === '/home/gem/.claude/projects/-home-gem-workspace/SID.jsonl',
    'claude transcript path = projects/<slug>/<session-id>.jsonl',
  );

  // isTurnComplete pure-function cases.
  const doneRecords = transcript.parseClaudeTranscript(
    jsonl(
      { type: 'user', message: { role: 'user' } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use' } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
      // trailing non-assistant records that follow the final assistant event:
      { type: 'system', subtype: 'ai-title' },
      { type: 'system', subtype: 'last-prompt' },
    ),
  );
  assert(
    transcript.isTurnComplete(doneRecords) === true,
    'end_turn on the LAST assistant record (not the last line) is complete',
  );
  const toolUseLast = transcript.parseClaudeTranscript(
    jsonl(
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use' } },
    ),
  );
  assert(
    transcript.isTurnComplete(toolUseLast) === false,
    'a later assistant `tool_use` (mid-turn) is NOT complete even after an earlier end_turn',
  );
  const questionEnd = transcript.parseClaudeTranscript(
    jsonl(
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Which environment should I target?' }],
        },
      },
    ),
  );
  assert(
    transcript.isTurnComplete(questionEnd) === true,
    'a clarifying-question ending (still end_turn) is complete (one-shot semantics)',
  );
  const noAssistant = transcript.parseClaudeTranscript(
    jsonl({ type: 'user', message: { role: 'user' } }),
  );
  assert(
    transcript.isTurnComplete(noAssistant) === false,
    'no assistant record yet => not complete',
  );

  // detectExit integration: reads the JSONL, kills the session on done.
  const doneJsonl = jsonl(
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
    { type: 'system', subtype: 'ai-title' },
  );
  const claudeDoneExec = makeExec((cmd) =>
    cmd.startsWith('cat ') ? { stdout: doneJsonl, code: 0 } : undefined,
  );
  const claudeExit = await claude.detectExit(claudeDoneExec, {
    taskId: 'abc',
    workspaceDir: '/home/gem/workspace',
    sessionId: 'SID',
  });
  assert(claudeExit.status === 'done', 'claude detectExit: end_turn => done');
  assert(
    claudeDoneExec.calls.some((c) => c.includes('tmux kill-session -t taskabc')),
    'claude detectExit proactively kills the tmux session on done (shared session-gone path)',
  );
  const claudeRunExec = makeExec((cmd) =>
    cmd.startsWith('cat ')
      ? {
          stdout: jsonl({
            type: 'assistant',
            message: { role: 'assistant', stop_reason: 'tool_use' },
          }),
          code: 0,
        }
      : undefined,
  );
  const claudeRun = await claude.detectExit(claudeRunExec, {
    taskId: 'abc',
    workspaceDir: '/home/gem/workspace',
    sessionId: 'SID',
  });
  assert(
    claudeRun.status === 'running' &&
      !claudeRunExec.calls.some((c) => c.includes('kill-session')),
    'claude detectExit: a mid-turn tool_use stays running and does NOT kill the session',
  );
  const claudeEmptyExec = makeExec((cmd) =>
    cmd.startsWith('cat ') ? { stdout: '', code: 0 } : undefined,
  );
  const claudeEmpty = await claude.detectExit(claudeEmptyExec, {
    taskId: 'abc',
    workspaceDir: '/home/gem/workspace',
    sessionId: 'SID',
  });
  assert(
    claudeEmpty.status === 'running',
    'claude detectExit: a missing/empty transcript reads as still-running',
  );

  // ---- 2.8 captureTranscript: parses ALL record types -------------------
  const archival = jsonl(
    { type: 'user', message: { role: 'user' } },
    { type: 'attachment', parentUuid: 'p1' },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
    { type: 'system', subtype: 'ai-title' },
  );
  const capExec = makeExec((cmd) =>
    cmd.startsWith('cat ') ? { stdout: archival, code: 0 } : undefined,
  );
  const cap = await claude.captureTranscript(capExec, {
    taskId: 'abc',
    workspaceDir: '/home/gem/workspace',
    sessionId: 'SID',
  });
  assert(
    cap.records.length === 4,
    'claude captureTranscript parses ALL record types from the JSONL',
  );
  assert(
    cap.records.map((r) => r.type).join(',') ===
      'user,attachment,assistant,system',
    'claude captureTranscript threads through attachment/system records (parent chain intact)',
  );
  const capEmpty = await claude.captureTranscript(
    makeExec(() => ({ stdout: '', code: 0 })),
    { taskId: 'abc', workspaceDir: '/home/gem/workspace', sessionId: 'SID' },
  );
  assert(
    Array.isArray(capEmpty.records) && capEmpty.records.length === 0,
    'claude captureTranscript yields no records (never throws) on an absent transcript',
  );
  // Malformed lines are skipped, not fatal.
  const malformed = await claude.captureTranscript(
    makeExec((cmd) =>
      cmd.startsWith('cat ')
        ? {
            stdout:
              '{not json}\n' +
              JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } }) +
              '\n',
            code: 0,
          }
        : undefined,
    ),
    { taskId: 'abc', workspaceDir: '/home/gem/workspace', sessionId: 'SID' },
  );
  assert(
    malformed.records.length === 1 && malformed.records[0].type === 'assistant',
    'claude captureTranscript skips a malformed JSONL line (best-effort parse)',
  );

  // codex captureTranscript yields no structured records (rollout read is elsewhere).
  const codexCap = await codex.captureTranscript(makeExec(), {
    taskId: 't',
    workspaceDir: '/home/gem/workspace',
  });
  assert(
    codexCap.records.length === 0,
    'codex captureTranscript returns no records here (rollout read stays in the provider)',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    failed++;
  })
  .finally(() => {
    rmSync(outDir, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  });
