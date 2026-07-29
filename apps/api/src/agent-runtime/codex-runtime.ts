import {
  buildDetachedCodexLaunchLine,
  buildHasSessionCommand,
  CODEX_PROMPT_FILE_PATH,
  wrapHeadlessDetachedSession,
  wrapInDetachedSession,
} from './codex-launch';
import {
  assertNativeCodexInteractiveLaunchArgv,
  createSandboxRuntimePrivateFile,
  DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
} from '@cap-console/sandbox';
import type {
  AgentRuntime,
  AuthMaterial,
  ExecutionMode,
  ExitSignal,
  LaunchContext,
  RuntimeId,
  RuntimeOutputFailure,
  SandboxExec,
  SandboxRuntimePreflightProbe,
  SandboxSetupCommand,
  SandboxSetupContext,
  SandboxSetupPlan,
  TerminalStartup,
  TranscriptArtifact,
  TranscriptFormat,
  TranscriptReadStrategy,
} from './agent-runtime.port';
import { classifyCodexOutputFailure } from './runtime-output-failure-classifier';
import { explicitTaskModelShellMaterial } from './task-model-launch';

/**
 * CodexRuntime (add-claude-code-runtime, task 2.2) — today's hard-coded codex
 * execution logic moved BEHIND the {@link AgentRuntime} port, behavior-preserving.
 *
 * After refactor-agent-runtime-policy-mechanism it is a POLICY object — declarative
 * data + pure command-emitters + one `detectExit`, owning no I/O — and every seam
 * reproduces the existing codex behavior byte-for-byte:
 *   - buildLaunchLine        → the SAME detached-tmux launch (via the shared
 *     {@link buildDetachedCodexLaunchLine} / `wrapInDetachedSession`) from the SAME
 *     `CODEX_LAUNCH_ARGV` default, wrapping `buildCodexLaunchLine`'s `$(cat)` shape.
 *   - terminalStartup        → declares the DSR-reply + cr-on-quiesce policy the
 *     shared pty mechanism reads (replaces the old `autoSubmit` observer).
 *   - sandboxSetupCommands   → the ORDERED config.toml (+ auth.json official /
 *     model_providers.cap compatible) + prompt-file commands the provider runs
 *     (replaces the provider's inline `injectCodexAuth`/`injectTaskPrompt`).
 *   - preStopTrimCommands    → the `~/.codex` trim (keep `sessions/`, zero auth.json).
 *   - detectExit             → `tmux has-session` over the exec handle: a GONE
 *     session is `done`, an existing session is `running`.
 * The structured-transcript capture lives in the retention path, not a per-runtime
 * port method; the shared byte-stream asciicast remains the primary replay.
 */
