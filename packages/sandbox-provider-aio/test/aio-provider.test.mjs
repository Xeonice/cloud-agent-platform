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

function provisionContext(taskId, cloneSpec) {
  return {
    taskId,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    ...(cloneSpec === undefined ? {} : { cloneSpec }),
  };
}

function response(status, body = { data: { exit_code: 0, output: '' } }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function ownership(ownerGeneration, resourceGeneration) {
  return { ownerGeneration, resourceGeneration };
}

function cleanupAuthorization(
  taskId,
  ownerGeneration,
  resourceGeneration,
  providerId = 'aio-local',
) {
  return {
    kind: 'generation',
    taskId,
    providerId,
    ownership: ownership(ownerGeneration, resourceGeneration),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function makeContainer(name = 'container', inspection = null) {
  const calls = [];
  let running = inspection?.State?.Running === true;
  let removed = false;
  return {
    id: inspection?.Id ?? name,
    name,
    calls,
    isRunning() {
      return running && !removed;
    },
    isRemoved() {
      return removed;
    },
    async start() {
      calls.push(['start']);
      running = true;
    },
    async stop(options) {
      calls.push(['stop', options]);
      running = false;
    },
    async remove(options) {
      calls.push(['remove', options]);
      removed = true;
    },
    async inspect() {
      calls.push(['inspect']);
      if (removed || inspection === null) {
        throw Object.assign(new Error('missing'), { statusCode: 404 });
      }
      return {
        Id: inspection.Id ?? name,
        ...inspection,
        State: { ...(inspection.State ?? {}), Running: running },
      };
    },
    async getArchive() {
      throw new Error('not implemented');
    },
  };
}

function makeDocker() {
  const created = [];
  const byName = new Map();
  let running = [];
  return {
    created,
    byName,
    setRunning(value) {
      running = value;
    },
    async createContainer(options) {
      const id = `docker-id:${options.name}:${created.length + 1}`;
      const container = makeContainer(options.name, {
        Id: id,
        Config: {
          Image: options.Image,
          Env: options.Env,
          Labels: options.Labels,
        },
        HostConfig: { NetworkMode: options.HostConfig.NetworkMode },
        State: { Running: false },
      });
      created.push({ options, container });
      byName.set(options.name, container);
      byName.set(id, container);
      return container;
    },
    getContainer(name) {
      if (!byName.has(name)) byName.set(name, makeContainer(name));
      return byName.get(name);
    },
    async listContainers() {
      return running;
    },
  };
}

function makeFetch(handler) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { input, path: url.pathname, method: init.method ?? 'GET', body, init };
    calls.push(call);
    if (url.pathname === '/v1/docs') return response(200);
    return handler?.(call) ?? response(200);
  };
  return { fetch, calls };
}

function makeProvider(options = {}) {
  const docker = options.docker ?? makeDocker();
  const fetchState = makeFetch(options.fetchHandler);
  const controller = new mod.AioSandboxContainerController({
    docker,
    fetch: fetchState.fetch,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
    delay: async () => undefined,
  });
  const provider = new mod.AioSandboxProvider({
    controller,
    fetch: fetchState.fetch,
    hooks: options.hooks,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  return { provider, controller, docker, fetchState };
}

function isDeliveryCommand(command) {
  return [
    'git status --porcelain',
    'git add -A',
    '/tmp/cap-commit-msg',
    'commit -F',
    'git rev-parse HEAD',
    'push --force-with-lease',
  ].some((needle) => command.includes(needle));
}

await test('provisions AIO containers through provider hooks and descriptors', async () => {
  const events = [];
  const { provider, docker, fetchState } = makeProvider({
    hooks: {
      provisionLookup: {
        getRuntimeId: async () => 'codex',
        getTaskPrompt: async () => 'fix the task',
      },
      runtimePreflight: async (context) => {
        events.push(['preflight', context.runtimeId, context.workspaceDir]);
        return {
          status: 'passed',
          checkedAt: '2026-01-02T03:04:05.000Z',
          runtimeId: String(context.runtimeId),
        };
      },
      promptAuthInjection: async (context) => {
        events.push(['prompt-auth', context.prompt, context.containerName]);
      },
      runtimeSetup: async (context) => {
        events.push(['setup', context.runtimeId]);
      },
      skillPreinstall: async (context) => {
        events.push(['skills', context.providerSandboxId]);
      },
    },
  });

  assert.equal(provider.getSandboxMode(), 'danger-full-access');
  const connection = await provider.provision(
    provisionContext('task-1', {
      url: 'https://example.invalid/repo.git',
    }),
  );

  assert.equal(docker.created[0].options.name, 'cap-aio-task-1');
  assert.equal(docker.created[0].options.HostConfig.NetworkMode, 'cap-private');
  assert.deepEqual(connection, {
    taskId: 'task-1',
    baseUrl: 'http://cap-aio-task-1:8080',
    wsUrl: 'ws://cap-aio-task-1:8080/v1/shell/ws',
  });
  const providerSandboxId = docker.created[0].container.id;
  const replayedConnection = await provider.provision(provisionContext('task-1'));
  assert.deepEqual(replayedConnection, connection);
  assert.notEqual(replayedConnection, connection);
  assert.deepEqual(events, [
    ['preflight', 'codex', '/home/gem/workspace'],
    ['prompt-auth', 'fix the task', 'cap-aio-task-1'],
    ['setup', 'codex'],
    ['skills', providerSandboxId],
    ['preflight', 'codex', '/home/gem/workspace'],
    ['prompt-auth', 'fix the task', 'cap-aio-task-1'],
    ['setup', 'codex'],
    ['skills', providerSandboxId],
  ]);
  assert.ok(
    fetchState.calls.some(
      (call) =>
        call.path === '/v1/shell/exec' &&
        call.body.command.includes('git clone') &&
        call.body.command.includes('clone --recursive'),
    ),
  );

  const selected = await provider.getSelectedSandboxRun('task-1');
  assert.equal(selected.providerId, 'aio-local');
  assert.equal(selected.providerSandboxId, providerSandboxId);
  assert.equal(selected.terminal.protocol, 'aio-json-v1');
  assert.equal(selected.command.protocol, 'aio-http-exec-v1');
  assert.equal(selected.command.workingDirectory, '/home/gem/workspace');
  assert.equal(selected.workspace.mode, 'git');
  assert.equal(selected.retention.mode, 'stop-retain');
  assert.deepEqual(selected.preflight, {
    status: 'passed',
    checkedAt: '2026-01-02T03:04:05.000Z',
    runtimeId: 'codex',
  });

  const descriptor = mod.defineAioSandboxProvider({
    controller: new mod.AioSandboxContainerController({
      docker: makeDocker(),
      env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
    }),
  });
  assert.equal(descriptor.id, 'aio-local');
  assert.equal(descriptor.location, 'local');
  assert.ok(descriptor.capabilities.includes('lifecycle.readopt'));
});

await test('reports composite phases before deferred AIO runtime setup settles', async () => {
  const preflightEntered = deferred();
  const releasePreflight = deferred();
  const progress = [];
  const { provider } = makeProvider({
    hooks: {
      runtimePreflight: async () => {
        preflightEntered.resolve();
        await releasePreflight.promise;
        return {
          status: 'passed',
          checkedAt: '2026-07-16T00:00:00.000Z',
          runtimeId: 'codex',
        };
      },
    },
  });
  let settled = false;
  const provisioning = provider
    .provision({
      ...provisionContext('task-composite-progress'),
      onProvisioningProgress: (event) => progress.push(event.stage),
    })
    .finally(() => {
      settled = true;
    });

  await preflightEntered.promise;
  assert.deepEqual(progress, ['readiness', 'runtime_setup']);
  assert.equal(settled, false);
  releasePreflight.resolve();
  await provisioning;
});

await test('redacts ordinary AIO preflight and runtime setup diagnostics', async () => {
  const preflightCanary = 'aio-preflight-private-canary';
  const preflight = makeProvider({
    hooks: {
      runtimePreflight: async () => {
        throw new Error(preflightCanary);
      },
    },
  }).provider;
  await assert.rejects(
    () => preflight.provision(provisionContext('task-preflight-canary')),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes(preflightCanary),
  );

  const setupCanary = 'aio-runtime-setup-private-canary';
  const runtimeSetup = makeProvider({
    hooks: {
      runtimeSetup: async () => {
        throw new Error(setupCanary);
      },
    },
  }).provider;
  await assert.rejects(
    () => runtimeSetup.provision(provisionContext('task-setup-canary')),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes(setupCanary),
  );
});

await test('AIO observes definitive create outcomes before start and leaves ambiguous 408 entered', async () => {
  const successful = makeProvider();
  const observations = [];
  await successful.provider.provision({
    ...provisionContext('task-create-observed'),
    onSandboxCreateObserved: async (observation) => {
      observations.push(observation);
      assert.equal(
        successful.docker.created[0].container.calls.some(
          ([kind]) => kind === 'start',
        ),
        false,
      );
    },
  });
  assert.deepEqual(observations, [
    {
      kind: 'created',
      providerSandboxId: successful.docker.created[0].container.id,
    },
  ]);

  const rejectedDocker = makeDocker();
  rejectedDocker.createContainer = async () => {
    throw Object.assign(new Error('invalid create request'), { statusCode: 422 });
  };
  const rejected = makeProvider({ docker: rejectedDocker });
  const rejectedObservations = [];
  await assert.rejects(
    () =>
      rejected.provider.provision({
        ...provisionContext('task-create-rejected'),
        onSandboxCreateObserved: async (observation) => {
          rejectedObservations.push(observation);
        },
      }),
    /invalid create request/u,
  );
  assert.deepEqual(rejectedObservations, [{ kind: 'not-created' }]);

  const ambiguousDocker = makeDocker();
  ambiguousDocker.createContainer = async () => {
    throw Object.assign(new Error('create response timed out'), { statusCode: 408 });
  };
  const ambiguous = makeProvider({ docker: ambiguousDocker });
  const ambiguousObservations = [];
  await assert.rejects(
    () =>
      ambiguous.provider.provision({
        ...provisionContext('task-create-ambiguous'),
        onSandboxCreateObserved: async (observation) => {
          ambiguousObservations.push(observation);
        },
      }),
    /create response timed out/u,
  );
  assert.deepEqual(ambiguousObservations, []);
});

await test('a new provider replays every setup stage after create-before-register crash', async () => {
  const docker = makeDocker();
  const controllerOptions = {
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  };
  const crashedController = new mod.AioSandboxContainerController(
    controllerOptions,
  );
  const created = await crashedController.createAndStart(
    'task-provider-replay',
    undefined,
    undefined,
    {
      ownership: ownership('expired-owner', 'provider-replay-resource'),
    },
  );
  assert.equal(
    crashedController.getConnection('task-provider-replay'),
    undefined,
    'the simulated crash happens before provider connection registration',
  );

  const events = [];
  const replayFetch = async (input) => {
    const path = new URL(input).pathname;
    if (path === '/v1/docs') events.push('readiness');
    return response(200);
  };
  const replayController = new mod.AioSandboxContainerController({
    ...controllerOptions,
    fetch: replayFetch,
    delay: async () => {
      assert.fail('first readiness response must not require a fixed delay');
    },
  });
  const replayProvider = new mod.AioSandboxProvider({
    controller: replayController,
    fetch: replayFetch,
    hooks: {
      provisionLookup: {
        getTaskPrompt: async () => {
          events.push('prompt');
          return 'recover the task';
        },
      },
      runtimePreflight: async () => {
        events.push('preflight');
        return {
          status: 'passed',
          checkedAt: '2026-07-16T00:00:00.000Z',
          runtimeId: 'codex',
        };
      },
      promptAuthInjection: async (context) => {
        assert.equal(context.prompt, 'recover the task');
        events.push('prompt-auth');
      },
      runtimeSetup: async () => {
        events.push('runtime-setup');
      },
      workspaceMaterialization: async (context) => {
        assert.equal(context.plan.resolvedBranch, 'master');
        events.push('workspace');
        return { status: 'succeeded', stage: 'complete' };
      },
      skillPreinstall: async () => {
        events.push('skills');
      },
    },
  });

  const connection = await replayProvider.provision({
    ...provisionContext('task-provider-replay'),
    ownership: ownership('recovered-owner', 'provider-replay-resource'),
    workspace: {
      repositoryUrl: 'https://code.example.test/org/repo.git',
      callerBranch: null,
      resolvedBranch: 'master',
      deadlineMs: 900_000,
    },
  });

  assert.equal(docker.created.length, 1, 'replay must reuse one physical sandbox');
  assert.equal(replayController.getConnection('task-provider-replay'), connection);
  assert.deepEqual(created.container.calls, [['start'], ['inspect']]);
  assert.deepEqual(events, [
    'readiness',
    'preflight',
    'prompt',
    'prompt-auth',
    'runtime-setup',
    'workspace',
    'skills',
  ]);
});

await test('tracked AIO replay fresh-inspects the exact generation and re-confirms initialization', async () => {
  const initialization = [];
  const { provider, docker, fetchState } = makeProvider({
    hooks: {
      runtimePreflight: async () => {
        initialization.push('preflight');
        return {
          status: 'passed',
          checkedAt: '2026-07-16T00:00:00.000Z',
          runtimeId: 'codex',
        };
      },
      runtimeSetup: async () => {
        initialization.push('runtime-setup');
      },
    },
  });
  const first = await provider.provision({
    ...provisionContext('task-fast-path-generation'),
    ownership: ownership('owner-a', 'resource-a'),
  });
  const container = docker.created[0].container;
  const callsBeforeReuse = container.calls.length;
  const guardEvents = [];

  const readopted = await provider.provision({
    ...provisionContext('task-fast-path-generation'),
    ownership: ownership('owner-b', 'resource-a'),
    externalBoundaryGuard: async (event) => {
      guardEvents.push([event.action, event.position]);
    },
  });
  assert.deepEqual(readopted, first);
  assert.notEqual(readopted, first);
  assert.equal(container.calls.length, callsBeforeReuse + 1);
  assert.deepEqual(container.calls.at(-1), ['inspect']);
  assert.equal(docker.created.length, 1);
  assert.deepEqual(guardEvents.slice(0, 2), [
    ['environment.resolve', 'before'],
    ['environment.resolve', 'after'],
  ]);
  assert.equal(
    guardEvents.some(
      ([action, position]) =>
        action === 'sandbox.inspect' && position === 'after',
    ),
    true,
  );
  assert.deepEqual(initialization, [
    'preflight',
    'runtime-setup',
    'preflight',
    'runtime-setup',
  ]);
  assert.equal(
    fetchState.calls.filter((call) => call.path === '/v1/docs').length,
    2,
  );

  await container.remove({ force: true });
  const recreated = await provider.provision({
    ...provisionContext('task-fast-path-generation'),
    ownership: ownership('owner-c', 'resource-a'),
  });
  assert.notEqual(recreated, first);
  assert.equal(docker.created.length, 2);
  const recreatedContainer = docker.created[1].container;
  assert.equal(recreatedContainer.isRunning(), true);
  await recreatedContainer.remove({ force: true });

  const replacementController = new mod.AioSandboxContainerController({
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  });
  await replacementController.createAndStart(
    'task-fast-path-generation',
    undefined,
    undefined,
    { ownership: ownership('replacement-owner', 'resource-b') },
  );
  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext('task-fast-path-generation'),
        ownership: ownership('owner-d', 'resource-a'),
      }),
    /resource generation does not match ownership fence/u,
  );
  assert.equal(docker.created.length, 3);
});

