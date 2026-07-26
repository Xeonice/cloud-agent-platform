import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function provisionContext(taskId, overrides = {}) {
  return {
    taskId,
    cloneSpec: null,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'headless-exec',
    ...overrides,
  };
}

function generationAuthorization(taskId = 'task-cleanup') {
  return Object.freeze({
    kind: 'generation',
    taskId,
    providerId: 'provider-a',
    ownership: Object.freeze({
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    }),
  });
}

function legacyAuthorization(taskId = 'task-legacy') {
  return Object.freeze({
    kind: 'legacy',
    taskId,
    providerId: 'provider-a',
  });
}

function succeeded(proof = 'already-absent') {
  return Object.freeze({
    outcome: 'succeeded',
    proof,
    cause: null,
    retryable: false,
  });
}

function failedPhysical() {
  return Object.freeze({
    outcome: 'failed',
    proof: null,
    cause: 'cleanup_failed',
    retryable: true,
  });
}

function indeterminatePhysical() {
  return Object.freeze({
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
  });
}

function evidence(physical = indeterminatePhysical(), attempt = 1) {
  return mod.sandboxCleanupAttemptEvidence(
    attempt,
    `31000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`,
    physical,
  );
}

function provider(id, capabilities = ['terminal.websocket'], overrides = {}) {
  const base = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => capabilities,
    async provision(ctx) {
      return {
        taskId: ctx.taskId,
        baseUrl: `http://${id}/${ctx.taskId}`,
        wsUrl: `ws://${id}/${ctx.taskId}`,
      };
    },
    async teardownSandbox() {
      return { kind: 'already-absent' };
    },
    async readRolloutFromContainer() {
      return null;
    },
    async sandboxExists() {
      return false;
    },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
    async reattach() {
      return null;
    },
    ...overrides,
  };
  return base;
}

function descriptor(id, instance, priority = 1) {
  return mod.defineLocalSandboxProvider({ id, provider: instance, priority });
}

function durableCallbackStore(overrides = {}) {
  return {
    async beginSandboxRunCleanupAttempt() {
      return { kind: 'allocated', evidence: evidence() };
    },
    async settleSandboxRunCleanupAttempt() {
      return { kind: 'recorded' };
    },
    async completeSandboxRunCleanup() {
      return true;
    },
    ...overrides,
  };
}

function durableCallbacks({
  store = durableCallbackStore(),
  authorize = async () => ({
    authorization: generationAuthorization(),
    confirmedAbsenceIsFinal: true,
  }),
  completedStatus = 'removed',
} = {}) {
  const router = new mod.SandboxProviderRouter([], { ownerStore: store });
  return {
    router,
    callbacks: router.createProviderContextCleanupCallbacks({
      authorize,
      completedStatus,
    }),
  };
}

function legacyOwner(overrides = {}) {
  return {
    taskId: 'task-legacy',
    providerId: 'provider-a',
    status: 'running',
    createState: 'idle',
    cleanupAttemptInFlight: false,
    cleanupAttemptCount: 0,
    ...overrides,
  };
}

function legacyCallbackStore(overrides = {}) {
  return {
    async getSandboxRunOwner() {
      return legacyOwner();
    },
    async settleLegacySandboxRunCleanup() {
      return { kind: 'recorded' };
    },
    ...overrides,
  };
}

function legacyCallbacks(store = legacyCallbackStore()) {
  const router = new mod.SandboxProviderRouter([], { ownerStore: store });
  return {
    router,
    callbacks: router.createLegacyProviderContextCleanupCallbacks(
      'task-legacy',
      'provider-a',
    ),
  };
}

await test('explicit model provider selection failures use the stable model phase', async () => {
  const router = new mod.SandboxProviderRouter([
    descriptor(
      'provider-a',
      provider('provider-a', ['terminal.websocket']),
    ),
  ]);

  await assert.rejects(
    router.provision(
      provisionContext('explicit-selection-failure', {
        modelIntent: { kind: 'explicit', selector: 'provider/model:v1' },
        environment: {
          providerId: 'provider-a',
          sourceKind: 'boxlite-image',
          sourceRef: 'image:v1',
        },
        workspace: {
          repositoryUrl: 'https://code.example.test/repo.git',
          callerBranch: null,
          resolvedBranch: 'main',
          deadlineMs: 1_000,
        },
      }),
    ),
    (error) => error?.phase === 'provider-selection',
  );
});

await test('router exposes absent cleanup authority and rejects missing durable stores', async () => {
  const router = new mod.SandboxProviderRouter([]);
  assert.deepEqual(await router.getSandboxCleanupAuthority('missing'), {
    state: 'not_required',
    ownershipKind: 'none',
    orphanState: 'none',
    status: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    lastAttemptProof: null,
    lastAttemptCause: null,
    lastAttemptRetryable: null,
    lastAttemptObservedAt: null,
  });
  await assert.rejects(
    router.claimSandboxCleanupOwnership('missing', 'owner:g1'),
    /ownership store is unavailable/,
  );
  await assert.rejects(
    new mod.SandboxProviderRouter([
      descriptor('provider-a', provider('provider-a')),
    ]).provision(
      provisionContext('missing-owner-store', {
        ownership: generationAuthorization('missing-owner-store').ownership,
      }),
    ),
    /ownership store is unavailable/,
  );
  await assert.rejects(
    router.teardownSandbox('missing-owner-store', {
      ownership: generationAuthorization('missing-owner-store').ownership,
    }),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );
});

await test('terminal cleanup policy failures stay coordination-pending', async () => {
  const authorization = generationAuthorization('terminal-policy');
  const missing = new mod.SandboxProviderRouter([], { ownerStore: {} });
  await assert.rejects(
    missing.failSandboxCleanupByTerminalPolicy(authorization, 1),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );

  for (const failSandboxRunCleanupByTerminalPolicy of [
    async () => {
      throw new Error('store unavailable');
    },
    async () => ({ kind: 'stale' }),
  ]) {
    const router = new mod.SandboxProviderRouter([], {
      ownerStore: { failSandboxRunCleanupByTerminalPolicy },
    });
    await assert.rejects(
      router.failSandboxCleanupByTerminalPolicy(authorization, 1),
      (error) => error?.code === 'sandbox_cleanup_coordination_pending',
    );
  }
});

await test('aggregate legacy cleanup preserves failed and indeterminate physical facts', async () => {
  const failedProvider = provider('failed', ['terminal.websocket'], {
    async teardownSandbox() {
      return failedPhysical();
    },
  });
  const indeterminateProvider = provider('indeterminate', ['terminal.websocket'], {
    async teardownSandbox() {
      return undefined;
    },
  });
  const failedRouter = new mod.SandboxProviderRouter([
    descriptor('failed', failedProvider),
    descriptor('indeterminate', indeterminateProvider),
  ]);
  assert.deepEqual(
    await failedRouter.teardownSandbox('aggregate-failed'),
    failedPhysical(),
  );

  const indeterminateRouter = new mod.SandboxProviderRouter([
    descriptor('indeterminate', indeterminateProvider),
  ]);
  assert.equal(
    (await indeterminateRouter.teardownSandbox('aggregate-indeterminate'))
      .outcome,
    'indeterminate',
  );
});

await test('diagnostic flush failures never block physical cleanup', async () => {
  let cleanups = 0;
  const router = new mod.SandboxProviderRouter([
    descriptor(
      'provider-a',
      provider('provider-a', ['terminal.websocket'], {
        async teardownSandbox() {
          cleanups += 1;
          return { kind: 'already-absent' };
        },
      }),
    ),
  ]);
  await router.teardownSandbox('flush-throws', {
    diagnostics: {
      flush() {
        throw new Error('diagnostics unavailable');
      },
    },
  });
  assert.equal(cleanups, 1);
});

await test('durable cleanup callback construction requires the complete attempt store', () => {
  const router = new mod.SandboxProviderRouter([], { ownerStore: {} });
  assert.throws(
    () =>
      router.createProviderContextCleanupCallbacks({
        authorize: async () => null,
        completedStatus: 'removed',
      }),
    /cleanup attempt store is unavailable/,
  );
});

