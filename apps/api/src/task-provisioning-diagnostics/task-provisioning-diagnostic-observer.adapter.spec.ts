import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticEventSchema,
  type TaskProvisioningDiagnosticAttempt,
  type TaskProvisioningDiagnosticCleanupSummary,
  type TaskProvisioningDiagnosticEvent,
} from '@cap/contracts';

import {
  getTaskLogContext,
  runWithTaskProvisioningAttemptLog,
} from '../observability/log-context';
import type {
  TaskProvisioningDiagnosticAttemptContext,
  TaskProvisioningDiagnosticRecorderResult,
} from './task-provisioning-diagnostic-recorder.port';
import {
  TASK_PROVISIONING_DIAGNOSTIC_OBSERVER_RECORD_ERROR,
  TaskProvisioningDiagnosticObserverRecordError,
  createTaskProvisioningDiagnosticObserver,
  tryBeginTaskProvisioningDiagnosticObserver,
  tryResumeTaskProvisioningDiagnosticObserver,
  type BeginTaskProvisioningDiagnosticObserverInput,
  type TaskProvisioningDiagnosticObserverBeginRecorder,
  type TaskProvisioningDiagnosticPrimarySettlementInput,
  type TaskProvisioningDiagnosticObserverRecorder,
  type TaskProvisioningDiagnosticObserverResumeRecorder,
  type ResumeTaskProvisioningDiagnosticObserverInput,
} from './task-provisioning-diagnostic-observer.adapter';

const TASK_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000001';
const OPERATION_ID = '30000000-0000-4000-8000-000000000001';
const RAW_CANARY = 'token-recorder-raw-canary';
const CANONICAL_OBSERVED_AT = new Date('2026-07-18T03:04:05.678Z');
const CLEANUP_OBSERVED_AT = new Date('2026-07-18T03:05:06.789Z');

const CONTEXT: TaskProvisioningDiagnosticAttemptContext = Object.freeze({
  taskId: TASK_ID,
  attemptId: ATTEMPT_ID,
  attempt: 3,
  admissionMode: 'durable',
});

const STARTED_FACT = Object.freeze({
  operationId: OPERATION_ID,
  stage: 'provider_selection' as const,
  operation: 'provider_select' as const,
  channel: 'primary' as const,
  outcome: 'started' as const,
});

const PRIMARY_SETTLEMENT = Object.freeze({
  state: 'failed' as const,
  stage: 'runtime_setup' as const,
  operation: 'runtime_setup' as const,
  outcome: 'failed' as const,
  cause: 'command_failed' as const,
  retryable: false,
  exitCode: 9,
  commandKind: 'runtime_setup' as const,
  durationMs: 123,
  httpStatusClass: '5xx' as const,
  nativeState: 'failed' as const,
  anomaly: null,
  timeoutMs: null,
  completion: 'mark_if_complete' as const,
}) satisfies TaskProvisioningDiagnosticPrimarySettlementInput;

const PENDING_CLEANUP = Object.freeze({
  state: 'pending' as const,
  cause: 'cleanup_unconfirmed' as const,
  attemptCount: 1,
  lastAttemptOutcome: 'succeeded' as const,
  observedAt: CLEANUP_OBSERVED_AT,
}) satisfies TaskProvisioningDiagnosticCleanupSummary;

const SUCCEEDED_CLEANUP = Object.freeze({
  ...PENDING_CLEANUP,
  state: 'succeeded' as const,
  cause: null,
}) satisfies TaskProvisioningDiagnosticCleanupSummary;

const SETTLED_ATTEMPT: TaskProvisioningDiagnosticAttempt = {
  schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  id: ATTEMPT_ID,
  taskId: TASK_ID,
  attempt: 3,
  admissionMode: 'durable',
  providerFamily: 'unknown',
  state: 'failed',
  stage: 'runtime_setup',
  coverage: 'partial',
  primary: {
    outcome: 'failed',
    cause: 'command_failed',
    retryable: false,
    exitCode: 9,
    observedAt: CANONICAL_OBSERVED_AT,
  },
  cleanup: {
    state: 'not_required',
    cause: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    observedAt: null,
  },
  eventCount: 2,
  truncated: false,
  startedAt: new Date('2026-07-18T03:00:00.000Z'),
  finishedAt: CANONICAL_OBSERVED_AT,
  completenessMarkedAt: null,
};

