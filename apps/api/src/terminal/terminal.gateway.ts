/**
 * @cap/api — realtime terminal WebSocket gateway.
 *
 * Streams a task's terminal over a SINGLE WebSocket carrying two logically
 * distinct channels (D4):
 *   - a RAW byte-stream channel reproducing the PTY output, and
 *   - a structured CONTROL-frame channel.
 *
 * Discrimination is encoded in the contracts frame protocol on the top-level
 * `channel` tag (`"raw"` vs `"control"`): a raw frame's payload is opaque and is
 * NEVER parsed as a control frame, and every control frame is validated against
 * the contracts `ControlFrameSchema` before it is acted on (5.1).
 *
 * The gateway's transport core owns the dual-channel transport, control-frame
 * validation, application-layer backpressure (5.2), the ACK-based pause/resume
 * protocol (5.3), and snapshot + tail-replay reconnect (5.4), delegating
 * bookkeeping to {@link BackpressureController} and {@link SnapshotManager}.
 *
 * Under the CONNECT-IN model the orchestrator is the WebSocket *client* into each
 * task's sandbox: it dials the per-task AIO Sandbox terminal OUT via an
 * {@link AioPtyClient} (registered through {@link openSession}), which becomes the
 * `TerminalSession.pty` backend. There is no inbound runner dial-back — the only
 * inbound peers are operator console clients. The layers above the `TerminalPty`
 * seam (auth, lease, approval routing, backpressure, snapshots, guardrails) are
 * unchanged by this inversion. The gateway layers on:
 *   - connect-time OPERATOR authentication of console clients via the human
 *     SESSION (cookie or `bearer.<token>` subprotocol) with a DB allowed re-check,
 *     and the gated legacy `AUTH_TOKEN` break-glass path, resolved by the shared
 *     `resolveOperatorPrincipal` — closing unauthenticated/expired/disabled
 *     connections before they join any task stream;
 *   - approval routing (6.5) — a sandbox `permission_request`, delivered over an
 *     OUTBOUND HTTP callback (re-homed in the integration track), is fanned out to
 *     operator clients and the resolved `decision` is returned to the blocked hook
 *     over its reply transport by `requestId` correlation;
 *   - raw keystroke forwarding GATED on holding the write lease (7.5), while
 *     one-shot approval `decision`s are accepted independently of the lease.
 */
import path from 'node:path';
import { statSync } from 'node:fs';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Terminal as HeadlessXterm } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { RawData, Server, WebSocket } from 'ws';
import {
  ControlFrameSchema,
  FRAME_CHANNEL,
  extractWsOperatorToken,
  type AckFrame,
  type ConnectAuthFrame,
  type ControlFrame,
  type DecisionFrame,
  type HeartbeatFrame,
  type KeystrokeFrame,
  type PauseFrame,
  type PermissionRequestFrame,
  type PostToolUseReportFrame,
  type RawFrame,
  type ReconnectFrame,
  type ResizeFrame,
  type ResumeFrame,
  type TakeoverRequestFrame,
  parseAsciicastEvent,
  parseAsciicastHeader,
} from '@cap/contracts';
import {
  BackpressureController,
  type FlowSignal,
} from './backpressure';
import {
  SnapshotManager,
  SESSION_LOG_FILENAME,
  SESSION_CAST_FILENAME,
  readSessionLogTail,
  type HeadlessTerminal,
  type WsControlFrame,
} from './snapshot';
import {
  buildCastHeaderLine,
  buildCastEventLine,
  castResizeData,
} from './cast-writer';
import type {
  AgentTerminalLaunchOutcome,
  AgentTerminalOutputMeta,
  AgentTerminalPty,
} from './agent-terminal-pty';
import {
  openSandboxTerminalPty,
  SandboxRuntimeModelSetupError,
  type AioResolvedTaskLaunchContext,
  type SandboxTerminalExitStatus,
  type SandboxTerminalPtyMode,
} from '@cap/sandbox';
import type { SelectedSandboxRun } from '@cap/sandbox';
import type { SandboxConnection } from '../sandbox/sandbox-provider.port';
// add-claude-code-runtime Track 3 (3.2): the gateway resolves the task's selected
// AgentRuntime (Track 2's RuntimeRegistry) and threads it into the AioPtyClient so
// the launch / autosubmit / exit-detection seams dispatch to it. Optional injection
// — when no registry is wired (focused transport unit context) the bridge defaults
// to the codex inline path, so nothing about the codex flow changes.
import {
  RUNTIME_REGISTRY,
  type AgentRuntime,
  type RuntimeRegistry,
} from '../agent-runtime/agent-runtime.integration';
import type { ExecutionMode } from '../agent-runtime/agent-runtime.port';
import { WriteLockService } from '../write-lock/write-lock.service';
// Connect-time operator SESSION authentication (replaces
// the AUTH_TOKEN-only operator check). `resolveOperatorPrincipal` is the shared,
// transport-agnostic decision point (also used by the REST guard), and it performs
// the constant-time legacy-bearer comparison internally, so the gateway needs no
// direct `constantTimeEqual` import.
import { AuthSessionService } from '../auth/auth-session.service';
import { resolveOperatorPrincipal } from '../auth/operator-principal';
import { readCookie, SESSION_COOKIE_NAME } from '../auth/session-token';
import { GuardrailsService } from '../guardrails/guardrails.service';
import {
  PROVISION_LOOKUP,
  type ProvisionLookup,
  type TaskLaunchContext,
} from '../sandbox/provision-lookup.port';
import { stableJson } from '../runtime-models/runtime-model-catalog.util';

/**
 * REAL headless xterm terminal backing the {@link SnapshotManager} (D9).
 *
 * Replaces the prior `NullHeadlessTerminal` (whose `serialize()` was always
 * empty, so every periodic snapshot was blank and `buildReconnectFrames`
 * replayed nothing). It owns a `@xterm/headless` `Terminal` fed the SAME raw PTY
 * bytes that are appended to `session.log`, with a `SerializeAddon` loaded so
 * `serialize()` returns the ACTUAL visible frame. We intentionally exclude the
 * headless xterm scrollback from snapshots: Codex inline/no-alt-screen output is
 * still a TUI repaint stream, so xterm scrollback is physical redraw history, not
 * a reliable linear transcript. The scrollable semantic history is served from
 * rollout JSONL via `/session-history`; this snapshot restores the live control
 * frame. The recorded `cols`/`rows` track the terminal geometry so a reconnecting
 * client of a different size can reconcile dimensions before applying it.
 *
 * `@xterm/headless`'s `write` is asynchronous internally (it parses on a
 * microtask), but `serialize()` reflects all bytes written before it is called
 * within the same synchronous turn because the parser is flushed on demand; the
 * snapshot cadence (seconds) is far slower than write bursts, so the visible
 * frame is always current by capture time.
 */
class XtermHeadlessTerminal implements HeadlessTerminal {
  private readonly term: HeadlessXterm;
  private readonly serializer: SerializeAddon;

