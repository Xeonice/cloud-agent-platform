/**
 * AIO Sandbox terminal bridge (`AioPtyClient`).
 *
 * Under the connect-in model (design D) the orchestrator is the WebSocket
 * *client*: for each task it dials the per-task AIO Sandbox container's terminal
 * WebSocket (`ws://cap-aio-<taskId>:8080/v1/shell/ws`) on the private `cap-net`
 * network. This class is the SOLE new code at the {@link TerminalPty} seam — it
 * is the connect-in PTY backend that supersedes the removed dial-back proxy.
 * Everything ABOVE the seam (web
 * ws-client, operator connect-auth, `WriteLockService`, approval routing,
 * `BackpressureController` + ACK, `SnapshotManager` + `session.log`, guardrails)
 * is reused verbatim.
 *
 * `AioPtyClient` owns the outbound WS into the sandbox and TRANSLATES the AIO
 * JSON frame protocol ↔ the existing base64-raw + control-frame protocol the
 * front-end xterm speaks. The translation is the complete contract between AIO's
 * protocol and ours:
 *
 *   | Direction              | AIO JSON frame                    | Cap side                          |
 *   | ---------------------- | --------------------------------- | --------------------------------- |
 *   | sandbox → orchestrator | `{type:"output",data}`            | `onData`/`emitData` (base64 raw)  |
 *   | orchestrator → sandbox | `{type:"input",data}`             | operator keystroke (`write`)      |
 *   | orchestrator → sandbox | `{type:"resize",data:{cols,rows}}`| resize event                      |
 *   | sandbox → orchestrator | `{type:"session_id"}` then `ready`| session-established signal        |
 *   | sandbox → orchestrator | `{type:"ping"}`                   | auto `{type:"pong",timestamp}`    |
 *   | sandbox → orchestrator | DSR `\x1b[6n` in an `output`      | inject CPR `\x1b[1;1R` input      |
 *
 * The bridge connects WITHOUT any `?session_id=` query parameter; codex runs in a
 * DETACHED named tmux session (`task<taskId>`) it launches or re-attaches to, so a
 * WS close no longer means the task ended (survive-api-redeploy D1/D4). Task
 * termination is detected by POLLING the named session's liveness
 * (`tmux has-session`); only a GONE session resolves the exit status (via the
 * sandbox `exec`/`wait` HTTP surfaces) and maps it to guardrails.
 */
import type {
  AgentTerminalDataListener,
  AgentTerminalOutputMeta,
  AgentTerminalPty,
  SandboxCommandExecutor,
  TerminalExitStatus,
  TerminalTransport,
  TerminalTransportFactory,
  TerminalTransportFrame,
} from '@cap/sandbox-core';
import { createAioHttpCommandExecutor } from './aio-provider.js';
import { AioTerminalTransport } from './aio-terminal-transport.js';
import type {
  AioExecutionMode,
  AioExitSignal,
  AioLegacySandboxExec,
  AioTerminalRuntime,
  AioTerminalStartup,
} from './aio-terminal-runtime.js';
import {
  aioSessionIdForTask,
  toAioTerminalRuntimeExec,
} from './aio-terminal-runtime.js';
import {
  buildAttachSessionCommand,
  buildDetachedCodexLaunchLine,
  buildHasSessionCommand,
  buildResizeDetachedSessionCommand,
  detachedSessionName,
  headlessExitFile,
} from './codex-launch.js';
// add-claude-code-runtime Track 3 (3.2): the bridge resolves the task's selected
// AgentRuntime (Track 2) and calls its `buildLaunchLine` / `autoSubmit` / `detectExit`
// instead of the inline codex logic. CODEX is preserved byte-identical: when the
// resolved runtime is `codex` (or unresolved), the existing detached-tmux launch +
// DSR-gated CR autosubmit + `tmux has-session` exit detection run exactly as before.
// CLAUDE takes the runtime path: the runtime's tmux launch line, NO autosubmit
// (`claude "prompt"` auto-runs), and — since align-claude-runtime-resident-session —
// the SAME `tmux has-session` `detectExit` codex uses. Claude is a RESIDENT
// continuous-conversation session: a finished turn idles for the operator's next input
// (typed into the live terminal) and does NOT terminate the task; the session-gone
// path resolves it only on operator stop or a configured idle/deadline reclamation.
import { selectLaunch } from './select-launch.js';

export interface AioPtyClientLogger {
  debug(message: string): void;
  warn(message: string): void;
}

const noopLogger: AioPtyClientLogger = {
  debug: () => undefined,
  warn: () => undefined,
};

/**
 * The DSR (Device Status Report) cursor-position query crossterm emits on
 * startup: `ESC [ 6 n` — standard DSR-6, with NO `?`. codex BLOCKS waiting for a
 * CPR reply and aborts with `Error: The cursor position could not be read within
 * a normal duration` if none arrives, because AIO's tmux-backed terminal does not
 * reply CPR in time. Verified byte-for-byte against the live sandbox: codex
 * (crossterm) emits `1b 5b 36 6e` = `\x1b[6n`. The private-mode `\x1b[?6n` form is
 * NOT what it sends, so the detector must match the no-`?` form exactly (matching
 * `\x1b[?6n` here silently disables CPR injection and codex never starts).
 */
const DSR_CURSOR_POSITION_QUERY = '\x1b[6n';

/**
 * The synthetic CPR (Cursor Position Report) reply we inject on seeing the DSR
 * query: `ESC [ 1 ; 1 R` = cursor at row 1, col 1. This unblocks crossterm so
 * codex renders its TUI. Injected entirely in this bridge layer, with NO AIO or
 * tmux changes (design D ★).
 */
const SYNTHETIC_CPR_REPLY = '\x1b[1;1R';

/**
 * The codex launch argv injected in-shell over `/v1/shell/ws` (harden-aio-execution
 * integration task 6.1):
 *   - `-C /home/gem/workspace` runs codex in the cloned task repo (the
 *     /v1/shell/ws shell's cwd is HOME=/home/gem, not the clone dir).
 *   - `--dangerously-bypass-approvals-and-sandbox` is Codex's documented
 *     YOLO-style launch mode, intentionally skipping approvals and the inner
 *     Codex sandbox because the platform already runs each task in an isolated
 *     AIO container.
 *   - `--no-alt-screen` runs codex's TUI in INLINE mode (no alternate screen), so
 *     its output stays in the NORMAL buffer and the live xterm keeps a scrollable
 *     history. codex defaults to the alternate screen, which by spec has NO
 *     scrollback — operators could not scroll up in the live terminal. codex 0.131
 *     supports this flag ("inline mode, preserving terminal scrollback history").
 * The derived image bakes the SAME string as `CODEX_LAUNCH_ARGV`
 * (docker/aio-sandbox.Dockerfile) as the single source of truth; this default
 * mirrors it so the bridge stays correct when the env is not threaded through.
 *
 * This is the BASE argv only. `launchCodex` wraps it with
 * `buildDetachedCodexLaunchLine` (which itself wraps `buildCodexLaunchLine`),
 * starting codex in a DETACHED named tmux session whose inner line appends the
 * task's prompt as codex's positional `[PROMPT]` via `"$(cat <prompt-file>)"`
 * (pre-filling the composer) without inlining the prompt text. Because the
 * positional prompt only PRE-FILLS (it does not auto-run), `onOutput` injects a
 * single Enter once the startup DSR is seen and output quiesces — the zero-touch
 * auto-submit (aio-codex-prompt-autostart), preserved WITHIN the detached session.
 */
