import assert from 'node:assert/strict';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(new URL('../../sandbox-core/dist/index.js', import.meta.url).href);

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function withDeadline(promise, timeoutMs = 2_000) {
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

function nonPersistingDiagnostics() {
  let identity = 0;
  return core.createNonPersistingSandboxProvisioningDiagnosticObserver({
    createOperationId: () =>
      `24000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`,
  });
}

const VALIDATION_PROBE_SANDBOX_ID =
  'probe-24000000-0000-4000-8000-000000000001';

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
  assert.equal(config.capabilities.includes('resource.disk-size-gb'), true);
  assert.equal(config.pathPrefix, 'default');
  assert.deepEqual(config.sandboxEnv, {});
  assert.equal(config.diskSizeGb, mod.BOXLITE_DEFAULT_DISK_SIZE_GB);
  assert.equal(
    config.gitCloneTimeoutMs,
    mod.BOXLITE_DEFAULT_GIT_CLONE_TIMEOUT_MS,
  );
  assert.equal(
    config.gitCloneTimeoutMs,
    core.DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS,
  );
  assert.equal(config.timeoutMs, mod.BOXLITE_DEFAULT_TIMEOUT_MS);
});

await test('cap-rest cannot opt into native disk enforcement capability', () => {
  const result = mod.readBoxLiteProviderConfig(
    validEnv({
      BOXLITE_PROTOCOL_MODE: 'cap-rest',
      BOXLITE_CAPABILITIES: 'command.exec,resource.disk-size-gb',
    }),
  );
  assert.equal(result.status, 'invalid');
  assert(
    result.errors.some((entry) =>
      entry.includes('cap-rest cannot advertise resource.disk-size-gb'),
    ),
  );
});

await test('config strictly validates disk and Git clone timeout bounds', () => {
  const deploymentDiskSizeGb = core.SANDBOX_DISK_SIZE_GB_MIN + 6;
  const gitCloneTimeoutMs = mod.BOXLITE_GIT_CLONE_TIMEOUT_MS_MIN + 12_345;
  const configured = validConfig({
    BOXLITE_DISK_SIZE_GB: String(deploymentDiskSizeGb),
    BOXLITE_GIT_CLONE_TIMEOUT_MS: String(gitCloneTimeoutMs),
  });
  assert.equal(configured.diskSizeGb, deploymentDiskSizeGb);
  assert.equal(configured.gitCloneTimeoutMs, gitCloneTimeoutMs);

  for (const [name, value] of [
    ['BOXLITE_DISK_SIZE_GB', String(core.SANDBOX_DISK_SIZE_GB_MIN - 1)],
    ['BOXLITE_DISK_SIZE_GB', String(core.SANDBOX_DISK_SIZE_GB_MAX + 1)],
    ['BOXLITE_DISK_SIZE_GB', '1.5'],
    [
      'BOXLITE_GIT_CLONE_TIMEOUT_MS',
      String(mod.BOXLITE_GIT_CLONE_TIMEOUT_MS_MIN - 1),
    ],
    [
      'BOXLITE_GIT_CLONE_TIMEOUT_MS',
      String(mod.BOXLITE_GIT_CLONE_TIMEOUT_MS_MAX + 1),
    ],
    ['BOXLITE_GIT_CLONE_TIMEOUT_MS', '1e3'],
  ]) {
    const result = mod.readBoxLiteProviderConfig(
      validEnv({ [name]: value }),
    );
    assert.equal(result.status, 'invalid');
    assert(result.errors.some((entry) => entry.includes(name)));
  }
});

await test('disk resolution uses managed resource then deployment config then product default', () => {
  const deploymentDiskSizeGb = core.SANDBOX_DISK_SIZE_GB_MIN + 7;
  const managedDiskSizeGb = deploymentDiskSizeGb + 1;
  const configured = validConfig({
    BOXLITE_DISK_SIZE_GB: String(deploymentDiskSizeGb),
  });
  assert.equal(
    mod.resolveBoxLiteDiskSizeGb({
      config: configured,
      resources: { diskSizeGb: managedDiskSizeGb },
    }),
    managedDiskSizeGb,
  );
  assert.equal(
    mod.resolveBoxLiteDiskSizeGb({ config: configured, resources: null }),
    deploymentDiskSizeGb,
  );
  assert.equal(
    mod.resolveBoxLiteDiskSizeGb({ config: validConfig() }),
    mod.BOXLITE_DEFAULT_DISK_SIZE_GB,
  );
  assert.throws(
    () =>
      mod.resolveBoxLiteDiskSizeGb({
        config: configured,
        resources: { diskSizeGb: core.SANDBOX_DISK_SIZE_GB_MAX + 1 },
      }),
    /integer from 1 to 1024/u,
  );
});

