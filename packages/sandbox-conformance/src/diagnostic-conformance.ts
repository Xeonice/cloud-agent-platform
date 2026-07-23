import {
  SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
  createNonPersistingSandboxProvisioningDiagnosticObserver,
  createSandboxProvisioningDiagnosticEmitter,
  validateSandboxPhysicalCleanupResult,
  type SandboxPhysicalCleanupResult,
  type SandboxProviderCapability,
  type SandboxProvisionContext,
  type SandboxProvisioningDiagnosticAttemptContext,
  type SandboxProvisioningDiagnosticEmitter,
  type SandboxProvisioningDiagnosticEvent,
  type SandboxProvisioningDiagnosticFact,
  type SandboxProvisioningDiagnosticObserver,
  type SandboxProvisioningDiagnosticOperation,
  type SandboxProvisioningDiagnosticProviderFamily,
  type SandboxProvisioningDiagnosticReplayKey,
} from '@cap/sandbox-core';

import type {
  SandboxProviderConformanceAssert,
  SandboxProviderConformanceScenario,
} from './conformance.js';

/**
 * Diagnostic conformance is deliberately opt-in while provider instrumentation
 * rolls out. Provider suites can adopt this helper without changing the
 * baseline lifecycle conformance used by providers that do not yet receive a
 * diagnostic observer.
 */
export const SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CASES = [
  'bounded-start-terminal',
  'replay-deduplication',
  'timeout',
  'cancellation',
  'indeterminate-settlement',
  'primary-plus-cleanup-failure',
  'credential-cleanup-failure',
  'taskless-probe',
  'raw-provider-secret-canary',
  'diagnostic-write-failure',
] as const;

export type SandboxProviderDiagnosticConformanceCase =
  (typeof SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CASES)[number];

/** Recognizable values that an adapter must inject only into unsafe inputs. */
export const SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CANARIES = Object.freeze({
  providerBody: 'CAP_PROVIDER_BODY_CANARY_2_4_6d11',
  providerError: 'CAP_PROVIDER_ERROR_CANARY_2_4_83a2',
  command: 'CAP_COMMAND_CANARY_2_4_0ac7',
  output: 'CAP_OUTPUT_CANARY_2_4_76ef',
  secret: 'CAP_SECRET_CANARY_2_4_f39b',
});

export interface SandboxProviderDiagnosticConformanceResult {
  /** Required by the primary/cleanup, canary, and write-failure cases. */
  readonly primary?: unknown;
  /** Required by the physical cleanup and write-failure cases. */
  readonly cleanup?: SandboxPhysicalCleanupResult;
  /** Required by the taskless probe case. */
  readonly probe?: unknown;
  /** Required when canonical workspace credentials are rejected at the boundary. */
  readonly rejection?: unknown;
  /** Provider/external-transport calls observed before the credential rejection. */
  readonly externalBoundaryCalls?: number;
}

export type SandboxProviderDiagnosticWorkspaceCredentialConformance =
  | {
      readonly kind: 'provider-local-secret';
      readonly providerCapabilities: readonly SandboxProviderCapability[];
    }
  | {
      readonly kind: 'reject-before-external-boundary';
      readonly providerCapabilities: readonly SandboxProviderCapability[];
    };

interface SandboxProviderDiagnosticConformanceExerciseInputBase {
  readonly canaries: typeof SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CANARIES;
  /** Identity sentinel used to prove diagnostics/cleanup cannot replace primary. */
  readonly primaryFailure: object;
  /** Safe secondary fault input; providers return their own normalized result. */
  readonly cleanupFailure: SandboxPhysicalCleanupResult;
  /** Identity sentinel used to prove a taskless observer cannot alter its probe. */
  readonly probeResult: object;
}

export type SandboxProviderTaskDiagnosticConformanceCase = Exclude<
  SandboxProviderDiagnosticConformanceCase,
  'taskless-probe'
