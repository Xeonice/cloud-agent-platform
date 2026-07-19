import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const boxlite = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

function response(status, body, extra = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      if (typeof extra.text === 'string') return extra.text;
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async arrayBuffer() {
      return extra.arrayBuffer ?? new Uint8Array().buffer;
    },
  };
}

function makeFetch(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = `${url.pathname}${url.search}`;
    calls.push({ input, init, method, path });
    const route = routes[`${method} ${path}`];
    if (route === undefined) return response(404, { error: 'not found' });
    return typeof route === 'function'
      ? route({ input, init, method, path })
      : route;
  };
  return { fetch, calls };
}

function successfulNativeAttachFactory(exitCode = 0) {
  return (url) => {
    const resolvedExitCode =
      typeof exitCode === 'function' ? exitCode(url) : exitCode;
    const socket = new EventEmitter();
    socket.close = () => socket.emit('close');
    socket.terminate = () => socket.emit('close');
    setImmediate(() => {
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({ type: 'exit', exit_code: resolvedExitCode }),
        ),
        false,
      );
    });
    return socket;
  };
}

function nativeDeadlineHarness() {
  let now = 0;
  const scheduled = new Set();
  const driver = {
    now: () => now,
    schedule(delayMs, trigger) {
      const entry = {
        at: now + delayMs,
        cancelled: false,
        trigger,
      };
      scheduled.add(entry);
      return () => {
        entry.cancelled = true;
        scheduled.delete(entry);
      };
    },
  };
  const runDue = () => {
    for (const entry of [...scheduled].sort((left, right) => left.at - right.at)) {
      if (entry.cancelled || entry.at > now) continue;
      entry.cancelled = true;
      scheduled.delete(entry);
      entry.trigger();
    }
  };
  return {
    driver,
    advance(elapsedMs) {
      now += elapsedMs;
      runDue();
    },
    elapseWithoutTimer(elapsedMs) {
      now += elapsedMs;
    },
    activeDeadlineCount() {
      return scheduled.size;
    },
  };
}

function diagnosticsHarness(identityOffset = 0) {
  const events = [];
  let identity = identityOffset * 1_000;
  const nextIdentity = (prefix) =>
    `${prefix}-0000-4000-8000-${String(++identity).padStart(12, '0')}`;
  const diagnostics = core.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId: '30000000-0000-4000-8000-000000000001',
      attemptId: `31000000-0000-4000-8000-${String(
        identityOffset + 1,
      ).padStart(12, '0')}`,
      attempt: 1,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
    },
    createEventId: () => nextIdentity('32000000'),
    createOperationId: () => nextIdentity('33000000'),
    record: async (event) => {
      events.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  return { diagnostics, events };
}

async function flushDiagnostics() {
  // Provider diagnostics are intentionally best-effort and fire-and-forget.
  // Drain both the observer microtask chain and its recorder continuation.
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withDeadline(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('test operation exceeded its deadline')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function operationEvents(events, operation) {
  return events.filter((event) => event.operation === operation);
}

function assertLifecycle(events, operation, terminalOutcome) {
  const lifecycle = operationEvents(events, operation);
  assert.equal(lifecycle.length, 2, `${operation} must emit one bounded pair`);
  assert.deepEqual(
    lifecycle.map((event) => event.outcome),
    ['started', terminalOutcome],
  );
  assert.equal(lifecycle[0].operationId, lifecycle[1].operationId);
  assert.match(
    lifecycle[0].operationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  return lifecycle;
}

function assertNativeTerminalFacts(event, expected) {
  assert.equal(event.outcome, expected.outcome);
  assert.equal(event.cause, expected.cause);
  assert.equal(event.retryable, expected.retryable);
  for (const field of [
    'nativeState',
    'anomaly',
    'httpStatusClass',
    'exitCode',
    'timeoutMs',
  ]) {
    assert.equal(event[field] ?? null, expected[field] ?? null, field);
  }
}

function assertNoRawMaterial(events, canaries) {
  const serialized = JSON.stringify(events);
  for (const canary of canaries) {
    assert.equal(
      serialized.includes(canary),
      false,
      `diagnostic events leaked canary ${canary}`,
    );
  }
  for (const forbiddenField of [
    'sandboxId',
    'resourceId',
    'providerSandboxId',
    'executionId',
    'command',
    'args',
    'cwd',
    'stdout',
    'stderr',
    'output',
    'prompt',
    'path',
    'endpoint',
    'url',
    'body',
    'response',
    'error',
    'message',
    'stack',
    'diagnostics',
    'diagnosticScope',
  ]) {
    assert.equal(
      serialized.includes(`"${forbiddenField}":`),
      false,
      `diagnostic events included forbidden field ${forbiddenField}`,
    );
  }
}

await test('native create and start emit separate bounded lifecycles', async () => {
  const sandboxId = 'RAW_BOXLITE_RESOURCE_CANARY';
  const nativeProse = 'RAW_BOXLITE_START_PROSE_CANARY';
  const scope = 'RAW_DIAGNOSTIC_SCOPE_CANARY';
  const harness = diagnosticsHarness();
  const { fetch } = makeFetch({
    'POST /v1/default/boxes': response(200, {
      box_id: sandboxId,
      status: 'configured',
    }),
    [`POST /v1/default/boxes/${sandboxId}/start`]: response(
      503,
      { error: nativeProse },
      { text: nativeProse },
    ),
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
  });

  await assert.rejects(
    () =>
      client.createSandbox({
        taskId: 'task-native-create-start',
        sandboxId,
        image: 'cap-boxlite:test',
        diagnostics: harness.diagnostics,
        diagnosticScope: scope,
      }),
    (error) => error instanceof boxlite.BoxLitePartialCreateError,
  );
  await flushDiagnostics();

  const created = assertLifecycle(
    harness.events,
    'sandbox_create',
    'succeeded',
  );
  const started = assertLifecycle(harness.events, 'sandbox_start', 'failed');
  assert.notEqual(created[0].operationId, started[0].operationId);
  assert.equal(started[1].cause, 'provider_unavailable');
  assert.equal(started[1].httpStatusClass, '5xx');
  assertNoRawMaterial(harness.events, [sandboxId, nativeProse, scope]);
});

await test('authority rejection before a BoxLite boundary emits no provider operation', async () => {
  const createHarness = diagnosticsHarness(12);
  const createRoutes = makeFetch({});
  const createClient = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: createRoutes.fetch,
  });
  const authorityFailure = new Error('RAW_AUTHORITY_FAILURE_CANARY');

  await assert.rejects(
    () => createClient.createSandbox({
      taskId: 'task-authority-before-create',
      sandboxId: 'authority-before-create-box',
      image: 'cap-boxlite:test',
      diagnostics: createHarness.diagnostics,
      externalBoundaryGuard: async () => {
        throw authorityFailure;
      },
    }),
    (error) => error === authorityFailure,
  );
  await flushDiagnostics();
  assert.equal(createRoutes.calls.length, 0);
  assert.equal(createHarness.events.length, 0);

  const startHarness = diagnosticsHarness(13);
  const startRoutes = makeFetch({
    'POST /v1/default/boxes': response(200, {
      box_id: 'authority-before-start-box',
      status: 'configured',
    }),
  });
  const startClient = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: startRoutes.fetch,
  });
  await assert.rejects(
    () => startClient.createSandbox({
      taskId: 'task-authority-before-start',
      sandboxId: 'authority-before-start-box',
      image: 'cap-boxlite:test',
      diagnostics: startHarness.diagnostics,
      externalBoundaryGuard: async (event) => {
        if (event.action === 'sandbox.start' && event.position === 'before') {
          throw authorityFailure;
        }
      },
    }),
    (error) =>
      error instanceof boxlite.BoxLitePartialCreateError &&
      error.cause === authorityFailure,
  );
  await flushDiagnostics();
  assertLifecycle(startHarness.events, 'sandbox_create', 'succeeded');
  assert.equal(operationEvents(startHarness.events, 'sandbox_start').length, 0);
  assertNoRawMaterial(startHarness.events, ['RAW_AUTHORITY_FAILURE_CANARY']);
});

await test('cap-rest create strips diagnostic internals and canaries from the wire', async () => {
  const diagnosticScope = 'WIRE_DIAGNOSTIC_SCOPE_CANARY';
  const observerCanary = 'WIRE_DIAGNOSTIC_OBSERVER_CANARY';
  const harness = diagnosticsHarness(1);
  // The extra property proves the complete observer object never reaches JSON.
  const diagnostics = Object.assign(Object.create(harness.diagnostics), {
    observerCanary,
  });
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: {
        id: 'cap-rest-created-box',
        taskId: 'task-cap-rest-wire',
        state: 'running',
      },
    }),
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch,
  });

  await client.createSandbox({
    taskId: 'task-cap-rest-wire',
    sandboxId: 'cap-rest-created-box',
    image: 'cap-boxlite:test',
    labels: { task: 'task-cap-rest-wire' },
    diagnostics,
    diagnosticScope,
  });
  await flushDiagnostics();

  assert.equal(calls.length, 1);
  const wireBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(wireBody, {
    taskId: 'task-cap-rest-wire',
    sandboxId: 'cap-rest-created-box',
    image: 'cap-boxlite:test',
    labels: { task: 'task-cap-rest-wire' },
  });
  assert.equal('diagnostics' in wireBody, false);
  assert.equal('diagnosticScope' in wireBody, false);
  assert.doesNotMatch(calls[0].init.body, /WIRE_DIAGNOSTIC_/u);
  assertLifecycle(harness.events, 'sandbox_create', 'succeeded');
  assertNoRawMaterial(harness.events, [diagnosticScope, observerCanary]);
});

