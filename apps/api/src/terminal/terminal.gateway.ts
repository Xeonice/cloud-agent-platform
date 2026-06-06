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
 * Tracks 5.1–5.4 (this gateway's transport core) own the dual-channel transport,
 * control-frame validation, application-layer backpressure (5.2), the ACK-based
 * pause/resume protocol (5.3), and snapshot + tail-replay reconnect (5.4),
 * delegating bookkeeping to {@link BackpressureController} and
 * {@link SnapshotManager}.
 *
 * The orchestrator-integration track layers the following onto this gateway:
 *   - 11.4: connect-time OPERATOR authentication of console clients against
 *           `AUTH_TOKEN` (constant-time), closing unauthenticated/invalid
 *           connections before they join any task stream; a runner `TASK_TOKEN`
 *           presented as the operator token is rejected.
 *   - 8.2 : the runner DIAL-BACK handshake verifier — a runner connection's first
 *           frame is a `dialback_handshake` carrying a `TASK_TOKEN`; the gateway
 *           accepts a valid unexpired token bound to the claimed task and
 *           associates the connection with it, rejecting
 *           missing/malformed/expired/mismatched tokens.
 *   - 6.5 : event ingestion + approval routing — a runner's `permission_request`
 *           is fanned out to operator clients (and notification adapters) and the
 *           resolved `decision` is returned to the blocking runner hook by
 *           `requestId` correlation.
 *   - 7.5 : raw keystroke forwarding is GATED on holding the write lease, while
 *           one-shot approval `decision`s are accepted independently of the lease.
 */
import path from 'node:path';
import { Inject, Logger, Optional } from '@nestjs/common';
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
  type DialbackHandshakeFrame,
  type HeartbeatFrame,
  type KeystrokeFrame,
  type PauseFrame,
  type PermissionRequestFrame,
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
import { SnapshotManager, type HeadlessTerminal, type WsControlFrame } from './snapshot';
import { WriteLockService } from '../write-lock/write-lock.service';
import { TaskTokenService } from '../tasks/task-token.service';
import { AuthSessionService } from '../auth/auth-session.service';
import { resolveOperatorPrincipal } from '../auth/operator-principal';
import { GuardrailsService } from '../guardrails/guardrails.service';

/**
 * Minimal no-op headless terminal used when `@xterm/headless` is not available
 * in the API process. The `serialize()` method returns an empty string so the
 * snapshot frame carries no visible-frame data, but the `SnapshotManager`'s
 * byte-offset bookkeeping and the tail-replay path (which reads `session.log`
 * directly) still work correctly. Once a real headless xterm is wired here the
 * snapshot frame will carry a genuine serialized frame.
 */
class NullHeadlessTerminal implements HeadlessTerminal {
  cols: number;
  rows: number;
  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
  }
  write(_data: string | Uint8Array): void { /* no-op: no rendering */ }
  serialize(): string { return ''; }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
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
   * the browser terminal is resized so runner PTY cols/rows stay in sync,
   * making the "identical cols and rows" live-frame parity precondition
   * reachable at runtime.
   */
  resize(cols: number, rows: number): void;
}

/**
 * The per-task server-side terminal session the gateway streams from. It pairs
 * the live PTY (raw producer) with the snapshot manager that mirrors it for
 * reconnect. The runner-dialback / terminal-execution tracks supply concrete
 * instances; this track defines the shape it consumes.
 */
export interface TerminalSession {
  readonly taskId: string;
  readonly pty: TerminalPty;
  readonly snapshots: SnapshotManager;
}

/** What kind of peer is on the other end of a connection. */
type ConnectionKind = 'operator' | 'runner';

