import type {
  SandboxProvisioningDiagnosticCause,
  SandboxProvisioningDiagnosticChannel,
  SandboxProvisioningDiagnosticCommandKind,
  SandboxProvisioningDiagnosticHttpStatusClass,
  SandboxProvisioningDiagnosticObserver,
  SandboxProvisioningDiagnosticOperation,
  SandboxProvisioningDiagnosticStage,
  SandboxProvisioningDiagnosticTerminalOutcome,
} from '@cap/sandbox-core';

export interface AioProvisioningDiagnosticOperationDescriptor {
  readonly key: string;
  readonly stage: SandboxProvisioningDiagnosticStage;
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly channel: SandboxProvisioningDiagnosticChannel;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
}

export interface AioProvisioningDiagnosticTerminal {
  readonly outcome: SandboxProvisioningDiagnosticTerminalOutcome;
  readonly cause: SandboxProvisioningDiagnosticCause | null;
  readonly retryable: boolean;
  readonly httpStatusClass?: SandboxProvisioningDiagnosticHttpStatusClass | null;
  readonly timeoutMs?: number | null;
}

export interface AioProvisioningDiagnosticFailureDefaults {
  readonly outcome?: Extract<
    SandboxProvisioningDiagnosticTerminalOutcome,
    'failed' | 'indeterminate' | 'timed_out'
  >;
  readonly cause?: SandboxProvisioningDiagnosticCause;
  readonly retryable?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AioProvisioningDiagnosticLifecycle {
  readonly operationId: string | null;
  succeed(
    facts?: Pick<AioProvisioningDiagnosticTerminal, 'httpStatusClass'>,
  ): void;
  settle(facts: AioProvisioningDiagnosticTerminal): void;
  fail(
    error: unknown,
    defaults?: AioProvisioningDiagnosticFailureDefaults,
  ): void;
}

const operationIdsByObserver = new WeakMap<
  SandboxProvisioningDiagnosticObserver,
  Map<string, string>
>();

/**
 * Bind one provider operation to a CAP-generated identity without awaiting the
 * diagnostic store. Evidence rejection or a stalled recorder must never become
 * AIO provisioning authority.
 */
export function startAioProvisioningDiagnostic(
  diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
  descriptor: AioProvisioningDiagnosticOperationDescriptor,
): AioProvisioningDiagnosticLifecycle {
  if (diagnostics === undefined) return NOOP_LIFECYCLE;

  let operationId: string;
  try {
    // Entering a cleanup boundary always means a new physical observation or
    // action. A later retry must not be collapsed into an earlier cleanup
    // attempt. Primary provisioning keys remain replay-stable within the
    // observer/attempt so re-running the same logical operation deduplicates.
    operationId =
      descriptor.channel === 'cleanup'
        ? diagnostics.createOperationId()
        : aioDiagnosticOperationId(diagnostics, descriptor.key);
    emitAioProvisioningDiagnostic(diagnostics, {
      operationId,
      stage: descriptor.stage,
      operation: descriptor.operation,
      channel: descriptor.channel,
      ...(descriptor.commandKind === undefined
        ? {}
        : { commandKind: descriptor.commandKind }),
      outcome: 'started',
    });
  } catch {
    return NOOP_LIFECYCLE;
  }

  let settled = false;
  const settle = (facts: AioProvisioningDiagnosticTerminal): void => {
    if (settled) return;
    settled = true;
    emitAioProvisioningDiagnostic(diagnostics, {
      operationId,
      stage: descriptor.stage,
      operation: descriptor.operation,
      channel: descriptor.channel,
      ...(descriptor.commandKind === undefined
        ? {}
        : { commandKind: descriptor.commandKind }),
      ...facts,
    });
  };

  const lifecycle: AioProvisioningDiagnosticLifecycle = {
    operationId,
    succeed(facts = {}) {
      settle({
        outcome: 'succeeded',
        cause: null,
        retryable: false,
        ...facts,
      });
    },
    settle,
    fail(
      error: unknown,
      defaults: AioProvisioningDiagnosticFailureDefaults = {},
    ) {
      settle(classifyAioProvisioningDiagnosticFailure(error, defaults));
    },
  };
  return Object.freeze(lifecycle);
}

export function classifyAioProvisioningDiagnosticFailure(
  error: unknown,
  defaults: AioProvisioningDiagnosticFailureDefaults = {},
): AioProvisioningDiagnosticTerminal {
  const aborted = defaults.signal?.aborted === true;
  const reason = aborted ? defaults.signal?.reason : error;
  if (isTimeoutFailure(reason)) {
    return {
      outcome: 'timed_out',
      cause: defaults.cause ?? 'provider_unavailable',
      retryable: defaults.retryable ?? true,
      ...(defaults.timeoutMs === undefined
        ? {}
        : { timeoutMs: defaults.timeoutMs }),
      ...httpStatusFact(error),
    };
  }
  if (aborted || isCancellationFailure(error)) {
    return {
      outcome: 'cancelled',
      cause: 'cancelled',
      retryable: false,
      ...httpStatusFact(error),
    };
  }

  const status = httpStatus(error);
  if (status === 401) {
    return {
      outcome: 'failed',
      cause: 'authentication_failed',
      retryable: false,
      httpStatusClass: '4xx',
    };
  }
  if (status === 403) {
    return {
      outcome: 'failed',
      cause: 'access_denied',
      retryable: false,
      httpStatusClass: '4xx',
    };
  }

  return {
    outcome: defaults.outcome ?? 'failed',
    cause:
      defaults.cause ??
      (status !== null && status >= 500
        ? 'provider_unavailable'
        : 'transport_failed'),
    retryable:
      defaults.retryable ??
      (status === null || status === 408 || status === 429 || status >= 500),
    ...(defaults.timeoutMs === undefined
      ? {}
      : { timeoutMs: defaults.timeoutMs }),
    ...httpStatusFact(error),
  };
}

export function aioHttpStatusClass(
  status: number,
): SandboxProvisioningDiagnosticHttpStatusClass | undefined {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    return undefined;
  }
  return `${Math.floor(status / 100)}xx` as SandboxProvisioningDiagnosticHttpStatusClass;
}

