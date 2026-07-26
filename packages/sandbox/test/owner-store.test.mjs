import assert from 'node:assert/strict';

import {
  InMemorySandboxRunOwnerStore,
  SANDBOX_CLEANUP_ATTEMPT_MAX,
} from '../dist/index.js';
import { planInMemoryCleanupAttempt } from '../dist/provider-center/cleanup-attempt.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

function cleanupEvidence(overrides = {}) {
  return {
    attemptId: '11111111-1111-4111-8111-111111111111',
    attempt: 1,
    outcome: 'succeeded',
    proof: 'already-absent',
    cause: null,
    retryable: false,
    observedAt: new Date('2026-07-19T14:00:00.000Z'),
    ...overrides,
  };
}

function attemptId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function acquireDurableOwner(
  store,
  taskId,
  {
    providerId = 'boxlite',
    providerSandboxId = `${taskId}-sandbox`,
    ownerGeneration = `${taskId}-owner`,
    resourceGeneration = `${taskId}-resource`,
    recordRunning = true,
  } = {},
) {
  const acquired = await store.acquireSandboxRunOwner({
    taskId,
    providerId,
    ownerGeneration,
    proposedResourceGeneration: resourceGeneration,
  });
  assert.equal(acquired.kind, 'acquired');
  if (recordRunning) {
    await store.recordSandboxRunOwner({
      taskId,
      providerId,
      providerSandboxId,
      ownership: acquired.ownership,
      status: 'running',
    });
  }
  return acquired.ownership;
}

await test('legacy create is pre-registered and promoted only after exact observation', async () => {
  const store = new InMemorySandboxRunOwnerStore();

  assert.equal(
    await store.beginSandboxRunCreate({
      taskId: 'task-legacy-fence',
      providerId: 'boxlite',
    }),
    true,
  );
  assert.deepEqual(await store.getSandboxRunOwner('task-legacy-fence'), {
    taskId: 'task-legacy-fence',
    providerId: 'boxlite',
    createState: 'entered',
    status: 'provisioning',
    cleanupAttemptInFlight: false,
    cleanupAttemptCount: 0,
  });
  assert.equal(
    await store.beginSandboxRunCreate({
      taskId: 'task-legacy-fence',
      providerId: 'boxlite',
    }),
    false,
    'a second invocation cannot adopt the first pre-call fence',
  );
  assert.equal(
    await store.validateLegacySandboxRunCreateFence({
      taskId: 'task-legacy-fence',
      providerId: 'boxlite',
    }),
    true,
  );
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-legacy-fence',
      providerId: 'different-provider',
      providerSandboxId: 'box-wrong',
    }),
    false,
  );
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-legacy-fence',
      providerId: 'boxlite',
      providerSandboxId: 'box-observed',
    }),
    true,
  );
  assert.equal(
    await store.validateLegacySandboxRunCreateFence({
      taskId: 'task-legacy-fence',
      providerId: 'boxlite',
    }),
    false,
  );
  await store.recordSandboxRunOwner({
    taskId: 'task-legacy-fence',
    providerId: 'boxlite',
    providerSandboxId: 'box-observed',
    expectedProvisioningFence: 'legacy-create-observed',
  });
  const promoted = await store.getSandboxRunOwner('task-legacy-fence');
  assert.equal(promoted.status, 'running');
  assert.equal(promoted.createState, 'idle');
  assert.equal(promoted.providerSandboxId, 'box-observed');
  assert.equal('expectedProvisioningFence' in promoted, false);
});

await test('post-invocation absence atomically closes only the matching deleting legacy fence', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  await store.beginSandboxRunCreate({
    taskId: 'task-legacy-post-invocation-absent',
    providerId: 'boxlite',
  });
  await store.beginSandboxRunCleanup('task-legacy-post-invocation-absent');

  assert.equal(
    await store.closeLegacySandboxRunCreateFence({
      taskId: 'task-legacy-post-invocation-absent',
      providerId: 'different-provider',
    }),
    false,
  );
  assert.equal(
    await store.closeLegacySandboxRunCreateFence({
      taskId: 'task-legacy-post-invocation-absent',
      providerId: 'boxlite',
    }),
    true,
  );
  const deleting = await store.beginSandboxRunCleanup(
    'task-legacy-post-invocation-absent',
  );
  assert.equal(deleting.kind, 'authorized');
  assert.equal(deleting.owner.createState, 'idle');
  assert.equal(
    await store.closeLegacySandboxRunCreateFence({
      taskId: 'task-legacy-post-invocation-absent',
      providerId: 'boxlite',
    }),
    true,
    'the same exact closure is idempotent',
  );
});

