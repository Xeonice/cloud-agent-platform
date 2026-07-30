import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);

function nonPersistingDiagnostics(
  createOperationId = () => '25000000-0000-4000-8000-000000000001',
) {
  return core.createNonPersistingSandboxProvisioningDiagnosticObserver({
    createOperationId,
  });
}

function validationEnvironment(overrides = {}) {
  return {
    environmentId: 'boxlite-validation',
    sourceKind: 'boxlite-image',
    sourceRef: 'registry.example.test/cap:v1@sha256:validation',
    ...overrides,
  };
}

function boxLiteProviderConfig(overrides = {}) {
  const parsed = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'registry.example.test/cap:v1',
    BOXLITE_PROVIDER_ID: 'boxlite-boundary',
    BOXLITE_CAPABILITIES: 'command.exec',
    ...overrides,
  });
  assert.equal(parsed.status, 'valid', parsed.errors?.join('\n'));
  return parsed.config;
}

function successfulExec(overrides = {}) {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    output: '',
    timedOut: false,
    ...overrides,
  };
}

function fetchResponse(status, body, extras = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return extras.text ?? '';
    },
    async arrayBuffer() {
      return extras.arrayBuffer ?? new Uint8Array().buffer;
    },
  };
}

function quietSocket(onReady) {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.close = () => {
    socket.readyState = 3;
    socket.emit('close');
  };
  socket.terminate = socket.close;
  onReady?.(socket);
  return socket;
}

function nativeExecutionFetch({ pollBody = { status: 'completed', exit_code: 0 } } = {}) {
  return async (url, init) => {
    const pathname = new URL(url).pathname;
    if (init.method === 'POST' && pathname.endsWith('/exec')) {
      return fetchResponse(200, { execution_id: 'boundary-execution' });
    }
    if (init.method === 'GET' && pathname.endsWith('/executions/boundary-execution')) {
      return fetchResponse(200, pollBody);
    }
    return fetchResponse(404, null);
  };
}

function validationClient(overrides = {}) {
  const calls = [];
  const sandbox = {
    id: 'provider-returned-probe',
    taskId: 'probe-task',
    state: 'running',
    image: 'registry.example.test/cap:v1@sha256:validation',
  };
  return {
    calls,
    async createSandbox(request) {
      calls.push(['createSandbox', request]);
      return sandbox;
    },
    async startExecution(request) {
      calls.push(['startExecution', request]);
      return { id: 'probe-execution', sandboxId: request.sandboxId };
    },
    async exec(request) {
      calls.push(['exec', request]);
      return successfulExec();
    },
    async getSandbox(id) {
      calls.push(['getSandbox', id]);
      return id === sandbox.id ? sandbox : null;
    },
    async deleteSandbox(id) {
      calls.push(['deleteSandbox', id]);
    },
    ...overrides,
  };
}

async function* chunks(...values) {
  for (const value of values) yield new Uint8Array(value);
}

await (async function workspaceBoundaries() {
  assert.deepEqual(
    await mod.deliverGitWorkspaceChanges({
      executor: { exec: async () => successfulExec() },
      workspacePath: '/workspace',
      args: {},
    }),
    {
      hadChanges: false,
      commitSha: null,
      error: 'Legacy provider-local Git delivery is disabled',
    },
  );

  assert.throws(() => mod.requireGitCloneSpec(null), /requires a clone spec/);
  assert.throws(() => mod.requireGitCloneSpec({}), /requires a clone spec/);
  assert.deepEqual(mod.requireGitCloneSpec({ url: 'https://example.test/repo.git' }), {
    url: 'https://example.test/repo.git',
    authHeader: undefined,
  });
  assert.deepEqual(
    mod.requireGitCloneSpec({
      url: 'https://example.test/repo.git',
      authHeader: 'Authorization: Basic value',
    }),
    {
      url: 'https://example.test/repo.git',
      authHeader: 'Authorization: Basic value',
    },
  );
  assert.deepEqual(
    mod.requireGitCloneSpec({
      url: 'https://example.test/repo.git',
      authHeader: 123,
    }),
    { url: 'https://example.test/repo.git', authHeader: undefined },
  );
  await assert.rejects(
    () =>
      mod.materializeGitWorkspace({
        executor: { exec: async () => successfulExec() },
        workspacePath: '/workspace',
        cloneSpec: {
          url: 'https://example.test/repo.git',
          authHeader: 'Authorization: Basic secret',
        },
      }),
    /raw-header Git clone is disabled/,
  );

  const commands = [];
  await mod.materializeGitWorkspace({
    executor: {
      async exec(request) {
        commands.push(request.command);
        return successfulExec();
      },
    },
    workspacePath: "/project's/worktree/",
    cloneSpec: { url: "https://example.test/owner's-repo.git" },
  });
  assert.match(commands[0], /mkdir -p '\/project'\\''s'/);
  assert.match(commands[0], /git clone --recursive/);

  const rootParentCommands = [];
  await mod.materializeGitWorkspace({
    executor: {
      async exec(request) {
        rootParentCommands.push(request.command);
        return successfulExec();
      },
    },
    workspacePath: '/workspace',
    cloneSpec: { url: 'https://example.test/repo.git' },
  });
  assert.match(rootParentCommands[0], /mkdir -p '\/'/);

  await assert.rejects(
    () =>
      mod.materializeGitWorkspace({
        executor: {
          exec: async () => successfulExec({ exitCode: 7, output: 'clone failed' }),
        },
        workspacePath: '/workspace',
        cloneSpec: { url: 'https://example.test/repo.git' },
      }),
    /BoxLite git materialization failed: clone failed/,
  );
})();

await (async function preflightCapabilityBoundaries() {
  const nativeDiskConfig = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'registry.example.test/cap:v1',
    BOXLITE_PROTOCOL_MODE: 'native',
    BOXLITE_CAPABILITIES: 'command.exec,resource.disk-size-gb',
  });
  assert.equal(nativeDiskConfig.status, 'valid');
  assert.equal(
    nativeDiskConfig.config.capabilities.filter(
      (capability) => capability === 'resource.disk-size-gb',
    ).length,
    1,
  );

  assert.deepEqual(
    mod.requiredToolsForBoxLiteCapabilities([
      'terminal.websocket',
      'workspace.git.materialize',
      'transcript.retained-read',
    ]),
    ['bash', 'cat', 'find', 'git', 'python3', 'sh'],
  );

  const preflight = mod.createBoxLiteRuntimePreflight({
    requiredTools: [],
    now: () => new Date('2026-07-25T00:00:00.000Z'),
  });
  const result = await preflight({
    provider: { getProviderId: () => 'boxlite-boundary' },
    sandbox: { id: 'unknown-source' },
    runtimeId: null,
    executor: { exec: async () => successfulExec() },
  });
  assert.equal(result.image, undefined);
})();

