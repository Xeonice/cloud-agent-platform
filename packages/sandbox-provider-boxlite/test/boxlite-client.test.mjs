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

function response(status, body, extra = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async arrayBuffer() {
      if (extra.arrayBuffer) return extra.arrayBuffer;
      return new Uint8Array().buffer;
    },
  };
}

function makeFetch(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const rawBody = init.body;
    const body =
      typeof rawBody === 'string'
        ? JSON.parse(rawBody)
        : rawBody instanceof Uint8Array
          ? [...rawBody]
          : rawBody;
    calls.push({
      url: input,
      path: url.pathname + url.search,
      method: init.method,
      headers: init.headers,
      body,
    });
    const route = routes[`${init.method ?? 'GET'} ${url.pathname}${url.search}`];
    if (!route) return response(404, { error: 'not found' });
    return typeof route === 'function' ? route({ url, init, body }) : route;
  };
  return { fetch, calls };
}

await test('REST client creates a sandbox with bearer auth and normalized URL', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        id: 'box-task-1',
        taskId: 'task-1',
        state: 'running',
        image: 'cap-boxlite:1',
        baseUrl: 'https://boxlite/s/box-task-1',
        terminalUrl: 'wss://boxlite/s/box-task-1/tty',
        metadata: { location: 'iad' },
      },
    }),
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: ' https://boxlite.example.test/ ',
    apiToken: 'secret',
    protocolMode: 'cap-rest',
    fetch,
  });

  const sandbox = await client.createSandbox({
    taskId: 'task-1',
    sandboxId: 'box-task-1',
    image: 'cap-boxlite:1',
    location: 'iad',
    labels: { task: 'task-1' },
  });

  assert.equal(sandbox.id, 'box-task-1');
  assert.equal(sandbox.terminalUrl, 'wss://boxlite/s/box-task-1/tty');
  assert.equal(calls[0].url, 'https://boxlite.example.test/v1/sandboxes');
  assert.equal(calls[0].headers.authorization, 'Bearer secret');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(calls[0].body, {
    taskId: 'task-1',
    sandboxId: 'box-task-1',
    image: 'cap-boxlite:1',
    location: 'iad',
    labels: { task: 'task-1' },
  });
});

await test('REST create observes the immutable response id only after the definitive response and keeps internal fields off the wire', async () => {
  const events = [];
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': () => ({
      ok: true,
      status: 200,
      async json() {
        events.push('definitive-response');
        return {
          data: {
            id: 'immutable-provider-id',
            taskId: 'task-observed',
            state: 'running',
          },
        };
      },
      async arrayBuffer() {
        return new Uint8Array().buffer;
      },
    }),
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch,
  });
  const cancellationController = new AbortController();

  const sandbox = await client.createSandbox({
    taskId: 'task-observed',
    sandboxId: 'requested-sandbox-id',
    image: 'cap-boxlite:1',
    labels: { task: 'task-observed' },
    externalBoundaryGuard: async () => {},
    onSandboxCreateObserved: async (observation) => {
      events.push(observation);
    },
    cancellationSignal: cancellationController.signal,
  });

  assert.equal(sandbox.id, 'immutable-provider-id');
  assert.deepEqual(events, [
    'definitive-response',
    { kind: 'created', providerSandboxId: 'immutable-provider-id' },
  ]);
  assert.deepEqual(calls[0].body, {
    taskId: 'task-observed',
    sandboxId: 'requested-sandbox-id',
    image: 'cap-boxlite:1',
    labels: { task: 'task-observed' },
  });
  assert.equal('externalBoundaryGuard' in calls[0].body, false);
  assert.equal('onSandboxCreateObserved' in calls[0].body, false);
  assert.equal('cancellationSignal' in calls[0].body, false);
});