>;

export interface SandboxProviderTaskDiagnosticConformanceExerciseInput
  extends SandboxProviderDiagnosticConformanceExerciseInputBase {
  readonly scenario: SandboxProviderTaskDiagnosticConformanceCase;
  /** Safe CAP task identity used directly by SandboxProvisionContext. */
  readonly taskId: string;
  /** Safe attempt correlation only; no recorder or persistence handle is exposed. */
  readonly attemptContext: SandboxProvisioningDiagnosticAttemptContext;
  readonly diagnostics: SandboxProvisioningDiagnosticEmitter;
}

export type SandboxProviderTasklessDiagnosticObserver =
  SandboxProvisioningDiagnosticObserver & {
    readonly mode: 'non-persisting';
  };

export interface SandboxProviderTasklessDiagnosticConformanceExerciseInput
  extends SandboxProviderDiagnosticConformanceExerciseInputBase {
  readonly scenario: 'taskless-probe';
  readonly diagnostics: SandboxProviderTasklessDiagnosticObserver;
  readonly taskId?: never;
  readonly attemptContext?: never;
}

/**
 * The scenario itself discriminates task provisioning from an explicitly
 * taskless probe. Task scenarios can therefore pass the supplied emitter and
 * task id straight into SandboxProvisionContext without a cast.
 */
export type SandboxProviderDiagnosticConformanceExerciseInput =
  | SandboxProviderTaskDiagnosticConformanceExerciseInput
  | SandboxProviderTasklessDiagnosticConformanceExerciseInput;

export interface SandboxProviderDiagnosticConformanceOptions {
  readonly providerFamily: SandboxProvisioningDiagnosticProviderFamily;
  /**
   * Closed credential behavior selected from the provider's real capability
   * declaration. Unsupported providers prove fail-closed rejection instead of
   * skipping the credential scenario.
   */
  readonly workspaceCredential: SandboxProviderDiagnosticWorkspaceCredentialConformance;
  /**
   * Execute the requested fault against the provider or its deterministic fake.
   * Implementations emit through `diagnostics`; they never receive a recorder.
   */
  readonly exercise: (
    input: SandboxProviderDiagnosticConformanceExerciseInput,
  ) => Promise<void | SandboxProviderDiagnosticConformanceResult>;
}

interface DiagnosticHarnessBase {
  readonly events: SandboxProvisioningDiagnosticEvent[];
  readonly attemptedFacts: SandboxProvisioningDiagnosticFact[];
  readonly diagnosticFailures: unknown[];
  readonly recordCalls: { value: number };
}

interface TaskDiagnosticHarness extends DiagnosticHarnessBase {
  readonly kind: 'task';
  readonly diagnostics: SandboxProvisioningDiagnosticEmitter;
  readonly taskId: string;
  readonly attemptId: string;
}

interface TasklessDiagnosticHarness extends DiagnosticHarnessBase {
  readonly kind: 'taskless';
  readonly diagnostics: SandboxProviderTasklessDiagnosticObserver;
}

const TASK_ID = '24000000-0000-4000-8000-000000000001';
const OBSERVED_AT_EPOCH_MS = Date.parse('2026-07-17T00:00:00.000Z');
const PRIMARY_FAILURE = Object.freeze({
  kind: 'sandbox-conformance-primary-failure',
});
const CLEANUP_FAILURE = Object.freeze({
  outcome: 'failed',
  proof: null,
  cause: 'cleanup_failed',
  retryable: true,
}) satisfies SandboxPhysicalCleanupResult;
const PROBE_RESULT = Object.freeze({
  kind: 'sandbox-conformance-taskless-probe-result',
});

/**
 * Build deterministic, runner-neutral diagnostic scenarios. Each scenario owns
 * a fresh in-memory recorder so suites may run them independently or in order.
 */
