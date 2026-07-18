import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import {
  TaskProvisioningDiagnosticAttemptSchema,
  TaskProvisioningDiagnosticCleanupSummarySchema,
  TaskProvisioningDiagnosticEventSchema,
  type TaskProvisioningDiagnosticAttempt,
  type TaskProvisioningDiagnosticCleanupSummary,
  type TaskProvisioningDiagnosticEvent,
  type TaskProvisioningStage,
  type TaskStatus,
} from '@cap/contracts';
import {
  InMemorySandboxRunOwnerStore,
  SandboxProviderRouter,
  defineLocalSandboxProvider,
  type AgentTerminalLaunchOutcome,
  type SandboxConnection,
  type SandboxProvisionContext,
  type SelectedSandboxRun,
} from '@cap/sandbox';

import { AuditService } from '../audit/audit.service';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import {
  GuardrailsService,
  type GuardrailsConfig,
  type ITerminalGateway,
} from '../guardrails/guardrails.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProvisionLookup } from '../sandbox/provision-lookup.port';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import { FencedTaskAdmissionProcessor } from '../task-admission/fenced-task-admission.processor';
import {
  DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  TaskAdmissionClock,
  TaskAdmissionLeaseTokenFactory,
  TaskAdmissionScheduler,
  type TaskAdmissionTimer,
} from '../task-admission/task-admission-runtime';
import {
  TaskAdmissionCoordinationError,
  TaskAdmissionLeaseLostError,
  TaskAdmissionProcessingError,
  TaskAdmissionStore,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionProcessor,
  type TaskAdmissionProcessorContext,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
  type TaskAdmissionTerminalFailure,
  type TaskAdmissionTerminalRecovery,
} from '../task-admission/task-admission.types';
import { TaskAdmissionWorker } from '../task-admission/task-admission.worker';
import type {
  AppendedTaskProvisioningDiagnosticEvent,
  BeginTaskProvisioningDiagnosticAttempt,
  RecordTaskProvisioningDiagnosticPrimary,
  ResumedTaskProvisioningDiagnosticAttempt,
  ResumeTaskProvisioningDiagnosticAttempt,
  TaskProvisioningDiagnosticAttemptContext,
  TaskProvisioningDiagnosticRecorderPort,
  TaskProvisioningDiagnosticRecorderResult,
} from '../task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import {
  deriveTaskDiagnosticCoverage,
  hasCompleteEventInvariants,
} from '../task-provisioning-diagnostics/task-provisioning-diagnostics.projection';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_TIME = new Date('2026-07-18T04:00:00.000Z');
const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
  diagnosticWriteTimeoutMs: 50,
};

type WorkState =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

interface StoryTask {
  status: TaskStatus;
  lifecycleVersion: number;
}