await test('a new provider stops a sandbox with no local run or controller map', async () => {
  const docker = makeDocker();
  const controllerOptions = {
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  };
  const creator = new mod.AioSandboxContainerController(controllerOptions);
  const created = await creator.createAndStart(
    'task-provider-stop',
    undefined,
    undefined,
    { ownership: ownership('creator-owner', 'provider-stop-resource') },
  );
  const events = [];
  const stoppingController = new mod.AioSandboxContainerController(
    controllerOptions,
  );
  const stoppingProvider = new mod.AioSandboxProvider({
    controller: stoppingController,
    hooks: {
      provisionLookup: {
        getRuntimeId: async (taskId) => {
          events.push(['runtime-lookup', taskId]);
          return 'codex';
        },
      },
      preStopTrim: async (context) => {
        events.push([
          'pre-stop',
          context.taskId,
          context.runtimeId,
          context.baseUrl,
        ]);
      },
    },
  });

  await stoppingProvider.teardownSandbox('task-provider-stop', {
    ownership: ownership('recovered-owner', 'provider-stop-resource'),
    cleanupAuthorization: cleanupAuthorization(
      'task-provider-stop',
      'recovered-owner',
      'provider-stop-resource',
    ),
    providerSandboxId: created.providerSandboxId,
    disposition: 'terminal-retain',
  });

  assert.deepEqual(events, [
    ['runtime-lookup', 'task-provider-stop'],
    [
      'pre-stop',
      'task-provider-stop',
      'codex',
      'http://cap-aio-task-provider-stop:8080',
    ],
  ]);
  assert.deepEqual(created.container.calls.slice(-2), [
    ['stop', { t: 0 }],
    ['inspect'],
  ]);
  assert.equal(created.container.isRemoved(), false);
});