await test('cap-rest exec keeps diagnostic descriptors off the wire', async () => {
  const harness = diagnosticsHarness(11);
  const observerCanary = 'WIRE_EXEC_OBSERVER_CANARY';
  const diagnostics = Object.assign(Object.create(harness.diagnostics), {
    observerCanary,
  });
  const { fetch, calls } = makeFetch({
    'POST /v1/sandboxes/cap-rest-exec-box/exec': response(200, {
      data: { exit_code: 0, stdout: 'WIRE_EXEC_OUTPUT_CANARY' },
    }),
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch,
  });
  const executor = boxlite.createBoxLiteCommandExecutor({
    client,
    sandboxId: 'cap-rest-exec-box',
    diagnostics,
  });

  const classified = await core.classifySandboxRuntimeCommandExecution({
    executor,
    request: {
      command: 'printf WIRE_EXEC_COMMAND_CANARY',
      cwd: '/workspace/WIRE_EXEC_CWD_CANARY',
      timeoutMs: 4_321,
    },
    descriptor: { commandKind: 'runtime_setup', ordinal: 1 },
  });
  await flushDiagnostics();

  assert.equal(classified.outcome, 'succeeded');
  assert.equal(calls.length, 1);
  const wireBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(wireBody, {
    command: 'printf WIRE_EXEC_COMMAND_CANARY',
    cwd: '/workspace/WIRE_EXEC_CWD_CANARY',
    timeoutMs: 4_321,
  });
  for (const internalField of [
    'diagnostics',
    'diagnosticChannel',
    'commandKind',
    'diagnosticDescriptor',
  ]) {
    assert.equal(internalField in wireBody, false);
  }
  assertLifecycle(harness.events, 'native_exec_start', 'succeeded');
  const settled = assertLifecycle(
    harness.events,
    'native_exec_settlement',
    'succeeded',
  );
  assert.equal(settled[1].commandKind, 'runtime_setup');
  assertNoRawMaterial(harness.events, [
    observerCanary,
    'WIRE_EXEC_COMMAND_CANARY',
    'WIRE_EXEC_CWD_CANARY',
    'WIRE_EXEC_OUTPUT_CANARY',
  ]);
});

await test('2xx malformed inspect response fails as protocol evidence, never absence', async () => {
  const sandboxId = 'RAW_INSPECT_RESOURCE_CANARY';
  const bodyCanary = 'RAW_INSPECT_BODY_CANARY';
  const harness = diagnosticsHarness(2);
  const { fetch } = makeFetch({
    [`GET /v1/default/boxes/${sandboxId}`]: response(200, {
      data: { status: 'running', native_detail: bodyCanary },
    }),
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
  });

  await assert.rejects(
    () =>
      client.getSandbox(sandboxId, {
        diagnostics: harness.diagnostics,
        diagnosticKey: 'sandbox.inspect.existing',
        diagnosticScope: 'inspect-scope',
      }),
    /missing id/u,
  );
  await flushDiagnostics();

  const inspected = assertLifecycle(
    harness.events,
    'sandbox_inspect',
    'failed',
  );
  assert.equal(inspected[1].cause, 'protocol_failed');
  assert.equal(inspected[1].retryable, false);
  assertNoRawMaterial(harness.events, [sandboxId, bodyCanary]);
});

await test('long native poll remains bounded and missing exit emits only safe facts', async () => {
  const sandboxId = 'RAW_POLL_RESOURCE_CANARY';
  const executionId = 'RAW_POLL_EXECUTION_CANARY';
  const command = 'printf RAW_POLL_COMMAND_CANARY';
  const output = 'RAW_POLL_OUTPUT_CANARY';
  const harness = diagnosticsHarness(3);
  let pollCalls = 0;
  const terminalPoll = `GET /v1/default/boxes/${sandboxId}/executions/${executionId}`;
  const { fetch } = makeFetch({
    [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
      execution_id: executionId,
    }),
    [terminalPoll]: () => {
      pollCalls += 1;
      return pollCalls <= 5
        ? response(200, { status: 'running' })
        : response(200, { status: 'failed', stderr: output });
    },
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
    webSocketFactory: successfulNativeAttachFactory(),
  });

  await assert.rejects(
    () =>
      client.exec({
        sandboxId,
        command,
        timeoutMs: 2_500,
        diagnostics: harness.diagnostics,
        commandKind: 'runtime_setup',
      }),
    (error) =>
      error?.code === 'sandbox_command_settlement_error' &&
      error?.settlement === 'failed_without_exit',
  );
  await flushDiagnostics();

  assert.equal(pollCalls, 6, 'the fixture must exercise repeated native polls');
  assertLifecycle(harness.events, 'native_exec_start', 'succeeded');
  const polled = assertLifecycle(
    harness.events,
    'native_exec_poll',
    'succeeded',
  );
  const settled = assertLifecycle(
    harness.events,
    'native_exec_settlement',
    'failed',
  );
  assert.equal(polled[1].nativeState, 'failed');
  assert.equal(polled[1].exitCode, null);
  assert.equal(settled[1].nativeState, undefined);
  assert.equal(settled[1].exitCode, null);
  assert.equal(settled[1].cause, 'missing_exit_code');
  assert.equal(settled[1].anomaly, 'missing_exit_code');
  assertLifecycle(harness.events, 'native_exec_attach', 'succeeded');
  assert.equal(harness.events.length, 8);
  assert.ok(
    harness.events.length <=
      core.SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
  );
  assertNoRawMaterial(harness.events, [
    sandboxId,
    executionId,
    command,
    output,
  ]);
});

await test('native poll fault table keeps settlement typed bounded and secret-free', async () => {
  const scenarios = [
    {
      name: 'killed-without-exit',
      settlement: 'failed_without_exit',
      classification: {
        settlement: 'failed_without_exit',
        outcome: 'failed',
        cause: 'missing_exit_code',
        retryable: false,
        exitCode: null,
        anomaly: 'missing_exit_code',
      },
      pollResponse: (canary) =>
        response(200, { status: 'killed', stderr: canary }),
      poll: {
        outcome: 'succeeded',
        cause: null,
        retryable: false,
        nativeState: 'killed',
        anomaly: null,
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: null,
      },
      settlementEvent: {
        outcome: 'failed',
        cause: 'missing_exit_code',
        retryable: false,
        nativeState: null,
        anomaly: 'missing_exit_code',
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: null,
      },
    },
    {
      name: 'malformed-terminal',
      settlement: 'protocol',
      classification: {
        settlement: 'protocol',
        outcome: 'failed',
        cause: 'protocol_failed',
        retryable: false,
        exitCode: null,
      },
      pollResponse: (canary) =>
        response(200, {
          status: 'completed',
          exit_code: canary,
          output: canary,
        }),
      poll: {
        outcome: 'failed',
        cause: 'protocol_failed',
        retryable: false,
        nativeState: 'completed',
        anomaly: 'invalid_poll_settlement',
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: null,
      },
      settlementEvent: {
        outcome: 'failed',
        cause: 'protocol_failed',
        retryable: false,
        nativeState: null,
        anomaly: null,
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: null,
      },
    },
    {
      name: 'poll-http-503',
      settlement: 'transport',
      classification: {
        settlement: 'transport',
        outcome: 'failed',
        cause: 'transport_failed',
        retryable: true,
        exitCode: null,
      },
      pollResponse: (canary) => response(503, { error: canary }),
      poll: {
        outcome: 'failed',
        cause: 'provider_unavailable',
        retryable: true,
        nativeState: null,
        anomaly: 'poll_transport_failure',
        httpStatusClass: '5xx',
        exitCode: null,
        timeoutMs: null,
      },
      settlementEvent: {
        outcome: 'failed',
        cause: 'transport_failed',
        retryable: true,
        nativeState: null,
        anomaly: null,
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: null,
      },
    },
    {
      name: 'poll-network-throw',
      settlement: 'transport',
      classification: {
        settlement: 'transport',
        outcome: 'failed',
        cause: 'transport_failed',
        retryable: true,
        exitCode: null,
      },
      pollResponse: (canary) => {
        throw new Error(canary);
      },
      poll: {
        outcome: 'failed',
        cause: 'transport_failed',
        retryable: true,
        nativeState: null,
        anomaly: 'poll_transport_failure',
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: null,
      },
      settlementEvent: {
        outcome: 'failed',
        cause: 'transport_failed',
        retryable: true,
        nativeState: null,
        anomaly: null,
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: null,
      },
    },
    {
      name: 'poll-deadline',
      settlement: 'indeterminate',
      classification: {
        settlement: 'indeterminate',
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
        exitCode: null,
      },
      timeoutMs: 1,
      pollResponse: (canary) =>
        response(200, { status: 'running', output: canary }),
      poll: {
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
        nativeState: 'unknown',
        anomaly: 'poll_timeout',
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: 1,
      },
      settlementEvent: {
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
        nativeState: null,
        anomaly: null,
        httpStatusClass: null,
        exitCode: null,
        timeoutMs: null,
      },
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const sandboxId = `RAW_${scenario.name.toUpperCase()}_RESOURCE_CANARY`;
    const executionId = `RAW_${scenario.name.toUpperCase()}_EXECUTION_CANARY`;
    const command = `printf RAW_${scenario.name.toUpperCase()}_COMMAND_CANARY`;
    const providerCanary = `RAW_${scenario.name.toUpperCase()}_PROVIDER_CANARY`;
    const harness = diagnosticsHarness(30 + index);
    let pollCalls = 0;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]: () => {
        pollCalls += 1;
        return scenario.pollResponse(providerCanary);
      },
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: successfulNativeAttachFactory(),
    });
    let rejection;

    await assert.rejects(
      () =>
        withDeadline(
          client.exec({
            sandboxId,
            command,
            timeoutMs: scenario.timeoutMs ?? 1_000,
            diagnostics: harness.diagnostics,
            commandKind: 'runtime_setup',
          }),
          2_000,
        ),
      (error) => {
        rejection = error;
        return (
          error?.code === 'sandbox_command_settlement_error' &&
          error.settlement === scenario.settlement
        );
      },
      scenario.name,
    );
    await harness.diagnostics.flush();

    assert.deepEqual(
      core.classifySandboxCommandExecutionRejection(rejection),
      scenario.classification,
      scenario.name,
    );
    assert.ok(pollCalls >= 1, scenario.name);
    assertLifecycle(harness.events, 'native_exec_start', 'succeeded');
    const polled = assertLifecycle(
      harness.events,
      'native_exec_poll',
      scenario.poll.outcome,
    );
    const settled = assertLifecycle(
      harness.events,
      'native_exec_settlement',
      scenario.settlementEvent.outcome,
    );
    assert.equal(
      operationEvents(harness.events, 'native_exec_attach').length,
      2,
      scenario.name,
    );
    assertNativeTerminalFacts(polled[1], scenario.poll);
    assertNativeTerminalFacts(settled[1], scenario.settlementEvent);
    assert.equal(harness.events.length, 8, scenario.name);
    assert.ok(
      harness.events.length <=
        core.SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
      scenario.name,
    );
    assertNoRawMaterial(harness.events, [
      sandboxId,
      executionId,
      command,
      providerCanary,
    ]);
    assert.equal(
      JSON.stringify(rejection).includes(providerCanary),
      false,
      scenario.name,
    );
  }
});