interface StoryWork {
  state: WorkState;
  attempt: number;
  stage: TaskProvisioningStage;
  availableAtMs: number;
  leaseToken: string | null;
  leaseUntilMs: number | null;
  causeCode: TaskAdmissionClaim['causeCode'];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class StoryClock extends TaskAdmissionClock {
  constructor(private currentMs = FIXED_TIME.getTime()) {
    super();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  get value(): number {
    return this.currentMs;
  }

  advancePast(timestampMs: number): void {
    assert.ok(timestampMs >= this.currentMs);
    this.currentMs = timestampMs + 1;
  }
}

class StoryScheduler extends TaskAdmissionScheduler {
  schedule(_delayMs: number, _callback: () => void): TaskAdmissionTimer {
    // runOnce owns these stories. Automatic renewal is still installed by the
    // real worker, but deterministic DB time never advances while one claim is
    // executing, so the timer only needs the production cancellation seam.
    return { cancel() {} };
  }
}

class StoryLeaseTokens extends TaskAdmissionLeaseTokenFactory {
  private sequence = 0;

  create(): string {
    this.sequence += 1;
    return `diagnostic-story-lease:${this.sequence}`;
  }
}

class StoryAdmissionStore extends TaskAdmissionStore {
  readonly task: StoryTask = { status: 'pending', lifecycleVersion: 0 };
  readonly work: StoryWork = {
    state: 'accepted',
    attempt: 0,
    stage: 'accepted',
    availableAtMs: FIXED_TIME.getTime(),
    leaseToken: null,
    leaseUntilMs: null,
    causeCode: null,
  };
  private failCheckpointStage: TaskProvisioningStage | null = null;

  constructor(private readonly clock: StoryClock) {
    super();
  }

  failNextCheckpoint(stage: TaskProvisioningStage): void {
    this.failCheckpointStage = stage;
  }

  cancelTask(): void {
    this.task.status = 'cancelled';
    this.task.lifecycleVersion += 1;
  }

  expireLease(): void {
    assert.notEqual(this.work.leaseUntilMs, null);
    this.clock.advancePast(this.work.leaseUntilMs as number);
  }

  advanceToRetry(): void {
    assert.equal(this.work.state, 'retrying');
    this.clock.advancePast(this.work.availableAtMs);
  }

  async reserveDurableAdmissionCapacity(input: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly expectedStatus: TaskStatus;
    readonly expectedLifecycleVersion: number;
  }): Promise<
    | {
        readonly outcome: 'running';
        readonly status: 'running';
        readonly lifecycleVersion: number;
        readonly transitioned: true;
      }
    | { readonly outcome: 'superseded'; readonly transitioned: false }
  > {
    if (
      input.taskId !== TASK_ID ||
      this.work.state !== 'running' ||
      this.work.leaseToken !== input.leaseToken ||
      this.work.leaseUntilMs === null ||
      this.work.leaseUntilMs <= this.clock.value ||
      this.task.status !== input.expectedStatus ||
      this.task.lifecycleVersion !== input.expectedLifecycleVersion ||
      input.expectedStatus !== 'pending'
    ) {
      return { outcome: 'superseded', transitioned: false };
    }
    this.task.status = 'running';
    this.task.lifecycleVersion += 1;
    return {
      outcome: 'running',
      status: 'running',
      lifecycleVersion: this.task.lifecycleVersion,
      transitioned: true,
    };
  }

  async claim(
    request: TaskAdmissionClaimRequest,
  ): Promise<TaskAdmissionClaim | null> {
    const claimableWithoutLease =
      (this.work.state === 'accepted' ||
        this.work.state === 'queued' ||
        this.work.state === 'retrying') &&
      this.work.availableAtMs <= this.clock.value;
    const expiredRunningLease =
      this.work.state === 'running' &&
      this.work.leaseUntilMs !== null &&
      this.work.leaseUntilMs <= this.clock.value;
    if (!claimableWithoutLease && !expiredRunningLease) return null;

    const sourceState = this.work.state;
    assert.ok(
      sourceState === 'accepted' ||
        sourceState === 'queued' ||
        sourceState === 'running' ||
        sourceState === 'retrying',
    );
    this.work.state = 'running';
    if (sourceState !== 'queued') this.work.attempt += 1;
    this.work.leaseToken = request.leaseToken;
    this.work.leaseUntilMs = this.clock.value + request.leaseDurationMs;

    return {
      taskId: TASK_ID,
      leaseToken: request.leaseToken,
      leaseUntil: new Date(this.work.leaseUntilMs),
      sourceState,
      attempt: this.work.attempt,
      stage: this.work.stage,
      causeCode: this.work.causeCode,
      resolvedBranch: 'main',
      resourceSnapshot: Object.freeze({ diskSizeGb: 8 }),
      workspaceMaterializationDeadlineMs: 900_000,
      taskStatus: this.task.status,
      taskLifecycleVersion: this.task.lifecycleVersion,
    };
  }

  async authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.owns(request);
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    this.work.leaseUntilMs = this.clock.value + request.leaseDurationMs;
    return true;
  }

  async checkpoint(
    request: TaskAdmissionCheckpointRequest,
  ): Promise<boolean> {
    if (!this.owns(request)) return false;
    if (request.stage === this.failCheckpointStage) {
      this.failCheckpointStage = null;
      throw new Error('simulated runtime checkpoint acknowledgement loss');
    }
    this.work.stage = request.stage;
    return true;
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    this.work.state = request.settlement.state;
    this.work.stage = request.settlement.stage;
    this.work.causeCode =
      request.settlement.state === 'failed' ||
      request.settlement.state === 'retrying'
        ? request.settlement.causeCode
        : this.work.causeCode;
    this.work.availableAtMs =
      request.settlement.state === 'queued' ||
      request.settlement.state === 'retrying'
        ? this.clock.value + request.settlement.availableAfterMs
        : this.clock.value;
    this.work.leaseToken = null;
    this.work.leaseUntilMs = null;
    return true;
  }

  private owns(request: TaskAdmissionAuthorityRequest): boolean {
    return (
      request.taskId === TASK_ID &&
      this.work.state === 'running' &&
      this.work.leaseToken === request.leaseToken &&
      this.work.leaseUntilMs !== null &&
      this.work.leaseUntilMs > this.clock.value &&
      request.taskFences.some(
        (fence) =>
          fence.status === this.task.status &&
          fence.lifecycleVersion === this.task.lifecycleVersion,
      )
    );
  }
}

interface DiagnosticRow {
  attempt: TaskProvisioningDiagnosticAttempt;
  readonly events: TaskProvisioningDiagnosticEvent[];
}

/**
 * Strict transactional-port substitute for this story. It mirrors the
 * production recorder's task-local attempt fence, interruption rule, immutable
 * event replay and explicit completeness proof. Prisma locking/compaction is
 * intentionally left to the recorder service's own integration suite.
 */
class StoryDiagnosticRecorder implements TaskProvisioningDiagnosticRecorderPort {
  private nextAttempt = 1;
  private readonly rows: DiagnosticRow[] = [];
  readonly failPrimaryAttempts = new Set<number>();
  primaryWriteFailures = 0;

  get attempts(): readonly TaskProvisioningDiagnosticAttempt[] {
    return this.rows.map(({ attempt }) => attempt);
  }

  eventsFor(attempt: number): readonly TaskProvisioningDiagnosticEvent[] {
    return this.rowByNumber(attempt)?.events ?? [];
  }

