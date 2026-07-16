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

function ownership(ownerGeneration, resourceGeneration) {
  return { ownerGeneration, resourceGeneration };
}

function cleanupAuthorization(
  taskId,
  ownerGeneration,
  resourceGeneration,
  providerId = 'cloud-http',
) {
  return {
    kind: 'generation',
    taskId,
    providerId,
    ownership: { ownerGeneration, resourceGeneration },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
        providerSandboxId: 'cloud-sandbox-task-1',
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
  const selected = await provider.getSelectedSandboxRun('task-1');
  assert.equal(selected.providerSandboxId, 'cloud-sandbox-task-1');
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

await test('durable provision binds the remote request and response to one resource generation', async () => {
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        taskId: 'task-generation',
        baseUrl: 'https://sandbox.example.test/task-generation',
        wsUrl: 'wss://sandbox.example.test/task-generation/ws',
        resourceGeneration: 'resource-generation-1',
      },
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });

  await provider.provision({
    ...provisionContext('task-generation'),
    ownership: {
      ownerGeneration: 'internal-lease-must-not-cross-http',
      resourceGeneration: 'resource-generation-1',
    },
  });

  assert.equal(calls[0].body.resourceGeneration, 'resource-generation-1');
  assert.equal(
    calls[0].headers['idempotency-key'],
    'cap-task:task-generation:resource:resource-generation-1',
  );
  assert.equal(
    JSON.stringify(calls[0]).includes('internal-lease-must-not-cross-http'),
    false,
    'the DB lease generation is internal coordination state',
  );
  const selected = await provider.getSelectedSandboxRun('task-generation');
  assert.equal(
    selected.providerSandboxId,
    undefined,
    'a logical task id must not be persisted as an unattested physical sandbox id',
  );
});

await test('cloud create is fenced before and after the external request', async () => {
  const beforeState = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        taskId: 'task-boundary-before',
        baseUrl: 'https://sandbox.example.test/task-boundary-before',
        wsUrl: 'wss://sandbox.example.test/task-boundary-before/ws',
      },
    }),
  });
  const beforeProvider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: beforeState.fetch,
  });
  const beforeFailure = new Error('lease lost before cloud create');
  await assert.rejects(
    () =>
      beforeProvider.provision({
        ...provisionContext('task-boundary-before'),
        externalBoundaryGuard: async (event) => {
          assert.deepEqual(event, {
            taskId: 'task-boundary-before',
            action: 'sandbox.create',
            position: 'before',
          });
          throw beforeFailure;
        },
      }),
    (error) => error === beforeFailure,
  );
  assert.equal(beforeState.calls.length, 0);

  const afterState = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        taskId: 'task-boundary-after',
        baseUrl: 'https://sandbox.example.test/task-boundary-after',
        wsUrl: 'wss://sandbox.example.test/task-boundary-after/ws',
      },
    }),
  });
  const afterProvider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: afterState.fetch,
  });
  const positions = [];
  const afterFailure = new Error('lease lost after cloud create');
  await assert.rejects(
    () =>
      afterProvider.provision({
        ...provisionContext('task-boundary-after'),
        externalBoundaryGuard: async (event) => {
          positions.push(event.position);
          if (event.position === 'after') throw afterFailure;
        },
      }),
    (error) => error === afterFailure,
  );
  assert.deepEqual(positions, ['before', 'after']);
  assert.equal(afterState.calls.length, 1);
});