await test('control-plane and Git clone timeout configuration remain independent', () => {
  const controlPlaneTimeoutMs = mod.BOXLITE_DEFAULT_TIMEOUT_MS + 1;
  const gitCloneTimeoutMs =
    mod.BOXLITE_DEFAULT_GIT_CLONE_TIMEOUT_MS + 1;
  const config = validConfig({
    BOXLITE_TIMEOUT_MS: String(controlPlaneTimeoutMs),
    BOXLITE_GIT_CLONE_TIMEOUT_MS: String(gitCloneTimeoutMs),
  });
  assert.equal(config.timeoutMs, controlPlaneTimeoutMs);
  assert.equal(config.gitCloneTimeoutMs, gitCloneTimeoutMs);
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
      "df -Pk / | awk -v minimum=4718592 'NR == 2 { exit ($2 >= minimum ? 0 : 1) } END { if (NR < 2) exit 1 }'",
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

await test('durable BoxLite provisioning carries an immutable resource generation and readopts it after a lost create response', async () => {
  const client = new mod.FakeBoxLiteClient();
  const originalCreate = client.createSandbox.bind(client);
  let firstCreate = true;
  client.createSandbox = async (request) => {
    const sandbox = await originalCreate(request);
    if (firstCreate) {
      firstCreate = false;
      throw Object.assign(new Error('BoxLite create failed: HTTP 409'), {
        status: 409,
      });
    }
    return sandbox;
  };
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  const ownership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };

  await provider.provision({
    taskId: 'task-generation',
    cloneSpec: null,
    ownership,
    beforeSandboxCleanup: async () => true,
    afterSandboxCleanup: async () => undefined,
  });

  assert.equal(client.createCalls.length, 1);
  assert.equal(
    client.createCalls[0].env.CAP_RESOURCE_GENERATION,
    'resource:r1',
  );
  assert.equal(
    client.createCalls[0].labels['cap.resourceGeneration'],
    'resource:r1',
  );
  assert.equal(
    client.createCalls[0].metadata.resourceGeneration,
    'resource:r1',
  );
});

await test('BoxLite exact-generation teardown cannot address a recreated physical generation', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  await provider.provision({
    taskId: 'task-generation-mismatch',
    cloneSpec: null,
    ownership: {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:new',
    },
    beforeSandboxCleanup: async () => true,
    afterSandboxCleanup: async () => undefined,
  });

  assert.deepEqual(
    await provider.teardownSandbox('task-generation-mismatch', {
      ownership: {
        ownerGeneration: 'owner:g1',
        resourceGeneration: 'resource:old',
      },
    }),
    { kind: 'already-absent' },
  );
  assert.deepEqual(client.deletedSandboxIds, []);
  assert.equal(
    client.sandboxes.has(client.createCalls[0].sandboxId),
    true,
    'the newer physical generation must remain live',
  );
});

await test('BoxLite exact-generation teardown checks a same-id replacement instead of stale cache metadata', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  const ownership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:old',
  };
  await provider.provision({
    taskId: 'task-same-id-replacement',
    cloneSpec: null,
    ownership,
    beforeSandboxCleanup: async () => true,
    afterSandboxCleanup: async () => undefined,
  });

  const sandboxId = client.createCalls[0].sandboxId;
  client.sandboxes.set(sandboxId, {
    id: sandboxId,
    taskId: 'task-same-id-replacement',
    state: 'running',
    baseUrl: `boxlite://${sandboxId}`,
    terminalUrl: `boxlite://${sandboxId}/terminal`,
    metadata: { resourceGeneration: 'resource:new' },
  });

  await assert.rejects(
    provider.teardownSandbox('task-same-id-replacement', { ownership }),
    /resource generation mismatch/,
  );
  assert.deepEqual(client.deletedSandboxIds, []);
});