  coverage(taskStatus: TaskStatus, admissionState: WorkState) {
    return deriveTaskDiagnosticCoverage({
      expectedSchemaVersion: 1,
      taskStatus,
      admissionState,
      attempts: this.attempts,
      eventsByAttempt: new Map(
        this.rows.map((row) => [row.attempt.id, row.events] as const),
      ),
      hasCompaction: false,
      hasUnsupportedEvidence: false,
    });
  }

  async beginAttempt(
    input: BeginTaskProvisioningDiagnosticAttempt,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttemptContext>
  > {
    const expectedAttempt = input.expectedAttempt ?? this.nextAttempt;
    if (expectedAttempt < this.nextAttempt) {
      return diagnosticFailure('attempt_number_conflict');
    }
    const active = this.rows.find(({ attempt }) => attempt.state === 'active');
    if (active) {
      if ((input.activeDisposition ?? 'reject') !== 'interrupt') {
        return diagnosticFailure('active_attempt_conflict');
      }
      const observedAt = new Date();
      active.attempt = TaskProvisioningDiagnosticAttemptSchema.parse({
        ...active.attempt,
        state: 'interrupted',
        coverage: 'partial',
        primary:
          active.attempt.primary ??
          {
            outcome: 'indeterminate',
            cause: 'settlement_unknown',
            retryable: true,
            exitCode: null,
            observedAt,
          },
        finishedAt: active.attempt.finishedAt ?? observedAt,
        completenessMarkedAt: null,
      });
    }

    const context: TaskProvisioningDiagnosticAttemptContext = {
      taskId: input.taskId,
      attemptId: randomUUID(),
      attempt: expectedAttempt,
      admissionMode: input.admissionMode,
    };
    this.rows.push({
      attempt: TaskProvisioningDiagnosticAttemptSchema.parse({
        schemaVersion: 1,
        id: context.attemptId,
        taskId: context.taskId,
        attempt: context.attempt,
        admissionMode: context.admissionMode,
        providerFamily: input.providerFamily ?? null,
        state: 'active',
        stage: input.stage ?? 'provider_selection',
        coverage: 'partial',
        primary: null,
        cleanup: {
          state: 'not_required',
          cause: null,
          attemptCount: 0,
          lastAttemptOutcome: null,
          observedAt: null,
        },
        eventCount: 0,
        truncated: false,
        startedAt: new Date(),
        finishedAt: null,
        completenessMarkedAt: null,
      }),
      events: [],
    });
    this.nextAttempt = expectedAttempt + 1;
    return { ok: true, value: context };
  }

  async resumeAttempt(
    input: ResumeTaskProvisioningDiagnosticAttempt,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<ResumedTaskProvisioningDiagnosticAttempt>
  > {
    const row = this.rowByNumber(input.attempt);
    if (
      !row ||
      row.attempt.taskId !== input.taskId ||
      row.attempt.admissionMode !== input.admissionMode
    ) {
      return diagnosticFailure('attempt_not_found');
    }
    return {
      ok: true,
      value: {
        context: contextFromAttempt(row.attempt),
        state: row.attempt.state,
        providerFamily: row.attempt.providerFamily,
        initialSequence: row.events.length,
      },
    };
  }

  async appendEvent(
    context: TaskProvisioningDiagnosticAttemptContext,
    input: unknown,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<AppendedTaskProvisioningDiagnosticEvent>
  > {
    const parsed = TaskProvisioningDiagnosticEventSchema.safeParse(input);
    const row = this.row(context);
    if (!parsed.success || !row || !eventMatchesContext(parsed.data, context)) {
      return diagnosticFailure('invalid_evidence');
    }
    const event = parsed.data;
    const replay = row.events.find(
      ({ idempotencyKey }) => idempotencyKey === event.idempotencyKey,
    );
    if (replay) {
      return sameDiagnosticEventFacts(replay, event)
        ? {
            ok: true,
            value: { event: replay, replayed: true },
          }
        : diagnosticFailure('immutable_evidence_conflict');
    }
    const logicalReplay = row.events.find(
      (retained) =>
        retained.operationId === event.operationId &&
        (retained.outcome === 'started') === (event.outcome === 'started'),
    );
    if (logicalReplay) {
      return sameDiagnosticEventFacts(logicalReplay, event)
        ? {
            ok: true,
            value: { event: logicalReplay, replayed: true },
          }
        : diagnosticFailure('immutable_evidence_conflict');
    }
    if (event.sequence !== row.events.length + 1) {
      return diagnosticFailure('immutable_evidence_conflict');
    }
    if (row.attempt.state !== 'active' && event.channel === 'primary') {
      return diagnosticFailure('immutable_evidence_conflict');
    }
    row.events.push(event);
    row.attempt = TaskProvisioningDiagnosticAttemptSchema.parse({
      ...row.attempt,
      providerFamily: event.providerFamily,
      stage: event.stage,
      eventCount: row.events.length,
      coverage: 'partial',
      completenessMarkedAt: null,
    });
    return { ok: true, value: { event, replayed: false } };
  }

  async recordPrimary(
    context: TaskProvisioningDiagnosticAttemptContext,
    input: RecordTaskProvisioningDiagnosticPrimary,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttempt>
  > {
    const row = this.row(context);
    if (!row) return diagnosticFailure('attempt_not_found');
    if (this.failPrimaryAttempts.has(context.attempt)) {
      this.primaryWriteFailures += 1;
      return diagnosticFailure('diagnostic_write_failed');
    }
    if (row.attempt.primary !== null) {
      return diagnosticFailure('immutable_evidence_conflict');
    }
    if (row.attempt.state !== 'active') {
      return diagnosticFailure('immutable_evidence_conflict');
    }
    row.attempt = TaskProvisioningDiagnosticAttemptSchema.parse({
      ...row.attempt,
      state: input.state,
      stage: input.stage,
      coverage: 'partial',
      primary: input.primary,
      finishedAt: input.primary.observedAt,
      completenessMarkedAt: null,
    });
    return { ok: true, value: row.attempt };
  }

  async recordCleanup(
    context: TaskProvisioningDiagnosticAttemptContext,
    input: TaskProvisioningDiagnosticCleanupSummary,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttempt>
  > {
    const row = this.row(context);
    const cleanup = TaskProvisioningDiagnosticCleanupSummarySchema.safeParse(input);
    if (!row) return diagnosticFailure('attempt_not_found');
    if (!cleanup.success) return diagnosticFailure('invalid_evidence');
    row.attempt = TaskProvisioningDiagnosticAttemptSchema.parse({
      ...row.attempt,
      cleanup: cleanup.data,
      coverage: 'partial',
      completenessMarkedAt: null,
    });
    return { ok: true, value: row.attempt };
  }

  async markComplete(
    context: TaskProvisioningDiagnosticAttemptContext,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttempt>
  > {
    const row = this.row(context);
    if (!row) return diagnosticFailure('attempt_not_found');
    if (!hasCompleteEventInvariants(row.attempt, row.events)) {
      return diagnosticFailure('incomplete_evidence');
    }
    row.attempt = TaskProvisioningDiagnosticAttemptSchema.parse({
      ...row.attempt,
      coverage: 'complete',
      completenessMarkedAt: new Date(),
    });
    return { ok: true, value: row.attempt };
  }

  async upsertPartialAttempt(
    context: TaskProvisioningDiagnosticAttemptContext,
  ): Promise<
    TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticAttempt>
  > {
    const row = this.row(context);
    return row
      ? { ok: true, value: row.attempt }
      : diagnosticFailure('attempt_not_found');
  }

  private row(
    context: TaskProvisioningDiagnosticAttemptContext,
  ): DiagnosticRow | undefined {
    return this.rows.find(
      ({ attempt }) =>
        attempt.id === context.attemptId &&
        attempt.taskId === context.taskId &&
        attempt.attempt === context.attempt &&
        attempt.admissionMode === context.admissionMode,
    );
  }

  private rowByNumber(attempt: number): DiagnosticRow | undefined {
    return this.rows.find((row) => row.attempt.attempt === attempt);
  }
}

function diagnosticFailure(
  code: Exclude<
    TaskProvisioningDiagnosticRecorderResult<never>,
    { readonly ok: true }
  >['code'],
): Exclude<
  TaskProvisioningDiagnosticRecorderResult<never>,
  { readonly ok: true }
> {
  return { ok: false, code, safeCause: 'diagnostic_write_failed' };
}

function contextFromAttempt(
  attempt: TaskProvisioningDiagnosticAttempt,
): TaskProvisioningDiagnosticAttemptContext {
  return {
    taskId: attempt.taskId,
    attemptId: attempt.id,
    attempt: attempt.attempt,
    admissionMode: attempt.admissionMode,
  };
}

function eventMatchesContext(
  event: TaskProvisioningDiagnosticEvent,
  context: TaskProvisioningDiagnosticAttemptContext,
): boolean {
  return (
    event.taskId === context.taskId &&
    event.attemptId === context.attemptId &&
    event.attempt === context.attempt &&
    event.admissionMode === context.admissionMode
  );
}

/** Match the production recorder's immutable facts, excluding DB coordinates. */
function sameDiagnosticEventFacts(
  retained: TaskProvisioningDiagnosticEvent,
  candidate: TaskProvisioningDiagnosticEvent,
): boolean {
  const facts = (event: TaskProvisioningDiagnosticEvent) => ({
    schemaVersion: event.schemaVersion,
    idempotencyKey: event.idempotencyKey,
    taskId: event.taskId,
    attemptId: event.attemptId,
    attempt: event.attempt,
    operationId: event.operationId,
    admissionMode: event.admissionMode,
    providerFamily: event.providerFamily,
    stage: event.stage,
    operation: event.operation,
    channel: event.channel,
    commandKind: event.commandKind ?? null,
    outcome: event.outcome,
    durationMs: event.outcome === 'started' ? null : event.durationMs ?? null,
    cause: event.outcome === 'started' ? null : event.cause,
    retryable: event.outcome === 'started' ? null : event.retryable,
    httpStatusClass:
      event.outcome === 'started' ? null : event.httpStatusClass ?? null,
    nativeState: event.outcome === 'started' ? null : event.nativeState ?? null,
    anomaly: event.outcome === 'started' ? null : event.anomaly ?? null,
    exitCode: event.outcome === 'started' ? null : event.exitCode ?? null,
    timeoutMs: event.outcome === 'started' ? null : event.timeoutMs ?? null,
  });
  return JSON.stringify(facts(retained)) === JSON.stringify(facts(candidate));
}

class StoryAuditLedger {
  readonly events = new Map<string, Record<string, unknown>>();
  readonly attemptedKeys: string[] = [];
  upsertCalls = 0;
  readonly service: AuditService;

  constructor() {
    const prisma = {
      auditEvent: {
        upsert: async ({
          where,
          update,
          create,
        }: {
          where: { dedupeKey: string };
          update: Record<string, unknown>;
          create: Record<string, unknown>;
        }) => {
          assert.deepEqual(update, {});
          this.upsertCalls += 1;
          this.attemptedKeys.push(where.dedupeKey);
          const existing = this.events.get(where.dedupeKey);
          if (existing) return existing;
          this.events.set(where.dedupeKey, create);
          return create;
        },
      },
    } as unknown as PrismaService;
    this.service = new AuditService(prisma);
  }
}

class StoryProvider {
  readonly ownerStore = new InMemorySandboxRunOwnerStore();
  readonly physicalResources = new Set<string>();
  readonly contexts: SandboxProvisionContext[] = [];
  readonly readoptionTargets: unknown[] = [];
  physicalCreates = 0;
  readonly router: SandboxProviderRouter;

  constructor() {
    const connection: SandboxConnection = {
      taskId: TASK_ID,
      baseUrl: `http://diagnostic-story/${TASK_ID}`,
      wsUrl: `ws://diagnostic-story/${TASK_ID}`,
    };
    const provider = {
      getSandboxMode: () => 'workspace-write' as const,
      getProviderCapabilities: () =>
        [
          'terminal.websocket',
          'lifecycle.readopt',
          'workspace.git.materialize',
          'resource.disk-size-gb',
        ] as const,
      provision: async (context: SandboxProvisionContext) => {
        this.contexts.push(context);
        const ownership = context.ownership;
        assert.ok(ownership);
        await context.externalBoundaryGuard?.({
          taskId: context.taskId,
          action: 'sandbox.create',
          position: 'before',
        });
        if (!this.physicalResources.has(ownership.resourceGeneration)) {
          this.physicalResources.add(ownership.resourceGeneration);
          this.physicalCreates += 1;
        }
        await context.onSandboxCreateObserved?.({
          kind: 'created',
          providerSandboxId: `physical:${ownership.resourceGeneration}`,
        });
        await emitSandboxCreateTwice(context);
        return connection;
      },
      reattach: async (_taskId: string, target: unknown) => {
        this.readoptionTargets.push(target);
        return connection;
      },
      getSelectedSandboxRun: async (): Promise<SelectedSandboxRun | null> => {
        const resourceGeneration = [...this.physicalResources][0];
        if (!resourceGeneration) return null;
        return {
          taskId: TASK_ID,
          providerId: 'diagnostic-story-provider',
          provider: provider as never,
          providerSandboxId: `physical:${resourceGeneration}`,
          capabilities: [
            'terminal.websocket',
            'lifecycle.readopt',
            'workspace.git.materialize',
            'resource.disk-size-gb',
          ],
          connection,
        };
      },
      teardownSandbox: async (
        _taskId: string,
        options?: {
          readonly ownership?: { readonly resourceGeneration: string };
        },
      ) => {
        if (options?.ownership) {
          this.physicalResources.delete(options.ownership.resourceGeneration);
        }
        return { kind: 'found-and-cleaned' as const };
      },
      readRolloutFromContainer: async () => null,
      sandboxExists: async () => this.physicalResources.size > 0,
      deliverWorkspaceChanges: async () => ({
        hadChanges: false,
        commitSha: null,
        error: null,
      }),
    };
    this.router = new SandboxProviderRouter(
      [
        defineLocalSandboxProvider({
          id: 'diagnostic-story-provider',
          provider: provider as never,
          capabilities: [
            'terminal.websocket',
            'lifecycle.readopt',
            'workspace.git.materialize',
            'resource.disk-size-gb',
          ],
        }),
      ],
      { ownerStore: this.ownerStore },
    );
  }
}

async function emitSandboxCreateTwice(
  context: SandboxProvisionContext,
): Promise<void> {
  const diagnostics = context.diagnostics;
  if (!diagnostics) return;
  diagnostics.bindProviderFamily('boxlite');
  const operationId = diagnostics.createOperationId();
  const started = {
    operationId,
    stage: 'sandbox_creation' as const,
    operation: 'sandbox_create' as const,
    channel: 'primary' as const,
    outcome: 'started' as const,
  };
  const succeeded = {
    operationId,
    stage: 'sandbox_creation' as const,
    operation: 'sandbox_create' as const,
    channel: 'primary' as const,
    outcome: 'succeeded' as const,
    cause: null,
    retryable: false,
  };
  await diagnostics.emit(started);
  await diagnostics.emit(started);
  await diagnostics.emit(succeeded);
  await diagnostics.emit(succeeded);
  await diagnostics.flush();
}

type TerminalOpenOptions = Parameters<ITerminalGateway['openSession']>[2];

class StoryTerminalGateway implements ITerminalGateway {
  readonly entered = deferred<void>();
  openCalls = 0;

  constructor(
    private transientFailures: number,
    private readonly blockUntilAbort = false,
  ) {}

  openSession(
    _connection: SandboxConnection,
    _selectedRun?: SelectedSandboxRun | null,
    options?: TerminalOpenOptions,
  ): { readonly launchDecision: Promise<AgentTerminalLaunchOutcome> } {
    this.openCalls += 1;
    return { launchDecision: this.decide(options) };
  }

  unregisterSession(_taskId: string): void {}

  async readSessionLogTail(_taskId: string): Promise<string> {
    return '';
  }

  private async decide(
    options?: TerminalOpenOptions,
  ): Promise<AgentTerminalLaunchOutcome> {
    await options?.beforeAgentLaunch?.();
    this.entered.resolve();
    if (this.blockUntilAbort) {
      await waitForAbort(options?.signal, TASK_ID);
    }
    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      throw new TaskAdmissionProcessingError(
        'provisioning_tls_network_failed',
        'agent_launch',
        true,
      );
    }
    return { kind: 'launched' };
  }
}

async function waitForAbort(
  signal: AbortSignal | undefined,
  taskId: string,
): Promise<void> {
  if (!signal) throw new Error('cancellation story requires a signal');
  if (signal.aborted) throw new TaskAdmissionLeaseLostError(taskId);
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new TaskAdmissionLeaseLostError(taskId)),
      { once: true },
    );
  });
}

class SameClaimReplayProcessor implements TaskAdmissionProcessor {
  replayChecks = 0;

