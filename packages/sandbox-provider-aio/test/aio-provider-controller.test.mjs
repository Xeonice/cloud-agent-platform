import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);
const { tar } = await import('./test-tar-helpers.mjs');

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

function makeContainer(name = 'container', inspection = null) {
  const calls = [];
  const archives = new Map();
  let inspectThrows = false;
  let inspectError = null;
  let getArchiveThrows = false;
  let startThrows = false;
  let startResponseLost = false;
  let stopThrows = false;
  let removeThrows = false;
  let running = inspection?.State?.Running === true;
  let removed = false;
  return {
    id: inspection?.Id ?? name,
    name,
    calls,
    archives,
    setInspectThrows(value) {
      inspectThrows = value;
    },
    setInspectError(value) {
      inspectError = value;
    },
    setGetArchiveThrows(value) {
      getArchiveThrows = value;
    },
    setStartThrows(value) {
      startThrows = value;
    },
    setStartResponseLost(value) {
      startResponseLost = value;
    },
    setStopThrows(value) {
      stopThrows = value;
    },
    setRemoveThrows(value) {
      removeThrows = value;
    },
    async start() {
      calls.push(['start']);
      if (startThrows) throw new Error('start failed');
      running = true;
      if (startResponseLost) throw new Error('start response lost');
    },
    async stop(options) {
      calls.push(['stop', options]);
      if (stopThrows) throw new Error('stop failed');
      running = false;
    },
    async remove(options) {
      calls.push(['remove', options]);
      if (removeThrows) throw new Error('remove failed');
      removed = true;
    },
    async inspect() {
      calls.push(['inspect']);
      if (inspectError) throw inspectError;
      if (inspectThrows || removed || inspection === null) {
        throw Object.assign(new Error('missing'), { statusCode: 404 });
      }
      return {
        Id: inspection.Id ?? name,
        ...inspection,
        State: { ...(inspection.State ?? {}), Running: running },
      };
    },
    async getArchive(options) {
      calls.push(['getArchive', options]);
      if (getArchiveThrows) throw new Error('no archive');
      const value = archives.get(options.path);
      if (value instanceof Error) throw value;
      if (value === 'bad-stream') {
        return new Readable({
          read() {
            this.destroy(new Error('stream failed'));
          },
        });
      }
      return Readable.from([value ?? Buffer.alloc(1024)]);
    },
  };
}

function makeDocker() {
  const created = [];
  const byName = new Map();
  let running = [];
  let listThrows = false;
  return {
    created,
    byName,
    setRunning(value) {
      running = value;
    },
    setListThrows(value) {
      listThrows = value;
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
    getImage(reference) {
      return {
        async inspect() {
          return {
            Id: 'sha256:aio-image-id',
            RepoDigests: reference.includes('repo-digest')
              ? ['registry.example/cap/aio@sha256:repo-digest']
              : [],
          };
        },
      };
    },
    async listContainers(options) {
      if (listThrows) throw new Error('docker down');
      this.lastListOptions = options;
      return running;
    },
  };
}

function makeFetch(routes = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ input, path: url.pathname, method: init.method, body, init });
    const route = routes[`${init.method ?? 'GET'} ${url.pathname}`];
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route({ input, init, body });
    return route ?? response(404, { data: { exit_code: 1, output: 'not found' } });
  };
  return { fetch, calls };
}

await test('creates, starts, registers, and resolves provisioned AIO connections', async () => {
  const docker = makeDocker();
  const logs = [];
  const controller = new mod.AioSandboxContainerController({
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
    logger: { debug: (message) => logs.push(message) },
  });
  const provisioned = await controller.createAndStart('task-1');
  assert.equal(docker.created[0].options.name, 'cap-aio-task-1');
  assert.equal(docker.created[0].options.HostConfig.NetworkMode, 'cap-private');
  assert.deepEqual(provisioned.connection, {
    taskId: 'task-1',
    baseUrl: 'http://cap-aio-task-1:8080',
    wsUrl: 'ws://cap-aio-task-1:8080/v1/shell/ws',
  });
  assert.equal(controller.getConnection('task-1'), undefined);
  controller.registerConnection(provisioned.connection);
  assert.equal(controller.getConnection('task-1'), provisioned.connection);
  assert.equal(controller.resolveBaseUrl('task-1'), 'http://cap-aio-task-1:8080');
  assert.match(logs[0], /provisioned AIO container cap-aio-task-1/);
  assert.equal(controller.resolveBaseUrl('task-missing'), 'http://cap-aio-task-missing:8080');
});

await test('a new controller readopts one deterministic sandbox after create-before-return', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  };
  const first = new mod.AioSandboxContainerController(options);
  const created = await first.createAndStart('task-replay');
  const second = new mod.AioSandboxContainerController(options);
  const readopted = await second.createAndStart('task-replay');

  assert.equal(docker.created.length, 1, 'task id owns one physical container');
  assert.equal(readopted.container, created.container);
  assert.deepEqual(readopted.connection, created.connection);
});

