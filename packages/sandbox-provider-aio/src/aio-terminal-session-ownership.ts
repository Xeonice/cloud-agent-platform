import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import WebSocket from 'ws';
import type { SandboxOwnershipFence } from '@cap/sandbox-core';
import {
  AIO_SHELL_SESSION_CLEANUP_MAX_BUDGET_MS,
  deleteAioShellSessionExact,
  executeAioShellCommand,
  executeAioShellCommandSession,
  type AioShellFetch,
  type AioShellExecResponse,
  type AioShellSessionCommandExecutor,
  type AioShellSessionCleanupProof,
} from './aio-shell-exec.js';

const AIO_TERMINAL_OWNERSHIP_VERSION = 'cap-aio-terminal-v2';
const AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR =
  '/tmp/.cap-aio-terminal-pairs-v2';
const AIO_TERMINAL_OWNERSHIP_FILE_SUFFIX = '.owner';
const AIO_TERMINAL_SESSION_ID_MAX_CHARS = 512;
const AIO_TERMINAL_JOURNAL_RECORD_MAX_CHARS = 8_192;
const AIO_TERMINAL_JOURNAL_RECORD_MAX_BYTES = 16_384;
const AIO_TERMINAL_JOURNAL_MAX_RECORDS = 128;
const AIO_TERMINAL_REQUEST_TIMEOUT_DEFAULT_MS = 1_500;
const AIO_TERMINAL_REQUEST_TIMEOUT_MAX_MS = 5_000;
const AIO_TERMINAL_EXACT_RELEASE_TIMEOUT_DEFAULT_MS = 20_000;
const AIO_TERMINAL_EXACT_RELEASE_TIMEOUT_MAX_MS = 20_000;
const AIO_TERMINAL_EXACT_RELEASE_DRAIN_MARGIN_MS = 100;
const AIO_TERMINAL_EXACT_RELEASE_FINAL_PROOF_COMMAND_RESERVE_MS = 4_500;
// Keep the proof side large enough for its final command plus the exact
// temporary-control-session DELETE drain. Reserving 14 s here left only the
// first 6 s after ENQUEUE for reconnects; a same-task cohort legitimately queued
// behind a 4-5 s predecessor then had too little time to reconnect both of its
// exact provider identities even though its absolute 20 s deadline had ample
// room. This derived 9.25 s reserve preserves every cleanup bound while giving
// each serialized cohort the largest safe reconnect slice of that same deadline.
const AIO_TERMINAL_EXACT_RELEASE_PROOF_RESERVE_MS =
  AIO_SHELL_SESSION_CLEANUP_MAX_BUDGET_MS +
  AIO_TERMINAL_EXACT_RELEASE_DRAIN_MARGIN_MS +
  AIO_TERMINAL_EXACT_RELEASE_FINAL_PROOF_COMMAND_RESERVE_MS;
const AIO_TERMINAL_RECONNECT_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const AIO_TERMINAL_RECONNECT_HANDSHAKE_BUFFER_CHARS = 16_384;
const AIO_TERMINAL_RELEASE_FRAME_MAX_BYTES = 1_024;
const AIO_TERMINAL_RELEASE_SCRIPT_MAX_BYTES = 16_384;
const AIO_TERMINAL_RELEASE_STAGE_CHUNK_CHARS = 512;
const AIO_TERMINAL_RECONNECT_RETRY_DELAYS_MS = [50, 100] as const;
const AES_GCM_IV_BYTES = 12;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_REGISTRATION_NONCE_PATTERN = /^[A-Za-z0-9]{8,64}$/u;
const SAFE_PROTOCOL_MARKER_PATTERN = /^CAP_AIO_[A-Z_]+_[A-Za-z0-9]{8,64}$/u;
const SAFE_CLOSE_TOKEN_PATTERN =
  /^: CAP_AIO_INJECTOR_CLOSE_[A-Za-z0-9]{8,64}$/u;
const SAFE_TTY_PATTERN = /^\/dev\/pts\/[0-9]+$/u;
const SAFE_TMUX_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const SAFE_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,18}$/u;
const AIO_RECONNECT_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JOURNAL_FILE_NAME_PATTERN = /^([0-9a-f]{64})\.owner$/u;
const JOURNAL_RECORD_PATTERN = new RegExp(
  `^${AIO_TERMINAL_OWNERSHIP_VERSION}:` +
    '([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64}):' +
    '([0-9a-f]{64}):([0-9a-f]{24}):' +
    '([A-Za-z0-9_-]{1,1024}):([0-9a-f]{32})$',
  'u',
);

const CURRENT_PROCESS_FINGERPRINT = sha256Hex(randomBytes(32));

/** Exact durable scope for one CAP-owned physical task sandbox. */
export interface AioTerminalOwnershipScope {
  readonly taskId: string;
  readonly providerSandboxId: string;
  readonly ownership: SandboxOwnershipFence;
}

/**
 * Opaque journal material embedded in the terminal's ready probe. The path is
 * only a SHA-256 session digest and the content is an authenticated ciphertext;
 * neither exposes the provider identity or durable ownership generations.
 */
export interface AioTerminalOwnershipRecord {
  readonly path: string;
  readonly content: string;
}

/** Immutable identity of one AIO-owned guest login shell/PTY. */
export interface AioTerminalGuestProcessFingerprint {
  readonly tty: string;
  readonly pid: string;
  readonly sid: string;
  readonly pgid: string;
  readonly startTime: string;
  readonly bootId: string;
}

/**
 * One main/injector pair is the minimum exact cleanup unit. The injector owns
 * the unguessable close token and can detach only the recorded main TTY; the
 * two process fingerprints then prove both persisted login shells exited.
 */
export interface AioTerminalOwnershipPair {
  readonly mainSessionId: string;
  readonly injectorSessionId: string;
  readonly main: AioTerminalGuestProcessFingerprint;
  readonly injector: AioTerminalGuestProcessFingerprint;
  readonly closeToken: string;
  readonly releaseMarker: string;
}

export type AioTerminalGuestPairReleaseSettlement =
  | { readonly kind: 'confirmed'; readonly cause: null }
  | {
      readonly kind: 'indeterminate';
      readonly cause:
        | 'identity-mismatch'
        | 'protocol-unconfirmed'
        | 'output-limit'
        | 'timeout';
    };

export interface AioTerminalReconnectSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (raw: WebSocket.RawData) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: () => void): void;
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
  terminate?(): void;
}

export type AioTerminalReconnectSocketFactory = (
  url: string,
  role: 'main' | 'injector',
) => AioTerminalReconnectSocket;

export interface AioTerminalGuestPairReleaseArgs {
  readonly fetch: AioShellFetch;
  readonly baseUrl: string;
  readonly taskId: string;
  readonly pair: AioTerminalOwnershipPair;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly socketFactory?: AioTerminalReconnectSocketFactory;
  readonly markerFactory?: () => string;
}

export type AioTerminalGuestPairReleaser = (
  args: AioTerminalGuestPairReleaseArgs,
) => Promise<AioTerminalGuestPairReleaseSettlement>;

interface DecodedAioTerminalOwnershipRecord {
  readonly path: string;
  readonly pair: AioTerminalOwnershipPair;
  readonly scopeFingerprint: string;
  readonly ownerFingerprint: string;
  readonly processFingerprint: string;
}

interface ParsedJournalRecord {
  readonly scopeFingerprint: string;
  readonly ownerFingerprint: string;
  readonly processFingerprint: string;
  readonly pairFingerprint: string;
  readonly ivHex: string;
  readonly ciphertext: string;
  readonly authTagHex: string;
}

interface AioTerminalSweepCounts {
  readonly inspectedRecords: number;
  readonly unrelatedRecords: number;
  readonly peerRecords: number;
  readonly staleRecords: number;
  readonly confirmedIdentities: number;
  readonly deletedIdentities: number;
  readonly alreadyAbsentIdentities: number;
  readonly removedRecords: number;
}

export type AioStaleTerminalSessionSweepSettlement =
  | (AioTerminalSweepCounts & {
      readonly kind: 'confirmed';
      readonly cause: null;
    })
  | (AioTerminalSweepCounts & {
      readonly kind: 'indeterminate';
      readonly cause:
        | 'ownership-unavailable'
        | 'journal-unconfirmed'
        | 'journal-invalid'
        | 'cleanup-unconfirmed'
        | 'journal-cleanup-unconfirmed';
    });

export interface AioTerminalOwnershipTiming {
  readonly requestTimeoutMs?: number;
  readonly cleanupAttemptTimeoutMs?: number;
  readonly cleanupRetryDelayMs?: number;
  readonly exactReleaseTimeoutMs?: number;
  readonly reconnectOutputMaxBytes?: number;
}

export function currentAioTerminalProcessFingerprint(): string {
  return CURRENT_PROCESS_FINGERPRINT;
}

export function isCompleteAioTerminalOwnershipScope(
  value: AioTerminalOwnershipScope | undefined,
  expectedTaskId?: string,
): value is AioTerminalOwnershipScope {
  return Boolean(
    value &&
      value.ownership &&
      typeof value.ownership === 'object' &&
      isBoundedNonControlString(value.taskId) &&
      (expectedTaskId === undefined || value.taskId === expectedTaskId) &&
      isBoundedNonControlString(value.providerSandboxId) &&
      isBoundedNonControlString(value.ownership.ownerGeneration) &&
      isBoundedNonControlString(value.ownership.resourceGeneration),
  );
}

/**
 * Build one encrypted ownership record for the complete main/injector pair.
 * Pairing is intentional: a stale sweep must never delete one provider handle
 * while losing the close capability needed to release the other persisted PTY.
 * A deterministic IV is accepted only as a test seam.
 */
export function createAioTerminalOwnershipRecord(args: {
  readonly pair: AioTerminalOwnershipPair;
  readonly scope: AioTerminalOwnershipScope;
  readonly processFingerprint?: string;
  readonly iv?: Uint8Array;
}): AioTerminalOwnershipRecord {
  const pair = normalizeOwnershipPair(args.pair);
  assertOwnershipScope(args.scope);
  const processFingerprint = normalizeProcessFingerprint(
    args.processFingerprint ?? currentAioTerminalProcessFingerprint(),
  );
  const pairPayload = serializeOwnershipPair(pair);
  const pairFingerprint = sha256Hex(pairPayload);
  const scopeFingerprint = ownershipScopeFingerprint(args.scope);
  const ownerFingerprint = sha256Hex(args.scope.ownership.ownerGeneration);
  const iv = normalizeIv(args.iv);
  const aad = ownershipRecordAad({
    pairFingerprint,
    scopeFingerprint,
    ownerFingerprint,
    processFingerprint,
  });
  const cipher = createCipheriv(
    'aes-256-gcm',
    ownershipEncryptionKey(args.scope),
    iv,
  );
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(pairPayload, 'utf8'),
    cipher.final(),
  ]);
  const content = [
    AIO_TERMINAL_OWNERSHIP_VERSION,
    scopeFingerprint,
    ownerFingerprint,
    processFingerprint,
    pairFingerprint,
    iv.toString('hex'),
    encrypted.toString('base64url'),
    cipher.getAuthTag().toString('hex'),
  ].join(':');
  return Object.freeze({
    path: ownershipRecordPath(pairFingerprint),
    content,
  });
}

/**
 * Put registration in the same shell command that publishes readiness. The
 * task session cannot attach to tmux until the encrypted journal write has
 * completed and the ready marker is observed by the control plane.
 */
export function buildAioTerminalOwnershipRegistrationShell(args: {
  readonly record: AioTerminalOwnershipRecord;
  readonly nonce: string;
}): string {
  assertOwnershipRecordPath(args.record.path);
  if (
    !SAFE_REGISTRATION_NONCE_PATTERN.test(args.nonce) ||
    !JOURNAL_RECORD_PATTERN.test(args.record.content)
  ) {
    throw new Error('AIO terminal ownership registration was invalid');
  }
  return [
    '(umask 077',
    `mkdir -p '${AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR}'`,
    `[ ! -L '${AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR}' ]`,
    `chmod 700 '${AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR}'`,
    'set -C',
    `printf '%s' '${args.record.content}' > '${args.record.path}'`,
    `chmod 600 '${args.record.path}')`,
  ].join(' && ');
}

/**
 * Probe the immutable guest PTY identity before any tmux attach. The marker is
 * nonce-bound and deliberately absent from the submitted command's output: the
 * shell prints it only after every `/proc` field has been collected.
 */