await test('an inspected old BoxLite generation cannot delete a newer ABA replacement', async () => {
  const client = new mod.FakeBoxLiteClient();
  const firstProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  const firstOwnership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  await firstProvider.provision({
    taskId: 'task-boxlite-aba',
    cloneSpec: null,
    ownership: firstOwnership,
    beforeSandboxCleanup: async () => null,
    afterSandboxCleanup: async () => undefined,
  });
  const firstSandboxId = client.createCalls[0].sandboxId;
  const inspected = deferred();
  const releaseInspection = deferred();
  const originalGetSandbox = client.getSandbox.bind(client);
  let heldFirstInspection = false;
  client.getSandbox = async (sandboxId) => {
    if (sandboxId === firstSandboxId && !heldFirstInspection) {
      heldFirstInspection = true;
      const snapshot = await originalGetSandbox(sandboxId);
      inspected.resolve();
      await releaseInspection.promise;
      return snapshot;
    }
    return originalGetSandbox(sandboxId);
  };

  const firstCleanup = firstProvider.teardownSandbox('task-boxlite-aba', {
    ownership: firstOwnership,
    cleanupAuthorization: {
      kind: 'generation',
      taskId: 'task-boxlite-aba',
      providerId: 'boxlite-test',
      ownership: firstOwnership,
    },
    providerSandboxId: firstSandboxId,
  });
  await inspected.promise;

  await client.deleteSandbox(firstSandboxId);
  const secondProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  const secondOwnership = {
    ownerGeneration: 'owner:g2',
    resourceGeneration: 'resource:r2',
  };
  await secondProvider.provision({
    taskId: 'task-boxlite-aba',
    cloneSpec: null,
    ownership: secondOwnership,
    beforeSandboxCleanup: async () => null,
    afterSandboxCleanup: async () => undefined,
  });
  const secondSandboxId = client.createCalls[1].sandboxId;
  assert.notEqual(secondSandboxId, firstSandboxId);

  releaseInspection.resolve();
  assert.deepEqual(await firstCleanup, { kind: 'found-and-cleaned' });
  assert.equal(await client.getSandbox(secondSandboxId) !== null, true);
});

await test('a restarted BoxLite provider readopts a generation-scoped persisted sandbox id', async () => {
  const client = new mod.FakeBoxLiteClient();
  const ownership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  const firstProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  await firstProvider.provision({
    taskId: 'task-generation-readopt',
    cloneSpec: null,
    ownership,
    beforeSandboxCleanup: async () => null,
    afterSandboxCleanup: async () => undefined,
  });
  const providerSandboxId = client.createCalls[0].sandboxId;
  assert.notEqual(providerSandboxId, 'cap-boxlite-task-generation-readopt');

  const restartedProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  assert.equal(await restartedProvider.reattach('task-generation-readopt'), null);
  const connection = await restartedProvider.reattach(
    'task-generation-readopt',
    { providerSandboxId, ownership },
  );
  assert.equal(connection?.baseUrl, `boxlite://${providerSandboxId}`);
  assert.equal(
    (await restartedProvider.getSelectedSandboxRun('task-generation-readopt'))
      ?.providerSandboxId,
    providerSandboxId,
  );
});

await test('BoxLite partial-create cleanup cannot bypass a lost owner fence', async () => {
  const client = new mod.FakeBoxLiteClient();
  let partialSandboxId;
  client.createSandbox = async (request) => {
    partialSandboxId = request.sandboxId;
    const sandbox = {
      id: request.sandboxId,
      taskId: request.taskId,
      state: 'configured',
      image: request.image,
    };
    client.sandboxes.set(sandbox.id, sandbox);
    throw new mod.BoxLitePartialCreateError(
      sandbox,
      new Error('start failed'),
    );
  };
  let cleanupChecks = 0;
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });

  await assert.rejects(
    provider.provision({
      taskId: 'task-partial-fenced',
      cloneSpec: null,
      ownership: {
        ownerGeneration: 'owner:g1',
        resourceGeneration: 'resource:r1',
      },
      beforeSandboxCleanup: async () => {
        cleanupChecks += 1;
        return false;
      },
      afterSandboxCleanup: async () => undefined,
    }),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      error.primary instanceof mod.BoxLitePartialCreateError &&
      !Object.keys(error).includes('primary'),
  );

  assert.equal(cleanupChecks, 1);
  assert.deepEqual(client.deletedSandboxIds, []);
  assert.equal(client.sandboxes.has(partialSandboxId), true);
});