await (async function validationConfigurationBoundaries() {
  await assert.rejects(
    () =>
      mod.validateBoxLiteEnvironment({
        environment: validationEnvironment(),
        client: validationClient(),
        diagnostics: { mode: 'task' },
      }),
    /requires a non-persisting diagnostic observer/,
  );
  await assert.rejects(
    () =>
      mod.validateBoxLiteEnvironment({
        environment: validationEnvironment(),
        client: validationClient(),
        diagnostics: nonPersistingDiagnostics(() => {
          throw new Error('identity unavailable');
        }),
      }),
    /could not allocate a CAP probe identity/,
  );
})();

await (async function validationFailureBoundaries() {
  const imageFallback = await mod.validateBoxLiteEnvironment({
    environment: validationEnvironment(),
    client: validationClient({
      async createSandbox(request) {
        return { id: request.sandboxId, taskId: request.taskId, state: 'running' };
      },
      async getSandbox() {
        return null;
      },
    }),
    diagnostics: nonPersistingDiagnostics(),
  });
  assert.equal(imageFallback.status, 'passed');
  assert.match(imageFallback.probes[0].output, /sha256:validation/);

  const missingSourceKind = await mod.validateBoxLiteEnvironment({
    environment: validationEnvironment({ sourceKind: undefined }),
    client: validationClient(),
    diagnostics: nonPersistingDiagnostics(),
  });
  assert.match(missingSourceKind.error, /source unknown/);

  const unknownSource = await mod.validateBoxLiteEnvironment({
    environment: validationEnvironment({
      sourceKind: 'boxlite-rootfs',
      sourceRef: '/var/lib/boxlite/rootfs.img',
    }),
    client: validationClient(),
    diagnostics: nonPersistingDiagnostics(),
  });
  assert.equal(unknownSource.status, 'failed');
  assert.match(unknownSource.error, /cannot validate environment source boxlite-rootfs/);

  const nonErrorCreate = await mod.validateBoxLiteEnvironment({
    environment: validationEnvironment(),
    client: validationClient({
      async createSandbox() {
        throw 'manifest unknown';
      },
    }),
    diagnostics: nonPersistingDiagnostics(),
  });
  assert.match(nonErrorCreate.error, /image not found or inaccessible/);

  const networkFailure = await mod.validateBoxLiteEnvironment({
    environment: validationEnvironment(),
    client: validationClient({
      async createSandbox() {
        throw new Error('network is unreachable token=private-value');
      },
    }),
    diagnostics: nonPersistingDiagnostics(),
  });
  assert.match(networkFailure.error, /registry unreachable/);
  assert.doesNotMatch(networkFailure.error, /private-value/);

  const capacityFailure = await mod.validateBoxLiteEnvironment({
    environment: validationEnvironment({ resources: { diskSizeGb: 4 } }),
    client: validationClient({
      async exec(request) {
        return successfulExec({
          exitCode: request.command.startsWith('df -Pk') ? 1 : 0,
          output: 'capacity insufficient',
        });
      },
    }),
    diagnostics: nonPersistingDiagnostics(),
  });
  assert.equal(capacityFailure.status, 'failed');
  assert.equal(capacityFailure.probes.at(-1).name, 'disk-capacity');

  const requiredCommandFailure = await mod.validateBoxLiteEnvironment({
    environment: validationEnvironment(),
    client: validationClient({
      async exec(request) {
        return successfulExec({
          exitCode: request.command === 'command -v codex' ? 127 : 0,
          output: request.command === 'command -v codex' ? 'missing' : '',
        });
      },
    }),
    diagnostics: nonPersistingDiagnostics(),
    requiredCommands: [{ name: 'codex', command: 'command -v codex' }],
  });
  assert.equal(requiredCommandFailure.status, 'failed');
  assert.equal(requiredCommandFailure.probes.at(-1).name, 'codex');

  let cleanupError;
  const cleanupFailure = await mod.validateBoxLiteEnvironment({
    environment: validationEnvironment(),
    client: validationClient({
      async getSandbox() {
        return { id: 'provider-returned-probe', state: 'running' };
      },
      async deleteSandbox() {
        throw new Error('delete unavailable');
      },
    }),
    diagnostics: nonPersistingDiagnostics(),
    onCleanupError(error) {
      cleanupError = error;
    },
  });
  assert.equal(cleanupFailure.status, 'failed');
  assert.equal(cleanupFailure.probes.at(-1).name, 'cleanup');
  assert.match(cleanupError.message, /credential safety fencing could not be confirmed/);
  assert.doesNotMatch(cleanupError.message, /delete unavailable/);

  await assert.rejects(
    () =>
      mod.probeBoxLiteDiskCapacity({
        client: {
          async exec() {
            throw new Error('private endpoint detail');
          },
        },
        sandboxId: 'box',
        diskSizeGb: 1,
      }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'readiness',
  );
})();

await (async function archiveTransferFailureBoundaries() {
  assert.equal(mod.formatBoxLiteArchivePartName(999_999), '999999');
  assert.throws(
    () => mod.formatBoxLiteArchivePartName(1_000_000),
    (error) => error?.reason === 'part_upload_failed',
  );
  for (const invalid of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      async () => {
        for await (const _part of mod.splitIntoParts(chunks([1]), invalid)) {
          // The iterator itself owns validation.
        }
      },
      /partBytes must be a positive integer/,
    );
  }

  const signal = new AbortController().signal;
  const calls = [];
  let progressCalls = 0;
  await mod.uploadBoxLiteArchiveInParts({
    client: {
      async uploadArchive(request) {
        calls.push(['upload', request]);
      },
      async exec(request) {
        calls.push(['exec', request]);
        return { exitCode: 0, output: '' };
      },
    },
    sandboxId: 'box-success',
    path: "/workspace's/archive",
    archive: chunks([1, 2], [3]),
    partBytes: 2,
    signal,
    execTimeoutMs: 321,
    onBytesUploaded() {
      progressCalls += 1;
      throw new Error('observer failure must not affect transfer');
    },
  });
  assert.equal(progressCalls, 2);
  assert(calls.filter(([kind]) => kind === 'upload').every(([, value]) => value.signal === signal));
  assert(
    calls
      .filter(([kind]) => kind === 'exec')
      .every(([, value]) => value.timeoutMs === 321 && value.cancellationSignal === signal),
  );

  for (const failure of [
    { stage: 'reassemble', reason: 'reassembly_failed', output: '' },
    { stage: 'reassemble', reason: 'reassembly_failed', output: 'cat failed' },
    { stage: 'verify', reason: 'integrity_mismatch', output: '' },
    { stage: 'extract', reason: 'extract_failed', output: '' },
    { stage: 'extract', reason: 'extract_failed', output: 'tar failed' },
  ]) {
    let execIndex = 0;
    const client = {
      async uploadArchive() {},
      async exec() {
        execIndex += 1;
        const stage = execIndex === 1 ? 'reassemble' : execIndex === 2 ? 'verify' : 'extract';
        if (stage === failure.stage) return { exitCode: 9, output: failure.output };
        return { exitCode: 0, output: '' };
      },
    };
    await assert.rejects(
      () =>
        mod.uploadBoxLiteArchiveInParts({
          client,
          sandboxId: 'box-failure',
          path: '/workspace/archive',
          archive: chunks([1]),
          partBytes: 1,
        }),
      (error) => error?.reason === failure.reason,
    );
  }

  let cleanupAttempted = false;
  await assert.rejects(
    () =>
      mod.uploadBoxLiteArchiveInParts({
        client: {
          async uploadArchive() {
            throw 'lost upload response';
          },
          async exec() {
            cleanupAttempted = true;
            throw new Error('cleanup transport unavailable');
          },
        },
        sandboxId: 'box-upload-failure',
        path: '/workspace/archive',
        archive: chunks([1]),
        partBytes: 1,
      }),
    (error) =>
      error?.reason === 'part_upload_failed' &&
      error.message.includes('lost upload response'),
  );
  assert.equal(cleanupAttempted, true);
})();