await test('AIO disposition removes only the superseded immutable id and retains an exact terminal replacement', async () => {
  const docker = makeDocker();
  const controllerOptions = {
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  };
  const firstController = new mod.AioSandboxContainerController(controllerOptions);
  const first = await firstController.createAndStart(
    'task-disposition',
    undefined,
    undefined,
    { ownership: ownership('owner-r1', 'resource-r1') },
  );
  // Simulate the deterministic name being released/rebound while the old
  // immutable id remains addressable to a durable cleanup worker.
  docker.byName.delete('cap-aio-task-disposition');
  const replacementController = new mod.AioSandboxContainerController(controllerOptions);
  const replacement = await replacementController.createAndStart(
    'task-disposition',
    undefined,
    undefined,
    { ownership: ownership('owner-r2', 'resource-r2') },
  );
  assert.notEqual(first.providerSandboxId, replacement.providerSandboxId);

  const cleanupProvider = new mod.AioSandboxProvider({
    controller: new mod.AioSandboxContainerController(controllerOptions),
  });
  await cleanupProvider.teardownSandbox('task-disposition', {
    cleanupAuthorization: cleanupAuthorization(
      'task-disposition',
      'owner-r1',
      'resource-r1',
    ),
    providerSandboxId: first.providerSandboxId,
    disposition: 'superseded-remove',
  });
  assert.equal(first.container.isRemoved(), true);
  assert.equal(replacement.container.isRemoved(), false);
  assert.equal(replacement.container.isRunning(), true);

  await cleanupProvider.teardownSandbox('task-disposition', {
    cleanupAuthorization: cleanupAuthorization(
      'task-disposition',
      'owner-r2',
      'resource-r2',
    ),
    providerSandboxId: replacement.providerSandboxId,
    disposition: 'terminal-retain',
  });
  assert.equal(replacement.container.isRemoved(), false);
  assert.equal(replacement.container.isRunning(), false);
});

await test('AIO exact-id cleanup survives a missing deterministic name mapping', async () => {
  const docker = makeDocker();
  const controllerOptions = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };
  const created = await new mod.AioSandboxContainerController(
    controllerOptions,
  ).createAndStart(
    'task-id-only',
    undefined,
    undefined,
    { ownership: ownership('owner-id-only', 'resource-id-only') },
  );
  docker.byName.delete('cap-aio-task-id-only');
  const provider = new mod.AioSandboxProvider({
    controller: new mod.AioSandboxContainerController(controllerOptions),
  });
  await provider.teardownSandbox('task-id-only', {
    cleanupAuthorization: cleanupAuthorization(
      'task-id-only',
      'owner-id-only',
      'resource-id-only',
    ),
    providerSandboxId: created.providerSandboxId,
    disposition: 'superseded-remove',
  });
  assert.equal(created.container.isRemoved(), true);
});

await test('AIO terminal cleanup recovers a lost replacement id only for the same generation', async () => {
  const docker = makeDocker();
  const controllerOptions = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };
  const first = await new mod.AioSandboxContainerController(
    controllerOptions,
  ).createAndStart(
    'task-lost-replacement-id',
    undefined,
    undefined,
    { ownership: ownership('owner-old', 'shared-resource') },
  );
  await first.container.remove({ force: true });
  const replacement = await new mod.AioSandboxContainerController(
    controllerOptions,
  ).createAndStart(
    'task-lost-replacement-id',
    undefined,
    undefined,
    { ownership: ownership('owner-new', 'shared-resource') },
  );
  const provider = new mod.AioSandboxProvider({
    controller: new mod.AioSandboxContainerController(controllerOptions),
  });
  await provider.teardownSandbox('task-lost-replacement-id', {
    cleanupAuthorization: cleanupAuthorization(
      'task-lost-replacement-id',
      'owner-new',
      'shared-resource',
    ),
    providerSandboxId: first.providerSandboxId,
    disposition: 'terminal-retain',
  });
  assert.equal(replacement.container.isRunning(), false);
  assert.equal(replacement.container.isRemoved(), false);

  const stale = await new mod.AioSandboxContainerController(
    controllerOptions,
  ).createAndStart(
    'task-lost-replacement-stale',
    undefined,
    undefined,
    { ownership: ownership('owner-r1', 'resource-r1') },
  );
  await stale.container.remove({ force: true });
  const newer = await new mod.AioSandboxContainerController(
    controllerOptions,
  ).createAndStart(
    'task-lost-replacement-stale',
    undefined,
    undefined,
    { ownership: ownership('owner-r2', 'resource-r2') },
  );
  await assert.rejects(
    () =>
      provider.teardownSandbox('task-lost-replacement-stale', {
        cleanupAuthorization: cleanupAuthorization(
          'task-lost-replacement-stale',
          'owner-r1-recovered',
          'resource-r1',
        ),
        providerSandboxId: stale.providerSandboxId,
        disposition: 'terminal-retain',
      }),
    /resource generation does not match ownership fence/u,
  );
  assert.equal(newer.container.isRunning(), true);
});