await test('BoxLite late create is removed after an earlier exact teardown observed absence', async () => {
  const client = new mod.FakeBoxLiteClient();
  const createEntered = deferred();
  const releaseCreate = deferred();
  let lateSandboxId;
  let authorityCurrent = true;
  let currentCleanupAuthorization = null;
  const cleanupCompletions = [];
  client.createSandbox = async (request) => {
    lateSandboxId = request.sandboxId;
    await request.externalBoundaryGuard?.({
      taskId: request.taskId,
      action: 'sandbox.create',
      position: 'before',
    });
    createEntered.resolve();
    await releaseCreate.promise;
    const sandbox = {
      id: request.sandboxId,
      taskId: request.taskId,
      state: 'running',
      image: request.image,
      diskSizeGb: request.diskSizeGb,
      baseUrl: `boxlite://${request.sandboxId}`,
      terminalUrl: `boxlite://${request.sandboxId}/terminal`,
      metadata: request.metadata,
    };
    client.sandboxes.set(sandbox.id, sandbox);
    try {
      await request.externalBoundaryGuard?.({
        taskId: request.taskId,
        action: 'sandbox.create',
        position: 'after',
      });
      return sandbox;
    } catch (error) {
      throw new mod.BoxLitePartialCreateError(sandbox, error);
    }
  };
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  const ownership = {
    ownerGeneration: 'owner:g1',
    resourceGeneration: 'resource:r1',
  };
  const provision = provider.provision({
    taskId: 'task-late-boxlite-create',
    cloneSpec: null,
    ownership,
    externalBoundaryGuard: async () => {
      if (!authorityCurrent) throw new Error('lease lost');
    },
    beforeSandboxCleanup: async () => currentCleanupAuthorization,
    afterSandboxCleanup: async (authorization) => {
      cleanupCompletions.push(authorization);
    },
  });
  await createEntered.promise;

  currentCleanupAuthorization = {
    kind: 'generation',
    taskId: 'task-late-boxlite-create',
    providerId: 'boxlite-test',
    ownership: {
      ownerGeneration: 'owner:g2',
      resourceGeneration: 'resource:r1',
    },
  };
  authorityCurrent = false;
  assert.deepEqual(
    await provider.teardownSandbox('task-late-boxlite-create', {
      ownership: currentCleanupAuthorization.ownership,
    }),
    { kind: 'already-absent' },
  );
  assert.equal(client.sandboxes.size, 0);

  releaseCreate.resolve();
  await assert.rejects(provision, mod.BoxLitePartialCreateError);
  assert.equal(client.sandboxes.size, 0);
  assert.deepEqual(cleanupCompletions, [currentCleanupAuthorization]);
  assert.deepEqual(client.deletedSandboxIds, [lateSandboxId]);
});

await test('durable BoxLite provisioning fences provider actions independently from progress stages', async () => {
  const events = [];
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preflight: async ({ executor }) => {
      await executor.exec({ command: 'preflight-check' });
      return { status: 'passed', checkedAt: '2026-07-16T00:00:00.000Z' };
    },
    runtimeSetup: async ({ executor }) => {
      await executor.exec({ command: 'runtime-setup' });
    },
  });

  await provider.provision({
    taskId: 'task-boundary-events',
    cloneSpec: null,
    ownership: {
      ownerGeneration: 'owner:g1',
      resourceGeneration: 'resource:r1',
    },
    externalBoundaryGuard: async (event) => {
      events.push(`${event.action}:${event.position}`);
    },
    beforeSandboxCleanup: async () => true,
    afterSandboxCleanup: async () => undefined,
  });

  assert.deepEqual(events, [
    'environment.resolve:before',
    'environment.resolve:after',
    'sandbox.inspect:before',
    'sandbox.inspect:after',
    'sandbox.create:before',
    'sandbox.create:after',
    'sandbox.readiness:before',
    'sandbox.readiness:after',
    'runtime.preflight:before',
    'command.execute:before',
    'command.execute:after',
    'runtime.preflight:after',
    'workspace.materialize:before',
    'workspace.materialize:after',
    'runtime.setup:before',
    'command.execute:before',
    'command.execute:after',
    'runtime.setup:after',
  ]);
});

await test('BoxLite latches one-shot nested authority failures across redaction wrappers', async () => {
  for (const phase of ['preflight', 'runtime-setup']) {
    const authorityFailure = new Error(`lease authority lost during ${phase}`);
    let rejected = false;
    const provider = new mod.BoxLiteSandboxProvider({
      config: validConfig(),
      client: new mod.FakeBoxLiteClient(),
      preflight: async ({ executor }) => {
        if (phase === 'preflight') {
          await executor.exec({ command: 'preflight-authority-check' });
        }
        return { status: 'passed', checkedAt: '2026-07-16T00:00:00.000Z' };
      },
      runtimeSetup: async ({ executor }) => {
        if (phase === 'runtime-setup') {
          await executor.exec({ command: 'runtime-authority-check' });
        }
      },
    });

    await assert.rejects(
      () =>
        provider.provision({
          taskId: `task-one-shot-authority-${phase}`,
          cloneSpec: null,
          externalBoundaryGuard: async (event) => {
            if (
              !rejected &&
              event.action === 'command.execute' &&
              event.position === 'after'
            ) {
              rejected = true;
              throw authorityFailure;
            }
          },
        }),
      (error) => error === authorityFailure,
    );
    assert.equal(rejected, true);
  }
});

