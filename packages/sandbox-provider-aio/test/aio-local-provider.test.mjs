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
      ORCHESTRATOR_APPROVALS_BASE: 'http://api:8080///',
    }),
    {
      image: 'registry.local/cap-aio-sandbox:1.2.3',
      network: 'cap-ci',
      readinessTimeoutMs: 1234,
      approvalsBase: 'http://api:8080',
    },
  );

  assert.equal(
    mod.readAioLocalSandboxConfig({
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      PORT: '18080',
    }).approvalsBase,
    'http://api:18080',
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
      approvalsBase: 'http://api:8080/',
    },
  });

  assert.equal(spec.containerName, 'cap-aio-task-helpers');
  assert.equal(spec.image, 'cap-aio-sandbox:0.1.0');
  assert.equal(spec.containerConfig.Image, 'cap-aio-sandbox:0.1.0');
  assert.equal(spec.connection.baseUrl, 'http://cap-aio-task-helpers:8080');
  assert.equal(spec.connection.wsUrl, 'ws://cap-aio-task-helpers:8080/v1/shell/ws');
  assert.equal(spec.containerConfig.HostConfig.SecurityOpt[0], 'seccomp=unconfined');
  assert.deepEqual(spec.containerConfig.Env, [
    'TASK_ID=task-helpers',
    'ORCHESTRATOR_APPROVALS_URL=http://api:8080/v1/approvals',
  ]);

  const custom = mod.buildAioLocalSandboxProvisionSpec({
    taskId: 'task-custom-env',
    config: {
      image: 'cap-aio-sandbox:0.1.0',
      network: 'cap-net-test',
      readinessTimeoutMs: 456,
      approvalsBase: 'http://api:8080',
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
          approvalsBase: 'http://api:8080',
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
  assert.equal(mod.normalizeUrlBase('http://example.test///'), 'http://example.test');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
