/**
 * Domain event publishing from the guardrails orchestrator (add-domain-event-bus 4.12).
 *
 * A NEW file on purpose. Publishing is new behaviour, so no pre-existing test can
 * cover it — and the pre-existing tests in this directory are the characterization
 * baseline that proves the change altered nothing else, so they must not be
 * touched. Everything asserted here is about events; every lifecycle assertion
 * these publishes sit next to is already owned by `guardrails.service.spec.ts`.
 *
 * Each publish point gets the same two-part assertion: it fired exactly once, and
 * its payload parses against the catalog. Parsing matters because the bus drops
 * (rather than throws on) an invalid payload — a publish site that built a subtly
 * wrong object would otherwise look identical to one that works.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DomainEventSchema,
  type DomainEvent,
  type DomainEventType,
  type TaskStatus,
} from '@cap-console/contracts';
import type { ModuleRef } from '@nestjs/core';
import type { SessionCredentialsService } from '@/creds/session-credentials.service';
import type { AdmissionTransitionResult } from '@/tasks/tasks.service';
import type {
  SandboxConnection,
  SandboxProvider,
} from '@/sandbox/sandbox-provider.port';
import type { ProvisionLookup } from '@/provision-lookup/provision-lookup.port';
import type { SandboxProvisionContext } from '@cap-console/sandbox';
import {
  DOMAIN_EVENT_BUS,
  type DomainEventBusPort,
} from '@/domain-events/domain-event-bus.port';
import { domainEventBusBindings } from '@/domain-events/domain-events.module';
import { evaluateDomainEventPublishing } from '@/domain-events/domain-event-publishing-cutover.port';
import { GuardrailsService, type GuardrailsConfig } from './guardrails.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
  diagnosticWriteTimeoutMs: 10,
};

const DEFAULT_PROVISION_LOOKUP: ProvisionLookup = {
  async getTaskLaunchContext() {
    return {
      modelIntent: { kind: 'runtime-default' },
      ownerUserId: USER_ID,
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      workspaceMaterializationDeadlineMs: 900_000,
    };
  },
  async getCloneSpec() {
    return null;
  },
  async getTaskPrompt() {
    return null;
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

/**
 * A bus that records what it was handed, and validates nothing itself.
 *
 * Validation is deliberately left to the assertions below rather than done here:
 * the real bus swallows an invalid payload, so a recorder that silently dropped
 * one would reproduce the very blind spot these tests exist to remove.
 */
type EventOfType<TType extends DomainEventType> = Extract<
  DomainEvent,
  { type: TType }
>;

function recordingBus() {
  const published: DomainEvent[] = [];
  return {
    bus: {
      publish(event: DomainEvent) {
        published.push(event);
      },
      subscribe() {},
    } as DomainEventBusPort,
    published,
    /** Narrowed by the same discriminant the bus dispatches on. */
    of<TType extends DomainEventType>(type: TType): EventOfType<TType>[] {
      return published.filter(
        (event): event is EventOfType<TType> => event.type === type,
      );
    },
  };
}

/** Every recorded event must survive the catalog it claims to belong to. */
function assertAllParse(published: readonly DomainEvent[]): void {
  for (const event of published) {
    DomainEventSchema.parse(event);
  }
}

type Transition = (
  taskId: string,
  next: Extract<TaskStatus, 'queued' | 'running'>,
  userId?: string,
  transitionToken?: string,
) => Promise<AdmissionTransitionResult>;

function buildService(
  transition: Transition,
  options: {
    bus?: DomainEventBusPort;
    sandbox?: SandboxProvider;
    isCurrent?: (
      taskId: string,
      next: 'queued' | 'running',
      transitionToken: string,
    ) => Promise<boolean>;
  } = {},
): GuardrailsService {
  // ELEVEN positional arguments: the bus is passed as the trailing one, which is
  // the same construction shape the nine out-of-directory specs use minus this
  // last argument. If the bus ever stops being last, this line stops compiling.
  const service = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    options.sandbox,
    CONFIG,
    DEFAULT_PROVISION_LOOKUP,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.bus,
  );
  Object.assign(service, {
    tasks: {
      transitionForAdmission: transition,
      isAdmissionTransitionCurrent: options.isCurrent,
    },
  });
  return service;
}

