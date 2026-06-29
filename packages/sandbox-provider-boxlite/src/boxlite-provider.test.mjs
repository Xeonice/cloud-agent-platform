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

function validEnv(overrides = {}) {
  return {
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest',
    BOXLITE_PROVIDER_ID: 'boxlite-test',
    BOXLITE_PROVIDER_PRIORITY: '25',
    BOXLITE_PROVIDER_LOCATION: 'cloud',
    BOXLITE_TERMINAL_MODE: 'pty',
    BOXLITE_CAPABILITIES: [
      'terminal.websocket',
      'terminal.interactive',
      'command.exec',
      'workspace.archive.transfer',
      'workspace.git.deliver',
      'lifecycle.readoption',
    ].join(','),
    ...overrides,
  };
}

function validConfig(overrides = {}) {
  const result = mod.readBoxLiteProviderConfig(validEnv(overrides));
  assert.equal(result.status, 'valid');
  return result.config;
}

await test('config is disabled by default', () => {
  const result = mod.readBoxLiteProviderConfig({});
  assert.equal(result.status, 'disabled');
});

await test('config validates endpoint credentials image and capabilities', () => {
  const result = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'ftp://boxlite',
    BOXLITE_IMAGE_MAP: '{bad json',
    BOXLITE_CAPABILITIES: 'terminal.interactive,workspace.archive.transfer,unknown.cap',
    BOXLITE_PROVIDER_LOCATION: 'mars',
    BOXLITE_PROVIDER_PRIORITY: 'high',
    BOXLITE_TIMEOUT_MS: '0',
    BOXLITE_PROTOCOL_MODE: 'bad',
    BOXLITE_SANDBOX_PROXY: 'ftp://proxy.example.test',
    BOXLITE_SANDBOX_HTTP_PROXY: 'not a url',
  });
  assert.equal(result.status, 'invalid');
  assert(result.errors.some((entry) => entry.includes('http or https')));
  assert(result.errors.some((entry) => entry.includes('BOXLITE_API_TOKEN')));
  assert(result.errors.some((entry) => entry.includes('BOXLITE_IMAGE')));
  assert(result.errors.some((entry) => entry.includes('unknown capability')));
  assert(result.errors.some((entry) => entry.includes('terminal.interactive requires terminal.websocket')));
  assert(result.errors.some((entry) => entry.includes('BOXLITE_TERMINAL_MODE must be pty')));
  assert(result.errors.some((entry) => entry.includes('workspace.archive.transfer requires command.exec')));
  assert(result.errors.some((entry) => entry.includes('BOXLITE_PROTOCOL_MODE must be native or cap-rest')));
  assert(result.errors.some((entry) => entry.includes('BOXLITE_SANDBOX_PROXY must use')));
  assert(result.errors.some((entry) => entry.includes('BOXLITE_SANDBOX_HTTP_PROXY must be a valid proxy URL')));
});

await test('config parses image map priority location and explicit capabilities', () => {
  const result = mod.readBoxLiteProviderConfig(validEnv({
    BOXLITE_IMAGE_MAP: 'codex=cap-boxlite-codex:1,claude=cap-boxlite-claude:1',
    BOXLITE_WORKSPACE_PATH: '/srv/workspace',
    BOXLITE_SANDBOX_ID_PREFIX: 'box-',
    BOXLITE_PROTOCOL_MODE: 'cap-rest',
    BOXLITE_PATH_PREFIX: '',
  }));
  assert.equal(result.status, 'valid');
  assert.equal(result.config.providerId, 'boxlite-test');
  assert.equal(result.config.priority, 25);
  assert.equal(result.config.location, 'cloud');
  assert.equal(result.config.workspacePath, '/srv/workspace');
  assert.equal(result.config.sandboxIdPrefix, 'box-');
  assert.equal(result.config.protocolMode, 'cap-rest');
  assert.equal(result.config.pathPrefix, '');
  assert.deepEqual(result.config.imageByRuntime, {
    codex: 'cap-boxlite-codex:1',
    claude: 'cap-boxlite-claude:1',
  });
  assert.equal(mod.resolveBoxLiteImage({ config: result.config, runtimeId: 'claude' }), 'cap-boxlite-claude:1');
});

