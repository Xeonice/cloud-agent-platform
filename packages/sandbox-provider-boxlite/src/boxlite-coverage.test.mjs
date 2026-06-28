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
      if (extra.throwJson) throw new Error('bad json');
      return body;
    },
    async arrayBuffer() {
      if (extra.noArrayBuffer) return undefined;
      return extra.arrayBuffer ?? new Uint8Array().buffer;
    },
  };
}

function makeFetch(routes) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const route = routes[`${init.method ?? 'GET'} ${url.pathname}${url.search}`];
    if (!route) return response(404, { error: 'not found' });
    return typeof route === 'function' ? route({ url, init }) : route;
  };
}

function validEnv(overrides = {}) {
  return {
    BOXLITE_ENDPOINT: 'https://boxlite.example.test/',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest',
    BOXLITE_CAPABILITIES: 'command.exec',
    ...overrides,
  };
}

function validConfig(overrides = {}) {
  const result = mod.readBoxLiteProviderConfig(validEnv(overrides));
  assert.equal(result.status, 'valid');
  return result.config;
}

class MinimalBoxLiteClient {
  constructor(execHandler = null) {
    this.sandboxes = new Map();
    this.deleted = [];
    this.execHandler = execHandler;
  }
  async createSandbox(request) {
    const sandbox = {
      id: request.sandboxId,
      taskId: request.taskId,
      state: 'running',
      image: request.image,
    };
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }
  async getSandbox(id) {
    return this.sandboxes.get(id) ?? null;
  }
  async deleteSandbox(id) {
    this.deleted.push(id);
    this.sandboxes.delete(id);
  }
  async exec(request) {
    return this.execHandler?.(request) ?? {
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
      timedOut: false,
    };
  }
}

await test('REST client covers missing, failed, and invalid edge responses', async () => {
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: makeFetch({
      'GET /v1/sandboxes/no-content': response(204, null),
      'GET /v1/sandboxes/fail': response(500, null),
      'GET /v1/sandboxes/bad-json': response(200, null, { throwJson: true }),
      'DELETE /v1/sandboxes/fail': response(500, { error: 'nope' }),
      'POST /v1/sandboxes': response(200, null),
      'POST /v1/sandboxes/box/exec': response(200, null),
      'PUT /v1/sandboxes/box/archive?path=%2Fworkspace': response(500, null),
      'GET /v1/sandboxes/box/archive?path=%2Fmissing': response(404, null),
      'GET /v1/sandboxes/box/archive?path=%2Fempty': response(200, null, {
        noArrayBuffer: true,
      }),
      'GET /v1/sandboxes/box/archive?path=%2Ffail': response(500, null),
    }),
  });

  assert.equal(await client.getSandbox('no-content'), null);
  assert.equal(await client.getSandbox('bad-json'), null);
  await assert.rejects(() => client.getSandbox('fail'), /get sandbox fail failed/);
  await assert.rejects(() => client.deleteSandbox('fail'), /delete sandbox fail failed/);
  await assert.rejects(
    () => client.createSandbox({ taskId: 'task', image: 'img' }),
    /did not include a sandbox object/,
  );
  await assert.rejects(
    () => client.exec({ sandboxId: 'box', command: 'true' }),
    /did not include a result object/,
  );
  await assert.rejects(
    () =>
      client.uploadArchive({
        sandboxId: 'box',
        path: '/workspace',
        archive: new Uint8Array([1]),
      }),
    /archive upload/,
  );
  assert.equal(await client.downloadArchive({ sandboxId: 'box', path: '/missing' }), null);
  assert.equal(await client.downloadArchive({ sandboxId: 'box', path: '/empty' }), null);
  await assert.rejects(
    () => client.downloadArchive({ sandboxId: 'box', path: '/fail' }),
    /archive download/,
  );

  const originalFetch = globalThis.fetch;
  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const noFetch = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
    });
    await assert.rejects(() => noFetch.getSandbox('anything'), /global fetch is not available/);
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
  }

  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: makeFetch({
        'GET /v1/sandboxes/global': response(200, { id: 'global' }),
      }),
      configurable: true,
      writable: true,
    });
    const globalFetchClient = new mod.BoxLiteRestClient({
      baseUrl: 'https://boxlite.example.test',
      protocolMode: 'cap-rest',
    });
    assert.equal((await globalFetchClient.getSandbox('global')).id, 'global');
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
  }

  const execShape = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: makeFetch({
      'POST /v1/sandboxes/box/exec': response(200, {
        exitCode: 4,
        output: 'explicit output',
      }),
      'POST /v1/sandboxes/empty/exec': response(200, {}),
    }),
  });
  const execResult = await execShape.exec({ sandboxId: 'box', command: 'false' });
  assert.equal(execResult.exitCode, 4);
  assert.equal(execResult.output, 'explicit output');
  const emptyExecResult = await execShape.exec({ sandboxId: 'empty', command: 'true' });
  assert(Number.isNaN(emptyExecResult.exitCode));
  assert.equal(emptyExecResult.output, '');

  const fallbackFake = new mod.FakeBoxLiteClient();
  assert.equal(
    (await fallbackFake.createSandbox({ taskId: 'task-no-sandbox-id', image: 'img' })).id,
    'task-no-sandbox-id',
  );
  assert.equal(await fallbackFake.downloadArchive({ sandboxId: 'missing', path: '/none' }), null);
});

