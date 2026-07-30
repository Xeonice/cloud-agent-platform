/**
 * @cap-console/api — realtime terminal WebSocket gateway.
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
 * protocol (5.3), and fresh viewer attachment, delegating connection-local
 * flow-control bookkeeping to {@link BackpressureController}.
 *
 * Under the CONNECT-IN model the orchestrator is the WebSocket *client* into each
 * task's sandbox: it dials the per-task AIO Sandbox terminal OUT via an
 * {@link SandboxTerminalSession} (registered through {@link openSession}), which becomes the
 * `TerminalSession.ownerPty` backend. There is no inbound runner dial-back — the only
 * inbound peers are operator console clients. The layers above the `TerminalPty`
 * seam (auth, lease, approval routing, attachment-local backpressure, recording,
 * guardrails) are unchanged by this inversion. The gateway layers on:
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
import {
  Inject,
  Logger,
  Optional,
  type OnApplicationShutdown,
} from '@nestjs/common';
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
  decodeCanonicalBase64Bytes,
  FRAME_CHANNEL,
  HIGH_WATER_MARK_BYTES,
  negotiateTerminalAttach,
  TERMINAL_PROTOCOL_VERSION,
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
  type ResizeFrame,
  type ResumeFrame,
  type TakeoverRequestFrame,
  type TerminalAttachFrame,
  type TerminalAttachOutcome,
  type TerminalAttachmentStateFrame,
  type TerminalGeometryFrame,
  type TerminalResponseFrame,
  parseAsciicastEvent,
  parseAsciicastHeader,
} from '@cap-console/contracts';
import {
  BackpressureController,
  type FlowSignal,
} from './backpressure';
import {
  SESSION_LOG_FILENAME,
  SESSION_CAST_FILENAME,
  readSessionLogTail,
  stripAnsi,
} from './snapshot';
import {
  readTerminalRecordingPolicy,
  TERMINAL_RAW_RECORDING_TRUNCATION_TEXT,
  type TerminalRecordingPolicy,
} from '@/session-recording/recording-policy';
import {
  TerminalQueryObserver,
  type TerminalQueryExpectation,
  type TerminalQueryObserverOptions,
} from './terminal-query-observer';
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
  aggregateTerminalCleanupSettlements,
  buildSandboxTerminalViewerAttachmentFactory,
  normalizeTerminalCleanupDecision,
  openSandboxTerminalPty,
  SandboxRuntimeModelSetupError,
  type SandboxResolvedTaskLaunchContext,
  type SandboxTerminalExitStatus,
  type SandboxTerminalPtyMode,
  type TerminalTransportWriteOutcome,
  type TerminalTransportCleanupSettlement,
  type TerminalViewerAttachment,
  type TerminalViewerAttachmentFactory,
  type TerminalViewerAttachmentOutcome,
} from '@cap-console/sandbox';
import type { SelectedSandboxRun } from '@cap-console/sandbox';
import type { SandboxConnection } from '@/sandbox/sandbox-provider.port';
// add-claude-code-runtime Track 3 (3.2): the gateway resolves the task's selected
// AgentRuntime (Track 2's RuntimeRegistry) and threads it into the SandboxTerminalSession so
// the launch / autosubmit / exit-detection seams dispatch to it. Optional injection
// — when no registry is wired (focused transport unit context) the bridge defaults
// to the codex inline path, so nothing about the codex flow changes.
import {
  RUNTIME_REGISTRY,
  type AgentRuntime,
  type RuntimeRegistry,
} from '@/agent-runtime/agent-runtime.integration';
import type { ExecutionMode } from '@/agent-runtime/agent-runtime.port';
import { WriteLockService } from '@/write-lock/write-lock.service';
// Connect-time operator SESSION authentication (replaces
// the AUTH_TOKEN-only operator check). `resolveOperatorPrincipal` is the shared,
// transport-agnostic decision point (also used by the REST guard), and it performs
// the constant-time legacy-bearer comparison internally, so the gateway needs no
// direct `constantTimeEqual` import.
import { AuthSessionService } from '@/auth/auth-session.service';
import {
  resolveOperatorPrincipal,
  type OperatorPrincipal,
  type PrincipalKind,
} from '@/principal/operator-principal';
import { readCookie, SESSION_COOKIE_NAME } from '@/auth/session-token';
import { GuardrailsService } from '@/guardrails/guardrails.service';
import {
  PROVISION_LOOKUP,
  type ProvisionLookup,
  type TaskLaunchContext,
} from '@/provision-lookup/provision-lookup.port';
import { stableJson } from '@/runtime-models/runtime-model-catalog.util';
import { TerminalDiagnosticsMetricsService } from '@/metrics/terminal-diagnostics-metrics.service';

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
   * {@link SandboxTerminalSession} provides it.
   */
  close?(): void;
}

/**
 * The per-task server-side terminal session. The owner PTY remains the sole
 * lifecycle/recording source; every browser gets a disposable, independently
 * opened viewer attachment from `viewerFactory`.
 */
export interface TerminalSession {
  readonly taskId: string;
  readonly ownerPty: TerminalPty;
  readonly viewerFactory: TerminalViewerAttachmentFactory;
  readonly geometry: MutableTerminalGeometry;
  /** Await before settling durable admission success and releasing launch authority. */
  readonly launchDecision: Promise<AgentTerminalLaunchOutcome>;
}

