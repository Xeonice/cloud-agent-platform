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

function cloudCreateResponse(taskId, options = {}) {
  return response(200, {
    data: {
      taskId,
      providerSandboxId: options.providerSandboxId ?? `cloud-${taskId}`,
      baseUrl: `https://sandbox.example.test/${taskId}`,
      wsUrl: `wss://sandbox.example.test/${taskId}/ws`,
      ...(options.resourceGeneration === undefined
        ? {}
        : { resourceGeneration: options.resourceGeneration }),
    },
  });
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

function cleanupSucceeded(proof) {
  return { outcome: 'succeeded', proof, cause: null, retryable: false };
}

function cleanupFailed(retryable = false) {
  return {
    outcome: 'failed',
    proof: null,
    cause: 'cleanup_failed',
    retryable,
  };
}

function cleanupIndeterminate() {
  return {
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function diagnosticUuid(index) {
  return `71000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function taskDiagnosticHarness(options = {}) {
  const events = [];
  let eventId = options.eventId ?? 100;
  let operationId = options.operationId ?? 200;
  let recordCalls = 0;
  const emitter = core.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId:
        options.taskId ?? '71000000-0000-4000-8000-000000000001',
      attemptId:
        options.attemptId ?? '71000000-0000-4000-8000-000000000002',
      attempt: options.attempt ?? 1,
      admissionMode: 'durable',
      providerFamily: options.providerFamily ?? 'unknown',
    },
    createEventId: () => diagnosticUuid(eventId++),
    createOperationId: () => diagnosticUuid(operationId++),
    now: () => new Date('2026-07-17T08:00:00.000Z'),
    record: async (event) => {
      recordCalls += 1;
      if (options.recordError !== undefined) throw options.recordError;
      events.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  return {
    emitter,
    events,
    taskId: emitter.attemptContext.taskId,
    get recordCalls() {
      return recordCalls;
    },
  };
}

function operationEvents(events, operation) {
  return events.filter((event) => event.operation === operation);
}

function assertDiagnosticPairs(events) {
  const operations = new Map();
  for (const event of events) {
    const retained = operations.get(event.operationId) ?? [];
    retained.push(event);
    operations.set(event.operationId, retained);
  }
  for (const retained of operations.values()) {
    assert.equal(retained.length, 2);
    assert.equal(retained[0].outcome, 'started');
    assert.notEqual(retained[1].outcome, 'started');
  }
}

async function captureRejection(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to reject');
}

function settleBeforeImmediate(promise) {
  return new Promise((resolve) => {
    promise.then(
      (value) => resolve({ status: 'fulfilled', value }),
      (reason) => resolve({ status: 'rejected', reason }),
    );
    setImmediate(() => resolve({ status: 'pending' }));
  });
}

function neverSettlingDiagnostics(taskId) {
  let providerFamily = 'unknown';
  let operationId = 900;
  const never = new Promise(() => undefined);
  return Object.freeze({
    mode: 'task',
    get attemptContext() {
      return {
        schemaVersion: 1,
        taskId,
        attemptId: '71000000-0000-4000-8000-000000000099',
        attempt: 1,
        admissionMode: 'durable',
        providerFamily,
      };
    },
    bindProviderFamily(nextProviderFamily) {
      providerFamily = nextProviderFamily;
    },
    createOperationId() {
      return diagnosticUuid(operationId++);
    },
    emit() {
      return never;
    },
  });
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
  assert.deepEqual(
    defaultDescriptor.capabilities,
    mod.HTTP_CLOUD_SANDBOX_PROVIDER_CAPABILITIES,
  );
});

await test('cloud provider rejects unsupported canonical workspace capability declarations', () => {
  const { fetch, calls } = makeFetch({});
  for (const capabilities of [
    ['workspace.git.materialize'],
    ['workspace.git.deliver'],
    ['terminal.websocket', 'workspace.git.materialize', 'workspace.git.deliver'],
  ]) {
    assert.throws(
      () =>
        new mod.HttpCloudSandboxProvider({
          baseUrl: 'https://cloud.example.test',
          capabilities,
          fetch,
        }),
      (error) =>
        error?.code === 'sandbox_provider_configuration_error' &&
        /unsupported canonical workspace capabilities/u.test(error.message),
    );
    assert.throws(
      () =>
        mod.defineHttpCloudSandboxProvider({
          baseUrl: 'https://cloud.example.test',
          capabilities,
          fetch,
        }),
      (error) =>
        error?.code === 'sandbox_provider_configuration_error' &&
        /unsupported canonical workspace capabilities/u.test(error.message),
    );
  }
  assert.equal(calls.length, 0);
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
    assert.deepEqual(
      provider.getProviderCapabilities(),
      mod.HTTP_CLOUD_SANDBOX_PROVIDER_CAPABILITIES,
    );
    assert.equal(await provider.sandboxExists('task-default'), true);
    assert.equal(calls[0].input, 'https://cloud.example.test/v1/sandboxes/task-default');
    assert.equal(calls[0].init.headers.authorization, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('cloud provider rejects invalid cleanup polling bounds', () => {
  for (const cleanupPollAttempts of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        new mod.HttpCloudSandboxProvider({
          baseUrl: 'https://cloud.example.test',
          cleanupPollAttempts,
          fetch: makeFetch({}).fetch,
        }),
      /cleanupPollAttempts must be a positive safe integer/u,
    );
  }
  for (const cleanupPollIntervalMs of [-1, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        new mod.HttpCloudSandboxProvider({
          baseUrl: 'https://cloud.example.test',
          cleanupPollIntervalMs,
          fetch: makeFetch({}).fetch,
        }),
      /cleanupPollIntervalMs must be a non-negative safe integer/u,
    );
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

  const unattestedObservations = [];
  const unattested = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(200, {
        data: {
          taskId: 'task-cloud-unattested',
          baseUrl: 'https://sandbox.example.test/task-cloud-unattested',
          wsUrl: 'wss://sandbox.example.test/task-cloud-unattested/ws',
        },
      }),
    }).fetch,
  });
  await unattested.provision({
    ...provisionContext('task-cloud-unattested'),
    onSandboxCreateObserved: async (observation) => {
      unattestedObservations.push(observation);
    },
  });
  assert.deepEqual(unattestedObservations, [{ kind: 'created' }]);

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

await test('created-observation rejection remains a coordination failure after confirmed cleanup', async () => {
  const taskId = '71000000-0000-4000-8000-000000000004';
  const resource = ownership('observed-owner', 'observed-resource');
  const authorization = cleanupAuthorization(
    taskId,
    resource.ownerGeneration,
    resource.resourceGeneration,
  );
  const observationFailure = new Error('create observation persistence failed');
  const diagnostics = taskDiagnosticHarness({ taskId });
  const events = [];
  const state = makeFetch({
    'POST /v1/sandboxes': cloudCreateResponse(taskId, {
      providerSandboxId: 'cloud-observation-rejected',
      resourceGeneration: resource.resourceGeneration,
    }),
    [`DELETE /v1/sandboxes/${taskId}`]: response(204, null),
    [`GET /v1/sandboxes/${taskId}`]: response(404, { error: 'gone' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: state.fetch,
  });

  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext(taskId),
        diagnostics: diagnostics.emitter,
        ownership: resource,
        onSandboxCreateObserved: async () => {
          events.push('observation-rejected');
          throw observationFailure;
        },
        beforeSandboxCleanup: async () => {
          events.push('cleanup-authorized');
          return authorization;
        },
        afterSandboxCleanup: async () => {
          events.push('cleanup-confirmed');
        },
      }),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      error.primary === observationFailure &&
      Object.keys(error).includes('primary') === false,
  );
  assert.deepEqual(events, [
    'observation-rejected',
    'cleanup-authorized',
    'cleanup-confirmed',
  ]);
  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['POST', 'DELETE', 'GET'],
  );
  assert.equal(
    operationEvents(diagnostics.events, 'sandbox_create').at(-1).outcome,
    'succeeded',
  );
  assertDiagnosticPairs(diagnostics.events);
});

await test('not-created observation rejection preserves the HTTP primary without cleanup', async () => {
  const taskId = '71000000-0000-4000-8000-000000000005';
  const diagnostics = taskDiagnosticHarness({ taskId });
  const observationFailure = new Error('must remain secondary');
  const state = makeFetch({
    'POST /v1/sandboxes': response(422, { error: 'invalid create' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: state.fetch,
  });
  let cleanupAuthorizationCalls = 0;

  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext(taskId),
        diagnostics: diagnostics.emitter,
        ownership: ownership('not-created-owner', 'not-created-resource'),
        onSandboxCreateObserved: async (observation) => {
          assert.deepEqual(observation, { kind: 'not-created' });
          throw observationFailure;
        },
        beforeSandboxCleanup: async () => {
          cleanupAuthorizationCalls += 1;
          return cleanupAuthorization(
            taskId,
            'not-created-owner',
            'not-created-resource',
          );
        },
      }),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      error.primary !== observationFailure &&
      /HTTP 422/u.test(error.primary?.message ?? ''),
  );
  assert.equal(cleanupAuthorizationCalls, 0);
  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['POST'],
  );
  assert.deepEqual(
    operationEvents(diagnostics.events, 'sandbox_create').map(
      (event) => event.outcome,
    ),
    ['started', 'failed'],
  );
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
    cleanupSucceeded('already-absent'),
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

await test('lost cloud create response followed by DELETE 404 completes cleanup ownership', async () => {
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
      events.push('cleanup-completed');
    },
  });

  await createEntered.promise;
  releaseCreate.resolve();
  await assert.rejects(provisioning, (error) => error === lostResponse);
  assert.deepEqual(events, ['cleanup-authorized', 'cleanup-completed']);
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
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      /HTTP 500/u.test(error.primary?.message ?? '') &&
      Object.keys(error).includes('primary') === false,
  );
  assert.deepEqual(events, ['cleanup-rejected']);
  assert.equal(
    calls.some((call) => call.method === 'DELETE'),
    false,
  );
});

await test('failed cloud provisioning keeps cleanup coordination failures secondary and fenced', async () => {
  const cases = [
    {
      label: 'authorization-throws',
      before: async () => {
        throw new Error('authorization unavailable');
      },
      deleteStatus: 404,
    },
    {
      label: 'authorization-provider-mismatch',
      before: async (taskId) =>
        cleanupAuthorization(
          taskId,
          'cleanup-owner',
          'cleanup-resource',
          'replacement-provider',
        ),
      deleteStatus: 404,
    },
    {
      label: 'authorization-generation-mismatch',
      before: async (taskId) =>
        cleanupAuthorization(
          taskId,
          'cleanup-owner',
          'replacement-resource',
        ),
      deleteStatus: 404,
    },
    {
      label: 'physical-cleanup-fenced',
      before: async (taskId) =>
        cleanupAuthorization(
          taskId,
          'cleanup-owner',
          'cleanup-resource',
        ),
      deleteStatus: 412,
    },
    {
      label: 'cleanup-ack-rejected',
      before: async (taskId) =>
        cleanupAuthorization(
          taskId,
          'cleanup-owner',
          'cleanup-resource',
        ),
      deleteStatus: 404,
      after: async () => {
        throw new Error('cleanup acknowledgement unavailable');
      },
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const taskId = `task-cloud-coordination-${index}`;
    const state = makeFetch({
      'POST /v1/sandboxes': response(500, { error: 'create unavailable' }),
      [`DELETE /v1/sandboxes/${taskId}`]: response(entry.deleteStatus, {
        error: 'cleanup result',
      }),
    });
    const provider = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      fetch: state.fetch,
    });
    await assert.rejects(
      () =>
        provider.provision({
          ...provisionContext(taskId),
          ownership: ownership('creating-owner', 'cleanup-resource'),
          beforeSandboxCleanup: () => entry.before(taskId),
          ...(entry.after === undefined
            ? {}
            : { afterSandboxCleanup: entry.after }),
        }),
      (error) =>
        error?.code === 'sandbox_cleanup_coordination_pending' &&
        /HTTP 500/u.test(error.primary?.message ?? ''),
      entry.label,
    );
  }

  const legacyTaskId = 'task-cloud-legacy-cleanup';
  const legacyPrimary = new Error('legacy create transport failed');
  const legacyEvents = [];
  const legacyProvider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': () => {
        throw legacyPrimary;
      },
      [`DELETE /v1/sandboxes/${legacyTaskId}`]: response(404, {
        error: 'gone',
      }),
    }).fetch,
  });
  const legacyAuthorization = {
    kind: 'legacy',
    taskId: legacyTaskId,
    providerId: 'cloud-http',
  };
  await assert.rejects(
    () =>
      legacyProvider.provision({
        ...provisionContext(legacyTaskId),
        beforeSandboxCleanup: async () => legacyAuthorization,
        afterSandboxCleanup: async (authorization) => {
          assert.equal(authorization, legacyAuthorization);
          legacyEvents.push('cleanup-acknowledged');
        },
      }),
    (error) => error === legacyPrimary,
  );
  assert.deepEqual(legacyEvents, ['cleanup-acknowledged']);

  const defensiveProvider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(500, { error: 'create unavailable' }),
    }).fetch,
  });
  defensiveProvider.cleanupFailedProvision = async () => {
    throw new Error('unexpected cleanup adapter failure');
  };
  await assert.rejects(
    () =>
      defensiveProvider.provision(
        provisionContext('task-cloud-defensive-cleanup'),
      ),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      /HTTP 500/u.test(error.primary?.message ?? ''),
  );

  const replayTaskId = 'task-cloud-replay-cleanup-target';
  let replayCreates = 0;
  const replayState = makeFetch({
    'POST /v1/sandboxes': () => {
      replayCreates += 1;
      return replayCreates === 1
        ? cloudCreateResponse(replayTaskId, {
            providerSandboxId: 'stored-provider-sandbox',
            resourceGeneration: 'replay-resource',
          })
        : response(500, { error: 'replay create unavailable' });
    },
    [`DELETE /v1/sandboxes/${replayTaskId}`]: ({ body }) => {
      assert.equal(body.providerSandboxId, 'stored-provider-sandbox');
      return response(404, { error: 'gone' });
    },
  });
  const replayProvider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: replayState.fetch,
  });
  const replayOwnership = ownership('replay-owner', 'replay-resource');
  await replayProvider.provision({
    ...provisionContext(replayTaskId),
    ownership: replayOwnership,
  });
  await assert.rejects(
    () =>
      replayProvider.provision({
        ...provisionContext(replayTaskId),
        ownership: replayOwnership,
        beforeSandboxCleanup: async () =>
          cleanupAuthorization(
            replayTaskId,
            replayOwnership.ownerGeneration,
            replayOwnership.resourceGeneration,
          ),
      }),
    /HTTP 500/u,
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
      'resource.disk-size-gb',
    ],
    fetch,
  });
  await provider.provision({
    ...provisionContext('task-resource'),
    resources: { diskSizeGb: 8 },
  });
  assert.deepEqual(calls[0].body.resources, { diskSizeGb: 8 });
});

await test('cloud provisioning rejects canonical credentials before HTTP create', async () => {
  const canary = 'CAP_CLOUD_UNMIGRATED_CREDENTIAL_CANARY';
  const diagnostics = taskDiagnosticHarness({
    taskId: '71000000-0000-4000-8000-000000000003',
  });
  const state = makeFetch({});
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: state.fetch,
  });

  await assert.rejects(
    () =>
      provider.provision({
        ...provisionContext(diagnostics.taskId),
        diagnostics: diagnostics.emitter,
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
  assert.equal(diagnostics.recordCalls, 0);
  assert.deepEqual(diagnostics.events, []);
  assert.equal(diagnostics.emitter.attemptContext.providerFamily, 'cloud-http');
});

await test('never-settling diagnostics cannot stall cloud create, failure, or cleanup', async () => {
  const taskId = '71000000-0000-4000-8000-000000000006';
  const diagnostics = neverSettlingDiagnostics(taskId);
  const state = makeFetch({
    'POST /v1/sandboxes': cloudCreateResponse(taskId),
    [`DELETE /v1/sandboxes/${taskId}`]: response(204, null),
    [`GET /v1/sandboxes/${taskId}`]: response(404, { error: 'gone' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: state.fetch,
  });

  const created = await settleBeforeImmediate(
    provider.provision({
      ...provisionContext(taskId),
      diagnostics,
    }),
  );
  assert.equal(created.status, 'fulfilled');
  assert.equal(created.value.taskId, taskId);
  const cleanup = await settleBeforeImmediate(provider.teardownSandbox(taskId));
  assert.deepEqual(cleanup, {
    status: 'fulfilled',
    value: cleanupSucceeded('found-and-cleaned'),
  });

  const failedTaskId = '71000000-0000-4000-8000-000000000007';
  const failedState = makeFetch({
    'POST /v1/sandboxes': response(500, { error: 'unavailable' }),
  });
  const failingProvider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: failedState.fetch,
  });
  const failed = await settleBeforeImmediate(
    failingProvider.provision({
      ...provisionContext(failedTaskId),
      diagnostics: neverSettlingDiagnostics(failedTaskId),
    }),
  );
  assert.equal(failed.status, 'rejected');
  assert.match(failed.reason.message, /HTTP 500/u);
  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['POST', 'DELETE', 'GET'],
  );
  assert.equal(failedState.calls.length, 1);
});

await test('synchronous diagnostic operation-id and emit failures remain evidence-only', async () => {
  const taskId = '71000000-0000-4000-8000-000000000008';
  const harness = taskDiagnosticHarness({ taskId });
  const operationIdFailure = new Error('diagnostic id generator unavailable');
  const diagnostics = Object.freeze({
    mode: 'task',
    get attemptContext() {
      return harness.emitter.attemptContext;
    },
    bindProviderFamily(providerFamily) {
      return harness.emitter.bindProviderFamily(providerFamily);
    },
    createOperationId() {
      throw operationIdFailure;
    },
    emit(fact) {
      return harness.emitter.emit(fact);
    },
  });
  const state = makeFetch({
    'POST /v1/sandboxes': cloudCreateResponse(taskId),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: state.fetch,
  });

  const connection = await provider.provision({
    ...provisionContext(taskId),
    diagnostics,
  });
  assert.equal(connection.taskId, taskId);
  assert.equal(state.calls.length, 1);
  assert.equal(harness.recordCalls, 0);
  assert.deepEqual(harness.events, []);

  const emitTaskId = '71000000-0000-4000-8000-000000000010';
  const emitHarness = taskDiagnosticHarness({ taskId: emitTaskId });
  const emitFailure = Object.freeze({
    mode: 'task',
    get attemptContext() {
      return emitHarness.emitter.attemptContext;
    },
    bindProviderFamily(providerFamily) {
      emitHarness.emitter.bindProviderFamily(providerFamily);
    },
    createOperationId() {
      return diagnosticUuid(980);
    },
    emit() {
      throw new Error('diagnostic emit failed synchronously');
    },
  });
  const emitProvider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': cloudCreateResponse(emitTaskId),
    }).fetch,
  });
  assert.equal(
    (
      await emitProvider.provision({
        ...provisionContext(emitTaskId),
        diagnostics: emitFailure,
      })
    ).taskId,
    emitTaskId,
  );
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

  const missingGenerationObject = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'POST /v1/sandboxes': response(200, null),
      'DELETE /v1/sandboxes/task-invalid-generation-object': response(404, {
        error: 'gone',
      }),
    }).fetch,
  });
  await assert.rejects(
    () =>
      missingGenerationObject.provision({
        ...provisionContext('task-invalid-generation-object'),
        ownership: ownership('invalid-owner', 'invalid-resource'),
        beforeSandboxCleanup: async () =>
          cleanupAuthorization(
            'task-invalid-generation-object',
            'invalid-owner',
            'invalid-resource',
          ),
      }),
    /did not confirm the requested resource generation/u,
  );
});

await test('cloud create diagnostics classify safe HTTP, protocol, guard, and timeout failures', async () => {
  const cases = [
    {
      label: 'http-101',
      route: response(101, null),
      outcome: 'failed',
      cause: 'protocol_failed',
      httpStatusClass: '1xx',
      retryable: false,
    },
    {
      label: 'http-302',
      route: response(302, null),
      outcome: 'failed',
      cause: 'protocol_failed',
      httpStatusClass: '3xx',
      retryable: false,
    },
    {
      label: 'http-401',
      route: response(401, null),
      outcome: 'failed',
      cause: 'access_denied',
      httpStatusClass: '4xx',
      retryable: false,
    },
    {
      label: 'http-403',
      route: response(403, null),
      outcome: 'failed',
      cause: 'access_denied',
      httpStatusClass: '4xx',
      retryable: false,
    },
    {
      label: 'http-408',
      route: response(408, null),
      outcome: 'timed_out',
      cause: 'settlement_unknown',
      httpStatusClass: '4xx',
      retryable: true,
    },
    {
      label: 'http-429',
      route: response(429, null),
      outcome: 'failed',
      cause: 'protocol_failed',
      httpStatusClass: '4xx',
      retryable: true,
    },
    {
      label: 'http-out-of-range',
      route: response(600, null),
      outcome: 'indeterminate',
      cause: 'provider_unavailable',
      httpStatusClass: null,
      retryable: true,
    },
    {
      label: 'protocol',
      route: response(200, null),
      outcome: 'failed',
      cause: 'protocol_failed',
      httpStatusClass: undefined,
      retryable: false,
    },
    {
      label: 'etimedout',
      route: () => {
        const error = new Error('connect timed out');
        error.code = 'ETIMEDOUT';
        throw error;
      },
      outcome: 'timed_out',
      cause: 'settlement_unknown',
      httpStatusClass: undefined,
      retryable: true,
    },
    {
      label: 'guard-non-error',
      route: cloudCreateResponse('unused'),
      guardFailure: 'guard rejected without provider payload',
      outcome: 'failed',
      cause: 'unknown',
      httpStatusClass: undefined,
      retryable: false,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const taskId = diagnosticUuid(1_100 + index);
    const diagnostics = taskDiagnosticHarness({ taskId });
    const state = makeFetch({ 'POST /v1/sandboxes': entry.route });
    const provider = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      timeoutMs: 19,
      fetch: state.fetch,
    });
    await captureRejection(() =>
      provider.provision({
        ...provisionContext(taskId),
        diagnostics: diagnostics.emitter,
        ...(entry.guardFailure === undefined
          ? {}
          : {
              externalBoundaryGuard: async () => {
                throw entry.guardFailure;
              },
            }),
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const terminal = operationEvents(
      diagnostics.events,
      'sandbox_create',
    ).at(-1);
    assert.equal(terminal.outcome, entry.outcome, entry.label);
    assert.equal(terminal.cause, entry.cause, entry.label);
    assert.equal(terminal.retryable, entry.retryable, entry.label);
    assert.equal(
      terminal.httpStatusClass,
      entry.httpStatusClass,
      entry.label,
    );
    assertDiagnosticPairs(diagnostics.events);
  }
});

await test('teardown is idempotent for missing cloud sandboxes', async () => {
  const { fetch, calls } = makeFetch({
    'DELETE /v1/sandboxes/task-missing': response(404, { error: 'gone' }),
    'DELETE /v1/sandboxes/task-terminal-missing': response(404, { error: 'gone' }),
    'DELETE /v1/sandboxes/task-legacy-authorization': response(404, {
      error: 'gone',
    }),
    'DELETE /v1/sandboxes/task-generation-authorization': response(404, {
      error: 'gone',
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch,
  });
  assert.deepEqual(await provider.teardownSandbox('task-missing'), {
    ...cleanupSucceeded('already-absent'),
  });
  assert.equal(calls[0].method, 'DELETE');
  assert.deepEqual(
    await provider.teardownSandbox('task-terminal-missing', {
      disposition: 'terminal-retain',
    }),
    cleanupSucceeded('already-absent'),
  );
  assert.deepEqual(
    await provider.teardownSandbox('task-legacy-authorization', {
      cleanupAuthorization: {
        kind: 'legacy',
        taskId: 'task-legacy-authorization',
        providerId: 'cloud-http',
      },
    }),
    cleanupSucceeded('already-absent'),
  );
  assert.deepEqual(
    await provider.teardownSandbox('task-generation-authorization', {
      cleanupAuthorization: cleanupAuthorization(
        'task-generation-authorization',
        'authorization-owner',
        'authorization-resource',
      ),
    }),
    cleanupSucceeded('already-absent'),
  );
  await assert.rejects(
    () =>
      provider.teardownSandbox('task-invalid-authorization', {
        cleanupAuthorization: {
          kind: 'legacy',
          taskId: 'replacement-task',
          providerId: 'cloud-http',
        },
      }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );

  const failing = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'DELETE /v1/sandboxes/task-fail': response(500, { error: 'boom' }),
    }).fetch,
  });
  assert.deepEqual(
    await failing.teardownSandbox('task-fail'),
    cleanupIndeterminate(),
  );
});

await test('owned cloud teardown is generation-conditional and stale cleanup fails closed', async () => {
  const { fetch, calls } = makeFetch({
    'DELETE /v1/sandboxes/task-owned': response(204, null),
    'GET /v1/sandboxes/task-owned': response(404, { error: 'gone' }),
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
  }), cleanupSucceeded('found-and-cleaned'));
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
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );
});

await test('cloud diagnostics keep create, delete acknowledgement, and absence confirmation safe and ordered', async () => {
  const taskId = '71000000-0000-4000-8000-000000000009';
  const apiTokenCanary = 'CAP_CLOUD_API_TOKEN_CANARY';
  const endpointCanary = 'CAP_CLOUD_ENDPOINT_CANARY';
  const providerIdCanary = 'CAP_CLOUD_PROVIDER_SANDBOX_ID_CANARY';
  const resource = ownership('safe-owner', 'safe-resource');
  const diagnostics = taskDiagnosticHarness({ taskId });
  let inspections = 0;
  const state = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        taskId,
        providerSandboxId: providerIdCanary,
        baseUrl: `https://sandbox.example.test/${endpointCanary}`,
        wsUrl: `wss://sandbox.example.test/${endpointCanary}/ws`,
        resourceGeneration: resource.resourceGeneration,
      },
    }),
    [`DELETE /v1/sandboxes/${taskId}`]: response(204, null),
    [`GET /v1/sandboxes/${taskId}`]: () => {
      inspections += 1;
      return inspections === 1
        ? response(200, {
            data: {
              providerSandboxId: providerIdCanary,
              resourceGeneration: resource.resourceGeneration,
              status: 'deleting',
            },
          })
        : response(404, { error: 'gone' });
    },
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    apiToken: apiTokenCanary,
    cleanupPollAttempts: 2,
    cleanupPollIntervalMs: 0,
    delay: async () => undefined,
    fetch: state.fetch,
  });

  await provider.provision({
    ...provisionContext(taskId),
    diagnostics: diagnostics.emitter,
    ownership: resource,
  });
  assert.deepEqual(
    await provider.teardownSandbox(taskId, { ownership: resource }),
    cleanupSucceeded('found-and-cleaned'),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['POST', 'DELETE', 'GET', 'GET'],
  );
  assertDiagnosticPairs(diagnostics.events);
  assert.deepEqual(
    operationEvents(diagnostics.events, 'sandbox_create').map(
      (event) => event.outcome,
    ),
    ['started', 'succeeded'],
  );
  assert.deepEqual(
    operationEvents(diagnostics.events, 'sandbox_delete').map(
      (event) => event.outcome,
    ),
    ['started', 'succeeded'],
  );
  assert.deepEqual(
    operationEvents(diagnostics.events, 'sandbox_absence_confirm').map(
      (event) => event.outcome,
    ),
    ['started', 'succeeded'],
  );
  const deleteTerminal = operationEvents(
    diagnostics.events,
    'sandbox_delete',
  ).at(-1);
  const confirmationStart = operationEvents(
    diagnostics.events,
    'sandbox_absence_confirm',
  )[0];
  assert.ok(deleteTerminal.sequence < confirmationStart.sequence);
  const serialized = JSON.stringify(diagnostics.events);
  for (const canary of [
    apiTokenCanary,
    endpointCanary,
    providerIdCanary,
    resource.resourceGeneration,
  ]) {
    assert.equal(serialized.includes(canary), false);
  }
});