await test('native start shares the command deadline and maps cancellation and protocol failures', async () => {
  for (const mode of ['deadline', 'cancellation']) {
    const harness = diagnosticsHarness(mode === 'deadline' ? 90 : 91);
    const controller = new AbortController();
    let fetchCalls = 0;
    let webSocketCalls = 0;
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch: async (_input, init = {}) => {
        fetchCalls += 1;
        return new Promise((_, reject) => {
          const rejectAbort = () => reject(init.signal.reason);
          init.signal.addEventListener('abort', rejectAbort, { once: true });
          if (init.signal.aborted) rejectAbort();
        });
      },
      webSocketFactory: () => {
        webSocketCalls += 1;
        throw new Error('attach must not begin before start settles');
      },
    });
    const startedAt = Date.now();
    const execution = client.exec({
      sandboxId: `START_${mode.toUpperCase()}_RESOURCE_CANARY`,
      command: `printf START_${mode.toUpperCase()}_COMMAND_CANARY`,
      timeoutMs: mode === 'deadline' ? 30 : 1_000,
      cancellationSignal: controller.signal,
      diagnostics: harness.diagnostics,
      commandKind: 'runtime_setup',
    });
    if (mode === 'cancellation') {
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
    }
    await assert.rejects(
      () => withDeadline(execution, 500),
      (error) =>
        error?.code === 'sandbox_command_settlement_error' &&
        error?.settlement ===
          (mode === 'deadline' ? 'timeout' : 'cancellation'),
    );
    await flushDiagnostics();
    assert.equal(fetchCalls, 1);
    assert.equal(webSocketCalls, 0);
    assert.ok(Date.now() - startedAt < 500, 'start must consume one budget only');
    const expectedOutcome =
      mode === 'deadline' ? 'timed_out' : 'cancelled';
    const started = assertLifecycle(
      harness.events,
      'native_exec_start',
      expectedOutcome,
    );
    const settled = assertLifecycle(
      harness.events,
      'native_exec_settlement',
      expectedOutcome,
    );
    assert.equal(started[1].cause, mode === 'deadline' ? 'settlement_unknown' : 'cancelled');
    assert.equal(settled[1].cause, mode === 'deadline' ? 'settlement_unknown' : 'cancelled');
    assertNoRawMaterial(harness.events, [
      `START_${mode.toUpperCase()}_RESOURCE_CANARY`,
      `START_${mode.toUpperCase()}_COMMAND_CANARY`,
    ]);
  }

  const harness = diagnosticsHarness(92);
  const responseCanary = 'RAW_START_PROTOCOL_RESPONSE_CANARY';
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: async () => response(200, { unexpected: responseCanary }),
    webSocketFactory: () => {
      throw new Error('attach must not begin after malformed start');
    },
  });
  await assert.rejects(
    () =>
      client.exec({
        sandboxId: 'START_PROTOCOL_RESOURCE_CANARY',
        command: 'printf START_PROTOCOL_COMMAND_CANARY',
        diagnostics: harness.diagnostics,
        commandKind: 'runtime_setup',
      }),
    (error) =>
      error?.code === 'sandbox_command_settlement_error' &&
      error?.settlement === 'protocol' &&
      !JSON.stringify(error).includes(responseCanary),
  );
  await flushDiagnostics();
  const started = assertLifecycle(
    harness.events,
    'native_exec_start',
    'failed',
  );
  const settled = assertLifecycle(
    harness.events,
    'native_exec_settlement',
    'failed',
  );
  assert.equal(started[1].cause, 'protocol_failed');
  assert.equal(settled[1].cause, 'protocol_failed');
  assertNoRawMaterial(harness.events, [
    responseCanary,
    'START_PROTOCOL_RESOURCE_CANARY',
    'START_PROTOCOL_COMMAND_CANARY',
  ]);
});

await test('native start preserves one deadline across transport response and parse boundaries', async () => {
  const scenarios = [
    {
      name: 'transport-before-deadline',
      expectedSettlement: null,
      fetch: async () => {
        throw new Error('native start transport unavailable');
      },
    },
    {
      name: 'response-after-deadline',
      expectedSettlement: 'timeout',
      fetch: async ({ clock }) => {
        clock.advance(100);
        return response(200, { execution_id: 'late-response-execution' });
      },
    },
    {
      name: 'response-after-cancellation',
      expectedSettlement: 'cancellation',
      fetch: async ({ controller }) => {
        controller.abort();
        return response(200, { execution_id: 'cancelled-response-execution' });
      },
    },
    {
      name: 'parse-crosses-deadline',
      expectedSettlement: 'timeout',
      fetch: async ({ clock }) =>
        response(
          200,
          new Proxy(
            {},
            {
              get(_target, property) {
                if (property === 'execution_id') {
                  clock.elapseWithoutTimer(100);
                }
                return undefined;
              },
            },
          ),
        ),
    },
  ];

  for (const [offset, scenario] of scenarios.entries()) {
    const clock = nativeDeadlineHarness();
    const harness = diagnosticsHarness(120 + offset);
    const controller = new AbortController();
    let socketCalls = 0;
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      nativeExecutionDeadlineDriver: clock.driver,
      fetch: async () => scenario.fetch({ clock, controller }),
      webSocketFactory: () => {
        socketCalls += 1;
        throw new Error('attach must not start after native start rejection');
      },
    });

    await assert.rejects(
      () =>
        client.exec({
          sandboxId: `START_BOUNDARY_${scenario.name}_RESOURCE_CANARY`,
          command: `printf START_BOUNDARY_${scenario.name}_COMMAND_CANARY`,
          timeoutMs: 100,
          cancellationSignal: controller.signal,
          diagnostics: harness.diagnostics,
          commandKind: 'runtime_setup',
        }),
      (error) =>
        scenario.expectedSettlement === null
          ? error?.message === 'native start transport unavailable'
          : error?.code === 'sandbox_command_settlement_error' &&
            error?.settlement === scenario.expectedSettlement,
      scenario.name,
    );
    await flushDiagnostics();

    assert.equal(socketCalls, 0, scenario.name);
    assert.equal(clock.activeDeadlineCount(), 0, scenario.name);
    const timedOut = scenario.expectedSettlement === 'timeout';
    const cancelled = scenario.expectedSettlement === 'cancellation';
    assertLifecycle(
      harness.events,
      'native_exec_start',
      timedOut ? 'timed_out' : cancelled ? 'cancelled' : 'indeterminate',
    );
    assertLifecycle(
      harness.events,
      'native_exec_settlement',
      timedOut ? 'timed_out' : cancelled ? 'cancelled' : 'failed',
    );
    assertNoRawMaterial(harness.events, [
      `START_BOUNDARY_${scenario.name}_RESOURCE_CANARY`,
      `START_BOUNDARY_${scenario.name}_COMMAND_CANARY`,
      'late-response-execution',
      'cancelled-response-execution',
    ]);
  }
});