await test('BoxLite preserves the caller cancellation authority reason', async () => {
  const controller = new AbortController();
  const authorityFailure = new Error('durable worker stopped this provision');
  controller.abort(authorityFailure);
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });

  await assert.rejects(
    () =>
      provider.provision({
        taskId: 'task-cancel-reason',
        cloneSpec: null,
        cancellationSignal: controller.signal,
      }),
    (error) => error === authorityFailure,
  );
  assert.equal(client.createCalls.length, 0);
});

await test('reports composite phases before deferred BoxLite runtime setup settles', async () => {
  const setupEntered = deferred();
  const releaseSetup = deferred();
  const progress = [];
  const durableCheckpoints = [];
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: new mod.FakeBoxLiteClient(),
    preflight: async () => ({
      status: 'passed',
      checkedAt: '2026-07-16T00:00:00.000Z',
    }),
    runtimeSetup: async () => {
      setupEntered.resolve();
      await releaseSetup.promise;
    },
  });
  let settled = false;
  const provisioning = provider
    .provision({
      taskId: 'task-composite-progress',
      cloneSpec: null,
      onProvisioningProgress: (event) => progress.push(event.stage),
      beforeProvisioningBoundary: (event) =>
        durableCheckpoints.push(event.stage),
    })
    .finally(() => {
      settled = true;
    });

  await setupEntered.promise;
  assert.deepEqual(progress, ['readiness', 'runtime_setup']);
  assert.deepEqual(durableCheckpoints, ['runtime_setup']);
  assert.equal(settled, false);
  releaseSetup.resolve();
  await provisioning;
});

await test('redacts ordinary BoxLite preflight diagnostics', async () => {
  const canary = 'boxlite-preflight-private-canary';
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preflight: async () => {
      throw new Error(canary);
    },
  });

  await assert.rejects(
    () => provider.provision({ taskId: 'task-preflight-canary', cloneSpec: null }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes(canary),
  );
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-preflight-canary']);
});

await test('failed-run cleanup is not delayed by stalled primary diagnostics persistence', async () => {
  const taskId = '25000000-0000-4000-8000-000000000001';
  const terminalRecordEntered = deferred();
  const releaseTerminalRecord = deferred();
  const deleteCompleted = deferred();
  const recordedEvents = [];
  let identity = 0;
  const nextIdentity = (prefix) =>
    `${prefix}-0000-4000-8000-${String(++identity).padStart(12, '0')}`;
  const diagnostics = core.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId,
      attemptId: '25000000-0000-4000-8000-000000000002',
      attempt: 1,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
    },
    createEventId: () => nextIdentity('26000000'),
    createOperationId: () => nextIdentity('27000000'),
    record: async (event) => {
      recordedEvents.push(event);
      if (
        event.channel === 'primary' &&
        event.operation === 'runtime_setup' &&
        event.outcome === 'failed'
      ) {
        terminalRecordEntered.resolve();
        await releaseTerminalRecord.promise;
      }
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  const client = new mod.FakeBoxLiteClient();
  const originalDelete = client.deleteSandbox.bind(client);
  let deleteCalls = 0;
  client.deleteSandbox = async (sandboxId) => {
    deleteCalls += 1;
    await originalDelete(sandboxId);
    deleteCompleted.resolve();
  };
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    runtimeSetup: async () => {
      throw new Error('RAW_DEFERRED_RUNTIME_SETUP_CANARY');
    },
  });

  const rejectedProvision = assert.rejects(
    provider.provision({
      taskId,
      cloneSpec: null,
      diagnostics,
    }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error.stage === 'runtime_setup' &&
      !error.message.includes('RAW_DEFERRED_RUNTIME_SETUP_CANARY'),
  );

  await withDeadline(terminalRecordEntered.promise);
  try {
    await withDeadline(deleteCompleted.promise);
    await withDeadline(rejectedProvision);
    assert.equal(deleteCalls, 1);
    assert.equal(client.sandboxes.has(`cap-boxlite-${taskId}`), false);
  } finally {
    releaseTerminalRecord.resolve();
  }
  await withDeadline(diagnostics.flush());
  assert.equal(deleteCalls, 1);
  assert.equal(
    recordedEvents.some(
      (event) =>
        event.channel === 'primary' &&
        event.operation === 'runtime_setup' &&
        event.outcome === 'failed',
    ),
    true,
  );
});

