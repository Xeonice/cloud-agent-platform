/**
 * @cap/api — AIO Sandbox terminal bridge (`AioPtyClient`).
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
import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import type { TerminalPty } from './terminal.gateway';
import {
  argvDisablesHooks,
  buildDetachedCodexLaunchLine,
  detachedSessionName,
} from './codex-launch';

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
 * integration task 6.1). Updated for codex 0.131 (the old `--full-auto` was
 * REMOVED upstream — 0.131 rejects it with "unexpected argument", verified live):
 *   - `-C /home/gem/workspace` runs codex in the cloned task repo (the
 *     /v1/shell/ws shell's cwd is HOME=/home/gem, not the clone dir).
 *   - `--ask-for-approval never --sandbox danger-full-access` is the 0.131
 *     non-interactive auto-run equivalent. LONG-form `--sandbox` is deliberate:
 *     the {@link launchCodex} guard rejects `-s`/`bypass-approvals`/`--yolo`, and
 *     `--sandbox`/`--ask-for-approval` clear it.
 *   - `--dangerously-bypass-hook-trust` trusts the baked `~/.codex/hooks.json`
 *     non-interactively. NOTE: it does NOT skip the DIRECTORY-trust prompt — that
 *     is handled out-of-band by writing `~/.codex/config.toml`
 *     `[projects."/home/gem/workspace"] trust_level="trusted"` at provision time
 *     (AioSandboxProvider), NOT via a launch flag.
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
  'codex -C /home/gem/workspace --ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust';

/**
 * The Enter key (carriage return) codex's TUI composer submits on. Injected ONCE
 * as the zero-touch prompt auto-submit (aio-codex-prompt-autostart): codex's
 * positional `[PROMPT]` only PRE-FILLS the composer, so a single `\r` after the
 * TUI is up and idle submits the pre-filled goal with no operator keystroke.
 */
const CODEX_SUBMIT_KEY = '\r';

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

/** A sandbox AIO JSON frame received over the terminal WebSocket. */
interface AioInboundFrame {
  type: string;
  data?: unknown;
  [key: string]: unknown;
}

/** The resolved exit outcome of a terminated sandbox session. */
export interface AioExitStatus {
  /** The numeric exit code, or null when it could not be resolved. */
  readonly code: number | null;
  /**
   * True when the session terminated abnormally (the WS closed before a
   * `session_id`/`ready` was ever seen, or the exit status could not be
   * resolved). An abnormal termination maps to guardrails `recordFailure`
   * regardless of `code`.
   */
  readonly abnormal: boolean;
}

/**
 * `AioPtyClient` opens an OUTBOUND `ws` client into the sandbox terminal and
 * presents it to the gateway as a {@link TerminalPty}, exposing the same
 * `onData`/`write`/`resize`/`pause`/`resume` surface the gateway consumes.
 */
export class AioPtyClient implements TerminalPty {
  private readonly logger = new Logger(AioPtyClient.name);

  /** Subscribers to translated raw PTY output (decoded sandbox `output` data). */
  private readonly dataListeners = new Set<(chunk: string) => void>();

  /** The outbound terminal WebSocket into the sandbox. */
  private readonly socket: WebSocket;

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

  /** Debounce timer backing the output-quiescence prompt auto-submit. */
  private autoSubmitTimer?: ReturnType<typeof setTimeout>;

  /**
   * The detached named tmux session this client drives, `task<taskId>`
   * (survive-api-redeploy D1). Codex runs inside it; this name is what the
   * liveness poller probes (`tmux has-session`) and what {@link attachToNamedSession}
   * attaches to.
   */
  private readonly sessionName: string;

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
  constructor(
    private readonly taskId: string,
    wsUrl: string,
    private readonly baseUrl: string,
    private readonly onExit?: (status: AioExitStatus) => void,
    private readonly mode: 'launch-or-attach' | 'replay-only' = 'replay-only',
  ) {
    this.sessionName = detachedSessionName(taskId);
    // Connect WITHOUT any `?session_id=` query parameter so the sandbox creates a
    // fresh tmux-backed AIO shell. Rejoining an existing AIO session by passing
    // `?session_id=` returns an immediate error frame and closes; instead codex
    // lives in a DETACHED tmux session we launch-or-attach to over a fresh WS
    // (survive-api-redeploy D1/D2), and `SnapshotManager` (above the seam) owns
    // operator reconnect/restore.
    this.socket = new WebSocket(wsUrl);
    this.socket.on('message', (raw) => this.onSocketMessage(raw));
    this.socket.on('close', () => this.onSocketClose());
    this.socket.on('error', (err) => {
      this.logger.warn(`task ${this.taskId}: sandbox terminal WS error: ${err.message}`);
    });
  }