await test('native poll rejects evidence that arrives after the shared deadline', async () => {
  for (const [offset, mode] of ['response', 'transport-rejection'].entries()) {
    const sandboxId = `POLL_DEADLINE_${mode}_RESOURCE_CANARY`;
    const executionId = `POLL_DEADLINE_${mode}_EXECUTION_CANARY`;
    const clock = nativeDeadlineHarness();
    const harness = diagnosticsHarness(130 + offset);
    let socket;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]: () => {
        // Model a fetch implementation that settles at the same instant as the
        // command deadline. The coordinator must inspect the shared monotonic
        // budget again before trusting either a response or a rejection.
        clock.elapseWithoutTimer(100);
        if (mode === 'transport-rejection') {
          throw new Error('late poll transport rejection');
        }
        return response(200, { status: 'completed', exit_code: 0 });
      },
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      nativeExecutionDeadlineDriver: clock.driver,
      fetch,
      webSocketFactory: () => {
        socket = new EventEmitter();
        socket.readyState = 1;
        socket.close = () => {
          socket.readyState = 3;
          socket.emit('close');
        };
        socket.terminate = socket.close;
        return socket;
      },
    });

    await assert.rejects(
      () =>
        client.exec({
          sandboxId,
          command: `printf POLL_DEADLINE_${mode}_COMMAND_CANARY`,
          timeoutMs: 100,
          diagnostics: harness.diagnostics,
          commandKind: 'runtime_setup',
        }),
      (error) =>
        error?.code === 'sandbox_command_settlement_error' &&
        error?.settlement === 'indeterminate',
      mode,
    );
    await flushDiagnostics();

    assert.equal(clock.activeDeadlineCount(), 0, mode);
    assert.equal(socket.listenerCount('message'), 0, mode);
    assert.equal(socket.listenerCount('close'), 0, mode);
    assert.equal(socket.listenerCount('error'), 0, mode);
    const poll = assertLifecycle(
      harness.events,
      'native_exec_poll',
      'indeterminate',
    );
    assert.equal(poll[1].cause, 'settlement_unknown');
    assert.equal(poll[1].anomaly, 'poll_timeout');
    assert.equal(poll[1].timeoutMs, 100);
    assertLifecycle(harness.events, 'native_exec_attach', 'timed_out');
    assertNoRawMaterial(harness.events, [
      sandboxId,
      executionId,
      `POLL_DEADLINE_${mode}_COMMAND_CANARY`,
      'late poll transport rejection',
    ]);
  }
});

await test('native attach folds output frames into one safe lifecycle', async () => {
  const sandboxId = 'RAW_ATTACH_RESOURCE_CANARY';
  const executionId = 'RAW_ATTACH_EXECUTION_CANARY';
  const output = 'RAW_ATTACH_OUTPUT_FRAME_CANARY';
  const harness = diagnosticsHarness(10);
  const { fetch } = makeFetch({
    [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
      execution_id: executionId,
    }),
    [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]:
      response(200, { status: 'completed', exit_code: 0 }),
  });
  const webSocketFactory = () => {
    const socket = new EventEmitter();
    socket.close = () => {};
    setImmediate(() => {
      socket.emit(
        'message',
        Buffer.concat([Buffer.from([1]), Buffer.from(output)]),
        true,
      );
      socket.emit(
        'message',
        Buffer.concat([Buffer.from([1]), Buffer.from(output)]),
        true,
      );
      socket.emit(
        'message',
        Buffer.from('{"type":"exit","exit_code":0}'),
        false,
      );
      socket.emit('close');
    });
    return socket;
  };
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
    webSocketFactory,
  });

  const result = await client.exec({
    sandboxId,
    command: 'printf RAW_ATTACH_COMMAND_CANARY',
    diagnostics: harness.diagnostics,
    commandKind: 'runtime_setup',
  });
  await flushDiagnostics();

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `${output}${output}`);
  assertLifecycle(harness.events, 'native_exec_attach', 'succeeded');
  assert.equal(harness.events.length, 8);
  assertNoRawMaterial(harness.events, [
    sandboxId,
    executionId,
    output,
    'RAW_ATTACH_COMMAND_CANARY',
  ]);
});

await test('native attach joins poll-first replay and attach-first fragmented output', async () => {
  {
    const sandboxId = 'POLL_FIRST_REPLAY_RESOURCE_CANARY';
    const executionId = 'POLL_FIRST_REPLAY_EXECUTION_CANARY';
    let socket;
    let pollCalls = 0;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]: () => {
        pollCalls += 1;
        return response(200, { status: 'completed', exit_code: 0 });
      },
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: () => {
        socket = new EventEmitter();
        socket.close = () => {};
        return socket;
      },
    });

    let resolved = false;
    const execution = client
      .exec({
        sandboxId,
        command: 'true',
        timeoutMs: 1_000,
      })
      .then((value) => {
        resolved = true;
        return value;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(pollCalls >= 1);
    assert.equal(resolved, false, 'poll settlement must not fabricate empty output');
    socket.emit(
      'message',
      Buffer.from('{"type":"exit","exit_code":0}'),
      false,
    );
    const result = await execution;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(result.output, '');
  }

  {
    const sandboxId = 'ATTACH_FIRST_FRAGMENT_RESOURCE_CANARY';
    const executionId = 'ATTACH_FIRST_FRAGMENT_EXECUTION_CANARY';
    let socket;
    let resolvePoll;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]: () =>
        new Promise((resolve) => {
          resolvePoll = resolve;
        }),
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: () => {
        socket = new EventEmitter();
        socket.close = () => {};
        return socket;
      },
    });
    let resolved = false;
    const execution = client
      .exec({
        sandboxId,
        command: 'printf fragmented',
        timeoutMs: 1_000,
      })
      .then((value) => {
        resolved = true;
        return value;
      });
    await new Promise((resolve) => setImmediate(resolve));
    const stdout = Buffer.from('A😀');
    const stderr = Buffer.from('错误');
    socket.emit(
      'message',
      Buffer.concat([Buffer.from([1]), stdout.subarray(0, 3)]),
      true,
    );
    socket.emit(
      'message',
      Buffer.concat([Buffer.from([2]), stderr.subarray(0, 2)]),
      true,
    );
    socket.emit(
      'message',
      Buffer.concat([Buffer.from([1]), stdout.subarray(3)]),
      true,
    );
    socket.emit(
      'message',
      Buffer.concat([Buffer.from([2]), stderr.subarray(2)]),
      true,
    );
    socket.emit(
      'message',
      Buffer.from('{"type":"exit","exit_code":0}'),
      false,
    );
    await Promise.resolve();
    assert.equal(resolved, false, 'attach exit must not replace poll authority');
    resolvePoll(response(200, { status: 'completed', exit_code: 0 }));
    const result = await execution;
    assert.equal(result.stdout, 'A😀');
    assert.equal(result.stderr, '错误');
    assert.equal(result.output, 'A😀错误');
  }
});

await test('native attach validates terminal control and poll exit consistency', async () => {
  const run = async ({ pollExitCode, attachFrame, stderr = '' }) => {
    const sandboxId = `TERMINAL_MATCH_${pollExitCode}_RESOURCE_CANARY`;
    const executionId = `TERMINAL_MATCH_${pollExitCode}_EXECUTION_CANARY`;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]:
        response(200, {
          status: 'completed',
          exit_code: pollExitCode,
        }),
    });
    return new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: () => {
        const socket = new EventEmitter();
        socket.close = () => {};
        setImmediate(() => {
          if (stderr) {
            socket.emit(
              'message',
              Buffer.concat([Buffer.from([2]), Buffer.from(stderr)]),
              true,
            );
          }
          socket.emit('message', Buffer.from(attachFrame), false);
        });
        return socket;
      },
    }).exec({
      sandboxId,
      command: 'false',
      timeoutMs: 1_000,
    });
  };

  const nonZero = await run({
    pollExitCode: 7,
    attachFrame: '{"type":"exit","exit_code":7}',
    stderr: 'expected failure',
  });
  assert.equal(nonZero.exitCode, 7);
  assert.equal(nonZero.stderr, 'expected failure');

  for (const attachFrame of [
    '{"type":"exit","exit_code":9}',
    '{"type":"exit"}',
    '{"type":"error","message":"RAW_CONTROL_ERROR_CANARY"}',
    'RAW_MALFORMED_CONTROL_CANARY',
  ]) {
    await assert.rejects(
      () => run({ pollExitCode: 0, attachFrame }),
      (error) =>
        error?.code === 'sandbox_command_output_settlement_error' &&
        error?.settlement === 'protocol' &&
        !JSON.stringify(error).includes('RAW_'),
    );
  }
});

await test('native attach transport failures fail closed without masking poll settlement', async () => {
  const failureCases = [
    [
      'constructor',
      () => {
        throw new Error('RAW_ATTACH_CONSTRUCTOR_CANARY');
      },
    ],
    [
      'error',
      () => {
        const socket = new EventEmitter();
        socket.close = () => {};
        setImmediate(() =>
          socket.emit('error', new Error('RAW_ATTACH_ERROR_CANARY')),
        );
        return socket;
      },
    ],
    [
      'early-close',
      () => {
        const socket = new EventEmitter();
        socket.close = () => {};
        setImmediate(() => socket.emit('close'));
        return socket;
      },
    ],
    [
      'malformed-frame',
      () => {
        const socket = new EventEmitter();
        socket.close = () => {};
        setImmediate(() => socket.emit('message', {}, true));
        return socket;
      },
    ],
  ];
  for (const [
    offset,
    [failureKind, webSocketFactory],
  ] of failureCases.entries()) {
    const sandboxId = `RAW_ATTACH_${failureKind}_RESOURCE_CANARY`;
    const executionId = `RAW_ATTACH_${failureKind}_EXECUTION_CANARY`;
    const harness = diagnosticsHarness(100 + offset);
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]:
        response(200, { status: 'completed', exit_code: 0 }),
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory,
    });

    await assert.rejects(
      () =>
        client.exec({
          sandboxId,
          command: `printf RAW_ATTACH_${failureKind}_COMMAND_CANARY`,
          diagnostics: harness.diagnostics,
          commandKind: 'runtime_setup',
        }),
      (error) =>
        error?.code === 'sandbox_command_output_settlement_error' &&
        error?.settlement ===
          (failureKind === 'malformed-frame' ? 'protocol' : 'transport'),
    );
    await flushDiagnostics();

    const attach = assertLifecycle(
      harness.events,
      'native_exec_attach',
      'degraded',
    );
    assert.equal(
      attach[1].cause,
      failureKind === 'malformed-frame'
        ? 'protocol_failed'
        : 'transport_failed',
    );
    assert.equal(attach[1].anomaly, 'attach_degraded');
    const settlement = assertLifecycle(
      harness.events,
      'native_exec_settlement',
      'failed',
    );
    assert.equal(
      settlement[1].cause,
      failureKind === 'malformed-frame'
        ? 'protocol_failed'
        : 'transport_failed',
    );
    assertNoRawMaterial(harness.events, [
      sandboxId,
      executionId,
      `RAW_ATTACH_${failureKind}_COMMAND_CANARY`,
      'RAW_ATTACH_CONSTRUCTOR_CANARY',
      'RAW_ATTACH_ERROR_CANARY',
    ]);
  }
});

