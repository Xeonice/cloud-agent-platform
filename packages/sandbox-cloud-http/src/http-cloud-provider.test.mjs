import assert from 'node:assert/strict';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(new URL('../../sandbox-core/dist/index.js', import.meta.url).href);
const conformance = await import(new URL('../../sandbox-conformance/dist/index.js', import.meta.url).href);

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

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function throwingJsonResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      throw new Error('invalid json');
    },
  };
}

function makeFetch(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
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

function provisionContext(taskId, cloneSpec) {
  return {
    taskId,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    ...(cloneSpec === undefined ? {} : { cloneSpec }),
  };
}

await test('defineHttpCloudSandboxProvider returns a cloud descriptor with declared capabilities', () => {
  const { fetch } = makeFetch({});
  const descriptor = mod.defineHttpCloudSandboxProvider({
    id: 'managed-cloud',
    baseUrl: 'https://cloud.example.test/',
    apiToken: 'token',
    fetch,
    priority: 30,
    capabilities: ['terminal.websocket'],
  });
  assert.equal(descriptor.id, 'managed-cloud');
  assert.equal(descriptor.location, 'cloud');
  assert.equal(descriptor.priority, 30);
  assert.deepEqual(descriptor.capabilities, ['terminal.websocket']);

  const defaultDescriptor = mod.defineHttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  assert.equal(defaultDescriptor.id, 'cloud-http');
  assert.deepEqual(defaultDescriptor.capabilities, core.SANDBOX_PROVIDER_CAPABILITIES);
});

await test('provider defaults mode, capabilities, timeout, and global fetch', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return response(200, { data: { id: 'task-default' } });
  };
  try {
    const provider = new mod.HttpCloudSandboxProvider({
      baseUrl: ' https://cloud.example.test/ ',
    });
    assert.equal(provider.getSandboxMode(), 'workspace-write');
    assert.deepEqual(provider.getProviderCapabilities(), core.SANDBOX_PROVIDER_CAPABILITIES);
    assert.equal(await provider.sandboxExists('task-default'), true);
    assert.equal(calls[0].input, 'https://cloud.example.test/v1/sandboxes/task-default');
    assert.equal(calls[0].init.headers.authorization, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('provision posts selected cloneSpec and returns the cloud connection', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        taskId: 'task-1',
        baseUrl: 'https://sandbox.example.test/task-1',
        wsUrl: 'wss://sandbox.example.test/task-1/ws',
      },
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test/',
    apiToken: 'secret',
    fetch,
  });
  const connection = await provider.provision({
    ...provisionContext('task-1', {
      url: 'https://github.com/acme/repo.git',
    }),
    environment: {
      providerId: 'cloud-prod',
      providerFamily: 'cloud-http',
      runtimeId: 'codex',
      sourceKind: 'image',
      sourceRef: 'cap-cloud@sha256:runtime',
      digest: 'sha256:runtime',
      checksum: 'sha256:metadata',
    },
  });
  assert.deepEqual(connection, {
    taskId: 'task-1',
    baseUrl: 'https://sandbox.example.test/task-1',
    wsUrl: 'wss://sandbox.example.test/task-1/ws',
  });
  assert.equal(calls[0].url, 'https://cloud.example.test/v1/sandboxes');
  assert.equal(calls[0].headers.authorization, 'Bearer secret');
  assert.deepEqual(calls[0].body, {
    taskId: 'task-1',
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    cloneSpec: { url: 'https://github.com/acme/repo.git' },
    environment: {
      providerId: 'cloud-prod',
      providerFamily: 'cloud-http',
      runtimeId: 'codex',
      sourceKind: 'image',
      sourceRef: 'cap-cloud@sha256:runtime',
      digest: 'sha256:runtime',
      checksum: 'sha256:metadata',
    },
  });
});

await test('provision omits cloneSpec when absent and accepts unwrapped fallback task ids', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      baseUrl: 'https://sandbox.example.test/task-raw',
      wsUrl: 'wss://sandbox.example.test/task-raw/ws',
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    mode: 'danger-full-access',
    capabilities: ['terminal.websocket'],
    timeoutMs: 1234,
    fetch,
  });
  assert.equal(provider.getSandboxMode(), 'danger-full-access');
  assert.deepEqual(provider.getProviderCapabilities(), ['terminal.websocket']);
  assert.deepEqual(await provider.provision(provisionContext('task-raw')), {
    taskId: 'task-raw',
    baseUrl: 'https://sandbox.example.test/task-raw',
    wsUrl: 'wss://sandbox.example.test/task-raw/ws',
  });
  assert.deepEqual(calls[0].body, {
    taskId: 'task-raw',
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
  });
  assert.equal(calls[0].headers.authorization, undefined);
});