export function buildAioTerminalGuestIdentityProbe(marker: string): string {
  assertProtocolMarker(marker);
  const markerBoundary = marker.lastIndexOf('_');
  const markerPrefix = marker.slice(0, markerBoundary + 1);
  const markerNonce = marker.slice(markerBoundary + 1);
  return [
    'stty -echo',
    'cap_pid=$$',
    `cap_sid=$(ps -o sid= -p "$cap_pid" | tr -d ' ')`,
    `cap_pgid=$(ps -o pgid= -p "$cap_pid" | tr -d ' ')`,
    'cap_tty=$(tty)',
    'cap_stat=$(cat "/proc/$cap_sid/stat")',
    'cap_tail=${cap_stat##*) }',
    'set -- $cap_tail',
    'cap_start=${20}',
    'cap_boot=$(cat /proc/sys/kernel/random/boot_id)',
    `printf '\\r\\n${markerPrefix}%s tty=%s pid=%s sid=%s pgid=%s start=%s boot=%s\\r\\n' '${markerNonce}' "$cap_tty" "$cap_pid" "$cap_sid" "$cap_pgid" "$cap_start" "$cap_boot"`,
  ].join(' && ');
}

export function parseAioTerminalGuestIdentity(
  buffer: string,
  marker: string,
): AioTerminalGuestProcessFingerprint | null {
  assertProtocolMarker(marker);
  if (typeof buffer !== 'string') return null;
  const match = new RegExp(
    `${escapeRegExp(marker)} tty=(/dev/pts/[0-9]+) ` +
      'pid=([1-9][0-9]{0,18}) sid=([1-9][0-9]{0,18}) ' +
      'pgid=([1-9][0-9]{0,18}) start=([1-9][0-9]{0,18}) ' +
      'boot=([0-9a-f-]{36})\\r*\\n',
    'u',
  ).exec(buffer);
  if (!match) return null;
  try {
    return normalizeGuestProcessFingerprint({
      tty: match[1]!,
      pid: match[2]!,
      sid: match[3]!,
      pgid: match[4]!,
      startTime: match[5]!,
      bootId: match[6]!,
    });
  } catch {
    return null;
  }
}

/**
 * Release an exact persisted AIO main/injector pair without guessing a PID or
 * treating REST metadata absence as PTY absence. Both provider identities are
 * capability-reconnected, then a command guarded by both full guest
 * fingerprints detaches only the recorded main TTY. Both login shells exit
 * through their own PTYs, and `/proc` proves both original fingerprints are
 * absent before success.
 */
export async function releaseAioTerminalGuestPairExact(
  args: AioTerminalGuestPairReleaseArgs,
): Promise<AioTerminalGuestPairReleaseSettlement> {
  let laneKey: string;
  try {
    laneKey = exactReleaseLaneKey(args);
  } catch {
    return exactReleaseIndeterminate('identity-mismatch');
  }
  return enqueueExactReleaseCohort(laneKey, args);
}

interface QueuedExactRelease {
  readonly args: AioTerminalGuestPairReleaseArgs;
  readonly normalizedTimeoutMs: number;
  readonly enqueuedAt: number;
  readonly deadline: number;
  readonly resolve: (settlement: AioTerminalGuestPairReleaseSettlement) => void;
}

interface ExactReleaseLane {
  readonly key: string;
  readonly fetchKey: AioShellFetch;
  readonly lanes: Map<string, ExactReleaseLane>;
  readonly pending: QueuedExactRelease[];
  scheduled: boolean;
  tail: Promise<void>;
}

const EXACT_RELEASE_LANES_BY_FETCH = new WeakMap<
  AioShellFetch,
  Map<string, ExactReleaseLane>
>();

function exactReleaseLaneKey(args: AioTerminalGuestPairReleaseArgs): string {
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const taskSessionName = exactTaskSessionName(args.taskId);
  // A URL may legally contain userinfo. The task-local scheduler only needs
  // equality, so retain a one-way digest rather than endpoint/task material.
  return sha256Hex(`${baseUrl}\u0000${taskSessionName}`);
}

function enqueueExactReleaseCohort(
  key: string,
  args: AioTerminalGuestPairReleaseArgs,
): Promise<AioTerminalGuestPairReleaseSettlement> {
  let lanes = EXACT_RELEASE_LANES_BY_FETCH.get(args.fetch);
  if (!lanes) {
    lanes = new Map();
    EXACT_RELEASE_LANES_BY_FETCH.set(args.fetch, lanes);
  }
  let lane = lanes.get(key);
  if (!lane) {
    lane = {
      key,
      fetchKey: args.fetch,
      lanes,
      pending: [],
      scheduled: false,
      tail: Promise.resolve(),
    };
    lanes.set(key, lane);
  }
  const selectedLane = lane;
  const normalizedTimeoutMs = normalizeExactReleaseTimeout(args.timeoutMs);
  const enqueuedAt = Date.now();
  const decision = new Promise<AioTerminalGuestPairReleaseSettlement>(
    (resolve) => {
      selectedLane.pending.push({
        args,
        normalizedTimeoutMs,
        enqueuedAt,
        deadline: enqueuedAt + normalizedTimeoutMs,
        resolve,
      });
    },
  );
  scheduleExactReleaseCohort(selectedLane);
  return decision;
}

function scheduleExactReleaseCohort(lane: ExactReleaseLane): void {
  if (lane.scheduled) return;
  lane.scheduled = true;
  queueMicrotask(() => {
    lane.scheduled = false;
    const pending = lane.pending.splice(0);
    if (pending.length === 0) return;
    const groups = new Map<number, QueuedExactRelease[]>();
    for (const queued of pending) {
      const group = groups.get(queued.normalizedTimeoutMs) ?? [];
      group.push(queued);
      groups.set(queued.normalizedTimeoutMs, group);
    }
    let settledTail = lane.tail;
    for (const cohort of groups.values()) {
      const run = settledTail.then(async () => {
        const runnable = cohort.filter((queued) => {
          if (queued.deadline > Date.now()) return true;
          queued.resolve(exactReleaseIndeterminate('timeout'));
          return false;
        });
        if (runnable.length === 0) return;
        let settlements: readonly AioTerminalGuestPairReleaseSettlement[];
        try {
          settlements = await releaseAioTerminalGuestPairCohortExact(
            runnable.map(({ args }) => args),
            Math.min(...runnable.map(({ deadline }) => deadline)),
          );
        } catch {
          settlements = runnable.map(() =>
            exactReleaseIndeterminate('protocol-unconfirmed'),
          );
        }
        for (let index = 0; index < runnable.length; index += 1) {
          runnable[index]!.resolve(
            settlements[index] ??
              exactReleaseIndeterminate('protocol-unconfirmed'),
          );
        }
      });
      settledTail = run.catch(() => undefined);
    }
    lane.tail = settledTail;
    void settledTail.then(() => {
      if (
        lane.tail === settledTail &&
        lane.pending.length === 0 &&
        !lane.scheduled
      ) {
        lane.lanes.delete(lane.key);
        if (lane.lanes.size === 0) {
          EXACT_RELEASE_LANES_BY_FETCH.delete(lane.fetchKey);
        }
      }
    });
  });
}

/**
 * Cohort implementation is kept as a separate boundary so transport callers
 * retain the single-pair API while same-task closes can share guest proof I/O.
 */
async function releaseAioTerminalGuestPairCohortExact(
  requests: readonly AioTerminalGuestPairReleaseArgs[],
  deadline: number,
): Promise<readonly AioTerminalGuestPairReleaseSettlement[]> {
  if (requests.length === 0) return [];
  const reconnectDeadline = exactReleaseReconnectPhaseDeadline(
    deadline,
    normalizeExactReleaseTimeout(requests[0]?.timeoutMs),
  );
  const prepared: PreparedExactRelease[] = [];
  const invalid = new Map<number, AioTerminalGuestPairReleaseSettlement>();
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    try {
      const pair = normalizeOwnershipPair(request.pair);
      assertReconnectProviderSessionId(pair.mainSessionId);
      assertReconnectProviderSessionId(pair.injectorSessionId);
      if (pair.mainSessionId.slice(0, 8) === pair.injectorSessionId.slice(0, 8)) {
        throw new Error('ambiguous provider identity');
      }
      prepared.push({
        index,
        request,
        pair,
        taskSessionName: exactTaskSessionName(request.taskId),
        maxOutputBytes: normalizeReconnectOutputLimit(request.maxOutputBytes),
        openSockets: new Set(),
        injectorOutcome: null,
        mainReleaseConfirmed: false,
        failureCause: null,
      });
    } catch {
      invalid.set(index, exactReleaseIndeterminate('identity-mismatch'));
    }
  }
  const settlements = requests.map((_, index) =>
    invalid.get(index) ?? exactReleaseIndeterminate('protocol-unconfirmed'),
  );
  if (prepared.length === 0) return settlements;

  try {
    await Promise.all(
      prepared.map(async (entry) => {
        try {
          const injectorExitMarker = releaseProtocolMarker(
            'INJECTOR_EXIT',
            entry.request.markerFactory ??
              (() => randomBytes(12).toString('hex')),
          );
          entry.injectorOutcome = await reconnectInjectorAndExit({
            baseUrl: entry.request.baseUrl,
            pair: entry.pair,
            taskSessionName: entry.taskSessionName,
            deadline: reconnectDeadline,
            maxOutputBytes: entry.maxOutputBytes,
            socketFactory:
              entry.request.socketFactory ??
              defaultAioTerminalReconnectSocketFactory,
            openSockets: entry.openSockets,
            exitMarker: injectorExitMarker,
            // The guest script itself distinguishes exact absence, an already
            // foreground shell, and the exact attached tmux client. Skipping a
            // preliminary REST classify removes the N-way control-shell burst
            // without relaxing any fingerprint or pinned-TTY predicate.
            detachMain: true,
          });
          if (entry.injectorOutcome === 'main-absent') {
            entry.mainReleaseConfirmed = true;
          }
        } catch (error) {
          entry.failureCause = exactReleaseCause(error);
          return;
        }
        if (entry.injectorOutcome !== 'main-ready') return;
        try {
          const mainExitMarker = releaseProtocolMarker(
            'MAIN_EXIT',
            entry.request.markerFactory ??
              (() => randomBytes(12).toString('hex')),
          );
          await reconnectMainAndExit({
            baseUrl: entry.request.baseUrl,
            pair: entry.pair,
            taskSessionName: entry.taskSessionName,
            deadline: reconnectDeadline,
            maxOutputBytes: entry.maxOutputBytes,
            socketFactory:
              entry.request.socketFactory ??
              defaultAioTerminalReconnectSocketFactory,
            openSockets: entry.openSockets,
            exitMarker: mainExitMarker,
          });
          entry.mainReleaseConfirmed = true;
        } catch (error) {
          entry.failureCause ??= exactReleaseCause(error);
        }
      }),
    );

    const proof = new Map(
      await proveExactReleaseCohort({ entries: prepared, deadline }),
    );

    for (const entry of prepared) {
      const state = proof.get(entry.index);
      settlements[entry.index] =
        state === 'confirmed'
          ? Object.freeze({ kind: 'confirmed' as const, cause: null })
          : exactReleaseIndeterminate(
              state === 'identity-mismatch'
                ? 'identity-mismatch'
                : entry.failureCause ?? 'protocol-unconfirmed',
            );
    }
  } catch (error) {
    const cause = exactReleaseCause(error);
    for (const entry of prepared) {
      settlements[entry.index] = exactReleaseIndeterminate(
        entry.failureCause ?? cause,
      );
    }
  } finally {
    for (const entry of prepared) {
      for (const socket of entry.openSockets) closeReconnectSocket(socket);
    }
  }
  return settlements;
}

interface PreparedExactRelease {
  readonly index: number;
  readonly request: AioTerminalGuestPairReleaseArgs;
  readonly pair: AioTerminalOwnershipPair;
  readonly taskSessionName: string;
  readonly maxOutputBytes: number;
  readonly openSockets: Set<AioTerminalReconnectSocket>;
  injectorOutcome: InjectorMainReleaseOutcome | null;
  mainReleaseConfirmed: boolean;
  failureCause: ExactReleaseCause | null;
}

type ExactCohortProofState =
  | 'confirmed'
  | 'main-recoverable'
  | 'identity-mismatch'
  | 'unconfirmed';