await test('failed provisioning cleanup is owner-authorized and settles only after exact stop', async () => {
  const deniedEvents = [];
  const denied = makeProvider({
    hooks: {
      runtimePreflight: async () => ({
        status: 'failed',
        checkedAt: '2026-07-16T00:00:00.000Z',
        runtimeId: 'codex',
        error: 'preflight rejected',
      }),
    },
  });
  await assert.rejects(
    () =>
      denied.provider.provision({
        ...provisionContext('task-cleanup-denied'),
        ownership: ownership('denied-owner', 'denied-resource'),
        beforeSandboxCleanup: async () => {
          deniedEvents.push('before-cleanup');
          return null;
        },
        afterSandboxCleanup: async () => {
          deniedEvents.push('after-cleanup');
        },
      }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes('preflight rejected'),
  );
  assert.deepEqual(deniedEvents, ['before-cleanup']);
  const deniedContainer = denied.docker.created[0].container;
  assert.equal(
    deniedContainer.calls.some(([kind]) => kind === 'stop' || kind === 'remove'),
    false,
  );

  const authorizedEvents = [];
  const authorized = makeProvider({
    hooks: {
      runtimePreflight: async () => ({
        status: 'failed',
        checkedAt: '2026-07-16T00:00:00.000Z',
        runtimeId: 'codex',
        error: 'preflight rejected',
      }),
    },
  });
  await assert.rejects(
    () =>
      authorized.provider.provision({
        ...provisionContext('task-cleanup-authorized'),
        ownership: ownership('authorized-owner', 'authorized-resource'),
        beforeSandboxCleanup: async () => {
          authorizedEvents.push('before-cleanup');
          return cleanupAuthorization(
            'task-cleanup-authorized',
            'current-owner',
            'authorized-resource',
          );
        },
        afterSandboxCleanup: async (authorization) => {
          assert.deepEqual(
            authorization,
            cleanupAuthorization(
              'task-cleanup-authorized',
              'current-owner',
              'authorized-resource',
            ),
          );
          const container = authorized.docker.created[0].container;
          assert.equal(
            container.calls.filter(([kind]) => kind === 'remove').length,
            1,
          );
          assert.equal(container.isRemoved(), true);
          assert.equal(container.calls.at(-1)[0], 'inspect');
          authorizedEvents.push('after-cleanup');
        },
      }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes('preflight rejected'),
  );
  assert.deepEqual(authorizedEvents, ['before-cleanup', 'after-cleanup']);
});

await test('deferred AIO create survives an early absent cleanup and the late worker removes its live generation', async () => {
  const taskId = 'task-deferred-create-cleanup';
  const docker = makeDocker();
  const createEntered = deferred();
  const releaseCreate = deferred();
  const originalCreate = docker.createContainer.bind(docker);
  docker.createContainer = async (options) => {
    createEntered.resolve();
    await releaseCreate.promise;
    return originalCreate(options);
  };
  const authorization = cleanupAuthorization(
    taskId,
    'current-owner',
    'deferred-resource',
  );
  const lateFailure = new Error('lease lost after deferred AIO start');
  const events = [];
  const creating = makeProvider({ docker });
  const earlyCleanup = makeProvider({ docker });
  const provisioning = creating.provider.provision({
    ...provisionContext(taskId),
    ownership: ownership('creating-owner', 'deferred-resource'),
    externalBoundaryGuard: async (event) => {
      if (event.action === 'sandbox.start' && event.position === 'after') {
        throw lateFailure;
      }
    },
    beforeSandboxCleanup: async () => {
      events.push('late-cleanup-authorized');
      return authorization;
    },
    afterSandboxCleanup: async (received) => {
      assert.equal(received, authorization);
      events.push('late-cleanup-completed');
    },
  });

  await createEntered.promise;
  assert.deepEqual(
    await earlyCleanup.provider.teardownSandbox(taskId, {
      cleanupAuthorization: authorization,
    }),
    { kind: 'already-absent' },
  );
  assert.deepEqual(events, []);

  releaseCreate.resolve();
  await assert.rejects(provisioning, (error) => error === lateFailure);
  const container = docker.created[0].container;
  assert.equal(container.isRunning(), false);
  assert.equal(container.isRemoved(), true);
  assert.equal(
    container.calls.filter(([kind]) => kind === 'remove').length,
    1,
  );
  assert.deepEqual(events, [
    'late-cleanup-authorized',
    'late-cleanup-completed',
  ]);
});

await test('uncertain AIO create followed by 404 keeps cleanup settlement pending', async () => {
  const taskId = 'task-uncertain-create-cleanup';
  const docker = makeDocker();
  const createEntered = deferred();
  const releaseCreate = deferred();
  const lostResponse = new Error('Docker create response was lost');
  docker.createContainer = async () => {
    createEntered.resolve();
    await releaseCreate.promise;
    throw lostResponse;
  };
  const authorization = cleanupAuthorization(
    taskId,
    'current-owner',
    'uncertain-resource',
  );
  const events = [];
  const { provider } = makeProvider({ docker });
  const provisioning = provider.provision({
    ...provisionContext(taskId),
    ownership: ownership('creating-owner', 'uncertain-resource'),
    externalBoundaryGuard: async () => undefined,
    beforeSandboxCleanup: async () => {
      events.push('cleanup-authorized');
      return authorization;
    },
    afterSandboxCleanup: async () => {
      events.push('must-not-complete');
    },
  });

  await createEntered.promise;
  releaseCreate.resolve();
  await assert.rejects(provisioning, (error) => error === lostResponse);
  assert.deepEqual(events, ['cleanup-authorized']);
});

await test('every AIO provision boundary fails closed before or after lease loss or stop without reaching ready', async () => {
  const actions = [
    'environment.resolve',
    'sandbox.inspect',
    'sandbox.create',
    'sandbox.start',
    'sandbox.readiness',
    'runtime.preflight',
    'prompt.lookup',
    'prompt-auth.inject',
    'runtime.setup',
    'workspace.materialize',
    'skills.preinstall',
  ];

  for (const targetAction of actions) {
    for (const targetPosition of ['before', 'after']) {
      for (const failureKind of ['lease-loss', 'stop']) {
      const boundaryReached = deferred();
      const releaseBoundary = deferred();
      const cancellation = new AbortController();
      const failure = new Error(
        `${failureKind}:${targetPosition}:${targetAction}`,
      );
      const events = [];
      const workspaceBoundary = async () => {};
      const progress = async () => {};
      const { provider } = makeProvider({
        hooks: {
          provisionLookup: {
            getResolvedEnvironment: async () => null,
            getTaskPrompt: async () => 'guard the task',
          },
          runtimePreflight: async () => ({
            status: 'passed',
            checkedAt: '2026-07-16T00:00:00.000Z',
            runtimeId: 'codex',
          }),
          promptAuthInjection: async () => {},
          runtimeSetup: async () => {},
          workspaceMaterialization: async (context) => {
            assert.equal(context.beforeBoundary, workspaceBoundary);
            assert.equal(context.onProgress, progress);
            return { status: 'succeeded', stage: 'complete' };
          },
          skillPreinstall: async () => {},
        },
      });
      let reachedReady = false;
      const provisioning = provider
        .provision({
          ...provisionContext(
            `task-boundary-${failureKind}-${targetPosition}-${targetAction}`,
          ),
          ownership: ownership(
            `owner-${failureKind}-${targetPosition}-${targetAction}`,
            `resource-${failureKind}-${targetPosition}-${targetAction}`,
          ),
          cancellationSignal: cancellation.signal,
          externalBoundaryGuard: async (event) => {
            events.push([event.action, event.position]);
            if (
              event.action === targetAction &&
              event.position === targetPosition
            ) {
              boundaryReached.resolve();
              await releaseBoundary.promise;
              if (failureKind === 'lease-loss') throw failure;
            }
          },
          beforeSandboxCleanup: async () => null,
          workspace: {
            repositoryUrl: 'https://code.example.test/org/repo.git',
            callerBranch: null,
            resolvedBranch: 'master',
            deadlineMs: 900_000,
          },
          onWorkspaceProgress: progress,
          beforeWorkspaceBoundary: workspaceBoundary,
        })
        .then((connection) => {
          reachedReady = true;
          return connection;
        });

      await boundaryReached.promise;
      assert.equal(
        reachedReady,
        false,
        `${failureKind} at ${targetAction} must block before ready`,
      );
      if (failureKind === 'stop') cancellation.abort(failure);
      releaseBoundary.resolve();
      await assert.rejects(provisioning, (error) => error === failure);
      assert.equal(reachedReady, false);
      const targetIndex = events.findIndex(
        ([action, position]) =>
          action === targetAction && position === targetPosition,
      );
      assert.notEqual(targetIndex, -1);
      if (targetPosition === 'before') {
        assert.equal(
          events
            .slice(targetIndex + 1)
            .some(
              ([action, position]) =>
                action === targetAction && position === 'after',
            ),
          false,
          `${failureKind} before ${targetAction} must prevent the action`,
        );
      }
      assert.equal(
        events
          .slice(targetIndex + 1)
          .some(([, position]) => position === 'before'),
        false,
        `${failureKind} at ${targetAction} must not enter a later action`,
      );
      }
    }
  }
});

await test('guarded command boundaries stop before fetch or after one fetch without fixed sleeps', async () => {
  for (const targetPosition of ['before', 'after']) {
    for (const failureKind of ['lease-loss', 'stop']) {
      const boundaryReached = deferred();
      const releaseBoundary = deferred();
      const cancellation = new AbortController();
      const failure = new Error(
        `${failureKind}:${targetPosition}:command.execute`,
      );
      let fetchCalls = 0;
      const executor = mod.createAioHttpCommandExecutor({
        baseUrl: 'http://sandbox.test',
        taskId: `task-command-${failureKind}-${targetPosition}`,
        signal: cancellation.signal,
        externalBoundaryGuard: async (event) => {
          if (event.position !== targetPosition) return;
          boundaryReached.resolve();
          await releaseBoundary.promise;
          if (failureKind === 'lease-loss') throw failure;
        },
        fetch: async () => {
          fetchCalls += 1;
          return response(200, {
            data: { exit_code: 0, output: 'guarded command' },
          });
        },
      });

      const executing = executor.exec({ command: 'echo guarded' });
      await boundaryReached.promise;
      if (failureKind === 'stop') cancellation.abort(failure);
      releaseBoundary.resolve();
      await assert.rejects(executing, (error) => error === failure);
      assert.equal(fetchCalls, targetPosition === 'before' ? 0 : 1);
    }
  }
});

await test('canonical workspace keeps generic, stage, and progress boundaries isolated', async () => {
  const externalEvents = [];
  const workspaceEvents = [];
  const progressEvents = [];
  const { provider, fetchState } = makeProvider({
    hooks: {
      runtimePreflight: async () => ({
        status: 'passed',
        checkedAt: '2026-07-16T00:00:00.000Z',
        runtimeId: 'codex',
      }),
      workspaceMaterialization: async (context) => {
        await context.onProgress?.({
          status: 'started',
          stage: 'workspace_transfer',
        });
        await context.beforeBoundary?.({
          stage: 'workspace_transfer',
          position: 'before',
        });
        const result = await context.stageExecutor.execute({
          stage: 'workspace_transfer',
          request: { command: 'git fetch origin master' },
          signal: new AbortController().signal,
          remainingTimeoutMs: 1_000,
        });
        assert.equal(result.exitCode, 0);
        await context.beforeBoundary?.({
          stage: 'workspace_transfer',
          position: 'after',
        });
        await context.onProgress?.({
          status: 'succeeded',
          stage: 'workspace_transfer',
        });
        return { status: 'succeeded', stage: 'complete' };
      },
    },
  });

  await provider.provision({
    ...provisionContext('task-workspace-boundary-isolation'),
    externalBoundaryGuard: async (event) => {
      externalEvents.push([event.action, event.position]);
    },
    workspace: {
      repositoryUrl: 'https://code.example.test/org/repo.git',
      callerBranch: null,
      resolvedBranch: 'master',
      deadlineMs: 900_000,
    },
    beforeWorkspaceBoundary: async (event) => {
      workspaceEvents.push([event.stage, event.position]);
    },
    onWorkspaceProgress: async (event) => {
      progressEvents.push([event.stage, event.status]);
    },
  });

  assert.deepEqual(
    externalEvents.filter(([action]) => action === 'workspace.materialize'),
    [
      ['workspace.materialize', 'before'],
      ['workspace.materialize', 'after'],
    ],
  );
  assert.equal(
    externalEvents.some(([action]) => action === 'command.execute'),
    false,
  );
  assert.deepEqual(workspaceEvents, [
    ['workspace_transfer', 'before'],
    ['workspace_transfer', 'after'],
  ]);
  assert.deepEqual(progressEvents, [
    ['workspace_transfer', 'started'],
    ['workspace_transfer', 'succeeded'],
  ]);
  assert.equal(
    fetchState.calls.filter((call) => call.path === '/v1/shell/exec').length,
    1,
  );
});

await test('guarded AIO command execution fences fetch and carries provider cancellation', async () => {
  const events = [];
  const cancellation = new AbortController();
  let fetchSignal;
  const executor = mod.createAioHttpCommandExecutor({
    baseUrl: 'http://sandbox.test',
    taskId: 'task-command-boundary',
    signal: cancellation.signal,
    externalBoundaryGuard: async (event) => {
      events.push([event.action, event.position]);
    },
    fetch: async (_input, init) => {
      fetchSignal = init.signal;
      return response(200, {
        data: { exit_code: 0, output: 'guarded command' },
      });
    },
  });

  const result = await executor.exec({ command: 'echo guarded' });

  assert.equal(result.output, 'guarded command');
  assert.equal(fetchSignal, cancellation.signal);
  assert.deepEqual(events, [
    ['command.execute', 'before'],
    ['command.execute', 'after'],
  ]);
});

await test('outer hook guards expose lease loss swallowed by degrading command hooks', async () => {
  for (const hookName of [
    'promptAuthInjection',
    'runtimeSetup',
    'skillPreinstall',
  ]) {
    const leaseFailure = new Error(`lease lost in ${hookName}`);
    let guardFailed = false;
    let workspaceReached = false;
    let ready = false;
    const degradingHook = async (context) => {
      try {
        await context.executor.exec({ command: `prepare ${hookName}` });
      } catch {
        // Deliberately emulate a best-effort hook that degrades command errors.
      }
    };
    const hooks = {
      provisionLookup: { getTaskPrompt: async () => 'guard the task' },
      runtimePreflight: async () => ({
        status: 'passed',
        checkedAt: '2026-07-16T00:00:00.000Z',
        runtimeId: 'codex',
      }),
      promptAuthInjection: async () => {},
      runtimeSetup: async () => {},
      workspaceMaterialization: async () => {
        workspaceReached = true;
        return { status: 'succeeded', stage: 'complete' };
      },
      skillPreinstall: async () => {},
      [hookName]: degradingHook,
    };
    const { provider } = makeProvider({ hooks });
    const provisioning = provider
      .provision({
        ...provisionContext(`task-degrading-${hookName}`),
        ownership: ownership(
          `owner-degrading-${hookName}`,
          `resource-degrading-${hookName}`,
        ),
        externalBoundaryGuard: async (event) => {
          if (
            event.action === 'command.execute' &&
            event.position === 'after' &&
            !guardFailed
          ) {
            guardFailed = true;
            throw leaseFailure;
          }
        },
        beforeSandboxCleanup: async () => null,
        workspace: {
          repositoryUrl: 'https://code.example.test/org/repo.git',
          callerBranch: null,
          resolvedBranch: 'master',
          deadlineMs: 900_000,
        },
      })
      .then((connection) => {
        ready = true;
        return connection;
      });

    await assert.rejects(provisioning, (error) => error === leaseFailure);
    assert.equal(ready, false);
    if (hookName !== 'skillPreinstall') {
      assert.equal(workspaceReached, false);
    }
  }
});

await test('direct AIO provisioning rejects unsupported resolved resources before create', async () => {
  const { provider, docker } = makeProvider();
  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext('task-resource-gate'),
        resources: { diskSizeGb: 8 },
      }),
    /missing capabilities: resource\.disk-size-gb/,
  );
  assert.equal(docker.created.length, 0);
});