interface MutableTerminalGeometry {
  cols: number;
  rows: number;
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
 * Sanitized, story-only evidence emitted at the CAP Gateway/provider boundary.
 *
 * The provider-backed verification story needs to distinguish bytes merely sent
 * by a browser from bytes that actually crossed the Gateway's provider-write
 * seam.  These events intentionally contain no provider URL, token, sandbox id,
 * principal, or terminal output payload.  Exact input/response bytes are base64
 * because they are opaque and may not be valid UTF-8.
 */
export type ProviderTerminalStoryTelemetryEvent =
  | {
      readonly type: 'attachment_state';
      readonly taskId: string;
      readonly attachmentId: string;
      readonly state: AttachmentStateDetails['state'];
      readonly reason?: string;
      readonly cols: number;
      readonly rows: number;
    }
  | {
      readonly type: 'viewer_opened' | 'viewer_closed';
      readonly taskId: string;
      readonly attachmentId: string;
    }
  | {
      readonly type: 'query';
      readonly taskId: string;
      readonly attachmentId: string;
      readonly queryId: number | null;
      readonly responseClass: string;
      readonly parameters: Readonly<Record<string, string | number | boolean>>;
      readonly bytesBase64: string;
      readonly admitted: boolean;
    }
  | {
      readonly type: 'response';
      readonly taskId: string;
      readonly attachmentId: string;
      readonly bytesBase64: string;
      readonly accepted: boolean;
      readonly responseClass?: string;
      readonly reason?: string;
    }
  | {
      readonly type: 'provider_write';
      readonly taskId: string;
      readonly attachmentId: string;
      readonly source: 'keystroke' | 'terminal_response';
      readonly bytesBase64: string;
      readonly outcome: TerminalTransportWriteOutcome | 'threw';
    }
  | {
      readonly type: 'resize';
      readonly taskId: string;
      readonly attachmentId: string;
      readonly cols: number;
      readonly rows: number;
      readonly authoritative: boolean;
    };

export interface ProviderTerminalStoryTelemetryObserver {
  onEvent(event: ProviderTerminalStoryTelemetryEvent): void;
}

export interface ProviderTerminalStoryGatewayResourceState {
  readonly ownerRegistered: boolean;
  readonly activeViewerCount: number;
}

/**
 * What kind of peer is on the other end of a connection. Under the connect-in
 * model the only inbound peers are operator console clients; the orchestrator
 * dials sandboxes OUT via {@link SandboxTerminalSession}, so there is no inbound runner.
 */
type ConnectionKind = 'operator';

type AttachmentPhase = 'unattached' | 'attaching' | 'attached' | 'closed';

/** Canonical non-secret subset retained after a credential resolves. */
interface PrincipalIdentity {
  readonly kind: PrincipalKind;
  readonly userId: string | null;
  readonly keyId: string | null;
}

interface FrozenClientBinding {
  readonly principalIdentity: PrincipalIdentity;
  readonly boundTaskId: string;
  readonly generation: number;
}

type AttachmentStateDetails =
  | { readonly state: 'attaching' | 'ready' }
  | {
      readonly state: 'unavailable';
      readonly reason:
        | 'session_absent'
        | 'session_indeterminate'
        | 'viewer_limit'
        | 'provider_unavailable';
      readonly reloadRequired: false;
    }
  | {
      readonly state: 'failed';
      readonly reason:
        | 'provider_failed'
        | 'attach_timeout'
        | 'transport_closed'
        | 'internal_error';
      readonly reloadRequired: false;
    };

/** Per-connected-client state held by the gateway. */
interface ClientState {
  readonly clientId: string;
  /** Operator console client (the only inbound connection kind). */
  kind: ConnectionKind;
  /** True once the connection has passed its auth/handshake gate. */
  authenticated: boolean;
  /** Stable identity from the latest successful pre-attach authentication. */
  principalIdentity: PrincipalIdentity | null;
  /** Mutable only while unattached; terminal_attach freezes it into `binding`. */
  requestedTaskId: string | null;
  phase: AttachmentPhase;
  binding: FrozenClientBinding | null;
  generation: number;
  authAttemptEpoch: number;
  abortController: AbortController | null;
  attachment: TerminalViewerAttachment | null;
  attachmentSubscriptions: Array<{ dispose(): void }>;
  /** Backpressure controller for this client's view of the raw stream. */
  readonly backpressure: BackpressureController;
  /** Cumulative byte offset of raw output sent to this client. */
  sentBytes: number;
  desiredGeometry: MutableTerminalGeometry;
  /** Generation-local transparent parser + terminal-response authorization. */
  queryObserver: TerminalQueryObserver | null;
  /** Metrics-only idempotence; contains no task/viewer/provider identity. */
  metricsAttachAttempted: boolean;
  metricsAttachOutcomeRecorded: boolean;
  metricsViewerActive: boolean;
  metricsViewerPaused: boolean;
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

interface SessionLogState {
  readonly logPath: string;
  tail: Promise<void>;
  ensured: boolean;
  reservedBytes: number;
  readonly maxBytes: number;
  pendingWrites: number;
  readonly maxPendingWrites: number;
  truncated: boolean;
}

interface SessionCastState {
  readonly castPath: string;
  tail: Promise<void>;
  startMs: number;
  ready: boolean;
  reservedBytes: number;
  readonly maxBytes: number;
  pendingWrites: number;
  readonly maxPendingWrites: number;
  truncated: boolean;
}

interface ResizeRepaintSuppressionState {
  quietTimer?: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
}

interface CastResumeState {
  readonly hasHeader: boolean;
  readonly hasBytes: boolean;
  readonly lastTimeSec: number;
  readonly sizeBytes: number;
}

type TerminalCleanupSource = 'owner' | 'viewer';

interface TrackedTerminalCleanup {
  readonly source: TerminalCleanupSource;
  readonly decision: Promise<TerminalTransportCleanupSettlement>;
  metricsOutcomeRecorded: boolean;
}

type BoundedTerminalCleanupResult =
  | {
      readonly kind: 'settled';
      readonly source: TerminalCleanupSource;
      readonly settlement: TerminalTransportCleanupSettlement;
    }
  | {
      readonly kind: 'timeout';
      readonly source: TerminalCleanupSource;
    };

/**
 * Secret-free graceful-shutdown evidence. Provider identity values never leave
 * their adapters; this summary exposes only bounded source and identity counts.
 */
export interface TerminalGatewayShutdownCleanupSummary {
  readonly kind: 'confirmed' | 'indeterminate';
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly closedClientCount: number;
  readonly closedSessionCount: number;
  readonly sourceCount: number;
  readonly ownerSourceCount: number;
  readonly viewerSourceCount: number;
  readonly confirmedSourceCount: number;
  readonly indeterminateSourceCount: number;
  readonly timedOutSourceCount: number;
  readonly expectedIdentities: number;
  readonly observedIdentities: number;
  readonly confirmedIdentities: number;
  readonly deletedIdentities: number;
  readonly alreadyAbsentIdentities: number;
  readonly causes: {
    readonly identityUnavailable: number;
    readonly cleanupUnsupported: number;
    readonly cleanupUnconfirmed: number;
    readonly timeout: number;
  };
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
const DEFAULT_TERMINAL_COLUMNS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
export const DEFAULT_TERMINAL_VIEWER_LIMIT_PER_TASK = 8;
export const MAX_TERMINAL_VIEWER_LIMIT_PER_TASK = 64;
const DEFAULT_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS = 12_000;
const MAX_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS = 120_000;
// AIO's exact main/injector release alone has a 20 s bounded protocol, followed
// by provider-session and encrypted ownership-journal deletion. Their complete
// fail-closed envelope is just under 30 s, so retain scheduler/network margin
// inside the process-level 40 s graceful-stop window.
export const DEFAULT_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS = 35_000;
export const MAX_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS = 35_000;

type TerminalQueryRuntimeConfig = Pick<
  TerminalQueryObserverOptions,
  'ttlMs' | 'capacity' | 'responseRateLimit' | 'responseRateWindowMs'
>;

function readDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readBoundedPositiveIntegerEnv(
  name: string,
  fallback: number,
  hardMax: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > hardMax) {
    throw new RangeError(`${name} must be an integer in [1, ${hardMax}]`);
  }
  return value;
}

/** Preserve invalid numeric values so the observer's hard-bound validator rejects them. */
function readOptionalNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return Number(raw);
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
  implements OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown
{
  private readonly logger = new Logger(TerminalGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Connected clients keyed by socket. */
  private readonly clients = new Map<WebSocket, ClientState>();

  /**
   * Gateway-owned close fence for disposable viewers.  Abort, policy failure,
   * timeout, and the late async continuation can all observe the same handle;
   * only the first path is allowed to invoke the provider close operation.
   */
  private readonly closedViewerAttachments =
    new WeakSet<TerminalViewerAttachment>();

  /** Cleanup decisions that have not yet settled at the API boundary. */
  private readonly pendingTerminalCleanups = new Set<TrackedTerminalCleanup>();

  /** Active terminal sessions keyed by task id. */
  private readonly sessions = new Map<string, TerminalSession>();

  /**
   * Opt-in observers registered only by the local provider-backed story.
   * Keeping this empty in normal operation makes the production hot path a
   * single map lookup and prevents verification-only inventories from becoming
   * a general terminal logging surface.
   */
  private readonly providerStoryObservers = new Map<
    string,
    Set<ProviderTerminalStoryTelemetryObserver>
  >();

  /** Owner recording subscriptions, separate from every browser attachment. */
  private readonly ownerSubscriptions = new Map<
    string,
    { dispose(): void }
  >();

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
   * Explicitly opted-in `session.log` append state. Native live rendering,
   * activity, runtime classification, and exit settlement never depend on this
   * map. Synchronous byte reservation happens before a write is enqueued so a
   * slow disk cannot turn the promise chain into an unbounded heap backlog.
   */
  private readonly sessionLogs = new Map<string, SessionLogState>();

  /**
   * Explicitly opted-in, independently bounded `session.cast` append state.
   * It deliberately does not share the session.log gate or tail chain.
   */
  private readonly sessionCasts = new Map<
    string,
    SessionCastState
  >();

  /** Resize events accepted before async interactive-cast activation completes. */
  private readonly pendingCastResizeEvents = new Map<string, string[]>();

  /**
   * Resize-triggered terminal repaints are current-screen redraws, not new agent
   * output. Keep them live-only so durable history remains a linear transcript.
   */
  private readonly resizeRepaintSuppressions = new Map<
    string,
    ResizeRepaintSuppressionState
  >();

  /**
   * Bounded owner-output evidence used by runtime classification and exit-detail
   * audit even when both raw artifacts are disabled.
   */
  private readonly runtimeFailureBuffers = new Map<string, string>();
  private readonly runtimeFailureChecks = new Set<string>();
  private readonly runtimeFailuresReported = new Set<string>();
  private readonly runtimeFailureRuntimes = new Map<string, AgentRuntime>();

  private readonly viewerLimitPerTask: number;
  private readonly viewerAttachTimeoutMs: number;
  private readonly shutdownCleanupTimeoutMs: number;
  private readonly terminalQueryConfig: TerminalQueryRuntimeConfig;
  private readonly terminalRecordingPolicy: TerminalRecordingPolicy;

  private shuttingDown = false;
  private shutdownCleanupPromise?: Promise<TerminalGatewayShutdownCleanupSummary>;

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
    // the SandboxTerminalSession's launch/exit seams.
    @Optional() @Inject(RUNTIME_REGISTRY) private readonly runtimes?: RuntimeRegistry,
    @Optional() @Inject(PROVISION_LOOKUP) private readonly provisionLookup?: ProvisionLookup,
    @Optional()
    @Inject(TerminalDiagnosticsMetricsService)
    private readonly terminalMetrics?: TerminalDiagnosticsMetricsService,
  ) {
    this.terminalRecordingPolicy = readTerminalRecordingPolicy();
    this.viewerLimitPerTask = readBoundedPositiveIntegerEnv(
      'CAP_TERMINAL_VIEWER_LIMIT_PER_TASK',
      DEFAULT_TERMINAL_VIEWER_LIMIT_PER_TASK,
      MAX_TERMINAL_VIEWER_LIMIT_PER_TASK,
    );
    this.viewerAttachTimeoutMs = readBoundedPositiveIntegerEnv(
      'CAP_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS',
      DEFAULT_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS,
      MAX_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS,
    );
    this.shutdownCleanupTimeoutMs = readBoundedPositiveIntegerEnv(
      'CAP_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS',
      DEFAULT_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS,
      MAX_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS,
    );
    // Keep raw numeric parsing separate from validation. A bad deployment value
    // must fail the native attachment before provider open, not silently fall
    // back to a more permissive default or take down unrelated API surfaces.
    this.terminalQueryConfig = {
      ttlMs: readOptionalNumberEnv('CAP_TERMINAL_QUERY_TTL_MS'),
      capacity: readOptionalNumberEnv('CAP_TERMINAL_QUERY_CAPACITY'),
      responseRateLimit: readOptionalNumberEnv(
        'CAP_TERMINAL_RESPONSE_RATE_LIMIT',
      ),
      responseRateWindowMs: readOptionalNumberEnv(
        'CAP_TERMINAL_RESPONSE_RATE_WINDOW_MS',
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Session registry — one owner PTY plus a repeatable viewer factory per task.
  // -------------------------------------------------------------------------

  /** Register a task's terminal session so clients can stream it. */
  registerSession(session: TerminalSession): void {
    if (this.shuttingDown) {
      this.trackTerminalCleanup(
        'owner',
        typeof session.ownerPty.close === 'function'
          ? session.ownerPty.cleanupDecision
          : undefined,
      );
      try {
        session.ownerPty.close?.();
      } catch {
        this.logger.warn(
          'terminal owner close threw after shutdown had started',
        );
      }
      return;
    }
    const previous = this.sessions.get(session.taskId);
    if (previous && previous !== session) {
      this.unregisterSession(session.taskId);
    }
    this.sessions.set(session.taskId, session);
  }

  /** Register bounded evidence collection for one explicitly enabled story task. */
  observeProviderTerminalStory(
    taskId: string,
    observer: ProviderTerminalStoryTelemetryObserver,
  ): { dispose(): void } {
    const observers = this.providerStoryObservers.get(taskId) ?? new Set();
    observers.add(observer);
    this.providerStoryObservers.set(taskId, observers);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        observers.delete(observer);
        if (observers.size === 0) this.providerStoryObservers.delete(taskId);
      },
    };
  }

  /** Exact, non-provider-specific cleanup evidence used after story teardown. */
  getProviderTerminalStoryResourceState(
    taskId: string,
  ): ProviderTerminalStoryGatewayResourceState {
    return {
      ownerRegistered: this.sessions.has(taskId),
      activeViewerCount: this.viewerCount(taskId),
    };
  }

  /**
   * Compatibility seam retained for Guardrails. Prefer the bounded live owner
   * evidence; only an explicitly enabled legacy/raw log falls back to disk.
   * This keeps failure classification independent from multi-gigabyte history.
   */
  async readSessionLogTail(taskId: string): Promise<string> {
    const evidence = this.runtimeFailureBuffers.get(taskId);
    if (evidence !== undefined) {
      return formatFailureEvidenceTail(evidence);
    }
    if (!this.terminalRecordingPolicy.sessionLog.enabled) return '';
    await this.flushSessionLog(taskId);
    return readSessionLogTail(resolveWorkspaceDir(taskId));
  }

  unregisterSession(taskId: string): void {
    const session = this.sessions.get(taskId);
    // Remove the session first. Every asynchronous viewer continuation checks
    // this identity before touching a provider attachment.
    this.sessions.delete(taskId);
    this.ownerSubscriptions.get(taskId)?.dispose();
    this.ownerSubscriptions.delete(taskId);
    for (const [client, state] of this.clients) {
      if (state.binding?.boundTaskId !== taskId || state.phase === 'closed') continue;
      this.writeLock?.releaseOnDisconnect(taskId, state.clientId);
      this.recordTerminalAttachOutcome(state, 'session_absent');
      this.sendAttachmentState(client, state, {
        state: 'unavailable',
        reason: 'session_absent',
        reloadRequired: false,
      });
      this.invalidateAttachment(state);
    }
    // 4.3 — release the bridge BEFORE dropping the session so a re-adopted (or
    // freshly-launched) task that ends drives the normal `onTerminal`/`recordExit`
    // path EXACTLY ONCE. `unregisterSession` is only reached from a TERMINAL
    // teardown (`onTerminal` after a clean exit, or a `forceFail` backstop after a
    // deadline/idle/circuit trip), at which point the task is already transitioned.
    // Closing the `SandboxTerminalSession` here stops its liveness poller + outbound WS, so a
    // poller that is still armed (a `forceFail` stopped the sandbox while the WS was
    // attached) cannot observe the now-gone session and fire a SECOND
    // `onSessionExit` → `recordExit`. `close()` is the D5 release-without-terminate
    // path: it never resolves an exit, so it is safe to call after the transition.
    // Idempotent: the bridge guards its own teardown; a missing `close` (transport
    // fake) is a no-op.
    if (session) {
      this.trackTerminalCleanup(
        'owner',
        typeof session.ownerPty.close === 'function'
          ? session.ownerPty.cleanupDecision
          : undefined,
      );
      try {
        session.ownerPty.close?.();
      } catch {
        this.logger.warn(`task ${taskId}: terminal owner close threw`);
      }
    }
    // Keep a final queued append discoverable until it settles so an immediate
    // failure-audit read can await the decisive last owner chunk.
    const logEntry = this.sessionLogs.get(taskId);
    if (logEntry) {
      void logEntry.tail.finally(() => {
        if (this.sessionLogs.get(taskId) === logEntry) {
          this.sessionLogs.delete(taskId);
        }
      });
    }
    // session-terminal-replay — drop the cast append state too (the session.cast
    // file persists on the volume for replay, like session.log).
    this.sessionCasts.delete(taskId);
    this.pendingCastResizeEvents.delete(taskId);
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

  /**
   * Nest shutdown hook: close every API-owned terminal bridge without touching
   * the detached task sessions, then wait only within the configured hard bound
   * for provider cleanup evidence.
   */
  async onApplicationShutdown(): Promise<void> {
    const summary = await this.shutdownTerminalResources();
    const evidence = JSON.stringify(summary);
    if (summary.kind === 'confirmed') {
      this.logger.log(`terminal cleanup settled ${evidence}`);
    } else {
      this.logger.warn(`terminal cleanup indeterminate ${evidence}`);
    }
  }

  /** Public for deterministic lifecycle verification; idempotent per process. */
  shutdownTerminalResources(): Promise<TerminalGatewayShutdownCleanupSummary> {
    if (!this.shutdownCleanupPromise) {
      this.shutdownCleanupPromise = this.performTerminalShutdownCleanup();
    }
    return this.shutdownCleanupPromise;
  }

  private async performTerminalShutdownCleanup(): Promise<TerminalGatewayShutdownCleanupSummary> {
    const startedAt = Date.now();
    this.shuttingDown = true;
    const closedClientCount = this.clients.size;
    const closedSessionCount = this.sessions.size;

    // Unregistering removes each task before aborting its viewers, so no close
    // callback can re-grant a write lease or reopen provider work during drain.
    for (const taskId of [...this.sessions.keys()]) {
      this.unregisterSession(taskId);
    }
    for (const [client, state] of [...this.clients]) {
      this.invalidateAttachment(state);
      this.clients.delete(client);
      try {
        client.close(1001, 'terminal gateway shutting down');
      } catch {
        // The WebSocket server may already have closed this peer.
      }
    }
    this.providerStoryObservers.clear();

    // No awaited work occurs before this snapshot. Consequently immediately
    // resolved decisions registered by close() are still included, while prior
    // fully settled resources have already left the pending set.
    const cleanups = [...this.pendingTerminalCleanups];
    const results = await Promise.all(
      cleanups.map((cleanup) =>
        waitForTerminalCleanup(
          cleanup,
          this.shutdownCleanupTimeoutMs,
        ),
      ),
    );
    results.forEach((result, index) => {
      this.recordTerminalCleanupOutcome(
        cleanups[index]!,
        result.kind === 'timeout' ? 'indeterminate' : result.settlement.kind,
      );
    });
    const settled = results.filter(
      (result): result is Extract<
        BoundedTerminalCleanupResult,
        { kind: 'settled' }
      > => result.kind === 'settled',
    );
    const aggregate = aggregateTerminalCleanupSettlements(
      settled.map(({ settlement }) => settlement),
    );
    const timedOutSourceCount = results.length - settled.length;
    const confirmedSourceCount = settled.filter(
      ({ settlement }) => settlement.kind === 'confirmed',
    ).length;
    const indeterminateSettlements = settled
      .map(({ settlement }) => settlement)
      .filter(
        (settlement): settlement is Extract<
          TerminalTransportCleanupSettlement,
          { kind: 'indeterminate' }
        > => settlement.kind === 'indeterminate',
      );
    const indeterminateSourceCount = indeterminateSettlements.length;

    return {
      kind:
        timedOutSourceCount === 0 && indeterminateSourceCount === 0
          ? 'confirmed'
          : 'indeterminate',
      timeoutMs: this.shutdownCleanupTimeoutMs,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      closedClientCount,
      closedSessionCount,
      sourceCount: results.length,
      ownerSourceCount: results.filter(({ source }) => source === 'owner').length,
      viewerSourceCount: results.filter(({ source }) => source === 'viewer').length,
      confirmedSourceCount,
      indeterminateSourceCount,
      timedOutSourceCount,
      expectedIdentities: aggregate.expectedIdentities,
      observedIdentities: aggregate.observedIdentities,
      confirmedIdentities: aggregate.confirmedIdentities,
      deletedIdentities: aggregate.deletedIdentities,
      alreadyAbsentIdentities: aggregate.alreadyAbsentIdentities,
      causes: {
        identityUnavailable: indeterminateSettlements.filter(
          ({ cause }) => cause === 'identity-unavailable',
        ).length,
        cleanupUnsupported: indeterminateSettlements.filter(
          ({ cause }) => cause === 'cleanup-unsupported',
        ).length,
        cleanupUnconfirmed: indeterminateSettlements.filter(
          ({ cause }) => cause === 'cleanup-unconfirmed',
        ).length,
        timeout: timedOutSourceCount,
      },
    };
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
   * client; the orchestrator dials sandboxes OUT via {@link SandboxTerminalSession}, so
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
    if (this.shuttingDown) {
      try {
        client.close(1001, 'terminal gateway shutting down');
      } catch {
        // The server may already have closed this socket.
      }
      return;
    }
    const clientId = `c${this.nextClientId++}`;
    const url = this.parseUrl(request);

    const state: ClientState = {
      clientId,
      kind: 'operator',
      authenticated: false,
      principalIdentity: null,
      requestedTaskId: null,
      phase: 'unattached',
      binding: null,
      generation: 0,
      authAttemptEpoch: 0,
      abortController: null,
      attachment: null,
      attachmentSubscriptions: [],
      backpressure: new BackpressureController(),
      sentBytes: 0,
      desiredGeometry: {
        cols: DEFAULT_TERMINAL_COLUMNS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
      queryObserver: null,
      metricsAttachAttempted: false,
      metricsAttachOutcomeRecorded: false,
      metricsViewerActive: false,
      metricsViewerPaused: false,
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
    const taskId = url?.searchParams.get('taskId') ?? null;
    const authEpoch = ++state.authAttemptEpoch;
    void this.authenticateOperator({ cookieToken, presentedToken: presented }).then((principal) => {
      if (!this.clients.has(client)) return; // disconnected mid-resolution
      if (authEpoch !== state.authAttemptEpoch || state.phase !== 'unattached') return;
      if (!principal) {
        this.logger.warn(`client ${clientId}: operator auth failed; closing`);
        this.failAuthentication(client, state);
        return;
      }
      state.authenticated = true;
      state.principalIdentity = principalIdentityOf(principal);
      state.requestedTaskId = taskId;
      this.logger.debug(`client ${clientId} authenticated as operator`);
    });

    this.logger.debug(`client ${clientId} connected as ${state.kind}`);
  }

  handleDisconnect(client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state) return;
    this.invalidateAttachment(state);
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
      // via {@link SandboxTerminalSession}'s onData, not as an inbound raw frame, so there
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
   * client; the orchestrator dials sandboxes OUT via {@link SandboxTerminalSession}, so
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
      case 'terminal_attach':
        this.onTerminalAttach(frame, client, state);
        break;
      case 'terminal_response':
        this.onTerminalResponse(frame, client, state);
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
      // `permission_request` is not accepted from an operator WebSocket. The
      // isolated compatibility callback may call `onPermissionRequest` directly;
      // current bypass-mode sandbox images do not register a hook caller.
      case 'decision':
        this.onDecision(frame, client, state);
        break;
      case 'resize':
        this.onResize(frame, state);
        break;
      case 'permission_request':
      case 'post_tool_use_report':
        // These task-scoped frames are server/compatibility-callback inputs,
        // never operator-WebSocket inputs. Check the frozen binding first so a
        // cross-task attempt is rejected by the same boundary as keystrokes and
        // heartbeats, then close even a same-task direction violation.
        if (!this.requireBoundTask(frame.taskId, client, state)) return;
        this.failPolicyViolation(
          client,
          state,
          `${frame.type} is not accepted from an operator WebSocket`,
        );
        break;
      case 'lease_state':
        if (!this.requireBoundTask(frame.sessionId, client, state)) return;
        this.failPolicyViolation(
          client,
          state,
          'lease_state is server-only',
        );
        break;
      case 'pause':
      case 'resume':
      case 'terminal_attachment_state':
      case 'terminal_geometry':
        this.failPolicyViolation(
          client,
          state,
          `${frame.type} is server-only`,
        );
        break;
      default:
        // Exhaustiveness fallback for future contract variants. They stay inert
        // until their direction and frozen-binding rules are defined explicitly.
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
  }): Promise<OperatorPrincipal | null> {
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
    if (sessionToken === null && bearerToken === null) return null;
    const credentials = { sessionToken, bearerToken };
    // Route through the shared resolver so the WS surface cannot drift from REST
    // on prefix dispatch (cap_sk_ api-key / reserved mcp_), the session re-check,
    // or the constant-time legacy AUTH_TOKEN compare. The same single presented
    // token fills both candidate slots; prefix dispatch (the FIRST step) ensures a
    // cap_sk_/mcp_ token here never falls into a Session lookup.
    return resolveOperatorPrincipal(credentials, {
      resolveSession: (token) =>
        this.authSession ? this.authSession.resolveSession(token) : Promise.resolve(null),
      resolveApiKey: (raw) =>
        this.authSession ? this.authSession.resolveApiKey(raw) : Promise.resolve(null),
      // No MCP resolver bound: the `mcp_` slot fails closed (denyMcpResolver).
    });
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
    const currentTaskId = this.clientTaskId(state);
    if (
      state.phase !== 'unattached' &&
      frame.taskId !== undefined &&
      frame.taskId !== currentTaskId
    ) {
      this.failPolicyViolation(
        client,
        state,
        'connect_auth cannot retarget an accepted terminal attachment',
      );
      return;
    }

    const targetTaskId = frame.taskId ?? currentTaskId;
    const authEpoch = ++state.authAttemptEpoch;
    // connect_auth carries the token explicitly in the frame (no cookie context).
    const principal = await this.authenticateOperator({
      cookieToken: null,
      presentedToken: frame.token,
    });
    if (!this.clients.has(client)) return; // disconnected mid-resolution
    if (authEpoch !== state.authAttemptEpoch || state.phase === 'closed') return;
    if (!principal) {
      this.failAuthentication(client, state);
      return;
    }

    const identity = principalIdentityOf(principal);
    if (state.binding) {
      if (
        !samePrincipalIdentity(identity, state.binding.principalIdentity) ||
        targetTaskId !== state.binding.boundTaskId
      ) {
        this.failPolicyViolation(
          client,
          state,
          'connect_auth principal/task changed after terminal attachment acceptance',
        );
      }
      return;
    }

    state.authenticated = true;
    state.principalIdentity = identity;
    state.requestedTaskId = targetTaskId;
  }

  // -------------------------------------------------------------------------
  // Connect-in session open — handle-driven session registration seam.
  // -------------------------------------------------------------------------

  /**
   * Open a task's terminal session under the connect-in model. The caller
   * (`GuardrailsService.startRunning`, which resolves this gateway lazily by
   * `TERMINAL_GATEWAY_TOKEN` and calls `openSession` after `provision()`, 4.2)
   * hands the {@link SandboxConnection} returned by `provision()`; this gateway
   * dials the sandbox terminal OUT by constructing an {@link SandboxTerminalSession} to
   * `connection.wsUrl`, retains it as the task owner, and registers a repeatable
   * viewer factory. Browser reconnect never consumes owner bytes or durable log
   * history; it opens a fresh attach-only provider PTY instead. Idempotent for an
   * already-open task.
   *
   * Create-vs-attach (survive-api-redeploy D2 / 2.5): the {@link SandboxTerminalSession} is
   * opened in `'launch-or-attach'` mode, so once the AIO shell is `ready` it probes
   * whether the detached session `task<taskId>` is already alive — ATTACHING to a
   * still-running codex (operator reconnect / freshly-booted api re-adoption) or
   * launching a FRESH detached session as the fallback. This single seam serves
   * both first launch and re-adoption.
   *
   * Exit detection (D4): a WS close NO LONGER terminates the task — it only
   * detaches; the detached codex keeps running for re-adoption. The `SandboxTerminalSession`
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
    if (this.shuttingDown) {
      throw new Error('terminal gateway is shutting down');
    }
    const { taskId } = connection;
    const existing = this.sessions.get(taskId);
    if (existing) return existing;

    const workspaceDir = resolveWorkspaceDir(taskId);
    const viewerFactory = buildSandboxTerminalViewerAttachmentFactory({
      taskId,
      connection,
      selectedRun,
    });
    const ownerPty = openSandboxTerminalPty({
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
      ownerPty,
      viewerFactory,
      geometry: {
        cols: DEFAULT_TERMINAL_COLUMNS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
      launchDecision: ownerPty.launchDecision,
    };
    this.registerSession(session);
    // Full raw terminal artifacts are diagnostics opt-ins. Their absence does
    // not affect the owner lifecycle, bounded failure evidence, or browser PTYs.
    if (
      this.terminalRecordingPolicy.sessionLog.enabled &&
      !this.sessionLogs.has(taskId)
    ) {
      const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
      this.sessionLogs.set(taskId, {
        logPath,
        tail: Promise.resolve(),
        ensured: false,
        reservedBytes: existingFileSize(logPath),
        maxBytes: this.terminalRecordingPolicy.sessionLog.maxBytes,
        pendingWrites: 0,
        maxPendingWrites: this.terminalRecordingPolicy.maxPendingWrites,
        truncated: false,
      });
    }
    if (this.terminalRecordingPolicy.sessionCast.enabled) {
      this.initCast(
        taskId,
        workspaceDir,
        session.geometry.cols,
        session.geometry.rows,
      );
    }
    // Owner output is lifecycle/recording/classification only. Browser output is
    // sourced exclusively from each connection's disposable viewer attachment.
    this.ownerSubscriptions.set(
      taskId,
      ownerPty.onData((chunk, meta) => this.onPtyOutput(taskId, chunk, meta)),
    );
    this.logger.debug(`task ${taskId}: opened sandbox terminal session`);
    return session;
  }

  private async resolveTaskLaunchContext(
    taskId: string,
    selectedRun?: SelectedSandboxRun | null,
  ): Promise<SandboxResolvedTaskLaunchContext> {
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
   * rejected promise all resolve to `undefined`, which the {@link SandboxTerminalSession}
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
   * Invoked when an {@link SandboxTerminalSession} resolves a task's exit status because its
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
    client: WebSocket,
    state: ClientState,
  ): void {
    if (!this.requireBoundTask(frame.sessionId, client, state)) return;
    if (state.phase !== 'attached' || !state.attachment) return;
    if (!this.writeLock) return;
    // Gate: only the lease holder may forward raw input to the PTY.
    if (!this.writeLock.isWriter(frame.sessionId, state.clientId)) {
      return;
    }
    const input = decodeCanonicalBase64Bytes(frame.data);
    const session = this.sessions.get(frame.sessionId);
    if (!session || !state.queryObserver) {
      this.failAttachment(client, state, 'internal_error');
      return;
    }
    // This never grants write authority: the lease check above already did so.
    // It only consumes a matching query token before the one original burst is
    // written, preventing a response carried on the human path from being replayed
    // later through the lease-independent terminal_response path.
    try {
      state.queryObserver.accountForWriterBurst(input, session.geometry);
    } catch {
      this.failAttachment(client, state, 'internal_error');
      return;
    }
    // A real operator keystroke is a hard boundary after a resize repaint: any
    // subsequent PTY output is user/agent activity and must re-enter durable
    // history so a refresh/reconnect cannot skip it.
    if (input.byteLength > 0) {
      this.endResizeRepaintSuppression(frame.sessionId);
    }
    let outcome: TerminalTransportWriteOutcome;
    try {
      outcome = state.attachment.write(input);
    } catch {
      this.emitProviderStoryEvent(frame.sessionId, {
        type: 'provider_write',
        taskId: frame.sessionId,
        attachmentId: this.providerStoryAttachmentId(state),
        source: 'keystroke',
        bytesBase64: Buffer.from(
          input.buffer,
          input.byteOffset,
          input.byteLength,
        ).toString('base64'),
        outcome: 'threw',
      });
      this.failAttachment(client, state, 'provider_failed');
      return;
    }
    this.emitProviderStoryEvent(frame.sessionId, {
      type: 'provider_write',
      taskId: frame.sessionId,
      attachmentId: this.providerStoryAttachmentId(state),
      source: 'keystroke',
      bytesBase64: Buffer.from(
        input.buffer,
        input.byteOffset,
        input.byteLength,
      ).toString('base64'),
      outcome,
    });
    this.handleViewerWriteOutcome(outcome, client, state);
    // VR.3 — operator input is activity: reset the idle window so an operator
    // actively driving codex keeps the task alive even between codex outputs.
    this.guardrails?.recordActivity(frame.sessionId);
  }

  /** Renew the write lease for a heartbeat from the current holder (7.2). */
  private onHeartbeat(
    frame: HeartbeatFrame,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (!this.requireBoundTask(frame.sessionId, client, state)) return;
    // The socket's server-assigned ClientState identity is authoritative. The
    // legacy browser `writerClientId` field is validated syntactically but never
    // trusted for lease selection or task routing.
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
    let reacquired = false;
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
      reacquired = true;
    }
    if (reacquired) {
      this.applyAuthoritativeGeometry(frame.sessionId, state.desiredGeometry);
    }
    this.broadcastLeaseState(frame.sessionId);
  }

  /**
   * Preemptive takeover (7.4): a reader seizes the lease, demoting the prior
   * holder. The lock-independent approval path is unaffected by lease ownership.
   */
  private onTakeover(
    frame: TakeoverRequestFrame,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (!this.requireBoundTask(frame.sessionId, client, state)) return;
    // As with heartbeat, ignore the caller-supplied legacy client id and bind
    // takeover to the authenticated socket's server-side identity.
    if (!this.writeLock) return;
    this.writeLock.takeover(frame.sessionId, state.clientId);
    this.lastWriterClientId.set(frame.sessionId, state.clientId);
    this.applyAuthoritativeGeometry(frame.sessionId, state.desiredGeometry);
    this.broadcastLeaseState(frame.sessionId);
  }

  /**
   * Acquire (or renew) the lease for a session on behalf of an operator client,
   * exposed for an explicit acquire path. Broadcasts the resulting lease state.
   */
  acquireLease(sessionId: string, client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state || !this.requireBoundTask(sessionId, client, state) || !this.writeLock) return;
    const wasWriter = this.writeLock.isWriter(sessionId, state.clientId);
    this.writeLock.acquire(sessionId, state.clientId);
    this.lastWriterClientId.set(sessionId, state.clientId);
    if (!wasWriter && this.writeLock.isWriter(sessionId, state.clientId)) {
      this.applyAuthoritativeGeometry(sessionId, state.desiredGeometry);
    }
    this.broadcastLeaseState(sessionId);
  }

  /**
   * After a writer disconnects and its lease is released, hand the now-free lease
   * to a still-connected authenticated operator on the same task (if any), so a
   * sole operator that RELOADED is promoted to writer immediately rather than
   * being left read-only with a free lease. Only sockets with an accepted frozen
   * binding participate. No-op when the lease is already held or no viewer
   * remains.
   */
  private regrantWriteLeaseToRemaining(taskId: string): void {
    if (!this.writeLock) return;
    if (this.writeLock.getLease(taskId)) return; // already re-held
    for (const state of this.clients.values()) {
      if (
        state.kind === 'operator' &&
        state.authenticated &&
        (state.phase === 'attaching' || state.phase === 'attached') &&
        state.binding?.boundTaskId === taskId
      ) {
        this.writeLock.acquire(taskId, state.clientId);
        this.lastWriterClientId.set(taskId, state.clientId);
        this.applyAuthoritativeGeometry(taskId, state.desiredGeometry);
        return;
      }
    }
  }

  /**
   * Auto-grant the write lease at terminal-attach acceptance, after principal
   * and task are frozen, WHEN the lease is free (non-preemptive). A second
   * attachment finds a live lease and stays a reader; explicit takeover is the
   * only preemption path. The lease is keyed by this connection's server-assigned
   * client id, the same id the input gate checks.
   */
  private grantWriteLeaseIfFree(state: ClientState): void {
    const taskId = this.clientTaskId(state);
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
      // Fan a session's lease state ONLY to sockets with an accepted immutable
      // binding to THAT session. Without this taskId filter a
      // heartbeat/takeover on task B would push a lease_state(sessionId=B) down a
      // socket joined to task A, corrupting that client's sessionId binding and
      // silently routing its keystrokes to the wrong session.
      if (
        state.kind === 'operator' &&
        state.authenticated &&
        (state.phase === 'attaching' || state.phase === 'attached') &&
        state.binding?.boundTaskId === sessionId
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
   * An isolated compatibility callback or a future explicit CAP-brokered caller
   * can pass the `reply` used to resolve the request. Current bypass-mode PTYs do
   * not call this path. Notification-adapter round-trips, when wired, may consume
   * the same pending entry.
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
      // Optional compatibility/future reply transport, resolved by requestId.
      reply,
    });
    // An explicit approval request counts as activity while awaiting a decision.
    if (this.guardrails) {
      this.guardrails.recordActivity(frame.taskId);
    }
    // Fan out to operators streaming this task so any of them can decide.
    for (const [socket, s] of this.clients) {
      if (
        s.kind === 'operator' &&
        s.authenticated &&
        s.phase === 'attached' &&
        s.binding?.boundTaskId === frame.taskId
      ) {
        this.send(socket, frame);
      }
    }
  }