function provisioningSandbox(
  connection: Partial<SandboxConnection> = {},
): SandboxProvider {
  return {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      return {
        taskId: context.taskId,
        baseUrl: 'http://127.0.0.1:8080',
        wsUrl: 'ws://127.0.0.1:8080/ws',
        ...connection,
      };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
}

test('a legacy admission publishes one TaskAdmitted, one TaskRunStarted, and one SandboxProvisioned', async () => {
  const recorder = recordingBus();
  const service = buildService(async () => 'transitioned', {
    bus: recorder.bus,
    sandbox: provisioningSandbox(),
    isCurrent: async () => true,
  });

  assert.equal(await service.admit(TASK_ID, { userId: USER_ID }), 'running');

  assertAllParse(recorder.published);

  const admitted = recorder.of('task.admitted');
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]?.admissionMode, 'legacy');
  assert.equal(admitted[0]?.outcome, 'running');
  // The token is the one that fenced the transition, not a second one minted for
  // the event: a non-empty token here plus the schema's `min(1)` is what stops a
  // publish site from quietly shipping `undefined`.
  assert.equal(typeof admitted[0]?.fenceToken, 'string');
  assert.equal(admitted[0]?.taskId, TASK_ID);

  const started = recorder.of('task.run_started');
  assert.equal(started.length, 1);
  assert.equal(started[0]?.startPoint, 'legacy_capacity');
  assert.equal(started[0]?.admissionMode, 'legacy');

  const provisioned = recorder.of('sandbox.provisioned');
  assert.equal(provisioned.length, 1);
  assert.equal(provisioned[0]?.admissionMode, 'legacy');
  assert.equal(provisioned[0]?.sandbox.baseUrl, 'http://127.0.0.1:8080');
  assert.equal(provisioned[0]?.sandbox.wsUrl, 'ws://127.0.0.1:8080/ws');
  // Enough for a subscriber to record the provisioning WITHOUT calling back into
  // guardrails — which is the dependency these events exist to cut.
  assert.equal(provisioned[0]?.environment.runtimeId, 'codex');
  assert.equal(provisioned[0]?.environment.executionMode, 'interactive-pty');
  assert.equal(provisioned[0]?.providerFamily, 'unknown');

  // Every eventId is distinct, which is what lets a later change de-duplicate
  // during the window where a subscriber and the direct call both run.
  const ids = new Set(recorder.published.map((event) => event.eventId));
  assert.equal(ids.size, recorder.published.length);
});

test('concurrent admit calls that join one in-flight admission publish TaskAdmitted once', async () => {
  const recorder = recordingBus();
  const service = buildService(async () => 'transitioned', {
    bus: recorder.bus,
    sandbox: provisioningSandbox(),
    isCurrent: async () => true,
  });

  const [first, second] = await Promise.all([
    service.admit(TASK_ID, { userId: USER_ID }),
    service.admit(TASK_ID, { userId: USER_ID }),
  ]);

  assert.equal(first, 'running');
  assert.equal(second, 'running');
  assert.equal(recorder.of('task.admitted').length, 1);
  assert.equal(recorder.of('task.run_started').length, 1);
});

test('a queued admission publishes TaskAdmitted with the queued outcome and no run start', async () => {
  const recorder = recordingBus();
  const service = buildService(async () => 'transitioned', {
    bus: recorder.bus,
    sandbox: provisioningSandbox(),
    isCurrent: async () => true,
  });

  // Ceiling is 1: the first task takes the slot, the second is held queued.
  assert.equal(await service.admit(TASK_ID), 'running');
  const queuedTaskId = '44444444-4444-4444-8444-444444444444';
  assert.equal(await service.admit(queuedTaskId), 'queued');

  assertAllParse(recorder.published);
  const queuedAdmission = recorder
    .of('task.admitted')
    .filter((event) => event.taskId === queuedTaskId);
  assert.equal(queuedAdmission.length, 1);
  assert.equal(queuedAdmission[0]?.outcome, 'queued');
  assert.equal(queuedAdmission[0]?.admissionMode, 'legacy');
  // A queued task has not started running, so it must not have a run start.
  assert.equal(
    recorder
      .of('task.run_started')
      .filter((event) => event.taskId === queuedTaskId).length,
    0,
  );
});

test('the terminal fence publishes exactly one TaskSettled carrying the terminal status', async () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const recorder = recordingBus();
    const service = buildService(async () => 'transitioned', {
      bus: recorder.bus,
    });

    service.fenceTerminal(TASK_ID, status);
    // Idempotent by contract — and the publish inherits that idempotency.
    service.fenceTerminal(TASK_ID, status);

    assertAllParse(recorder.published);
    const settled = recorder.of('task.settled');
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.status, status);
    assert.equal(settled[0]?.taskId, TASK_ID);
  }
});

test('a fence with no status settles nothing and publishes nothing', () => {
  const recorder = recordingBus();
  const service = buildService(async () => 'transitioned', {
    bus: recorder.bus,
  });

  service.fenceTerminal(TASK_ID);

  assert.equal(recorder.of('task.settled').length, 0);
});