await test('REST create reports not-created only for definitive non-retryable 4xx responses', async () => {
  const observations = [];
  const { fetch } = makeFetch({
    'POST /v1/sandboxes': response(422, { error: 'invalid image' }),
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch,
  });

  await assert.rejects(
    () =>
      client.createSandbox({
        taskId: 'task-rejected',
        image: 'invalid-image',
        onSandboxCreateObserved: async (observation) => {
          observations.push(observation);
        },
      }),
    /HTTP 422/,
  );

  assert.deepEqual(observations, [{ kind: 'not-created' }]);
});

await test('REST create keeps ambiguous 408 entered and settles explicit 425 or 429 rejections', async () => {
  for (const status of [408, 425, 429]) {
    const observations = [];
    const { fetch } = makeFetch({
      'POST /v1/sandboxes': response(status, { error: 'retry later' }),
    });
    const client = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'cap-rest',
      fetch,
    });

    await assert.rejects(
      () =>
        client.createSandbox({
          taskId: `task-retry-${status}`,
          image: 'cap-boxlite:1',
          onSandboxCreateObserved: async (observation) => {
            observations.push(observation);
          },
        }),
      new RegExp(`HTTP ${status}`),
    );
    assert.deepEqual(
      observations,
      status === 408 ? [] : [{ kind: 'not-created' }],
      `HTTP ${status} must use its definitive resource outcome`,
    );
  }
});

await test('REST create does not observe timeout or lost-response failures', async () => {
  for (const failure of [
    new DOMException('request timed out', 'TimeoutError'),
    new Error('connection reset after request was sent'),
  ]) {
    const observations = [];
    const client = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'cap-rest',
      fetch: async () => {
        throw failure;
      },
    });

    await assert.rejects(
      () =>
        client.createSandbox({
          taskId: 'task-ambiguous-create',
          image: 'cap-boxlite:1',
          onSandboxCreateObserved: async (observation) => {
            observations.push(observation);
          },
        }),
      (error) => error === failure,
    );
    assert.deepEqual(observations, []);
  }
});

await test('native REST client creates a sandbox from rootfs_path', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/default/boxes': response(200, {
      box_id: 'rootfs-box',
      task_id: 'task-rootfs',
      status: 'configured',
      rootfs_path: '/var/lib/cap/rootfs',
    }),
    'POST /v1/default/boxes/rootfs-box/start': response(200, {
      box_id: 'rootfs-box',
      task_id: 'task-rootfs',
      status: 'running',
      rootfs_path: '/var/lib/cap/rootfs',
    }),
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
  });

  const sandbox = await client.createSandbox({
    taskId: 'task-rootfs',
    sandboxId: 'rootfs-box',
    rootfsPath: '/var/lib/cap/rootfs',
  });

  assert.equal(sandbox.id, 'rootfs-box');
  assert.equal(sandbox.rootfsPath, '/var/lib/cap/rootfs');
  assert.equal(calls[0].path, '/v1/default/boxes');
  assert.deepEqual(calls[0].body, {
    name: 'rootfs-box',
    rootfs_path: '/var/lib/cap/rootfs',
  });
});

await test('native REST create observes the response id before starting the sandbox', async () => {
  const events = [];
  const { fetch, calls } = makeFetch({
    'POST /v1/default/boxes': () => ({
      ok: true,
      status: 200,
      async json() {
        events.push('create-response');
        return {
          box_id: 'native-immutable-id',
          task_id: 'task-native-observed',
          status: 'configured',
          image: 'cap-boxlite:1',
        };
      },
      async arrayBuffer() {
        return new Uint8Array().buffer;
      },
    }),
    'POST /v1/default/boxes/native-immutable-id/start': () => {
      events.push('start-request');
      return response(200, {
        box_id: 'native-immutable-id',
        task_id: 'task-native-observed',
        status: 'running',
      });
    },
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    pathPrefix: 'default',
    fetch,
  });

  const sandbox = await client.createSandbox({
    taskId: 'task-native-observed',
    sandboxId: 'requested-native-id',
    image: 'cap-boxlite:1',
    onSandboxCreateObserved: async (observation) => {
      events.push(observation);
    },
  });

  assert.equal(sandbox.id, 'native-immutable-id');
  assert.deepEqual(events, [
    'create-response',
    { kind: 'created', providerSandboxId: 'native-immutable-id' },
    'start-request',
  ]);
  assert.deepEqual(calls[0].body, {
    name: 'requested-native-id',
    image: 'cap-boxlite:1',
  });
});