  constructor(private readonly delegate: FencedTaskAdmissionProcessor) {}

  process(
    context: TaskAdmissionProcessorContext,
  ): ReturnType<TaskAdmissionProcessor['process']> {
    const first = this.delegate.process(context);
    const replay = this.delegate.process(context);
    assert.equal(
      replay,
      first,
      'one exact claim must reuse the Guardrails processing promise',
    );
    this.replayChecks += 1;
    return first;
  }

  settleTerminalFailure(
    context: TaskAdmissionProcessorContext,
    failure: TaskAdmissionTerminalFailure,
  ): Promise<boolean> {
    return this.delegate.settleTerminalFailure(context, failure);
  }

  recoverTerminal(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionTerminalRecovery> {
    return this.delegate.recoverTerminal(context);
  }
}

function provisionLookup(): ProvisionLookup {
  return {
    async getTaskLaunchContext() {
      return {
        modelIntent: { kind: 'runtime-default' as const },
        ownerUserId: USER_ID,
        runtimeId: 'codex' as const,
        executionMode: 'interactive-pty' as const,
        resources: Object.freeze({ diskSizeGb: 8 }),
        workspaceMaterializationDeadlineMs: 900_000,
      };
    },
    async getTaskWorkspacePlan() {
      return {
        repositoryUrl: 'https://example.test/acme/repo.git',
        callerBranch: null,
        resolvedBranch: 'main',
        deadlineMs: 900_000,
      };
    },
    async getCloneSpec() {
      throw new Error('canonical workspace plan suppresses legacy clone lookup');
    },
    async getTaskPrompt() {
      return 'diagnostic recovery story';
    },
    async getTaskSkills() {
      return [];
    },
    async getTaskRuntime() {
      return 'codex';
    },
    async getTaskExecutionMode() {
      return 'interactive-pty';
    },
  };
}

class DiagnosticRecoveryHarness {
  readonly clock = new StoryClock();
  readonly store = new StoryAdmissionStore(this.clock);
  readonly scheduler = new StoryScheduler();
  readonly leaseTokens = new StoryLeaseTokens();
  readonly diagnostics = new StoryDiagnosticRecorder();
  readonly audits = new StoryAuditLedger();
  readonly provider = new StoryProvider();