await test('provision fails closed for HTTP and invalid connection responses', async () => {
  const { fetch } = makeFetch({
    'POST /v1/sandboxes': response(500, { error: 'boom' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  await assert.rejects(
    () => provider.provision(provisionContext('task-fail')),
    /cloud sandbox request POST \/v1\/sandboxes failed: HTTP 500/,
  );

  const invalid = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(200, null),
    }).fetch,
  });
  await assert.rejects(
    () => invalid.provision(provisionContext('task-invalid')),
    /did not include a connection object/,
  );

  const missingUrl = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(200, {
        data: { taskId: 'task-invalid', baseUrl: 'https://sandbox.example.test' },
      }),
    }).fetch,
  });
  await assert.rejects(
    () => missingUrl.provision(provisionContext('task-invalid')),
    /missing baseUrl or wsUrl/,
  );

  const badBaseUrl = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(200, {
        data: { taskId: 'task-invalid', baseUrl: 1, wsUrl: 'wss://sandbox/ws' },
      }),
    }).fetch,
  });
  await assert.rejects(
    () => badBaseUrl.provision(provisionContext('task-invalid')),
    /missing baseUrl or wsUrl/,
  );
});

await test('teardown is idempotent for missing cloud sandboxes', async () => {
  const { fetch, calls } = makeFetch({
    'DELETE /v1/sandboxes/task-missing': response(404, { error: 'gone' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  await provider.teardownSandbox('task-missing');
  assert.equal(calls[0].method, 'DELETE');

  const failing = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'DELETE /v1/sandboxes/task-fail': response(500, { error: 'boom' }),
    }).fetch,
  });
  await assert.rejects(
    () => failing.teardownSandbox('task-fail'),
    /teardown for task task-fail failed: HTTP 500/,
  );
});