await test('durable cleanup authorization and allocation failures are fail-closed', async () => {
  {
    const { callbacks } = durableCallbacks({
      authorize: async () => {
        throw new Error('authorization unavailable');
      },
    });
    assert.equal(await callbacks.beforeSandboxCleanup(), null);
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
  {
    const { callbacks } = durableCallbacks({ authorize: async () => null });
    assert.equal(await callbacks.beforeSandboxCleanup(), null);
    assert.deepEqual(await callbacks.settleIncomplete(), { kind: 'none' });
  }
  for (const beginSandboxRunCleanupAttempt of [
    async () => {
      throw new Error('allocation unavailable');
    },
    async () => ({ kind: 'replayed', evidence: evidence() }),
  ]) {
    const { callbacks } = durableCallbacks({
      store: durableCallbackStore({ beginSandboxRunCleanupAttempt }),
    });
    assert.equal(await callbacks.beforeSandboxCleanup(), null);
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
  {
    const { callbacks } = durableCallbacks();
    const authorization = await callbacks.beforeSandboxCleanup();
    assert.deepEqual(authorization, generationAuthorization());
    assert.equal(await callbacks.beforeSandboxCleanup(), null);
    const finalization = await callbacks.settleIncomplete();
    assert.equal(finalization.kind, 'coordination-pending');
    assert.deepEqual(finalization.authorization, authorization);
  }
});

await test('durable cleanup rejects missing, mismatched, malformed, and conflicting settlement', async () => {
  {
    const { callbacks } = durableCallbacks();
    await callbacks.settleSandboxCleanupAttempt(
      generationAuthorization('wrong-task'),
      succeeded(),
    );
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
  {
    const { callbacks } = durableCallbacks();
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(authorization, {
      outcome: 'succeeded',
    });
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
  {
    const { callbacks } = durableCallbacks();
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(authorization, failedPhysical());
    await callbacks.settleSandboxCleanupAttempt(authorization, succeeded());
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
});

await test('durable cleanup coalesces duplicate settlement and completes successful absence', async () => {
  const settleEntered = deferred();
  const releaseSettle = deferred();
  let settlements = 0;
  const after = [];
  const { callbacks } = durableCallbacks({
    store: durableCallbackStore({
      async settleSandboxRunCleanupAttempt() {
        settlements += 1;
        settleEntered.resolve();
        await releaseSettle.promise;
        return { kind: 'recorded' };
      },
    }),
    authorize: async () => ({
      authorization: generationAuthorization(),
      confirmedAbsenceIsFinal: true,
      afterSettlement: async (physical) => after.push(physical),
    }),
  });
  const authorization = await callbacks.beforeSandboxCleanup();
  const first = callbacks.afterSandboxCleanup(authorization);
  await settleEntered.promise;
  const second = callbacks.afterSandboxCleanup(authorization);
  assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  releaseSettle.resolve();
  await Promise.all([first, second]);
  assert.equal(settlements, 1);
  assert.deepEqual(after, [succeeded()]);
  assert.deepEqual(await callbacks.settleIncomplete(), { kind: 'none' });
});

await test('durable cleanup settlement and completion failures remain explicit coordination', async () => {
  for (const settleSandboxRunCleanupAttempt of [
    async () => {
      throw new Error('settlement unavailable');
    },
    async () => ({ kind: 'stale' }),
  ]) {
    const { callbacks } = durableCallbacks({
      store: durableCallbackStore({ settleSandboxRunCleanupAttempt }),
    });
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(
      authorization,
      failedPhysical(),
    );
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }

  for (const completeSandboxRunCleanup of [
    async () => {
      throw new Error('completion unavailable');
    },
    async () => false,
  ]) {
    const { callbacks } = durableCallbacks({
      store: durableCallbackStore({ completeSandboxRunCleanup }),
    });
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.afterSandboxCleanup(authorization);
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
});

await test('durable cleanup reports failed physical attempts and outer acknowledgement failures', async () => {
  {
    const observed = [];
    const { callbacks } = durableCallbacks({
      authorize: async () => ({
        authorization: generationAuthorization(),
        confirmedAbsenceIsFinal: true,
        afterSettlement: async (physical) => observed.push(physical),
      }),
    });
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(
      authorization,
      failedPhysical(),
    );
    const finalization = await callbacks.settleIncomplete();
    assert.equal(finalization.kind, 'settled-physical');
    assert.deepEqual(finalization.physical, failedPhysical());
    assert.deepEqual(observed, [failedPhysical()]);
  }
  {
    const { callbacks } = durableCallbacks({
      authorize: async () => ({
        authorization: generationAuthorization(),
        confirmedAbsenceIsFinal: true,
        afterSettlement: async () => {
          throw new Error('upstream acknowledgement failed');
        },
      }),
    });
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(
      authorization,
      failedPhysical(),
    );
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
});

await test('durable incomplete settlement records one unconfirmed physical attempt', async () => {
  const acknowledged = [];
  const { callbacks } = durableCallbacks({
    authorize: async () => ({
      authorization: generationAuthorization(),
      confirmedAbsenceIsFinal: false,
      afterSettlement: async (physical) => acknowledged.push(physical),
    }),
  });
  await callbacks.beforeSandboxCleanup();
  const finalization = await callbacks.settleIncomplete();
  assert.equal(finalization.kind, 'settled-physical');
  assert.equal(finalization.physical.outcome, 'indeterminate');
  assert.equal(acknowledged[0].outcome, 'indeterminate');
});

await test('legacy cleanup callback construction requires its evidence store', () => {
  const router = new mod.SandboxProviderRouter([], { ownerStore: {} });
  assert.throws(
    () =>
      router.createLegacyProviderContextCleanupCallbacks(
        'task-legacy',
        'provider-a',
      ),
    /Legacy provider cleanup evidence store is unavailable/,
  );
});

await test('legacy cleanup authorization failures never widen destructive authority', async () => {
  for (const getSandboxRunOwner of [
    async () => {
      throw new Error('owner unavailable');
    },
    async () => null,
    async () => legacyOwner({ providerId: 'provider-b' }),
    async () => legacyOwner({
      ownership: generationAuthorization().ownership,
    }),
  ]) {
    const { callbacks } = legacyCallbacks(
      legacyCallbackStore({ getSandboxRunOwner }),
    );
    assert.equal(await callbacks.beforeSandboxCleanup(), null);
    const finalization = await callbacks.settleIncomplete();
    if (await getSandboxRunOwner().catch(() => undefined)) {
      assert.equal(finalization.kind, 'coordination-pending');
    }
  }

  const { callbacks } = legacyCallbacks();
  const authorization = await callbacks.beforeSandboxCleanup();
  assert.deepEqual(authorization, legacyAuthorization());
  assert.equal(await callbacks.beforeSandboxCleanup(), null);
  assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
});

await test('legacy cleanup settlement validates authorization and physical evidence', async () => {
  {
    const { callbacks } = legacyCallbacks();
    await callbacks.settleSandboxCleanupAttempt(
      generationAuthorization(),
      succeeded(),
    );
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
  {
    const { callbacks } = legacyCallbacks();
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(authorization, {
      outcome: 'succeeded',
    });
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
  {
    const { callbacks } = legacyCallbacks();
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(authorization, failedPhysical());
    await callbacks.settleSandboxCleanupAttempt(authorization, succeeded());
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
});

await test('legacy cleanup settlement handles store rejection and non-recorded outcomes', async () => {
  for (const settleLegacySandboxRunCleanup of [
    async () => {
      throw new Error('legacy settlement unavailable');
    },
    async () => ({ kind: 'stale' }),
  ]) {
    const { callbacks } = legacyCallbacks(
      legacyCallbackStore({ settleLegacySandboxRunCleanup }),
    );
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(
      authorization,
      failedPhysical(),
    );
    assert.equal((await callbacks.settleIncomplete()).kind, 'coordination-pending');
  }
});

await test('legacy cleanup settlement coalesces and reports success versus failure', async () => {
  {
    const entered = deferred();
    const release = deferred();
    let settlements = 0;
    const { callbacks } = legacyCallbacks(
      legacyCallbackStore({
        async settleLegacySandboxRunCleanup() {
          settlements += 1;
          entered.resolve();
          await release.promise;
          return { kind: 'replayed' };
        },
      }),
    );
    const authorization = await callbacks.beforeSandboxCleanup();
    const first = callbacks.afterSandboxCleanup(authorization);
    await entered.promise;
    const second = callbacks.afterSandboxCleanup(authorization);
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(settlements, 1);
    assert.deepEqual(await callbacks.settleIncomplete(), { kind: 'none' });
  }
  {
    const { callbacks } = legacyCallbacks();
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.settleSandboxCleanupAttempt(
      authorization,
      failedPhysical(),
    );
    const finalization = await callbacks.settleIncomplete();
    assert.equal(finalization.kind, 'settled-physical');
    assert.deepEqual(finalization.physical, failedPhysical());
  }
  {
    const { callbacks } = legacyCallbacks();
    const authorization = await callbacks.beforeSandboxCleanup();
    const finalization = await callbacks.settleIncomplete();
    assert.equal(finalization.kind, 'settled-physical');
    assert.equal(finalization.physical.outcome, 'indeterminate');
    assert.deepEqual(authorization, legacyAuthorization());
  }
});

await test('selected-run failures and empty verified targets remain cacheless', async () => {
  const instance = provider(
    'provider-a',
    ['terminal.websocket', 'lifecycle.readopt'],
    {
      async getSelectedSandboxRun() {
        throw new Error('selected run unavailable');
      },
    },
  );
  const entry = descriptor('provider-a', instance);
  const router = new mod.SandboxProviderRouter([entry]);
  assert.equal(await router.selectedRunFor('selected-failure', entry), null);

  router.rememberVerifiedDeliveryTarget('empty-target', 'provider-a', {});
  assert.equal(router.verifiedDeliveryTargets.has('empty-target'), false);
});

function generatedCleanupOwner(taskId, overrides = {}) {
  return {
    taskId,
    providerId: 'provider-a',
    ownership: generationAuthorization(taskId).ownership,
    status: 'deleting',
    createState: 'idle',
    cleanupAttemptInFlight: false,
    cleanupAttemptCount: 0,
    ...overrides,
  };
}

function cleanupStoreForAuthorization(
  authorization,
  owner = generatedCleanupOwner(authorization.taskId),
  overrides = {},
) {
  return {
    async beginSandboxRunCleanup() {
      return { kind: 'authorized', authorization, owner };
    },
    async beginSandboxRunCleanupAttempt() {
      return { kind: 'allocated', evidence: evidence() };
    },
    async settleSandboxRunCleanupAttempt() {
      return { kind: 'recorded' };
    },
    async completeSandboxRunCleanup() {
      return true;
    },
    async getSandboxRunOwner() {
      return null;
    },
    ...overrides,
  };
}

await test('generated cleanup callbacks propagate successful upstream completion', async () => {
  const taskId = 'upstream-success-completion';
  const upstreamAuthorization = generationAuthorization(taskId);
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const completed = [];
  const primary = new Error('provider failed after cleanup');
  const instance = provider('provider-a', ['terminal.websocket'], {
    async provision(ctx) {
      const authorization = await ctx.beforeSandboxCleanup();
      await ctx.afterSandboxCleanup(authorization);
      throw primary;
    },
  });
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', instance)],
    { ownerStore },
  );

  await assert.rejects(
    router.provision(
      provisionContext(taskId, {
        ownership: upstreamAuthorization.ownership,
        beforeSandboxCleanup: async () => upstreamAuthorization,
        afterSandboxCleanup: async (authorization) => {
          completed.push(authorization);
        },
      }),
    ),
    (error) => error === primary,
  );
  assert.deepEqual(completed, [upstreamAuthorization]);
});

await test('generated create guards reject stale ownership before provider I/O', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const beginCreate = ownerStore.beginSandboxRunCreate.bind(ownerStore);
  let providerCalls = 0;
  ownerStore.beginSandboxRunCreate = async (args) => {
    if (args.ownership) return false;
    return beginCreate(args);
  };
  const instance = provider('provider-a', ['terminal.websocket'], {
    async provision(ctx) {
      providerCalls += 1;
      await ctx.externalBoundaryGuard({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      return {
        taskId: ctx.taskId,
        baseUrl: 'http://provider-a',
        wsUrl: 'ws://provider-a',
      };
    },
  });
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', instance)],
    { ownerStore },
  );
  await assert.rejects(
    router.provision(
      provisionContext('stale-generated-create', {
        ownership: generationAuthorization('stale-generated-create').ownership,
      }),
    ),
    /create fence is no longer current/,
  );
  assert.equal(providerCalls, 1);
});

await test('legacy provisioning rejects duplicate in-flight work and failed fence entry', async () => {
  {
    const ownerStore = new mod.InMemorySandboxRunOwnerStore();
    const entered = deferred();
    const release = deferred();
    const instance = provider('provider-a', ['terminal.websocket'], {
      async provision(ctx) {
        entered.resolve();
        await release.promise;
        return {
          taskId: ctx.taskId,
          baseUrl: 'http://provider-a',
          wsUrl: 'ws://provider-a',
        };
      },
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      { ownerStore },
    );
    const first = router.provision(provisionContext('duplicate-legacy'));
    await entered.promise;
    await assert.rejects(
      router.provision(provisionContext('duplicate-legacy')),
      /in-flight legacy provision/,
    );
    release.resolve();
    await first;
  }
  {
    const ownerStore = new mod.InMemorySandboxRunOwnerStore();
    ownerStore.beginSandboxRunCreate = async () => false;
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      { ownerStore },
    );
    await assert.rejects(
      router.provision(provisionContext('legacy-fence-rejected')),
      /create fence is no longer current/,
    );
  }
});

await test('provider cleanup-pending signals bypass duplicate router cleanup', async () => {
  const pending = new mod.SandboxCleanupCoordinationPendingError(
    new Error('primary'),
  );
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const router = new mod.SandboxProviderRouter(
    [
      descriptor(
        'provider-a',
        provider('provider-a', ['terminal.websocket'], {
          async provision() {
            throw pending;
          },
        }),
      ),
    ],
    { ownerStore },
  );
  await assert.rejects(
    router.provision(
      provisionContext('provider-cleanup-pending', {
        ownership: generationAuthorization('provider-cleanup-pending').ownership,
      }),
    ),
    (error) => error === pending,
  );
});

await test('teardown validates authorization targets and registered owners', async () => {
  const taskId = 'teardown-validation';
  const authorization = generationAuthorization(taskId);
  const instance = provider('provider-a');

  {
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      {
        ownerStore: cleanupStoreForAuthorization(authorization),
      },
    );
    await assert.rejects(
      router.teardownSandboxResult(taskId, {
        cleanupAuthorization: {
          ...authorization,
          taskId: 'wrong-task',
        },
      }),
      /authorization task does not match/,
    );
  }
  {
    const different = {
      ...authorization,
      ownership: {
        ...authorization.ownership,
        resourceGeneration: 'resource:different',
      },
    };
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      {
        ownerStore: cleanupStoreForAuthorization(different),
      },
    );
    assert.equal(
      (
        await router.teardownSandboxResult(taskId, {
          cleanupAuthorization: authorization,
        })
      ).kind,
      'coordination-pending',
    );
  }
  {
    const missingOwner = generatedCleanupOwner(taskId, {
      providerId: 'missing-provider',
    });
    const missingAuthorization = {
      ...authorization,
      providerId: 'missing-provider',
    };
    const router = new mod.SandboxProviderRouter([], {
      ownerStore: cleanupStoreForAuthorization(
        missingAuthorization,
        missingOwner,
      ),
    });
    await assert.rejects(
      router.teardownSandboxResult(taskId, {
        cleanupAuthorization: missingAuthorization,
      }),
      /owner provider is not registered/,
    );
  }
});

await test('teardown resumes settled evidence and detects incomplete stores', async () => {
  const taskId = 'settled-evidence';
  const authorization = generationAuthorization(taskId);
  const settledOwner = generatedCleanupOwner(taskId, {
    cleanupAttemptCount: 1,
    cleanupLastAttemptId: '32000000-0000-4000-8000-000000000001',
    cleanupLastOutcome: 'succeeded',
    cleanupLastProof: 'already-absent',
    cleanupLastCause: null,
    cleanupLastRetryable: false,
    cleanupLastObservedAt: new Date('2026-07-25T00:00:00.000Z'),
  });
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', provider('provider-a'))],
    {
      ownerStore: cleanupStoreForAuthorization(authorization, settledOwner, {
        async completeSandboxRunCleanup() {
          return false;
        },
      }),
    },
  );
  const result = await router.teardownSandboxResult(taskId, {
    cleanupAuthorization: authorization,
  });
  assert.equal(result.kind, 'coordination-pending');
  assert.equal(result.physical.outcome, 'succeeded');

  const incompleteStore = cleanupStoreForAuthorization(
    authorization,
    generatedCleanupOwner(taskId),
  );
  incompleteStore.beginSandboxRunCleanupAttempt = undefined;
  const incompleteRouter = new mod.SandboxProviderRouter(
    [descriptor('provider-a', provider('provider-a'))],
    { ownerStore: incompleteStore },
  );
  assert.equal(
    (
      await incompleteRouter.teardownSandboxResult(taskId, {
        cleanupAuthorization: authorization,
      })
    ).kind,
    'coordination-pending',
  );
});

await test('create-in-flight cleanup handles absent and settled owner rechecks', async () => {
  for (const pending of [
    { kind: 'absent' },
    {
      kind: 'settled',
      owner: generatedCleanupOwner('create-recheck', {
        status: 'removed',
      }),
    },
  ]) {
    const taskId = 'create-recheck';
    const authorization = generationAuthorization(taskId);
    const owner = generatedCleanupOwner(taskId, { createState: 'entered' });
    const store = cleanupStoreForAuthorization(authorization, owner, {
      async joinSandboxRunCleanup() {
        return pending;
      },
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      { ownerStore: store },
    );
    const result = await router.teardownSandboxResult(taskId, {
      cleanupAuthorization: authorization,
    });
    assert.equal(result.kind, 'physical');
    assert.equal(result.physical.outcome, 'succeeded');
  }
});

await test('legacy owned cleanup marks successful provider absence', async () => {
  const taskId = 'legacy-mark-removed';
  const statuses = [];
  const ownerRecord = legacyOwner({ taskId, providerSandboxId: 'sandbox-a' });
  const store = {
    async getSandboxRunOwner() {
      return ownerRecord;
    },
    async markSandboxRunOwnerStatus(nextTaskId, status) {
      statuses.push([nextTaskId, status]);
    },
  };
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', provider('provider-a'))],
    { ownerStore: store },
  );
  const result = await router.teardownSandboxResult(taskId);
  assert.equal(result.kind, 'physical');
  assert.deepEqual(statuses, [[taskId, 'removed']]);
});

await test('cleanup primary wrapping retains the primary when owner-store cleanup throws', async () => {
  const primary = new Error('primary failure');
  const router = new mod.SandboxProviderRouter([], {
    ownerStore: {
      async beginSandboxRunCleanup() {
        throw new Error('cleanup store unavailable');
      },
    },
  });
  await assert.rejects(
    router.rethrowPrimaryAfterCleanup(primary, 'cleanup-throws', {
      ownership: generationAuthorization('cleanup-throws').ownership,
    }),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      error.primary === primary,
  );
});

await test('legacy and generation cleanup keys both settle through the attempt protocol', async () => {
  for (const authorization of [
    generationAuthorization('attempt-key-generation'),
    legacyAuthorization('attempt-key-legacy'),
  ]) {
    const owner = authorization.kind === 'generation'
      ? generatedCleanupOwner(authorization.taskId)
      : legacyOwner({
          taskId: authorization.taskId,
          status: 'deleting',
        });
    const store = cleanupStoreForAuthorization(authorization, owner);
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      { ownerStore: store },
    );
    const result = await router.teardownSandboxResult(authorization.taskId, {
      cleanupAuthorization: authorization,
    });
    assert.equal(result.kind, 'physical');
    assert.equal(result.physical.outcome, 'succeeded');
  }
});

await test('cleanup evidence rejects incomplete persisted snapshots', async () => {
  const taskId = 'incomplete-evidence';
  const authorization = generationAuthorization(taskId);
  const owner = generatedCleanupOwner(taskId, {
    status: 'removed',
    cleanupAttemptCount: 1,
  });
  const router = new mod.SandboxProviderRouter([], {
    ownerStore: {
      async beginSandboxRunCleanup() {
        return { kind: 'settled', owner };
      },
    },
  });
  await assert.rejects(
    router.teardownSandboxResult(taskId, {
      cleanupAuthorization: authorization,
    }),
    /cleanup evidence is incomplete/,
  );
});

await test('settled removed and terminal owners derive physical truth without evidence', async () => {
  for (const [status, outcome] of [
    ['removed', 'succeeded'],
    ['terminal', 'indeterminate'],
  ]) {
    const taskId = `settled-${status}`;
    const owner = generatedCleanupOwner(taskId, {
      status,
      cleanupAttemptCount: 0,
    });
    const router = new mod.SandboxProviderRouter([], {
      ownerStore: {
        async beginSandboxRunCleanup() {
          return { kind: 'settled', owner };
        },
      },
    });
    const result = await router.teardownSandboxResult(taskId, {
      ownership: owner.ownership,
    });
    assert.equal(result.kind, 'physical');
    assert.equal(result.physical.outcome, outcome);
  }
});

await test('cleanup ownership claims expose absent and invalid store outcomes', async () => {
  {
    const router = new mod.SandboxProviderRouter([], {
      ownerStore: {
        async claimSandboxRunCleanup() {
          return { kind: 'absent' };
        },
      },
    });
    const claim = await router.claimSandboxCleanupOwnership(
      'claim-absent',
      'owner:g1',
    );
    assert.equal(claim.kind, 'absent');
    assert.equal(claim.authority.state, 'not_required');
  }
  {
    const router = new mod.SandboxProviderRouter([], {
      ownerStore: {
        async claimSandboxRunCleanup() {
          return {
            kind: 'authorized',
            authorization: legacyAuthorization('claim-invalid'),
            owner: legacyOwner({ taskId: 'claim-invalid' }),
          };
        },
      },
    });
    await assert.rejects(
      router.claimSandboxCleanupOwnership('claim-invalid', 'owner:g1'),
      /cannot be claimed/,
    );
  }
});

await test('required provider resolution rejects missing and conflicting snapshots', async () => {
  {
    const router = new mod.SandboxProviderRouter([
      descriptor('provider-a', provider('provider-a')),
    ]);
    await assert.rejects(
      router.provision(
        provisionContext('explicit-missing-environment', {
          modelIntent: { kind: 'explicit', selector: 'provider/model:v1' },
        }),
      ),
      (error) => error?.phase === 'snapshot',
    );
  }
  {
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a', [
        'terminal.websocket',
        'lifecycle.readopt',
      ]))],
      { resolveTaskProviderId: async () => 'missing-provider' },
    );
    await assert.rejects(
      router.reattach('required-provider-missing'),
      (error) => error?.phase === 'provider-selection',
    );
  }
});

