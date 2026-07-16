import assert from 'node:assert/strict';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

function provider(name, capabilities) {
  return {
    getSandboxMode: () => name,
    getProviderCapabilities: capabilities === undefined ? undefined : () => capabilities,
  };
}

function provisionContext(taskId, cloneSpec = null) {
  return {
    taskId,
    cloneSpec,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
  };
}

function routableProvider(name, capabilities, options = {}) {
  const calls = [];
  const provisionContexts = [];
  const connection = {
    taskId: options.reattachTask ?? 'task',
    baseUrl: `http://${name}`,
    wsUrl: `ws://${name}`,
  };
  return {
    calls,
    provisionContexts,
    getSandboxMode: () => options.mode ?? 'workspace-write',
    getProviderCapabilities: capabilities === undefined ? undefined : () => capabilities,
    async provision(ctx) {
      provisionContexts.push(ctx);
      calls.push(['provision', ctx.taskId, ctx.cloneSpec ?? null]);
      return {
        taskId: ctx.taskId,
        baseUrl: `http://${name}/${ctx.taskId}`,
        wsUrl: `ws://${name}/${ctx.taskId}`,
      };
    },
    async teardownSandbox(taskId, teardownOptions) {
      calls.push(['teardown', taskId, teardownOptions?.ownership ?? null]);
    },
    async readRolloutFromContainer(taskId, runtimeId) {
      calls.push(['read', taskId, runtimeId ?? null]);
      return options.rollout ?? null;
    },
    async sandboxExists(taskId) {
      calls.push(['exists', taskId]);
      return options.exists === true;
    },
    async deliverWorkspaceChanges(taskId, args) {
      calls.push(['deliver', taskId, args.branch]);
      return {
        hadChanges: true,
        commitSha: name,
        error: null,
      };
    },
    async listReadoptable() {
      calls.push(['listReadoptable']);
      return options.readoptable ?? [];
    },
    async reconcileSandboxInventory(input) {
      calls.push(['reconcileSandboxInventory', [...input.protectedTaskIds]]);
      for (const candidate of options.reconcileCandidates ?? []) {
        calls.push([
          'reconcileAuthorization',
          candidate,
          await input.canReap(candidate),
        ]);
      }
      return options.reconcileResult ?? { inspected: [], reaped: [] };
    },
    async reattach(taskId) {
      calls.push(['reattach', taskId]);
      return options.reattachTask === taskId
        ? { ...connection, taskId }
        : null;
    },
    async getSelectedSandboxRun(taskId) {
      calls.push(['selectedRun', taskId]);
      return options.selectedRun?.(taskId) ?? null;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

await test('single-provider selector preserves legacy compatibility', () => {
  const legacy = provider('legacy-local', undefined);
  const selected = mod.selectSandboxProvider(legacy, ['terminal.websocket']);
  assert.equal(selected.provider, legacy);
  assert.equal(selected.compatibility, 'legacy-assumed');
  assert.deepEqual(selected.capabilities, []);
});

await test('single-provider selector fails closed for declared missing capabilities', () => {
  assert.throws(
    () => mod.selectSandboxProvider(provider('cloud-readonly', ['terminal.websocket']), [
      'terminal.websocket',
      'workspace.git.materialize',
    ]),
    /missing required capabilities: workspace\.git\.materialize/,
  );
});

await test('candidate selector chooses highest-priority cloud or local provider', () => {
  const local = provider('aio-local', ['terminal.websocket']);
  const cloud = provider('managed-cloud', ['terminal.websocket']);
  const selected = mod.selectSandboxProviderCandidate(
    [
      { id: 'local-aio', provider: local, location: 'local', priority: 10 },
      { id: 'cloud-managed', provider: cloud, location: 'cloud', priority: 50 },
    ],
    ['terminal.websocket'],
  );
  assert.equal(selected.id, 'cloud-managed');
  assert.equal(selected.location, 'cloud');
  assert.equal(selected.provider, cloud);
});

await test('candidate selector uses location preference as a tie-breaker', () => {
  const local = provider('aio-local', ['terminal.websocket']);
  const cloud = provider('managed-cloud', ['terminal.websocket']);
  const selected = mod.selectSandboxProviderCandidate(
    [
      { id: 'cloud-managed', provider: cloud, location: 'cloud', priority: 10 },
      { id: 'local-aio', provider: local, location: 'local', priority: 10 },
    ],
    ['terminal.websocket'],
    { preferLocation: 'local' },
  );
  assert.equal(selected.id, 'local-aio');

  const selectedAlreadyPreferred = mod.selectSandboxProviderCandidate(
    [
      { id: 'local-aio', provider: local, location: 'local', priority: 10 },
      { id: 'cloud-managed', provider: cloud, location: 'cloud', priority: 10 },
    ],
    ['terminal.websocket'],
    { preferLocation: 'local' },
  );
  assert.equal(selectedAlreadyPreferred.id, 'local-aio');
});

await test('candidate selector skips providers missing required capabilities', () => {
  const local = provider('aio-local', ['terminal.websocket']);
  const cloud = provider('managed-cloud', [
    'terminal.websocket',
    'workspace.git.materialize',
  ]);
  const selected = mod.selectSandboxProviderCandidate(
    [
      { id: 'local-aio', provider: local, location: 'local', priority: 100 },
      { id: 'cloud-managed', provider: cloud, location: 'cloud', priority: 10 },
    ],
    ['terminal.websocket', 'workspace.git.materialize'],
  );
  assert.equal(selected.id, 'cloud-managed');
});

await test('candidate selector reports missing capabilities across candidates', () => {
  assert.throws(
    () =>
      mod.selectSandboxProviderCandidate(
        [
          {
            id: 'local-aio',
            provider: provider('aio-local', ['terminal.websocket']),
            location: 'local',
          },
        ],
        ['workspace.git.deliver'],
      ),
    /No sandbox provider candidate satisfies required capabilities .*local-aio: missing workspace\.git\.deliver/,
  );
});

await test('candidate selector rejects undeclared candidates unless explicitly allowed', () => {
  const legacy = provider('legacy-local', undefined);
  assert.throws(
    () =>
      mod.selectSandboxProviderCandidate(
        [{ id: 'legacy', provider: legacy, location: 'local' }],
        ['terminal.websocket'],
      ),
    /no declared capabilities/,
  );

  const selected = mod.selectSandboxProviderCandidate(
    [{ id: 'legacy', provider: legacy, location: 'local' }],
    ['terminal.websocket'],
    { allowLegacyProvider: true },
  );
  assert.equal(selected.compatibility, 'legacy-assumed');
});

await test('candidate selector reports explicit-family no-candidate and stable-order cases', () => {
  assert.throws(
    () =>
      mod.selectSandboxProviderCandidate([], ['terminal.websocket'], {
        explicitProviderFamily: 'boxlite',
      }),
    /No sandbox provider candidates for explicit provider family "boxlite" are configured/,
  );

  const first = provider('first', ['terminal.websocket']);
  const second = provider('second', ['terminal.websocket']);
  const selected = mod.selectSandboxProviderCandidate(
    [
      { id: 'first', provider: first, location: 'local' },
      { id: 'second', provider: second, location: 'local' },
    ],
    ['terminal.websocket'],
  );
  assert.equal(selected.id, 'first');
});

await test('provider descriptor binds local/cloud metadata to declared capabilities', () => {
  const local = provider('aio-local', ['terminal.websocket']);
  const descriptor = mod.describeSandboxProvider({
    id: 'local-aio',
    provider: local,
    location: 'local',
    priority: 20,
  });
  assert.equal(descriptor.id, 'local-aio');
  assert.equal(descriptor.location, 'local');
  assert.equal(descriptor.provider, local);
  assert.equal(descriptor.priority, 20);
  assert.deepEqual(descriptor.capabilities, ['terminal.websocket']);
});

await test('provider descriptor requires explicit capabilities for undeclared adapters', () => {
  assert.throws(
    () =>
      mod.describeSandboxProvider({
        id: 'legacy-local',
        provider: provider('legacy-local', undefined),
        location: 'local',
      }),
    /requires declared capabilities/,
  );

  const explicit = mod.describeSandboxProvider({
    id: 'legacy-local',
    provider: provider('legacy-local', undefined),
    location: 'local',
    capabilities: ['terminal.websocket'],
  });
  assert.deepEqual(explicit.capabilities, ['terminal.websocket']);
});

await test('local/cloud provider helpers produce schedulable candidates', () => {
  const local = mod.defineLocalSandboxProvider({
    id: 'local-aio',
    provider: provider('aio-local', ['terminal.websocket']),
    priority: 5,
  });
  const cloud = mod.defineCloudSandboxProvider({
    id: 'cloud-managed',
    provider: provider('managed-cloud', ['terminal.websocket']),
    priority: 10,
  });

  assert.equal(local.location, 'local');
  assert.equal(cloud.location, 'cloud');

  const selected = mod.selectSandboxProviderCandidate(
    [local, cloud],
    ['terminal.websocket'],
  );
  assert.equal(selected.id, 'cloud-managed');
});

await test('provider registry manages local and cloud candidates independently', () => {
  const local = mod.defineLocalSandboxProvider({
    id: 'local-aio',
    provider: provider('aio-local', ['terminal.websocket']),
    priority: 5,
  });
  const cloud = mod.defineCloudSandboxProvider({
    id: 'cloud-managed',
    provider: provider('managed-cloud', [
      'terminal.websocket',
      'workspace.git.materialize',
    ]),
    priority: 10,
  });
  const registry = new mod.SandboxProviderRegistry([local]);
  registry.register(cloud);

  assert.deepEqual(registry.list({ location: 'local' }).map((entry) => entry.id), [
    'local-aio',
  ]);
  assert.deepEqual(registry.list({ location: 'cloud' }).map((entry) => entry.id), [
    'cloud-managed',
  ]);
  assert.deepEqual(registry.snapshot().providers.map((entry) => entry.id), [
    'local-aio',
    'cloud-managed',
  ]);

  const selected = registry.select(['terminal.websocket', 'workspace.git.materialize']);
  assert.equal(selected.id, 'cloud-managed');
});

await test('provider registry rejects duplicate provider ids', () => {
  const local = mod.defineLocalSandboxProvider({
    id: 'local-aio',
    provider: provider('aio-local', ['terminal.websocket']),
  });
  assert.throws(
    () => new mod.SandboxProviderRegistry([local, local]),
    /already registered/,
  );
});

await test('provision plan couples cloneSpec and required capabilities', () => {
  const cloneSpec = { url: 'https://example.test/repo.git' };
  const withWorkspace = mod.buildSandboxProvisionPlan({ cloneSpec });
  assert.equal(withWorkspace.cloneSpec, cloneSpec);
  assert.deepEqual(withWorkspace.requiredCapabilities, [
    'terminal.websocket',
    'workspace.git.materialize',
  ]);
  assert.deepEqual(withWorkspace.featureCapabilities, [
    'terminal.interactive',
    'command.exec',
  ]);

  const withoutWorkspace = mod.buildSandboxProvisionPlan({ cloneSpec: null });
  assert.equal(withoutWorkspace.cloneSpec, null);
  assert.deepEqual(withoutWorkspace.requiredCapabilities, ['terminal.websocket']);
  assert.deepEqual(withoutWorkspace.featureCapabilities, [
    'terminal.interactive',
    'command.exec',
  ]);

  const archivePlan = mod.buildSandboxProvisionPlan({
    cloneSpec,
    archiveWorkspace: true,
  });
  assert(archivePlan.featureCapabilities.includes('workspace.archive.transfer'));

  const resources = { diskSizeGb: 10 };
  const workspace = {
    repositoryUrl: 'https://example.test/repo.git',
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs: 900_000,
  };
  const resourcePlan = mod.buildSandboxProvisionPlan({
    cloneSpec,
    environment: { resources },
    workspace,
  });
  assert.deepEqual(resourcePlan.requiredCapabilities, [
    'terminal.websocket',
    'workspace.git.materialize',
    'resource.disk-size-gb',
  ]);
  assert.notEqual(resourcePlan.resources, resources);
  assert.notEqual(resourcePlan.workspace, workspace);
  assert.equal(Object.isFrozen(resourcePlan.resources), true);
  assert.equal(Object.isFrozen(resourcePlan.workspace), true);
});

await test('provider router gates explicit resources and forwards immutable context', async () => {
  const unsupported = routableProvider('unsupported', [
    'terminal.websocket',
    'workspace.git.materialize',
  ]);
  const supported = routableProvider('supported', [
    'terminal.websocket',
    'workspace.git.materialize',
    'resource.disk-size-gb',
  ]);
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'unsupported',
      provider: unsupported,
      priority: 100,
    }),
    mod.defineCloudSandboxProvider({
      id: 'supported',
      provider: supported,
      priority: 10,
    }),
  ]);
  const resources = { diskSizeGb: 8 };
  const workspace = {
    repositoryUrl: 'https://example.test/repo.git',
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs: 900_000,
  };
  const controller = new AbortController();

  await router.provision({
    taskId: 'task-resources',
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    resources,
    workspace,
    cancellationSignal: controller.signal,
  });

  assert.deepEqual(unsupported.calls, []);
  const received = supported.provisionContexts[0];
  assert.deepEqual(received.resources, { diskSizeGb: 8 });
  assert.equal(Object.isFrozen(received.resources), true);
  assert.equal(received.workspace.callerBranch, null);
  assert.equal(received.workspace.resolvedBranch, 'master');
  assert.equal(Object.isFrozen(received.workspace), true);
  assert.equal(received.cancellationSignal, controller.signal);
});