await test('config defaults to native protocol with default path prefix', () => {
  const config = validConfig();
  assert.equal(config.protocolMode, 'native');
  assert.equal(config.pathPrefix, 'default');
  assert.deepEqual(config.sandboxEnv, {});
});

await test('config maps sandbox proxy env into uppercase and lowercase variables', () => {
  const config = validConfig({
    BOXLITE_SANDBOX_PROXY: 'http://proxy.example.test:7897',
    BOXLITE_SANDBOX_NO_PROXY: 'localhost,127.0.0.1,::1',
  });
  assert.deepEqual(config.sandboxEnv, {
    HTTP_PROXY: 'http://proxy.example.test:7897',
    http_proxy: 'http://proxy.example.test:7897',
    HTTPS_PROXY: 'http://proxy.example.test:7897',
    https_proxy: 'http://proxy.example.test:7897',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  });
});

await test('config lets protocol-specific sandbox proxies override the shared proxy', () => {
  const config = validConfig({
    BOXLITE_SANDBOX_PROXY: 'http://proxy.example.test:7897',
    BOXLITE_SANDBOX_HTTP_PROXY: 'http://http-proxy.example.test:8080',
    BOXLITE_SANDBOX_HTTPS_PROXY: 'socks5h://socks-proxy.example.test:1080',
  });
  assert.deepEqual(config.sandboxEnv, {
    HTTP_PROXY: 'http://http-proxy.example.test:8080',
    http_proxy: 'http://http-proxy.example.test:8080',
    HTTPS_PROXY: 'socks5h://socks-proxy.example.test:1080',
    https_proxy: 'socks5h://socks-proxy.example.test:1080',
  });
});

await test('descriptor factory registers only when env is valid', () => {
  assert.equal(mod.defineBoxLiteSandboxProviderFromEnv({ env: {} }).status, 'disabled');
  assert.equal(
    mod.defineBoxLiteSandboxProviderFromEnv({
      env: { BOXLITE_ENDPOINT: 'https://boxlite.example.test' },
    }).status,
    'invalid',
  );

  const descriptorResult = mod.defineBoxLiteSandboxProviderFromEnv({
    env: validEnv(),
    client: new mod.FakeBoxLiteClient(),
  });
  assert.equal(descriptorResult.status, 'registered');
  assert.equal(descriptorResult.descriptor.id, 'boxlite-test');
  assert.equal(descriptorResult.descriptor.location, 'cloud');
  assert.deepEqual(descriptorResult.descriptor.capabilities, validConfig().capabilities);
});

await test('descriptor factory installs default readiness preflight from capabilities', async () => {
  const client = new mod.FakeBoxLiteClient();
  const descriptor = mod.defineBoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_CAPABILITIES: 'terminal.websocket,terminal.interactive,command.exec,workspace.git.materialize,workspace.git.deliver',
    }),
    client,
  });
  await descriptor.provider.provision({
    taskId: 'task-default-preflight',
    cloneSpec: null,
  });
  assert.deepEqual(
    client.execCalls.map((call) => call.command),
    [
      "test -d '/home/gem/workspace'",
      "command -v 'bash'",
      "command -v 'git'",
      "command -v 'sh'",
    ],
  );
  assert.deepEqual(mod.requiredToolsForBoxLiteCapabilities(descriptor.capabilities), [
    'bash',
    'git',
    'sh',
  ]);
});

await test('provider provision is task-scoped and idempotent', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_SANDBOX_ID_PREFIX: 'box-',
      BOXLITE_SANDBOX_PROXY: 'http://proxy.example.test:7897',
      BOXLITE_SANDBOX_NO_PROXY: 'localhost,127.0.0.1,::1',
    }),
    client,
  });

  const first = await provider.provision({ taskId: 'task-1', cloneSpec: null });
  const second = await provider.provision({ taskId: 'task-1', cloneSpec: null });
  assert.deepEqual(second, first);
  assert.equal(client.createCalls.length, 1);
  assert.equal(client.createCalls[0].sandboxId, 'box-task-1');
  assert.deepEqual(client.createCalls[0].env, {
    HTTP_PROXY: 'http://proxy.example.test:7897',
    http_proxy: 'http://proxy.example.test:7897',
    HTTPS_PROXY: 'http://proxy.example.test:7897',
    https_proxy: 'http://proxy.example.test:7897',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  });
  assert.equal(await provider.sandboxExists('task-1'), true);
  assert.equal((await provider.reattach('task-1')).baseUrl, 'boxlite://box-task-1');
});

