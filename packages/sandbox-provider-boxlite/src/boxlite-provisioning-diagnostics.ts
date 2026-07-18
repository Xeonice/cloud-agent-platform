import type {
  SandboxProvisioningDiagnosticAnomaly,
  SandboxProvisioningDiagnosticCause,
  SandboxProvisioningDiagnosticChannel,
  SandboxProvisioningDiagnosticCommandKind,
  SandboxProvisioningDiagnosticHttpStatusClass,
  SandboxProvisioningDiagnosticNativeState,
  SandboxProvisioningDiagnosticObserver,
  SandboxProvisioningDiagnosticOperation,
  SandboxProvisioningDiagnosticStage,
  SandboxProvisioningDiagnosticTerminalOutcome,
} from '@cap/sandbox-core';
import {
  validateSandboxProvisioningDiagnosticFact,
  type SandboxProvisioningDiagnosticFact,
  type SandboxProvisioningDiagnosticTerminalFact,
} from '@cap/sandbox-core';

export interface BoxLiteProvisioningDiagnosticOperationDescriptor {
  /** Closed adapter-local replay identity; never copied into a fact. */
  readonly key?: BoxLiteProvisioningDiagnosticOperationKey;
  /** Attempt-local resource lineage; retained only as an in-memory map key. */
  readonly scope?: string;
  readonly stage: SandboxProvisioningDiagnosticStage;
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly channel: SandboxProvisioningDiagnosticChannel;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
}

export type BoxLiteProvisioningDiagnosticOperationKey =
  | 'sandbox.create'
  | 'sandbox.start'
  | 'sandbox.inspect.existing'
  | 'sandbox.inspect.conflict'
  | 'workspace.materialize'
  | 'runtime.preflight'
  | 'runtime.setup';

export interface BoxLiteProvisioningDiagnosticTerminal {
  readonly outcome: SandboxProvisioningDiagnosticTerminalOutcome;
  readonly cause: SandboxProvisioningDiagnosticCause | null;
  readonly retryable: boolean;
  readonly httpStatusClass?: SandboxProvisioningDiagnosticHttpStatusClass | null;
  readonly nativeState?: SandboxProvisioningDiagnosticNativeState | null;
  readonly anomaly?: SandboxProvisioningDiagnosticAnomaly | null;
  readonly exitCode?: number | null;
  readonly timeoutMs?: number | null;
}

export interface BoxLiteProvisioningDiagnosticFailureDefaults
  extends Partial<
    Pick<
      BoxLiteProvisioningDiagnosticTerminal,
      | 'outcome'
      | 'cause'
      | 'retryable'
      | 'nativeState'
      | 'anomaly'
      | 'exitCode'
      | 'timeoutMs'
    >
  > {
  readonly signal?: AbortSignal;
}

export interface BoxLiteProvisioningDiagnosticLifecycle {
  readonly operationId: string | null;
  succeed(
    facts?: Omit<
      Partial<BoxLiteProvisioningDiagnosticTerminal>,
      'outcome' | 'cause' | 'retryable'
    >,
  ): void;
  settle(facts: BoxLiteProvisioningDiagnosticTerminal): void;
  fail(
    error: unknown,
    defaults?: BoxLiteProvisioningDiagnosticFailureDefaults,
  ): void;
  failHttp(
    status: number,
    defaults?: BoxLiteProvisioningDiagnosticFailureDefaults,
  ): void;
}

export type BoxLiteNativeExecutionDiagnosticPhase =
  | 'environment_probe'
  | 'readiness'
  | 'workspace'
  | 'runtime_setup';

export interface BoxLiteNativeExecutionDiagnosticSession {
  /**
   * Observer passed only to provider-native command execution. Non-native
   * operation facts pass through; native execution lifecycles are summarized
   * once per phase and channel.
   */
  readonly diagnostics: SandboxProvisioningDiagnosticObserver | undefined;
  /** Close the semantic phase and flush only complete start/terminal pairs. */
  finish(): void;
}