  constructor(cols = 80, rows = 24) {
    this.term = new HeadlessXterm({
      cols,
      rows,
      // Required so the SerializeAddon can read the full buffer/styles.
      allowProposedApi: true,
      // Keep a bounded scrollback so a long-running session does not grow the
      // headless buffer without bound (the durable source is session.log).
      scrollback: 1000,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  get cols(): number {
    return this.term.cols;
  }
  set cols(value: number) {
    if (value > 0 && value !== this.term.cols) {
      this.term.resize(value, this.term.rows);
    }
  }

  get rows(): number {
    return this.term.rows;
  }
  set rows(value: number) {
    if (value > 0 && value !== this.term.rows) {
      this.term.resize(this.term.cols, value);
    }
  }

  write(data: string | Uint8Array): void {
    this.term.write(data);
  }

  /** SerializeAddon: the actual current visible frame (non-empty once fed). */
  serialize(): string {
    return this.serializer.serialize({ scrollback: 0 });
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      this.term.resize(cols, rows);
    }
  }
}

/** A node-pty handle: a pausable producer the gateway streams to clients. */
export interface TerminalPty extends AgentTerminalPty {
  /** Subscribe to raw PTY output; returns an unsubscribe handle. */
  onData(
    listener: (chunk: string, meta?: AgentTerminalOutputMeta) => void,
  ): { dispose(): void };
  /** Forward raw input bytes to the PTY (lock-gated keystroke path, 7.5). */
  write(data: string): void;
  /**
   * Resize the PTY to the given dimensions (VR.8). Called by the gateway when
   * the browser terminal is resized so the sandbox PTY cols/rows stay in sync,
   * making the "identical cols and rows" live-frame parity precondition
   * reachable at runtime.
   */
  resize(cols: number, rows: number): void;
  /**
   * Release the bridge's resources WITHOUT terminating the task
   * (survive-api-redeploy D5 / 4.3): stop the liveness poller and close the
   * outbound WS, leaving the DETACHED tmux session running. Called by
   * {@link TerminalGateway.unregisterSession} on terminal teardown so the
   * bridge's liveness poller can no longer fire a SECOND `onSessionExit` after
   * the task has already been transitioned (e.g. a deadline/idle `forceFail`
   * backstop stopped the sandbox while the poller was still armed). Optional so
   * transport-only `TerminalPty` fakes need not implement it; the
   * {@link AioPtyClient} provides it.
   */
  close?(): void;
}

/**
 * The per-task server-side terminal session the gateway streams from. It pairs
 * the live PTY (raw producer) with the snapshot manager that mirrors it for
 * reconnect. Under the connect-in model the live PTY is an {@link AioPtyClient}
 * dialed OUT into the sandbox terminal; the caller supplies concrete instances
 * and this gateway defines the shape it consumes.
 */
export interface TerminalSession {
  readonly taskId: string;
  readonly pty: TerminalPty;
  readonly snapshots: SnapshotManager;
  /** Await before settling durable admission success and releasing launch authority. */
  readonly launchDecision: Promise<AgentTerminalLaunchOutcome>;
}

export interface OpenTerminalSessionOptions {
  /** Use `attach-only` for recovery paths that must never create an agent session. */
  readonly mode?: SandboxTerminalPtyMode;
  readonly recordExit?: boolean;
  /** Cancels a fresh agent launch without affecting readoption of an existing session. */
  readonly signal?: AbortSignal;
  /**
   * Load-bearing durable-authority check executed after launch preparation and
   * immediately before the first tmux agent-launch input is sent.
   */
  readonly beforeAgentLaunch?: () => Promise<void>;
}

/**
 * What kind of peer is on the other end of a connection. Under the connect-in
 * model the only inbound peers are operator console clients; the orchestrator
 * dials sandboxes OUT via {@link AioPtyClient}, so there is no inbound runner.
 */
type ConnectionKind = 'operator';

/** Per-connected-client state held by the gateway. */
interface ClientState {
  readonly clientId: string;
  /** Operator console client (the only inbound connection kind). */
  kind: ConnectionKind;
  /** True once the connection has passed its auth/handshake gate. */
  authenticated: boolean;
  /** The task this client is streaming/serving, once it has joined one. */
  taskId: string | null;
  /** Backpressure controller for this client's view of the raw stream. */
  readonly backpressure: BackpressureController;
  /** Cumulative byte offset of raw output sent to this client. */
  sentBytes: number;
  /** Unsubscribe handle for the client's PTY data subscription, if attached. */
  ptySubscription: { dispose(): void } | null;
}

/** A blocked permission request awaiting an operator decision (6.5). */
interface PendingApproval {
  readonly taskId: string;
  /** The Codex tool name being gated (surfaced by the pending-list read, 6.5). */
  readonly toolName: string;
  /** Raw, opaque tool-call input forwarded for operator review (6.5). */
  readonly toolInput: unknown;
  /**
   * How a resolved decision is returned to the blocked hook. Under the connect-in
   * model the sandbox's `permission_request` arrives over an OUTBOUND HTTP
   * callback (re-homed in the integration track); the HTTP handler registers a
   * `reply` so `onDecision` can resolve the blocked call. It is optional so the
   * approval routing can be unit-driven without a transport attached.
   */
  readonly reply?: (frame: DecisionFrame) => void;
}

interface SessionCastState {
  readonly castPath: string;
  tail: Promise<void>;
  startMs: number;
}

interface ResizeRepaintSuppressionState {
  quietTimer?: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
}

interface CastResumeState {
  readonly hasHeader: boolean;
  readonly hasBytes: boolean;
  readonly lastTimeSec: number;
}

const RESIZE_REPAINT_QUIESCE_MS = readDurationEnv(
  'CAP_TERMINAL_RESIZE_REPAINT_QUIESCE_MS',
  300,
);
const RESIZE_REPAINT_MAX_MS = readDurationEnv(
  'CAP_TERMINAL_RESIZE_REPAINT_MAX_MS',
  2_000,
);
const CAST_RESUME_HEAD_BYTES = 4096;
const CAST_RESUME_TAIL_BYTES = 1024 * 1024;

function readDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The operator-facing projection of a {@link PendingApproval} returned by
 * {@link TerminalGateway.listPendingApprovals} (6.5). Carries the
 * correlation/identity fields the pending-list REST read surfaces (matching the
 * contracts `PendingApprovalSchema`), without the internal `reply` transport.
 */
export interface PendingApprovalView {
  readonly requestId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
}

/**
 * NestJS WebSocket gateway for the realtime terminal.
 *
 * Uses the raw `ws` adapter (not socket.io) because the protocol is a custom
 * binary-ish frame protocol, not socket.io events. The module registers the
 * `ws` `WsAdapter`; this gateway is transport-agnostic above that.
 */
@WebSocketGateway({ path: '/terminal' })
export class TerminalGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(TerminalGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Connected clients keyed by socket. */
  private readonly clients = new Map<WebSocket, ClientState>();

  /** Active terminal sessions keyed by task id. */
  private readonly sessions = new Map<string, TerminalSession>();

  /** Pending blocked approvals keyed by `requestId` (6.5). */
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  /**
   * The clientId the write lease was last GRANTED to, per task. Used to scope the
   * heartbeat self-heal: only the connection that previously held a task's lease
   * may re-acquire it once it lapses (e.g. its tab was throttled past the TTL).
   * Without this scoping a mere reader's heartbeat could acquire a lapsed-but-
   * uncontended lease and silently STEAL write access from a still-connected
   * operator — preemption the lease model forbids outside an explicit takeover.
   * A stale entry (writer long gone) is harmless: self-heal also requires the
   * lease to be free AND the clientId to match a LIVE connection, and the normal
   * grant paths overwrite it.
   */
  private readonly lastWriterClientId = new Map<string, string>();

  /**
   * Per-task `session.log` append state (D9 / 3.1). Under the connect-in model
   * there is no in-sandbox runner producer writing `session.log`; the
   * orchestrator bridge must persist raw PTY output itself. Each entry holds the
   * absolute log path and a serialized tail-promise so concurrent appends are
   * ordered (no interleaving) and the byte stream on disk matches, byte-for-byte,
   * the bytes fed to `snapshots.feed` — keeping the snapshot boundary and the
   * replayed tail aligned.
   */
  private readonly sessionLogs = new Map<
    string,
    { logPath: string; tail: Promise<void>; ensured: boolean }
  >();

  /**
   * Per-task `session.cast` (asciicast v2) append state — parallel to
   * {@link sessionLogs} but on its OWN tail chain, INDEPENDENT of the session.log
   * lockstep: a cast write failure never affects streaming. `startMs` anchors
   * event `time`. (session-terminal-replay, Track 2)
   */
  private readonly sessionCasts = new Map<
    string,
    SessionCastState
  >();

  /**
   * Resize-triggered terminal repaints are current-screen redraws, not new agent
   * output. Keep them live-only so durable history remains a linear transcript.
   */
  private readonly resizeRepaintSuppressions = new Map<
    string,
    ResizeRepaintSuppressionState
  >();

  /** Bounded per-task output used only by the selected runtime's pure classifier. */
  private readonly runtimeFailureBuffers = new Map<string, string>();
  private readonly runtimeFailureChecks = new Set<string>();
  private readonly runtimeFailuresReported = new Set<string>();
  private readonly runtimeFailureRuntimes = new Map<string, AgentRuntime>();

  private nextClientId = 1;

  /**
   * Collaborators are optional so the gateway's transport core can still be
   * constructed in isolation (e.g. transport unit tests). When the integration
   * module provides them, the auth/lease integration paths activate.
   *
   * VR.3: `guardrails` is injected optionally so the PTY-output path can call
   * `recordActivity()` to feed the IdleTracker and reclaim wedged tasks.
   */
  constructor(
    @Optional() private readonly writeLock?: WriteLockService,
    @Optional() @Inject(GuardrailsService) private readonly guardrails?: GuardrailsService,
    @Optional() @Inject(AuthSessionService) private readonly authSession?: AuthSessionService,
    // 3.2 — optional so the transport core still constructs in isolation; when the
    // module provides it the gateway resolves each task's runtime and hands it to
    // the AioPtyClient's launch/exit seams.
    @Optional() @Inject(RUNTIME_REGISTRY) private readonly runtimes?: RuntimeRegistry,
    @Optional() @Inject(PROVISION_LOOKUP) private readonly provisionLookup?: ProvisionLookup,
  ) {}

  // -------------------------------------------------------------------------
  // Session registry — the caller registers a task's session (PTY + snapshots)
  // after provisioning the sandbox and opening the AioPtyClient to its wsUrl.
  // -------------------------------------------------------------------------

  /** Register a task's terminal session so clients can stream it. */
  registerSession(session: TerminalSession): void {
    this.sessions.set(session.taskId, session);
  }

  /** Remove a task's terminal session (e.g. on completion/teardown). */
  /**
   * Sample the tail of a task's API-side `session.log` for the failure-detail
   * audit (record-task-failure-reason). Delegates to the pure snapshot helper;
   * the file lives on the API-side workspace volume, so it is readable even after
   * the sandbox is torn down. Best-effort: returns `''` on any error.
   */
  async readSessionLogTail(taskId: string): Promise<string> {
    // A WS close can race the final queued append. Classification needs the
    // decisive last chunk, so observe the per-task append chain before sampling.
    await this.flushSessionLog(taskId);
    return readSessionLogTail(resolveWorkspaceDir(taskId));
  }

  unregisterSession(taskId: string): void {
    const session = this.sessions.get(taskId);
    // 4.3 — release the bridge BEFORE dropping the session so a re-adopted (or
    // freshly-launched) task that ends drives the normal `onTerminal`/`recordExit`
    // path EXACTLY ONCE. `unregisterSession` is only reached from a TERMINAL
    // teardown (`onTerminal` after a clean exit, or a `forceFail` backstop after a
    // deadline/idle/circuit trip), at which point the task is already transitioned.
    // Closing the `AioPtyClient` here stops its liveness poller + outbound WS, so a
    // poller that is still armed (a `forceFail` stopped the sandbox while the WS was
    // attached) cannot observe the now-gone session and fire a SECOND
    // `onSessionExit` → `recordExit`. `close()` is the D5 release-without-terminate
    // path: it never resolves an exit, so it is safe to call after the transition.
    // Idempotent: the bridge guards its own teardown; a missing `close` (transport
    // fake) is a no-op.
    session?.pty.close?.();
    this.sessions.delete(taskId);
    // Drop the session.log append state; the file itself persists on the volume
    // for post-mortem / restart reconnect (multi-target-deploy persistent volume).
    this.sessionLogs.delete(taskId);
    // session-terminal-replay — drop the cast append state too (the session.cast
    // file persists on the volume for replay, like session.log).
    this.sessionCasts.delete(taskId);
    this.runtimeFailureBuffers.delete(taskId);
    this.runtimeFailureChecks.delete(taskId);
    this.runtimeFailuresReported.delete(taskId);
    this.runtimeFailureRuntimes.delete(taskId);
    this.endResizeRepaintSuppression(taskId);
    // An unregistered task will never legitimately reclaim its old lease, so drop
    // its last-writer record too (bounds the map to live tasks; harmless either
    // way since a stale id can never match a future monotonic clientId).
    this.lastWriterClientId.delete(taskId);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * A new socket connected. The second argument is the raw HTTP upgrade request
   * (`ws` forwards it via NestJS's `WsAdapter`), from which we read the operator
   * credentials.
   *
   * Under the connect-in model the only inbound peer is an OPERATOR console
   * client; the orchestrator dials sandboxes OUT via {@link AioPtyClient}, so
   * there is no inbound runner dial-back to handshake. The operator is
   * authenticated at connect time against a human SESSION, resolved from the URL
   * `token` query param or
   * the `bearer.<token>` subprotocol (browsers cannot set an `Authorization`
   * header on a WS handshake). The session resolver RE-CONFIRMS the DB allowed
   * gate, so an expired/revoked/disabled session fails. The legacy
   * shared `AUTH_TOKEN` is accepted on this same channel ONLY when
   * `AUTH_TOKEN_LEGACY_ENABLED` is on (task 2.8). An unauthenticated/invalid
   * operator connection is closed immediately, BEFORE it can join any task stream
   * or be sent any bytes/control frames.
   *
   * Operator authentication is async (the session is resolved against the store),
   * so the connection starts `authenticated: false`; the message handler is
   * attached immediately but every operator frame is gated on `authenticated`
   * (see {@link handleControlFrame}) so nothing is acted on until auth resolves.
   */
  handleConnection(client: WebSocket, request?: IncomingMessage): void {
    const clientId = `c${this.nextClientId++}`;
    const url = this.parseUrl(request);

    const state: ClientState = {
      clientId,
      kind: 'operator',
      authenticated: false,
      taskId: null,
      backpressure: new BackpressureController(),
      sentBytes: 0,
      ptySubscription: null,
    };
    this.clients.set(client, state);

    // The contracts frame protocol (`channel`/`type`) does not match the `ws`
    // adapter's default `{event,data}` routing, so we consume raw messages
    // directly off the socket and discriminate them ourselves. Attached BEFORE
    // async operator auth resolves; operator frames are dropped until then.
    client.on('message', (data: RawData) => this.handleMessage(data, client));

    // 2.7 — connect-time operator SESSION authentication. Reject (close) before
    // the connection can join any task stream when no valid principal resolves
    // (missing/expired/revoked/disabled session, or — with the legacy path
    // off — a bare `AUTH_TOKEN`). Auth is async (the session is resolved against
    // the store), so the connection stays `authenticated: false` until it lands.
    const presented = extractWsOperatorToken({
      queryToken: url?.searchParams.get('token') ?? null,
      subprotocols: this.subprotocols(request),
    });
    // Browser clients authenticate via the httpOnly `cap_session` cookie the
    // browser auto-attaches to the cross-site wss upgrade (SameSite=None+Secure),
    // exactly like REST. The query/subprotocol `token` stays the legacy/non-browser
    // channel. Reading BOTH here is what lets the WS surface accept the same
    // session cookie the REST AuthGuard does — it previously read NEITHER cookie,
    // so a browser (empty VITE_AUTH_TOKEN) always failed with 1008.
    const cookieToken = readCookie(request?.headers?.cookie, SESSION_COOKIE_NAME);
    void this.authenticateOperator({ cookieToken, presentedToken: presented }).then((ok) => {
      if (!this.clients.has(client)) return; // disconnected mid-resolution
      if (!ok) {
        this.logger.warn(`client ${clientId}: operator auth failed; closing`);
        this.closeUnauthenticated(client);
        return;
      }
      state.authenticated = true;
      // Associate the operator with the task it asked to stream, if any.
      const taskId = url?.searchParams.get('taskId') ?? null;
      if (taskId) state.taskId = taskId;
      // 7.1 — auto-grant the write lease the instant auth resolves (when free),
      // so operator keystrokes reach the PTY without a client-driven takeover
      // RACING this async auth resolution (a fixed client retry window could be
      // fully consumed before auth lands on a cold/contended session store,
      // leaving the terminal permanently read-only). See grantWriteLeaseIfFree.
      this.grantWriteLeaseIfFree(state);
      this.logger.debug(`client ${clientId} authenticated as operator`);
    });

    this.logger.debug(`client ${clientId} connected as ${state.kind}`);
  }

  handleDisconnect(client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state) return;
    // Detach from the PTY and clear any backpressure pause this client owned so
    // a wedged pause cannot outlive the client that caused it.
    state.ptySubscription?.dispose();
    state.backpressure.reset();
    // Remove the client BEFORE the lease handoff so the re-grant below never
    // picks the disconnecting socket and broadcastLeaseState never targets it.
    this.clients.delete(client);

    // 7.3 — auto-release the write lease immediately on writer disconnect, then
    // hand it to a still-connected operator on the SAME task (if any). This is
    // what makes a sole operator's RELOAD safe: the new connection's connect-time
    // auto-grant can race ahead of this close and find the lease still held by the
    // OLD connection (so it skips the grant); when the old socket finally closes
    // here, the freed lease is immediately re-granted to that remaining new
    // connection instead of being left free with the only operator holding
    // nothing (which left the terminal permanently read-only).
    if (state.taskId && this.writeLock) {
      const released = this.writeLock.releaseOnDisconnect(state.taskId, state.clientId);
      if (released) {
        this.regrantWriteLeaseToRemaining(state.taskId);
        this.broadcastLeaseState(state.taskId);
      }
    }

    this.logger.debug(`client ${state.clientId} disconnected`);
  }

  // -------------------------------------------------------------------------
  // Inbound message handling — dual-channel discrimination (5.1)
  // -------------------------------------------------------------------------

  /**
   * Every inbound text message is a JSON frame. We discriminate strictly on the
   * top-level `channel` tag: a `"raw"` frame is opaque client input and is NEVER
   * parsed as a control frame; a `"control"` frame is validated against
   * `ControlFrameSchema` before it is acted on. Anything that fails validation
   * is dropped (never coerced into a control action).
   */
  handleMessage(payload: unknown, client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state) return;

    const frame = this.parseFrame(payload);
    if (!frame) return;

    if (frame.channel === FRAME_CHANNEL.RAW) {
      // Raw channel: opaque bytes — never interpreted as a control frame. An
      // inbound raw frame from an OPERATOR is not the keystroke path (that is the
      // lock-gated `keystroke` control frame, 7.5); operator raw frames are
      // dropped. Under the connect-in model sandbox PTY output arrives OUT-of-band
      // via {@link AioPtyClient}'s onData, not as an inbound raw frame, so there
      // is no inbound producer raw-frame path here.
      return;
    }

    // Control channel: strictly validated against the contracts schema.
    const result = ControlFrameSchema.safeParse(frame);
    if (!result.success) {
      this.logger.warn(
        `client ${state.clientId}: invalid control frame dropped`,
      );
      return;
    }
    this.handleControlFrame(result.data, client, state);
  }

  /**
   * Parse an inbound payload into a frame and read ONLY its `channel`
   * discriminant. Returns null (drop) for anything that is not a frame object
   * with a valid `channel` tag — a malformed raw payload can therefore never be
   * mistaken for a control frame.
   */
  private parseFrame(payload: unknown): { channel: string } | null {
    // Normalize any `ws` RawData shape (string | Buffer | ArrayBuffer |
    // Buffer[]) to a UTF-8 string, then parse JSON. Non-JSON payloads are
    // dropped — they can never be coerced into a control frame.
    const text = toUtf8(payload);
    if (text === null) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
    if (
      typeof obj !== 'object' ||
      obj === null ||
      !('channel' in obj) ||
      typeof (obj as { channel: unknown }).channel !== 'string'
    ) {
      return null;
    }
    const channel = (obj as { channel: string }).channel;
    if (channel !== FRAME_CHANNEL.RAW && channel !== FRAME_CHANNEL.CONTROL) {
      return null;
    }
    return obj as { channel: string };
  }

  /**
   * Dispatch a validated control frame. The transport core owns the flow-control
   * (`ack`) and reconnect (`reconnect`) frames; the integration track owns the
   * keystroke/heartbeat/takeover (7.5) and approval round-trip frames (6.5).
   *
   * Under the connect-in model the only inbound peer is an OPERATOR console
   * client; the orchestrator dials sandboxes OUT via {@link AioPtyClient}, so
   * there is no inbound runner dial-back handshake. Because operator SESSION auth
   * is async (resolved against the store, 2.7), a connection may receive frames
   * before `authenticated` is set: until it authenticates the only frame acted on
   * is `connect_auth`, so no task-stream action runs and no bytes/control frames
   * are emitted to an unauthenticated connection.
   */
  private handleControlFrame(
    frame: ControlFrame,
    client: WebSocket,
    state: ClientState,
  ): void {
    // 2.7 — operator auth gate: an operator connection whose connect-time session
    // auth has not (yet) succeeded may only (re)assert auth via a `connect_auth`
    // frame. Any other frame before authentication is dropped, so no task-stream
    // action runs and no bytes/control frames are emitted until it authenticates.
    if (!state.authenticated) {
      if (frame.type === 'connect_auth') {
        void this.onConnectAuth(frame, client, state);
      } else {
        this.logger.warn(
          `operator ${state.clientId}: frame before auth dropped`,
        );
      }
      return;
    }

    switch (frame.type) {
      case 'ack':
        this.onAck(frame, client, state);
        break;
      case 'reconnect':
        void this.onReconnect(frame, client, state);
        break;
      case 'connect_auth':
        void this.onConnectAuth(frame, client, state);
        break;
      case 'keystroke':
        this.onKeystroke(frame, client, state);
        break;
      case 'heartbeat':
        this.onHeartbeat(frame, client, state);
        break;
      case 'takeover_request':
        this.onTakeover(frame, client, state);
        break;
      // `permission_request` is no longer accepted as an inbound control frame:
      // under the connect-in model the sandbox hook delivers it over an OUTBOUND
      // HTTP callback (re-homed in the integration track), which calls
      // `onPermissionRequest` directly. An operator client cannot inject one.
      case 'decision':
        this.onDecision(frame, client, state);
        break;
      case 'resize':
        this.onResize(frame, state);
        break;
      default:
        // Unhandled-but-valid frames (e.g. server->client only) are inert.
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Operator connect-time SESSION authentication
  // -------------------------------------------------------------------------

  /**
   * Resolves a presented operator credential to a valid principal at connect
   * time. The credential is treated FIRST as a session token (resolved via
   * {@link AuthSessionService}, which RE-CONFIRMS DB allowed state so
   * expired/revoked/disabled sessions fail) and, only when the session does not
   * resolve, as the legacy shared
   * `AUTH_TOKEN` operator bearer — accepted in CONSTANT TIME and ONLY when
   * `AUTH_TOKEN_LEGACY_ENABLED` is on (task 2.8).
   *
   * Returns `false` for a missing credential, an unresolved session, or a legacy
   * bearer while the legacy path is disabled (fail-closed). A sandbox `TASK_TOKEN`
   * presented here is neither a valid session nor the configured `AUTH_TOKEN`, so
   * it fails — there is no special case that admits it as an operator.
   *
   * When {@link AuthSessionService} is not provided (transport-only unit
   * construction), no session can resolve; only the gated legacy path remains.
   */
  private async authenticateOperator(args: {
    cookieToken: string | null;
    presentedToken: string | null;
  }): Promise<boolean> {
    const { cookieToken, presentedToken } = args;
    // Keep the two credentials on their CORRECT trust domains (unlike the old
    // single-string handling): the browser's `cap_session` COOKIE is a session
    // token; the query/subprotocol `token` is the legacy/non-browser channel
    // (also tried as a session token for non-browser session clients). Cookie
    // takes precedence as the session candidate. Both route through the shared
    // {@link resolveOperatorPrincipal} so the WS surface cannot drift from REST
    // on the session re-check or the constant-time legacy `AUTH_TOKEN` compare.
    const sessionToken = cookieToken ?? presentedToken;
    const bearerToken = presentedToken;
    if (sessionToken === null && bearerToken === null) return false;
    const credentials = { sessionToken, bearerToken };
    // Route through the shared resolver so the WS surface cannot drift from REST
    // on prefix dispatch (cap_sk_ api-key / reserved mcp_), the session re-check,
    // or the constant-time legacy AUTH_TOKEN compare. The same single presented
    // token fills both candidate slots; prefix dispatch (the FIRST step) ensures a
    // cap_sk_/mcp_ token here never falls into a Session lookup.
    const principal = await resolveOperatorPrincipal(credentials, {
      resolveSession: (token) =>
        this.authSession ? this.authSession.resolveSession(token) : Promise.resolve(null),
      resolveApiKey: (raw) =>
        this.authSession ? this.authSession.resolveApiKey(raw) : Promise.resolve(null),
      // No MCP resolver bound: the `mcp_` slot fails closed (denyMcpResolver).
    });
    return principal !== null;
  }

  /**
   * A client may (re)assert operator auth via an explicit `connect_auth` frame
   * (e.g. a non-browser client, or to re-confirm after connect). An operator
   * already authenticated is only updated (its claimed `taskId`); an
   * unauthenticated connection presenting a valid session (or, when enabled, the
   * legacy bearer) is promoted to an authenticated operator. An invalid
   * credential closes the connection before it joins any task stream.
   */
  private async onConnectAuth(
    frame: ConnectAuthFrame,
    client: WebSocket,
    state: ClientState,
  ): Promise<void> {
    if (state.authenticated) {
      if (frame.taskId) state.taskId = frame.taskId;
      return;
    }
    // connect_auth carries the token explicitly in the frame (no cookie context).
    const ok = await this.authenticateOperator({
      cookieToken: null,
      presentedToken: frame.token,
    });
    if (!this.clients.has(client)) return; // disconnected mid-resolution
    if (!ok) {
      this.closeUnauthenticated(client);
      return;
    }
    state.authenticated = true;
    if (frame.taskId) state.taskId = frame.taskId;
    // Mirror the connect-time auto-grant on the explicit connect_auth path so a
    // non-browser/re-asserting client also gets the lease when it is free.
    this.grantWriteLeaseIfFree(state);
  }

  // -------------------------------------------------------------------------
  // Connect-in session open — handle-driven session registration seam.
  // -------------------------------------------------------------------------

  /**
   * Open a task's terminal session under the connect-in model. The caller
   * (`GuardrailsService.startRunning`, which resolves this gateway lazily by
   * `TERMINAL_GATEWAY_TOKEN` and calls `openSession` after `provision()`, 4.2)
   * hands the {@link SandboxConnection} returned by `provision()`; this gateway
   * dials the sandbox terminal OUT by constructing an {@link AioPtyClient} to
   * `connection.wsUrl` and registers a {@link TerminalSession} so reconnecting
   * operator clients get the snapshot + tail-replay path.
   *
   * The SnapshotManager is backed by a REAL {@link XtermHeadlessTerminal} (D9) so
   * periodic snapshots carry the actual visible frame, alongside byte-offset
   * tracking + tail-replay. Idempotent for an already-open task.
   *
   * Create-vs-attach (survive-api-redeploy D2 / 2.5): the {@link AioPtyClient} is
   * opened in `'launch-or-attach'` mode, so once the AIO shell is `ready` it probes
   * whether the detached session `task<taskId>` is already alive — ATTACHING to a
   * still-running codex (operator reconnect / freshly-booted api re-adoption) or
   * launching a FRESH detached session as the fallback. This single seam serves
   * both first launch and re-adoption.
   *
   * Exit detection (D4): a WS close NO LONGER terminates the task — it only
   * detaches; the detached codex keeps running for re-adoption. The `AioPtyClient`
   * polls the named session's liveness and invokes the gateway's `onSessionExit`
   * hook ONLY when the session is observed GONE, so the guardrails mapping
   * (zero → `recordSuccess`, non-zero/abnormal → `recordFailure`) is applied at the
   * true termination, not on an operator disconnect or an api restart.
   *
   * @returns the registered {@link TerminalSession}, so the caller can hold the
   *          handle if needed.
   */
  openSession(
    connection: SandboxConnection,
    selectedRun?: SelectedSandboxRun | null,
    options: OpenTerminalSessionOptions = {},
  ): TerminalSession {
    const { taskId } = connection;
    const existing = this.sessions.get(taskId);
    if (existing) return existing;

    const workspaceDir = resolveWorkspaceDir(taskId);
    // D9 — back the SnapshotManager with a REAL xterm headless terminal so
    // periodic snapshots carry the actual visible frame (the prior
    // NullHeadlessTerminal serialized to empty, leaving reconnect with nothing).
    const headless = new XtermHeadlessTerminal();
    const snapshots = new SnapshotManager(headless, workspaceDir, {
      initialOffset: readSessionLogSize(workspaceDir),
    });
    const pty = openSandboxTerminalPty({
      connection,
      selectedRun,
      onExit:
        options.recordExit === false
          ? undefined
          : (status) => this.onSessionExit(taskId, status),
      mode: options.mode ?? 'launch-or-attach',
      signal: options.signal,
      beforeAgentLaunch: options.beforeAgentLaunch,
      resolveTaskLaunchContext: () =>
        this.resolveTaskLaunchContext(taskId, selectedRun),
      onRuntimeSetupFailure: (code) => {
        void this.guardrails?.failRuntime(taskId, code, null, false);
      },
    });
    const session: TerminalSession = {
      taskId,
      pty,
      snapshots,
      launchDecision: pty.launchDecision,
    };
    this.registerSession(session);
    // 3.1 — register the per-task session.log append target. The path MUST match
    // the one SnapshotManager reads for tail-replay (workspaceDir/session.log) so
    // the persisted bytes are exactly what reconnect replays after a snapshot.
    if (!this.sessionLogs.has(taskId)) {
      this.sessionLogs.set(taskId, {
        logPath: path.join(workspaceDir, SESSION_LOG_FILENAME),
        tail: Promise.resolve(),
        ensured: false,
      });
    }
    // session-terminal-replay — begin the asciicast recording alongside
    // session.log (independent tail chain; best-effort, never blocks streaming).
    this.initCast(
      taskId,
      workspaceDir,
      session.snapshots.cols,
      session.snapshots.rows,
    );
    // Feed live PTY output into the SnapshotManager + fan it out to operators
    // who have not yet reconnected/attached (VR.10). Operators that have called
    // attachPty receive the same bytes through their own ptySubscription.
    pty.onData((chunk, meta) => this.onPtyOutput(taskId, chunk, meta));
    snapshots.start();
    this.logger.debug(`task ${taskId}: opened sandbox terminal session`);
    return session;
  }

  private async resolveTaskLaunchContext(
    taskId: string,
    selectedRun?: SelectedSandboxRun | null,
  ): Promise<AioResolvedTaskLaunchContext> {
    if (!this.provisionLookup || !this.runtimes) {
      throw new SandboxRuntimeModelSetupError('launch-context');
    }
    let launch: TaskLaunchContext;
    try {
      launch = await this.provisionLookup.getTaskLaunchContext(taskId);
    } catch (error) {
      if (error instanceof SandboxRuntimeModelSetupError) throw error;
      throw new SandboxRuntimeModelSetupError('lookup');
    }
    this.assertSelectedRunMatchesLaunchContext(launch, selectedRun);
    try {
      return {
        runtime: this.runtimes.resolve(launch.runtimeId),
        executionMode: launch.executionMode,
        modelIntent: launch.modelIntent,
      };
    } catch {
      throw new SandboxRuntimeModelSetupError('runtime-resolution');
    }
  }

  private assertSelectedRunMatchesLaunchContext(
    launch: TaskLaunchContext,
    selectedRun?: SelectedSandboxRun | null,
  ): void {
    if (launch.modelIntent.kind === 'runtime-default') return;
    const actual = selectedRun?.environment;
    const expected = launch.environment;
    if (
      !selectedRun ||
      !actual ||
      !expected ||
      selectedRun.providerId !== expected.providerId ||
      actual.providerId !== expected.providerId ||
      actual.providerFamily !== expected.providerFamily ||
      actual.runtimeId !== expected.runtimeId ||
      actual.sourceKind !== expected.sourceKind ||
      actual.sourceRef !== expected.sourceRef ||
      actual.digest !== expected.digest ||
      actual.checksum !== expected.checksum ||
      actual.cliArtifactChecksum !== expected.cliArtifactChecksum ||
      actual.validationId !== expected.validationId ||
      actual.validationVersion !== expected.validationVersion ||
      actual.contractVersion !== expected.contractVersion ||
      stableJson(actual.runtimeArtifactChecksums ?? null) !==
        stableJson(expected.runtimeArtifactChecksums ?? null) ||
      actual.metadata?.immutableIdentity !==
        expected.metadata?.immutableIdentity ||
      actual.metadata?.fingerprint !== expected.metadata?.fingerprint ||
      actual.metadata?.sandboxMetadataChecksum !==
        expected.metadata?.sandboxMetadataChecksum ||
      actual.metadata?.cliVersion !== expected.metadata?.cliVersion ||
      stableJson(actual.metadata?.sandboxMetadata ?? null) !==
        stableJson(expected.metadata?.sandboxMetadata ?? null)
    ) {
      throw new SandboxRuntimeModelSetupError('snapshot');
    }
  }

  /**
   * Resolve a task's selected {@link AgentRuntime} via the injected
   * {@link RuntimeRegistry} (3.2). Best-effort + never throws: a missing registry
   * (transport-only unit context), a registry without `resolveForTask`, or a
   * rejected promise all resolve to `undefined`, which the {@link AioPtyClient}
   * treats as the DEFAULT codex inline path — so a runtime-resolution hiccup can
   * never strand a codex task. Threaded as the bridge's runtime resolver so the
   * (async) per-task `runtime`-column lookup happens off the synchronous
   * {@link openSession} path, only when the AIO shell is `ready`.
   */
  private async resolveRuntimeForTask(
    taskId: string,
  ): Promise<AgentRuntime | undefined> {
    try {
      return (await this.runtimes?.resolveForTask?.(taskId)) ?? undefined;
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: could not resolve AgentRuntime for terminal launch (defaulting to codex): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Resolve a task's execution mode via the injected {@link RuntimeRegistry}
   * (add-headless-execution-track). Best-effort + never throws: a missing registry, a
   * registry without the method, or a rejected promise all resolve to `interactive-pty`,
   * so a console task is never accidentally launched headless and a resolution hiccup
   * never strands a programmatic task in the wrong launch mode.
   */
  private async resolveExecutionModeForTask(
    taskId: string,
  ): Promise<ExecutionMode> {
    try {
      return (
        (await this.runtimes?.getTaskExecutionMode?.(taskId)) ?? 'interactive-pty'
      );
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: could not resolve execution mode for terminal launch (defaulting to interactive-pty): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'interactive-pty';
    }
  }

  /**
   * Invoked when an {@link AioPtyClient} resolves a task's exit status because its
   * detached named tmux session was observed GONE by the liveness poller (D4) —
   * NOT on a mere WS close (an operator disconnect / api restart leaves the session
   * alive for re-adoption and never reaches here). Applies the guardrails outcome
   * mapping (4.3): a ZERO exit maps to `recordSuccess`, a NON-ZERO/unresolved/
   * abnormal exit maps to `recordFailure`. The {@link AioExitStatus} the bridge
   * resolves is structurally compatible with the guardrails `ExitStatus`, so it is
   * passed straight through to `recordExit`, which owns the zero/non-zero rule.
   */
  protected onSessionExit(
    taskId: string,
    status: SandboxTerminalExitStatus,
  ): void {
    this.logger.debug(
      `task ${taskId}: terminal session exited (code=${status.code}, abnormal=${status.abnormal})`,
    );
    // 4.3 — map the resolved remote exit signal to the start/turn circuit-breaker
    // outcome. `recordExit` applies the zero→success / non-zero|abnormal→failure
    // rule; `onTerminal`/`forceFail`/teardown are unaffected.
    this.guardrails?.recordExit(taskId, status);
  }

  // -------------------------------------------------------------------------
  // 7.5 — lock-gated keystrokes + lease management
  // -------------------------------------------------------------------------

  /**
   * Forward raw keystroke input to the task's PTY ONLY when the sending client
   * holds the write lease (7.5). A reader's keystroke is silently dropped — it is
   * NOT an approval and never reaches the PTY. Lease state is owned by the
   * write-lock service.
   */
  private onKeystroke(
    frame: KeystrokeFrame,
    _client: WebSocket,
    state: ClientState,
  ): void {
    if (!state.authenticated || state.kind !== 'operator') return;
    if (!this.writeLock) return;
    // Gate: only the lease holder may forward raw input to the PTY.
    if (!this.writeLock.isWriter(frame.sessionId, state.clientId)) {
      return;
    }
    const session = this.sessions.get(frame.sessionId);
    if (!session) return;
    const input = Buffer.from(frame.data, 'base64').toString('utf8');
    // A real operator keystroke is a hard boundary after a resize repaint: any
    // subsequent PTY output is user/agent activity and must re-enter durable
    // history so a refresh/reconnect cannot skip it.
    if (input.length > 0) {
      this.endResizeRepaintSuppression(frame.sessionId);
    }
    session.pty.write(input);
    // VR.3 — operator input is activity: reset the idle window so an operator
    // actively driving codex keeps the task alive even between codex outputs.
    this.guardrails?.recordActivity(frame.sessionId);
  }

  /** Renew the write lease for a heartbeat from the current holder (7.2). */
  private onHeartbeat(
    frame: HeartbeatFrame,
    _client: WebSocket,
    state: ClientState,
  ): void {
    if (!state.authenticated) return;
    // VR.3 — an operator heartbeat means a human is ATTENDING this task. Reset the
    // idle window so an operator-driven session (codex idling at its composer,
    // waiting for the next instruction and therefore producing NO PTY output) is
    // not force-failed as "idle" while someone is watching it. Closing the session
    // tab stops the heartbeat, so a genuinely abandoned task still reclaims after
    // `maxIdleMs`. Runs before the writeLock guard so attendance counts even for a
    // reader connection.
    this.guardrails?.recordActivity(frame.sessionId);
    if (!this.writeLock) return;
    this.writeLock.heartbeat(frame.sessionId, state.clientId);
    // Self-heal, SCOPED to the prior holder: if the lease is FREE after the
    // heartbeat (this connection's own lease expired while its tab was throttled
    // past the TTL) AND this connection was the last grantee, re-acquire it so a
    // throttled operator recovers write access without a page reload. The
    // `lastWriterClientId` gate is essential — without it ANY reader's heartbeat
    // could acquire a lapsed-but-uncontended lease and silently STEAL write
    // access from a still-connected operator (preemption the model forbids
    // outside an explicit takeover). `getLease` non-null also short-circuits, so
    // a LIVE holder is never preempted.
    if (
      !this.writeLock.getLease(frame.sessionId) &&
      this.lastWriterClientId.get(frame.sessionId) === state.clientId
    ) {
      this.writeLock.acquire(frame.sessionId, state.clientId);
    }
    this.broadcastLeaseState(frame.sessionId);
  }

  /**
   * Preemptive takeover (7.4): a reader seizes the lease, demoting the prior
   * holder. The lock-independent approval path is unaffected by lease ownership.
   */
  private onTakeover(
    frame: TakeoverRequestFrame,
    _client: WebSocket,
    state: ClientState,
  ): void {
    if (!state.authenticated || !this.writeLock) return;
    this.writeLock.takeover(frame.sessionId, state.clientId);
    this.lastWriterClientId.set(frame.sessionId, state.clientId);
    this.broadcastLeaseState(frame.sessionId);
  }

  /**
   * Acquire (or renew) the lease for a session on behalf of an operator client,
   * exposed for an explicit acquire path. Broadcasts the resulting lease state.
   */
  acquireLease(sessionId: string, client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state || !state.authenticated || !this.writeLock) return;
    this.writeLock.acquire(sessionId, state.clientId);
    this.lastWriterClientId.set(sessionId, state.clientId);
    this.broadcastLeaseState(sessionId);
  }

  /**
   * After a writer disconnects and its lease is released, hand the now-free lease
   * to a still-connected authenticated operator on the same task (if any), so a
   * sole operator that RELOADED — whose new connection raced ahead of the old
   * socket's close and skipped its connect-time auto-grant — is promoted to
   * writer immediately rather than being left read-only with a free lease. No-op
   * when the lease is somehow already re-held or no operator remains.
   */
  private regrantWriteLeaseToRemaining(taskId: string): void {
    if (!this.writeLock) return;
    if (this.writeLock.getLease(taskId)) return; // already re-held
    for (const state of this.clients.values()) {
      if (state.kind === 'operator' && state.authenticated && state.taskId === taskId) {
        this.writeLock.acquire(taskId, state.clientId);
        this.lastWriterClientId.set(taskId, state.clientId);
        return;
      }
    }
  }

  /**
   * Auto-grant the write lease to an operator the moment its connect-time auth
   * resolves, WHEN the lease is free (7.1 `acquire` — non-preemptive). This is
   * what lets operator keystrokes reach the PTY without a client-driven takeover
   * handshake racing the async auth: the grant happens server-side exactly when
   * `state.authenticated` flips, then broadcasts a `lease_state` so the client
   * captures the sessionId and enables input. A second operator on the same task
   * finds a LIVE lease and stays a reader — no preemption (explicit takeover is
   * the only way to seize a held lease). The lease is keyed by this connection's
   * server-assigned `clientId`, the same id the keystroke gate checks, so the
   * grant and the gate cannot drift.
   */
  private grantWriteLeaseIfFree(state: ClientState): void {
    const taskId = state.taskId;
    if (!taskId || !this.writeLock) return;
    if (this.writeLock.getLease(taskId)) return; // a live writer already holds it
    this.writeLock.acquire(taskId, state.clientId);
    this.lastWriterClientId.set(taskId, state.clientId);
    this.broadcastLeaseState(taskId);
  }

  /** Broadcast the current lease for a session to operators watching it. */
  private broadcastLeaseState(sessionId: string): void {
    if (!this.writeLock) return;
    const lease = this.writeLock.getLease(sessionId);
    const frame: ControlFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'lease_state',
      sessionId,
      lease: lease ? { ...lease } : null,
    };
    for (const [socket, state] of this.clients) {
      // Fan a session's lease state ONLY to operators actually watching THAT
      // session (or not yet joined to any). Without this taskId filter a
      // heartbeat/takeover on task B would push a lease_state(sessionId=B) down a
      // socket joined to task A, corrupting that client's sessionId binding and
      // silently routing its keystrokes to the wrong session.
      if (
        state.kind === 'operator' &&
        state.authenticated &&
        (state.taskId === null || state.taskId === sessionId)
      ) {
        this.send(socket, frame);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6.5 — event ingestion + approval routing
  // -------------------------------------------------------------------------

  /**
   * Route a blocking `permission_request` to the operator approval surface: fan
   * the request out to every authenticated operator client for the claimed task
   * (the lock-INDEPENDENT approval surface, D7), and record a `reply` transport
   * so the resolved `decision` can be returned to the blocked hook by `requestId`.
   *
   * Under the connect-in model the sandbox's hook delivers this over an OUTBOUND
   * HTTP callback (re-homed in the integration track), and the HTTP handler
   * passes the `reply` used to unblock the hook. The approval routing/semantics
   * above the transport are unchanged. Notification-adapter round-trips, when
   * wired, also consume this same pending entry.
   */
  onPermissionRequest(
    frame: PermissionRequestFrame,
    reply?: (decision: DecisionFrame) => void,
  ): void {
    this.pendingApprovals.set(frame.requestId, {
      taskId: frame.taskId,
      // Identity fields surfaced by the session-gated pending-list REST read
      // (be-audit-approvals 6.5; consumed via {@link listPendingApprovals}).
      toolName: frame.toolName,
      toolInput: frame.toolInput,
      // Connect-in reply transport: the OUTBOUND-HTTP-callback handler registers
      // this so `onDecision` can unblock the hook by `requestId` correlation.
      reply,
    });
    // VR.3 — a hook event counts as activity; reset the idle window so the
    // task is not force-failed while it is actively waiting for a decision.
    if (this.guardrails) {
      this.guardrails.recordActivity(frame.taskId);
    }
    // Fan out to operators streaming this task so any of them can decide.
    for (const [socket, s] of this.clients) {
      if (
        s.kind === 'operator' &&
        s.authenticated &&
        (s.taskId === null || s.taskId === frame.taskId)
      ) {
        this.send(socket, frame);
      }
    }
  }

  /**
   * Connect-in approval entry point for the OUTBOUND HTTP callback (5.5). The
   * sandbox's blocking Codex hook POSTs its `permission_request` to the
   * orchestrator approvals endpoint (over `cap-net`); the approvals controller
   * calls this, which routes the request through the SAME `onPermissionRequest`
   * fan-out + `onDecision` resolution path the WS transport used, and resolves
   * with the operator's {@link DecisionFrame} once a decision arrives. Only the
   * transport differs — the approval semantics above it are unchanged.
   *
   * The returned promise resolves when an operator decides (via `onDecision`,
   * which fires the `reply` registered here). It never rejects: a timeout is the
   * caller's concern (the hook fails closed on no/invalid response).
   */
  requestApproval(frame: PermissionRequestFrame): Promise<DecisionFrame> {
    return new Promise<DecisionFrame>((resolve) => {
      this.onPermissionRequest(frame, resolve);
    });
  }

  /**
   * Connect-in non-blocking `PostToolUse` report entry point for the OUTBOUND
   * HTTP callback (5.5). The sandbox's post-tool-use hook POSTs its file-edit
   * report to the approvals endpoint; this records it as task activity (so a
   * task actively editing files is not force-failed as idle) and returns. It is
   * post-hoc only — it never gates, blocks, or reverses the executed command.
   */
  reportPostToolUse(frame: PostToolUseReportFrame): void {
    // VR.3 — a tool-use report counts as activity; reset the idle window.
    if (this.guardrails) {
      this.guardrails.recordActivity(frame.taskId);
    }
  }

  /**
   * An operator submitted a one-shot approval `decision`. This is accepted
   * INDEPENDENTLY of the write lease (7.5 / D7): any authenticated operator may
   * decide even without holding the keyboard. The decision is correlated by
   * `requestId` and returned to the blocked hook via the pending `reply`
   * transport (6.5); the hook then unblocks and prints the decision to Codex.
   */
  private onDecision(
    frame: DecisionFrame,
    _client: WebSocket,
    state: ClientState,
  ): void {
    // Lock-INDEPENDENT: no lease check here. Only require an authenticated
    // operator so a non-operator cannot inject its own decision.
    if (state.kind !== 'operator' || !state.authenticated) return;

    const pending = this.pendingApprovals.get(frame.requestId);
    if (!pending) return;
    this.pendingApprovals.delete(frame.requestId);

    // Return the resolved decision to the blocked hook over its reply transport.
    pending.reply?.(frame);
    // Tell operators the request is resolved so duplicate surfaces clear.
    for (const [socket, s] of this.clients) {
      if (s.kind === 'operator' && s.authenticated) {
        this.send(socket, frame);
      }
    }
  }

  /**
   * Read-only snapshot of the pending `PermissionRequest` decisions currently
   * awaiting an operator (be-audit-approvals 6.5). Exposed for the session-gated
   * pending-list REST endpoint: it projects each in-flight blocked approval to its
   * correlation/identity fields, dropping the internal `reply` transport. The
   * returned array is a fresh copy, so a caller can never mutate the gateway's
   * live `pendingApprovals` map.
   */
  listPendingApprovals(): PendingApprovalView[] {
    const out: PendingApprovalView[] = [];
    for (const [requestId, approval] of this.pendingApprovals) {
      out.push({
        requestId,
        taskId: approval.taskId,
        toolName: approval.toolName,
        toolInput: approval.toolInput,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // ACK protocol + backpressure (5.2 / 5.3)
  // -------------------------------------------------------------------------

  /**
   * Consume a client `ack`: advance the drained-output counter and, if the
   * drain crossed the low-water mark while paused, resume the PTY and tell the
   * client with an explicit `resume` control frame.
   */
  private onAck(frame: AckFrame, client: WebSocket, state: ClientState): void {
    const signal = state.backpressure.onAck(frame.seq);
    this.emitFlowSignal(signal, client);
  }

  /**
   * Stream one raw output chunk to a client: emit it as a `raw` frame tagged
   * with the cumulative byte offset, then update backpressure. If the send
   * pushed un-acknowledged bytes to the high-water mark, pause the PTY and tell
   * the client with an explicit `pause` control frame.
   *
   * VR.3: Each PTY output chunk resets the idle window for the task, so wedged
   * tasks that are silently producing output are not force-failed as idle.
   */
  private streamRawChunk(
    chunk: string,
    client: WebSocket,
    state: ClientState,
    meta?: AgentTerminalOutputMeta,
  ): void {
    const recordable = this.isPtyOutputRecordable(state.taskId, meta);
    const bytes = Buffer.byteLength(chunk);
    if (recordable) {
      state.sentBytes += bytes;
    }
    const rawFrame: RawFrame = {
      channel: FRAME_CHANNEL.RAW,
      data: Buffer.from(chunk).toString('base64'),
      seq: state.sentBytes,
    };
    this.send(client, rawFrame);

    // VR.3 — feed the IdleTracker so tasks actively producing terminal output
    // are never incorrectly reclaimed as idle.
    if (state.taskId && this.guardrails) {
      this.guardrails.recordActivity(state.taskId);
    }

    // Non-recordable attach/bootstrap bytes are intentionally live-only. They
    // must not advance the reconnect cursor, otherwise a later reconnect asks for
    // a byte offset that does not exist in session.log and can skip/reorder replay.
    if (recordable) {
      const signal = state.backpressure.onSent(state.sentBytes);
      this.emitFlowSignal(signal, client);
    }
  }

  /** Translate a {@link FlowSignal} into the matching pause/resume frame. */
  private emitFlowSignal(signal: FlowSignal, client: WebSocket): void {
    if (signal === 'pause') {
      const frame: PauseFrame = {
        channel: FRAME_CHANNEL.CONTROL,
        type: 'pause',
      };
      this.send(client, frame);
    } else if (signal === 'resume') {
      const frame: ResumeFrame = {
        channel: FRAME_CHANNEL.CONTROL,
        type: 'resume',
      };
      this.send(client, frame);
    }
  }

  private isPtyOutputRecordable(
    taskId: string | null,
    meta?: AgentTerminalOutputMeta,
  ): boolean {
    if (meta?.recordable === false) return false;
    if (!taskId) return true;
    const suppression = this.resizeRepaintSuppressions.get(taskId);
    if (!suppression) return true;
    this.armResizeRepaintQuietTimer(taskId, suppression);
    return false;
  }

  private beginResizeRepaintSuppression(taskId: string): void {
    if (RESIZE_REPAINT_MAX_MS <= 0) return;
    let suppression = this.resizeRepaintSuppressions.get(taskId);
    if (!suppression) {
      suppression = {};
      this.resizeRepaintSuppressions.set(taskId, suppression);
    }
    this.clearResizeRepaintTimers(suppression);
    suppression.maxTimer = setTimeout(() => {
      this.endResizeRepaintSuppression(taskId);
    }, RESIZE_REPAINT_MAX_MS);
    suppression.maxTimer.unref?.();
    this.armResizeRepaintQuietTimer(taskId, suppression);
  }

  private armResizeRepaintQuietTimer(
    taskId: string,
    suppression = this.resizeRepaintSuppressions.get(taskId),
  ): void {
    if (!suppression) return;
    if (suppression.quietTimer) {
      clearTimeout(suppression.quietTimer);
      suppression.quietTimer = undefined;
    }
    if (RESIZE_REPAINT_QUIESCE_MS <= 0) {
      this.endResizeRepaintSuppression(taskId);
      return;
    }
    suppression.quietTimer = setTimeout(() => {
      this.endResizeRepaintSuppression(taskId);
    }, RESIZE_REPAINT_QUIESCE_MS);
    suppression.quietTimer.unref?.();
  }

  private endResizeRepaintSuppression(taskId: string): void {
    const suppression = this.resizeRepaintSuppressions.get(taskId);
    if (!suppression) return;
    this.clearResizeRepaintTimers(suppression);
    this.resizeRepaintSuppressions.delete(taskId);
  }

  private clearResizeRepaintTimers(
    suppression: ResizeRepaintSuppressionState,
  ): void {
    if (suppression.quietTimer) {
      clearTimeout(suppression.quietTimer);
      suppression.quietTimer = undefined;
    }
    if (suppression.maxTimer) {
      clearTimeout(suppression.maxTimer);
      suppression.maxTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Reconnect: snapshot + tail-replay (5.4)
  // -------------------------------------------------------------------------

  /**
   * Restore a reconnecting client: join it to the claimed task's session, then
   * deliver the latest SerializeAddon snapshot followed by the `session.log`
   * tail appended after it (reconciling size differences via the snapshot's
   * recorded cols/rows). Live streaming resumes once the final tail frame is
   * sent.
   */
  private async onReconnect(
    frame: ReconnectFrame,
    client: WebSocket,
    state: ClientState,
  ): Promise<void> {
    const taskId = state.taskId;
    if (!taskId) {
      this.logger.warn(
        `client ${state.clientId}: reconnect before joining a task`,
      );
      return;
    }
    const session = this.sessions.get(taskId);
    if (!session) return;

    // Sync the sandbox PTY (and snapshot headless) to the reconnecting operator's
    // terminal geometry so codex renders at the client's cols/rows, not the AIO
    // default 80×24 — without this codex's cursor-addressed history misaligns in a
    // wider browser grid. The reconnect frame carries cols/rows for exactly this
    // reconciliation; the explicit resize frame the client also sends on open is
    // belt-and-suspenders. Guarded to an authenticated operator, mirroring onResize.
    if (
      state.authenticated &&
      state.kind === 'operator' &&
      typeof frame.cols === 'number' &&
      typeof frame.rows === 'number'
    ) {
      this.beginResizeRepaintSuppression(taskId);
      session.pty.resize(frame.cols, frame.rows);
      session.snapshots.resizeHeadless(frame.cols, frame.rows);
    }

    // `onPtyOutput` streams to live operators synchronously but persists
    // `session.log` through a per-task async append chain. Reconnect is the
    // durable replay boundary, so wait for already-observed output to land before
    // reading the log; otherwise a fast reconnect can see live bytes on the old
    // socket and an empty tail on the new socket.
    await this.flushSessionLog(taskId);
    await this.flushSessionCast(taskId);

    const frames: WsControlFrame[] = await session.snapshots.buildReconnectFrames(
      {
        fromSeq: frame.lastSeq,
        clientCols: frame.cols,
        clientRows: frame.rows,
      },
    );

    for (const f of frames) {
      this.send(client, f);
    }
    // The client now holds everything up to the snapshot manager's offset;
    // align its sent counter and rebase backpressure so the un-acknowledged
    // total restarts from zero and subsequent accounting stays monotonic.
    let lastSeq = 0;
    let hasSeq = false;
    for (const f of frames) {
      if ('seq' in f) {
        lastSeq = f.seq;
        hasSeq = true;
      }
    }
    if (hasSeq) {
      state.sentBytes = lastSeq;
      state.backpressure.rebase(lastSeq);
    }
    // Begin live streaming for this client from here on.
    this.attachPty(session, client, state);
  }

  /**
   * Subscribe a client to a session's live PTY output, streaming each chunk as a
   * backpressure-accounted raw frame. Idempotent per client: a prior
   * subscription is disposed first so a reconnect re-attaches cleanly.
   *
   * VR.9: Wire the real PTY into the client's BackpressureController so
   * `pty.pause()` / `pty.resume()` actually halt the producer when the client
   * backlog reaches the 500k high-water mark. Without this the controller's
   * `pty?.pause()` / `pty?.resume()` calls silently no-op.
   */
  private attachPty(
    session: TerminalSession,
    client: WebSocket,
    state: ClientState,
  ): void {
    state.ptySubscription?.dispose();
    state.taskId = session.taskId;
    // VR.9 — inject the PTY into the backpressure controller now that we know it.
    state.backpressure.setPty(session.pty);
    state.ptySubscription = session.pty.onData((chunk, meta) => {
      this.streamRawChunk(chunk, client, state, meta);
    });
  }

  // -------------------------------------------------------------------------
  // VR.8 — terminal geometry sync (resize frame)
  // -------------------------------------------------------------------------

  /**
   * Dispatch a terminal resize event from an authenticated operator to the
   * session's sandbox PTY so the PTY cols/rows stay in sync with the browser.
   * Without this the sandbox PTY stays fixed at 80×24 while the browser auto-fits,
   * making the "identical cols and rows" parity precondition unreachable (VR.8).
   */
  private onResize(frame: ResizeFrame, state: ClientState): void {
    if (!state.authenticated || state.kind !== 'operator') return;
    if (!state.taskId) return;
    const session = this.sessions.get(state.taskId);
    if (!session) return;
    // Forward the resize to the sandbox PTY (AioPtyClient → AIO `resize` frame)
    // so cols/rows stay in sync with the browser (VR.8). Also update the
    // SnapshotManager's headless terminal so subsequent snapshots record the
    // updated geometry.
    this.beginResizeRepaintSuppression(state.taskId);
    session.pty.resize(frame.cols, frame.rows);
    session.snapshots.resizeHeadless(frame.cols, frame.rows);
    // session-terminal-replay — record the resize as an asciicast `r` event so
    // the timing player re-sizes the replay terminal at the right moment.
    const castEntry = this.sessionCasts.get(state.taskId);
    if (castEntry) {
      this.appendCastEvent(
        state.taskId,
        'r',
        castResizeData(frame.cols, frame.rows),
      );
    }
  }

  // -------------------------------------------------------------------------
  // PTY-output fan-out + SnapshotManager feeding (VR.10)
  // -------------------------------------------------------------------------

  /**
   * Handle a chunk of live PTY output produced by the task's {@link AioPtyClient}
   * (subscribed in {@link openSession}). This is the SINGLE code path where raw
   * PTY output is received, so it is where the two byte-offset consumers are kept
   * in lockstep (D9 / 3.1):
   *   1. the bytes are APPENDED to `workspaces/<taskId>/session.log` (the durable
   *      tail-replay source — there is no in-sandbox runner producer under
   *      connect-in), and
   *   2. the SAME bytes (same `byteLen`) are fed to `snapshots.feed`, advancing
   *      the snapshot byte-offset by exactly what was written to the file.
   * Because the file append and the offset advance both use the identical
   * `payload` buffer, the snapshot boundary (`seq`) and the replayed tail align.
   *
   * It also streams the chunk to every operator watching the task who has NOT yet
   * reconnected/attached (operators that have called `attachPty` receive the same
   * bytes through their own `ptySubscription`).
   */
  private onPtyOutput(
    taskId: string,
    chunk: string,
    meta?: AgentTerminalOutputMeta,
  ): void {
    const session = this.sessions.get(taskId);
    const recordable = this.isPtyOutputRecordable(taskId, meta);
    // Encode ONCE so the bytes written to disk are byte-for-byte the bytes the
    // snapshot offset advances by (UTF-8 char length can differ from byte length).
    const payload = Buffer.from(chunk, 'utf8');
    const byteLen = payload.byteLength;

    if (recordable) {
      // 3.1 — persist the raw PTY output to session.log BEFORE advancing the
      // snapshot offset, so the file and the offset move together (lockstep).
      this.appendSessionLog(taskId, payload);

      // session-terminal-replay — ALSO record to session.cast (asciicast v2),
      // independent of the lockstep above; best-effort, never blocks streaming.
      this.appendCast(taskId, chunk);

      if (session) {
        // VR.10 — Feed the SnapshotManager so the byte-offset tracks session.log.
        session.snapshots.feed(chunk, byteLen);
      }
    } else if (session) {
      // Attach/bootstrap bytes are live-only and must not move the durable log
      // cursor, but they still describe the current terminal frame after an API
      // restart/readoption. Feed the transient headless terminal with a zero
      // byte delta so snapshots can restore the visible screen without replaying
      // duplicate bootstrap bytes from session.log.
      session.snapshots.feed(chunk, 0);
    }

    // VR.3 — feed the IdleTracker.
    if (this.guardrails) {
      this.guardrails.recordActivity(taskId);
    }

    // Directly stream to any operator watching this task who has NOT yet called
    // reconnect/attachPty (i.e. no ptySubscription set up yet) so they receive
    // live output from the moment they connect.
    for (const [socket, s] of this.clients) {
      if (
        s.kind === 'operator' &&
        s.authenticated &&
        s.ptySubscription === null &&
        (s.taskId === null || s.taskId === taskId)
      ) {
        this.streamRawChunk(chunk, socket, s, meta);
      }
    }

    // Runtime-auth failures may leave an interactive TUI resident instead of
    // exiting. Inspect the same recordable stream after it has been forwarded so
    // the operator still receives the decisive error chunk. Classification is
    // delegated to the selected AgentRuntime; this shared gateway never parses
    // Codex/Claude-specific envelopes.
    if (recordable) this.inspectRuntimeFailure(taskId, chunk);
  }

  private inspectRuntimeFailure(taskId: string, chunk: string): void {
    if (!this.guardrails || this.runtimeFailuresReported.has(taskId)) return;
    const previous = this.runtimeFailureBuffers.get(taskId) ?? '';
    const rolling = `${previous}${chunk}`.slice(-8 * 1024);
    this.runtimeFailureBuffers.set(taskId, rolling);
    if (
      this.runtimeFailureChecks.has(taskId) ||
      !TerminalGateway.mayContainRuntimeAuthFailure(rolling)
    ) {
      return;
    }

    this.runtimeFailureChecks.add(taskId);
    void (async () => {
      try {
        let runtime = this.runtimeFailureRuntimes.get(taskId);
        if (!runtime) {
          runtime = await this.runtimes?.resolveForTask?.(taskId);
          // unregisterSession may have completed while the runtime lookup was
          // in flight. Do not revive classifier state for a terminal task.
          if (!this.runtimeFailureBuffers.has(taskId)) return;
          if (runtime) this.runtimeFailureRuntimes.set(taskId, runtime);
        }
        const failure = runtime?.classifyOutputFailure(rolling) ?? null;
        if (!failure) return;

        // Fence duplicate chunks before awaiting the lifecycle transition. A
        // successful terminal teardown calls unregisterSession(), which clears
        // this set; adding only after the await would re-introduce a stale entry.
        this.runtimeFailuresReported.add(taskId);
        const accepted = await this.guardrails?.failRuntime(
          taskId,
          failure.code,
          null,
        );
        if (!accepted) this.runtimeFailuresReported.delete(taskId);
      } catch (err) {
        this.runtimeFailuresReported.delete(taskId);
        this.logger.debug(
          `task ${taskId}: runtime failure inspection skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        this.runtimeFailureChecks.delete(taskId);
        const latest = this.runtimeFailureBuffers.get(taskId);
        // Output can arrive while resolve/classification is awaiting. Re-check
        // the latest rolling window once so a provider envelope split across
        // those chunks cannot leave an interactive TUI running indefinitely.
        if (
          latest !== undefined &&
          latest !== rolling &&
          !this.runtimeFailuresReported.has(taskId)
        ) {
          this.inspectRuntimeFailure(taskId, '');
        }
      }
    })();
  }

  /** Cheap runtime-neutral prefilter; the AgentRuntime owns final classification. */
  private static mayContainRuntimeAuthFailure(output: string): boolean {
    return /\b(?:401|expired|invalid|refresh|session)\b|auth(?:entication|orization)?|credential|token|api[ -]?key|sign(?:ed)? in|log(?:ged)? in|\/login/i.test(
      output,
    );
  }

  /**
   * Append a raw PTY-output payload to the task's `session.log` (3.1), serializing
   * appends per task so concurrent chunks land in order (the bytes on disk match
   * the bytes fed to `snapshots.feed`). The workspace directory is created lazily
   * on the first append. Append failures are logged but never throw into the hot
   * output path — a missing tail degrades reconnect, it does not break streaming.
   */
  private appendSessionLog(taskId: string, payload: Buffer): void {
    const entry = this.sessionLogs.get(taskId);
    if (!entry) return;
    const { logPath } = entry;
    // Chain on the prior append so writes are strictly ordered (no interleaving),
    // keeping the on-disk byte stream identical to the fed-offset byte stream.
    entry.tail = entry.tail.then(async () => {
      try {
        if (!entry.ensured) {
          await mkdir(path.dirname(logPath), { recursive: true });
          entry.ensured = true;
        }
        await appendFile(logPath, payload);
      } catch (err) {
        this.logger.warn(
          `task ${taskId}: session.log append failed: ${(err as Error).message}`,
        );
      }
    });
  }

  private async flushSessionLog(taskId: string): Promise<void> {
    const entry = this.sessionLogs.get(taskId);
    if (!entry) return;
    try {
      await entry.tail;
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: session.log flush failed before reconnect: ${
          (err as Error).message
        }`,
      );
    }
  }

  private async flushSessionCast(taskId: string): Promise<void> {
    const entry = this.sessionCasts.get(taskId);
    if (!entry) return;
    try {
      await entry.tail;
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: session.cast flush failed before reconnect: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * Begin a per-task asciicast recording (session-terminal-replay, Track 2):
   * register the cast append state and write the asciicast v2 header (initial
   * geometry) as the first tail-chained op. BEST-EFFORT — a cast failure never
   * affects streaming or the session.log lockstep (its OWN append chain).
   */
  private initCast(
    taskId: string,
    workspaceDir: string,
    cols: number,
    rows: number,
  ): void {
    if (this.sessionCasts.has(taskId)) return;
    // headless-task-conversation-view: a HEADLESS task has NO terminal record —
    // its review surface is the polled conversation, and a recorded codex-exec
    // JSON stream would be the unreadable artifact this change removes. Resolve the
    // execution mode async (a registry lookup that resolves well before codex emits
    // real output — the shell/launch handshake dominates, so an interactive task
    // loses no real frames), then arm recording ONLY for interactive. headless
    // leaves no sessionCasts entry, so appendCast is a no-op and the cast endpoint
    // honestly returns empty for it. `resolveExecutionModeForTask` never throws (it
    // defaults to interactive-pty), so a resolution hiccup safely still records.
    void this.resolveExecutionModeForTask(taskId).then((mode) => {
      if (mode === 'headless-exec') return;
      this.armCast(taskId, workspaceDir, cols, rows);
    });
  }

  /** Register the cast append state + write the asciicast v2 header (interactive only). */
  private armCast(
    taskId: string,
    workspaceDir: string,
    cols: number,
    rows: number,
  ): void {
    if (this.sessionCasts.has(taskId)) return;
    const castPath = path.join(workspaceDir, SESSION_CAST_FILENAME);
    const entry: SessionCastState = {
      castPath,
      tail: Promise.resolve(),
      startMs: Date.now(),
    };
    this.sessionCasts.set(taskId, entry);
    entry.tail = entry.tail.then(async () => {
      try {
        await mkdir(path.dirname(castPath), { recursive: true });
        const resume = await inspectCastResumeState(castPath);
        const now = Date.now();
        if (resume.hasHeader) {
          entry.startMs = now - resume.lastTimeSec * 1000;
          return;
        }
        entry.startMs = now;
        if (resume.hasBytes) {
          this.logger.warn(
            `task ${taskId}: existing session.cast has no valid header; not appending a second header`,
          );
          return;
        }
        await appendFile(castPath, buildCastHeaderLine(cols, rows, Math.floor(now / 1000)));
      } catch (err) {
        this.logger.warn(
          `task ${taskId}: session.cast header write failed: ${(err as Error).message}`,
        );
      }
    });
  }

  /**
   * Append one finished asciicast line to the task's `session.cast`, strictly
   * ordered on the cast tail chain and best-effort (logged + swallowed).
   */
  private appendCastEvent(
    taskId: string,
    code: 'o' | 'r',
    data: string,
  ): void {
    const entry = this.sessionCasts.get(taskId);
    if (!entry) return;
    entry.tail = entry.tail.then(async () => {
      try {
        await appendFile(
          entry.castPath,
          buildCastEventLine(
            Math.max(0, (Date.now() - entry.startMs) / 1000),
            code,
            data,
          ),
        );
      } catch (err) {
        this.logger.warn(
          `task ${taskId}: session.cast append failed: ${(err as Error).message}`,
        );
      }
    });
  }

  /**
   * Record a chunk of PTY output as an asciicast `o` event. `chunk` is an
   * already-decoded UTF-8 string (the AioPtyClient decodes the PTY byte stream
   * before emitting), so JSON-escaping yields valid UTF-8 `data` with no
   * split-multibyte risk at this layer.
   */
  private appendCast(taskId: string, chunk: string): void {
    this.appendCastEvent(taskId, 'o', chunk);
  }

  // -------------------------------------------------------------------------
  // Low-level send + helpers
  // -------------------------------------------------------------------------

  /** Serialize and send a frame to a client if the socket is open. */
  private send(client: WebSocket, frame: RawFrame | ControlFrame): void {
    if (client.readyState !== client.OPEN) return;
    client.send(JSON.stringify(frame));
  }

  /** Close an unauthenticated connection with the WS policy-violation code. */
  private closeUnauthenticated(client: WebSocket): void {
    try {
      client.close(1008, 'unauthorized');
    } catch {
      // Best-effort; the socket may already be closing.
    }
  }

  /** Parse the connection's request URL, tolerating the `ws` adapter's shapes. */
  private parseUrl(request?: IncomingMessage): URL | null {
    const raw = request?.url;
    if (!raw) return null;
    try {
      // A relative request-target is resolved against a dummy origin so we can
      // read query params without caring about the real host.
      return new URL(raw, 'http://localhost');
    } catch {
      return null;
    }
  }

  /** Read the requested WebSocket subprotocols off the upgrade request headers. */
  private subprotocols(request?: IncomingMessage): string[] {
    const header = request?.headers?.['sec-websocket-protocol'];
    if (!header) return [];
    const value = Array.isArray(header) ? header.join(',') : header;
    return value.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  }
}

function readSessionLogSize(workspaceDir: string): number {
  try {
    return statSync(path.join(workspaceDir, SESSION_LOG_FILENAME)).size;
  } catch {
    return 0;
  }
}

async function inspectCastResumeState(
  castPath: string,
): Promise<CastResumeState> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(castPath, 'r');
  } catch {
    return { hasHeader: false, hasBytes: false, lastTimeSec: 0 };
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return { hasHeader: false, hasBytes: false, lastTimeSec: 0 };
    }

    const headLength = Math.min(size, CAST_RESUME_HEAD_BYTES);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    const firstLine = firstNonBlankLine(head.toString('utf8'));
    const hasHeader = firstLine
      ? parseAsciicastHeader(firstLine) !== null
      : false;
    if (!hasHeader) {
      return { hasHeader: false, hasBytes: true, lastTimeSec: 0 };
    }

    const tailStart = Math.max(0, size - CAST_RESUME_TAIL_BYTES);
    const tailLength = size - tailStart;
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, tailStart);
    return {
      hasHeader: true,
      hasBytes: true,
      lastTimeSec: findLastCastEventTime(tail.toString('utf8')),
    };
  } finally {
    await handle.close();
  }
}

function firstNonBlankLine(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) return line;
  }
  return null;
}

function findLastCastEventTime(text: string): number {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) continue;
    if (parseAsciicastHeader(line)) continue;
    const event = parseAsciicastEvent(line);
    if (event && Number.isFinite(event[0])) {
      return Math.max(0, event[0]);
    }
  }
  return 0;
}

/**
 * Normalize an inbound `ws` RawData payload (string | Buffer | ArrayBuffer |
 * Buffer[]) to a UTF-8 string, or null if it is none of those.
 */
function toUtf8(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString('utf8');
  if (Array.isArray(payload) && payload.every((p) => Buffer.isBuffer(p))) {
    return Buffer.concat(payload as Buffer[]).toString('utf8');
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).toString('utf8');
  }
  return null;
}

/**
 * Resolve the workspace directory for a task, mirroring the runner's
 * `createTaskWorkspace` logic. The gateway needs this path to point the
 * SnapshotManager at the correct `session.log` for tail-replay (VR.10).
 *
 * The root is read from `WORKSPACES_DIR` — the env var every deploy target sets
 * to the persistent-volume mount (docker-compose.yml, fly.toml, Dockerfile) — so
 * `session.log` is written/read ON the volume and survives an orchestrator
 * restart (VR.13). Legacy `WORKSPACES_ROOT` is still honored as a fallback, then
 * `cwd()/workspaces` for local dev (off-volume, ephemeral — dev only).
 */
function resolveWorkspaceDir(taskId: string): string {
  const root =
    process.env.WORKSPACES_DIR ??
    process.env.WORKSPACES_ROOT ??
    path.resolve(process.cwd(), 'workspaces');
  return path.join(root, taskId);
}