await test('inventory reconciliation requires complete durable authority ports', async () => {
  const router = new mod.SandboxProviderRouter([], { ownerStore: {} });
  await assert.rejects(
    router.reconcileSandboxInventory({
      protectedTaskIds: [],
      canReap: async () => true,
    }),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );
});

await test('generated delivery cleanup validates store availability and authorization identity', async () => {
  const taskId = 'delivery-store-validation';
  const ownerRecord = generatedCleanupOwner(taskId, { status: 'running' });
  const credentialArgs = {
    branch: 'main',
    commitMessage: 'deliver',
    credential: mod.createExactHostGitCredential(
      'https://code.example.test/repo.git',
      'Authorization: Basic router-branch',
    ),
  };
  {
    const router = new mod.SandboxProviderRouter([], { ownerStore: {} });
    assert.throws(
      () =>
        router.deliveryContextForOwner(
          taskId,
          'provider-a',
          ownerRecord,
          credentialArgs,
        ),
      /delivery cleanup store is unavailable/,
    );
  }
  for (const beginSandboxRunCleanup of [
    async () => ({ kind: 'pending' }),
    async () => ({
      kind: 'authorized',
      authorization: generationAuthorization('different-delivery'),
      owner: ownerRecord,
    }),
  ]) {
    const store = durableCallbackStore({ beginSandboxRunCleanup });
    const router = new mod.SandboxProviderRouter([], { ownerStore: store });
    const delivery = router.deliveryContextForOwner(
      taskId,
      'provider-a',
      ownerRecord,
      credentialArgs,
    );
    assert.equal(await delivery.args.beforeSandboxCleanup(), null);
    assert.equal((await delivery.cleanup.settleIncomplete()).kind, 'coordination-pending');
  }
});