export function createSandboxProviderDiagnosticConformanceScenarios(
  options: SandboxProviderDiagnosticConformanceOptions,
  assert: SandboxProviderConformanceAssert,
): readonly SandboxProviderConformanceScenario[] {
  assertWorkspaceCredentialCapabilityContract(options.workspaceCredential);
  return SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CASES.map(
    (scenario, scenarioIndex) => ({
      name: `provider diagnostics: ${scenario}`,
      async run() {
        const commonInput = {
          canaries: SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CANARIES,
          primaryFailure: PRIMARY_FAILURE,
          cleanupFailure: CLEANUP_FAILURE,
          probeResult: PROBE_RESULT,
        } as const;
        if (scenario === 'taskless-probe') {
          const harness = createTasklessDiagnosticHarness(scenarioIndex);
          const result =
            (await options.exercise({
              ...commonInput,
              scenario,
              diagnostics: harness.diagnostics,
            })) ?? {};
          await harness.diagnostics.flush();
          assertNoCanaries(harness.events, assert);
          assertNoCanaries(harness.diagnosticFailures, assert);
          assertTasklessProbe(harness, result, assert);
          return;
        }

        const harness = createTaskDiagnosticHarness(
          scenario,
          scenarioIndex,
        );
        const exerciseInput = {
          ...commonInput,
          scenario,
          taskId: harness.taskId,
          attemptContext: harness.diagnostics.attemptContext,
          diagnostics: harness.diagnostics,
        } satisfies SandboxProviderTaskDiagnosticConformanceExerciseInput;
        const providerContext = {
          taskId: exerciseInput.taskId,
          diagnostics: exerciseInput.diagnostics,
        } satisfies Pick<SandboxProvisionContext, 'taskId' | 'diagnostics'>;
        void providerContext;
        const result = (await options.exercise(exerciseInput)) ?? {};
        await harness.diagnostics.flush();

        assert.equal(
          harness.diagnostics.attemptContext.providerFamily,
          options.providerFamily,
          'provider must bind its real diagnostic family before emitting task evidence',
        );
        assertNoCanaries(harness.events, assert);
        assertNoCanaries(harness.diagnosticFailures, assert);

        if (
          scenario === 'credential-cleanup-failure' &&
          options.workspaceCredential.kind === 'reject-before-external-boundary'
        ) {
          assertCredentialRejection(harness, result, assert);
          return;
        }

        if (scenario === 'diagnostic-write-failure') {
          assertDiagnosticWriteFailure(harness, result, assert);
          return;
        }

        assertDiagnosticEnvelope(harness, options.providerFamily, assert);
        assertScenarioOutcome(scenario, harness, result, assert);
      },
    }),
  );
}

function assertWorkspaceCredentialCapabilityContract(
  workspaceCredential: SandboxProviderDiagnosticWorkspaceCredentialConformance,
): void {
  const declaresWorkspaceCredentialPath =
    workspaceCredential.providerCapabilities.includes('workspace.git.materialize') ||
    workspaceCredential.providerCapabilities.includes('workspace.git.deliver');
  if (
    workspaceCredential.kind === 'provider-local-secret' &&
    !declaresWorkspaceCredentialPath
  ) {
    throw new Error(
      'provider-local-secret credential conformance requires workspace.git.materialize or workspace.git.deliver',
    );
  }
  if (
    workspaceCredential.kind === 'reject-before-external-boundary' &&
    declaresWorkspaceCredentialPath
  ) {
    throw new Error(
      'reject-before-external-boundary credential conformance cannot declare workspace.git.materialize or workspace.git.deliver',
    );
  }
}