/** Per-connected-client state held by the gateway. */
interface ClientState {
  readonly clientId: string;
  /** Operator console client vs runner sandbox dial-back. */
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

/** A blocked runner permission request awaiting an operator decision (6.5). */
interface PendingApproval {
  /** The runner socket that raised the request (where the decision returns). */
  readonly runner: WebSocket;
  readonly taskId: string;
  /** The Codex tool name being gated (surfaced by the pending-list read, 6.5). */
  readonly toolName: string;
  /** Raw, opaque tool-call input forwarded for operator review (6.5). */
  readonly toolInput: unknown;
}

/**
 * The operator-facing projection of a {@link PendingApproval} returned by
 * {@link TerminalGateway.listPendingApprovals} (6.5). Carries the
 * correlation/identity fields the pending-list REST read surfaces (matching the
 * contracts `PendingApprovalSchema`), without the internal runner socket.
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

  private nextClientId = 1;

  /**
   * Collaborators are optional so the gateway's transport core can still be
   * constructed in isolation (e.g. transport unit tests). When the integration
   * module provides them, the auth/lease/token integration paths activate.
   *
   * VR.3: `guardrails` is injected optionally so the PTY-output path can call
   * `recordActivity()` to feed the IdleTracker and reclaim wedged tasks.
   * VR.4: used to call `recordSuccess()` when a runner dials back successfully.
   */
  constructor(
    @Optional() private readonly writeLock?: WriteLockService,
    @Optional() private readonly taskTokens?: TaskTokenService,
    @Optional() @Inject(GuardrailsService) private readonly guardrails?: GuardrailsService,
    @Optional() @Inject(AuthSessionService) private readonly authSession?: AuthSessionService,
  ) {}

  // -------------------------------------------------------------------------
  // Session registry — terminal-execution / runner-dialback register sessions.
  // -------------------------------------------------------------------------

  /** Register a task's terminal session so clients can stream it. */
  registerSession(session: TerminalSession): void {
    this.sessions.set(session.taskId, session);
  }