await test('native attach rejects invalid binary channels and closes setup failures', async () => {
  const cases = [
    {
      name: 'empty-binary',
      settlement: 'protocol',
      configure(socket) {
        setImmediate(() => socket.emit('message', Buffer.alloc(0), true));
      },
    },
    {
      name: 'unknown-channel',
      settlement: 'protocol',
      configure(socket) {
        setImmediate(() =>
          socket.emit('message', Buffer.from([9, 1, 2, 3]), true),
        );
      },
    },
    {
      name: 'listener-registration',
      settlement: 'transport',
      configure(socket) {
        const register = socket.on.bind(socket);
        socket.on = (event, listener) => {
          if (event === 'close') {
            throw new Error('attach close-listener registration failed');
          }
          return register(event, listener);
        };
      },
    },
    {
      name: 'terminate-throws',
      settlement: 'protocol',
      configure(socket) {
        socket.readyState = 1;
        socket.terminate = () => {
          throw new Error('attach terminate failed');
        };
        setImmediate(() => socket.emit('message', Buffer.alloc(0), true));
      },
    },
  ];

  for (const scenario of cases) {
    const sandboxId = `ATTACH_EDGE_${scenario.name}_RESOURCE_CANARY`;
    const executionId = `ATTACH_EDGE_${scenario.name}_EXECUTION_CANARY`;
    let socket;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]:
        response(200, { status: 'completed', exit_code: 0 }),
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: () => {
        socket = new EventEmitter();
        socket.close = () => socket.emit('close');
        socket.terminate = () => socket.emit('close');
        scenario.configure(socket);
        return socket;
      },
    });

    await assert.rejects(
      () =>
        client.exec({
          sandboxId,
          command: `printf ATTACH_EDGE_${scenario.name}_COMMAND_CANARY`,
          timeoutMs: 1_000,
        }),
      (error) =>
        error?.code === 'sandbox_command_output_settlement_error' &&
        error?.settlement === scenario.settlement,
      scenario.name,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.listenerCount('message'), 0, scenario.name);
    assert.equal(socket.listenerCount('close'), 0, scenario.name);
    assert.equal(socket.listenerCount('error'), 0, scenario.name);
  }
});

await test('native attach accepts ArrayBuffer and chunk-array output without truncation', async () => {
  const sandboxId = 'ATTACH_RAW_SHAPES_RESOURCE_CANARY';
  const executionId = 'ATTACH_RAW_SHAPES_EXECUTION_CANARY';
  const { fetch } = makeFetch({
    [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
      execution_id: executionId,
    }),
    [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]:
      response(200, { status: 'completed', exit_code: 0 }),
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
    webSocketFactory: () => {
      const socket = new EventEmitter();
      socket.close = () => socket.emit('close');
      socket.terminate = () => socket.emit('close');
      setImmediate(() => {
        socket.emit(
          'message',
          Uint8Array.from([1, ...Buffer.from('stdout')]).buffer,
          true,
        );
        socket.emit(
          'message',
          [Buffer.from([2]), Buffer.from('stderr')],
          true,
        );
        socket.emit(
          'message',
          Buffer.from('{"type":"exit","exit_code":0}'),
          false,
        );
      });
      return socket;
    },
  });

  const result = await client.exec({
    sandboxId,
    command: 'printf raw-shapes',
    timeoutMs: 1_000,
  });
  assert.equal(result.stdout, 'stdout');
  assert.equal(result.stderr, 'stderr');
  assert.equal(result.output, 'stdoutstderr');
});

await test('native attach terminal paths dispose named listeners and choose close versus terminate', async () => {
  for (const mode of [
    'success',
    'protocol',
    'timeout',
    'cancellation',
    'stopped',
  ]) {
    const sandboxId = `DISPOSE_${mode.toUpperCase()}_RESOURCE_CANARY`;
    const executionId = `DISPOSE_${mode.toUpperCase()}_EXECUTION_CANARY`;
    const controller = new AbortController();
    let socket;
    let closeCalls = 0;
    let terminateCalls = 0;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]: () => {
        if (mode === 'stopped') {
          throw new Error('RAW_DISPOSAL_POLL_ERROR_CANARY');
        }
        return response(200, { status: 'completed', exit_code: 0 });
      },
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: () => {
        socket = new EventEmitter();
        socket.readyState = 1;
        const finishShutdown = () => {
          socket.readyState = 2;
          socket.emit('error', new Error('LATE_SHUTDOWN_ERROR_ONE_CANARY'));
          socket.emit('error', new Error('LATE_SHUTDOWN_ERROR_TWO_CANARY'));
          socket.readyState = 3;
          socket.emit('close');
        };
        socket.close = () => {
          closeCalls += 1;
          finishShutdown();
        };
        socket.terminate = () => {
          terminateCalls += 1;
          finishShutdown();
        };
        if (mode === 'success' || mode === 'protocol') {
          setImmediate(() =>
            socket.emit(
              'message',
              Buffer.from(
                mode === 'success'
                  ? '{"type":"exit","exit_code":0}'
                  : '{"type":"exit"}',
              ),
              false,
            ),
          );
        }
        return socket;
      },
    });
    const execution = client.exec({
      sandboxId,
      command: 'true',
      timeoutMs: mode === 'timeout' ? 30 : 1_000,
      cancellationSignal: controller.signal,
    });
    if (mode === 'cancellation') {
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
    }

    if (mode === 'success') {
      assert.equal((await withDeadline(execution, 500)).exitCode, 0);
    } else {
      await assert.rejects(
        () => withDeadline(execution, 500),
        (error) => {
          if (mode === 'stopped') {
            return (
              error?.code === 'sandbox_command_settlement_error' &&
              error?.settlement === 'transport'
            );
          }
          return (
            error?.code === 'sandbox_command_output_settlement_error' &&
            error?.settlement ===
              (mode === 'protocol'
                ? 'protocol'
                : mode === 'timeout'
                  ? 'timeout'
                  : 'cancellation')
          );
        },
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.listenerCount('message'), 0, mode);
    assert.equal(socket.listenerCount('close'), 0, mode);
    assert.equal(socket.listenerCount('error'), 0, mode);
    assert.equal(closeCalls, mode === 'success' ? 1 : 0, mode);
    assert.equal(terminateCalls, mode === 'success' ? 0 : 1, mode);
  }
});

await test('proven poll settlement waits only for the shared attach deadline', async () => {
  const sandboxId = 'RAW_ATTACH_HANG_RESOURCE_CANARY';
  const executionId = 'RAW_ATTACH_HANG_EXECUTION_CANARY';
  const harness = diagnosticsHarness(104);
  const { fetch } = makeFetch({
    [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
      execution_id: executionId,
    }),
    [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]:
      response(200, { status: 'completed', exit_code: 0 }),
  });
  let socketClosed = false;
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
    webSocketFactory: () => {
      const socket = new EventEmitter();
      socket.close = () => {
        socketClosed = true;
      };
      return socket;
    },
  });

  await assert.rejects(
    () =>
      withDeadline(
        client.exec({
          sandboxId,
          command: 'printf RAW_ATTACH_HANG_COMMAND_CANARY',
          timeoutMs: 30,
          diagnostics: harness.diagnostics,
          commandKind: 'runtime_setup',
        }),
        500,
      ),
    (error) =>
      error?.code === 'sandbox_command_output_settlement_error' &&
      error?.settlement === 'timeout',
  );
  await flushDiagnostics();

  assert.equal(socketClosed, true);
  const attach = assertLifecycle(
    harness.events,
    'native_exec_attach',
    'timed_out',
  );
  assert.equal(attach[1].cause, 'settlement_unknown');
  assert.equal(attach[1].anomaly, 'attach_degraded');
  assert.equal(attach[1].timeoutMs, 30);
  const settlement = assertLifecycle(
    harness.events,
    'native_exec_settlement',
    'timed_out',
  );
  assert.equal(settlement[1].cause, 'settlement_unknown');
  assertNoRawMaterial(harness.events, [
    sandboxId,
    executionId,
    'RAW_ATTACH_HANG_COMMAND_CANARY',
  ]);
});