interface BoxLiteBufferedNativeLifecycle {
  readonly started: Extract<
    SandboxProvisioningDiagnosticFact,
    { readonly outcome: 'started' }
  >;
  terminal?: SandboxProvisioningDiagnosticTerminalFact;
}

interface BoxLiteNativeDiagnosticAggregate {
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly channel: SandboxProvisioningDiagnosticChannel;
  readonly lifecycles: BoxLiteBufferedNativeLifecycle[];
  flushed: boolean;
}

const BOXLITE_NATIVE_DIAGNOSTIC_OPERATIONS = new Set<
  SandboxProvisioningDiagnosticOperation
>([
  'native_exec_start',
  'native_exec_poll',
  'native_exec_attach',
  'native_exec_settlement',
]);

/**
 * Fold command-level native traces into a phase-level safe causal envelope.
 *
 * A real provisioning phase can execute many shell commands. Persisting four
 * lifecycle pairs per command would exhaust the attempt ledger before runtime
 * or cleanup evidence is available. This session retains every command result
 * only in memory, selects the strongest terminal fact per native operation,
 * and emits one complete pair per phase/channel. A later failure therefore
 * replaces an earlier representative success instead of being sampled away.
 */
export function startBoxLiteNativeExecutionDiagnosticSession(
  diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
  _phase: BoxLiteNativeExecutionDiagnosticPhase,
): BoxLiteNativeExecutionDiagnosticSession {
  if (diagnostics === undefined) return NOOP_NATIVE_SESSION;

  const lifecycles = new Map<string, BoxLiteBufferedNativeLifecycle>();
  const aggregates = new Map<string, BoxLiteNativeDiagnosticAggregate>();
  const startedAt = Date.now();
  let finished = false;

  const observer: SandboxProvisioningDiagnosticObserver = Object.freeze({
    mode: diagnostics.mode,
    createOperationId() {
      // The command-local identity is still CAP-generated. It is never emitted
      // or retained after this semantic phase is summarized.
      return diagnostics.createOperationId();
    },
    async emit(value: SandboxProvisioningDiagnosticFact): Promise<void> {
      const fact = validateSandboxProvisioningDiagnosticFact(value);
      if (!BOXLITE_NATIVE_DIAGNOSTIC_OPERATIONS.has(fact.operation)) {
        await diagnostics.emit(fact);
        return;
      }

      if (fact.outcome === 'started') {
        if (lifecycles.has(fact.operationId)) {
          throw new Error('BoxLite native diagnostic lifecycle is invalid');
        }
        const lifecycle: BoxLiteBufferedNativeLifecycle = { started: fact };
        lifecycles.set(fact.operationId, lifecycle);
        nativeAggregateFor(aggregates, fact).lifecycles.push(lifecycle);
        return;
      }

      const lifecycle = lifecycles.get(fact.operationId);
      if (
        lifecycle === undefined ||
        lifecycle.terminal !== undefined ||
        !sameNativeDiagnosticShape(lifecycle.started, fact)
      ) {
        throw new Error('BoxLite native diagnostic lifecycle is invalid');
      }
      lifecycle.terminal = fact;
      if (finished) flushCompletedNativeDiagnosticAggregates();
    },
    async flush() {
      await diagnostics.flush();
    },
  });

  const flushCompletedNativeDiagnosticAggregates = (): void => {
    for (const aggregate of aggregates.values()) {
      if (
        aggregate.flushed ||
        aggregate.lifecycles.length === 0 ||
        aggregate.lifecycles.some((lifecycle) => lifecycle.terminal === undefined)
      ) {
        continue;
      }
      aggregate.flushed = true;
      const selected = selectNativeAggregateTerminal(aggregate.lifecycles);
      if (selected === undefined) continue;
      let operationId: string;
      try {
        operationId = diagnostics.createOperationId();
      } catch {
        continue;
      }
      const commandKind = nativeAggregateCommandKind(
        aggregate.lifecycles,
        selected,
      );
      const descriptor = {
        operationId,
        stage: selected.started.stage,
        operation: aggregate.operation,
        channel: aggregate.channel,
        ...(commandKind === undefined ? {} : { commandKind }),
      } as const;
      emitBoxLiteProvisioningDiagnostic(diagnostics, {
        ...descriptor,
        outcome: 'started',
      });
      const {
        operationId: _operationId,
        stage: _stage,
        operation: _operation,
        channel: _channel,
        commandKind: _commandKind,
        durationMs: _durationMs,
        ...terminal
      } = selected.terminal;
      void _operationId;
      void _stage;
      void _operation;
      void _channel;
      void _commandKind;
      void _durationMs;
      emitBoxLiteProvisioningDiagnostic(diagnostics, {
        ...descriptor,
        durationMs: elapsedMilliseconds(startedAt),
        ...terminal,
      });
    }
  };

  return Object.freeze({
    diagnostics: observer,
    finish() {
      if (finished) return;
      finished = true;
      flushCompletedNativeDiagnosticAggregates();
    },
  });
}