const DEFAULT_CODEX_LAUNCH_ARGV =
  'codex --no-alt-screen -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox';

/**
 * The Enter key (carriage return) codex's TUI composer submits on. Injected ONCE
 * as the zero-touch prompt auto-submit (aio-codex-prompt-autostart): codex's
 * positional `[PROMPT]` only PRE-FILLS the composer, so a single `\r` after the
 * TUI is up and idle submits the pre-filled goal with no operator keystroke.
 */
const CODEX_SUBMIT_KEY = '\r';
const TMUX_RESIZE_TIMEOUT_MS = 2_000;

/**
 * Output-quiescence window (ms) the prompt auto-submit waits for AFTER codex's
 * startup DSR is observed before injecting {@link CODEX_SUBMIT_KEY}: a stretch of
 * no output means the initial render is done and the pre-filled composer is idle
 * and ready for Enter. Env-tunable (`CODEX_AUTOSUBMIT_QUIESCE_MS`) so the live
 * value can be tuned without a rebuild and tests can drive it fast.
 */
const CODEX_PROMPT_AUTOSUBMIT_QUIESCE_MS = Number(
  process.env['CODEX_AUTOSUBMIT_QUIESCE_MS'] ?? 800,
);

/**
 * Liveness poll cadence (ms) for the detached named tmux session
 * (survive-api-redeploy D4). With codex running in a detached session a WS close
 * no longer means the task ended, so termination is detected by POLLING
 * `tmux has-session -t task<taskId>` over `/v1/shell/exec`: while the session is
 * alive the task is running; the FIRST poll that reports the session gone resolves
 * the exit status and drives the terminal path. Modeled on the deadline/idle
 * watchers' interval cadence. Env-tunable (`CODEX_LIVENESS_POLL_MS`) so the live
 * value can be tuned without a rebuild and tests can drive it fast.
 */
const CODEX_LIVENESS_POLL_MS = Number(
  process.env['CODEX_LIVENESS_POLL_MS'] ?? 5000,
);

/**
 * Re-adoption attaches a fresh shell to an already-running tmux session. The
 * shell echo, duplicate-session fallback output, and initial TUI repaint are
 * useful to a live viewer but must not become durable history.
 */
const ATTACH_BOOTSTRAP_QUIESCE_MS = Number(
  process.env['CODEX_ATTACH_BOOTSTRAP_QUIESCE_MS'] ?? 300,
);
const ATTACH_BOOTSTRAP_MAX_MS = Number(
  process.env['CODEX_ATTACH_BOOTSTRAP_MAX_MS'] ?? 2_000,
);

/**
 * The cloned-workspace directory inside the sandbox the detached session runs in
 * (`-c <dir>`), matching the codex `buildDetachedCodexLaunchLine` default. Passed
 * to a non-codex runtime's `buildLaunchLine` as the session cwd so claude runs in
 * the same cloned task repo codex does (3.2). One constant shared by both paths.
 */
const CLAUDE_WORKSPACE_DIR = '/home/gem/workspace';

/** The resolved exit outcome of a terminated sandbox session. */
export type AioExitStatus = TerminalExitStatus;
export type AioPtyClientMode =
  | 'launch-or-attach'
  | 'provider-story-fixture'
  | 'replay-only';

const PROVIDER_STORY_SCRIPT_PATH = '/tmp/cap-provider-terminal-story.sh';

function buildProviderStoryFixtureScript(): string {
  return [
    '#!/bin/sh',
    'export TERM=xterm-256color',
    'export LC_ALL="${LC_ALL:-C.UTF-8}"',
    '',
    'emit() {',
    '  printf \'%s\\r\\n\' "$1"',
    '}',
    '',
    'resize_marker() {',
    "  set -- $(stty size 2>/dev/null || printf '0 0')",
    '  rows="${1:-0}"',
    '  cols="${2:-0}"',
    '  emit "PROVIDER_STORY_RESIZE:${cols}x${rows}"',
    '}',
    '',
    'trap resize_marker WINCH',
    '',
    'emit "PROVIDER_STORY_BEGIN"',
    'emit "PROVIDER_STORY_UTF8: 中文渲染正常 汉字边界"',
    'emit "PROVIDER_STORY_SPLIT_SAFE_MARKER: utf8-boundary"',
    'emit "PROVIDER_STORY_REPLAY_BULK_BEGIN"',
    'i=1',
    'while [ "$i" -le 220 ]; do',
    "  n=$(printf '%03d' \"$i\")",
    '  emit "PROVIDER_STORY_SCROLL_${n} 中文 scrollback"',
    '  i=$((i + 1))',
    'done',
    'emit "PROVIDER_STORY_REPLAY_BULK_END"',
    'resize_marker',
    'emit "PROVIDER_STORY_READY_FOR_INPUT"',
    '',
    '(',
    '  i=1',
    '  while [ "$i" -le 60 ]; do',
    '    sleep 0.25',
    "    n=$(printf '%03d' \"$i\")",
    '    emit "PROVIDER_STORY_LIVE_${n} still streaming"',
    '    i=$((i + 1))',
    '  done',
    ') &',
    'tick_pid=$!',
    '',
    'while :; do',
    '  if ! IFS= read -r line; then',
    '    sleep 0.05',
    '    continue',
    '  fi',
    '  emit "PROVIDER_STORY_ECHO:${line}"',
    '  resize_marker',
    '  [ "$line" = "exit" ] && break',
    'done',
    '',
    'kill "$tick_pid" 2>/dev/null || true',
    'emit "PROVIDER_STORY_DONE"',
    '',
  ].join('\n');
}

function buildProviderStoryFixtureInstallCommand(): string {
  return [
    `cat > ${PROVIDER_STORY_SCRIPT_PATH} <<'CAP_PROVIDER_TERMINAL_STORY_SCRIPT'`,
    buildProviderStoryFixtureScript(),
    'CAP_PROVIDER_TERMINAL_STORY_SCRIPT',
    `chmod +x ${PROVIDER_STORY_SCRIPT_PATH}`,
  ].join('\n');
}

/**
 * `AioPtyClient` opens an OUTBOUND `ws` client into the sandbox terminal and
 * presents it to the gateway as a {@link TerminalPty}, exposing the same
 * `onData`/`write`/`resize`/`pause`/`resume` surface the gateway consumes.
 */
export class AioPtyClient implements AgentTerminalPty {
  private readonly logger: AioPtyClientLogger = noopLogger;

  /** Subscribers to translated raw PTY output (decoded sandbox `output` data). */
  private readonly dataListeners = new Set<AgentTerminalDataListener>();

  /** The provider terminal transport into the sandbox. */
  private transport: TerminalTransport;

  /** Opens a fresh provider terminal transport when a closed bridge must re-attach. */
  private readonly transportFactory: TerminalTransportFactory;
  private readonly commandExecutor: SandboxCommandExecutor;

  /** Operator input collected while the sandbox terminal WS is being re-opened. */
  private readonly pendingInput: string[] = [];

  /** True while a replacement sandbox terminal WS is in flight. */
  private reconnectingForInput = false;

  /** True once the sandbox sent `session_id` then `ready` (terminal is live). */
  private established = false;

  /** True once we have observed a `session_id` frame (precedes `ready`). */
  private sawSessionId = false;

  /** Resolves once exit detection has resolved the status, to dedupe. */
  private exitResolved = false;