  replica(gateway: StoryTerminalGateway): {
    readonly guardrails: GuardrailsService;
    readonly replayProcessor: SameClaimReplayProcessor;
    readonly worker: TaskAdmissionWorker;
  } {
    const resolved: { guardrails?: GuardrailsService } = {};
    const moduleRef = {
      get(token: unknown) {
        assert.equal(token, GuardrailsService);
        assert.ok(resolved.guardrails);
        return resolved.guardrails;
      },
    } as unknown as ModuleRef;
    const guardrails = new GuardrailsService(
      moduleRef,
      { destroyForSession() {} } as unknown as SessionCredentialsService,
      this.provider.router as unknown as SandboxProvider,
      CONFIG,
      provisionLookup(),
      this.audits.service,
      undefined,
      undefined,
      this.diagnostics,
      { isEnabled: () => true } satisfies TaskProvisioningDiagnosticsWriteGatePort,
    );
    resolved.guardrails = guardrails;
    Object.assign(guardrails, {
      gateway,
      tasks: {
        reserveDurableAdmissionCapacity: (input: {
          readonly taskId: string;
          readonly leaseToken: string;
          readonly expectedStatus: TaskStatus;
          readonly expectedLifecycleVersion: number;
        }) => this.store.reserveDurableAdmissionCapacity(input),
      },
    });
    const replayProcessor = new SameClaimReplayProcessor(
      new FencedTaskAdmissionProcessor(moduleRef),
    );
    const worker = new TaskAdmissionWorker(
      this.store,
      replayProcessor,
      this.scheduler,
      this.clock,
      this.leaseTokens,
      {
        ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
        leaseDurationMs: 100,
        renewIntervalMs: 25,
        queuedRetryAfterMs: 10,
        maxAttempts: 4,
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 10,
        retryJitterRatio: 0,
        maxInFlight: 1,
      },
      undefined,
      this.audits.service,
    );
    return { guardrails, replayProcessor, worker };
  }
}

test('restart, expired lease, and bounded retry keep diagnostic attempts separate while readopting one sandbox', async () => {
  const harness = new DiagnosticRecoveryHarness();
  const gateway = new StoryTerminalGateway(1);

  harness.store.failNextCheckpoint('runtime_setup');
  const crashed = harness.replica(gateway);
  await assert.rejects(
    crashed.worker.runOnce(),
    (error: unknown) =>
      error instanceof TaskAdmissionCoordinationError &&
      String(error.cause).includes('checkpoint acknowledgement loss'),
  );
  assert.equal(crashed.replayProcessor.replayChecks, 1);
  assert.equal(harness.store.work.state, 'running');
  assert.equal(harness.diagnostics.attempts[0]?.state, 'active');
  assert.equal(harness.provider.physicalCreates, 1);

  harness.store.expireLease();
  const recovered = harness.replica(gateway);
  assert.equal((await recovered.worker.runOnce()).kind, 'retrying');
  assert.equal(recovered.replayProcessor.replayChecks, 1);
  assert.equal(harness.store.work.state, 'retrying');

  harness.store.advanceToRetry();
  const retried = harness.replica(gateway);
  assert.equal((await retried.worker.runOnce()).kind, 'succeeded');
  assert.equal(retried.replayProcessor.replayChecks, 1);
  assert.equal(harness.store.work.state, 'succeeded');

  assert.deepEqual(
    harness.diagnostics.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      state: attempt.state,
      outcome: attempt.primary?.outcome ?? null,
      cause: attempt.primary?.cause ?? null,
    })),
    [
      {
        attempt: 1,
        state: 'interrupted',
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
      },
      {
        attempt: 2,
        state: 'failed',
        outcome: 'failed',
        cause: 'tls_network_failed',
      },
      {
        attempt: 3,
        state: 'succeeded',
        outcome: 'succeeded',
        cause: null,
      },
    ],
  );
  assert.equal(
    new Set(harness.diagnostics.attempts.map(({ id }) => id)).size,
    3,
  );
  assert.deepEqual(
    harness.diagnostics.attempts.map((attempt) =>
      harness.diagnostics.eventsFor(attempt.attempt).length,
    ),
    [2, 4, 4],
    'same-claim duplicate emits and processing replay add no extra event',
  );
  for (const attempt of harness.diagnostics.attempts) {
    const events = harness.diagnostics.eventsFor(attempt.attempt);
    assert.equal(
      new Set(events.map(({ idempotencyKey }) => idempotencyKey)).size,
      events.length,
    );
    assert.ok(
      events.every(
        (event) =>
          event.attemptId === attempt.id && event.attempt === attempt.attempt,
      ),
      'events remain fenced to their own attempt identity',
    );
  }
  assert.equal(
    hasCompleteEventInvariants(
      harness.diagnostics.attempts[0]!,
      harness.diagnostics.eventsFor(1),
    ),
    false,
    'the interrupted attempt can never claim complete coverage',
  );
  assert.equal(
    harness.diagnostics.coverage(
      harness.store.task.status,
      harness.store.work.state,
    ),
    'partial',
  );