await test('cleanup callbacks without an ownership fence fail before create', async () => {
  const { provider, docker } = makeProvider();
  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext('task-cleanup-callback-gate'),
        beforeSandboxCleanup: async () =>
          cleanupAuthorization(
            'task-cleanup-callback-gate',
            'owner',
            'resource',
          ),
      }),
    /cleanup callbacks require an ownership fence/,
  );
  assert.equal(docker.created.length, 0);
});

await test('direct AIO provisioning rejects canonical credentials before create', async () => {
  const canary = 'CAP_AIO_UNMIGRATED_CREDENTIAL_CANARY';
  const { provider, docker } = makeProvider();
  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext('task-credential-gate'),
        workspace: {
          repositoryUrl: 'https://code.example.test/org/repo.git',
          callerBranch: null,
          resolvedBranch: 'master',
          deadlineMs: 900_000,
          credential: core.createExactHostGitCredential(
            'https://code.example.test/org/repo.git',
            `Authorization: Basic ${canary}`,
          ),
        },
      }),
    (err) =>
      err?.code === 'sandbox_provider_configuration_error' &&
      /staged workspace hook/.test(err.message) &&
      !err.message.includes(canary),
  );
  assert.equal(docker.created.length, 0);
});

await test('canonical workspace takes precedence over a simultaneous legacy clone spec', async () => {
  const materializations = [];
  const legacyCalls = [];
  const { provider, fetchState } = makeProvider({
    hooks: {
      workspaceMaterialization: async (context) => {
        materializations.push(context);
        return { status: 'succeeded', stage: 'complete' };
      },
      cloneSpecToGitCloneSpec: async () => {
        legacyCalls.push('legacy-converter');
        throw new Error('legacy clone conversion must not run');
      },
    },
  });

  await provider.provision({
    ...provisionContext('task-canonical-precedence', {
      url: 'https://legacy.example.test/org/repo.git',
    }),
    workspace: {
      repositoryUrl: 'https://code.example.test/org/repo.git',
      callerBranch: null,
      resolvedBranch: 'master',
      deadlineMs: 900_000,
    },
  });

  assert.equal(materializations.length, 1);
  assert.equal(materializations[0].plan.resolvedBranch, 'master');
  assert.deepEqual(legacyCalls, []);
  assert.equal(
    fetchState.calls.some(
      (call) =>
        call.path === '/v1/shell/exec' &&
        call.body?.command?.includes('git clone'),
    ),
    false,
  );
});

await test('uses lookup clone specs, delivers workspace changes, and scrubs failures', async () => {
  const commands = [];
  const execCalls = [];
  const { provider } = makeProvider({
    hooks: {
      provisionLookup: {
        getCloneSpec: () => ({ url: 'https://example.invalid/repo.git' }),
      },
    },
    fetchHandler(call) {
      if (call.path !== '/v1/shell/exec') return response(200);
      execCalls.push(call);
      commands.push(call.body.command);
      if (call.body.command.includes('git status')) {
        return response(200, { data: { exit_code: 0, output: ' M file.txt\n' } });
      }
      if (call.body.command.includes('git rev-parse HEAD')) {
        return response(200, { data: { exit_code: 0, output: 'abc123\n' } });
      }
      if (call.body.command.includes(' push --force-with-lease ')) {
        return response(200, { data: { exit_code: 1, output: 'Bearer abc.def' } });
      }
      return response(200);
    },
  });

  await provider.provision(provisionContext('task-2'));
  assert.ok(
    commands.some((command) =>
      command.includes("git clone --recursive -- 'https://example.invalid/repo.git'"),
    ),
  );

  const delivered = await provider.deliverWorkspaceChanges('task-2', {
    authHeader: 'Authorization: Basic xyz',
    branch: 'cap/result',
    commitMessage: "don't break quoting",
  });
  assert.deepEqual(delivered, {
    hadChanges: false,
    commitSha: null,
    error: 'Legacy raw-header Git delivery is disabled',
  });
  const deliveryCalls = execCalls.filter((call) =>
    isDeliveryCommand(call.body.command),
  );
  assert.equal(deliveryCalls.length, 0, 'legacy delivery fails before exec');
});