await (async function restClientCollectionAndListBoundaries() {
  assert.deepEqual(
    [...(await mod.collectBoxLiteArchiveBytes(chunks([1, 2], [3])))],
    [1, 2, 3],
  );

  const listCases = [
    { body: [{ id: 'array-box' }], expected: 'array-box' },
    { body: { boxes: [{ box_id: 'boxes-box' }] }, expected: 'boxes-box' },
    { body: { sandboxes: [{ name: 'sandboxes-box' }] }, expected: 'sandboxes-box' },
    { body: { data: [{ id: 'wrapped-box' }] }, expected: 'wrapped-box' },
  ];
  for (const [index, item] of listCases.entries()) {
    const client = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: index === 0 ? 'cap-rest' : 'native',
      fetch: async () => fetchResponse(200, item.body),
    });
    assert.equal((await client.listSandboxes())[0].id, item.expected);
  }
  const nativeNamed = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: async () =>
      fetchResponse(200, {
        boxes: [{ box_id: 'provider-box-id', name: 'requested-task-name' }],
      }),
  });
  assert.equal(
    (await nativeNamed.listSandboxes())[0].taskId,
    'requested-task-name',
    'native create name remains recoverable for exact cleanup after response loss',
  );
  await assert.rejects(
    () =>
      new mod.BoxLiteRestClient({
        baseUrl: 'https://boxlite.example.test',
        fetch: async () => fetchResponse(200, { unexpected: [] }),
      }).listSandboxes(),
    /did not include a sandbox list/,
  );

  const parsedFields = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    fetch: async () =>
      fetchResponse(200, [
        {
          id: 'field-box',
          diskSizeGb: 4,
          baseUrl: 'boxlite://field-box',
          terminalUrl: 'boxlite://field-box/terminal',
          metadata: { source: 'test' },
        },
      ]),
  });
  const [fieldBox] = await parsedFields.listSandboxes();
  assert.equal(fieldBox.diskSizeGb, 4);
  assert.equal(fieldBox.baseUrl, 'boxlite://field-box');
  assert.equal(fieldBox.terminalUrl, 'boxlite://field-box/terminal');
  assert.deepEqual(fieldBox.metadata, { source: 'test' });

  const fake = new mod.FakeBoxLiteClient();
  await fake.createSandbox({ taskId: 'fake-list', image: 'image' });
  assert.equal((await fake.listSandboxes())[0].id, 'fake-list');
  await assert.rejects(
    () =>
      fake.createSandbox({
        taskId: 'fake-partial',
        image: 'image',
        onSandboxCreateObserved() {
          throw new Error('observer lost response');
        },
      }),
    (error) =>
      error?.name === 'BoxLitePartialCreateError' &&
      error.sandbox?.id === 'fake-partial',
  );

  for (const protocolMode of ['native', 'cap-rest']) {
    const client = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode,
      fetch: async (url, init) => {
        const pathname = new URL(url).pathname;
        assert.equal(init.method, 'POST');
        return fetchResponse(
          200,
          protocolMode === 'native'
            ? { id: 'native-partial', status: 'configured' }
            : { id: 'rest-partial', state: 'running' },
        );
      },
    });
    await assert.rejects(
      () =>
        client.createSandbox({
          taskId: `${protocolMode}-partial`,
          image: 'image',
          onSandboxCreateObserved(event) {
            if (event.kind === 'created') throw new Error('observer lost response');
          },
        }),
      (error) =>
        error?.name === 'BoxLitePartialCreateError' &&
        error.sandbox?.id ===
          (protocolMode === 'native' ? 'native-partial' : 'rest-partial'),
    );
  }

  const rejectedByGuard = new mod.FakeBoxLiteClient();
  await assert.rejects(
    () =>
      rejectedByGuard.createSandbox({
        taskId: 'guard-rejected',
        image: 'image',
        externalBoundaryGuard: async () => {
          throw new Error('authority rejected');
        },
      }),
    /authority rejected/,
  );
  assert.equal(rejectedByGuard.sandboxes.size, 0);

  const limitedFake = new mod.FakeBoxLiteClient({ uploadBodyLimitBytes: 1 });
  await assert.rejects(
    () =>
      limitedFake.uploadArchive({
        sandboxId: 'limited',
        path: '/workspace',
        archive: new Uint8Array([1, 2]),
      }),
    /HTTP 413.*length limit exceeded/,
  );

  const explicitNullClient = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    fetch: async () => fetchResponse(200, null),
  });
  assert.equal(await explicitNullClient.getSandbox('explicit-null'), null);
})();

