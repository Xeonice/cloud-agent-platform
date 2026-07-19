import {
  SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
  classifySandboxCommandExecutionRejection,
  type SandboxCommandExecutionRequest,
  type SandboxCommandExecutionResult,
  type SandboxProvisioningDiagnosticEvent,
} from '@cap/sandbox-core';

import type {
  SandboxProviderConformanceAssert,
  SandboxProviderConformanceScenario,
} from './conformance.js';

export const SANDBOX_SPLIT_COMMAND_OUTPUT_CONFORMANCE_CASES = [
  'process-first',
  'output-first',
  'late-replay',
  'valid-empty',
  'fragmented-utf8',
  'early-close',
  'output-error',
  'shared-deadline',
  'cancellation',
  'channel-mismatch',
] as const;

export type SandboxSplitCommandOutputConformanceCase =
  (typeof SANDBOX_SPLIT_COMMAND_OUTPUT_CONFORMANCE_CASES)[number];

export const SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES = Object.freeze({
  command: 'CAP_COMMAND_OUTPUT_CONFORMANCE_COMMAND_CANARY_9a31',
  stdout: 'CAP_COMMAND_OUTPUT_CONFORMANCE_STDOUT_CANARY_7f22',
  stderr: 'CAP_COMMAND_OUTPUT_CONFORMANCE_STDERR_CANARY_5b13',
  rawError: 'CAP_COMMAND_OUTPUT_CONFORMANCE_RAW_ERROR_CANARY_3c04',
  secret: 'CAP_COMMAND_OUTPUT_CONFORMANCE_SECRET_CANARY_1d95',
});

export interface SandboxCommandOutputProcessSettlement {
  readonly exitCode: number;
}

declare const sandboxCommandOutputTerminalReceiptBrand: unique symbol;

/** Opaque proof obtainable only by dequeuing a terminal protocol event. */
export interface SandboxCommandOutputTerminalReceipt {
  readonly [sandboxCommandOutputTerminalReceiptBrand]: true;
}

export type SandboxCommandOutputProtocolEvent =
  | {
      readonly kind: 'stdout' | 'stderr';
      readonly chunk: Uint8Array;
    }
  | {
      readonly kind: 'exit';
      readonly exitCode: number;
      readonly receipt: SandboxCommandOutputTerminalReceipt;
    }
  | {
      readonly kind: 'close';
      readonly receipt: SandboxCommandOutputTerminalReceipt;
    }
  | {
      readonly kind: 'error';
      readonly rawErrorCanary: string;
      readonly receipt: SandboxCommandOutputTerminalReceipt;
    };

type SandboxCommandOutputProtocolInput =
  | Extract<
      SandboxCommandOutputProtocolEvent,
      { readonly kind: 'stdout' | 'stderr' }
    >
  | {
      readonly kind: 'exit';
      readonly exitCode: number;
    }
  | {
      readonly kind: 'close';
    }
  | {
      readonly kind: 'error';
      readonly rawErrorCanary: string;
    };

/**
 * Provider test transports bind their process and output channels to these
 * gates. The shared harness releases terminal protocol facts in a declared
 * order, so conformance never depends on a fixed post-poll sleep.
 */
export interface SandboxCommandOutputProtocolGates {
  readonly process: {
    waitForSettlement(): Promise<SandboxCommandOutputProcessSettlement>;
    /** Acknowledge that the provider adapter consumed the terminal process fact. */
    acknowledgeConsumed(): void;
  };
  readonly output: {
    /** Wait until the harness permits the output transport handshake. */
    waitForHandshake(): Promise<void>;
    events(): AsyncIterable<SandboxCommandOutputProtocolEvent>;
    /** Acknowledge synchronous consumption of an exit, close, or error fact. */
    acknowledgeTerminalConsumed(
      receipt: SandboxCommandOutputTerminalReceipt,
    ): void;
    /** Acknowledge that the adapter's output driver has fully stopped. */
    acknowledgeDriverSettled(): void;
  };
}

/**
 * Provider-neutral monotonic deadline seam. Production adapters bind this to
 * their real clock, and every terminal-correctness/deadline timer in a
 * conformance adapter MUST use it. Conformance advances it without wall-clock
 * sleeps.
 */