await test('verified delivery targets compare complete ownership identity', async () => {
  const selected = {
    providerId: 'provider-a',
    providerSandboxId: 'sandbox-a',
  };
  const instance = provider(
    'provider-a',
    ['terminal.websocket', 'lifecycle.readopt'],
    { async getSelectedSandboxRun() { return selected; } },
  );
  const entry = descriptor('provider-a', instance);
  const router = new mod.SandboxProviderRouter([entry]);
  const target = {
    providerSandboxId: 'sandbox-a',
    ownership: generationAuthorization('verified-target').ownership,
  };
  router.rememberVerifiedDeliveryTarget('verified-target', 'provider-a', target);
  assert.equal(
    await router.isVerifiedDeliveryTarget('verified-target', entry, target),
    true,
  );
  assert.equal(
    await router.isVerifiedDeliveryTarget('verified-target', entry, {
      ...target,
      ownership: {
        ...target.ownership,
        ownerGeneration: 'owner:different',
      },
    }),
    false,
  );
  router.rememberVerifiedDeliveryTarget('verified-target', 'provider-a', {
    providerSandboxId: 'sandbox-a',
  });
  assert.equal(
    await router.isVerifiedDeliveryTarget('verified-target', entry, {
      providerSandboxId: 'sandbox-a',
    }),
    true,
  );
});

await test('provider failure without ownership preserves its original rejection', async () => {
  const primary = new Error('ownerless provider failure');
  const router = new mod.SandboxProviderRouter([
    descriptor(
      'provider-a',
      provider('provider-a', ['terminal.websocket'], {
        async provision() {
          throw primary;
        },
      }),
    ),
  ]);
  await assert.rejects(
    router.provision(provisionContext('ownerless-provider-failure')),
    (error) => error === primary,
  );
});

await test('provider-return cleanup finalization rejects coordination and settled physical states', async () => {
  {
    const ownerStore = new mod.InMemorySandboxRunOwnerStore();
    const instance = provider('provider-a', ['terminal.websocket'], {
      async provision(ctx) {
        await ctx.beforeSandboxCleanup();
        await ctx.beforeSandboxCleanup();
        return {
          taskId: ctx.taskId,
          baseUrl: 'http://provider-a',
          wsUrl: 'ws://provider-a',
        };
      },
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      { ownerStore },
    );
    await assert.rejects(
      router.provision(
        provisionContext('provider-return-coordination', {
          ownership: generationAuthorization(
            'provider-return-coordination',
          ).ownership,
        }),
      ),
      (error) => error?.code === 'sandbox_cleanup_coordination_pending',
    );
  }
  {
    const ownerStore = new mod.InMemorySandboxRunOwnerStore();
    const instance = provider('provider-a', ['terminal.websocket'], {
      async provision(ctx) {
        const authorization = await ctx.beforeSandboxCleanup();
        await ctx.settleSandboxCleanupAttempt(
          authorization,
          failedPhysical(),
        );
        return {
          taskId: ctx.taskId,
          baseUrl: 'http://provider-a',
          wsUrl: 'ws://provider-a',
        };
      },
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      { ownerStore },
    );
    await assert.rejects(
      router.provision(
        provisionContext('provider-return-physical', {
          ownership: generationAuthorization('provider-return-physical')
            .ownership,
        }),
      ),
      (error) => error?.code === 'sandbox_cleanup_coordination_pending',
    );
  }
});

await test('owner recording failure without a create fence preserves the store error', async () => {
  const primary = new Error('owner recording unavailable');
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', provider('provider-a'))],
    {
      ownerStore: {
        async getSandboxRunOwner() {
          return null;
        },
        async recordSandboxRunOwner() {
          throw primary;
        },
      },
    },
  );
  await assert.rejects(
    router.provision(provisionContext('owner-recording-failure')),
    (error) => error === primary,
  );
});

function completeOwnershipStore(acquireSandboxRunOwner) {
  return {
    acquireSandboxRunOwner,
    beginSandboxRunCreate: async () => true,
    observeSandboxRunCreate: async () => true,
    claimSandboxRunCleanup: async () => ({ kind: 'absent' }),
    joinSandboxRunCleanup: async () => ({ kind: 'absent' }),
    beginSandboxRunCleanup: async () => ({ kind: 'absent' }),
    beginSandboxRunCleanupAttempt: async () => ({
      kind: 'allocated',
      evidence: evidence(),
    }),
    settleSandboxRunCleanupAttempt: async () => ({ kind: 'recorded' }),
    completeSandboxRunCleanup: async () => true,
    failSandboxRunCleanupByTerminalPolicy: async () => ({ kind: 'stale' }),
    getSandboxRunCleanupAuthority: async () => ({
      state: 'not_required',
      ownershipKind: 'none',
      orphanState: 'none',
      status: null,
      attemptCount: 0,
      lastAttemptOutcome: null,
      lastAttemptProof: null,
      lastAttemptCause: null,
      lastAttemptRetryable: null,
      lastAttemptObservedAt: null,
    }),
    settleLegacySandboxRunCleanup: async () => ({ kind: 'recorded' }),
  };
}

await test('ownership acquisition handles legacy cleanup, vanished claims, terminal policy, and conflict', async () => {
  const requested = generationAuthorization('acquire-matrix').ownership;
  {
    let calls = 0;
    const store = completeOwnershipStore(async () => {
      calls += 1;
      return calls === 1
        ? {
            kind: 'cleanup-required',
            owner: legacyOwner({ taskId: 'acquire-matrix' }),
          }
        : { kind: 'acquired', ownership: requested };
    });
    const router = new mod.SandboxProviderRouter([], { ownerStore: store });
    let teardowns = 0;
    router.teardownSandbox = async () => {
      teardowns += 1;
    };
    assert.deepEqual(
      await router.acquireProvisionOwnership(
        'acquire-matrix',
        'provider-a',
        requested,
      ),
      requested,
    );
    assert.equal(teardowns, 1);
  }
  for (const claim of [
    { kind: 'absent', authority: { state: 'not_required' } },
    { kind: 'settled', authority: { state: 'failed' } },
  ]) {
    const owner = generatedCleanupOwner('acquire-matrix');
    const store = completeOwnershipStore(async () => ({
      kind: 'cleanup-required',
      owner,
    }));
    const router = new mod.SandboxProviderRouter([], { ownerStore: store });
    router.claimSandboxCleanupOwnership = async () => claim;
    await assert.rejects(
      router.acquireProvisionOwnership(
        'acquire-matrix',
        'provider-a',
        requested,
      ),
      claim.kind === 'absent' ? /disappeared/ : /terminal policy/,
    );
  }
  {
    let calls = 0;
    const owner = generatedCleanupOwner('acquire-matrix');
    const store = completeOwnershipStore(async () => {
      calls += 1;
      return calls === 1
        ? { kind: 'cleanup-required', owner }
        : { kind: 'conflict', owner };
    });
    const router = new mod.SandboxProviderRouter([], { ownerStore: store });
    router.claimSandboxCleanupOwnership = async () => ({
      kind: 'authorized',
      authorization: generationAuthorization('acquire-matrix'),
      authority: { state: 'pending' },
    });
    router.teardownSandbox = async () => undefined;
    await assert.rejects(
      router.acquireProvisionOwnership(
        'acquire-matrix',
        'provider-a',
        requested,
      ),
      /incompatible active sandbox owner/,
    );
  }
});

function absentAuthority() {
  return {
    state: 'not_required',
    ownershipKind: 'none',
    orphanState: 'none',
    status: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    lastAttemptProof: null,
    lastAttemptCause: null,
    lastAttemptRetryable: null,
    lastAttemptObservedAt: null,
  };
}

await test('legacy cleanup joins an in-flight invocation and bounds an unsettled one', async () => {
  const taskId = 'legacy-in-flight-timeout';
  const store = {
    async getSandboxRunOwner() {
      return null;
    },
    async getSandboxRunCleanupAuthority() {
      return absentAuthority();
    },
  };
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', provider('provider-a'))],
    { ownerStore: store, legacyProvisionJoinTimeoutMs: 1 },
  );
  router.legacyProvisioningInFlight.set(taskId, {
    providerId: 'provider-a',
    settled: new Promise(() => {}),
    settle() {},
  });
  const result = await router.runLegacySandboxCleanup(taskId, {});
  assert.equal(result.kind, 'coordination-pending');
  assert.equal(result.physical.outcome, 'indeterminate');

  const settledTask = 'legacy-in-flight-settled';
  router.legacyProvisioningInFlight.set(settledTask, {
    providerId: 'provider-a',
    settled: Promise.resolve(),
    settle() {},
  });
  const settled = await router.runLegacySandboxCleanup(settledTask, {});
  assert.equal(settled.kind, 'physical');
  assert.equal(settled.physical.outcome, 'succeeded');
});

function legacyPendingAuthority() {
  return {
    state: 'pending',
    ownershipKind: 'legacy',
    orphanState: 'unknown',
    status: 'deleting',
    attemptCount: 0,
    lastAttemptOutcome: null,
    lastAttemptProof: null,
    lastAttemptCause: null,
    lastAttemptRetryable: null,
    lastAttemptObservedAt: null,
  };
}

await test('legacy cleanup resumes settled and non-authorized durable authority', async () => {
  for (const resumed of [
    {
      kind: 'settled',
      owner: legacyOwner({ taskId: 'legacy-resume', status: 'removed' }),
    },
    { kind: 'pending' },
  ]) {
    const store = {
      async getSandboxRunOwner() {
        return null;
      },
      async getSandboxRunCleanupAuthority() {
        return legacyPendingAuthority();
      },
      async beginSandboxRunCleanup() {
        return resumed;
      },
    };
    const router = new mod.SandboxProviderRouter([], { ownerStore: store });
    const result = await router.runLegacySandboxCleanup('legacy-resume', {});
    assert.equal(
      result.kind,
      resumed.kind === 'settled' ? 'physical' : 'coordination-pending',
    );
  }
});