function aioDiagnosticOperationId(
  diagnostics: SandboxProvisioningDiagnosticObserver,
  key: string,
): string {
  let operationIds = operationIdsByObserver.get(diagnostics);
  if (operationIds === undefined) {
    operationIds = new Map<string, string>();
    operationIdsByObserver.set(diagnostics, operationIds);
  }
  const retained = operationIds.get(key);
  if (retained !== undefined) return retained;
  const created = diagnostics.createOperationId();
  operationIds.set(key, created);
  return created;
}

function emitAioProvisioningDiagnostic(
  diagnostics: SandboxProvisioningDiagnosticObserver,
  fact: Parameters<SandboxProvisioningDiagnosticObserver['emit']>[0],
): void {
  try {
    void Promise.resolve(diagnostics.emit(fact)).catch(() => undefined);
  } catch {
    // Diagnostics are evidence. The provider result remains authoritative.
  }
}

const NOOP_LIFECYCLE: AioProvisioningDiagnosticLifecycle = Object.freeze({
  operationId: null,
  succeed() {},
  settle() {},
  fail() {},
});

function httpStatusFact(
  error: unknown,
): Pick<AioProvisioningDiagnosticTerminal, 'httpStatusClass'> {
  const status = httpStatus(error);
  if (status === null) return {};
  return {
    httpStatusClass: `${Math.floor(status / 100)}xx` as SandboxProvisioningDiagnosticHttpStatusClass,
  };
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly response?: { readonly status?: unknown };
  };
  for (const value of [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
  ]) {
    if (Number.isSafeInteger(value) && (value as number) >= 100 && (value as number) <= 599) {
      return value as number;
    }
  }
  return null;
}

function isTimeoutFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return (
    candidate.name === 'TimeoutError' ||
    candidate.code === 'ETIMEDOUT' ||
    candidate.code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

function isCancellationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return (
    candidate.name === 'AbortError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 'ERR_CANCELED'
  );
}