  assert.equal(harness.provider.contexts.length, 3);
  assert.equal(harness.provider.physicalCreates, 1);
  assert.equal(harness.provider.physicalResources.size, 1);
  const ownerships = harness.provider.contexts.map(({ ownership }) => ownership);
  assert.ok(ownerships.every(Boolean));
  assert.equal(
    new Set(ownerships.map((owner) => owner?.resourceGeneration)).size,
    1,
    'all new admission claims readopt the same physical generation',
  );
  assert.equal(
    new Set(ownerships.map((owner) => owner?.ownerGeneration)).size,
    3,
    'each newly claimed lease receives a distinct ownership generation',
  );
  const activeOwners = await harness.provider.ownerStore.listActiveSandboxRunOwners();
  assert.equal(activeOwners.length, 1);
  assert.deepEqual(activeOwners[0]?.ownership, ownerships[2]);
  assert.ok(harness.provider.readoptionTargets.length >= 2);

  await Promise.resolve();
  assert.equal(harness.audits.upsertCalls, harness.audits.attemptedKeys.length);
  assert.equal(
    harness.audits.events.size,
    new Set(harness.audits.attemptedKeys).size,
    'claim-stage replay is folded into one durable product milestone row',
  );
  const auditAttemptsByKey = new Map<string, number>();
  for (const key of harness.audits.attemptedKeys) {
    auditAttemptsByKey.set(key, (auditAttemptsByKey.get(key) ?? 0) + 1);
  }
  assert.ok(
    [...auditAttemptsByKey.values()].every((count) => count <= 2),
    'same-claim processing replay cannot multiply milestone writes',
  );
  assert.ok(
    [...harness.audits.events.keys()].every((key) =>
      key.startsWith(`task.provisioning:${TASK_ID}:`),
    ),
  );
  const diagnosticIds = harness.diagnostics.attempts.map(({ id }) => id);
  const auditJson = JSON.stringify([...harness.audits.events.values()]);
  assert.ok(diagnosticIds.every((id) => !auditJson.includes(id)));