function createTasklessDiagnosticHarness(
  scenarioIndex: number,
): TasklessDiagnosticHarness {
  const attemptedFacts: SandboxProvisioningDiagnosticFact[] = [];
  const diagnosticFailures: unknown[] = [];
  const events: SandboxProvisioningDiagnosticEvent[] = [];
  const recordCalls = { value: 0 };
  let operationIndex = 0;
  const observer = createNonPersistingSandboxProvisioningDiagnosticObserver({
    createOperationId: () =>
      indexedUuid(2_000 + scenarioIndex * 100 + ++operationIndex),
  });
  const diagnostics: SandboxProviderTasklessDiagnosticObserver = Object.freeze({
    mode: 'non-persisting',
    createOperationId: (replayKey?: SandboxProvisioningDiagnosticReplayKey) =>
      observer.createOperationId(replayKey),
    async emit(fact: SandboxProvisioningDiagnosticFact) {
      attemptedFacts.push(fact);
      try {
        await observer.emit(fact);
      } catch (error) {
        diagnosticFailures.push(error);
        throw error;
      }
    },
    async flush() {
      await observer.flush();
    },
  });
  return {
    kind: 'taskless',
    diagnostics,
    events,
    attemptedFacts,
    diagnosticFailures,
    recordCalls,
  };
}

function createTaskDiagnosticHarness(
  scenario: SandboxProviderTaskDiagnosticConformanceCase,
  scenarioIndex: number,
): TaskDiagnosticHarness {
  const attemptedFacts: SandboxProvisioningDiagnosticFact[] = [];
  const diagnosticFailures: unknown[] = [];
  const events: SandboxProvisioningDiagnosticEvent[] = [];
  const recordCalls = { value: 0 };
  const attemptId = indexedUuid(100 + scenarioIndex);
  let eventIndex = 0;
  let operationIndex = 0;
  const emitter = createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId: TASK_ID,
      attemptId,
      attempt: scenarioIndex + 1,
      admissionMode: 'durable',
      providerFamily: 'unknown',
    },
    createEventId: () =>
      indexedUuid(4_000 + scenarioIndex * 100 + ++eventIndex),
    createOperationId: () =>
      indexedUuid(2_000 + scenarioIndex * 100 + ++operationIndex),
    now: () => new Date(OBSERVED_AT_EPOCH_MS + eventIndex),
    record: async (event) => {
      recordCalls.value += 1;
      if (scenario === 'diagnostic-write-failure') {
        throw new Error('Sandbox diagnostic conformance recorder unavailable');
      }
      events.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  const diagnostics = wrapDiagnosticObserver(
    emitter,
    attemptedFacts,
    diagnosticFailures,
  );
  return {
    kind: 'task',
    diagnostics,
    events,
    attemptedFacts,
    diagnosticFailures,
    recordCalls,
    taskId: TASK_ID,
    attemptId,
  };
}

/*
 * Keep the task-emitter wrapper generic so its attempt context and family
 * binding stay available to a real provider consumer.
 */
function wrapDiagnosticObserver(
  observer: SandboxProvisioningDiagnosticEmitter,
  attemptedFacts: SandboxProvisioningDiagnosticFact[],
  diagnosticFailures: unknown[],
): SandboxProvisioningDiagnosticEmitter {
  return Object.freeze({
    mode: 'task' as const,
    get attemptContext() {
      return observer.attemptContext;
    },
    createOperationId(replayKey?: SandboxProvisioningDiagnosticReplayKey) {
      return observer.createOperationId(replayKey);
    },
    bindProviderFamily(
      providerFamily: SandboxProvisioningDiagnosticProviderFamily,
    ) {
      observer.bindProviderFamily(providerFamily);
    },
    async emit(fact: SandboxProvisioningDiagnosticFact) {
      attemptedFacts.push(fact);
      try {
        await observer.emit(fact);
      } catch (error) {
        diagnosticFailures.push(error);
        throw error;
      }
    },
    async flush() {
      await observer.flush();
    },
  });
}

/*
 * The remaining assertions operate only on task-scoped persisted events.
 */

