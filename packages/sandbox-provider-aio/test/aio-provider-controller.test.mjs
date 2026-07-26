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
    body,
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
  const putArchives = [];
  let inspectResults = [];
  let inspectThrows = false;
  let inspectError = null;
  let getArchiveThrows = false;
  let startThrows = false;
  let startResponseLost = false;
  let stopThrows = false;
  let stopNoop = false;
  let removeThrows = false;
  let removeResponseLost = false;
  let removeNoop = false;
  let running = inspection?.State?.Running === true;
  let removed = false;
  return {
    id: inspection?.Id ?? name,
    name,
    calls,
    archives,
    putArchives,
    setInspectResults(value) {
      inspectResults = [...value];
    },
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
    setStopNoop(value) {
      stopNoop = value;
    },
    setRemoveThrows(value) {
      removeThrows = value;
    },
    setRemoveResponseLost(value) {
      removeResponseLost = value;
    },
    setRemoveNoop(value) {
      removeNoop = value;
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
      if (!stopNoop) running = false;
    },
    async remove(options) {
      calls.push(['remove', options]);
      if (removeThrows) throw new Error('remove failed');
      if (!removeNoop) removed = true;
      if (removeResponseLost) throw new Error('remove response lost');
    },
    async inspect() {
      calls.push(['inspect']);
      if (inspectError) throw inspectError;
      if (inspectResults.length > 0) {
        const result = inspectResults.shift();
        if (result instanceof Error) throw result;
        return result;
      }
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
    async putArchive(archive, options) {
      calls.push(['putArchive', options]);
      const chunks = [];
      for await (const chunk of archive) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      putArchives.push({ options, contents: Buffer.concat(chunks) });
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

function matchingInspection(
  taskId,
  {
    id = `id-${taskId}`,
    running = true,
    image = 'cap-aio-sandbox:0.1.0',
    network = 'cap-net',
    env = [`TASK_ID=${taskId}`],
    labels = {},
  } = {},
) {
  return {
    Id: id,
    Config: { Image: image, Env: env, Labels: labels },
    HostConfig: { NetworkMode: network },
    State: { Running: running },
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
    let result;
    if (typeof route === 'function') result = await route({ input, init, body });
    else if (route) result = route;
    else if (url.pathname === '/v1/shell/sessions/create') {
      result = response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    } else if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      result = response(200, {
        success: true,
        data: { session_id: url.pathname.slice('/v1/shell/sessions/'.length) },
      });
    } else {
      result = response(404, { data: { exit_code: 1, output: 'not found' } });
    }
    if (
      url.pathname === '/v1/shell/exec' &&
      result.ok &&
      result.body &&
      typeof result.body === 'object' &&
      !Object.prototype.hasOwnProperty.call(result.body, 'success')
    ) {
      const data =
        result.body.data && typeof result.body.data === 'object'
          ? result.body.data
          : result.body;
      return response(result.status, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          ...data,
        },
      });
    }
    return result;
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

await test('resolves immutable repo digests and rejects images without a usable identity', async () => {
  const docker = makeDocker();
  const controller = new mod.AioSandboxContainerController({ docker });
  assert.deepEqual(await controller.resolveImageIdentity('image-with-repo-digest'), {
    locator: 'registry.example/cap/aio@sha256:repo-digest',
    digest: 'sha256:repo-digest',
  });

  docker.getImage = () => ({
    async inspect() {
      return { Id: '  ', RepoDigests: ['registry.example/cap/aio:latest'] };
    },
  });
  await assert.rejects(
    () => controller.resolveImageIdentity('mutable-only'),
    /no provider-consumable immutable identity/,
  );
});

await test('existing-container observation and inspection uncertainty fail closed', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };
  await new mod.AioSandboxContainerController(options).createAndStart(
    'task-existing-observation',
  );
  const observerFailure = new Error('durable create observation unavailable');
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController(options).createAndStart(
        'task-existing-observation',
        undefined,
        undefined,
        {
          onSandboxCreateObserved: async () => {
            throw observerFailure;
          },
        },
      ),
    (error) =>
      core.isSandboxCleanupCoordinationPendingError(error) &&
      error.primary === observerFailure,
  );

  const uncertain = makeContainer(
    'cap-aio-task-inspect-uncertain',
    matchingInspection('task-inspect-uncertain'),
  );
  const transportFailure = new Error('docker inspect transport unavailable');
  uncertain.setInspectError(transportFailure);
  docker.byName.set('cap-aio-task-inspect-uncertain', uncertain);
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController(options).createAndStart(
        'task-inspect-uncertain',
      ),
    (error) => error === transportFailure,
  );
});

await test('existing stopped containers start idempotently and confirm ambiguous responses', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };
  const cleanStart = makeContainer(
    'cap-aio-task-existing-stopped',
    matchingInspection('task-existing-stopped', { running: false }),
  );
  docker.byName.set('cap-aio-task-existing-stopped', cleanStart);
  const started = await new mod.AioSandboxContainerController(options).createAndStart(
    'task-existing-stopped',
  );
  assert.equal(started.container, cleanStart);
  assert.deepEqual(cleanStart.calls, [['inspect'], ['start']]);

  const responseLost = makeContainer(
    'cap-aio-task-existing-start-lost',
    matchingInspection('task-existing-start-lost', { running: false }),
  );
  responseLost.setStartResponseLost(true);
  docker.byName.set('cap-aio-task-existing-start-lost', responseLost);
  assert.equal(
    (
      await new mod.AioSandboxContainerController(options).createAndStart(
        'task-existing-start-lost',
      )
    ).container,
    responseLost,
  );
  assert.deepEqual(responseLost.calls, [['inspect'], ['start'], ['inspect']]);

  const failed = makeContainer(
    'cap-aio-task-existing-start-failed',
    matchingInspection('task-existing-start-failed', { running: false }),
  );
  failed.setStartThrows(true);
  docker.byName.set('cap-aio-task-existing-start-failed', failed);
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController(options).createAndStart(
        'task-existing-start-failed',
      ),
    /start failed/,
  );
  assert.deepEqual(failed.calls, [['inspect'], ['start'], ['inspect']]);
});

