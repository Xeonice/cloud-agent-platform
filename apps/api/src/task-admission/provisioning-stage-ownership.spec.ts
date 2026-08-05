/**
 * Executable per-stage provisioning-row ownership proof
 * (adjudicate-audit-event-migration, design D5/D6).
 *
 * The question this file answers is NOT "does guardrails still call audit". It
 * is: **for every provisioning stage a provider family reports through
 * `onProvisioningProgress`, is an audit row under the dedupe identity
 * `task.provisioning:{taskId}:{attempt}:{stage}` still written by the admission
 * worker when the orchestrator's audit-only hint is absent?** Only a stage that
 * answers yes may lose the hint at `guardrails.service.ts:1197`.
 *
 * It lives beside the admission worker, not in `apps/api/src/guardrails/`, for
 * two reasons: the guardrails characterization baseline (135 `test()` over 6
 * `*.spec.ts`) is pinned by spec and adding a file there would self-inflict a
 * baseline break, and the subject under proof is the *checkpoint owner*, which
 * is the worker.
 *
 * Honesty constraints held here on purpose:
 *  - The reported stage vocabulary is READ FROM the real provider sources, not
 *    restated. A family that starts reporting a new stage turns this red
 *    without anyone remembering to update a list.
 *  - The admission chain under test is the production one: real
 *    `TaskAdmissionWorker` -> real `FencedTaskAdmissionProcessor` -> real
 *    `GuardrailsService.processDurableAdmission` -> real lease controls. Only
 *    the provider (which needs Docker/BoxLite) and provider-independent
 *    lookups are stubbed.
 *  - The two writers get two SEPARATE recorders, so every row is attributed to
 *    the writer that produced it. "Hint absent" is then a real second run with
 *    no recorder wired into guardrails at all, not a filtered view of one run.
 *
 * What it measured when it was written: both families report exactly
 * `readiness` and `runtime_setup`, and both are worker-owned on a run to
 * completion — `runtime_setup` and `readiness` are projected in the stable
 * provider-neutral order right after `provision(...)` returns, which design D5
 * missed when it predicted `readiness` had no owner. The residual the last
 * assertion pins is WHEN: only a stage crossing a declared provisioning
 * boundary (boxlite `runtime_setup`) is owned during `provision(...)`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import type { TaskProvisioningStage } from '@cap-console/contracts';
import type {
  SandboxProvisionContext,
  SandboxProvisioningProgressStage,
} from '@cap-console/sandbox';
import type { AuditRecorderPort } from '@/audit/audit-recorder.port';
import { AuditService } from '@/audit/audit.service';
import type { PrismaService } from '@/prisma/prisma.service';
import type { SessionCredentialsService } from '@/creds/session-credentials.service';
import type { SandboxProvider } from '@/sandbox/sandbox-provider.port';
import { GuardrailsService } from '@/guardrails/guardrails.service';
import {
  TaskAdmissionStore,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
  type TaskAdmissionSettlement,
} from '@/admission-coordination/task-admission.types';
import { FencedTaskAdmissionProcessor } from './fenced-task-admission.processor';
import {
  DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  TaskAdmissionClock,
  TaskAdmissionLeaseTokenFactory,
  TaskAdmissionScheduler,
  type TaskAdmissionTimer,
} from './task-admission-runtime';
import { TaskAdmissionWorker } from './task-admission.worker';

// ---------------------------------------------------------------------------
// The stage census, read from the real provider sources.
// ---------------------------------------------------------------------------

/**
 * Compiled location is `dist/task-admission/`; the assertions below read the
 * TypeScript the build was made from, because a scan of emitted JavaScript
 * would happily pass against stale output.
 */
const apiSrc = resolve(__dirname, '..', '..', 'src');
const repoRoot = resolve(apiSrc, '..', '..', '..');

const PROVIDER_SOURCES = {
  aio: join(
    repoRoot,
    'packages',
    'sandbox-provider-aio',
    'src',
    'aio-provider.ts',
  ),
  boxlite: join(
    repoRoot,
    'packages',
    'sandbox-provider-boxlite',
    'src',
    'boxlite-provider.ts',
  ),
} as const;

type ProviderFamily = keyof typeof PROVIDER_SOURCES;

/** One provisioning callback the provider makes, in source order. */
interface ProviderStageEvent {
  readonly kind: 'progress' | 'boundary';
  readonly stage: SandboxProvisioningProgressStage;
  readonly index: number;
}