await test('config parser covers defaults, require helper, and invalid modes', () => {
  const defaults = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test/',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE_MAP: '{"default":"cap-boxlite:default","codex":"cap-boxlite:codex"}',
    BOXLITE_CAPABILITIES: 'command.exec,,command.exec',
  });
  assert.equal(defaults.status, 'valid');
  assert.equal(defaults.config.endpoint, 'https://boxlite.example.test');
  assert.deepEqual(defaults.config.capabilities, ['command.exec']);
  assert.equal(mod.resolveBoxLiteImage({ config: defaults.config, runtimeId: null }), 'cap-boxlite:default');
  assert.equal(mod.requireBoxLiteProviderConfig(validEnv()).defaultImage, 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest');
  assert.throws(() => mod.requireBoxLiteProviderConfig({}), /BOXLITE_ENDPOINT is not set/);
  assert.throws(
    () => mod.requireBoxLiteProviderConfig({ BOXLITE_ENDPOINT: 'https://boxlite.example.test' }),
    /Invalid BoxLite provider configuration/,
  );

  const invalid = mod.readBoxLiteProviderConfig(validEnv({
    BOXLITE_IMAGE_MAP: '{"codex":""}',
    BOXLITE_WORKSPACE_PATH: 'relative',
    BOXLITE_SANDBOX_MODE: 'bad-mode',
    BOXLITE_CLIENT_MODE: 'sdk',
    BOXLITE_TERMINAL_MODE: 'stream',
    BOXLITE_PROVIDER_PRIORITY: '1.5',
    BOXLITE_TIMEOUT_MS: '-1',
    BOXLITE_CAPABILITIES: 'workspace.git.deliver,transcript.retained-source',
  }));
  assert.equal(invalid.status, 'invalid');
  assert(invalid.errors.some((entry) => entry.includes('values must be non-empty')));
  assert(invalid.errors.some((entry) => entry.includes('absolute path')));
  assert(invalid.errors.some((entry) => entry.includes('BOXLITE_SANDBOX_MODE')));
  assert(invalid.errors.some((entry) => entry.includes('BOXLITE_CLIENT_MODE')));
  assert(invalid.errors.some((entry) => entry.includes('BOXLITE_TERMINAL_MODE')));
  assert(invalid.errors.some((entry) => entry.includes('BOXLITE_PROVIDER_PRIORITY')));
  assert(invalid.errors.some((entry) => entry.includes('BOXLITE_TIMEOUT_MS')));
  assert(invalid.errors.some((entry) => entry.includes('workspace.git.deliver requires command.exec')));
  assert(invalid.errors.some((entry) => entry.includes('transcript.retained-source requires command.exec')));

  assert.equal(
    mod.readBoxLiteProviderConfig({
      ...validEnv(),
      BOXLITE_ENDPOINT: 'not a url',
    }).status,
    'invalid',
  );

  assert.equal(
    mod.readBoxLiteProviderConfig(validEnv({ BOXLITE_IMAGE_MAP: 'codex=img=bad' })).status,
    'invalid',
  );
  assert.equal(
    mod.readBoxLiteProviderConfig(validEnv({ BOXLITE_IMAGE_MAP: '[]' })).status,
    'invalid',
  );
});