await test('selected-run and operation selectors expose helper ports', () => {
  const selected = mod.buildSelectedSandboxRun({
    taskId: 'task-selected',
    selection: {
      id: 'provider-selected',
      provider: provider('provider-selected', ['terminal.websocket']),
      location: 'local',
      priority: 0,
      capabilities: ['terminal.websocket'],
      compatibility: 'declared',
    },
    connection: {
      taskId: 'provider-task',
      baseUrl: 'http://provider',
      wsUrl: 'ws://provider',
    },
    providerSandboxId: 'provider-task',
    terminal: { protocol: 'aio-json-v1', wsUrl: 'ws://provider' },
    command: { protocol: 'aio-http-exec-v1', baseUrl: 'http://provider' },
    workspace: { mode: 'git', path: '/workspace' },
    retention: { mode: 'stop-retain', retainTranscript: true },
    preflight: { status: 'skipped', checkedAt: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(selected.providerId, 'provider-selected');
  assert.equal(selected.providerSandboxId, 'provider-task');
  assert.equal(selected.retention.mode, 'stop-retain');

  assert.equal(
    mod.selectDeliverySandboxProvider(provider('deliver', ['workspace.git.deliver']))
      .compatibility,
    'declared',
  );
  assert.equal(
    mod.selectReadoptionSandboxProvider(provider('readopt', ['lifecycle.readopt']))
      .compatibility,
    'declared',
  );
  assert.equal(
    mod.selectReadoptionSandboxProvider(
      provider('readoption-docs', ['lifecycle.readoption']),
    ).compatibility,
    'declared',
  );
  assert.equal(
    mod.selectRetainedTranscriptSandboxProvider(
      provider('transcript', ['transcript.retained-read']),
    ).compatibility,
    'declared',
  );
  assert.throws(
    () => mod.selectSandboxProvider(null, ['terminal.websocket']),
    /No sandbox provider is configured/,
  );
  assert.throws(
    () =>
      mod.selectConfiguredSandboxProvider(
        provider('legacy', undefined),
        ['terminal.websocket'],
      ),
    /does not declare capabilities/,
  );
});

await test('settle plans preserve terminal and force-fail lifecycle ordering flags', () => {
  assert.deepEqual(mod.terminalSettlePlan(), {
    sessionReason: 'completed',
    captureTranscript: true,
    deliverWorkspace: true,
    teardownSandbox: true,
    teardownSession: true,
    releaseSlot: true,
  });
  assert.deepEqual(mod.forceFailSettlePlan({ terminal: 'failed' }), {
    sessionReason: 'failed',
    captureTranscript: true,
    deliverWorkspace: false,
    teardownSandbox: true,
    teardownSession: true,
    releaseSlot: true,
  });
});

await test('git workspace helpers keep auth out of clone URL and scrub failures', () => {
  const command = mod.buildGitCloneCommand(
    {
      url: 'https://github.com/acme/private.git',
    },
    '/workspace',
  );
  assert.equal(
    command,
    "git clone -- 'https://github.com/acme/private.git' '/workspace'",
  );
  assert.throws(
    () =>
      mod.buildGitCloneCommand(
        {
          url: 'https://github.com/acme/private.git',
          authHeader: 'Authorization: Basic secret-token',
        },
        '/workspace',
      ),
    /raw-header Git clone is disabled/u,
  );
  assert.equal(
    mod.scrubSandboxExecSecrets(
      'fatal https://user:token@example.test/repo.git Authorization: Basic abc123',
    ),
    'fatal https://***:***@example.test/repo.git Authorization: Basic ***',
  );
});

await test('legacy raw-header delivery command builder is disabled', () => {
  assert.throws(
    () => mod.buildGitDeliveryCommands(),
    /raw-header Git delivery is disabled/u,
  );
});

await test('exec result parser handles nested AIO-style responses and NaN fail-closed codes', () => {
  assert.deepEqual(mod.parseSandboxExecResult({ data: { exit_code: '0', stdout: 'ok' } }), {
    exitCode: 0,
    output: 'ok',
  });
  const missing = mod.parseSandboxExecResult({ data: { stdout: 'unknown' } });
  assert(Number.isNaN(missing.exitCode));
  assert.equal(missing.output, 'unknown');
});

await test('provider router selects by capabilities and pins the owner for later operations', async () => {
  const local = routableProvider('local', mod.SANDBOX_PROVIDER_CAPABILITIES);
  const cloud = routableProvider('cloud', mod.SANDBOX_PROVIDER_CAPABILITIES, {
    mode: 'danger-full-access',
  });
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({ id: 'local', provider: local, priority: 1 }),
    mod.defineCloudSandboxProvider({ id: 'cloud', provider: cloud, priority: 10 }),
  ]);

  assert.equal(router.getSandboxMode(), 'danger-full-access');
  const connection = await router.provision(
    provisionContext('task-routed', { url: 'https://example.test/repo.git' }),
  );
  assert.equal(connection.baseUrl, 'http://cloud/task-routed');
  assert.deepEqual(local.calls, []);

  const delivery = await router.deliverWorkspaceChanges('task-routed', {
    authHeader: 'Authorization: Basic x',
    branch: 'cap/task-routed',
    commitMessage: 'done',
  });
  assert.equal(delivery.commitSha, 'cloud');
  assert.deepEqual(cloud.calls.map((call) => call[0]), [
    'provision',
    'reattach',
    'deliver',
  ]);
  assert(router.getProviderCapabilities().includes('workspace.git.materialize'));
});

await test('provider router covers read, exists, readopt listing, and no-owner teardown paths', async () => {
  const transcript = { format: 'jsonl', jsonl: '{"ok":true}\n' };
  const noTranscript = routableProvider('no-transcript', ['terminal.websocket'], {
    exists: false,
    readoptable: ['dup', 'only-no-transcript'],
  });
  const withTranscript = routableProvider('with-transcript', [
    'terminal.websocket',
    'transcript.retained-read',
    'lifecycle.readopt',
  ], {
    exists: true,
    rollout: transcript,
    readoptable: ['dup', 'only-transcript'],
  });
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'no-transcript',
      provider: noTranscript,
      capabilities: ['terminal.websocket'],
    }),
    mod.defineCloudSandboxProvider({
      id: 'with-transcript',
      provider: withTranscript,
      capabilities: [
        'terminal.websocket',
        'transcript.retained-read',
        'lifecycle.readopt',
      ],
    }),
  ]);

  assert.equal(await router.readRolloutFromContainer('task-read', 'codex'), transcript);
  assert.equal(await router.sandboxExists('task-exists'), true);
  assert.deepEqual((await router.listReadoptable()).sort(), ['dup', 'only-transcript']);
  await router.teardownSandbox('task-teardown-all');
  assert(noTranscript.calls.some((call) => call[0] === 'teardown'));
  assert(withTranscript.calls.some((call) => call[0] === 'teardown'));

  const readOnlyRouter = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'readonly-mode',
      provider: routableProvider('readonly-mode', ['terminal.websocket'], {
        mode: 'read-only',
      }),
      capabilities: ['terminal.websocket'],
    }),
  ]);
  assert.equal(readOnlyRouter.getSandboxMode(), 'read-only');
  assert.equal(await readOnlyRouter.sandboxExists('task-missing'), false);
  assert.equal(await readOnlyRouter.readRolloutFromContainer('task-missing'), null);

  const workspaceWriteRouter = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'workspace-write-mode',
      provider: routableProvider('workspace-write-mode', ['terminal.websocket']),
      capabilities: ['terminal.websocket'],
    }),
  ]);
  assert.equal(workspaceWriteRouter.getSandboxMode(), 'workspace-write');

  const readoptNoList = {
    calls: [],
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['lifecycle.readopt'],
    async teardownSandbox() {},
    async readRolloutFromContainer() {
      return null;
    },
    async sandboxExists() {
      return false;
    },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const readoptNoListRouter = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'readopt-no-list',
      provider: readoptNoList,
      capabilities: ['lifecycle.readopt'],
    }),
  ]);
  assert.deepEqual(await readoptNoListRouter.listReadoptable(), []);
});

await test('provider router explicitly reconciles every readoption provider and aggregates inventory without pre-clearing it', async () => {
  const local = routableProvider('local-reconcile', ['lifecycle.readopt'], {
    readoptable: ['task-protected'],
    reconcileResult: {
      inspected: 2,
      reaped: 1,
    },
  });
  const cloud = routableProvider('cloud-reconcile', ['lifecycle.readopt'], {
    readoptable: ['task-cloud'],
    reconcileResult: {
      inspected: 2,
      reaped: 2,
    },
  });
  const unsupported = routableProvider('unsupported-reconcile', [
    'terminal.websocket',
  ], {
    reconcileResult: {
      inspected: 1,
      reaped: 1,
    },
  });
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'local-reconcile',
      provider: local,
      capabilities: ['lifecycle.readopt'],
    }),
    mod.defineCloudSandboxProvider({
      id: 'cloud-reconcile',
      provider: cloud,
      capabilities: ['lifecycle.readopt'],
    }),
    mod.defineLocalSandboxProvider({
      id: 'unsupported-reconcile',
      provider: unsupported,
      capabilities: ['terminal.websocket'],
    }),
  ]);

  assert.deepEqual(
    await router.reconcileSandboxInventory({
      protectedTaskIds: ['task-protected', 'task-protected'],
      canReap: () => true,
    }),
    {
      inspected: 4,
      reaped: 3,
    },
  );
  assert.deepEqual(
    local.calls.find(([kind]) => kind === 'reconcileSandboxInventory'),
    ['reconcileSandboxInventory', ['task-protected']],
  );
  assert.deepEqual(
    cloud.calls.find(([kind]) => kind === 'reconcileSandboxInventory'),
    ['reconcileSandboxInventory', ['task-protected']],
  );
  assert.equal(
    unsupported.calls.some(([kind]) => kind === 'reconcileSandboxInventory'),
    false,
  );
  assert.deepEqual(await router.listReadoptable(), [
    'task-protected',
    'task-cloud',
  ]);
});