  const latestAttempt = harness.diagnostics.attempts[2]!;
  const latestContext = contextFromAttempt(latestAttempt);
  const retainedEvent = harness.diagnostics.eventsFor(3)[0]!;
  const driftedReplay = await harness.diagnostics.appendEvent(latestContext, {
    ...retainedEvent,
    eventId: randomUUID(),
    sequence: harness.diagnostics.eventsFor(3).length + 1,
    providerFamily: retainedEvent.providerFamily === 'boxlite' ? 'aio' : 'boxlite',
    observedAt: new Date(retainedEvent.observedAt.getTime() + 1),
  });
  assert.equal(driftedReplay.ok, false);
  assert.equal(
    driftedReplay.ok ? null : driftedReplay.code,
    'immutable_evidence_conflict',
  );
  const logicalReplay = await harness.diagnostics.appendEvent(latestContext, {
    ...retainedEvent,
    eventId: randomUUID(),
    idempotencyKey: `${retainedEvent.idempotencyKey}:drift`,
    sequence: harness.diagnostics.eventsFor(3).length + 1,
    observedAt: new Date(retainedEvent.observedAt.getTime() + 1),
  });
  assert.equal(logicalReplay.ok, false);
  assert.equal(
    logicalReplay.ok ? null : logicalReplay.code,
    'immutable_evidence_conflict',
  );
  assert.equal(harness.diagnostics.eventsFor(3).length, 4);
});