await test('provider covers fallback URLs, stale sandboxes, local descriptors, and archive guards', async () => {
  assert.equal(
    new mod.BoxLiteSandboxProvider({ config: validConfig() }).getProviderId(),
    'boxlite',
  );
  assert.throws(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: validConfig({ BOXLITE_CAPABILITIES: 'command.exec,workspace.archive.transfer' }),
        client: new MinimalBoxLiteClient(),
      }),
    /cannot advertise workspace.archive.transfer/,
  );

  const client = new MinimalBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_PROVIDER_LOCATION: 'local',
      BOXLITE_TERMINAL_MODE: 'pty',
      BOXLITE_PROTOCOL_MODE: 'cap-rest',
      BOXLITE_CAPABILITIES: 'terminal.websocket,terminal.interactive,command.exec',
    }),
    client,
  });
  const descriptor = mod.defineBoxLiteSandboxProvider({
    id: 'boxlite-local',
    config: validConfig({ BOXLITE_PROVIDER_LOCATION: 'local' }),
    client: new mod.FakeBoxLiteClient(),
  });
  assert.equal(descriptor.id, 'boxlite-local');
  assert.equal(descriptor.location, 'local');

  const connection = await provider.provision({ taskId: 'task-fallback', cloneSpec: null });
  assert.equal(connection.baseUrl, 'https://boxlite.example.test/v1/sandboxes/cap-boxlite-task-fallback');
  assert.equal(connection.wsUrl, 'wss://boxlite.example.test/v1/sandboxes/cap-boxlite-task-fallback/terminal');
  assert.equal(await provider.getTerminalDescriptor('task-fallback'), null);
  assert.equal((await provider.getWorkspaceDescriptor('task-fallback')).mode, 'none');
  assert.equal(await provider.readRolloutFromContainer('task-fallback'), null);
  assert.deepEqual(await provider.listReadoptable(), ['task-fallback']);
  assert.equal(await provider.reattach('missing'), null);

  const sparseProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_CAPABILITIES: '' }),
    client: new mod.FakeBoxLiteClient(),
  });
  await sparseProvider.provision({ taskId: 'task-sparse', cloneSpec: null });
  const sparseRun = await sparseProvider.getSelectedSandboxRun('task-sparse');
  assert.equal(sparseRun.terminal, undefined);
  assert.equal(sparseRun.command, undefined);
  assert.equal(sparseRun.workspace.mode, 'none');
  assert.equal(sparseRun.retention.mode, 'none');
  assert.equal(await sparseProvider.getCommandDescriptor('missing'), null);
  assert.equal(await sparseProvider.getWorkspaceDescriptor('missing'), null);
  assert.equal(await sparseProvider.getRetentionPolicy('missing'), null);

  const patchedProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_CAPABILITIES: 'command.exec' }),
    client: new mod.FakeBoxLiteClient(),
  });
  assert.equal(await patchedProvider.getCommandDescriptor('missing'), null);
  await patchedProvider.provision({ taskId: 'task-patched', cloneSpec: null });
  patchedProvider.getWorkspaceDescriptor = async () => null;
  patchedProvider.getRetentionPolicy = async () => null;
  const patchedRun = await patchedProvider.getSelectedSandboxRun('task-patched');
  assert.equal(patchedRun.workspace, undefined);
  assert.equal(patchedRun.retention, undefined);

  const noErrorPreflightProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: new mod.FakeBoxLiteClient(),
    preflight: () => ({ status: 'failed' }),
  });
  await assert.rejects(
    () => noErrorPreflightProvider.provision({ taskId: 'task-no-error-preflight', cloneSpec: null }),
    /BoxLite runtime preflight failed/,
  );

  const undefinedRuntimePreflightProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: new mod.FakeBoxLiteClient(),
    preflight: ({ runtimeId }) => ({ status: 'passed', runtimeId: runtimeId ?? undefined }),
  });
  await undefinedRuntimePreflightProvider.provision({ taskId: 'task-undefined-runtime', cloneSpec: null });
  assert.equal(
    (await undefinedRuntimePreflightProvider.preflightRuntime({ taskId: 'task-undefined-runtime' })).runtimeId,
    undefined,
  );

  client.sandboxes.get('cap-boxlite-task-fallback').state = 'deleted';
  assert.equal(await provider.sandboxExists('task-fallback'), false);
  assert.equal(await provider.getSelectedSandboxRun('task-fallback'), null);
  await assert.rejects(
    () => provider.downloadWorkspaceArchive({ taskId: 'task-fallback' }),
    /does not support archive download|not available/,
  );
  await assert.rejects(
    () =>
      provider.uploadWorkspaceArchive({
        taskId: 'task-fallback',
        archive: new Uint8Array([1]),
      }),
    /does not support archive upload/,
  );

  const archiveProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_CAPABILITIES: 'command.exec,workspace.archive.transfer' }),
    client: new mod.FakeBoxLiteClient(),
  });
  await assert.rejects(
    () => archiveProvider.downloadWorkspaceArchive({ taskId: 'not-provisioned' }),
    /not available/,
  );
  assert.match(
    (await archiveProvider.deliverWorkspaceChanges('not-deliverable', {
      authHeader: 'Authorization: Basic token',
      branch: 'cap/not-deliverable',
      commitMessage: 'deliver',
    })).error,
    /does not support git delivery/,
  );

  const existingClient = new mod.FakeBoxLiteClient();
  existingClient.sandboxes.set('cap-boxlite-existing', {
    id: 'cap-boxlite-existing',
    taskId: 'existing',
    state: 'running',
    image: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest',
  });
  const existingProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_PROTOCOL_MODE: 'cap-rest',
      BOXLITE_CAPABILITIES: 'command.exec,workspace.git.materialize,workspace.git.deliver',
    }),
    client: existingClient,
  });
  const existingRun = await existingProvider.getSelectedSandboxRun('existing');
  assert.equal(existingRun.connection.baseUrl, 'https://boxlite.example.test/v1/sandboxes/cap-boxlite-existing');
  assert.equal(existingRun.preflight.status, 'skipped');
  assert.equal(existingRun.workspace.git.materialized, true);
  assert.equal(existingRun.workspace.git.deliverable, true);

  const staleClient = new mod.FakeBoxLiteClient();
  const staleProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: staleClient,
    preflight: () => ({ status: 'passed', image: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest' }),
  });
  await staleProvider.provision({ taskId: 'task-stale-cache', cloneSpec: null });
  const staleSandbox = staleClient.sandboxes.get('cap-boxlite-task-stale-cache');
  let lookupCount = 0;
  staleClient.getSandbox = async () => {
    lookupCount += 1;
    return lookupCount === 1 ? null : staleSandbox;
  };
  const rebuiltRun = await staleProvider.getSelectedSandboxRun('task-stale-cache');
  assert.equal(rebuiltRun.preflight.status, 'passed');

  const noImagePreflight = mod.createBoxLiteRuntimePreflight({
    requiredTools: [],
    now: () => new Date('2026-06-27T00:00:00.000Z'),
  });
  const preflight = await noImagePreflight({
    provider: { getProviderId: () => 'boxlite-test' },
    sandbox: { id: 'no-image' },
    executor: {
      async exec() {
        throw new Error('should not execute with no tools');
      },
    },
  });
  assert.equal(preflight.status, 'passed');
  assert.equal(preflight.image, undefined);
});