/**
 * Compile-time tie between the provider-facing stage union and the durable
 * stage vocabulary: widening `SandboxProvisioningProgressStage` beyond a
 * declared provisioning stage turns this red before any assertion runs.
 */
const asProvisioningStage = (
  stage: SandboxProvisioningProgressStage,
): TaskProvisioningStage => stage;

const PROGRESS_CALL =
  /reportSandboxProvisioningProgress\(\s*[\w.?]+\.onProvisioningProgress\s*,\s*\{[^}]*stage:\s*'([a-z_]+)'/g;
const BOUNDARY_CALL =
  /beforeProvisioningBoundary\?\.\(\s*\{[^}]*stage:\s*'([a-z_]+)'/g;

function providerStageEvents(family: ProviderFamily): ProviderStageEvent[] {
  const source = readFileSync(PROVIDER_SOURCES[family], 'utf8');
  const events: ProviderStageEvent[] = [];
  for (const [pattern, kind] of [
    [PROGRESS_CALL, 'progress'],
    [BOUNDARY_CALL, 'boundary'],
  ] as const) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      events.push({
        kind,
        stage: match[1] as SandboxProvisioningProgressStage,
        index: match.index ?? 0,
      });
    }
  }
  return events.sort((left, right) => left.index - right.index);
}

function stagesOf(
  events: readonly ProviderStageEvent[],
  kind: ProviderStageEvent['kind'],
): Set<TaskProvisioningStage> {
  return new Set(
    events
      .filter((event) => event.kind === kind)
      .map((event) => asProvisioningStage(event.stage)),
  );
}

const sortedStages = (stages: Iterable<TaskProvisioningStage>): string[] =>
  [...stages].sort();

// ---------------------------------------------------------------------------
// Minimal durable-work store: enough authority for one healthy claim.
// ---------------------------------------------------------------------------

const STAGES = [
  'accepted',
  'sandbox_creation',
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_setup',
  'readiness',
  'agent_launch',
  'complete',
] as const satisfies readonly TaskProvisioningStage[];

const stageIndex = (stage: TaskProvisioningStage): number =>
  STAGES.indexOf(stage);

class ManualClock extends TaskAdmissionClock {
  constructor(private currentMs = 0) {
    super();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  get value(): number {
    return this.currentMs;
  }
}

class ImmediateScheduler extends TaskAdmissionScheduler {
  schedule(_delayMs: number, _callback: () => void): TaskAdmissionTimer {
    // Lease renewal is not the subject here; a claim that never renews is
    // exactly the healthy short claim this proof drives.
    return { cancel() {} };
  }
}

class SequenceLeaseTokens extends TaskAdmissionLeaseTokenFactory {
  private sequence = 0;

  create(): string {
    this.sequence += 1;
    return `ownership:${this.sequence}`;
  }
}

/** One durable work row, already holding running capacity. */
interface WorkRow {
  state: TaskAdmissionSettlement['state'] | 'accepted' | 'running';
  attempt: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  stage: TaskProvisioningStage;
  settlement: TaskAdmissionSettlement | null;
}

class SingleRowStore extends TaskAdmissionStore {
  readonly row: WorkRow = {
    state: 'accepted',
    attempt: 0,
    leaseToken: null,
    leaseUntil: null,
    stage: 'accepted',
    settlement: null,
  };

  constructor(
    private readonly taskId: string,
    private readonly clock: ManualClock,
  ) {
    super();
  }

  async claim(
    request: TaskAdmissionClaimRequest,
  ): Promise<TaskAdmissionClaim | null> {
    if (this.row.state !== 'accepted') return null;
    this.row.attempt += 1;
    this.row.state = 'running';
    this.row.leaseToken = request.leaseToken;
    this.row.leaseUntil = this.clock.value + request.leaseDurationMs;
    return Object.freeze({
      taskId: this.taskId,
      leaseToken: request.leaseToken,
      leaseUntil: new Date(this.row.leaseUntil),
      sourceState: 'accepted' as const,
      attempt: this.row.attempt,
      stage: this.row.stage,
      causeCode: null,
      resolvedBranch: 'master',
      resourceSnapshot: Object.freeze({ diskSizeGb: 12 }),
      workspaceMaterializationDeadlineMs: 900_000,
      // Durable running capacity is already held, so the chain enters
      // provisioning without a lifecycle reservation.
      taskStatus: 'running' as const,
      taskLifecycleVersion: 1,
    });
  }

  async authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.owned(request) !== null;
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    const row = this.owned(request);
    if (!row) return false;
    row.leaseUntil = this.clock.value + request.leaseDurationMs;
    return true;
  }