await test('guarded existing starts surface lease loss and reject malformed confirmation', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };
  const leaseLost = makeContainer(
    'cap-aio-task-guarded-start-lease',
    matchingInspection('task-guarded-start-lease', { running: false }),
  );
  docker.byName.set('cap-aio-task-guarded-start-lease', leaseLost);
  const leaseError = new Error('sandbox start lease lost');
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController(options).createAndStart(
        'task-guarded-start-lease',
        undefined,
        undefined,
        {
          externalBoundaryGuard: async ({ action, position }) => {
            if (action === 'sandbox.start' && position === 'before') throw leaseError;
          },
        },
      ),
    (error) => error === leaseError,
  );
  assert.equal(leaseLost.calls.some(([kind]) => kind === 'start'), false);

  const malformed = makeContainer(
    'cap-aio-task-guarded-start-malformed',
    matchingInspection('task-guarded-start-malformed', { running: false }),
  );
  malformed.setStartResponseLost(true);
  malformed.setInspectResults([
    matchingInspection('task-guarded-start-malformed', { running: false }),
    null,
  ]);
  docker.byName.set('cap-aio-task-guarded-start-malformed', malformed);
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController(options).createAndStart(
        'task-guarded-start-malformed',
        undefined,
        undefined,
        { externalBoundaryGuard: async () => undefined },
      ),
    /start response lost/,
  );
});

await test('rejects aborted provisioning and malformed Docker identities before readiness', async () => {
  for (const [reason, expected] of [
    [new Error('explicit abort reason'), /explicit abort reason/],
    ['cancelled', /provisioning was aborted/],
  ]) {
    const abort = new AbortController();
    abort.abort(reason);
    const docker = makeDocker();
    await assert.rejects(
      () =>
        new mod.AioSandboxContainerController({
          docker,
          env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
        }).createAndStart(
          'task-aborted',
          undefined,
          undefined,
          { signal: abort.signal },
        ),
      expected,
    );
    assert.equal(docker.created.length, 0);
  }

  const invalidGeneration = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  });
  await assert.rejects(
    () =>
      invalidGeneration.createAndStart('task-invalid-generation', undefined, undefined, {
        ownership: ownership('owner', ' bad-generation '),
      }),
    /resource generation is invalid/,
  );

  const missingCreatedId = makeDocker();
  missingCreatedId.createContainer = async (options) => {
    const container = makeContainer(options.name, matchingInspection('task-missing-id'));
    container.id = undefined;
    return container;
  };
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController({
        docker: missingCreatedId,
        env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
      }).createAndStart('task-missing-id'),
    /missing container id/,
  );
});

await test('existing sandbox inspections must be structurally valid and immutable-compatible', async () => {
  const docker = makeDocker();
  const options = {
    docker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  };

  const invalid = makeContainer(
    'cap-aio-task-existing-invalid',
    matchingInspection('task-existing-invalid'),
  );
  invalid.setInspectResults([null]);
  docker.byName.set('cap-aio-task-existing-invalid', invalid);
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController(options).createAndStart(
        'task-existing-invalid',
      ),
    /inspection is invalid/,
  );

  const incompatible = makeContainer(
    'cap-aio-task-existing-incompatible',
    matchingInspection('task-existing-incompatible', { image: 'other-image:1' }),
  );
  docker.byName.set('cap-aio-task-existing-incompatible', incompatible);
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController(options).createAndStart(
        'task-existing-incompatible',
      ),
    /does not match immutable task provisioning inputs/,
  );

  const missingId = makeContainer(
    'cap-aio-task-existing-missing-id',
    matchingInspection('task-existing-missing-id'),
  );
  missingId.setInspectResults([
    { ...matchingInspection('task-existing-missing-id'), Id: undefined },
  ]);
  docker.byName.set('cap-aio-task-existing-missing-id', missingId);
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController(options).createAndStart(
        'task-existing-missing-id',
      ),
    /inspection is missing container id/,
  );
});