await test('provider router fences reconciliation candidates against active cross-replica owners', async () => {
  const activeCandidate = {
    taskId: 'task-owner-acquired-after-snapshot',
    providerSandboxId: 'sandbox-active',
  };
  const orphanCandidate = {
    taskId: 'task-still-orphaned',
    providerSandboxId: 'sandbox-orphaned',
  };
  const provider = routableProvider('reconcile-owner-fence', [
    'lifecycle.readopt',
  ], {
    reconcileCandidates: [activeCandidate, orphanCandidate],
    reconcileResult: { inspected: 2, reaped: 1 },
  });
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  await ownerStore.recordSandboxRunOwner({
    taskId: activeCandidate.taskId,
    providerId: 'another-replica-provider',
    providerSandboxId: activeCandidate.providerSandboxId,
    connection: {
      taskId: activeCandidate.taskId,
      baseUrl: 'http://active-owner',
      wsUrl: 'ws://active-owner',
    },
  });
  const router = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'reconcile-owner-fence',
        provider,
        capabilities: ['lifecycle.readopt'],
      }),
    ],
    { ownerStore },
  );
  const upstreamAuthorizations = [];

  assert.deepEqual(
    await router.reconcileSandboxInventory({
      // The owner was acquired after this (empty) startup snapshot.
      protectedTaskIds: [],
      canReap: (candidate) => {
        upstreamAuthorizations.push(candidate);
        return true;
      },
    }),
    { inspected: 2, reaped: 1 },
  );
  assert.deepEqual(
    provider.calls.filter(([kind]) => kind === 'reconcileAuthorization'),
    [
      ['reconcileAuthorization', activeCandidate, false],
      ['reconcileAuthorization', orphanCandidate, true],
    ],
  );
  assert.deepEqual(upstreamAuthorizations, [orphanCandidate]);
});

await test('provider router returns capability errors for owned providers missing delivery support', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-readonly-owner',
    providerId: 'readonly',
    providerSandboxId: 'readonly-task',
    connection: {
      taskId: 'readonly-task',
      baseUrl: 'http://readonly',
      wsUrl: 'ws://readonly',
    },
  });
  const readonly = routableProvider('readonly', ['terminal.websocket']);
  const router = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'readonly',
        provider: readonly,
        capabilities: ['terminal.websocket'],
      }),
    ],
    { ownerStore },
  );
  assert.deepEqual(
    await router.deliverWorkspaceChanges('task-readonly-owner', {
      authHeader: 'Authorization: Basic x',
      branch: 'cap/task-readonly-owner',
      commitMessage: 'done',
    }),
    {
      hadChanges: false,
      commitSha: null,
      error:
        'sandbox provider for task task-readonly-owner does not support workspace delivery',
    },
  );

  assert.equal(await router.readRolloutFromContainer('task-readonly-owner'), null);
  assert.equal(await router.reattach('task-readonly-owner'), null);
});

await test('provider router uses owned provider for transcript and existence checks', async () => {
  const transcript = { format: 'jsonl', jsonl: '{"owned":true}\n' };
  const owner = routableProvider('owned', [
    'terminal.websocket',
    'transcript.retained-read',
    'workspace.git.deliver',
  ], {
    rollout: transcript,
    exists: true,
  });
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'owned',
      provider: owner,
      capabilities: [
        'terminal.websocket',
        'transcript.retained-read',
        'workspace.git.deliver',
      ],
    }),
  ]);
  await router.provision(provisionContext('task-owned-read'));
  assert.equal(await router.readRolloutFromContainer('task-owned-read'), transcript);
  assert.equal(await router.sandboxExists('task-owned-read'), true);
});

await test('provider router aggregates selected-run descriptors when provider run is partial', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const partial = routableProvider('partial', [
    'terminal.websocket',
    'workspace.git.deliver',
  ], {
    selectedRun: () => ({
      connection: {
        taskId: 'partial-task',
        baseUrl: 'http://partial',
        wsUrl: 'ws://partial',
      },
    }),
  });
  partial.getTerminalDescriptor = async () => ({
    protocol: 'aio-json-v1',
    wsUrl: 'ws://partial/terminal',
  });
  partial.getCommandDescriptor = async () => ({
    protocol: 'aio-http-exec-v1',
    baseUrl: 'http://partial/command',
  });
  partial.getWorkspaceDescriptor = async () => ({
    mode: 'git',
    path: '/workspace',
  });
  partial.getRetentionPolicy = async () => ({
    mode: 'stop-retain',
    retainTranscript: true,
  });
  const router = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'partial',
        provider: partial,
        capabilities: ['terminal.websocket', 'workspace.git.deliver'],
      }),
    ],
    { ownerStore },
  );
  await router.provision(provisionContext('task-partial'));
  const run = await router.getSelectedSandboxRun('task-partial');
  assert.equal(run.providerSandboxId, undefined);
  assert.equal(run.terminal.wsUrl, 'ws://partial/terminal');
  assert.equal(run.command.baseUrl, 'http://partial/command');
  assert.equal(run.workspace.path, '/workspace');
  assert.equal(run.retention.mode, 'stop-retain');
});

await test('provider router records and returns resolved environment metadata', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const environment = {
    environmentId: 'env-aio',
    name: 'AIO custom',
    sourceKind: 'aio-docker-image',
    sourceRef: 'cap-aio-custom:1.0.0',
    providerFamily: 'aio',
    contractVersion: 'sandbox-environment-v1',
  };
  const sandboxMetadata = {
    schemaVersion: 1,
    sandboxVersion: 'v1.2.3',
    dependencies: { codex: '0.132.0', 'custom-cli': '4.5.6' },
  };
  const provider = routableProvider('environment-aware', ['terminal.websocket'], {
    selectedRun: (taskId) => ({
      taskId,
      providerId: 'environment-aware',
      providerSandboxId: `sandbox-${taskId}`,
      connection: {
        taskId,
        baseUrl: `http://environment-aware/${taskId}`,
        wsUrl: `ws://environment-aware/${taskId}`,
      },
      environment,
      preflight: {
        status: 'passed',
        checkedAt: '2026-07-10T00:00:00.000Z',
        runtimeId: 'codex',
        probes: [],
        metadata: { sandboxMetadata },
      },
    }),
  });
  const router = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'environment-aware',
        provider,
        capabilities: ['terminal.websocket'],
      }),
    ],
    { ownerStore },
  );

  await router.provision(provisionContext('task-env-owner'));
  const owner = await ownerStore.getSandboxRunOwner('task-env-owner');
  const run = await router.getSelectedSandboxRun('task-env-owner');

  assert.deepEqual(owner.environment, environment);
  assert.deepEqual(owner.metadata, { sandboxMetadata });
  assert.deepEqual(run.environment, environment);
  assert.deepEqual(run.owner.environment, environment);
});

await test('provider router selected-run returns null for unresolved ownership records', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-missing-provider',
    providerId: 'missing-provider',
    providerSandboxId: 'missing-task',
    connection: {
      taskId: 'missing-task',
      baseUrl: 'http://missing',
      wsUrl: 'ws://missing',
    },
  });
  const router = new mod.SandboxProviderRouter([], { ownerStore });
  assert.equal(await router.getSelectedSandboxRun('task-missing-provider'), null);
  assert.equal(await router.reattach('task-missing-provider'), null);
});

await test('provider router reattaches without owner store and uses reattached connection fallback', async () => {
  const readopt = routableProvider('readopt-connection', [
    'terminal.websocket',
    'lifecycle.readopt',
  ], {
    reattachTask: 'task-reattach-connection',
    selectedRun: () => ({}),
  });
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'readopt-connection',
      provider: readopt,
      capabilities: ['terminal.websocket', 'lifecycle.readopt'],
    }),
  ]);
  const connection = await router.reattach('task-reattach-connection');
  assert.equal(connection.taskId, 'task-reattach-connection');

  assert.equal(await router.getSelectedSandboxRun('task-reattach-connection'), null);

  const selectedReadopt = routableProvider('selected-readopt', [
    'terminal.websocket',
    'lifecycle.readopt',
  ], {
    reattachTask: 'task-selected-readopt',
    selectedRun: () => ({}),
  });
  const selectedRouter = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'selected-readopt',
      provider: selectedReadopt,
      capabilities: ['terminal.websocket', 'lifecycle.readopt'],
    }),
  ]);
  const selected = await selectedRouter.getSelectedSandboxRun('task-selected-readopt');
  assert.equal(selected.connection.taskId, 'task-selected-readopt');
  assert.equal(selected.providerSandboxId, undefined);
});

await test('provider router never labels a logical connection task id as a physical sandbox id', async () => {
  const partial = routableProvider('connection-fallback', ['terminal.websocket'], {
    selectedRun: () => ({
      connection: {
        taskId: 'provider-connection-task',
        baseUrl: 'http://connection-fallback',
        wsUrl: 'ws://connection-fallback',
      },
    }),
  });
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'connection-fallback',
      provider: partial,
      capabilities: ['terminal.websocket'],
    }),
  ]);
  await router.provision(provisionContext('task-connection-fallback'));
  const run = await router.getSelectedSandboxRun('task-connection-fallback');
  assert.equal(run.providerSandboxId, undefined);
});

await test('provider router persists and prefers stored ownership after restart', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const local = routableProvider('local', mod.SANDBOX_PROVIDER_CAPABILITIES, {
    reattachTask: 'task-owned',
  });
  const cloud = routableProvider('cloud', mod.SANDBOX_PROVIDER_CAPABILITIES, {
    reattachTask: 'task-owned',
    selectedRun: (taskId) => ({
      providerSandboxId: `cloud-sandbox-${taskId}`,
    }),
  });
  const firstRouter = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({ id: 'local', provider: local, priority: 1 }),
      mod.defineCloudSandboxProvider({ id: 'cloud', provider: cloud, priority: 50 }),
    ],
    { ownerStore },
  );

  await firstRouter.provision(provisionContext('task-owned'));
  assert.equal((await ownerStore.getSandboxRunOwner('task-owned'))?.providerId, 'cloud');
  assert.equal(
    (await ownerStore.getSandboxRunOwner('task-owned'))?.providerSandboxId,
    'cloud-sandbox-task-owned',
  );
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-owned',
    providerId: 'cloud',
    providerSandboxId: 'cloud-task-owned',
    connection: {
      taskId: 'cloud-task-owned',
      baseUrl: 'http://cloud/task-owned',
      wsUrl: 'ws://cloud/task-owned',
    },
  });
  await ownerStore.markSandboxRunOwnerStatus('task-never-owned', 'removed');

  const restartedRouter = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({ id: 'local', provider: local, priority: 1 }),
      mod.defineCloudSandboxProvider({ id: 'cloud', provider: cloud, priority: 50 }),
    ],
    { ownerStore },
  );

  const delivery = await restartedRouter.deliverWorkspaceChanges('task-owned', {
    authHeader: 'Authorization: Basic x',
    branch: 'cap/task-owned',
    commitMessage: 'done',
  });
  assert.equal(delivery.commitSha, 'cloud');
  assert(!local.calls.some((call) => call[0] === 'deliver'));

  const run = await restartedRouter.getSelectedSandboxRun('task-owned');
  assert.equal(run.providerId, 'cloud');
  assert.equal(run.owner.providerId, 'cloud');
  assert.equal(run.connection.baseUrl, 'http://cloud/task-owned');
});