test('a superseded legacy provisioning tears its runtime down without publishing TaskSettled', async () => {
  const recorder = recordingBus();
  // The admission transition commits and stays current long enough for the run to
  // reach the inline pipeline, which then loses its fence. The pipeline discards
  // the attempt and calls `clearAdmissionRuntime`, whose `recordEnd` is NOT a
  // settlement — the task itself never reached a terminal status here.
  //
  // The counter matters: guardrails re-checks the fence twice before handing off,
  // and a check that fails earlier supersedes inside `startRunning`, which is NOT
  // one of the three declared observation points and correctly publishes nothing.
  let fenceChecks = 0;
  const service = buildService(async () => 'transitioned', {
    bus: recorder.bus,
    sandbox: provisioningSandbox(),
    isCurrent: async () => {
      fenceChecks += 1;
      return fenceChecks <= 2;
    },
  });

  await service.admit(TASK_ID).catch(() => undefined);

  assertAllParse(recorder.published);
  assert.equal(recorder.of('task.settled').length, 0);
  // A discarded attempt provisioned nothing anybody may observe.
  assert.equal(recorder.of('sandbox.provisioned').length, 0);
  // And the whole run reports its supersession exactly once, however many
  // internal fence checks it passed on the way out.
  assert.equal(recorder.of('task.superseded').length, 1);
  assert.equal(
    recorder.of('task.superseded')[0]?.observationPoint,
    'inline_pipeline_run',
  );
});

test('a failing provision publishes no SandboxProvisioned', async () => {
  const recorder = recordingBus();
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision() {
      throw new Error('provider exploded');
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    bus: recorder.bus,
    sandbox,
    isCurrent: async () => true,
  });

  await service.admit(TASK_ID).catch(() => undefined);

  assert.equal(recorder.of('sandbox.provisioned').length, 0);
});

test('readoption publishes one TaskRunStarted with no fabricated admission mode', async () => {
  const recorder = recordingBus();
  const service = buildService(async () => 'transitioned', {
    bus: recorder.bus,
  });
  Object.assign(service, {
    gateway: {
      openSession: () => ({
        launchDecision: Promise.resolve({ kind: 'attached' as const }),
      }),
      unregisterSession() {},
    },
  });

  const result = await service.readopt(TASK_ID, {
    taskId: TASK_ID,
    baseUrl: 'http://127.0.0.1:8080',
    wsUrl: 'ws://127.0.0.1:8080/ws',
  });

  assert.equal(result, 'attached');
  assertAllParse(recorder.published);
  const started = recorder.of('task.run_started');
  assert.equal(started.length, 1);
  assert.equal(started[0]?.startPoint, 'readoption');
  // Recovery genuinely does not know which path admitted the run before the
  // restart. Reporting a mode here would be invented data, so the field is absent.
  assert.equal(started[0]?.admissionMode, undefined);
});

test('arming the durable runtime publishes one TaskRunStarted and re-arming publishes none', async () => {
  const recorder = recordingBus();
  const service = buildService(async () => 'transitioned', {
    bus: recorder.bus,
  });
  const lease = { authorize: async () => {} };
  const armDurableRuntime = (
    service as unknown as {
      armDurableRuntime: (taskId: string, lease: unknown) => Promise<void>;
    }
  ).armDurableRuntime.bind(service);

  await armDurableRuntime(TASK_ID, lease);
  await armDurableRuntime(TASK_ID, lease);

  assertAllParse(recorder.published);
  const started = recorder.of('task.run_started');
  assert.equal(started.length, 1);
  assert.equal(started[0]?.startPoint, 'durable_arm');
  assert.equal(started[0]?.admissionMode, 'durable');
});

test('a throwing bus does not disturb the terminal fence', () => {
  const service = buildService(async () => 'transitioned', {
    bus: {
      publish() {
        throw new Error('subscriber storm');
      },
      subscribe() {},
    } as DomainEventBusPort,
  });

  // The fence must complete normally: no throw reaches this caller, and the
  // lifecycle bookkeeping it performs is unaffected by the failed publish.
  service.fenceTerminal(TASK_ID, 'completed');
  assert.equal(service.runningCount, 0);
});

test('with no bus injected the same lifecycle runs without a null reference', async () => {
  const service = buildService(async () => 'transitioned', {
    sandbox: provisioningSandbox(),
    isCurrent: async () => true,
  });

  assert.equal(await service.admit(TASK_ID, { userId: USER_ID }), 'running');
  service.fenceTerminal(TASK_ID, 'completed');
});