await test('credentialed delivery timeout preserves a concurrently replaced AIO run', async () => {
  const taskId = 'task-delivery-fence';
  const exactOwnership = ownership(
    'owner:delivery-fence',
    'resource:delivery-fence',
  );
  const authorization = cleanupAuthorization(
    taskId,
    exactOwnership.ownerGeneration,
    exactOwnership.resourceGeneration,
  );
  const events = [];
  const { provider, docker } = makeProvider({
    hooks: {
      workspaceDelivery: async (workspace) => {
        const cancellation = new AbortController();
        cancellation.abort();
        const stage = await workspace.stageExecutor.execute({
          stage: 'delivery_push',
          request: { command: 'git push', timeoutMs: 5_000 },
          signal: cancellation.signal,
          remainingTimeoutMs: 5_000,
        });
        assert.equal(stage.timedOut, true);
        return {
          hadChanges: true,
          commitSha: 'delivery-fence-sha',
          error: 'delivery_timeout',
        };
      },
    },
  });
  await provider.provision({
    ...provisionContext(taskId, null),
    workspace: null,
    ownership: exactOwnership,
    beforeSandboxCleanup: async () => authorization,
    afterSandboxCleanup: async () => undefined,
  });

  const result = await provider.deliverWorkspaceChanges(taskId, {
    branch: `cap/${taskId}`,
    commitMessage: 'delivery fence',
    credential: core.createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      'Authorization: Basic delivery-canary',
    ),
    ownership: exactOwnership,
    beforeSandboxCleanup: async () => {
      events.push('cleanup-authorized');
      return authorization;
    },
    afterSandboxCleanup: async (received) => {
      assert.equal(received, authorization);
      events.push('cleanup-completed');
      const previous = provider.runs.get(taskId);
      provider.runs.set(taskId, {
        ...previous,
        providerSandboxId: 'replacement-container-id',
        ownership: ownership(
          'owner:delivery-replacement',
          'resource:delivery-replacement',
        ),
      });
    },
  });

  assert.deepEqual(result, {
    hadChanges: true,
    commitSha: 'delivery-fence-sha',
    error: 'delivery_timeout',
  });
  assert.deepEqual(events, ['cleanup-authorized', 'cleanup-completed']);
  assert.equal(docker.created[0].container.isRemoved(), true);
  assert.equal(await provider.sandboxExists(taskId), false);
  assert.deepEqual(await provider.listReadoptable(), []);
  assert.equal(
    (await provider.getSelectedSandboxRun(taskId)).providerSandboxId,
    'replacement-container-id',
  );
});

await test('legacy AIO delivery fencing completes durable cleanup and forgets only its removed run', async () => {
  const taskId = 'task-legacy-delivery-fence';
  const authorization = {
    kind: 'legacy',
    taskId,
    providerId: 'aio-local',
  };
  let cleanupCompleted = false;
  const { provider, docker } = makeProvider({
    hooks: {
      workspaceDelivery: async (workspace) => {
        const cancellation = new AbortController();
        cancellation.abort();
        await workspace.stageExecutor.execute({
          stage: 'delivery_push',
          request: { command: 'git push', timeoutMs: 1_000 },
          signal: cancellation.signal,
          remainingTimeoutMs: 1_000,
        });
        return {
          hadChanges: false,
          commitSha: null,
          error: 'delivery_timeout',
        };
      },
    },
  });
  await provider.provision({
    ...provisionContext(taskId, null),
    workspace: null,
  });
  assert.equal(provider.runs.has(taskId), true);

  const result = await provider.deliverWorkspaceChanges(taskId, {
    branch: `cap/${taskId}`,
    commitMessage: 'legacy delivery fence',
    credential: core.createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      'Authorization: Basic legacy-delivery-canary',
    ),
    beforeSandboxCleanup: async () => authorization,
    afterSandboxCleanup: async (received) => {
      assert.equal(received, authorization);
      cleanupCompleted = true;
    },
  });
  assert.equal(result.error, 'delivery_timeout');
  assert.equal(cleanupCompleted, true);
  assert.equal(docker.created[0].container.isRemoved(), true);
  assert.equal(provider.runs.has(taskId), false);
});