await test('native REST create settles explicit 4xx rejections, keeps 408 entered, and never starts', async () => {
  for (const status of [408, 409, 425, 429]) {
    const observations = [];
    const { fetch, calls } = makeFetch({
      'POST /v1/default/boxes': response(status, { error: 'create rejected' }),
    });
    const client = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      pathPrefix: 'default',
      fetch,
    });

    await assert.rejects(
      () =>
        client.createSandbox({
          taskId: `task-native-rejected-${status}`,
          sandboxId: `native-rejected-${status}`,
          image: 'cap-boxlite:1',
          onSandboxCreateObserved: async (observation) => {
            observations.push(observation);
          },
        }),
      new RegExp(`HTTP ${status}`),
    );

    assert.deepEqual(
      observations,
      status === 408 ? [] : [{ kind: 'not-created' }],
    );
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
      'POST /v1/default/boxes',
    ]);
  }
});

await test('rootfsPath is rejected for cap-rest and ambiguous create sources fail', async () => {
  const harness = makeFetch({});
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: harness.fetch,
  });
  await assert.rejects(
    () => client.createSandbox({ taskId: 'task', rootfsPath: '/rootfs' }),
    /only supported with native protocol mode/,
  );
  await assert.rejects(
    () => client.createSandbox({ taskId: 'task', image: 'img', rootfsPath: '/rootfs' }),
    /either image or rootfsPath, not both/,
  );
  await assert.rejects(
    () => client.createSandbox({ taskId: 'task' }),
    /requires image or rootfsPath/,
  );
  await assert.rejects(
    () =>
      client.createSandbox({
        taskId: 'task',
        image: 'img',
        diskSizeGb: 5,
      }),
    /diskSizeGb create is only supported with native protocol mode/,
  );
  assert.equal(harness.calls.length, 0);
});

await test('REST client exec normalizes nested and snake-case responses', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes/box-task-1/exec': response(200, {
      data: {
        exit_code: 7,
        stdout: 'out',
        stderr: 'err',
        timed_out: true,
      },
    }),
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch,
  });

  const result = await client.exec({
    sandboxId: 'box-task-1',
    command: 'git status',
    cwd: '/workspace',
    timeoutMs: 1000,
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.output, 'outerr');
  assert.equal(result.timedOut, true);
  assert.deepEqual(calls[0].body, {
    command: 'git status',
    cwd: '/workspace',
    timeoutMs: 1000,
  });
});

await test('REST client handles get/delete and archive transfer', async () => {
  const archive = new Uint8Array([9, 8, 7]).buffer;
  const { fetch, calls } = makeFetch({
    'GET /v1/sandboxes/box-task-1': response(200, { id: 'box-task-1' }),
    'GET /v1/sandboxes/missing': response(404, { error: 'gone' }),
    'DELETE /v1/sandboxes/missing': response(404, { error: 'gone' }),
    'PUT /v1/sandboxes/box-task-1/archive?path=%2Fworkspace': response(204, null),
    'GET /v1/sandboxes/box-task-1/archive?path=%2Fworkspace': response(200, null, {
      arrayBuffer: archive,
    }),
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch,
  });

  assert.equal((await client.getSandbox('box-task-1')).id, 'box-task-1');
  assert.equal(await client.getSandbox('missing'), null);
  await client.deleteSandbox('missing');
  await client.uploadArchive({
    sandboxId: 'box-task-1',
    path: '/workspace',
    archive: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual([...(await client.downloadArchive({
    sandboxId: 'box-task-1',
    path: '/workspace',
  }))], [9, 8, 7]);
  assert.deepEqual(calls.at(-2).body, [1, 2, 3]);
});

await test('REST client fails closed on invalid create and failed exec', async () => {
  const invalid = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(200, { data: { state: 'running' } }),
    }).fetch,
  });
  await assert.rejects(
    () => invalid.createSandbox({ taskId: 'task-1', image: 'cap-boxlite:1' }),
    /missing id/,
  );

  const failed = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: makeFetch({
      'POST /v1/sandboxes/box-task-1/exec': response(503, { error: 'down' }),
    }).fetch,
  });
  await assert.rejects(
    () => failed.exec({ sandboxId: 'box-task-1', command: 'true' }),
    /BoxLite request POST \/v1\/sandboxes\/box-task-1\/exec failed: HTTP 503/,
  );
});