await test('legacy cleanup handles settled begin, missing attempt store, allocation replay, and stale settlement', async () => {
  {
    const owner = legacyOwner({ taskId: 'legacy-begin-settled', createState: 'entered' });
    const store = {
      async getSandboxRunOwner() { return owner; },
      async beginSandboxRunCleanup() {
        return { kind: 'settled', owner: { ...owner, status: 'terminal' } };
      },
    };
    const router = new mod.SandboxProviderRouter([], { ownerStore: store });
    assert.equal(
      (await router.runLegacySandboxCleanup('legacy-begin-settled', {})).kind,
      'physical',
    );
  }

  for (const mode of ['missing-attempt', 'replayed-allocation', 'stale-settlement']) {
    const taskId = `legacy-${mode}`;
    const owner = legacyOwner({ taskId, status: 'deleting', createState: 'idle' });
    let beginCalls = 0;
    const store = {
      async getSandboxRunOwner() { return null; },
      async getSandboxRunCleanupAuthority() { return legacyPendingAuthority(); },
      async beginSandboxRunCleanup() {
        beginCalls += 1;
        return { kind: 'authorized', authorization: legacyAuthorization(taskId), owner };
      },
      async beginSandboxRunCleanupAttempt() {
        return mode === 'replayed-allocation'
          ? { kind: 'replayed', evidence: evidence() }
          : { kind: 'allocated', evidence: evidence() };
      },
      async settleSandboxRunCleanupAttempt() {
        return mode === 'stale-settlement'
          ? { kind: 'stale' }
          : { kind: 'recorded' };
      },
      async completeSandboxRunCleanup() { return true; },
      async closeLegacySandboxRunCreateFence() { return true; },
    };
    if (mode === 'missing-attempt') {
      store.beginSandboxRunCleanupAttempt = undefined;
    }
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      { ownerStore: store },
    );
    const result = await router.runLegacySandboxCleanup(taskId, {});
    assert.equal(result.kind, 'coordination-pending');
    assert.equal(beginCalls >= 2, true);
  }
});

await test('legacy cleanup helper rejects missing stores and unknown provider ids', async () => {
  const noStore = new mod.SandboxProviderRouter([]);
  assert.equal(
    (await noStore.runLegacySandboxCleanup('no-store', {})).kind,
    'coordination-pending',
  );
  assert.equal(
    (
      await noStore.runDirectLegacySandboxCleanup(
        'no-direct-store',
        legacyOwner({ taskId: 'no-direct-store' }),
        {},
      )
    ).kind,
    'coordination-pending',
  );
  const withStore = new mod.SandboxProviderRouter([], {
    ownerStore: {
      async settleLegacySandboxRunCleanup() { return { kind: 'recorded' }; },
    },
  });
  assert.equal(
    (
      await withStore.runLegacyProviderBackedCleanup(
        'missing-provider',
        {},
        'missing-provider',
      )
    ).outcome,
    'indeterminate',
  );
});

await test('delivery reports missing persisted targets and provider failures', async () => {
  const credential = mod.createExactHostGitCredential(
    'https://code.example.test/repo.git',
    'Authorization: Basic router-delivery',
  );
  {
    const ownerStore = new mod.InMemorySandboxRunOwnerStore();
    await ownerStore.recordSandboxRunOwner({
      taskId: 'delivery-missing-target',
      providerId: 'provider-a',
      status: 'running',
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a', [
        'workspace.git.deliver',
        'lifecycle.readopt',
      ]))],
      { ownerStore },
    );
    const result = await router.deliverWorkspaceChanges(
      'delivery-missing-target',
      { branch: 'main', commitMessage: 'deliver', credential },
    );
    assert.match(result.error, /could not reattach/);
  }
  {
    const primary = new Error('delivery failed');
    const ownerStore = new mod.InMemorySandboxRunOwnerStore();
    await ownerStore.recordSandboxRunOwner({
      taskId: 'delivery-provider-failure',
      providerId: 'provider-a',
      providerSandboxId: 'sandbox-a',
      status: 'running',
    });
    const instance = provider(
      'provider-a',
      ['workspace.git.deliver', 'lifecycle.readopt'],
      {
        async reattach(taskId) {
          return { taskId, baseUrl: 'http://provider-a', wsUrl: 'ws://provider-a' };
        },
        async deliverWorkspaceChanges() { throw primary; },
      },
    );
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      { ownerStore },
    );
    await assert.rejects(
      router.deliverWorkspaceChanges('delivery-provider-failure', {
        branch: 'main',
        commitMessage: 'deliver',
        credential,
      }),
      (error) => error === primary,
    );
  }
});

await test('stored and process-local owners enforce immutable provider constraints', async () => {
  {
    const ownerStore = new mod.InMemorySandboxRunOwnerStore();
    await ownerStore.recordSandboxRunOwner({
      taskId: 'stored-provider-conflict',
      providerId: 'provider-a',
      status: 'running',
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      {
        ownerStore,
        resolveTaskProviderId: async () => 'provider-b',
      },
    );
    await assert.rejects(
      router.getSelectedSandboxRun('stored-provider-conflict'),
      (error) => error?.phase === 'provider-selection',
    );
  }
  {
    let requiredProviderId = null;
    const instance = provider(
      'provider-a',
      ['terminal.websocket', 'lifecycle.readopt'],
      {
        async reattach(taskId) {
          return { taskId, baseUrl: 'http://provider-a', wsUrl: 'ws://provider-a' };
        },
      },
    );
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      { resolveTaskProviderId: async () => requiredProviderId },
    );
    await router.provision(provisionContext('local-provider-conflict'));
    requiredProviderId = 'provider-b';
    await assert.rejects(
      router.reattach('local-provider-conflict'),
      (error) => error?.phase === 'provider-selection',
    );
  }
});

await test('durable cleanup distinguishes create-in-flight success and acknowledgement loss', async () => {
  {
    const acknowledged = [];
    const { callbacks } = durableCallbacks({
      authorize: async () => ({
        authorization: generationAuthorization(),
        confirmedAbsenceIsFinal: false,
        afterSettlement: async (physical) => acknowledged.push(physical),
      }),
    });
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.afterSandboxCleanup(authorization);
    const finalization = await callbacks.settleIncomplete();
    assert.equal(finalization.kind, 'settled-physical');
    assert.equal(finalization.physical.outcome, 'indeterminate');
    assert.equal(acknowledged[0].outcome, 'indeterminate');
  }
  {
    const { callbacks } = durableCallbacks({
      authorize: async () => ({
        authorization: generationAuthorization(),
        confirmedAbsenceIsFinal: true,
        afterSettlement: async () => {
          throw new Error('outer acknowledgement unavailable');
        },
      }),
    });
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.afterSandboxCleanup(authorization);
    assert.equal(
      (await callbacks.settleIncomplete()).kind,
      'coordination-pending',
    );
  }
});

await test('durable incomplete settlement preserves store and acknowledgement failures', async () => {
  {
    const { callbacks } = durableCallbacks({
      store: durableCallbackStore({
        async settleSandboxRunCleanupAttempt() {
          throw new Error('settlement unavailable');
        },
      }),
    });
    await callbacks.beforeSandboxCleanup();
    assert.equal(
      (await callbacks.settleIncomplete()).kind,
      'coordination-pending',
    );
  }
  {
    const { callbacks } = durableCallbacks({
      authorize: async () => ({
        authorization: generationAuthorization(),
        confirmedAbsenceIsFinal: true,
        afterSettlement: async () => {
          throw new Error('outer acknowledgement unavailable');
        },
      }),
    });
    await callbacks.beforeSandboxCleanup();
    assert.equal(
      (await callbacks.settleIncomplete()).kind,
      'coordination-pending',
    );
  }
});

await test('provider-return fallback maps thrown and pending cleanup to coordination', async () => {
  for (const fallbackMode of ['throw', 'pending']) {
    const taskId = `provider-return-fallback-${fallbackMode}`;
    const ownerStore = new mod.InMemorySandboxRunOwnerStore();
    const instance = provider('provider-a', ['terminal.websocket'], {
      async provision(ctx) {
        const authorization = await ctx.beforeSandboxCleanup();
        await ctx.settleSandboxCleanupAttempt(authorization, failedPhysical());
        return {
          taskId: ctx.taskId,
          baseUrl: 'http://provider-a',
          wsUrl: 'ws://provider-a',
        };
      },
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      { ownerStore },
    );
    router.teardownSandboxResult = async () => {
      if (fallbackMode === 'throw') throw new Error('fallback unavailable');
      return { kind: 'coordination-pending', durablePending: true };
    };
    await assert.rejects(
      router.provision(
        provisionContext(taskId, {
          ownership: generationAuthorization(taskId).ownership,
        }),
      ),
      (error) => error?.code === 'sandbox_cleanup_coordination_pending',
    );
  }
});

await test('legacy cleanup rechecks authority after a settled in-flight provision', async () => {
  const taskId = 'legacy-refreshed-authority';
  let authorityCalls = 0;
  const store = {
    async getSandboxRunOwner() {
      return null;
    },
    async getSandboxRunCleanupAuthority() {
      authorityCalls += 1;
      if (authorityCalls === 1) return absentAuthority();
      if (authorityCalls === 2) return legacyPendingAuthority();
      return { ...absentAuthority(), state: 'succeeded', status: 'removed' };
    },
  };
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', provider('provider-a'))],
    { ownerStore: store },
  );
  router.legacyProvisioningInFlight.set(taskId, {
    providerId: 'provider-a',
    settled: Promise.resolve(),
    settle() {},
  });
  const result = await router.runLegacySandboxCleanup(taskId, {});
  assert.equal(result.kind, 'physical');
  assert.equal(result.physical.outcome, 'succeeded');
  assert.equal(authorityCalls, 3);
});

await test('legacy cleanup rejects non-authorized initial and refreshed fences', async () => {
  {
    const taskId = 'legacy-initial-not-authorized';
    const owner = legacyOwner({ taskId, createState: 'entered' });
    const router = new mod.SandboxProviderRouter([], {
      ownerStore: {
        async getSandboxRunOwner() { return owner; },
        async beginSandboxRunCleanup() { return { kind: 'pending' }; },
      },
    });
    assert.equal(
      (await router.runLegacySandboxCleanup(taskId, {})).kind,
      'coordination-pending',
    );
  }

  for (const refreshedKind of ['settled', 'pending']) {
    const taskId = `legacy-refreshed-${refreshedKind}`;
    const owner = legacyOwner({ taskId, createState: 'entered' });
    let beginCalls = 0;
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      {
        ownerStore: {
          async getSandboxRunOwner() { return owner; },
          async beginSandboxRunCleanup() {
            beginCalls += 1;
            if (beginCalls === 1) {
              return {
                kind: 'authorized',
                authorization: legacyAuthorization(taskId),
                owner,
              };
            }
            return refreshedKind === 'settled'
              ? { kind: 'settled', owner: { ...owner, status: 'removed' } }
              : { kind: 'pending' };
          },
        },
      },
    );
    router.legacyProvisioningInFlight.set(taskId, {
      providerId: 'provider-a',
      settled: Promise.resolve(),
      settle() {},
    });
    const result = await router.runLegacySandboxCleanup(taskId, {});
    assert.equal(
      result.kind,
      refreshedKind === 'settled' ? 'physical' : 'coordination-pending',
    );
  }
});

