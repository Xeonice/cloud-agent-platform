import { randomUUID } from 'node:crypto';

const AIO_SHELL_SESSION_CLEANUP_ATTEMPTS = 3;
const AIO_SHELL_SESSION_CLEANUP_TIMEOUT_MS = 1_500;
const AIO_SHELL_SESSION_CLEANUP_RETRY_DELAY_MS = 25;
/**
 * Worst-case wall-clock budget of the exact three-attempt session cleanup.
 * Callers with a wider lifecycle deadline can reserve this much time before
 * starting command I/O, so the temporary control shell drains inside that
 * lifecycle instead of continuing after its caller has timed out.
 */
export const AIO_SHELL_SESSION_CLEANUP_MAX_BUDGET_MS =
  AIO_SHELL_SESSION_CLEANUP_ATTEMPTS *
    AIO_SHELL_SESSION_CLEANUP_TIMEOUT_MS +
  AIO_SHELL_SESSION_CLEANUP_RETRY_DELAY_MS *
    ((AIO_SHELL_SESSION_CLEANUP_ATTEMPTS - 1) *
      AIO_SHELL_SESSION_CLEANUP_ATTEMPTS) /
    2;
const AIO_SHELL_SETTLED_STATUSES = [
  'completed',
  'no_change_timeout',
  'hard_timeout',
  'terminated',
] as const;
const AIO_SHELL_KNOWN_STATUSES = [
  'running',
  ...AIO_SHELL_SETTLED_STATUSES,
] as const;

const AIO_SHELL_CLEANUP_FAILURE_EVIDENCE = Object.freeze({
  outcome: 'indeterminate' as const,
  cause: 'cleanup_unconfirmed' as const,
  retryable: true as const,
});

interface AioShellFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type AioShellFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<AioShellFetchResponse>;

export interface AioShellExecResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

export type AioShellSessionCleanupProof = 'deleted' | 'already-absent';

/**
 * A stricter caller may shorten the fixed cleanup deadlines, but cannot expand
 * them beyond the provider defaults. The number of attempts remains exactly
 * three so command and terminal cleanup share one retry contract.
 */
export interface AioShellSessionCleanupTiming {
  readonly attemptTimeoutMs?: number;
  readonly retryDelayMs?: number;
}

export type AioShellSessionCommandExecutor = (
  command: string,
  signal?: AbortSignal,
) => Promise<AioShellExecResponse>;

/**
 * Runs one synchronous AIO shell command and releases the REST-created shell
 * session before returning. Cleanup deliberately receives a fresh timeout:
 * the command signal may already be aborted after AIO has allocated a session.
 */
export async function executeAioShellCommand(
  fetchImpl: AioShellFetch,
  baseUrl: string,
  command: string,
  signal?: AbortSignal,
): Promise<AioShellExecResponse> {
  return executeAioShellCommandSession(
    fetchImpl,
    baseUrl,
    signal,
    (execute) => execute(command, signal),
  );
}

/**
 * Reuse one temporary REST shell for a bounded command transaction, then
 * synchronously drain its exact cleanup before resolving. The callback never
 * receives the provider session id, so callers cannot accidentally persist or
 * delete a broader identity.
 */