await test('legacy deleting observes the late exact id before cleanup can settle', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  await store.beginSandboxRunCreate({
    taskId: 'task-legacy-entered',
    providerId: 'boxlite',
  });
  const cleanup = await store.beginSandboxRunCleanup('task-legacy-entered');
  assert.equal(cleanup.kind, 'authorized');

  assert.deepEqual(
    await store.settleLegacySandboxRunCleanup({
      taskId: 'task-legacy-entered',
      providerId: 'boxlite',
      disposition: 'superseded-remove',
      status: 'removed',
      evidence: cleanupEvidence(),
    }),
    { kind: 'conflict' },
  );
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-legacy-entered',
      providerId: 'boxlite',
      providerSandboxId: 'box-late',
    }),
    false,
    'deleting persists the exact id but rejects provider success promotion',
  );
  const deleting = await store.beginSandboxRunCleanup('task-legacy-entered');
  assert.equal(deleting.kind, 'authorized');
  assert.equal(deleting.owner.createState, 'idle');
  assert.equal(deleting.owner.providerSandboxId, 'box-late');
  const allocated = await store.beginSandboxRunCleanupAttempt(
    deleting.authorization,
    '22222222-2222-4222-8222-222222222222',
  );
  assert.equal(allocated.kind, 'allocated');
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      deleting.authorization,
      cleanupEvidence({
        attemptId: allocated.evidence.attemptId,
        attempt: allocated.evidence.attempt,
        proof: 'found-and-cleaned',
      }),
    )).kind,
    'recorded',
  );
  assert.equal(
    await store.completeSandboxRunCleanup(
      deleting.authorization,
      'removed',
    ),
    true,
  );
  assert.equal(await store.getSandboxRunOwner('task-legacy-entered'), null);
});

await test('terminal cleanup rejects a late legacy observation and completion', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  await store.beginSandboxRunCreate({
    taskId: 'task-legacy-late',
    providerId: 'boxlite',
  });
  const settled = await store.settleLegacySandboxRunCleanup({
    taskId: 'task-legacy-late',
    providerId: 'boxlite',
    disposition: 'retained',
    status: 'terminal',
    evidence: cleanupEvidence({
      outcome: 'indeterminate',
      proof: null,
      cause: 'cleanup_unconfirmed',
      retryable: true,
    }),
  });
  assert.equal(settled.kind, 'recorded');
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-legacy-late',
      providerId: 'boxlite',
      providerSandboxId: 'box-late',
    }),
    false,
  );
  await assert.rejects(
    store.recordSandboxRunOwner({
      taskId: 'task-legacy-late',
      providerId: 'boxlite',
      providerSandboxId: 'box-late',
      expectedProvisioningFence: 'legacy-create-observed',
    }),
    /Legacy sandbox provisioning fence is no longer current/,
  );
  assert.equal(await store.getSandboxRunOwner('task-legacy-late'), null);
  assert.equal(
    await store.beginSandboxRunCreate({
      taskId: 'task-legacy-late',
      providerId: 'boxlite',
    }),
    false,
    'a late boundary cannot replace settled terminal authority',
  );
});