await (async function streamingArchiveRequestBoundaries() {
  const forwarded = [];
  const uploadSignal = new AbortController().signal;
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: async (_url, init) => {
      assert.equal(init.duplex, 'half');
      assert.equal(init.headers['content-type'], 'application/octet-stream');
      assert.equal(init.signal, uploadSignal);
      const reader = init.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        forwarded.push(...next.value);
      }
      return fetchResponse(200, {});
    },
  });
  await client.uploadArchive({
    sandboxId: 'streaming-box',
    path: '/workspace',
    archive: chunks([1, 2], [3, 4]),
    signal: uploadSignal,
  });
  assert.deepEqual(forwarded, [1, 2, 3, 4]);

  let cancellationReason;
  const cancellable = {
    [Symbol.asyncIterator]() {
      let emitted = false;
      return {
        async next() {
          if (emitted) return { done: true, value: undefined };
          emitted = true;
          return { done: false, value: new Uint8Array([9]) };
        },
        async return(reason) {
          cancellationReason = reason;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const cancellingClient = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: async (_url, init) => {
      await init.body.cancel('consumer stopped');
      return fetchResponse(200, {});
    },
  });
  await cancellingClient.uploadArchive({
    sandboxId: 'cancel-stream',
    path: '/workspace',
    archive: cancellable,
  });
  assert.equal(cancellationReason, 'consumer stopped');

  const requestSignal = new AbortController().signal;
  let forwardedSignal;
  const signalClient = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: async (_url, init) => {
      forwardedSignal = init.signal;
      return fetchResponse(204, null);
    },
  });
  await signalClient.getSandbox('signal-box', { cancellationSignal: requestSignal });
  assert(forwardedSignal instanceof AbortSignal);
})();

await (async function nativePollParsingBoundaries() {
  const invalidCases = [
    null,
    { status: 'running', exit_code: 0 },
    { status: 'unknown-provider-state' },
    { status: 'completed' },
    { status: 'failed', exit_code: 0 },
    { status: 'timed_out', exit_code: 0 },
    { status: 'running', timed_out: 'yes' },
    { status: 'running', state: 'completed' },
    { status: 'running', timed_out: true },
    { status: 123 },
    { status: 'completed', exit_code: 0, exitCode: 1 },
    { status: 'completed', exit_code: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of invalidCases) {
    assert.equal(mod.parseBoxLiteNativeExecutionPollResult(value).kind, 'invalid');
  }

  for (const state of ['pending', 'queued', 'created', 'starting']) {
    const parsed = mod.parseBoxLiteNativeExecutionPollResult({ status: state });
    assert.equal(parsed.kind, 'pending');
    assert.equal(parsed.nativeState, 'pending');
  }
  assert.equal(
    mod.parseBoxLiteNativeExecutionPollResult({ timed_out: true }).nativeState,
    'timed_out',
  );
  for (const state of ['complete', 'exited']) {
    assert.equal(
      mod.parseBoxLiteNativeExecutionPollResult({ state, code: 0 }).outcome,
      'succeeded',
    );
  }
  for (const state of ['failed', 'killed']) {
    const missingExit = mod.parseBoxLiteNativeExecutionPollResult({ state });
    assert.equal(missingExit.kind, 'terminal');
    assert.equal(missingExit.cause, 'missing_exit_code');
    const failedExit = mod.parseBoxLiteNativeExecutionPollResult({ state, code: 7 });
    assert.equal(failedExit.cause, 'command_failed');
  }
  for (const state of ['timeout', 'timed_out']) {
    const timeout = mod.parseBoxLiteNativeExecutionPollResult({ state });
    assert.equal(timeout.outcome, 'timed_out');
    assert.equal(timeout.exitCode, null);
  }
})();

await (async function fakeArchiveParserBoundaries() {
  async function rejectsArchive(archive) {
    const fake = new mod.FakeBoxLiteClient();
    await assert.rejects(
      () =>
        fake.uploadArchive({
          sandboxId: 'fake-tar',
          path: '/workspace',
          archive,
        }),
      /failed to extract tar/,
    );
  }

  await rejectsArchive(new Uint8Array(10));
  await rejectsArchive(new Uint8Array(1024));

  const badMagic = new Uint8Array(1024);
  badMagic[0] = 0x61;
  await rejectsArchive(badMagic);

  const emptyName = new Uint8Array(1024);
  emptyName.set(Buffer.from('ustar\0'), 257);
  await rejectsArchive(emptyName);

  const truncated = new Uint8Array(512);
  truncated.set(Buffer.from('entry\0'), 0);
  truncated.set(Buffer.from('00000000010\0'), 124);
  truncated.set(Buffer.from('ustar\0'), 257);
  await rejectsArchive(truncated);

  const directoryOnly = new Uint8Array(1024);
  directoryOnly.set(Buffer.from('directory\0'), 0);
  directoryOnly.set(Buffer.from('00000000000\0'), 124);
  directoryOnly[156] = 0x35;
  directoryOnly.set(Buffer.from('ustar\0'), 257);
  await rejectsArchive(directoryOnly);

  const fake = new mod.FakeBoxLiteClient();
  await fake.uploadArchive({
    sandboxId: 'archive-paths',
    path: '/workspace',
    archive: core.createSandboxMode0600FileArchive(
      'secret.txt',
      new Uint8Array([1, 2, 3]),
    ),
  });
  assert.deepEqual(fake.archivePaths('archive-paths'), ['/workspace/secret.txt']);
})();

await (async function defaultWebSocketFactoryBoundary() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'exit', exit_code: 0 }));
  });

  try {
    const client = new mod.BoxLiteRestClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      protocolMode: 'native',
      fetch: async (url, init) => {
        const pathname = new URL(url).pathname;
        if (init.method === 'POST' && pathname.endsWith('/exec')) {
          return fetchResponse(200, { execution_id: 'default-ws-exec' });
        }
        if (init.method === 'GET' && pathname.endsWith('/executions/default-ws-exec')) {
          return fetchResponse(200, { status: 'completed', exit_code: 0 });
        }
        return fetchResponse(404, null);
      },
    });
    const result = await client.exec({
      sandboxId: 'default-ws-box',
      command: 'true',
      timeoutMs: 2_000,
    });
    assert.equal(result.exitCode, 0);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
})();