function deliveryCredentialArgs() {
  return {
    branch: 'main',
    commitMessage: 'deliver',
    credential: mod.createExactHostGitCredential(
      'https://code.example.test/repo.git',
      'Authorization: Basic router-finalization',
    ),
  };
}

function durableDeliveryHarness(taskId, deliverWorkspaceChanges) {
  const authorization = generationAuthorization(taskId);
  const owner = generatedCleanupOwner(taskId, {
    status: 'running',
    providerSandboxId: 'sandbox-a',
  });
  const store = cleanupStoreForAuthorization(authorization, owner, {
    async getSandboxRunOwner() {
      return owner;
    },
  });
  const instance = provider(
    'provider-a',
    ['workspace.git.deliver', 'lifecycle.readopt'],
    {
      async reattach(nextTaskId) {
        return {
          taskId: nextTaskId,
          baseUrl: 'http://provider-a',
          wsUrl: 'ws://provider-a',
        };
      },
      deliverWorkspaceChanges,
    },
  );
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', instance)],
    { ownerStore: store },
  );
  return { router, authorization };
}

await test('delivery success refuses coordination-pending provider cleanup', async () => {
  const taskId = 'delivery-success-coordination';
  const { router } = durableDeliveryHarness(
    taskId,
    async (_taskId, args) => {
      await args.beforeSandboxCleanup();
      await args.beforeSandboxCleanup();
      return { hadChanges: false, commitSha: null, error: null };
    },
  );
  await assert.rejects(
    router.deliverWorkspaceChanges(taskId, deliveryCredentialArgs()),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );
});

await test('delivery success exhausts each settled-physical fallback outcome', async () => {
  for (const fallbackMode of ['throw', 'pending', 'physical']) {
    const taskId = `delivery-success-fallback-${fallbackMode}`;
    const { router } = durableDeliveryHarness(
      taskId,
      async (_taskId, args) => {
        const authorization = await args.beforeSandboxCleanup();
        await args.settleSandboxCleanupAttempt(
          authorization,
          failedPhysical(),
        );
        return { hadChanges: false, commitSha: null, error: null };
      },
    );
    router.teardownSandboxResult = async () => {
      if (fallbackMode === 'throw') throw new Error('fallback unavailable');
      if (fallbackMode === 'pending') {
        return { kind: 'coordination-pending', durablePending: true };
      }
      return {
        kind: 'physical',
        physical: succeeded(),
        durablePending: false,
      };
    };
    await assert.rejects(
      router.deliverWorkspaceChanges(taskId, deliveryCredentialArgs()),
      (error) => error?.code === 'sandbox_cleanup_coordination_pending',
    );
  }
});

await test('delivery failure without cleanup callbacks preserves the provider error', async () => {
  const taskId = 'legacy-delivery-failure-no-cleanup';
  const primary = new Error('legacy delivery failed');
  const instance = provider(
    'provider-a',
    ['terminal.websocket', 'workspace.git.deliver', 'lifecycle.readopt'],
    {
      async deliverWorkspaceChanges() {
        throw primary;
      },
    },
  );
  const router = new mod.SandboxProviderRouter([
    descriptor('provider-a', instance),
  ]);
  await router.provision(provisionContext(taskId));
  await assert.rejects(
    router.deliverWorkspaceChanges(taskId, {
      branch: 'main',
      commitMessage: 'deliver',
      authHeader: 'Authorization: Basic legacy-delivery',
    }),
    (error) => error === primary,
  );
});

await test('delivery failure with settled physical cleanup preserves its primary', async () => {
  const taskId = 'delivery-failure-settled-physical';
  const primary = new Error('delivery failed after cleanup');
  const { router } = durableDeliveryHarness(
    taskId,
    async (_taskId, args) => {
      const authorization = await args.beforeSandboxCleanup();
      await args.settleSandboxCleanupAttempt(authorization, failedPhysical());
      throw primary;
    },
  );
  router.teardownSandboxResult = async () => ({
    kind: 'physical',
    physical: failedPhysical(),
    durablePending: true,
  });
  await assert.rejects(
    router.deliverWorkspaceChanges(taskId, deliveryCredentialArgs()),
    (error) => error === primary,
  );
});

await test('provision passes detached transfer control flow through unchanged', async () => {
  const signal = new mod.SandboxWorkspaceTransferDetachedSignal({
    taskId: 'detached-router-signal',
    jobId: 'job-router-signal',
    async probe() { return { kind: 'alive' }; },
    async kill() {},
  });
  const router = new mod.SandboxProviderRouter([
    descriptor(
      'provider-a',
      provider('provider-a', ['terminal.websocket'], {
        async provision() { throw signal; },
      }),
    ),
  ]);
  await assert.rejects(
    router.provision(provisionContext('detached-router-signal')),
    (error) => error === signal,
  );
});

await test('generated provider callbacks expose absent cleanup and forward create observations', async () => {
  const taskId = 'generated-absent-cleanup-observation';
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  ownerStore.joinSandboxRunCleanup = async () => ({ kind: 'absent' });
  let forwardedObservation;
  const instance = provider('provider-a', ['terminal.websocket'], {
    async provision(ctx) {
      assert.equal(await ctx.beforeSandboxCleanup(), null);
      await ctx.onSandboxCreateObserved({
        kind: 'created',
        providerSandboxId: 'sandbox-observed',
      });
      return {
        taskId: ctx.taskId,
        baseUrl: 'http://provider-a',
        wsUrl: 'ws://provider-a',
      };
    },
  });
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', instance)],
    { ownerStore },
  );
  await router.provision(
    provisionContext(taskId, {
      ownership: generationAuthorization(taskId).ownership,
      onSandboxCreateObserved: async (observation) => {
        forwardedObservation = observation;
      },
    }),
  );
  assert.deepEqual(forwardedObservation, {
    kind: 'created',
    providerSandboxId: 'sandbox-observed',
  });
});

await test('teardown returns confirmed absence and allocation conflicts without evidence', async () => {
  {
    const taskId = 'teardown-authority-absent';
    const router = new mod.SandboxProviderRouter([], {
      ownerStore: {
        async beginSandboxRunCleanup() { return { kind: 'absent' }; },
      },
    });
    router.owners.set(taskId, 'provider-a');
    const result = await router.teardownSandboxResult(taskId, {
      ownership: generationAuthorization(taskId).ownership,
    });
    assert.equal(result.kind, 'physical');
    assert.equal(result.physical.outcome, 'succeeded');
    assert.equal(router.owners.has(taskId), false);
  }
  {
    const taskId = 'teardown-allocation-conflict-no-evidence';
    const authorization = generationAuthorization(taskId);
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      {
        ownerStore: cleanupStoreForAuthorization(authorization, undefined, {
          async beginSandboxRunCleanupAttempt() {
            return { kind: 'conflict' };
          },
        }),
      },
    );
    const result = await router.teardownSandboxResult(taskId, {
      cleanupAuthorization: authorization,
    });
    assert.equal(result.kind, 'coordination-pending');
    assert.equal(result.physical, undefined);
  }
});

await test('owned legacy teardown forwards diagnostics to its provider', async () => {
  const taskId = 'legacy-owned-diagnostics';
  const diagnostics = { flush() {} };
  let providerOptions;
  const owner = legacyOwner({ taskId });
  const router = new mod.SandboxProviderRouter(
    [
      descriptor(
        'provider-a',
        provider('provider-a', ['terminal.websocket'], {
          async teardownSandbox(_taskId, options) {
            providerOptions = options;
            return { kind: 'already-absent' };
          },
        }),
      ),
    ],
    { ownerStore: { async getSandboxRunOwner() { return owner; } } },
  );
  await router.teardownSandboxResult(taskId, { diagnostics });
  assert.equal(providerOptions.diagnostics, diagnostics);
});

await test('legacy cleanup preserves failed evidence while joining create fences', async () => {
  for (const mode of ['missing', 'timeout']) {
    const taskId = `legacy-failed-preliminary-${mode}`;
    const owner = legacyOwner({
      taskId,
      createState: 'entered',
      providerSandboxId: 'sandbox-entered',
    });
    const diagnostics = { flush() {} };
    const seenOptions = [];
    const store = {
      async getSandboxRunOwner() { return owner; },
      async beginSandboxRunCleanup() {
        return {
          kind: 'authorized',
          authorization: legacyAuthorization(taskId),
          owner,
        };
      },
    };
    const router = new mod.SandboxProviderRouter(
      [
        descriptor(
          'provider-a',
          provider('provider-a', ['terminal.websocket'], {
            async teardownSandbox(_taskId, options) {
              seenOptions.push(options);
              return failedPhysical();
            },
          }),
        ),
      ],
      { ownerStore: store, legacyProvisionJoinTimeoutMs: 1 },
    );
    if (mode === 'timeout') {
      router.legacyProvisioningInFlight.set(taskId, {
        providerId: 'provider-a',
        settled: new Promise(() => {}),
        settle() {},
      });
    }
    const result = await router.runLegacySandboxCleanup(taskId, { diagnostics });
    assert.equal(result.kind, 'coordination-pending');
    assert.equal(result.physical.outcome, 'failed');
    assert.equal(seenOptions[0].providerSandboxId, 'sandbox-entered');
    assert.equal(seenOptions[0].diagnostics, diagnostics);
  }

  const timeoutTaskId = 'legacy-provider-backed-failed-timeout';
  const timeoutRouter = new mod.SandboxProviderRouter(
    [
      descriptor(
        'provider-a',
        provider('provider-a', ['terminal.websocket'], {
          async teardownSandbox() { return failedPhysical(); },
        }),
      ),
    ],
    {
      ownerStore: {
        async getSandboxRunOwner() { return null; },
        async getSandboxRunCleanupAuthority() { return absentAuthority(); },
      },
      legacyProvisionJoinTimeoutMs: 1,
    },
  );
  timeoutRouter.legacyProvisioningInFlight.set(timeoutTaskId, {
    providerId: 'provider-a',
    settled: new Promise(() => {}),
    settle() {},
  });
  const timeoutResult = await timeoutRouter.runLegacySandboxCleanup(
    timeoutTaskId,
    {},
  );
  assert.equal(timeoutResult.physical.outcome, 'failed');
});