async function proveExactReleaseCohort(args: {
  readonly entries: readonly PreparedExactRelease[];
  readonly deadline: number;
}): Promise<ReadonlyMap<number, ExactCohortProofState>> {
  if (args.entries.length === 0) return new Map();
  const recoveryCandidates = new Set(
    args.entries
      .filter(
        (entry) =>
          !entry.mainReleaseConfirmed &&
          entry.failureCause !== null &&
          entry.failureCause !== 'timeout' &&
          entry.failureCause !== 'output-limit',
      )
      .map(({ index }) => index),
  );
  const remaining = remainingReleaseMs(args.deadline);
  // The command transaction shares one temporary provider shell across the
  // recovery snapshot and final proof. Its signal excludes the exact DELETE
  // envelope; the session helper always awaits that fresh cleanup before this
  // lane can settle or the next timeout group can start.
  const commandBudget =
    remaining >
    AIO_SHELL_SESSION_CLEANUP_MAX_BUDGET_MS +
      AIO_TERMINAL_EXACT_RELEASE_DRAIN_MARGIN_MS
      ? remaining -
        AIO_SHELL_SESSION_CLEANUP_MAX_BUDGET_MS -
        AIO_TERMINAL_EXACT_RELEASE_DRAIN_MARGIN_MS
      : remaining;
  const commandSignal = AbortSignal.timeout(commandBudget);
  const first = args.entries[0]!;
  let proof: ReadonlyMap<number, ExactCohortProofState>;
  try {
    proof = await executeAioShellCommandSession(
      first.request.fetch,
      normalizeBaseUrl(first.request.baseUrl),
      commandSignal,
      async (execute) => {
        if (recoveryCandidates.size === 0) {
          return executeExactReleaseCohortProofPass({
            entries: args.entries,
            allowMainRecovery: new Set(),
            maxAttempts: 50,
            execute,
            signal: commandSignal,
          });
        }

        const observed = new Map(
          await executeExactReleaseCohortProofPass({
            entries: args.entries,
            allowMainRecovery: recoveryCandidates,
            maxAttempts: 1,
            execute,
            signal: commandSignal,
          }),
        );
        const recoverable = args.entries.filter(
          (entry) => observed.get(entry.index) === 'main-recoverable',
        );
        if (recoverable.length > 0) {
          const recoveryDeadline = exactReleaseRecoveryPhaseDeadline(
            args.deadline,
          );
          await Promise.all(
            recoverable.map(async (entry) => {
              try {
                const mainExitMarker = releaseProtocolMarker(
                  'MAIN_EXIT',
                  entry.request.markerFactory ??
                    (() => randomBytes(12).toString('hex')),
                );
                await reconnectMainAndExit({
                  baseUrl: entry.request.baseUrl,
                  pair: entry.pair,
                  taskSessionName: entry.taskSessionName,
                  deadline: recoveryDeadline,
                  maxOutputBytes: entry.maxOutputBytes,
                  socketFactory:
                    entry.request.socketFactory ??
                    defaultAioTerminalReconnectSocketFactory,
                  openSockets: entry.openSockets,
                  exitMarker: mainExitMarker,
                });
                entry.mainReleaseConfirmed = true;
              } catch (error) {
                entry.failureCause ??= exactReleaseCause(error);
              }
            }),
          );
        }

        const finalEntries = args.entries.filter((entry) => {
          const state = observed.get(entry.index);
          return state === 'main-recoverable' || state === 'unconfirmed';
        });
        if (finalEntries.length === 0) return observed;
        try {
          const finalProof = await executeExactReleaseCohortProofPass({
            entries: finalEntries,
            allowMainRecovery: new Set(),
            maxAttempts: 50,
            execute,
            signal: commandSignal,
          });
          for (const entry of finalEntries) {
            observed.set(
              entry.index,
              finalProof.get(entry.index) ?? 'unconfirmed',
            );
          }
        } catch (error) {
          const cause =
            commandSignal.aborted || Date.now() >= args.deadline
              ? 'timeout'
              : exactReleaseCause(error);
          for (const entry of finalEntries) {
            entry.failureCause ??= cause;
            observed.set(entry.index, 'unconfirmed');
          }
        }
        return observed;
      },
    );
  } catch (error) {
    throw new ExactReleaseError(
      commandSignal.aborted || Date.now() >= args.deadline
        ? 'timeout'
        : exactReleaseCause(error),
    );
  }
  if (Date.now() >= args.deadline) {
    throw new ExactReleaseError('timeout');
  }
  return proof;
}

async function executeExactReleaseCohortProofPass(args: {
  readonly entries: readonly PreparedExactRelease[];
  readonly allowMainRecovery: ReadonlySet<number>;
  readonly maxAttempts: number;
  readonly execute: AioShellSessionCommandExecutor;
  readonly signal: AbortSignal;
}): Promise<ReadonlyMap<number, ExactCohortProofState>> {
  const markers = args.entries.map((entry) => ({
    entry,
    nonce: randomBytes(12).toString('hex'),
  }));
  const command = ownershipSubshellCommand(
    buildExactReleaseCohortProofShell({
      markers,
      allowMainRecovery: args.allowMainRecovery,
      maxAttempts: args.maxAttempts,
    }),
  );
  let result: AioShellExecResponse;
  try {
    result = await args.execute(
      command,
      args.signal,
    );
  } catch {
    throw new ExactReleaseError(
      args.signal.aborted ? 'timeout' : 'protocol-unconfirmed',
    );
  }
  if (
    !result.ok ||
    !isRecord(result.body) ||
    result.body.success !== true ||
    !isRecord(result.body.data) ||
    result.body.data.command !== command
  ) {
    throw new ExactReleaseError('protocol-unconfirmed');
  }
  if (
    result.body.data.status !== 'completed' ||
    result.body.data.exit_code !== 0
  ) {
    throw new ExactReleaseError('identity-mismatch');
  }
  const outputLines = terminalCommandOutput(result.body.data)
    .replace(/\r\n|\r/gu, '\n')
    .split('\n')
    .filter((line) => line.length > 0);
  const allowed = new Set<string>();
  for (const { nonce } of markers) {
    for (const state of [
      'CONFIRMED',
      'MAIN_RECOVERABLE',
      'IDENTITY_MISMATCH',
      'UNCONFIRMED',
    ] as const) {
      allowed.add(exactCohortProofMarker(state, nonce));
    }
  }
  // AIO's REST login shell can include the submitted `sh -lc ...` command in
  // `output`, especially for a long cohort proof. None of that echo is proof:
  // accept only standalone nonce-bound protocol lines, while still rejecting
  // every unknown line in our reserved marker namespace. The submitted shell
  // keeps each marker prefix and nonce in separate quoted arguments, so its
  // own echo cannot contain one of the exact allowed lines.
  if (
    outputLines.some(
      (line) => line.startsWith('CAP_AIO_PAIR_') && !allowed.has(line),
    )
  ) {
    throw new ExactReleaseError('protocol-unconfirmed');
  }
  const proof = new Map<number, ExactCohortProofState>();
  for (const { entry, nonce } of markers) {
    const candidates = [
      ['CONFIRMED', 'confirmed'],
      ['MAIN_RECOVERABLE', 'main-recoverable'],
      ['IDENTITY_MISMATCH', 'identity-mismatch'],
      ['UNCONFIRMED', 'unconfirmed'],
    ] as const;
    const counts = candidates.map(([label, state]) => ({
      state,
      count: outputLines.filter(
        (line) => line === exactCohortProofMarker(label, nonce),
      ).length,
    }));
    if (counts.reduce((total, { count }) => total + count, 0) !== 1) {
      throw new ExactReleaseError('protocol-unconfirmed');
    }
    const observed = counts.find(({ count }) => count === 1);
    proof.set(
      entry.index,
      observed?.state ?? 'unconfirmed',
    );
  }
  return proof;
}

function exactCohortProofMarker(
  state:
    | 'CONFIRMED'
    | 'MAIN_RECOVERABLE'
    | 'IDENTITY_MISMATCH'
    | 'UNCONFIRMED',
  nonce: string,
): string {
  if (!SAFE_REGISTRATION_NONCE_PATTERN.test(nonce)) {
    throw new ExactReleaseError('identity-mismatch');
  }
  const marker = `CAP_AIO_PAIR_${state}_${nonce}`;
  assertProtocolMarker(marker);
  return marker;
}

function buildExactReleaseCohortProofShell(args: {
  readonly markers: readonly {
    readonly entry: PreparedExactRelease;
    readonly nonce: string;
  }[];
  readonly allowMainRecovery: ReadonlySet<number>;
  readonly maxAttempts: number;
}): string {
  const taskSessionName = args.markers[0]?.entry.taskSessionName;
  if (!taskSessionName || !SAFE_TMUX_NAME_PATTERN.test(taskSessionName)) {
    throw new ExactReleaseError('identity-mismatch');
  }
  if (
    !Number.isSafeInteger(args.maxAttempts) ||
    args.maxAttempts < 1 ||
    args.maxAttempts > 50
  ) {
    throw new ExactReleaseError('identity-mismatch');
  }
  for (const { entry, nonce } of args.markers) {
    normalizeOwnershipPair(entry.pair);
    if (entry.taskSessionName !== taskSessionName) {
      throw new ExactReleaseError('identity-mismatch');
    }
    if (!SAFE_REGISTRATION_NONCE_PATTERN.test(nonce)) {
      throw new ExactReleaseError('identity-mismatch');
    }
  }

  const functionBody = [
    'cap_proc_state() {',
    'cap_expected_pid="$1"; cap_expected_sid="$2"; cap_expected_pgid="$3";',
    'cap_expected_start="$4"; cap_expected_boot="$5"; cap_expected_tty="$6";',
    "cap_proc_state_value='identity-mismatch'; cap_proc_foreground='0';",
    'cap_actual_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || return 0;',
    '[ "$cap_actual_boot" = "$cap_expected_boot" ] || return 0;',
    'if [ ! -e "/proc/$cap_expected_pid" ]; then',
    'cap_kill_error=$(LC_ALL=C kill -0 "$cap_expected_pid" 2>&1); cap_kill_status=$?;',
    `if [ "$cap_kill_status" -ne 0 ] && printf '%s\n' "$cap_kill_error" | grep -Fq 'No such process'; then cap_proc_state_value='absent'; fi;`,
    'return 0; fi;',
    'if ! cap_stat=$(cat "/proc/$cap_expected_pid/stat" 2>/dev/null); then cap_proc_state_value="pending"; return 0; fi;',
    'cap_tail=${cap_stat##*) }; set -- $cap_tail;',
    '[ "${3}" = "$cap_expected_pgid" ] || return 0;',
    '[ "${4}" = "$cap_expected_sid" ] || return 0;',
    '[ "${20}" = "$cap_expected_start" ] || return 0;',
    'if ! cap_actual_tty=$(readlink "/proc/$cap_expected_pid/fd/0" 2>/dev/null); then cap_proc_state_value="pending"; return 0; fi;',
    '[ "$cap_actual_tty" = "$cap_expected_tty" ] || return 0;',
    'if ! exec 8<"/proc/$cap_expected_pid/task/$cap_expected_pid/children" 2>/dev/null; then cap_proc_state_value="pending"; return 0; fi;',
    "cap_children=''; { IFS= read -r cap_children <&8 || :; }; exec 8<&- 2>/dev/null || :;",
    "cap_proc_state_value='present';",
    'if [ "${6}" = "$cap_expected_pgid" ] && [ -z "$cap_children" ]; then cap_proc_foreground="1"; fi;',
    '}',
    'cap_tty_state() {',
    'cap_expected_tty="$1"; cap_tty_state_value="identity-mismatch";',
    'command -v tmux >/dev/null 2>&1 || return 0;',
    `cap_sessions=$(tmux list-sessions -F '#{session_name}' 2>&1); cap_tmux_status=$?;`,
    'if [ "$cap_tmux_status" -eq 0 ]; then',
    `if printf '%s\n' "$cap_sessions" | grep -Fqx -- '${taskSessionName}'; then`,
    `cap_clients=$(tmux list-clients -t '=${taskSessionName}' -F '#{client_tty}' 2>/dev/null) || return 0;`,
    `if printf '%s\n' "$cap_clients" | grep -Fqx -- "$cap_expected_tty"; then cap_tty_state_value='attached'; else cap_tty_state_value='detached'; fi;`,
    `else cap_tty_state_value='detached'; fi; return 0;`,
    'fi;',
    `if [ "$cap_tmux_status" -eq 1 ]; then case "$cap_sessions" in 'no server running on '*) cap_tty_state_value='detached';; esac; fi;`,
    '}',
    'cap_emit_pair_state() {',
    'cap_emit_state="$1"; cap_emit_nonce="$2";',
    `case "$cap_emit_state" in confirmed) printf '\\r\\nCAP_AIO_PAIR_CONFIRMED_%s\\r\\n' "$cap_emit_nonce" ;;`,
    `main-recoverable) printf '\\r\\nCAP_AIO_PAIR_MAIN_RECOVERABLE_%s\\r\\n' "$cap_emit_nonce" ;;`,
    `identity-mismatch) printf '\\r\\nCAP_AIO_PAIR_IDENTITY_MISMATCH_%s\\r\\n' "$cap_emit_nonce" ;;`,
    `*) printf '\\r\\nCAP_AIO_PAIR_UNCONFIRMED_%s\\r\\n' "$cap_emit_nonce" ;; esac;`,
    '}',
    'cap_verify_pair() {',
    'cap_nonce="$1"; cap_allow_recovery="$2"; cap_i=0;',
    `while [ "$cap_i" -lt ${args.maxAttempts} ]; do`,
    'cap_proc_state "$3" "$4" "$5" "$6" "$7" "$8"; cap_injector_state="$cap_proc_state_value";',
    'cap_proc_state "$9" "${10}" "${11}" "${12}" "${13}" "${14}"; cap_main_state="$cap_proc_state_value"; cap_main_foreground="$cap_proc_foreground";',
    'cap_tty_state "${14}"; cap_main_tty_state="$cap_tty_state_value";',
    'if [ "$cap_injector_state" = "identity-mismatch" ] || [ "$cap_main_state" = "identity-mismatch" ] || [ "$cap_main_tty_state" = "identity-mismatch" ]; then cap_emit_pair_state identity-mismatch "$cap_nonce"; return 0; fi;',
    'if [ "$cap_injector_state" = "absent" ] && [ "$cap_main_state" = "absent" ] && [ "$cap_main_tty_state" = "detached" ]; then cap_emit_pair_state confirmed "$cap_nonce"; return 0; fi;',
    'if [ "$cap_allow_recovery" = "1" ] && [ "$cap_injector_state" = "absent" ] && [ "$cap_main_state" = "present" ] && [ "$cap_main_foreground" = "1" ] && [ "$cap_main_tty_state" = "detached" ]; then cap_emit_pair_state main-recoverable "$cap_nonce"; return 0; fi;',
    `cap_i=$((cap_i + 1)); [ "$cap_i" -ge ${args.maxAttempts} ] || sleep 0.05;`,
    'done;',
    'cap_emit_pair_state unconfirmed "$cap_nonce";',
    '}',
  ];
  const invocations = args.markers.map(({ entry, nonce }) => {
    const allowRecovery = args.allowMainRecovery.has(entry.index) ? '1' : '0';
    const injector = entry.pair.injector;
    const main = entry.pair.main;
    return (
      `cap_verify_pair '${nonce}' '${allowRecovery}' ` +
      `'${injector.pid}' '${injector.sid}' '${injector.pgid}' ` +
      `'${injector.startTime}' '${injector.bootId}' '${injector.tty}' ` +
      `'${main.pid}' '${main.sid}' '${main.pgid}' ` +
      `'${main.startTime}' '${main.bootId}' '${main.tty}' &`
    );
  });
  return [...functionBody, ...invocations, 'wait'].join('\n');
}