await test('cloud cleanup transport and confirmation fault matrix stays typed', async () => {
  const timeoutFailure = () => {
    const error = new Error('cleanup timed out');
    error.name = 'TimeoutError';
    throw error;
  };
  const transportFailure = () => {
    throw new Error('cleanup transport failed');
  };
  const cases = [
    {
      label: 'delete-transport',
      deletion: transportFailure,
      expected: cleanupIndeterminate(),
      operation: 'sandbox_delete',
      outcome: 'indeterminate',
    },
    {
      label: 'delete-timeout',
      deletion: timeoutFailure,
      expected: cleanupIndeterminate(),
      operation: 'sandbox_delete',
      outcome: 'timed_out',
    },
    {
      label: 'delete-http-timeout',
      deletion: response(408, { error: 'timeout' }),
      expected: cleanupIndeterminate(),
      operation: 'sandbox_delete',
      outcome: 'timed_out',
    },
    {
      label: 'delete-http-failed',
      deletion: response(400, { error: 'invalid' }),
      expected: cleanupFailed(false),
      operation: 'sandbox_delete',
      outcome: 'failed',
    },
    {
      label: 'confirm-transport',
      confirmation: transportFailure,
      expected: cleanupIndeterminate(),
      operation: 'sandbox_absence_confirm',
      outcome: 'indeterminate',
    },
    {
      label: 'confirm-timeout',
      confirmation: timeoutFailure,
      expected: cleanupIndeterminate(),
      operation: 'sandbox_absence_confirm',
      outcome: 'timed_out',
    },
    {
      label: 'confirm-http-timeout',
      confirmation: response(408, { error: 'timeout' }),
      expected: cleanupIndeterminate(),
      operation: 'sandbox_absence_confirm',
      outcome: 'timed_out',
    },
    {
      label: 'confirm-unavailable',
      confirmation: response(503, { error: 'unavailable' }),
      expected: cleanupIndeterminate(),
      operation: 'sandbox_absence_confirm',
      outcome: 'indeterminate',
    },
    {
      label: 'confirm-failed',
      confirmation: response(400, { error: 'invalid' }),
      expected: cleanupFailed(false),
      operation: 'sandbox_absence_confirm',
      outcome: 'failed',
    },
    {
      label: 'confirm-fenced',
      confirmation: response(409, { error: 'fenced' }),
      coordinationPending: true,
      operation: 'sandbox_absence_confirm',
      outcome: 'failed',
    },
    {
      label: 'confirm-generation-mismatch',
      confirmation: response(200, {
        data: {
          providerSandboxId: 'matrix-sandbox',
          resourceGeneration: 'replacement-resource',
          status: 'deleting',
        },
      }),
      coordinationPending: true,
      operation: 'sandbox_absence_confirm',
      outcome: 'failed',
    },
    {
      label: 'confirm-provider-id-mismatch',
      confirmation: response(200, {
        data: {
          providerSandboxId: 'replacement-sandbox',
          resourceGeneration: 'matrix-resource',
          status: 'deleting',
        },
      }),
      coordinationPending: true,
      operation: 'sandbox_absence_confirm',
      outcome: 'failed',
    },
    {
      label: 'confirm-invalid-payload-without-target',
      confirmation: response(200, null),
      withoutTarget: true,
      expected: cleanupIndeterminate(),
      operation: 'sandbox_absence_confirm',
      outcome: 'indeterminate',
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const taskId = diagnosticUuid(1_000 + index);
    const diagnostics = taskDiagnosticHarness({ taskId });
    const state = makeFetch({
      [`DELETE /v1/sandboxes/${taskId}`]:
        entry.deletion ?? response(204, null),
      [`GET /v1/sandboxes/${taskId}`]:
        entry.confirmation ?? response(404, { error: 'gone' }),
    });
    const provider = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      cleanupPollAttempts: 1,
      fetch: state.fetch,
    });
    const cleanup = () =>
      provider.teardownSandbox(taskId, {
        ...(entry.withoutTarget
          ? {}
          : {
              ownership: ownership('matrix-owner', 'matrix-resource'),
              providerSandboxId: 'matrix-sandbox',
            }),
        diagnostics: diagnostics.emitter,
      });
    if (entry.coordinationPending) {
      await assert.rejects(
        cleanup,
        (error) => error?.code === 'sandbox_cleanup_coordination_pending',
        entry.label,
      );
    } else {
      assert.deepEqual(await cleanup(), entry.expected, entry.label);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      operationEvents(diagnostics.events, entry.operation).at(-1).outcome,
      entry.outcome,
      entry.label,
    );
    assertDiagnosticPairs(diagnostics.events);
  }
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
    cleanupSucceeded('found-and-cleaned'),
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

await test('cloud cleanup accepts each explicit retained and removed terminal proof', async () => {
  const cases = [
    {
      taskId: 'task-proof-deleted-flag',
      disposition: 'superseded-remove',
      data: { deleted: true },
    },
    {
      taskId: 'task-proof-deleted-status',
      disposition: 'superseded-remove',
      data: { status: 'deleted' },
    },
    {
      taskId: 'task-proof-removed-status',
      disposition: 'superseded-remove',
      data: { status: 'removed' },
    },
    {
      taskId: 'task-proof-stopped-status',
      disposition: 'terminal-retain',
      data: { status: 'stopped' },
    },
  ];
  for (const entry of cases) {
    const provider = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      fetch: makeFetch({
        [`DELETE /v1/sandboxes/${entry.taskId}`]: response(204, null),
        [`GET /v1/sandboxes/${entry.taskId}`]: response(200, {
          data: entry.data,
        }),
      }).fetch,
    });
    assert.deepEqual(
      await provider.teardownSandbox(entry.taskId, {
        disposition: entry.disposition,
      }),
      cleanupSucceeded('found-and-cleaned'),
      entry.taskId,
    );
  }
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
  assert.deepEqual(
    await provider.teardownSandbox('task-retain-removed', {
      disposition: 'terminal-retain',
    }),
    cleanupFailed(false),
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
    cleanupSucceeded('found-and-cleaned'),
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
  assert.deepEqual(
    await pending.teardownSandbox('task-remove-pending', {
      ownership: ownership('pending-owner', 'pending-resource'),
      providerSandboxId: 'cloud-pending-id',
      disposition: 'superseded-remove',
    }),
    cleanupIndeterminate(),
  );

  const defaultDelay = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({
      'DELETE /v1/sandboxes/task-default-delay': response(202, null),
      'GET /v1/sandboxes/task-default-delay': response(200, {
        data: { status: 'deleting' },
      }),
    }).fetch,
    cleanupPollAttempts: 2,
    cleanupPollIntervalMs: 1,
  });
  assert.deepEqual(
    await defaultDelay.teardownSandbox('task-default-delay'),
    cleanupIndeterminate(),
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

await test('sandboxExists diagnostics classify HTTP and transport uncertainty without leaking errors', async () => {
  const cases = [
    {
      label: 'http-timeout',
      route: response(408, { error: 'timeout' }),
      outcome: 'timed_out',
      cause: 'settlement_unknown',
    },
    {
      label: 'transport-timeout',
      route: () => {
        const error = new Error('inspect timeout');
        error.name = 'TimeoutError';
        throw error;
      },
      outcome: 'timed_out',
      cause: 'settlement_unknown',
    },
    {
      label: 'transport-error',
      route: () => {
        throw new Error('CAP_INSPECT_RAW_ERROR_CANARY');
      },
      outcome: 'indeterminate',
      cause: 'transport_failed',
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const taskId = diagnosticUuid(1_200 + index);
    const diagnostics = taskDiagnosticHarness({ taskId });
    const provider = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      timeoutMs: 29,
      fetch: makeFetch({
        [`GET /v1/sandboxes/${taskId}`]: entry.route,
      }).fetch,
    });
    await assert.rejects(() =>
      provider.sandboxExists(taskId, diagnostics.emitter),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const terminal = operationEvents(
      diagnostics.events,
      'sandbox_inspect',
    ).at(-1);
    assert.equal(terminal.outcome, entry.outcome, entry.label);
    assert.equal(terminal.cause, entry.cause, entry.label);
    assert.equal(
      JSON.stringify(diagnostics.events).includes(
        'CAP_INSPECT_RAW_ERROR_CANARY',
      ),
      false,
    );
    assertDiagnosticPairs(diagnostics.events);
  }
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

await test('cloud readoption accepts partial targets and rejects missing attestation', async () => {
  const resource = ownership('partial-owner', 'partial-resource');
  const state = makeFetch({
    'POST /v1/sandboxes/target-empty/reattach': response(200, {
      data: {
        taskId: 'target-empty',
        baseUrl: 'https://sandbox.example.test/target-empty',
        wsUrl: 'wss://sandbox.example.test/target-empty/ws',
      },
    }),
    'POST /v1/sandboxes/target-provider/reattach': response(200, {
      data: {
        taskId: 'target-provider',
        providerSandboxId: 'partial-provider',
        baseUrl: 'https://sandbox.example.test/target-provider',
        wsUrl: 'wss://sandbox.example.test/target-provider/ws',
      },
    }),
    'POST /v1/sandboxes/target-owner/reattach': response(200, {
      data: {
        taskId: 'target-owner',
        resourceGeneration: resource.resourceGeneration,
        baseUrl: 'https://sandbox.example.test/target-owner',
        wsUrl: 'wss://sandbox.example.test/target-owner/ws',
      },
    }),
    'POST /v1/sandboxes/target-unattested/reattach': response(200, {
      data: null,
    }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: state.fetch,
  });

  assert.equal((await provider.reattach('target-empty', {})).taskId, 'target-empty');
  assert.equal(
    (
      await provider.reattach('target-provider', {
        providerSandboxId: 'partial-provider',
      })
    ).taskId,
    'target-provider',
  );
  assert.equal(
    (await provider.reattach('target-owner', { ownership: resource })).taskId,
    'target-owner',
  );
  await assert.rejects(
    () =>
      provider.reattach('target-unattested', {
        providerSandboxId: 'partial-provider',
      }),
    /did not attest the persisted target/u,
  );
  assert.deepEqual(state.calls[0].body, {});
  assert.deepEqual(state.calls[1].body, {
    providerSandboxId: 'partial-provider',
  });
  assert.deepEqual(state.calls[2].body, {
    resourceGeneration: resource.resourceGeneration,
  });
});

await test('cloud terminal descriptor parsing is strict and preserves only valid optional fields', async () => {
  const invalidTerminals = [
    false,
    [],
    {},
    { protocol: '', url: 'wss://terminal.example.test' },
    { protocol: 'provider-native' },
    { protocol: 'provider-native', url: '', wsUrl: '' },
  ];
  for (const [index, terminal] of invalidTerminals.entries()) {
    const taskId = `task-invalid-terminal-${index}`;
    const provider = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      fetch: makeFetch({
        'POST /v1/sandboxes': response(200, {
          data: {
            taskId,
            baseUrl: `https://sandbox.example.test/${taskId}`,
            wsUrl: `wss://sandbox.example.test/${taskId}/ws`,
            terminal,
          },
        }),
      }).fetch,
    });
    await assert.rejects(
      () => provider.provision(provisionContext(taskId)),
      /terminal descriptor is invalid/u,
    );
  }

  for (const [index, terminal] of [
    {
      protocol: 'provider-native',
      url: 'https://terminal.example.test',
      wsUrl: 'wss://terminal.example.test/ws',
      metadata: { transport: 'native' },
    },
    {
      protocol: 'provider-native',
      url: 'https://terminal.example.test',
      metadata: [],
    },
    {
      protocol: 'provider-native',
      wsUrl: 'wss://terminal.example.test/ws',
      metadata: 'invalid',
    },
    {
      protocol: 'provider-native',
      wsUrl: 'wss://terminal.example.test/ws',
      metadata: null,
    },
  ].entries()) {
    const taskId = `task-valid-terminal-${index}`;
    const provider = new mod.HttpCloudSandboxProvider({
      baseUrl: 'https://cloud.example.test',
      fetch: makeFetch({
        'POST /v1/sandboxes': response(200, {
          data: {
            taskId,
            baseUrl: `https://sandbox.example.test/${taskId}`,
            wsUrl: `wss://sandbox.example.test/${taskId}/ws`,
            terminal,
          },
        }),
      }).fetch,
    });
    await provider.provision(provisionContext(taskId));
    const selected = await provider.getSelectedSandboxRun(taskId);
    assert.equal(selected.terminal.protocol, 'provider-native');
    assert.equal(
      Object.hasOwn(selected.terminal, 'metadata'),
      index === 0,
    );
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

await test('cloud provider passes shared provisioning diagnostic conformance', async () => {
  const capabilityProvider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: makeFetch({}).fetch,
  });
  const diagnosticScenarios =
    conformance.createSandboxProviderDiagnosticConformanceScenarios(
      {
        providerFamily: 'cloud-http',
        workspaceCredential: {
          kind: 'reject-before-external-boundary',
          providerCapabilities: capabilityProvider.getProviderCapabilities(),
        },
        exercise: async (input) => {
          if (input.scenario === 'taskless-probe') {
            const state = makeFetch({
              'GET /v1/sandboxes/cloud-taskless-probe': response(200, {
                data: { taskId: 'cloud-taskless-probe' },
              }),
            });
            const provider = new mod.HttpCloudSandboxProvider({
              baseUrl: 'https://cloud.example.test',
              fetch: state.fetch,
            });
            assert.equal(
              await provider.sandboxExists(
                'cloud-taskless-probe',
                input.diagnostics,
              ),
              true,
            );
            assert.equal(state.calls.length, 1);
            return { probe: input.probeResult };
          }

          const resource = ownership(
            `owner-${input.scenario}`,
            `resource-${input.scenario}`,
          );
          const authorization = cleanupAuthorization(
            input.taskId,
            resource.ownerGeneration,
            resource.resourceGeneration,
          );
          const cleanupRoutes = {
            [`DELETE /v1/sandboxes/${input.taskId}`]: response(204, null),
            [`GET /v1/sandboxes/${input.taskId}`]: response(404, {
              error: 'gone',
            }),
          };
          const provision = (overrides = {}) => ({
            ...provisionContext(input.taskId),
            diagnostics: input.diagnostics,
            ...overrides,
          });

          switch (input.scenario) {
            case 'bounded-start-terminal': {
              const state = makeFetch({
                'POST /v1/sandboxes': cloudCreateResponse(input.taskId),
              });
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                fetch: state.fetch,
              });
              await provider.provision(provision());
              assert.equal(state.calls.length, 1);
              return;
            }
            case 'replay-deduplication': {
              const state = makeFetch({
                'POST /v1/sandboxes': cloudCreateResponse(input.taskId),
              });
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                fetch: state.fetch,
              });
              await provider.provision(provision());
              await provider.provision(provision());
              assert.equal(state.calls.length, 2);
              return;
            }
            case 'timeout': {
              const state = makeFetch({
                'POST /v1/sandboxes': () => {
                  const error = new Error('bounded cloud create timeout');
                  error.name = 'TimeoutError';
                  throw error;
                },
                ...cleanupRoutes,
              });
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                timeoutMs: 37,
                fetch: state.fetch,
              });
              await assert.rejects(() =>
                provider.provision(
                  provision({
                    ownership: resource,
                    beforeSandboxCleanup: async () => authorization,
                  }),
                ),
              );
              return;
            }
            case 'cancellation': {
              const state = makeFetch(cleanupRoutes);
              const controller = new AbortController();
              controller.abort(new Error('cancelled before cloud create'));
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                fetch: state.fetch,
              });
              await assert.rejects(() =>
                provider.provision(
                  provision({
                    cancellationSignal: controller.signal,
                    ownership: resource,
                    beforeSandboxCleanup: async () => authorization,
                  }),
                ),
              );
              assert.equal(
                state.calls.some((call) => call.method === 'POST'),
                false,
              );
              return;
            }
            case 'indeterminate-settlement': {
              const state = makeFetch({
                'POST /v1/sandboxes': () => {
                  throw new Error(input.canaries.providerError);
                },
                ...cleanupRoutes,
              });
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                fetch: state.fetch,
              });
              await assert.rejects(() =>
                provider.provision(
                  provision({
                    ownership: resource,
                    beforeSandboxCleanup: async () => authorization,
                  }),
                ),
              );
              return;
            }
            case 'primary-plus-cleanup-failure': {
              const state = makeFetch({
                'POST /v1/sandboxes': () => {
                  throw input.primaryFailure;
                },
                [`DELETE /v1/sandboxes/${input.taskId}`]: response(500, {
                  error: 'cleanup unavailable',
                }),
              });
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                fetch: state.fetch,
              });
              await assert.rejects(
                () =>
                  provider.provision(
                    provision({
                      ownership: resource,
                      beforeSandboxCleanup: async () => authorization,
                    }),
                  ),
                (error) => error === input.primaryFailure,
              );
              const cleanup = await provider.teardownSandbox(input.taskId, {
                ownership: resource,
                diagnostics: input.diagnostics,
              });
              return { primary: input.primaryFailure, cleanup };
            }
            case 'credential-cleanup-failure': {
              const state = makeFetch({});
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                fetch: state.fetch,
              });
              const rejection = await captureRejection(() =>
                provider.provision(
                  provision({
                    workspace: {
                      repositoryUrl:
                        'https://code.example.test/org/private.git',
                      callerBranch: null,
                      resolvedBranch: 'main',
                      deadlineMs: 900_000,
                      credential: core.createExactHostGitCredential(
                        'https://code.example.test/org/private.git',
                        `Authorization: Basic ${input.canaries.secret}`,
                      ),
                    },
                  }),
                ),
              );
              return {
                rejection,
                externalBoundaryCalls: state.calls.length,
              };
            }
            case 'raw-provider-secret-canary': {
              const state = makeFetch({
                'POST /v1/sandboxes': () => {
                  throw input.primaryFailure;
                },
                [`DELETE /v1/sandboxes/${input.taskId}`]: response(429, {
                  error: 'cleanup throttled',
                }),
              });
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                apiToken: input.canaries.secret,
                fetch: state.fetch,
              });
              let primary;
              await assert.rejects(
                () => provider.provision(provision()),
                (error) => {
                  primary = error;
                  return error === input.primaryFailure;
                },
              );
              const cleanup = await provider.teardownSandbox(input.taskId, {
                diagnostics: input.diagnostics,
              });
              assert.deepEqual(cleanup, input.cleanupFailure);
              assert.deepEqual(
                state.calls.map((call) => call.method),
                ['POST', 'DELETE'],
              );

              const operationId = input.diagnostics.createOperationId();
              await assert.rejects(() =>
                input.diagnostics.emit({
                  operationId,
                  stage: 'sandbox_creation',
                  operation: 'sandbox_create',
                  channel: 'primary',
                  outcome: 'failed',
                  cause: 'unknown',
                  retryable: false,
                  providerBody: input.canaries.providerBody,
                  providerError: input.canaries.providerError,
                  command: input.canaries.command,
                  output: input.canaries.output,
                  secret: input.canaries.secret,
                }),
              );
              return {
                primary,
                cleanup: input.cleanupFailure,
              };
            }
            case 'diagnostic-write-failure': {
              const state = makeFetch({
                'POST /v1/sandboxes': () => {
                  throw input.primaryFailure;
                },
                [`DELETE /v1/sandboxes/${input.taskId}`]: response(429, {
                  error: 'cleanup throttled',
                }),
              });
              const provider = new mod.HttpCloudSandboxProvider({
                baseUrl: 'https://cloud.example.test',
                fetch: state.fetch,
              });
              let primary;
              await assert.rejects(
                () => provider.provision(provision()),
                (error) => {
                  primary = error;
                  return error === input.primaryFailure;
                },
              );
              const cleanup = await provider.teardownSandbox(input.taskId, {
                diagnostics: input.diagnostics,
              });
              assert.deepEqual(cleanup, input.cleanupFailure);
              assert.deepEqual(
                state.calls.map((call) => call.method),
                ['POST', 'DELETE'],
              );
              return {
                primary,
                cleanup: input.cleanupFailure,
              };
            }
          }
        },
      },
      assert,
    );

  assert.equal(diagnosticScenarios.length, 10);
  for (const scenario of diagnosticScenarios) {
    await scenario.run();
  }
});