function nativeAggregateFor(
  aggregates: Map<string, BoxLiteNativeDiagnosticAggregate>,
  fact: Extract<SandboxProvisioningDiagnosticFact, { readonly outcome: 'started' }>,
): BoxLiteNativeDiagnosticAggregate {
  const key = `${fact.channel}\0${fact.operation}`;
  const retained = aggregates.get(key);
  if (retained !== undefined) return retained;
  const aggregate: BoxLiteNativeDiagnosticAggregate = {
    operation: fact.operation,
    channel: fact.channel,
    lifecycles: [],
    flushed: false,
  };
  aggregates.set(key, aggregate);
  return aggregate;
}

function sameNativeDiagnosticShape(
  started: Extract<SandboxProvisioningDiagnosticFact, { readonly outcome: 'started' }>,
  terminal: SandboxProvisioningDiagnosticTerminalFact,
): boolean {
  return (
    started.stage === terminal.stage &&
    started.operation === terminal.operation &&
    started.channel === terminal.channel &&
    (started.commandKind ?? null) === (terminal.commandKind ?? null)
  );
}

function selectNativeAggregateTerminal(
  lifecycles: readonly BoxLiteBufferedNativeLifecycle[],
):
  | {
      readonly started: BoxLiteBufferedNativeLifecycle['started'];
      readonly terminal: SandboxProvisioningDiagnosticTerminalFact;
    }
  | undefined {
  let selected:
    | {
        readonly started: BoxLiteBufferedNativeLifecycle['started'];
        readonly terminal: SandboxProvisioningDiagnosticTerminalFact;
      }
    | undefined;
  for (const lifecycle of lifecycles) {
    if (lifecycle.terminal === undefined) return undefined;
    if (
      selected === undefined ||
      nativeTerminalPriority(lifecycle.terminal.outcome) >
        nativeTerminalPriority(selected.terminal.outcome)
    ) {
      selected = { started: lifecycle.started, terminal: lifecycle.terminal };
    }
  }
  return selected;
}

function nativeTerminalPriority(
  outcome: SandboxProvisioningDiagnosticTerminalOutcome,
): number {
  switch (outcome) {
    case 'succeeded':
      return 0;
    case 'degraded':
      return 1;
    case 'failed':
      return 2;
    case 'timed_out':
      return 3;
    case 'cancelled':
      return 4;
    case 'indeterminate':
      return 5;
  }
}

function nativeAggregateCommandKind(
  lifecycles: readonly BoxLiteBufferedNativeLifecycle[],
  selected: {
    readonly started: BoxLiteBufferedNativeLifecycle['started'];
    readonly terminal: SandboxProvisioningDiagnosticTerminalFact;
  },
): SandboxProvisioningDiagnosticCommandKind | undefined {
  if (selected.terminal.outcome !== 'succeeded') {
    return selected.started.commandKind ?? undefined;
  }
  const kinds = new Set(
    lifecycles.map((lifecycle) => lifecycle.started.commandKind ?? null),
  );
  return kinds.size === 1 ? selected.started.commandKind ?? undefined : undefined;
}