await test('BoxLite provider-internal cleanup obeys the owner CAS and cannot delete after transfer', async () => {
  const client = new mod.FakeBoxLiteClient();
  let cleanupChecks = 0;
  let cleanupCompletions = 0;
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    runtimeSetup: async () => {
      throw new Error('runtime setup failed after transfer');
    },
  });

  await assert.rejects(
    provider.provision({
      taskId: 'task-stale-cleanup',
      cloneSpec: null,
      ownership: {
        ownerGeneration: 'owner:g1',
        resourceGeneration: 'resource:r1',
      },
      beforeSandboxCleanup: async () => {
        cleanupChecks += 1;
        return false;
      },
      afterSandboxCleanup: async () => {
        cleanupCompletions += 1;
      },
    }),
    (error) =>
      error?.code === 'sandbox_cleanup_coordination_pending' &&
      error.primary?.code === 'sandbox_provisioning_stage_error' &&
      error.primary?.stage === 'runtime_setup' &&
      !error.primary.message.includes('runtime setup failed after transfer') &&
      !Object.keys(error).includes('primary'),
  );

  assert.equal(cleanupChecks, 1);
  assert.equal(cleanupCompletions, 0);
  assert.deepEqual(client.deletedSandboxIds, []);
  assert.equal(
    await client.getSandbox(client.createCalls[0].sandboxId) !== null,
    true,
  );
});

await test('cap-rest provisioning rejects the resolved fallback resource before create', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_PROTOCOL_MODE: 'cap-rest' }),
    client,
  });

  await assert.rejects(
    () =>
      provider.provision({
        taskId: 'task-resource-gate',
        cloneSpec: null,
      }),
    /missing capabilities: resource\.disk-size-gb/,
  );
  assert.equal(client.createCalls.length, 0);
});

await test('task provisioning verifies actual rootfs capacity even when create echoes the requested disk', async () => {
  const canary = 'CAP_BOXLITE_CAPACITY_OUTPUT_CANARY';
  const client = new mod.FakeBoxLiteClient({
    execHandler: () => ({
      exitCode: 1,
      stdout: '',
      stderr: canary,
      output: canary,
      timedOut: false,
    }),
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_DISK_SIZE_GB: '9' }),
    client,
  });

  await assert.rejects(
    () =>
      provider.provision({
        taskId: 'task-capacity-probe',
        cloneSpec: null,
      }),
    (error) =>
      error?.code === 'sandbox_provisioning_capacity_error' &&
      error?.message ===
        'Sandbox provisioned capacity is below the resolved resource policy' &&
      !error.message.includes(canary),
  );
  assert.equal(client.createCalls[0].diskSizeGb, 9);
  assert.match(client.execCalls[0].command, /^df -Pk \/ \| awk/);
  assert.deepEqual(client.deletedSandboxIds, [
    'cap-boxlite-task-capacity-probe',
  ]);
  assert.equal(await provider.sandboxExists('task-capacity-probe'), false);
});

await test('capacity remains primary when physical cleanup confirms the sandbox still exists', async () => {
  const capacityCanary = 'RAW_CAPACITY_PRIMARY_CANARY';
  const cleanupCanary = 'RAW_CAPACITY_CLEANUP_CANARY';
  const taskId = 'task-capacity-cleanup-failed';
  const ownership = {
    ownerGeneration: 'owner:capacity-cleanup-failed',
    resourceGeneration: 'resource:capacity-cleanup-failed',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-test',
    ownership,
  };
  const client = new mod.FakeBoxLiteClient({
    execHandler: () => ({
      exitCode: 1,
      stdout: '',
      stderr: capacityCanary,
      output: capacityCanary,
      timedOut: false,
    }),
  });
  client.deleteSandbox = async (sandboxId) => {
    client.deletedSandboxIds.push(sandboxId);
    throw new Error(cleanupCanary);
  };
  const physicalResults = [];
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_DISK_SIZE_GB: '9' }),
    client,
  });

  let failure;
  await assert.rejects(
    () =>
      provider.provision({
        taskId,
        cloneSpec: null,
        ownership,
        beforeSandboxCleanup: async () => authorization,
        settleSandboxCleanupAttempt: async (receivedAuthorization, physical) => {
          assert.equal(receivedAuthorization, authorization);
          physicalResults.push(physical);
        },
      }),
    (error) => {
      failure = error;
      return (
        error?.code === 'sandbox_provisioning_capacity_error' &&
        error.message ===
          'Sandbox provisioned capacity is below the resolved resource policy' &&
        error.code !== 'sandbox_cleanup_coordination_pending'
      );
    },
  );

  assert.deepEqual(physicalResults, [
    {
      outcome: 'failed',
      proof: null,
      cause: 'cleanup_failed',
      retryable: true,
    },
  ]);
  assert.equal(Object.isFrozen(physicalResults[0]), true);
  assert.deepEqual(client.deletedSandboxIds, [client.createCalls[0].sandboxId]);
  assert.equal(await provider.sandboxExists(taskId), true);
  assert.equal(JSON.stringify(failure).includes(capacityCanary), false);
  assert.equal(JSON.stringify(failure).includes(cleanupCanary), false);
  assert.equal(Object.hasOwn(failure, 'primary'), false);
});