await test('cloud observes created and definitive not-created responses inside the create boundary', async () => {
  const order = [];
  const created = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(200, {
        data: {
          taskId: 'task-cloud-observed',
          providerSandboxId: 'cloud-id-observed',
          baseUrl: 'https://sandbox.example.test/task-cloud-observed',
          wsUrl: 'wss://sandbox.example.test/task-cloud-observed/ws',
        },
      }),
    }).fetch,
  });
  await created.provision({
    ...provisionContext('task-cloud-observed'),
    externalBoundaryGuard: async (event) => {
      order.push(event.position);
    },
    onSandboxCreateObserved: async (observation) => {
      order.push(observation);
    },
  });
  assert.deepEqual(order, [
    'before',
    { kind: 'created', providerSandboxId: 'cloud-id-observed' },
    'after',
  ]);

  const rejectedObservations = [];
  const rejected = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(422, { error: 'invalid request' }),
    }).fetch,
  });
  await assert.rejects(
    () =>
      rejected.provision({
        ...provisionContext('task-cloud-rejected'),
        onSandboxCreateObserved: async (observation) => {
          rejectedObservations.push(observation);
        },
      }),
    /POST \/v1\/sandboxes failed: HTTP 422/u,
  );
  assert.deepEqual(rejectedObservations, [{ kind: 'not-created' }]);

  for (const [label, failedFetch] of [
    ['HTTP 408', makeFetch({
      'POST /v1/sandboxes': response(408, { error: 'timeout' }),
    }).fetch],
    ['lost response', async () => {
      throw new Error('response lost');
    }],
  ]) {
    const ambiguousObservations = [];
    const ambiguous = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      fetch: failedFetch,
    });
    await assert.rejects(
      () =>
        ambiguous.provision({
          ...provisionContext(`task-cloud-${label.replaceAll(' ', '-')}`),
          onSandboxCreateObserved: async (observation) => {
            ambiguousObservations.push(observation);
          },
        }),
    );
    assert.deepEqual(ambiguousObservations, [], label);
  }
});

await test('cloud create observes cancellation after an in-flight external request', async () => {
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  const fetchResult = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const calls = [];
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: async (input, init) => {
      calls.push({ input, init });
      markFetchStarted();
      return fetchResult;
    },
  });
  const controller = new AbortController();
  const stopReason = new Error('task stopped during cloud create');
  const provisioning = provider.provision({
    ...provisionContext('task-boundary-cancelled'),
    cancellationSignal: controller.signal,
    externalBoundaryGuard: async () => undefined,
  });

  await fetchStarted;
  controller.abort(stopReason);
  releaseFetch(
    response(200, {
      data: {
        taskId: 'task-boundary-cancelled',
        baseUrl: 'https://sandbox.example.test/task-boundary-cancelled',
        wsUrl: 'wss://sandbox.example.test/task-boundary-cancelled/ws',
      },
    }),
  );

  await assert.rejects(provisioning, (error) => error === stopReason);
  assert.equal(calls.length, 1);
});

await test('deferred cloud create survives an early 404 and late post-guard cleanup removes the exact generation', async () => {
  const taskId = 'task-cloud-deferred-cleanup';
  const createEntered = deferred();
  const releaseCreate = deferred();
  const authorization = cleanupAuthorization(
    taskId,
    'current-owner',
    'deferred-resource',
  );
  const calls = [];
  const events = [];
  let live = false;
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ method: init.method, path: url.pathname, headers: init.headers, body });
      if (init.method === 'POST') {
        createEntered.resolve();
        await releaseCreate.promise;
        live = true;
        return response(200, {
          data: {
            taskId,
            baseUrl: `https://sandbox.example.test/${taskId}`,
            wsUrl: `wss://sandbox.example.test/${taskId}/ws`,
            resourceGeneration: 'deferred-resource',
          },
        });
      }
      if (init.method === 'DELETE') {
        if (!live) return response(404, { error: 'not materialized yet' });
        assert.deepEqual(body, {
          disposition: 'superseded-remove',
          resourceGeneration: 'deferred-resource',
        });
        assert.equal(init.headers['if-match'], '"deferred-resource"');
        live = false;
        return response(204, null);
      }
      return response(404, { error: 'unexpected request' });
    },
  });
  const lateFailure = new Error('lease lost after cloud create returned');
  const provisioning = provider.provision({
    ...provisionContext(taskId),
    ownership: ownership('creating-owner', 'deferred-resource'),
    externalBoundaryGuard: async (event) => {
      if (event.position === 'after') throw lateFailure;
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
    await provider.teardownSandbox(taskId, {
      cleanupAuthorization: authorization,
    }),
    { kind: 'already-absent' },
  );
  assert.deepEqual(events, []);

  releaseCreate.resolve();
  await assert.rejects(provisioning, (error) => error === lateFailure);
  assert.equal(live, false);
  assert.deepEqual(events, [
    'late-cleanup-authorized',
    'late-cleanup-completed',
  ]);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 2);
});