  /** Remove a task's terminal session (e.g. on completion/teardown). */
  unregisterSession(taskId: string): void {
    this.sessions.delete(taskId);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * A new socket connected. The second argument is the raw HTTP upgrade request
   * (`ws` forwards it via NestJS's `WsAdapter`), from which we read the operator
   * credentials. Two connection kinds are distinguished:
   *
   *  - OPERATOR (console): authenticated at connect time against a GitHub-OAuth
   *    SESSION (be-oauth-allowlist, task 2.7), resolved from the URL `token`
   *    query param or the `bearer.<token>` subprotocol (browsers cannot set an
   *    `Authorization` header on a WS handshake). The session resolver
   *    RE-CONFIRMS allowlist membership, so an expired/revoked/de-allowlisted
   *    session fails. The legacy shared `AUTH_TOKEN` is accepted on this same
   *    channel ONLY when `AUTH_TOKEN_LEGACY_ENABLED` is on (task 2.8). An
   *    unauthenticated/invalid operator connection is closed immediately, BEFORE
   *    it can join any task stream or be sent any bytes/control frames.
   *  - RUNNER (sandbox dial-back): NOT operator-authenticated; instead its FIRST
   *    frame must be a `dialback_handshake` carrying a valid `TASK_TOKEN` (8.2).
   *    A runner is identified by the `?role=runner` marker the runner dials with.
   *
   * Operator authentication is async (the session is resolved against the store),
   * so the connection starts `authenticated: false`; the message handler is
   * attached immediately but every operator frame is gated on `authenticated`
   * (see {@link handleControlFrame}) so nothing is acted on until auth resolves.
   */
  handleConnection(client: WebSocket, request?: IncomingMessage): void {
    const clientId = `c${this.nextClientId++}`;
    const url = this.parseUrl(request);
    const isRunner = url?.searchParams.get('role') === 'runner';

    const state: ClientState = {
      clientId,
      kind: isRunner ? 'runner' : 'operator',
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

    if (state.kind === 'operator') {
      // 2.7 — connect-time operator SESSION authentication. Reject (close) before
      // the connection can join any task stream when no valid principal resolves
      // (missing/expired/revoked/de-allowlisted session, or a runner `TASK_TOKEN`
      // presented in place of an operator credential).
      const presented = extractWsOperatorToken({
        queryToken: url?.searchParams.get('token') ?? null,
        subprotocols: this.subprotocols(request),
      });
      void this.authenticateOperator(presented).then((ok) => {
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
    }
    // Runner connections defer authentication to the first-frame handshake (8.2).

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

    // Drop any approvals still blocked on this runner so they cannot wedge.
    // Also stop the SnapshotManager when the runner disconnects (VR.10).
    if (state.kind === 'runner') {
      for (const [requestId, approval] of this.pendingApprovals) {
        if (approval.runner === client) this.pendingApprovals.delete(requestId);
      }
      if (state.taskId) {
        const session = this.sessions.get(state.taskId);
        session?.snapshots.stop();
      }
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
      // Raw channel: opaque bytes — never interpreted as a control frame.
      // A raw frame from an OPERATOR is not the keystroke path (that is the
      // lock-gated `keystroke` control frame, 7.5); operator raw frames are
      // dropped.
      // A raw frame from an authenticated RUNNER carries PTY output bytes that
      // must be forwarded to every operator watching that task and fed to the
      // SnapshotManager so tail-replay and periodic snapshots work (VR.10).
      if (state.kind === 'runner' && state.authenticated && state.taskId) {
        this.onRunnerRawFrame(frame as unknown as RawFrame, state);
      }
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
   * dial-back handshake (8.2), keystroke/heartbeat/takeover (7.5), and the
   * approval round-trip frames (6.5).
   *
   * Authentication gate: a RUNNER connection's very first frame MUST be the
   * dial-back handshake; nothing else is processed until it authenticates. An
   * OPERATOR connection is already authenticated at connect time (11.4); a stray
   * `connect_auth` frame from a non-browser client re-affirms it.
   */
  private handleControlFrame(
    frame: ControlFrame,
    client: WebSocket,
    state: ClientState,
  ): void {
    // 8.2 — runner handshake gate: an unauthenticated runner may only send the
    // dial-back handshake. Any other frame from it before authentication is
    // dropped (it never joins a task stream).
    if (state.kind === 'runner' && !state.authenticated) {
      if (frame.type === 'dialback_handshake') {
        this.onDialbackHandshake(frame, client, state);
      } else {
        this.logger.warn(
          `runner ${state.clientId}: non-handshake frame before auth dropped`,
        );
      }
      return;
    }

    // 2.7 — operator auth gate: an operator connection whose connect-time session
    // auth has not (yet) succeeded may only (re)assert auth via a `connect_auth`
    // frame. Any other frame before authentication is dropped, so no task-stream
    // action runs and no bytes/control frames are emitted until it authenticates.
    if (state.kind === 'operator' && !state.authenticated) {
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
      case 'permission_request':
        this.onPermissionRequest(frame, client, state);
        break;
      case 'decision':
        this.onDecision(frame, client, state);
        break;
      case 'resize':
        this.onResize(frame, state);
        break;
      case 'dialback_handshake':
        // A handshake from an already-associated connection is a no-op.
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
   * bearer while the legacy path is disabled (fail-closed). A runner `TASK_TOKEN`
   * presented here is neither a valid session nor the configured `AUTH_TOKEN`, so
   * it fails — there is no special case that admits it as an operator.
   *
   * When {@link AuthSessionService} is not provided (transport-only unit
   * construction), no session can resolve; only the gated legacy path remains.
   */
  private async authenticateOperator(presented: string | null): Promise<boolean> {
    if (presented === null) return false;
    // A WS handshake carries a SINGLE operator credential on ONE channel (the
    // `token` query param or the `bearer.<token>` subprotocol), so — unlike REST,
    // where the session cookie and the `Authorization` header are distinct — the
    // same string is the candidate for both trust domains. We try it FIRST as a
    // GitHub-OAuth session token; only if that does not resolve do we try it as
    // the gated legacy `AUTH_TOKEN` bearer (task 2.8). Both checks route through
    // the shared {@link resolveOperatorPrincipal} so the WS surface cannot drift
    // from REST on the session re-check or the constant-time legacy comparison.
    const credentials = { sessionToken: presented, legacyBearerToken: presented };
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
    if (state.kind === 'operator' && state.authenticated) {
      if (frame.taskId) state.taskId = frame.taskId;
      return;
    }
    const ok = await this.authenticateOperator(frame.token);
    if (!this.clients.has(client)) return; // disconnected mid-resolution
    if (!ok) {
      this.closeUnauthenticated(client);
      return;
    }
    state.kind = 'operator';
    state.authenticated = true;
    if (frame.taskId) state.taskId = frame.taskId;
  }

  // -------------------------------------------------------------------------
  // 8.2 — runner dial-back handshake verifier
  // -------------------------------------------------------------------------

  /**
   * Verify a runner's first-frame dial-back handshake. Accepts a valid, unexpired
   * `TASK_TOKEN` bound to the CLAIMED task and associates the connection with it;
   * rejects (closes) on a missing/malformed/expired token, or a token issued for
   * a DIFFERENT task than the one claimed (token-A-claims-task-B). A connection
   * that fails verification is never associated with any task.
   */
  private onDialbackHandshake(
    frame: DialbackHandshakeFrame,
    client: WebSocket,
    state: ClientState,
  ): void {
    const ok =
      this.taskTokens !== undefined &&
      this.taskTokens.verify(frame.taskId, frame.TASK_TOKEN);
    if (!ok) {
      this.logger.warn(
        `runner ${state.clientId}: dial-back handshake rejected for task ${frame.taskId}`,
      );
      this.closeUnauthenticated(client);
      return;
    }
    state.kind = 'runner';
    state.authenticated = true;
    state.taskId = frame.taskId;
    this.logger.debug(
      `runner ${state.clientId}: dial-back associated with task ${frame.taskId}`,
    );
    // VR.4 — a successful dial-back handshake means the agent started; reset the
    // circuit-breaker counter for this task so a prior failure streak is cleared.
    if (this.guardrails) {
      this.guardrails.recordSuccess(frame.taskId);
    }

    // VR.10 — register a TerminalSession for this task so reconnecting operator
    // clients can get the snapshot + tail-replay instead of always hitting
    // `if (!session) return`. We create a SnapshotManager backed by a
    // NullHeadlessTerminal (byte-offset tracking + tail-replay work; snapshot
    // data is empty until a real headless terminal is wired). The RunnerPtyProxy
    // lets the gateway forward keystrokes and resize events to the runner over
    // the same WS connection.
    if (!this.sessions.has(frame.taskId)) {
      const workspaceDir = resolveWorkspaceDir(frame.taskId);
      const headless = new NullHeadlessTerminal();
      const snapshots = new SnapshotManager(headless, workspaceDir);
      const ptyProxy = new RunnerPtyProxy(client);
      const session: TerminalSession = {
        taskId: frame.taskId,
        pty: ptyProxy,
        snapshots,
      };
      this.registerSession(session);
      snapshots.start();
      this.logger.debug(
        `runner ${state.clientId}: registered session + started snapshot manager for task ${frame.taskId}`,
      );
    }
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
   * A runner forwarded a blocking `permission_request`. Route it to the operator
   * approval surface: fan the request out to every authenticated operator client
   * for the claimed task (the lock-INDEPENDENT approval surface, D7), and record
   * the originating runner so the resolved `decision` can be returned to the
   * blocked hook by `requestId`. Notification-adapter round-trips, when wired,
   * also consume this same pending entry.
   */
  private onPermissionRequest(
    frame: PermissionRequestFrame,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (state.kind !== 'runner' || !state.authenticated) return;
    this.pendingApprovals.set(frame.requestId, {
      runner: client,
      taskId: frame.taskId,
      toolName: frame.toolName,
      toolInput: frame.toolInput,
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
   * An operator submitted a one-shot approval `decision`. This is accepted
   * INDEPENDENTLY of the write lease (7.5 / D7): any authenticated operator may
   * decide even without holding the keyboard. The decision is correlated by
   * `requestId` and returned to the exact runner connection that blocked on it
   * (6.5); the runner hook then unblocks and prints the decision to Codex.
   */
  private onDecision(
    frame: DecisionFrame,
    _client: WebSocket,
    state: ClientState,
  ): void {
    // Lock-INDEPENDENT: no lease check here. Only require an authenticated
    // operator so a runner cannot inject its own decision.
    if (state.kind !== 'operator' || !state.authenticated) return;

    const pending = this.pendingApprovals.get(frame.requestId);
    if (!pending) return;
    this.pendingApprovals.delete(frame.requestId);

    // Return the resolved decision to the blocked runner hook.
    this.send(pending.runner, frame);
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
   * correlation/identity fields, dropping the internal runner socket. The
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
   * session's runner PTY so the PTY cols/rows stay in sync with the browser.
   * Without this the runner PTY stays fixed at 80×24 while the browser auto-fits,
   * making the "identical cols and rows" parity precondition unreachable (VR.8).
   */
  private onResize(frame: ResizeFrame, state: ClientState): void {
    if (!state.authenticated || state.kind !== 'operator') return;
    if (!state.taskId) return;
    const session = this.sessions.get(state.taskId);
    if (!session) return;
    // Forward the resize to the runner PTY so cols/rows stay in sync with the
    // browser (VR.8). Also update the SnapshotManager's headless terminal so
    // subsequent snapshots record the updated geometry.
    session.pty.resize(frame.cols, frame.rows);
    session.snapshots.resizeHeadless(frame.cols, frame.rows);
  }

  // -------------------------------------------------------------------------
  // VR.10 — runner raw-frame forwarding + SnapshotManager feeding
  // -------------------------------------------------------------------------

  /**
   * Forward a raw PTY-output frame received from an authenticated runner to every
   * operator watching the task, and feed the bytes to the SnapshotManager so the
   * byte-offset bookkeeping stays in sync with `session.log` (VR.10).
   *
   * The runner sends raw PTY bytes as `{ channel: "raw", data: <base64>, seq }`.
   * We re-use the same frame shape to forward to operators, preserving the seq
   * (byte offset) so operator clients' ACK counters line up.
   */
  private onRunnerRawFrame(frame: RawFrame, state: ClientState): void {
    const taskId = state.taskId!;
    const session = this.sessions.get(taskId);

    // Decode the base64 payload.
    const decoded = Buffer.from(frame.data, 'base64').toString('utf8');
    const byteLen = Buffer.from(frame.data, 'base64').byteLength;

    if (session) {
      // VR.10 — Feed the SnapshotManager so the byte-offset tracks session.log.
      session.snapshots.feed(decoded, byteLen);

      // Emit through the PTY proxy so operator clients that have called
      // attachPty (via onReconnect) receive the bytes through their
      // ptySubscription callbacks (which in turn call streamRawChunk).
      if (session.pty instanceof RunnerPtyProxy) {
        session.pty.emitData(decoded);
      }
    }

    // VR.3 — feed the IdleTracker.
    if (this.guardrails) {
      this.guardrails.recordActivity(taskId);
    }

    // Also directly stream to any operator watching this task who has NOT yet
    // called reconnect/attachPty (i.e. no ptySubscription set up yet). This
    // ensures they still receive live output from the moment they connect.
    for (const [socket, s] of this.clients) {
      if (
        s.kind === 'operator' &&
        s.authenticated &&
        s.ptySubscription === null &&
        (s.taskId === null || s.taskId === taskId)
      ) {
        this.streamRawChunk(decoded, socket, s);
      }
    }
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

/**
 * A proxy that wraps the runner's dial-back WebSocket as a `TerminalPty`
 * visible to the gateway (VR.10). It:
 *   - delivers PTY output via an event-emitter pattern (fed by `onRunnerRawFrame`
 *     rather than a local `child.onData` subscription, since the bytes arrive
 *     over the WS),
 *   - forwards `write` (keystrokes) to the runner as a `keystroke` control frame,
 *   - forwards `resize` to the runner as a `resize` control frame (VR.8),
 *   - forwards `pause`/`resume` to the runner as flow-control frames.
 */
class RunnerPtyProxy implements TerminalPty {
  private readonly dataListeners = new Set<(chunk: string) => void>();

  constructor(private readonly runnerSocket: WebSocket) {}

  onData(listener: (chunk: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  /** Called by the gateway when a raw frame arrives from the runner. */
  emitData(chunk: string): void {
    for (const listener of this.dataListeners) {
      listener(chunk);
    }
  }

  write(data: string): void {
    // Keystrokes forwarded via a keystroke control frame over the runner WS.
    // This is only called when the operator holds the write lease (7.5).
    const frame: KeystrokeFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'keystroke',
      sessionId: '',
      data: Buffer.from(data).toString('base64'),
    };
    this.sendToRunner(frame);
  }

  resize(cols: number, rows: number): void {
    // VR.8: forward the resize to the runner so the PTY matches the browser.
    const frame: ResizeFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'resize',
      cols,
      rows,
    };
    this.sendToRunner(frame);
  }

  pause(): void {
    const frame: PauseFrame = { channel: FRAME_CHANNEL.CONTROL, type: 'pause' };
    this.sendToRunner(frame);
  }

  resume(): void {
    const frame: ResumeFrame = { channel: FRAME_CHANNEL.CONTROL, type: 'resume' };
    this.sendToRunner(frame);
  }

  private sendToRunner(frame: ControlFrame): void {
    if (this.runnerSocket.readyState === this.runnerSocket.OPEN) {
      this.runnerSocket.send(JSON.stringify(frame));
    }
  }
}