function assertDiagnosticEnvelope(
  harness: TaskDiagnosticHarness,
  providerFamily: SandboxProvisioningDiagnosticProviderFamily,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(harness.events.length > 0, 'diagnostic exercise must record events');
  assert.ok(
    harness.events.length <= SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
    'diagnostic events must remain within the shared attempt bound',
  );

  const eventIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const operations = new Map<string, SandboxProvisioningDiagnosticEvent[]>();
  for (const [index, event] of harness.events.entries()) {
    assert.equal(event.sequence, index + 1, 'diagnostic sequence must be contiguous');
    assert.equal(event.taskId, harness.taskId, 'task correlation must remain stable');
    assert.equal(event.attemptId, harness.attemptId, 'attempt correlation must remain stable');
    assert.equal(
      event.providerFamily,
      providerFamily,
      'provider family correlation must remain stable',
    );
    assert.ok(!eventIds.has(event.eventId), 'event identities must be unique');
    assert.ok(
      !idempotencyKeys.has(event.idempotencyKey),
      'persisted event idempotency identities must be unique',
    );
    eventIds.add(event.eventId);
    idempotencyKeys.add(event.idempotencyKey);
    const phase = event.outcome === 'started' ? 'started' : 'terminal';
    assert.equal(
      event.idempotencyKey,
      `${event.operationId}:${phase}`,
      'idempotency identity must use the stable operation phase',
    );
    const operationEvents = operations.get(event.operationId) ?? [];
    operationEvents.push(event);
    operations.set(event.operationId, operationEvents);
  }

  for (const operationEvents of operations.values()) {
    const [started, terminal] = operationEvents;
    assert.equal(
      operationEvents.length,
      2,
      'each logical operation must emit one start and one terminal event',
    );
    assert.equal(started!.outcome, 'started', 'operation start must be first');
    assert.ok(terminal!.outcome !== 'started', 'operation must have one terminal outcome');
    assert.deepEqual(
      operationShape(terminal!),
      operationShape(started!),
      'operation identity and safe shape must remain stable through settlement',
    );
  }
}

function assertScenarioOutcome(
  scenario: Exclude<
    SandboxProviderDiagnosticConformanceCase,
    'taskless-probe' | 'diagnostic-write-failure'
  >,
  harness: TaskDiagnosticHarness,
  result: SandboxProviderDiagnosticConformanceResult,
  assert: SandboxProviderConformanceAssert,
): void {
  const terminal = harness.events.filter((event) => event.outcome !== 'started');
  switch (scenario) {
    case 'bounded-start-terminal':
      assert.ok(
        terminal.some(
          (event) =>
            event.channel === 'primary' &&
            event.operation === 'sandbox_create' &&
            event.outcome === 'succeeded',
        ),
        'bounded lifecycle must include a successful sandbox create settlement',
      );
      return;
    case 'replay-deduplication':
      assertReplayDeduplication(
        harness,
        ['sandbox_create', 'sandbox_inspect'],
        assert,
      );
      return;
    case 'timeout':
      assert.ok(
        terminal.some(
          (event) =>
            event.channel === 'primary' &&
            event.operation === 'sandbox_create' &&
            event.outcome === 'timed_out',
        ),
        'timeout exercise must retain a timed-out sandbox create outcome',
      );
      assertCleanupAfterPrimary(harness, 'timed_out', 'sandbox_create', assert);
      return;
    case 'cancellation':
      assert.ok(
        terminal.some(
          (event) =>
            event.channel === 'primary' &&
            event.operation === 'sandbox_create' &&
            event.outcome === 'cancelled',
        ),
        'cancellation exercise must retain a cancelled sandbox create outcome',
      );
      assertCleanupAfterPrimary(harness, 'cancelled', 'sandbox_create', assert);
      return;
    case 'indeterminate-settlement':
      assert.ok(
        terminal.some(
          (event) =>
            event.channel === 'primary' &&
            event.operation === 'sandbox_create' &&
            event.outcome === 'indeterminate',
        ),
        'indeterminate exercise must retain an indeterminate sandbox create outcome',
      );
      assertCleanupAfterPrimary(
        harness,
        'indeterminate',
        'sandbox_create',
        assert,
      );
      return;
    case 'primary-plus-cleanup-failure':
      assertPrimaryAndCleanupFailure(harness, result, false, assert);
      return;
    case 'credential-cleanup-failure':
      assertPrimaryAndCleanupFailure(harness, result, true, assert);
      return;
    case 'raw-provider-secret-canary':
      assertPrimaryAndCleanupFailure(harness, result, false, assert);
      assert.ok(
        harness.diagnosticFailures.length > 0,
        'raw provider diagnostic must be rejected by the boundary',
      );
      assert.ok(
        terminal.some(
          (event) =>
            event.channel === 'primary' &&
            event.outcome !== 'succeeded',
        ),
        'raw provider canary exercise must retain a safe primary failure',
      );
      for (const canary of Object.values(
        SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CANARIES,
      )) {
        assert.ok(
          JSON.stringify(harness.attemptedFacts).includes(canary),
          'exercise must inject every raw provider and secret canary',
        );
      }
      return;
  }
}