interface ReconnectReleaseContext {
  readonly baseUrl: string;
  readonly pair: AioTerminalOwnershipPair;
  readonly taskSessionName: string;
  readonly deadline: number;
  readonly maxOutputBytes: number;
  readonly socketFactory: AioTerminalReconnectSocketFactory;
  readonly openSockets: Set<AioTerminalReconnectSocket>;
  readonly exitMarker: string;
}

interface ReconnectReleaseInputFrame {
  readonly data: string;
  readonly acknowledgement: string | null;
}

interface ReconnectReleaseInputPlan {
  readonly frames: readonly ReconnectReleaseInputFrame[];
  readonly failureMarker: string | null;
  readonly outcomeMarkers: Readonly<{
    mainReady: string;
    mainAbsent: string;
  }> | null;
}

interface ExactProtocolMarkerTrieNode {
  readonly next: Map<string, number>;
  marker: string | null;
}

interface ExactProtocolMarkerObservationState {
  readonly nodes: readonly ExactProtocolMarkerTrieNode[];
  readonly counts: Map<string, number>;
  readonly firstObservationOrder: Map<string, number>;
  currentNode: number | null;
  lineEligible: boolean;
  pendingCarriageReturn: boolean;
  nextObservationOrder: number;
}

type InjectorMainReleaseOutcome = 'main-ready' | 'main-absent';

function reconnectInjectorAndExit(
  context: ReconnectReleaseContext & { readonly detachMain: boolean },
): Promise<InjectorMainReleaseOutcome> {
  const mainReadyMarker = injectorMainOutcomeMarker(
    context.exitMarker,
    'MAIN_READY',
  );
  const mainAbsentMarker = injectorMainOutcomeMarker(
    context.exitMarker,
    'MAIN_ABSENT',
  );
  const releaseCommand = buildExactInjectorReleaseAndExitCommand({
    injector: context.pair.injector,
    main: context.pair.main,
    detachMain: context.detachMain,
    taskSessionName: context.taskSessionName,
    marker: context.exitMarker,
    mainReadyMarker,
    mainAbsentMarker,
  });
  return reconnectAndRunReleaseProtocol({
    ...context,
    role: 'injector',
    providerSessionId: context.pair.injectorSessionId,
    // The no-op sentinel is safe both when the injector loop consumes it and
    // in the journal-written/loop-not-installed crash window. A shell-level
    // barrier then proves it was consumed before bounded staging begins.
    inputPlan: buildInjectorReleaseInputPlan({
      closeToken: context.pair.closeToken,
      releaseMarker: context.pair.releaseMarker,
      exitMarker: context.exitMarker,
      releaseCommand,
      mainReadyMarker,
      mainAbsentMarker,
    }),
  }).then((outcome) => {
    if (outcome === null) {
      throw new ExactReleaseError('protocol-unconfirmed');
    }
    return outcome;
  });
}

function reconnectMainAndExit(context: ReconnectReleaseContext): Promise<void> {
  return reconnectAndRunReleaseProtocol({
    ...context,
    role: 'main',
    providerSessionId: context.pair.mainSessionId,
    inputPlan: singleReleaseInputPlan(
      buildExactFingerprintExitCommand(context.pair.main, context.exitMarker),
    ),
  }).then(() => undefined);
}

async function reconnectAndRunReleaseProtocol(args: ReconnectReleaseContext & {
  readonly role: 'main' | 'injector';
  readonly providerSessionId: string;
  readonly inputPlan: ReconnectReleaseInputPlan;
}): Promise<InjectorMainReleaseOutcome | null> {
  for (
    let attempt = 0;
    attempt <= AIO_TERMINAL_RECONNECT_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return await reconnectAndRunReleaseProtocolOnce(args);
    } catch (error) {
      const retryDelay = AIO_TERMINAL_RECONNECT_RETRY_DELAYS_MS[attempt];
      if (
        !(error instanceof PreIdentityReconnectError) ||
        retryDelay === undefined
      ) {
        throw error;
      }
      await runExactReleaseBeforeDeadline(
        args.deadline,
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, retryDelay);
          }),
      );
    }
  }
  throw new ExactReleaseError('protocol-unconfirmed');
}