await test('create failure classification supports primitive, status, and body conflict forms', async () => {
  const primitiveDocker = makeDocker();
  primitiveDocker.createContainer = async () => {
    throw 'primitive create failure';
  };
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController({
        docker: primitiveDocker,
        env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
      }).createAndStart('task-create-primitive'),
    (error) => error === 'primitive create failure',
  );

  const statusDocker = makeDocker();
  const rejected = { status: 422 };
  statusDocker.createContainer = async () => {
    throw rejected;
  };
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController({
        docker: statusDocker,
        env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
      }).createAndStart('task-create-status'),
    (error) => error === rejected,
  );

  const bodyConflictDocker = makeDocker();
  let raced;
  bodyConflictDocker.createContainer = async (options) => {
    raced = makeContainer(
      options.name,
      matchingInspection('task-create-body-conflict', {
        id: 'id-create-body-conflict',
        image: options.Image,
        network: options.HostConfig.NetworkMode,
        env: options.Env,
      }),
    );
    bodyConflictDocker.byName.set(options.name, raced);
    throw {
      status: 409,
      body: {
        message:
          `Conflict. The container name "${options.name}" is already in use ` +
          'by another container.',
      },
    };
  };
  const provisioned = await new mod.AioSandboxContainerController({
    docker: bodyConflictDocker,
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
  }).createAndStart('task-create-body-conflict');
  assert.equal(provisioned.container, raced);
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
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(input).pathname;
    if (path === '/v1/docs') {
      docsAttempts += 1;
      return docsAttempts === 1 ? response(503) : response(200);
    }
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === '/v1/shell/sessions/create') {
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (init.method === 'DELETE') {
      return response(200, {
        success: true,
        data: { session_id: path.slice('/v1/shell/sessions/'.length) },
      });
    }
    return response(200, {
      success: true,
      data: {
        session_id: body.id,
        command: body.command,
        status: 'completed',
        exit_code: 0,
        output: 'global ok',
      },
    });
  };
  try {
    const controller = new mod.AioSandboxContainerController({ docker: makeDocker() });
    assert.deepEqual(await controller.runSandboxExec('http://sandbox', 'echo ok'), {
      exitCode: 0,
      output: 'global ok',
      timedOut: false,
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

await test('readiness stops immediately on cancellation and tolerates missing status-class metadata', async () => {
  const abort = new AbortController();
  abort.abort();
  let abortedFetches = 0;
  const cancelled = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: async () => {
      abortedFetches += 1;
      return response(200);
    },
  });
  await assert.rejects(
    () =>
      cancelled.waitForReadiness({
        baseUrl: 'http://sandbox',
        taskId: 'task-readiness-aborted',
        timeoutMs: 1_000,
        signal: abort.signal,
      }),
    /readiness was aborted/,
  );
  assert.equal(abortedFetches, 0);

  const malformedStatus = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: async () => ({
      ok: true,
      status: Number.NaN,
      async json() {
        return {};
      },
    }),
  });
  await malformedStatus.waitForReadiness({
    baseUrl: 'http://sandbox',
    taskId: 'task-readiness-without-status-class',
    timeoutMs: 1_000,
  });
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

await test('teardown recognizes stopped sandboxes and fails closed on unconfirmed stops', async () => {
  const docker = makeDocker();
  const stoppedInspection = matchingInspection('task-already-stopped', {
    id: 'id-already-stopped',
    running: false,
  });
  const stopped = makeContainer('cap-aio-task-already-stopped', stoppedInspection);
  docker.byName.set('cap-aio-task-already-stopped', stopped);
  docker.byName.set('id-already-stopped', stopped);
  const controller = new mod.AioSandboxContainerController({ docker });
  assert.deepEqual(await controller.teardownSandbox('task-already-stopped'), {
    kind: 'found-and-cleaned',
  });
  assert.equal(stopped.calls.some(([kind]) => kind === 'stop'), false);
  assert.equal(stopped.calls.some(([kind]) => kind === 'remove'), true);
  await assert.rejects(
    stopped.inspect(),
    (error) => error?.statusCode === 404,
  );

  const inspectFailure = new Error('post-stop inspect unavailable');
  const uncertain = makeContainer(
    'cap-aio-task-stop-inspect-uncertain',
    matchingInspection('task-stop-inspect-uncertain', {
      id: 'id-stop-inspect-uncertain',
    }),
  );
  uncertain.setInspectResults([
    matchingInspection('task-stop-inspect-uncertain', {
      id: 'id-stop-inspect-uncertain',
    }),
    inspectFailure,
  ]);
  docker.byName.set('cap-aio-task-stop-inspect-uncertain', uncertain);
  docker.byName.set('id-stop-inspect-uncertain', uncertain);
  await assert.rejects(
    () => controller.teardownSandbox('task-stop-inspect-uncertain'),
    (error) => error === inspectFailure,
  );

  const vanished = makeContainer(
    'cap-aio-task-stop-vanished',
    matchingInspection('task-stop-vanished', { id: 'id-stop-vanished' }),
  );
  vanished.setInspectResults([
    matchingInspection('task-stop-vanished', { id: 'id-stop-vanished' }),
    Object.assign(new Error('container vanished after stop'), { status: 404 }),
  ]);
  docker.byName.set('cap-aio-task-stop-vanished', vanished);
  docker.byName.set('id-stop-vanished', vanished);
  assert.deepEqual(await controller.teardownSandbox('task-stop-vanished'), {
    kind: 'found-and-cleaned',
  });

  const noOp = makeContainer(
    'cap-aio-task-stop-noop',
    matchingInspection('task-stop-noop', { id: 'id-stop-noop' }),
  );
  noOp.setStopNoop(true);
  docker.byName.set('cap-aio-task-stop-noop', noOp);
  docker.byName.set('id-stop-noop', noOp);
  await assert.rejects(
    () => controller.teardownSandbox('task-stop-noop'),
    /stop could not be confirmed/,
  );

  const malformed = makeContainer(
    'cap-aio-task-stop-malformed',
    matchingInspection('task-stop-malformed', {
      id: 'id-stop-malformed',
      labels: { 'cap.resourceGeneration': 'resource-stop-malformed' },
    }),
  );
  malformed.setInspectResults([
    matchingInspection('task-stop-malformed', {
      id: 'id-stop-malformed',
      labels: { 'cap.resourceGeneration': 'resource-stop-malformed' },
    }),
    null,
  ]);
  docker.byName.set('cap-aio-task-stop-malformed', malformed);
  docker.byName.set('id-stop-malformed', malformed);
  await assert.rejects(
    () =>
      controller.teardownSandbox('task-stop-malformed', {
        ownership: ownership('owner-stop-malformed', 'resource-stop-malformed'),
      }),
    /inspection is invalid/,
  );
});

await test('private archive transport resolves deterministic fallback containers', async () => {
  const docker = makeDocker();
  const fallback = makeContainer('cap-aio-task-private-archive');
  docker.byName.set('cap-aio-task-private-archive', fallback);
  const controller = new mod.AioSandboxContainerController({ docker });
  const archive = Uint8Array.from([1, 2, 3, 4]);
  await controller.putPrivateArchive('task-private-archive', '/run/cap', archive);
  assert.deepEqual(fallback.putArchives, [
    {
      options: { path: '/run/cap' },
      contents: Buffer.from([1, 2, 3, 4]),
    },
  ]);
  assert.deepEqual(archive, Uint8Array.from([1, 2, 3, 4]));
});

await test('targeted removal confirms response loss and rejects surviving exact resources', async () => {
  const docker = makeDocker();
  const controller = new mod.AioSandboxContainerController({ docker });

  const responseLost = makeContainer(
    'cap-aio-task-remove-response-lost',
    matchingInspection('task-remove-response-lost', {
      id: 'id-remove-response-lost',
    }),
  );
  responseLost.setRemoveResponseLost(true);
  docker.byName.set('id-remove-response-lost', responseLost);
  assert.deepEqual(
    await controller.removeSandbox('task-remove-response-lost', {
      providerSandboxId: 'id-remove-response-lost',
    }),
    undefined,
  );

  const surviving = makeContainer(
    'cap-aio-task-remove-surviving',
    matchingInspection('task-remove-surviving', {
      id: 'id-remove-surviving',
      labels: { 'cap.resourceGeneration': 'resource-remove-surviving' },
    }),
  );
  surviving.setRemoveNoop(true);
  docker.byName.set('id-remove-surviving', surviving);
  await assert.rejects(
    () =>
      controller.removeSandboxAndConfirm(
        'task-remove-surviving',
        ownership('owner-remove-surviving', 'resource-remove-surviving'),
        'id-remove-surviving',
      ),
    /removal could not be confirmed/,
  );

  const changed = makeContainer(
    'cap-aio-task-remove-changed-id',
    matchingInspection('task-remove-changed-id', { id: 'id-remove-original' }),
  );
  changed.setRemoveThrows(true);
  changed.setInspectResults([
    matchingInspection('task-remove-changed-id', { id: 'id-remove-original' }),
    matchingInspection('task-remove-changed-id', { id: 'id-remove-replacement' }),
  ]);
  docker.byName.set('id-remove-original', changed);
  await assert.rejects(
    () =>
      controller.removeSandboxAndConfirm(
        'task-remove-changed-id',
        undefined,
        'id-remove-original',
      ),
    /changed provider sandbox id/,
  );

  const wrongTask = makeContainer(
    'cap-aio-task-remove-wrong-task',
    matchingInspection('task-remove-wrong-task', { id: 'id-remove-wrong-task' }),
  );
  wrongTask.setRemoveThrows(true);
  wrongTask.setInspectResults([
    matchingInspection('task-remove-wrong-task', { id: 'id-remove-wrong-task' }),
    matchingInspection('different-task', { id: 'id-remove-wrong-task' }),
  ]);
  docker.byName.set('id-remove-wrong-task', wrongTask);
  await assert.rejects(
    () =>
      controller.removeSandboxAndConfirm(
        'task-remove-wrong-task',
        undefined,
        'id-remove-wrong-task',
      ),
    /task id does not match persisted target/,
  );
});

await test('cleanup pins persisted ids and requires authoritative final absence', async () => {
  const docker = makeDocker();
  const controller = new mod.AioSandboxContainerController({ docker });
  const rebound = makeContainer(
    'persisted-cleanup-id',
    matchingInspection('task-cleanup-rebound', { id: 'replacement-cleanup-id' }),
  );
  docker.byName.set('persisted-cleanup-id', rebound);
  await assert.rejects(
    () =>
      controller.removeSandboxAndConfirm(
        'task-cleanup-rebound',
        undefined,
        'persisted-cleanup-id',
      ),
    /does not match persisted target/,
  );

  const finalInspectFailure = new Error('final absence inspection unavailable');
  const uncertain = makeContainer(
    'cap-aio-task-cleanup-final-uncertain',
    matchingInspection('task-cleanup-final-uncertain'),
  );
  uncertain.setRemoveThrows(true);
  uncertain.setInspectResults([
    matchingInspection('task-cleanup-final-uncertain'),
    finalInspectFailure,
  ]);
  docker.byName.set('cap-aio-task-cleanup-final-uncertain', uncertain);
  await assert.rejects(
    () => controller.removeSandboxAndConfirm('task-cleanup-final-uncertain'),
    /removal could not be confirmed/,
  );
});

await test('sandbox existence distinguishes not-found reasons from transport failures', async () => {
  const docker = makeDocker();
  const controller = new mod.AioSandboxContainerController({ docker });

  const transport = docker.getContainer('cap-aio-task-exists-transport');
  const transportError = new Error('inspect transport failure');
  transport.setInspectError(transportError);
  await assert.rejects(
    () => controller.sandboxExists('task-exists-transport'),
    (error) => error === transportError,
  );

  const primitive = docker.getContainer('cap-aio-task-exists-primitive');
  primitive.setInspectError('primitive inspect failure');
  await assert.rejects(
    () => controller.sandboxExists('task-exists-primitive'),
    (error) => error === 'primitive inspect failure',
  );

  const reason = docker.getContainer('cap-aio-task-exists-reason');
  reason.setInspectError({ reason: 'No Such Container: task-exists-reason' });
  assert.equal(await controller.sandboxExists('task-exists-reason'), false);
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
    'POST /v1/shell/exec': response(200, { data: { exit_code: 0, stdout: 'ok' } }),
  });
  const controller = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch,
  });
  assert.deepEqual(await controller.runSandboxExec('http://sandbox', 'echo ok'), {
    exitCode: 0,
    output: 'ok',
    timedOut: false,
  });
  const execCall = calls.find((call) => call.path === '/v1/shell/exec');
  assert.deepEqual(execCall.body, {
    id: calls[0].body.id,
    command: 'echo ok',
    async_mode: false,
  });

  const failed = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: makeFetch({ 'POST /v1/shell/exec': response(500) }).fetch,
  });
  const parsed = await failed.runSandboxExec('http://sandbox', 'boom');
  assert(Number.isNaN(parsed.exitCode));
  assert.equal(parsed.output, '/v1/shell/exec responded 500');
  assert.equal(parsed.timedOut, false);

  const noChangeTimeout = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: makeFetch({
      'POST /v1/shell/exec': response(200, {
        data: {
          exit_code: -1,
          output: 'no new output',
          status: 'no_change_timeout',
        },
      }),
    }).fetch,
  });
  const noChangeResult = await noChangeTimeout.runSandboxExec(
    'http://sandbox',
    'long command',
  );
  assert(Number.isNaN(noChangeResult.exitCode));
  assert.equal(noChangeResult.output, 'no new output');
  assert.equal(noChangeResult.timedOut, true);

  const terminated = mod.parseAioExecResult({
    data: {
      exit_code: -1,
      output: 'final process metadata unavailable',
      status: 'terminated',
    },
  });
  assert(Number.isNaN(terminated.exitCode));
  assert.equal(terminated.output, 'final process metadata unavailable');
  assert.equal(terminated.timedOut, false);

  const invalidJson = new mod.AioSandboxContainerController({
    docker: makeDocker(),
    fetch: makeFetch({
      'POST /v1/shell/exec': {
        ok: true,
        status: 200,
        async json() {
          throw new Error('bad json');
        },
      },
    }).fetch,
  });
  await assert.rejects(
    () => invalidJson.runSandboxExec('http://sandbox', 'x'),
    /invalid protocol response/u,
  );
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
    fetch: makeFetch({
      'POST /v1/shell/exec': () => {
        throw 'string down';
      },
    }).fetch,
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
  assert.equal(calls.length, 6);
  const createCalls = calls.filter(
    (call) => call.path === '/v1/shell/sessions/create',
  );
  const execCalls = calls.filter((call) => call.path === '/v1/shell/exec');
  const deletePaths = new Set(
    calls
      .filter((call) => call.method === 'DELETE')
      .map((call) => call.path),
  );
  assert.equal(createCalls.length, 2);
  assert.equal(execCalls.length, 2);
  for (const createCall of createCalls) {
    assert.equal(
      execCalls.some((call) => call.body.id === createCall.body.id),
      true,
    );
    assert.equal(
      deletePaths.has(`/v1/shell/sessions/${createCall.body.id}`),
      true,
    );
  }
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