await test('durable provider transfer overrides a stale local owner cache and readopts only the new exact target', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const local = routableProvider('local-cache-a', mod.SANDBOX_PROVIDER_CAPABILITIES);
  const cloud = routableProvider('durable-owner-b', mod.SANDBOX_PROVIDER_CAPABILITIES);
  const localReadoptions = [];
  const cloudReadoptions = [];
  local.reattach = async (taskId, target) => {
    localReadoptions.push([taskId, target]);
    return null;
  };
  cloud.reattach = async (taskId, target) => {
    cloudReadoptions.push([taskId, target]);
    return {
      taskId,
      baseUrl: 'http://durable-owner-b/task-provider-transfer',
      wsUrl: 'ws://durable-owner-b/task-provider-transfer',
    };
  };
  const router = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({ id: 'local-cache-a', provider: local, priority: 50 }),
      mod.defineCloudSandboxProvider({ id: 'durable-owner-b', provider: cloud, priority: 1 }),
    ],
    { ownerStore },
  );
  const firstOwnership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await router.provision({
    ...provisionContext('task-provider-transfer'),
    ownership: firstOwnership,
  });
  assert.equal(
    (await ownerStore.getSandboxRunOwner('task-provider-transfer'))?.providerId,
    'local-cache-a',
  );

  const firstCleanup = await ownerStore.claimSandboxRunCleanup(
    'task-provider-transfer',
    'owner:g2',
  );
  assert.equal(firstCleanup.kind, 'authorized');
  assert.equal(
    await ownerStore.completeSandboxRunCleanup(
      firstCleanup.authorization,
      'removed',
    ),
    true,
  );
  const replacement = await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-provider-transfer',
    providerId: 'durable-owner-b',
    ownerGeneration: 'owner:g3',
    proposedResourceGeneration: 'resource:r2',
  });
  assert.equal(replacement.kind, 'acquired');
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-provider-transfer',
    providerId: 'durable-owner-b',
    providerSandboxId: 'physical-b-r2',
    ownership: replacement.ownership,
    status: 'running',
    connection: {
      taskId: 'task-provider-transfer',
      baseUrl: 'http://durable-owner-b/task-provider-transfer',
      wsUrl: 'ws://durable-owner-b/task-provider-transfer',
    },
  });

  const delivery = await router.deliverWorkspaceChanges('task-provider-transfer', {
    authHeader: 'Authorization: Basic x',
    branch: 'cap/task-provider-transfer',
    commitMessage: 'done',
  });
  assert.equal(delivery.commitSha, 'durable-owner-b');
  assert.equal(local.calls.some((call) => call[0] === 'deliver'), false);
  assert.deepEqual(localReadoptions, []);
  assert.deepEqual(cloudReadoptions, [[
    'task-provider-transfer',
    {
      providerSandboxId: 'physical-b-r2',
      ownership: replacement.ownership,
    },
  ]]);
});

await test('a pre-create provider failure abandons an idle generation without stranding cleanup', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const teardownOptions = [];
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.provision = async () => {
    throw new Error('pre-create validation failed');
  };
  provider.teardownSandbox = async (_taskId, options) => {
    teardownOptions.push(options);
    return { kind: 'already-absent' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  await assert.rejects(
    router.provision({
      ...provisionContext('task-pre-create-failure'),
      ownership: {
        ownerGeneration: 'owner:g1',
        resourceGeneration: 'resource:r1',
      },
    }),
    /pre-create validation failed/,
  );
  assert.equal(teardownOptions.length, 1);
  assert.equal(teardownOptions[0].disposition, 'superseded-remove');
  assert.equal(
    await router.claimSandboxCleanupOwnership(
      'task-pre-create-failure',
      'owner:g2',
    ),
    null,
  );
});

await test('a definitive no-resource create response returns entered state to idle', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.provision = async (ctx) => {
    await ctx.externalBoundaryGuard({
      taskId: ctx.taskId,
      action: 'sandbox.create',
      position: 'before',
    });
    await ctx.onSandboxCreateObserved({ kind: 'not-created' });
    throw new Error('image was rejected before resource creation');
  };
  provider.teardownSandbox = async () => ({ kind: 'already-absent' });
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  await assert.rejects(
    router.provision({
      ...provisionContext('task-definite-create-rejection'),
      ownership: {
        ownerGeneration: 'owner:g1',
        resourceGeneration: 'resource:r1',
      },
    }),
    /image was rejected/,
  );
  assert.equal(
    await router.claimSandboxCleanupOwnership(
      'task-definite-create-rejection',
      'owner:g2',
    ),
    null,
  );
});

await test('observed create then confirmed delete can recover after missing cleanup completion', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const ownership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-observed-delete-crash',
    providerId: 'local',
    ownerGeneration: ownership.ownerGeneration,
    proposedResourceGeneration: ownership.resourceGeneration,
  });
  await ownerStore.beginSandboxRunCreate({
    taskId: 'task-observed-delete-crash',
    providerId: 'local',
    ownership,
  });
  await ownerStore.observeSandboxRunCreate({
    taskId: 'task-observed-delete-crash',
    providerId: 'local',
    resourceGeneration: ownership.resourceGeneration,
    providerSandboxId: 'sandbox-r1',
  });
  const cleanup = await ownerStore.claimSandboxRunCleanup(
    'task-observed-delete-crash',
    'owner:g2',
  );
  const seen = [];
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.teardownSandbox = async (_taskId, options) => {
    seen.push(options);
    return { kind: 'already-absent' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  await router.teardownSandbox('task-observed-delete-crash', {
    cleanupAuthorization: cleanup.authorization,
    disposition: 'superseded-remove',
  });
  assert.equal(seen[0].providerSandboxId, 'sandbox-r1');
  assert.equal(
    await ownerStore.getSandboxRunOwner('task-observed-delete-crash'),
    null,
  );
});

await test('selected-run failure preserves the exact create observation and never infers a logical id', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.provision = async (ctx) => {
    await ctx.externalBoundaryGuard({
      taskId: ctx.taskId,
      action: 'sandbox.create',
      position: 'before',
    });
    await ctx.onSandboxCreateObserved({
      kind: 'created',
      providerSandboxId: 'physical-r1',
    });
    return {
      taskId: ctx.taskId,
      baseUrl: `http://local/${ctx.taskId}`,
      wsUrl: `ws://local/${ctx.taskId}`,
    };
  };
  provider.getSelectedSandboxRun = async () => {
    throw new Error('selected run unavailable');
  };
  provider.teardownSandbox = async () => ({ kind: 'already-absent' });
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  await router.provision({
    ...provisionContext('task-selected-run-failed'),
    ownership: {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    },
  });
  const owner = await ownerStore.getSandboxRunOwner('task-selected-run-failed');
  assert.equal(owner.providerSandboxId, 'physical-r1');
  assert.notEqual(owner.providerSandboxId, owner.connection.taskId);
  await router.teardownSandbox('task-selected-run-failed', {
    disposition: 'superseded-remove',
  });
  assert.equal(
    await ownerStore.getSandboxRunOwner('task-selected-run-failed'),
    null,
  );
});

await test('selected-run absence preserves the exact create observation and never infers a logical id', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.provision = async (ctx) => {
    await ctx.externalBoundaryGuard({
      taskId: ctx.taskId,
      action: 'sandbox.create',
      position: 'before',
    });
    await ctx.onSandboxCreateObserved({
      kind: 'created',
      providerSandboxId: 'physical-null-r1',
    });
    return {
      taskId: ctx.taskId,
      baseUrl: `http://local/${ctx.taskId}`,
      wsUrl: `ws://local/${ctx.taskId}`,
    };
  };
  provider.getSelectedSandboxRun = async () => null;
  provider.teardownSandbox = async () => ({ kind: 'already-absent' });
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  await router.provision({
    ...provisionContext('task-selected-run-null'),
    ownership: {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    },
  });
  const owner = await ownerStore.getSandboxRunOwner('task-selected-run-null');
  assert.equal(owner.providerSandboxId, 'physical-null-r1');
  assert.notEqual(owner.providerSandboxId, owner.connection.taskId);
  await router.teardownSandbox('task-selected-run-null', {
    disposition: 'superseded-remove',
  });
  assert.equal(
    await ownerStore.getSandboxRunOwner('task-selected-run-null'),
    null,
  );
});

await test('a newer owner generation transfers the same resource before stale cleanup and fences the old worker', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const oldEntered = deferred();
  const releaseOld = deferred();
  const cleanupCalls = [];
  const provider = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(ctx) {
      if (ctx.ownership.ownerGeneration === 'owner:g1') {
        oldEntered.resolve();
        await releaseOld.promise;
        const cleanupAuthorization = await ctx.beforeSandboxCleanup();
        if (cleanupAuthorization) {
          cleanupCalls.push(ctx.ownership);
          await ctx.afterSandboxCleanup(cleanupAuthorization);
        }
        throw new Error('old worker aborted');
      }
      return {
        taskId: ctx.taskId,
        baseUrl: `http://sandbox/${ctx.taskId}`,
        wsUrl: `ws://sandbox/${ctx.taskId}`,
      };
    },
    async teardownSandbox() {
      throw new Error('stale cleanup must not reach the provider');
    },
    async readRolloutFromContainer() { return null; },
    async sandboxExists() { return true; },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  const first = router.provision({
    ...provisionContext('task-generation-transfer'),
    ownership: {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    },
  });
  await oldEntered.promise;

  await router.provision({
    ...provisionContext('task-generation-transfer'),
    ownership: {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:r2-proposal',
    },
  });
  releaseOld.resolve();
  await assert.rejects(first, /old worker aborted/);

  const owner = await ownerStore.getSandboxRunOwner('task-generation-transfer');
  assert.deepEqual(owner.ownership, {
    ownerGeneration: 'owner:g2',
    resourceGeneration: 'resource:r1',
  });
  assert.equal(owner.status, 'running');
  assert.deepEqual(cleanupCalls, []);
});