  /**
   * True once codex's startup DSR (`\x1b[6n`) has been observed in the output —
   * the signal that codex's TUI (not the shell) now owns the terminal. Gates the
   * zero-touch prompt auto-submit so a `\r` can never land in the bash shell.
   */
  private dsrSeen = false;

  /** True once the zero-touch prompt auto-submit Enter has been injected (once). */
  private promptSubmitted = false;

  /**
   * True once THIS bridge launched a FRESH codex via {@link launchCodex} (D1).
   * Gates the zero-touch prompt auto-submit: only a fresh launch has a pre-filled
   * composer awaiting its single Enter. An ATTACH re-adopts an already-running
   * codex (operator reconnect / boot re-adoption) whose composer is NOT freshly
   * pre-filled, so the bridge must NEVER inject a stray Enter into it.
   */
  private launchedCodex = false;

  /**
   * The resolved runtime's declared terminal-startup policy (the SHARED DSR/CPR
   * mechanism below reads this — no agent-identity branch). Defaults to codex's
   * policy for the unresolved-runtime fallback (`launchCodex`) and before launch.
   */
  private terminalStartup: AioTerminalStartup = {
    replyToStartupDSR: true,
    promptSubmit: 'cr-on-quiesce',
  };

  /** Debounce timer backing the output-quiescence prompt auto-submit. */
  private autoSubmitTimer?: ReturnType<typeof setTimeout>;

  /** True while re-adoption attach/bootstrap bytes are being observed. */
  private attachBootstrapActive = false;

  /** Ends the attach-bootstrap window after output goes quiet. */
  private attachBootstrapQuietTimer?: ReturnType<typeof setTimeout>;

  /** Hard stop so continuous output becomes recordable again. */
  private attachBootstrapMaxTimer?: ReturnType<typeof setTimeout>;

  /**
   * The detached named tmux session this client drives, `task<taskId>`
   * (survive-api-redeploy D1). Codex runs inside it; this name is what the
   * liveness poller probes (`tmux has-session`) and what {@link attachToNamedSession}
   * attaches to.
   */
  private readonly sessionName: string;

  /** Prevent duplicate fixture installs if a provider sends repeated ready frames. */
  private providerStoryFixtureStarted = false;

  /**
   * Liveness poller handle (survive-api-redeploy D4). Polls
   * `tmux has-session -t <sessionName>` on {@link CODEX_LIVENESS_POLL_MS}; the
   * first poll that reports the session GONE resolves the exit status and drives
   * the terminal path. Started once the terminal is established (a session exists
   * to watch), stopped once the exit is resolved.
   */
  private livenessTimer?: ReturnType<typeof setInterval>;

  /**
   * True while a liveness probe is in flight, so overlapping intervals do not
   * stack concurrent `/v1/shell/exec` calls if a probe runs slower than the poll
   * cadence.
   */
  private livenessProbeInFlight = false;

  /**
   * @param taskId   The task this terminal belongs to.
   * @param wsUrl    The sandbox terminal WS, `ws://cap-aio-<taskId>:8080/v1/shell/ws`.
   * @param baseUrl  The sandbox HTTP API root, `http://cap-aio-<taskId>:8080`,
   *                 used by liveness probes + exit-status resolution (`exec`/`wait`).
   * @param onExit   Invoked once with the resolved {@link AioExitStatus} when the
   *                 detached session is observed GONE (D4). The guardrails mapping
   *                 (zero → `recordSuccess`, non-zero/abnormal → `recordFailure`)
   *                 is wired by the caller (guardrails-wiring 4.3).
   * @param mode     What this terminal DOES once the AIO shell is `ready`
   *                 (survive-api-redeploy D2):
   *                 - `'launch-or-attach'` (default for an execution terminal):
   *                   probe whether the detached session `task<taskId>` is already
   *                   alive; if alive, ATTACH (re-adopt the running codex); if gone
   *                   or inconclusive, launch a FRESH detached session. This single
   *                   mode implements the gateway's create-vs-attach decision (2.5)
   *                   AND the boot re-adoption re-attach (Track 3) over the same
   *                   liveness probe, with no synchronous pre-probe needed.
   *                 - `'replay-only'`: do nothing on `ready` (no launch, no attach,
   *                   no liveness poller) — a terminal opened purely for
   *                   snapshot/tail replay of a finished task.
   */
  /**
   * The task's selected {@link AgentRuntime} (3.2), resolved ONCE on `ready` via
   * {@link resolveRuntime} before launching. `undefined` until resolved (or when no
   * resolver/registry is wired), in which case the bridge uses the DEFAULT codex
   * inline path — so a focused transport unit test (no runtime resolver) still
   * launches codex exactly as before.
   */
  private runtime?: AioTerminalRuntime;

  /**
   * The task's execution mode (add-headless-execution-track), resolved alongside
   * {@link runtime}. Defaults to `interactive-pty` so a task without a resolved mode
   * (legacy rows, no resolver wired, transport-only unit context) launches the
   * interactive TUI exactly as before. `headless-exec` switches the launch to the
   * runtime's non-interactive `buildHeadlessLine`.
   */
  private executionMode: AioExecutionMode = 'interactive-pty';

  constructor(
    private readonly taskId: string,
    wsUrl: string,
    private readonly baseUrl: string,
    private readonly onExit?: (status: AioExitStatus) => void,
    private readonly mode: AioPtyClientMode = 'replay-only',
    /**
     * Resolve the task's selected {@link AgentRuntime} (3.2). Called at MOST once,
     * on `ready`, before the launch-or-attach decision. Optional + best-effort: a
     * missing resolver, a rejected promise, or an `undefined` result all fall back
     * to the DEFAULT codex inline path, so a runtime-resolution hiccup can never
     * strand a codex task. Resolution is async (it may read the task's `runtime`
     * column), so it is threaded as a callback rather than a constructed value.
     */
    private readonly resolveRuntime?: () => Promise<AioTerminalRuntime | undefined>,
    /**
     * Resolve the task's execution mode (add-headless-execution-track), resolved at the
     * SAME point as {@link resolveRuntime}. Optional + best-effort: a missing resolver or
     * a rejected/`null` result leaves {@link executionMode} at `interactive-pty`, so a
     * console task (or any unresolved mode) launches the interactive TUI as before.
     */
    private readonly resolveExecutionMode?: () => Promise<
      AioExecutionMode | null | undefined
    >,
    transportFactory?: TerminalTransportFactory,
    commandExecutor?: SandboxCommandExecutor,
  ) {
    this.transportFactory = transportFactory ?? {
      open: () => new AioTerminalTransport(this.taskId, wsUrl),
    };
    this.commandExecutor =
      commandExecutor ?? createAioHttpCommandExecutor({ baseUrl });
    this.sessionName = detachedSessionName(taskId);
    // Connect WITHOUT any `?session_id=` query parameter so the sandbox creates a
    // fresh tmux-backed AIO shell. Rejoining an existing AIO session by passing
    // `?session_id=` returns an immediate error frame and closes; instead codex
    // lives in a DETACHED tmux session we launch-or-attach to over a fresh WS
    // (survive-api-redeploy D1/D2), and `SnapshotManager` (above the seam) owns
    // operator reconnect/restore.
    this.transport = this.openTransport();
  }

  // -------------------------------------------------------------------------
  // TerminalPty surface — consumed by the gateway above the seam.
  // -------------------------------------------------------------------------