for (const createState of ['idle', 'entered']) {
  await test(`authorized already-absent AIO cleanup delegates ${createState} completion to the owner CAS`, async () => {
    const taskId = `task-already-absent-${createState}`;
    const exactOwnership = ownership(
      `owner:already-absent-${createState}`,
      `resource:already-absent-${createState}`,
    );
    const authorization = cleanupAuthorization(
      taskId,
      exactOwnership.ownerGeneration,
      exactOwnership.resourceGeneration,
    );
    let beforeCalls = 0;
    let afterCalls = 0;
    const adapter = mod.createAioWorkspaceSecurityAdapter({
      taskId,
      providerId: 'aio-local',
      ownership: exactOwnership,
      controller: {
        async removeSandboxAndConfirm() {
          return { kind: 'already-absent' };
        },
      },
      executor: {
        async exec() {
          assert.fail('pre-aborted stage must not execute');
        },
      },
      beforeSandboxCleanup: async () => {
        beforeCalls += 1;
        return authorization;
      },
      afterSandboxCleanup: async (received) => {
        assert.equal(received, authorization);
        afterCalls += 1;
        if (createState === 'entered') {
          throw new Error('entered create keeps cleanup deleting');
        }
      },
    });
    const cancellation = new AbortController();
    cancellation.abort();
    const execution = adapter.stageExecutor.execute({
      stage: 'delivery_push',
      request: { command: 'git push', timeoutMs: 1_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 1_000,
    });
    if (createState === 'idle') {
      assert.equal((await execution).timedOut, true);
      assert.equal(adapter.wasSandboxFenced(), true);
    } else {
      await assert.rejects(execution, /entered create keeps cleanup deleting/u);
      assert.equal(adapter.wasSandboxFenced(), false);
    }
    assert.equal(beforeCalls, 1);
    assert.equal(afterCalls, 1);
  });
}

await test('AIO adapter single-flights concurrent stage and secret fencing', async () => {
  const taskId = 'task-aio-delivery-single-flight';
  const exactOwnership = ownership(
    'owner:aio-single-flight',
    'resource:aio-single-flight',
  );
  const authorization = cleanupAuthorization(
    taskId,
    exactOwnership.ownerGeneration,
    exactOwnership.resourceGeneration,
  );
  const removalEntered = deferred();
  const releaseRemoval = deferred();
  const secretDeleteAttempted = deferred();
  let beforeCalls = 0;
  let removeCalls = 0;
  let afterCalls = 0;
  const adapter = mod.createAioWorkspaceSecurityAdapter({
    taskId,
    providerId: 'aio-local',
    ownership: exactOwnership,
    createSecretId: () => 'single-flight',
    controller: {
      async putPrivateArchive() {},
      async isSandboxConfirmedAbsent() {
        return false;
      },
      async removeSandboxAndConfirm() {
        removeCalls += 1;
        removalEntered.resolve();
        await releaseRemoval.promise;
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec(request) {
        if (request.command.includes('rm -f --')) {
          secretDeleteAttempted.resolve();
          return {
            exitCode: 1,
            output: '',
            stdout: '',
            stderr: '',
            timedOut: false,
          };
        }
        return {
          exitCode: 0,
          output: '',
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
    },
    beforeSandboxCleanup: async () => {
      beforeCalls += 1;
      return authorization;
    },
    afterSandboxCleanup: async () => {
      afterCalls += 1;
    },
  });
  const handle = await adapter.secretFilePort.writeSecretFile({
    kind: 'git-http-credential',
    credential: core.createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      'Authorization: Basic single-flight-canary',
    ),
  });
  const cancellation = new AbortController();
  cancellation.abort();
  const stage = adapter.stageExecutor.execute({
    stage: 'delivery_push',
    request: { command: 'git push', timeoutMs: 1_000 },
    signal: cancellation.signal,
    remainingTimeoutMs: 1_000,
  });
  await removalEntered.promise;
  const secret = adapter.secretFilePort.deleteSecretFile(handle);
  await secretDeleteAttempted.promise;
  releaseRemoval.resolve();
  const [stageOutcome, secretOutcome] = await Promise.allSettled([
    stage,
    secret,
  ]);
  assert.equal(stageOutcome.status, 'fulfilled');
  assert.equal(stageOutcome.value.timedOut, true);
  assert.equal(secretOutcome.status, 'rejected');
  assert.equal(beforeCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(afterCalls, 1);
  assert.equal(adapter.wasSandboxFenced(), true);
});

await test('AIO adapter retains a rejected single-flight fence without repeating cleanup', async () => {
  const taskId = 'task-aio-rejected-single-flight';
  const exactOwnership = ownership(
    'owner:aio-rejected-single-flight',
    'resource:aio-rejected-single-flight',
  );
  const authorization = cleanupAuthorization(
    taskId,
    exactOwnership.ownerGeneration,
    exactOwnership.resourceGeneration,
  );
  const removalEntered = deferred();
  const releaseRemoval = deferred();
  let beforeCalls = 0;
  let removeCalls = 0;
  const adapter = mod.createAioWorkspaceSecurityAdapter({
    taskId,
    providerId: 'aio-local',
    ownership: exactOwnership,
    controller: {
      async removeSandboxAndConfirm() {
        removeCalls += 1;
        removalEntered.resolve();
        await releaseRemoval.promise;
        throw new Error('remove response remained uncertain');
      },
    },
    executor: {
      async exec() {
        assert.fail('pre-aborted stage must not execute');
      },
    },
    beforeSandboxCleanup: async () => {
      beforeCalls += 1;
      return authorization;
    },
    afterSandboxCleanup: async () => {
      assert.fail('unconfirmed removal must not complete cleanup');
    },
  });
  const cancellation = new AbortController();
  cancellation.abort();
  const execute = () =>
    adapter.stageExecutor.execute({
      stage: 'delivery_push',
      request: { command: 'git push', timeoutMs: 1_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 1_000,
    });
  const first = execute();
  const second = execute();
  await removalEntered.promise;
  releaseRemoval.resolve();
  const outcomes = await Promise.allSettled([first, second]);
  assert(outcomes.every((outcome) => outcome.status === 'rejected'));
  await assert.rejects(execute(), /fencing could not be confirmed/u);
  assert.equal(beforeCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(adapter.wasSandboxFenced(), false);
});

await test('readopts running sandboxes and runs pre-stop hooks on teardown', async () => {
  const docker = makeDocker();
  const readoptedContainer = makeContainer('cap-aio-task-3', {
    Id: 'container-3',
    Config: {
      Image: 'cap-aio-sandbox:0.1.0',
      Env: ['TASK_ID=task-3'],
      Labels: {},
    },
    HostConfig: { NetworkMode: 'cap-private' },
    State: { Running: true },
  });
  docker.byName.set('cap-aio-task-3', readoptedContainer);
  docker.byName.set('container-3', readoptedContainer);
  docker.setRunning([{ Id: 'container-3', Names: ['/cap-aio-task-3'] }]);
  const trimCalls = [];
  const { provider } = makeProvider({
    docker,
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'codex',
      },
      preStopTrim: async (context) => {
        trimCalls.push([context.taskId, context.runtimeId, context.baseUrl]);
      },
      transcriptRead: async (context) => ({
        format: 'codex-jsonl',
        jsonl: `task=${context.taskId}`,
      }),
    },
    fetchHandler(call) {
      if (call.body?.command?.includes('tmux has-session')) {
        return response(200, { data: { exit_code: 0, output: '' } });
      }
      return response(200);
    },
  });

  assert.deepEqual(await provider.listReadoptable(), ['task-3']);
  assert.deepEqual(
    await provider.reconcileSandboxInventory({
      protectedTaskIds: ['task-3'],
      canReap: () => true,
    }),
    { inspected: 1, reaped: 0 },
  );
  assert.equal(
    readoptedContainer.calls.some(([kind]) => kind === 'remove'),
    false,
  );
  const connection = await provider.reattach('task-3');
  assert.equal(connection.baseUrl, 'http://cap-aio-task-3:8080');
  const selected = await provider.getSelectedSandboxRun('task-3');
  assert.equal(selected.providerSandboxId, 'container-3');
  assert.equal(selected.preflight.status, 'skipped');
  assert.equal(selected.preflight.runtimeId, 'codex');
  assert.deepEqual(await provider.readRolloutFromContainer('task-3'), {
    format: 'codex-jsonl',
    jsonl: 'task=task-3',
  });

  await provider.teardownSandbox('task-3');
  assert.deepEqual(trimCalls, [
    ['task-3', 'codex', 'http://cap-aio-task-3:8080'],
  ]);
  assert.deepEqual(docker.byName.get('cap-aio-task-3').calls.slice(-2), [
    ['stop', { t: 0 }],
    ['inspect'],
  ]);
});

await test('surfaces command executor HTTP failures and release/remove helpers', async () => {
  const docker = makeDocker();
  const { provider, controller } = makeProvider({
    docker,
    fetchHandler() {
      return response(503, { data: { exit_code: 1, output: 'down' } });
    },
  });

  const executor = provider.createCommandExecutor('http://cap-aio-task-4:8080');
  assert.deepEqual(await executor.exec({ command: 'echo ok' }), {
    exitCode: Number.NaN,
    output: '/v1/shell/exec responded 503',
    stdout: '',
    stderr: '/v1/shell/exec responded 503',
    timedOut: false,
  });

  docker.byName.set(
    'cap-aio-task-4',
    makeContainer('cap-aio-task-4', { State: { Running: true } }),
  );
  assert.equal(await provider.sandboxExists('task-4'), true);
  await provider.removeSandbox('task-4');
  assert.deepEqual(docker.byName.get('cap-aio-task-4').calls.at(-1), [
    'remove',
    { force: true },
  ]);
  controller.registerConnection({
    taskId: 'task-4',
    baseUrl: 'http://cap-aio-task-4:8080',
    wsUrl: 'ws://cap-aio-task-4:8080/v1/shell/ws',
  });
  provider.releaseHandles();
  assert.equal(controller.getConnection('task-4'), undefined);
});

await test('fails closed on preflight and clone materialization errors', async () => {
  const preflightDocker = makeDocker();
  const preflight = makeProvider({
    docker: preflightDocker,
    hooks: {
      runtimePreflight: async () => ({
        status: 'failed',
        checkedAt: '2026-01-02T03:04:05.000Z',
        runtimeId: 'codex',
        error: 'node is missing',
      }),
    },
  }).provider;
  await assert.rejects(
    () => preflight.provision(provisionContext('task-preflight-fail')),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes('node is missing'),
  );
  assert.deepEqual(
    preflightDocker.byName.get('cap-aio-task-preflight-fail').calls.slice(-2),
    [['stop', { t: 0 }], ['inspect']],
  );

  const runtimeLookupDocker = makeDocker();
  let legacyRuntimeLookupCalled = false;
  const runtimeLookup = makeProvider({
    docker: runtimeLookupDocker,
    hooks: {
      provisionLookup: {
        getRuntimeId: async () => {
          legacyRuntimeLookupCalled = true;
          throw new Error('runtime lookup unavailable');
        },
      },
      preStopTrim: async () => {
        throw new Error('pre-stop trim should not run for failed provision cleanup');
      },
    },
  }).provider;
  await runtimeLookup.provision(provisionContext('task-runtime-lookup-fail'));
  assert.equal(legacyRuntimeLookupCalled, false);

  const cloneFailDocker = makeDocker();
  const cloneTrimCalls = [];
  const cloneFail = makeProvider({
    docker: cloneFailDocker,
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'codex',
      },
      runtimeSetup: async () => undefined,
      preStopTrim: async (context) => {
        cloneTrimCalls.push([context.taskId, context.runtimeId, context.baseUrl]);
      },
    },
    fetchHandler(call) {
      if (call.body?.command?.includes('clone --recursive')) {
        return response(200, {
          data: {
            exit_code: 1,
            output: 'https://user:secret@example.invalid/repo.git failed',
          },
        });
      }
      return response(200);
    },
  }).provider;
  await assert.rejects(
    () =>
      cloneFail.provision(
        provisionContext('task-clone-fail', {
          url: 'https://example.invalid/repo.git',
        }),
      ),
    /AIO git materialization failed: https:\/\/\*\*\*:\*\*\*@example.invalid/,
  );
  assert.deepEqual(cloneTrimCalls, [
    ['task-clone-fail', 'codex', 'http://cap-aio-task-clone-fail:8080'],
  ]);
  assert.deepEqual(
    cloneFailDocker.byName.get('cap-aio-task-clone-fail').calls.slice(-2),
    [['stop', { t: 0 }], ['inspect']],
  );
});

await test('defines docker-backed descriptors and null readoption paths', async () => {
  const docker = makeDocker();
  const descriptor = mod.defineAioSandboxProviderFromDocker({
    id: 'docker-aio',
    docker,
    priority: 77,
    capabilities: ['terminal.websocket'],
    logger: { debug() {}, log() {}, warn() {} },
  });
  assert.equal(descriptor.id, 'docker-aio');
  assert.equal(descriptor.priority, 77);
  assert.deepEqual(descriptor.capabilities, ['terminal.websocket']);
  assert.equal(descriptor.provider.getSandboxMode(), 'danger-full-access');

  const defaultDockerDescriptor = mod.defineAioSandboxProviderFromDocker({
    id: 'default-docker-aio',
  });
  assert.equal(defaultDockerDescriptor.id, 'default-docker-aio');

  const { provider } = makeProvider({
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'fallback-runtime',
      },
    },
  });
  assert.equal(await provider.reattach('task-missing'), null);
  assert.equal(await provider.readRolloutFromContainer('task-missing', 'explicit'), null);
  await provider.teardownSandbox('task-untracked');

  const transcriptProvider = makeProvider({
    hooks: {
      transcriptRead: async (context) => ({
        format: 'codex-jsonl',
        jsonl: `runtime=${context.runtimeId ?? 'none'}`,
      }),
    },
  }).provider;
  assert.deepEqual(await transcriptProvider.readRolloutFromContainer('task-no-run'), {
    format: 'codex-jsonl',
    jsonl: 'runtime=none',
  });
});