await test('direct BoxLite provisioning rejects canonical credentials before create', async () => {
  const canary = 'CAP_BOXLITE_UNMIGRATED_CREDENTIAL_CANARY';
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });

  await assert.rejects(
    () =>
      provider.provision({
        taskId: 'task-credential-gate',
        cloneSpec: null,
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
      /staged workspace hook/.test(err.message) &&
      !err.message.includes(canary),
  );
  assert.equal(client.createCalls.length, 0);
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

await test('legacy environments snapshot the validated deployment disk fallback', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_DISK_SIZE_GB: '11' }),
    client,
    resolveEnvironment: async () => ({
      environmentId: 'env-legacy-no-resources',
      name: 'Legacy BoxLite environment',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-legacy:v1',
      providerFamily: 'boxlite',
    }),
  });

  await provider.provision({
    taskId: 'task-legacy-disk-fallback',
    cloneSpec: null,
  });

  assert.equal(client.createCalls[0].diskSizeGb, 11);
  assert.deepEqual(client.createCalls[0].metadata.resources, {
    diskSizeGb: 11,
  });
  const selected = await provider.getSelectedSandboxRun(
    'task-legacy-disk-fallback',
  );
  assert.deepEqual(selected.environment.resources, { diskSizeGb: 11 });
  assert.equal(Object.isFrozen(selected.environment.resources), true);
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
    client,
    diagnostics: nonPersistingDiagnostics(),
    workspacePath: '/workspace',
    environment: {
      environmentId: 'env-boxlite',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-custom:v1',
      digest: 'sha256:boxlite',
      resources: { diskSizeGb: 9 },
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
      ['disk-capacity', true],
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
  assert.equal(client.createCalls[0].diskSizeGb, 9);
  assert.deepEqual(result.resourceSnapshot, { diskSizeGb: 9 });
  assert.equal(client.startExecutionCalls[0].command, 'true');
  assert.match(client.execCalls[0].command, /^df -Pk \/ \| awk/);
  assert.equal(client.execCalls[1].command, 'true');
  assert.equal(client.execCalls[2].command, 'command -v git');
  assert.deepEqual(client.deletedSandboxIds, [VALIDATION_PROBE_SANDBOX_ID]);
});

await test('validation and task provisioning use the same frozen managed disk snapshot', async () => {
  const resources = { diskSizeGb: 13 };
  const environment = {
    environmentId: 'env-resource-parity',
    name: 'Resource parity',
    providerFamily: 'boxlite',
    sourceKind: 'boxlite-image',
    sourceRef: 'cap-boxlite-custom:v1@sha256:parity',
    digest: 'sha256:parity',
    resources,
  };
  const validationClient = new mod.FakeBoxLiteClient();
  const validation = await mod.validateBoxLiteEnvironment({
    client: validationClient,
    diagnostics: nonPersistingDiagnostics(),
    environment,
  });
  assert.equal(validation.status, 'passed');

  const taskClient = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_DISK_SIZE_GB: '7' }),
    client: taskClient,
    resolveEnvironment: async () => environment,
  });
  await provider.provision({
    taskId: 'task-resource-parity',
    cloneSpec: null,
  });

  assert.equal(validationClient.createCalls[0].diskSizeGb, 13);
  assert.equal(taskClient.createCalls[0].diskSizeGb, 13);
  assert.deepEqual(validation.resourceSnapshot, resources);
  assert.deepEqual(taskClient.createCalls[0].metadata.resources, resources);
  assert.equal(
    Object.isFrozen(
      (await provider.getSelectedSandboxRun('task-resource-parity')).environment
        .resources,
    ),
    true,
  );
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
    client,
    diagnostics: nonPersistingDiagnostics(),
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
    client,
    diagnostics: nonPersistingDiagnostics(),
    environment: {
      environmentId: 'env-boxlite',
      sourceKind: 'boxlite-image',
      sourceRef: 'cap-boxlite-custom:v1',
      digest: 'sha256:probe-fail',
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /exec probe failed/);
  assert.deepEqual(client.deletedSandboxIds, [VALIDATION_PROBE_SANDBOX_ID]);
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
    client,
    diagnostics: nonPersistingDiagnostics(),
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
  assert.deepEqual(client.deletedSandboxIds, [VALIDATION_PROBE_SANDBOX_ID]);
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
    const result = await mod.validateBoxLiteEnvironment({
      client,
      diagnostics: nonPersistingDiagnostics(),
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
    assert.deepEqual(client.deletedSandboxIds, [VALIDATION_PROBE_SANDBOX_ID]);
  }
});