await test('early attach failure still waits for later polling process truth', async () => {
  const sandboxId = 'RAW_ATTACH_TIMEOUT_RESOURCE_CANARY';
  const executionId = 'RAW_ATTACH_TIMEOUT_EXECUTION_CANARY';
  const harness = diagnosticsHarness(105);
  const { fetch } = makeFetch({
    [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
      execution_id: executionId,
    }),
    [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]:
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return response(200, { status: 'completed', exit_code: 0 });
      },
  });
  let socketClosed = false;
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
    webSocketFactory: () => {
      const socket = new EventEmitter();
      socket.close = () => {
        socketClosed = true;
      };
      setImmediate(() =>
        socket.emit('error', new Error('RAW_ATTACH_EARLY_ERROR_CANARY')),
      );
      return socket;
    },
  });

  await assert.rejects(
    () =>
      withDeadline(
        client.exec({
          sandboxId,
          command: 'printf RAW_ATTACH_TIMEOUT_COMMAND_CANARY',
          timeoutMs: 250,
          diagnostics: harness.diagnostics,
          commandKind: 'runtime_setup',
        }),
        1_000,
      ),
    (error) =>
      error?.code === 'sandbox_command_output_settlement_error' &&
      error?.settlement === 'transport',
  );
  await flushDiagnostics();

  assert.equal(socketClosed, true);
  const attach = assertLifecycle(
    harness.events,
    'native_exec_attach',
    'degraded',
  );
  assert.equal(attach[1].cause, 'transport_failed');
  assert.equal(attach[1].anomaly, 'attach_degraded');
  assert.equal(attach[1].timeoutMs, undefined);
  const poll = assertLifecycle(
    harness.events,
    'native_exec_poll',
    'succeeded',
  );
  assert.equal(poll[1].nativeState, 'completed');
  assert.equal(poll[1].exitCode, 0);
  const settlement = assertLifecycle(
    harness.events,
    'native_exec_settlement',
    'failed',
  );
  assert.equal(settlement[1].cause, 'transport_failed');
  assertNoRawMaterial(harness.events, [
    sandboxId,
    executionId,
    'RAW_ATTACH_TIMEOUT_COMMAND_CANARY',
  ]);
});

await test('native execution cancellation closes the pending settlement channel at each join order', async () => {
  {
    const sandboxId = 'CANCEL_AFTER_POLL_RESOURCE_CANARY';
    const executionId = 'CANCEL_AFTER_POLL_EXECUTION_CANARY';
    const controller = new AbortController();
    let socketClosed = false;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]:
        response(200, { status: 'completed', exit_code: 0 }),
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: () => {
        const socket = new EventEmitter();
        socket.close = () => {
          socketClosed = true;
        };
        return socket;
      },
    });
    const execution = client.exec({
      sandboxId,
      command: 'true',
      timeoutMs: 1_000,
      cancellationSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(
      () => execution,
      (error) =>
        error?.code === 'sandbox_command_output_settlement_error' &&
        error?.settlement === 'cancellation',
    );
    assert.equal(socketClosed, true);
  }

  {
    const sandboxId = 'CANCEL_AFTER_ATTACH_RESOURCE_CANARY';
    const executionId = 'CANCEL_AFTER_ATTACH_EXECUTION_CANARY';
    const controller = new AbortController();
    let socket;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]: ({
        init,
      }) =>
        new Promise((_, reject) => {
          const rejectCancellation = () => reject(init.signal.reason);
          init.signal.addEventListener('abort', rejectCancellation, {
            once: true,
          });
          if (init.signal.aborted) rejectCancellation();
        }),
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: () => {
        socket = new EventEmitter();
        socket.close = () => {};
        return socket;
      },
    });
    const execution = client.exec({
      sandboxId,
      command: 'true',
      timeoutMs: 1_000,
      cancellationSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit(
      'message',
      Buffer.from('{"type":"exit","exit_code":0}'),
      false,
    );
    controller.abort();
    await assert.rejects(
      () => execution,
      (error) =>
        error?.code === 'sandbox_command_settlement_error' &&
        error?.settlement === 'cancellation',
    );
  }

  {
    const sandboxId = 'CANCEL_AFTER_POLL_RESPONSE_RESOURCE_CANARY';
    const executionId = 'CANCEL_AFTER_POLL_RESPONSE_EXECUTION_CANARY';
    const controller = new AbortController();
    let resolvePoll;
    let socket;
    const { fetch } = makeFetch({
      [`POST /v1/default/boxes/${sandboxId}/exec`]: response(200, {
        execution_id: executionId,
      }),
      [`GET /v1/default/boxes/${sandboxId}/executions/${executionId}`]: () =>
        new Promise((resolve) => {
          resolvePoll = resolve;
        }),
    });
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch,
      webSocketFactory: () => {
        socket = new EventEmitter();
        socket.close = () => {};
        return socket;
      },
    });
    const execution = client.exec({
      sandboxId,
      command: 'true',
      timeoutMs: 1_000,
      cancellationSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit(
      'message',
      Buffer.from('{"type":"exit","exit_code":0}'),
      false,
    );
    resolvePoll(response(200, { status: 'completed', exit_code: 0 }));
    controller.abort();
    await assert.rejects(
      () => execution,
      (error) =>
        error?.code === 'sandbox_command_settlement_error' &&
        error?.settlement === 'cancellation',
    );
  }

  {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const client = new boxlite.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch: async () => {
        fetchCalls += 1;
        return response(500, null);
      },
    });
    await assert.rejects(
      () =>
        client.exec({
          sandboxId: 'CANCEL_BEFORE_START_RESOURCE_CANARY',
          command: 'true',
          cancellationSignal: controller.signal,
        }),
      (error) =>
        error?.code === 'sandbox_command_settlement_error' &&
        error?.settlement === 'cancellation',
    );
    assert.equal(fetchCalls, 0);
  }
});

await test('native execution repeatedly drains fast attach replay without races', async () => {
  const sandboxId = 'FAST_REPLAY_RESOURCE_CANARY';
  const outputs = new Map();
  let starts = 0;
  let closedSockets = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const path = url.pathname;
    if (init.method === 'POST' && path.endsWith('/exec')) {
      starts += 1;
      const executionId = `fast-exec-${starts}`;
      outputs.set(executionId, `fast-output-${starts}`);
      return response(200, { execution_id: executionId });
    }
    if (init.method === 'GET' && path.includes('/executions/fast-exec-')) {
      return response(200, { status: 'completed', exit_code: 0 });
    }
    return response(404, null);
  };
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
    webSocketFactory: (url) => {
      const executionId = decodeURIComponent(
        new URL(url).pathname.split('/').at(-2),
      );
      const output = outputs.get(executionId);
      const socket = new EventEmitter();
      socket.close = () => {
        closedSockets += 1;
      };
      setImmediate(() => {
        socket.emit(
          'message',
          Buffer.concat([Buffer.from([1]), Buffer.from(output)]),
          true,
        );
        socket.emit(
          'message',
          Buffer.from('{"type":"exit","exit_code":0}'),
          false,
        );
      });
      return socket;
    },
  });

  const results = await Promise.all(
    Array.from({ length: 75 }, (_, index) =>
      client.exec({
        sandboxId,
        command: `printf fast-output-${index + 1}`,
        timeoutMs: 1_000,
      }),
    ),
  );
  assert.equal(results.length, 75);
  for (const [index, result] of results.entries()) {
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, `fast-output-${index + 1}`);
  }
  assert.equal(closedSockets, 75);
});

await test('a later native failure in the same command group retains its own trace', async () => {
  const sandboxId = 'RAW_SECOND_EXEC_RESOURCE_CANARY';
  const firstExecutionId = 'RAW_FIRST_EXECUTION_CANARY';
  const secondExecutionId = 'RAW_SECOND_EXECUTION_CANARY';
  const secondOutput = 'RAW_SECOND_EXEC_OUTPUT_CANARY';
  const harness = diagnosticsHarness(8);
  let executionStarts = 0;
  const { fetch } = makeFetch({
    [`POST /v1/default/boxes/${sandboxId}/exec`]: () => {
      executionStarts += 1;
      return response(200, {
        execution_id:
          executionStarts === 1 ? firstExecutionId : secondExecutionId,
      });
    },
    [`GET /v1/default/boxes/${sandboxId}/executions/${firstExecutionId}`]:
      response(200, { status: 'completed', exit_code: 0 }),
    [`GET /v1/default/boxes/${sandboxId}/executions/${secondExecutionId}`]:
      response(200, { status: 'failed', stderr: secondOutput }),
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
    webSocketFactory: successfulNativeAttachFactory(),
  });
  const diagnosticSession =
    boxlite.startBoxLiteNativeExecutionDiagnosticSession(
      harness.diagnostics,
      'runtime_setup',
    );

  try {
    const first = await client.exec({
      sandboxId,
      command: 'printf first-runtime-setup',
      diagnostics: diagnosticSession.diagnostics,
      commandKind: 'runtime_setup',
    });
    assert.equal(first.exitCode, 0);
    await assert.rejects(
      () => client.exec({
        sandboxId,
        command: 'printf RAW_SECOND_EXEC_COMMAND_CANARY',
        diagnostics: diagnosticSession.diagnostics,
        commandKind: 'runtime_setup',
      }),
      (error) =>
        error?.code === 'sandbox_command_settlement_error' &&
        error?.settlement === 'failed_without_exit',
    );
  } finally {
    diagnosticSession.finish();
  }
  await diagnosticSession.diagnostics.flush();

  const starts = operationEvents(harness.events, 'native_exec_start');
  assert.equal(starts.length, 2, 'the runtime phase needs one aggregate pair');
  assert.deepEqual(
    starts.filter((event) => event.outcome !== 'started').map((event) => event.outcome),
    ['succeeded'],
  );

  const settlements = operationEvents(
    harness.events,
    'native_exec_settlement',
  );
  assert.equal(
    settlements.length,
    2,
    'the later same-phase failure must replace the representative success',
  );
  const terminals = settlements.filter((event) => event.outcome !== 'started');
  assert.deepEqual(terminals.map((event) => event.outcome), ['failed']);
  assert.equal(terminals[0].cause, 'missing_exit_code');
  assert.equal(terminals[0].anomaly, 'missing_exit_code');
  assert.equal(terminals[0].exitCode, null);
  assertNoRawMaterial(harness.events, [
    sandboxId,
    firstExecutionId,
    secondExecutionId,
    secondOutput,
    'RAW_SECOND_EXEC_COMMAND_CANARY',
  ]);
});