  /** Subscribe to translated raw PTY output; returns an unsubscribe handle. */
  onData(listener: AgentTerminalDataListener): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  /**
   * Forward operator keystrokes to the sandbox as an AIO `{type:"input",data}`
   * frame. Only called when the operator holds the write lease (7.5); the lease
   * gate lives above the seam in the gateway, unchanged.
   */
  write(data: string): void {
    this.sendInput(data);
  }

  /** Open a provider terminal transport and fence late events from superseded transports. */
  private openTransport(): TerminalTransport {
    const transport = this.transportFactory.open();
    transport.onFrame((frame) => {
      if (transport !== this.transport) return;
      this.onTransportFrame(frame);
    });
    transport.onClose(() => {
      if (transport !== this.transport) return;
      this.onTransportClose();
    });
    transport.onError(() => {
      // The transport logs provider-level errors. Keeping the subscription here
      // ensures future transports have the same fenced lifecycle hook surface.
    });
    return transport;
  }

  /**
   * Re-open the sandbox terminal WS on demand when an operator types after the
   * previous bridge detached. The detached tmux session remains authoritative;
   * the new WS only re-attaches to it and then drains pending keystrokes.
   */
  private reconnectForInput(): void {
    if (this.reconnectingForInput) return;
    if (this.transport.readyState === 'connecting') return;
    this.reconnectingForInput = true;
    this.established = false;
    this.sawSessionId = false;
    this.transport.close();
    this.transport = this.openTransport();
  }

  /**
   * Resolve the task's selected {@link AgentRuntime} EXACTLY ONCE (3.2), caching it
   * on {@link runtime}. Best-effort + never throws: a missing resolver, a rejected
   * promise, or an `undefined` result leaves {@link runtime} undefined so every
   * launch/exit branch falls back to the DEFAULT codex inline path. Idempotent — a
   * second call is a no-op once resolved.
   */
  private async ensureRuntimeResolved(): Promise<void> {
    if (this.runtime || !this.resolveRuntime) return;
    try {
      this.runtime = (await this.resolveRuntime()) ?? undefined;
    } catch (err) {
      this.logger.warn(
        `task ${this.taskId}: could not resolve AgentRuntime (defaulting to codex): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.runtime = undefined;
    }
    // Resolve the execution mode at the same point (add-headless-execution-track).
    // Best-effort: any failure leaves `interactive-pty`, so a hiccup never strands a
    // task in the wrong launch mode.
    if (this.resolveExecutionMode) {
      try {
        this.executionMode =
          (await this.resolveExecutionMode()) ?? 'interactive-pty';
      } catch (err) {
        this.logger.warn(
          `task ${this.taskId}: could not resolve execution mode (defaulting to interactive-pty): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.executionMode = 'interactive-pty';
      }
    }
  }

  /**
   * Launch the task's selected agent in a fresh detached tmux session. For an
   * UNRESOLVED runtime this is {@link launchCodex} (the byte-identical inline codex
   * path). For a RESOLVED runtime it builds the launch line from the port's
   * `runtime.buildLaunchLine`, sends it, attaches, and arms the prompt auto-submit
   * ONLY when the runtime's declared `terminalStartup.promptSubmit` is
   * `'cr-on-quiesce'` (codex) — claude declares `'none'` so no Enter is ever
   * injected (`claude "prompt"` auto-runs the positional prompt).
   *
   * @param armAutoSubmit Whether a DEFINITIVE fresh launch (true) vs an inconclusive
   *   fallback (false). For a resolved runtime it is intersected with the declared
   *   `terminalStartup` policy so a no-submit runtime never arms the timer.
   */
  private launchAgent(armAutoSubmit = true): void {
    const runtime = this.runtime;
    if (!runtime) {
      // UNRESOLVED runtime only (resolver missing/failed) → the inline codex launch
      // is the safe legacy default since there is no port to call. A RESOLVED codex
      // now flows through the port path below (VR-5: shared scaffolding no longer
      // branches on agent identity; codex is driven through CodexRuntime, whose
      // buildLaunchLine is byte-identical to this inline path).
      this.launchCodex(undefined, armAutoSubmit);
      return;
    }
    // RESOLVED runtime (codex OR claude-code): build the detached-tmux launch line
    // from the runtime itself (it owns the agent argv + env + `$(cat <prompt-file>)`
    // shape — for codex `CodexRuntime.buildLaunchLine` wraps the SAME
    // `CODEX_LAUNCH_ARGV` via the SAME `buildDetachedCodexLaunchLine`) and run it
    // over the same WS-shell input + attach.
    const launchCtx = {
      taskId: this.taskId,
      workspaceDir: CLAUDE_WORKSPACE_DIR,
      // The stable per-task `--session-id` uuid claude threads into its transcript
      // (codex ignores it). Computed here now that the consumer talks to the port
      // runtime directly (refactor step 5: the RuntimeAdapter that did this is gone).
      sessionId: aioSessionIdForTask(this.taskId),
    };
    // add-headless-execution-track — the interactive-vs-headless launch decision is a
    // PURE function (select-launch.ts) so it is unit-testable without a WS/container.
    // headless-exec yields the runtime's non-interactive one-shot with no DSR/CR
    // handshake + no autosubmit; interactive-pty keeps the declared policy unchanged.
    const plan = selectLaunch(
      runtime,
      this.executionMode,
      launchCtx,
      armAutoSubmit,
    );
    this.terminalStartup = plan.terminalStartup;
    this.launchedCodex = plan.armAutoSubmit;
    this.sendInput(`${plan.line}\n`);
    this.attachSession();
  }

  /**
   * Launch codex in a DETACHED, NAMED tmux session then ATTACH to it
   * (survive-api-redeploy D1). Sends, as terminal input over `/v1/shell/ws`:
   *
   *   tmux -u new-session -d -s task<taskId> -c /home/gem/workspace '<codex line>'
   *   tmux -u set-option -t task<taskId> status off \; attach -t task<taskId>
   *
   * The detached session makes codex a child of the container tmux daemon, so it
   * KEEPS RUNNING when this WS closes (api restart / operator disconnect); the
   * immediate attach makes THIS WS shell a client of that session so codex's TUI
   * output streams over the WS and the DSR-gated single-carriage-return auto-submit
   * still works WITHIN the attached session (the CPR reply and the auto-submit
   * Enter land in the attached pane, exactly as before). `argv` defaults to
   * {@link DEFAULT_CODEX_LAUNCH_ARGV}, the SAME launch contract baked into the
   * derived image as `CODEX_LAUNCH_ARGV`.
   */
  launchCodex(
    argv: string = process.env['CODEX_LAUNCH_ARGV'] ?? DEFAULT_CODEX_LAUNCH_ARGV,
    /**
     * Whether this launch should arm the zero-touch prompt auto-submit. True for a
     * launch that DEFINITIVELY creates a fresh session (the composer is newly
     * pre-filled and awaits its single Enter). The launch-or-attach `null`
     * (inconclusive liveness) fallback passes false: if the probe was wrong and a
     * codex was actually already running, `tmux new-session` is a no-op (duplicate
     * name) and the attach rejoins the LIVE codex — so an auto-submit Enter would
     * be a stray keystroke into a running session. Suppressing it there is safe;
     * the operator can still submit manually if it really was a fresh-but-flaky
     * start.
     */
    armAutoSubmit = true,
  ): void {
    // Create the detached session carrying codex with the task prompt PRE-FILLED
    // (when one was injected at provision time) without inlining the prompt text,
    // then attach so its output streams here and the output-quiescence trigger in
    // `onOutput` can auto-submit the pre-filled goal (codex's positional prompt
    // does not auto-run on its own).
    this.launchedCodex = armAutoSubmit;
    if (!armAutoSubmit) {
      this.beginAttachBootstrapWindow();
    }
    this.sendInput(`${buildDetachedCodexLaunchLine(this.taskId, argv)}\n`);
    this.attachSession();
  }

