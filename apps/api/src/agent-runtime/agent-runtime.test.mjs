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
 *   - CLAUDE launch flags (bypass permissions, native terminal, sandboxed/config-dir env,
 *     the `$(cat)` positional prompt) and the incompatible flags are absent;
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
  const { createSandboxRuntimePrivateFilePort } = await import(
    pathToFileURL(join(repoRoot, 'packages/sandbox-core/dist/index.js')).href
  );

  const consumePrivateFiles = async (commands) => {
    const files = new Map();
    const port = createSandboxRuntimePrivateFilePort({
      rootDirectory: '/home/gem',
      transport: {
        async writeFile(request) {
          files.set(request.path, Buffer.from(request.content).toString('utf8'));
        },
        async deleteFile() {},
      },
    });
    for (const command of commands) {
      for (const file of command.privateFiles ?? []) await port.writeFile(file);
    }
    return files;
  };

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
    model: { kind: 'runtime-default' },
  });
  assert(
    codexLine.startsWith('tmux -u new-session -d -s taskb3ee3f63 '),
    'codex launches in the UTF-8 detached named tmux session `task<taskId>`',
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
        'codex -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox',
      ),
    'codex launch line carries the native-terminal bypass argv',
  );
  assert(
    !codexLine.includes('--no-alt-screen'),
    'codex interactive launch does not force the inline/normal buffer',
  );

  // (codex's provision-time auth/config + prompt writes are now the pure
  // `sandboxSetupCommands` emitter — golden-tested byte-exact in the 3.2 block
  // below; the dead `injectAuth` port method is removed in this refactor.)

  // terminalStartup (refactor-agent-runtime-policy-mechanism): codex DECLARES the
  // DSR-reply + cr-on-quiesce policy the shared provider-neutral session reads;
  // claude declares neither (its prompt auto-runs). The DSR/CPR/quiesce MECHANISM is
  // unchanged and lives in the session engine — only its gate now reads this declared
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
    model: { kind: 'runtime-default' },
  });
  assert(
    claudeLine.startsWith('tmux -u new-session -d -s taskabc -c /home/gem/workspace '),
    'claude launches in the UTF-8 detached named tmux session with the workspace cwd',
  );
  assert(
    claudeLine.includes(
      'claude --session-id 11111111-2222-3333-4444-555555555555 --dangerously-skip-permissions "$P"',
    ),
    'claude launch line is `claude --session-id <uuid> --dangerously-skip-permissions "$P"`',
  );
  assert(
    !claudeLine.includes('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN') &&
      claudeLine.includes('CLAUDE_CODE_SANDBOXED=1') &&
      claudeLine.includes('CLAUDE_CONFIG_DIR=/home/gem/.claude'),
    'claude interactive launch allows native terminal mode while retaining sandboxed + config-dir env',
  );
  assert(
    claudeLine.includes('cat /home/gem/.claude/task-prompt.txt'),
    'claude prompt rides the `$(cat <file>)` shape (never inlined)',
  );
  assert(
    !claudeLine.includes('claude attach') &&
      !claudeLine.includes('claude agents') &&
      !claudeLine.includes('--bare') &&
      !claudeLine.includes('--no-session-persistence'),
    'claude launch line uses NONE of the incompatible flags',
  );
  let threwNoSession = false;
  try {
    claude.buildLaunchLine({
      taskId: 'abc',
      workspaceDir: '/home/gem/workspace',
      model: { kind: 'runtime-default' },
    });
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

  // ---- transcript helpers (retention primitives) -----------------------
  // align-claude-runtime-resident-session: detectExit no longer uses these (it is
  // now `tmux has-session`, asserted below). They remain pure, tested helpers the
  // retention/UX layers MAY consume — `isTurnComplete` is a turn-complete signal,
  // NOT a task-termination trigger.
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

  // detectExit (align-claude-runtime-resident-session): claude is RESIDENT — it now
  // resolves from `tmux has-session` like codex (gone => done, alive => running) and
  // NEVER tails the transcript or kills the session on a finished turn.
  const claudeGoneExec = makeExec((cmd) =>
    cmd.includes('has-session') ? { stdout: '__cap_has__1\n', code: 0 } : undefined,
  );
  const claudeGone = await claude.detectExit(claudeGoneExec, {
    taskId: 'abc',
    workspaceDir: '/home/gem/workspace',
    sessionId: 'SID',
  });
  assert(
    claudeGone.status === 'done',
    'claude detectExit: a GONE tmux session is done (codex parity)',
  );
  assert(
    claudeGoneExec.calls.some((c) => c.includes('tmux has-session -t taskabc')),
    'claude detectExit probes `tmux has-session` (codex parity), not the transcript',
  );
  assert(
    !claudeGoneExec.calls.some((c) => c.includes('kill-session')) &&
      !claudeGoneExec.calls.some((c) => c.startsWith('cat ')),
    'claude detectExit NEVER kills the session or tails the transcript (resident)',
  );
  const claudeAliveExec = makeExec((cmd) =>
    cmd.includes('has-session') ? { stdout: '__cap_has__0\n', code: 0 } : undefined,
  );
  const claudeAlive = await claude.detectExit(claudeAliveExec, {
    taskId: 'abc',
    workspaceDir: '/home/gem/workspace',
    sessionId: 'SID',
  });
  assert(
    claudeAlive.status === 'running' &&
      !claudeAliveExec.calls.some((c) => c.includes('kill-session')),
    'claude detectExit: an EXISTING session is still running (a finished turn does NOT terminate it)',
  );
  const claudeBlipExec = makeExec(() => ({ stdout: 'no sentinel here', code: 0 }));
  const claudeBlip = await claude.detectExit(claudeBlipExec, {
    taskId: 'abc',
    workspaceDir: '/home/gem/workspace',
    sessionId: 'SID',
  });
  assert(
    claudeBlip.status === 'running',
    'claude detectExit: an inconclusive probe (no sentinel) reads as running',
  );

  // (the runtime `captureTranscript` port method is REMOVED in this refactor — the
  // structured transcript capture lives in the retention path's SessionTranscriptService
  // + the provider's rollout read, never a dead per-runtime port method. The JSONL
  // parsing helpers are covered by the transcript-module cases above:
  // `parseClaudeTranscript` / `isTurnComplete` — now retention/UX primitives, no longer
  // wired into the resident-session `detectExit`.)

  // ---- 3.2 GOLDEN: sandboxSetupCommands / preStopTrimCommands emitters --------
  // Characterize the pure setup/trim emitters. Private bytes live in opaque,
  // serialization-redacted one-shot files and commands contain only fixed path/mode
  // verification. Pins conditional prompt omission, per-command unresolved-exit
  // policy, exact file contents, and the no-secret-command/argv boundary.
  const CXDIR = '/home/gem/.codex';
  const WS = '/home/gem/workspace';
  const CRED_STORE = 'cli_auth_credentials_store = "file"\n';
  const TRUST = `[projects."${WS}"]\ntrust_level = "trusted"\n`;

  // codex: null material, no prompt → 1 command (trust-only config.toml, strict)
  const cxNull = codex.sandboxSetupCommands({ taskId: 't', workspaceDir: WS, prompt: null }, null);
  assert(
    cxNull.ok === true && cxNull.commands.length === 1,
    'codex setup (no auth, no prompt) → 1 command',
  );
  assert(
    cxNull.commands[0].command ===
      `rm -f ${CXDIR}/hooks.json && test -s ${CXDIR}/config.toml && test "$(stat -c %a ${CXDIR}/config.toml)" = 600 && rm -f ${CXDIR}/auth.json`,
    'codex GOLDEN: trust-only command contains paths and verification only',
  );
  const cxNullFiles = await consumePrivateFiles(cxNull.commands);
  assert(
    cxNullFiles.get(`${CXDIR}/config.toml`) === CRED_STORE + TRUST,
    'codex GOLDEN: trust-only config.toml uses the private file channel',
  );
  assert(
    cxNull.commands[0].tolerateUnresolvedExit === false,
    'codex config command is strict (fail-closed on unresolved exit)',
  );
  assert(
    cxNull.commands[0].descriptor.commandKind === 'credential_setup' &&
      cxNull.commands[0].descriptor.ordinal === 1,
    'codex config command declares its safe descriptor',
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
      `rm -f ${CXDIR}/hooks.json && test -s ${CXDIR}/config.toml && test "$(stat -c %a ${CXDIR}/config.toml)" = 600 && test -s ${CXDIR}/auth.json && test "$(stat -c %a ${CXDIR}/auth.json)" = 600`,
    'codex GOLDEN: official setup command contains no credential bytes',
  );
  assert(
    cxOff.commands[1].command ===
      `test -s ${CXDIR}/task-prompt.txt && test "$(stat -c %a ${CXDIR}/task-prompt.txt)" = 600`,
    'codex GOLDEN: prompt setup command contains no prompt bytes',
  );
  const cxOffFiles = await consumePrivateFiles(cxOff.commands);
  assert(
    cxOffFiles.get(`${CXDIR}/config.toml`) === CRED_STORE + TRUST &&
      cxOffFiles.get(`${CXDIR}/auth.json`) === cxAuthJson &&
      cxOffFiles.get(`${CXDIR}/task-prompt.txt`) === cxPrompt,
    'codex GOLDEN: config, auth, and prompt bytes use private files',
  );
  assert(
    !JSON.stringify(cxOff).includes(cxAuthJson) &&
      !JSON.stringify(cxOff).includes(cxPrompt) &&
      !cxOff.commands.some((entry) => entry.command.includes('base64')),
    'codex setup plan serialization and commands disclose no private bytes',
  );
  assert(
    cxOff.commands[1].descriptor.commandKind === 'runtime_setup' &&
      cxOff.commands[1].descriptor.ordinal === 2,
    'codex prompt command declares its safe descriptor',
  );

  // codex: compatible, no prompt → 1 command, NO auth.json, model_providers.cap TOML
  const COMPAT = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-4o' };
  const COMPAT_TOML =
    CRED_STORE +
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
      `rm -f ${CXDIR}/hooks.json && test -s ${CXDIR}/config.toml && test "$(stat -c %a ${CXDIR}/config.toml)" = 600 && rm -f ${CXDIR}/auth.json`,
    'codex GOLDEN: compatible setup command contains no apiKey',
  );
  const cxCompFiles = await consumePrivateFiles(cxComp.commands);
  assert(
    cxCompFiles.get(`${CXDIR}/config.toml`) === COMPAT_TOML &&
      !JSON.stringify(cxComp).includes(COMPAT.apiKey),
    'codex GOLDEN: compatible config uses a serialization-redacted private file',
  );

  // codex trim — byte-exact (keeps sessions/ and proves private files absent)
  const cxTrim = codex.preStopTrimCommands();
  assert(
    cxTrim.length === 1 &&
      cxTrim[0] ===
        `rm -rf ${CXDIR}/cache ${CXDIR}/logs_*.sqlite ${CXDIR}/logs_*.sqlite-shm ${CXDIR}/logs_*.sqlite-wal && rm -f ${CXDIR}/config.toml ${CXDIR}/task-prompt.txt ${CXDIR}/auth.json && test ! -e ${CXDIR}/config.toml && test ! -e ${CXDIR}/task-prompt.txt && test ! -e ${CXDIR}/auth.json`,
    'codex GOLDEN: pre-stop proves compatible key, prompt, and auth absent while keeping sessions/',
  );
  assert(
    codex.preflightProbes().map((p) => p.name).join(',') ===
      'codex cli,git,tmux,bash,tar,gzip',
    'codex preflight declares required image tools',
  );
  assert(
    codex
      .preflightProbes()
      .every(
        (probe, index) =>
          probe.descriptor.commandKind === 'runtime_preflight' &&
          probe.descriptor.ordinal === index + 1,
      ),
    'codex preflight declares safe ordered descriptors',
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
  assert(
    clTok.commands[0].descriptor.commandKind === 'credential_setup' &&
      clTok.commands[0].descriptor.ordinal === 1 &&
      clTok.commands[1].descriptor.commandKind === 'runtime_setup' &&
      clTok.commands[1].descriptor.ordinal === 2,
    'claude setup declares safe ordered descriptors',
  );

  // claude: token, no prompt → 1 command; launch-env.sh + settings.json +
  // .claude.json byte-exact
  const clNoP = claude.sandboxSetupCommands({ taskId: 't', workspaceDir: WS, prompt: null }, { oauthToken: CLTOK });
  assert(clNoP.ok === true && clNoP.commands.length === 1, 'claude setup (token, no prompt) → 1 command');
  const clSnippet =
    `export CLAUDE_CODE_OAUTH_TOKEN='${CLTOK}'\n` +
    'unset ANTHROPIC_API_KEY\nunset ANTHROPIC_AUTH_TOKEN\nunset apiKeyHelper\n';
  const clPreseed = JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    numStartups: 5,
    hasAcknowledgedCostThreshold: true,
    bypassPermissionsModeAccepted: true,
    projects: { [WS]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  });
  const clSettings = JSON.stringify({
    permissions: { skipDangerousModePermissionPrompt: true },
  });
  assert(
    clNoP.commands[0].command ===
      `test -s /home/gem/.claude/launch-env.sh && test "$(stat -c %a /home/gem/.claude/launch-env.sh)" = 600 && test -s /home/gem/.claude/settings.json && test "$(stat -c %a /home/gem/.claude/settings.json)" = 600 && test -s /home/gem/.claude.json && test "$(stat -c %a /home/gem/.claude.json)" = 600 && test -s /home/gem/.claude/.claude.json && test "$(stat -c %a /home/gem/.claude/.claude.json)" = 600`,
    'claude GOLDEN: setup command contains paths and mode verification only',
  );
  assert(
    clNoP.commands[0].command.includes('/home/gem/.claude/settings.json'),
    'claude GUARD: user settings suppress the dangerous-mode confirmation prompt',
  );
  // REGRESSION GUARD (fix-claude-onboarding-and-token-verify): the onboarding
  // pre-seed MUST land in BOTH main-config locations, because upstream flipped which
  // one is read when CLAUDE_CONFIG_DIR is set: 2.1.181 read only `$HOME/.claude.json`
  // (config-dir copy ignored); 2.1.207 reads only `$CLAUDE_CONFIG_DIR/.claude.json`
  // (HOME-root copy ignored — live-verified 2026-07-21). Seeding a single path is a
  // version cliff that blocks tasks on the first-run wizard.
  const clFiles = await consumePrivateFiles(clNoP.commands);
  assert(
    clFiles.get('/home/gem/.claude/launch-env.sh') === clSnippet &&
      clFiles.get('/home/gem/.claude/settings.json') === clSettings &&
      clFiles.get('/home/gem/.claude.json') === clPreseed &&
      clFiles.get('/home/gem/.claude/.claude.json') === clPreseed,
    'claude GUARD: token/settings and identical dual-path preseed use private 0600 files',
  );
  assert(
    !JSON.stringify(clNoP).includes(CLTOK) &&
      !clNoP.commands[0].command.includes(CLTOK) &&
      !clNoP.commands[0].command.includes('base64'),
    'claude setup plan serialization and command disclose no token or derived encoding',
  );

  // claude trim — keeps projects/
  assert(
    claude.preStopTrimCommands()[0] ===
      `find /home/gem/.claude -mindepth 1 -maxdepth 1 ! -name projects -exec rm -rf {} + && rm -f /home/gem/.claude.json && test ! -e /home/gem/.claude/launch-env.sh && test ! -e /home/gem/.claude/task-prompt.txt && test ! -e /home/gem/.claude.json`,
    'claude GOLDEN: pre-stop keeps projects/ and proves private files absent',
  );
  assert(
    claude.preflightProbes().map((p) => p.name).join(',') ===
      'claude cli,git,tmux,bash,tar,gzip',
    'claude preflight declares required image tools',
  );
  assert(
    claude
      .preflightProbes()
      .every(
        (probe, index) =>
          probe.descriptor.commandKind === 'runtime_preflight' &&
          probe.descriptor.ordinal === index + 1,
      ),
    'claude preflight declares safe ordered descriptors',
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