test('the escape hatch runs a full lifecycle with zero publishes', async () => {
  // The whole chain, end to end, rather than an assertion about the toggle in
  // isolation: escape-hatch value → closed decision → composition root omits the
  // bus provider → the publisher resolves NO bus → zero publish calls.
  //
  // That last step is the reason the escape hatch is built this way. It is not a
  // "publishing off" branch that only executes during a rollback; it is the same
  // `this.bus === undefined` path the 120 untouched specs in this directory
  // already exercise on every run.
  const decision = evaluateDomainEventPublishing({
    CAP_DOMAIN_EVENT_PUBLISHING_ENABLED: '0',
  });
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'escape-hatch');

  const bindings = domainEventBusBindings(decision);
  assert.equal(bindings.exports.includes(DOMAIN_EVENT_BUS), false);

  // Resolve the bus exactly as a publisher would: by token, from what the
  // composition root actually bound. Closed means there is nothing to resolve.
  const recorder = recordingBus();
  const boundBus = bindings.providers.some(
    (provider: unknown) =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === DOMAIN_EVENT_BUS,
  )
    ? recorder.bus
    : undefined;
  assert.equal(boundBus, undefined);

  const service = buildService(async () => 'transitioned', {
    bus: boundBus,
    sandbox: provisioningSandbox(),
    isCurrent: async () => true,
  });

  assert.equal(await service.admit(TASK_ID, { userId: USER_ID }), 'running');
  service.fenceTerminal(TASK_ID, 'completed');

  assert.equal(recorder.published.length, 0);
});

// ---------------------------------------------------------------------------
// Search-type assertions: the DECLARED publish-point counts, pinned to source.
//
// The behavioural tests above prove each declared point fires. These prove no
// UNDECLARED point exists — a fourth run-start publish, or a second settle,
// cannot be added without turning one of these red. That is the whole reason
// D11 enumerates the points rather than describing them.
// ---------------------------------------------------------------------------

// Resolved from the COMPILED location (`dist/guardrails/…`) back to `src`, because
// the assertions below read the source these tests were built from — a check on
// the emitted JavaScript would pass on stale output.
const apiSrc = resolve(__dirname, '..', '..', 'src');
const publisherSources = {
  guardrails: readFileSync(
    join(apiSrc, 'guardrails', 'guardrails.service.ts'),
    'utf8',
  ),
  tasks: readFileSync(join(apiSrc, 'tasks', 'tasks.service.ts'), 'utf8'),
  pipeline: readFileSync(
    join(apiSrc, 'inline-admission', 'inline-admission.pipeline.ts'),
    'utf8',
  ),
};

const countOf = (source: string, eventType: string) =>
  (source.match(new RegExp(`'${eventType}'`, 'g')) ?? []).length;

test('TaskRunStarted is published at exactly three points, all in guardrails', () => {
  assert.equal(countOf(publisherSources.guardrails, 'task\\.run_started'), 3);
  assert.equal(countOf(publisherSources.tasks, 'task\\.run_started'), 0);
  assert.equal(countOf(publisherSources.pipeline, 'task\\.run_started'), 0);
});

test('TaskSettled is published at exactly one point, inside the terminal fence', () => {
  assert.equal(countOf(publisherSources.guardrails, 'task\\.settled'), 1);
  assert.equal(countOf(publisherSources.tasks, 'task\\.settled'), 0);
  assert.equal(countOf(publisherSources.pipeline, 'task\\.settled'), 0);

  // …and that one sits in `fenceTerminal`, not in the admission-runtime teardown
  // whose `recordEnd` looks deceptively like the same moment.
  const fence = publisherSources.guardrails.slice(
    publisherSources.guardrails.indexOf('fenceTerminal(taskId: string'),
    publisherSources.guardrails.indexOf('async onTerminal('),
  );
  assert.match(fence, /'task\.settled'/);

  const teardown = publisherSources.guardrails.slice(
    publisherSources.guardrails.indexOf(
      'private clearAdmissionRuntime(taskId: string)',
    ),
    publisherSources.guardrails.indexOf('private async armDurableRuntime('),
  );
  assert.doesNotMatch(teardown, /publishDomainEvent/);
});

test('no published TaskSuperseded payload names a superseder', () => {
  // The observation points hold no handle on the winner, so any field claiming
  // otherwise would be invented. Pinned as text because the absence of a field
  // is exactly what a type cannot assert.
  for (const source of Object.values(publisherSources)) {
    assert.doesNotMatch(source, /supersededBy|supersederTaskId|winnerToken/);
  }
});
