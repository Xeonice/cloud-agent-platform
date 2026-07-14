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
  assert.deepEqual(mod.resolveBoxLiteSandboxSource({ config: result.config, runtimeId: 'claude' }), {
    kind: 'image',
    value: 'cap-boxlite-claude:1',
  });
});

await test('config supports rootfs paths and rejects ambiguous sources', () => {
  const rootfs = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_ROOTFS_PATH: '/var/lib/cap/boxlite/default',
    BOXLITE_ROOTFS_PATH_MAP: 'codex=/var/lib/cap/boxlite/codex',
    BOXLITE_CAPABILITIES: 'command.exec',
  });
  assert.equal(rootfs.status, 'valid');
  assert.equal(rootfs.config.defaultImage, '');
  assert.equal(rootfs.config.defaultRootfsPath, '/var/lib/cap/boxlite/default');
  assert.deepEqual(rootfs.config.rootfsPathByRuntime, {
    codex: '/var/lib/cap/boxlite/codex',
  });
  assert.deepEqual(mod.resolveBoxLiteSandboxSource({ config: rootfs.config, runtimeId: 'codex' }), {
    kind: 'rootfs',
    value: '/var/lib/cap/boxlite/codex',
  });

  const ambiguous = mod.readBoxLiteProviderConfig({
    ...validEnv(),
    BOXLITE_ROOTFS_PATH: '/var/lib/cap/boxlite/default',
  });
  assert.equal(ambiguous.status, 'invalid');
  assert(ambiguous.errors.some((entry) => entry.includes('ambiguous')));

  const capRestRootfs = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_ROOTFS_PATH: '/var/lib/cap/boxlite/default',
    BOXLITE_PROTOCOL_MODE: 'cap-rest',
  });
  assert.equal(capRestRootfs.status, 'invalid');
  assert(capRestRootfs.errors.some((entry) => entry.includes('BOXLITE_PROTOCOL_MODE=native')));

  const relative = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_ROOTFS_PATH_MAP: 'default=relative',
  });
  assert.equal(relative.status, 'invalid');
  assert(relative.errors.some((entry) => entry.includes('absolute path')));
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

await test('provider delegates retained transcript reads only when the capability is implemented', async () => {
  const retainedConfig = validConfig({
    BOXLITE_CAPABILITIES: 'command.exec,transcript.retained-read',
  });
  assert.throws(
    () =>
      new mod.BoxLiteSandboxProvider({
        config: retainedConfig,
        client: new mod.FakeBoxLiteClient(),
      }),
    /cannot advertise transcript\.retained-read without a transcriptRead hook/,
  );

  const client = new mod.FakeBoxLiteClient();
  const calls = [];
  const provider = new mod.BoxLiteSandboxProvider({
    config: retainedConfig,
    client,
    resolveRuntimeId: async (taskId) => {
      calls.push(['resolve-runtime', taskId]);
      return 'codex';
    },
    transcriptRead: async (context) => {
      calls.push([
        'read',
        context.taskId,
        context.runtimeId,
        context.sandbox.id,
        context.workspacePath,
      ]);
      return { format: 'codex-rollout', jsonl: '{"ok":true}\n' };
    },
  });
  assert.equal(await provider.readRolloutFromContainer('missing', 'codex'), null);
  await provider.provision({ taskId: 'task-transcript', cloneSpec: null });
  assert.deepEqual(
    await provider.readRolloutFromContainer('task-transcript', 'claude-code'),
    { format: 'codex-rollout', jsonl: '{"ok":true}\n' },
  );
  assert.deepEqual(
    await provider.readRolloutFromContainer('task-transcript'),
    { format: 'codex-rollout', jsonl: '{"ok":true}\n' },
  );
  assert.deepEqual(calls, [
    [
      'read',
      'task-transcript',
      'claude-code',
      'cap-boxlite-task-transcript',
      '/home/gem/workspace',
    ],
    ['resolve-runtime', 'task-transcript'],
    [
      'read',
      'task-transcript',
      'codex',
      'cap-boxlite-task-transcript',
      '/home/gem/workspace',
    ],
  ]);
});