await (async function nativeExecutionRaceBoundaries() {
  const cancellationSignal = {
    reads: 0,
    get aborted() {
      this.reads += 1;
      return this.reads >= 2;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const cancelledAtPoll = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: nativeExecutionFetch(),
    webSocketFactory: () => quietSocket(),
  });
  await assert.rejects(
    () =>
      cancelledAtPoll.exec({
        sandboxId: 'cancel-at-poll',
        command: 'true',
        timeoutMs: 100,
        cancellationSignal,
      }),
    (error) => error?.settlement === 'cancellation',
  );

  let clockReads = 0;
  const deadlineBeforeAttach = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: nativeExecutionFetch(),
    webSocketFactory: () => {
      throw new Error('initial deadline must prevent socket creation');
    },
    nativeExecutionDeadlineDriver: {
      now() {
        clockReads += 1;
        return clockReads >= 4 ? 1_000 : 0;
      },
      schedule() {
        return () => {};
      },
    },
  });
  await assert.rejects(
    () =>
      deadlineBeforeAttach.exec({
        sandboxId: 'deadline-before-attach',
        command: 'true',
        timeoutMs: 100,
      }),
    (error) => error?.settlement === 'timeout',
  );

  const externalCancellation = new AbortController();
  let returnedSocket;
  const cancellationInsideFactory = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: nativeExecutionFetch(),
    webSocketFactory: () => {
      externalCancellation.abort();
      returnedSocket = quietSocket();
      return returnedSocket;
    },
  });
  await assert.rejects(
    () =>
      cancellationInsideFactory.exec({
        sandboxId: 'cancel-inside-factory',
        command: 'true',
        timeoutMs: 100,
        cancellationSignal: externalCancellation.signal,
      }),
    (error) => error?.settlement === 'cancellation',
  );
  assert.equal(returnedSocket.readyState, 3);

  let currentTime = 0;
  const deadlineOnMessage = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (init.method === 'POST') {
        return fetchResponse(200, { execution_id: 'boundary-execution' });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fetchResponse(200, { status: 'completed', exit_code: 0 });
    },
    webSocketFactory: () =>
      quietSocket((socket) => {
        setImmediate(() => {
          currentTime = 1_000;
          socket.emit('message', Buffer.from('{}'), false);
        });
      }),
    nativeExecutionDeadlineDriver: {
      now: () => currentTime,
      schedule: () => () => {},
    },
  });
  await assert.rejects(
    () =>
      deadlineOnMessage.exec({
        sandboxId: 'deadline-on-message',
        command: 'true',
        timeoutMs: 100,
      }),
    (error) =>
      error?.settlement === 'indeterminate' || error?.settlement === 'timeout',
  );

  const invalidObjectControl = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: nativeExecutionFetch(),
    webSocketFactory: () =>
      quietSocket((socket) => {
        setImmediate(() => socket.emit('message', Buffer.from('null'), false));
      }),
  });
  await assert.rejects(
    () =>
      invalidObjectControl.exec({
        sandboxId: 'invalid-control',
        command: 'true',
        timeoutMs: 100,
      }),
    (error) => error?.settlement === 'protocol',
  );
})();

await (async function nativePollAbortRegistrationRace() {
  const originalAddEventListener = AbortSignal.prototype.addEventListener;
  let triggerDeadline = () => {};
  let budgetAbortRegistrations = 0;
  AbortSignal.prototype.addEventListener = function patched(type, listener, options) {
    const result = originalAddEventListener.call(this, type, listener, options);
    if (type === 'abort') {
      budgetAbortRegistrations += 1;
      if (budgetAbortRegistrations === 2) triggerDeadline();
    }
    return result;
  };
  try {
    const client = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'native',
      fetch: nativeExecutionFetch({ pollBody: { status: 'running' } }),
      webSocketFactory: () => quietSocket(),
      nativeExecutionDeadlineDriver: {
        now: () => 0,
        schedule(_delay, trigger) {
          triggerDeadline = trigger;
          return () => {};
        },
      },
    });
    await assert.rejects(
      () =>
        client.exec({
          sandboxId: 'abort-registration-race',
          command: 'true',
          timeoutMs: 100,
        }),
      (error) => error?.settlement === 'indeterminate',
    );
  } finally {
    AbortSignal.prototype.addEventListener = originalAddEventListener;
  }
})();

await (async function nativeBudgetBoundaryRaces() {
  let remainingReads = 0;
  const remainingExpires = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: nativeExecutionFetch(),
    webSocketFactory: () => quietSocket(),
    nativeExecutionDeadlineDriver: {
      now() {
        remainingReads += 1;
        return remainingReads >= 7 ? 100 : 0;
      },
      schedule: () => () => {},
    },
  });
  await assert.rejects(
    () =>
      remainingExpires.exec({
        sandboxId: 'remaining-expires',
        command: 'true',
        timeoutMs: 50,
      }),
    (error) => error?.settlement === 'indeterminate',
  );

  let waitReads = 0;
  const waitStartsAborted = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: nativeExecutionFetch({ pollBody: { status: 'running' } }),
    webSocketFactory: () => quietSocket(),
    nativeExecutionDeadlineDriver: {
      now() {
        waitReads += 1;
        return waitReads >= 12 ? 100 : 0;
      },
      schedule: () => () => {},
    },
  });
  await assert.rejects(
    () =>
      waitStartsAborted.exec({
        sandboxId: 'wait-starts-aborted',
        command: 'true',
        timeoutMs: 50,
      }),
    (error) => error?.settlement === 'indeterminate',
  );

  let scheduledTriggers = 0;
  const duplicateDeadline = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: nativeExecutionFetch(),
    webSocketFactory: () => quietSocket(),
    nativeExecutionDeadlineDriver: {
      now: () => 0,
      schedule(_delay, trigger) {
        trigger();
        scheduledTriggers += 1;
        trigger();
        scheduledTriggers += 1;
        return () => {};
      },
    },
  });
  await assert.rejects(
    () =>
      duplicateDeadline.exec({
        sandboxId: 'duplicate-deadline',
        command: 'true',
        timeoutMs: 0,
      }),
    (error) => error?.settlement === 'timeout',
  );
  assert.equal(scheduledTriggers, 2);
})();

await (async function settledMessageIsIgnored() {
  const synchronousSocket = {
    readyState: 1,
    on(event, listener) {
      if (event === 'message') {
        listener(
          Buffer.from(JSON.stringify({ type: 'exit', exit_code: 0 })),
          false,
        );
        listener(Buffer.from('ignored-after-settlement'), false);
      }
      return this;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
    close() {},
    terminate() {},
  };
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'native',
    fetch: nativeExecutionFetch(),
    webSocketFactory: () => synchronousSocket,
  });
  assert.equal(
    (
      await client.exec({
        sandboxId: 'settled-message',
        command: 'true',
        timeoutMs: 100,
      })
    ).exitCode,
    0,
  );
})();

