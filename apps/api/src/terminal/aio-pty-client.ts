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
 * integration task 6.1). `--full-auto` KEEPS the baked PreToolUse/PostToolUse
 * hooks (the `-s` sandbox / bypass-approvals flags DISABLE them, so they are
 * never used here), and `--dangerously-bypass-hook-trust` trusts the baked
 * `~/.codex/hooks.json` non-interactively (there is no operator in the sandbox to
 * answer codex's interactive trust prompt). The derived image bakes the SAME
 * string as `CODEX_LAUNCH_ARGV` (docker/aio-sandbox.Dockerfile) as the single
 * source of truth; this default mirrors it so the bridge launch path stays
 * correct even when the env is not threaded through. NOTE (codex#16732, D8 ★):
 * this launch is NOT assumed to make hooks fire reliably — it is gated by the
 * live fire-test (6.8) and backed by the cap-controlled fallback (6.9).
 */
const DEFAULT_CODEX_LAUNCH_ARGV = 'codex --full-auto --dangerously-bypass-hook-trust';

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
    if (/(^|\s)-s(\s|$)|bypass-approvals/.test(argv)) {
      throw new Error(
        `refusing to launch codex with hook-disabling flags (would fail open on approvals): ${argv}`,
      );
    }
    this.sendInput(`${argv}\n`);
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
    }

    // Emit the decoded output into the existing raw pipeline; the gateway
    // base64-encodes it as a `raw` frame for the browser (unchanged protocol).
    this.emitData(data);
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