await test('a normal multi-command provision stays within the attempt event bound', async () => {
  const harness = diagnosticsHarness(9);
  const configResult = boxlite.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'RAW_NORMAL_PROVISION_TOKEN_CANARY',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROVIDER_ID: 'boxlite-diagnostic-count',
    BOXLITE_PROTOCOL_MODE: 'native',
    BOXLITE_TERMINAL_MODE: 'none',
    BOXLITE_CAPABILITIES:
      'command.exec,lifecycle.readoption,workspace.git.materialize',
  });
  assert.equal(configResult.status, 'valid');

  let nativeExecStarts = 0;
  const normalSandboxIds = new Set();
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = `${url.pathname}${url.search}`;
    if (method === 'POST' && path === '/v1/default/boxes') {
      const body = JSON.parse(init.body);
      normalSandboxIds.add(body.name);
      return response(200, {
        box_id: body.name,
        status: 'configured',
        image: body.image,
        disk_size_gb: body.disk_size_gb,
      });
    }
    if (method === 'POST' && path.endsWith('/start')) {
      const sandboxId = path.split('/').at(-2);
      return response(200, {
        box_id: sandboxId,
        status: 'running',
        disk_size_gb: 5,
      });
    }
    if (method === 'POST' && path.endsWith('/exec')) {
      nativeExecStarts += 1;
      return response(200, { execution_id: `normal-exec-${nativeExecStarts}` });
    }
    if (method === 'GET' && path.includes('/executions/normal-exec-')) {
      return response(200, { status: 'completed', exit_code: 0 });
    }
    if (method === 'PUT' && path.includes('/files?path=')) {
      return response(204, null);
    }
    if (method === 'GET' && path.startsWith('/v1/default/boxes/')) {
      const sandboxId = path.split('/')[4];
      if (normalSandboxIds.has(sandboxId)) {
        return response(200, { box_id: sandboxId, status: 'running' });
      }
    }
    return response(404, { error: 'unexpected normal provision route' });
  };
  const webSocketFactory = () => {
    const socket = new EventEmitter();
    socket.close = () => {};
    setImmediate(() => {
      socket.emit(
        'message',
        Buffer.from('{"type":"exit","exit_code":0}'),
        false,
      );
      socket.emit('close');
    });
    return socket;
  };
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: configResult.config.endpoint,
    apiToken: configResult.config.apiToken,
    protocolMode: 'native',
    fetch,
    webSocketFactory,
  });
  const provider = new boxlite.BoxLiteSandboxProvider({
    config: configResult.config,
    client,
    preflight: async ({ executor }) => {
      for (let ordinal = 1; ordinal <= 7; ordinal += 1) {
        await executor.exec({
          command: `printf normal-preflight-${ordinal}`,
        });
      }
      return {
        status: 'passed',
        checkedAt: '2026-07-17T00:00:00.000Z',
        probes: [],
      };
    },
    workspaceMaterialization: async (workspace) => {
      const handle = await workspace.secretFilePort.writeSecretFile({
        kind: 'git-http-credential',
        credential: workspace.plan.credential,
      });
      try {
        const signal = new AbortController().signal;
        for (const [index, stage] of [
          'remote_ref_resolution',
          'workspace_transfer',
          'checkout',
          'submodules',
        ].entries()) {
          const result = await workspace.stageExecutor.execute({
            stage,
            request: {
              command: `printf normal-workspace-${index + 1}`,
              cwd: workspace.workspaceDir,
              timeoutMs: 5_000,
            },
            signal,
            remainingTimeoutMs: 5_000,
          });
          assert.equal(result.exitCode, 0);
        }
      } finally {
        await workspace.secretFilePort.deleteSecretFile(handle);
      }
      return { status: 'succeeded', stage: 'complete' };
    },
    runtimeSetup: async ({ executor }) => {
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        const runtimeSetup =
          await core.classifySandboxRuntimeCommandExecution({
            executor,
            request: { command: `printf normal-runtime-${ordinal}` },
            descriptor: { commandKind: 'runtime_setup', ordinal },
          });
        assert.equal(runtimeSetup.outcome, 'succeeded');
      }
    },
  });

  const repositoryUrl = 'https://diagnostics.example.test/private.git';
  const secretCanary = 'RAW_NORMAL_WORKSPACE_SECRET_CANARY';

  await provider.provision({
    taskId: 'task-normal-diagnostic-count',
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    cloneSpec: null,
    workspace: {
      repositoryUrl,
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 30_000,
      credential: core.createExactHostGitCredential(
        repositoryUrl,
        `Authorization: Basic ${secretCanary}`,
      ),
    },
    diagnostics: harness.diagnostics,
  });
  await flushDiagnostics();

  assert.equal(
    nativeExecStarts,
    19,
    'the fixture must exceed the old per-command diagnostic budget',
  );
  assert.ok(harness.events.length > 0);
  assert.ok(
    harness.events.length <=
      core.SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
    `normal provision emitted ${harness.events.length} events`,
  );
  const byOperationId = new Map();
  for (const event of harness.events) {
    const retained = byOperationId.get(event.operationId) ?? [];
    retained.push(event);
    byOperationId.set(event.operationId, retained);
  }
  for (const lifecycle of byOperationId.values()) {
    assert.equal(lifecycle.length, 2);
    assert.equal(lifecycle[0].outcome, 'started');
    assert.notEqual(lifecycle[1].outcome, 'started');
  }
  assert.deepEqual(
    operationEvents(harness.events, 'native_exec_settlement')
      .filter((event) => event.outcome !== 'started')
      .map((event) => event.commandKind),
    [
      'runtime_preflight',
      undefined,
      'credential_cleanup',
      'runtime_setup',
    ],
    'phase aggregates retain a safe command kind only when it is unambiguous',
  );
  console.log(`# normal provision diagnostic events: ${harness.events.length}`);
  assertNoRawMaterial(harness.events, [
    'RAW_NORMAL_PROVISION_TOKEN_CANARY',
    secretCanary,
    'normal-preflight-1',
    'normal-preflight-7',
    'normal-workspace-1',
    'normal-workspace-4',
    'normal-runtime-1',
    'normal-runtime-4',
  ]);
});

await test('cleanup-only workspace failure never fabricates a primary failure', async () => {
  const harness = diagnosticsHarness(15);
  const configResult = boxlite.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'RAW_CLEANUP_ONLY_TOKEN_CANARY',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROVIDER_ID: 'boxlite-cleanup-only-diagnostics',
    BOXLITE_PROTOCOL_MODE: 'native',
    BOXLITE_TERMINAL_MODE: 'none',
    BOXLITE_CAPABILITIES:
      'command.exec,lifecycle.readoption,workspace.git.materialize',
  });
  assert.equal(configResult.status, 'valid');

  let present = true;
  let executionSequence = 0;
  const executionResults = new Map();
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = `${url.pathname}${url.search}`;
    if (method === 'POST' && path === '/v1/default/boxes') {
      const body = JSON.parse(init.body);
      present = true;
      return response(200, {
        box_id: body.name,
        status: 'configured',
        image: body.image,
        disk_size_gb: body.disk_size_gb,
      });
    }
    if (method === 'POST' && path.endsWith('/start')) {
      return response(200, {
        box_id: path.split('/').at(-2),
        status: 'running',
        disk_size_gb: 5,
      });
    }
    if (method === 'POST' && path.endsWith('/exec')) {
      const body = JSON.parse(init.body);
      const command = body.args?.[1] ?? '';
      const executionId = `cleanup-only-exec-${++executionSequence}`;
      executionResults.set(executionId, {
        status: 'completed',
        exit_code: command.includes('rm -f --') ? 23 : 0,
      });
      return response(200, { execution_id: executionId });
    }
    if (method === 'GET' && path.includes('/executions/cleanup-only-exec-')) {
      return response(200, executionResults.get(path.split('/').at(-1)));
    }
    if (method === 'PUT' && path.includes('/files?path=')) {
      return response(204, null);
    }
    if (method === 'DELETE' && path.startsWith('/v1/default/boxes/')) {
      present = false;
      return response(204, null);
    }
    if (method === 'GET' && path.startsWith('/v1/default/boxes/')) {
      return present
        ? response(200, {
            box_id: path.split('/')[4],
            status: 'running',
          })
        : response(404, null);
    }
    return response(404, { error: 'unexpected cleanup-only route' });
  };
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: configResult.config.endpoint,
    apiToken: configResult.config.apiToken,
    protocolMode: 'native',
    fetch,
    webSocketFactory: successfulNativeAttachFactory((url) => {
      const executionId = new URL(url).pathname.split('/').at(-2);
      return executionResults.get(executionId)?.exit_code ?? 0;
    }),
  });
  const provider = new boxlite.BoxLiteSandboxProvider({
    config: configResult.config,
    client,
    workspaceMaterialization: async (workspace) => {
      await workspace.secretFilePort.writeSecretFile({
        kind: 'git-http-credential',
        credential: workspace.plan.credential,
      });
      return { status: 'succeeded', stage: 'complete' };
    },
  });
  const repositoryUrl = 'https://diagnostics.example.test/cleanup-only.git';

  await assert.rejects(
    () => provider.provision({
      taskId: 'task-cleanup-only-diagnostics',
      modelIntent: { kind: 'runtime-default' },
      runtimeId: 'codex',
      executionMode: 'headless-exec',
      cloneSpec: null,
      workspace: {
        repositoryUrl,
        callerBranch: null,
        resolvedBranch: 'main',
        deadlineMs: 30_000,
        credential: core.createExactHostGitCredential(
          repositoryUrl,
          'Authorization: Basic RAW_CLEANUP_ONLY_SECRET_CANARY',
        ),
      },
      diagnostics: harness.diagnostics,
    }),
    (error) =>
      error?.code === 'sandbox_provider_configuration_error' &&
      error.message ===
        'BoxLite secret file removal required sandbox fencing',
  );
  await flushDiagnostics();

  assert.deepEqual(
    harness.events.filter(
      (event) =>
        event.channel === 'primary' &&
        event.outcome !== 'started' &&
        event.outcome !== 'succeeded',
    ),
    [],
  );
  assert.equal(
    operationEvents(harness.events, 'workspace_materialize').length,
    0,
  );
  const cleanupSettlement = harness.events.find(
    (event) =>
      event.channel === 'cleanup' &&
      event.operation === 'native_exec_settlement' &&
      event.outcome === 'failed',
  );
  assert.equal(cleanupSettlement?.commandKind, 'credential_cleanup');
  assert.equal(cleanupSettlement?.cause, 'command_failed');
  assertNoRawMaterial(harness.events, [
    'RAW_CLEANUP_ONLY_TOKEN_CANARY',
    'RAW_CLEANUP_ONLY_SECRET_CANARY',
    'cleanup-only.git',
  ]);
});