await test('resource generation labels survive owner transfer and fence readoption', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  };
  const first = new mod.AioSandboxContainerController(options);
  const created = await first.createAndStart(
    'task-owned-readopt',
    undefined,
    undefined,
    {
      ownership: ownership('expired-owner', 'stable-resource'),
    },
  );
  assert.equal(
    docker.created[0].options.Labels['cap.resourceGeneration'],
    'stable-resource',
  );

  const recovered = new mod.AioSandboxContainerController(options);
  const readopted = await recovered.createAndStart(
    'task-owned-readopt',
    undefined,
    undefined,
    {
      ownership: ownership('recovered-owner', 'stable-resource'),
    },
  );
  assert.equal(readopted.container, created.container);
  assert.equal(docker.created.length, 1);

  const staleResource = new mod.AioSandboxContainerController(options);
  await assert.rejects(
    () =>
      staleResource.createAndStart(
        'task-owned-readopt',
        undefined,
        undefined,
        {
          ownership: ownership('another-owner', 'different-resource'),
        },
      ),
    /resource generation does not match ownership fence/,
  );
  assert.equal(
    created.container.calls.filter(([kind]) => kind === 'start').length,
    1,
  );
});

await test('guarded readoption confirms a lost start response with a second fenced inspect', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  };
  const creator = new mod.AioSandboxContainerController(options);
  const created = await creator.createAndStart(
    'task-start-confirm',
    undefined,
    undefined,
    { ownership: ownership('owner-a', 'resource-a') },
  );
  await created.container.stop({ t: 0 });
  created.container.setStartResponseLost(true);
  const events = [];
  const recovered = new mod.AioSandboxContainerController(options);

  const readopted = await recovered.createAndStart(
    'task-start-confirm',
    undefined,
    undefined,
    {
      ownership: ownership('owner-b', 'resource-a'),
      externalBoundaryGuard: async (event) => {
        events.push([event.action, event.position]);
      },
    },
  );

  assert.equal(readopted.container, created.container);
  assert.deepEqual(created.container.calls.slice(-3), [
    ['inspect'],
    ['start'],
    ['inspect'],
  ]);
  assert.deepEqual(events, [
    ['sandbox.inspect', 'before'],
    ['sandbox.inspect', 'after'],
    ['sandbox.start', 'before'],
    ['sandbox.start', 'after'],
    ['sandbox.inspect', 'before'],
    ['sandbox.inspect', 'after'],
  ]);
});

await test('owned create start failures defer removal to the authorized provider cleanup', async () => {
  const docker = makeDocker();
  const create = docker.createContainer.bind(docker);
  let container;
  docker.createContainer = async (options) => {
    container = await create(options);
    container.setStartThrows(true);
    return container;
  };
  const controller = new mod.AioSandboxContainerController({
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  });

  await assert.rejects(
    () =>
      controller.createAndStart(
        'task-owned-start-failure',
        undefined,
        undefined,
        {
          ownership: ownership('start-owner', 'start-resource'),
        },
      ),
    /start failed/,
  );
  assert.deepEqual(container.calls, [['start']]);
});

await test('a confirmed deterministic Docker name conflict readopts the raced container', async () => {
  const docker = makeDocker();
  let racedContainer;
  docker.createContainer = async (options) => {
    racedContainer = makeContainer(options.name, {
      Config: { Image: options.Image, Env: options.Env },
      HostConfig: { NetworkMode: options.HostConfig.NetworkMode },
      State: { Running: true },
    });
    docker.byName.set(options.name, racedContainer);
    throw Object.assign(
      new Error(
        `Conflict. The container name "/${options.name}" is already in use by container "raced".`,
      ),
      {
        statusCode: 409,
        json: {
          message:
            `Conflict. The container name "/${options.name}" is already in use ` +
            'by container "raced".',
        },
      },
    );
  };
  const controller = new mod.AioSandboxContainerController({
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  });

  const provisioned = await controller.createAndStart('task-create-race');

  assert.equal(provisioned.container, racedContainer);
  assert.deepEqual(racedContainer.calls, [['inspect']]);
});

await test('a generic Docker 409 never enters deterministic-name readoption', async () => {
  const docker = makeDocker();
  let unrelatedContainer;
  const conflict = Object.assign(new Error('container is paused'), {
    statusCode: 409,
    json: { message: 'container is paused' },
  });
  docker.createContainer = async (options) => {
    unrelatedContainer = makeContainer(options.name, {
      Config: { Image: options.Image, Env: options.Env },
      HostConfig: { NetworkMode: options.HostConfig.NetworkMode },
      State: { Running: true },
    });
    docker.byName.set(options.name, unrelatedContainer);
    throw conflict;
  };
  const controller = new mod.AioSandboxContainerController({
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  });

  await assert.rejects(
    () => controller.createAndStart('task-generic-conflict'),
    (error) => error === conflict,
  );
  assert.deepEqual(
    unrelatedContainer.calls,
    [],
    'generic conflicts must not inspect or adopt the raced name',
  );
});