await test('lost cloud create response followed by 404 does not complete cleanup ownership', async () => {
  const taskId = 'task-cloud-lost-create-response';
  const createEntered = deferred();
  const releaseCreate = deferred();
  const lostResponse = new Error('cloud create response was lost');
  const authorization = cleanupAuthorization(
    taskId,
    'current-owner',
    'lost-response-resource',
  );
  const events = [];
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: async (_input, init = {}) => {
      if (init.method === 'POST') {
        createEntered.resolve();
        await releaseCreate.promise;
        throw lostResponse;
      }
      if (init.method === 'DELETE') {
        return response(404, { error: 'not visible yet' });
      }
      return response(404, { error: 'unexpected request' });
    },
  });
  const provisioning = provider.provision({
    ...provisionContext(taskId),
    ownership: ownership('creating-owner', 'lost-response-resource'),
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

await test('durable provision fails closed when the remote does not attest the exact generation', async () => {
  const events = [];
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        taskId: 'task-generation-mismatch',
        baseUrl: 'https://sandbox.example.test/task-generation-mismatch',
        wsUrl: 'wss://sandbox.example.test/task-generation-mismatch/ws',
        resourceGeneration: 'replacement-generation',
      },
    }),
    'DELETE /v1/sandboxes/task-generation-mismatch': response(204, null),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });

  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext('task-generation-mismatch'),
        ownership: {
          ownerGeneration: 'owner-1',
          resourceGeneration: 'expected-generation',
        },
        beforeSandboxCleanup: async () => {
          events.push('cleanup-authorized');
          return cleanupAuthorization(
            'task-generation-mismatch',
            'current-owner',
            'expected-generation',
          );
        },
        afterSandboxCleanup: async (authorization) => {
          assert.deepEqual(
            authorization,
            cleanupAuthorization(
              'task-generation-mismatch',
              'current-owner',
              'expected-generation',
            ),
          );
          events.push('cleanup-confirmed');
        },
      }),
    /did not confirm the requested resource generation/,
  );
  assert.deepEqual(events, ['cleanup-authorized', 'cleanup-confirmed']);
  assert.equal(calls[1].method, 'DELETE');
  assert.deepEqual(calls[1].body, {
    disposition: 'superseded-remove',
    resourceGeneration: 'expected-generation',
  });
  assert.equal(calls[1].headers['if-match'], '"expected-generation"');
});

await test('a superseded cloud worker cannot issue late physical cleanup', async () => {
  const events = [];
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': response(500, { error: 'lost create response' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });

  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext('task-late-cleanup'),
        ownership: {
          ownerGeneration: 'stale-owner',
          resourceGeneration: 'shared-resource-generation',
        },
        beforeSandboxCleanup: async () => {
          events.push('cleanup-rejected');
          return null;
        },
        afterSandboxCleanup: async () => {
          events.push('must-not-complete');
        },
      }),
    /HTTP 500/,
  );
  assert.deepEqual(events, ['cleanup-rejected']);
  assert.equal(
    calls.some((call) => call.method === 'DELETE'),
    false,
  );
});