await test('provider provisions rootfs-backed sandboxes without an image source', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_IMAGE: '',
      BOXLITE_ROOTFS_PATH: '/var/lib/cap/boxlite/rootfs',
      BOXLITE_CAPABILITIES: 'command.exec',
    }),
    client,
  });

  const connection = await provider.provision({ taskId: 'task-rootfs', cloneSpec: null });
  assert.equal(connection.baseUrl, 'boxlite://cap-boxlite-task-rootfs');
  assert.equal(client.createCalls.length, 1);
  assert.equal(client.createCalls[0].image, undefined);
  assert.equal(client.createCalls[0].rootfsPath, '/var/lib/cap/boxlite/rootfs');
  const run = await provider.getSelectedSandboxRun('task-rootfs');
  assert.equal(run.preflight.image, '/var/lib/cap/boxlite/rootfs');
});

await test('provider preserves configured BoxLite defaults when no managed environment resolves', async () => {
  const imageClient = new mod.FakeBoxLiteClient();
  const imageProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: imageClient,
    resolveEnvironment: async () => null,
  });

  await imageProvider.provision({ taskId: 'task-default-image', cloneSpec: null });
  assert.equal(imageClient.createCalls[0].image, 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest');
  assert.equal(imageClient.createCalls[0].rootfsPath, undefined);

  const rootfsClient = new mod.FakeBoxLiteClient();
  const rootfsProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_IMAGE: '',
      BOXLITE_ROOTFS_PATH: '/var/lib/cap/boxlite/default-rootfs',
      BOXLITE_CAPABILITIES: 'command.exec',
    }),
    client: rootfsClient,
    resolveEnvironment: async () => null,
  });

  await rootfsProvider.provision({ taskId: 'task-default-rootfs', cloneSpec: null });
  assert.equal(rootfsClient.createCalls[0].image, undefined);
  assert.equal(rootfsClient.createCalls[0].rootfsPath, '/var/lib/cap/boxlite/default-rootfs');
});

await test('provider uses selected BoxLite image environments before config defaults', async () => {
  const imageClient = new mod.FakeBoxLiteClient();
  const imageProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: imageClient,
    resolveEnvironment: async () => ({
      environmentId: 'env-boxlite-image',
      name: 'BoxLite image',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-custom:v1',
      providerFamily: 'boxlite',
      contractVersion: 'sandbox-environment-v1',
    }),
  });
  await imageProvider.provision({ taskId: 'task-env-image', cloneSpec: null });
  assert.equal(imageClient.createCalls[0].image, 'cap-boxlite-custom:v1');
  assert.equal(imageClient.createCalls[0].rootfsPath, undefined);
  assert.equal(
    imageClient.createCalls[0].metadata.sandboxEnvironmentId,
    'env-boxlite-image',
  );
  const imageRun = await imageProvider.getSelectedSandboxRun('task-env-image');
  assert.equal(imageRun.environment.environmentId, 'env-boxlite-image');
  assert.equal(imageRun.preflight.environment.environmentId, 'env-boxlite-image');
});

await test('provider rejects incompatible selected environments without falling back', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    resolveEnvironment: async () => ({
      environmentId: 'env-aio',
      sourceKind: 'aio-docker-image',
      sourceRef: 'cap-aio:v1',
      providerFamily: 'aio',
    }),
  });

  await assert.rejects(
    () => provider.provision({ taskId: 'task-incompatible-env', cloneSpec: null }),
    /not compatible with BoxLite/,
  );
  assert.equal(client.createCalls.length, 0);
});

await test('provider rejects managed BoxLite rootfs environments without falling back', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_IMAGE: '',
      BOXLITE_ROOTFS_PATH: '/var/lib/cap/boxlite/default-rootfs',
      BOXLITE_CAPABILITIES: 'command.exec',
    }),
    client,
    resolveEnvironment: async () => ({
      environmentId: 'env-rootfs',
      sourceKind: 'boxlite-rootfs',
      sourceRef: '/var/lib/cap/boxlite/managed-rootfs',
      providerFamily: 'boxlite',
    }),
  });

  await assert.rejects(
    () => provider.provision({ taskId: 'task-managed-rootfs-env', cloneSpec: null }),
    /not compatible with BoxLite/,
  );
  assert.equal(client.createCalls.length, 0);
});