  /**
   * Approval-router entry point retained for the isolated compatibility callback
   * and a future explicitly CAP-brokered action. Current bypass-mode sandbox
   * images do not call it. It routes through `onPermissionRequest` fan-out and
   * resolves with the operator's {@link DecisionFrame} once a decision arrives.
   *
   * The returned promise resolves when an operator decides (via `onDecision`,
   * which fires the `reply` registered here). It never rejects: a timeout is the
   * caller's concern; an explicitly gated caller must fail closed.
   */
  requestApproval(frame: PermissionRequestFrame): Promise<DecisionFrame> {
    return new Promise<DecisionFrame>((resolve) => {
      this.onPermissionRequest(frame, resolve);
    });
  }

  /**
   * Non-blocking compatibility `PostToolUse` report entry point. Current
   * bypass-mode images do not register the historical hook caller. If explicitly
   * invoked, it records task activity and remains post-hoc only.
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
    client: WebSocket,
    state: ClientState,
  ): void {
    // Lock-INDEPENDENT: no lease check here. Only require an authenticated
    // operator so a non-operator cannot inject its own decision.
    if (state.kind !== 'operator' || !state.authenticated) return;

    const pending = this.pendingApprovals.get(frame.requestId);
    if (!pending) return;
    if (!this.requireBoundTask(pending.taskId, client, state)) return;
    this.pendingApprovals.delete(frame.requestId);

    // Return the resolved decision to the blocked hook over its reply transport.
    pending.reply?.(frame);
    // Tell operators the request is resolved so duplicate surfaces clear.
    for (const [socket, s] of this.clients) {
      if (
        s.kind === 'operator' &&
        s.authenticated &&
        s.phase === 'attached' &&
        s.binding?.boundTaskId === pending.taskId
      ) {
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
    if (state.phase !== 'attaching' && state.phase !== 'attached') return;
    if (!state.binding || !state.attachment) return;
    const signal = state.backpressure.onAck(frame.seq);
    this.emitFlowSignal(signal, client, state);
  }

  /**
   * Stream one raw output chunk to a client: emit it as a `raw` frame tagged
   * with the cumulative byte offset, then update backpressure. If the send
   * pushed un-acknowledged bytes to the high-water mark, pause the PTY and tell
   * the client with an explicit `pause` control frame.
   *
   * Viewer bytes are deliberately excluded from lifecycle/activity accounting:
   * only owner output is canonical, while attach repaint/query traffic is local
   * to this disposable browser attachment.
   */
  private streamViewerBytes(
    chunk: Uint8Array,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (state.phase !== 'attaching' && state.phase !== 'attached') return;
    if (chunk.byteLength === 0) return;
    const queryObserver = state.queryObserver;
    if (!queryObserver) {
      this.failAttachment(client, state, 'internal_error');
      return;
    }
    // Load-bearing order: authorize every recognized response before the same
    // trigger bytes can reach xterm and synchronously produce terminal_response.
    // The observer is side-effect-free with respect to `chunk`; delivery below
    // uses the exact original byte view.
    try {
      const observation = queryObserver.observeOutput(chunk);
      const taskId = state.binding?.boundTaskId;
      if (taskId) {
        const attachmentId = this.providerStoryAttachmentId(state);
        for (const observed of observation.observations) {
          this.emitProviderStoryEvent(taskId, {
            type: 'query',
            taskId,
            attachmentId,
            queryId: observed.queryId,
            responseClass: observed.query.responseClass,
            parameters: terminalQueryParameters(observed.query),
            bytesBase64: Buffer.from(
              observed.rawBytes.buffer,
              observed.rawBytes.byteOffset,
              observed.rawBytes.byteLength,
            ).toString('base64'),
            admitted: observed.admitted,
          });
        }
      }
    } catch {
      this.failAttachment(client, state, 'internal_error');
      return;
    }
    for (let offset = 0; offset < chunk.byteLength; offset += HIGH_WATER_MARK_BYTES) {
      const length = Math.min(HIGH_WATER_MARK_BYTES, chunk.byteLength - offset);
      const bytes = new Uint8Array(
        chunk.buffer,
        chunk.byteOffset + offset,
        length,
      );
      state.sentBytes += length;
      const rawFrame: RawFrame = {
        channel: FRAME_CHANNEL.RAW,
        data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
          'base64',
        ),
        seq: state.sentBytes,
      };
      this.send(client, rawFrame);
      const signal = state.backpressure.onSent(state.sentBytes);
      this.emitFlowSignal(signal, client, state);
    }

  }