await test('failed exact AIO reattach clears only the matching stale provider run', async () => {
  const taskId = 'task-failed-exact-reattach';
  const staleOwnership = ownership('owner:stale', 'resource:stale');
  const target = {
    providerSandboxId: 'container:stale',
    ownership: staleOwnership,
  };
  const first = makeProvider();
  first.provider.runs.set(taskId, {
    taskId,
    providerSandboxId: target.providerSandboxId,
    ownership: staleOwnership,
    connection: {
      taskId,
      baseUrl: 'http://stale',
      wsUrl: 'ws://stale',
    },
  });
  first.controller.reattach = async () => null;
  assert.equal(await first.provider.reattach(taskId, target), null);
  assert.equal(first.provider.runs.has(taskId), false);

  const concurrent = makeProvider();
  const entered = deferred();
  const release = deferred();
  const staleRun = {
    taskId,
    providerSandboxId: target.providerSandboxId,
    ownership: staleOwnership,
    connection: {
      taskId,
      baseUrl: 'http://stale',
      wsUrl: 'ws://stale',
    },
  };
  const replacementRun = {
    taskId,
    providerSandboxId: 'container:replacement',
    ownership: ownership('owner:replacement', 'resource:replacement'),
    connection: {
      taskId,
      baseUrl: 'http://replacement',
      wsUrl: 'ws://replacement',
    },
  };
  concurrent.provider.runs.set(taskId, staleRun);
  concurrent.controller.reattach = async () => {
    entered.resolve();
    await release.promise;
    return null;
  };
  const reattaching = concurrent.provider.reattach(taskId, target);
  await entered.promise;
  concurrent.provider.runs.set(taskId, replacementRun);
  release.resolve();
  assert.equal(await reattaching, null);
  assert.equal(concurrent.provider.runs.get(taskId), replacementRun);
});

await test('covers workspace success, validation, and degradation paths', async () => {
  const commands = [];
  const { provider } = makeProvider({
    hooks: {
      cloneSpecToGitCloneSpec: async (cloneSpec) =>
        cloneSpec && typeof cloneSpec === 'object' && 'repo' in cloneSpec
          ? { url: cloneSpec.repo }
          : null,
    },
    fetchHandler(call) {
      if (call.path !== '/v1/shell/exec') return response(200);
      commands.push(call.body.command);
      if (call.body.command.includes('git status')) {
        return response(200, { data: { exit_code: 0, output: ' M file.txt\n' } });
      }
      if (call.body.command.includes('base64 -d')) {
        return response(200);
      }
      if (call.body.command.includes('git commit')) {
        return response(200);
      }
      if (call.body.command.includes('git rev-parse HEAD')) {
        return response(200, { data: { exit_code: 0, output: 'def456\n' } });
      }
      if (call.body.command.includes('push --force-with-lease')) {
        return response(200);
      }
      return response(200);
    },
  });

  await provider.provision(
    provisionContext('task-workspace-success', {
      repo: 'https://example.invalid/repo.git',
    }),
  );
  assert.ok(
    commands.some((command) =>
      command.includes("git clone --recursive -- 'https://example.invalid/repo.git'"),
    ),
  );

  assert.deepEqual(
    await provider.deliverWorkspaceChanges('task-workspace-success', {
      authHeader: 'Authorization: Basic xyz',
      branch: 'cap/success',
      commitMessage: 'ship it',
    }),
    {
      hadChanges: false,
      commitSha: null,
      error: 'Legacy raw-header Git delivery is disabled',
    },
  );

  const invalid = makeProvider().provider;
  await assert.rejects(
    () => invalid.provision(provisionContext('task-invalid-clone', {})),
    /requires a clone spec with a url/,
  );

  const defaultNowFetch = makeFetch(() => response(200));
  const defaultNowProvider = new mod.AioSandboxProvider({
    controller: new mod.AioSandboxContainerController({
      docker: makeDocker(),
      env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
      fetch: defaultNowFetch.fetch,
      delay: async () => undefined,
    }),
    fetch: defaultNowFetch.fetch,
  });
  await defaultNowProvider.provision(provisionContext('task-default-now'));
  assert.equal(
    (await defaultNowProvider.getSelectedSandboxRun('task-default-now')).preflight.status,
    'skipped',
  );
  defaultNowProvider.runs.delete('task-default-now');
  await defaultNowProvider.teardownSandbox('task-default-now');

  const fallbackSelected = await defaultNowProvider.getSelectedSandboxRun('task-never-registered');
  assert.equal(fallbackSelected.connection.baseUrl, 'http://cap-aio-task-never-registered:8080');
  assert.equal(
    fallbackSelected.providerSandboxId,
    undefined,
    'a logical task connection id must not be exposed as a physical Docker id',
  );

  const fallbackTrimCalls = [];
  const fallbackTrim = makeProvider({
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'resolved-after-run-delete',
      },
      preStopTrim: (context) => {
        fallbackTrimCalls.push(context.runtimeId);
      },
    },
  }).provider;
  await fallbackTrim.provision(provisionContext('task-trim-fallback'));
  fallbackTrim.runs.delete('task-trim-fallback');
  await fallbackTrim.teardownSandbox('task-trim-fallback');
  assert.deepEqual(fallbackTrimCalls, ['resolved-after-run-delete']);

  const failedWithoutError = makeProvider({
    hooks: {
      runtimePreflight: async () => ({
        status: 'failed',
        checkedAt: '2026-01-02T03:04:05.000Z',
      }),
    },
  }).provider;
  await assert.rejects(
    () =>
      failedWithoutError.provision(
        provisionContext('task-preflight-default-error'),
      ),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes('task-preflight-default-error'),
  );

  const cloneSkip = makeProvider({
    hooks: {
      provisionLookup: {
        getCloneSpec: () => null,
      },
    },
  }).provider;
  await cloneSkip.provision(provisionContext('task-clone-skip'));

  const rootWorkspace = makeProvider({
    fetchHandler() {
      return response(200);
    },
  }).provider;
  rootWorkspace.workspaceDir = 'workspace';
  await rootWorkspace.provision(
    provisionContext('task-root-workspace', {
      url: 'https://example.invalid/repo.git',
    }),
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
