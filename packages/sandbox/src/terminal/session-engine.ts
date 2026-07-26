/**
 * Provider-neutral sandbox terminal session engine.
 *
 * Under the connect-in model the orchestrator owns one normalized provider
 * terminal transport per task. This engine is the PTY backend above that
 * transport and is deliberately unaware of AIO JSON, BoxLite binary channels,
 * provider URLs, credentials, or provider command protocols.
 * Everything ABOVE the seam (web
 * ws-client, operator connect-auth, `WriteLockService`, approval routing,
 * viewer-local backpressure/ACK, owner-only `session.log`, guardrails)
 * is reused verbatim.
 *
 * Provider packages translate their wire protocols into the normalized
 * TerminalTransport frame contract before this engine sees them:
 *
 *   | Direction              | normalized transport frame       | CAP side                          |
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
  AgentTerminalLaunchOutcome,
  AgentTerminalOutputMeta,
  AgentTerminalPty,
  SandboxCommandExecutor,
  TerminalExitStatus,
  TerminalTransport,
  TerminalTransportCleanupSettlement,
  TerminalTransportFactory,
  TerminalTransportFrame,
  TaskModelIntent,
  TaskModelLaunchMaterial,
} from '@cap/sandbox-core';
import {
  SandboxRuntimeModelSetupError,
  taskModelLaunchMaterial,
} from '@cap/sandbox-core';
import type {
  SandboxLegacyTerminalExec,
  SandboxResolvedTaskLaunchContext,
  SandboxTerminalExecutionMode,
  SandboxTerminalExitSignal,
  SandboxTerminalRuntime,
  SandboxTerminalStartup,
} from './runtime.js';
import {
  assertNativeCodexInteractiveLaunchArgv,
  DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
  terminalSessionIdForTask,
  toSandboxTerminalRuntimeExec,
} from './runtime.js';
import {
  buildAttachSessionCommand,
  buildDetachedCodexLaunchLine,
  buildExactHasSessionCommand,
  buildResizeDetachedSessionCommand,
  detachedSessionName,
  headlessExitFile,
  wrapInDetachedSession,
} from './session-commands.js';
// add-claude-code-runtime Track 3 (3.2): the bridge resolves the task's selected
// AgentRuntime (Track 2) and calls its `buildLaunchLine` / `autoSubmit` / `detectExit`
// instead of the legacy inline Codex mechanism. When the resolved runtime is
// `codex`, the detached-tmux launch uses Codex's native terminal mode while the
// DSR-gated CR autosubmit + `tmux has-session` exit detection run exactly as before.
// CLAUDE takes the runtime path: the runtime's tmux launch line, NO autosubmit
// (`claude "prompt"` auto-runs), and — since align-claude-runtime-resident-session —
// the SAME `tmux has-session` `detectExit` codex uses. Claude is a RESIDENT
// continuous-conversation session: a finished turn idles for the operator's next input
// (typed into the live terminal) and does NOT terminate the task; the session-gone
// path resolves it only on operator stop or a configured idle/deadline reclamation.
import { selectLaunch } from './select-launch.js';
import {
  aggregateTerminalCleanupSettlements,
  confirmedEmptyTerminalCleanupSettlement,
  normalizeTerminalCleanupDecision,
} from './cleanup.js';

export interface SandboxTerminalSessionLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export type SandboxTerminalOwnerRecoveryEvent =
  | { readonly kind: 'outage'; readonly attempt: 0; readonly durationMs: 0 }
  | { readonly kind: 'retry'; readonly attempt: number; readonly durationMs: number }
  | { readonly kind: 'restored'; readonly attempt: number; readonly durationMs: number }
  | {
      readonly kind: 'failed';
      readonly attempt: number;
      readonly durationMs: number;
      readonly reason:
        | 'absent'
        | 'budget-exhausted'
        | 'cleanup-unconfirmed';
    };

export interface SandboxTerminalOwnerRecoveryPolicy {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly readyTimeoutMs?: number;
  /** Bound before a replacement owner may attach behind the closed generation. */
  readonly cleanupTimeoutMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
  readonly onEvent?: (event: SandboxTerminalOwnerRecoveryEvent) => void;
}

const noopLogger: SandboxTerminalSessionLogger = {
  debug: () => undefined,
  warn: () => undefined,
};

/**
 * The DSR (Device Status Report) cursor-position query crossterm emits on
 * startup: `ESC [ 6 n` — standard DSR-6, with NO `?`. codex BLOCKS waiting for a
 * CPR reply and aborts with `Error: The cursor position could not be read within
 * a normal duration` if none arrives, because some tmux-backed terminals do not
 * reply CPR in time. Verified byte-for-byte against the live sandbox: codex
 * (crossterm) emits `1b 5b 36 6e` = `\x1b[6n`. The private-mode `\x1b[?6n` form is
 * NOT what it sends, so the detector must match the no-`?` form exactly (matching
 * `\x1b[?6n` here silently disables CPR injection and codex never starts).
 */
const DSR_CURSOR_POSITION_QUERY = '\x1b[6n';

/**
 * The synthetic CPR (Cursor Position Report) reply we inject on seeing the DSR
 * query: `ESC [ 1 ; 1 R` = cursor at row 1, col 1. This unblocks crossterm so
 * codex renders its TUI. Injected entirely in this shared session layer.
 */
const SYNTHETIC_CPR_REPLY = '\x1b[1;1R';

/**
 * The Enter key (carriage return) codex's TUI composer submits on. Injected ONCE
 * as the zero-touch prompt auto-submit (aio-codex-prompt-autostart): codex's
 * positional `[PROMPT]` only PRE-FILLS the composer, so a single `\r` after the
 * TUI is up and idle submits the pre-filled goal with no operator keystroke.
 */
const CODEX_SUBMIT_KEY = '\r';
const TMUX_RESIZE_TIMEOUT_MS = 2_000;
const TMUX_RESIZE_MAX_ATTEMPTS = 3;
const TMUX_RESIZE_RETRY_DELAY_MS = 50;

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
const OWNER_RECOVERY_MAX_ATTEMPTS = 5;
const OWNER_RECOVERY_BASE_DELAY_MS = 100;
const OWNER_RECOVERY_MAX_DELAY_MS = 1_600;
const OWNER_RECOVERY_READY_TIMEOUT_MS = 5_000;
// AIO's exact owner release uses one shared 12s guest deadline before bounded
// provider-metadata and ownership-journal confirmation. Keep the supervisor's
// fence long enough for that complete proof while retaining the 30s hard max.
const OWNER_RECOVERY_CLEANUP_TIMEOUT_MS = 25_000;
const OWNER_RECOVERY_JITTER_RATIO = 0.2;

