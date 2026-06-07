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
 *   - connect-time OPERATOR authentication of console clients via the GitHub-OAuth
 *     SESSION (cookie or `bearer.<token>` subprotocol) with an allowlist re-check,
 *     and the gated legacy `AUTH_TOKEN` break-glass path, resolved by the shared
 *     `resolveOperatorPrincipal` — closing unauthenticated/expired/non-allowlisted
 *     connections before they join any task stream (be-oauth-allowlist 2.7);
 *   - approval routing (6.5) — a sandbox `permission_request`, delivered over an
 *     OUTBOUND HTTP callback (re-homed in the integration track), is fanned out to
 *     operator clients and the resolved `decision` is returned to the blocked hook
 *     over its reply transport by `requestId` correlation;
 *   - raw keystroke forwarding GATED on holding the write lease (7.5), while
 *     one-shot approval `decision`s are accepted independently of the lease.
 */
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
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
} from '@cap/contracts';
import {
  BackpressureController,
  type FlowSignal,
  type PausablePty,
} from './backpressure';
import {
  SnapshotManager,
  SESSION_LOG_FILENAME,
  type HeadlessTerminal,
  type WsControlFrame,
} from './snapshot';
import { AioPtyClient, type AioExitStatus } from './aio-pty-client';
import type { SandboxConnection } from '../sandbox/sandbox-provider.port';
import { WriteLockService } from '../write-lock/write-lock.service';
// be-oauth-allowlist 2.7 — connect-time operator SESSION authentication (replaces
// the AUTH_TOKEN-only operator check). `resolveOperatorPrincipal` is the shared,
// transport-agnostic decision point (also used by the REST guard), and it performs
// the constant-time legacy-bearer comparison internally, so the gateway needs no
// direct `constantTimeEqual` import.
import { AuthSessionService } from '../auth/auth-session.service';
import { resolveOperatorPrincipal } from '../auth/operator-principal';
import { readCookie, SESSION_COOKIE_NAME } from '../auth/session-token';
import { GuardrailsService } from '../guardrails/guardrails.service';