await (async function requestSignalFallbackBoundaries() {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'AbortSignal',
  );
  const callerSignal = new AbortController().signal;
  try {
    let observedSignal;
    Object.defineProperty(globalThis, 'AbortSignal', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const withoutPlatformTimeout = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'cap-rest',
      fetch: async (_url, init) => {
        observedSignal = init.signal;
        return fetchResponse(204, null);
      },
    });
    await withoutPlatformTimeout.getSandbox('no-platform-timeout', {
      cancellationSignal: callerSignal,
    });
    assert.equal(observedSignal, callerSignal);

    const timeoutSignal = callerSignal;
    Object.defineProperty(globalThis, 'AbortSignal', {
      configurable: true,
      writable: true,
      value: { timeout: () => timeoutSignal },
    });
    const withoutSignalAny = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'cap-rest',
      fetch: async (_url, init) => {
        observedSignal = init.signal;
        return fetchResponse(204, null);
      },
    });
    await withoutSignalAny.getSandbox('no-signal-any', {
      cancellationSignal: callerSignal,
    });
    assert.equal(observedSignal, callerSignal);
  } finally {
    Object.defineProperty(globalThis, 'AbortSignal', originalDescriptor);
  }
})();

await (async function protocolFailureCarriesCancellationSignal() {
  const signal = new AbortController().signal;
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: async () => fetchResponse(200, null),
  });
  await assert.rejects(
    () =>
      client.exec({
        sandboxId: 'invalid-exec-shape',
        command: 'true',
        cancellationSignal: signal,
      }),
    /did not include a result object/,
  );
})();

await (async function providerConflictAndCapacityBoundaries() {
  const inspectFailureClient = new mod.FakeBoxLiteClient();
  inspectFailureClient.getSandbox = async () => {
    throw new Error('inspect unavailable');
  };
  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig(),
        client: inspectFailureClient,
      }).provision({ taskId: 'inspect-failure', cloneSpec: null }),
    /inspect unavailable/,
  );

  for (const conflict of [
    Object.assign(new Error('conflict'), { status: 409 }),
    Object.assign(new Error('conflict'), { statusCode: 409 }),
    new Error('BoxLite create failed: HTTP 409 conflict'),
  ]) {
    const conflictClient = new mod.FakeBoxLiteClient();
    conflictClient.createSandbox = async () => {
      throw conflict;
    };
    await assert.rejects(
      () =>
        new mod.BoxLiteSandboxProvider({
          config: boxLiteProviderConfig(),
          client: conflictClient,
        }).provision({ taskId: `missing-${String(conflict.status ?? conflict.statusCode ?? 'message')}`, cloneSpec: null }),
      (error) => error === conflict,
    );
  }

  const generationConflictClient = new mod.FakeBoxLiteClient();
  let generationInspectCount = 0;
  generationConflictClient.createSandbox = async () => {
    throw Object.assign(new Error('conflict'), { status: 409 });
  };
  generationConflictClient.getSandbox = async () => {
    generationInspectCount += 1;
    return generationInspectCount === 1
      ? null
      : {
          id: 'generation-conflict',
          state: 'running',
          metadata: { resourceGeneration: 'resource:other' },
        };
  };
  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig({ BOXLITE_SANDBOX_ID_PREFIX: '' }),
        client: generationConflictClient,
      }).provision({
        taskId: 'generation-conflict',
        cloneSpec: null,
        ownership: {
          ownerGeneration: 'owner:expected',
          resourceGeneration: 'resource:expected',
        },
        beforeSandboxCleanup: async () => null,
        afterSandboxCleanup: async () => {},
      }),
    /resource generation mismatch/,
  );

  const capacityClient = new mod.FakeBoxLiteClient();
  const normalCreate = capacityClient.createSandbox.bind(capacityClient);
  capacityClient.createSandbox = async (request) => ({
    ...(await normalCreate(request)),
    diskSizeGb: (request.diskSizeGb ?? 1) + 1,
  });
  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig({ BOXLITE_DISK_SIZE_GB: '4' }),
        client: capacityClient,
      }).provision({ taskId: 'capacity-mismatch', cloneSpec: null }),
    (error) => error?.code === 'sandbox_provisioning_capacity_error',
  );
  assert.deepEqual(capacityClient.deletedSandboxIds, ['cap-boxlite-capacity-mismatch']);
})();

await (async function providerCleanupAndConfigurationBoundaries() {
  const retainedClient = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig(),
    client: retainedClient,
  });
  await provider.provision({ taskId: 'retained-delete', cloneSpec: null });
  retainedClient.deleteSandbox = async () => {};
  const cleanup = await provider.teardownSandbox('retained-delete');
  assert.equal(cleanup.outcome, 'failed');
  assert.deepEqual(await provider.listReadoptable(), []);

  const deliveryProvider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig({
      BOXLITE_CAPABILITIES: 'command.exec,workspace.git.deliver',
    }),
    client: new mod.FakeBoxLiteClient(),
    workspaceDelivery: async () => ({
      hadChanges: false,
      commitSha: null,
      error: null,
    }),
  });
  await deliveryProvider.provision({ taskId: 'delivery-config', cloneSpec: null });
  await assert.rejects(
    () =>
      deliveryProvider.deliverWorkspaceChanges('delivery-config', {
        branch: 'cap/delivery',
        commitMessage: 'delivery',
        beforeSandboxCleanup: async () => null,
      }),
    /cleanup callbacks must be provided together/,
  );
  await assert.rejects(
    () =>
      deliveryProvider.deliverWorkspaceChanges('delivery-config', {
        branch: 'cap/delivery',
        commitMessage: 'delivery',
        ownership: {
          ownerGeneration: 'owner:delivery',
          resourceGeneration: 'resource:delivery',
        },
      }),
    /durable delivery cleanup requires owner generation callbacks/,
  );

  const cancelledSignal = {
    aborted: true,
    reason: undefined,
    addEventListener() {},
    removeEventListener() {},
  };
  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig(),
        client: new mod.FakeBoxLiteClient(),
      }).provision({
        taskId: 'cancel-without-reason',
        cloneSpec: null,
        cancellationSignal: cancelledSignal,
      }),
    (error) => error?.name === 'AbortError',
  );
})();

