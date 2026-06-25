import assert from 'node:assert/strict';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(new URL('../../sandbox-core/dist/index.js', import.meta.url).href);

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

function routableProvider(name, capabilities, options = {}) {
  const calls = [];
  const connection = {
    taskId: options.reattachTask ?? 'task',
    baseUrl: `http://${name}`,
    wsUrl: `ws://${name}`,
  };
  return {
    calls,
    getSandboxMode: () => options.mode ?? 'workspace-write',
    getProviderCapabilities: capabilities === undefined ? undefined : () => capabilities,
    async provision(ctx) {
      calls.push(['provision', ctx.taskId, ctx.cloneSpec ?? null]);
      return {
        taskId: ctx.taskId,
        baseUrl: `http://${name}/${ctx.taskId}`,
        wsUrl: `ws://${name}/${ctx.taskId}`,
      };
    },
    async teardownSandbox(taskId) {
      calls.push(['teardown', taskId]);
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
    async reattach(taskId) {
      calls.push(['reattach', taskId]);
      return options.reattachTask === taskId
        ? { ...connection, taskId }
        : null;
    },
  };
}

await test('single-provider selector rejects a missing provider', () => {
  assert.throws(
    () => mod.selectSandboxProvider(null, ['terminal.websocket']),
    /No sandbox provider is configured/,
  );
});

await test('single-provider selector preserves legacy compatibility by default', () => {
  const legacy = provider('legacy-local', undefined);
  const selected = mod.selectSandboxProvider(legacy, ['terminal.websocket']);
  assert.equal(selected.provider, legacy);
  assert.equal(selected.compatibility, 'legacy-assumed');
  assert.deepEqual(selected.capabilities, []);
});

await test('configured selector rejects undeclared providers unless explicitly allowed', () => {
  const legacy = provider('legacy-local', undefined);
  assert.throws(
    () => mod.selectConfiguredSandboxProvider(legacy, ['terminal.websocket']),
    /does not declare capabilities/,
  );
  assert.equal(
    mod.selectConfiguredSandboxProvider(legacy, ['terminal.websocket'], {
      allowLegacyProvider: true,
    }).compatibility,
    'legacy-assumed',
  );
});

await test('declared single-provider selector succeeds and fails closed on missing capabilities', () => {
  const declared = provider('aio-local', ['terminal.websocket']);
  assert.equal(
    mod.selectSandboxProvider(declared, ['terminal.websocket']).compatibility,
    'declared',
  );
  assert.throws(
    () => mod.selectSandboxProvider(declared, ['workspace.git.materialize']),
    /missing required capabilities: workspace\.git\.materialize/,
  );
});

await test('candidate selector chooses highest priority and preserves declaration order ties', () => {
  const first = provider('first', ['terminal.websocket']);
  const second = provider('second', ['terminal.websocket']);
  assert.equal(
    mod.selectSandboxProviderCandidate(
      [
        { id: 'first', provider: first, location: 'local', priority: 10 },
        { id: 'second', provider: second, location: 'cloud', priority: 50 },
      ],
      ['terminal.websocket'],
    ).id,
    'second',
  );
  assert.equal(
    mod.selectSandboxProviderCandidate(
      [
        { id: 'first', provider: first, location: 'local', priority: 10 },
        { id: 'second', provider: second, location: 'cloud', priority: 10 },
      ],
      ['terminal.websocket'],
    ).id,
    'first',
  );
});

await test('candidate selector uses location preference only as a tie breaker', () => {
  const local = provider('aio-local', ['terminal.websocket']);
  const cloud = provider('cloud', ['terminal.websocket']);
  assert.equal(
    mod.selectSandboxProviderCandidate(
      [
        { id: 'cloud', provider: cloud, location: 'cloud', priority: 10 },
        { id: 'local', provider: local, location: 'local', priority: 10 },
      ],
      ['terminal.websocket'],
      { preferLocation: 'local' },
    ).id,
    'local',
  );
  assert.equal(
    mod.selectSandboxProviderCandidate(
      [
        { id: 'cloud', provider: cloud, location: 'cloud', priority: 50 },
        { id: 'local', provider: local, location: 'local', priority: 10 },
      ],
      ['terminal.websocket'],
      { preferLocation: 'local' },
    ).id,
    'cloud',
  );
  assert.equal(
    mod.selectSandboxProviderCandidate(
      [
        { id: 'local', provider: local, location: 'local', priority: 10 },
        { id: 'cloud', provider: cloud, location: 'cloud', priority: 10 },
      ],
      ['terminal.websocket'],
      { preferLocation: 'local' },
    ).id,
    'local',
  );
});

await test('candidate selector skips missing capabilities and reports all rejection reasons', () => {
  const local = provider('aio-local', ['terminal.websocket']);
  const cloud = provider('cloud', [
    'terminal.websocket',
    'workspace.git.materialize',
  ]);
  assert.equal(
    mod.selectSandboxProviderCandidate(
      [
        { id: 'local', provider: local, location: 'local', priority: 100 },
        { id: 'cloud', provider: cloud, location: 'cloud', priority: 10 },
      ],
      ['terminal.websocket', 'workspace.git.materialize'],
    ).id,
    'cloud',
  );
  assert.throws(
    () =>
      mod.selectSandboxProviderCandidate(
        [
          { id: 'local', provider: local, location: 'local' },
          { id: 'legacy', provider: provider('legacy', undefined), location: 'cloud' },
        ],
        ['workspace.git.deliver'],
      ),
    /local: missing workspace\.git\.deliver; legacy: no declared capabilities/,
  );
});

await test('candidate selector handles legacy and empty candidate sets explicitly', () => {
  const legacy = provider('legacy', undefined);
  assert.equal(
    mod.selectSandboxProviderCandidate(
      [{ id: 'legacy', provider: legacy, location: 'local' }],
      ['terminal.websocket'],
      { allowLegacyProvider: true },
    ).compatibility,
    'legacy-assumed',
  );
  assert.equal(
    mod.selectSandboxProviderCandidate(
      [
        {
          id: 'declared-no-priority',
          provider: provider('declared', ['terminal.websocket']),
          location: 'local',
        },
      ],
      ['terminal.websocket'],
    ).priority,
    0,
  );
  assert.throws(
    () => mod.selectSandboxProviderCandidate([], ['terminal.websocket']),
    /No sandbox provider candidates are configured/,
  );
});

await test('operation selectors bind callers to operation-specific capability sets', () => {
  const full = provider('full', core.SANDBOX_PROVIDER_CAPABILITIES);
  assert.deepEqual(
    mod.selectDeliverySandboxProvider(full).capabilities,
    core.SANDBOX_PROVIDER_CAPABILITIES,
  );
  assert.equal(mod.selectReadoptionSandboxProvider(full).provider, full);
  assert.equal(mod.selectRetainedTranscriptSandboxProvider(full).provider, full);
});

await test('provision plan couples cloneSpec and required capabilities', () => {
  const cloneSpec = { url: 'https://example.test/repo.git' };
  assert.deepEqual(mod.provisionSandboxRequiredCapabilities({
    materializeGitWorkspace: true,
  }), ['terminal.websocket', 'workspace.git.materialize']);
  assert.deepEqual(mod.provisionSandboxRequiredCapabilities({
    materializeGitWorkspace: false,
  }), ['terminal.websocket']);
  assert.deepEqual(mod.buildSandboxProvisionPlan({ cloneSpec }), {
    cloneSpec,
    requiredCapabilities: ['terminal.websocket', 'workspace.git.materialize'],
  });
  assert.deepEqual(mod.buildSandboxProvisionPlan({ cloneSpec: null }), {
    cloneSpec: null,
    requiredCapabilities: ['terminal.websocket'],
  });
  assert.deepEqual(mod.buildSandboxProvisionPlan({ cloneSpec: undefined }), {
    cloneSpec: undefined,
    requiredCapabilities: ['terminal.websocket'],
  });
});

await test('missingCapabilities returns only required entries that are absent', () => {
  assert.deepEqual(
    mod.missingCapabilities(['terminal.websocket'], [
      'terminal.websocket',
      'workspace.git.deliver',
    ]),
    ['workspace.git.deliver'],
  );
  assert.deepEqual(
    mod.missingCapabilities(['terminal.websocket'], ['terminal.websocket']),
    [],
  );
});

await test('provider registry manages local and cloud candidates', () => {
  const local = core.defineLocalSandboxProvider({
    id: 'local',
    provider: provider('local', ['terminal.websocket']),
  });
  const cloud = core.defineCloudSandboxProvider({
    id: 'cloud',
    provider: provider('cloud', [
      'terminal.websocket',
      'workspace.git.materialize',
    ]),
    priority: 10,
  });
  const registry = new mod.SandboxProviderRegistry([local]);
  registry.register(cloud);

  assert.equal(registry.get('local'), local);
  assert.equal(registry.get('missing'), undefined);
  assert.deepEqual(registry.list().map((entry) => entry.id), ['local', 'cloud']);
  assert.deepEqual(registry.list({ location: 'local' }).map((entry) => entry.id), [
    'local',
  ]);
  assert.deepEqual(registry.list({ location: 'cloud' }).map((entry) => entry.id), [
    'cloud',
  ]);
  assert.deepEqual(registry.snapshot().local.map((entry) => entry.id), ['local']);
  assert.equal(
    registry.select(['terminal.websocket', 'workspace.git.materialize']).id,
    'cloud',
  );
  assert.throws(() => registry.register(local), /already registered/);
  assert.throws(
    () => new mod.SandboxProviderRegistry([local, local]),
    /already registered/,
  );
});

await test('provider router selects local or cloud by capabilities and pins task ownership', async () => {
  const local = routableProvider('local', core.SANDBOX_PROVIDER_CAPABILITIES, {
    mode: 'workspace-write',
  });
  const cloud = routableProvider('cloud', core.SANDBOX_PROVIDER_CAPABILITIES, {
    mode: 'danger-full-access',
  });
  const router = new mod.SandboxProviderRouter([
    core.defineLocalSandboxProvider({ id: 'local', provider: local, priority: 1 }),
    core.defineCloudSandboxProvider({ id: 'cloud', provider: cloud, priority: 10 }),
  ]);

  assert.equal(router.getSandboxMode(), 'danger-full-access');
  assert.deepEqual(router.getProviderCapabilities(), core.SANDBOX_PROVIDER_CAPABILITIES);

  const connection = await router.provision({
    taskId: 'task-routed',
    cloneSpec: { url: 'https://example.test/repo.git' },
  });
  assert.equal(connection.baseUrl, 'http://cloud/task-routed');
  assert.deepEqual(local.calls, []);
  assert.equal(cloud.calls[0][0], 'provision');

  assert.equal(
    (await router.deliverWorkspaceChanges('task-routed', {
      authHeader: 'Authorization: Basic x',
      branch: 'cap/task-routed',
      commitMessage: 'done',
    })).commitSha,
    'cloud',
  );
  assert.equal(await router.sandboxExists('task-routed'), false);
  await router.teardownSandbox('task-routed');
  assert.deepEqual(cloud.calls.map((call) => call[0]), [
    'provision',
    'deliver',
    'exists',
    'teardown',
  ]);
});

await test('provider router honors location preference and handles missing owner capabilities', async () => {
  const local = routableProvider('local-lite', ['terminal.websocket'], {
    mode: 'read-only',
  });
  const cloud = routableProvider('cloud-full', core.SANDBOX_PROVIDER_CAPABILITIES, {
    mode: 'workspace-write',
  });
  const router = new mod.SandboxProviderRouter(
    [
      core.defineLocalSandboxProvider({ id: 'local', provider: local, priority: 5 }),
      core.defineCloudSandboxProvider({ id: 'cloud', provider: cloud, priority: 5 }),
    ],
    { preferLocation: 'local' },
  );

  assert.equal(router.getSandboxMode(), 'workspace-write');
  await router.provision({ taskId: 'task-local', cloneSpec: null });
  assert.equal(local.calls[0][0], 'provision');
  assert.deepEqual(await router.readRolloutFromContainer('task-local', 'codex'), null);
  assert.deepEqual(
    await router.deliverWorkspaceChanges('task-local', {
      authHeader: 'Authorization: Basic x',
      branch: 'cap/task-local',
      commitMessage: 'done',
    }),
    {
      hadChanges: false,
      commitSha: null,
      error: 'sandbox provider for task task-local does not support workspace delivery',
    },
  );
});

await test('provider router aggregates readoption and probes compatible providers after restart', async () => {
  const local = routableProvider('local', core.SANDBOX_PROVIDER_CAPABILITIES, {
    readoptable: ['task-a', 'shared'],
    rollout: null,
  });
  const cloud = routableProvider('cloud', core.SANDBOX_PROVIDER_CAPABILITIES, {
    readoptable: ['shared', 'task-b'],
    reattachTask: 'task-b',
    rollout: { format: 'codex-rollout', jsonl: '{"type":"turn"}\n' },
    exists: true,
  });
  const noReadoption = routableProvider('no-readoption', ['terminal.websocket']);
  delete noReadoption.listReadoptable;
  const readoptionWithoutMethods = routableProvider(
    'readoption-without-methods',
    core.SANDBOX_PROVIDER_CAPABILITIES,
  );
  delete readoptionWithoutMethods.listReadoptable;
  delete readoptionWithoutMethods.reattach;

  const router = new mod.SandboxProviderRouter([
    core.defineLocalSandboxProvider({ id: 'local', provider: local }),
    core.defineCloudSandboxProvider({ id: 'cloud', provider: cloud }),
    core.defineLocalSandboxProvider({
      id: 'no-readoption',
      provider: noReadoption,
      capabilities: ['terminal.websocket'],
    }),
    core.defineCloudSandboxProvider({
      id: 'readoption-without-methods',
      provider: readoptionWithoutMethods,
    }),
  ]);

  assert.deepEqual(await router.listReadoptable(), ['task-a', 'shared', 'task-b']);
  assert.equal(await router.reattach('missing'), null);
  assert.equal((await router.reattach('task-b'))?.baseUrl, 'http://cloud');
  assert.equal((await router.reattach('task-b'))?.baseUrl, 'http://cloud');

  assert.equal(
    (await router.readRolloutFromContainer('task-b', 'codex'))?.jsonl,
    '{"type":"turn"}\n',
  );
  assert.equal(
    (await router.readRolloutFromContainer('task-archive', null))?.format,
    'codex-rollout',
  );
  assert.equal(await router.sandboxExists('task-archive'), true);

  const ownerWithoutReattach = routableProvider(
    'owner-without-reattach',
    core.SANDBOX_PROVIDER_CAPABILITIES,
  );
  delete ownerWithoutReattach.reattach;
  const ownedRouter = new mod.SandboxProviderRouter([
    core.defineLocalSandboxProvider({
      id: 'owner-without-reattach',
      provider: ownerWithoutReattach,
    }),
  ]);
  await ownedRouter.provision({ taskId: 'owned-no-reattach', cloneSpec: null });
  assert.equal(await ownedRouter.reattach('owned-no-reattach'), null);
});

await test('provider router reattaches before no-owner delivery and never guesses a writer', async () => {
  const readOnly = routableProvider('read-only', ['terminal.websocket'], {
    mode: 'read-only',
  });
  const wrongDelivery = routableProvider('wrong-delivery', [
    'workspace.git.deliver',
  ], {
    mode: 'read-only',
  });
  const owner = routableProvider('owner', [
    'lifecycle.readopt',
    'workspace.git.deliver',
  ], {
    mode: 'read-only',
    reattachTask: 'task-owned',
  });
  const router = new mod.SandboxProviderRouter([
    core.defineLocalSandboxProvider({
      id: 'read-only',
      provider: readOnly,
      capabilities: ['terminal.websocket'],
    }),
    core.defineCloudSandboxProvider({
      id: 'wrong-delivery',
      provider: wrongDelivery,
      capabilities: ['workspace.git.deliver'],
      priority: 100,
    }),
    core.defineLocalSandboxProvider({
      id: 'owner',
      provider: owner,
      capabilities: ['lifecycle.readopt', 'workspace.git.deliver'],
      priority: 1,
    }),
  ]);

  assert.equal(router.getSandboxMode(), 'read-only');
  assert.equal(
    (await router.deliverWorkspaceChanges('task-owned', {
      authHeader: 'Authorization: Basic x',
      branch: 'cap/task-owned',
      commitMessage: 'done',
    })).commitSha,
    'owner',
  );
  assert(!wrongDelivery.calls.some((call) => call[0] === 'deliver'));
  assert.deepEqual(owner.calls.map((call) => call[0]), ['reattach', 'deliver']);

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
  assert.equal(await router.readRolloutFromContainer('unknown', null), null);
  assert.equal(await router.sandboxExists('unknown'), false);
  await router.teardownSandbox('unknown');
  assert(readOnly.calls.some((call) => call[0] === 'teardown'));
  assert(wrongDelivery.calls.some((call) => call[0] === 'teardown'));
  assert(owner.calls.some((call) => call[0] === 'teardown'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