function reconnectAndRunReleaseProtocolOnce(args: ReconnectReleaseContext & {
  readonly role: 'main' | 'injector';
  readonly providerSessionId: string;
  readonly inputPlan: ReconnectReleaseInputPlan;
}): Promise<InjectorMainReleaseOutcome | null> {
  let timeoutMs: number;
  try {
    timeoutMs = remainingReleaseMs(args.deadline);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<InjectorMainReleaseOutcome | null>((resolve, reject) => {
      let socket: AioTerminalReconnectSocket;
      try {
        socket = args.socketFactory(
          aioTerminalReconnectUrl(args.baseUrl, args.providerSessionId),
          args.role,
        );
      } catch {
        reject(new PreIdentityReconnectError());
        return;
      }
      args.openSockets.add(socket);
      let settled = false;
      let identityConfirmed = false;
      let nextFrameIndex = 0;
      let pendingFrameIndex: number | null = null;
      let pendingWriteConfirmed = false;
      let pendingAcknowledgementConfirmed = false;
      let allFramesWriteConfirmed = false;
      let exitMarkerObserved = false;
      let releaseOutcome: InjectorMainReleaseOutcome | null = null;
      let inputStarted = false;
      let totalBytes = 0;
      let historicalOutputBuffer = '';
      const liveMarkerObservations =
        createExactProtocolMarkerObservationState(
          args.inputPlan,
          args.exitMarker,
        );
      const settle = (continuation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        args.openSockets.delete(socket);
        closeReconnectSocket(socket);
        continuation();
      };
      const fail = (
        cause: ExactReleaseCause,
        retryableBeforeIdentity = false,
      ): void =>
        settle(() =>
          reject(
            retryableBeforeIdentity
              ? new PreIdentityReconnectError()
              : new ExactReleaseError(cause),
          ),
        );
      const maybeAdvanceInput = (): void => {
        if (
          settled ||
          pendingFrameIndex === null ||
          !pendingWriteConfirmed ||
          !pendingAcknowledgementConfirmed
        ) {
          return;
        }
        nextFrameIndex = pendingFrameIndex + 1;
        pendingFrameIndex = null;
        if (nextFrameIndex >= args.inputPlan.frames.length) {
          allFramesWriteConfirmed = true;
          if (
            exitMarkerObserved &&
            (args.inputPlan.outcomeMarkers === null || releaseOutcome !== null)
          ) {
            settle(() => resolve(releaseOutcome));
          }
          return;
        }
        sendNextInputFrame();
      };
      const sendNextInputFrame = (): void => {
        if (settled || pendingFrameIndex !== null) return;
        const frame = args.inputPlan.frames[nextFrameIndex];
        if (!frame) {
          fail('protocol-unconfirmed');
          return;
        }
        pendingFrameIndex = nextFrameIndex;
        pendingWriteConfirmed = false;
        pendingAcknowledgementConfirmed = frame.acknowledgement === null;
        inputStarted = true;
        if (
          !sendReconnectInput(socket, frame.data, (error) => {
            if (settled || pendingFrameIndex !== nextFrameIndex) return;
            if (error) {
              fail('protocol-unconfirmed');
              return;
            }
            pendingWriteConfirmed = true;
            maybeAdvanceInput();
          })
        ) {
          fail('protocol-unconfirmed');
        }
      };
      const inspectLiveReleaseMarkers = (): void => {
        if (settled) return;
        let outcomeOrder: number | undefined;
        if (
          args.inputPlan.failureMarker !== null &&
          exactProtocolMarkerObservationCount(
            liveMarkerObservations,
            args.inputPlan.failureMarker,
          ) > 0
        ) {
          fail('protocol-unconfirmed');
          return;
        }
        for (
          let index = 0;
          index < args.inputPlan.frames.length;
          index += 1
        ) {
          const acknowledgement =
            args.inputPlan.frames[index]?.acknowledgement;
          if (acknowledgement === null || acknowledgement === undefined) {
            continue;
          }
          const count = exactProtocolMarkerObservationCount(
            liveMarkerObservations,
            acknowledgement,
          );
          const highestAllowedIndex =
            pendingFrameIndex ?? nextFrameIndex - 1;
          if (
            count > 1 ||
            (count === 1 && index > highestAllowedIndex)
          ) {
            fail('protocol-unconfirmed');
            return;
          }
          if (count === 1 && index === pendingFrameIndex) {
            pendingAcknowledgementConfirmed = true;
          }
        }
        if (args.inputPlan.outcomeMarkers !== null) {
          const readyCount = exactProtocolMarkerObservationCount(
            liveMarkerObservations,
            args.inputPlan.outcomeMarkers.mainReady,
          );
          const absentCount = exactProtocolMarkerObservationCount(
            liveMarkerObservations,
            args.inputPlan.outcomeMarkers.mainAbsent,
          );
          const finalFrameIndex = args.inputPlan.frames.length - 1;
          if (
            readyCount > 1 ||
            absentCount > 1 ||
            readyCount + absentCount > 1 ||
            ((readyCount === 1 || absentCount === 1) &&
              !allFramesWriteConfirmed &&
              pendingFrameIndex !== finalFrameIndex)
          ) {
            fail('protocol-unconfirmed');
            return;
          }
          if (readyCount === 1) releaseOutcome = 'main-ready';
          if (absentCount === 1) releaseOutcome = 'main-absent';
          if (readyCount === 1) {
            outcomeOrder = exactProtocolMarkerFirstObservationOrder(
              liveMarkerObservations,
              args.inputPlan.outcomeMarkers.mainReady,
            );
          }
          if (absentCount === 1) {
            outcomeOrder = exactProtocolMarkerFirstObservationOrder(
              liveMarkerObservations,
              args.inputPlan.outcomeMarkers.mainAbsent,
            );
          }
        }
        const exitCount = exactProtocolMarkerObservationCount(
          liveMarkerObservations,
          args.exitMarker,
        );
        const exitOrder =
          exitCount === 1
            ? exactProtocolMarkerFirstObservationOrder(
                liveMarkerObservations,
                args.exitMarker,
              )
            : undefined;
        const finalFrameIndex = args.inputPlan.frames.length - 1;
        if (
          exitCount > 1 ||
          (exitCount === 1 &&
            args.inputPlan.outcomeMarkers !== null &&
            (releaseOutcome === null ||
              outcomeOrder === undefined ||
              exitOrder === undefined ||
              outcomeOrder >= exitOrder)) ||
          (exitCount === 1 &&
            !allFramesWriteConfirmed &&
            pendingFrameIndex !== finalFrameIndex)
        ) {
          fail('protocol-unconfirmed');
          return;
        }
        if (exitCount === 1) {
          exitMarkerObserved = true;
          if (
            allFramesWriteConfirmed &&
            (args.inputPlan.outcomeMarkers === null || releaseOutcome !== null)
          ) {
            settle(() => resolve(releaseOutcome));
            return;
          }
        }
        maybeAdvanceInput();
      };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      timer.unref?.();
      socket.on('message', (raw) => {
        if (settled) return;
        totalBytes += rawDataByteLength(raw);
        if (totalBytes > args.maxOutputBytes) {
          fail('output-limit');
          return;
        }
        const frame = parseReconnectFrame(raw);
        if (!frame) return;
        if (frame.type === 'error') {
          fail(
            'protocol-unconfirmed',
            !identityConfirmed && !inputStarted,
          );
          return;
        }
        if (
          !identityConfirmed &&
          (frame.type === 'output' || frame.type === 'restore_output') &&
          typeof frame.data === 'string'
        ) {
          historicalOutputBuffer = appendBoundedText(
            historicalOutputBuffer,
            frame.data,
            AIO_TERMINAL_RECONNECT_HANDSHAKE_BUFFER_CHARS,
          );
          return;
        }
        // A pinned AIO 1.0.0.125 resume emits restore_output followed by the
        // exact terminal_restored acknowledgement. A new-session session_id
        // frame is not resume evidence and must never authorize PTY input.
        if (frame.type === 'session_id') {
          fail('identity-mismatch');
          return;
        }
        if (frame.type === 'terminal_restored') {
          if (identityConfirmed) {
            fail('identity-mismatch');
            return;
          }
          if (
            frame.data !==
            `Session ${args.providerSessionId.slice(0, 8)} restored`
          ) {
            fail('identity-mismatch');
            return;
          }
          identityConfirmed = true;
          if (
            args.inputPlan.failureMarker !== null &&
            hasExactProtocolMarkerLine(
              historicalOutputBuffer,
              args.inputPlan.failureMarker,
            )
          ) {
            fail('protocol-unconfirmed');
            return;
          }
          sendNextInputFrame();
          return;
        }
        if (
          !identityConfirmed ||
          frame.type !== 'output' ||
          typeof frame.data !== 'string'
        ) {
          return;
        }
        observeExactProtocolMarkerOutput(
          liveMarkerObservations,
          frame.data,
        );
        inspectLiveReleaseMarkers();
      });
      socket.on('close', () => {
        if (!settled) {
          fail(
            'protocol-unconfirmed',
            !identityConfirmed && !inputStarted,
          );
        }
      });
      socket.on('error', () => {
        if (!settled) {
          fail(
            'protocol-unconfirmed',
            !identityConfirmed && !inputStarted,
          );
        }
      });
    });
}

function buildExactFingerprintExitCommand(
  fingerprintValue: AioTerminalGuestProcessFingerprint,
  marker: string,
): string {
  const fingerprint = normalizeGuestProcessFingerprint(fingerprintValue);
  const predicate = buildExactGuestFingerprintPredicate(
    fingerprint,
    'cap_self',
    true,
    true,
  );
  return (
    `if ${predicate}; then ` +
    `${buildEchoSafeProtocolMarkerPrint(marker)}; exit; fi\n`
  );
}

function buildExactInjectorReleaseAndExitCommand(args: {
  readonly injector: AioTerminalGuestProcessFingerprint;
  readonly main: AioTerminalGuestProcessFingerprint;
  readonly detachMain: boolean;
  readonly taskSessionName: string;
  readonly marker: string;
  readonly mainReadyMarker: string;
  readonly mainAbsentMarker: string;
}): string {
  const injector = normalizeGuestProcessFingerprint(args.injector);
  const main = normalizeGuestProcessFingerprint(args.main);
  if (!SAFE_TMUX_NAME_PATTERN.test(args.taskSessionName)) {
    throw new ExactReleaseError('identity-mismatch');
  }
  const markerBoundary = args.marker.lastIndexOf('_');
  const diagnosticNonce = args.marker.slice(markerBoundary + 1);
  if (!SAFE_REGISTRATION_NONCE_PATTERN.test(diagnosticNonce)) {
    throw new ExactReleaseError('identity-mismatch');
  }
  assertProtocolMarker(args.mainReadyMarker);
  assertProtocolMarker(args.mainAbsentMarker);
  const selfPredicate = buildExactGuestFingerprintPredicate(
    injector,
    'cap_self',
    true,
    true,
  );
  const detachMain = args.detachMain
    ? [
        `cap_main_pid='${main.pid}'; cap_main_sid='${main.sid}'; cap_main_pgid='${main.pgid}';`,
        `cap_main_start='${main.startTime}'; cap_main_tty='${main.tty}'; cap_main_boot='${main.bootId}';`,
        'cap_main_exact() {',
        'cap_main_actual_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) &&',
        '[ "$cap_main_actual_boot" = "$cap_main_boot" ] &&',
        'cap_main_stat=$(cat "/proc/$cap_main_pid/stat" 2>/dev/null) &&',
        'cap_main_tail=${cap_main_stat##*) } && set -- $cap_main_tail &&',
        '[ "${3}" = "$cap_main_pgid" ] && [ "${4}" = "$cap_main_sid" ] &&',
        '[ "${20}" = "$cap_main_start" ] &&',
        'cap_main_actual_tty=$(readlink "/proc/$cap_main_pid/fd/0" 2>/dev/null) &&',
        '[ "$cap_main_actual_tty" = "$cap_main_tty" ] && cap_main_tpgid="${6}";',
        '};',
        'cap_main_read_children() {',
        'exec 8<"/proc/$cap_main_pid/task/$cap_main_pid/children" 2>/dev/null &&',
        "cap_main_children='' && { IFS= read -r cap_main_children <&8 || :; } &&",
        'exec 8<&- 2>/dev/null;',
        '};',
        'cap_main_state() { cap_main_exact && cap_main_read_children; };',
        "cap_main_fd_open=0; cap_main_outcome='';",
        "cap_release_stage='MAIN_PRESENCE';",
        'if [ ! -e "/proc/$cap_main_pid" ]; then',
        "cap_release_stage='MAIN_ABSENT';",
        'cap_main_kill_error=$(LC_ALL=C kill -0 "$cap_main_pid" 2>&1); cap_main_kill_status=$?;',
        `if [ "$cap_main_kill_status" -eq 0 ] || ! printf '%s\\n' "$cap_main_kill_error" | grep -Fq 'No such process'; then cap_release_ok=0; else cap_main_outcome='ABSENT'; fi;`,
        'else',
        "cap_release_stage='MAIN_PIN_OPEN';",
        'if exec 9<"/proc/$cap_main_pid/fd/0" 2>/dev/null; then cap_main_fd_open=1; else cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then cap_release_stage="MAIN_PIN_READ"; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then cap_main_pinned_tty=$(readlink "/proc/$$/fd/9" 2>/dev/null) || cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ] && [ "$cap_main_pinned_tty" != "$cap_main_tty" ]; then cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then cap_release_stage="MAIN_EXACT"; fi;',
        'if [ "$cap_release_ok" -eq 1 ] && ! cap_main_state; then cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then cap_release_stage="MAIN_ACTIVITY"; fi;',
        'if [ "$cap_release_ok" -eq 1 ] && { [ "$cap_main_tpgid" != "$cap_main_pgid" ] || [ -n "$cap_main_children" ]; }; then',
        "cap_release_stage='MAIN_CLIENT';",
        'command -v tmux >/dev/null 2>&1 || cap_release_ok=0;',
        `if [ "$cap_release_ok" -eq 1 ]; then tmux has-session -t '=${args.taskSessionName}' 2>/dev/null; [ "$?" -eq 0 ] || cap_release_ok=0; fi;`,
        `if [ "$cap_release_ok" -eq 1 ]; then cap_clients=$(tmux list-clients -t '=${args.taskSessionName}' -F '#{client_tty}' 2>/dev/null) || cap_release_ok=0; fi;`,
        'if [ "$cap_release_ok" -eq 1 ] && ! printf \'%s\\n\' "$cap_clients" | grep -Fqx -- "$cap_main_tty"; then cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then if cap_main_exact; then cap_main_pinned_tty=$(readlink "/proc/$$/fd/9" 2>/dev/null) || cap_release_ok=0; else cap_release_ok=0; fi; fi;',
        'if [ "$cap_release_ok" -eq 1 ] && [ "$cap_main_pinned_tty" != "$cap_main_tty" ]; then cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then cap_release_stage="MAIN_DETACH"; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then tmux detach-client -t "$cap_main_tty" 2>/dev/null || cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then cap_release_stage="MAIN_SETTLE"; fi;',
        'cap_main_ready=0; cap_main_i=0;',
        'while [ "$cap_release_ok" -eq 1 ] && [ "$cap_main_i" -lt 20 ]; do',
        'if ! cap_main_state; then cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ] && [ "$cap_main_tpgid" = "$cap_main_pgid" ] && [ -z "$cap_main_children" ]; then cap_main_ready=1; break; fi;',
        'cap_main_i=$((cap_main_i + 1)); sleep 0.05;',
        'done;',
        'if [ "$cap_main_ready" -ne 1 ]; then cap_release_ok=0; fi;',
        'if [ "$cap_release_ok" -eq 1 ]; then cap_release_stage="MAIN_READY"; cap_main_outcome="READY"; fi;',
        'fi;',
        'if [ "$cap_release_ok" -eq 1 ] && [ -z "$cap_main_outcome" ]; then',
        'if cap_main_state && [ "$cap_main_tpgid" = "$cap_main_pgid" ] && [ -z "$cap_main_children" ]; then cap_release_stage="MAIN_READY"; cap_main_outcome="READY"; else cap_release_ok=0; fi;',
        'fi;',
        'if [ "$cap_main_fd_open" -eq 1 ]; then exec 9<&- 2>/dev/null || cap_release_ok=0; fi;',
        'fi;',
      ].join('\n')
    : "cap_main_outcome='ABSENT';";
  return [
    "cap_release_stage='SELF'; cap_release_ok=0;",
    `if ${selfPredicate}; then`,
    "cap_release_stage='MAIN_START'; cap_release_ok=1;",
    detachMain,
    'if [ "$cap_release_ok" -eq 1 ]; then',
    `case "$cap_main_outcome" in READY) ${buildEchoSafeProtocolMarkerPrint(args.mainReadyMarker)} ;; ABSENT) ${buildEchoSafeProtocolMarkerPrint(args.mainAbsentMarker)} ;; *) cap_release_ok=0 ;; esac;`,
    'fi;',
    'if [ "$cap_release_ok" -eq 1 ]; then',
    `${buildEchoSafeProtocolMarkerPrint(args.marker)};`,
    'exit;',
    'fi;',
    'fi;',
    `printf '\\r\\nCAP_AIO_INJECTOR_DIAG_%s_%s\\r\\n' "$cap_release_stage" '${diagnosticNonce}';`,
    '',
  ]
    .filter((line, index, lines) => line.length > 0 || index === lines.length - 1)
    .join('\n');
}

function singleReleaseInputPlan(data: string): ReconnectReleaseInputPlan {
  return Object.freeze({
    frames: Object.freeze([
      Object.freeze({
        data: assertBoundedReleaseFrame(data),
        acknowledgement: null,
      }),
    ]),
    failureMarker: null,
    outcomeMarkers: null,
  });
}

function buildInjectorReleaseInputPlan(args: {
  readonly closeToken: string;
  readonly releaseMarker: string;
  readonly exitMarker: string;
  readonly releaseCommand: string;
  readonly mainReadyMarker: string;
  readonly mainAbsentMarker: string;
}): ReconnectReleaseInputPlan {
  if (!SAFE_CLOSE_TOKEN_PATTERN.test(args.closeToken)) {
    throw new ExactReleaseError('identity-mismatch');
  }
  assertProtocolMarker(args.releaseMarker);
  assertProtocolMarker(args.exitMarker);
  assertProtocolMarker(args.mainReadyMarker);
  assertProtocolMarker(args.mainAbsentMarker);
  if (!args.releaseMarker.startsWith('CAP_AIO_INJECTOR_RELEASED_')) {
    throw new ExactReleaseError('identity-mismatch');
  }
  const releaseScriptBytes = Buffer.byteLength(args.releaseCommand, 'utf8');
  if (
    releaseScriptBytes === 0 ||
    releaseScriptBytes > AIO_TERMINAL_RELEASE_SCRIPT_MAX_BYTES
  ) {
    throw new ExactReleaseError('identity-mismatch');
  }

  const encodedScript = Buffer.from(args.releaseCommand, 'utf8').toString(
    'base64',
  );
  const failureMarker = args.releaseMarker.replace(
    'CAP_AIO_INJECTOR_RELEASED_',
    'CAP_AIO_INJECTOR_FAILED_',
  );
  assertProtocolMarker(failureMarker);
  const stageKey = sha256Hex(`stage:${args.exitMarker}`).slice(0, 32);
  const readyMarker = releaseStageMarker(args.exitMarker, -1);
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < encodedScript.length;
    offset += AIO_TERMINAL_RELEASE_STAGE_CHUNK_CHARS
  ) {
    chunks.push(
      encodedScript.slice(
        offset,
        offset + AIO_TERMINAL_RELEASE_STAGE_CHUNK_CHARS,
      ),
    );
  }
  if (chunks.length === 0) throw new ExactReleaseError('identity-mismatch');

  const frames: ReconnectReleaseInputFrame[] = [];
  frames.push(
    Object.freeze({
      data: assertBoundedReleaseFrame(`${args.closeToken}\n`),
      acknowledgement: null,
    }),
  );
  frames.push(
    Object.freeze({
      data: assertBoundedReleaseFrame(
        `cap_stage_key='${stageKey}'; cap_stage_seq='0'; cap_stage_data=''; ` +
          `${buildEchoSafeProtocolMarkerPrint(readyMarker)}\n`,
      ),
      acknowledgement: readyMarker,
    }),
  );
  for (let index = 0; index < chunks.length; index += 1) {
    const acknowledgement = releaseStageMarker(args.exitMarker, index);
    const nextSequence = String(index + 1);
    frames.push(
      Object.freeze({
        data: assertBoundedReleaseFrame(
          `if [ "$cap_stage_key" = '${stageKey}' ] && ` +
            `[ "$cap_stage_seq" = '${index}' ]; then ` +
            `cap_stage_data="\${cap_stage_data}"'${chunks[index]}'; ` +
            `cap_stage_seq='${nextSequence}'; ` +
            `${buildEchoSafeProtocolMarkerPrint(acknowledgement)}; fi\n`,
        ),
        acknowledgement,
      }),
    );
  }
  const encodedDigest = sha256Hex(encodedScript);
  const executeReadyMarker = releaseStageMarker(
    args.exitMarker,
    chunks.length,
  );
  frames.push(
    Object.freeze({
      data: assertBoundedReleaseFrame(
        `if [ "$cap_stage_key" = '${stageKey}' ] && ` +
          `[ "$cap_stage_seq" = '${chunks.length}' ] && ` +
          `[ "\${#cap_stage_data}" = '${encodedScript.length}' ]; then ` +
          `cap_stage_digest=$(printf '%s' "$cap_stage_data" | sha256sum); ` +
          `cap_stage_digest=\${cap_stage_digest%% *}; ` +
          `if [ "$cap_stage_digest" = '${encodedDigest}' ]; then ` +
          `cap_stage_script=$(printf '%s' "$cap_stage_data" | base64 -d 2>/dev/null) && ` +
          `cap_stage_seq='${chunks.length + 1}' && ` +
          `${buildEchoSafeProtocolMarkerPrint(executeReadyMarker)}; fi; fi\n`,
      ),
      acknowledgement: executeReadyMarker,
    }),
  );
  frames.push(
    Object.freeze({
      data: assertBoundedReleaseFrame(
        `if [ "$cap_stage_key" = '${stageKey}' ] && ` +
          `[ "$cap_stage_seq" = '${chunks.length + 1}' ]; then ` +
          `eval "$cap_stage_script"; ` +
          `${buildEchoSafeProtocolMarkerPrint(failureMarker)}; fi\n`,
      ),
      acknowledgement: null,
    }),
  );
  return Object.freeze({
    frames: Object.freeze(frames),
    failureMarker,
    outcomeMarkers: Object.freeze({
      mainReady: args.mainReadyMarker,
      mainAbsent: args.mainAbsentMarker,
    }),
  });
}