await (async function providerArchiveTransferBoundaries() {
  let uploadProgress = 0;
  const archiveClient = new mod.FakeBoxLiteClient();
  const archiveProvider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig({
      BOXLITE_CAPABILITIES:
        'command.exec,workspace.archive.transfer,workspace.source.archive',
      BOXLITE_ARCHIVE_PART_BYTES: '2',
    }),
    client: archiveClient,
    workspaceMaterialization: async ({ archiveTransfer }) => {
      await archiveTransfer.uploadArchive({
        path: '/repo-source',
        archive: chunks([1, 2, 3]),
        signal: new AbortController().signal,
        onBytesUploaded(bytes) {
          uploadProgress = bytes;
        },
      });
      return { status: 'succeeded', stage: 'complete' };
    },
  });
  await archiveProvider.provision({
    taskId: 'archive-transfer',
    cloneSpec: null,
    workspace: {
      repositoryUrl: 'https://example.test/repo.git',
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 5_000,
    },
    workspaceSource: {
      kind: 'archive',
      repoId: 'repo-source',
      storePath: '/host/repo-source.git',
      gitSource: 'https://example.test/repo.git',
    },
  });
  assert.equal(uploadProgress, 3);
  assert.equal(archiveClient.archivePaths('cap-boxlite-archive-transfer').length, 1);

  const missingUploadClient = new mod.FakeBoxLiteClient();
  missingUploadClient.uploadArchive = undefined;
  const missingUploadProvider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig(),
    client: missingUploadClient,
    workspaceMaterialization: async ({ archiveTransfer }) => {
      await archiveTransfer.uploadArchive({
        path: '/repo-source',
        archive: chunks([1]),
      });
      return { status: 'succeeded', stage: 'complete' };
    },
  });
  await assert.rejects(
    () =>
      missingUploadProvider.provision({
        taskId: 'archive-upload-missing',
        cloneSpec: null,
        workspace: {
          repositoryUrl: 'https://example.test/repo.git',
          callerBranch: null,
          resolvedBranch: 'main',
          deadlineMs: 5_000,
        },
      }),
    /requires archive upload support/,
  );
})();

await (async function providerRuntimeCommandFailureBoundaries() {
  function runtimeFailure(commandKind) {
    return new core.SandboxRuntimeCommandExecutionError(
      { commandKind, ordinal: 1 },
      {
        settlement: 'exit',
        outcome: 'failed',
        cause: 'command_failed',
        retryable: false,
        exitCode: 7,
      },
    );
  }

  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig(),
        client: new mod.FakeBoxLiteClient(),
        preflight: async () => {
          throw runtimeFailure('runtime_preflight');
        },
      }).provision({ taskId: 'preflight-command-failure', cloneSpec: null }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup',
  );

  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig(),
        client: new mod.FakeBoxLiteClient(),
        runtimeSetup: async () => {
          throw runtimeFailure('runtime_setup');
        },
      }).provision({ taskId: 'setup-command-failure', cloneSpec: null }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup',
  );
})();

await (async function providerCanonicalWorkspaceGuardBoundaries() {
  const workspacePlan = {
    repositoryUrl: 'https://example.test/repo.git',
    callerBranch: null,
    resolvedBranch: 'main',
    deadlineMs: 5_000,
  };
  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig(),
        client: new mod.FakeBoxLiteClient(),
      }).provision({
        taskId: 'canonical-hook-missing',
        cloneSpec: null,
        workspace: workspacePlan,
      }),
    /requires the staged workspace hook/,
  );

  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig(),
        client: new mod.FakeBoxLiteClient(),
        workspaceMaterialization: async () => ({
          status: 'succeeded',
          stage: 'complete',
        }),
      }).provision({
        taskId: 'canonical-durable-callbacks-missing',
        cloneSpec: null,
        workspace: workspacePlan,
        ownership: {
          ownerGeneration: 'owner:workspace',
          resourceGeneration: 'resource:workspace',
        },
      }),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' ||
      /durable workspace cleanup requires/.test(error?.message ?? ''),
  );

  const underlying = new Error('underlying pending workspace failure');
  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig(),
        client: new mod.FakeBoxLiteClient(),
        workspaceMaterialization: async () => {
          throw new core.SandboxCleanupCoordinationPendingError(underlying);
        },
      }).provision({
        taskId: 'workspace-pending-primary',
        cloneSpec: null,
        workspace: workspacePlan,
      }),
    (error) => error === underlying,
  );
})();

await (async function providerCredentialFenceBoundaries() {
  const credential = core.createExactHostGitCredential(
    'https://example.test/repo.git',
    'Authorization: Basic boundary-secret',
  );
  const cleanupFailingClient = () =>
    new mod.FakeBoxLiteClient({
      execHandler: (request) =>
        successfulExec({
          exitCode: request.command.includes('rm -f --') ? 1 : 0,
        }),
    });
  const workspacePlan = {
    repositoryUrl: 'https://example.test/repo.git',
    callerBranch: null,
    resolvedBranch: 'main',
    deadlineMs: 5_000,
    credential,
  };

  await assert.rejects(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: boxLiteProviderConfig(),
        client: cleanupFailingClient(),
        workspaceMaterialization: async ({ secretFilePort }) => {
          await secretFilePort.writeSecretFile({
            kind: 'git-http-credential',
            credential,
          });
          return { status: 'succeeded', stage: 'complete' };
        },
      }).provision({
        taskId: 'materialization-fenced-success',
        cloneSpec: null,
        workspace: workspacePlan,
      }),
    /secret file removal required sandbox fencing/,
  );

  const deliveryClient = cleanupFailingClient();
  const deliveryProvider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig({
      BOXLITE_CAPABILITIES: 'command.exec,workspace.git.deliver',
    }),
    client: deliveryClient,
    workspaceDelivery: async ({ secretFilePort }) => {
      await secretFilePort.writeSecretFile({
        kind: 'git-http-credential',
        credential,
      });
      return { hadChanges: false, commitSha: null, error: null };
    },
  });
  await deliveryProvider.provision({ taskId: 'delivery-fenced-success', cloneSpec: null });
  await assert.rejects(
    () =>
      deliveryProvider.deliverWorkspaceChanges('delivery-fenced-success', {
        branch: 'cap/fenced',
        commitMessage: 'fenced',
        credential,
      }),
    /secret file removal required sandbox fencing/,
  );
})();