await test('inventory reconciliation tolerates vanished candidates but rejects changed or missing ids', async () => {
  const vanishedDocker = makeDocker();
  const vanished = makeContainer(
    'cap-aio-task-inventory-vanished',
    matchingInspection('task-inventory-vanished', { id: 'id-inventory-vanished' }),
  );
  vanished.setInspectThrows(true);
  vanishedDocker.byName.set('id-inventory-vanished', vanished);
  vanishedDocker.setRunning([
    { Id: 'id-inventory-vanished', Names: ['/cap-aio-task-inventory-vanished'] },
  ]);
  assert.deepEqual(
    await new mod.AioSandboxContainerController({
      docker: vanishedDocker,
    }).reconcileSandboxInventory({
      protectedTaskIds: [],
      canReap: () => assert.fail('a vanished candidate needs no authorization'),
    }),
    { inspected: 1, reaped: 0 },
  );

  const changedDocker = makeDocker();
  const changed = makeContainer(
    'cap-aio-task-inventory-changed',
    matchingInspection('task-inventory-changed', { id: 'id-inventory-replacement' }),
  );
  changedDocker.byName.set('id-inventory-original', changed);
  changedDocker.setRunning([
    { Id: 'id-inventory-original', Names: ['/cap-aio-task-inventory-changed'] },
  ]);
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController({
        docker: changedDocker,
      }).reconcileSandboxInventory({
        protectedTaskIds: [],
        canReap: () => true,
      }),
    /provider sandbox id changed before reconciliation/,
  );

  const missingIdDocker = makeDocker();
  missingIdDocker.setRunning([
    { Id: '', Names: ['/cap-aio-task-inventory-missing-id'] },
  ]);
  await assert.rejects(
    () =>
      new mod.AioSandboxContainerController({
        docker: missingIdDocker,
      }).reconcileSandboxInventory({
        protectedTaskIds: [],
        canReap: () => true,
      }),
    /inventory is missing container id/,
  );
});

