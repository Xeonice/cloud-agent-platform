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

  // (codex's provision-time auth/config + prompt writes are now the pure
  // `sandboxSetupCommands` emitter — golden-tested byte-exact in the 3.2 block
  // below; the dead `injectAuth` port method is removed in this refactor.)

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

  // (claude's launch-env.sh + `.claude.json` writes + fail-closed-without-token are
  // now the pure `sandboxSetupCommands` emitter — golden-tested byte-exact in the 3.2
  // block below; the dead `injectAuth` port method is removed in this refactor. The
  // terminal-startup no-op is asserted via `claude.terminalStartup` above.)

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

  // (the runtime `captureTranscript` port method is REMOVED in this refactor — the
  // structured transcript capture lives in the retention path's SessionTranscriptService
  // + the provider's rollout read, never a dead per-runtime port method. The JSONL
  // parsing the claude `detectExit` relies on is still covered by the transcript-module
  // cases above: `parseClaudeTranscript` / `isTurnComplete`.)

  // ---- 3.2 GOLDEN: sandboxSetupCommands / preStopTrimCommands emitters --------
  // Byte-exact characterization of the pure setup/trim emitters (refactor step 3a/3b).
  // Expected payloads are computed from LITERAL config/auth/prompt content, so a drift
  // in the emitter's TOML/escaping/order fails here. Pins TRAP-1 (config+auth = ONE
  // command), TRAP-2 (conditional prompt = dropped element), TRAP-3 (per-command
  // tolerateUnresolvedExit), TRAP-5 (idempotency tokens).
  const toB64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const CXDIR = '/home/gem/.codex';
  const WS = '/home/gem/workspace';
  const TRUST = `[projects."${WS}"]\ntrust_level = "trusted"\n`;

  // codex: null material, no prompt → 1 command (trust-only config.toml, strict)
  const cxNull = codex.sandboxSetupCommands({ taskId: 't', workspaceDir: WS, prompt: null }, null);
  assert(
    cxNull.ok === true && cxNull.commands.length === 1,
    'codex setup (no auth, no prompt) → 1 command',
  );
  assert(
    cxNull.commands[0].command ===
      `mkdir -p ${CXDIR} && rm -f ${CXDIR}/hooks.json && printf %s '${toB64(TRUST)}' | base64 -d > ${CXDIR}/config.toml && chmod 600 ${CXDIR}/config.toml`,
    'codex GOLDEN: trust-only config.toml command byte-exact',
  );
  assert(
    cxNull.commands[0].tolerateUnresolvedExit === false,
    'codex config command is strict (fail-closed on unresolved exit)',
  );

  // codex: official + prompt → 2 commands; auth.json appended to config command (TRAP-1)
  const cxAuthJson = '{"auth_mode":"chatgpt","tokens":{}}';
  const cxPrompt = 'read the code 阅读代码';
  const cxOff = codex.sandboxSetupCommands(
    { taskId: 't', workspaceDir: WS, prompt: cxPrompt },
    { authJson: cxAuthJson },
  );
  assert(cxOff.ok === true && cxOff.commands.length === 2, 'codex setup (official + prompt) → 2 commands');
  assert(
    cxOff.commands[0].command ===
      `mkdir -p ${CXDIR} && rm -f ${CXDIR}/hooks.json && printf %s '${toB64(TRUST)}' | base64 -d > ${CXDIR}/config.toml && chmod 600 ${CXDIR}/config.toml && printf %s '${toB64(cxAuthJson)}' | base64 -d > ${CXDIR}/auth.json && chmod 600 ${CXDIR}/auth.json`,
    'codex GOLDEN: official config+auth.json as ONE command byte-exact (TRAP-1)',
  );
  assert(
    cxOff.commands[1].command ===
      `mkdir -p ${CXDIR} && printf %s '${toB64(cxPrompt)}' | base64 -d > ${CXDIR}/task-prompt.txt && chmod 600 ${CXDIR}/task-prompt.txt`,
    'codex GOLDEN: prompt-file write byte-exact',
  );

  // codex: compatible, no prompt → 1 command, NO auth.json, model_providers.cap TOML
  const COMPAT = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-4o' };
  const COMPAT_TOML =
    `model = "gpt-4o"\nmodel_provider = "cap"\n` +
    TRUST +
    `[model_providers.cap]\nname = "Compatible provider"\nbase_url = "https://api.example.com/v1"\nwire_api = "responses"\nexperimental_bearer_token = "sk-test"\n`;
  const cxComp = codex.sandboxSetupCommands(
    { taskId: 't', workspaceDir: WS, prompt: null },
    { codexCompatible: COMPAT },
  );
  assert(cxComp.ok === true && cxComp.commands.length === 1, 'codex setup (compatible, no prompt) → 1 command (no auth.json)');
  assert(
    cxComp.commands[0].command ===
      `mkdir -p ${CXDIR} && rm -f ${CXDIR}/hooks.json && printf %s '${toB64(COMPAT_TOML)}' | base64 -d > ${CXDIR}/config.toml && chmod 600 ${CXDIR}/config.toml`,
    'codex GOLDEN: compatible config.toml (model_providers.cap, no auth.json) byte-exact',
  );

  // codex trim — byte-exact (keeps sessions/, truncates auth.json with `: >`)
  const cxTrim = codex.preStopTrimCommands();
  assert(
    cxTrim.length === 1 &&
      cxTrim[0] ===
        `rm -rf ${CXDIR}/cache ${CXDIR}/logs_*.sqlite ${CXDIR}/logs_*.sqlite-shm ${CXDIR}/logs_*.sqlite-wal 2>/dev/null; : > ${CXDIR}/auth.json 2>/dev/null; true`,
    'codex GOLDEN: pre-stop trim byte-exact (: > truncate, keeps sessions/)',
  );

  // claude: no/blank token → fail closed BEFORE any command (TRAP-3)
  assert(
    claude.sandboxSetupCommands({ taskId: 't', workspaceDir: WS, prompt: 'x' }, null).ok === false,
    'claude setup fails closed without a token',
  );
  assert(
    claude.sandboxSetupCommands({ taskId: 't', workspaceDir: WS, prompt: 'x' }, { oauthToken: '   ' }).ok === false,
    'claude setup fails closed on a blank token',
  );

  // claude: token + prompt → 2 commands; auth-env tolerant, prompt strict (TRAP-3)
  const CLTOK = 'sk-ant-oat-XYZ';
  const clTok = claude.sandboxSetupCommands({ taskId: 't', workspaceDir: WS, prompt: 'goal' }, { oauthToken: CLTOK });
  assert(clTok.ok === true && clTok.commands.length === 2, 'claude setup (token + prompt) → 2 commands');
  assert(clTok.commands[0].tolerateUnresolvedExit === true, 'claude auth-env command tolerates unresolved exit');
  assert(clTok.commands[1].tolerateUnresolvedExit === false, 'claude prompt command is strict');

  // claude: token, no prompt → 1 command; launch-env.sh + .claude.json byte-exact
  const clNoP = claude.sandboxSetupCommands({ taskId: 't', workspaceDir: WS, prompt: null }, { oauthToken: CLTOK });
  assert(clNoP.ok === true && clNoP.commands.length === 1, 'claude setup (token, no prompt) → 1 command');
  const clSnippet =
    `export CLAUDE_CODE_OAUTH_TOKEN="$(printf %s '${toB64(CLTOK)}' | base64 -d)"\n` +
    'unset ANTHROPIC_API_KEY\nunset ANTHROPIC_AUTH_TOKEN\nunset apiKeyHelper\n';
  const clPreseed = JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    numStartups: 5,
    hasAcknowledgedCostThreshold: true,
    bypassPermissionsModeAccepted: true,
    projects: { [WS]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  });
  assert(
    clNoP.commands[0].command ===
      `mkdir -p /home/gem/.claude && printf %s '${toB64(clSnippet)}' | base64 -d > /home/gem/.claude/launch-env.sh && chmod 600 /home/gem/.claude/launch-env.sh && printf %s '${toB64(clPreseed)}' | base64 -d > /home/gem/.claude/.claude.json && chmod 600 /home/gem/.claude/.claude.json`,
    'claude GOLDEN: launch-env.sh + .claude.json command byte-exact',
  );

  // claude trim — keeps projects/
  assert(
    claude.preStopTrimCommands()[0] ===
      `find /home/gem/.claude -mindepth 1 -maxdepth 1 ! -name projects -exec rm -rf {} + 2>/dev/null; true`,
    'claude GOLDEN: pre-stop trim keeps projects/',
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