await test('provider return after ownership transfer cannot record or tear down the newer owner', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const firstProviderEntered = deferred();
  const releaseFirstProvider = deferred();
  const teardownCalls = [];
  const provider = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(ctx) {
      if (ctx.ownership.ownerGeneration === 'owner:g1') {
        firstProviderEntered.resolve();
        await releaseFirstProvider.promise;
      }
      return {
        taskId: ctx.taskId,
        baseUrl: `http://sandbox/${ctx.taskId}`,
        wsUrl: `ws://sandbox/${ctx.taskId}`,
      };
    },
    async teardownSandbox(_taskId, options) {
      teardownCalls.push(options.ownership);
    },
    async readRolloutFromContainer() { return null; },
    async sandboxExists() { return true; },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  const first = router.provision({
    ...provisionContext('task-return-after-transfer'),
    ownership: {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    },
  });
  await firstProviderEntered.promise;

  await router.provision({
    ...provisionContext('task-return-after-transfer'),
    ownership: {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:r2-proposal',
    },
  });
  releaseFirstProvider.resolve();
  await assert.rejects(first, /owner generation is no longer current/);

  const owner = await ownerStore.getSandboxRunOwner('task-return-after-transfer');
  assert.deepEqual(owner.ownership, {
    ownerGeneration: 'owner:g2',
    resourceGeneration: 'resource:r1',
  });
  assert.equal(owner.status, 'running');
  assert.deepEqual(teardownCalls, []);
});

await test('durable runtime-default replay pins the persisted provider and resource generation after priorities change', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const persisted = routableProvider('persisted-provider', [
    'terminal.websocket',
  ]);
  const newlyPreferred = routableProvider('newly-preferred-provider', [
    'terminal.websocket',
  ]);
  const taskId = 'task-runtime-default-provider-replay';
  const initialRouter = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'persisted-provider',
        provider: persisted,
        priority: 100,
      }),
      mod.defineCloudSandboxProvider({
        id: 'newly-preferred-provider',
        provider: newlyPreferred,
        priority: 1,
      }),
    ],
    { ownerStore },
  );

  await initialRouter.provision({
    ...provisionContext(taskId),
    ownership: {
      ownerGeneration: 'owner:initial',
      resourceGeneration: 'resource:persisted',
    },
  });
  persisted.calls.length = 0;
  persisted.provisionContexts.length = 0;
  newlyPreferred.calls.length = 0;
  newlyPreferred.provisionContexts.length = 0;

  const replayRouter = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'persisted-provider',
        provider: persisted,
        priority: 1,
      }),
      mod.defineCloudSandboxProvider({
        id: 'newly-preferred-provider',
        provider: newlyPreferred,
        priority: 100,
      }),
    ],
    { ownerStore },
  );
  await replayRouter.provision({
    ...provisionContext(taskId),
    ownership: {
      ownerGeneration: 'owner:replay',
      resourceGeneration: 'resource:new-proposal',
    },
  });

  assert.equal(persisted.provisionContexts.length, 1);
  assert.deepEqual(persisted.provisionContexts[0].ownership, {
    ownerGeneration: 'owner:replay',
    resourceGeneration: 'resource:persisted',
  });
  assert.equal(
    newlyPreferred.calls.some(([kind]) => kind === 'provision'),
    false,
  );
  assert.deepEqual(
    (await ownerStore.getSandboxRunOwner(taskId)).ownership,
    {
      ownerGeneration: 'owner:replay',
      resourceGeneration: 'resource:persisted',
    },
  );
});

await test('durable explicit-model replay fails closed when its immutable provider conflicts with the persisted owner', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const persisted = routableProvider('explicit-persisted-provider', [
    'terminal.websocket',
  ]);
  const explicit = routableProvider('explicit-conflicting-provider', [
    'terminal.websocket',
  ]);
  const taskId = 'task-explicit-provider-conflict';
  const initialRouter = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'explicit-persisted-provider',
        provider: persisted,
        priority: 100,
      }),
      mod.defineCloudSandboxProvider({
        id: 'explicit-conflicting-provider',
        provider: explicit,
        priority: 1,
      }),
    ],
    { ownerStore },
  );
  await initialRouter.provision({
    ...provisionContext(taskId),
    ownership: {
      ownerGeneration: 'owner:initial',
      resourceGeneration: 'resource:initial',
    },
  });
  persisted.calls.length = 0;
  explicit.calls.length = 0;

  const replayRouter = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'explicit-persisted-provider',
        provider: persisted,
      }),
      mod.defineCloudSandboxProvider({
        id: 'explicit-conflicting-provider',
        provider: explicit,
      }),
    ],
    { ownerStore },
  );
  await assert.rejects(
    replayRouter.provision({
      ...provisionContext(taskId),
      modelIntent: { kind: 'explicit', selector: 'stable-model-selector' },
      environment: { providerId: 'explicit-conflicting-provider' },
      ownership: {
        ownerGeneration: 'owner:replay',
        resourceGeneration: 'resource:new-proposal',
      },
    }),
    (error) =>
      error?.code === 'runtime_model_setup_failed' &&
      error?.phase === 'provider-selection',
  );
  assert.equal(
    [...persisted.calls, ...explicit.calls].some(
      ([kind]) => kind === 'provision',
    ),
    false,
  );
  assert.deepEqual(
    (await ownerStore.getSandboxRunOwner(taskId)).ownership,
    {
      ownerGeneration: 'owner:initial',
      resourceGeneration: 'resource:initial',
    },
  );
});

await test('durable replay fails closed when the persisted provider is no longer registered', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const persisted = routableProvider('removed-persisted-provider', [
    'terminal.websocket',
  ]);
  const fallback = routableProvider('available-fallback-provider', [
    'terminal.websocket',
  ]);
  const taskId = 'task-unregistered-provider-replay';
  const initialRouter = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'removed-persisted-provider',
        provider: persisted,
      }),
    ],
    { ownerStore },
  );
  await initialRouter.provision({
    ...provisionContext(taskId),
    ownership: {
      ownerGeneration: 'owner:initial',
      resourceGeneration: 'resource:initial',
    },
  });
  const replayRouter = new mod.SandboxProviderRouter(
    [
      mod.defineCloudSandboxProvider({
        id: 'available-fallback-provider',
        provider: fallback,
        priority: 100,
      }),
    ],
    { ownerStore },
  );

  await assert.rejects(
    replayRouter.provision({
      ...provisionContext(taskId),
      ownership: {
        ownerGeneration: 'owner:replay',
        resourceGeneration: 'resource:new-proposal',
      },
    }),
    (error) =>
      error?.code === 'runtime_model_setup_failed' &&
      error?.phase === 'provider-selection',
  );
  assert.equal(
    fallback.calls.some(([kind]) => kind === 'provision'),
    false,
  );
  assert.deepEqual(
    (await ownerStore.getSandboxRunOwner(taskId)).ownership,
    {
      ownerGeneration: 'owner:initial',
      resourceGeneration: 'resource:initial',
    },
  );
});

await test('a deleting generation is confirmed absent before a newer resource generation provisions', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const cleanupIntentPersisted = deferred();
  const teardownEntered = deferred();
  const releaseTeardown = deferred();
  let newerProvisioned = false;
  const provider = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(ctx) {
      if (ctx.ownership.ownerGeneration === 'owner:g1') {
        const cleanupAuthorization = await ctx.beforeSandboxCleanup();
        assert.equal(cleanupAuthorization.kind, 'generation');
        cleanupIntentPersisted.resolve();
        throw new Error('crash after cleanup intent');
      }
      newerProvisioned = true;
      return {
        taskId: ctx.taskId,
        baseUrl: `http://sandbox/${ctx.taskId}`,
        wsUrl: `ws://sandbox/${ctx.taskId}`,
      };
    },
    async teardownSandbox(_taskId, options) {
      assert.deepEqual(options.ownership, {
        ownerGeneration: 'owner:g2',
        resourceGeneration: 'resource:r1',
      });
      teardownEntered.resolve();
      await releaseTeardown.promise;
      return { kind: 'found-and-cleaned' };
    },
    async readRolloutFromContainer() { return null; },
    async sandboxExists() { return true; },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  await assert.rejects(
    router.provision({
      ...provisionContext('task-cleanup-first'),
      ownership: {
        ownerGeneration: 'owner:g1',
        resourceGeneration: 'resource:r1',
      },
    }),
    /crash after cleanup intent/,
  );
  await cleanupIntentPersisted.promise;

  const second = router.provision({
    ...provisionContext('task-cleanup-first'),
    ownership: {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:r2',
    },
  });
  await teardownEntered.promise;
  assert.equal(newerProvisioned, false);
  releaseTeardown.resolve();
  await second;

  const owner = await ownerStore.getSandboxRunOwner('task-cleanup-first');
  assert.equal(newerProvisioned, true);
  assert.deepEqual(owner.ownership, {
    ownerGeneration: 'owner:g2',
    resourceGeneration: 'resource:r2',
  });
  assert.equal(owner.status, 'running');
});

await test('terminal cleanup takeover wins before stale teardown reaches the provider', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const first = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-terminal-transfer-first',
    providerId: 'local',
    ownerGeneration: first.ownerGeneration,
    proposedResourceGeneration: first.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-terminal-transfer-first',
    providerId: 'local',
    providerSandboxId: 'sandbox-terminal-transfer-first',
    ownership: first,
    status: 'running',
  });
  const teardownCalls = [];
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.teardownSandbox = async (_taskId, options) => {
    teardownCalls.push(options.ownership);
    return { kind: 'found-and-cleaned' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  const claimedByFirst = await router.claimSandboxCleanupOwnership(
    'task-terminal-transfer-first',
    'owner:g1',
  );
  const claimedBySecond = await router.claimSandboxCleanupOwnership(
    'task-terminal-transfer-first',
    'owner:g2',
  );
  await router.teardownSandbox('task-terminal-transfer-first', {
    cleanupAuthorization: claimedByFirst,
  });
  assert.deepEqual(teardownCalls, []);

  await router.teardownSandbox('task-terminal-transfer-first', {
    cleanupAuthorization: claimedBySecond,
  });
  assert.deepEqual(teardownCalls, [{
    ownerGeneration: 'owner:g2',
    resourceGeneration: 'resource:r1',
  }]);
});

await test('ordinary terminal teardown claims a generated owner before provider cleanup', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const ownership = {
    ownerGeneration: 'owner:runtime',
    resourceGeneration: 'resource:runtime',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-ordinary-terminal',
    providerId: 'local',
    ownerGeneration: ownership.ownerGeneration,
    proposedResourceGeneration: ownership.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-ordinary-terminal',
    providerId: 'local',
    providerSandboxId: 'sandbox-ordinary-terminal',
    ownership,
    status: 'running',
  });
  const teardownCalls = [];
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.teardownSandbox = async (_taskId, options) => {
    teardownCalls.push(options.ownership);
    return { kind: 'found-and-cleaned' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  await router.teardownSandbox('task-ordinary-terminal');
  assert.equal(teardownCalls.length, 1);
  assert.equal(
    teardownCalls[0].resourceGeneration,
    ownership.resourceGeneration,
  );
  assert.match(teardownCalls[0].ownerGeneration, /^cleanup:/);
  assert.equal(await ownerStore.getSandboxRunOwner('task-ordinary-terminal'), null);
});