await test('active-owner listing excludes settled rows and provider acquisition is fenced', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  await store.beginSandboxRunCreate({
    taskId: 'task-list-provisioning',
    providerId: 'boxlite',
  });
  await acquireDurableOwner(store, 'task-list-running');
  await store.recordSandboxRunOwner({
    taskId: 'task-list-terminal',
    providerId: 'boxlite',
    status: 'running',
  });
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'task-list-terminal',
      providerId: 'boxlite',
      disposition: 'retained',
      status: 'terminal',
      evidence: cleanupEvidence({
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
      }),
    })).kind,
    'recorded',
  );

  assert.deepEqual(
    (await store.listActiveSandboxRunOwners())
      .map((owner) => owner.taskId)
      .sort(),
    ['task-list-provisioning', 'task-list-running'],
  );

  const first = await store.acquireSandboxRunOwner({
    taskId: 'task-provider-conflict',
    providerId: 'boxlite',
    ownerGeneration: 'owner-a',
    proposedResourceGeneration: 'resource-a',
  });
  assert.equal(first.kind, 'acquired');
  const conflict = await store.acquireSandboxRunOwner({
    taskId: 'task-provider-conflict',
    providerId: 'aio',
    ownerGeneration: 'owner-b',
    proposedResourceGeneration: 'resource-b',
  });
  assert.equal(conflict.kind, 'conflict');
  assert.equal(conflict.owner.providerId, 'boxlite');
});

await test('durable create admission and observation reject every stale fence', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  const ownership = await acquireDurableOwner(store, 'task-durable-create', {
    recordRunning: false,
  });
  const wrongOwner = { ...ownership, ownerGeneration: 'wrong-owner' };
  const wrongResource = { ...ownership, resourceGeneration: 'wrong-resource' };

  assert.equal(
    await store.beginSandboxRunCreate({
      taskId: 'missing-durable-create',
      providerId: 'boxlite',
      ownership,
    }),
    false,
  );
  assert.equal(
    await store.beginSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'aio',
      ownership,
    }),
    false,
  );
  assert.equal(
    await store.beginSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'boxlite',
      ownership: wrongOwner,
    }),
    false,
  );
  assert.equal(
    await store.beginSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'boxlite',
      ownership: wrongResource,
    }),
    false,
  );
  assert.equal(
    await store.beginSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'boxlite',
      ownership,
    }),
    true,
  );

  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'missing-durable-create',
      providerId: 'boxlite',
      resourceGeneration: ownership.resourceGeneration,
    }),
    false,
  );
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'aio',
      resourceGeneration: ownership.resourceGeneration,
    }),
    false,
  );
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'boxlite',
      resourceGeneration: 'wrong-resource',
    }),
    false,
  );
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'boxlite',
      resourceGeneration: ownership.resourceGeneration,
      providerSandboxId: 'box-first',
    }),
    true,
  );
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'boxlite',
      resourceGeneration: ownership.resourceGeneration,
      providerSandboxId: 'box-second',
    }),
    false,
  );
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-durable-create',
      providerId: 'boxlite',
      resourceGeneration: ownership.resourceGeneration,
      providerSandboxId: 'box-first',
    }),
    true,
  );
});

