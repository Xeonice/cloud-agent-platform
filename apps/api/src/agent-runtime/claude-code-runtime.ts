import {
  buildHasSessionCommand,
  wrapHeadlessDetachedSession,
  wrapInDetachedSession,
} from '../terminal/codex-launch';
import { claudeProjectSlug } from './claude-transcript';
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
import { classifyClaudeOutputFailure } from './runtime-output-failure-classifier';

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

  classifyOutputFailure(rollingOutput: string): RuntimeOutputFailure | null {
    return classifyClaudeOutputFailure(rollingOutput);
  }

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
   * `hasCompletedOnboarding` keys are present (a per-project trust entry ALONE leaves
   * the theme screen blocking). So this seeds both the global onboarding keys AND the
   * per-project trust entry for the canonical workspace.
   *
   * CRITICAL — this MUST be the HOME-root `.claude.json` (`$HOME/.claude.json`), NOT
   * `$CLAUDE_CONFIG_DIR/.claude.json`. `CLAUDE_CONFIG_DIR` relocates only the `.claude`
   * DIRECTORY (settings.json, cache, `projects/` transcripts); Claude (verified on
   * 2.1.181 in a live sandbox) reads/writes its MAIN config at `$HOME/.claude.json`
   * regardless. Seeding it inside the config dir is silently ignored — Claude creates a
   * fresh un-onboarded `$HOME/.claude.json` and runs the full theme/auth onboarding.
   */
  static readonly CLAUDE_JSON_PATH = '/home/gem/.claude.json';

  /** The canonical workspace path the per-project trust entry is keyed on. */
  static readonly WORKSPACE_DIR = '/home/gem/workspace';

  // ------------------------------------------------------------------------
  // 2.4 — launch line
  // ------------------------------------------------------------------------

  /**
   * Build the detached-tmux launch line for Claude (task 2.4):
   *
   *   tmux -u new-session -d -s task<id> -c <workspace> \
   *     'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 CLAUDE_CODE_SANDBOXED=1 \
   *      CLAUDE_CONFIG_DIR=/home/gem/.claude \
   *      . <auth-env-file>; P="$(cat <prompt-file>)"; \
   *      claude --session-id <uuid> --dangerously-skip-permissions "$P"'
   *
   *   - `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` keeps the TUI in the normal
   *     buffer so the existing asciicast capture (no alt-screen branch) replays it.
   *   - `CLAUDE_CODE_SANDBOXED=1` short-circuits the workspace trust gate.
   *   - `CLAUDE_CONFIG_DIR=/home/gem/.claude` pins the config/home so the
   *     pre-seeded onboarding/trust and the transcript live where we expect.
   *   - `. <auth-env-file>` sources the token + the ANTHROPIC_* unsets onto the
   *     launch env (task 2.5), so a stray API key cannot shadow the OAuth token.
   *   - `--dangerously-skip-permissions` starts Claude in its documented
   *     bypass-permissions mode, the Claude Code analog of Codex's YOLO flag.
   *   - The prompt rides `"$(cat <file>)"` (never inlined). Unlike codex, Claude
   *     AUTO-RUNS the positional prompt, so there is no Enter to inject.
   *
   * It NEVER uses `claude attach`, `claude agents`, `--bare`,
   * or `--no-session-persistence` (each breaks the inline-buffer, auth, or
   * transcript assumptions, or hard-refuses root).
   */
  buildLaunchLine(ctx: LaunchContext): string {
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      // The --session-id uuid is load-bearing: it names the transcript JSONL the
      // shared retention path archives/replays. A launch without it would lose the
      // session's durable transcript, so refuse rather than launch one that can't.
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
      `claude --session-id ${sessionId} --dangerously-skip-permissions "$P"`;
    // SHARED launch mechanism: claude supplies only the inner agent line; the
    // detached-tmux wrapper is identical for every runtime (refactor step 4).
    return wrapInDetachedSession(ctx.taskId, inner, ctx.workspaceDir);
  }

  sandboxSetupCommands(
    ctx: SandboxSetupContext,
    material: AuthMaterial | null,
  ): SandboxSetupPlan {
    const token = material?.oauthToken?.trim();
    if (!token) {
      // FAIL CLOSED before any command — a claude-code task must NOT launch
      // unauthenticated (the deliberate divergence from codex, which degrades).
      return { ok: false, reason: 'runtime not configured' };
    }
    const dir = ClaudeCodeRuntime.CONFIG_DIR;
    const commands: SandboxSetupCommand[] = [];

    // launch-env.sh (OAuth token + ANTHROPIC_* unsets) + user settings +
    // `.claude.json` pre-seed as ONE command, byte-identical to the prior
    // `injectAuth` shape. tolerateUnresolvedExit is TRUE to preserve `injectAuth`'s
    // `code !== null && code !== 0` (an unresolved exit code was treated as success).
    const tokenB64 = Buffer.from(token, 'utf8').toString('base64');
    const snippet =
      `export CLAUDE_CODE_OAUTH_TOKEN="$(printf %s '${tokenB64}' | base64 -d)"\n` +
      'unset ANTHROPIC_API_KEY\n' +
      'unset ANTHROPIC_AUTH_TOKEN\n' +
      'unset apiKeyHelper\n';
    const snippetB64 = Buffer.from(snippet, 'utf8').toString('base64');
    const file = ClaudeCodeRuntime.AUTH_ENV_FILE_PATH;
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
    const settings = JSON.stringify({
      permissions: { skipDangerousModePermissionPrompt: true },
    });
    const settingsB64 = Buffer.from(settings, 'utf8').toString('base64');
    const claudeJson = ClaudeCodeRuntime.CLAUDE_JSON_PATH;
    const settingsJson = `${dir}/settings.json`;
    commands.push({
      command:
        `mkdir -p ${dir} && ` +
        `printf %s '${snippetB64}' | base64 -d > ${file} && chmod 600 ${file} && ` +
        `printf %s '${settingsB64}' | base64 -d > ${settingsJson} && chmod 600 ${settingsJson} && ` +
        `printf %s '${preseedB64}' | base64 -d > ${claudeJson} && chmod 600 ${claudeJson}`,
      tolerateUnresolvedExit: true,
    });

    // prompt-file write — OMITTED when there is no prompt; STRICT (an unresolved exit
    // fails closed), byte-identical to the prior adapter `injectClaudePrompt`.
    if (ctx.prompt) {
      const b64 = Buffer.from(ctx.prompt, 'utf8').toString('base64');
      const promptFile = ClaudeCodeRuntime.PROMPT_FILE_PATH;
      commands.push({
        command: `mkdir -p ${dir} && printf %s '${b64}' | base64 -d > ${promptFile} && chmod 600 ${promptFile}`,
        tolerateUnresolvedExit: false,
      });
    }
    return { ok: true, commands };
  }

  preflightProbes(): readonly SandboxRuntimePreflightProbe[] {
    return [
      { name: 'claude cli', command: 'command -v claude' },
      { name: 'git', command: 'command -v git' },
      { name: 'tmux', command: 'command -v tmux' },
      { name: 'bash', command: 'command -v bash' },
      { name: 'tar', command: 'command -v tar' },
      { name: 'gzip', command: 'command -v gzip' },
    ];
  }

  preStopTrimCommands(): readonly string[] {
    const dir = ClaudeCodeRuntime.CONFIG_DIR;
    // Drop `~/.claude` bulk but KEEP `projects/` (the session transcript) — the
    // defense-in-depth analog of codex's `~/.codex` trim. Byte-identical to the
    // prior adapter `trimBeforeStop`.
    return [
      `find ${dir} -mindepth 1 -maxdepth 1 ! -name projects -exec rm -rf {} + 2>/dev/null; true`,
    ];
  }

  // ------------------------------------------------------------------------
  // terminal startup — declarative, no DSR reply, no submit key
  // ------------------------------------------------------------------------

  /**
   * Claude declares NO terminal-startup handshake: `claude "prompt"` auto-runs the
   * positional prompt, so the shared pty mechanism injects no synthetic CPR and no
   * carriage return (refactor-agent-runtime-policy-mechanism: replaces the no-op
   * `autoSubmit` — the policy is data, the mechanism is shared).
   */
  readonly terminalStartup: TerminalStartup = {
    replyToStartupDSR: false,
    promptSubmit: 'none',
  };

  // ------------------------------------------------------------------------
  // exit detection — RESIDENT continuous-conversation session (codex parity)
  // ------------------------------------------------------------------------

  /**
   * Resolve completion from session liveness, IDENTICAL to {@link CodexRuntime.detectExit}:
   * `tmux has-session` over the exec handle — a session that EXISTS (exit 0) is still
   * `running`; a GONE session (non-zero) is `done`. The `__cap_has__$?` sentinel mirrors
   * `probeSessionLiveness`; an inconclusive probe (no sentinel) reads as still-running so
   * a transport blip is never mistaken for completion.
   *
   * Claude is a RESIDENT continuous-conversation session (align-claude-runtime-resident-session):
   * a finished turn does NOT exit the process and is NOT treated as completion — Claude idles
   * for the next input the operator types into the live terminal, driving multi-turn
   * conversation in the same `--session-id` session. The task is `done` ONLY when the session
   * is gone (operator stop, or a configured idle/deadline reclamation), exactly like codex;
   * the shared liveness poller's abnormal-death watchdog still catches a session that dies
   * unexpectedly. This replaces the prior `end_turn`-transcript one-shot detection (which also
   * misclassified a cleanly-completed turn as `abnormal_exit` after its proactive kill-session).
   */
  async detectExit(exec: SandboxExec, ctx: LaunchContext): Promise<ExitSignal> {
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

  /** Claude supports both the interactive TUI and the non-interactive `-p` print mode. */
  readonly executionModes: ReadonlySet<ExecutionMode> = new Set([
    'interactive-pty',
    'headless-exec',
  ]);

  /** Claude transcript = the per-session JSONL under `~/.claude/projects/<slug>`. */
  readonly transcriptFormat: TranscriptFormat = 'claude-jsonl';
  transcriptArtifact(ctx: LaunchContext): TranscriptArtifact {
    // The projects subdir is keyed on the canonicalized workspace slug; the file is named
    // by the launch `--session-id`. Fall back to the newest `*.jsonl` when the session id
    // is absent (defensive — the launch path requires it).
    const dir = `${ClaudeCodeRuntime.CONFIG_DIR}/projects/${claudeProjectSlug(ctx.workspaceDir)}`;
    const sid = ctx.sessionId;
    const filenameGlob = sid
      ? new RegExp(`(^|/)${sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.jsonl$`)
      : /(^|\/).*\.jsonl$/;
    return { dir, filenameGlob };
  }

  /**
   * Claude persists one newest per-session JSONL file (unify-transcript-parsers D3), so the
   * read mechanism reads the lexicographically-newest `transcriptArtifact` match and hands
   * the claude-jsonl parser a `{ format, jsonl }` source — the prior verbatim read. A future
   * multi-record runtime declares a different strategy without touching this.
   */
  readonly readTranscriptSource: TranscriptReadStrategy = {
    kind: 'single-newest-jsonl',
  };

  /**
   * Headless one-shot: `claude -p` runs the prompt non-interactively and EXITS on turn
   * completion. Same env prefix + auth sourcing as the interactive launch; `--session-id`
   * names the transcript JSONL the shared retention path reads; `< /dev/null` skips claude's
   * 3s stdin wait. Wrapped in the SAME detached named session so the liveness poller resolves
   * it on natural exit.
   */
  buildHeadlessLine(ctx: LaunchContext): string {
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      throw new Error(
        'ClaudeCodeRuntime.buildHeadlessLine requires ctx.sessionId (the --session-id uuid)',
      );
    }
    const inner = this.headlessInner(
      `claude -p "$P" --session-id ${sessionId} --output-format stream-json --verbose --dangerously-skip-permissions < /dev/null`,
    );
    return wrapHeadlessDetachedSession(ctx.taskId, inner, ctx.workspaceDir);
  }

  /** Headless resume: `claude -p --resume <id>` continues a prior session non-interactively. */
  buildResumeLine(ctx: LaunchContext, prevSessionId: string): string {
    const inner = this.headlessInner(
      `claude -p "$P" --resume ${prevSessionId} --output-format stream-json --verbose --dangerously-skip-permissions < /dev/null`,
    );
    return wrapHeadlessDetachedSession(ctx.taskId, inner, ctx.workspaceDir);
  }

  /** Shared env-prefix + auth-source + prompt-read preamble for the headless `claude` invocations. */
  private headlessInner(claudeCmd: string): string {
    const envPrefix =
      'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 ' +
      'CLAUDE_CODE_SANDBOXED=1 ' +
      `CLAUDE_CONFIG_DIR=${ClaudeCodeRuntime.CONFIG_DIR}`;
    return (
      `${envPrefix} ` +
      `. ${ClaudeCodeRuntime.AUTH_ENV_FILE_PATH} 2>/dev/null; ` +
      `P="$(cat ${ClaudeCodeRuntime.PROMPT_FILE_PATH} 2>/dev/null)"; ` +
      claudeCmd
    );
  }
}