await test('cloud provisioning capability-gates resources and forwards neutral snapshots', async () => {
  const unsupportedState = makeFetch({});
  const unsupported = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    capabilities: ['terminal.websocket'],
    fetch: unsupportedState.fetch,
  });
  await assert.rejects(
    () =>
      unsupported.provision({
        ...provisionContext('task-unsupported-resource'),
        resources: { diskSizeGb: 8 },
      }),
    /missing capabilities: resource\.disk-size-gb/,
  );
  assert.equal(unsupportedState.calls.length, 0);

  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      taskId: 'task-resource',
      baseUrl: 'https://sandbox.example.test/task-resource',
      wsUrl: 'wss://sandbox.example.test/task-resource/ws',
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    capabilities: [
      'terminal.websocket',
      'workspace.git.materialize',
      'resource.disk-size-gb',
    ],
    fetch,
  });
  const workspace = {
    repositoryUrl: 'https://example.test/repo.git',
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs: 900_000,
  };
  await provider.provision({
    ...provisionContext('task-resource'),
    resources: { diskSizeGb: 8 },
    workspace,
  });
  assert.deepEqual(calls[0].body.resources, { diskSizeGb: 8 });
  assert.deepEqual(calls[0].body.workspace, workspace);
});

await test('cloud provisioning rejects canonical credentials before HTTP create', async () => {
  const canary = 'CAP_CLOUD_UNMIGRATED_CREDENTIAL_CANARY';
  const state = makeFetch({});
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: state.fetch,
  });

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
      /provider-local secret writer/.test(err.message) &&
      !err.message.includes(canary),
  );
  assert.equal(state.calls.length, 0);
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
    'DELETE /v1/sandboxes/task-terminal-missing': response(404, { error: 'gone' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  assert.deepEqual(await provider.teardownSandbox('task-missing'), {
    kind: 'already-absent',
  });
  assert.equal(calls[0].method, 'DELETE');
  assert.deepEqual(
    await provider.teardownSandbox('task-terminal-missing', {
      disposition: 'terminal-retain',
    }),
    { kind: 'already-absent' },
  );

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

await test('owned cloud teardown is generation-conditional and stale cleanup fails closed', async () => {
  const { fetch, calls } = makeFetch({
    'DELETE /v1/sandboxes/task-owned': response(204, null),
    'DELETE /v1/sandboxes/task-stale': response(412, {
      error: 'generation mismatch',
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });

  assert.deepEqual(await provider.teardownSandbox('task-owned', {
    ownership: {
      ownerGeneration: 'owner-current',
      resourceGeneration: 'resource-current',
    },
  }), { kind: 'found-and-cleaned' });
  assert.deepEqual(calls[0].body, {
    disposition: 'superseded-remove',
    resourceGeneration: 'resource-current',
  });
  assert.equal(calls[0].headers['if-match'], '"resource-current"');

  await assert.rejects(
    () =>
      provider.teardownSandbox('task-stale', {
        ownership: {
          ownerGeneration: 'owner-stale',
          resourceGeneration: 'resource-stale',
        },
      }),
    /fenced by resource generation/,
  );
});

await test('terminal-retain confirms an exact retained state even after synchronous 204', async () => {
  let confirmation = 0;
  const delays = [];
  const { fetch, calls } = makeFetch({
    'DELETE /v1/sandboxes/task-retained': response(204, null),
    'GET /v1/sandboxes/task-retained': () => {
      confirmation += 1;
      return response(200, {
        data: {
          providerSandboxId: 'cloud-retained-id',
          resourceGeneration: 'retained-resource',
          status: confirmation === 1 ? 'running' : 'retained',
        },
      });
    },
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
    cleanupPollAttempts: 3,
    cleanupPollIntervalMs: 17,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  assert.deepEqual(
    await provider.teardownSandbox('task-retained', {
      ownership: ownership('retained-owner', 'retained-resource'),
      providerSandboxId: 'cloud-retained-id',
      disposition: 'terminal-retain',
    }),
    { kind: 'found-and-cleaned' },
  );
  assert.deepEqual(calls[0].body, {
    disposition: 'terminal-retain',
    providerSandboxId: 'cloud-retained-id',
    resourceGeneration: 'retained-resource',
  });
  assert.equal(
    calls.filter((call) => call.method === 'GET').length,
    2,
    '204 is only an acknowledgement, not retained-state proof',
  );
  assert.deepEqual(delays, [17]);
});

await test('accepted terminal-retain fails closed when confirmation reports 404', async () => {
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'DELETE /v1/sandboxes/task-retain-removed': response(202, null),
      'GET /v1/sandboxes/task-retain-removed': response(404, { error: 'gone' }),
    }).fetch,
    delay: async () => undefined,
  });
  await assert.rejects(
    () =>
      provider.teardownSandbox('task-retain-removed', {
        disposition: 'terminal-retain',
      }),
    /terminal-retain teardown .* removed the retained sandbox/u,
  );
});

await test('accepted superseded removal polls exact generation to absence and otherwise stays pending', async () => {
  let confirmation = 0;
  const delays = [];
  const { fetch } = makeFetch({
    'DELETE /v1/sandboxes/task-remove-accepted': response(202, null),
    'GET /v1/sandboxes/task-remove-accepted': () => {
      confirmation += 1;
      return confirmation === 1
        ? response(200, {
            data: {
              providerSandboxId: 'cloud-remove-id',
              resourceGeneration: 'remove-resource',
              status: 'deleting',
            },
          })
        : response(404, { error: 'gone' });
    },
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
    cleanupPollAttempts: 3,
    cleanupPollIntervalMs: 23,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  assert.deepEqual(
    await provider.teardownSandbox('task-remove-accepted', {
      ownership: ownership('remove-owner', 'remove-resource'),
      providerSandboxId: 'cloud-remove-id',
      disposition: 'superseded-remove',
    }),
    { kind: 'found-and-cleaned' },
  );
  assert.deepEqual(delays, [23]);

  const pending = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'DELETE /v1/sandboxes/task-remove-pending': response(202, null),
      'GET /v1/sandboxes/task-remove-pending': response(200, {
        data: {
          providerSandboxId: 'cloud-pending-id',
          resourceGeneration: 'pending-resource',
          status: 'deleting',
        },
      }),
    }).fetch,
    cleanupPollAttempts: 2,
    cleanupPollIntervalMs: 0,
    delay: async () => undefined,
  });
  await assert.rejects(
    () =>
      pending.teardownSandbox('task-remove-pending', {
        ownership: ownership('pending-owner', 'pending-resource'),
        providerSandboxId: 'cloud-pending-id',
        disposition: 'superseded-remove',
      }),
    (error) => error?.code === 'sandbox_cleanup_pending',
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

await test('sandboxExists maps HTTP 2xx/404 and fails closed on indeterminate responses', async () => {
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
  await assert.rejects(
    () => provider.sandboxExists('task-error'),
    /existence check for task task-error is indeterminate: HTTP 500/,
  );
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
    'GET /v1/sandboxes/readoptable': response(200, { data: ['task-a', 'task-b'] }),
    'POST /v1/sandboxes/task-a/reattach': response(200, {
      data: {
        taskId: 'task-a',
        baseUrl: 'https://sandbox.example.test/task-a',
        wsUrl: 'wss://sandbox.example.test/task-a/ws',
        terminal: {
          protocol: 'provider-native',
          url: 'wss://sandbox.example.test/task-a/terminal',
        },
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
  assert.deepEqual(
    (await provider.getSelectedSandboxRun('task-a')).terminal,
    {
      protocol: 'provider-native',
      url: 'wss://sandbox.example.test/task-a/terminal',
    },
  );
  assert.equal(await provider.reattach('task-gone'), null);
  assert.equal(await provider.reattach('task-empty'), null);
  await assert.rejects(
    () => provider.reattach('task-error'),
    /reattach for task task-error is indeterminate: HTTP 500/,
  );
  await assert.rejects(
    () => provider.reattach('task-invalid'),
    /did not include a connection object/,
  );
});

await test('targeted cloud readoption sends and verifies the persisted physical target', async () => {
  const target = {
    providerSandboxId: 'cloud-readopt-id',
    ownership: ownership('readopt-owner', 'readopt-resource'),
  };
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes/task-targeted/reattach': response(200, {
      data: {
        taskId: 'task-targeted',
        providerSandboxId: 'cloud-readopt-id',
        resourceGeneration: 'readopt-resource',
        baseUrl: 'https://sandbox.example.test/task-targeted',
        wsUrl: 'wss://sandbox.example.test/task-targeted/ws',
        terminal: {
          protocol: 'aio-json-v1',
          wsUrl: 'wss://sandbox.example.test/task-targeted/ws',
        },
      },
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  assert.equal((await provider.reattach('task-targeted', target))?.taskId, 'task-targeted');
  assert.deepEqual(calls[0].body, {
    providerSandboxId: 'cloud-readopt-id',
    resourceGeneration: 'readopt-resource',
  });
  assert.equal(calls[0].headers['if-match'], '"readopt-resource"');
  assert.equal(
    (await provider.getSelectedSandboxRun('task-targeted')).providerSandboxId,
    'cloud-readopt-id',
  );
  assert.equal(
    (await provider.getSelectedSandboxRun('task-targeted')).terminal.protocol,
    'aio-json-v1',
  );

  for (const [taskId, data, pattern] of [
    [
      'task-wrong-id',
      {
        providerSandboxId: 'replacement-id',
        resourceGeneration: 'readopt-resource',
      },
      /provider sandbox id does not match persisted target/u,
    ],
    [
      'task-wrong-generation',
      {
        providerSandboxId: 'cloud-readopt-id',
        resourceGeneration: 'replacement-resource',
      },
      /resource generation does not match persisted target/u,
    ],
  ]) {
    const mismatched = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      fetch: makeFetch({
        [`POST /v1/sandboxes/${taskId}/reattach`]: response(200, {
          data: {
            taskId,
            ...data,
            baseUrl: `https://sandbox.example.test/${taskId}`,
            wsUrl: `wss://sandbox.example.test/${taskId}/ws`,
          },
        }),
      }).fetch,
    });
    await assert.rejects(
      () => mismatched.reattach(taskId, target),
      pattern,
    );
    assert.equal(await mismatched.getSelectedSandboxRun(taskId), null);
  }
});

await test('readoption list accepts a genuinely empty inventory', async () => {
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'GET /v1/sandboxes/readoptable': response(200, { data: [] }),
    }).fetch,
  });
  assert.deepEqual(await provider.listReadoptable(), []);
});

await test('readoption list rejects indeterminate 200 responses', async () => {
  const nonArray = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'GET /v1/sandboxes/readoptable': response(200, { data: null }),
    }).fetch,
  });
  await assert.rejects(
    () => nonArray.listReadoptable(),
    /readoption inventory is indeterminate: response did not include a task id array/,
  );

  const invalidJson = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'GET /v1/sandboxes/readoptable': throwingJsonResponse(200),
    }).fetch,
  });
  await assert.rejects(
    () => invalidJson.listReadoptable(),
    /readoption inventory is indeterminate: response was not valid JSON/,
  );

  for (const data of [
    ['task-a', 1],
    ['task-a', ''],
    ['task-a', '   '],
    ['task-a', ' task-b'],
    ['task-a', 'task-b '],
  ]) {
    const invalidTaskId = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      fetch: makeFetch({
        'GET /v1/sandboxes/readoptable': response(200, { data }),
      }).fetch,
    });
    await assert.rejects(
      () => invalidTaskId.listReadoptable(),
      /readoption inventory is indeterminate: response included an invalid task id/,
    );
  }
});

await test('readoption list preserves HTTP failure errors', async () => {
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