function assertReplayDeduplication(
  harness: TaskDiagnosticHarness,
  expectedOperations: readonly SandboxProvisioningDiagnosticOperation[],
  assert: SandboxProviderConformanceAssert,
): void {
  const phaseCounts = new Map<string, number>();
  for (const fact of harness.attemptedFacts) {
    const phase = fact.outcome === 'started' ? 'started' : 'terminal';
    const key = `${fact.operationId}:${phase}`;
    phaseCounts.set(key, (phaseCounts.get(key) ?? 0) + 1);
  }
  const replayedOperation = harness.events.find(
    (event) =>
      event.outcome === 'started' &&
      event.channel === 'primary' &&
      expectedOperations.includes(event.operation) &&
      phaseCounts.get(`${event.operationId}:started`)! > 1 &&
      phaseCounts.get(`${event.operationId}:terminal`)! > 1,
  );
  assert.ok(
    replayedOperation !== undefined,
    'exercise must replay both phases of one logical operation',
  );
  assert.ok(
    harness.attemptedFacts.length > harness.events.length,
    'replayed facts must not create additional persisted events',
  );
}

function assertPrimaryAndCleanupFailure(
  harness: TaskDiagnosticHarness,
  result: SandboxProviderDiagnosticConformanceResult,
  credentialCleanup: boolean,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.equal(
    result.primary,
    PRIMARY_FAILURE,
    'cleanup failure must preserve the original primary identity',
  );
  if (!credentialCleanup) {
    assertSafeUnsuccessfulPhysicalCleanup(
      result.cleanup,
      'injected physical cleanup failure must not report success',
      assert,
    );
  }
  const primaryTerminal = harness.events.find(
    (event) =>
      event.channel === 'primary' &&
      event.outcome !== 'started' &&
      event.outcome !== 'succeeded',
  );
  const cleanupStarted = harness.events.find(
    (event) =>
      event.channel === 'cleanup' &&
      event.outcome === 'started' &&
      (!credentialCleanup || isCredentialCleanupDiagnostic(event)),
  );
  const cleanupTerminal = harness.events.find(
    (event) =>
      event.channel === 'cleanup' &&
      event.outcome !== 'started' &&
      (!credentialCleanup || isCredentialCleanupDiagnostic(event)),
  );
  assert.ok(primaryTerminal !== undefined, 'primary failure event must be retained');
  assert.ok(cleanupStarted !== undefined, 'cleanup start must be separate from primary');
  assert.ok(cleanupTerminal !== undefined, 'cleanup failure must be retained separately');
  assert.ok(
    primaryTerminal!.sequence < cleanupStarted!.sequence,
    'primary terminal evidence must be recorded before cleanup begins',
  );
  assert.ok(
    cleanupTerminal!.outcome === 'failed' ||
      cleanupTerminal!.outcome === 'indeterminate',
    'cleanup must retain a failed or indeterminate safe outcome',
  );
}