await test('missing, legacy, and durable cleanup coordination remain distinct', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  const sampleOwnership = {
    ownerGeneration: 'sample-owner',
    resourceGeneration: 'sample-resource',
  };
  assert.deepEqual(await store.beginSandboxRunCleanup('missing-cleanup'), {
    kind: 'absent',
  });
  assert.deepEqual(await store.claimSandboxRunCleanup('missing-cleanup', 'owner'), {
    kind: 'absent',
  });
  assert.deepEqual(
    await store.joinSandboxRunCleanup({
      taskId: 'missing-cleanup',
      providerId: 'boxlite',
      ownership: sampleOwnership,
    }),
    { kind: 'absent' },
  );

  await store.recordSandboxRunOwner({
    taskId: 'task-legacy-claim',
    providerId: 'boxlite',
    status: 'running',
  });
  const claimedLegacy = await store.claimSandboxRunCleanup(
    'task-legacy-claim',
    'ignored-owner-generation',
  );
  assert.equal(claimedLegacy.kind, 'authorized');
  assert.equal(claimedLegacy.authorization.kind, 'legacy');
  assert.deepEqual(
    await store.joinSandboxRunCleanup({
      taskId: 'task-legacy-claim',
      providerId: 'boxlite',
      ownership: sampleOwnership,
    }),
    { kind: 'conflict' },
  );

  await store.beginSandboxRunCreate({
    taskId: 'task-legacy-close-id',
    providerId: 'boxlite',
  });
  await store.observeSandboxRunCreate({
    taskId: 'task-legacy-close-id',
    providerId: 'boxlite',
    providerSandboxId: 'box-exact',
  });
  await store.beginSandboxRunCleanup('task-legacy-close-id');
  assert.equal(
    await store.closeLegacySandboxRunCreateFence({
      taskId: 'task-legacy-close-id',
      providerId: 'boxlite',
      providerSandboxId: 'box-other',
    }),
    false,
  );
  assert.equal(
    await store.closeLegacySandboxRunCreateFence({
      taskId: 'task-legacy-close-id',
      providerId: 'boxlite',
      providerSandboxId: 'box-exact',
    }),
    true,
  );

  const ownership = await acquireDurableOwner(store, 'task-durable-join');
  assert.equal(
    (await store.joinSandboxRunCleanup({
      taskId: 'task-durable-join',
      providerId: 'aio',
      ownership,
    })).kind,
    'conflict',
  );
  assert.equal(
    (await store.joinSandboxRunCleanup({
      taskId: 'task-durable-join',
      providerId: 'boxlite',
      ownership: { ...ownership, resourceGeneration: 'stale-resource' },
    })).kind,
    'stale',
  );
  assert.equal(
    (await store.joinSandboxRunCleanup({
      taskId: 'task-durable-join',
      providerId: 'boxlite',
      ownership: { ...ownership, ownerGeneration: 'stale-owner' },
    })).kind,
    'stale',
  );
  const joined = await store.joinSandboxRunCleanup({
    taskId: 'task-durable-join',
    providerId: 'boxlite',
    ownership,
  });
  assert.equal(joined.kind, 'authorized');
  assert.equal(joined.authorization.kind, 'generation');

  await store.recordSandboxRunOwner({
    taskId: 'task-settled-join',
    providerId: 'boxlite',
    status: 'running',
  });
  await store.markSandboxRunOwnerStatus('task-settled-join', 'terminal');
  assert.equal(
    (await store.joinSandboxRunCleanup({
      taskId: 'task-settled-join',
      providerId: 'boxlite',
      ownership: sampleOwnership,
    })).kind,
    'settled',
  );
});

await test('durable cleanup attempts are idempotent and fenced at each transition', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  const ownership = await acquireDurableOwner(store, 'task-attempt-fences', {
    recordRunning: false,
  });
  await store.beginSandboxRunCreate({
    taskId: 'task-attempt-fences',
    providerId: 'boxlite',
    ownership,
  });
  const cleanup = await store.beginSandboxRunCleanup(
    'task-attempt-fences',
    ownership,
  );
  assert.equal(cleanup.kind, 'authorized');
  assert.equal(
    (await store.beginSandboxRunCleanupAttempt(
      {
        ...cleanup.authorization,
        taskId: 'missing-attempt-authority',
      },
      attemptId(99),
    )).kind,
    'stale',
  );
  const first = await store.beginSandboxRunCleanupAttempt(
    cleanup.authorization,
    attemptId(1),
  );
  assert.equal(first.kind, 'allocated');
  assert.equal(
    (await store.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      attemptId(1),
    )).kind,
    'replayed',
  );
  assert.equal(
    (await store.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      attemptId(2),
    )).kind,
    'in-flight',
  );
  assert.equal(
    await store.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
    false,
  );
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      cleanup.authorization,
      cleanupEvidence({
        attemptId: first.evidence.attemptId,
        attempt: first.evidence.attempt,
      }),
    )).kind,
    'conflict',
    'success cannot settle before the entered create fence is observed',
  );
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      cleanup.authorization,
      cleanupEvidence({
        attemptId: first.evidence.attemptId,
        attempt: first.evidence.attempt,
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
      }),
    )).kind,
    'recorded',
  );

  const second = await store.beginSandboxRunCleanupAttempt(
    cleanup.authorization,
    attemptId(2),
  );
  assert.equal(second.kind, 'allocated');
  assert.equal(
    await store.observeSandboxRunCreate({
      taskId: 'task-attempt-fences',
      providerId: 'boxlite',
      resourceGeneration: ownership.resourceGeneration,
      providerSandboxId: 'box-observed-after-cleanup',
    }),
    true,
  );
  const succeeded = cleanupEvidence({
    attemptId: second.evidence.attemptId,
    attempt: second.evidence.attempt,
    proof: 'found-and-cleaned',
  });
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      cleanup.authorization,
      succeeded,
    )).kind,
    'recorded',
  );
  assert.equal(
    (await store.beginSandboxRunCleanupAttempt(
      cleanup.authorization,
      attemptId(2),
    )).kind,
    'replayed',
  );
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      cleanup.authorization,
      succeeded,
    )).kind,
    'replayed',
  );
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      cleanup.authorization,
      { ...succeeded, observedAt: new Date('2026-07-19T14:00:01.000Z') },
    )).kind,
    'conflict',
  );
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      cleanup.authorization,
      cleanupEvidence({ attemptId: attemptId(1), attempt: 1 }),
    )).kind,
    'stale',
  );
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      cleanup.authorization,
      cleanupEvidence({ attemptId: attemptId(3), attempt: 3 }),
    )).kind,
    'conflict',
  );
  assert.equal(
    await store.completeSandboxRunCleanup(
      {
        ...cleanup.authorization,
        ownership: {
          ...cleanup.authorization.ownership,
          resourceGeneration: 'wrong-resource',
        },
      },
      'removed',
    ),
    false,
  );
  assert.equal(
    await store.completeSandboxRunCleanup(cleanup.authorization, 'removed'),
    true,
  );
});