await test('native REST client uses BoxLite 0.9 routes for boxes exec and files', async () => {
  const archive = new Uint8Array([5, 4, 3]).buffer;
  const { fetch, calls } = makeFetch({
    'POST /v1/default/boxes': response(200, {
      box_id: 'box-task-1',
      status: 'configured',
      image: 'cap-boxlite:1',
      disk_size_gb: 9,
    }),
    'POST /v1/default/boxes/box-task-1/start': response(200, {
      box_id: 'box-task-1',
      status: 'running',
      image: 'cap-boxlite:1',
    }),
    'GET /v1/default/boxes/box-task-1': response(200, {
      box_id: 'box-task-1',
      status: 'running',
    }),
    'POST /v1/default/boxes/box-task-1/exec': response(200, {
      execution_id: 'exec-1',
    }),
    'GET /v1/default/boxes/box-task-1/executions/exec-1': response(200, {
      status: 'completed',
      exit_code: 0,
      stdout: 'ok',
    }),
    'PUT /v1/default/boxes/box-task-1/files?path=%2Fworkspace': response(204, null),
    'GET /v1/default/boxes/box-task-1/files?path=%2Fworkspace': response(200, null, {
      arrayBuffer: archive,
    }),
    'DELETE /v1/default/boxes/box-task-1': response(204, null),
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    pathPrefix: 'default',
    fetch,
  });

  const sandbox = await client.createSandbox({
    taskId: 'task-1',
    sandboxId: 'box-task-1',
    image: 'cap-boxlite:1',
    diskSizeGb: 9,
    env: { FOO: 'bar' },
    metadata: { workspacePath: '/workspace' },
  });
  assert.equal(sandbox.id, 'box-task-1');
  assert.equal(sandbox.diskSizeGb, 9);
  assert.equal((await client.getSandbox('box-task-1')).id, 'box-task-1');
  const exec = await client.exec({
    sandboxId: 'box-task-1',
    command: 'command -v git',
    cwd: '/workspace',
    timeoutMs: 1000,
  });
  assert.equal(exec.exitCode, 0);
  assert.equal(exec.stdout, 'ok');
  await client.uploadArchive({
    sandboxId: 'box-task-1',
    path: '/workspace',
    archive: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual([...(await client.downloadArchive({
    sandboxId: 'box-task-1',
    path: '/workspace',
  }))], [5, 4, 3]);
  await client.deleteSandbox('box-task-1');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'POST /v1/default/boxes',
    'POST /v1/default/boxes/box-task-1/start',
    'GET /v1/default/boxes/box-task-1',
    'POST /v1/default/boxes/box-task-1/exec',
    'GET /v1/default/boxes/box-task-1/executions/exec-1',
    'PUT /v1/default/boxes/box-task-1/files?path=%2Fworkspace',
    'GET /v1/default/boxes/box-task-1/files?path=%2Fworkspace',
    'DELETE /v1/default/boxes/box-task-1',
  ]);
  assert.deepEqual(calls[0].body, {
    name: 'box-task-1',
    image: 'cap-boxlite:1',
    disk_size_gb: 9,
    env: { FOO: 'bar' },
  });
  assert.deepEqual(calls[3].body, {
    command: 'sh',
    args: ['-lc', 'command -v git'],
    working_dir: '/workspace',
    tty: false,
    timeout_seconds: 1,
  });
});