  async checkpoint(request: TaskAdmissionCheckpointRequest): Promise<boolean> {
    const row = this.owned(request);
    if (!row || stageIndex(request.stage) < stageIndex(row.stage)) return false;
    row.stage = request.stage;
    return true;
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    const row = this.owned(request);
    if (!row) return false;
    row.state = request.settlement.state;
    row.stage = request.settlement.stage;
    row.leaseToken = null;
    row.leaseUntil = null;
    row.settlement = request.settlement;
    return true;
  }

  private owned(request: TaskAdmissionAuthorityRequest): WorkRow | null {
    const row = this.row;
    if (
      request.taskId !== this.taskId ||
      row.state !== 'running' ||
      row.leaseToken !== request.leaseToken ||
      row.leaseUntil === null ||
      row.leaseUntil <= this.clock.value
    ) {
      return null;
    }
    return request.taskFences.some(
      (fence) => fence.status === 'running' && fence.lifecycleVersion === 1,
    )
      ? row
      : null;
  }
}

// ---------------------------------------------------------------------------
// Row capture, keyed by the production dedupe identity.
// ---------------------------------------------------------------------------

interface CapturedRow {
  readonly dedupeKey: string;
  readonly stage: TaskProvisioningStage;
  readonly attempt: number;
  /** Position in the run-wide write order, shared across both writers. */
  readonly sequence: number;
}

/** Run-wide write order, so two writers can be compared against each other. */
class WriteOrder {
  private next = 0;

  take(): number {
    this.next += 1;
    return this.next;
  }
}

/**
 * A recorder that builds the SAME dedupe identity the production
 * `AuditService.recordProvisioningProgress` builds, so a captured row is
 * comparable with a persisted one. One instance per writer, which is what
 * makes per-writer attribution possible at all.
 */
class RecordingAudit {
  readonly rows: CapturedRow[] = [];

  constructor(private readonly order: WriteOrder) {}

  readonly port: AuditRecorderPort = {
    recordProvisioningProgress: async (
      taskId: string,
      stage: TaskProvisioningStage,
      attempt: number,
    ) => {
      this.rows.push({
        dedupeKey: `task.provisioning:${taskId}:${attempt}:${stage}`,
        stage,
        attempt,
        sequence: this.order.take(),
      });
    },
  } as unknown as AuditRecorderPort;

  stages(): Set<TaskProvisioningStage> {
    return new Set(this.rows.map((row) => row.stage));
  }

  /** Write order of the FIRST row for `stage`; null when never written. */
  firstWriteOf(stage: TaskProvisioningStage): number | null {
    return this.rows.find((row) => row.stage === stage)?.sequence ?? null;
  }
}

// ---------------------------------------------------------------------------
// The production admission chain, with only the provider stubbed.
// ---------------------------------------------------------------------------

const CONNECTION = {
  taskId: 'stage-ownership',
  baseUrl: 'http://sandbox.test/stage-ownership',
  wsUrl: 'ws://sandbox.test/stage-ownership/ws',
} as const;

/**
 * Ownership stamped onto the provision context by the real chain, read back by
 * the stubbed run lookup so the post-provision re-verification sees THIS
 * attempt. Shared between the provider stub and the service, hence a holder.
 */
interface OwnershipHolder {
  current?: SandboxProvisionContext['ownership'];
}

function buildGuardrails(
  sandbox: SandboxProvider,
  audit: AuditRecorderPort | undefined,
  ownership: OwnershipHolder,
): GuardrailsService {
  const service = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    sandbox,
    {
      maxConcurrentTasks: 2,
      defaultIdleTimeoutMs: null,
      circuitBreakerThreshold: 3,
      diagnosticWriteTimeoutMs: 10,
    },
    undefined,
    audit,
  );
  Object.assign(service, {
    gateway: {
      openSession() {
        return { launchDecision: Promise.resolve({ kind: 'launched' }) };
      },
      unregisterSession() {},
      async readSessionLogTail() {
        return '';
      },
    },
    armDurableRuntime: async () => {},
    resolveProvisionPlan: async () => ({
      cloneSpec: null,
      modelIntent: { kind: 'runtime-default' as const },
      runtimeId: 'codex',
      executionMode: 'interactive-pty' as const,
      // Must match the store's claim snapshot: the durable chain asserts
      // claim/plan consistency before crossing the provider boundary.
      resources: { diskSizeGb: 12 },
      workspace: {
        repositoryUrl: 'https://example.test/repo.git',
        callerBranch: null,
        resolvedBranch: 'master',
        deadlineMs: 900_000,
      },
      requiredCapabilities: [],
    }),
    resolveSelectedRunStrict: async () => ({
      connection: CONNECTION,
      owner: {
        taskId: CONNECTION.taskId,
        providerId: 'sandbox-test',
        providerSandboxId: CONNECTION.taskId,
        ownership: ownership.current,
        status: 'running',
      },
    }),
  });
  return service;
}

