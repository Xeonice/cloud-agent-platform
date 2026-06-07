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
 * The bridge connects WITHOUT any `?session_id=` query parameter so the sandbox
 * creates a fresh tmux-backed session per task, and detects task termination by
 * observing the terminal WS close (`node-pty`'s `onExit` no longer exists),
 * resolving the exit status via the sandbox `exec`/`wait` HTTP surfaces.
 */
import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import type { TerminalPty } from './terminal.gateway';
import { argvDisablesHooks, buildCodexLaunchLine } from './codex-launch';

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
 * This is the BASE argv only. `launchCodex` wraps it with `buildCodexLaunchLine`,
 * which appends the task's prompt as codex's positional `[PROMPT]` via
 * `"$(cat <prompt-file>)"` (pre-filling the composer) without inlining the prompt
 * text. Because the positional prompt only PRE-FILLS (it does not auto-run),
 * `onOutput` injects a single Enter once the startup DSR is seen and output
 * quiesces — the zero-touch auto-submit (aio-codex-prompt-autostart).
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

  /** Debounce timer backing the output-quiescence prompt auto-submit. */
  private autoSubmitTimer?: ReturnType<typeof setTimeout>;

  /**
   * @param taskId   The task this terminal belongs to.
   * @param wsUrl    The sandbox terminal WS, `ws://cap-aio-<taskId>:8080/v1/shell/ws`.
   * @param baseUrl  The sandbox HTTP API root, `http://cap-aio-<taskId>:8080`,
   *                 used by exit-status resolution (`exec`/`wait`).
   * @param onExit   Invoked once with the resolved {@link AioExitStatus} after
   *                 the terminal WS closes. The guardrails mapping
   *                 (zero → `recordSuccess`, non-zero/abnormal → `recordFailure`)
   *                 is wired by the caller (guardrails-wiring 4.3).
   */
  constructor(
    private readonly taskId: string,
    wsUrl: string,
    private readonly baseUrl: string,
    private readonly onExit?: (status: AioExitStatus) => void,
    /**
     * When true, codex is auto-launched (via {@link launchCodex}) the moment the
     * sandbox terminal reports `ready` — the connect-in execution trigger. The
     * `auth.json` injected into `/home/gem/.codex` at provision time is already
     * in place by then, so codex authenticates on startup. Defaults to false so
     * terminals opened only for attach/replay never spawn an agent.
     */
    private readonly autoLaunchCodex: boolean = false,
  ) {
    // Connect WITHOUT any `?session_id=` query parameter so the sandbox creates a
    // fresh tmux-backed session per task. Rejoining an existing session by
    // passing `?session_id=` returns an immediate error frame and closes, and
    // `SnapshotManager` (above the seam) owns operator reconnect/restore — so a
    // new session is always correct here.
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
   * Launch codex in-shell with the hooks-preserving, trust-bypassing argv
   * (integration task 6.1). Sends `<argv>\n` as terminal input so codex starts
   * INSIDE the AIO shell over `/v1/shell/ws` (execution model A) — never via the
   * request/response `exec`/MCP surfaces. `argv` defaults to
   * {@link DEFAULT_CODEX_LAUNCH_ARGV} (`codex --full-auto
   * --dangerously-bypass-hook-trust`), which is the SAME launch contract baked
   * into the derived image as `CODEX_LAUNCH_ARGV`. The CPR injection in
   * {@link onOutput} unblocks crossterm's startup DSR query so codex renders.
   */
  launchCodex(argv: string = process.env['CODEX_LAUNCH_ARGV'] ?? DEFAULT_CODEX_LAUNCH_ARGV): void {
    // Guard: never launch codex with a flag that DISABLES hooks. `-s` /
    // bypass-approvals turn the baked approval hooks off, which would fail OPEN
    // on approvals; refuse rather than launch an unguarded agent.
    // Guard inspects ONLY the fixed launch flags (`argv`), never the operator
    // prompt text — the prompt rides the injected file referenced via
    // `"$(cat …)"` inside buildCodexLaunchLine, so a prompt that merely mentions
    // `-s`/`--yolo`/`bypass-approvals` cannot false-positive here.
    if (argvDisablesHooks(argv)) {
      throw new Error(
        `refusing to launch codex with hook-disabling flags (-s / --yolo / bypass-approvals would fail open on approvals): ${argv}`,
      );
    }
    // Launch codex with the task prompt PRE-FILLED into the composer (when one
    // was injected at provision time) without inlining the prompt text. The
    // pre-filled goal is then auto-submitted by the output-quiescence trigger in
    // `onOutput` (codex's positional prompt does not auto-run on its own).
    this.sendInput(`${buildCodexLaunchLine(argv)}\n`);
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
        // `session_id` then `ready` is the session-established signal: the
        // terminal is now live. We never rejoin a prior session.
        this.established = true;
        // Connect-in execution trigger: once the terminal is live, launch codex
        // in-shell. The auth.json was written into /home/gem/.codex at provision
        // time, so codex authenticates on startup; the CPR injection in onOutput
        // unblocks its TUI. Gated by autoLaunchCodex so attach/replay-only
        // terminals never spawn an agent. Best-effort: a launch error is logged,
        // never thrown, so it cannot break the WS message handler.
        if (this.autoLaunchCodex) {
          try {
            this.launchCodex();
          } catch (err) {
            this.logger.warn(
              `task ${this.taskId}: codex auto-launch failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
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
    if (!this.autoLaunchCodex || !this.dsrSeen || this.promptSubmitted) return;
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
  // Exit detection (design D) — WS close → resolve status → guardrails mapping.
  // -------------------------------------------------------------------------

  /**
   * The terminal WebSocket closed: task execution terminated. `node-pty`'s
   * `onExit` no longer exists, so the WS close is the termination event. Resolve
   * the exit status via the sandbox `exec`/`wait` HTTP surfaces and hand it to
   * the caller's `onExit` so guardrails can map zero → `recordSuccess` and
   * non-zero/abnormal → `recordFailure` (the mapping itself is wired in
   * guardrails-wiring).
   */
  private onSocketClose(): void {
    // Cancel any pending prompt auto-submit so it cannot fire after the WS closed.
    if (this.autoSubmitTimer) {
      clearTimeout(this.autoSubmitTimer);
      this.autoSubmitTimer = undefined;
    }
    if (this.exitResolved) return;
    this.exitResolved = true;
    void this.resolveExitStatus().then((status) => {
      this.onExit?.(status);
    });
  }

  /**
   * Resolve the task exit status after WS close. A close BEFORE the session was
   * ever established is abnormal regardless of any code. Otherwise resolve via
   * `POST <baseUrl>/v1/shell/wait` (authoritative) falling back to
   * `POST <baseUrl>/v1/shell/exec` running `echo $?`.
   */
  private async resolveExitStatus(): Promise<AioExitStatus> {
    if (!this.established) {
      this.logger.warn(
        `task ${this.taskId}: terminal WS closed before session established (abnormal)`,
      );
      return { code: null, abnormal: true };
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