await test('native start failure exposes the partial create without deleting outside the provider fence', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/default/boxes': response(200, {
      box_id: 'box-partial',
      status: 'configured',
      image: 'cap-boxlite:1',
    }),
    'POST /v1/default/boxes/box-partial/start': response(503, {
      error: 'start unavailable',
    }),
    'DELETE /v1/default/boxes/box-partial': response(204, null),
  });
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    pathPrefix: 'default',
    fetch,
  });

  let failure;
  await assert.rejects(
    () => client.createSandbox({
      taskId: 'task-partial',
      sandboxId: 'box-partial',
      image: 'cap-boxlite:1',
    }),
    (error) => {
      failure = error;
      return error instanceof mod.BoxLitePartialCreateError;
    },
  );

  assert.equal(failure.sandbox.id, 'box-partial');
  assert.match(String(failure.cause), /start.*HTTP 503/);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'POST /v1/default/boxes',
    'POST /v1/default/boxes/box-partial/start',
  ]);
});

await test('native create and start are separately fenced and a rejected start fence makes no start request', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/default/boxes': response(200, {
      box_id: 'box-start-fenced',
      status: 'configured',
      image: 'cap-boxlite:1',
    }),
    'POST /v1/default/boxes/box-start-fenced/start': response(200, {
      box_id: 'box-start-fenced',
      status: 'running',
    }),
  });
  const events = [];
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    pathPrefix: 'default',
    fetch,
  });

  await assert.rejects(
    client.createSandbox({
      taskId: 'task-start-fenced',
      sandboxId: 'box-start-fenced',
      image: 'cap-boxlite:1',
      externalBoundaryGuard: async (event) => {
        events.push(`${event.action}:${event.position}`);
        if (event.action === 'sandbox.start' && event.position === 'before') {
          throw new Error('lease lost before start');
        }
      },
    }),
    (error) =>
      error instanceof mod.BoxLitePartialCreateError &&
      error.cause?.message === 'lease lost before start',
  );

  assert.deepEqual(events, [
    'sandbox.create:before',
    'sandbox.create:after',
    'sandbox.start:before',
  ]);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'POST /v1/default/boxes',
  ]);
});

await test('fake client is deterministic and records calls', async () => {
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => ({
      exitCode: request.command === 'false' ? 1 : 0,
      stdout: 'ok',
      stderr: '',
      output: 'ok',
      timedOut: false,
    }),
  });

  const sandbox = await client.createSandbox({
    taskId: 'task-1',
    sandboxId: 'box-task-1',
    image: 'cap-boxlite:1',
    diskSizeGb: 12,
    metadata: { selected: true },
  });
  assert.equal(sandbox.id, 'box-task-1');
  assert.equal(sandbox.diskSizeGb, 12);
  assert.equal(client.createCalls[0].diskSizeGb, 12);
  assert.equal((await client.getSandbox('box-task-1')).metadata.selected, true);

  const result = await client.exec({ sandboxId: 'box-task-1', command: 'false' });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(client.execCalls.map((call) => call.command), ['false']);

  const uploaded = new Uint8Array([4, 5]);
  await client.uploadArchive({
    sandboxId: 'box-task-1',
    path: '/workspace',
    archive: uploaded,
  });
  uploaded.fill(0);
  assert.deepEqual([...await client.downloadArchive({
    sandboxId: 'box-task-1',
    path: '/workspace',
  })], [4, 5]);

  await client.deleteSandbox('box-task-1');
  assert.equal(await client.getSandbox('box-task-1'), null);
  assert.deepEqual(client.deletedSandboxIds, ['box-task-1']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