await test('generated cleanup rejects a void provider result even with historical observation proof', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const ownership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-generated-void-cleanup',
    providerId: 'local',
    ownerGeneration: ownership.ownerGeneration,
    proposedResourceGeneration: ownership.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-generated-void-cleanup',
    providerId: 'local',
    providerSandboxId: 'sandbox-r1',
    ownership,
    status: 'running',
    connection: {
      taskId: 'task-generated-void-cleanup',
      baseUrl: 'http://local/r1',
      wsUrl: 'ws://local/r1',
    },
  });
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.teardownSandbox = async () => undefined;
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  await assert.rejects(
    router.teardownSandbox('task-generated-void-cleanup'),
    /cleanup is pending/,
  );
  provider.teardownSandbox = async () => ({ kind: 'found-and-cleaned' });
  const retryAuthorization = await router.claimSandboxCleanupOwnership(
    'task-generated-void-cleanup',
    'owner:g2',
  );
  await router.teardownSandbox('task-generated-void-cleanup', {
    cleanupAuthorization: retryAuthorization,
  });
  assert.equal(
    await ownerStore.getSandboxRunOwner('task-generated-void-cleanup'),
    null,
  );
});

await test('exact cleanup completion remains valid when authority transfers during provider delete', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const first = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-terminal-delete-first',
    providerId: 'local',
    ownerGeneration: first.ownerGeneration,
    proposedResourceGeneration: first.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-terminal-delete-first',
    providerId: 'local',
    providerSandboxId: 'sandbox-terminal-delete-first',
    ownership: first,
    status: 'running',
  });
  const firstDeleteEntered = deferred();
  const releaseFirstDelete = deferred();
  const teardownCalls = [];
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.teardownSandbox = async (_taskId, options) => {
    teardownCalls.push(options.ownership);
    if (options.ownership.ownerGeneration === 'owner:g1') {
      firstDeleteEntered.resolve();
      await releaseFirstDelete.promise;
    }
    return { kind: 'found-and-cleaned' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  const claimedByFirst = await router.claimSandboxCleanupOwnership(
    'task-terminal-delete-first',
    'owner:g1',
  );
  const firstCleanup = router.teardownSandbox('task-terminal-delete-first', {
    cleanupAuthorization: claimedByFirst,
  });
  await firstDeleteEntered.promise;

  const claimedBySecond = await router.claimSandboxCleanupOwnership(
    'task-terminal-delete-first',
    'owner:g2',
  );
  releaseFirstDelete.resolve();
  await firstCleanup;
  await router.teardownSandbox('task-terminal-delete-first', {
    cleanupAuthorization: claimedBySecond,
  });

  assert.deepEqual(teardownCalls, [first]);
  assert.equal(await ownerStore.getSandboxRunOwner('task-terminal-delete-first'), null);
});

await test('found cleanup remains pending until an entered create settles and its final target is removed', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const ownership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-found-before-late-create',
    providerId: 'local',
    ownerGeneration: ownership.ownerGeneration,
    proposedResourceGeneration: ownership.resourceGeneration,
  });
  await ownerStore.beginSandboxRunCreate({
    taskId: 'task-found-before-late-create',
    providerId: 'local',
    ownership,
  });
  let physicalExists = true;
  let teardownCount = 0;
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.teardownSandbox = async () => {
    teardownCount += 1;
    if (!physicalExists) return { kind: 'already-absent' };
    physicalExists = false;
    return { kind: 'found-and-cleaned' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  const firstCleanup = await router.claimSandboxCleanupOwnership(
    'task-found-before-late-create',
    'owner:g2',
  );
  await assert.rejects(
    router.teardownSandbox('task-found-before-late-create', {
      cleanupAuthorization: firstCleanup,
      disposition: 'superseded-remove',
    }),
    /cleanup is pending/,
  );

  physicalExists = true;
  await ownerStore.observeSandboxRunCreate({
    taskId: 'task-found-before-late-create',
    providerId: 'local',
    resourceGeneration: ownership.resourceGeneration,
    providerSandboxId: 'late-r1',
  });
  const retry = await router.claimSandboxCleanupOwnership(
    'task-found-before-late-create',
    'owner:g3',
  );
  await router.teardownSandbox('task-found-before-late-create', {
    cleanupAuthorization: retry,
    disposition: 'superseded-remove',
  });
  assert.equal(teardownCount, 2);
  assert.equal(physicalExists, false);
  assert.equal(
    await ownerStore.getSandboxRunOwner('task-found-before-late-create'),
    null,
  );
});

await test('an absent cleanup cannot close an in-flight create and the late creator joins the current cleanup token', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const createEntered = deferred();
  const releaseCreate = deferred();
  const lateDeleteConfirmed = deferred();
  const releaseLateCompletion = deferred();
  const liveSandboxes = new Set();
  const cleanupTokens = [];
  const provider = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(ctx) {
      await ctx.externalBoundaryGuard?.({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      createEntered.resolve();
      await releaseCreate.promise;
      liveSandboxes.add(ctx.ownership.resourceGeneration);
      await ctx.onSandboxCreateObserved?.({
        kind: 'created',
        providerSandboxId: `sandbox-${ctx.ownership.resourceGeneration}`,
      });
      const cleanupAuthorization = await ctx.beforeSandboxCleanup();
      assert(cleanupAuthorization, 'late creator must join the deleting tombstone');
      cleanupTokens.push(cleanupAuthorization);
      assert.equal(cleanupAuthorization.kind, 'generation');
      assert.equal(
        cleanupAuthorization.ownership.resourceGeneration,
        ctx.ownership.resourceGeneration,
      );
      liveSandboxes.delete(cleanupAuthorization.ownership.resourceGeneration);
      lateDeleteConfirmed.resolve();
      await releaseLateCompletion.promise;
      await ctx.afterSandboxCleanup(cleanupAuthorization);
      throw new Error('late create was fenced after the external action');
    },
    async teardownSandbox(_taskId, options) {
      const generation = options.ownership?.resourceGeneration;
      if (!generation || !liveSandboxes.has(generation)) {
        return { kind: 'already-absent' };
      }
      liveSandboxes.delete(generation);
      return { kind: 'found-and-cleaned' };
    },
    async readRolloutFromContainer() { return null; },
    async sandboxExists() { return liveSandboxes.size > 0; },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  const first = router.provision({
    ...provisionContext('task-inflight-create-cleanup'),
    ownership: {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    },
  });
  await createEntered.promise;

  const terminalAuthorization = await router.claimSandboxCleanupOwnership(
    'task-inflight-create-cleanup',
    'owner:g2',
  );
  await assert.rejects(
    router.teardownSandbox('task-inflight-create-cleanup', {
      cleanupAuthorization: terminalAuthorization,
    }),
    /cleanup is pending settlement of an in-flight create/,
  );
  const stillDeleting = await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-inflight-create-cleanup',
    providerId: 'local',
    ownerGeneration: 'owner:g3',
    proposedResourceGeneration: 'resource:r2',
  });
  assert.equal(stillDeleting.kind, 'cleanup-required');
  assert.equal(stillDeleting.owner.status, 'deleting');
  assert.equal(liveSandboxes.size, 0);

  releaseCreate.resolve();
  await lateDeleteConfirmed.promise;
  const transferredDuringDelete = await router.claimSandboxCleanupOwnership(
    'task-inflight-create-cleanup',
    'owner:g3',
  );
  assert.equal(transferredDuringDelete.ownership.ownerGeneration, 'owner:g3');
  releaseLateCompletion.resolve();
  await assert.rejects(first, /late create was fenced/);
  assert.equal(liveSandboxes.size, 0);
  assert.equal(cleanupTokens.length, 1);
  assert.equal(
    cleanupTokens[0].ownership.ownerGeneration,
    'owner:g2',
    'late creator must complete with the current cleanup owner, not stale g1',
  );
  assert.equal(
    await router.claimSandboxCleanupOwnership(
      'task-inflight-create-cleanup',
      'owner:g4',
    ),
    null,
  );
});

await test('terminal cleanup keeps its work when an absent old resource is replaced before durable recheck', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const firstOwnership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-terminal-replaced-after-404',
    providerId: 'local',
    ownerGeneration: firstOwnership.ownerGeneration,
    proposedResourceGeneration: firstOwnership.resourceGeneration,
  });
  assert.equal(
    await ownerStore.beginSandboxRunCreate({
      taskId: 'task-terminal-replaced-after-404',
      providerId: 'local',
      ownership: firstOwnership,
    }),
    true,
  );
  const firstAuthorization = await ownerStore.claimSandboxRunCleanup(
    'task-terminal-replaced-after-404',
    'owner:g2',
  );
  assert.equal(firstAuthorization.kind, 'authorized');

  const originalJoin = ownerStore.joinSandboxRunCleanup.bind(ownerStore);
  let replacedBeforeRecheck = false;
  ownerStore.joinSandboxRunCleanup = async (args) => {
    if (!replacedBeforeRecheck) {
      replacedBeforeRecheck = true;
      assert.equal(
        await ownerStore.observeSandboxRunCreate({
          taskId: firstAuthorization.authorization.taskId,
          providerId: firstAuthorization.authorization.providerId,
          resourceGeneration:
            firstAuthorization.authorization.ownership.resourceGeneration,
        }),
        true,
        'the first create must be durably observed before its cleanup can complete',
      );
      assert.equal(
        await ownerStore.completeSandboxRunCleanup(
          firstAuthorization.authorization,
          'removed',
        ),
        true,
      );
      await ownerStore.acquireSandboxRunOwner({
        taskId: args.taskId,
        providerId: 'local',
        ownerGeneration: 'owner:g3',
        proposedResourceGeneration: 'resource:r2',
      });
      await ownerStore.recordSandboxRunOwner({
        taskId: args.taskId,
        providerId: 'local',
        providerSandboxId: 'sandbox-r2',
        ownership: {
          ownerGeneration: 'owner:g3',
          resourceGeneration: 'resource:r2',
        },
        status: 'running',
      });
    }
    return originalJoin(args);
  };

  const teardownOptions = [];
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.teardownSandbox = async (_taskId, options) => {
    teardownOptions.push(options);
    return teardownOptions.length === 1
      ? { kind: 'already-absent' }
      : { kind: 'found-and-cleaned' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  await assert.rejects(
    router.teardownSandbox('task-terminal-replaced-after-404', {
      cleanupAuthorization: firstAuthorization.authorization,
    }),
    /cleanup is pending/,
  );
  const replacement = await ownerStore.getSandboxRunOwner(
    'task-terminal-replaced-after-404',
  );
  assert.equal(replacement?.providerSandboxId, 'sandbox-r2');

  const replacementAuthorization = await router.claimSandboxCleanupOwnership(
    'task-terminal-replaced-after-404',
    'owner:g4',
  );
  await router.teardownSandbox('task-terminal-replaced-after-404', {
    cleanupAuthorization: replacementAuthorization,
  });
  assert.equal(teardownOptions.length, 2);
  assert.equal(teardownOptions[0].providerSandboxId, undefined);
  assert.equal(teardownOptions[1].providerSandboxId, 'sandbox-r2');
  assert.deepEqual(
    teardownOptions[1].cleanupAuthorization,
    replacementAuthorization,
  );
  assert.equal(
    await ownerStore.getSandboxRunOwner('task-terminal-replaced-after-404'),
    null,
  );
});