await test('validates AIO environments with transient container probes and cleanup', async () => {
  const docker = makeDocker();
  const { fetch } = makeFetch({
    'GET /v1/docs': response(200),
    'POST /v1/shell/exec': response(200, {
      data: { exit_code: 0, output: 'node v20' },
    }),
  });
  const controller = new mod.AioSandboxContainerController({
    docker,
    fetch,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
    },
  });

  let diagnosticId = 0;
  const diagnostics = core.createNonPersistingSandboxProvisioningDiagnosticObserver({
    createOperationId: () =>
      `32000000-0000-4000-8000-${String(++diagnosticId).padStart(12, '0')}`,
  });
  const result = await mod.validateAioEnvironment({
    controller,
    diagnostics,
    environment: {
      environmentId: 'env-aio',
      sourceKind: 'aio-docker-image',
      sourceRef: 'cap-aio-custom:1.0.0',
      digest: 'sha256:abc',
    },
    requiredCommands: [{ name: 'node', command: 'node --version' }],
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.resolvedDigest, 'sha256:aio-image-id');
  assert.equal(result.resolvedLocator, 'sha256:aio-image-id');
  assert.deepEqual(
    result.probes.map((probe) => [probe.name, probe.ok]),
    [
      ['create-container', true],
      ['http-ready', true],
      ['node', true],
    ],
  );
  assert.equal(docker.created[0].options.Image, 'sha256:aio-image-id');
  assert.equal(diagnostics.mode, 'non-persisting');
  assert.equal(Object.hasOwn(diagnostics, 'attemptContext'), false);
  assert.equal(
    docker.byName
      .get(docker.created[0].options.name)
      .calls.some(
        (call) =>
          call[0] === 'remove' && call[1]?.force === true,
      ),
    true,
  );
});

