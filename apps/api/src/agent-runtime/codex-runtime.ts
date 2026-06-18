import {
  argvDisablesHooks,
  buildDetachedCodexLaunchLine,
  detachedSessionName,
} from '../terminal/codex-launch';
import type {
  AgentRuntime,
  AuthMaterial,
  AutoSubmitPty,
  ExitSignal,
  InjectAuthResult,
  LaunchContext,
  RuntimeId,
  SandboxExec,
  TranscriptCapture,
} from './agent-runtime.port';

/**
 * CodexRuntime (add-claude-code-runtime, task 2.2) — today's hard-coded codex
 * execution logic moved BEHIND the {@link AgentRuntime} port, behavior-preserving.
 *
 * Every seam reproduces the existing codex behavior byte-for-byte so the codex
 * end-to-end suite passes unchanged after the refactor:
 *   - buildLaunchLine     → the SAME detached-tmux launch the `AioPtyClient` built
 *     via {@link buildDetachedCodexLaunchLine} from the SAME `CODEX_LAUNCH_ARGV`
 *     default (env-overridable), wrapping `buildCodexLaunchLine`'s `$(cat)` shape.
 *   - injectAuth          → write `~/.codex/auth.json` verbatim (the provider's
 *     `injectCodexAuth`), degrading to unauthenticated (a warning, NOT a failure)
 *     when no material is configured — exactly today's behavior.
 *   - autoSubmit          → the DSR-gated CPR reply + output-quiescence single
 *     carriage-return zero-touch prompt auto-submit.
 *   - detectExit          → `tmux has-session` over the exec handle: a GONE
 *     session is `done`, an existing session is `running`.
 *   - captureTranscript   → codex has no extra structured source HERE (the rollout
 *     read stays in the provider/rollout-parser path), so this returns no records;
 *     the shared byte-stream asciicast remains the primary replay.
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
   * The DSR (Device Status Report) cursor-position query crossterm emits at codex
   * TUI startup, `ESC[6n` (DSR-6, NO `?`). codex BLOCKS waiting for a CPR reply;
   * observing it confirms codex (not the shell) owns the terminal — the gate for
   * the zero-touch prompt auto-submit. Kept byte-identical to the pty client.
   */
  static readonly DSR_CURSOR_POSITION_QUERY = '\x1b[6n';

  /** The synthetic CPR (Cursor Position Report) reply injected on seeing the DSR. */
  static readonly SYNTHETIC_CPR_REPLY = '\x1b[1;1R';

  /** The Enter key the codex composer submits on — the single zero-touch CR. */
  static readonly CODEX_SUBMIT_KEY = '\r';

  /**
   * Output-quiescence window (ms) the prompt auto-submit waits AFTER the startup
   * DSR before injecting the Enter. Env-tunable (`CODEX_AUTOSUBMIT_QUIESCE_MS`),
   * matching the pty client default so behavior is identical.
   */
  static get autoSubmitQuiesceMs(): number {
    return Number(process.env['CODEX_AUTOSUBMIT_QUIESCE_MS'] ?? 800);
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

  async injectAuth(
    exec: SandboxExec,
    material: AuthMaterial | null,
  ): Promise<InjectAuthResult> {
    const dir = CodexRuntime.CODEX_HOME_DIR;
    const authJson = material?.authJson;
    if (!authJson) {
      // Today's behavior: no auth configured is NOT a failure — the workspace
      // trust (config.toml) is still written by the provider and codex runs
      // unauthenticated. So this seam reports ok:true (degraded) and writes
      // nothing here; the provider's warning log is unchanged.
      return { ok: true };
    }
    // Mirror the provider's `injectCodexAuth`: base64 the document and decode it
    // into `~/.codex/auth.json` (0600). The provider writes config.toml + auth
    // together; here we only own the credential write — the config.toml trust
    // step stays in the provider (it is workspace-policy, not credential).
    const authB64 = Buffer.from(authJson, 'utf8').toString('base64');
    await exec.exec(
      `mkdir -p ${dir} && printf %s '${authB64}' | base64 -d > ${dir}/auth.json && chmod 600 ${dir}/auth.json`,
    );
    return { ok: true };
  }

  autoSubmit(pty: AutoSubmitPty, _ctx: LaunchContext): () => void {
    // The DSR-gated zero-touch prompt auto-submit, reproduced from the pty
    // client's `onOutput`/`maybeArmPromptAutoSubmit`:
    //   1. On the startup DSR (`ESC[6n`) reply with the synthetic CPR so codex
    //      proceeds past startup, and arm the prompt auto-submit.
    //   2. After the DSR, debounce on output quiescence; the FIRST stretch of no
    //      output fires a single Enter to submit the pre-filled composer, once.
    let dsrSeen = false;
    let promptSubmitted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const armSubmit = (): void => {
      if (!dsrSeen || promptSubmitted) return;
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        if (promptSubmitted) return;
        promptSubmitted = true;
        pty.sendInput(CodexRuntime.CODEX_SUBMIT_KEY);
      }, CodexRuntime.autoSubmitQuiesceMs);
    };

    const detach = pty.onOutput((chunk: string) => {
      if (chunk.length === 0) return;
      if (chunk.includes(CodexRuntime.DSR_CURSOR_POSITION_QUERY)) {
        pty.sendInput(CodexRuntime.SYNTHETIC_CPR_REPLY);
        dsrSeen = true;
      }
      armSubmit();
    });

    // Teardown: detach the observer and cancel any pending Enter so it can never
    // fire after the bridge tore down (the pty client clears this on WS close).
    return () => {
      clearTimer();
      detach();
    };
  }

  async detectExit(exec: SandboxExec, ctx: LaunchContext): Promise<ExitSignal> {
    // Identical signal to the liveness poller's `tmux has-session`: a session
    // that EXISTS (exit 0) is still running; a GONE session (non-zero) is done.
    // The `__cap_has__$?` sentinel mirrors `probeSessionLiveness`. An inconclusive
    // probe (no sentinel) is treated as still-running so a transport blip is never
    // mistaken for completion (the poller re-checks).
    const session = detachedSessionName(ctx.taskId);
    const { stdout } = await exec.exec(
      `tmux has-session -t ${session}; echo __cap_has__$?`,
    );
    const match = /__cap_has__(\d+)/.exec(stdout);
    if (!match) return { status: 'running' };
    return match[1] === '0' ? { status: 'running' } : { status: 'done' };
  }

  async captureTranscript(
    _exec: SandboxExec,
    _ctx: LaunchContext,
  ): Promise<TranscriptCapture> {
    // Codex's structured transcript (the rollout JSONL) is read by the provider's
    // retention path through `rollout-parser`, not here — that path is unchanged.
    // The shared byte-stream asciicast remains the primary replay source, so this
    // seam adds no structured records for codex.
    return { records: [] };
  }
}
