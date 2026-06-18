import { detachedSessionName } from '../terminal/codex-launch';
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
import {
  claudeTranscriptPath,
  isTurnComplete,
  parseClaudeTranscript,
} from './claude-transcript';

/**
 * ClaudeCodeRuntime (add-claude-code-runtime, tasks 2.4–2.8) — the second
 * {@link AgentRuntime}, running the interactive Claude Code TUI in the SAME
 * detached-tmux model as codex (design D2), so the asciicast capture/replay,
 * liveness poller, and boot re-adoption apply unchanged. It diverges from codex
 * on four seams: a simpler env-token auth, a no-op autosubmit (Claude auto-runs
 * its positional prompt), transcript-driven exit detection (an interactive turn
 * never exits the process), and a structured JSONL archival source.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'claude-code';

  /** Claude's config/home directory inside the sandbox (the `gem` user's HOME). */
  static readonly CONFIG_DIR = '/home/gem/.claude';

  /**
   * Absolute path of the injected task-prompt file inside the sandbox. The
   * provider base64-decodes `task.prompt` into this file at provision time; the
   * launch line reads it via `"$(cat …)"` and passes it as Claude's positional
   * prompt — the SAME shell-injection-safe `$(cat)` shape codex uses, so the
   * prompt text is never inlined into the command.
   */
  static readonly PROMPT_FILE_PATH = '/home/gem/.claude/task-prompt.txt';

  /**
   * The sandbox env-export snippet `injectAuth` writes and the launch line
   * SOURCES (task 2.5). Keeping the token in a sourced file — not in the literal
   * launch argv — keeps it out of the command line / `docker inspect` and lets a
   * single `. <file>` set the token AND unset the shadowing vars on the launch
   * environment in one place.
   */
  static readonly AUTH_ENV_FILE_PATH = '/home/gem/.claude/launch-env.sh';

  /**
   * The pre-seeded Claude config that suppresses BOTH first-run gates at provision
   * time (the analog of codex's `config.toml` trust step). `CLAUDE_CODE_SANDBOXED=1`
   * short-circuits the workspace TRUST dialog, but the GLOBAL theme/onboarding
   * screen still blocks the first interactive launch unless the top-level `theme` +
   * `hasCompletedOnboarding` keys are present (spike-confirmed: a per-project trust
   * entry ALONE leaves the theme screen blocking). So this seeds both the global
   * onboarding keys AND the per-project trust entry for the canonical workspace.
   */
  static readonly CLAUDE_JSON_PATH = '/home/gem/.claude/.claude.json';

  /** The canonical workspace path the per-project trust entry is keyed on. */
  static readonly WORKSPACE_DIR = '/home/gem/workspace';

  // ------------------------------------------------------------------------
  // 2.4 — launch line
  // ------------------------------------------------------------------------

  /**
   * Build the detached-tmux launch line for Claude (task 2.4):
   *
   *   tmux new-session -d -s task<id> -c <workspace> \
   *     'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 CLAUDE_CODE_SANDBOXED=1 \
   *      CLAUDE_CONFIG_DIR=/home/gem/.claude \
   *      . <auth-env-file>; P="$(cat <prompt-file>)"; \
   *      claude --session-id <uuid> --permission-mode acceptEdits "$P"'
   *
   *   - `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` keeps the TUI in the normal
   *     buffer so the existing asciicast capture (no alt-screen branch) replays it.
   *   - `CLAUDE_CODE_SANDBOXED=1` short-circuits the workspace trust gate.
   *   - `CLAUDE_CONFIG_DIR=/home/gem/.claude` pins the config/home so the
   *     pre-seeded onboarding/trust and the transcript live where we expect.
   *   - `. <auth-env-file>` sources the token + the ANTHROPIC_* unsets onto the
   *     launch env (task 2.5), so a stray API key cannot shadow the OAuth token.
   *   - The prompt rides `"$(cat <file>)"` (never inlined). Unlike codex, Claude
   *     AUTO-RUNS the positional prompt, so there is no Enter to inject.
   *
   * It NEVER uses `claude attach`, `claude agents`, `--bare`,
   * `--no-session-persistence`, or `--dangerously-skip-permissions` (each breaks
   * the inline-buffer, auth, or transcript assumptions, or hard-refuses root).
   */
  buildLaunchLine(ctx: LaunchContext): string {
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      // The --session-id uuid is load-bearing: it names the transcript JSONL
      // detectExit tails. A launch without it could never resolve completion, so
      // refuse rather than launch a task that can never finish.
      throw new Error(
        'ClaudeCodeRuntime.buildLaunchLine requires ctx.sessionId (the --session-id uuid)',
      );
    }
    const envPrefix =
      'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 ' +
      'CLAUDE_CODE_SANDBOXED=1 ' +
      `CLAUDE_CONFIG_DIR=${ClaudeCodeRuntime.CONFIG_DIR}`;
    // Source the auth env (token + ANTHROPIC_* unsets), read the prompt file, and
    // launch claude with the prompt positionally. `2>/dev/null` + the file's own
    // existence guard keep a missing prompt/auth file from aborting the launch.
    const inner =
      `${envPrefix} ` +
      `. ${ClaudeCodeRuntime.AUTH_ENV_FILE_PATH} 2>/dev/null; ` +
      `P="$(cat ${ClaudeCodeRuntime.PROMPT_FILE_PATH} 2>/dev/null)"; ` +
      `claude --session-id ${sessionId} --permission-mode acceptEdits "$P"`;
    const session = detachedSessionName(ctx.taskId);
    return `tmux new-session -d -s ${session} -c ${ctx.workspaceDir} '${inner}'`;
  }

  // ------------------------------------------------------------------------
  // 2.5 — credential injection via env token + ANTHROPIC_* unset
  // ------------------------------------------------------------------------

  /**
   * Write the launch-env snippet that sets `CLAUDE_CODE_OAUTH_TOKEN` and UNSETS
   * `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper` (task 2.5), then the
   * launch line sources it. Fails CLOSED with a distinct "runtime not configured"
   * reason when no token is configured — a `claude-code` task must NOT launch
   * unauthenticated (the deliberate divergence from codex, which degrades).
   *
   * The ANTHROPIC_* unsets are unconditional: a non-empty `ANTHROPIC_API_KEY`
   * silently shadows the OAuth subscription token (spike-confirmed), so the launch
   * env must neutralize it whether or not it is currently set. `apiKeyHelper` is
   * cleared from Claude's settings the same way (an env var here is the seam;
   * the settings-file form is handled at provision time by the provider).
   */
  async injectAuth(
    exec: SandboxExec,
    material: AuthMaterial | null,
  ): Promise<InjectAuthResult> {
    const token = material?.oauthToken?.trim();
    if (!token) {
      return { ok: false, reason: 'runtime not configured' };
    }
    // Base64 the token so it survives the shell round-trip with no quoting pain
    // and never appears as readable text in the exec command. The sourced snippet
    // exports the token and unsets the shadowing vars on the launch env.
    const tokenB64 = Buffer.from(token, 'utf8').toString('base64');
    const snippet =
      `export CLAUDE_CODE_OAUTH_TOKEN="$(printf %s '${tokenB64}' | base64 -d)"\n` +
      'unset ANTHROPIC_API_KEY\n' +
      'unset ANTHROPIC_AUTH_TOKEN\n' +
      'unset apiKeyHelper\n';
    const snippetB64 = Buffer.from(snippet, 'utf8').toString('base64');
    const file = ClaudeCodeRuntime.AUTH_ENV_FILE_PATH;
    const dir = ClaudeCodeRuntime.CONFIG_DIR;
    // Pre-seed `.claude.json` at provision time so the first interactive launch
    // hits NO trust dialog AND no global theme/onboarding screen (VR-4): global
    // onboarding keys + the per-project trust entry for the canonical workspace.
    const preseed = JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      numStartups: 5,
      hasAcknowledgedCostThreshold: true,
      bypassPermissionsModeAccepted: true,
      projects: {
        [ClaudeCodeRuntime.WORKSPACE_DIR]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    });
    const preseedB64 = Buffer.from(preseed, 'utf8').toString('base64');
    const claudeJson = ClaudeCodeRuntime.CLAUDE_JSON_PATH;
    const { code } = await exec.exec(
      `mkdir -p ${dir} && ` +
        `printf %s '${snippetB64}' | base64 -d > ${file} && chmod 600 ${file} && ` +
        `printf %s '${preseedB64}' | base64 -d > ${claudeJson} && chmod 600 ${claudeJson}`,
    );
    if (code !== null && code !== 0) {
      return { ok: false, reason: 'runtime not configured' };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------------
  // 2.6 — autosubmit is a no-op
  // ------------------------------------------------------------------------

  /**
   * No-op (task 2.6). `claude "prompt"` auto-runs the positional prompt, so the
   * runtime injects NO carriage return and uses NONE of codex's DSR/CPR/quiesce
   * machinery. Returns nothing — there is no observer or timer to tear down.
   */
  autoSubmit(_pty: AutoSubmitPty, _ctx: LaunchContext): void {
    // intentionally empty
  }

  // ------------------------------------------------------------------------
  // 2.7 — turn-completion exit detection
  // ------------------------------------------------------------------------

  /**
   * Determine turn completion from the transcript, not process exit (task 2.7).
   * An interactive Claude turn does NOT exit the process — it idles for the next
   * input — so `tmux has-session` would stay alive forever. Instead this tails the
   * `--session-id` JSONL and treats the turn complete when the LAST `assistant`
   * record carries `stop_reason == "end_turn"` (NOT the last line — `system`/
   * title/last-prompt records trail it; see {@link isTurnComplete}). On `done` it
   * proactively `tmux kill-session` so the SHARED session-gone exit path resolves
   * the task; the liveness poller is thereby demoted to an abnormal-death watchdog.
   *
   * A `tool_use` mid-turn event is NOT complete (detection keeps running); a
   * clarifying-question ending is still `end_turn`, so it completes the run
   * (one-shot semantics). A missing/unreadable transcript reads as still-running.
   */
  async detectExit(exec: SandboxExec, ctx: LaunchContext): Promise<ExitSignal> {
    const sessionId = ctx.sessionId;
    if (!sessionId) return { status: 'running' };
    const path = claudeTranscriptPath(
      ClaudeCodeRuntime.CONFIG_DIR,
      ctx.workspaceDir,
      sessionId,
    );
    let jsonl: string;
    try {
      const { stdout } = await exec.exec(`cat ${path} 2>/dev/null`);
      jsonl = stdout;
    } catch {
      // Transport blip — inconclusive, keep polling rather than mistaking it for
      // completion (mirrors the codex liveness poller's null handling).
      return { status: 'running' };
    }
    if (jsonl.trim().length === 0) return { status: 'running' };
    const records = parseClaudeTranscript(jsonl);
    if (!isTurnComplete(records)) return { status: 'running' };

    // Turn complete — proactively kill the tmux session so the shared session-gone
    // path resolves the task. Best-effort: a kill failure still lets the watchdog
    // catch it; we never throw out of detection.
    const session = detachedSessionName(ctx.taskId);
    try {
      await exec.exec(`tmux kill-session -t ${session} 2>/dev/null; true`);
    } catch {
      // ignore — the abnormal-death watchdog is the backstop
    }
    return { status: 'done' };
  }

  // ------------------------------------------------------------------------
  // 2.8 — transcript capture
  // ------------------------------------------------------------------------

  /**
   * Reuse the shared byte-stream asciicast capture (unchanged, the primary replay
   * source) and additionally read the `--session-id` JSONL off the sandbox as a
   * structured archival record, parsing ALL record types (task 2.8). The slug is
   * derived from the CANONICALIZED workspace path. Best-effort: a missing or
   * unreadable transcript yields no records, never an error.
   */
  async captureTranscript(
    exec: SandboxExec,
    ctx: LaunchContext,
  ): Promise<TranscriptCapture> {
    const sessionId = ctx.sessionId;
    if (!sessionId) return { records: [] };
    const path = claudeTranscriptPath(
      ClaudeCodeRuntime.CONFIG_DIR,
      ctx.workspaceDir,
      sessionId,
    );
    try {
      const { stdout } = await exec.exec(`cat ${path} 2>/dev/null`);
      if (stdout.trim().length === 0) return { records: [] };
      return { records: parseClaudeTranscript(stdout) };
    } catch {
      return { records: [] };
    }
  }
}
