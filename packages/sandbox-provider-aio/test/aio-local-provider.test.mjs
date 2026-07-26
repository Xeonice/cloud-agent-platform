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

await test('defines local descriptors with defaults and explicit overrides', async () => {
  const defaultDescriptor = mod.defineAioLocalSandboxProvider({
    provider: {},
  });
  assert.equal(defaultDescriptor.id, 'aio-local');
  assert.equal(defaultDescriptor.location, 'local');
  assert.ok(defaultDescriptor.capabilities.includes('terminal.websocket'));

  const provider = {
    getProviderCapabilities() {
      return ['workspace.git.deliver'];
    },
  };
  const providerDescriptor = mod.defineAioLocalSandboxProvider({ provider });
  assert.deepEqual(providerDescriptor.capabilities, ['workspace.git.deliver']);

  const explicitDescriptor = mod.defineAioLocalSandboxProvider({
    id: 'custom-aio',
    provider,
    priority: 42,
    capabilities: ['lifecycle.readopt'],
  });
  assert.equal(explicitDescriptor.id, 'custom-aio');
  assert.equal(explicitDescriptor.priority, 42);
  assert.deepEqual(explicitDescriptor.capabilities, ['lifecycle.readopt']);
});

await test('reads pinned AIO config and rejects unsafe or invalid env', async () => {
  assert.deepEqual(
    mod.readAioLocalSandboxConfig({
      AIO_SANDBOX_IMAGE: 'registry.local/cap-aio-sandbox:1.2.3',
      AIO_SANDBOX_NETWORK: 'cap-ci',
      AIO_SANDBOX_READINESS_TIMEOUT_MS: '1234',
    }),
    {
      image: 'registry.local/cap-aio-sandbox:1.2.3',
      network: 'cap-ci',
      readinessTimeoutMs: 1234,
    },
  );

  assert.throws(() => mod.requirePinnedAioSandboxImage(undefined), /must be set/);
  assert.throws(
    () => mod.requirePinnedAioSandboxImage('cap-aio-sandbox'),
    /must be a pinned tag/,
  );
  assert.throws(
    () => mod.requirePinnedAioSandboxImage('cap-aio-sandbox:latest'),
    /must be a pinned tag/,
  );
  assert.throws(
    () =>
      mod.readAioLocalSandboxConfig({
        AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
        AIO_SANDBOX_READINESS_TIMEOUT_MS: '0',
      }),
    /positive integer/,
  );
});

await test('builds provision specs, names, env, and validation helpers', async () => {
  const spec = mod.buildAioLocalSandboxProvisionSpec({
    taskId: 'task-helpers',
    config: {
      image: 'cap-aio-sandbox:0.1.0',
      network: 'cap-net-test',
      readinessTimeoutMs: 456,
    },
  });

  assert.equal(spec.containerName, 'cap-aio-task-helpers');
  assert.equal(spec.image, 'cap-aio-sandbox:0.1.0');
  assert.equal(spec.containerConfig.Image, 'cap-aio-sandbox:0.1.0');
  assert.equal(spec.connection.baseUrl, 'http://cap-aio-task-helpers:8080');
  assert.equal(spec.connection.wsUrl, 'ws://cap-aio-task-helpers:8080/v1/shell/ws');
  assert.equal(spec.containerConfig.HostConfig.SecurityOpt[0], 'seccomp=unconfined');
  assert.deepEqual(spec.containerConfig.Env, ['TASK_ID=task-helpers']);

  const custom = mod.buildAioLocalSandboxProvisionSpec({
    taskId: 'task-custom-env',
    config: {
      image: 'cap-aio-sandbox:0.1.0',
      network: 'cap-net-test',
      readinessTimeoutMs: 456,
    },
    environment: {
      environmentId: 'env-aio',
      sourceKind: 'aio-docker-image',
      sourceRef: 'cap-aio-custom:1.0.0',
    },
  });
  assert.equal(custom.image, 'cap-aio-custom:1.0.0');
  assert.equal(custom.containerConfig.Image, 'cap-aio-custom:1.0.0');
  assert.throws(
    () =>
      mod.buildAioLocalSandboxProvisionSpec({
        taskId: 'task-wrong-env',
        config: {
          image: 'cap-aio-sandbox:0.1.0',
          network: 'cap-net-test',
          readinessTimeoutMs: 456,
        },
        environment: {
          environmentId: 'env-boxlite',
          sourceKind: 'boxlite-image',
          sourceRef: 'cap-boxlite:1.0.0',
        },
      }),
    /not compatible with AIO/,
  );

  assert.equal(
    mod.parseAioTaskIdFromContainerNames(['/other', '/cap-aio-task-helpers']),
    'task-helpers',
  );
  assert.equal(
    mod.parseAioTaskIdFromContainerNames(['cap-aio-task-plain']),
    'task-plain',
  );
  assert.equal(mod.parseAioTaskIdFromContainerNames(undefined), null);
  assert.equal(mod.parseAioTaskIdFromContainerNames(['/cap-aio-']), null);
  assert.throws(() => mod.assertAioSeccompUnconfined([]), /SecurityOpt/);
});

await test('builds a read-only repo source mount and rejects escaping mount inputs', async () => {
  assert.deepEqual(
    mod.buildAioRepoSourceMount({
      volumeName: 'cap-repo-store',
      subpath: 'repo-123.git/objects',
      mountPath: '/run/cap/repo-source',
    }),
    {
      Type: 'volume',
      Source: 'cap-repo-store',
      Target: '/run/cap/repo-source',
      ReadOnly: true,
      VolumeOptions: { Subpath: 'repo-123.git/objects' },
    },
  );

  for (const subpath of ['', '/repo.git', 'repos/../private.git']) {
    assert.throws(
      () =>
        mod.buildAioRepoSourceMount({
          volumeName: 'cap-repo-store',
          subpath,
          mountPath: '/run/cap/repo-source',
        }),
      /subpath must be relative/u,
    );
  }
  assert.throws(
    () =>
      mod.buildAioRepoSourceMount({
        volumeName: '   ',
        subpath: 'repo.git',
        mountPath: '/run/cap/repo-source',
      }),
    /requires a volume name/u,
  );
  assert.throws(
    () =>
      mod.buildAioRepoSourceMount({
        volumeName: 'cap-repo-store',
        subpath: 'repo.git',
        mountPath: 'run/cap/repo-source',
      }),
    /path must be absolute/u,
  );
});

await test('reports incompatible environment identity without assuming optional metadata', async () => {
  const base = {
    taskId: 'task-incompatible-env',
    config: {
      image: 'cap-aio-sandbox:0.1.0',
      network: 'cap-net-test',
      readinessTimeoutMs: 456,
    },
  };

  assert.throws(
    () =>
      mod.buildAioLocalSandboxProvisionSpec({
        ...base,
        environment: {
          id: 'legacy-env-id',
          sourceKind: 'boxlite-image',
          sourceRef: 'boxlite:test',
        },
      }),
    /environment legacy-env-id source boxlite-image/u,
  );
  assert.throws(
    () =>
      mod.buildAioLocalSandboxProvisionSpec({
        ...base,
        environment: { sourceRef: 'unknown:test' },
      }),
    /environment unknown source unknown/u,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