await test('provider exposes selected-run descriptors and internal BoxLite terminal only server-side', async () => {
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_WORKSPACE_PATH: '/workspace/project' }),
    client: new mod.FakeBoxLiteClient(),
  });
  await provider.provision({ taskId: 'task-2', cloneSpec: null });

  const run = await provider.getSelectedSandboxRun('task-2');
  assert.equal(run.providerId, 'boxlite-test');
  assert.equal(run.providerSandboxId, 'cap-boxlite-task-2');
  assert.equal(run.terminal.protocol, 'boxlite-v1');
  assert.equal(run.terminal.wsUrl, 'wss://boxlite.example.test');
  assert.equal(run.command.protocol, 'boxlite-exec-v1');
  assert.equal(run.command.workingDirectory, '/workspace/project');
  assert.equal(run.workspace.mode, 'archive');
  assert.deepEqual(run.workspace.archive, { upload: true, download: true });
  assert.equal(run.workspace.git.deliverable, true);
  assert.equal(run.retention.mode, 'none');
  assert.equal(run.preflight.status, 'skipped');
});

await test('runtime preflight probes tools and caches by provider image runtime fingerprint', async () => {
  let execCount = 0;
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => {
      execCount += 1;
      return {
        exitCode: request.command.includes("'missing-tool'") ? 1 : 0,
        stdout: request.command,
        stderr: '',
        output: request.command,
        timedOut: false,
      };
    },
  });
  const preflight = mod.createBoxLiteRuntimePreflight({
    requiredTools: ['git'],
    now: () => new Date('2026-06-27T00:00:00.000Z'),
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preflight,
  });
  await provider.provision({ taskId: 'task-preflight', cloneSpec: null });
  const first = await provider.preflightRuntime({
    taskId: 'task-preflight',
    runtimeId: 'codex',
  });
  const second = await provider.preflightRuntime({
    taskId: 'task-preflight',
    runtimeId: 'codex',
  });
  assert.equal(first.status, 'passed');
  assert.equal(second, first);
  assert.equal(execCount, 2);
});

await test('runtime preflight failure tears down the created sandbox and rejects provision', async () => {
  const client = new mod.FakeBoxLiteClient({
    execHandler: () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'missing',
      output: 'missing',
      timedOut: false,
    }),
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preflight: mod.createBoxLiteRuntimePreflight({
      requiredTools: ['missing-tool'],
    }),
  });
  await assert.rejects(
    () => provider.provision({ taskId: 'task-preflight-fail', cloneSpec: null }),
    /BoxLite image missing required tools: missing-tool/,
  );
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-preflight-fail']);
});

await test('provider runs runtime setup hook after preflight', async () => {
  const events = [];
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => {
      events.push(`exec:${request.command}:${request.cwd ?? ''}`);
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      };
    },
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preflight: async ({ executor, taskId }) => {
      events.push(`preflight:${taskId}`);
      await executor.exec({ command: 'preflight-check' });
      return { status: 'passed', checkedAt: '2026-06-29T00:00:00.000Z' };
    },
    runtimeSetup: async ({ taskId, sandbox, executor, workspacePath }) => {
      events.push(`setup:${taskId}:${sandbox.id}:${workspacePath}`);
      await executor.exec({ command: 'write-runtime-setup', cwd: workspacePath });
    },
  });

  const connection = await provider.provision({ taskId: 'task-runtime-setup', cloneSpec: null });

  assert.equal(connection.baseUrl, 'boxlite://cap-boxlite-task-runtime-setup');
  assert.deepEqual(events, [
    'preflight:task-runtime-setup',
    'exec:preflight-check:',
    'setup:task-runtime-setup:cap-boxlite-task-runtime-setup:/home/gem/workspace',
    'exec:write-runtime-setup:/home/gem/workspace',
  ]);
  assert.deepEqual(client.deletedSandboxIds, []);
});