await test('a historical provider sandbox id cannot settle cleanup for an unresolved recreate attempt', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const original = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-recreate-after-loss',
    providerId: 'local',
    ownerGeneration: original.ownerGeneration,
    proposedResourceGeneration: original.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-recreate-after-loss',
    providerId: 'local',
    providerSandboxId: 'historical-r1-sandbox',
    ownership: original,
    status: 'running',
    connection: {
      taskId: 'task-recreate-after-loss',
      baseUrl: 'http://historical.invalid',
      wsUrl: 'ws://historical.invalid',
    },
  });
  const createEntered = deferred();
  const releaseCreate = deferred();
  let liveSandbox = false;
  const provider = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(ctx) {
      await ctx.externalBoundaryGuard?.({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      createEntered.resolve();
      await releaseCreate.promise;
      liveSandbox = true;
      await ctx.onSandboxCreateObserved?.({
        kind: 'created',
        providerSandboxId: `sandbox-${ctx.ownership.resourceGeneration}`,
      });
      const authorization = await ctx.beforeSandboxCleanup();
      assert(authorization);
      liveSandbox = false;
      await ctx.afterSandboxCleanup(authorization);
      throw new Error('recreate fenced');
    },
    async teardownSandbox() {
      if (!liveSandbox) return { kind: 'already-absent' };
      liveSandbox = false;
      return { kind: 'found-and-cleaned' };
    },
    async readRolloutFromContainer() { return null; },
    async sandboxExists() { return liveSandbox; },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  const recreate = router.provision({
    ...provisionContext('task-recreate-after-loss'),
    ownership: {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:r2-proposal',
    },
  });
  await createEntered.promise;
  const cleanupAuthorization = await router.claimSandboxCleanupOwnership(
    'task-recreate-after-loss',
    'owner:g3',
  );
  await assert.rejects(
    router.teardownSandbox('task-recreate-after-loss', {
      cleanupAuthorization,
    }),
    /cleanup is pending settlement of an in-flight create/,
  );

  releaseCreate.resolve();
  await assert.rejects(recreate, /recreate fenced/);
  assert.equal(liveSandbox, false);
  assert.equal(
    await router.claimSandboxCleanupOwnership(
      'task-recreate-after-loss',
      'owner:g4',
    ),
    null,
  );
});

await test('legacy NULL-generation owners are serialized through explicit cleanup', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-legacy-cleanup',
    providerId: 'local',
    providerSandboxId: 'legacy-sandbox',
    status: 'running',
  });
  const teardownOptions = [];
  const provider = routableProvider('local', ['terminal.websocket']);
  provider.teardownSandbox = async (_taskId, options) => {
    teardownOptions.push(options);
    return { kind: 'already-absent' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  const cleanupAuthorization = await router.claimSandboxCleanupOwnership(
    'task-legacy-cleanup',
    'owner:new',
  );
  assert.deepEqual(cleanupAuthorization, {
    kind: 'legacy',
    taskId: 'task-legacy-cleanup',
    providerId: 'local',
  });
  await router.teardownSandbox('task-legacy-cleanup', {
    cleanupAuthorization,
  });
  assert.equal(teardownOptions.length, 1);
  assert.equal(teardownOptions[0].ownership, undefined);
  assert.equal(await ownerStore.getSandboxRunOwner('task-legacy-cleanup'), null);
});

await test('restart reattach cannot revive a deleting generated owner as ownerless', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-deleting-reattach',
    providerId: 'local',
    ownerGeneration: 'owner:g1',
    proposedResourceGeneration: 'resource:r1',
  });
  await ownerStore.claimSandboxRunCleanup(
    'task-deleting-reattach',
    'owner:g2',
  );
  const provider = routableProvider(
    'local',
    ['lifecycle.readopt', 'terminal.websocket'],
    { reattachTask: 'task-deleting-reattach' },
  );
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({
      id: 'local',
      provider,
      capabilities: ['lifecycle.readopt', 'terminal.websocket'],
    })],
    { ownerStore },
  );

  await assert.rejects(
    router.reattach('task-deleting-reattach'),
    /Ownerless sandbox records cannot replace a durable owner/,
  );
  await assert.rejects(
    router.reattach('task-deleting-reattach'),
    /Ownerless sandbox records cannot replace a durable owner/,
  );
  assert.equal(
    provider.calls.filter((call) => call[0] === 'reattach').length,
    2,
    'failed owner persistence must not populate the in-memory owner cache',
  );
  const stillDeleting = await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-deleting-reattach',
    providerId: 'local',
    ownerGeneration: 'owner:g3',
    proposedResourceGeneration: 'resource:r2',
  });
  assert.equal(stillDeleting.kind, 'cleanup-required');
  assert.equal(stillDeleting.owner.status, 'deleting');
});

await test('provider router readopts before selected-run aggregation when no owner is known', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const owner = routableProvider('readopt-owner', [
    'lifecycle.readopt',
    'terminal.websocket',
  ], {
    reattachTask: 'task-readopt-run',
  });
  const router = new mod.SandboxProviderRouter(
    [
      mod.defineCloudSandboxProvider({
        id: 'readopt-owner',
        provider: owner,
        capabilities: ['lifecycle.readopt', 'terminal.websocket'],
      }),
    ],
    { ownerStore },
  );

  const run = await router.getSelectedSandboxRun('task-readopt-run');
  assert.equal(run.providerId, 'readopt-owner');
  assert.equal(run.connection.baseUrl, 'http://readopt-owner');
  assert.equal(run.owner.providerId, 'readopt-owner');
  assert.deepEqual(owner.calls.map((call) => call[0]), ['reattach', 'selectedRun']);
});

await test('provider router refuses no-owner delivery unless readoption proves ownership', async () => {
  const wrongDelivery = routableProvider('wrong-delivery', ['workspace.git.deliver']);
  const owner = routableProvider('owner', ['lifecycle.readopt', 'workspace.git.deliver'], {
    reattachTask: 'task-owned',
  });
  const router = new mod.SandboxProviderRouter([
    mod.defineCloudSandboxProvider({
      id: 'wrong-delivery',
      provider: wrongDelivery,
      capabilities: ['workspace.git.deliver'],
      priority: 100,
    }),
    mod.defineLocalSandboxProvider({
      id: 'owner',
      provider: owner,
      capabilities: ['lifecycle.readopt', 'workspace.git.deliver'],
      priority: 1,
    }),
  ]);

  assert.equal(
    (await router.deliverWorkspaceChanges('task-owned', {
      authHeader: 'Authorization: Basic x',
      branch: 'cap/task-owned',
      commitMessage: 'done',
    })).commitSha,
    'owner',
  );
  assert(!wrongDelivery.calls.some((call) => call[0] === 'deliver'));

  assert.deepEqual(
    await router.deliverWorkspaceChanges('unknown', {
      authHeader: 'Authorization: Basic x',
      branch: 'cap/unknown',
      commitMessage: 'done',
    }),
    {
      hadChanges: false,
      commitSha: null,
      error:
        'sandbox provider for task unknown is unknown; reattach must succeed before workspace delivery',
    },
  );
});

await test('terminal registry resolves descriptors and fails closed on unknown protocols', () => {
  const registry = mod
    .createTerminalTransportRegistry()
    .register('aio-json-v1', ({ taskId, descriptor, connection }) => ({
      open: () => ({
        taskId,
        wsUrl: descriptor.wsUrl ?? connection.wsUrl,
        readyState: 'open',
        pause() {},
        resume() {},
        onFrame: () => ({ dispose() {} }),
        onClose: () => ({ dispose() {} }),
        onError: () => ({ dispose() {} }),
        sendInput: () => true,
        sendResize: () => true,
        sendPong: () => true,
        close() {},
      }),
    }));
  const connection = {
    taskId: 'terminal-task',
    baseUrl: 'http://aio',
    wsUrl: 'ws://aio/default',
    terminal: {
      protocol: 'aio-json-v1',
      wsUrl: 'ws://aio/connection-descriptor',
    },
  };
  assert.equal(
    mod.resolveTerminalDescriptor({ connection }).wsUrl,
    'ws://aio/connection-descriptor',
  );
  assert.equal(
    mod.resolveTerminalDescriptor({
      connection,
      selectedRun: {
        terminal: {
          protocol: 'aio-json-v1',
          wsUrl: 'ws://aio/selected-run',
        },
      },
    }).wsUrl,
    'ws://aio/selected-run',
  );
  assert.equal(registry.build({ taskId: connection.taskId, connection }).open().wsUrl, 'ws://aio/connection-descriptor');
  assert.throws(
    () =>
      registry.build({
        taskId: 'terminal-task',
        connection,
        selectedRun: {
          terminal: {
            protocol: 'unknown-provider',
            wsUrl: 'ws://provider/internal',
          },
        },
      }),
    /unsupported terminal transport protocol "unknown-provider"/,
  );
});

await test('compatibility aggregate exports adapter package surfaces', () => {
  assert.equal(typeof mod.SandboxProviderRouter, 'function');
  assert.equal(typeof mod.defineAioLocalSandboxProvider, 'function');
  assert.equal(typeof mod.defineHttpCloudSandboxProvider, 'function');
  assert.equal(typeof mod.AioSandboxContainerController, 'function');
});

await test('credentialed delivery fencing uses the persisted exact owner and settles it removed', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const ownership = {
    ownerGeneration: 'owner:delivery',
    resourceGeneration: 'resource:delivery',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-delivery-fence',
    providerId: 'local',
    ownerGeneration: ownership.ownerGeneration,
    proposedResourceGeneration: ownership.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-delivery-fence',
    providerId: 'local',
    providerSandboxId: 'sandbox-delivery-fence',
    ownership,
    status: 'running',
  });

  let callerBeforeCalls = 0;
  let callerAfterCalls = 0;
  const deliveryEvents = [];
  const provider = routableProvider('local', [
    'workspace.git.deliver',
    'lifecycle.readopt',
  ]);
  provider.reattach = async (_taskId, target) => {
    assert.deepEqual(target, {
      providerSandboxId: 'sandbox-delivery-fence',
      ownership,
    });
    return {
      taskId: 'task-delivery-fence',
      baseUrl: 'http://local/task-delivery-fence',
      wsUrl: 'ws://local/task-delivery-fence',
    };
  };
  provider.deliverWorkspaceChanges = async (taskId, args) => {
    assert.equal(taskId, 'task-delivery-fence');
    assert.deepEqual(args.ownership, ownership);
    deliveryEvents.push('delivery-started');
    const authorization = await args.beforeSandboxCleanup();
    assert.deepEqual(authorization, {
      kind: 'generation',
      taskId,
      providerId: 'local',
      ownership,
    });
    deliveryEvents.push('cleanup-authorized');
    const blocked = await ownerStore.acquireSandboxRunOwner({
      taskId,
      providerId: 'local',
      ownerGeneration: 'owner:replacement',
      proposedResourceGeneration: 'resource:replacement',
    });
    assert.equal(blocked.kind, 'cleanup-required');
    assert.equal(blocked.owner.status, 'deleting');
    deliveryEvents.push('sandbox-removed-and-confirmed');
    await args.afterSandboxCleanup(authorization);
    deliveryEvents.push('cleanup-completed');
    return { hadChanges: false, commitSha: null, error: 'delivery_timeout' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  const result = await router.deliverWorkspaceChanges(
    'task-delivery-fence',
    {
      branch: 'cap/task-delivery-fence',
      commitMessage: 'delivery fence',
      credential: mod.createExactHostGitCredential(
        'https://code.example.test/acme/private.git',
        'Authorization: Basic canary',
      ),
      ownership: {
        ownerGeneration: 'caller:must-not-win',
        resourceGeneration: 'caller:must-not-win',
      },
      beforeSandboxCleanup: async () => {
        callerBeforeCalls += 1;
        return null;
      },
      afterSandboxCleanup: async () => {
        callerAfterCalls += 1;
      },
    },
  );

  assert.deepEqual(result, {
    hadChanges: false,
    commitSha: null,
    error: 'delivery_timeout',
  });
  assert.equal(callerBeforeCalls, 0);
  assert.equal(callerAfterCalls, 0);
  assert.deepEqual(deliveryEvents, [
    'delivery-started',
    'cleanup-authorized',
    'sandbox-removed-and-confirmed',
    'cleanup-completed',
  ]);
  assert.equal(await ownerStore.getSandboxRunOwner('task-delivery-fence'), null);
  const replacement = await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-delivery-fence',
    providerId: 'local',
    ownerGeneration: 'owner:replacement',
    proposedResourceGeneration: 'resource:replacement',
  });
  assert.equal(replacement.kind, 'acquired');
  assert.equal(
    replacement.ownership.resourceGeneration,
    'resource:replacement',
  );
});