function isCredentialCleanupDiagnostic(
  event: SandboxProvisioningDiagnosticEvent,
): boolean {
  return (
    event.operation === 'credential_cleanup' ||
    (event.operation === 'native_exec_settlement' &&
      event.commandKind === 'credential_cleanup')
  );
}

function assertCleanupAfterPrimary(
  harness: TaskDiagnosticHarness,
  primaryOutcome: 'timed_out' | 'cancelled' | 'indeterminate',
  primaryOperation: SandboxProvisioningDiagnosticOperation,
  assert: SandboxProviderConformanceAssert,
): void {
  const primaryTerminal = harness.events.find(
    (event) =>
      event.channel === 'primary' &&
      event.operation === primaryOperation &&
      event.outcome === primaryOutcome,
  );
  const cleanupStarted = harness.events.find(
    (event) =>
      event.channel === 'cleanup' &&
      event.outcome === 'started' &&
      (event.operation === 'sandbox_delete' ||
        event.operation === 'sandbox_absence_confirm'),
  );
  const cleanupTerminal = harness.events.find(
    (event) =>
      cleanupStarted !== undefined &&
      event.operationId === cleanupStarted.operationId &&
      event.outcome !== 'started',
  );
  assert.ok(
    primaryTerminal !== undefined,
    `${primaryOutcome} primary evidence must be retained before cleanup`,
  );
  assert.ok(
    cleanupStarted !== undefined,
    `${primaryOutcome} must start an independent cleanup lifecycle`,
  );
  assert.ok(
    cleanupTerminal !== undefined,
    `${primaryOutcome} cleanup lifecycle must settle once`,
  );
  assert.ok(
    primaryTerminal !== undefined &&
      cleanupStarted !== undefined &&
      primaryTerminal.sequence < cleanupStarted.sequence,
    `${primaryOutcome} primary evidence must be recorded before cleanup`,
  );
}

function assertTasklessProbe(
  harness: TasklessDiagnosticHarness,
  result: SandboxProviderDiagnosticConformanceResult,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.equal(harness.diagnostics.mode, 'non-persisting', 'probe must use taskless mode');
  assert.ok(
    !Object.hasOwn(harness.diagnostics, 'attemptContext'),
    'taskless probe must not receive a task attempt identity',
  );
  assert.ok(
    !Object.hasOwn(harness.diagnostics, 'record'),
    'taskless probe must not receive a persistence callback',
  );
  assert.equal(harness.recordCalls.value, 0, 'taskless probe must perform zero writes');
  assert.equal(harness.events.length, 0, 'taskless probe must create zero persisted events');
  assert.equal(result.probe, PROBE_RESULT, 'diagnostics must not alter the probe result');
  assertFactPairs(harness.attemptedFacts, assert);
}

function assertCredentialRejection(
  harness: TaskDiagnosticHarness,
  result: SandboxProviderDiagnosticConformanceResult,
  assert: SandboxProviderConformanceAssert,
): void {
  const rejection = result.rejection as
    | { readonly code?: unknown }
    | null
    | undefined;
  assert.equal(
    rejection?.code,
    'sandbox_provider_configuration_error',
    'unsupported canonical credentials must fail with the safe provider configuration code',
  );
  assert.equal(
    result.externalBoundaryCalls,
    0,
    'credential rejection must happen before any provider external boundary',
  );
  assert.equal(
    harness.attemptedFacts.length,
    0,
    'credential rejection must not fabricate diagnostic facts',
  );
  assert.equal(
    harness.events.length,
    0,
    'credential rejection must not fabricate persisted events',
  );
  assert.equal(
    harness.diagnosticFailures.length,
    0,
    'credential rejection must not fabricate diagnostic failures',
  );
  assert.equal(
    harness.recordCalls.value,
    0,
    'credential rejection must not call the diagnostic recorder',
  );
  assertNoCanaries([result.rejection], assert);
}