await test('inventory removal accepts only confirmed absence and preserves concurrent stops', async () => {
  const responseLostDocker = makeDocker();
  const responseLost = makeContainer(
    'cap-aio-task-inventory-response-lost',
    matchingInspection('task-inventory-response-lost', {
      id: 'id-inventory-response-lost',
    }),
  );
  responseLost.setRemoveResponseLost(true);
  responseLostDocker.byName.set('id-inventory-response-lost', responseLost);
  responseLostDocker.setRunning([
    {
      Id: 'id-inventory-response-lost',
      Names: ['/cap-aio-task-inventory-response-lost'],
    },
  ]);
  const logs = [];
  assert.deepEqual(
    await new mod.AioSandboxContainerController({
      docker: responseLostDocker,
      logger: { log: (message) => logs.push(message) },
    }).reconcileSandboxInventory({
      protectedTaskIds: [],
      canReap: () => true,
    }),
    { inspected: 1, reaped: 1 },
  );
  assert.match(logs[0], /force-removed 1/);

  const stoppedDocker = makeDocker();
  const stopped = makeContainer(
    'cap-aio-task-inventory-concurrent-stop',
    matchingInspection('task-inventory-concurrent-stop', {
      id: 'id-inventory-concurrent-stop',
    }),
  );
  stopped.setRemoveThrows(true);
  stopped.setInspectResults([
    matchingInspection('task-inventory-concurrent-stop', {
      id: 'id-inventory-concurrent-stop',
    }),
    matchingInspection('task-inventory-concurrent-stop', {
      id: 'id-inventory-concurrent-stop',
      running: false,
    }),
  ]);
  stoppedDocker.byName.set('id-inventory-concurrent-stop', stopped);
  stoppedDocker.setRunning([
    {
      Id: 'id-inventory-concurrent-stop',
      Names: ['/cap-aio-task-inventory-concurrent-stop'],
    },
  ]);
  assert.deepEqual(
    await new mod.AioSandboxContainerController({
      docker: stoppedDocker,
    }).reconcileSandboxInventory({
      protectedTaskIds: [],
      canReap: () => true,
    }),
    { inspected: 1, reaped: 0 },
  );
});

