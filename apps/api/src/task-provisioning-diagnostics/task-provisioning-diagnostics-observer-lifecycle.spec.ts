import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import type {
  BeginTaskProvisioningDiagnosticObserverInput,
  BegunTaskProvisioningDiagnosticObserver,
  ResumeTaskProvisioningDiagnosticObserverInput,
} from './task-provisioning-diagnostic-observer.adapter';
import {
  TASK_PROVISIONING_DIAGNOSTIC_RECORDER,
  type BeginTaskProvisioningDiagnosticAttempt,
  type ResumeTaskProvisioningDiagnosticAttempt,
  type TaskProvisioningDiagnosticAttemptContext,
  type TaskProvisioningDiagnosticRecorderPort,
} from './task-provisioning-diagnostic-recorder.port';
import {
  TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
  type TaskProvisioningDiagnosticsWriteGatePort,
} from './task-provisioning-diagnostics-write-gate.port';
import { TaskProvisioningDiagnosticsModule } from './task-provisioning-diagnostics.module';
import {
  TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE,
  TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS,
  TaskProvisioningDiagnosticsObserverLifecycle,
  taskProvisioningDiagnosticWriteTimeoutMs,
  type TaskProvisioningDiagnosticsObserverLifecyclePort,
} from './task-provisioning-diagnostics-observer-lifecycle.port';
import { TaskProvisioningDiagnosticsObserverLifecycleService } from './task-provisioning-diagnostics-observer-lifecycle.service';

const TASK_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000001';

/**
 * A write bound far below the store's settle time, so "the bound fired" and
 * "the write finished" can never be confused by a slow machine.
 */
const WRITE_BOUND_MS = 5;
const SLOW_WRITE_MS = 250;

const CONTEXT: TaskProvisioningDiagnosticAttemptContext = Object.freeze({
  taskId: TASK_ID,
  attemptId: ATTEMPT_ID,
  attempt: 3,
  admissionMode: 'durable' as const,
});

const BEGIN_INPUT: BeginTaskProvisioningDiagnosticObserverInput =
  Object.freeze({
    taskId: TASK_ID,
    admissionMode: 'durable' as const,
  });

const RESUME_INPUT: ResumeTaskProvisioningDiagnosticObserverInput =
  Object.freeze({
    taskId: TASK_ID,
    admissionMode: 'durable' as const,
    attempt: 3,
  });

interface RecorderHarness {
  readonly recorder: TaskProvisioningDiagnosticRecorderPort;
  readonly beganWith: BeginTaskProvisioningDiagnosticAttempt[];
  readonly resumedWith: ResumeTaskProvisioningDiagnosticAttempt[];
}

/**
 * A recorder that answers both boundaries successfully. `delayMs` models a
 * store that commits after the caller's evidence bound has already expired;
 * `throwOn` models one that fails outright.
 */
function recorderDouble(
  options: {
    readonly delayMs?: number;
    readonly throwOn?: 'begin' | 'resume';
    readonly failOn?: 'begin' | 'resume';
  } = {},
): RecorderHarness {
  const beganWith: BeginTaskProvisioningDiagnosticAttempt[] = [];
  const resumedWith: ResumeTaskProvisioningDiagnosticAttempt[] = [];
  const failure = {
    ok: false as const,
    code: 'diagnostic_write_failed' as const,
    safeCause: 'diagnostic_write_failed' as const,
  };
  const settle = async () => {
    if (options.delayMs === undefined) return;
    // Deliberately NOT unref'd: a real store write holds the loop open, and the
    // detached-write assertions below observe what arrives after the bound.
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  };

  const recorder = {
    async beginAttempt(input: BeginTaskProvisioningDiagnosticAttempt) {
      beganWith.push(input);
      await settle();
      if (options.throwOn === 'begin') throw new Error('recorder exploded');
      if (options.failOn === 'begin') return failure;
      return { ok: true as const, value: CONTEXT };
    },
    async resumeAttempt(input: ResumeTaskProvisioningDiagnosticAttempt) {
      resumedWith.push(input);
      await settle();
      if (options.throwOn === 'resume') throw new Error('recorder exploded');
      if (options.failOn === 'resume') return failure;
      return {
        ok: true as const,
        value: {
          context: CONTEXT,
          state: 'active' as const,
          providerFamily: null,
          initialSequence: 0,
        },
      };
    },
    async appendEvent() {
      return failure;
    },
    async recordPrimary() {
      return failure;
    },
    async recordCleanup() {
      return failure;
    },
    async markComplete() {
      return failure;
    },
    async upsertPartialAttempt() {
      return failure;
    },
  } as unknown as TaskProvisioningDiagnosticRecorderPort;

  return { recorder, beganWith, resumedWith };
}

const openGate: TaskProvisioningDiagnosticsWriteGatePort = {
  isEnabled: () => true,
};
const closedGate: TaskProvisioningDiagnosticsWriteGatePort = {
  isEnabled: () => false,
};
const throwingGate: TaskProvisioningDiagnosticsWriteGatePort = {
  isEnabled: () => {
    throw new Error('gate exploded');
  },
};