async function deliveryResultFor(responses) {
  const queue = [...responses];
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_CAPABILITIES: 'command.exec,workspace.git.deliver' }),
    client: new mod.FakeBoxLiteClient({
      execHandler: () =>
        queue.shift() ?? {
          exitCode: 0,
          stdout: '',
          stderr: '',
          output: '',
          timedOut: false,
        },
    }),
  });
  await provider.provision({ taskId: 'task-deliver', cloneSpec: null });
  return provider.deliverWorkspaceChanges('task-deliver', {
    authHeader: 'Authorization: Basic token',
    branch: "cap/branch'quoted",
    commitMessage: "message ' quoted",
  });
}

await test('provider git delivery covers success and each command failure', async () => {
  assert.match(
    (await deliveryResultFor([{ exitCode: 2, output: 'bad status', stdout: '', stderr: '' }])).error,
    /git status failed/,
  );
  assert.match(
    (await deliveryResultFor([
      { exitCode: 0, output: ' M file', stdout: ' M file', stderr: '' },
      { exitCode: 2, output: 'bad add', stdout: '', stderr: '' },
    ])).error,
    /git add failed/,
  );
  assert.match(
    (await deliveryResultFor([
      { exitCode: 0, output: ' M file', stdout: ' M file', stderr: '' },
      { exitCode: 0, output: '', stdout: '', stderr: '' },
      { exitCode: 2, output: 'bad commit', stdout: '', stderr: '' },
    ])).error,
    /git commit failed/,
  );
  assert.match(
    (await deliveryResultFor([
      { exitCode: 0, output: ' M file', stdout: ' M file', stderr: '' },
      { exitCode: 0, output: '', stdout: '', stderr: '' },
      { exitCode: 0, output: '', stdout: '', stderr: '' },
      { exitCode: 2, output: 'bad sha', stdout: '', stderr: '' },
    ])).error,
    /git rev-parse failed/,
  );
  assert.match(
    (await deliveryResultFor([
      { exitCode: 0, output: ' M file', stdout: ' M file', stderr: '' },
      { exitCode: 0, output: '', stdout: '', stderr: '' },
      { exitCode: 0, output: '', stdout: '', stderr: '' },
      { exitCode: 0, output: 'abc123\n', stdout: 'abc123\n', stderr: '' },
      { exitCode: 2, output: 'bad push', stdout: '', stderr: '' },
    ])).error,
    /git push failed/,
  );
  const success = await deliveryResultFor([
    { exitCode: 0, output: ' M file', stdout: ' M file', stderr: '' },
    { exitCode: 0, output: '', stdout: '', stderr: '' },
    { exitCode: 0, output: '', stdout: '', stderr: '' },
    { exitCode: 0, output: 'abc123\n', stdout: 'abc123\n', stderr: '' },
    { exitCode: 0, output: '', stdout: '', stderr: '' },
  ]);
  assert.equal(success.hadChanges, true);
  assert.equal(success.commitSha, 'abc123');
  const successNoSha = await deliveryResultFor([
    { exitCode: 0, output: ' M file', stdout: ' M file', stderr: '' },
    { exitCode: 0, output: '', stdout: '', stderr: '' },
    { exitCode: 0, output: '', stdout: '', stderr: '' },
    { exitCode: 0, output: '\n', stdout: '\n', stderr: '' },
    { exitCode: 0, output: '', stdout: '', stderr: '' },
  ]);
  assert.equal(successNoSha.hadChanges, true);
  assert.equal(successNoSha.commitSha, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