  /**
   * Attach this WS shell to the (already-running) detached named session
   * `task<taskId>` (survive-api-redeploy D2/2.3). Sends a tmux command that first
   * disables tmux's own status line and then attaches, so the live agent output
   * streams over this WS without leaking `[task<id>:bash*]` chrome or consuming a
   * terminal row. Operator input is injected into the shared pane — the
   * operator-reconnect / boot-re-adoption path. Does NOT launch a new agent. The
   * caller is responsible for having verified liveness (gateway create-vs-attach,
   * 2.5); a stale attach to a dead session simply drops back to the bash shell,
   * which the liveness poller then observes as gone.
   */
  attachToNamedSession(): void {
    this.beginAttachBootstrapWindow();
    this.attachSession();
  }

  /** Send the tmux input that hides its status line and joins the live session. */
  private attachSession(): void {
    this.sendInput(`${buildAttachSessionCommand(this.taskId)}\n`);
    this.flushPendingInputSoon();
  }

  /** Drain operator input queued while the sandbox terminal WS was re-opening. */
  private flushPendingInputSoon(): void {
    if (this.pendingInput.length === 0) return;
    setTimeout(() => {
      if (this.transport.readyState !== 'open') {
        this.reconnectForInput();
        return;
      }
      const pending = this.pendingInput.splice(0);
      for (const data of pending) {
        this.sendInput(data);
      }
    }, 100);
  }