await test('default fetch and delay implementations are usable from the controller', async () => {
  const originalFetch = globalThis.fetch;
  let docsAttempts = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(input).pathname;
    if (path === '/v1/docs') {
      docsAttempts += 1;
      return docsAttempts === 1 ? response(503) : response(200);
    }
    return response(200, { data: { exit_code: 0, output: 'global ok' } });
  };
  try {
    const controller = new mod.AioSandboxContainerController({ docker: makeDocker() });
    assert.deepEqual(await controller.runSandboxExec('http://sandbox', 'echo ok'), {
      exitCode: 0,
      output: 'global ok',
    });
    await controller.waitForReadiness({
      baseUrl: 'http://sandbox',
      taskId: 'task-default-delay',
      timeoutMs: 1000,
    });
    assert.equal(docsAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('waitForReadiness succeeds, retries, and reports timeout causes', async () => {
  const docker = makeDocker();
  let attempts = 0;
  const controller = new mod.AioSandboxContainerController({
    docker,
    fetch: async () => {
      attempts += 1;
      return attempts === 1 ? response(503) : response(200);
    },
    delay: async () => undefined,
  });
  await controller.waitForReadiness({
    baseUrl: 'http://sandbox',
    taskId: 'task-ready',
    timeoutMs: 1000,
  });
  assert.equal(attempts, 2);

  const timeout = new mod.AioSandboxContainerController({
    docker,
    fetch: async () => {
      throw 'network down';
    },
    delay: async () => undefined,
  });
  await assert.rejects(
    () =>
      timeout.waitForReadiness({
        baseUrl: 'http://sandbox',
        taskId: 'task-timeout',
        timeoutMs: 0,
      }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'readiness' &&
      !error.message.includes('network down'),
  );

  const originalNow = Date.now;
  try {
    let now = 1000;
    Date.now = () => now;
    const deterministicTimeout = new mod.AioSandboxContainerController({
      docker,
      fetch: async () => {
        throw 'network down';
      },
      delay: async () => {
        now += 2;
      },
    });
    await assert.rejects(
      () =>
        deterministicTimeout.waitForReadiness({
          baseUrl: 'http://sandbox',
          taskId: 'task-timeout',
          timeoutMs: 1,
        }),
      (error) =>
        error?.code === 'sandbox_provisioning_stage_error' &&
        error?.stage === 'readiness' &&
        !error.message.includes('network down'),
    );

    now = 2000;
    const httpTimeout = new mod.AioSandboxContainerController({
      docker,
      fetch: async () => response(503),
      delay: async () => {
        now += 2;
      },
    });
    await assert.rejects(
      () =>
        httpTimeout.waitForReadiness({
          baseUrl: 'http://sandbox',
          taskId: 'task-timeout',
          timeoutMs: 1,
        }),
      (error) =>
        error?.code === 'sandbox_provisioning_stage_error' &&
        error?.stage === 'readiness' &&
        !error.message.includes('/v1/docs'),
    );
  } finally {
    Date.now = originalNow;
  }
});

await test('every readiness fetch is fenced and guard rejection bypasses retry degradation', async () => {
  const docker = makeDocker();
  const events = [];
  let attempts = 0;
  const controller = new mod.AioSandboxContainerController({
    docker,
    fetch: async () => {
      attempts += 1;
      return attempts === 1 ? response(503) : response(200);
    },
    delay: async () => undefined,
  });
  await controller.waitForReadiness({
    baseUrl: 'http://sandbox',
    taskId: 'task-readiness-fenced',
    timeoutMs: 1_000,
    externalBoundaryGuard: async (event) => {
      events.push([event.action, event.position]);
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(events, [
    ['sandbox.readiness', 'before'],
    ['sandbox.readiness', 'after'],
    ['sandbox.readiness', 'before'],
    ['sandbox.readiness', 'after'],
  ]);

  const leaseFailure = new Error('readiness lease lost');
  let rejectedFetches = 0;
  const rejected = new mod.AioSandboxContainerController({
    docker,
    fetch: async () => {
      rejectedFetches += 1;
      throw new Error('ordinary readiness network error');
    },
    delay: async () => {
      assert.fail('guard rejection must bypass readiness retry delay');
    },
  });
  await assert.rejects(
    () =>
      rejected.waitForReadiness({
        baseUrl: 'http://sandbox',
        taskId: 'task-readiness-lease-loss',
        timeoutMs: 1_000,
        externalBoundaryGuard: async (event) => {
          if (event.position === 'after') throw leaseFailure;
        },
      }),
    (error) => error === leaseFailure,
  );
  assert.equal(rejectedFetches, 1);
});

await test('teardown stops retained containers and runs beforeStop with registered or fallback baseUrl', async () => {
  const docker = makeDocker();
  const controller = new mod.AioSandboxContainerController({
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  });
  const first = await controller.createAndStart('task-1');
  controller.registerConnection({
    taskId: 'task-1',
    baseUrl: 'http://custom',
    wsUrl: 'ws://custom',
  });
  const beforeStop = [];
  assert.deepEqual(await controller.teardownSandbox('task-1', {
    beforeStop: async (args) => beforeStop.push(args),
  }), { kind: 'found-and-cleaned' });
  assert.deepEqual(beforeStop, [{ taskId: 'task-1', baseUrl: 'http://custom' }]);
  assert.deepEqual(first.container.calls.slice(-2), [
    ['stop', { t: 0 }],
    ['inspect'],
  ]);
  assert.equal(controller.getConnection('task-1'), undefined);

  const second = await controller.createAndStart('task-2');
  second.container.setStopThrows(true);
  await assert.rejects(
    () =>
      controller.teardownSandbox('task-2', {
        beforeStop: async (args) => beforeStop.push(args),
      }),
    /stop failed/,
  );
  assert.deepEqual(beforeStop.at(-1), {
    taskId: 'task-2',
    baseUrl: 'http://cap-aio-task-2:8080',
  });
  assert.deepEqual(await controller.teardownSandbox('task-missing'), {
    kind: 'already-absent',
  });
});

await test('a fresh controller stops a sandbox created by another replica through its deterministic name', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };
  const creator = new mod.AioSandboxContainerController(options);
  const created = await creator.createAndStart('task-cross-replica-stop');
  const stoppingReplica = new mod.AioSandboxContainerController(options);

  assert.deepEqual(
    await stoppingReplica.teardownSandbox('task-cross-replica-stop'),
    { kind: 'found-and-cleaned' },
  );

  assert.deepEqual(created.container.calls.slice(-3), [
    ['inspect'],
    ['stop', { t: 0 }],
    ['inspect'],
  ]);
});

await test('cross-replica stop and remove reject stale resource generations', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };
  const creator = new mod.AioSandboxContainerController(options);
  const created = await creator.createAndStart(
    'task-owned-cleanup',
    undefined,
    undefined,
    { ownership: ownership('creator-owner', 'cleanup-resource') },
  );
  const staleStopper = new mod.AioSandboxContainerController(options);
  await assert.rejects(
    () =>
      staleStopper.teardownSandbox('task-owned-cleanup', {
        ownership: ownership('stale-owner', 'stale-resource'),
      }),
    /resource generation does not match ownership fence/,
  );
  assert.equal(
    created.container.calls.some(([kind]) => kind === 'stop'),
    false,
  );

  const recoveredStopper = new mod.AioSandboxContainerController(options);
  await recoveredStopper.teardownSandbox('task-owned-cleanup', {
    ownership: ownership('recovered-owner', 'cleanup-resource'),
  });
  assert.equal(
    created.container.calls.filter(([kind]) => kind === 'stop').length,
    1,
  );

  const removeCreator = new mod.AioSandboxContainerController(options);
  const removable = await removeCreator.createAndStart(
    'task-owned-remove',
    undefined,
    undefined,
    { ownership: ownership('creator-owner', 'remove-resource') },
  );
  const staleRemover = new mod.AioSandboxContainerController(options);
  await assert.rejects(
    () =>
      staleRemover.removeSandboxAndConfirm(
        'task-owned-remove',
        ownership('stale-owner', 'stale-resource'),
      ),
    /resource generation does not match ownership fence/,
  );
  assert.equal(
    removable.container.calls.some(([kind]) => kind === 'remove'),
    false,
  );
  const recoveredRemover = new mod.AioSandboxContainerController(options);
  await recoveredRemover.removeSandboxAndConfirm(
    'task-owned-remove',
    ownership('recovered-owner', 'remove-resource'),
  );
  assert.equal(
    removable.container.calls.filter(([kind]) => kind === 'remove').length,
    1,
  );
});

await test('owned teardown ignores a stale local handle and pins the deterministic replacement id', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };
  const staleController = new mod.AioSandboxContainerController(options);
  const oldResource = await staleController.createAndStart(
    'task-owned-aba',
    undefined,
    undefined,
    { ownership: ownership('old-owner', 'old-resource') },
  );
  await oldResource.container.remove({ force: true });

  const replacementController = new mod.AioSandboxContainerController(options);
  const replacement = await replacementController.createAndStart(
    'task-owned-aba',
    undefined,
    undefined,
    { ownership: ownership('new-owner', 'new-resource') },
  );
  await staleController.teardownSandbox('task-owned-aba', {
    ownership: ownership('new-owner', 'new-resource'),
  });

  assert.equal(
    replacement.container.calls.filter(([kind]) => kind === 'stop').length,
    1,
  );
});

await test('removeSandbox and sandboxExists use live maps or deterministic docker names', async () => {
  const docker = makeDocker();
  const controller = new mod.AioSandboxContainerController({
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  });
  const created = await controller.createAndStart('task-live');
  await controller.removeSandbox('task-live');
  assert.deepEqual(created.container.calls.at(-1), ['remove', { force: true }]);

  const fallback = makeContainer('cap-aio-task-fallback', {
    Config: {
      Image: 'cap-aio-sandbox:0.1.0',
      Env: ['TASK_ID=task-fallback'],
    },
    HostConfig: { NetworkMode: 'cap-net' },
    State: { Running: true },
  });
  docker.byName.set('cap-aio-task-fallback', fallback);
  fallback.setRemoveThrows(true);
  await controller.removeSandbox('task-fallback');
  assert.deepEqual(fallback.calls.at(-1), ['remove', { force: true }]);

  assert.equal(await controller.sandboxExists('task-fallback'), true);
  fallback.setInspectThrows(true);
  assert.equal(await controller.sandboxExists('task-fallback'), false);
});

await test('reads the lexicographically newest retained JSONL from docker archives', async () => {
  const docker = makeDocker();
  const controller = new mod.AioSandboxContainerController({
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  });
  const provisioned = await controller.createAndStart('task-transcript');
  provisioned.container.archives.set(
    '/sessions',
    tar([
      { name: 'rollout-2026-01-01.jsonl', content: 'old' },
      { name: 'rollout-2026-01-02.jsonl', content: 'new' },
      { name: 'rollout-2026-01-02.jsonl', content: 'same-name' },
    ]),
  );
  assert.equal(
    await controller.readSingleNewestJsonl(
      'task-transcript',
      '/sessions',
      /rollout-.*\.jsonl$/,
    ),
    'same-name',
  );
  provisioned.container.setGetArchiveThrows(true);
  assert.equal(
    await controller.readSingleNewestJsonl('task-transcript', '/sessions', /rollout/),
    null,
  );

  const fallback = docker.getContainer('cap-aio-task-empty');
  fallback.archives.set('/sessions', tar([{ name: 'skip.txt', content: 'x' }]));
  assert.equal(
    await controller.readSingleNewestJsonl('task-empty', '/sessions', /rollout/),
    null,
  );
  fallback.archives.set('/sessions', 'bad-stream');
  assert.equal(
    await controller.readSingleNewestJsonl('task-empty', '/sessions', /rollout/),
    null,
  );
});

await test('runs sandbox exec commands with parsed AIO responses and non-ok fail-closed codes', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/shell/exec': response(200, { data: { exit_code: '0', stdout: 'ok' } }),
  });
  const controller = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch,
  });
  assert.deepEqual(await controller.runSandboxExec('http://sandbox', 'echo ok'), {
    exitCode: 0,
    output: 'ok',
  });
  assert.deepEqual(calls[0].body, { command: 'echo ok' });

  const failed = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: makeFetch({ 'POST /v1/shell/exec': response(500) }).fetch,
  });
  const parsed = await failed.runSandboxExec('http://sandbox', 'boom');
  assert(Number.isNaN(parsed.exitCode));
  assert.equal(parsed.output, '/v1/shell/exec responded 500');

  const invalidJson = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error('bad json');
      },
    }),
  });
  assert(Number.isNaN((await invalidJson.runSandboxExec('http://sandbox', 'x')).exitCode));
});