function owner(options: {
  readonly recorder?: TaskProvisioningDiagnosticRecorderPort;
  readonly writeGate?: TaskProvisioningDiagnosticsWriteGatePort;
  readonly writeTimeoutMs?: number;
}): TaskProvisioningDiagnosticsObserverLifecyclePort {
  return new TaskProvisioningDiagnosticsObserverLifecycle(options);
}

describe('task provisioning diagnostics observer lifecycle', () => {
  it('answers no observer on all three closed paths without reaching the recorder', async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly harness: RecorderHarness;
      readonly owner: TaskProvisioningDiagnosticsObserverLifecyclePort;
    }> = [
      (() => {
        const harness = recorderDouble();
        return {
          name: 'closed gate',
          harness,
          owner: owner({ recorder: harness.recorder, writeGate: closedGate }),
        };
      })(),
      (() => {
        const harness = recorderDouble();
        return {
          name: 'absent gate',
          harness,
          owner: owner({ recorder: harness.recorder }),
        };
      })(),
      (() => {
        const harness = recorderDouble();
        return {
          name: 'throwing gate',
          harness,
          owner: owner({ recorder: harness.recorder, writeGate: throwingGate }),
        };
      })(),
    ];

    for (const { name, harness, owner: lifecycle } of cases) {
      let begun: BegunTaskProvisioningDiagnosticObserver | undefined;
      assert.equal(
        await lifecycle.tryBegin(BEGIN_INPUT, {
          onBegun: (attempt) => {
            begun = attempt;
          },
        }),
        undefined,
        name,
      );
      assert.equal(await lifecycle.tryResume(RESUME_INPUT), undefined, name);
      assert.equal(begun, undefined, name);
      assert.deepEqual(harness.beganWith, [], name);
      assert.deepEqual(harness.resumedWith, [], name);
    }
  });

  it('answers no observer when the recorder itself is unbound', async () => {
    const gateReads: string[] = [];
    const countingGate: TaskProvisioningDiagnosticsWriteGatePort = {
      isEnabled: () => {
        gateReads.push('read');
        return true;
      },
    };

    for (const lifecycle of [
      owner({ writeGate: countingGate }),
      owner({}),
    ]) {
      assert.equal(await lifecycle.tryBegin(BEGIN_INPUT), undefined);
      assert.equal(await lifecycle.tryResume(RESUME_INPUT), undefined);
    }
    assert.deepEqual(gateReads, []);
  });

  it('begins an observer under the recorder-allocated attempt identity when the gate is open', async () => {
    const harness = recorderDouble();
    const lifecycle = owner({
      recorder: harness.recorder,
      writeGate: openGate,
    });
    const begun: BegunTaskProvisioningDiagnosticObserver[] = [];

    const attempt = await lifecycle.tryBegin(BEGIN_INPUT, {
      onBegun: (observer) => {
        begun.push(observer);
      },
    });

    assert.ok(attempt);
    assert.deepEqual(attempt.context, CONTEXT);
    assert.equal(begun.length, 1);
    assert.equal(begun[0], attempt);
    assert.equal(harness.beganWith.length, 1);
    assert.equal(harness.beganWith[0]?.taskId, TASK_ID);
    assert.equal(harness.beganWith[0]?.admissionMode, 'durable');
    assert.equal(harness.beganWith[0]?.expectedAttempt, undefined);
  });

  it('resumes exactly the persisted attempt the caller proved it owns', async () => {
    const harness = recorderDouble();
    const lifecycle = owner({
      recorder: harness.recorder,
      writeGate: openGate,
    });

    const resumed = await lifecycle.tryResume(RESUME_INPUT);

    assert.ok(resumed);
    assert.equal(resumed.state, 'active');
    assert.deepEqual(resumed.context, CONTEXT);
    assert.deepEqual(harness.resumedWith, [
      { taskId: TASK_ID, admissionMode: 'durable', attempt: 3 },
    ]);
  });

  it('bounds the begin write and hands a late attempt to the caller continuation', async () => {
    const harness = recorderDouble({ delayMs: SLOW_WRITE_MS });
    const lifecycle = owner({
      recorder: harness.recorder,
      writeGate: openGate,
      writeTimeoutMs: WRITE_BOUND_MS,
    });
    let settleDetached: (
      attempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    ) => void = () => {};
    const detached = new Promise<
      BegunTaskProvisioningDiagnosticObserver | undefined
    >((resolve) => {
      settleDetached = resolve;
    });

    const startedAt = Date.now();
    const attempt = await lifecycle.tryBegin(BEGIN_INPUT, {
      onDetachedWrite: (late) => {
        settleDetached(late);
      },
    });

    assert.equal(attempt, undefined);
    assert.ok(Date.now() - startedAt < SLOW_WRITE_MS);
    const late = await detached;
    assert.ok(late);
    assert.deepEqual(late.context, CONTEXT);
  });

  it('bounds the resume write with the same no-observer answer', async () => {
    const harness = recorderDouble({ delayMs: SLOW_WRITE_MS });
    const lifecycle = owner({
      recorder: harness.recorder,
      writeGate: openGate,
      writeTimeoutMs: WRITE_BOUND_MS,
    });

    const startedAt = Date.now();
    assert.equal(await lifecycle.tryResume(RESUME_INPUT), undefined);
    assert.ok(Date.now() - startedAt < SLOW_WRITE_MS);
    assert.equal(harness.resumedWith.length, 1);
  });

  it('swallows a throwing or failing recorder into the same result', async () => {
    for (const options of [{ throwOn: 'begin' as const }, { failOn: 'begin' as const }]) {
      const harness = recorderDouble(options);
      const lifecycle = owner({
        recorder: harness.recorder,
        writeGate: openGate,
      });
      assert.equal(await lifecycle.tryBegin(BEGIN_INPUT), undefined);
    }

    for (const options of [
      { throwOn: 'resume' as const },
      { failOn: 'resume' as const },
    ]) {
      const harness = recorderDouble(options);
      const lifecycle = owner({
        recorder: harness.recorder,
        writeGate: openGate,
      });
      assert.equal(await lifecycle.tryResume(RESUME_INPUT), undefined);
    }
  });

  it('treats a throwing continuation as a failed bounded write rather than a caller error', async () => {
    const harness = recorderDouble();
    const lifecycle = owner({
      recorder: harness.recorder,
      writeGate: openGate,
    });
    let settleDetached: (
      attempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    ) => void = () => {};
    const detached = new Promise<
      BegunTaskProvisioningDiagnosticObserver | undefined
    >((resolve) => {
      settleDetached = resolve;
    });

    const attempt = await lifecycle.tryBegin(BEGIN_INPUT, {
      onBegun: () => {
        throw new Error('caller exploded');
      },
      onDetachedWrite: (late) => {
        settleDetached(late);
      },
    });

    assert.equal(attempt, undefined);
    const late = await detached;
    assert.ok(late);
    assert.deepEqual(late.context, CONTEXT);
  });

  it('keeps the default write bound for an absent or nonsensical configuration', () => {
    assert.equal(TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS, 2_000);
    for (const configured of [undefined, 0, -1, 1.5, Number.NaN]) {
      assert.equal(
        taskProvisioningDiagnosticWriteTimeoutMs(configured),
        TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS,
      );
    }
    assert.equal(taskProvisioningDiagnosticWriteTimeoutMs(10), 10);
  });

  it('resolves from the container against its bound collaborators', async () => {
    const harness = recorderDouble();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TaskProvisioningDiagnosticsObserverLifecycleService,
        {
          provide: TASK_PROVISIONING_DIAGNOSTIC_RECORDER,
          useValue: harness.recorder,
        },
        { provide: TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE, useValue: openGate },
        {
          provide: TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE,
          useExisting: TaskProvisioningDiagnosticsObserverLifecycleService,
        },
      ],
    }).compile();

    const lifecycle = moduleRef.get<TaskProvisioningDiagnosticsObserverLifecyclePort>(
      TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE,
    );
    const attempt = await lifecycle.tryBegin(BEGIN_INPUT);

    assert.ok(attempt);
    assert.deepEqual(attempt.context, CONTEXT);
    await moduleRef.close();
  });

  it('resolves with every collaborator unbound and answers no observer', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TaskProvisioningDiagnosticsObserverLifecycleService],
    }).compile();

    const lifecycle = moduleRef.get(
      TaskProvisioningDiagnosticsObserverLifecycleService,
    );

    // The container binding and the injector-less route are one implementation.
    assert.ok(lifecycle instanceof TaskProvisioningDiagnosticsObserverLifecycle);
    assert.equal(await lifecycle.tryBegin(BEGIN_INPUT), undefined);
    assert.equal(await lifecycle.tryResume(RESUME_INPUT), undefined);
    await moduleRef.close();
  });

  it('is provided and exported by the global diagnostics module under its port token', () => {
    const providers = (Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      TaskProvisioningDiagnosticsModule,
    ) ?? []) as readonly unknown[];
    const exports = (Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      TaskProvisioningDiagnosticsModule,
    ) ?? []) as readonly unknown[];
    const binding = providers.find(
      (provider): provider is { provide: unknown; useExisting?: unknown } =>
        provider !== null &&
        typeof provider === 'object' &&
        'provide' in provider &&
        (provider as { provide: unknown }).provide ===
          TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE,
    );

    assert.equal(
      providers.includes(TaskProvisioningDiagnosticsObserverLifecycleService),
      true,
    );
    assert.equal(
      binding?.useExisting,
      TaskProvisioningDiagnosticsObserverLifecycleService,
    );
    assert.equal(
      exports.includes(TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE),
      true,
    );
  });
});