await test('inventory reconciliation surfaces changed identities and surviving orphans', async () => {
  async function reconcileOne(container, listedId, taskId) {
    const docker = makeDocker();
    docker.byName.set(listedId, container);
    docker.setRunning([{ Id: listedId, Names: [`/cap-aio-${taskId}`] }]);
    return new mod.AioSandboxContainerController({
      docker,
    }).reconcileSandboxInventory({
      protectedTaskIds: [],
      canReap: () => true,
    });
  }

  const changedAfterFailure = makeContainer(
    'cap-aio-task-inventory-changed-after-failure',
    matchingInspection('task-inventory-changed-after-failure', {
      id: 'id-inventory-changed-after-failure',
    }),
  );
  changedAfterFailure.setRemoveThrows(true);
  changedAfterFailure.setInspectResults([
    matchingInspection('task-inventory-changed-after-failure', {
      id: 'id-inventory-changed-after-failure',
    }),
    matchingInspection('task-inventory-changed-after-failure', {
      id: 'id-inventory-replacement-after-failure',
    }),
  ]);
  await assert.rejects(
    () =>
      reconcileOne(
        changedAfterFailure,
        'id-inventory-changed-after-failure',
        'task-inventory-changed-after-failure',
      ),
    /remove failed/,
  );

  const changedAfterSuccess = makeContainer(
    'cap-aio-task-inventory-changed-after-success',
    matchingInspection('task-inventory-changed-after-success', {
      id: 'id-inventory-changed-after-success',
    }),
  );
  changedAfterSuccess.setRemoveNoop(true);
  changedAfterSuccess.setInspectResults([
    matchingInspection('task-inventory-changed-after-success', {
      id: 'id-inventory-changed-after-success',
    }),
    matchingInspection('task-inventory-changed-after-success', {
      id: 'id-inventory-replacement-after-success',
    }),
  ]);
  await assert.rejects(
    () =>
      reconcileOne(
        changedAfterSuccess,
        'id-inventory-changed-after-success',
        'task-inventory-changed-after-success',
      ),
    /provider sandbox id changed during reconciliation/,
  );

  const failedSurvivor = makeContainer(
    'cap-aio-task-inventory-failed-survivor',
    matchingInspection('task-inventory-failed-survivor', {
      id: 'id-inventory-failed-survivor',
    }),
  );
  failedSurvivor.setRemoveThrows(true);
  await assert.rejects(
    () =>
      reconcileOne(
        failedSurvivor,
        'id-inventory-failed-survivor',
        'task-inventory-failed-survivor',
      ),
    /remove failed/,
  );

  const successfulNoop = makeContainer(
    'cap-aio-task-inventory-successful-noop',
    matchingInspection('task-inventory-successful-noop', {
      id: 'id-inventory-successful-noop',
    }),
  );
  successfulNoop.setRemoveNoop(true);
  await assert.rejects(
    () =>
      reconcileOne(
        successfulNoop,
        'id-inventory-successful-noop',
        'task-inventory-successful-noop',
      ),
    /orphan removal could not be confirmed/,
  );
});