interface AdmissionRun {
  readonly hint: RecordingAudit;
  readonly worker: RecordingAudit;
  readonly reported: TaskProvisioningStage[];
  readonly outcome: string;
  readonly finalStage: TaskProvisioningStage;
}

/**
 * Drive one durable admission for `family`, replaying exactly the provisioning
 * callbacks that family makes in its own source order.
 *
 * `hintWired: false` is the "hint removed" world: guardrails gets no recorder
 * at all, so `this.audit?.recordProvisioningProgress(...)` at
 * `guardrails.service.ts:1197` cannot produce a row even though the line is
 * still there. Anything still recorded is worker-owned by construction.
 */
async function runAdmission(args: {
  readonly family: ProviderFamily;
  readonly hintWired: boolean;
}): Promise<AdmissionRun> {
  const events = providerStageEvents(args.family);
  const reported = events
    .filter((event) => event.kind === 'progress')
    .map((event) => event.stage);
  const order = new WriteOrder();
  const hint = new RecordingAudit(order);
  const worker = new RecordingAudit(order);
  const clock = new ManualClock();
  const store = new SingleRowStore(CONNECTION.taskId, clock);

  const ownership: OwnershipHolder = {};
  const sandbox = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      ownership.current = context.ownership;
      for (const event of events) {
        if (event.kind === 'boundary') {
          await context.beforeProvisioningBoundary?.({ stage: event.stage });
        } else {
          context.onProvisioningProgress?.({
            status: 'started',
            stage: event.stage,
          });
        }
      }
      return CONNECTION;
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;

  const guardrails = buildGuardrails(
    sandbox,
    args.hintWired ? hint.port : undefined,
    ownership,
  );
  const admissionWorker = new TaskAdmissionWorker(
    store,
    new FencedTaskAdmissionProcessor({
      get: () => guardrails,
    } as unknown as ModuleRef),
    new ImmediateScheduler(),
    clock,
    new SequenceLeaseTokens(),
    {
      ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
      leaseDurationMs: 60_000,
      renewIntervalMs: 30_000,
      maxInFlight: 1,
    },
    undefined,
    worker.port,
  );

  const outcome = await admissionWorker.runOnce();
  await admissionWorker.stop();
  return {
    hint,
    worker,
    reported,
    outcome: outcome.kind,
    finalStage: store.row.stage,
  };
}

// ---------------------------------------------------------------------------
// The proof.
// ---------------------------------------------------------------------------

test('each provider family reports a non-empty, provider-neutral stage set', () => {
  for (const family of Object.keys(PROVIDER_SOURCES) as ProviderFamily[]) {
    const events = providerStageEvents(family);
    const reported = stagesOf(events, 'progress');
    assert.ok(
      reported.size > 0,
      `${family} reports no provisioning stage; the census regex no longer matches its source`,
    );
    for (const stage of reported) {
      assert.ok(
        stageIndex(stage) >= 0,
        `${family} reports '${stage}', which is not a declared provisioning stage`,
      );
    }
  }
});

test('every stage a provider family reports still has a worker-written row when the hint is absent', async () => {
  const uncovered: string[] = [];
  for (const family of Object.keys(PROVIDER_SOURCES) as ProviderFamily[]) {
    const run = await runAdmission({ family, hintWired: false });
    assert.equal(
      run.outcome,
      'succeeded',
      `${family}: the admission chain must reach completion for this proof to mean anything`,
    );
    assert.equal(run.finalStage, 'complete');
    assert.equal(
      run.hint.rows.length,
      0,
      `${family}: the hint must write nothing in the hint-absent world`,
    );
    const owned = run.worker.stages();
    for (const stage of run.reported) {
      if (!owned.has(stage)) uncovered.push(`${family}:${stage}`);
    }
  }
  assert.deepEqual(
    uncovered,
    [],
    `provisioning stages with no admission-worker owner once the ` +
      `guardrails.service.ts:1197 hint is gone: ${uncovered.join(', ')}. ` +
      `Each one would silently drop out of the task history timeline, so the ` +
      `hint must be retained and adjudicated CALL.`,
  );
});