await test('BoxLite environment validation rejects mutable tags before creating a probe', async () => {
  const client = new mod.FakeBoxLiteClient();
  const result = await mod.validateBoxLiteEnvironment({
    client,
    diagnostics: nonPersistingDiagnostics(),
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
  assert.equal(execCount, 3);
});

await test('runtime preflight failure tears down the created sandbox and rejects provision', async () => {
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => ({
      exitCode: request.command.startsWith('df -Pk /') ? 0 : 1,
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
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes('missing-tool'),
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
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes('sandbox metadata invalid'),
  );

  assert.deepEqual(
    client.execCalls.map((call) => call.command),
    [
      "df -Pk / | awk -v minimum=4718592 'NR == 2 { exit ($2 >= minimum ? 0 : 1) } END { if (NR < 2) exit 1 }'",
      'cat /etc/cap/sandbox-metadata.json',
    ],
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
    "exec:df -Pk / | awk -v minimum=4718592 'NR == 2 { exit ($2 >= minimum ? 0 : 1) } END { if (NR < 2) exit 1 }':/home/gem/workspace",
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
      throw new Error('boxlite-runtime-setup-private-canary');
    },
  });

  await assert.rejects(
    () => provider.provision({ taskId: 'task-runtime-setup-fail', cloneSpec: null }),
    (error) =>
      error?.code === 'sandbox_provisioning_stage_error' &&
      error?.stage === 'runtime_setup' &&
      !error.message.includes('boxlite-runtime-setup-private-canary'),
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
    },
  });
  assert(commands.every((command) => !command.includes('http.extraHeader=')));
  assert(commands.some((command) => command.includes('clone --recursive')));
  assert.equal(client.deletedSandboxIds.length, 0);
});

await test('provider tears down sandbox when git materialization fails', async () => {
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => ({
      exitCode: request.command.startsWith('df -Pk /') ? 0 : 128,
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

  // The daemon EXTRACTS uploaded bodies (native /files semantics), so the
  // helper round-trips a single-entry tar envelope, not raw bytes.
  await provider.uploadWorkspaceArchive({
    taskId: 'task-3',
    archive: core.createSandboxMode0600FileArchive(
      'payload.bin',
      new Uint8Array([1, 2, 3]),
    ),
  });
  assert.deepEqual(
    [
      ...(await provider.downloadWorkspaceArchive({
        taskId: 'task-3',
        path: '/home/gem/workspace/payload.bin',
      })),
    ],
    [1, 2, 3],
  );
});

await test('command executor preserves a proven native failure without fabricating a numeric exit', async () => {
  const settlement = new core.SandboxCommandSettlementError(
    'failed_without_exit',
  );
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: new mod.FakeBoxLiteClient({
      execHandler: async () => {
        throw settlement;
      },
    }),
  });

  await assert.rejects(
    () =>
      provider
        .createCommandExecutor('cap-boxlite-task-missing-exit')
        .exec({ command: 'false' }),
    (error) => error === settlement,
  );
  assert.deepEqual(core.classifySandboxCommandExecutionRejection(settlement), {
    settlement: 'failed_without_exit',
    outcome: 'failed',
    cause: 'missing_exit_code',
    retryable: false,
    exitCode: null,
    anomaly: 'missing_exit_code',
  });
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

await test('provider teardown does not wait for diagnostics flush and remains idempotent', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  const flushEntered = deferred();
  const neverFlushes = new Promise(() => {});
  let operationIdentity = 0;
  const diagnostics = {
    mode: 'non-persisting',
    createOperationId: () =>
      `2b000000-0000-4000-8000-${String(++operationIdentity).padStart(12, '0')}`,
    async emit() {},
    async flush() {
      flushEntered.resolve();
      await neverFlushes;
    },
  };
  await provider.provision({ taskId: 'task-4', cloneSpec: null });
  assert.deepEqual(
    await withDeadline(provider.teardownSandbox('task-4', { diagnostics })),
    { kind: 'found-and-cleaned' },
  );
  await withDeadline(flushEntered.promise);
  assert.deepEqual(await provider.teardownSandbox('task-4'), {
    kind: 'already-absent',
  });
  assert.equal(await provider.sandboxExists('task-4'), false);
  assert.deepEqual(client.deletedSandboxIds, ['cap-boxlite-task-4']);
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
  events.length = 0;
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
  events.length = 0;

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