const RECORDER_FAILURE = Object.freeze({
  ok: false as const,
  code: 'diagnostic_write_failed' as const,
  safeCause: 'diagnostic_write_failed' as const,
});

type SettlementRecorderStep =
  | 'append_started'
  | 'append_terminal'
  | 'record_primary'
  | 'record_cleanup'
  | 'mark_complete';

interface SettlementRecorderHarness {
  readonly recorder: TaskProvisioningDiagnosticObserverBeginRecorder;
  readonly trace: string[];
  readonly appended: TaskProvisioningDiagnosticEvent[];
  readonly primaryInputs: unknown[];
  readonly cleanupInputs: unknown[];
}

function settlementRecorder(options: {
  readonly failAt?: SettlementRecorderStep;
  readonly failOnceAt?: SettlementRecorderStep;
  readonly throwAt?: SettlementRecorderStep;
  readonly canonicalObservedAt?: Date;
  readonly omitCanonicalTerminal?: boolean;
} = {}): SettlementRecorderHarness {
  const trace: string[] = [];
  const appended: TaskProvisioningDiagnosticEvent[] = [];
  const primaryInputs: unknown[] = [];
  const cleanupInputs: unknown[] = [];
  let canonicalStarted: TaskProvisioningDiagnosticEvent | undefined;
  const failedOnce = new Set<SettlementRecorderStep>();
  const failOrThrow = (step: SettlementRecorderStep) => {
    if (options.throwAt === step) throw new Error(`${RAW_CANARY}:${step}`);
    if (options.failOnceAt === step && !failedOnce.has(step)) {
      failedOnce.add(step);
      return true;
    }
    return options.failAt === step;
  };

  const recorder: TaskProvisioningDiagnosticObserverBeginRecorder = {
    async beginAttempt() {
      trace.push('begin');
      return { ok: true, value: CONTEXT };
    },
    async appendEvent(_context, candidate) {
      const event = TaskProvisioningDiagnosticEventSchema.parse(candidate);
      const step =
        event.outcome === 'started'
          ? ('append_started' as const)
          : ('append_terminal' as const);
      trace.push(step);
      if (failOrThrow(step)) return RECORDER_FAILURE;

      let canonical = event;
      if (event.outcome === 'started') {
        canonicalStarted = event;
      } else if (options.omitCanonicalTerminal && canonicalStarted) {
        canonical = canonicalStarted;
      } else if (options.canonicalObservedAt) {
        canonical = TaskProvisioningDiagnosticEventSchema.parse({
          ...event,
          observedAt: options.canonicalObservedAt,
        });
      }
      appended.push(event);
      return {
        ok: true,
        value: {
          event: canonical,
          replayed: canonical !== event,
        },
      };
    },
    async recordPrimary(_context, input) {
      trace.push('record_primary');
      primaryInputs.push(input);
      if (failOrThrow('record_primary')) return RECORDER_FAILURE;
      return { ok: true, value: SETTLED_ATTEMPT };
    },
    async recordCleanup(_context, input) {
      trace.push('record_cleanup');
      cleanupInputs.push(input);
      if (failOrThrow('record_cleanup')) return RECORDER_FAILURE;
      return { ok: true, value: SETTLED_ATTEMPT };
    },
    async markComplete() {
      trace.push('mark_complete');
      if (failOrThrow('mark_complete')) return RECORDER_FAILURE;
      return { ok: true, value: SETTLED_ATTEMPT };
    },
  };

  return { recorder, trace, appended, primaryInputs, cleanupInputs };
}

function lifecycleRecorderMethods(): Pick<
  TaskProvisioningDiagnosticObserverBeginRecorder,
  'recordPrimary' | 'recordCleanup' | 'markComplete'
> {
  return {
    async recordPrimary() {
      return { ok: true, value: SETTLED_ATTEMPT };
    },
    async recordCleanup() {
      return { ok: true, value: SETTLED_ATTEMPT };
    },
    async markComplete() {
      return { ok: true, value: SETTLED_ATTEMPT };
    },
  };
}

function emitWithinAttempt(
  diagnostics: ReturnType<typeof createTaskProvisioningDiagnosticObserver>,
): Promise<void> {
  return runWithTaskProvisioningAttemptLog(CONTEXT, () =>
    diagnostics.emit(STARTED_FACT),
  );
}