export class CodexRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'codex';

  classifyOutputFailure(rollingOutput: string): RuntimeOutputFailure | null {
    return classifyCodexOutputFailure(rollingOutput);
  }

  /**
   * The codex launch argv — the SAME base string the provider-neutral sandbox
   * session engine uses ({@link DEFAULT_CODEX_LAUNCH_ARGV}) and the derived image bakes as
   * `CODEX_LAUNCH_ARGV`. The launch uses Codex's documented YOLO-style bypass
   * flag (`--dangerously-bypass-approvals-and-sandbox`) so task agents do not
   * stop for per-command approvals inside the already-isolated per-task sandbox.
   * No terminal-mode override is applied: Codex may enter its default alternate
   * screen and emit its native cursor, style, mouse, focus, and query sequences.
   * Running-terminal history across reconnect is intentionally not synthesized.
   */
  static readonly DEFAULT_CODEX_LAUNCH_ARGV =
    DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV;

  /** The codex `~/.codex` directory the auth.json is written into. */
  private static readonly CODEX_HOME_DIR = '/home/gem/.codex';

  /**
   * Declarative terminal-startup policy (refactor-agent-runtime-policy-mechanism:
   * replaces the dead `autoSubmit`). codex's positional prompt only PRE-FILLS the
   * composer, so the SHARED pty mechanism replies to crossterm's startup DSR
   * (`\x1b[6n`) with a synthetic CPR (`\x1b[1;1R`) and, after output quiesces,
   * injects a single Enter (`\r`). The quiesce window stays env-tunable
   * (`CODEX_AUTOSUBMIT_QUIESCE_MS`, default 800) — the SAME value the pty client
   * read inline, so behavior is byte-identical. A getter so the env is read at
   * access time (test-tunable), exactly like the prior `autoSubmitQuiesceMs`.
   */
  get terminalStartup(): TerminalStartup {
    return {
      replyToStartupDSR: true,
      promptSubmit: 'cr-on-quiesce',
      quiesceMs: Number(process.env['CODEX_AUTOSUBMIT_QUIESCE_MS'] ?? 800),
    };
  }

  /** Resolve the base codex argv (env override wins), mirroring `launchCodex`. */
  private resolveArgv(): string {
    return assertNativeCodexInteractiveLaunchArgv(
      process.env['CODEX_LAUNCH_ARGV'] ??
        CodexRuntime.DEFAULT_CODEX_LAUNCH_ARGV,
    );
  }

  buildLaunchLine(ctx: LaunchContext): string {
    // Identical to the pty client's `launchCodex`: wrap the base argv in the
    // detached named tmux session whose inner line reads the prompt file via
    // `$(cat …)` and passes it positionally. Workspace cwd is `ctx.workspaceDir`.
    const argv = this.resolveArgv();
    const model = explicitTaskModelShellMaterial(ctx.model);
    if (model) {
      const launch =
        `P="$(cat ${CODEX_PROMPT_FILE_PATH} 2>/dev/null)"; ` +
        `if [ -n "$P" ]; then set -- "$P"; else set --; fi; ` +
        `${argv} ${model.argument} "$@"`;
      return wrapInDetachedSession(
        ctx.taskId,
        `${model.guard}{ ${launch}; }`,
        ctx.workspaceDir,
      );
    }
    return buildDetachedCodexLaunchLine(
      ctx.taskId,
      argv,
      undefined,
      ctx.workspaceDir,
    );
  }

  /**
   * The compatible-provider TOML fragments, byte-identical to the provider's prior
   * inline `compatibleProviderToml` (wire-compatible-provider-execution). `esc`
   * escapes backslash + double-quote so an operator value cannot break the TOML
   * string. Top-level `model`/`model_provider` are written as a PREFIX (bare keys
   * must precede any table header), the `[model_providers.cap]` table as a suffix.
   */
  private static compatibleProviderToml(material: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }): { topLevel: string; providerTable: string } {
    const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return {
      topLevel: `model = "${esc(material.model)}"\nmodel_provider = "cap"\n`,
      providerTable:
        `[model_providers.cap]\n` +
        `name = "Compatible provider"\n` +
        `base_url = "${esc(material.baseUrl)}"\n` +
        `wire_api = "responses"\n` +
        `experimental_bearer_token = "${esc(material.apiKey)}"\n`,
    };
  }

  sandboxSetupCommands(
    ctx: SandboxSetupContext,
    material: AuthMaterial | null,
  ): SandboxSetupPlan {
    const dir = CodexRuntime.CODEX_HOME_DIR;
    const commands: SandboxSetupCommand[] = [];

    // config.toml (always: the workspace-trust table) + auth.json (official only),
    // assembled as ONE combined command — byte-identical to the provider's prior
    // inline `injectCodexAuth`. Compatible material adds the top-level model keys
    // (PREFIX) + the provider table (SUFFIX); no auth.json. No credential → the
    // trust table alone (codex runs unauthenticated, degraded — NOT a failure).
    const trustTable = `[projects."${ctx.workspaceDir}"]\ntrust_level = "trusted"\n`;
    let topLevel = '';
    let providerTable = '';
    const privateFiles = [];
    let hasOfficialAuthFile = false;
    if (material?.codexCompatible) {
      ({ topLevel, providerTable } = CodexRuntime.compatibleProviderToml(
        material.codexCompatible,
      ));
    } else if (material?.authJson) {
      hasOfficialAuthFile = true;
      privateFiles.push(
        createSandboxRuntimePrivateFile(`${dir}/auth.json`, material.authJson),
      );
    }
    // fix-codex-headless-subscription-auth: codex defaults to `cli_auth_credentials_store="auto"`
    // (OS keyring first); the keyring-less Linux sandbox then loads NO credential and every
    // request fails `401 "Missing bearer"`. Force the FILE store so codex reads the injected
    // `auth.json`. A top-level key — MUST precede any `[table]` (the trust/provider tables).
    const credStore = 'cli_auth_credentials_store = "file"\n';
    const configToml = credStore + topLevel + trustTable + providerTable;
    privateFiles.unshift(
      createSandboxRuntimePrivateFile(`${dir}/config.toml`, configToml),
    );
    const authVerification = hasOfficialAuthFile
      ? ` && test -s ${dir}/auth.json && test "$(stat -c %a ${dir}/auth.json)" = 600`
      : ` && rm -f ${dir}/auth.json`;
    commands.push({
      descriptor: { commandKind: 'credential_setup', ordinal: 1 },
      command:
        `rm -f ${dir}/hooks.json && ` +
        `test -s ${dir}/config.toml && test "$(stat -c %a ${dir}/config.toml)" = 600` +
        authVerification,
      tolerateUnresolvedExit: false,
      privateFiles,
    });

    // prompt-file write — OMITTED entirely when there is no prompt (codex opens a
    // blank composer), matching the prior `injectTaskPrompt` early-return.
    if (ctx.prompt) {
      commands.push({
        descriptor: { commandKind: 'runtime_setup', ordinal: 2 },
        command:
          `test -s ${CODEX_PROMPT_FILE_PATH} && ` +
          `test "$(stat -c %a ${CODEX_PROMPT_FILE_PATH})" = 600`,
        tolerateUnresolvedExit: false,
        privateFiles: [
          createSandboxRuntimePrivateFile(CODEX_PROMPT_FILE_PATH, ctx.prompt),
        ],
      });
    }
    return { ok: true, commands };
  }

  preflightProbes(): readonly SandboxRuntimePreflightProbe[] {
    return [
      {
        name: 'codex cli',
        command: 'command -v codex',
        descriptor: { commandKind: 'runtime_preflight', ordinal: 1 },
      },
      {
        name: 'git',
        command: 'command -v git',
        descriptor: { commandKind: 'runtime_preflight', ordinal: 2 },
      },
      {
        name: 'tmux',
        command: 'command -v tmux',
        descriptor: { commandKind: 'runtime_preflight', ordinal: 3 },
      },
      {
        name: 'bash',
        command: 'command -v bash',
        descriptor: { commandKind: 'runtime_preflight', ordinal: 4 },
      },
      {
        name: 'tar',
        command: 'command -v tar',
        descriptor: { commandKind: 'runtime_preflight', ordinal: 5 },
      },
      {
        name: 'gzip',
        command: 'command -v gzip',
        descriptor: { commandKind: 'runtime_preflight', ordinal: 6 },
      },
    ];
  }

  preStopTrimCommands(): readonly string[] {
    const dir = CodexRuntime.CODEX_HOME_DIR;
    // Keep `sessions/` (rollout); drop caches + sqlite logs, the prompt, and
    // config.toml (which may hold a compatible-provider bearer token), then
    // remove auth.json and prove every credential-bearing path is absent. AIO
    // may retain the stopped sandbox only after this command succeeds.
    return [
      `rm -rf ${dir}/cache ${dir}/logs_*.sqlite ${dir}/logs_*.sqlite-shm ${dir}/logs_*.sqlite-wal && ` +
        `rm -f ${dir}/config.toml ${CODEX_PROMPT_FILE_PATH} ${dir}/auth.json && ` +
        `test ! -e ${dir}/config.toml && ` +
        `test ! -e ${CODEX_PROMPT_FILE_PATH} && ` +
        `test ! -e ${dir}/auth.json`,
    ];
  }

  async detectExit(exec: SandboxExec, ctx: LaunchContext): Promise<ExitSignal> {
    // Identical signal to the liveness poller's `tmux has-session`: a session
    // that EXISTS (exit 0) is still running; a GONE session (non-zero) is done.
    // The `__cap_has__$?` sentinel mirrors `probeSessionLiveness`. An inconclusive
    // probe (no sentinel) is treated as still-running so a transport blip is never
    // mistaken for completion (the poller re-checks).
    const { stdout } = await exec.exec(
      `${buildHasSessionCommand(ctx.taskId)}; echo __cap_has__$?`,
    );
    const match = /__cap_has__(\d+)/.exec(stdout);
    if (!match) return { status: 'running' };
    return match[1] === '0' ? { status: 'running' } : { status: 'done' };
  }

  // ------------------------------------------------------------------------
  // headless-exec mode (add-headless-execution-track)
  // ------------------------------------------------------------------------

  /** codex supports both the interactive TUI and the non-interactive `exec`. */
  readonly executionModes: ReadonlySet<ExecutionMode> = new Set([
    'interactive-pty',
    'headless-exec',
  ]);

  /** codex transcript = the rollout JSONL under `~/.codex/sessions`. */
  readonly transcriptFormat: TranscriptFormat = 'codex-rollout';
  transcriptArtifact(_ctx: LaunchContext): TranscriptArtifact {
    return {
      dir: `${CodexRuntime.CODEX_HOME_DIR}/sessions`,
      filenameGlob: /(^|\/)rollout-.*\.jsonl$/,
    };
  }

  /**
   * codex persists a single newest rollout JSONL file (unify-transcript-parsers D3),
   * so the read mechanism reads the lexicographically-newest `transcriptArtifact` match
   * and hands the codex-rollout parser a `{ format, jsonl }` source — the prior verbatim
   * read. A future multi-record runtime declares a different strategy without touching this.
   */
  readonly readTranscriptSource: TranscriptReadStrategy = {
    kind: 'single-newest-jsonl',
  };

  /**
   * Headless one-shot: `codex exec --json`. fix-headless-execution-container-gaps — the
   * `exec` SUBCOMMAND flag surface differs from the interactive top-level one: it accepts the
   * single bypass `--dangerously-bypass-approvals-and-sandbox` and REJECTS the interactive
   * `--ask-for-approval` / `--sandbox` / `--dangerously-bypass-hook-trust` (passing those
   * aborts exec before any rollout is written → the production `no-rollout` defect). `-C` is
   * dropped — the detached wrapper's `tmux -c <ws>` already sets cwd. `--skip-git-repo-check`
   * (the clone is not a git repo) and `< /dev/null` (codex 0.131 `exec` blocks on extra stdin
   * otherwise) are MANDATORY (spike). The prompt rides `"$(cat …)"`, never inlined. Wrapped in
   * the HEADLESS detached session so the agent's real exit code is captured for resolution.
   */
  buildHeadlessLine(ctx: LaunchContext): string {
    const ws = ctx.workspaceDir;
    const model = explicitTaskModelShellMaterial(ctx.model);
    const modelArgument = model ? ` ${model.argument}` : '';
    const launch =
      `P="$(cat ${CODEX_PROMPT_FILE_PATH} 2>/dev/null)"; ` +
      `codex exec --json --dangerously-bypass-approvals-and-sandbox ` +
      `--skip-git-repo-check${modelArgument} "$P" < /dev/null`;
    const inner = model ? `${model.guard}{ ${launch}; }` : launch;
    return wrapHeadlessDetachedSession(ctx.taskId, inner, ws);
  }

  /**
   * Headless resume: `codex exec resume <id>` continues a prior session. Note the flag
   * surface is NARROWER than `exec` — it rejects `-s/--sandbox` (sandbox is inherited from
   * the original session), but the YOLO bypass itself is accepted and MUST be repeated.
   * Live verification against the pinned 0.144.1 CLI showed that relying on inherited
   * approval policy can return exit 0 without performing tool calls. It also needs
   * `--skip-git-repo-check` and `< /dev/null` (spike).
   */
  buildResumeLine(ctx: LaunchContext, prevSessionId: string): string {
    const ws = ctx.workspaceDir;
    const sessionId = safeResumeSessionId(prevSessionId);
    const inner =
      `P="$(cat ${CODEX_PROMPT_FILE_PATH} 2>/dev/null)"; ` +
      `codex exec resume --json --dangerously-bypass-approvals-and-sandbox ` +
      `--skip-git-repo-check ${sessionId} "$P" < /dev/null`;
    return wrapHeadlessDetachedSession(ctx.taskId, inner, ws);
  }
}

/**
 * Resume ids are emitted by the runtime transcript and normally UUIDs. Keep the
 * slightly wider documented Codex thread-name alphabet, but reject shell syntax:
 * the value is embedded inside the single-quoted tmux command and therefore must
 * remain one inert shell token.
 */
function safeResumeSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error('Codex resume session id is not a safe runtime identifier');
  }
  return value;
}