  /** Translate a {@link FlowSignal} into the matching pause/resume frame. */
  private emitFlowSignal(
    signal: FlowSignal,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (signal === 'pause') {
      if (!state.metricsViewerPaused) {
        state.metricsViewerPaused = true;
        this.terminalMetrics?.viewerPaused();
      }
      const frame: PauseFrame = {
        channel: FRAME_CHANNEL.CONTROL,
        type: 'pause',
      };
      this.send(client, frame);
    } else if (signal === 'resume') {
      if (state.metricsViewerPaused) {
        state.metricsViewerPaused = false;
        this.terminalMetrics?.viewerResumed();
      }
      const frame: ResumeFrame = {
        channel: FRAME_CHANNEL.CONTROL,
        type: 'resume',
      };
      this.send(client, frame);
    }
  }

  /**
   * Producer/provenance eligibility, not a durable-artifact switch. Bootstrap
   * and resize repaint bytes are excluded from both failure evidence and raw
   * artifacts; disabling raw artifacts never makes eligible agent bytes vanish
   * from activity or runtime classification.
   */
  private isOwnerOutputEligible(
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
  // Native viewer attachment handshake (one WebSocket -> one provider PTY)
  // -------------------------------------------------------------------------

  /**
   * Synchronous acceptance point. The phase, principal, task and generation are
   * frozen before any owner/provider promise is observed. The async continuation
   * can only operate while that exact binding remains current.
   */
  private onTerminalAttach(
    frame: TerminalAttachFrame,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (
      state.phase !== 'unattached' ||
      !state.authenticated ||
      !state.principalIdentity ||
      !state.requestedTaskId
    ) {
      this.failPolicyViolation(client, state, 'terminal attachment is not admissible');
      return;
    }

    const generation = state.generation + 1;
    const binding: FrozenClientBinding = Object.freeze({
      principalIdentity: Object.freeze({ ...state.principalIdentity }),
      boundTaskId: state.requestedTaskId,
      generation,
    });
    state.phase = 'attaching';
    state.binding = binding;
    state.generation = generation;
    state.authAttemptEpoch += 1;
    state.abortController = new AbortController();
    state.desiredGeometry = { cols: frame.cols, rows: frame.rows };
    state.sentBytes = 0;
    state.metricsAttachAttempted = true;
    state.metricsAttachOutcomeRecorded = false;
    state.backpressure.reset();
    state.queryObserver?.close();
    state.queryObserver = null;

    const negotiation = negotiateTerminalAttach(frame);
    if (!negotiation.ok) {
      this.recordTerminalAttachOutcome(state, negotiation.frame.reason);
      this.send(client, negotiation.frame);
      this.invalidateAttachment(state);
      this.closeReloadRequired(client);
      return;
    }

    try {
      state.queryObserver = this.createTerminalQueryObserver(state);
    } catch {
      this.logger.warn(
        `client ${state.clientId}: native terminal query configuration rejected`,
      );
      this.failAttachment(client, state, 'internal_error');
      return;
    }

    const session = this.sessions.get(binding.boundTaskId);
    if (!session) {
      this.unavailableAttachment(client, state, 'session_absent');
      return;
    }

    if (this.viewerCount(binding.boundTaskId) > this.viewerLimitPerTask) {
      this.unavailableAttachment(client, state, 'viewer_limit');
      return;
    }

    this.activateMetricsViewer(state);
    this.sendAttachmentState(client, state, { state: 'attaching' });
    // Establish lease authority only after principal and task are immutable.
    // Granting from mutable pre-attach auth state could strand task A's lease
    // after a legitimate pre-attach retarget to task B.
    this.grantWriteLeaseIfFree(state);
    if (this.isWriter(binding.boundTaskId, state.clientId)) {
      this.applyAuthoritativeGeometry(binding.boundTaskId, state.desiredGeometry);
    } else {
      this.sendGeometry(client, session.geometry);
    }

    void this.completeTerminalAttach(client, state, session, generation);
  }

  private async completeTerminalAttach(
    client: WebSocket,
    state: ClientState,
    session: TerminalSession,
    generation: number,
  ): Promise<void> {
    let ownerDecision: AgentTerminalLaunchOutcome;
    try {
      ownerDecision = await session.launchDecision;
    } catch {
      if (this.isCurrentAttachment(client, state, session, generation)) {
        this.failAttachment(client, state, 'internal_error');
      }
      return;
    }
    if (!this.isCurrentAttachment(client, state, session, generation)) return;

    if (ownerDecision.kind === 'absent') {
      this.unavailableAttachment(client, state, 'session_absent');
      return;
    }
    if (ownerDecision.kind === 'indeterminate') {
      this.unavailableAttachment(client, state, 'session_indeterminate');
      return;
    }
    if (ownerDecision.kind !== 'launched' && ownerDecision.kind !== 'attached') {
      this.unavailableAttachment(client, state, 'provider_unavailable');
      return;
    }

    // A resize accepted while the owner launch decision was pending may have
    // raced a not-yet-existing tmux pane. Re-assert the canonical grid now that
    // launch/attach is proven, without recording a second cast resize event.
    session.ownerPty.resize(session.geometry.cols, session.geometry.rows);

    let attachment: TerminalViewerAttachment;
    try {
      attachment = session.viewerFactory.open({
        cols: session.geometry.cols,
        rows: session.geometry.rows,
        signal: state.abortController?.signal,
      });
    } catch {
      this.failAttachment(client, state, 'provider_failed');
      return;
    }
    const attachmentId = this.providerStoryAttachmentId(state);
    this.emitProviderStoryEvent(session.taskId, {
      type: 'viewer_opened',
      taskId: session.taskId,
      attachmentId,
    });
    if (!this.isCurrentAttachment(client, state, session, generation)) {
      this.closeViewerAttachment(attachment);
      this.emitProviderStoryEvent(session.taskId, {
        type: 'viewer_closed',
        taskId: session.taskId,
        attachmentId,
      });
      return;
    }

    state.attachment = attachment;
    state.backpressure.setPty(attachment);
    state.attachmentSubscriptions.push(
      attachment.onData((chunk) => {
        if (!this.isCurrentAttachment(client, state, session, generation)) return;
        this.streamViewerBytes(chunk, client, state);
      }),
      attachment.onClose(() => {
        if (
          this.isCurrentAttachment(client, state, session, generation) &&
          state.phase === 'attached'
        ) {
          this.failAttachment(client, state, 'transport_closed');
        }
      }),
      attachment.onError((_error) => {
        this.logger.warn(
          `client ${state.clientId}: provider viewer attachment error`,
        );
        if (
          this.isCurrentAttachment(client, state, session, generation) &&
          state.phase === 'attached'
        ) {
          this.failAttachment(client, state, 'provider_failed');
        }
      }),
    );

    let outcome: TerminalViewerAttachmentOutcome | 'timeout';
    try {
      outcome = await this.waitForAttachmentDecision(
        attachment,
        state.abortController?.signal,
      );
    } catch {
      if (this.isCurrentAttachment(client, state, session, generation)) {
        this.failAttachment(client, state, 'internal_error');
      }
      return;
    }
    if (!this.isCurrentAttachment(client, state, session, generation)) {
      this.closeViewerAttachment(attachment);
      return;
    }
    this.finishAttachmentDecision(outcome, client, state, session);
  }

  private async waitForAttachmentDecision(
    attachment: TerminalViewerAttachment,
    signal?: AbortSignal,
  ): Promise<TerminalViewerAttachmentOutcome | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        attachment.attachmentDecision,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.viewerAttachTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal?.aborted) this.closeViewerAttachment(attachment);
    }
  }

  private finishAttachmentDecision(
    outcome: TerminalViewerAttachmentOutcome | 'timeout',
    client: WebSocket,
    state: ClientState,
    session: TerminalSession,
  ): void {
    if (outcome === 'timeout') {
      state.abortController?.abort();
      this.failAttachment(client, state, 'attach_timeout');
      return;
    }
    switch (outcome.kind) {
      case 'ready':
        if (state.attachment?.opaqueInputCapability !== 'byte-preserving') {
          this.failAttachment(client, state, 'provider_failed');
          return;
        }
        state.phase = 'attached';
        this.recordTerminalAttachOutcome(state, 'ready');
        this.sendAttachmentState(client, state, { state: 'ready' });
        this.sendGeometry(client, session.geometry);
        this.broadcastLeaseState(session.taskId);
        return;
      case 'absent':
        this.unavailableAttachment(client, state, 'session_absent');
        return;
      case 'indeterminate':
        this.unavailableAttachment(client, state, 'session_indeterminate');
        return;
      case 'failed':
        if (outcome.reason === 'aborted' && state.phase === 'closed') return;
        this.failAttachment(
          client,
          state,
          outcome.reason === 'blank-redraw'
            ? 'attach_timeout'
            : outcome.reason === 'transport'
              ? 'provider_failed'
              : 'internal_error',
        );
    }
  }

  private onTerminalResponse(
    frame: TerminalResponseFrame,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (
      (state.phase !== 'attaching' && state.phase !== 'attached') ||
      !state.binding ||
      !state.attachment ||
      !state.queryObserver
    ) {
      return;
    }
    const session = this.sessions.get(state.binding.boundTaskId);
    if (!session) return;
    const generation = state.binding.generation;
    if (!this.isCurrentAttachment(client, state, session, generation)) return;

    const attachment = state.attachment;
    const observer = state.queryObserver;
    const response = decodeCanonicalBase64Bytes(frame.data);
    const geometry = { ...session.geometry };
    const attachmentId = this.providerStoryAttachmentId(state);
    const bytesBase64 = Buffer.from(
      response.buffer,
      response.byteOffset,
      response.byteLength,
    ).toString('base64');
    void observer
      .consumeAndWriteResponse(
        response,
        geometry,
        (bytes) => {
          // Consume and write are one synchronous authorization transaction. The
          // queue token is already gone; re-check every live identity immediately
          // before touching the captured provider PTY and never restore on failure.
          if (
            !this.isCurrentAttachment(client, state, session, generation) ||
            state.attachment !== attachment ||
            state.queryObserver !== observer
          ) {
            throw new Error('stale terminal response generation');
          }
          let outcome: TerminalTransportWriteOutcome;
          try {
            outcome = attachment.writeTerminalResponse(bytes);
          } catch {
            this.emitProviderStoryEvent(session.taskId, {
              type: 'provider_write',
              taskId: session.taskId,
              attachmentId,
              source: 'terminal_response',
              bytesBase64,
              outcome: 'threw',
            });
            this.failAttachment(client, state, 'provider_failed');
            throw new Error('terminal response provider write threw');
          }
          this.emitProviderStoryEvent(session.taskId, {
            type: 'provider_write',
            taskId: session.taskId,
            attachmentId,
            source: 'terminal_response',
            bytesBase64,
            outcome,
          });
          if (outcome !== 'written') {
            this.handleViewerWriteOutcome(outcome, client, state);
            throw new Error('terminal response provider write rejected');
          }
        },
        () =>
          this.isCurrentAttachment(client, state, session, generation) &&
          state.attachment === attachment &&
          state.queryObserver === observer,
      )
      .then((result) => {
        this.emitProviderStoryEvent(session.taskId, {
          type: 'response',
          taskId: session.taskId,
          attachmentId,
          bytesBase64,
          accepted: result.accepted,
          ...(result.classification
            ? { responseClass: result.classification.responseClass }
            : {}),
          ...(!result.accepted ? { reason: result.reason } : {}),
        });
      })
      .catch(() => {
        if (this.isCurrentAttachment(client, state, session, generation)) {
          this.failAttachment(client, state, 'internal_error');
        }
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
    if (state.phase !== 'attached' || !state.binding) return;
    state.desiredGeometry = { cols: frame.cols, rows: frame.rows };
    const authoritative = this.isWriter(
      state.binding.boundTaskId,
      state.clientId,
    );
    this.emitProviderStoryEvent(state.binding.boundTaskId, {
      type: 'resize',
      taskId: state.binding.boundTaskId,
      attachmentId: this.providerStoryAttachmentId(state),
      cols: frame.cols,
      rows: frame.rows,
      authoritative,
    });
    if (!authoritative) return;
    this.applyAuthoritativeGeometry(
      state.binding.boundTaskId,
      state.desiredGeometry,
    );
  }

  private applyAuthoritativeGeometry(
    taskId: string,
    geometry: Readonly<MutableTerminalGeometry>,
  ): void {
    const session = this.sessions.get(taskId);
    if (!session) return;
    const changed =
      session.geometry.cols !== geometry.cols ||
      session.geometry.rows !== geometry.rows;
    session.geometry.cols = geometry.cols;
    session.geometry.rows = geometry.rows;

    if (changed) this.beginResizeRepaintSuppression(taskId);
    session.ownerPty.resize(geometry.cols, geometry.rows);
    for (const state of this.clients.values()) {
      if (
        state.binding?.boundTaskId === taskId &&
        (state.phase === 'attaching' || state.phase === 'attached')
      ) {
        state.attachment?.resize(geometry.cols, geometry.rows);
      }
    }
    this.broadcastGeometry(taskId);

    if (changed && this.terminalRecordingPolicy.sessionCast.enabled) {
      const resizeData = castResizeData(geometry.cols, geometry.rows);
      if (this.sessionCasts.has(taskId)) {
        this.appendCastEvent(taskId, 'r', resizeData);
      } else {
        const pending = this.pendingCastResizeEvents.get(taskId) ?? [];
        pending.push(resizeData);
        this.pendingCastResizeEvents.set(taskId, pending);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Owner PTY output: lifecycle/activity/classification + durable artifacts only
  // -------------------------------------------------------------------------

  /**
   * Handle a chunk of live PTY output produced by the task's {@link SandboxTerminalSession}
   * (subscribed in {@link openSession}). Browser bytes never pass through this
   * method: each viewer receives only its own fresh tmux attachment stream.
   */
  private onPtyOutput(
    taskId: string,
    chunk: string,
    meta?: AgentTerminalOutputMeta,
  ): void {
    const eligible = this.isOwnerOutputEligible(taskId, meta);

    if (eligible) {
      // Classification/evidence is load-bearing and independent of optional
      // artifact gates. Update it before enqueueing any best-effort disk write.
      this.inspectRuntimeFailure(taskId, chunk);
      if (this.terminalRecordingPolicy.sessionLog.enabled) {
        this.appendSessionLog(taskId, Buffer.from(chunk, 'utf8'));
      }
      if (this.terminalRecordingPolicy.sessionCast.enabled) {
        this.appendCast(taskId, chunk);
      }
    }

    // VR.3 — feed the IdleTracker.
    if (this.guardrails) {
      this.guardrails.recordActivity(taskId);
    }

  }

  private inspectRuntimeFailure(taskId: string, chunk: string): void {
    const previous = this.runtimeFailureBuffers.get(taskId) ?? '';
    const rolling = appendBoundedUtf8Tail(
      previous,
      chunk,
      this.terminalRecordingPolicy.failureEvidenceMaxBytes,
    );
    this.runtimeFailureBuffers.set(taskId, rolling);
    if (!this.guardrails || this.runtimeFailuresReported.has(taskId)) return;
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
   * appends per task so concurrent chunks land in order. The workspace directory
   * is created lazily on the first append. Append failures are logged but never
   * throw into the owner lifecycle/classification path.
   */
  private appendSessionLog(taskId: string, payload: Buffer): void {
    const entry = this.sessionLogs.get(taskId);
    if (!entry || entry.truncated) return;
    const { logPath } = entry;
    const truncation = Buffer.from(
      TERMINAL_RAW_RECORDING_TRUNCATION_TEXT,
      'utf8',
    );
    let writePayload = payload;
    if (
      entry.reservedBytes + payload.byteLength + truncation.byteLength >
        entry.maxBytes ||
      entry.pendingWrites + 1 >= entry.maxPendingWrites
    ) {
      entry.truncated = true;
      writePayload =
        entry.reservedBytes + truncation.byteLength <= entry.maxBytes
          ? truncation
          : Buffer.alloc(0);
      this.logger.warn(
        `task ${taskId}: session.log reached its configured byte/pending-write capacity; recording stopped`,
      );
    }
    if (writePayload.byteLength === 0) return;
    // Reserve synchronously before capturing the payload in the append chain.
    // Once the budget is exhausted, later chunks allocate no queued closures.
    entry.reservedBytes += writePayload.byteLength;
    entry.pendingWrites += 1;
    // Chain on the prior append so writes are strictly ordered (no interleaving),
    // while the synchronous reservation above bounds the outstanding backlog.
    entry.tail = entry.tail
      .then(async () => {
        try {
          if (!entry.ensured) {
            await mkdir(path.dirname(logPath), { recursive: true });
            entry.ensured = true;
          }
          await appendFile(logPath, writePayload);
        } catch (err) {
          this.logger.warn(
            `task ${taskId}: session.log append failed: ${(err as Error).message}`,
          );
        }
      })
      .finally(() => {
        entry.pendingWrites -= 1;
      });
  }

  private async flushSessionLog(taskId: string): Promise<void> {
    const entry = this.sessionLogs.get(taskId);
    if (!entry) return;
    try {
      await entry.tail;
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: session.log flush failed before audit read: ${
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
    initialCols: number,
    initialRows: number,
  ): void {
    if (!this.terminalRecordingPolicy.sessionCast.enabled) {
      this.pendingCastResizeEvents.delete(taskId);
      return;
    }
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
      if (mode === 'headless-exec') {
        this.pendingCastResizeEvents.delete(taskId);
        return;
      }
      if (!this.sessions.has(taskId)) return;
      this.armCast(taskId, workspaceDir, initialCols, initialRows);
      const entry = this.sessionCasts.get(taskId);
      const initialized = entry?.tail;
      void initialized?.then(() => {
        if (this.sessionCasts.get(taskId) !== entry) return;
        const pending = this.pendingCastResizeEvents.get(taskId) ?? [];
        this.pendingCastResizeEvents.delete(taskId);
        for (const resizeData of pending) {
          this.appendCastEvent(taskId, 'r', resizeData);
        }
      });
    });
  }

  /** Register the cast append state + write the asciicast v2 header (interactive only). */
  private armCast(
    taskId: string,
    workspaceDir: string,
    cols: number,
    rows: number,
  ): void {
    if (!this.terminalRecordingPolicy.sessionCast.enabled) return;
    if (this.sessionCasts.has(taskId)) return;
    const castPath = path.join(workspaceDir, SESSION_CAST_FILENAME);
    const existingBytes = existingFileSize(castPath);
    const initialHeader = buildCastHeaderLine(
      cols,
      rows,
      Math.floor(Date.now() / 1000),
    );
    const entry: SessionCastState = {
      castPath,
      tail: Promise.resolve(),
      startMs: Date.now(),
      ready: false,
      // Reserve a prospective header before any event can queue. The init tail
      // writes it first; existing files already include their one header.
      reservedBytes:
        existingBytes > 0
          ? existingBytes
          : Buffer.byteLength(initialHeader, 'utf8'),
      maxBytes: this.terminalRecordingPolicy.sessionCast.maxBytes,
      pendingWrites: 1,
      maxPendingWrites: this.terminalRecordingPolicy.maxPendingWrites,
      truncated: false,
    };
    this.sessionCasts.set(taskId, entry);
    entry.tail = entry.tail
      .then(async () => {
        try {
          await mkdir(path.dirname(castPath), { recursive: true });
          const resume = await inspectCastResumeState(castPath);
          entry.reservedBytes = Math.max(entry.reservedBytes, resume.sizeBytes);
          const now = Date.now();
          if (resume.sizeBytes > entry.maxBytes) {
            entry.truncated = true;
            this.logger.warn(
              `task ${taskId}: existing session.cast exceeds the configured ${entry.maxBytes}-byte budget; recording remains stopped`,
            );
            return;
          }
          if (resume.hasHeader) {
            entry.startMs = now - resume.lastTimeSec * 1000;
            entry.ready = true;
            return;
          }
          entry.startMs = now;
          if (resume.hasBytes) {
            entry.truncated = true;
            this.logger.warn(
              `task ${taskId}: existing session.cast has no valid header; not appending a second header`,
            );
            return;
          }
          const header = initialHeader;
          const headerBytes = Buffer.byteLength(header, 'utf8');
          if (headerBytes > entry.maxBytes) {
            entry.truncated = true;
            this.logger.warn(
              `task ${taskId}: session.cast header exceeds the configured byte budget`,
            );
            return;
          }
          await appendFile(castPath, header);
          entry.ready = true;
        } catch (err) {
          entry.truncated = true;
          this.logger.warn(
            `task ${taskId}: session.cast header write failed: ${(err as Error).message}`,
          );
        }
      })
      .finally(() => {
        entry.pendingWrites -= 1;
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
    if (!entry || entry.truncated) return;
    const time = Math.max(0, (Date.now() - entry.startMs) / 1000);
    const eventLine = buildCastEventLine(time, code, data);
    const truncationLine = buildCastEventLine(
      time,
      'o',
      TERMINAL_RAW_RECORDING_TRUNCATION_TEXT,
    );
    const eventBytes = Buffer.byteLength(eventLine, 'utf8');
    const truncationBytes = Buffer.byteLength(truncationLine, 'utf8');
    let line = eventLine;
    if (
      entry.reservedBytes + eventBytes + truncationBytes > entry.maxBytes ||
      entry.pendingWrites + 1 >= entry.maxPendingWrites
    ) {
      entry.truncated = true;
      line =
        entry.reservedBytes + truncationBytes <= entry.maxBytes
          ? truncationLine
          : '';
      this.logger.warn(
        `task ${taskId}: session.cast reached its configured byte/pending-write capacity; recording stopped`,
      );
    }
    if (line.length === 0) return;
    entry.reservedBytes += Buffer.byteLength(line, 'utf8');
    entry.pendingWrites += 1;
    entry.tail = entry.tail
      .then(async () => {
        // Header validation/write is the first operation on this same chain.
        // If it failed or found an invalid legacy file, do not create headerless
        // events; the synchronously reserved queue remains capacity-bounded.
        if (!entry.ready) return;
        try {
          await appendFile(entry.castPath, line);
        } catch (err) {
          this.logger.warn(
            `task ${taskId}: session.cast append failed: ${(err as Error).message}`,
          );
        }
      })
      .finally(() => {
        entry.pendingWrites -= 1;
      });
  }

  /**
   * Record a chunk of PTY output as an asciicast `o` event. `chunk` is an
   * already-decoded UTF-8 string (the SandboxTerminalSession decodes the PTY byte stream
   * before emitting), so JSON-escaping yields valid UTF-8 `data` with no
   * split-multibyte risk at this layer.
   */
  private appendCast(taskId: string, chunk: string): void {
    this.appendCastEvent(taskId, 'o', chunk);
  }

  // -------------------------------------------------------------------------
  // Low-level send + helpers
  // -------------------------------------------------------------------------

  private clientTaskId(state: ClientState): string | null {
    return state.binding?.boundTaskId ?? state.requestedTaskId;
  }

  private isWriter(taskId: string, clientId: string): boolean {
    return this.writeLock?.isWriter(taskId, clientId) ?? false;
  }

  private viewerCount(taskId: string): number {
    let count = 0;
    for (const state of this.clients.values()) {
      if (
        state.binding?.boundTaskId === taskId &&
        (state.phase === 'attaching' || state.phase === 'attached')
      ) {
        count += 1;
      }
    }
    return count;
  }

  private isCurrentAttachment(
    client: WebSocket,
    state: ClientState,
    session: TerminalSession,
    generation: number,
  ): boolean {
    return (
      this.clients.get(client) === state &&
      (state.phase === 'attaching' || state.phase === 'attached') &&
      state.generation === generation &&
      state.binding?.generation === generation &&
      state.binding.boundTaskId === session.taskId &&
      this.sessions.get(session.taskId) === session &&
      state.abortController?.signal.aborted === false
    );
  }

  private requireBoundTask(
    taskId: string,
    client: WebSocket,
    state: ClientState,
  ): boolean {
    if (
      state.authenticated &&
      state.binding?.boundTaskId === taskId &&
      (state.phase === 'attaching' || state.phase === 'attached')
    ) {
      return true;
    }
    this.failPolicyViolation(client, state, 'cross-task or unbound terminal frame');
    return false;
  }

  private sendAttachmentState(
    client: WebSocket,
    state: ClientState,
    details: AttachmentStateDetails,
  ): void {
    const taskId = state.binding?.boundTaskId;
    const geometry =
      (taskId ? this.sessions.get(taskId)?.geometry : undefined) ??
      state.desiredGeometry;
    const frame: TerminalAttachmentStateFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'terminal_attachment_state',
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      cols: geometry.cols,
      rows: geometry.rows,
      ...details,
    };
    this.send(client, frame);
    if (taskId) {
      this.emitProviderStoryEvent(taskId, {
        type: 'attachment_state',
        taskId,
        attachmentId: this.providerStoryAttachmentId(state),
        state: details.state,
        ...('reason' in details ? { reason: details.reason } : {}),
        cols: geometry.cols,
        rows: geometry.rows,
      });
    }
  }

  private sendGeometry(
    client: WebSocket,
    geometry: Readonly<MutableTerminalGeometry>,
  ): void {
    const frame: TerminalGeometryFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'terminal_geometry',
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      cols: geometry.cols,
      rows: geometry.rows,
    };
    this.send(client, frame);
  }

  private broadcastGeometry(taskId: string): void {
    const geometry = this.sessions.get(taskId)?.geometry;
    if (!geometry) return;
    for (const [client, state] of this.clients) {
      if (
        state.binding?.boundTaskId === taskId &&
        (state.phase === 'attaching' || state.phase === 'attached')
      ) {
        this.sendGeometry(client, geometry);
      }
    }
  }

  private unavailableAttachment(
    client: WebSocket,
    state: ClientState,
    reason: Extract<
      AttachmentStateDetails,
      { state: 'unavailable' }
    >['reason'],
  ): void {
    this.recordTerminalAttachOutcome(state, reason);
    this.sendAttachmentState(client, state, {
      state: 'unavailable',
      reason,
      reloadRequired: false,
    });
    this.invalidateAttachment(state);
  }

  private failAttachment(
    client: WebSocket,
    state: ClientState,
    reason: Extract<AttachmentStateDetails, { state: 'failed' }>['reason'],
  ): void {
    this.recordTerminalAttachOutcome(state, reason);
    this.sendAttachmentState(client, state, {
      state: 'failed',
      reason,
      reloadRequired: false,
    });
    this.invalidateAttachment(state);
  }

  private handleViewerWriteOutcome(
    outcome: TerminalTransportWriteOutcome,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (outcome === 'written') return;
    this.failAttachment(
      client,
      state,
      outcome === 'unsupported' ? 'provider_failed' : 'transport_closed',
    );
  }

  private createTerminalQueryObserver(state: ClientState): TerminalQueryObserver {
    return new TerminalQueryObserver({
      ...this.terminalQueryConfig,
      onQueueFull: ({ capacity, pending, requested }) => {
        this.logger.warn(
          `client ${state.clientId}: terminal query queue full ` +
            `(capacity=${capacity}, pending=${pending}, requested=${requested})`,
        );
      },
      onResponseRateLimited: ({ limit, windowMs, attemptsInWindow }) => {
        this.logger.warn(
          `client ${state.clientId}: terminal response rate limited ` +
            `(limit=${limit}, windowMs=${windowMs}, attempts=${attemptsInWindow})`,
        );
      },
    });
  }

  private recordTerminalAttachOutcome(
    state: ClientState,
    outcome: TerminalAttachOutcome,
  ): void {
    if (
      !state.metricsAttachAttempted ||
      state.metricsAttachOutcomeRecorded
    ) {
      return;
    }
    state.metricsAttachOutcomeRecorded = true;
    this.terminalMetrics?.observeAttachOutcome(outcome);
  }

  private activateMetricsViewer(state: ClientState): void {
    if (state.metricsViewerActive) return;
    state.metricsViewerActive = true;
    state.metricsViewerPaused = false;
    this.terminalMetrics?.viewerActivated();
  }

  private deactivateMetricsViewer(state: ClientState): void {
    if (!state.metricsViewerActive) return;
    const wasPaused = state.metricsViewerPaused;
    state.metricsViewerActive = false;
    state.metricsViewerPaused = false;
    this.terminalMetrics?.viewerDeactivated(wasPaused);
  }

  private invalidateAttachment(state: ClientState): void {
    if (state.phase === 'closed') return;
    this.recordTerminalAttachOutcome(state, 'cancelled');
    const taskId = state.binding?.boundTaskId ?? null;
    state.phase = 'closed';
    state.generation += 1;
    state.authAttemptEpoch += 1;
    state.abortController?.abort();
    state.abortController = null;
    const queryObserver = state.queryObserver;
    state.queryObserver = null;
    queryObserver?.close();
    this.deactivateMetricsViewer(state);
    state.backpressure.reset();
    state.backpressure.setPty(undefined);
    for (const subscription of state.attachmentSubscriptions.splice(0)) {
      subscription.dispose();
    }
    const attachment = state.attachment;
    state.attachment = null;
    if (attachment) {
      this.closeViewerAttachment(attachment);
      if (taskId) {
        this.emitProviderStoryEvent(taskId, {
          type: 'viewer_closed',
          taskId,
          attachmentId: this.providerStoryAttachmentId(state),
        });
      }
    }
    if (
      taskId &&
      this.writeLock?.releaseOnDisconnect(taskId, state.clientId) &&
      this.sessions.has(taskId)
    ) {
      // The closed state above excludes this client from selection even when
      // WebSocket teardown has not yet removed it from `clients`.
      this.regrantWriteLeaseToRemaining(taskId);
      this.broadcastLeaseState(taskId);
    }
  }

  private closeViewerAttachment(attachment: TerminalViewerAttachment): void {
    if (this.closedViewerAttachments.has(attachment)) return;
    this.closedViewerAttachments.add(attachment);
    this.trackTerminalCleanup('viewer', attachment.cleanupDecision);
    try {
      attachment.close();
    } catch {
      this.logger.warn('terminal viewer close threw');
    }
  }

  private trackTerminalCleanup(
    source: TerminalCleanupSource,
    decision: Promise<TerminalTransportCleanupSettlement> | undefined,
  ): void {
    const tracked: TrackedTerminalCleanup = {
      source,
      decision: normalizeTerminalCleanupDecision(decision),
      metricsOutcomeRecorded: false,
    };
    this.pendingTerminalCleanups.add(tracked);
    void tracked.decision.then((settlement) => {
      this.recordTerminalCleanupOutcome(tracked, settlement.kind);
      this.pendingTerminalCleanups.delete(tracked);
    });
  }

  private recordTerminalCleanupOutcome(
    tracked: TrackedTerminalCleanup,
    outcome: 'confirmed' | 'indeterminate',
  ): void {
    if (tracked.metricsOutcomeRecorded) return;
    tracked.metricsOutcomeRecorded = true;
    this.terminalMetrics?.observeCleanupOutcome(outcome);
  }

  private providerStoryAttachmentId(state: ClientState): string {
    const generation = state.binding?.generation ?? state.generation;
    return `${state.clientId}:${generation}`;
  }

  private emitProviderStoryEvent(
    taskId: string,
    event: ProviderTerminalStoryTelemetryEvent,
  ): void {
    const observers = this.providerStoryObservers.get(taskId);
    if (!observers || observers.size === 0) return;
    for (const observer of [...observers]) {
      try {
        observer.onEvent(event);
      } catch {
        // Verification telemetry must never alter terminal delivery or cleanup.
        this.logger.warn(
          `task ${taskId}: provider terminal story telemetry observer failed`,
        );
      }
    }
  }

  private failAuthentication(client: WebSocket, state: ClientState): void {
    state.authenticated = false;
    state.principalIdentity = null;
    this.invalidateAttachment(state);
    this.closeUnauthenticated(client);
  }

  private failPolicyViolation(
    client: WebSocket,
    state: ClientState,
    reason: string,
  ): void {
    this.logger.warn(`client ${state.clientId}: ${reason}`);
    if (state.binding && state.phase !== 'closed') {
      this.recordTerminalAttachOutcome(state, 'internal_error');
      this.sendAttachmentState(client, state, {
        state: 'failed',
        reason: 'internal_error',
        reloadRequired: false,
      });
    }
    this.invalidateAttachment(state);
    try {
      client.close(1008, 'terminal attachment policy violation');
    } catch {
      // Best-effort; the socket may already be closing.
    }
  }

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

  /**
   * A negotiated protocol/profile mismatch consumes this socket's sole attach
   * attempt. Closing with 1008 stops automatic reconnect while preserving the
   * already-sent reload-required control frame for the Web client.
   */
  private closeReloadRequired(client: WebSocket): void {
    try {
      client.close(1008, 'terminal client reload required');
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

function waitForTerminalCleanup(
  cleanup: TrackedTerminalCleanup,
  timeoutMs: number,
): Promise<BoundedTerminalCleanupResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'timeout', source: cleanup.source });
    }, timeoutMs);
    void cleanup.decision.then((settlement) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: 'settled', source: cleanup.source, settlement });
    });
  });
}