  // -------------------------------------------------------------------------
  // TerminalPty surface — consumed by the gateway above the seam.
  // -------------------------------------------------------------------------

  /** Subscribe to translated raw PTY output; returns an unsubscribe handle. */
  onData(listener: (chunk: string) => void): { dispose(): void } {
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

  /**
   * Launch codex in a DETACHED, NAMED tmux session then ATTACH to it
   * (survive-api-redeploy D1). Sends, as terminal input over `/v1/shell/ws`:
   *
   *   tmux new-session -d -s task<taskId> -c /home/gem/workspace '<codex line>'
   *   tmux attach -t task<taskId>
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
    // Guard: never launch codex with a flag that DISABLES hooks. `-s` /
    // bypass-approvals turn the baked approval hooks off, which would fail OPEN
    // on approvals; refuse rather than launch an unguarded agent.
    // Guard inspects ONLY the fixed launch flags (`argv`), never the operator
    // prompt text — the prompt rides the injected file referenced via
    // `"$(cat …)"` inside buildCodexLaunchLine, so a prompt that merely mentions
    // `-s`/`--yolo`/`bypass-approvals` cannot false-positive here. Wrapping the
    // line in tmux does NOT change what the guard sees: it still inspects `argv`.
    if (argvDisablesHooks(argv)) {
      throw new Error(
        `refusing to launch codex with hook-disabling flags (-s / --yolo / bypass-approvals would fail open on approvals): ${argv}`,
      );
    }
    // Create the detached session carrying codex with the task prompt PRE-FILLED
    // (when one was injected at provision time) without inlining the prompt text,
    // then attach so its output streams here and the output-quiescence trigger in
    // `onOutput` can auto-submit the pre-filled goal (codex's positional prompt
    // does not auto-run on its own).
    this.launchedCodex = armAutoSubmit;
    this.sendInput(`${buildDetachedCodexLaunchLine(this.taskId, argv)}\n`);
    this.attachSession();
  }

  /**
   * Attach this WS shell to the (already-running) detached named session
   * `task<taskId>` (survive-api-redeploy D2/2.3). Sends `tmux attach -t task<id>`
   * so the live codex's output streams over this WS and operator input is injected
   * into the shared pane — the operator-reconnect / boot-re-adoption path. Does
   * NOT launch a new agent. The caller is responsible for having verified liveness
   * (gateway create-vs-attach, 2.5); a stale attach to a dead session simply drops
   * back to the bash shell, which the liveness poller then observes as gone.
   */
  attachToNamedSession(): void {
    this.attachSession();
  }

  /** Send the `tmux attach -t <sessionName>` input that joins the live session. */
  private attachSession(): void {
    this.sendInput(`tmux attach -t ${this.sessionName}\n`);
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
    try {
      const alive = await this.hasSession();
      if (alive === true) {
        this.attachToNamedSession();
      } else if (alive === false) {
        // Definitively GONE → genuine fresh launch; arm the auto-submit.
        this.launchCodex();
      } else {
        // INCONCLUSIVE → fresh launch as a recoverable fallback, but DO NOT arm
        // the auto-submit: if a codex was actually already running, the duplicate
        // `tmux new-session` is a no-op and the attach rejoins it, so a stray Enter
        // must not be injected.
        this.launchCodex(undefined, false);
      }
    } catch (err) {
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
   * Resize the sandbox PTY as an AIO `{type:"resize",data:{cols,rows}}` frame so
   * the sandbox PTY cols/rows stay in sync with the browser, keeping the
   * "identical cols and rows" live-frame parity precondition reachable (VR.8).
   */
  resize(cols: number, rows: number): void {
    this.sendJson({ type: 'resize', data: { cols, rows } });
  }

  /**
   * Application-layer pause: there is no in-band AIO pause frame, so we
   * socket-pause the WS read side, applying TCP backpressure toward the sandbox
   * producer. The per-operator ACK window above the seam still protects each
   * browser independently.
   */
  pause(): void {
    this.socket.pause();
  }

  /** Resume the WS read side previously paused by {@link pause}. */
  resume(): void {
    this.socket.resume();
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
    if (this.autoSubmitTimer) {
      clearTimeout(this.autoSubmitTimer);
      this.autoSubmitTimer = undefined;
    }
    try {
      this.socket.close();
    } catch {
      // Best-effort; the socket may already be closing.
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
  private onSocketMessage(raw: WebSocket.RawData): void {
    const frame = this.parseFrame(raw);
    if (!frame) return;

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
        if (this.mode === 'launch-or-attach') {
          void this.launchOrAttachOnReady();
        }
        break;
      case 'output':
        this.onOutput(frame);
        break;
      case 'ping':
        // Answer a sandbox liveness ping with an INTERNAL pong distinct from the
        // operator write-lease heartbeat — it never routes through
        // `WriteLockService`; it is purely a transport-level keepalive reply.
        this.sendJson({ type: 'pong', timestamp: Date.now() });
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
  private onOutput(frame: AioInboundFrame): void {
    const data = typeof frame.data === 'string' ? frame.data : '';
    if (data.length === 0) return;

    // CPR injection — watch the output stream for the crossterm DSR query and
    // reply immediately so codex proceeds past startup (design D ★).
    if (data.includes(DSR_CURSOR_POSITION_QUERY)) {
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
    this.emitData(data);
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
    }, CODEX_PROMPT_AUTOSUBMIT_QUIESCE_MS);
  }

  /** Fan a translated raw output chunk out to every `onData` subscriber. */
  private emitData(chunk: string): void {
    for (const listener of this.dataListeners) {
      listener(chunk);
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
  private onSocketClose(): void {
    // Cancel any pending prompt auto-submit so it cannot fire after the WS closed.
    if (this.autoSubmitTimer) {
      clearTimeout(this.autoSubmitTimer);
      this.autoSubmitTimer = undefined;
    }
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
   * Start the liveness poller (D4): on {@link CODEX_LIVENESS_POLL_MS} probe whether
   * the named tmux session still exists. While it exists the task is running; the
   * first probe that reports it GONE resolves the exit status and drives the
   * terminal path via {@link onExit}. Idempotent — arming twice is a no-op.
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
   * One liveness probe (D4): if the named tmux session is still alive, return
   * without action. When it is GONE — and the exit has not already been resolved —
   * resolve the exit status and hand it to {@link onExit}, then stop polling. A
   * probe error (sandbox HTTP unreachable, e.g. the api just lost the WS during a
   * redeploy) is treated as INCONCLUSIVE, not as "gone", so a transient blip never
   * force-fails a still-running task; the next poll re-checks.
   */
  private async pollLiveness(): Promise<void> {
    if (this.exitResolved || this.livenessProbeInFlight) return;
    this.livenessProbeInFlight = true;
    try {
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
   * Liveness check (2.3): `tmux has-session -t <sessionName>` via
   * `POST /v1/shell/exec`. Returns `true` when the session exists (exit 0),
   * `false` when it is gone (non-zero), or `null` when the probe itself could not
   * be made (HTTP error / unparseable) — INCONCLUSIVE, so the poller re-checks
   * rather than mistaking a transport blip for a terminated task. Delegates to the
   * module-level {@link probeSessionLiveness} so the gateway's create-vs-attach
   * probe and this poller share one implementation.
   */
  hasSession(): Promise<boolean | null> {
    return probeSessionLiveness(this.baseUrl, this.taskId);
  }

  /**
   * Resolve the task exit status once the session is gone (or on an abnormal
   * start). Resolve via `POST <baseUrl>/v1/shell/wait` (authoritative) falling
   * back to `POST <baseUrl>/v1/shell/exec` running `echo $?`. When neither
   * resolves, the termination is abnormal.
   */
  private async resolveExitStatus(): Promise<AioExitStatus> {
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

  /** Resolve the exit code via `POST /v1/shell/exec` running `echo $?`. */
  private async resolveViaEcho(): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'echo $?' }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { stdout?: unknown; output?: unknown };
      const out = typeof body.stdout === 'string' ? body.stdout : typeof body.output === 'string' ? body.output : '';
      return coerceExitCode(out.trim());
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound frame helpers (orchestrator → sandbox).
  // -------------------------------------------------------------------------

  /** Send an AIO `{type:"input",data}` frame to the sandbox. */
  private sendInput(data: string): void {
    this.sendJson({ type: 'input', data });
  }

  /** Serialize and send an AIO JSON frame if the socket is open. */
  private sendJson(frame: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  /** Parse an inbound `ws` payload into an AIO JSON frame, or null to drop it. */
  private parseFrame(raw: WebSocket.RawData): AioInboundFrame | null {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString('utf8');
    } else if (Array.isArray(raw)) {
      text = Buffer.concat(raw).toString('utf8');
    } else {
      text = Buffer.from(raw as ArrayBuffer).toString('utf8');
    }
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof obj !== 'object' || obj === null || typeof (obj as { type?: unknown }).type !== 'string') {
      return null;
    }
    return obj as AioInboundFrame;
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
  baseUrl: string,
  taskId: string,
): Promise<boolean | null> {
  const sessionName = detachedSessionName(taskId);
  try {
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: `tmux has-session -t ${sessionName}; echo __cap_has__$?`,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { stdout?: unknown; output?: unknown };
    const out =
      typeof body.stdout === 'string'
        ? body.stdout
        : typeof body.output === 'string'
          ? body.output
          : '';
    const match = /__cap_has__(-?\d+)/.exec(out);
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
