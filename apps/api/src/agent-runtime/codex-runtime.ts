import {
  argvDisablesHooks,
  buildDetachedCodexLaunchLine,
  buildHasSessionCommand,
  CODEX_PROMPT_FILE_PATH,
  wrapInDetachedSession,
} from '../terminal/codex-launch';
import type {
  AgentRuntime,
  AuthMaterial,
  ExecutionMode,
  ExitSignal,
  LaunchContext,
  RuntimeId,
  SandboxExec,
  SandboxSetupCommand,
  SandboxSetupContext,
  SandboxSetupPlan,
  TerminalStartup,
  TranscriptArtifact,
  TranscriptFormat,
} from './agent-runtime.port';

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

  /**
   * The codex launch argv — the SAME base string the `AioPtyClient` uses
   * ({@link DEFAULT_CODEX_LAUNCH_ARGV}) and the derived image bakes as
   * `CODEX_LAUNCH_ARGV`. 0.131 non-interactive auto-run:
   * `--ask-for-approval never --sandbox danger-full-access` +
   * `--dangerously-bypass-hook-trust`, run in the cloned workspace via `-C`.
   * Kept verbatim so the launch line is byte-identical to before the refactor.
   */
  static readonly DEFAULT_CODEX_LAUNCH_ARGV =
    'codex -C /home/gem/workspace --ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust';

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
    return (
      process.env['CODEX_LAUNCH_ARGV'] ??
      CodexRuntime.DEFAULT_CODEX_LAUNCH_ARGV
    );
  }

  buildLaunchLine(ctx: LaunchContext): string {
    // Identical to the pty client's `launchCodex`: wrap the base argv in the
    // detached named tmux session whose inner line reads the prompt file via
    // `$(cat …)` and passes it positionally. Workspace cwd is `ctx.workspaceDir`.
    const argv = this.resolveArgv();
    // VR-5: preserve the hook-disabling guard that lived in `launchCodex` — never
    // launch codex with a flag that turns the baked approval hooks off (`-s` /
    // `--yolo` / bypass-approvals would fail OPEN on approvals). The guard inspects
    // ONLY the fixed `argv`, never the operator prompt (which rides the `$(cat)`
    // file), so it cannot false-positive on prompt text. Moved here so codex driven
    // THROUGH this port keeps the guard the inline path had.
    if (argvDisablesHooks(argv)) {
      throw new Error(
        `refusing to launch codex with hook-disabling flags (-s / --yolo / bypass-approvals would fail open on approvals): ${argv}`,
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
    let authJsonCommand = '';
    if (material?.codexCompatible) {
      ({ topLevel, providerTable } = CodexRuntime.compatibleProviderToml(
        material.codexCompatible,
      ));
    } else if (material?.authJson) {
      const authB64 = Buffer.from(material.authJson, 'utf8').toString('base64');
      authJsonCommand =
        ` && printf %s '${authB64}' | base64 -d > ${dir}/auth.json && chmod 600 ${dir}/auth.json`;
    }
    const configToml = topLevel + trustTable + providerTable;
    const configB64 = Buffer.from(configToml, 'utf8').toString('base64');
    commands.push({
      command:
        `mkdir -p ${dir} && rm -f ${dir}/hooks.json && printf %s '${configB64}' | base64 -d > ${dir}/config.toml && chmod 600 ${dir}/config.toml` +
        authJsonCommand,
      tolerateUnresolvedExit: false,
    });

    // prompt-file write — OMITTED entirely when there is no prompt (codex opens a
    // blank composer), matching the prior `injectTaskPrompt` early-return.
    if (ctx.prompt) {
      const promptB64 = Buffer.from(ctx.prompt, 'utf8').toString('base64');
      commands.push({
        command: `mkdir -p ${dir} && printf %s '${promptB64}' | base64 -d > ${CODEX_PROMPT_FILE_PATH} && chmod 600 ${CODEX_PROMPT_FILE_PATH}`,
        tolerateUnresolvedExit: false,
      });
    }
    return { ok: true, commands };
  }

  preStopTrimCommands(): readonly string[] {
    const dir = CodexRuntime.CODEX_HOME_DIR;
    // Keep `sessions/` (rollout); drop caches + sqlite logs; zero auth.json. Trailing
    // `true` + `2>/dev/null` keep it exit-0 best-effort. Byte-identical to the prior
    // inline `trimCodexHomeBeforeStop`.
    return [
      `rm -rf ${dir}/cache ${dir}/logs_*.sqlite ${dir}/logs_*.sqlite-shm ${dir}/logs_*.sqlite-wal 2>/dev/null; ` +
        `: > ${dir}/auth.json 2>/dev/null; true`,
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
   * Headless one-shot: `codex exec --json` with the SAME sandbox/approval flags as the
   * interactive argv, plus `--skip-git-repo-check` (the cloned workspace is not a git
   * repo) and `< /dev/null` — MANDATORY: codex 0.131 `exec` blocks reading additional
   * stdin otherwise (spike). The prompt rides `"$(cat …)"`, never inlined. Wrapped in the
   * SAME detached named session as the interactive line, so the liveness poller + boot
   * re-adoption resolve it on natural exit.
   */
  buildHeadlessLine(ctx: LaunchContext): string {
    const ws = ctx.workspaceDir;
    const inner =
      `P="$(cat ${CODEX_PROMPT_FILE_PATH} 2>/dev/null)"; ` +
      `codex exec --json -C ${ws} --ask-for-approval never --sandbox danger-full-access ` +
      `--dangerously-bypass-hook-trust --skip-git-repo-check "$P" < /dev/null`;
    return wrapInDetachedSession(ctx.taskId, inner, ws);
  }

  /**
   * Headless resume: `codex exec resume <id>` continues a prior session. Note the flag
   * surface is NARROWER than `exec` — it rejects `-s/--sandbox` (sandbox is inherited from
   * the original session) but still needs `--skip-git-repo-check` and `< /dev/null` (spike).
   */
  buildResumeLine(ctx: LaunchContext, prevSessionId: string): string {
    const ws = ctx.workspaceDir;
    const inner =
      `P="$(cat ${CODEX_PROMPT_FILE_PATH} 2>/dev/null)"; ` +
      `codex exec resume ${prevSessionId} "$P" --json --skip-git-repo-check < /dev/null`;
    return wrapInDetachedSession(ctx.taskId, inner, ws);
  }
}