function successfulAppendRecorder(options?: {
  readonly replayed?: boolean;
  readonly events?: unknown[];
  readonly logContexts?: unknown[];
}): TaskProvisioningDiagnosticObserverRecorder {
  return {
    async appendEvent(context, event) {
      assert.deepEqual(context, CONTEXT);
      options?.events?.push(event);
      options?.logContexts?.push(getTaskLogContext());
      return {
        ok: true,
        value: {
          event: TaskProvisioningDiagnosticEventSchema.parse(event),
          replayed: options?.replayed ?? false,
        },
      };
    },
  };
}

describe('task provisioning diagnostic observer adapter', () => {
  it('maps a recorded event with an initially unknown provider family', async () => {
    const events: unknown[] = [];
    const logContexts: unknown[] = [];
    const diagnostics = createTaskProvisioningDiagnosticObserver(
      CONTEXT,
      successfulAppendRecorder({ events, logContexts }),
    );

    assert.equal(diagnostics.mode, 'task');
    assert.equal(diagnostics.attemptContext.providerFamily, 'unknown');
    await emitWithinAttempt(diagnostics);
    assert.equal(events.length, 1);

    const event = TaskProvisioningDiagnosticEventSchema.parse(events[0]);
    assert.equal(event.taskId, CONTEXT.taskId);
    assert.equal(event.attemptId, CONTEXT.attemptId);
    assert.equal(event.attempt, CONTEXT.attempt);
    assert.equal(event.providerFamily, 'unknown');
    assert.equal(event.sequence, 1);
    assert.deepEqual(logContexts, [
      {
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        attempt: 3,
        stage: 'provider_selection',
        operationId: OPERATION_ID,
      },
    ]);
  });

  it('establishes attempt and operation log context for detached emissions', async () => {
    const logContexts: unknown[] = [];
    const diagnostics = createTaskProvisioningDiagnosticObserver(
      CONTEXT,
      successfulAppendRecorder({ logContexts }),
    );

    assert.equal(getTaskLogContext(), undefined);
    await new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        diagnostics.emit(STARTED_FACT).then(resolve, reject);
      });
    });

    assert.deepEqual(logContexts, [
      {
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        attempt: 3,
        stage: 'provider_selection',
        operationId: OPERATION_ID,
      },
    ]);
    assert.equal(getTaskLogContext(), undefined);
  });

  it('maps a durable replay to the emitter duplicate result', async () => {
    const events: unknown[] = [];
    const diagnostics = createTaskProvisioningDiagnosticObserver(
      CONTEXT,
      successfulAppendRecorder({ replayed: true, events }),
    );

    await emitWithinAttempt(diagnostics);
    await emitWithinAttempt(diagnostics);
    assert.equal(events.length, 1);
  });

  it('reduces recorder result failures and thrown raw values to one fixed safe error', async () => {
    const failedResult: TaskProvisioningDiagnosticRecorderResult<never> = {
      ok: false,
      code: 'diagnostic_write_failed',
      safeCause: 'diagnostic_write_failed',
    };
    const recorders: TaskProvisioningDiagnosticObserverRecorder[] = [
      { appendEvent: async () => failedResult },
      {
        appendEvent: async () => {
          throw new Error(RAW_CANARY);
        },
      },
    ];

    for (const recorder of recorders) {
      const diagnostics = createTaskProvisioningDiagnosticObserver(
        CONTEXT,
        recorder,
      );
      await assert.rejects(emitWithinAttempt(diagnostics), (error: unknown) => {
        assert.ok(error instanceof TaskProvisioningDiagnosticObserverRecordError);
        assert.equal(
          error.code,
          TASK_PROVISIONING_DIAGNOSTIC_OBSERVER_RECORD_ERROR,
        );
        assert.equal(
          error.message,
          'Task provisioning diagnostic event recording failed',
        );
        assert.equal(`${error.name}:${error.message}:${error.stack}`.includes(RAW_CANARY), false);
        return true;
      });
    }
  });

  it('begins a fenced durable attempt and returns its context plus observer', async () => {
    let receivedBegin: unknown;
    const recorder: TaskProvisioningDiagnosticObserverBeginRecorder = {
      async beginAttempt(input) {
        receivedBegin = input;
        return { ok: true, value: CONTEXT };
      },
      ...successfulAppendRecorder(),
      ...lifecycleRecorderMethods(),
    };

    const begun = await tryBeginTaskProvisioningDiagnosticObserver(recorder, {
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 3,
      activeDisposition: 'interrupt',
    });

    assert.ok(begun);
    assert.deepEqual(begun.context, CONTEXT);
    assert.equal(begun.diagnostics.attemptContext.providerFamily, 'unknown');
    assert.deepEqual(receivedBegin, {
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 3,
      providerFamily: 'unknown',
      stage: 'provider_selection',
      activeDisposition: 'interrupt',
    });
  });

  it('forwards only strict admission-proven retry evidence to the recorder', async () => {
    const received: unknown[] = [];
    const recorder: TaskProvisioningDiagnosticObserverBeginRecorder = {
      async beginAttempt(input) {
        received.push(input);
        return { ok: true, value: CONTEXT };
      },
      ...successfulAppendRecorder(),
      ...lifecycleRecorderMethods(),
    };

    const begun = await tryBeginTaskProvisioningDiagnosticObserver(recorder, {
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 3,
      activeDisposition: 'interrupt',
      retry: {
        stage: 'sandbox_creation',
        cause: 'tls_network_failed',
      },
    });

    assert.ok(begun);
    assert.deepEqual(received, [
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
        providerFamily: 'unknown',
        stage: 'provider_selection',
        activeDisposition: 'interrupt',
        retry: {
          stage: 'sandbox_creation',
          cause: 'tls_network_failed',
        },
      },
    ]);

    const invalid = {
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 3,
      retry: {
        stage: 'sandbox_creation',
        cause: 'tls_network_failed',
      },
    } as unknown as BeginTaskProvisioningDiagnosticObserverInput;
    assert.equal(
      await tryBeginTaskProvisioningDiagnosticObserver(recorder, invalid),
      undefined,
    );
    assert.equal(received.length, 1);
  });

  it('keeps legacy allocation recorder-owned and makes begin failures non-blocking', async () => {
    let legacyBegin: unknown;
    const unavailable: TaskProvisioningDiagnosticObserverBeginRecorder = {
      async beginAttempt(input) {
        legacyBegin = input;
        return {
          ok: false,
          code: 'diagnostics_unavailable',
          safeCause: 'coordination_failed',
        };
      },
      ...successfulAppendRecorder(),
      ...lifecycleRecorderMethods(),
    };
    const throwing: TaskProvisioningDiagnosticObserverBeginRecorder = {
      beginAttempt: async () => {
        throw new Error(RAW_CANARY);
      },
      ...successfulAppendRecorder(),
      ...lifecycleRecorderMethods(),
    };

    assert.equal(
      await tryBeginTaskProvisioningDiagnosticObserver(unavailable, {
        taskId: TASK_ID,
        admissionMode: 'legacy',
      }),
      undefined,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(legacyBegin, 'expectedAttempt'),
      false,
    );
    assert.equal(
      await tryBeginTaskProvisioningDiagnosticObserver(throwing, {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
      }),
      undefined,
    );
  });

  it('resumes an active attempt with its retained provider and the next event sequence', async () => {
    const events: unknown[] = [];
    let receivedResume: unknown;
    let beginCalls = 0;
    const recorder = {
      async resumeAttempt(input: unknown) {
        receivedResume = input;
        return {
          ok: true as const,
          value: {
            context: CONTEXT,
            state: 'active' as const,
            providerFamily: 'boxlite' as const,
            initialSequence: 2,
          },
        };
      },
      async beginAttempt() {
        beginCalls += 1;
        return { ok: true as const, value: CONTEXT };
      },
      ...successfulAppendRecorder({ events }),
      ...lifecycleRecorderMethods(),
    };

    const resumed = await tryResumeTaskProvisioningDiagnosticObserver(
      recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        attempt: 3,
      },
    );

    assert.ok(resumed);
    assert.equal(resumed.state, 'active');
    assert.deepEqual(resumed.context, CONTEXT);
    assert.deepEqual(receivedResume, {
      taskId: TASK_ID,
      admissionMode: 'durable',
      attempt: 3,
    });
    assert.equal(beginCalls, 0);
    assert.equal(resumed.diagnostics.attemptContext.providerFamily, 'boxlite');

    await emitWithinAttempt(resumed.diagnostics);
    const event = TaskProvisioningDiagnosticEventSchema.parse(events[0]);
    assert.equal(event.sequence, 3);
    assert.equal(event.providerFamily, 'boxlite');
    assert.throws(() => resumed.diagnostics.bindProviderFamily('aio'));
  });

  it('resumes terminal evidence without fabricating a provider family and keeps settlement orchestration-only', async () => {
    let primaryCalls = 0;
    let cleanupCalls = 0;
    let completeCalls = 0;
    const recorder: TaskProvisioningDiagnosticObserverResumeRecorder = {
      async resumeAttempt() {
        return {
          ok: true,
          value: {
            context: CONTEXT,
            state: 'failed',
            providerFamily: null,
            initialSequence: 2,
          },
        };
      },
      ...successfulAppendRecorder(),
      async recordPrimary() {
        primaryCalls += 1;
        return { ok: true, value: SETTLED_ATTEMPT };
      },
      async recordCleanup() {
        cleanupCalls += 1;
        return { ok: true, value: SETTLED_ATTEMPT };
      },
      async markComplete() {
        completeCalls += 1;
        return { ok: true, value: SETTLED_ATTEMPT };
      },
    };

    const resumed = await tryResumeTaskProvisioningDiagnosticObserver(
      recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        attempt: 3,
      },
    );

    assert.ok(resumed);
    assert.equal(resumed.state, 'failed');
    assert.equal(resumed.diagnostics.attemptContext.providerFamily, 'unknown');
    assert.equal('settlement' in resumed, true);
    assert.equal('settlement' in resumed.diagnostics, false);
    assert.equal(Object.isFrozen(resumed), true);
    assert.equal(Object.isFrozen(resumed.settlement), true);

    await resumed.settlement.settleCleanup(SUCCEEDED_CLEANUP);
    assert.equal(primaryCalls, 0);
    assert.equal(cleanupCalls, 1);
    assert.equal(completeCalls, 1);
  });

  it('keeps strict resume failures non-blocking and never falls back to begin', async () => {
    let resumeCalls = 0;
    let beginCalls = 0;
    const failureRecorder = {
      async resumeAttempt() {
        resumeCalls += 1;
        return {
          ok: false as const,
          code: 'attempt_not_found' as const,
          safeCause: 'coordination_failed' as const,
        };
      },
      async beginAttempt() {
        beginCalls += 1;
        return { ok: true as const, value: CONTEXT };
      },
      ...successfulAppendRecorder(),
      ...lifecycleRecorderMethods(),
    };

    assert.equal(
      await tryResumeTaskProvisioningDiagnosticObserver(failureRecorder, {
        taskId: TASK_ID,
        admissionMode: 'durable',
        attempt: 3,
        raw: RAW_CANARY,
      } as ResumeTaskProvisioningDiagnosticObserverInput),
      undefined,
    );
    assert.equal(resumeCalls, 0);
    assert.equal(
      await tryResumeTaskProvisioningDiagnosticObserver(failureRecorder, {
        taskId: TASK_ID,
        admissionMode: 'durable',
        attempt: 3,
      }),
      undefined,
    );

    const throwingRecorder: TaskProvisioningDiagnosticObserverResumeRecorder = {
      async resumeAttempt() {
        throw new Error(RAW_CANARY);
      },
      ...successfulAppendRecorder(),
      ...lifecycleRecorderMethods(),
    };
    assert.equal(
      await tryResumeTaskProvisioningDiagnosticObserver(throwingRecorder, {
        taskId: TASK_ID,
        admissionMode: 'durable',
        attempt: 3,
      }),
      undefined,
    );
    assert.equal(resumeCalls, 1);
    assert.equal(beginCalls, 0);
  });

  it('settles from the canonical terminal event in strict append-primary-cleanup-complete order', async () => {
    const harness = settlementRecorder({
      canonicalObservedAt: CANONICAL_OBSERVED_AT,
    });
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(
      harness.recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
      },
    );
    assert.ok(begun);

    await begun.settlement.settlePrimary(PRIMARY_SETTLEMENT);

    assert.deepEqual(harness.trace, [
      'begin',
      'append_started',
      'append_terminal',
      'record_primary',
      'record_cleanup',
      'mark_complete',
    ]);
    assert.equal(harness.appended.length, 2);
    const [started, terminal] = harness.appended;
    assert.ok(started);
    assert.ok(terminal);
    assert.equal(started.outcome, 'started');
    assert.equal(terminal.outcome, 'failed');
    assert.match(
      started.operationId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    assert.equal(terminal.operationId, started.operationId);
    assert.equal(terminal.channel, 'primary');
    assert.equal(terminal.commandKind, 'runtime_setup');
    assert.equal(terminal.durationMs, 123);
    assert.equal(terminal.httpStatusClass, '5xx');
    assert.equal(terminal.nativeState, 'failed');
    assert.equal(terminal.anomaly, null);
    assert.equal(terminal.timeoutMs, null);
    assert.deepEqual(harness.primaryInputs, [
      {
        state: 'failed',
        stage: 'runtime_setup',
        primary: {
          outcome: 'failed',
          cause: 'command_failed',
          retryable: false,
          exitCode: 9,
          observedAt: CANONICAL_OBSERVED_AT,
        },
      },
    ]);
    assert.deepEqual(harness.cleanupInputs, [
      {
        state: 'not_required',
        cause: null,
        attemptCount: 0,
        lastAttemptOutcome: null,
        observedAt: null,
      },
    ]);
    assert.equal('settlement' in begun.diagnostics, false);
    assert.equal(Object.isFrozen(begun.settlement), true);
  });

  it('reuses an existing matching provider terminal instead of appending a duplicate outer pair', async () => {
    const harness = settlementRecorder();
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(
      harness.recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
      },
    );
    assert.ok(begun);

    const common = {
      operationId: OPERATION_ID,
      stage: 'runtime_setup' as const,
      operation: 'runtime_setup' as const,
      commandKind: 'runtime_setup' as const,
      channel: 'primary' as const,
    };
    await runWithTaskProvisioningAttemptLog(CONTEXT, async () => {
      await begun.diagnostics.emit({ ...common, outcome: 'started' });
      await begun.diagnostics.emit({
        ...common,
        outcome: 'failed',
        cause: 'command_failed',
        retryable: false,
        exitCode: 9,
      });
    });
    await begun.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      completion: 'leave_partial',
    });

    assert.deepEqual(harness.trace, [
      'begin',
      'append_started',
      'append_terminal',
      'record_primary',
    ]);
    assert.equal(harness.appended.length, 2);
    const providerTerminal = harness.appended[1];
    assert.ok(providerTerminal);
    assert.deepEqual(harness.primaryInputs, [
      {
        state: 'failed',
        stage: 'runtime_setup',
        primary: {
          outcome: 'failed',
          cause: 'command_failed',
          retryable: false,
          exitCode: 9,
          observedAt: providerTerminal.observedAt,
        },
      },
    ]);
  });

  it('joins concurrent primary settlement callers onto the first selected input', async () => {
    const harness = settlementRecorder();
    let releasePrimary!: () => void;
    const primaryGate = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    let observePrimary!: () => void;
    const primaryStarted = new Promise<void>((resolve) => {
      observePrimary = resolve;
    });
    const baseRecordPrimary = harness.recorder.recordPrimary.bind(
      harness.recorder,
    );
    const recorder: TaskProvisioningDiagnosticObserverBeginRecorder = {
      ...harness.recorder,
      async recordPrimary(context, input) {
        observePrimary();
        await primaryGate;
        return baseRecordPrimary(context, input);
      },
    };
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(
      recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'legacy',
      },
    );
    assert.ok(begun);

    const first = begun.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      completion: 'leave_partial',
    });
    const joined = begun.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      cause: 'unknown',
      completion: 'leave_partial',
    });
    assert.equal(joined, first);
    await primaryStarted;
    releasePrimary();
    await Promise.all([first, joined]);

    assert.deepEqual(harness.trace, [
      'begin',
      'append_started',
      'append_terminal',
      'record_primary',
    ]);
    assert.equal(harness.appended.length, 2);
    assert.equal(harness.primaryInputs.length, 1);
  });

  it('retries failed primary persistence with the selected input and retained operation pair', async () => {
    const harness = settlementRecorder({ failOnceAt: 'record_primary' });
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(
      harness.recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
      },
    );
    assert.ok(begun);

    const selected = {
      ...PRIMARY_SETTLEMENT,
      completion: 'leave_partial' as const,
    };
    await begun.settlement.settlePrimary(selected);
    await begun.settlement.settlePrimary({
      ...selected,
      cause: 'unknown',
    });

    assert.deepEqual(harness.trace, [
      'begin',
      'append_started',
      'append_terminal',
      'record_primary',
      'record_primary',
    ]);
    assert.equal(harness.appended.length, 2);
    assert.equal(harness.primaryInputs.length, 2);
    assert.deepEqual(harness.primaryInputs[1], harness.primaryInputs[0]);
  });

  it('leaves a successful primary partial when orchestration requests no completeness mark', async () => {
    const harness = settlementRecorder();
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(
      harness.recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'legacy',
      },
    );
    assert.ok(begun);

    await begun.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      completion: 'leave_partial',
    });

    assert.deepEqual(harness.trace, [
      'begin',
      'append_started',
      'append_terminal',
      'record_primary',
    ]);
    assert.equal(harness.cleanupInputs.length, 0);
  });

  it('drains provider facts accepted before the outer settlement boundary', async () => {
    const harness = settlementRecorder();
    let releaseProviderAppend!: () => void;
    const providerAppendGate = new Promise<void>((resolve) => {
      releaseProviderAppend = resolve;
    });
    let providerAppendObserved!: () => void;
    const providerAppendStarted = new Promise<void>((resolve) => {
      providerAppendObserved = resolve;
    });
    const baseAppend = harness.recorder.appendEvent.bind(harness.recorder);
    const recorder: TaskProvisioningDiagnosticObserverBeginRecorder = {
      ...harness.recorder,
      async appendEvent(context, candidate) {
        const event = TaskProvisioningDiagnosticEventSchema.parse(candidate);
        if (event.operationId === OPERATION_ID) {
          harness.trace.push('provider_append');
          providerAppendObserved();
          await providerAppendGate;
          return {
            ok: true,
            value: { event, replayed: false },
          };
        }
        return baseAppend(context, candidate);
      },
    };
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(recorder, {
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 3,
    });
    assert.ok(begun);

    const providerEmission = runWithTaskProvisioningAttemptLog(CONTEXT, () =>
      begun.diagnostics.emit(STARTED_FACT),
    );
    await providerAppendStarted;
    const settlement = begun.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      completion: 'leave_partial',
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(harness.trace, ['begin', 'provider_append']);

    releaseProviderAppend();
    await Promise.all([providerEmission, settlement]);
    assert.deepEqual(harness.trace, [
      'begin',
      'provider_append',
      'append_started',
      'append_terminal',
      'record_primary',
    ]);
  });

  it('serializes pending and terminal cleanup before one finalization', async () => {
    const harness = settlementRecorder();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let observeCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      observeCleanup = resolve;
    });
    let cleanupCalls = 0;
    const baseRecordCleanup = harness.recorder.recordCleanup.bind(
      harness.recorder,
    );
    const recorder: TaskProvisioningDiagnosticObserverBeginRecorder = {
      ...harness.recorder,
      async recordCleanup(context, input) {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          observeCleanup();
          await cleanupGate;
        }
        return baseRecordCleanup(context, input);
      },
    };
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(recorder, {
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 3,
    });
    assert.ok(begun);
    await begun.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      completion: 'leave_partial',
    });

    const pending = begun.settlement.settleCleanup(PENDING_CLEANUP);
    await cleanupStarted;
    const terminal = begun.settlement.settleCleanup(SUCCEEDED_CLEANUP);
    await Promise.resolve();
    assert.equal(cleanupCalls, 1);
    assert.equal(harness.cleanupInputs.length, 0);

    releaseCleanup();
    await Promise.all([pending, terminal]);
    assert.equal(cleanupCalls, 2);
    assert.deepEqual(harness.cleanupInputs, [
      PENDING_CLEANUP,
      SUCCEEDED_CLEANUP,
    ]);
    assert.equal(
      harness.trace.filter((step) => step === 'mark_complete').length,
      1,
    );
    assert.deepEqual(harness.trace.slice(-3), [
      'record_cleanup',
      'record_cleanup',
      'mark_complete',
    ]);
  });

  it('retries cleanup persistence and finalization from exact cleanup replay', async () => {
    const cleanupHarness = settlementRecorder({
      failOnceAt: 'record_cleanup',
    });
    const cleanupObserver = await tryBeginTaskProvisioningDiagnosticObserver(
      cleanupHarness.recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
      },
    );
    assert.ok(cleanupObserver);
    await cleanupObserver.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      completion: 'leave_partial',
    });
    await cleanupObserver.settlement.settleCleanup(SUCCEEDED_CLEANUP);
    await cleanupObserver.settlement.settleCleanup(SUCCEEDED_CLEANUP);
    assert.equal(cleanupHarness.cleanupInputs.length, 2);
    assert.equal(
      cleanupHarness.trace.filter((step) => step === 'mark_complete').length,
      1,
    );

    const finalizeHarness = settlementRecorder({
      failOnceAt: 'mark_complete',
    });
    const finalizeObserver = await tryBeginTaskProvisioningDiagnosticObserver(
      finalizeHarness.recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
      },
    );
    assert.ok(finalizeObserver);
    await finalizeObserver.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      completion: 'leave_partial',
    });
    await finalizeObserver.settlement.settleCleanup(SUCCEEDED_CLEANUP);
    await finalizeObserver.settlement.settleCleanup(SUCCEEDED_CLEANUP);
    assert.equal(finalizeHarness.cleanupInputs.length, 1);
    assert.equal(
      finalizeHarness.trace.filter((step) => step === 'mark_complete').length,
      2,
    );
  });

  it('stops after every failed or throwing recorder step and always resolves', async () => {
    const expectedTrace: Record<SettlementRecorderStep, string[]> = {
      append_started: ['begin', 'append_started'],
      append_terminal: ['begin', 'append_started', 'append_terminal'],
      record_primary: [
        'begin',
        'append_started',
        'append_terminal',
        'record_primary',
      ],
      record_cleanup: [
        'begin',
        'append_started',
        'append_terminal',
        'record_primary',
        'record_cleanup',
      ],
      mark_complete: [
        'begin',
        'append_started',
        'append_terminal',
        'record_primary',
        'record_cleanup',
        'mark_complete',
      ],
    };

    for (const mode of ['failAt', 'throwAt'] as const) {
      for (const step of Object.keys(expectedTrace) as SettlementRecorderStep[]) {
        const harness = settlementRecorder({ [mode]: step });
        const begun = await tryBeginTaskProvisioningDiagnosticObserver(
          harness.recorder,
          {
            taskId: TASK_ID,
            admissionMode: 'durable',
            expectedAttempt: 3,
          },
        );
        assert.ok(begun);
        await assert.doesNotReject(
          begun.settlement.settlePrimary(PRIMARY_SETTLEMENT),
        );
        assert.deepEqual(harness.trace, expectedTrace[step], `${mode}:${step}`);
      }
    }
  });

  it('does not fabricate primary or completeness without a canonical terminal event', async () => {
    const harness = settlementRecorder({ omitCanonicalTerminal: true });
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(
      harness.recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
      },
    );
    assert.ok(begun);

    await begun.settlement.settlePrimary(PRIMARY_SETTLEMENT);

    assert.deepEqual(harness.trace, [
      'begin',
      'append_started',
      'append_terminal',
    ]);
    assert.equal(harness.primaryInputs.length, 0);
    assert.equal(harness.cleanupInputs.length, 0);
  });

  it('rejects unknown raw bags before any settlement recorder input', async () => {
    const harness = settlementRecorder();
    const begun = await tryBeginTaskProvisioningDiagnosticObserver(
      harness.recorder,
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 3,
      },
    );
    assert.ok(begun);

    await begun.settlement.settlePrimary({
      ...PRIMARY_SETTLEMENT,
      raw: {
        error: RAW_CANARY,
        command: RAW_CANARY,
        providerResponse: RAW_CANARY,
      },
    } as TaskProvisioningDiagnosticPrimarySettlementInput);
    await begun.settlement.settleCleanup({
      ...SUCCEEDED_CLEANUP,
      raw: { error: RAW_CANARY },
    } as TaskProvisioningDiagnosticCleanupSummary);

    assert.deepEqual(harness.trace, ['begin']);
    assert.equal(
      JSON.stringify({
        appended: harness.appended,
        primary: harness.primaryInputs,
        cleanup: harness.cleanupInputs,
      }).includes(RAW_CANARY),
      false,
    );
  });
});