export async function executeAioShellCommandSession<T>(
  fetchImpl: AioShellFetch,
  baseUrl: string,
  signal: AbortSignal | undefined,
  action: (execute: AioShellSessionCommandExecutor) => Promise<T>,
): Promise<T> {
  const sessionId = randomUUID();
  let result: T | undefined;
  let actionCompleted = false;
  let executionError: unknown;
  let executionFailed = false;
  try {
    const createResponse = await fetchImpl(
      `${baseUrl}/v1/shell/sessions/create`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sessionId }),
        signal,
      },
    );
    const createBody = await createResponse.json().catch(() => undefined);
    assertAioShellSessionCreated(createResponse, createBody, sessionId);
    result = await action(async (command, commandSignal = signal) => {
      const response = await fetchImpl(`${baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sessionId, command, async_mode: false }),
        signal: commandSignal,
      });
      const body = await response.json().catch(() => undefined);
      if (response.ok) assertAioShellExecResponse(body, sessionId, command);
      return { ok: response.ok, status: response.status, body };
    });
    actionCompleted = true;
  } catch (error) {
    executionFailed = true;
    executionError = error;
  }

  let cleanupFailed = false;
  try {
    await deleteAioShellSessionExact(fetchImpl, baseUrl, sessionId);
  } catch {
    cleanupFailed = true;
  }

  if (executionFailed) {
    if (cleanupFailed) {
      attachAioShellCleanupFailureEvidence(executionError);
    }
    throw executionError;
  }
  if (cleanupFailed) {
    throw new Error(
      'AIO shell session cleanup was not confirmed',
    );
  }

  if (!actionCompleted) throw new Error('AIO shell exec did not settle');
  return result as T;
}

function assertAioShellSessionCreated(
  response: AioShellFetchResponse,
  body: unknown,
  sessionId: string,
): void {
  if (
    !response.ok ||
    !isRecord(body) ||
    body.success !== true ||
    !isRecord(body.data) ||
    body.data.session_id !== sessionId ||
    typeof body.data.working_dir !== 'string'
  ) {
    throw new Error(
      `AIO shell session creation was not confirmed (HTTP ${response.status})`,
    );
  }
}

function assertAioShellExecResponse(
  body: unknown,
  sessionId: string,
  command: string,
): void {
  if (
    !isRecord(body) ||
    body.success !== true ||
    !isRecord(body.data) ||
    body.data.session_id !== sessionId ||
    body.data.command !== command ||
    !isAioShellKnownStatus(body.data.status)
  ) {
    throw new Error('AIO shell exec returned an invalid protocol response');
  }
  if (!isAioShellSettledStatus(body.data.status)) {
    throw new Error('AIO shell exec returned an incomplete protocol response');
  }
  if (
    body.data.status === 'completed' &&
    (!Number.isSafeInteger(body.data.exit_code) ||
      (body.data.exit_code as number) < 0)
  ) {
    throw new Error('AIO shell exec returned an incomplete protocol response');
  }
}

export async function deleteAioShellSessionExact(
  fetchImpl: AioShellFetch,
  baseUrl: string,
  sessionId: string,
  timing: AioShellSessionCleanupTiming = {},
): Promise<AioShellSessionCleanupProof> {
  const attemptTimeoutMs = normalizeAioShellCleanupAttemptTimeout(
    timing.attemptTimeoutMs,
  );
  const retryDelayMs = normalizeAioShellCleanupRetryDelay(
    timing.retryDelayMs,
  );
  for (let attempt = 1; attempt <= AIO_SHELL_SESSION_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      return await deleteAioShellSessionOnce(
        fetchImpl,
        baseUrl,
        sessionId,
        attemptTimeoutMs,
      );
    } catch {
      if (attempt < AIO_SHELL_SESSION_CLEANUP_ATTEMPTS) {
        await delayAioShellCleanupRetry(attempt, retryDelayMs);
      }
    }
  }
  throw new Error('AIO shell session cleanup was not confirmed');
}

async function deleteAioShellSessionOnce(
  fetchImpl: AioShellFetch,
  baseUrl: string,
  sessionId: string,
  attemptTimeoutMs: number,
): Promise<AioShellSessionCleanupProof> {
  return runAioShellCleanupWithDeadline(attemptTimeoutMs, async (signal) => {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
    const response = await fetchImpl(
      `${normalizedBaseUrl}/v1/shell/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'DELETE',
        signal,
      },
    );
    const body = await response.json().catch(() => undefined);
    if (
      !response.ok ||
      !isRecord(body) ||
      !isRecord(body.data) ||
      body.data.session_id !== sessionId
    ) {
      throw new Error(
        `AIO shell session cleanup was not confirmed (HTTP ${response.status})`,
      );
    }
    if (body.success === true) return 'deleted';
    if (
      body.success === false &&
      body.message === `Session ${sessionId} not found`
    ) {
      return 'already-absent';
    }
    throw new Error(
      `AIO shell session cleanup was not confirmed (HTTP ${response.status})`,
    );
  });
}

function isAioShellKnownStatus(
  value: unknown,
): value is (typeof AIO_SHELL_KNOWN_STATUSES)[number] {
  return (
    typeof value === 'string' &&
    (AIO_SHELL_KNOWN_STATUSES as readonly string[]).includes(value)
  );
}

function isAioShellSettledStatus(
  value: (typeof AIO_SHELL_KNOWN_STATUSES)[number],
): value is (typeof AIO_SHELL_SETTLED_STATUSES)[number] {
  return (AIO_SHELL_SETTLED_STATUSES as readonly string[]).includes(value);
}

function delayAioShellCleanupRetry(
  failedAttempt: number,
  retryDelayMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(
      resolve,
      retryDelayMs * failedAttempt,
    );
  });
}

function runAioShellCleanupWithDeadline<T>(
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
      settle(() => reject(new Error('AIO shell session cleanup timed out')));
    }, timeoutMs);

    void action(controller.signal).then(
      (value) => settle(() => resolve(value)),
      () =>
        settle(() =>
          reject(new Error('AIO shell session cleanup was not confirmed')),
        ),
    );
  });
}

function normalizeAioShellCleanupAttemptTimeout(
  value: number | undefined,
): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return AIO_SHELL_SESSION_CLEANUP_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(1, Math.floor(value)),
    AIO_SHELL_SESSION_CLEANUP_TIMEOUT_MS,
  );
}

function normalizeAioShellCleanupRetryDelay(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) {
    return AIO_SHELL_SESSION_CLEANUP_RETRY_DELAY_MS;
  }
  return Math.min(
    Math.floor(value),
    AIO_SHELL_SESSION_CLEANUP_RETRY_DELAY_MS,
  );
}

/**
 * Preserve the exact operation failure as the thrown primary. The bounded,
 * secret-free cleanup fact is attached non-enumerably when the primary is an
 * extensible object; raw cleanup errors, endpoints, ids, commands and bodies are
 * deliberately never retained.
 */
function attachAioShellCleanupFailureEvidence(primary: unknown): void {
  if (
    (typeof primary !== 'object' || primary === null) &&
    typeof primary !== 'function'
  ) {
    return;
  }
  try {
    if (!Object.prototype.hasOwnProperty.call(primary, 'aioShellCleanup')) {
      Object.defineProperty(primary, 'aioShellCleanup', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: AIO_SHELL_CLEANUP_FAILURE_EVIDENCE,
      });
    }
  } catch {
    // A frozen/non-extensible primary still remains authoritative and exact.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