await test('cloud provider passes applicable ownership behavior conformance', async () => {
  const taskId = '72000000-0000-4000-8000-000000000001';
  const providerSandboxId = 'cloud-behavior-sandbox';
  const resource = ownership(
    'cloud-behavior-owner',
    'cloud-behavior-resource',
  );
  const trace = [];
  const appendTrace = (event) => {
    trace.push({
      sequence: trace.length + 1,
      taskId,
      providerId: 'cloud-http',
      ...event,
    });
  };
  const state = makeFetch({
    'POST /v1/sandboxes': cloudCreateResponse(taskId, {
      providerSandboxId,
    }),
    'GET /v1/sandboxes/readoptable': () => {
      appendTrace({ kind: 'readoptable-listed' });
      return response(200, { data: [taskId] });
    },
    [`POST /v1/sandboxes/${taskId}/reattach`]: ({ body, init }) => {
      appendTrace({
        kind: 'reattached',
        providerSandboxIdMatched:
          body.providerSandboxId === providerSandboxId,
        ownershipFenceMatched:
          body.resourceGeneration === resource.resourceGeneration &&
          init.headers['if-match'] === `"${resource.resourceGeneration}"`,
      });
      return response(200, {
        data: {
          taskId,
          providerSandboxId,
          resourceGeneration: resource.resourceGeneration,
          baseUrl: `https://sandbox.example.test/${taskId}`,
          wsUrl: `wss://sandbox.example.test/${taskId}/ws`,
        },
      });
    },
    [`DELETE /v1/sandboxes/${taskId}`]: response(404, { error: 'gone' }),
  });
  const provider = new mod.HttpCloudSandboxProvider({
    baseUrl: 'https://cloud.example.test',
    fetch: state.fetch,
  });
  assert.equal(
    provider.getProviderCapabilities().includes('command.exec'),
    false,
  );
  assert.equal(typeof provider.getCommandDescriptor, 'undefined');
  const getSelectedSandboxRun = provider.getSelectedSandboxRun.bind(provider);
  provider.getSelectedSandboxRun = async (selectedTaskId) => {
    const selected = await getSelectedSandboxRun(selectedTaskId);
    assert.equal(selected?.command, undefined);
    if (trace.length === 0) appendTrace({ kind: 'provider-selected' });
    return selected;
  };
  const scenarios = conformance.createSandboxProviderBehaviorConformanceScenarios(
    {
      provider,
      taskId,
      cloneSpec: null,
      behavior: {
        ownership: {
          readoptionTarget: () => ({
            providerSandboxId,
            ownership: resource,
          }),
          readTrace: () => trace,
        },
      },
      expectTranscriptSource: false,
    },
    assert,
  );
  assert.deepEqual(
    scenarios.map((scenario) => scenario.name),
    [
      'behavior adapters cover every advertised provider-owned capability',
      'ownership behavior readopts only the selected provider task',
    ],
  );
  try {
    for (const scenario of scenarios) await scenario.run();
  } finally {
    await provider.teardownSandbox(taskId);
  }
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
    [`GET /v1/sandboxes/${taskId}`]: response(404, { error: 'gone' }),
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
      requiredCapabilities: mod.HTTP_CLOUD_SANDBOX_PROVIDER_CAPABILITIES,
    },
    assert,
  );

  for (const scenario of scenarios) {
    await scenario.run();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
