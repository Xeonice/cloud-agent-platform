import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);
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

function makeContainer(name = 'container') {
  const calls = [];
  const archives = new Map();
  let inspectThrows = false;
  let getArchiveThrows = false;
  let stopThrows = false;
  let removeThrows = false;
  return {
    name,
    calls,
    archives,
    setInspectThrows(value) {
      inspectThrows = value;
    },
    setGetArchiveThrows(value) {
      getArchiveThrows = value;
    },
    setStopThrows(value) {
      stopThrows = value;
    },
    setRemoveThrows(value) {
      removeThrows = value;
    },
    async start() {
      calls.push(['start']);
    },
    async stop(options) {
      calls.push(['stop', options]);
      if (stopThrows) throw new Error('stop failed');
    },
    async remove(options) {
      calls.push(['remove', options]);
      if (removeThrows) throw new Error('remove failed');
    },
    async inspect() {
      calls.push(['inspect']);
      if (inspectThrows) throw new Error('missing');
      return { id: name };
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
      const container = makeContainer(options.name);
      created.push({ options, container });
      byName.set(options.name, container);
      return container;
    },
    getContainer(name) {
      if (!byName.has(name)) byName.set(name, makeContainer(name));
      return byName.get(name);
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
    /did not become ready within 0ms .*undefined/,
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
      /network down/,
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
      /\/v1\/docs responded with status 503/,
    );
  } finally {
    Date.now = originalNow;
  }
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
  await controller.teardownSandbox('task-1', {
    beforeStop: async (args) => beforeStop.push(args),
  });
  assert.deepEqual(beforeStop, [{ taskId: 'task-1', baseUrl: 'http://custom' }]);
  assert.deepEqual(first.container.calls.at(-1), ['stop', { t: 0 }]);
  assert.equal(controller.getConnection('task-1'), undefined);

  const second = await controller.createAndStart('task-2');
  second.container.setStopThrows(true);
  await controller.teardownSandbox('task-2', {
    beforeStop: async (args) => beforeStop.push(args),
  });
  assert.deepEqual(beforeStop.at(-1), {
    taskId: 'task-2',
    baseUrl: 'http://cap-aio-task-2:8080',
  });
  await controller.teardownSandbox('task-missing');
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

  const fallback = docker.getContainer('cap-aio-task-fallback');
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

await test('startup readoption reattaches live sessions and reaps dead or foreign containers once', async () => {
  const docker = makeDocker();
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
  assert.deepEqual(docker.getContainer('id-dead').calls.at(-1), ['remove', { force: true }]);
  assert.deepEqual(docker.getContainer('id-foreign').calls.at(-1), ['remove', { force: true }]);
  assert.deepEqual(controller.reattach('task-live'), {
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
  assert.equal(controller.reattach('task-live'), custom);
  assert.equal(controller.reattach('task-missing'), null);
  assert.match(logs[0], /re-adopted 1 .* force-removed 2/);
});

await test('readoption handles no candidates, docker failures, probe HTTP failures, and releaseHandles', async () => {
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
  assert.deepEqual(await down.listReadoptable(), []);
  assert.match(warnings[0], /docker down/);

  const stringDown = makeDocker();
  stringDown.listContainers = async () => {
    throw 'string down';
  };
  const stringWarnings = [];
  assert.deepEqual(
    await new mod.AioSandboxContainerController({
      docker: stringDown,
      logger: { warn: (message) => stringWarnings.push(message) },
    }).listReadoptable(),
    [],
  );
  assert.match(stringWarnings[0], /string down/);

  const probeDownDocker = makeDocker();
  probeDownDocker.setRunning([{ Id: 'id-live', Names: ['/cap-aio-task-live'] }]);
  const probeDown = new mod.AioSandboxContainerController({
    docker: probeDownDocker,
    fetch: makeFetch({ 'POST /v1/shell/exec': response(500) }).fetch,
  });
  assert.deepEqual(await probeDown.listReadoptable(), []);

  const throwProbeDocker = makeDocker();
  throwProbeDocker.setRunning([{ Id: 'id-live', Names: ['/cap-aio-task-live'] }]);
  const throwProbe = new mod.AioSandboxContainerController({
    docker: throwProbeDocker,
    fetch: makeFetch({ 'POST /v1/shell/exec': new Error('fetch down') }).fetch,
  });
  assert.deepEqual(await throwProbe.listReadoptable(), []);
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