test('diagnostic primary write failure leaves the admission result authoritative and coverage honest', async () => {
  const harness = new DiagnosticRecoveryHarness();
  harness.diagnostics.failPrimaryAttempts.add(1);
  const replica = harness.replica(new StoryTerminalGateway(0));

  assert.equal((await replica.worker.runOnce()).kind, 'succeeded');
  assert.equal(harness.store.work.state, 'succeeded');
  assert.equal(harness.provider.physicalCreates, 1);
  assert.equal(replica.replayProcessor.replayChecks, 1);
  assert.equal(harness.diagnostics.primaryWriteFailures, 1);
  assert.equal(harness.diagnostics.attempts.length, 1);
  assert.equal(harness.diagnostics.attempts[0]?.state, 'active');
  assert.equal(harness.diagnostics.attempts[0]?.primary, null);
  assert.equal(harness.diagnostics.eventsFor(1).length, 4);
  assert.equal(
    harness.diagnostics.coverage(
      harness.store.task.status,
      harness.store.work.state,
    ),
    'partial',
    'failed evidence persistence cannot fabricate complete coverage',
  );
});

test('cancellation supersedes a blocked claim without a late diagnostic settlement or duplicate sandbox', async () => {
  const harness = new DiagnosticRecoveryHarness();
  const gateway = new StoryTerminalGateway(0, true);
  const replica = harness.replica(gateway);
  const processing = replica.worker.runOnce();
  await within(gateway.entered.promise, 1_000, 'blocked terminal gateway entry');

  harness.store.cancelTask();
  replica.worker.abortTask(TASK_ID);
  assert.equal((await processing).kind, 'lease-lost');
  assert.equal(replica.replayProcessor.replayChecks, 1);
  assert.equal(harness.store.task.status, 'cancelled');
  assert.equal(harness.store.work.state, 'running');
  assert.equal(harness.provider.physicalCreates, 1);
  assert.equal(harness.provider.physicalResources.size, 1);
  assert.equal(harness.diagnostics.attempts.length, 1);
  assert.equal(harness.diagnostics.attempts[0]?.state, 'active');
  assert.equal(harness.diagnostics.attempts[0]?.primary, null);
  assert.equal(harness.diagnostics.eventsFor(1).length, 2);
  assert.equal(
    harness.diagnostics.coverage(
      harness.store.task.status,
      harness.store.work.state,
    ),
    'partial',
    'the superseded worker cannot invent a cancellation/cleanup result',
  );
});