await test('legacy cleanup fails closed for generation owners and incomplete routing ports', async () => {
  const cases = [
    {
      taskId: 'legacy-generation-owner',
      providers: [],
      store: {
        async getSandboxRunOwner() {
          return generatedCleanupOwner('legacy-generation-owner');
        },
      },
    },
    {
      taskId: 'legacy-missing-begin-cleanup',
      providers: [],
      store: {
        async getSandboxRunOwner() {
          return legacyOwner({
            taskId: 'legacy-missing-begin-cleanup',
            createState: 'entered',
          });
        },
      },
    },
    {
      taskId: 'legacy-missing-owner-provider',
      providers: [],
      store: {
        async getSandboxRunOwner() {
          return legacyOwner({
            taskId: 'legacy-missing-owner-provider',
            createState: 'entered',
            providerId: 'missing-provider',
          });
        },
        async beginSandboxRunCleanup() {
          return {
            kind: 'authorized',
            authorization: legacyAuthorization('legacy-missing-owner-provider'),
            owner: legacyOwner({
              taskId: 'legacy-missing-owner-provider',
              createState: 'entered',
              providerId: 'missing-provider',
            }),
          };
        },
      },
    },
  ];
  for (const { taskId, providers, store } of cases) {
    const router = new mod.SandboxProviderRouter(providers, { ownerStore: store });
    assert.equal(
      (await router.runLegacySandboxCleanup(taskId, {})).kind,
      'coordination-pending',
    );
  }
});

function persistedSucceededLegacyOwner(taskId, overrides = {}) {
  return legacyOwner({
    taskId,
    status: 'deleting',
    createState: 'idle',
    cleanupAttemptCount: 1,
    cleanupLastAttemptId: '33000000-0000-4000-8000-000000000001',
    cleanupLastOutcome: 'succeeded',
    cleanupLastProof: 'already-absent',
    cleanupLastCause: null,
    cleanupLastRetryable: false,
    cleanupLastObservedAt: new Date('2026-07-25T00:00:00.000Z'),
    ...overrides,
  });
}

function resumedLegacyStore(taskId, owner, overrides = {}) {
  return {
    async getSandboxRunOwner() { return null; },
    async getSandboxRunCleanupAuthority() { return legacyPendingAuthority(); },
    async beginSandboxRunCleanup() {
      return {
        kind: 'authorized',
        authorization: legacyAuthorization(taskId),
        owner,
      };
    },
    async beginSandboxRunCleanupAttempt() {
      return { kind: 'allocated', evidence: evidence() };
    },
    async settleSandboxRunCleanupAttempt() { return { kind: 'recorded' }; },
    async completeSandboxRunCleanup() { return true; },
    async closeLegacySandboxRunCreateFence() { return true; },
    ...overrides,
  };
}

await test('resumed legacy cleanup retries persisted completion and reports a failed CAS', async () => {
  const taskId = 'legacy-resumed-completion-failed';
  const owner = persistedSucceededLegacyOwner(taskId);
  let completedStatus;
  const store = resumedLegacyStore(taskId, owner, {
    async completeSandboxRunCleanup(_authorization, status) {
      completedStatus = status;
      return false;
    },
  });
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', provider('provider-a'))],
    { ownerStore: store },
  );
  const result = await router.runLegacySandboxCleanup(taskId, {
    disposition: 'superseded-remove',
  });
  assert.equal(result.kind, 'coordination-pending');
  assert.equal(result.physical.outcome, 'succeeded');
  assert.equal(completedStatus, 'removed');
});

await test('resumed legacy cleanup keeps allocation conflicts without fabricated evidence', async () => {
  const taskId = 'legacy-allocation-conflict-no-evidence';
  const owner = legacyOwner({ taskId, status: 'deleting', createState: 'idle' });
  const store = resumedLegacyStore(taskId, owner, {
    async beginSandboxRunCleanupAttempt() { return { kind: 'conflict' }; },
  });
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', provider('provider-a'))],
    { ownerStore: store },
  );
  const result = await router.runLegacySandboxCleanup(taskId, {});
  assert.equal(result.kind, 'coordination-pending');
  assert.equal(result.physical, undefined);
});

await test('entered legacy cleanup fences exact ids and preserves close or completion failures', async () => {
  for (const mode of ['close-failed', 'complete-failed']) {
    const taskId = `legacy-entered-${mode}`;
    const owner = legacyOwner({
      taskId,
      status: 'deleting',
      createState: 'entered',
      providerSandboxId: 'sandbox-entered',
    });
    const diagnostics = { flush() {} };
    const calls = [];
    const store = resumedLegacyStore(taskId, owner, {
      async getSandboxRunOwner() { return owner; },
      async getSandboxRunCleanupAuthority() { return absentAuthority(); },
      async closeLegacySandboxRunCreateFence(args) {
        calls.push(['close', args]);
        return mode !== 'close-failed';
      },
      async completeSandboxRunCleanup(_authorization, status) {
        calls.push(['complete', status]);
        return mode !== 'complete-failed';
      },
    });
    const instance = provider('provider-a', ['terminal.websocket'], {
      async teardownSandbox(_taskId, options) {
        calls.push(['teardown', options]);
        return { kind: 'already-absent' };
      },
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', instance)],
      { ownerStore: store },
    );
    router.legacyProvisioningInFlight.set(taskId, {
      providerId: 'provider-a',
      settled: Promise.resolve(),
      settle() {},
    });
    const result = await router.runLegacySandboxCleanup(taskId, {
      disposition: 'superseded-remove',
      diagnostics,
    });
    assert.equal(result.kind, 'coordination-pending');
    assert.equal(calls[0][1].providerSandboxId, 'sandbox-entered');
    assert.equal(calls[0][1].diagnostics, diagnostics);
    assert.equal(calls.some(([kind]) => kind === 'close'), true);
    if (mode === 'complete-failed') {
      assert.equal(
        calls.some(([kind, status]) => kind === 'complete' && status === 'removed'),
        true,
      );
    }
  }
});

await test('direct legacy cleanup preserves optional provider context and stale settlement', async () => {
  const taskId = 'legacy-direct-stale-settlement';
  const diagnostics = { flush() {} };
  let providerOptions;
  let settledArgs;
  const owner = legacyOwner({
    taskId,
    providerSandboxId: 'sandbox-direct',
    cleanupAttemptCount: undefined,
  });
  const router = new mod.SandboxProviderRouter(
    [
      descriptor(
        'provider-a',
        provider('provider-a', ['terminal.websocket'], {
          async teardownSandbox(_taskId, options) {
            providerOptions = options;
            return { kind: 'already-absent' };
          },
        }),
      ),
    ],
    {
      ownerStore: {
        async settleLegacySandboxRunCleanup(args) {
          settledArgs = args;
          return { kind: 'stale' };
        },
      },
    },
  );
  const result = await router.runDirectLegacySandboxCleanup(taskId, owner, {
    disposition: 'superseded-remove',
    diagnostics,
  });
  assert.equal(result.kind, 'coordination-pending');
  assert.equal(providerOptions.providerSandboxId, 'sandbox-direct');
  assert.equal(providerOptions.diagnostics, diagnostics);
  assert.equal(settledArgs.evidence.attempt, 1);
  assert.equal(settledArgs.status, 'removed');
});

await test('provider-backed legacy cleanup forwards diagnostics', async () => {
  const diagnostics = { flush() {} };
  let providerOptions;
  const router = new mod.SandboxProviderRouter([
    descriptor(
      'provider-a',
      provider('provider-a', ['terminal.websocket'], {
        async teardownSandbox(_taskId, options) {
          providerOptions = options;
          return { kind: 'already-absent' };
        },
      }),
    ),
  ]);
  await router.runLegacyProviderBackedCleanup(
    'legacy-provider-backed-diagnostics',
    { diagnostics },
  );
  assert.equal(providerOptions.diagnostics, diagnostics);
});

await test('durable cleanup remains pending while successful completion is still in flight', async () => {
  const completionEntered = deferred();
  const releaseCompletion = deferred();
  const { callbacks } = durableCallbacks({
    store: durableCallbackStore({
      async completeSandboxRunCleanup() {
        completionEntered.resolve();
        await releaseCompletion.promise;
        return true;
      },
    }),
  });
  const authorization = await callbacks.beforeSandboxCleanup();
  const completion = callbacks.afterSandboxCleanup(authorization);
  await completionEntered.promise;
  assert.equal(
    (await callbacks.settleIncomplete()).kind,
    'coordination-pending',
  );
  releaseCompletion.resolve();
  await completion;
  assert.deepEqual(await callbacks.settleIncomplete(), { kind: 'none' });
});

await test('ownership acquisition generates a resource id on both empty-generation attempts', async () => {
  const requested = {
    ownerGeneration: 'owner:empty-resource',
    resourceGeneration: '',
  };
  const proposed = [];
  let calls = 0;
  const store = completeOwnershipStore(async (args) => {
    proposed.push(args.proposedResourceGeneration);
    calls += 1;
    return calls === 1
      ? {
          kind: 'cleanup-required',
          owner: legacyOwner({ taskId: 'acquire-empty-resource' }),
        }
      : {
          kind: 'acquired',
          ownership: {
            ownerGeneration: requested.ownerGeneration,
            resourceGeneration: args.proposedResourceGeneration,
          },
        };
  });
  const router = new mod.SandboxProviderRouter([], { ownerStore: store });
  router.teardownSandbox = async () => undefined;
  const acquired = await router.acquireProvisionOwnership(
    'acquire-empty-resource',
    'provider-a',
    requested,
  );
  assert.equal(proposed.length, 2);
  assert.equal(proposed.every((value) => value.length > 0), true);
  assert.equal(acquired.resourceGeneration, proposed[1]);
});

await test('delivery reattach reloads the persisted owner written by the provider probe', async () => {
  const taskId = 'delivery-reattach-owner-reload';
  let stored = null;
  const store = {
    async getSandboxRunOwner() { return stored; },
    async recordSandboxRunOwner(record) {
      stored = { ...record, status: 'running', createState: 'idle' };
    },
  };
  const instance = provider(
    'provider-a',
    ['workspace.git.deliver', 'lifecycle.readopt'],
    {
      async reattach(nextTaskId) {
        return {
          taskId: nextTaskId,
          baseUrl: 'http://provider-a',
          wsUrl: 'ws://provider-a',
        };
      },
      async getSelectedSandboxRun() {
        return {
          providerId: 'provider-a',
          providerSandboxId: 'sandbox-reattached',
          environment: {
            providerId: 'provider-a',
            sourceKind: 'boxlite-image',
            sourceRef: 'image:v1',
          },
        };
      },
    },
  );
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', instance)],
    { ownerStore: store },
  );
  const result = await router.deliverWorkspaceChanges(taskId, {
    branch: 'main',
    commitMessage: 'deliver',
    authHeader: 'Authorization: Basic reload-owner',
  });
  assert.equal(result.error, null);
  assert.equal(stored.providerSandboxId, 'sandbox-reattached');
  assert.equal(stored.environment.providerId, 'provider-a');
});