function principalIdentityOf(principal: OperatorPrincipal): PrincipalIdentity {
  return Object.freeze({
    kind: principal.kind,
    userId: principal.user?.id ?? null,
    keyId: principal.keyId ?? null,
  });
}

function samePrincipalIdentity(
  left: PrincipalIdentity,
  right: PrincipalIdentity,
): boolean {
  return (
    left.kind === right.kind &&
    left.userId === right.userId &&
    left.keyId === right.keyId
  );
}

function terminalQueryParameters(
  query: TerminalQueryExpectation,
): Readonly<Record<string, string | number | boolean>> {
  switch (query.responseClass) {
    case 'decrqm_ansi':
    case 'decrqm_private':
      return { mode: query.mode };
    case 'decrqss':
      return { subtype: query.subtype };
    case 'osc_4':
      return { colorIndex: query.colorIndex };
    default:
      return {};
  }
}

async function inspectCastResumeState(
  castPath: string,
): Promise<CastResumeState> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(castPath, 'r');
  } catch {
    return {
      hasHeader: false,
      hasBytes: false,
      lastTimeSec: 0,
      sizeBytes: 0,
    };
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return {
        hasHeader: false,
        hasBytes: false,
        lastTimeSec: 0,
        sizeBytes: 0,
      };
    }

    const headLength = Math.min(size, CAST_RESUME_HEAD_BYTES);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    const firstLine = firstNonBlankLine(head.toString('utf8'));
    const hasHeader = firstLine
      ? parseAsciicastHeader(firstLine) !== null
      : false;
    if (!hasHeader) {
      return {
        hasHeader: false,
        hasBytes: true,
        lastTimeSec: 0,
        sizeBytes: size,
      };
    }

    const tailStart = Math.max(0, size - CAST_RESUME_TAIL_BYTES);
    const tailLength = size - tailStart;
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, tailStart);
    return {
      hasHeader: true,
      hasBytes: true,
      lastTimeSec: findLastCastEventTime(tail.toString('utf8')),
      sizeBytes: size,
    };
  } finally {
    await handle.close();
  }
}

function existingFileSize(filePath: string): number {
  try {
    const size = statSync(filePath).size;
    return Number.isSafeInteger(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

function appendBoundedUtf8Tail(
  previous: string,
  chunk: string,
  maxBytes: number,
): string {
  const combined = Buffer.from(`${previous}${chunk}`, 'utf8');
  if (combined.byteLength <= maxBytes) return combined.toString('utf8');
  // Decode only a fixed-size suffix. If the byte boundary lands inside one
  // multibyte code point, drop the decoder's leading replacement marker.
  return combined
    .subarray(combined.byteLength - maxBytes)
    .toString('utf8')
    .replace(/^\uFFFD+/, '');
}

function formatFailureEvidenceTail(input: string): string {
  const lines = stripAnsi(input)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const tail = lines.slice(-20).join('\n');
  return tail.length > 2_000 ? tail.slice(-2_000) : tail;
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
 * `createTaskWorkspace` logic. The gateway records owner output and reads failure
 * audit excerpts from the same persistent task workspace.
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