/**
 * Observe one BoxLite boundary without retaining any native request, response,
 * identifier, command, output, or exception. Diagnostic writes are evidence and
 * can never replace the provider operation's controlled result.
 */
export function startBoxLiteProvisioningDiagnostic(
  diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
  descriptor: BoxLiteProvisioningDiagnosticOperationDescriptor,
): BoxLiteProvisioningDiagnosticLifecycle {
  if (diagnostics === undefined) return NOOP_LIFECYCLE;

  let operationId: string;
  try {
    operationId =
      descriptor.channel === 'cleanup' || descriptor.key === undefined
        ? diagnostics.createOperationId()
        : boxLiteDiagnosticOperationId(
            diagnostics,
            descriptor.scope ?? 'default',
            descriptor.key,
          );
    const { key: _key, scope: _scope, ...factDescriptor } = descriptor;
    void _key;
    void _scope;
    emitBoxLiteProvisioningDiagnostic(diagnostics, {
      operationId,
      ...factDescriptor,
      outcome: 'started',
    });
  } catch {
    return NOOP_LIFECYCLE;
  }

  const startedAt = Date.now();
  const { key: _key, scope: _scope, ...factDescriptor } = descriptor;
  void _key;
  void _scope;
  let settled = false;
  const settle = (facts: BoxLiteProvisioningDiagnosticTerminal): void => {
    if (settled) return;
    settled = true;
    emitBoxLiteProvisioningDiagnostic(diagnostics, {
      operationId,
      ...factDescriptor,
      ...(descriptor.key === undefined
        ? { durationMs: elapsedMilliseconds(startedAt) }
        : {}),
      ...facts,
    });
  };

  const lifecycle: BoxLiteProvisioningDiagnosticLifecycle = {
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
    fail(error, defaults = {}) {
      settle(classifyBoxLiteProvisioningDiagnosticFailure(error, defaults));
    },
    failHttp(status, defaults = {}) {
      settle(
        classifyBoxLiteProvisioningDiagnosticHttpFailure(status, defaults),
      );
    },
  };
  return Object.freeze(lifecycle);
}

const operationIdsByObserver = new WeakMap<
  SandboxProvisioningDiagnosticObserver,
  Map<string, string>
>();

function boxLiteDiagnosticOperationId(
  diagnostics: SandboxProvisioningDiagnosticObserver,
  scope: string,
  key: BoxLiteProvisioningDiagnosticOperationKey,
): string {
  let operationIds = operationIdsByObserver.get(diagnostics);
  if (operationIds === undefined) {
    operationIds = new Map<string, string>();
    operationIdsByObserver.set(diagnostics, operationIds);
  }
  const scopedKey = `${scope}\0${key}`;
  const retained = operationIds.get(scopedKey);
  if (retained !== undefined) return retained;
  const created = diagnostics.createOperationId();
  operationIds.set(scopedKey, created);
  return created;
}

export function classifyBoxLiteProvisioningDiagnosticFailure(
  error: unknown,
  defaults: BoxLiteProvisioningDiagnosticFailureDefaults = {},
): BoxLiteProvisioningDiagnosticTerminal {
  if (defaults.signal?.aborted === true || isCancellationFailure(error)) {
    return withOptionalSafeFacts(
      {
        outcome: 'cancelled',
        cause: 'cancelled',
        retryable: false,
      },
      defaults,
    );
  }
  if (isTimeoutFailure(error)) {
    return withOptionalSafeFacts(
      {
        outcome: 'timed_out',
        cause: defaults.cause ?? 'provider_unavailable',
        retryable: defaults.retryable ?? true,
      },
      defaults,
    );
  }
  return withOptionalSafeFacts(
    {
      outcome: defaults.outcome ?? 'failed',
      cause: defaults.cause ?? 'transport_failed',
      retryable: defaults.retryable ?? true,
    },
    defaults,
  );
}