test('removing the hint changes nothing about which rows the worker writes', async () => {
  for (const family of Object.keys(PROVIDER_SOURCES) as ProviderFamily[]) {
    const withHint = await runAdmission({ family, hintWired: true });
    const withoutHint = await runAdmission({ family, hintWired: false });
    assert.deepEqual(
      sortedStages(withoutHint.worker.stages()),
      sortedStages(withHint.worker.stages()),
      `${family}: the worker's row set must be independent of the audit-only hint`,
    );
    assert.deepEqual(
      sortedStages(withHint.hint.stages()),
      sortedStages(new Set(withHint.reported)),
      `${family}: with the hint wired, it must report exactly the stages the provider reported`,
    );
  }
});

test('a reported stage is owned in-provision only where the family declares a provisioning boundary', async () => {
  // WHEN the owner's row lands is the only difference removing the hint makes,
  // and it is not uniform. A stage the family pushes through
  // `beforeProvisioningBoundary` is checkpointed INSIDE `provision(...)`, so
  // its row survives an attempt that never returns. Every other reported stage
  // is projected only after `provision(...)` returned
  // (`guardrails.service.ts:1245`/`:1247`), so an attempt that throws, is
  // cancelled, or unwinds for a detaching transfer keeps no record of it once
  // the hint is gone. Deriving the split from the census keeps that residual
  // measured rather than remembered.
  const residual: string[] = [];
  for (const family of Object.keys(PROVIDER_SOURCES) as ProviderFamily[]) {
    const events = providerStageEvents(family);
    const boundaryStages = stagesOf(events, 'boundary');
    const run = await runAdmission({ family, hintWired: true });
    for (const stage of run.reported) {
      const hintWrite = run.hint.firstWriteOf(stage);
      const ownerWrite = run.worker.firstWriteOf(stage);
      assert.ok(
        hintWrite !== null,
        `${family}: the wired hint must record the reported stage '${stage}'`,
      );
      assert.ok(
        ownerWrite !== null,
        `${family}: the worker must own a row for the reported stage '${stage}'`,
      );
      if (boundaryStages.has(stage)) {
        assert.ok(
          ownerWrite < hintWrite,
          `${family}: '${stage}' crosses a declared provisioning boundary, so ` +
            `its owner row must already exist when the hint fires`,
        );
      } else {
        assert.ok(
          hintWrite < ownerWrite,
          `${family}: '${stage}' has no declared provisioning boundary, so its ` +
            `owner row is expected only after provision returned`,
        );
        residual.push(`${family}:${stage}`);
      }
    }
  }
  // Measured, not assumed: these are the stages whose only in-provision writer
  // is the hint. They are still owned on a run to completion; they are not
  // owned on an attempt that never returns from `provision(...)`.
  assert.deepEqual(residual, [
    'aio:readiness',
    'aio:runtime_setup',
    'boxlite:readiness',
  ]);
});

test('the worker checkpoint and the composite hint collapse into one row per stage identity', async () => {
  // The real recorder against a store that models the unique `dedupeKey`
  // upsert: two writers, one identity, one row.
  const rows = new Map<string, { readonly type: string; writes: number }>();
  const prisma = {
    auditEvent: {
      async upsert(args: {
        where: { dedupeKey: string };
        create: { type: string };
      }) {
        const existing = rows.get(args.where.dedupeKey);
        if (existing) {
          existing.writes += 1;
          return;
        }
        rows.set(args.where.dedupeKey, { type: args.create.type, writes: 1 });
      },
    },
  } as unknown as PrismaService;
  const audit = new AuditService(prisma);

  const taskId = 'shared-identity';
  const attempt = 3;
  const stage: TaskProvisioningStage = 'runtime_setup';
  // Writer 1: the admission worker's durable checkpoint.
  await audit.recordProvisioningProgress(taskId, stage, attempt);
  // Writer 2: the provider-composite audit-only hint, same identity.
  await audit.recordProvisioningProgress(taskId, stage, attempt);

  assert.equal(rows.size, 1, 'two writers of one identity must leave one row');
  const key = `task.provisioning:${taskId}:${attempt}:${stage}`;
  const row = rows.get(key);
  assert.ok(row, `the row must carry the dedupe identity ${key}`);
  assert.equal(row.type, `task.provisioning:${stage}`);
  assert.equal(
    row.writes,
    2,
    'the second writer must reach the same identity rather than a second row',
  );

  // A different attempt is a different identity: dedupe must not collapse
  // separate attempts into one timeline entry.
  await audit.recordProvisioningProgress(taskId, stage, attempt + 1);
  assert.equal(rows.size, 2);
});