export interface SandboxCommandOutputConformanceDeadlineDriver {
  now(): number;
  schedule(delayMs: number, trigger: () => void): () => void;
}

export interface SandboxCommandOutputConformanceExerciseInput {
  readonly scenario: SandboxSplitCommandOutputConformanceCase;
  readonly request: SandboxCommandExecutionRequest;
  readonly protocol: SandboxCommandOutputProtocolGates;
  readonly deadlineDriver: SandboxCommandOutputConformanceDeadlineDriver;
}

export type SandboxCommandOutputConformanceObservation =
  | {
      readonly kind: 'resolved';
      readonly result: SandboxCommandExecutionResult;
      readonly executionCount: number;
      readonly diagnostics: readonly SandboxProvisioningDiagnosticEvent[];
    }
  | {
      readonly kind: 'rejected';
      readonly rejection: unknown;
      readonly executionCount: number;
      readonly diagnostics: readonly SandboxProvisioningDiagnosticEvent[];
    };

export interface SandboxCommandOutputConformanceOptions {
  readonly exercise: (
    input: SandboxCommandOutputConformanceExerciseInput,
  ) => Promise<SandboxCommandOutputConformanceObservation>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface ProtocolController {
  readonly gates: SandboxCommandOutputProtocolGates;
  readonly processRequested: Promise<void>;
  readonly processConsumed: Promise<void>;
  readonly outputHandshakeRequested: Promise<void>;
  readonly outputAttached: Promise<void>;
  readonly outputTerminalConsumed: Promise<void>;
  readonly outputDriverSettled: Promise<void>;
  readonly deadlineDriver: SandboxCommandOutputConformanceDeadlineDriver;
  releaseOutputHandshake(): void;
  settleProcess(exitCode: number): void;
  emit(event: SandboxCommandOutputProtocolInput): void;
  closeEvents(): void;
  advanceDeadline(milliseconds: number): void;
  deadlineSchedules(): readonly SandboxCommandOutputDeadlineSchedule[];
}

interface SandboxCommandOutputDeadlineSchedule {
  readonly scheduledAt: number;
  readonly dueAt: number;
}

interface ExpectedSuccess {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

const PROCESS_FIRST_STDOUT = `${SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.stdout}:process-first`;
const OUTPUT_FIRST_STDOUT = `${SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.stdout}:output-first`;
const LATE_REPLAY_STDOUT = `${SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.stdout}:late-replay`;
const FRAGMENTED_STDOUT = `${SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.stdout}:前🙂后`;
const FRAGMENTED_STDERR = `${SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.stderr}:界`;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEADLINE_TIMEOUT_MS = 100;
const PROTOCOL_WATCHDOG_MS = 500;

export function createSandboxCommandOutputConformanceScenarios(
  options: SandboxCommandOutputConformanceOptions,
  assert: SandboxProviderConformanceAssert,
): readonly SandboxProviderConformanceScenario[] {
  return SANDBOX_SPLIT_COMMAND_OUTPUT_CONFORMANCE_CASES.map((scenario) => ({
    name: `command output settlement: ${scenario}`,
    run: () => runScenario(options, scenario, assert),
  }));
}

async function runScenario(
  options: SandboxCommandOutputConformanceOptions,
  scenario: SandboxSplitCommandOutputConformanceCase,
  assert: SandboxProviderConformanceAssert,
): Promise<void> {
  const controller = createProtocolController();
  const request = Object.freeze({
    command: `printf %s ${SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.command}`,
    cwd: '/workspace',
    timeoutMs:
      scenario === 'shared-deadline' ? DEADLINE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  }) satisfies SandboxCommandExecutionRequest;
  const cancellationController =
    scenario === 'cancellation' ? new AbortController() : null;
  const scenarioRequest: SandboxCommandExecutionRequest =
    cancellationController === null
      ? request
      : Object.freeze({ ...request, signal: cancellationController.signal });
  let observationSettled = false;
  const observationPromise = options.exercise({
    scenario,
    request: scenarioRequest,
    protocol: controller.gates,
    deadlineDriver: controller.deadlineDriver,
  });
  void observationPromise.then(
    () => {
      observationSettled = true;
    },
    () => {
      observationSettled = true;
    },
  );

  try {
    await requireProtocolReady(controller, observationPromise);
    const expected = await driveScenario(
      controller,
      scenario,
      cancellationController,
      () => observationSettled,
    );
    const observation = await withProtocolWatchdog(
      observationPromise,
      `${scenario} exercise did not settle`,
    );
    await withProtocolWatchdog(
      controller.outputDriverSettled,
      `${scenario} output driver did not settle`,
    );

    assert.equal(
      observation.executionCount,
      1,
      `${scenario} must execute the command exactly once`,
    );
    assertDiagnosticsSafeAndBounded(observation.diagnostics, scenario, assert);
    if (expected.kind === 'success') {
      assert.equal(observation.kind, 'resolved', `${scenario} must resolve`);
      const resolved = observation as Extract<
        SandboxCommandOutputConformanceObservation,
        { readonly kind: 'resolved' }
      >;
      assert.deepEqual(
        resolved.result,
        {
          exitCode: expected.result.exitCode,
          stdout: expected.result.stdout,
          stderr: expected.result.stderr,
          output: expected.result.output,
          timedOut: false,
        },
        `${scenario} must return fully settled output`,
      );
      return;
    }

    assert.equal(observation.kind, 'rejected', `${scenario} must reject`);
    const rejected = observation as Extract<
      SandboxCommandOutputConformanceObservation,
      { readonly kind: 'rejected' }
    >;
    assert.deepEqual(
      classifySandboxCommandExecutionRejection(
        rejected.rejection,
        scenarioRequest.signal,
      ),
      expected.classification,
      `${scenario} must use the safe output-settlement classification`,
    );
    assertUnsafeMaterialAbsent(rejected.rejection, scenario, assert);
  } finally {
    controller.closeEvents();
    // A transport callback arriving after terminal cleanup must stay inert.
    controller.emit({ kind: 'close' });
  }
}

async function requireProtocolReady(
  controller: ProtocolController,
  observation: Promise<SandboxCommandOutputConformanceObservation>,
): Promise<void> {
  const first = await withProtocolWatchdog(
    Promise.race([
      Promise.all([
        controller.processRequested,
        controller.outputHandshakeRequested,
      ]).then(() => 'ready' as const),
      observation.then(() => 'settled' as const),
    ]),
    'Command output conformance protocol did not become ready',
  );
  if (first !== 'ready') {
    throw new Error(
      'Command output conformance exercise settled before both protocol channels were observed',
    );
  }
}

async function driveScenario(
  controller: ProtocolController,
  scenario: SandboxSplitCommandOutputConformanceCase,
  cancellationController: AbortController | null,
  isObservationSettled: () => boolean,
): Promise<
  | { readonly kind: 'success'; readonly result: ExpectedSuccess }
  | {
      readonly kind: 'failure';
      readonly classification: ReturnType<
        typeof classifySandboxCommandExecutionRejection
      >;
    }
> {
  switch (scenario) {
    case 'process-first': {
      await openOutputChannel(controller, scenario);
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      emitText(controller, 'stdout', PROCESS_FIRST_STDOUT);
      controller.emit({ kind: 'exit', exitCode: 0 });
      await waitForTerminalConsumption(controller, scenario);
      controller.closeEvents();
      return success(0, PROCESS_FIRST_STDOUT, '');
    }
    case 'output-first': {
      await openOutputChannel(controller, scenario);
      emitText(controller, 'stdout', OUTPUT_FIRST_STDOUT);
      controller.emit({ kind: 'exit', exitCode: 0 });
      await waitForTerminalConsumption(controller, scenario);
      controller.closeEvents();
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      return success(0, OUTPUT_FIRST_STDOUT, '');
    }
    case 'late-replay': {
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      assertSharedAbsoluteDeadline(
        controller,
        scenario,
        DEFAULT_TIMEOUT_MS,
      );
      // Reach the last virtual millisecond of the original command budget.
      // Any second finite post-poll grace registered on the required timing
      // seam fires now, while the real command deadline remains pending.
      controller.advanceDeadline(DEFAULT_TIMEOUT_MS - 1);
      await nextMacrotask();
      await nextMacrotask();
      assertSharedAbsoluteDeadline(
        controller,
        scenario,
        DEFAULT_TIMEOUT_MS,
      );
      if (isObservationSettled()) {
        throw new Error(
          'late-replay exercise settled before the output terminal fact',
        );
      }
      await openOutputChannel(controller, scenario);
      emitText(controller, 'stdout', LATE_REPLAY_STDOUT);
      controller.emit({ kind: 'exit', exitCode: 0 });
      await waitForTerminalConsumption(controller, scenario);
      controller.closeEvents();
      return success(0, LATE_REPLAY_STDOUT, '');
    }
    case 'valid-empty': {
      await openOutputChannel(controller, scenario);
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      controller.emit({ kind: 'exit', exitCode: 0 });
      await waitForTerminalConsumption(controller, scenario);
      controller.closeEvents();
      return success(0, '', '');
    }
    case 'fragmented-utf8': {
      await openOutputChannel(controller, scenario);
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      emitInterleavedFragmentedUtf8(controller);
      controller.emit({ kind: 'exit', exitCode: 0 });
      await waitForTerminalConsumption(controller, scenario);
      controller.closeEvents();
      return success(0, FRAGMENTED_STDOUT, FRAGMENTED_STDERR);
    }
    case 'early-close': {
      await openOutputChannel(controller, scenario);
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      controller.emit({ kind: 'close' });
      await waitForTerminalConsumption(controller, scenario);
      controller.closeEvents();
      return failure('transport');
    }
    case 'output-error': {
      await openOutputChannel(controller, scenario);
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      controller.emit({
        kind: 'error',
        rawErrorCanary:
          SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.rawError,
      });
      await waitForTerminalConsumption(controller, scenario);
      controller.closeEvents();
      return failure('transport');
    }
    case 'shared-deadline': {
      await openOutputChannel(controller, scenario);
      assertSharedAbsoluteDeadline(
        controller,
        scenario,
        DEADLINE_TIMEOUT_MS,
      );
      controller.advanceDeadline(DEADLINE_TIMEOUT_MS * 0.75);
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      assertSharedAbsoluteDeadline(
        controller,
        scenario,
        DEADLINE_TIMEOUT_MS,
      );
      controller.advanceDeadline(DEADLINE_TIMEOUT_MS * 0.25);
      await nextMacrotask();
      await nextMacrotask();
      if (!isObservationSettled()) {
        throw new Error(
          'shared-deadline exercise did not settle at the original command deadline',
        );
      }
      assertSharedAbsoluteDeadline(
        controller,
        scenario,
        DEADLINE_TIMEOUT_MS,
      );
      return failure('timeout');
    }
    case 'cancellation': {
      await openOutputChannel(controller, scenario);
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      cancellationController?.abort(
        new Error(SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.secret),
      );
      return failure('cancellation');
    }
    case 'channel-mismatch': {
      await openOutputChannel(controller, scenario);
      controller.settleProcess(0);
      await waitForProcessConsumption(controller, scenario);
      controller.emit({ kind: 'exit', exitCode: 7 });
      await waitForTerminalConsumption(controller, scenario);
      controller.closeEvents();
      return failure('protocol');
    }
  }
}

function success(
  exitCode: number,
  stdout: string,
  stderr: string,
): { readonly kind: 'success'; readonly result: ExpectedSuccess } {
  return {
    kind: 'success',
    result: { exitCode, stdout, stderr, output: `${stdout}${stderr}` },
  };
}

function failure(
  settlement: 'transport' | 'protocol' | 'timeout' | 'cancellation',
): {
  readonly kind: 'failure';
  readonly classification: ReturnType<
    typeof classifySandboxCommandExecutionRejection
  >;
} {
  const classifications = {
    transport: {
      settlement: 'transport',
      outcome: 'failed',
      cause: 'transport_failed',
      retryable: true,
      exitCode: null,
    },
    protocol: {
      settlement: 'protocol',
      outcome: 'failed',
      cause: 'protocol_failed',
      retryable: false,
      exitCode: null,
    },
    timeout: {
      settlement: 'timeout',
      outcome: 'timed_out',
      cause: 'settlement_unknown',
      retryable: true,
      exitCode: null,
    },
    cancellation: {
      settlement: 'cancellation',
      outcome: 'cancelled',
      cause: 'cancelled',
      retryable: false,
      exitCode: null,
    },
  } as const;
  return { kind: 'failure', classification: classifications[settlement] };
}

function createProtocolController(): ProtocolController {
  const processRequested = deferred<void>();
  const processSettlement = deferred<SandboxCommandOutputProcessSettlement>();
  const processConsumed = deferred<void>();
  const outputHandshakeRequested = deferred<void>();
  const outputHandshakeReleased = deferred<void>();
  const outputAttached = deferred<void>();
  const outputTerminalConsumed = deferred<void>();
  const outputDriverSettled = deferred<void>();
  const outputEvents = new AsyncEventQueue<SandboxCommandOutputProtocolEvent>();
  const deadline = manualDeadlineDriver();
  let pendingTerminalReceipt: SandboxCommandOutputTerminalReceipt | null = null;

  return {
    gates: Object.freeze({
      process: Object.freeze({
        waitForSettlement() {
          processRequested.resolve(undefined);
          return processSettlement.promise;
        },
        acknowledgeConsumed() {
          processConsumed.resolve(undefined);
        },
      }),
      output: Object.freeze({
        async waitForHandshake() {
          outputHandshakeRequested.resolve(undefined);
          await outputHandshakeReleased.promise;
        },
        events() {
          outputAttached.resolve(undefined);
          return outputEvents;
        },
        acknowledgeTerminalConsumed(
          receipt: SandboxCommandOutputTerminalReceipt,
        ) {
          if (receipt !== pendingTerminalReceipt) return;
          pendingTerminalReceipt = null;
          outputTerminalConsumed.resolve(undefined);
        },
        acknowledgeDriverSettled() {
          outputDriverSettled.resolve(undefined);
        },
      }),
    }),
    processRequested: processRequested.promise,
    processConsumed: processConsumed.promise,
    outputHandshakeRequested: outputHandshakeRequested.promise,
    outputAttached: outputAttached.promise,
    outputTerminalConsumed: outputTerminalConsumed.promise,
    outputDriverSettled: outputDriverSettled.promise,
    deadlineDriver: deadline.driver,
    releaseOutputHandshake() {
      outputHandshakeReleased.resolve(undefined);
    },
    settleProcess(exitCode) {
      processSettlement.resolve({ exitCode });
    },
    emit(event) {
      if (event.kind === 'stdout' || event.kind === 'stderr') {
        outputEvents.push(event);
        return;
      }
      const receipt = Object.freeze(
        {},
      ) as SandboxCommandOutputTerminalReceipt;
      pendingTerminalReceipt = receipt;
      outputEvents.push(Object.freeze({ ...event, receipt }));
    },
    closeEvents() {
      outputEvents.close();
    },
    advanceDeadline(milliseconds) {
      deadline.advance(milliseconds);
    },
    deadlineSchedules() {
      return deadline.schedules();
    },
  };
}

function assertSharedAbsoluteDeadline(
  controller: ProtocolController,
  scenario: SandboxSplitCommandOutputConformanceCase,
  expectedDeadline: number,
): void {
  const schedules = controller.deadlineSchedules();
  if (
    schedules.length === 0 ||
    schedules.some((schedule) => schedule.dueAt !== expectedDeadline)
  ) {
    const dueAt = schedules.map((schedule) => schedule.dueAt).join(', ') || 'none';
    throw new Error(
      `${scenario} settlement timers must share the absolute command deadline ${expectedDeadline}; observed ${dueAt}`,
    );
  }
}

async function openOutputChannel(
  controller: ProtocolController,
  scenario: SandboxSplitCommandOutputConformanceCase,
): Promise<void> {
  controller.releaseOutputHandshake();
  await withProtocolWatchdog(
    controller.outputAttached,
    `${scenario} output transport did not consume the handshake`,
  );
}

async function waitForProcessConsumption(
  controller: ProtocolController,
  scenario: SandboxSplitCommandOutputConformanceCase,
): Promise<void> {
  await withProtocolWatchdog(
    controller.processConsumed,
    `${scenario} process terminal fact was not consumed`,
  );
}

async function waitForTerminalConsumption(
  controller: ProtocolController,
  scenario: SandboxSplitCommandOutputConformanceCase,
): Promise<void> {
  await withProtocolWatchdog(
    controller.outputTerminalConsumed,
    `${scenario} output terminal fact was not consumed`,
  );
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function withProtocolWatchdog<T>(
  operation: Promise<T>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          PROTOCOL_WATCHDOG_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function manualDeadlineDriver(): {
  readonly driver: SandboxCommandOutputConformanceDeadlineDriver;
  advance(milliseconds: number): void;
  schedules(): readonly SandboxCommandOutputDeadlineSchedule[];
} {
  let now = 0;
  const scheduled: Array<{
    readonly scheduledAt: number;
    readonly at: number;
    readonly trigger: () => void;
    cancelled: boolean;
  }> = [];
  return {
    driver: Object.freeze({
      now: () => now,
      schedule(delayMs: number, trigger: () => void) {
        const entry = {
          scheduledAt: now,
          at: now + delayMs,
          trigger,
          cancelled: false,
        };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    }),
    advance(milliseconds) {
      now += milliseconds;
      for (const entry of scheduled) {
        if (!entry.cancelled && entry.at <= now) {
          entry.cancelled = true;
          entry.trigger();
        }
      }
    },
    schedules() {
      return scheduled.map((entry) =>
        Object.freeze({
          scheduledAt: entry.scheduledAt,
          dueAt: entry.at,
        }),
      );
    },
  };
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value);
    },
  };
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.readers.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  push(value: T): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) {
      reader({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader({ value: undefined, done: true });
    }
  }
}

function emitText(
  controller: ProtocolController,
  kind: 'stdout' | 'stderr',
  value: string,
): void {
  controller.emit({ kind, chunk: new TextEncoder().encode(value) });
}

function emitInterleavedFragmentedUtf8(
  controller: ProtocolController,
): void {
  emitText(
    controller,
    'stdout',
    `${SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.stdout}:前`,
  );
  emitText(
    controller,
    'stderr',
    `${SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES.stderr}:`,
  );
  const stdoutTail = new TextEncoder().encode('🙂后');
  const stderrTail = new TextEncoder().encode('界');
  controller.emit({ kind: 'stdout', chunk: stdoutTail.subarray(0, 2) });
  controller.emit({ kind: 'stderr', chunk: stderrTail.subarray(0, 1) });
  controller.emit({ kind: 'stdout', chunk: stdoutTail.subarray(2) });
  controller.emit({ kind: 'stderr', chunk: stderrTail.subarray(1) });
}

function assertDiagnosticsSafeAndBounded(
  diagnostics: readonly SandboxProvisioningDiagnosticEvent[],
  scenario: SandboxSplitCommandOutputConformanceCase,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(
    diagnostics.length <= SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
    `${scenario} diagnostics must remain bounded`,
  );
  const serialized = JSON.stringify(diagnostics);
  for (const unsafe of Object.values(
    SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES,
  )) {
    assert.equal(
      serialized.includes(unsafe),
      false,
      `${scenario} diagnostics must not retain unsafe material`,
    );
  }
}

function assertUnsafeMaterialAbsent(
  rejection: unknown,
  scenario: SandboxSplitCommandOutputConformanceCase,
  assert: SandboxProviderConformanceAssert,
): void {
  const serialized = `${String(rejection)} ${JSON.stringify(rejection)}`;
  for (const unsafe of Object.values(
    SANDBOX_COMMAND_OUTPUT_CONFORMANCE_CANARIES,
  )) {
    assert.equal(
      serialized.includes(unsafe),
      false,
      `${scenario} rejection must not retain unsafe material`,
    );
  }
}
