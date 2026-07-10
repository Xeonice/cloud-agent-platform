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
    async getSelectedSandboxRun(taskId) {
      calls.push(['selectedRun', taskId]);
      return options.selectedRun?.(taskId) ?? null;
    },
  };
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
      authHeader: 'Authorization: Basic secret-token',
    },
    '/workspace',
  );
  assert.equal(
    command,
    "git -c 'http.extraHeader=Authorization: Basic secret-token' clone -- 'https://github.com/acme/private.git' '/workspace'",
  );
  assert.equal(
    mod.scrubSandboxExecSecrets(
      'fatal https://user:token@example.test/repo.git Authorization: Basic abc123',
    ),
    'fatal https://***:***@example.test/repo.git Authorization: Basic ***',
  );
});

await test('git delivery commands inject commit message via base64 file', () => {
  const commands = mod.buildGitDeliveryCommands({
    workspaceDir: '/workspace',
    authHeader: 'Authorization: Basic secret-token',
    branch: 'cap/task-123',
    commitMessage: 'hello\nworld',
  });
  assert.equal(commands.status, "git -C '/workspace' status --porcelain");
  assert.match(commands.writeCommitMessage, /^printf %s '[A-Za-z0-9+/=]+' \| base64 -d > '\/tmp\/cap-commit-msg'$/);
  assert.match(commands.commit, /commit -F '\/tmp\/cap-commit-msg'$/);
  assert.equal(
    commands.push,
    "git -C '/workspace' -c 'http.extraHeader=Authorization: Basic secret-token' push --force-with-lease origin 'cap/task-123'",
  );
  assert(!commands.commit.includes('hello'), 'raw commit message is not on the shell line');
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
  const connection = await router.provision({
    taskId: 'task-routed',
    cloneSpec: { url: 'https://example.test/repo.git' },
  });
  assert.equal(connection.baseUrl, 'http://cloud/task-routed');
  assert.deepEqual(local.calls, []);

  const delivery = await router.deliverWorkspaceChanges('task-routed', {
    authHeader: 'Authorization: Basic x',
    branch: 'cap/task-routed',
    commitMessage: 'done',
  });
  assert.equal(delivery.commitSha, 'cloud');
  assert.deepEqual(cloud.calls.map((call) => call[0]), ['provision', 'deliver']);
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
  await router.provision({ taskId: 'task-owned-read', cloneSpec: null });
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
  await router.provision({ taskId: 'task-partial', cloneSpec: null });
  const run = await router.getSelectedSandboxRun('task-partial');
  assert.equal(run.providerSandboxId, 'task-partial');
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

  await router.provision({ taskId: 'task-env-owner', cloneSpec: null });
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
  assert.equal(selected.providerSandboxId, 'task-selected-readopt');
});

await test('provider router selected-run can fall back to connection task id without owner store', async () => {
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
  await router.provision({ taskId: 'task-connection-fallback', cloneSpec: null });
  const run = await router.getSelectedSandboxRun('task-connection-fallback');
  assert.equal(run.providerSandboxId, 'provider-connection-task');
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

  await firstRouter.provision({ taskId: 'task-owned', cloneSpec: null });
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