/**
 * REAL headless xterm terminal backing the {@link SnapshotManager} (D9).
 *
 * Replaces the prior `NullHeadlessTerminal` (whose `serialize()` was always
 * empty, so every periodic snapshot was blank and `buildReconnectFrames`
 * replayed nothing). It owns a `@xterm/headless` `Terminal` fed the SAME raw PTY
 * bytes that are appended to `session.log`, with a `SerializeAddon` loaded so
 * `serialize()` returns the ACTUAL visible frame. The recorded `cols`/`rows`
 * track the terminal geometry so a reconnecting client of a different size can
 * reconcile dimensions before applying the snapshot.
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
    return this.serializer.serialize();
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      this.term.resize(cols, rows);
    }
  }
}

/** A node-pty handle: a pausable producer the gateway streams to clients. */
export interface TerminalPty extends PausablePty {
  /** Subscribe to raw PTY output; returns an unsubscribe handle. */
  onData(listener: (chunk: string) => void): { dispose(): void };
  /** Forward raw input bytes to the PTY (lock-gated keystroke path, 7.5). */
  write(data: string): void;
  /**
   * Resize the PTY to the given dimensions (VR.8). Called by the gateway when
   * the browser terminal is resized so the sandbox PTY cols/rows stay in sync,
   * making the "identical cols and rows" live-frame parity precondition
   * reachable at runtime.
   */
  resize(cols: number, rows: number): void;
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
  unregisterSession(taskId: string): void {
    this.sessions.delete(taskId);
    // Drop the session.log append state; the file itself persists on the volume
    // for post-mortem / restart reconnect (multi-target-deploy persistent volume).
    this.sessionLogs.delete(taskId);
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
   * authenticated at connect time against a GitHub-OAuth SESSION
   * (be-oauth-allowlist, task 2.7), resolved from the URL `token` query param or
   * the `bearer.<token>` subprotocol (browsers cannot set an `Authorization`
   * header on a WS handshake). The session resolver RE-CONFIRMS allowlist
   * membership, so an expired/revoked/de-allowlisted session fails. The legacy
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
    // (missing/expired/revoked/de-allowlisted session, or — with the legacy path
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

    // 7.3 — auto-release the write lease immediately on writer disconnect.
    if (state.taskId && this.writeLock) {
      const released = this.writeLock.releaseOnDisconnect(state.taskId, state.clientId);
      if (released) this.broadcastLeaseState(state.taskId);
    }

    this.clients.delete(client);
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
  // 2.7 — operator connect-time SESSION authentication
  // -------------------------------------------------------------------------

  /**
   * Resolves a presented operator credential to a valid principal at connect
   * time (be-oauth-allowlist, task 2.7). The credential is treated FIRST as a
   * GitHub-OAuth session token (resolved via {@link AuthSessionService}, which
   * RE-CONFIRMS allowlist membership so expired/revoked/de-allowlisted sessions
   * fail) and, only when the session does not resolve, as the legacy shared
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
    const legacyBearerToken = presentedToken;
    if (sessionToken === null && legacyBearerToken === null) return false;
    const credentials = { sessionToken, legacyBearerToken };
    const principal = await resolveOperatorPrincipal(credentials, (token) =>
      this.authSession ? this.authSession.resolveSession(token) : Promise.resolve(null),
    );
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
   * Exit detection (design D): when the sandbox terminal WS closes, the
   * `AioPtyClient` resolves the exit status and invokes the gateway's
   * `onSessionExit` hook so the guardrails mapping (zero → `recordSuccess`,
   * non-zero/abnormal → `recordFailure`) can be applied. That mapping itself is
   * wired in the guardrails track; here we only expose the resolved status.
   *
   * @returns the registered {@link TerminalSession}, so the caller can hold the
   *          handle if needed.
   */
  openSession(connection: SandboxConnection): TerminalSession {
    const { taskId, wsUrl, baseUrl } = connection;
    const existing = this.sessions.get(taskId);
    if (existing) return existing;

    const workspaceDir = resolveWorkspaceDir(taskId);
    // D9 — back the SnapshotManager with a REAL xterm headless terminal so
    // periodic snapshots carry the actual visible frame (the prior
    // NullHeadlessTerminal serialized to empty, leaving reconnect with nothing).
    const headless = new XtermHeadlessTerminal();
    const snapshots = new SnapshotManager(headless, workspaceDir);
    const pty = new AioPtyClient(
      taskId,
      wsUrl,
      baseUrl,
      (status) => this.onSessionExit(taskId, status),
      // Connect-in execution trigger: auto-launch codex once the sandbox
      // terminal reports `ready`. provision() has already injected the codex
      // auth.json into the container by the time we get here, so codex
      // authenticates on startup. This is the call site that was missing —
      // without it codex was never launched.
      true,
    );
    const session: TerminalSession = { taskId, pty, snapshots };
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
    // Feed live PTY output into the SnapshotManager + fan it out to operators
    // who have not yet reconnected/attached (VR.10). Operators that have called
    // attachPty receive the same bytes through their own ptySubscription.
    pty.onData((chunk) => this.onPtyOutput(taskId, chunk));
    snapshots.start();
    this.logger.debug(
      `task ${taskId}: opened AioPtyClient to ${wsUrl} + started snapshot manager`,
    );
    return session;
  }

  /**
   * Invoked when an {@link AioPtyClient} resolves a task's exit status after the
   * sandbox terminal WS closes. Applies the guardrails outcome mapping (4.3): a
   * ZERO exit maps to `recordSuccess`, a NON-ZERO/unresolved/abnormal exit maps
   * to `recordFailure`. The {@link AioExitStatus} the bridge resolves is
   * structurally compatible with the guardrails `ExitStatus`, so it is passed
   * straight through to `recordExit`, which owns the zero/non-zero rule.
   */
  protected onSessionExit(taskId: string, status: AioExitStatus): void {
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
    session.pty.write(input);
  }

  /** Renew the write lease for a heartbeat from the current holder (7.2). */
  private onHeartbeat(
    frame: HeartbeatFrame,
    _client: WebSocket,
    state: ClientState,
  ): void {
    if (!state.authenticated || !this.writeLock) return;
    this.writeLock.heartbeat(frame.sessionId, state.clientId);
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
    this.broadcastLeaseState(sessionId);
  }

  /** Broadcast the current lease for a session to every operator client. */
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
      if (state.kind === 'operator' && state.authenticated) {
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
  ): void {
    const bytes = Buffer.byteLength(chunk);
    state.sentBytes += bytes;
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

    const signal = state.backpressure.onSent(state.sentBytes);
    this.emitFlowSignal(signal, client);
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
    const last = frames[frames.length - 1];
    if (last) {
      state.sentBytes = last.seq;
      state.backpressure.rebase(last.seq);
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
    state.ptySubscription = session.pty.onData((chunk) => {
      this.streamRawChunk(chunk, client, state);
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
    session.pty.resize(frame.cols, frame.rows);
    session.snapshots.resizeHeadless(frame.cols, frame.rows);
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
  private onPtyOutput(taskId: string, chunk: string): void {
    const session = this.sessions.get(taskId);
    // Encode ONCE so the bytes written to disk are byte-for-byte the bytes the
    // snapshot offset advances by (UTF-8 char length can differ from byte length).
    const payload = Buffer.from(chunk, 'utf8');
    const byteLen = payload.byteLength;

    // 3.1 — persist the raw PTY output to session.log BEFORE advancing the
    // snapshot offset, so the file and the offset move together (lockstep).
    this.appendSessionLog(taskId, payload);

    if (session) {
      // VR.10 — Feed the SnapshotManager so the byte-offset tracks session.log.
      session.snapshots.feed(chunk, byteLen);
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
        this.streamRawChunk(chunk, socket, s);
      }
    }
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