await test('delivery cleanup completion failure retains the deleting tombstone for recovery', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const ownership = {
    ownerGeneration: 'owner:delivery-pending',
    resourceGeneration: 'resource:delivery-pending',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-delivery-pending',
    providerId: 'local',
    ownerGeneration: ownership.ownerGeneration,
    proposedResourceGeneration: ownership.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-delivery-pending',
    providerId: 'local',
    ownership,
    status: 'running',
  });
  ownerStore.completeSandboxRunCleanup = async () => false;

  const provider = routableProvider('local', ['workspace.git.deliver']);
  provider.reattach = async (_taskId, target) => {
    assert.deepEqual(target, { ownership });
    return {
      taskId: 'task-delivery-pending',
      baseUrl: 'http://local/task-delivery-pending',
      wsUrl: 'ws://local/task-delivery-pending',
    };
  };
  provider.deliverWorkspaceChanges = async (_taskId, args) => {
    const authorization = await args.beforeSandboxCleanup();
    await args.afterSandboxCleanup(authorization);
    assert.fail('failed completion must reject delivery');
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );
  await assert.rejects(
    router.deliverWorkspaceChanges('task-delivery-pending', {
      branch: 'cap/task-delivery-pending',
      commitMessage: 'delivery pending',
      credential: mod.createExactHostGitCredential(
        'https://code.example.test/acme/private.git',
        'Authorization: Basic canary',
      ),
    }),
    /delivery cleanup generation was superseded/u,
  );
  const blocked = await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-delivery-pending',
    providerId: 'local',
    ownerGeneration: 'owner:recovery',
    proposedResourceGeneration: 'resource:replacement',
  });
  assert.equal(blocked.kind, 'cleanup-required');
  assert.equal(blocked.owner.status, 'deleting');
  assert.deepEqual(blocked.owner.ownership, ownership);
});

await test('credentialed delivery fails closed when the persisted exact target cannot reattach', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const ownership = {
    ownerGeneration: 'owner:missing-delivery-target',
    resourceGeneration: 'resource:missing-delivery-target',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-missing-delivery-target',
    providerId: 'local',
    ownerGeneration: ownership.ownerGeneration,
    proposedResourceGeneration: ownership.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-missing-delivery-target',
    providerId: 'local',
    providerSandboxId: 'sandbox-missing-delivery-target',
    ownership,
    status: 'running',
  });
  let deliveryCalls = 0;
  const provider = routableProvider('local', [
    'workspace.git.deliver',
    'lifecycle.readopt',
  ]);
  provider.reattach = async (_taskId, target) => {
    assert.deepEqual(target, {
      providerSandboxId: 'sandbox-missing-delivery-target',
      ownership,
    });
    return null;
  };
  provider.deliverWorkspaceChanges = async () => {
    deliveryCalls += 1;
    assert.fail('delivery must not run after exact reattach returned null');
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  assert.deepEqual(
    await router.deliverWorkspaceChanges('task-missing-delivery-target', {
      branch: 'cap/task-missing-delivery-target',
      commitMessage: 'must not deliver',
      credential: mod.createExactHostGitCredential(
        'https://code.example.test/acme/private.git',
        'Authorization: Basic canary',
      ),
    }),
    {
      hadChanges: false,
      commitSha: null,
      error:
        'sandbox provider for task task-missing-delivery-target could not reattach its persisted target before workspace delivery',
    },
  );
  assert.equal(deliveryCalls, 0);
  assert.equal(
    (await ownerStore.getSandboxRunOwner('task-missing-delivery-target'))
      ?.status,
    'running',
  );
});

await test('legacy owner delivery fencing settles the owner instead of leaving stale running state', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-legacy-delivery-fence',
    providerId: 'local',
    providerSandboxId: 'sandbox-legacy-delivery-fence',
    status: 'running',
  });
  const provider = routableProvider('local', [
    'workspace.git.deliver',
    'lifecycle.readopt',
  ]);
  provider.reattach = async (_taskId, target) => {
    assert.deepEqual(target, {
      providerSandboxId: 'sandbox-legacy-delivery-fence',
    });
    return {
      taskId: 'task-legacy-delivery-fence',
      baseUrl: 'http://local/task-legacy-delivery-fence',
      wsUrl: 'ws://local/task-legacy-delivery-fence',
    };
  };
  provider.deliverWorkspaceChanges = async (taskId, args) => {
    assert.equal(args.ownership, undefined);
    const authorization = await args.beforeSandboxCleanup();
    assert.deepEqual(authorization, {
      kind: 'legacy',
      taskId,
      providerId: 'local',
    });
    const blocked = await ownerStore.acquireSandboxRunOwner({
      taskId,
      providerId: 'local',
      ownerGeneration: 'owner:replacement',
      proposedResourceGeneration: 'resource:replacement',
    });
    assert.equal(blocked.kind, 'cleanup-required');
    assert.equal(blocked.owner.status, 'deleting');
    await args.afterSandboxCleanup(authorization);
    return { hadChanges: false, commitSha: null, error: 'delivery_timeout' };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  assert.equal(
    (
      await router.deliverWorkspaceChanges('task-legacy-delivery-fence', {
        branch: 'cap/task-legacy-delivery-fence',
        commitMessage: 'legacy delivery fence',
        credential: mod.createExactHostGitCredential(
          'https://code.example.test/acme/private.git',
          'Authorization: Basic canary',
        ),
      })
    ).error,
    'delivery_timeout',
  );
  assert.equal(
    await ownerStore.getSandboxRunOwner('task-legacy-delivery-fence'),
    null,
  );
  assert.equal(
    (
      await ownerStore.acquireSandboxRunOwner({
        taskId: 'task-legacy-delivery-fence',
        providerId: 'local',
        ownerGeneration: 'owner:replacement',
        proposedResourceGeneration: 'resource:replacement',
      })
    ).kind,
    'acquired',
  );
});

await test('successful generated-owner delivery does not enter cleanup and keeps the owner running', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const ownership = {
    ownerGeneration: 'owner:successful-push',
    resourceGeneration: 'resource:successful-push',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-successful-push',
    providerId: 'local',
    ownerGeneration: ownership.ownerGeneration,
    proposedResourceGeneration: ownership.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-successful-push',
    providerId: 'local',
    providerSandboxId: 'sandbox-successful-push',
    ownership,
    status: 'running',
  });
  const provider = routableProvider('local', [
    'workspace.git.deliver',
    'lifecycle.readopt',
  ]);
  provider.reattach = async () => ({
    taskId: 'task-successful-push',
    baseUrl: 'http://local/task-successful-push',
    wsUrl: 'ws://local/task-successful-push',
  });
  provider.deliverWorkspaceChanges = async (_taskId, args) => {
    assert.equal(typeof args.beforeSandboxCleanup, 'function');
    assert.equal(typeof args.afterSandboxCleanup, 'function');
    return {
      hadChanges: true,
      commitSha: 'successful-push-sha',
      error: null,
    };
  };
  const router = new mod.SandboxProviderRouter(
    [mod.defineLocalSandboxProvider({ id: 'local', provider })],
    { ownerStore },
  );

  assert.equal(
    (
      await router.deliverWorkspaceChanges('task-successful-push', {
        branch: 'cap/task-successful-push',
        commitMessage: 'successful push',
        credential: mod.createExactHostGitCredential(
          'https://code.example.test/acme/private.git',
          'Authorization: Basic canary',
        ),
      })
    ).commitSha,
    'successful-push-sha',
  );
  const owner = await ownerStore.getSandboxRunOwner('task-successful-push');
  assert.equal(owner.status, 'running');
  assert.deepEqual(owner.ownership, ownership);
});

await test('an old delivery completion cannot clear a newly provisioned provider cache', async () => {
  const ownerStore = new mod.InMemorySandboxRunOwnerStore();
  const firstOwnership = {
    ownerGeneration: 'owner:old-delivery',
    resourceGeneration: 'resource:old-delivery',
  };
  await ownerStore.acquireSandboxRunOwner({
    taskId: 'task-delivery-cache-race',
    providerId: 'old-provider',
    ownerGeneration: firstOwnership.ownerGeneration,
    proposedResourceGeneration: firstOwnership.resourceGeneration,
  });
  await ownerStore.recordSandboxRunOwner({
    taskId: 'task-delivery-cache-race',
    providerId: 'old-provider',
    providerSandboxId: 'sandbox-old-delivery',
    ownership: firstOwnership,
    status: 'running',
  });
  const oldProvider = routableProvider('old-provider', [
    'workspace.git.deliver',
    'lifecycle.readopt',
  ]);
  oldProvider.reattach = async () => ({
    taskId: 'task-delivery-cache-race',
    baseUrl: 'http://old-provider/task-delivery-cache-race',
    wsUrl: 'ws://old-provider/task-delivery-cache-race',
  });
  oldProvider.deliverWorkspaceChanges = async (_taskId, args) => {
    const authorization = await args.beforeSandboxCleanup();
    await args.afterSandboxCleanup(authorization);
    return { hadChanges: false, commitSha: null, error: 'delivery_timeout' };
  };
  const newProvider = routableProvider('new-provider', [
    'terminal.websocket',
  ]);
  let router;
  const completeCleanup =
    ownerStore.completeSandboxRunCleanup.bind(ownerStore);
  ownerStore.completeSandboxRunCleanup = async (authorization, status) => {
    const completed = await completeCleanup(authorization, status);
    assert.equal(completed, true);
    await router.provision({
      ...provisionContext('task-delivery-cache-race'),
      ownership: {
        ownerGeneration: 'owner:new-delivery',
        resourceGeneration: 'resource:new-delivery',
      },
    });
    return true;
  };
  router = new mod.SandboxProviderRouter(
    [
      mod.defineLocalSandboxProvider({
        id: 'old-provider',
        provider: oldProvider,
        priority: 1,
      }),
      mod.defineCloudSandboxProvider({
        id: 'new-provider',
        provider: newProvider,
        priority: 100,
      }),
    ],
    { ownerStore },
  );

  await router.deliverWorkspaceChanges('task-delivery-cache-race', {
    branch: 'cap/task-delivery-cache-race',
    commitMessage: 'cache race',
    credential: mod.createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      'Authorization: Basic canary',
    ),
  });
  assert.equal(router.owners.get('task-delivery-cache-race'), 'new-provider');
  assert.equal(
    (await ownerStore.getSandboxRunOwner('task-delivery-cache-race')).providerId,
    'new-provider',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