function releaseStageMarker(exitMarker: string, sequence: number): string {
  assertProtocolMarker(exitMarker);
  const nonce = sha256Hex(`${exitMarker}:stage:${sequence}`).slice(0, 24);
  const marker = `CAP_AIO_INJECTOR_STAGE_${nonce}`;
  assertProtocolMarker(marker);
  return marker;
}

function assertBoundedReleaseFrame(value: string): string {
  if (
    !value.endsWith('\n') ||
    value.slice(0, -1).includes('\n') ||
    Buffer.byteLength(value, 'utf8') > AIO_TERMINAL_RELEASE_FRAME_MAX_BYTES
  ) {
    throw new ExactReleaseError('identity-mismatch');
  }
  return value;
}

function buildExactGuestFingerprintPredicate(
  fingerprintValue: AioTerminalGuestProcessFingerprint,
  prefix: 'cap_self' | 'cap_main',
  requireSelfPid: boolean,
  requireForeground: boolean,
): string {
  const fingerprint = normalizeGuestProcessFingerprint(fingerprintValue);
  const checks = [
    `${prefix}_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)`,
    `[ "$${prefix}_boot" = '${fingerprint.bootId}' ]`,
  ];
  if (requireSelfPid) checks.push(`[ "$$" = '${fingerprint.pid}' ]`);
  checks.push(
    `${prefix}_stat=$(cat '/proc/${fingerprint.pid}/stat' 2>/dev/null)`,
    `${prefix}_tail=\${${prefix}_stat##*) }`,
    `set -- $${prefix}_tail`,
    `[ "\${3}" = '${fingerprint.pgid}' ]`,
    `[ "\${4}" = '${fingerprint.sid}' ]`,
    `[ "\${20}" = '${fingerprint.startTime}' ]`,
    `${prefix}_tty=$(readlink '/proc/${fingerprint.pid}/fd/0' 2>/dev/null)`,
    `[ "$${prefix}_tty" = '${fingerprint.tty}' ]`,
  );
  if (requireForeground) {
    checks.push(
      `[ "\${6}" = '${fingerprint.pgid}' ]`,
      buildExactGuestChildrenRead(fingerprint, prefix),
      `[ -z "$${prefix}_children" ]`,
    );
  }
  return checks.join(' && ');
}

function buildExactGuestChildrenRead(
  fingerprint: AioTerminalGuestProcessFingerprint,
  prefix: 'cap_self' | 'cap_main',
): string {
  return (
    `exec 8<'/proc/${fingerprint.pid}/task/${fingerprint.pid}/children' 2>/dev/null && ` +
    `${prefix}_children='' && ` +
    `{ IFS= read -r ${prefix}_children <&8 || :; } && ` +
    'exec 8<&- 2>/dev/null'
  );
}

function buildEchoSafeProtocolMarkerPrint(marker: string): string {
  assertProtocolMarker(marker);
  const markerBoundary = marker.lastIndexOf('_');
  const prefix = marker.slice(0, markerBoundary + 1);
  const nonce = marker.slice(markerBoundary + 1);
  return `printf '\\r\\n${prefix}%s\\r\\n' '${nonce}'`;
}

function sendReconnectInput(
  socket: AioTerminalReconnectSocket,
  data: string,
  onComplete?: (error?: Error) => void,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify({ type: 'input', data }), (error) => {
      if (error) closeReconnectSocket(socket);
      onComplete?.(error);
    });
    return true;
  } catch {
    return false;
  }
}

function hasExactProtocolMarkerLine(buffer: string, marker: string): boolean {
  assertProtocolMarker(marker);
  const normalized = buffer.replace(/\r\n|\r/gu, '\n');
  return normalized.includes(`\n${marker}\n`);
}

function createExactProtocolMarkerObservationState(
  inputPlan: ReconnectReleaseInputPlan,
  exitMarker: string,
): ExactProtocolMarkerObservationState {
  const expected = [
    inputPlan.failureMarker,
    ...inputPlan.frames.map(({ acknowledgement }) => acknowledgement),
    inputPlan.outcomeMarkers?.mainReady,
    inputPlan.outcomeMarkers?.mainAbsent,
    exitMarker,
  ].filter((marker): marker is string => marker !== null && marker !== undefined);
  const markers = [...new Set(expected)];
  if (markers.length !== expected.length) {
    throw new ExactReleaseError('identity-mismatch');
  }
  const nodes: ExactProtocolMarkerTrieNode[] = [
    { next: new Map(), marker: null },
  ];
  for (const marker of markers) {
    assertProtocolMarker(marker);
    let nodeIndex = 0;
    for (const character of marker) {
      const node = nodes[nodeIndex]!;
      let nextIndex = node.next.get(character);
      if (nextIndex === undefined) {
        nextIndex = nodes.length;
        node.next.set(character, nextIndex);
        nodes.push({ next: new Map(), marker: null });
      }
      nodeIndex = nextIndex;
    }
    nodes[nodeIndex]!.marker = marker;
  }
  return {
    nodes,
    counts: new Map(markers.map((marker) => [marker, 0])),
    firstObservationOrder: new Map(),
    currentNode: null,
    lineEligible: false,
    pendingCarriageReturn: false,
    nextObservationOrder: 0,
  };
}

function observeExactProtocolMarkerOutput(
  state: ExactProtocolMarkerObservationState,
  output: string,
): void {
  const completeLine = (): void => {
    if (state.lineEligible && state.currentNode !== null) {
      const marker = state.nodes[state.currentNode]?.marker;
      if (marker !== null && marker !== undefined) {
        const previousCount = state.counts.get(marker) ?? 0;
        state.counts.set(marker, Math.min(2, previousCount + 1));
        if (previousCount === 0) {
          state.firstObservationOrder.set(
            marker,
            state.nextObservationOrder,
          );
          state.nextObservationOrder += 1;
        }
      }
    }
    state.lineEligible = true;
    state.currentNode = 0;
  };

  for (const character of output) {
    if (character === '\n' && state.pendingCarriageReturn) {
      state.pendingCarriageReturn = false;
      continue;
    }
    state.pendingCarriageReturn = false;
    if (character === '\r') {
      completeLine();
      state.pendingCarriageReturn = true;
      continue;
    }
    if (character === '\n') {
      completeLine();
      continue;
    }
    if (!state.lineEligible || state.currentNode === null) continue;
    state.currentNode =
      state.nodes[state.currentNode]?.next.get(character) ?? null;
  }
}

function exactProtocolMarkerObservationCount(
  state: ExactProtocolMarkerObservationState,
  marker: string,
): number {
  const count = state.counts.get(marker);
  if (count === undefined) throw new ExactReleaseError('protocol-unconfirmed');
  return count;
}

function exactProtocolMarkerFirstObservationOrder(
  state: ExactProtocolMarkerObservationState,
  marker: string,
): number | undefined {
  if (!state.counts.has(marker)) {
    throw new ExactReleaseError('protocol-unconfirmed');
  }
  return state.firstObservationOrder.get(marker);
}

type ExactReleaseCause = Extract<
  AioTerminalGuestPairReleaseSettlement,
  { readonly kind: 'indeterminate' }
>['cause'];

class ExactReleaseError extends Error {
  constructor(readonly releaseCause: ExactReleaseCause) {
    super('AIO terminal exact release was not confirmed');
  }
}

/**
 * A pinned AIO session permits one live character subscriber. Immediately
 * after the transport closes, its server-side unsubscribe may briefly lag the
 * close event. Retrying is safe only before terminal_restored and before the
 * first input frame; every later failure retains the ordinary fail-closed path.
 */
class PreIdentityReconnectError extends ExactReleaseError {
  constructor() {
    super('protocol-unconfirmed');
  }
}

function exactReleaseCause(error: unknown): ExactReleaseCause {
  return error instanceof ExactReleaseError ? error.releaseCause : 'protocol-unconfirmed';
}

function exactReleaseIndeterminate(
  cause: ExactReleaseCause,
): AioTerminalGuestPairReleaseSettlement {
  return Object.freeze({ kind: 'indeterminate' as const, cause });
}

function runExactReleaseBeforeDeadline<T>(
  deadline: number,
  action: () => Promise<T>,
): Promise<T> {
  const remaining = remainingReleaseMs(deadline);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (continuation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      continuation();
    };
    const timer = setTimeout(
      () => settle(() => reject(new ExactReleaseError('timeout'))),
      remaining,
    );
    timer.unref?.();
    void action().then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

function remainingReleaseMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new ExactReleaseError('timeout');
  }
  return remaining;
}

function exactReleaseReconnectPhaseDeadline(
  deadline: number,
  normalizedTimeoutMs: number,
): number {
  const proofReserveMs = Math.min(
    AIO_TERMINAL_EXACT_RELEASE_PROOF_RESERVE_MS,
    Math.max(
      1,
      Math.floor(normalizedTimeoutMs / 2),
      normalizedTimeoutMs - 6_000,
    ),
  );
  return deadline - proofReserveMs;
}

function exactReleaseRecoveryPhaseDeadline(deadline: number): number {
  const productionDeadline =
    deadline -
    AIO_SHELL_SESSION_CLEANUP_MAX_BUDGET_MS -
    AIO_TERMINAL_EXACT_RELEASE_DRAIN_MARGIN_MS -
    AIO_TERMINAL_EXACT_RELEASE_FINAL_PROOF_COMMAND_RESERVE_MS;
  const now = Date.now();
  if (productionDeadline > now) return productionDeadline;
  // Explicit sub-second tests and diagnostics cannot reserve the production
  // envelope; split only their remaining command slice without expanding the
  // caller's absolute deadline.
  return (
    now + Math.max(1, Math.floor((deadline - now) / 2))
  );
}