await test('terminal cleanup policy records failure and replays only the exact generation', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  const ownership = await acquireDurableOwner(store, 'task-terminal-policy');
  const cleanup = await store.beginSandboxRunCleanup(
    'task-terminal-policy',
    ownership,
  );
  assert.equal(cleanup.kind, 'authorized');
  assert.equal(
    (await store.failSandboxRunCleanupByTerminalPolicy(
      cleanup.authorization,
      0,
    )).kind,
    'conflict',
  );
  assert.equal(
    (await store.failSandboxRunCleanupByTerminalPolicy(
      cleanup.authorization,
      Number.NaN,
    )).kind,
    'conflict',
  );
  assert.equal(
    (await store.failSandboxRunCleanupByTerminalPolicy(
      cleanup.authorization,
      SANDBOX_CLEANUP_ATTEMPT_MAX + 1,
    )).kind,
    'conflict',
  );
  assert.equal(
    (await store.failSandboxRunCleanupByTerminalPolicy(
      {
        ...cleanup.authorization,
        taskId: 'missing-terminal-policy',
      },
      1,
    )).kind,
    'stale',
  );

  const allocated = await store.beginSandboxRunCleanupAttempt(
    cleanup.authorization,
    attemptId(10),
  );
  assert.equal(allocated.kind, 'allocated');
  assert.equal(
    (await store.failSandboxRunCleanupByTerminalPolicy(
      cleanup.authorization,
      allocated.evidence.attempt,
    )).kind,
    'conflict',
  );
  assert.equal(
    (await store.settleSandboxRunCleanupAttempt(
      cleanup.authorization,
      cleanupEvidence({
        attemptId: allocated.evidence.attemptId,
        attempt: allocated.evidence.attempt,
        outcome: 'failed',
        proof: null,
        cause: 'cleanup_failed',
        retryable: false,
      }),
    )).kind,
    'recorded',
  );
  const failed = await store.failSandboxRunCleanupByTerminalPolicy(
    cleanup.authorization,
    allocated.evidence.attempt,
  );
  assert.equal(failed.kind, 'failed');
  const projection = await store.getSandboxRunCleanupAuthority(
    'task-terminal-policy',
  );
  assert.equal(projection.state, 'failed');
  assert.equal(projection.status, 'failed');
  assert.equal(
    (await store.failSandboxRunCleanupByTerminalPolicy(
      cleanup.authorization,
      allocated.evidence.attempt,
    )).kind,
    'replayed',
  );
  assert.equal(
    (await store.failSandboxRunCleanupByTerminalPolicy(
      cleanup.authorization,
      allocated.evidence.attempt + 1,
    )).kind,
    'stale',
  );
});