export function classifyBoxLiteProvisioningDiagnosticHttpFailure(
  status: number,
  defaults: BoxLiteProvisioningDiagnosticFailureDefaults = {},
): BoxLiteProvisioningDiagnosticTerminal {
  const httpStatusClass = boxLiteHttpStatusClass(status);
  if (status === 401) {
    return withOptionalSafeFacts(
      {
        outcome: 'failed',
        cause: 'authentication_failed',
        retryable: false,
        ...(httpStatusClass === undefined ? {} : { httpStatusClass }),
      },
      defaults,
    );
  }
  if (status === 403) {
    return withOptionalSafeFacts(
      {
        outcome: 'failed',
        cause: 'access_denied',
        retryable: false,
        ...(httpStatusClass === undefined ? {} : { httpStatusClass }),
      },
      defaults,
    );
  }
  if (status === 408) {
    return withOptionalSafeFacts(
      {
        outcome: 'timed_out',
        cause: defaults.cause ?? 'settlement_unknown',
        retryable: defaults.retryable ?? true,
        ...(httpStatusClass === undefined ? {} : { httpStatusClass }),
      },
      defaults,
    );
  }
  if (status === 429) {
    return withOptionalSafeFacts(
      {
        outcome: 'failed',
        cause: defaults.cause ?? 'provider_unavailable',
        retryable: defaults.retryable ?? true,
        ...(httpStatusClass === undefined ? {} : { httpStatusClass }),
      },
      defaults,
    );
  }
  if (status >= 400 && status < 500) {
    return withOptionalSafeFacts(
      {
        outcome: 'failed',
        cause: defaults.cause ?? 'protocol_failed',
        retryable: defaults.retryable ?? false,
        ...(httpStatusClass === undefined ? {} : { httpStatusClass }),
      },
      defaults,
    );
  }
  return withOptionalSafeFacts(
    {
      outcome: 'failed',
      cause:
        defaults.cause ??
        (status >= 500 ? 'provider_unavailable' : 'transport_failed'),
      retryable:
        defaults.retryable ??
        (status === 408 || status === 429 || status >= 500),
      ...(httpStatusClass === undefined ? {} : { httpStatusClass }),
    },
    defaults,
  );
}

export function boxLiteHttpStatusClass(
  status: number,
): SandboxProvisioningDiagnosticHttpStatusClass | undefined {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    return undefined;
  }
  return `${Math.floor(status / 100)}xx` as SandboxProvisioningDiagnosticHttpStatusClass;
}

function withOptionalSafeFacts(
  terminal: BoxLiteProvisioningDiagnosticTerminal,
  defaults: BoxLiteProvisioningDiagnosticFailureDefaults,
): BoxLiteProvisioningDiagnosticTerminal {
  return {
    ...terminal,
    ...(defaults.nativeState === undefined
      ? {}
      : { nativeState: defaults.nativeState }),
    ...(defaults.anomaly === undefined ? {} : { anomaly: defaults.anomaly }),
    ...(defaults.exitCode === undefined ? {} : { exitCode: defaults.exitCode }),
    ...(defaults.timeoutMs === undefined
      ? {}
      : { timeoutMs: defaults.timeoutMs }),
  };
}

function emitBoxLiteProvisioningDiagnostic(
  diagnostics: SandboxProvisioningDiagnosticObserver,
  fact: Parameters<SandboxProvisioningDiagnosticObserver['emit']>[0],
): void {
  try {
    void Promise.resolve(diagnostics.emit(fact)).catch(() => undefined);
  } catch {
    // Diagnostic evidence cannot become provider execution authority.
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(Date.now() - startedAt));
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

const NOOP_LIFECYCLE: BoxLiteProvisioningDiagnosticLifecycle = Object.freeze({
  operationId: null,
  succeed() {},
  settle() {},
  fail() {},
  failHttp() {},
});

const NOOP_NATIVE_SESSION: BoxLiteNativeExecutionDiagnosticSession =
  Object.freeze({
    diagnostics: undefined,
    finish() {},
  });