await (async function providerCleanupAuthorizationBoundaries() {
  const provider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig(),
    client: new mod.FakeBoxLiteClient(),
  });
  await assert.rejects(
    () =>
      provider.teardownSandbox('cleanup-target', {
        cleanupAuthorization: {
          kind: 'generation',
          taskId: 'different-task',
          providerId: 'boxlite-boundary',
          ownership: {
            ownerGeneration: 'owner:1',
            resourceGeneration: 'resource:1',
          },
        },
      }),
    /cleanup authorization target mismatch/,
  );
  await assert.rejects(
    () =>
      provider.teardownSandbox('cleanup-legacy', {
        ownership: {
          ownerGeneration: 'owner:1',
          resourceGeneration: 'resource:1',
        },
        cleanupAuthorization: {
          kind: 'legacy',
          taskId: 'cleanup-legacy',
          providerId: 'boxlite-boundary',
        },
      }),
    /legacy cleanup cannot carry generation ownership/,
  );
  await assert.rejects(
    () =>
      provider.teardownSandbox('cleanup-generation', {
        ownership: {
          ownerGeneration: 'owner:1',
          resourceGeneration: 'resource:old',
        },
        cleanupAuthorization: {
          kind: 'generation',
          taskId: 'cleanup-generation',
          providerId: 'boxlite-boundary',
          ownership: {
            ownerGeneration: 'owner:2',
            resourceGeneration: 'resource:new',
          },
        },
      }),
    /cleanup authorization resource generation mismatch/,
  );
  assert.deepEqual(
    await provider.teardownSandbox('cleanup-legacy-absent', {
      cleanupAuthorization: {
        kind: 'legacy',
        taskId: 'cleanup-legacy-absent',
        providerId: 'boxlite-boundary',
      },
    }),
    { kind: 'already-absent' },
  );

  const failedDeleteClient = new mod.FakeBoxLiteClient();
  failedDeleteClient.deleteSandbox = async () => {};
  const failedDeleteProvider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig(),
    client: failedDeleteClient,
    runtimeSetup: async () => {
      throw new Error('force cleanup');
    },
  });
  const cleanupAuthorization = {
    kind: 'generation',
    taskId: 'failed-delete-authorization',
    providerId: 'boxlite-boundary',
    ownership: {
      ownerGeneration: 'owner:cleanup',
      resourceGeneration: 'resource:cleanup',
    },
  };
  await assert.rejects(
    () =>
      failedDeleteProvider.provision({
        taskId: 'failed-delete-authorization',
        cloneSpec: null,
        ownership: cleanupAuthorization.ownership,
        beforeSandboxCleanup: async () => cleanupAuthorization,
        afterSandboxCleanup: async () => {},
      }),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );
})();

await (async function providerExistingRunEnvironmentBoundary() {
  const client = new mod.FakeBoxLiteClient();
  client.sandboxes.set('cap-boxlite-existing-environment', {
    id: 'cap-boxlite-existing-environment',
    taskId: 'existing-environment',
    state: 'running',
    image: 'registry.example.test/cap:managed',
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig(),
    client,
    resolveEnvironment: async () => ({
      environmentId: 'managed-boxlite-environment',
      providerFamily: 'boxlite',
      sourceKind: 'boxlite-image',
      sourceRef: 'registry.example.test/cap:managed',
      resources: { diskSizeGb: 8 },
    }),
  });
  await provider.provision({ taskId: 'existing-environment', cloneSpec: null });
  const run = await provider.getSelectedSandboxRun('existing-environment');
  assert.equal(run.environment.environmentId, 'managed-boxlite-environment');
  assert.equal(client.createCalls.length, 0);
})();

await (async function providerGenerationProbeDuringReadoption() {
  const client = new mod.FakeBoxLiteClient();
  let inspectCount = 0;
  client.createSandbox = async () => {
    throw Object.assign(new Error('conflict'), { status: 409 });
  };
  client.getSandbox = async (sandboxId) => {
    inspectCount += 1;
    return inspectCount === 1
      ? null
      : { id: sandboxId, state: 'running', image: 'image' };
  };
  const provider = new mod.BoxLiteSandboxProvider({
    config: boxLiteProviderConfig(),
    client,
  });
  await provider.provision({
    taskId: 'generation-probe',
    cloneSpec: null,
    ownership: {
      ownerGeneration: 'owner:probe',
      resourceGeneration: 'resource:probe',
    },
    beforeSandboxCleanup: async () => null,
    afterSandboxCleanup: async () => {},
  });
  assert(
    client.execCalls.some((call) =>
      call.command.includes('CAP_RESOURCE_GENERATION'),
    ),
  );
})();

// ---------------------------------------------------------------------------
// enforce-provider-contract-parity, task 1.4 — the deprecated capability
// spelling is an OPERATOR-facing input and must keep working.
//
// `BOXLITE_CAPABILITIES` is a documented `.env` interface and the README's own
// worked examples spell readoption as `lifecycle.readoption`, so deployments in
// the field have it written down. The spelling no longer exists internally; it
// is normalized at this one parse boundary. These two cases are what stop that
// normalization from being dropped as "dead code" later.
// ---------------------------------------------------------------------------

await (async () => {
  const deprecated = boxLiteProviderConfig({
    BOXLITE_CAPABILITIES: 'command.exec,lifecycle.readoption',
  });
  const canonical = boxLiteProviderConfig({
    BOXLITE_CAPABILITIES: 'command.exec,lifecycle.readopt',
  });
  assert.deepEqual(
    [...deprecated.capabilities].sort(),
    [...canonical.capabilities].sort(),
    'the deprecated spelling must resolve to the same capability set as the canonical one',
  );
  assert(
    !deprecated.capabilities.includes('lifecycle.readoption'),
    'the deprecated spelling must not survive past the parse boundary',
  );
  assert(
    deprecated.capabilities.includes('lifecycle.readopt'),
    'the deprecated spelling must resolve TO the canonical capability',
  );
})();

await (async () => {
  // Normalization must not turn a genuinely unknown capability into a silent
  // pass, and the error must echo what the operator actually wrote.
  const parsed = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'registry.example.test/cap:v1',
    BOXLITE_CAPABILITIES: 'command.exec,lifecycle.readoptionn',
  });
  assert.equal(parsed.status, 'invalid');
  assert(
    parsed.errors.some((line) => line.includes('lifecycle.readoptionn')),
    'an unknown capability must be reported using the operator\'s own spelling',
  );
})();

console.log('BoxLite boundary regression tests passed');