await test('validates BoxLite environments with create start exec delete probes', async () => {
  const client = new mod.FakeBoxLiteClient();

  const result = await mod.validateBoxLiteEnvironment({
    taskId: 'task-boxlite-probe',
    client,
    workspacePath: '/workspace',
    environment: {
      environmentId: 'env-boxlite',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-custom:v1',
      digest: 'sha256:boxlite',
    },
    requiredCommands: [{ name: 'git', command: 'command -v git' }],
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.resolvedDigest, 'sha256:boxlite');
  assert.equal(
    result.resolvedLocator,
    'cap-boxlite-custom:v1@sha256:boxlite',
  );
  assert.deepEqual(
    result.probes.map((probe) => [probe.name, probe.ok]),
    [
      ['create-sandbox', true],
      ['start-execution', true],
      ['exec-probe', true],
      ['git', true],
    ],
  );
  assert.equal(
    client.createCalls[0].image,
    'cap-boxlite-custom:v1@sha256:boxlite',
  );
  assert.equal(client.createCalls[0].rootfsPath, undefined);
  assert.equal(client.startExecutionCalls[0].command, 'true');
  assert.equal(client.execCalls[0].command, 'true');
  assert.equal(client.execCalls[1].command, 'command -v git');
  assert.deepEqual(client.deletedSandboxIds, ['probe-task-boxlite-probe']);
});

await test('BoxLite environment validation cleans up returned provider ids', async () => {
  const client = new mod.FakeBoxLiteClient();
  const originalCreate = client.createSandbox.bind(client);
  client.createSandbox = async (request) => {
    const sandbox = await originalCreate(request);
    client.sandboxes.delete(sandbox.id);
    const generated = { ...sandbox, id: 'generated-box-id' };
    client.sandboxes.set(generated.id, generated);
    return generated;
  };

  const result = await mod.validateBoxLiteEnvironment({
    taskId: 'task-boxlite-generated-id',
    client,
    environment: {
      environmentId: 'env-boxlite',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-custom:v1',
      digest: 'sha256:generated',
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(client.deletedSandboxIds, ['generated-box-id']);
  assert.equal(client.execCalls[0].sandboxId, 'generated-box-id');
});

await test('BoxLite environment validation fails closed and still deletes probe sandboxes', async () => {
  const client = new mod.FakeBoxLiteClient({
    execHandler: () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'missing',
      output: 'missing',
      timedOut: false,
    }),
  });

  const result = await mod.validateBoxLiteEnvironment({
    taskId: 'task-boxlite-probe-fail',
    client,
    environment: {
      environmentId: 'env-boxlite',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-custom:v1',
      digest: 'sha256:probe-fail',
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /exec probe failed/);
  assert.deepEqual(client.deletedSandboxIds, ['probe-task-boxlite-probe-fail']);
});

await test('BoxLite environment validation keeps original failure when cleanup fails', async () => {
  const client = new mod.FakeBoxLiteClient({
    execHandler: () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'missing',
      output: 'missing',
      timedOut: false,
    }),
  });
  client.deleteSandbox = async (id) => {
    client.deletedSandboxIds.push(id);
    throw new Error('delete failed');
  };

  const result = await mod.validateBoxLiteEnvironment({
    taskId: 'task-boxlite-cleanup-fail',
    client,
    environment: {
      environmentId: 'env-boxlite',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-custom:v1',
      digest: 'sha256:cleanup-fail',
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /exec probe failed/);
  assert.doesNotMatch(result.error, /delete failed/);
  assert.deepEqual(client.deletedSandboxIds, ['probe-task-boxlite-cleanup-fail']);
});

await test('BoxLite environment validation classifies registry pull failures', async () => {
  const cases = [
    {
      message:
        "Failed to pull image '127.0.0.1:5000/cap:v1': error sending request for url (https://127.0.0.1:5000/v2/cap/manifests/v1)",
      expected: /registry unreachable|registry transport|registry pull/,
    },
    {
      message: 'denied: permission_denied: token does not match expected scopes',
      expected: /registry authorization failed/,
    },
    {
      message: 'server gave HTTP response to HTTPS client',
      expected: /registry transport failed/,
    },
    {
      message: 'no matching manifest for linux/arm64 in manifest list entries',
      expected: /architecture or runtime mismatch/,
    },
  ];

  for (const [index, item] of cases.entries()) {
    const client = new mod.FakeBoxLiteClient();
    client.createSandbox = async () => {
      throw new Error(item.message);
    };
    const taskId = `task-boxlite-${index}`;

    const result = await mod.validateBoxLiteEnvironment({
      taskId,
      client,
      environment: {
        environmentId: 'env-boxlite',
        sourceKind: 'boxlite-image',
        sourceRef: 'cap-boxlite-custom:v1',
        digest: `sha256:registry-case-${index}`,
      },
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, item.expected);
    assert.match(result.probes.at(-1).output, item.expected);
    assert.deepEqual(client.deletedSandboxIds, [`probe-${taskId}`]);
  }
});

await test('BoxLite environment validation rejects mutable tags before creating a probe', async () => {
  const client = new mod.FakeBoxLiteClient();
  const result = await mod.validateBoxLiteEnvironment({
    taskId: 'task-boxlite-mutable',
    client,
    environment: {
      environmentId: 'env-boxlite',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-custom:v1',
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /digest-qualified/);
  assert.equal(client.createCalls.length, 0);
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

await test('provider uses the caller-pinned runtime before environment selection and preflight', async () => {
  const events = [];
  let legacyRuntimeLookupCalled = false;
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_IMAGE_MAP:
        'codex=cap-boxlite-codex:1,claude-code=cap-boxlite-claude:1',
    }),
    client,
    resolveRuntimeId: async (taskId) => {
      legacyRuntimeLookupCalled = true;
      events.push(`runtime:${taskId}`);
      return 'claude-code';
    },
    resolveEnvironment: async ({ taskId, runtimeId }) => {
      events.push(`environment:${taskId}:${runtimeId}`);
      return null;
    },
    preflight: async ({ taskId, runtimeId }) => {
      events.push(`preflight:${taskId}:${runtimeId}`);
      return { status: 'passed', checkedAt: '2026-07-11T00:00:00.000Z' };
    },
    runtimeSetup: async ({ taskId, runtimeId }) => {
      events.push(`setup:${taskId}:${runtimeId}`);
    },
  });

  await provider.provision({
    taskId: 'task-claude-runtime',
    cloneSpec: null,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'claude-code',
    executionMode: 'interactive-pty',
  });

  assert.equal(client.createCalls[0].image, 'cap-boxlite-claude:1');
  assert.equal(legacyRuntimeLookupCalled, false);
  assert.deepEqual(events, [
    'environment:task-claude-runtime:claude-code',
    'preflight:task-claude-runtime:claude-code',
    'setup:task-claude-runtime:claude-code',
  ]);
});

await test('metadata preflight failure blocks git materialization and credential injection', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_CAPABILITIES:
        'terminal.websocket,terminal.interactive,command.exec,workspace.git.materialize',
    }),
    client,
    preflight: async ({ executor }) => {
      await executor.exec({ command: 'cat /etc/cap/sandbox-metadata.json' });
      return {
        status: 'failed',
        checkedAt: '2026-07-11T00:00:00.000Z',
        error: 'sandbox metadata invalid',
      };
    },
  });

  await assert.rejects(
    () =>
      provider.provision({
        taskId: 'task-metadata-before-clone',
        cloneSpec: {
          url: 'https://example.test/private.git',
          authHeader: 'Authorization: Basic secret',
        },
      }),
    /sandbox metadata invalid/,
  );

  assert.deepEqual(
    client.execCalls.map((call) => call.command),
    ['cat /etc/cap/sandbox-metadata.json'],
  );
  assert.deepEqual(client.deletedSandboxIds, [
    'cap-boxlite-task-metadata-before-clone',
  ]);
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

await test('provider runs pre-stop cleanup before teardown and keeps deletion best-effort', async () => {
  const events = [];
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => {
      events.push(`exec:${request.command}`);
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
    preStopCleanup: async ({ taskId, sandbox, executor }) => {
      events.push(`cleanup:${taskId}:${sandbox.id}`);
      await executor.exec({ command: 'rm -rf secret-profile' });
      throw new Error('cleanup failure is non-fatal');
    },
  });
  await provider.provision({ taskId: 'task-cleanup', cloneSpec: null });
  await provider.teardownSandbox('task-cleanup');

  assert.deepEqual(events, [
    'cleanup:task-cleanup:cap-boxlite-task-cleanup',
    'exec:rm -rf secret-profile',
  ]);
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-cleanup']);
});

await test('provider runs pre-stop cleanup for readoptable BoxLite sandboxes', async () => {
  const events = [];
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => {
      events.push(`exec:${request.sandboxId}:${request.command}`);
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      };
    },
  });
  const firstProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  await firstProvider.provision({ taskId: 'task-readopt-cleanup', cloneSpec: null });

  const restartedProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preStopCleanup: async ({ taskId, sandbox, executor }) => {
      events.push(`cleanup:${taskId}:${sandbox.id}`);
      await executor.exec({ command: 'rm -rf cap-profile' });
    },
  });
  await restartedProvider.teardownSandbox('task-readopt-cleanup');

  assert.deepEqual(events, [
    'cleanup:task-readopt-cleanup:cap-boxlite-task-readopt-cleanup',
    'exec:cap-boxlite-task-readopt-cleanup:rm -rf cap-profile',
  ]);
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-readopt-cleanup']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