await test('lost delete response remains separate from confirmed absence', async () => {
  const sandboxId = 'RAW_DELETE_RESOURCE_CANARY';
  const errorCanary = 'RAW_DELETE_ERROR_CANARY';
  const harness = diagnosticsHarness(4);
  let probes = 0;
  const client = {
    async deleteSandbox() {
      throw new Error(errorCanary);
    },
    async getSandbox() {
      probes += 1;
      return null;
    },
  };

  await boxlite.deleteBoxLiteSandboxAndConfirm({
    client,
    sandboxId,
    attempts: 3,
    waitForRetry: async () => {},
    diagnostics: harness.diagnostics,
  });
  await flushDiagnostics();

  assert.equal(probes, 1);
  const deleted = assertLifecycle(
    harness.events,
    'sandbox_delete',
    'indeterminate',
  );
  assert.equal(deleted[1].cause, 'cleanup_unconfirmed');
  assert.equal(deleted[1].retryable, true);
  assertLifecycle(
    harness.events,
    'sandbox_absence_confirm',
    'succeeded',
  );
  assertNoRawMaterial(harness.events, [sandboxId, errorCanary]);
});

await test('production delete helper retains safe HTTP failure classification', async () => {
  const sandboxId = 'RAW_DELETE_HTTP_RESOURCE_CANARY';
  const responseCanary = 'RAW_DELETE_HTTP_BODY_CANARY';
  const harness = diagnosticsHarness(14);
  const { fetch } = makeFetch({
    [`DELETE /v1/default/boxes/${sandboxId}`]: response(
      503,
      { error: responseCanary },
      { text: responseCanary },
    ),
    [`GET /v1/default/boxes/${sandboxId}`]: response(404, null),
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch,
  });

  await boxlite.deleteBoxLiteSandboxAndConfirm({
    client,
    sandboxId,
    attempts: 1,
    diagnostics: harness.diagnostics,
  });
  await flushDiagnostics();

  const deleted = assertLifecycle(
    harness.events,
    'sandbox_delete',
    'failed',
  );
  assert.equal(deleted[1].cause, 'cleanup_failed');
  assert.equal(deleted[1].retryable, true);
  assert.equal(deleted[1].httpStatusClass, '5xx');
  assertLifecycle(
    harness.events,
    'sandbox_absence_confirm',
    'succeeded',
  );
  assertNoRawMaterial(harness.events, [sandboxId, responseCanary]);
});

await test('physical delete helper returns one strict secret-free result for every outcome', async () => {
  const scenarios = [
    {
      name: 'succeeded',
      expected: {
        outcome: 'succeeded',
        proof: 'found-and-cleaned',
        cause: null,
        retryable: false,
      },
      client: {
        async deleteSandbox() {},
        async getSandbox() {
          return null;
        },
      },
    },
    {
      name: 'failed',
      expected: {
        outcome: 'failed',
        proof: null,
        cause: 'cleanup_failed',
        retryable: true,
      },
      client: {
        async deleteSandbox() {
          throw new Error('RAW_FAILED_DELETE_CANARY');
        },
        async getSandbox() {
          return {
            id: 'RAW_FAILED_RESOURCE_CANARY',
            state: 'running',
          };
        },
      },
    },
    {
      name: 'indeterminate',
      expected: {
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
      },
      client: {
        async deleteSandbox() {
          throw new Error('RAW_INDETERMINATE_DELETE_CANARY');
        },
        async getSandbox() {
          throw new Error('RAW_INDETERMINATE_PROBE_CANARY');
        },
      },
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const sandboxId = `RAW_${scenario.name.toUpperCase()}_SANDBOX_CANARY`;
    const harness = diagnosticsHarness(20 + index);
    const physical = await boxlite.attemptDeleteBoxLiteSandboxAndConfirm({
      client: scenario.client,
      sandboxId,
      attempts: 1,
      diagnostics: harness.diagnostics,
    });
    await harness.diagnostics.flush();

    assert.deepEqual(physical, scenario.expected, scenario.name);
    assert.equal(Object.isFrozen(physical), true, scenario.name);
    assert.deepEqual(
      Object.keys(physical),
      ['outcome', 'proof', 'cause', 'retryable'],
      scenario.name,
    );
    assert.equal(
      JSON.stringify({ physical, events: harness.events }).includes(sandboxId),
      false,
      `${scenario.name} leaked the provider sandbox id`,
    );
    assertNoRawMaterial(harness.events, [
      sandboxId,
      'RAW_FAILED_DELETE_CANARY',
      'RAW_FAILED_RESOURCE_CANARY',
      'RAW_INDETERMINATE_DELETE_CANARY',
      'RAW_INDETERMINATE_PROBE_CANARY',
    ]);
  }
});

await test('confirmed resource presence emits one bounded failed lifecycle', async () => {
  const sandboxId = 'RAW_ABSENCE_RESOURCE_CANARY';
  const harness = diagnosticsHarness(5);
  let probes = 0;
  const client = {
    async deleteSandbox() {},
    async getSandbox() {
      probes += 1;
      return { id: sandboxId, state: 'deleting' };
    },
  };

  await assert.rejects(
    () =>
      boxlite.deleteBoxLiteSandboxAndConfirm({
        client,
        sandboxId,
        attempts: 4,
        waitForRetry: async () => {},
        diagnostics: harness.diagnostics,
      }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );
  await flushDiagnostics();

  assert.equal(probes, 4);
  assertLifecycle(harness.events, 'sandbox_delete', 'succeeded');
  const confirmed = assertLifecycle(
    harness.events,
    'sandbox_absence_confirm',
    'failed',
  );
  assert.equal(confirmed[1].cause, 'cleanup_failed');
  assert.equal(confirmed[1].retryable, true);
  assert.equal(harness.events.length, 4);
  assertNoRawMaterial(harness.events, [sandboxId]);
});

await test('operation replay identity is isolated by scope and observer', async () => {
  const first = diagnosticsHarness(6);
  const second = diagnosticsHarness(7);
  const { fetch } = makeFetch({
    'POST /v1/sandboxes': response(200, {
      data: { id: 'scope-replay-box', state: 'running' },
    }),
  });
  const client = new boxlite.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch,
  });
  const create = (diagnostics, diagnosticScope) =>
    client.createSandbox({
      taskId: 'task-scope-replay',
      sandboxId: 'scope-replay-box',
      image: 'cap-boxlite:test',
      diagnostics,
      diagnosticScope,
    });

  await create(first.diagnostics, 'resource-generation-1');
  await flushDiagnostics();
  const replayedOperationId = first.events[0].operationId;
  await create(first.diagnostics, 'resource-generation-1');
  await flushDiagnostics();
  assert.equal(first.events.length, 2, 'same-scope replay must deduplicate');
  assert.equal(first.events[1].operationId, replayedOperationId);

  await create(first.diagnostics, 'resource-generation-2');
  await flushDiagnostics();
  assert.equal(first.events.length, 4);
  const newScopeOperationId = first.events[2].operationId;
  assert.notEqual(newScopeOperationId, replayedOperationId);
  assert.equal(first.events[3].operationId, newScopeOperationId);

  await create(second.diagnostics, 'resource-generation-1');
  await flushDiagnostics();
  assert.equal(second.events.length, 2);
  assert.notEqual(second.events[0].operationId, replayedOperationId);
  assert.equal(second.events[1].operationId, second.events[0].operationId);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