/**
 * The cloned-workspace directory inside the sandbox the detached session runs in
 * (`-c <dir>`), matching the codex `buildDetachedCodexLaunchLine` default. Passed
 * to a non-codex runtime's `buildLaunchLine` as the session cwd so claude runs in
 * the same cloned task repo codex does (3.2). One constant shared by both paths.
 */
const CLAUDE_WORKSPACE_DIR = '/home/gem/workspace';

/** The resolved exit outcome of a terminated sandbox session. */
export type SandboxTerminalSessionExitStatus = TerminalExitStatus;
export type SandboxTerminalSessionMode =
  | 'launch-or-attach'
  | 'attach-only'
  | 'provider-story-fixture'
  | 'replay-only';

/**
 * Internal control-flow marker for a cancelled or superseded fresh launch.
 * This is deliberately distinct from runtime/model setup failure: losing
 * admission authority is an expected coordination outcome, not a bad model.
 */
class SandboxAgentLaunchFencedError extends Error {
  constructor() {
    super('Agent launch was fenced before terminal input');
    this.name = 'SandboxAgentLaunchFencedError';
  }
}

const PROVIDER_STORY_SCRIPT_PATH = '/tmp/cap-provider-terminal-story.mjs';

function buildProviderStoryFixtureScript(): string {
  return [
    '#!/usr/bin/env node',
    "import process from 'node:process';",
    '',
    'const ESC = String.fromCharCode(27);',
    'const CR = 13;',
    'const LF = 10;',
    'let tick = null;',
    'let tickIndex = 0;',
    'let pending = Buffer.alloc(0);',
    'let lineBytes = [];',
    'let shuttingDown = false;',
    '',
    'function write(value) { process.stdout.write(value); }',
    'function emit(value) { write(value + "\\r\\n"); }',
    'function hex(bytes) { return Buffer.from(bytes).toString("hex").toUpperCase(); }',
    'function paint(row, value) {',
    '  write(ESC + "7" + ESC + "[" + row + ";1H" + value + ESC + "[0m" + ESC + "[K" + ESC + "8");',
    '}',
    'function stopTick() {',
    '  if (tick === null) return;',
    '  clearInterval(tick);',
    '  tick = null;',
    '}',
    'function resizeMarker() {',
    '  const cols = Number.isInteger(process.stdout.columns) ? process.stdout.columns : 0;',
    '  const rows = Number.isInteger(process.stdout.rows) ? process.stdout.rows : 0;',
    '  paint(6, ESC + "[38;5;45mPROVIDER_STORY_RESIZE:" + cols + "x" + rows);',
    '}',
    'function renderFrame() {',
    '  write(ESC + "[?1049h" + ESC + "[2J" + ESC + "[H");',
    '  write(ESC + "[1;38;5;39mCAP native provider terminal" + ESC + "[0m\\r\\n");',
    '  write("PROVIDER_STORY_CURRENT_FRAME\\r\\n");',
    '  write(ESC + "[38;5;82mPROVIDER_STORY_UTF8: 中文渲染正常 汉字边界" + ESC + "[0m\\r\\n");',
    '  write(ESC + "[3mPROVIDER_STORY_NATIVE_ALT: cursor-style-cjk" + ESC + "[0m\\r\\n");',
    '  write("PROVIDER_STORY_READY_FOR_INPUT\\r\\n");',
    '  write("PROVIDER_STORY_RESIZE:pending\\r\\n");',
    '  write("PROVIDER_STORY_LIVE_000 waiting" + ESC + "[K\\r\\n");',
    '  write("PROVIDER_STORY_ECHO:waiting" + ESC + "[K\\r\\n");',
    '  write("PROVIDER_STORY_ORACLE_UTF8:waiting" + ESC + "[K\\r\\n");',
    '  write("PROVIDER_STORY_ORACLE_MOUSE:waiting" + ESC + "[K");',
    '  write(ESC + "[?1000h" + ESC + "[?1006l" + ESC + "[?25h" + ESC + "[12;7H");',
    '}',
    'function handleLine(terminator) {',
    '  const payload = Buffer.from(lineBytes);',
    '  lineBytes = [];',
    '  const received = Buffer.concat([payload, Buffer.from([terminator])]);',
    '  const value = payload.toString("utf8");',
    '  paint(9, "PROVIDER_STORY_ORACLE_UTF8:" + hex(received));',
    '  if (value === "CAP_STORY_FREEZE") {',
    '    stopTick();',
    '    paint(7, ESC + "[38;5;214mPROVIDER_STORY_FROZEN stable");',
    '  } else if (value === "CAP_STORY_LIVE_ONCE") {',
    '    stopTick();',
    '    paint(7, ESC + "[38;5;214mPROVIDER_STORY_LIVE_PROBE exactly-once");',
    '  }',
    '  paint(8, "PROVIDER_STORY_ECHO:" + value);',
    '  resizeMarker();',
    '  if (value === "exit") shutdown(0);',
    '}',
    'function consumeInput() {',
    '  while (pending.length > 0) {',
    '    if (pending[0] === 27) {',
    '      if (pending.length < 3) return;',
    '      if (pending[1] === 91 && pending[2] === 77) {',
    '        if (pending.length < 6) return;',
    '        const mouse = pending.subarray(0, 6);',
    '        pending = pending.subarray(6);',
    '        paint(10, "PROVIDER_STORY_ORACLE_MOUSE:" + hex(mouse));',
    '        continue;',
    '      }',
    '    }',
    '    const byte = pending[0];',
    '    pending = pending.subarray(1);',
    '    if (byte === CR || byte === LF) handleLine(byte);',
    '    else lineBytes.push(byte);',
    '  }',
    '}',
    'function shutdown(code) {',
    '  if (shuttingDown) return;',
    '  shuttingDown = true;',
    '  stopTick();',
    '  write(ESC + "[?1000l" + ESC + "[?1049l");',
    '  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);',
    '  emit("PROVIDER_STORY_DONE");',
    '  process.exit(code);',
    '}',
    '',
    'emit("PROVIDER_STORY_BEGIN");',
    'emit("PROVIDER_STORY_UTF8: 中文渲染正常 汉字边界");',
    'emit("PROVIDER_STORY_SPLIT_SAFE_MARKER: utf8-boundary");',
    'emit("PROVIDER_STORY_HISTORY_BULK_BEGIN");',
    'for (let index = 1; index <= 512; index += 1) {',
    '  emit("PROVIDER_STORY_HISTORY_" + String(index).padStart(4, "0") + " 中文 discarded-live-history");',
    '}',
    'emit("PROVIDER_STORY_HISTORY_BULK_END");',
    'renderFrame();',
    'resizeMarker();',
    'tick = setInterval(() => {',
    '  tickIndex += 1;',
    '  paint(7, ESC + "[38;5;214mPROVIDER_STORY_LIVE_" + String(tickIndex).padStart(3, "0") + " exactly-once");',
    '  if (tickIndex >= 60) stopTick();',
    '}, 250);',
    'process.on("SIGWINCH", resizeMarker);',
    'for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {',
    '  process.on(signal, () => shutdown(signal === "SIGINT" ? 130 : 143));',
    '}',
    'if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);',
    'process.stdin.resume();',
    'process.stdin.on("data", (chunk) => {',
    '  pending = Buffer.concat([pending, Buffer.from(chunk)]);',
    '  consumeInput();',
    '});',
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
 * `SandboxTerminalSession` consumes a provider-owned transport and presents it
 * to the gateway as a {@link AgentTerminalPty}, exposing the same
 * `onData`/`write`/`resize`/`pause`/`resume` surface the gateway consumes.
 */
export class SandboxTerminalSession implements AgentTerminalPty {
  private readonly logger: SandboxTerminalSessionLogger = noopLogger;

  /** Always resolves exactly once; it never rejects when callers ignore it. */
  readonly launchDecision: Promise<AgentTerminalLaunchOutcome>;
  readonly cleanupDecision: Promise<TerminalTransportCleanupSettlement>;
  private resolveLaunchDecision!: (outcome: AgentTerminalLaunchOutcome) => void;
  private resolveCleanupDecision!: (
    settlement: TerminalTransportCleanupSettlement,
  ) => void;
  private launchDecisionSettled = false;
  private cleanupDecisionSettled = false;
  private launchAbortListener?: () => void;

  /** Subscribers to translated raw PTY output (decoded sandbox `output` data). */
  private readonly dataListeners = new Set<AgentTerminalDataListener>();

  /** The provider terminal transport into the sandbox. */
  private transport: TerminalTransport;

  /** Opens a fresh provider terminal transport when a closed bridge must re-attach. */
  private readonly transportFactory: TerminalTransportFactory;
  /** Only unresolved generations are retained; settled counts fold immediately. */
  private readonly pendingTransportCleanupDecisions = new Set<
    Promise<TerminalTransportCleanupSettlement>
  >();
  private completedTransportCleanup =
    confirmedEmptyTerminalCleanupSettlement();
  private readonly commandExecutor: SandboxCommandExecutor;
  private closeStarted = false;

  /**
   * Browser resize events can arrive while the provider is still settling a
   * replacement owner transport. Keep detached-window mutations ordered so an
   * older, slower HTTP command can never overwrite a newer browser geometry.
   */
  private detachedResizeCommandTail: Promise<void> = Promise.resolve();

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
  private terminalStartup: SandboxTerminalStartup = {
    replyToStartupDSR: false,
    promptSubmit: 'none',
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

  /** Active recovery of the single task owner after an unexpected PTY close. */
  private ownerRecoveryActive = false;
  private ownerRecoveryGeneration = 0;
  private ownerRecoveryAttempt = 0;
  private ownerRecoveryStartedAt = 0;
  private ownerRecoveryTimer?: ReturnType<typeof setTimeout>;
  private ownerRecoveryReadyTimer?: ReturnType<typeof setTimeout>;
  private suppressCurrentTransportClose = false;
  /** Recovery candidates invalidated before a replacement becomes current. */
  private readonly retiredTransports = new WeakSet<TerminalTransport>();
  private readonly ownerRecoveryPolicy: Required<
    Omit<SandboxTerminalOwnerRecoveryPolicy, 'onEvent'>
  > &
    Pick<SandboxTerminalOwnerRecoveryPolicy, 'onEvent'>;

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
   *                 - `'attach-only'`: probe the named session and attach only
   *                   after it is definitively live. A gone or indeterminate
   *                   probe is surfaced through `launchDecision` and never falls
   *                   back to `tmux new-session`.
   *                 - `'replay-only'`: do nothing on `ready` (no launch, no attach,
   *                   no liveness poller). Retained as an inert compatibility/test
   *                   mode; live reconnect no longer reads snapshot or log-tail data.
   */
  /**
   * The task's selected {@link AgentRuntime} (3.2), resolved ONCE on `ready` via
   * the combined launch-context resolver before launching. It remains undefined for
   * non-launch modes; a launch mode without a valid resolver fails preflight.
   */
  private runtime?: SandboxTerminalRuntime;
  private modelIntent?: TaskModelIntent;
  private modelMaterial?: TaskModelLaunchMaterial;
  private launchContextResolution?: Promise<void>;
  private launchDecisionStarted = false;
  private runtimeSetupFailureReported = false;

  /**
   * The task's execution mode (add-headless-execution-track), resolved alongside
   * {@link runtime}. `headless-exec` switches the launch to the runtime's
   * non-interactive `buildHeadlessLine`.
   */
  private executionMode: SandboxTerminalExecutionMode = 'interactive-pty';

  constructor(
    private readonly taskId: string,
    _legacyWsUrl: string,
    _legacyBaseUrl: string,
    private readonly onExit?: (status: SandboxTerminalSessionExitStatus) => void,
    private readonly mode: SandboxTerminalSessionMode = 'replay-only',
    /**
     * Resolve the task's selected runtime, execution mode, and model intent at most
     * once before a launch-or-attach decision. It is optional only for modes that do
     * not launch; a missing/rejected/invalid result in a launch mode fails setup.
     */
    private readonly resolveTaskLaunchContext?: () => Promise<SandboxResolvedTaskLaunchContext>,
    transportFactory?: TerminalTransportFactory,
    commandExecutor?: SandboxCommandExecutor,
    private readonly prepareModelMaterial?: (
      intent: TaskModelIntent,
    ) => Promise<TaskModelLaunchMaterial>,
    private readonly onRuntimeSetupFailure?: (
      code: 'runtime_model_setup_failed',
    ) => void,
    /** Cancellation fence supplied by the durable admission owner. */
    private readonly signal?: AbortSignal,
    /** Final DB-backed authority check before a fresh agent launch. */
    private readonly beforeAgentLaunch?: () => Promise<void>,
    /** Provider-owned exit/wait protocol, normalized to one optional code. */
    private readonly resolveProviderExitStatus?: () => Promise<number | null>,
    ownerRecoveryPolicy: SandboxTerminalOwnerRecoveryPolicy = {},
  ) {
    this.launchDecision = new Promise<AgentTerminalLaunchOutcome>((resolve) => {
      this.resolveLaunchDecision = resolve;
    });
    this.cleanupDecision = new Promise<TerminalTransportCleanupSettlement>(
      (resolve) => {
        this.resolveCleanupDecision = resolve;
      },
    );
    if (!transportFactory || !commandExecutor) {
      throw new Error(
        'Sandbox terminal session requires a transport factory and command executor',
      );
    }
    this.transportFactory = transportFactory;
    this.commandExecutor = commandExecutor;
    this.ownerRecoveryPolicy = normalizeOwnerRecoveryPolicy(ownerRecoveryPolicy);
    this.sessionName = detachedSessionName(taskId);
    // The provider transport always opens a fresh provider PTY. The task itself
    // lives in a detached named tmux session that this engine launches or joins;
    // Fresh viewer attachments above this seam own browser reconnect/restore.
    this.transport = this.openTransport();
    this.listenForAgentLaunchAbort();
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
    const cleanup = normalizeTerminalCleanupDecision(
      transport.cleanupDecision,
    );
    this.pendingTransportCleanupDecisions.add(cleanup);
    void cleanup.then((settlement) => {
      this.pendingTransportCleanupDecisions.delete(cleanup);
      this.completedTransportCleanup = aggregateTerminalCleanupSettlements([
        this.completedTransportCleanup,
        settlement,
      ]);
    });
    transport.onFrame((frame) => {
      if (
        transport !== this.transport ||
        this.retiredTransports.has(transport)
      ) {
        return;
      }
      this.onTransportFrame(frame);
    });
    transport.onClose(() => {
      if (
        transport !== this.transport ||
        this.retiredTransports.has(transport)
      ) {
        return;
      }
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
    // An established owner reconnect is an ownership hand-off, not a cheap
    // socket redial. In particular, terminal-query responses can arrive while
    // the provider is reporting a socket drop. Opening a replacement here
    // would bypass the exact old-generation cleanup fence and allow two tmux
    // clients to coexist. Queue input until the bounded owner recovery path has
    // proved the old transport detached.
    if (this.closeStarted || this.exitResolved || this.ownerRecoveryActive) return;
    if (this.reconnectingForInput) return;
    if (this.transport.readyState === 'connecting') return;
    if (
      this.established &&
      (this.mode === 'launch-or-attach' || this.mode === 'attach-only')
    ) {
      this.beginOwnerRecovery();
      try {
        this.transport.close();
      } catch {
        // The recovery cleanup deadline owns the fail-closed outcome.
      }
      return;
    }
    this.reconnectingForInput = true;
    this.launchDecisionStarted = false;
    this.established = false;
    this.sawSessionId = false;
    this.suppressCurrentTransportClose = true;
    this.transport.close();
    this.transport = this.openTransport();
    this.suppressCurrentTransportClose = false;
  }

  /**
   * Resolve the task's selected {@link AgentRuntime} EXACTLY ONCE (3.2), caching it
   * on {@link runtime}. A missing resolver, rejected promise, or invalid result fails
   * launch-context preflight. Idempotent — a second call returns the same promise.
   */
  private ensureTaskLaunchContextResolved(): Promise<void> {
    if (this.launchContextResolution) return this.launchContextResolution;
    this.launchContextResolution = (async () => {
      if (!this.resolveTaskLaunchContext) {
        throw new SandboxRuntimeModelSetupError('launch-context');
      }
      let context: SandboxResolvedTaskLaunchContext;
      try {
        context = await this.resolveTaskLaunchContext();
      } catch (error) {
        if (error instanceof SandboxRuntimeModelSetupError) throw error;
        throw new SandboxRuntimeModelSetupError('lookup');
      }
      if (
        !context.runtime ||
        (context.executionMode !== 'interactive-pty' &&
          context.executionMode !== 'headless-exec') ||
        (context.modelIntent.kind !== 'runtime-default' &&
          context.modelIntent.kind !== 'explicit')
      ) {
        throw new SandboxRuntimeModelSetupError('launch-context');
      }
      this.runtime = context.runtime;
      this.executionMode = context.executionMode;
      this.modelIntent = context.modelIntent;
      this.modelMaterial = taskModelLaunchMaterial(context.modelIntent);
    })();
    return this.launchContextResolution;
  }

  /**
   * Launch the task's selected agent in a fresh detached tmux session. For an
   * UNRESOLVED runtime this is {@link launchCodex} (the native-terminal Codex
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
    const model = this.modelMaterial;
    if (!runtime || !model) {
      throw new SandboxRuntimeModelSetupError('launch-context');
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
      sessionId: terminalSessionIdForTask(this.taskId),
      model,
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
   *   tmux -u set-window-option -t =task<taskId>: window-size manual \;
   *   set-option -t =task<taskId>: status off \;
   *   attach-session -f ignore-size -t =task<taskId>
   *
   * The detached session makes codex a child of the container tmux daemon, so it
   * KEEPS RUNNING when this WS closes (api restart / operator disconnect); the
   * immediate attach makes THIS WS shell a client of that session so codex's TUI
   * output streams over the WS and the DSR-gated single-carriage-return auto-submit
   * still works WITHIN the attached session (the CPR reply and the auto-submit
   * Enter land in the attached pane, exactly as before). `argv` defaults to
   * {@link DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV}, the same launch contract baked
   * into both provider images as `CODEX_LAUNCH_ARGV`.
   */
  launchCodex(
    argv: string =
      process.env['CODEX_LAUNCH_ARGV'] ??
      DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
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
    model: TaskModelLaunchMaterial = { kind: 'runtime-default' },
  ): void {
    if (model.kind !== 'runtime-default') {
      throw new SandboxRuntimeModelSetupError('launch-context');
    }
    // Create the detached session carrying codex with the task prompt PRE-FILLED
    // (when one was injected at provision time) without inlining the prompt text,
    // then attach so its output streams here and the output-quiescence trigger in
    // `onOutput` can auto-submit the pre-filled goal (codex's positional prompt
    // does not auto-run on its own).
    this.launchedCodex = armAutoSubmit;
    if (!armAutoSubmit) {
      this.beginAttachBootstrapWindow();
    }
    const nativeArgv = assertNativeCodexInteractiveLaunchArgv(argv);
    this.sendInput(`${buildDetachedCodexLaunchLine(this.taskId, nativeArgv)}\n`);
    this.attachSession();
  }

  /**
   * Attach this WS shell to the (already-running) detached named session
   * `task<taskId>` (survive-api-redeploy D2/2.3). Sends a tmux command that first
   * disables tmux's own status line and then attaches, so the live agent output
   * streams over this WS without leaking `[task<id>:bash*]` chrome or consuming a
   * terminal row. Operator input is injected into the shared pane — the
   * operator-reconnect / boot-re-adoption path. `ignore-size` prevents the
   * provider bridge's bootstrap grid from reflowing the authoritative pane;
   * the Gateway applies writer geometry separately. Does NOT launch a new agent. The
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
    if (this.launchDecisionStarted || this.launchDecisionSettled) return;
    this.launchDecisionStarted = true;
    // Provider-backed terminals (notably BoxLite) may echo a login shell prompt as
    // soon as the WS reports ready, before the async tmux liveness probe returns.
    // Treat that pre-decision shell noise as attach bootstrap so it stays live-only
    // and never becomes durable task history.
    this.beginAttachBootstrapWindow();
    let bootstrapHandedOff = false;
    let sessionActive = false;
    try {
      await this.ensureTaskLaunchContextResolved();
      if (this.launchDecisionSettled) return;
      const alive = await this.hasSession();
      if (this.launchDecisionSettled) return;
      if (alive === true) {
        bootstrapHandedOff = true;
        this.attachToNamedSession();
        sessionActive = true;
        this.settleLaunchDecision({ kind: 'attached' });
      } else if (alive === false) {
        // Definitively GONE → genuine fresh launch; arm the auto-submit (the runtime
        // gates whether an Enter is actually injected — claude's autoSubmit is a no-op).
        await this.prepareFreshAgentLaunch();
        // No await is permitted between this final signal check and launchAgent:
        // launchAgent synchronously sends both the tmux launch and attach lines.
        if (this.launchDecisionSettled) return;
        this.assertAgentLaunchSignal();
        this.endAttachBootstrapWindow();
        bootstrapHandedOff = true;
        this.launchAgent();
        sessionActive = true;
        this.settleLaunchDecision({ kind: 'launched' });
      } else {
        // INCONCLUSIVE → fresh launch as a recoverable fallback, but DO NOT arm
        // the auto-submit: if an agent was actually already running, the duplicate
        // `tmux new-session` is a no-op and the attach rejoins it, so a stray Enter
        // must not be injected.
        await this.prepareFreshAgentLaunch();
        // Keep the last cancellation read adjacent to the synchronous launch.
        if (this.launchDecisionSettled) return;
        this.assertAgentLaunchSignal();
        bootstrapHandedOff = true;
        this.launchAgent(false);
        sessionActive = true;
        this.settleLaunchDecision({ kind: 'launched' });
      }
    } catch (error) {
      if (!bootstrapHandedOff) this.endAttachBootstrapWindow();
      if (error instanceof SandboxAgentLaunchFencedError) {
        this.fencePendingAgentLaunch();
      } else {
        this.settleLaunchDecision({ kind: 'failed' });
        this.reportRuntimeSetupFailure();
      }
    } finally {
      if (sessionActive) this.startLivenessPoller();
    }
  }

  /**
   * Re-adoption-only decision used during startup recovery. Unlike
   * {@link launchOrAttachOnReady}, this path has no fresh-launch fallback:
   * recovery must not turn an absent or temporarily unprobeable historical
   * session into a second agent process.
   */
  private async attachOnlyOnReady(): Promise<void> {
    if (this.launchDecisionStarted || this.launchDecisionSettled) return;
    this.launchDecisionStarted = true;
    this.beginAttachBootstrapWindow();
    let bootstrapHandedOff = false;
    let sessionActive = false;
    try {
      const alive = await this.hasSession();
      if (this.launchDecisionSettled) return;
      if (alive === true) {
        bootstrapHandedOff = true;
        this.attachToNamedSession();
        sessionActive = true;
        this.settleLaunchDecision({ kind: 'attached' });
        return;
      }
      this.settleLaunchDecision({
        kind: alive === false ? 'absent' : 'indeterminate',
      });
    } catch {
      // `hasSession` normally translates transport errors to `null`; keep this
      // defensive branch equally fail-closed if an executor violates that seam.
      this.settleLaunchDecision({ kind: 'indeterminate' });
    } finally {
      if (!bootstrapHandedOff) this.endAttachBootstrapWindow();
      if (sessionActive) this.startLivenessPoller();
    }
  }

  /**
   * Finish every asynchronous launch prerequisite, then execute the caller's
   * durable authority check. The caller performs one final synchronous signal
   * check after this promise settles and immediately before sending input.
   */
  private async prepareFreshAgentLaunch(): Promise<void> {
    await this.prepareFreshModelMaterial();
    this.assertAgentLaunchSignal();
    if (!this.beforeAgentLaunch) return;
    try {
      await this.beforeAgentLaunch();
    } catch {
      // Coordination/lease errors are intentionally not reclassified as model
      // setup failures and their possibly-sensitive diagnostics are not logged.
      throw new SandboxAgentLaunchFencedError();
    }
  }

  private assertAgentLaunchSignal(): void {
    if (this.signal?.aborted) throw new SandboxAgentLaunchFencedError();
  }

  private listenForAgentLaunchAbort(): void {
    if (!this.signal || this.mode !== 'launch-or-attach') return;
    const onAbort = () => this.fencePendingAgentLaunch();
    this.launchAbortListener = onAbort;
    if (this.signal.aborted) onAbort();
    else this.signal.addEventListener('abort', onAbort, { once: true });
  }

  private settleLaunchDecision(outcome: AgentTerminalLaunchOutcome): boolean {
    if (this.launchDecisionSettled) return false;
    this.launchDecisionSettled = true;
    if (this.signal && this.launchAbortListener) {
      this.signal.removeEventListener('abort', this.launchAbortListener);
      this.launchAbortListener = undefined;
    }
    this.resolveLaunchDecision(outcome);
    return true;
  }

  private fencePendingAgentLaunch(): void {
    if (!this.settleLaunchDecision({ kind: 'fenced' })) return;
    this.launchDecisionStarted = true;
    this.close();
  }

  private async prepareFreshModelMaterial(): Promise<void> {
    const intent = this.modelIntent;
    if (!intent || !this.prepareModelMaterial) {
      throw new SandboxRuntimeModelSetupError('launch-context');
    }
    let prepared: TaskModelLaunchMaterial;
    try {
      prepared = await this.prepareModelMaterial(intent);
    } catch (error) {
      if (error instanceof SandboxRuntimeModelSetupError) throw error;
      throw new SandboxRuntimeModelSetupError('material-write');
    }
    const expected = taskModelLaunchMaterial(intent);
    if (
      prepared.kind !== expected.kind ||
      (prepared.kind === 'explicit' &&
        expected.kind === 'explicit' &&
        (prepared.path !== expected.path ||
          prepared.checksum !== expected.checksum))
    ) {
      throw new SandboxRuntimeModelSetupError('material-verify');
    }
    this.modelMaterial = prepared;
  }

  private reportRuntimeSetupFailure(): void {
    if (this.runtimeSetupFailureReported) return;
    this.runtimeSetupFailureReported = true;
    this.stopOwnerRecovery();
    this.stopLivenessPoller();
    this.onRuntimeSetupFailure?.('runtime_model_setup_failed');
  }

  /**
   * Dev/test-only provider-backed terminal story fixture. It deliberately does
   * not launch Codex/Claude; the goal is to exercise the provider PTY transport
   * and CAP gateway through the same detached named tmux topology as production:
   * one owner plus repeatable attach-only viewers, a long discarded history
   * prefix, and a deterministic native alternate-screen current frame.
   */
  private async launchProviderStoryFixture(): Promise<void> {
    if (
      this.providerStoryFixtureStarted ||
      this.launchDecisionStarted ||
      this.launchDecisionSettled
    ) {
      return;
    }
    this.providerStoryFixtureStarted = true;
    this.launchDecisionStarted = true;
    this.beginAttachBootstrapWindow();
    let sessionActive = false;
    try {
      const install = await this.commandExecutor.exec({
        command: buildProviderStoryFixtureInstallCommand(),
        timeoutMs: 5_000,
      });
      if (install.exitCode !== 0 || install.timedOut) {
        throw new Error(
          `fixture install failed: exit_code ${install.exitCode}`,
        );
      }

      // Create the exact task session through the command endpoint and wait for
      // that command to finish before settling launchDecision. This removes the
      // old race where a viewer could probe before the shell had executed
      // `tmux new-session`, and it makes the fixture structurally identical to a
      // real owner/viewer session rather than a script on the outer WS shell.
      const launch = await this.commandExecutor.exec({
        command: wrapInDetachedSession(
          this.taskId,
          `node ${PROVIDER_STORY_SCRIPT_PATH}`,
        ),
        timeoutMs: 5_000,
      });
      if (launch.exitCode !== 0 || launch.timedOut) {
        throw new Error(
          `fixture detached launch failed: exit_code ${launch.exitCode}`,
        );
      }

      this.attachToNamedSession();
      sessionActive = true;
      this.settleLaunchDecision({ kind: 'launched' });
    } catch (err) {
      this.endAttachBootstrapWindow();
      this.settleLaunchDecision({ kind: 'failed' });
      this.logger.warn(
        `task ${this.taskId}: provider story fixture launch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      if (sessionActive) this.startLivenessPoller();
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

    this.detachedResizeCommandTail = this.detachedResizeCommandTail
      .then(() => this.applyDetachedSessionResize(command))
      .catch((err) => {
        this.logger.debug(
          `task ${this.taskId}: detached tmux resize skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  private async applyDetachedSessionResize(command: string): Promise<void> {
    let lastFailure = 'unknown failure';

    for (let attempt = 1; attempt <= TMUX_RESIZE_MAX_ATTEMPTS; attempt += 1) {
      if (this.closeStarted) return;

      try {
        const result = await this.commandExecutor.exec({
          command,
          timeoutMs: TMUX_RESIZE_TIMEOUT_MS,
        });
        if (result.exitCode === 0 && !result.timedOut) return;
        lastFailure = result.timedOut
          ? 'command timed out'
          : `exit code ${result.exitCode}`;
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err);
      }

      if (
        attempt < TMUX_RESIZE_MAX_ATTEMPTS &&
        !this.closeStarted
      ) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, TMUX_RESIZE_RETRY_DELAY_MS);
        });
      }
    }

    throw new Error(
      `failed after ${TMUX_RESIZE_MAX_ATTEMPTS} attempts (${lastFailure})`,
    );
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
   * now-defunct bridge (the next process re-adopts via a fresh `SandboxTerminalSession`).
   */
  close(): void {
    if (this.closeStarted) return;
    this.closeStarted = true;
    this.settleLaunchDecision({ kind: 'fenced' });
    this.exitResolved = true;
    this.stopOwnerRecovery();
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
    } finally {
      this.settleTransportCleanupDecisions();
    }
  }

  private settleTransportCleanupDecisions(): void {
    const pending = [...this.pendingTransportCleanupDecisions];
    void Promise.all(pending).then(() => {
      if (this.cleanupDecisionSettled) return;
      this.cleanupDecisionSettled = true;
      this.resolveCleanupDecision(this.completedTransportCleanup);
    });
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
      case 'ready': {
        // `session_id` then `ready` is the session-established signal: the AIO
        // shell is now live. Codex itself lives in a DETACHED tmux session
        // (survive-api-redeploy D1) that we launch fresh or re-attach to. A
        // replay-only terminal does neither. Best-effort: an error is logged,
        // never thrown, so it cannot break the WS message handler.
        this.established = true;
        if (this.ownerRecoveryActive) {
          // `ready` is not restoration by itself. The replacement must accept
          // the attach command; otherwise reporting `restored` would let queued
          // operator/query input trigger another transport while no owner is
          // actually attached.
          this.beginAttachBootstrapWindow();
          const attachAccepted = this.transport.sendInput(
            `${buildAttachSessionCommand(this.taskId)}\n`,
          );
          if (!attachAccepted) {
            this.established = false;
            return;
          }
          this.flushPendingInputSoon();
          this.clearOwnerRecoveryReadyTimer();
          this.finishOwnerRecovery();
          this.startLivenessPoller();
          break;
        }
        const reconnectingForInput = this.reconnectingForInput;
        this.reconnectingForInput = false;
        if (this.mode === 'launch-or-attach') {
          if (reconnectingForInput && this.launchDecisionSettled) {
            // The one durable launch-or-attach decision was already settled on
            // the original bridge. A replacement input bridge must rejoin that
            // same detached session without trying to reopen or resettle it.
            this.attachToNamedSession();
          } else {
            void this.launchOrAttachOnReady();
          }
        } else if (this.mode === 'attach-only') {
          void this.attachOnlyOnReady();
        } else if (this.mode === 'provider-story-fixture') {
          void this.launchProviderStoryFixture();
        }
        break;
      }
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
    if (
      ATTACH_BOOTSTRAP_MAX_MS <= 0 ||
      ATTACH_BOOTSTRAP_QUIESCE_MS <= 0
    ) {
      this.endAttachBootstrapWindow();
      return;
    }
    this.attachBootstrapMaxTimer = setTimeout(() => {
      this.endAttachBootstrapWindow();
    }, ATTACH_BOOTSTRAP_MAX_MS);
    this.attachBootstrapMaxTimer.unref?.();
    // Provider attach latency can exceed the quiet duration before the first
    // repaint byte arrives. Start the quiet countdown from outputMeta() instead
    // of attach-command submission so that delayed current-frame output remains
    // producer-ineligible; the max timer above still keeps the gap bounded.
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
    if (this.suppressCurrentTransportClose || this.exitResolved) return;
    if (this.ownerRecoveryActive) {
      this.clearOwnerRecoveryReadyTimer();
      const generation = this.ownerRecoveryGeneration;
      void this.fenceClosedOwnerGeneration(
        generation,
        normalizeTerminalCleanupDecision(this.transport.cleanupDecision),
      );
      return;
    }
    // A close before the terminal was ever established means the dial failed: no
    // detached session exists, no liveness poller is running, so resolve the
    // abnormal start here (the only WS-close that still terminates the task).
    if (!this.established) {
      if (this.exitResolved) return;
      this.exitResolved = true;
      this.settleLaunchDecision({ kind: 'failed' });
      this.logger.warn(
        `task ${this.taskId}: terminal WS closed before session established (abnormal)`,
      );
      this.onExit?.({ code: null, abnormal: true });
      return;
    }
    if (!this.launchDecisionSettled) {
      this.launchDecisionStarted = true;
      this.settleLaunchDecision({ kind: 'failed' });
    }
    // Established session: the WS closed but the detached session may still be
    // alive. Do NOT resolve exit here — the liveness poller decides. Stop polling
    // over this (now-dead) WS's HTTP surface only if the exit was already resolved.
    this.logger.debug(
      `task ${this.taskId}: terminal WS closed; detached session ${this.sessionName} left for re-adoption (not terminating)`,
    );
    if (this.mode === 'launch-or-attach' || this.mode === 'attach-only') {
      this.beginOwnerRecovery();
    }
  }

  private beginOwnerRecovery(): void {
    if (this.ownerRecoveryActive || this.exitResolved) return;
    this.ownerRecoveryActive = true;
    this.ownerRecoveryGeneration += 1;
    this.ownerRecoveryAttempt = 0;
    this.ownerRecoveryStartedAt = Date.now();
    this.established = false;
    this.sawSessionId = false;
    this.emitOwnerRecoveryEvent({ kind: 'outage', attempt: 0, durationMs: 0 });
    const generation = this.ownerRecoveryGeneration;
    const cleanup = normalizeTerminalCleanupDecision(
      this.transport.cleanupDecision,
    );
    void this.fenceClosedOwnerGeneration(generation, cleanup);
  }

  private async fenceClosedOwnerGeneration(
    generation: number,
    cleanup: Promise<TerminalTransportCleanupSettlement>,
  ): Promise<void> {
    const settlement = await settleTerminalCleanupBeforeDeadline(
      cleanup,
      this.ownerRecoveryPolicy.cleanupTimeoutMs,
    );
    if (!this.isCurrentOwnerRecovery(generation)) return;
    if (!settlement || settlement.kind !== 'confirmed') {
      this.failOwnerRecovery('cleanup-unconfirmed');
      return;
    }
    this.scheduleOwnerRecoveryAttempt(generation);
  }

  private scheduleOwnerRecoveryAttempt(generation: number): void {
    if (
      !this.ownerRecoveryActive ||
      this.exitResolved ||
      generation !== this.ownerRecoveryGeneration ||
      this.ownerRecoveryTimer
    ) {
      return;
    }
    if (this.ownerRecoveryAttempt >= this.ownerRecoveryPolicy.maxAttempts) {
      this.failOwnerRecovery('budget-exhausted');
      return;
    }
    const exponent = Math.max(0, this.ownerRecoveryAttempt);
    const baseDelay = Math.min(
      this.ownerRecoveryPolicy.maxDelayMs,
      this.ownerRecoveryPolicy.baseDelayMs * 2 ** exponent,
    );
    const jitter =
      (this.ownerRecoveryPolicy.random() * 2 - 1) *
      this.ownerRecoveryPolicy.jitterRatio;
    const delayMs = Math.max(1, Math.round(baseDelay * (1 + jitter)));
    this.ownerRecoveryTimer = setTimeout(() => {
      this.ownerRecoveryTimer = undefined;
      void this.runOwnerRecoveryAttempt(generation);
    }, delayMs);
    this.ownerRecoveryTimer.unref?.();
  }

  private async runOwnerRecoveryAttempt(generation: number): Promise<void> {
    if (!this.isCurrentOwnerRecovery(generation)) return;
    this.ownerRecoveryAttempt += 1;
    this.emitOwnerRecoveryEvent({
      kind: 'retry',
      attempt: this.ownerRecoveryAttempt,
      durationMs: this.ownerRecoveryDuration(),
    });

    const alive = await this.hasSession();
    if (!this.isCurrentOwnerRecovery(generation)) return;
    if (alive === false) {
      this.failOwnerRecovery('absent');
      return;
    }
    if (alive === null) {
      this.scheduleOwnerRecoveryAttempt(generation);
      return;
    }

    let candidate: TerminalTransport;
    try {
      this.established = false;
      this.sawSessionId = false;
      candidate = this.openTransport();
      this.transport = candidate;
    } catch {
      this.scheduleOwnerRecoveryAttempt(generation);
      return;
    }
    this.ownerRecoveryReadyTimer = setTimeout(() => {
      this.ownerRecoveryReadyTimer = undefined;
      if (!this.isCurrentOwnerRecovery(generation)) return;
      if (this.transport !== candidate) return;
      // Retire before close: a provider can emit a late `ready` after the
      // timeout callback but before its cleanup promise settles. That frame
      // must not attach or report the timed-out candidate as restored.
      this.retiredTransports.add(candidate);
      this.suppressCurrentTransportClose = true;
      try {
        candidate.close();
      } catch {
        // The bounded recovery budget owns the failure outcome.
      } finally {
        this.suppressCurrentTransportClose = false;
      }
      void this.fenceClosedOwnerGeneration(
        generation,
        normalizeTerminalCleanupDecision(candidate.cleanupDecision),
      );
    }, this.ownerRecoveryPolicy.readyTimeoutMs);
    this.ownerRecoveryReadyTimer.unref?.();
  }

  private finishOwnerRecovery(): void {
    if (!this.ownerRecoveryActive) return;
    const event: SandboxTerminalOwnerRecoveryEvent = {
      kind: 'restored',
      attempt: this.ownerRecoveryAttempt,
      durationMs: this.ownerRecoveryDuration(),
    };
    this.ownerRecoveryActive = false;
    this.clearOwnerRecoveryTimers();
    this.emitOwnerRecoveryEvent(event);
  }

  private failOwnerRecovery(
    reason: 'absent' | 'budget-exhausted' | 'cleanup-unconfirmed',
  ): void {
    if (!this.ownerRecoveryActive || this.exitResolved) return;
    const event: SandboxTerminalOwnerRecoveryEvent = {
      kind: 'failed',
      reason,
      attempt: this.ownerRecoveryAttempt,
      durationMs: this.ownerRecoveryDuration(),
    };
    this.ownerRecoveryActive = false;
    this.clearOwnerRecoveryTimers();
    this.exitResolved = true;
    this.stopLivenessPoller();
    this.logger.warn(
      `task ${this.taskId}: terminal owner recovery ${reason}; entering unobserved-exit reconciliation`,
    );
    this.emitOwnerRecoveryEvent(event);
    this.onExit?.({ code: null, abnormal: true });
  }

  private stopOwnerRecovery(): void {
    this.ownerRecoveryActive = false;
    this.ownerRecoveryGeneration += 1;
    this.clearOwnerRecoveryTimers();
  }

  private clearOwnerRecoveryTimers(): void {
    if (this.ownerRecoveryTimer) clearTimeout(this.ownerRecoveryTimer);
    this.ownerRecoveryTimer = undefined;
    this.clearOwnerRecoveryReadyTimer();
  }

  private clearOwnerRecoveryReadyTimer(): void {
    if (this.ownerRecoveryReadyTimer) clearTimeout(this.ownerRecoveryReadyTimer);
    this.ownerRecoveryReadyTimer = undefined;
  }

  private isCurrentOwnerRecovery(generation: number): boolean {
    return (
      this.ownerRecoveryActive &&
      !this.exitResolved &&
      generation === this.ownerRecoveryGeneration
    );
  }

  private ownerRecoveryDuration(): number {
    return Math.max(0, Date.now() - this.ownerRecoveryStartedAt);
  }

  private emitOwnerRecoveryEvent(event: SandboxTerminalOwnerRecoveryEvent): void {
    try {
      this.ownerRecoveryPolicy.onEvent?.(event);
    } catch {
      // Metrics/diagnostic observers cannot own terminal recovery control flow.
    }
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
   * UNRESOLVED runtime falls to the direct has-session compatibility path below.
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
        // Only an UNRESOLVED runtime falls to the direct has-session path below.
        await this.pollRuntimeExit(runtime);
        return;
      }
      // Unresolved runtime only → the direct has-session termination path.
      const alive = await this.hasSession();
      if (alive === null) return; // inconclusive — re-check next tick
      if (alive) return; // still running
      // Session gone: resolve the real exit status (D4) and terminate exactly once.
      if (this.exitResolved) return;
      this.exitResolved = true;
      this.stopOwnerRecovery();
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
  private async pollRuntimeExit(runtime: SandboxTerminalRuntime): Promise<void> {
    // Call the port runtime's `detectExit` directly (refactor step 5: no adapter) —
    // a port `SandboxExec` (via {@link toPortExec}) + the port `LaunchContext`. BOTH
    // codex and claude resolve from the `tmux has-session` GONE check; claude is a
    // resident session, so a finished turn keeps it running (not killed on end_turn).
    let signal: SandboxTerminalExitSignal | undefined;
    try {
      if (!this.modelMaterial) {
        throw new SandboxRuntimeModelSetupError('launch-context');
      }
      signal = await runtime.detectExit(toSandboxTerminalRuntimeExec(this.runSandboxExec()), {
        taskId: this.taskId,
        workspaceDir: CLAUDE_WORKSPACE_DIR,
        sessionId: terminalSessionIdForTask(this.taskId),
        model: this.modelMaterial,
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
      this.stopOwnerRecovery();
      this.stopLivenessPoller();
      const status: SandboxTerminalSessionExitStatus = await this.resolveExitStatus();
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
    this.stopOwnerRecovery();
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
  private runSandboxExec(): SandboxLegacyTerminalExec {
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
  private async resolveExitStatus(): Promise<SandboxTerminalSessionExitStatus> {
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

  /** Resolve an exit code through the provider-owned normalized wait seam. */
  private async resolveViaWait(): Promise<number | null> {
    if (!this.resolveProviderExitStatus) return null;
    try {
      return coerceExitCode(await this.resolveProviderExitStatus());
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
    if (this.closeStarted || this.exitResolved) return;
    if (this.ownerRecoveryActive) {
      this.pendingInput.push(data);
      return;
    }
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
      command: `${buildExactHasSessionCommand(taskId)}; echo __cap_has__$?`,
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

function settleTerminalCleanupBeforeDeadline(
  cleanup: Promise<TerminalTransportCleanupSettlement>,
  timeoutMs: number,
): Promise<TerminalTransportCleanupSettlement | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      value: TerminalTransportCleanupSettlement | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    timer.unref?.();
    void cleanup.then(
      (value) => settle(value),
      () => settle(null),
    );
  });
}

function normalizeOwnerRecoveryPolicy(
  policy: SandboxTerminalOwnerRecoveryPolicy,
): Required<Omit<SandboxTerminalOwnerRecoveryPolicy, 'onEvent'>> &
  Pick<SandboxTerminalOwnerRecoveryPolicy, 'onEvent'> {
  const random = policy.random ?? Math.random;
  return {
    maxAttempts: boundedInteger(
      policy.maxAttempts,
      OWNER_RECOVERY_MAX_ATTEMPTS,
      1,
      20,
    ),
    baseDelayMs: boundedInteger(
      policy.baseDelayMs,
      OWNER_RECOVERY_BASE_DELAY_MS,
      1,
      60_000,
    ),
    maxDelayMs: boundedInteger(
      policy.maxDelayMs,
      OWNER_RECOVERY_MAX_DELAY_MS,
      1,
      60_000,
    ),
    readyTimeoutMs: boundedInteger(
      policy.readyTimeoutMs,
      OWNER_RECOVERY_READY_TIMEOUT_MS,
      1,
      60_000,
    ),
    cleanupTimeoutMs: boundedInteger(
      policy.cleanupTimeoutMs,
      OWNER_RECOVERY_CLEANUP_TIMEOUT_MS,
      1,
      30_000,
    ),
    jitterRatio:
      typeof policy.jitterRatio === 'number' &&
      Number.isFinite(policy.jitterRatio) &&
      policy.jitterRatio >= 0 &&
      policy.jitterRatio <= 1
        ? policy.jitterRatio
        : OWNER_RECOVERY_JITTER_RATIO,
    random: () => {
      const value = random();
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    },
    onEvent: policy.onEvent,
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
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