  /**
   * The create-vs-attach decision (survive-api-redeploy D2 / 2.5), driven by the
   * SAME liveness probe the poller uses. Run once on `ready` for a
   * `'launch-or-attach'` terminal:
   *   - session ALIVE → {@link attachToNamedSession} (re-adopt the running codex
   *     without restarting it — operator reconnect / boot re-adoption);
   *   - session GONE → {@link launchCodex} (fresh detached launch, first-launch
   *     behavior preserved);
   *   - INCONCLUSIVE (probe could not be made) → fall back to a fresh launch,
   *     which is idempotent for a name that does not yet exist and recoverable if
   *     it did (tmux refuses a duplicate name, then the poller observes the live
   *     one). After deciding, arm the liveness poller so termination is detected by
   *     the session disappearing, NOT by the WS closing (D4). Best-effort: never
   *     throws into the WS message handler.
   */
  private async launchOrAttachOnReady(): Promise<void> {
    // Provider-backed terminals (notably BoxLite) may echo a login shell prompt as
    // soon as the WS reports ready, before the async tmux liveness probe returns.
    // Treat that pre-decision shell noise as attach bootstrap so it stays live-only
    // and never becomes durable task history.
    this.beginAttachBootstrapWindow();
    let bootstrapHandedOff = false;
    try {
      // 3.2 — resolve the task's runtime ONCE before deciding. Best-effort: a missing
      // resolver / rejected promise / undefined result leaves `this.runtime` undefined
      // → the DEFAULT codex inline path. Resolved BEFORE the launch branch so the
      // runtime's `buildLaunchLine` / `autoSubmit` gate the fresh-launch path.
      await this.ensureRuntimeResolved();
      const alive = await this.hasSession();
      if (alive === true) {
        bootstrapHandedOff = true;
        this.attachToNamedSession();
      } else if (alive === false) {
        // Definitively GONE → genuine fresh launch; arm the auto-submit (the runtime
        // gates whether an Enter is actually injected — claude's autoSubmit is a no-op).
        this.endAttachBootstrapWindow();
        bootstrapHandedOff = true;
        this.launchAgent();
      } else {
        // INCONCLUSIVE → fresh launch as a recoverable fallback, but DO NOT arm
        // the auto-submit: if an agent was actually already running, the duplicate
        // `tmux new-session` is a no-op and the attach rejoins it, so a stray Enter
        // must not be injected.
        bootstrapHandedOff = true;
        this.launchAgent(false);
      }
    } catch (err) {
      if (!bootstrapHandedOff) this.endAttachBootstrapWindow();
      this.logger.warn(
        `task ${this.taskId}: launch-or-attach on ready failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      // Arm the liveness poller regardless of which branch ran (or even if it
      // threw): once the shell is established there is a detached session whose
      // disappearance is the authoritative termination signal (D4).
      this.startLivenessPoller();
    }
  }

  /**
   * Dev/test-only provider-backed terminal story fixture. It deliberately does
   * not launch Codex/Claude; the goal is to exercise the provider PTY transport
   * and CAP gateway with deterministic output, input echo, resize markers,
   * scrollback, and reconnect replay.
   */
  private async launchProviderStoryFixture(): Promise<void> {
    if (this.providerStoryFixtureStarted) return;
    this.providerStoryFixtureStarted = true;
    try {
      const result = await this.commandExecutor.exec({
        command: buildProviderStoryFixtureInstallCommand(),
        timeoutMs: 5_000,
      });
      if (result.exitCode !== 0) {
        const output = result.output.trim();
        this.logger.warn(
          `task ${this.taskId}: provider story fixture install failed: exit_code ${result.exitCode}` +
            (output ? ` — ${output}` : ''),
        );
        return;
      }
      this.sendInput(`exec /bin/sh ${PROVIDER_STORY_SCRIPT_PATH}\n`);
      this.flushPendingInputSoon();
    } catch (err) {
      this.logger.warn(
        `task ${this.taskId}: provider story fixture launch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Resize the sandbox PTY as an AIO `{type:"resize",data:{cols,rows}}` frame so
   * the sandbox PTY cols/rows stay in sync with the browser, keeping the
   * "identical cols and rows" live-frame parity precondition reachable (VR.8).
   */
  resize(cols: number, rows: number): void {
    this.transport.sendResize(cols, rows);
    if (this.mode === 'provider-story-fixture') return;
    this.resizeDetachedSession(cols, rows);
  }

  private resizeDetachedSession(cols: number, rows: number): void {
    const geometry = normalizeTerminalGeometry(cols, rows);
    if (!geometry) return;
    const command = buildResizeDetachedSessionCommand(
      this.taskId,
      geometry.cols,
      geometry.rows,
    );
    void this.commandExecutor
      .exec({ command, timeoutMs: TMUX_RESIZE_TIMEOUT_MS })
      .catch((err) => {
        this.logger.debug(
          `task ${this.taskId}: detached tmux resize skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /**
   * Application-layer pause: there is no in-band AIO pause frame, so we
   * socket-pause the WS read side, applying TCP backpressure toward the sandbox
   * producer. The per-operator ACK window above the seam still protects each
   * browser independently.
   */
  pause(): void {
    this.transport.pause();
  }

  /** Resume the WS read side previously paused by {@link pause}. */
  resume(): void {
    this.transport.resume();
  }

  /**
   * Release this bridge's resources WITHOUT terminating the task (D5): stop the
   * liveness poller and close the WS. The DETACHED tmux session is intentionally
   * left running so the next process / operator can re-adopt it. Called when a
   * session is being released for re-adoption (gateway/provider non-destructive
   * shutdown) OR when the task has ALREADY reached a terminal state and the
   * gateway is tearing the session down (4.3 `unregisterSession`). In BOTH cases
   * this must never resolve a (further) exit: it does NOT call {@link onExit}.
   *
   * To make termination EXACTLY ONCE (4.3) it marks {@link exitResolved} so any
   * liveness probe already IN FLIGHT — or a subsequent one — cannot fire a second
   * `onExit` after `close()` (e.g. a deadline/idle `forceFail` stopped the sandbox
   * while a `pollLiveness` was mid-`await`; without this latch that in-flight poll
   * would observe the gone session and re-`recordExit` the already-terminal task).
   * This is NOT "resolving an exit": no status is produced and `onExit` is never
   * invoked here — it only SUPPRESSES a redundant late resolution from this
   * now-defunct bridge (the next process re-adopts via a fresh `AioPtyClient`).
   */
  close(): void {
    this.exitResolved = true;
    this.stopLivenessPoller();
    this.endAttachBootstrapWindow();
    if (this.autoSubmitTimer) {
      clearTimeout(this.autoSubmitTimer);
      this.autoSubmitTimer = undefined;
    }
    try {
      this.transport.close();
    } catch {
      // Best-effort; the transport may already be closing.
    }
  }

  // -------------------------------------------------------------------------
  // Inbound frame translation (sandbox → orchestrator).
  // -------------------------------------------------------------------------

  /**
   * Translate a single inbound AIO JSON frame. Each branch maps an AIO frame
   * type onto the existing pipeline per the translation table; unknown frame
   * types are inert.
   */
  private onTransportFrame(frame: TerminalTransportFrame): void {
    switch (frame.type) {
      case 'session_id':
        // The server-sent `session_id` precedes `ready`; observing it marks the
        // start of the session-established handshake.
        this.sawSessionId = true;
        break;
      case 'ready':
        // `session_id` then `ready` is the session-established signal: the AIO
        // shell is now live. Codex itself lives in a DETACHED tmux session
        // (survive-api-redeploy D1) that we launch fresh or re-attach to. A
        // replay-only terminal does neither. Best-effort: an error is logged,
        // never thrown, so it cannot break the WS message handler.
        this.established = true;
        this.reconnectingForInput = false;
        if (this.mode === 'launch-or-attach') {
          void this.launchOrAttachOnReady();
        } else if (this.mode === 'provider-story-fixture') {
          void this.launchProviderStoryFixture();
        }
        break;
      case 'output':
        this.onOutput(frame);
        break;
      case 'ping':
        // Answer a sandbox liveness ping with an INTERNAL pong distinct from the
        // operator write-lease heartbeat — it never routes through
        // `WriteLockService`; it is purely a transport-level keepalive reply.
        this.transport.sendPong(Date.now());
        break;
      default:
        // Other AIO frame types are inert at this seam.
        break;
    }
  }

  /**
   * Surface a sandbox `{type:"output",data}` frame as raw output into the
   * existing base64-raw pipeline (via `emitData`), and perform CPR injection: on
   * observing the DSR cursor-position query in the output, immediately reply with
   * the synthetic CPR input so codex starts.
   */
  private onOutput(frame: TerminalTransportFrame): void {
    const data = typeof frame.data === 'string' ? frame.data : '';
    if (data.length === 0) return;

    // CPR injection — watch the output stream for the crossterm DSR query and
    // reply immediately so codex proceeds past startup (design D ★).
    if (data.includes(DSR_CURSOR_POSITION_QUERY) && this.terminalStartup.replyToStartupDSR) {
      this.sendInput(SYNTHETIC_CPR_REPLY);
      // The DSR is emitted only by codex's crossterm at TUI startup, never by the
      // shell — observing it confirms codex (not the shell) now owns the terminal,
      // the gate for the zero-touch prompt auto-submit below.
      this.dsrSeen = true;
    }

    // Zero-touch prompt auto-submit: codex's positional prompt only PRE-FILLS the
    // composer, so once its TUI has started (DSR seen) and output has quiesced
    // (initial render done, composer idle), inject a single Enter to submit the
    // pre-filled goal. Re-armed (debounced) on every output frame after the DSR.
    this.maybeArmPromptAutoSubmit();

    // Emit the decoded output into the existing raw pipeline; the gateway
    // base64-encodes it as a `raw` frame for the browser (unchanged protocol).
    const meta = this.outputMeta();
    this.emitData(data, meta);
  }

  private beginAttachBootstrapWindow(): void {
    this.attachBootstrapActive = true;
    this.clearAttachBootstrapTimers();
    if (ATTACH_BOOTSTRAP_MAX_MS <= 0) {
      this.endAttachBootstrapWindow();
      return;
    }
    this.attachBootstrapMaxTimer = setTimeout(() => {
      this.endAttachBootstrapWindow();
    }, ATTACH_BOOTSTRAP_MAX_MS);
    this.attachBootstrapMaxTimer.unref?.();
    this.armAttachBootstrapQuietTimer();
  }

  private armAttachBootstrapQuietTimer(): void {
    if (!this.attachBootstrapActive) return;
    if (this.attachBootstrapQuietTimer) {
      clearTimeout(this.attachBootstrapQuietTimer);
      this.attachBootstrapQuietTimer = undefined;
    }
    if (ATTACH_BOOTSTRAP_QUIESCE_MS <= 0) {
      this.endAttachBootstrapWindow();
      return;
    }
    this.attachBootstrapQuietTimer = setTimeout(() => {
      this.endAttachBootstrapWindow();
    }, ATTACH_BOOTSTRAP_QUIESCE_MS);
    this.attachBootstrapQuietTimer.unref?.();
  }

  private endAttachBootstrapWindow(): void {
    this.attachBootstrapActive = false;
    this.clearAttachBootstrapTimers();
  }

  private clearAttachBootstrapTimers(): void {
    if (this.attachBootstrapQuietTimer) {
      clearTimeout(this.attachBootstrapQuietTimer);
      this.attachBootstrapQuietTimer = undefined;
    }
    if (this.attachBootstrapMaxTimer) {
      clearTimeout(this.attachBootstrapMaxTimer);
      this.attachBootstrapMaxTimer = undefined;
    }
  }

  private outputMeta(): AgentTerminalOutputMeta | undefined {
    if (!this.attachBootstrapActive) return undefined;
    this.armAttachBootstrapQuietTimer();
    return { recordable: false, source: 'attach-bootstrap' };
  }

  /**
   * Arm/re-arm the output-quiescence timer that injects the prompt auto-submit
   * Enter exactly once. Only active when codex was auto-launched and its startup
   * DSR has been seen; each output frame resets the timer so the Enter fires only
   * after a stretch of NO output (the rendered composer sitting idle, ready for
   * input). A misfire degrades to a still-pre-filled composer the operator can
   * submit manually — never a lost goal — so this is best-effort and never throws.
   */
  private maybeArmPromptAutoSubmit(): void {
    if (!this.launchedCodex || !this.dsrSeen || this.promptSubmitted) return;
    if (this.autoSubmitTimer) clearTimeout(this.autoSubmitTimer);
    this.autoSubmitTimer = setTimeout(() => {
      this.autoSubmitTimer = undefined;
      if (this.promptSubmitted) return;
      this.promptSubmitted = true;
      this.sendInput(CODEX_SUBMIT_KEY);
    }, this.terminalStartup.quiesceMs ?? CODEX_PROMPT_AUTOSUBMIT_QUIESCE_MS);
  }

  /** Fan a translated raw output chunk out to every `onData` subscriber. */
  private emitData(chunk: string, meta?: AgentTerminalOutputMeta): void {
    for (const listener of this.dataListeners) {
      listener(chunk, meta);
    }
  }

  // -------------------------------------------------------------------------
  // Exit detection (survive-api-redeploy D4) — liveness, NOT WS close, is the
  // termination signal. A WS close only detaches; the detached session lives on.
  // -------------------------------------------------------------------------

  /**
   * The terminal WebSocket closed. Under the detached-session model (D4) this is
   * NO LONGER the termination event: closing the WS only detaches the operator /
   * api from the named tmux session — codex keeps running inside it for the next
   * process / operator to re-adopt. So a WS close MUST NOT call
   * `recordSuccess`/`recordFailure`; the {@link startLivenessPoller liveness poller}
   * is the sole owner of the exit decision (it fires when the session is GONE).
   *
   * The ONE exception is a close BEFORE the session was ever `established`: the
   * dial itself failed, so there is no detached session to outlive the WS and no
   * poller was ever armed — that is an abnormal start and is resolved here so the
   * task is not left dangling.
   */
  private onTransportClose(): void {
    // Cancel any pending prompt auto-submit so it cannot fire after the WS closed.
    if (this.autoSubmitTimer) {
      clearTimeout(this.autoSubmitTimer);
      this.autoSubmitTimer = undefined;
    }
    this.endAttachBootstrapWindow();
    // A close before the terminal was ever established means the dial failed: no
    // detached session exists, no liveness poller is running, so resolve the
    // abnormal start here (the only WS-close that still terminates the task).
    if (!this.established) {
      if (this.exitResolved) return;
      this.exitResolved = true;
      this.logger.warn(
        `task ${this.taskId}: terminal WS closed before session established (abnormal)`,
      );
      this.onExit?.({ code: null, abnormal: true });
      return;
    }
    // Established session: the WS closed but the detached session may still be
    // alive. Do NOT resolve exit here — the liveness poller decides. Stop polling
    // over this (now-dead) WS's HTTP surface only if the exit was already resolved.
    this.logger.debug(
      `task ${this.taskId}: terminal WS closed; detached session ${this.sessionName} left for re-adoption (not terminating)`,
    );
  }

  /**
   * Start the termination poller on {@link CODEX_LIVENESS_POLL_MS} (D4 / 3.2).
   * RUNTIME-AGNOSTIC: each tick dispatches via {@link pollLiveness} to the resolved
   * runtime. BOTH codex and claude resolve from the SAME `tmux has-session` GONE check
   * (align-claude-runtime-resident-session): claude is a resident continuous-conversation
   * session, so a finished turn does NOT terminate it — the session-gone check is the
   * termination signal for both, and a session that dies unexpectedly is the abnormal death.
   * Either way the FIRST resolved tick drives the terminal path via {@link onExit}.
   * Armed once the AIO shell is established (regardless of launch-vs-attach, so a
   * re-adopted session is watched too) and idempotent — arming twice is a no-op.
   */
  private startLivenessPoller(): void {
    if (this.livenessTimer || this.exitResolved) return;
    this.livenessTimer = setInterval(() => {
      void this.pollLiveness();
    }, CODEX_LIVENESS_POLL_MS);
    // Do not keep the event loop alive solely for this poller.
    this.livenessTimer.unref?.();
  }

  /** Stop the liveness poller. */
  private stopLivenessPoller(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
  }

  /**
   * One liveness probe (D4 / 3.2). The TERMINATION SIGNAL is DISPATCHED to the
   * task's selected runtime's `detectExit`, which for BOTH codex and claude is the
   * SAME `tmux has-session` check (align-claude-runtime-resident-session): while the
   * named session exists the task is running; the first probe that reports it GONE
   * resolves the real exit status and terminates exactly once. A probe error is
   * INCONCLUSIVE (re-check next tick), so a transport blip never force-fails a
   * still-running task. Claude is a resident continuous-conversation session — a
   * finished turn idles for the next input and does NOT terminate the task; the
   * session goes gone only on operator stop or a configured idle/deadline
   * reclamation, and a session that dies unexpectedly is the abnormal death. An
   * UNRESOLVED runtime falls to the inline has-session path below.
   */
  private async pollLiveness(): Promise<void> {
    if (this.exitResolved || this.livenessProbeInFlight) return;
    this.livenessProbeInFlight = true;
    try {
      const runtime = this.runtime;
      if (runtime && typeof runtime.detectExit === 'function') {
        // VR-5: codex's `detectExit` (CodexRuntime) runs the SAME `tmux has-session`
        // probe and resolves via the SAME shared `resolveExitStatus`, so routing it
        // through the port is behavior-preserving and removes the identity branch.
        // Only an UNRESOLVED runtime falls to the inline has-session path below.
        await this.pollRuntimeExit(runtime);
        return;
      }
      // Unresolved runtime only → the inline has-session termination path.
      const alive = await this.hasSession();
      if (alive === null) return; // inconclusive — re-check next tick
      if (alive) return; // still running
      // Session gone: resolve the real exit status (D4) and terminate exactly once.
      if (this.exitResolved) return;
      this.exitResolved = true;
      this.stopLivenessPoller();
      const status = await this.resolveExitStatus();
      this.onExit?.(status);
    } finally {
      this.livenessProbeInFlight = false;
    }
  }

  /**
   * Runtime-driven termination probe. Calls the runtime's `detectExit(exec, taskId)`
   * — for BOTH codex and claude the SAME `tmux has-session` GONE check
   * (align-claude-runtime-resident-session) — then maps its decision:
   *   - `{ done: false }`  → still running (re-check next tick);
   *   - `{ done: null }`   → inconclusive (transient read error; re-check next tick);
   *   - `{ done: true }`   → the session is GONE (operator stop, or a configured
   *     idle/deadline reclamation), so resolve the real exit status via the SHARED
   *     {@link resolveExitStatus} (a clean shutdown → zero exit → `recordSuccess`),
   *     unless the runtime supplied an explicit `status`. Terminates exactly once.
   * Never throws into the poller: a `detectExit` rejection is treated as inconclusive
   * so a still-running task is never force-failed by a transient probe blip (the
   * abnormal-death watchdog still catches a truly dead session).
   */
  private async pollRuntimeExit(runtime: AioTerminalRuntime): Promise<void> {
    // Call the port runtime's `detectExit` directly (refactor step 5: no adapter) —
    // a port `SandboxExec` (via {@link toPortExec}) + the port `LaunchContext`. BOTH
    // codex and claude resolve from the `tmux has-session` GONE check; claude is a
    // resident session, so a finished turn keeps it running (not killed on end_turn).
    let signal: AioExitSignal | undefined;
    try {
      signal = await runtime.detectExit(toAioTerminalRuntimeExec(this.runSandboxExec()), {
        taskId: this.taskId,
        workspaceDir: CLAUDE_WORKSPACE_DIR,
        sessionId: aioSessionIdForTask(this.taskId),
      });
    } catch (err) {
      this.logger.debug(
        `task ${this.taskId}: runtime "${runtime.id}" detectExit probe errored (inconclusive): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      signal = undefined;
    }
    if (signal && signal.status === 'done') {
      // The session is GONE (operator stop, or a configured idle/deadline reclamation).
      // Resolve the real exit status via the SHARED path (a clean shutdown → zero exit →
      // recordSuccess), unless the runtime supplied an explicit status. Terminates once.
      if (this.exitResolved) return;
      this.exitResolved = true;
      this.stopLivenessPoller();
      const status: AioExitStatus = await this.resolveExitStatus();
      this.onExit?.(status);
      return;
    }
    // detectExit says NOT-done (or was inconclusive/errored). As an ABNORMAL-DEATH
    // backstop the poller independently probes `tmux has-session`: a definitively GONE
    // session (the agent crashed or the tmux daemon died) resolves the exit status
    // exactly once, so a resident task whose session vanished is never left hanging. An
    // alive/inconclusive session re-checks next tick — so a transient probe blip never
    // force-fails a live, resident task idling for the operator's next input.
    const alive = await this.hasSession();
    if (alive === null || alive === true) return;
    if (this.exitResolved) return;
    this.exitResolved = true;
    this.stopLivenessPoller();
    const status = await this.resolveExitStatus();
    this.onExit?.(status);
  }

  /**
   * The {@link SandboxExec} closure a runtime's `detectExit` uses to read the
   * transcript / kill the session over THIS sandbox's `/v1/shell/exec`, returning
   * the parsed `{exitCode, output}`. A non-`ok` HTTP status surfaces as
   * `{exitCode: NaN}` so the runtime treats it as inconclusive rather than as
   * completion.
   */
  private runSandboxExec(): AioLegacySandboxExec {
    return async (command: string) => {
      const result = await this.commandExecutor.exec({ command });
      return {
        exitCode: result.exitCode,
        output: result.output,
      };
    };
  }

  /**
   * Liveness check (2.3): `tmux has-session -t <sessionName>` via
   * `POST /v1/shell/exec`. Returns `true` when the session exists (exit 0),
   * `false` when it is gone (non-zero), or `null` when the probe itself could not
   * be made (HTTP error / unparseable) — INCONCLUSIVE, so the poller re-checks
   * rather than mistaking a transport blip for a terminated task. Delegates to the
   * module-level {@link probeSessionLiveness} so the gateway's create-vs-attach
   * probe and this poller share one implementation.
   */
  hasSession(): Promise<boolean | null> {
    return probeSessionLiveness(this.commandExecutor, this.taskId);
  }

  /**
   * Resolve the task exit status once the session is gone (or on an abnormal
   * start). Resolve via `POST <baseUrl>/v1/shell/wait` (authoritative) falling
   * back to `POST <baseUrl>/v1/shell/exec` running `echo $?`. When neither
   * resolves, the termination is abnormal.
   */
  private async resolveExitStatus(): Promise<AioExitStatus> {
    // fix-headless-execution-container-gaps: a headless agent runs AS the detached tmux
    // session's command, so once it exits the session ends and its real exit code is
    // unrecoverable from the AIO main shell (wait/echo below both miss it → abnormal →
    // failed, even for a clean success). Read the sentinel the headless wrapper captured
    // `$?` into FIRST. Interactive tasks skip this and keep the wait/echo path unchanged.
    if (this.executionMode === 'headless-exec') {
      const fromFile = await this.resolveViaExitFile();
      if (fromFile !== null) {
        return { code: fromFile, abnormal: false };
      }
    }
    const waited = await this.resolveViaWait();
    if (waited !== null) {
      return { code: waited, abnormal: false };
    }
    const echoed = await this.resolveViaEcho();
    if (echoed !== null) {
      return { code: echoed, abnormal: false };
    }
    this.logger.warn(`task ${this.taskId}: exit status could not be resolved (abnormal)`);
    return { code: null, abnormal: true };
  }

  /** Resolve the exit code via `POST /v1/shell/wait`, or null on failure. */
  private async resolveViaWait(): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/shell/wait`, { method: 'POST' });
      if (!res.ok) return null;
      const body = (await res.json()) as { exitCode?: unknown; code?: unknown };
      return coerceExitCode(body.exitCode ?? body.code);
    } catch {
      return null;
    }
  }

  /**
   * Resolve the exit code via the per-task sentinel the HEADLESS wrapper captured `$?` into
   * (`cat <headlessExitFile>` over `/v1/shell/exec`), or null if missing/unreadable. Only the
   * headless path reads this (see {@link resolveExitStatus}).
   */
  private async resolveViaExitFile(): Promise<number | null> {
    try {
      const res = await this.commandExecutor.exec({
        command: `cat ${headlessExitFile(this.taskId)}`,
      });
      return coerceExitCode(res.output.trim());
    } catch {
      return null;
    }
  }

  /** Resolve the exit code via `POST /v1/shell/exec` running `echo $?`. */
  private async resolveViaEcho(): Promise<number | null> {
    try {
      const res = await this.commandExecutor.exec({ command: 'echo $?' });
      return coerceExitCode(res.output.trim());
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound frame helpers (orchestrator → sandbox).
  // -------------------------------------------------------------------------

  /** Send an AIO `{type:"input",data}` frame to the sandbox. */
  private sendInput(data: string): void {
    const sent = this.transport.sendInput(data);
    if (!sent) {
      this.pendingInput.push(data);
      this.reconnectForInput();
    }
  }
}

/**
 * Probe whether a task's DETACHED named tmux session is alive WITHOUT opening a
 * terminal WebSocket (survive-api-redeploy 2.3/2.5). Runs
 * `tmux has-session -t task<taskId>` over `POST <baseUrl>/v1/shell/exec`. Returns
 * `true` when alive (exit 0), `false` when gone (non-zero), or `null` when the
 * probe could not be made (HTTP error / unparseable). The gateway uses this to
 * decide create-vs-attach when opening a session, and the boot re-adoption pass
 * (Track 3) consumes the same shape via its own `/v1/shell/exec` call.
 */
export async function probeSessionLiveness(
  executor: SandboxCommandExecutor,
  taskId: string,
): Promise<boolean | null> {
  try {
    const result = await executor.exec({
      command: `${buildHasSessionCommand(taskId)}; echo __cap_has__$?`,
    });
    const match = /__cap_has__(-?\d+)/.exec(result.output);
    if (!match) return null;
    return match[1] === '0';
  } catch {
    return null;
  }
}

/**
 * Coerce a value that should be an integer exit code into a number, or null if
 * it is not a parseable non-negative integer.
 */
function coerceExitCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  }
  return null;
}

function normalizeTerminalGeometry(
  cols: number,
  rows: number,
): { cols: number; rows: number } | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  const normalizedCols = Math.trunc(cols);
  const normalizedRows = Math.trunc(rows);
  if (normalizedCols <= 0 || normalizedRows <= 0) return null;
  return { cols: normalizedCols, rows: normalizedRows };
}

/**
 * Parse a headless exit code from a `/v1/shell/exec` `cat <sentinel>` response.
 * fix-headless-execution-container-gaps: the live AIO server NESTS the result under `data`
 * (`{data:{output, stdout, ...}}`) — reading the TOP level yields `undefined` even on success
 * (the same trap `parseExecResult`/`runSandboxExec` already unwrap). The `cat`'d sentinel
 * content (the AGENT's exit code) is in `output`/`stdout`, NOT `exit_code` (that is `cat`'s own
 * exit). Pure + exported so the data-nested shape — the exact case the unit suite missed — is
 * regression-tested without standing up a WebSocket/container.
 */
export function exitCodeFromExecBody(top: unknown): number | null {
  if (top === null || typeof top !== 'object') return null;
  const t = top as Record<string, unknown>;
  const d = (t.data ?? t) as { stdout?: unknown; output?: unknown };
  const out =
    typeof d.output === 'string'
      ? d.output
      : typeof d.stdout === 'string'
        ? d.stdout
        : '';
  return coerceExitCode(out.trim());
}