function defaultAioTerminalReconnectSocketFactory(
  url: string,
): AioTerminalReconnectSocket {
  return new WebSocket(url, {
    maxPayload: AIO_TERMINAL_RECONNECT_OUTPUT_MAX_BYTES,
  });
}

function aioTerminalReconnectUrl(baseUrl: string, sessionId: string): string {
  assertProviderSessionId(sessionId);
  let url: URL;
  try {
    url = new URL(normalizeBaseUrl(baseUrl));
  } catch {
    throw new ExactReleaseError('identity-mismatch');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ExactReleaseError('identity-mismatch');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/shell/ws';
  url.search = '';
  url.hash = '';
  url.searchParams.set('session_id', sessionId);
  return url.toString();
}

function closeReconnectSocket(socket: AioTerminalReconnectSocket): void {
  try {
    if (socket.terminate) socket.terminate();
    else socket.close();
  } catch {
    // A concurrently closed cleanup socket is already detached from the PTY.
  }
}

function parseReconnectFrame(
  raw: WebSocket.RawData,
): { readonly type: string; readonly data?: unknown } | null {
  try {
    const value = JSON.parse(rawDataToBuffer(raw).toString('utf8')) as unknown;
    return isRecord(value) && typeof value.type === 'string'
      ? (value as { readonly type: string; readonly data?: unknown })
      : null;
  } catch {
    return null;
  }
}

function rawDataByteLength(raw: WebSocket.RawData): number {
  return rawDataToBuffer(raw).byteLength;
}

function rawDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

function appendBoundedText(current: string, addition: string, max: number): string {
  const combined = current + addition;
  return combined.length <= max ? combined : combined.slice(-max);
}

function terminalCommandOutput(data: Record<string, unknown>): string {
  return typeof data.output === 'string'
    ? data.output
    : typeof data.stdout === 'string'
      ? data.stdout
      : '';
}

function releaseProtocolMarker(
  label: 'MAIN_EXIT' | 'INJECTOR_EXIT',
  factory: () => string,
): string {
  let nonce: string;
  try {
    nonce = factory();
  } catch {
    throw new ExactReleaseError('identity-mismatch');
  }
  if (!SAFE_REGISTRATION_NONCE_PATTERN.test(nonce)) {
    throw new ExactReleaseError('identity-mismatch');
  }
  return `CAP_AIO_${label}_${nonce}`;
}

function injectorMainOutcomeMarker(
  exitMarker: string,
  label: 'MAIN_READY' | 'MAIN_ABSENT',
): string {
  assertProtocolMarker(exitMarker);
  const prefix = 'CAP_AIO_INJECTOR_EXIT_';
  if (!exitMarker.startsWith(prefix)) {
    throw new ExactReleaseError('identity-mismatch');
  }
  const nonce = exitMarker.slice(prefix.length);
  if (!SAFE_REGISTRATION_NONCE_PATTERN.test(nonce)) {
    throw new ExactReleaseError('identity-mismatch');
  }
  const marker = `CAP_AIO_${label}_${nonce}`;
  assertProtocolMarker(marker);
  return marker;
}

/**
 * Startup/readoption sweep for sessions left behind by an API SIGKILL. It does
 * not depend on AIO's REST session inventory: that endpoint has been observed
 * to omit live WebSocket terminal sessions. Every record is read and
 * authenticated before the first DELETE, and only exact stale identities from
 * the requested physical scope can be removed.
 */
export async function sweepAioStaleTerminalSessions(args: {
  readonly fetch: AioShellFetch;
  readonly baseUrl: string;
  readonly scope?: AioTerminalOwnershipScope;
  readonly processFingerprint?: string;
  readonly timing?: AioTerminalOwnershipTiming;
  readonly guestPairReleaser?: AioTerminalGuestPairReleaser;
  readonly reconnectSocketFactory?: AioTerminalReconnectSocketFactory;
  readonly releaseMarkerFactory?: () => string;
}): Promise<AioStaleTerminalSessionSweepSettlement> {
  const counts = mutableSweepCounts();
  if (!isCompleteAioTerminalOwnershipScope(args.scope)) {
    return indeterminateSweep(counts, 'ownership-unavailable');
  }

  let processFingerprint: string;
  let expectedScopeFingerprint: string;
  let expectedOwnerFingerprint: string;
  try {
    processFingerprint = normalizeProcessFingerprint(
      args.processFingerprint ?? currentAioTerminalProcessFingerprint(),
    );
    expectedScopeFingerprint = ownershipScopeFingerprint(args.scope);
    expectedOwnerFingerprint = sha256Hex(args.scope.ownership.ownerGeneration);
  } catch {
    return indeterminateSweep(counts, 'ownership-unavailable');
  }

  const timeoutMs = normalizeRequestTimeout(args.timing?.requestTimeoutMs);
  let paths: readonly string[];
  try {
    paths = await listOwnershipRecordPaths(
      args.fetch,
      args.baseUrl,
      timeoutMs,
    );
  } catch (error) {
    return indeterminateSweep(
      counts,
      error instanceof InvalidAioTerminalJournalError
        ? 'journal-invalid'
        : 'journal-unconfirmed',
    );
  }
  counts.inspectedRecords = paths.length;

  let records: readonly DecodedAioTerminalOwnershipRecord[];
  try {
    records = await Promise.all(
      paths.map((path) =>
        readAndDecodeOwnershipRecord({
          fetch: args.fetch,
          baseUrl: args.baseUrl,
          timeoutMs,
          path,
          scope: args.scope!,
        }),
      ),
    );
  } catch (error) {
    return indeterminateSweep(
      counts,
      error instanceof InvalidAioTerminalJournalError
        ? 'journal-invalid'
        : 'journal-unconfirmed',
    );
  }

  const stale: DecodedAioTerminalOwnershipRecord[] = [];
  for (const record of records) {
    if (record.scopeFingerprint !== expectedScopeFingerprint) {
      counts.unrelatedRecords += 1;
      continue;
    }
    if (
      record.ownerFingerprint === expectedOwnerFingerprint &&
      record.processFingerprint === processFingerprint
    ) {
      counts.peerRecords += 1;
      continue;
    }
    counts.staleRecords += 1;
    stale.push(record);
  }
  if (stale.length === 0) return confirmedSweep(counts);

  const releaser =
    args.guestPairReleaser ?? releaseAioTerminalGuestPairExact;
  const cleanupDeadline =
    Date.now() + normalizeExactReleaseTimeout(args.timing?.exactReleaseTimeoutMs);
  const cleanupResults: Array<readonly AioShellSessionCleanupProof[] | null> = [];
  for (const record of stale) {
    let releaseTimeoutMs: number;
    try {
      releaseTimeoutMs = remainingReleaseMs(cleanupDeadline);
    } catch {
      cleanupResults.push(null);
      continue;
    }
    const release = await releaser({
      fetch: args.fetch,
      baseUrl: args.baseUrl,
      taskId: args.scope!.taskId,
      pair: record.pair,
      timeoutMs: releaseTimeoutMs,
      maxOutputBytes: args.timing?.reconnectOutputMaxBytes,
      socketFactory: args.reconnectSocketFactory,
      markerFactory: args.releaseMarkerFactory,
    }).catch(() => exactReleaseIndeterminate('protocol-unconfirmed'));
    if (release.kind !== 'confirmed') {
      cleanupResults.push(null);
      continue;
    }
    const providerIds = [
      record.pair.mainSessionId,
      record.pair.injectorSessionId,
    ];
    try {
      cleanupResults.push(
        await Promise.all(
          providerIds.map((providerSessionId) =>
            deleteAioShellSessionExact(
              args.fetch,
              args.baseUrl,
              providerSessionId,
              {
                attemptTimeoutMs: args.timing?.cleanupAttemptTimeoutMs,
                retryDelayMs: args.timing?.cleanupRetryDelayMs,
              },
            ),
          ),
        ),
      );
    } catch {
      cleanupResults.push(null);
    }
  }
  for (const proofs of cleanupResults) {
    if (proofs === null) continue;
    counts.confirmedIdentities += proofs.length;
    counts.deletedIdentities += proofs.filter(
      (proof) => proof === 'deleted',
    ).length;
    counts.alreadyAbsentIdentities += proofs.filter(
      (proof) => proof === 'already-absent',
    ).length;
  }
  if (counts.confirmedIdentities !== counts.staleRecords * 2) {
    return indeterminateSweep(counts, 'cleanup-unconfirmed');
  }

  try {
    await deleteAioTerminalOwnershipRecordFilesExact({
      fetch: args.fetch,
      baseUrl: args.baseUrl,
      paths: stale.map((record) => record.path),
      requestTimeoutMs: timeoutMs,
    });
    counts.removedRecords = stale.length;
  } catch {
    return indeterminateSweep(counts, 'journal-cleanup-unconfirmed');
  }
  return confirmedSweep(counts);
}

/** Remove only already-validated, hash-addressed ownership records. */
export async function deleteAioTerminalOwnershipRecordFilesExact(args: {
  readonly fetch: AioShellFetch;
  readonly baseUrl: string;
  readonly paths: readonly string[];
  readonly requestTimeoutMs?: number;
}): Promise<void> {
  const paths = [...new Set(args.paths)].sort();
  if (paths.length === 0) return;
  if (paths.length > AIO_TERMINAL_JOURNAL_MAX_RECORDS) {
    throw new Error('AIO terminal ownership record cleanup was invalid');
  }
  for (const path of paths) assertOwnershipRecordPath(path);
  const command = `rm -f -- ${paths.map((path) => `'${path}'`).join(' ')}`;
  const timeoutMs = normalizeRequestTimeout(args.requestTimeoutMs);
  const result = await runWithDeadline(timeoutMs, (signal) =>
    executeAioShellCommand(
      args.fetch,
      normalizeBaseUrl(args.baseUrl),
      command,
      signal,
    ),
  );
  if (
    !result.ok ||
    !isRecord(result.body) ||
    result.body.success !== true ||
    !isRecord(result.body.data) ||
    result.body.data.command !== command ||
    result.body.data.status !== 'completed' ||
    result.body.data.exit_code !== 0
  ) {
    throw new Error('AIO terminal ownership record cleanup was not confirmed');
  }
}

async function listOwnershipRecordPaths(
  fetchImpl: AioShellFetch,
  baseUrl: string,
  timeoutMs: number,
): Promise<readonly string[]> {
  const response = await runWithDeadline(timeoutMs, (signal) =>
    fetchImpl(`${normalizeBaseUrl(baseUrl)}/v1/file/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR,
        recursive: false,
        show_hidden: true,
        include_size: true,
        include_permissions: false,
        sort_by: 'name',
        sort_desc: false,
      }),
      signal,
    }),
  );
  const body = await response.json().catch(() => undefined);
  if (isConfirmedMissingPath(response, body)) return [];
  if (
    !response.ok ||
    !isRecord(body) ||
    body.success !== true
  ) {
    throw new Error('journal list');
  }
  if (
    !isRecord(body.data) ||
    body.data.path !== AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR ||
    !Array.isArray(body.data.files) ||
    body.data.files.length > AIO_TERMINAL_JOURNAL_MAX_RECORDS
  ) {
    throw new InvalidAioTerminalJournalError();
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of body.data.files) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.path !== 'string' ||
      entry.is_directory !== false ||
      (entry.size !== undefined &&
        entry.size !== null &&
        (!Number.isSafeInteger(entry.size) ||
          (entry.size as number) < 1 ||
          (entry.size as number) > AIO_TERMINAL_JOURNAL_RECORD_MAX_BYTES))
    ) {
      throw new InvalidAioTerminalJournalError();
    }
    const match = JOURNAL_FILE_NAME_PATTERN.exec(entry.name);
    const expectedPath = `${AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR}/${entry.name}`;
    if (!match || entry.path !== expectedPath || seen.has(expectedPath)) {
      throw new InvalidAioTerminalJournalError();
    }
    seen.add(expectedPath);
    paths.push(expectedPath);
  }
  assertOptionalListCount(body.data.total_count, paths.length);
  assertOptionalListCount(body.data.file_count, paths.length);
  assertOptionalListCount(body.data.directory_count, 0);
  return paths;
}

async function readAndDecodeOwnershipRecord(args: {
  readonly fetch: AioShellFetch;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly path: string;
  readonly scope: AioTerminalOwnershipScope;
}): Promise<DecodedAioTerminalOwnershipRecord> {
  assertOwnershipRecordPath(args.path);
  const response = await runWithDeadline(args.timeoutMs, (signal) =>
    args.fetch(`${normalizeBaseUrl(args.baseUrl)}/v1/file/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: args.path,
        start_line: 0,
        end_line: 2,
        sudo: false,
      }),
      signal,
    }),
  );
  const body = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    !isRecord(body) ||
    body.success !== true
  ) {
    throw new Error('journal read');
  }
  if (
    !isRecord(body.data) ||
    body.data.file !== args.path ||
    typeof body.data.content !== 'string' ||
    body.data.content.length === 0 ||
    body.data.content.length > AIO_TERMINAL_JOURNAL_RECORD_MAX_CHARS
  ) {
    throw new InvalidAioTerminalJournalError();
  }
  const content = body.data.content.replace(/\r?\n$/u, '');
  if (content.includes('\n') || content.includes('\r')) {
    throw new InvalidAioTerminalJournalError();
  }
  return decodeOwnershipRecord(args.path, content, args.scope);
}