await test('best-effort shell exec logs non-ok and thrown transport errors', async () => {
  const warnings = [];
  const nonOk = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: makeFetch({ 'POST /v1/shell/exec': response(503) }).fetch,
    logger: { warn: (message) => warnings.push(message) },
  });
  await nonOk.runShellExecBestEffort({
    baseUrl: 'http://sandbox',
    taskId: 'task-1',
    command: 'trim',
    label: 'trim',
    timeoutMs: 1,
  });
  assert.match(warnings[0], /trim .* HTTP 503/);

  const thrown = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: makeFetch({ 'POST /v1/shell/exec': new Error('down') }).fetch,
    logger: { warn: (message) => warnings.push(message) },
  });
  await thrown.runShellExecBestEffort({
    baseUrl: 'http://sandbox',
    taskId: 'task-2',
    command: 'trim',
  });
  assert.match(warnings[1], /AIO shell exec .* down/);

  const thrownString = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: async () => {
      throw 'string down';
    },
    logger: { warn: (message) => warnings.push(message) },
  });
  await thrownString.runShellExecBestEffort({
    baseUrl: 'http://sandbox',
    taskId: 'task-3',
    command: 'trim',
  });
  assert.match(warnings[2], /string down/);
});

await test('startup readoption inventory is read-only and reattaches only definitively live sessions', async () => {
  const docker = makeDocker();
  const liveContainer = makeContainer('cap-aio-task-live', {
    Id: 'id-live',
    Config: { Env: ['TASK_ID=task-live'], Labels: {} },
    State: { Running: true },
  });
  docker.byName.set('id-live', liveContainer);
  docker.byName.set('cap-aio-task-live', liveContainer);
  docker.setRunning([
    { Id: 'id-live', Names: ['/cap-aio-task-live'] },
    { Id: 'id-dead', Names: ['/cap-aio-task-dead'] },
    { Id: 'id-foreign', Names: ['/foreign'] },
  ]);
  const logs = [];
  const { fetch, calls } = makeFetch({
    'POST /v1/shell/exec': ({ input }) =>
      input.includes('task-live')
        ? response(200, { data: { exit_code: 0, output: '' } })
        : response(200, { data: { exit_code: 1, output: '' } }),
  });
  const controller = new mod.AioSandboxContainerController({
    docker,
    fetch,
    logger: { log: (message) => logs.push(message) },
  });
  assert.deepEqual(await controller.listReadoptable(), ['task-live']);
  assert.deepEqual(await controller.listReadoptable(), ['task-live']);
  assert.equal(calls.length, 2);
  assert.equal(docker.lastListOptions.filters.name[0], 'cap-aio-');
  assert.equal(
    docker.getContainer('id-dead').calls.some(([kind]) => kind === 'remove'),
    false,
  );
  assert.equal(
    docker.getContainer('id-foreign').calls.some(([kind]) => kind === 'remove'),
    false,
  );
  assert.deepEqual(await controller.reattach('task-live'), {
    taskId: 'task-live',
    baseUrl: 'http://cap-aio-task-live:8080',
    wsUrl: 'ws://cap-aio-task-live:8080/v1/shell/ws',
  });
  const custom = {
    taskId: 'task-live',
    baseUrl: 'http://custom-live',
    wsUrl: 'ws://custom-live',
  };
  controller.registerConnection(custom);
  assert.equal(await controller.reattach('task-live'), custom);
  assert.equal(await controller.reattach('task-missing'), null);
  assert.match(logs[0], /found 1 .*\(inventory is read-only/);
});

await test('explicit inventory reconciliation protects unfinished durable work and reaps only unprotected running orphans', async () => {
  const docker = makeDocker();
  const protectedContainer = makeContainer('cap-aio-task-admitting', {
    Id: 'id-admitting',
    Config: { Env: ['TASK_ID=task-admitting'], Labels: {} },
    State: { Running: true },
  });
  const orphanContainer = makeContainer('cap-aio-task-orphan', {
    Id: 'id-orphan',
    Config: { Env: ['TASK_ID=task-orphan'], Labels: {} },
    State: { Running: true },
  });
  const stoppedHistory = makeContainer('cap-aio-task-history', {
    Id: 'id-history',
    Config: { Env: ['TASK_ID=task-history'], Labels: {} },
    State: { Running: false },
  });
  for (const [id, container] of [
    ['id-admitting', protectedContainer],
    ['id-orphan', orphanContainer],
    ['id-history', stoppedHistory],
  ]) {
    docker.byName.set(id, container);
  }
  docker.setRunning([
    { Id: 'id-admitting', Names: ['/cap-aio-task-admitting'] },
    { Id: 'id-orphan', Names: ['/cap-aio-task-orphan'] },
    // The list can race with a terminal stop. The fresh inspect is authoritative.
    { Id: 'id-history', Names: ['/cap-aio-task-history'] },
  ]);
  const controller = new mod.AioSandboxContainerController({ docker });
  const authorizationCandidates = [];

  assert.deepEqual(
    await controller.reconcileSandboxInventory({
      protectedTaskIds: ['task-admitting'],
      canReap: (candidate) => {
        authorizationCandidates.push(candidate);
        return true;
      },
    }),
    {
      inspected: 3,
      reaped: 1,
    },
  );
  assert.equal(
    protectedContainer.calls.some(([kind]) => kind === 'remove'),
    false,
    'pre-agent durable admission sandbox remains protected without a tmux session',
  );
  assert.deepEqual(orphanContainer.calls.filter(([kind]) => kind === 'remove'), [
    ['remove', { force: true }],
  ]);
  assert.equal(
    stoppedHistory.calls.some(([kind]) => kind === 'remove'),
    false,
    'stopped retained history is not removed after a stale running list result',
  );
  assert.deepEqual(authorizationCandidates, [
    { taskId: 'task-orphan', providerSandboxId: 'id-orphan' },
  ]);
});

await test('inventory reconciliation revalidates stale snapshot candidates before removing any sandbox', async () => {
  const docker = makeDocker();
  const newlyOwned = makeContainer('cap-aio-task-new-owner', {
    Id: 'id-new-owner',
    Config: { Env: ['TASK_ID=task-new-owner'], Labels: {} },
    State: { Running: true },
  });
  const orphan = makeContainer('cap-aio-task-orphan-authorized', {
    Id: 'id-orphan-authorized',
    Config: { Env: ['TASK_ID=task-orphan-authorized'], Labels: {} },
    State: { Running: true },
  });
  docker.byName.set('id-new-owner', newlyOwned);
  docker.byName.set('id-orphan-authorized', orphan);
  docker.setRunning([
    { Id: 'id-new-owner', Names: ['/cap-aio-task-new-owner'] },
    { Id: 'id-orphan-authorized', Names: ['/cap-aio-task-orphan-authorized'] },
  ]);
  const activeOwnersOnAnotherReplica = new Set(['task-new-owner']);
  const authorizations = [];
  const controller = new mod.AioSandboxContainerController({ docker });

  assert.deepEqual(
    await controller.reconcileSandboxInventory({
      // This startup snapshot predates the owner acquired on another replica.
      protectedTaskIds: [],
      canReap: (candidate) => {
        assert.equal(
          (candidate.taskId === 'task-new-owner' ? newlyOwned : orphan).calls.some(
            ([kind]) => kind === 'inspect',
          ),
          true,
          'authorization runs only after a fresh physical inspection',
        );
        const allowed = !activeOwnersOnAnotherReplica.has(candidate.taskId);
        authorizations.push([candidate, allowed]);
        return allowed;
      },
    }),
    { inspected: 2, reaped: 1 },
  );
  assert.deepEqual(authorizations, [
    [{ taskId: 'task-new-owner', providerSandboxId: 'id-new-owner' }, false],
    [
      {
        taskId: 'task-orphan-authorized',
        providerSandboxId: 'id-orphan-authorized',
      },
      true,
    ],
  ]);
  assert.equal(newlyOwned.calls.some(([kind]) => kind === 'remove'), false);
  assert.deepEqual(orphan.calls.filter(([kind]) => kind === 'remove'), [
    ['remove', { force: true }],
  ]);
});

await test('inventory reconciliation authorizes the whole batch before removal and fails closed on lookup errors', async () => {
  const docker = makeDocker();
  const authorized = makeContainer('cap-aio-task-authorized-first', {
    Id: 'id-authorized-first',
    Config: { Env: ['TASK_ID=task-authorized-first'], Labels: {} },
    State: { Running: true },
  });
  const indeterminateOwner = makeContainer('cap-aio-task-owner-lookup-down', {
    Id: 'id-owner-lookup-down',
    Config: { Env: ['TASK_ID=task-owner-lookup-down'], Labels: {} },
    State: { Running: true },
  });
  docker.byName.set('id-authorized-first', authorized);
  docker.byName.set('id-owner-lookup-down', indeterminateOwner);
  docker.setRunning([
    { Id: 'id-authorized-first', Names: ['/cap-aio-task-authorized-first'] },
    { Id: 'id-owner-lookup-down', Names: ['/cap-aio-task-owner-lookup-down'] },
  ]);
  const controller = new mod.AioSandboxContainerController({ docker });

  await assert.rejects(
    () =>
      controller.reconcileSandboxInventory({
        protectedTaskIds: [],
        canReap: ({ taskId }) => {
          if (taskId === 'task-owner-lookup-down') {
            throw new Error('durable owner lookup unavailable');
          }
          return true;
        },
      }),
    /durable owner lookup unavailable/,
  );
  assert.equal(authorized.calls.some(([kind]) => kind === 'remove'), false);
  assert.equal(indeterminateOwner.calls.some(([kind]) => kind === 'remove'), false);
});

await test('inventory reconciliation refuses to run without live reaping authorization', async () => {
  const docker = makeDocker();
  const candidate = makeContainer('cap-aio-task-no-authorization', {
    Id: 'id-no-authorization',
    Config: { Env: ['TASK_ID=task-no-authorization'], Labels: {} },
    State: { Running: true },
  });
  docker.byName.set('id-no-authorization', candidate);
  docker.setRunning([
    { Id: 'id-no-authorization', Names: ['/cap-aio-task-no-authorization'] },
  ]);
  const controller = new mod.AioSandboxContainerController({ docker });

  await assert.rejects(
    () => controller.reconcileSandboxInventory({ protectedTaskIds: [] }),
    /requires a canReap authorization callback/,
  );
  assert.equal(candidate.calls.some(([kind]) => kind === 'remove'), false);
});

await test('inventory reconciliation performs no removal when any candidate state is indeterminate', async () => {
  const docker = makeDocker();
  const confirmed = makeContainer('cap-aio-task-confirmed', {
    Id: 'id-confirmed',
    Config: { Env: ['TASK_ID=task-confirmed'], Labels: {} },
    State: { Running: true },
  });
  const indeterminate = makeContainer('cap-aio-task-indeterminate', {
    Id: 'id-indeterminate',
    Config: { Env: ['TASK_ID=task-indeterminate'], Labels: {} },
    State: { Running: true },
  });
  indeterminate.setInspectError(new Error('docker inspect transport down'));
  docker.byName.set('id-confirmed', confirmed);
  docker.byName.set('id-indeterminate', indeterminate);
  docker.setRunning([
    { Id: 'id-confirmed', Names: ['/cap-aio-task-confirmed'] },
    { Id: 'id-indeterminate', Names: ['/cap-aio-task-indeterminate'] },
  ]);
  const controller = new mod.AioSandboxContainerController({ docker });

  await assert.rejects(
    () =>
      controller.reconcileSandboxInventory({
        protectedTaskIds: [],
        canReap: () => assert.fail('authorization must wait for all fresh inspections'),
      }),
    /docker inspect transport down/,
  );
  assert.equal(confirmed.calls.some(([kind]) => kind === 'remove'), false);
  assert.equal(indeterminate.calls.some(([kind]) => kind === 'remove'), false);
});

await test('targeted readoption pins the persisted immutable id across same-name replacement', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
  };
  const creator = new mod.AioSandboxContainerController(options);
  const firstOwnership = ownership('owner-r1', 'resource-r1');
  const first = await creator.createAndStart(
    'task-readoption-target',
    undefined,
    undefined,
    { ownership: firstOwnership },
  );
  creator.releaseHandles();
  assert.deepEqual(
    await creator.reattach('task-readoption-target', {
      providerSandboxId: first.providerSandboxId,
      ownership: firstOwnership,
    }),
    first.connection,
  );

  creator.releaseHandles();
  await first.container.remove({ force: true });
  const replacement = await new mod.AioSandboxContainerController(
    options,
  ).createAndStart(
    'task-readoption-target',
    undefined,
    undefined,
    { ownership: ownership('owner-r2', 'resource-r2') },
  );
  assert.equal(
    await creator.reattach('task-readoption-target', {
      providerSandboxId: first.providerSandboxId,
      ownership: firstOwnership,
    }),
    null,
  );
  await assert.rejects(
    () =>
      creator.reattach('task-readoption-target', {
        providerSandboxId: replacement.providerSandboxId,
        ownership: firstOwnership,
      }),
    /resource generation does not match ownership fence/u,
  );
});