await test('runtime setup hook failure tears down the created sandbox and rejects provision', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preflight: () => ({ status: 'passed', checkedAt: '2026-06-29T00:00:00.000Z' }),
    runtimeSetup: () => {
      throw new Error('setup failed');
    },
  });

  await assert.rejects(
    () => provider.provision({ taskId: 'task-runtime-setup-fail', cloneSpec: null }),
    /setup failed/,
  );
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-runtime-setup-fail']);
});

await test('provider materializes git workspace when cloneSpec is present', async () => {
  const commands = [];
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => {
      commands.push(request.command);
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      };
    },
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_CAPABILITIES: [
        'terminal.websocket',
        'terminal.interactive',
        'command.exec',
        'workspace.git.materialize',
      ].join(','),
    }),
    client,
  });
  await provider.provision({
    taskId: 'task-materialize',
    cloneSpec: {
      url: 'https://example.test/repo.git',
      authHeader: 'Authorization: Basic token',
    },
  });
  assert(commands.some((command) => command.includes('git -c http.extraHeader=')));
  assert(commands.some((command) => command.includes('clone --recursive')));
  assert.equal(client.deletedSandboxIds.length, 0);
});

await test('provider tears down sandbox when git materialization fails', async () => {
  const client = new mod.FakeBoxLiteClient({
    execHandler: () => ({
      exitCode: 128,
      stdout: '',
      stderr: 'clone failed',
      output: 'clone failed',
      timedOut: false,
    }),
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_CAPABILITIES: 'terminal.websocket,terminal.interactive,command.exec,workspace.git.materialize',
    }),
    client,
  });
  await assert.rejects(
    () =>
      provider.provision({
        taskId: 'task-materialize-fail',
        cloneSpec: { url: 'https://example.test/repo.git' },
      }),
    /BoxLite git materialization failed: clone failed/,
  );
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-materialize-fail']);
});

await test('command executor and archive helpers normalize BoxLite client operations', async () => {
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => ({
      exitCode: request.command === 'false' ? 2 : 0,
      stdout: request.cwd ?? '',
      stderr: '',
      output: request.cwd ?? '',
      timedOut: false,
    }),
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  await provider.provision({ taskId: 'task-3', cloneSpec: null });

  const executor = provider.createCommandExecutor('cap-boxlite-task-3');
  const result = await executor.exec({ command: 'true', cwd: '/workspace' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '/workspace');

  await provider.uploadWorkspaceArchive({
    taskId: 'task-3',
    archive: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual([...(await provider.downloadWorkspaceArchive({ taskId: 'task-3' }))], [1, 2, 3]);
});

await test('terminal and retention descriptors are capability gated', async () => {
  const noTerminalConfig = validConfig({
    BOXLITE_TERMINAL_MODE: 'none',
    BOXLITE_CAPABILITIES: 'command.exec,lifecycle.snapshot',
  });
  const snapshotProvider = new mod.BoxLiteSandboxProvider({
    config: noTerminalConfig,
    client: new mod.FakeBoxLiteClient(),
  });
  await snapshotProvider.provision({ taskId: 'task-snapshot', cloneSpec: null });
  assert.equal(await snapshotProvider.getTerminalDescriptor('task-snapshot'), null);
  assert.equal((await snapshotProvider.getRetentionPolicy('task-snapshot')).mode, 'snapshot');

  const sleepProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_TERMINAL_MODE: 'none',
      BOXLITE_CAPABILITIES: 'command.exec,lifecycle.sleep',
    }),
    client: new mod.FakeBoxLiteClient(),
  });
  await sleepProvider.provision({ taskId: 'task-sleep', cloneSpec: null });
  assert.equal((await sleepProvider.getRetentionPolicy('task-sleep')).mode, 'provider-native');
});

await test('provider teardown is idempotent and clears existence', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  await provider.provision({ taskId: 'task-4', cloneSpec: null });
  await provider.teardownSandbox('task-4');
  await provider.teardownSandbox('task-4');
  assert.equal(await provider.sandboxExists('task-4'), false);
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-4', 'cap-boxlite-task-4']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