function assertDiagnosticWriteFailure(
  harness: TaskDiagnosticHarness,
  result: SandboxProviderDiagnosticConformanceResult,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(harness.recordCalls.value > 0, 'exercise must reach the failing recorder');
  assert.ok(
    harness.attemptedFacts.length > 0 &&
      harness.attemptedFacts.length <=
        SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
    'failed recorder facts must remain non-empty and within the shared attempt bound',
  );
  assert.ok(
    harness.attemptedFacts.some(
      (fact) =>
        fact.channel === 'primary' && fact.operation === 'sandbox_create',
    ),
    'diagnostic write failure must exercise the real sandbox create boundary',
  );
  assert.equal(harness.events.length, 0, 'failed recorder must persist no event');
  assert.ok(
    harness.diagnosticFailures.length > 0,
    'recorder failure must be observed by the provider boundary',
  );
  assert.equal(
    result.primary,
    PRIMARY_FAILURE,
    'diagnostic write failure must preserve the primary result',
  );
  assertSafeUnsuccessfulPhysicalCleanup(
    result.cleanup,
    'diagnostic write failure must preserve a safe physical cleanup failure',
    assert,
  );
}

function assertSafeUnsuccessfulPhysicalCleanup(
  result: SandboxPhysicalCleanupResult | undefined,
  message: string,
  assert: SandboxProviderConformanceAssert,
): SandboxPhysicalCleanupResult {
  const cleanup = validateSandboxPhysicalCleanupResult(
    result as SandboxPhysicalCleanupResult,
  );
  assert.ok(cleanup.outcome !== 'succeeded', message);
  assertNoCanaries([cleanup], assert);
  return cleanup;
}

function assertFactPairs(
  facts: readonly SandboxProvisioningDiagnosticFact[],
  assert: SandboxProviderConformanceAssert,
): void {
  const operations = new Map<string, SandboxProvisioningDiagnosticFact[]>();
  for (const fact of facts) {
    const operationFacts = operations.get(fact.operationId) ?? [];
    operationFacts.push(fact);
    operations.set(fact.operationId, operationFacts);
  }
  assert.ok(operations.size > 0, 'taskless probe must emit a diagnostic lifecycle');
  for (const operationFacts of operations.values()) {
    assert.equal(operationFacts.length, 2, 'taskless lifecycle must remain bounded');
    assert.equal(operationFacts[0]!.outcome, 'started', 'taskless lifecycle must start');
    assert.ok(
      operationFacts[1]!.outcome !== 'started',
      'taskless lifecycle must settle once',
    );
  }
}

function assertNoCanaries(
  values: readonly unknown[],
  assert: SandboxProviderConformanceAssert,
): void {
  const serialized = values
    .map((value) =>
      value instanceof Error
        ? `${value.name}:${value.message}:${String(value.stack)}`
        : JSON.stringify(value),
    )
    .join('\n');
  for (const canary of Object.values(
    SANDBOX_PROVIDER_DIAGNOSTIC_CONFORMANCE_CANARIES,
  )) {
    assert.ok(
      !serialized.includes(canary),
      'persisted diagnostic material must contain no raw provider or secret canary',
    );
  }
}

function operationShape(event: SandboxProvisioningDiagnosticEvent): object {
  return {
    operationId: event.operationId,
    stage: event.stage,
    operation: event.operation,
    channel: event.channel,
    commandKind: event.commandKind ?? null,
    // add-repo-content-store: the named workspace-source variant is part of an
    // operation's stable shape, so a start/terminal pair may not disagree.
    workspaceSourceKind: event.workspaceSourceKind ?? null,
  };
}

function indexedUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