await test('readoption distinguishes definitive dead sessions from indeterminate inventory and probe failures', async () => {
  const noCandidates = makeDocker();
  const controller = new mod.AioSandboxContainerController({ docker: noCandidates });
  assert.deepEqual(await controller.listReadoptable(), []);

  const dockerDown = makeDocker();
  dockerDown.setListThrows(true);
  const warnings = [];
  const down = new mod.AioSandboxContainerController({
    docker: dockerDown,
    logger: { warn: (message) => warnings.push(message) },
  });
  await assert.rejects(() => down.listReadoptable(), /docker down/);
  assert.match(warnings[0], /docker down/);

  const stringDown = makeDocker();
  stringDown.listContainers = async () => {
    throw 'string down';
  };
  const stringWarnings = [];
  await assert.rejects(
    () => new mod.AioSandboxContainerController({
      docker: stringDown,
      logger: { warn: (message) => stringWarnings.push(message) },
    }).listReadoptable(),
    (error) => error === 'string down',
  );
  assert.match(stringWarnings[0], /string down/);

  const probeDownDocker = makeDocker();
  probeDownDocker.setRunning([{ Id: 'id-live', Names: ['/cap-aio-task-live'] }]);
  const probeDown = new mod.AioSandboxContainerController({
    docker: probeDownDocker,
    fetch: makeFetch({ 'POST /v1/shell/exec': response(500) }).fetch,
  });
  await assert.rejects(
    () => probeDown.listReadoptable(),
    /liveness probe .* HTTP 500/,
  );
  assert.equal(
    probeDownDocker.getContainer('id-live').calls.some(([kind]) => kind === 'remove'),
    false,
  );

  const throwProbeDocker = makeDocker();
  throwProbeDocker.setRunning([{ Id: 'id-live', Names: ['/cap-aio-task-live'] }]);
  const throwProbe = new mod.AioSandboxContainerController({
    docker: throwProbeDocker,
    fetch: makeFetch({ 'POST /v1/shell/exec': new Error('fetch down') }).fetch,
  });
  await assert.rejects(() => throwProbe.listReadoptable(), /fetch down/);
  assert.equal(
    throwProbeDocker.getContainer('id-live').calls.some(([kind]) => kind === 'remove'),
    false,
  );
  throwProbe.releaseHandles();
  assert.deepEqual(await throwProbe.listReadoptable(), []);
});

await test('utility exports delegate to shared exec parsing and scrubbing helpers', async () => {
  assert.deepEqual(mod.parseAioExecResult({ data: { exit_code: 7, output: 'x' } }), {
    exitCode: 7,
    output: 'x',
  });
  assert.equal(
    mod.scrubAioExecSecrets('https://user:pass@example.test Authorization: Basic abc'),
    'https://***:***@example.test Authorization: Basic ***',
  );
  const buffer = await mod.streamToBuffer(Readable.from(['a', Buffer.from('b')]));
  assert.equal(buffer.toString('utf8'), 'ab');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