await test('retained transcript reads return source, null on missing, and include runtime query', async () => {
  const { fetch, calls } = makeFetch({
    'GET /v1/sandboxes/task-1/transcript?runtimeId=codex': response(200, {
      data: { format: 'codex-rollout', jsonl: '{"type":"turn"}\n' },
    }),
    'GET /v1/sandboxes/task-2/transcript': response(404, { error: 'gone' }),
    'GET /v1/sandboxes/task-3/transcript': response(204, null),
    'GET /v1/sandboxes/task-4/transcript': response(500, { error: 'boom' }),
    'GET /v1/sandboxes/task-5/transcript': response(200, { data: { format: 1 } }),
    'GET /v1/sandboxes/task-6/transcript': throwingJsonResponse(200),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  assert.deepEqual(await provider.readRolloutFromContainer('task-1', 'codex'), {
    format: 'codex-rollout',
    jsonl: '{"type":"turn"}\n',
  });
  assert.equal(await provider.readRolloutFromContainer('task-2'), null);
  assert.equal(await provider.readRolloutFromContainer('task-3', null), null);
  assert.equal(await provider.readRolloutFromContainer('task-4'), null);
  assert.equal(await provider.readRolloutFromContainer('task-5'), null);
  assert.equal(await provider.readRolloutFromContainer('task-6'), null);
  assert.equal(calls[0].path, '/v1/sandboxes/task-1/transcript?runtimeId=codex');
});

await test('sandboxExists maps HTTP 2xx to true and 404 to false', async () => {
  const { fetch } = makeFetch({
    'GET /v1/sandboxes/task-live': response(200, { data: { id: 'task-live' } }),
    'GET /v1/sandboxes/task-gone': response(404, { error: 'gone' }),
    'GET /v1/sandboxes/task-error': response(500, { error: 'boom' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  assert.equal(await provider.sandboxExists('task-live'), true);
  assert.equal(await provider.sandboxExists('task-gone'), false);
  assert.equal(await provider.sandboxExists('task-error'), false);
});

await test('delivery returns parsed result and fail-open HTTP errors', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes/task-1/deliver': response(200, {
      data: { hadChanges: true, commitSha: 'abc123', error: null },
    }),
    'POST /v1/sandboxes/task-2/deliver': response(500, { error: 'boom' }),
    'POST /v1/sandboxes/task-3/deliver': response(200, null),
    'POST /v1/sandboxes/task-4/deliver': response(200, {
      data: { hadChanges: false, commitSha: 123, error: 456 },
    }),
    'POST /v1/sandboxes/task-5/deliver': response(200, {
      data: { hadChanges: false, commitSha: null, error: 'push rejected' },
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  const args = {
    authHeader: 'Authorization: Basic secret',
    branch: 'cap/task-1',
    commitMessage: 'message',
  };
  assert.deepEqual(await provider.deliverWorkspaceChanges('task-1', args), {
    hadChanges: true,
    commitSha: 'abc123',
    error: null,
  });
  assert.deepEqual(await provider.deliverWorkspaceChanges('task-2', args), {
    hadChanges: false,
    commitSha: null,
    error: 'cloud delivery HTTP 500',
  });
  assert.deepEqual(await provider.deliverWorkspaceChanges('task-3', args), {
    hadChanges: false,
    commitSha: null,
    error: 'cloud delivery response was invalid',
  });
  assert.deepEqual(await provider.deliverWorkspaceChanges('task-4', args), {
    hadChanges: false,
    commitSha: null,
    error: null,
  });
  assert.deepEqual(await provider.deliverWorkspaceChanges('task-5', args), {
    hadChanges: false,
    commitSha: null,
    error: 'push rejected',
  });
  assert.deepEqual(calls[0].body, args);
});

await test('readoption list and reattach use cloud lifecycle endpoints', async () => {
  const { fetch } = makeFetch({
    'GET /v1/sandboxes/readoptable': response(200, { data: ['task-a', 'task-b', 1] }),
    'GET /v1/sandboxes/readoptable-empty': response(200, { data: null }),
    'POST /v1/sandboxes/task-a/reattach': response(200, {
      data: {
        taskId: 'task-a',
        baseUrl: 'https://sandbox.example.test/task-a',
        wsUrl: 'wss://sandbox.example.test/task-a/ws',
      },
    }),
    'POST /v1/sandboxes/task-gone/reattach': response(404, { error: 'gone' }),
    'POST /v1/sandboxes/task-empty/reattach': response(204, null),
    'POST /v1/sandboxes/task-error/reattach': response(500, { error: 'boom' }),
    'POST /v1/sandboxes/task-invalid/reattach': response(200, { data: null }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  assert.deepEqual(await provider.listReadoptable(), ['task-a', 'task-b']);
  assert.deepEqual(await provider.reattach('task-a'), {
    taskId: 'task-a',
    baseUrl: 'https://sandbox.example.test/task-a',
    wsUrl: 'wss://sandbox.example.test/task-a/ws',
  });
  assert.equal(await provider.reattach('task-gone'), null);
  assert.equal(await provider.reattach('task-empty'), null);
  assert.equal(await provider.reattach('task-error'), null);
  await assert.rejects(
    () => provider.reattach('task-invalid'),
    /did not include a connection object/,
  );
});

await test('readoption list handles non-array responses and HTTP failures', async () => {
  const nonArray = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'GET /v1/sandboxes/readoptable': response(200, { data: null }),
    }).fetch,
  });
  assert.deepEqual(await nonArray.listReadoptable(), []);

  const invalidJson = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'GET /v1/sandboxes/readoptable': throwingJsonResponse(200),
    }).fetch,
  });
  assert.deepEqual(await invalidJson.listReadoptable(), []);

  const failing = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'GET /v1/sandboxes/readoptable': response(500, { error: 'boom' }),
    }).fetch,
  });
  await assert.rejects(
    () => failing.listReadoptable(),
    /cloud sandbox request GET \/v1\/sandboxes\/readoptable failed: HTTP 500/,
  );
});

await test('cloud provider passes the shared sandbox provider conformance scenarios', async () => {
  const taskId = 'task-conformance';
  const { fetch } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        taskId,
        baseUrl: `https://sandbox.example.test/${taskId}`,
        wsUrl: `wss://sandbox.example.test/${taskId}/ws`,
      },
    }),
    [`GET /v1/sandboxes/${taskId}`]: response(200, { data: { id: taskId } }),
    [`POST /v1/sandboxes/${taskId}/deliver`]: response(200, {
      data: { hadChanges: true, commitSha: 'abc123', error: null },
    }),
    [`GET /v1/sandboxes/${taskId}/transcript?runtimeId=codex`]: response(200, {
      data: { format: 'codex-rollout', jsonl: '{"type":"turn"}\n' },
    }),
    'GET /v1/sandboxes/readoptable': response(200, { data: [taskId] }),
    [`POST /v1/sandboxes/${taskId}/reattach`]: response(200, {
      data: {
        taskId,
        baseUrl: `https://sandbox.example.test/${taskId}`,
        wsUrl: `wss://sandbox.example.test/${taskId}/ws`,
      },
    }),
    [`DELETE /v1/sandboxes/${taskId}`]: response(204, null),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  const scenarios = conformance.createSandboxProviderConformanceScenarios(
    {
      provider,
      taskId,
      cloneSpec: { url: 'https://github.com/acme/repo.git' },
      runtimeId: 'codex',
      requiredCapabilities: core.SANDBOX_PROVIDER_CAPABILITIES,
    },
    assert,
  );

  for (const scenario of scenarios) {
    await scenario.run();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