await test('cleanup attempt planning fails closed at persisted boundaries', () => {
  const owner = {
    taskId: 'task-attempt-limit',
    providerId: 'boxlite',
    status: 'deleting',
    createState: 'idle',
    cleanupAttemptInFlight: false,
    cleanupAttemptCount: SANDBOX_CLEANUP_ATTEMPT_MAX,
  };
  assert.deepEqual(
    planInMemoryCleanupAttempt(owner, null, attemptId(999)),
    { result: { kind: 'conflict' } },
  );
  assert.deepEqual(
    planInMemoryCleanupAttempt(
      { ...owner, cleanupAttemptCount: 1, cleanupAttemptInFlight: true },
      null,
      attemptId(998),
    ),
    { result: { kind: 'conflict' } },
  );

  const first = planInMemoryCleanupAttempt(
    {
      ...owner,
      cleanupAttemptCount: undefined,
      cleanupAttemptInFlight: false,
    },
    null,
    attemptId(997),
  );
  assert.equal(first.result.kind, 'allocated');
  assert.equal(first.result.evidence.attempt, 1);
  assert.equal(first.nextOwner.cleanupAttemptCount, 1);
});

await test('legacy cleanup settlement validates mapping, identity, attempt, and replay evidence', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  const indeterminate = cleanupEvidence({
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
  });
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'missing-legacy-settlement',
      providerId: 'boxlite',
      disposition: 'retained',
      status: 'terminal',
      evidence: indeterminate,
    })).kind,
    'stale',
  );
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'missing-legacy-settlement',
      providerId: 'boxlite',
      disposition: 'superseded-remove',
      status: 'terminal',
      evidence: cleanupEvidence(),
    })).kind,
    'conflict',
  );

  await store.recordSandboxRunOwner({
    taskId: 'task-legacy-replay',
    providerId: 'boxlite',
    status: 'running',
  });
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'task-legacy-replay',
      providerId: 'aio',
      disposition: 'retained',
      status: 'terminal',
      evidence: indeterminate,
    })).kind,
    'stale',
  );
  const settled = await store.settleLegacySandboxRunCleanup({
    taskId: 'task-legacy-replay',
    providerId: 'boxlite',
    disposition: 'retained',
    status: 'terminal',
    evidence: indeterminate,
  });
  assert.equal(settled.kind, 'recorded');
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'task-legacy-replay',
      providerId: 'boxlite',
      disposition: 'retained',
      status: 'terminal',
      evidence: indeterminate,
    })).kind,
    'replayed',
  );
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'task-legacy-replay',
      providerId: 'boxlite',
      disposition: 'retained',
      status: 'terminal',
      evidence: {
        ...indeterminate,
        observedAt: new Date('2026-07-19T14:00:01.000Z'),
      },
    })).kind,
    'stale',
  );

  await store.recordSandboxRunOwner({
    taskId: 'task-legacy-attempt-mismatch',
    providerId: 'boxlite',
    status: 'running',
  });
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'task-legacy-attempt-mismatch',
      providerId: 'boxlite',
      disposition: 'retained',
      status: 'terminal',
      evidence: { ...indeterminate, attempt: 2 },
    })).kind,
    'conflict',
  );

  const durableOwnership = await acquireDurableOwner(
    store,
    'task-durable-legacy-settlement',
  );
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'task-durable-legacy-settlement',
      providerId: 'boxlite',
      disposition: 'retained',
      status: 'terminal',
      evidence: indeterminate,
    })).kind,
    'conflict',
  );
  const durableCleanup = await store.beginSandboxRunCleanup(
    'task-durable-legacy-settlement',
    durableOwnership,
  );
  assert.equal(durableCleanup.kind, 'authorized');

  await store.recordSandboxRunOwner({
    taskId: 'task-legacy-deleting-settlement',
    providerId: 'boxlite',
    status: 'running',
  });
  await store.beginSandboxRunCleanup('task-legacy-deleting-settlement');
  assert.equal(
    (await store.settleLegacySandboxRunCleanup({
      taskId: 'task-legacy-deleting-settlement',
      providerId: 'boxlite',
      disposition: 'retained',
      status: 'terminal',
      evidence: indeterminate,
    })).kind,
    'conflict',
  );
});

