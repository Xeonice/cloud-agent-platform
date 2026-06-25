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

  const withoutWorkspace = mod.buildSandboxProvisionPlan({ cloneSpec: null });
  assert.equal(withoutWorkspace.cloneSpec, null);
  assert.deepEqual(withoutWorkspace.requiredCapabilities, ['terminal.websocket']);
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

await test('compatibility aggregate exports adapter package surfaces', () => {
  assert.equal(typeof mod.SandboxProviderRouter, 'function');
  assert.equal(typeof mod.defineAioLocalSandboxProvider, 'function');
  assert.equal(typeof mod.defineHttpCloudSandboxProvider, 'function');
  assert.equal(typeof mod.AioSandboxContainerController, 'function');
});

await test('provider conformance scenarios exercise the shared provider contract', async () => {
  const taskId = 'task-conformance';
  const connection = {
    taskId,
    baseUrl: `http://sandbox/${taskId}`,
    wsUrl: `ws://sandbox/${taskId}/ws`,
  };
  const fakeProvider = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => mod.SANDBOX_PROVIDER_CAPABILITIES,
    provision: async () => connection,
    sandboxExists: async () => true,
    deliverWorkspaceChanges: async () => ({
      hadChanges: true,
      commitSha: 'abc123',
      error: null,
    }),
    readRolloutFromContainer: async () => ({
      format: 'codex-rollout',
      jsonl: '{"type":"turn"}\n',
    }),
    listReadoptable: async () => [taskId],
    reattach: async () => connection,
    teardownSandbox: async () => undefined,
  };

  const scenarios = mod.createSandboxProviderConformanceScenarios(
    {
      provider: fakeProvider,
      taskId,
      cloneSpec: { url: 'https://example.test/repo.git' },
      runtimeId: 'codex',
      requiredCapabilities: mod.SANDBOX_PROVIDER_CAPABILITIES,
    },
    assert,
  );

  for (const scenario of scenarios) {
    await scenario.run();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