await test('credentialed delivery fails closed when the persisted provider cannot reattach', async () => {
  const taskId = 'delivery-provider-without-reattach';
  const owner = generatedCleanupOwner(taskId, {
    status: 'running',
    providerSandboxId: 'sandbox-no-reattach',
  });
  const instance = provider(
    'provider-a',
    ['workspace.git.deliver', 'lifecycle.readopt'],
    { reattach: undefined },
  );
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', instance)],
    { ownerStore: { async getSandboxRunOwner() { return owner; } } },
  );
  const result = await router.deliverWorkspaceChanges(
    taskId,
    deliveryCredentialArgs(),
  );
  assert.match(result.error, /could not reattach/);
});

await test('delivery rethrows an existing cleanup-pending signal without wrapping', async () => {
  const taskId = 'delivery-existing-cleanup-pending';
  const pending = new mod.SandboxCleanupCoordinationPendingError();
  const instance = provider(
    'provider-a',
    ['terminal.websocket', 'workspace.git.deliver', 'lifecycle.readopt'],
    { async deliverWorkspaceChanges() { throw pending; } },
  );
  const router = new mod.SandboxProviderRouter([
    descriptor('provider-a', instance),
  ]);
  await router.provision(provisionContext(taskId));
  await assert.rejects(
    router.deliverWorkspaceChanges(taskId, {
      branch: 'main',
      commitMessage: 'deliver',
      authHeader: 'Authorization: Basic pending',
    }),
    (error) => error === pending,
  );
});

await test('inventory aggregation tolerates missing provider result fields', async () => {
  const providers = [undefined, {}].map((result, index) =>
    descriptor(
      `provider-${index}`,
      provider(
        `provider-${index}`,
        ['terminal.websocket', 'lifecycle.readopt'],
        { async reconcileSandboxInventory() { return result; } },
      ),
    ),
  );
  const router = new mod.SandboxProviderRouter(providers);
  assert.deepEqual(
    await router.reconcileSandboxInventory({
      protectedTaskIds: [],
      canReap: async () => true,
    }),
    { inspected: 0, reaped: 0 },
  );
});

await test('selected-run aggregation falls back when provider metadata is undefined', async () => {
  const taskId = 'selected-run-undefined-metadata';
  const connection = {
    taskId,
    baseUrl: 'http://provider-a',
    wsUrl: 'ws://provider-a',
  };
  const owner = legacyOwner({ taskId, connection });
  const instance = provider(
    'provider-a',
    ['terminal.websocket', 'lifecycle.readopt'],
    {
      async reattach() { return connection; },
      async getSelectedSandboxRun() { return undefined; },
    },
  );
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', instance)],
    { ownerStore: { async getSandboxRunOwner() { return owner; } } },
  );
  const selected = await router.getSelectedSandboxRun(taskId);
  assert.equal(selected.connection, connection);
});

await test('reattach persistence includes selected physical identity and environment', async () => {
  const taskId = 'reattach-selected-persistence';
  let recorded;
  const connection = {
    taskId,
    baseUrl: 'http://provider-a',
    wsUrl: 'ws://provider-a',
  };
  const environment = {
    providerId: 'provider-a',
    sourceKind: 'boxlite-image',
    sourceRef: 'image:v1',
  };
  const instance = provider(
    'provider-a',
    ['terminal.websocket', 'lifecycle.readopt'],
    {
      async reattach() { return connection; },
      async getSelectedSandboxRun() {
        return {
          providerId: 'provider-a',
          providerSandboxId: 'sandbox-selected',
          environment,
          connection,
        };
      },
    },
  );
  const router = new mod.SandboxProviderRouter(
    [descriptor('provider-a', instance)],
    {
      ownerStore: {
        async getSandboxRunOwner() { return null; },
        async recordSandboxRunOwner(next) { recorded = next; },
      },
    },
  );
  await router.reattachOwner(taskId, { includeSelectedRun: true });
  assert.equal(recorded.providerSandboxId, 'sandbox-selected');
  assert.equal(recorded.environment, environment);
});

await test('delivery context preserves cancellation, deadline, and ownerless credential args', async () => {
  const controller = new AbortController();
  const router = new mod.SandboxProviderRouter([]);
  const args = {
    ...deliveryCredentialArgs(),
    cancellationSignal: controller.signal,
    deadlineMs: 12_345,
  };
  const delivery = router.deliveryContextForOwner(
    'delivery-optional-args',
    'provider-a',
    undefined,
    args,
  );
  assert.equal(delivery.args.cancellationSignal, controller.signal);
  assert.equal(delivery.args.deadlineMs, 12_345);
  assert.equal(delivery.cleanup, undefined);
});

await test('generated delivery treats absent cleanup authority as a no-op', async () => {
  const taskId = 'delivery-cleanup-authority-absent';
  const owner = generatedCleanupOwner(taskId, { status: 'running' });
  const router = new mod.SandboxProviderRouter([], {
    ownerStore: durableCallbackStore({
      async beginSandboxRunCleanup() { return { kind: 'absent' }; },
    }),
  });
  const delivery = router.deliveryContextForOwner(
    taskId,
    'provider-a',
    owner,
    deliveryCredentialArgs(),
  );
  assert.equal(await delivery.args.beforeSandboxCleanup(), null);
  assert.deepEqual(await delivery.cleanup.settleIncomplete(), { kind: 'none' });
});

await test('verified target invalidation detects physical sandbox replacement', async () => {
  const taskId = 'verified-target-replaced';
  const instance = provider(
    'provider-a',
    ['terminal.websocket', 'lifecycle.readopt'],
    {
      async getSelectedSandboxRun() {
        return { providerId: 'provider-a', providerSandboxId: 'sandbox-new' };
      },
    },
  );
  const entry = descriptor('provider-a', instance);
  const router = new mod.SandboxProviderRouter([entry]);
  router.rememberVerifiedDeliveryTarget(taskId, 'provider-a', {
    providerSandboxId: 'sandbox-old',
  });
  assert.equal(
    await router.isVerifiedDeliveryTarget(taskId, entry, {
      providerSandboxId: 'sandbox-old',
    }),
    false,
  );
  assert.equal(router.verifiedDeliveryTargets.has(taskId), false);

  router.rememberVerifiedDeliveryTarget(taskId, 'provider-a', {
    providerSandboxId: 'sandbox-one',
  });
  assert.equal(
    await router.isVerifiedDeliveryTarget(taskId, entry, {
      providerSandboxId: 'sandbox-two',
    }),
    false,
  );
});

await test('cleanup authority projection covers legacy running defaults', async () => {
  const taskId = 'claim-settled-legacy-running';
  const owner = {
    taskId,
    providerId: 'provider-a',
    status: 'running',
    createState: 'idle',
    cleanupAttemptInFlight: false,
  };
  const router = new mod.SandboxProviderRouter([], {
    ownerStore: {
      async claimSandboxRunCleanup() { return { kind: 'settled', owner }; },
    },
  });
  const claim = await router.claimSandboxCleanupOwnership(taskId, 'owner:g1');
  assert.equal(claim.kind, 'settled');
  assert.equal(claim.authority.state, 'not_required');
  assert.equal(claim.authority.ownershipKind, 'legacy');
  assert.equal(claim.authority.attemptCount, 0);
});

await test('legacy completion uses terminal disposition and supports omitted physical metadata', async () => {
  {
    const taskId = 'legacy-resumed-terminal-completion';
    const owner = persistedSucceededLegacyOwner(taskId);
    let status;
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      {
        ownerStore: resumedLegacyStore(taskId, owner, {
          async completeSandboxRunCleanup(_authorization, nextStatus) {
            status = nextStatus;
            return true;
          },
        }),
      },
    );
    assert.equal(
      (await router.runLegacySandboxCleanup(taskId, {})).kind,
      'physical',
    );
    assert.equal(status, 'terminal');
  }

  {
    const taskId = 'legacy-entered-terminal-completion';
    const owner = legacyOwner({
      taskId,
      status: 'deleting',
      createState: 'entered',
    });
    let status;
    const store = resumedLegacyStore(taskId, owner, {
      async getSandboxRunOwner() { return owner; },
      async completeSandboxRunCleanup(_authorization, nextStatus) {
        status = nextStatus;
        return true;
      },
    });
    const router = new mod.SandboxProviderRouter(
      [descriptor('provider-a', provider('provider-a'))],
      { ownerStore: store },
    );
    router.legacyProvisioningInFlight.set(taskId, {
      providerId: 'provider-a',
      settled: Promise.resolve(),
      settle() {},
    });
    assert.equal(
      (await router.runLegacySandboxCleanup(taskId, {})).kind,
      'physical',
    );
    assert.equal(status, 'terminal');
  }

  {
    const taskId = 'legacy-direct-without-physical-id';
    let providerOptions;
    const owner = legacyOwner({ taskId, providerSandboxId: undefined });
    const router = new mod.SandboxProviderRouter(
      [
        descriptor(
          'provider-a',
          provider('provider-a', ['terminal.websocket'], {
            async teardownSandbox(_taskId, options) {
              providerOptions = options;
              return { kind: 'already-absent' };
            },
          }),
        ),
      ],
      {
        ownerStore: {
          async settleLegacySandboxRunCleanup() { return { kind: 'recorded' }; },
        },
      },
    );
    assert.equal(
      (await router.runDirectLegacySandboxCleanup(taskId, owner, {})).kind,
      'physical',
    );
    assert.equal('providerSandboxId' in providerOptions, false);
  }
});

await test('legacy cleanup defaults an omitted attempt count in callback and settled evidence paths', async () => {
  {
    const owner = {
      taskId: 'task-legacy',
      providerId: 'provider-a',
      status: 'running',
      createState: 'idle',
      cleanupAttemptInFlight: false,
    };
    let attempt;
    const { callbacks } = legacyCallbacks({
      async getSandboxRunOwner() { return owner; },
      async settleLegacySandboxRunCleanup(args) {
        attempt = args.evidence.attempt;
        return { kind: 'recorded' };
      },
    });
    const authorization = await callbacks.beforeSandboxCleanup();
    await callbacks.afterSandboxCleanup(authorization);
    assert.equal(attempt, 1);
  }

  {
    const taskId = 'settled-removed-without-attempt-count';
    const owner = {
      taskId,
      providerId: 'provider-a',
      status: 'removed',
      createState: 'idle',
      cleanupAttemptInFlight: false,
    };
    const router = new mod.SandboxProviderRouter([], {
      ownerStore: {
        async beginSandboxRunCleanup() { return { kind: 'settled', owner }; },
      },
    });
    const result = await router.teardownSandboxResult(taskId, {
      ownership: generationAuthorization(taskId).ownership,
    });
    assert.equal(result.kind, 'physical');
    assert.equal(result.physical.outcome, 'succeeded');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