await test('targeted readoption rejects transport, id, state, and task mismatches', async () => {
  const docker = makeDocker();
  const controller = new mod.AioSandboxContainerController({ docker });

  const fallback = makeContainer(
    'cap-aio-task-readopt-fallback',
    matchingInspection('task-readopt-fallback', { id: 'id-readopt-fallback' }),
  );
  docker.byName.set('cap-aio-task-readopt-fallback', fallback);
  docker.byName.set('id-readopt-fallback', fallback);
  assert.deepEqual(await controller.reattach('task-readopt-fallback', {}), {
    taskId: 'task-readopt-fallback',
    baseUrl: 'http://cap-aio-task-readopt-fallback:8080',
    wsUrl: 'ws://cap-aio-task-readopt-fallback:8080/v1/shell/ws',
  });

  const transport = makeContainer('id-readopt-transport');
  const transportError = new Error('readoption inspect unavailable');
  transport.setInspectError(transportError);
  docker.byName.set('id-readopt-transport', transport);
  await assert.rejects(
    () =>
      controller.reattach('task-readopt-transport', {
        providerSandboxId: 'id-readopt-transport',
      }),
    (error) => error === transportError,
  );

  const changed = makeContainer(
    'id-readopt-original',
    matchingInspection('task-readopt-changed', { id: 'id-readopt-replacement' }),
  );
  docker.byName.set('id-readopt-original', changed);
  await assert.rejects(
    () =>
      controller.reattach('task-readopt-changed', {
        providerSandboxId: 'id-readopt-original',
      }),
    /provider sandbox id does not match persisted target/,
  );

  const stopped = makeContainer(
    'id-readopt-stopped',
    matchingInspection('task-readopt-stopped', {
      id: 'id-readopt-stopped',
      running: false,
    }),
  );
  docker.byName.set('id-readopt-stopped', stopped);
  assert.equal(
    await controller.reattach('task-readopt-stopped', {
      providerSandboxId: 'id-readopt-stopped',
    }),
    null,
  );

  const wrongTask = makeContainer(
    'id-readopt-wrong-task',
    matchingInspection('different-task', { id: 'id-readopt-wrong-task' }),
  );
  docker.byName.set('id-readopt-wrong-task', wrongTask);
  await assert.rejects(
    () =>
      controller.reattach('task-readopt-wrong-task', {
        providerSandboxId: 'id-readopt-wrong-task',
      }),
    /task id does not match persisted target/,
  );

  for (const [id, inspected, expected] of [
    ['id-readopt-invalid', null, /inspection is invalid/],
    [
      'id-readopt-missing-id',
      {
        ...matchingInspection('task-readopt-missing-id'),
        Id: undefined,
      },
      /inspection is missing container id/,
    ],
  ]) {
    const malformed = makeContainer(id, matchingInspection('placeholder'));
    malformed.setInspectResults([inspected]);
    docker.byName.set(id, malformed);
    await assert.rejects(
      () =>
        controller.reattach(id.replace('id-readopt-', 'task-readopt-'), {
          providerSandboxId: id,
        }),
      expected,
    );
  }
});