await test('orphan confirmation and status updates cannot bypass cleanup fences', async () => {
  const store = new InMemorySandboxRunOwnerStore();
  const ownership = await acquireDurableOwner(store, 'task-orphan-confirm');
  await store.beginSandboxRunCleanup('task-orphan-confirm', ownership);
  assert.equal(
    (await store.confirmSandboxRunCleanupOrphan({
      taskId: 'missing-orphan-confirm',
      providerId: 'boxlite',
      providerSandboxId: 'missing',
    })).kind,
    'stale',
  );
  assert.equal(
    (await store.confirmSandboxRunCleanupOrphan({
      taskId: 'task-orphan-confirm',
      providerId: 'aio',
      providerSandboxId: 'task-orphan-confirm-sandbox',
    })).kind,
    'conflict',
  );
  assert.equal(
    (await store.confirmSandboxRunCleanupOrphan({
      taskId: 'task-orphan-confirm',
      providerId: 'boxlite',
      providerSandboxId: 'wrong-sandbox',
    })).kind,
    'conflict',
  );
  assert.equal(
    (await store.confirmSandboxRunCleanupOrphan({
      taskId: 'task-orphan-confirm',
      providerId: 'boxlite',
      providerSandboxId: 'task-orphan-confirm-sandbox',
    })).kind,
    'recorded',
  );
  assert.equal(
    (await store.confirmSandboxRunCleanupOrphan({
      taskId: 'task-orphan-confirm',
      providerId: 'boxlite',
      providerSandboxId: 'task-orphan-confirm-sandbox',
    })).kind,
    'replayed',
  );
  assert.equal(
    (await store.getSandboxRunCleanupAuthority('task-orphan-confirm')).orphanState,
    'confirmed',
  );

  await store.markSandboxRunOwnerStatus('missing-status', 'removed');
  await store.markSandboxRunOwnerStatus('task-orphan-confirm', 'deleting');
  await store.markSandboxRunOwnerStatus('task-orphan-confirm', 'failed');
  await store.markSandboxRunOwnerStatus('task-orphan-confirm', 'running');
  assert.equal(
    (await store.getSandboxRunCleanupAuthority('task-orphan-confirm')).status,
    'deleting',
  );

  await store.beginSandboxRunCreate({
    taskId: 'task-entered-status-fence',
    providerId: 'boxlite',
  });
  await store.beginSandboxRunCleanup('task-entered-status-fence');
  await store.markSandboxRunOwnerStatus('task-entered-status-fence', 'removed');
  assert.equal(
    (await store.getSandboxRunCleanupAuthority('task-entered-status-fence')).status,
    'deleting',
  );

  await store.recordSandboxRunOwner({
    taskId: 'task-unconfirmed-status-fence',
    providerId: 'boxlite',
    status: 'running',
  });
  await store.beginSandboxRunCleanup('task-unconfirmed-status-fence');
  await store.markSandboxRunOwnerStatus('task-unconfirmed-status-fence', 'terminal');
  assert.equal(
    (await store.getSandboxRunCleanupAuthority('task-unconfirmed-status-fence')).status,
    'deleting',
  );

  await store.markSandboxRunOwnerStatus('task-legacy-late', 'running');
  assert.equal(
    (await store.getSandboxRunCleanupAuthority('task-legacy-late')).status,
    null,
    'missing records ignore ordinary status changes',
  );

  await store.recordSandboxRunOwner({
    taskId: 'task-settled-status-fence',
    providerId: 'boxlite',
    status: 'running',
  });
  await store.markSandboxRunOwnerStatus('task-settled-status-fence', 'terminal');
  await store.markSandboxRunOwnerStatus('task-settled-status-fence', 'running');
  assert.equal(
    (await store.getSandboxRunCleanupAuthority('task-settled-status-fence')).status,
    'terminal',
    'settled records ignore ordinary status changes',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