function decodeOwnershipRecord(
  path: string,
  content: string,
  scope: AioTerminalOwnershipScope,
): DecodedAioTerminalOwnershipRecord {
  const match = JOURNAL_RECORD_PATTERN.exec(content);
  if (!match) throw new InvalidAioTerminalJournalError();
  const parsed: ParsedJournalRecord = {
    scopeFingerprint: match[1]!,
    ownerFingerprint: match[2]!,
    processFingerprint: match[3]!,
    pairFingerprint: match[4]!,
    ivHex: match[5]!,
    ciphertext: match[6]!,
    authTagHex: match[7]!,
  };
  const pathPairFingerprint = path.slice(
    AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR.length + 1,
    -AIO_TERMINAL_OWNERSHIP_FILE_SUFFIX.length,
  );
  if (pathPairFingerprint !== parsed.pairFingerprint) {
    throw new InvalidAioTerminalJournalError();
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      ownershipEncryptionKey(scope),
      Buffer.from(parsed.ivHex, 'hex'),
    );
    decipher.setAAD(
      Buffer.from(
        ownershipRecordAad({
          pairFingerprint: parsed.pairFingerprint,
          scopeFingerprint: parsed.scopeFingerprint,
          ownerFingerprint: parsed.ownerFingerprint,
          processFingerprint: parsed.processFingerprint,
        }),
        'utf8',
      ),
    );
    decipher.setAuthTag(Buffer.from(parsed.authTagHex, 'hex'));
    const pairPayload = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const pair = deserializeOwnershipPair(pairPayload);
    if (sha256Hex(pairPayload) !== parsed.pairFingerprint) {
      throw new Error('identity digest mismatch');
    }
    return {
      path,
      pair,
      scopeFingerprint: parsed.scopeFingerprint,
      ownerFingerprint: parsed.ownerFingerprint,
      processFingerprint: parsed.processFingerprint,
    };
  } catch {
    throw new InvalidAioTerminalJournalError();
  }
}

function ownershipRecordAad(args: {
  readonly pairFingerprint: string;
  readonly scopeFingerprint: string;
  readonly ownerFingerprint: string;
  readonly processFingerprint: string;
}): string {
  return canonicalFields([
    AIO_TERMINAL_OWNERSHIP_VERSION,
    args.pairFingerprint,
    args.scopeFingerprint,
    args.ownerFingerprint,
    args.processFingerprint,
  ]);
}

function ownershipEncryptionKey(scope: AioTerminalOwnershipScope): Buffer {
  return createHash('sha256')
    .update(
      canonicalFields([
        AIO_TERMINAL_OWNERSHIP_VERSION,
        'encryption-key',
        scope.ownership.resourceGeneration,
      ]),
    )
    .digest();
}

function ownershipScopeFingerprint(scope: AioTerminalOwnershipScope): string {
  assertOwnershipScope(scope);
  return sha256Hex(
    canonicalFields([
      AIO_TERMINAL_OWNERSHIP_VERSION,
      scope.taskId,
      scope.providerSandboxId,
      scope.ownership.resourceGeneration,
    ]),
  );
}

function ownershipRecordPath(pairFingerprint: string): string {
  return `${AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR}/${pairFingerprint}${AIO_TERMINAL_OWNERSHIP_FILE_SUFFIX}`;
}

function assertOwnershipRecordPath(path: string): void {
  const prefix = `${AIO_TERMINAL_OWNERSHIP_JOURNAL_DIR}/`;
  if (
    typeof path !== 'string' ||
    !path.startsWith(prefix) ||
    !JOURNAL_FILE_NAME_PATTERN.test(path.slice(prefix.length))
  ) {
    throw new Error('AIO terminal ownership record path was invalid');
  }
}

function assertProviderSessionId(value: string): void {
  if (!isBoundedNonControlString(value)) {
    throw new Error('AIO terminal provider session identity was invalid');
  }
}

function assertReconnectProviderSessionId(value: string): void {
  if (!isCanonicalAioTerminalProviderSessionId(value)) {
    throw new Error('AIO terminal reconnect identity was invalid');
  }
}

export function isCanonicalAioTerminalProviderSessionId(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' && AIO_RECONNECT_SESSION_ID_PATTERN.test(value)
  );
}

function isBoundedNonControlString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AIO_TERMINAL_SESSION_ID_MAX_CHARS &&
    !containsAsciiControl(value)
  );
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertOwnershipScope(
  value: AioTerminalOwnershipScope | undefined,
): asserts value is AioTerminalOwnershipScope {
  if (!isCompleteAioTerminalOwnershipScope(value)) {
    throw new Error('AIO terminal ownership scope was invalid');
  }
}

function normalizeOwnershipPair(
  value: AioTerminalOwnershipPair,
): AioTerminalOwnershipPair {
  if (!isRecord(value)) {
    throw new Error('AIO terminal ownership pair was invalid');
  }
  assertReconnectProviderSessionId(value.mainSessionId);
  assertReconnectProviderSessionId(value.injectorSessionId);
  if (
    value.mainSessionId.slice(0, 8) ===
    value.injectorSessionId.slice(0, 8)
  ) {
    throw new Error('AIO terminal ownership pair was invalid');
  }
  const main = normalizeGuestProcessFingerprint(value.main);
  const injector = normalizeGuestProcessFingerprint(value.injector);
  if (main.tty === injector.tty || main.sid === injector.sid) {
    throw new Error('AIO terminal ownership pair was invalid');
  }
  if (
    !SAFE_CLOSE_TOKEN_PATTERN.test(value.closeToken) ||
    !SAFE_PROTOCOL_MARKER_PATTERN.test(value.releaseMarker) ||
    closeProtocolNonce(value.closeToken) !==
      closeProtocolNonce(value.releaseMarker)
  ) {
    throw new Error('AIO terminal ownership pair was invalid');
  }
  return Object.freeze({
    mainSessionId: value.mainSessionId,
    injectorSessionId: value.injectorSessionId,
    main,
    injector,
    closeToken: value.closeToken,
    releaseMarker: value.releaseMarker,
  });
}

function normalizeGuestProcessFingerprint(
  value: AioTerminalGuestProcessFingerprint,
): AioTerminalGuestProcessFingerprint {
  if (!isRecord(value)) {
    throw new Error('AIO terminal guest fingerprint was invalid');
  }
  assertGuestTty(value.tty);
  for (const field of [value.pid, value.sid, value.pgid, value.startTime]) {
    if (!SAFE_POSITIVE_INTEGER_PATTERN.test(field)) {
      throw new Error('AIO terminal guest fingerprint was invalid');
    }
  }
  if (
    value.pid !== value.sid ||
    value.sid !== value.pgid ||
    !SAFE_BOOT_ID_PATTERN.test(value.bootId)
  ) {
    throw new Error('AIO terminal guest fingerprint was invalid');
  }
  return Object.freeze({
    tty: value.tty,
    pid: value.pid,
    sid: value.sid,
    pgid: value.pgid,
    startTime: value.startTime,
    bootId: value.bootId,
  });
}

function serializeOwnershipPair(pair: AioTerminalOwnershipPair): string {
  const normalized = normalizeOwnershipPair(pair);
  return JSON.stringify(normalized);
}

function deserializeOwnershipPair(payload: string): AioTerminalOwnershipPair {
  if (
    typeof payload !== 'string' ||
    payload.length === 0 ||
    payload.length > AIO_TERMINAL_JOURNAL_RECORD_MAX_CHARS
  ) {
    throw new Error('AIO terminal ownership pair was invalid');
  }
  const value = JSON.parse(payload) as unknown;
  const pair = normalizeOwnershipPair(
    value as AioTerminalOwnershipPair,
  );
  if (serializeOwnershipPair(pair) !== payload) {
    throw new Error('AIO terminal ownership pair was invalid');
  }
  return pair;
}

function closeProtocolNonce(value: string): string {
  return value.slice(value.lastIndexOf('_') + 1);
}

function assertGuestTty(value: string): void {
  if (!SAFE_TTY_PATTERN.test(value)) {
    throw new Error('AIO terminal guest TTY was invalid');
  }
}

function assertProtocolMarker(value: string): void {
  if (!SAFE_PROTOCOL_MARKER_PATTERN.test(value)) {
    throw new Error('AIO terminal protocol marker was invalid');
  }
}

function exactTaskSessionName(taskId: string): string {
  const sessionName = `task${taskId}`;
  if (!SAFE_TMUX_NAME_PATTERN.test(sessionName)) {
    throw new Error('AIO terminal task identity was invalid');
  }
  return sessionName;
}

function ownershipSubshellCommand(command: string): string {
  return `sh -lc ${shellQuote(command)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeProcessFingerprint(value: string): string {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error('AIO terminal process fingerprint was invalid');
  }
  return value;
}

function normalizeIv(value: Uint8Array | undefined): Buffer {
  const iv = value === undefined ? randomBytes(AES_GCM_IV_BYTES) : Buffer.from(value);
  if (iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new Error('AIO terminal ownership IV was invalid');
  }
  return iv;
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('AIO terminal base URL was invalid');
  }
  const normalized = value.replace(/\/+$/u, '');
  if (normalized.length === 0) {
    throw new Error('AIO terminal base URL was invalid');
  }
  return normalized;
}

function normalizeRequestTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return AIO_TERMINAL_REQUEST_TIMEOUT_DEFAULT_MS;
  }
  return Math.min(Math.floor(value), AIO_TERMINAL_REQUEST_TIMEOUT_MAX_MS);
}

function normalizeExactReleaseTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return AIO_TERMINAL_EXACT_RELEASE_TIMEOUT_DEFAULT_MS;
  }
  return Math.min(
    Math.max(1, Math.floor(value)),
    AIO_TERMINAL_EXACT_RELEASE_TIMEOUT_MAX_MS,
  );
}

function normalizeReconnectOutputLimit(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return AIO_TERMINAL_RECONNECT_OUTPUT_MAX_BYTES;
  }
  return Math.min(value, AIO_TERMINAL_RECONNECT_OUTPUT_MAX_BYTES);
}

function assertOptionalListCount(value: unknown, expected: number): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw new InvalidAioTerminalJournalError();
  }
}

function isConfirmedMissingPath(
  _response: { readonly status: number },
  body: unknown,
): boolean {
  return Boolean(
    isRecord(body) &&
      body.success === false &&
      (body.data === null || body.data === undefined) &&
      typeof body.message === 'string' &&
      /(?:not found|does not exist|no such file)/iu.test(body.message),
  );
}

function canonicalFields(fields: readonly string[]): string {
  return fields
    .map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`)
    .join('|');
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function mutableSweepCounts(): {
  inspectedRecords: number;
  unrelatedRecords: number;
  peerRecords: number;
  staleRecords: number;
  confirmedIdentities: number;
  deletedIdentities: number;
  alreadyAbsentIdentities: number;
  removedRecords: number;
} {
  return {
    inspectedRecords: 0,
    unrelatedRecords: 0,
    peerRecords: 0,
    staleRecords: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    removedRecords: 0,
  };
}

function confirmedSweep(
  counts: ReturnType<typeof mutableSweepCounts>,
): AioStaleTerminalSessionSweepSettlement {
  return Object.freeze({ ...counts, kind: 'confirmed' as const, cause: null });
}

function indeterminateSweep(
  counts: ReturnType<typeof mutableSweepCounts>,
  cause: Extract<
    AioStaleTerminalSessionSweepSettlement,
    { readonly kind: 'indeterminate' }
  >['cause'],
): AioStaleTerminalSessionSweepSettlement {
  return Object.freeze({ ...counts, kind: 'indeterminate' as const, cause });
}

function runWithDeadline<T>(
  timeoutMs: number,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (continuation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      continuation();
    };
    const timer = setTimeout(() => {
      controller.abort();
      settle(() => reject(new Error('AIO terminal ownership request timed out')));
    }, timeoutMs);
    void action(controller.signal).then(
      (value) => settle(() => resolve(value)),
      () =>
        settle(() =>
          reject(new Error('AIO terminal ownership request was not confirmed')),
        ),
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

class InvalidAioTerminalJournalError extends Error {
  constructor() {
    super('AIO terminal ownership journal was invalid');
  }
}