await test('readoption inventory rejects indeterminate liveness exit codes', async () => {
  const docker = makeDocker();
  docker.setRunning([
    { Id: 'id-readopt-indeterminate', Names: ['/cap-aio-task-readopt-indeterminate'] },
  ]);
  const controller = new mod.AioSandboxContainerController({
    docker,
    fetch: makeFetch({
      'POST /v1/shell/exec': response(200, {
        data: { exit_code: 2, output: 'tmux unavailable' },
      }),
    }).fetch,
  });
  await assert.rejects(
    () => controller.listReadoptable(),
    /indeterminate exit code 2/,
  );
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

await test('targeted readoption sweeps the exact owned terminal journal before publishing the connection', async () => {
  const taskId = 'task-readopt-terminal-sweep';
  const providerSandboxId = 'id-readopt-terminal-sweep';
  const ownershipFence = ownership('owner-sweep', 'resource-sweep');
  const docker = makeDocker();
  const container = makeContainer(
    providerSandboxId,
    matchingInspection(taskId, {
      id: providerSandboxId,
      labels: {
        [mod.AIO_SANDBOX_RESOURCE_GENERATION_LABEL]:
          ownershipFence.resourceGeneration,
      },
    }),
  );
  docker.byName.set(providerSandboxId, container);
  let controller;
  const { fetch, calls } = makeFetch({
    'POST /v1/file/list': ({ body }) => {
      assert.equal(
        controller.getConnection(taskId),
        undefined,
        'startup sweep precedes publishing the reattached connection',
      );
      return response(200, {
        success: true,
        data: {
          path: body.path,
          files: [],
          total_count: 0,
          directory_count: 0,
          file_count: 0,
        },
      });
    },
  });
  controller = new mod.AioSandboxContainerController({
    docker,
    fetch,
    terminalSessionSweepProcessFingerprint: 'a'.repeat(64),
  });

  assert.deepEqual(
    await controller.reattach(taskId, {
      providerSandboxId,
      ownership: ownershipFence,
    }),
    {
      taskId,
      baseUrl: `http://cap-aio-${taskId}:8080`,
      wsUrl: `ws://cap-aio-${taskId}:8080/v1/shell/ws`,
    },
  );
  assert.equal(
    calls.filter((call) => call.path === '/v1/file/list').length,
    1,
  );
  assert.deepEqual(controller.getTerminalSessionSweepDecision(taskId), {
    kind: 'confirmed',
    cause: null,
    inspectedRecords: 0,
    unrelatedRecords: 0,
    peerRecords: 0,
    staleRecords: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    removedRecords: 0,
  });
});

await test('targeted readoption reports stale cleanup and indeterminate sweep outcomes without native identities', async () => {
  const taskId = 'task-readopt-stale-terminal';
  const providerSandboxId = 'id-readopt-stale-terminal';
  const ownershipFence = ownership('owner-current', 'resource-stale-sweep');
  const scope = { taskId, providerSandboxId, ownership: ownershipFence };
  const staleSessionId = '81000000-0000-4000-8000-000000000001';
  const staleInjectorSessionId = '82000000-0000-4000-8000-000000000002';
  const closeNonce = 'controller00000001';
  const staleRecord = mod.createAioTerminalOwnershipRecord({
    pair: {
      mainSessionId: staleSessionId,
      injectorSessionId: staleInjectorSessionId,
      main: {
        tty: '/dev/pts/81',
        pid: '8101',
        sid: '8101',
        pgid: '8101',
        startTime: '810100',
        bootId: '11111111-1111-4111-8111-111111111111',
      },
      injector: {
        tty: '/dev/pts/82',
        pid: '8201',
        sid: '8201',
        pgid: '8201',
        startTime: '820100',
        bootId: '11111111-1111-4111-8111-111111111111',
      },
      closeToken: `: CAP_AIO_INJECTOR_CLOSE_${closeNonce}`,
      releaseMarker: `CAP_AIO_INJECTOR_RELEASED_${closeNonce}`,
    },
    scope,
    processFingerprint: 'b'.repeat(64),
    iv: Uint8Array.from({ length: 12 }, () => 1),
  });
  const journalDir = staleRecord.path.slice(0, staleRecord.path.lastIndexOf('/'));
  const docker = makeDocker();
  const container = makeContainer(
    providerSandboxId,
    matchingInspection(taskId, {
      id: providerSandboxId,
      labels: {
        [mod.AIO_SANDBOX_RESOURCE_GENERATION_LABEL]:
          ownershipFence.resourceGeneration,
      },
    }),
  );
  docker.byName.set(providerSandboxId, container);
  const logs = [];
  const successfulFetch = makeFetch({
    'POST /v1/file/list': response(200, {
      success: true,
      data: {
        path: journalDir,
        files: [
          {
            name: staleRecord.path.slice(staleRecord.path.lastIndexOf('/') + 1),
            path: staleRecord.path,
            is_directory: false,
            size: Buffer.byteLength(staleRecord.content),
          },
        ],
        total_count: 1,
        directory_count: 0,
        file_count: 1,
      },
    }),
    'POST /v1/file/read': response(200, {
      success: true,
      data: { file: staleRecord.path, content: staleRecord.content },
    }),
    'POST /v1/shell/exec': response(200, { data: { exit_code: 0 } }),
  });
  const controller = new mod.AioSandboxContainerController({
    docker,
    fetch: successfulFetch.fetch,
    terminalSessionSweepProcessFingerprint: 'a'.repeat(64),
    terminalSessionGuestPairReleaser: async ({ pair }) => {
      assert.equal(pair.mainSessionId, staleSessionId);
      assert.equal(pair.injectorSessionId, staleInjectorSessionId);
      return { kind: 'confirmed', cause: null };
    },
    logger: { log: (message) => logs.push(message) },
  });
  assert.ok(
    await controller.reattach(taskId, {
      providerSandboxId,
      ownership: ownershipFence,
    }),
  );
  assert.match(logs[0], /confirmed 2 stale identity cleanup/u);
  assert.equal(logs[0].includes(staleSessionId), false);
  assert.equal(logs[0].includes(staleInjectorSessionId), false);
  assert.doesNotMatch(logs[0], /id-readopt/u);
  assert.equal(
    successfulFetch.calls.some(
      (call) =>
        call.method === 'DELETE' && call.path.endsWith(staleSessionId),
    ),
    true,
  );
  assert.equal(
    successfulFetch.calls.some(
      (call) =>
        call.method === 'DELETE' && call.path.endsWith(staleInjectorSessionId),
    ),
    true,
  );

  controller.releaseHandles();
  const warnings = [];
  const indeterminate = new mod.AioSandboxContainerController({
    docker,
    fetch: makeFetch({
      'POST /v1/file/list': response(503, {
        success: false,
        data: null,
        message: 'PROVIDER_RESPONSE_SECRET',
      }),
    }).fetch,
    terminalSessionSweepProcessFingerprint: 'a'.repeat(64),
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.ok(
    await indeterminate.reattach(taskId, {
      providerSandboxId,
      ownership: ownershipFence,
    }),
  );
  assert.match(warnings[0], /was indeterminate .*journal-unconfirmed/u);
  assert.equal(warnings[0].includes(staleSessionId), false);
  assert.equal(warnings[0].includes(staleInjectorSessionId), false);
  assert.doesNotMatch(
    warnings[0],
    /PROVIDER_RESPONSE_SECRET|id-readopt/u,
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
    timedOut: false,
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
