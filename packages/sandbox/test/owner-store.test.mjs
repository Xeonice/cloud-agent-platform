import assert from 'node:assert/strict';

import {
  InMemorySandboxRunOwnerStore,
} from '../dist/index.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
