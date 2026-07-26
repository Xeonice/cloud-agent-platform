import assert from 'node:assert/strict';

import Docker from 'dockerode';

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

function diagnostics(overrides = {}) {
  return {
    mode: 'non-persisting',
    createOperationId: () => 'probe-operation-id',
    ...overrides,
  };
}

function controller(overrides = {}) {
  const calls = [];
  return {
    calls,
    async resolveImageIdentity(sourceRef) {
      calls.push(['resolveImageIdentity', sourceRef]);
      return {
        locator: 'registry.test/cap-aio@sha256:resolved',
        digest: 'sha256:resolved',
      };
    },
    async createAndStart(...args) {
      calls.push(['createAndStart', ...args]);
      return {
        connection: { baseUrl: 'http://probe-container:8080' },
        spec: {
          image: 'registry.test/cap-aio@sha256:resolved',
          readinessTimeoutMs: 321,
        },
      };
    },
    async waitForReadiness(args) {
      calls.push(['waitForReadiness', args]);
    },
    async runSandboxExec(...args) {
      calls.push(['runSandboxExec', ...args]);
      return { exitCode: 0, output: 'command ok' };
    },
    async removeSandboxAndConfirm(...args) {
      calls.push(['removeSandboxAndConfirm', ...args]);
      return { kind: 'found-and-cleaned' };
    },
    ...overrides,
  };
}

const validEnvironment = {
  environmentId: 'env-aio',
  sourceKind: 'aio-docker-image',
  sourceRef: 'registry.test/cap-aio:1.0.0',
};

await test('validates the resolved image, required commands, and cleanup contract', async () => {
  const observer = diagnostics();
  const fake = controller();
  const result = await mod.validateAioEnvironment({
    controller: fake,
    diagnostics: observer,
    environment: validEnvironment,
    requiredCommands: [{ name: 'node', command: 'node --version' }],
  });

  assert.deepEqual(result, {
    status: 'passed',
    providerFamily: 'aio',
    sourceKind: 'aio-docker-image',
    resolvedLocator: 'registry.test/cap-aio@sha256:resolved',
    resolvedDigest: 'sha256:resolved',
    probes: [
      {
        name: 'create-container',
        ok: true,
        output: 'registry.test/cap-aio@sha256:resolved',
      },
      { name: 'http-ready', ok: true, command: 'GET /v1/docs' },
      {
        name: 'node',
        command: 'node --version',
        ok: true,
        output: 'command ok',
      },
    ],
  });
  const create = fake.calls.find(([name]) => name === 'createAndStart');
  assert.deepEqual(create.slice(1), [
    'probe-operation-id',
    {
      ...validEnvironment,
      sourceRef: 'registry.test/cap-aio@sha256:resolved',
      digest: 'sha256:resolved',
    },
    undefined,
    { diagnostics: observer },
  ]);
  assert.deepEqual(
    fake.calls.find(([name]) => name === 'waitForReadiness')[1],
    {
      baseUrl: 'http://probe-container:8080',
      taskId: 'probe-operation-id',
      timeoutMs: 321,
      diagnostics: observer,
    },
  );
  assert.deepEqual(
    fake.calls.find(([name]) => name === 'removeSandboxAndConfirm').slice(1),
    ['probe-operation-id', undefined, undefined, observer],
  );
});

await test('rejects a persisting observer before allocating a probe identity', async () => {
  let allocated = false;
  await assert.rejects(
    mod.validateAioEnvironment({
      controller: controller(),
      diagnostics: diagnostics({
        mode: 'persisting',
        createOperationId() {
          allocated = true;
          return 'must-not-be-used';
        },
      }),
      environment: validEnvironment,
    }),
    /requires a non-persisting diagnostic observer/u,
  );
  assert.equal(allocated, false);
});

await test('reports unsupported and incomplete environment metadata and still cleans up', async () => {
  for (const [environment, message] of [
    [{ sourceKind: 'boxlite-image', sourceRef: 'boxlite:1.0.0' }, 'boxlite-image'],
    [{ sourceKind: undefined, sourceRef: 'unknown:1.0.0' }, 'unknown'],
    [{ sourceKind: 'aio-docker-image' }, 'image reference is missing'],
  ]) {
    const fake = controller();
    const result = await mod.validateAioEnvironment({
      controller: fake,
      diagnostics: diagnostics(),
      environment,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, new RegExp(message));
    assert.deepEqual(result.probes, [
      { name: 'validation-error', ok: false, output: result.error },
    ]);
    assert.equal(
      fake.calls.filter(([name]) => name === 'removeSandboxAndConfirm').length,
      1,
    );
  }
});

await test('retains resolved identity when provisioning fails', async () => {
  const fake = controller({
    async createAndStart() {
      throw new Error('container creation failed');
    },
  });
  const result = await mod.validateAioEnvironment({
    controller: fake,
    diagnostics: diagnostics(),
    environment: validEnvironment,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.resolvedLocator, 'registry.test/cap-aio@sha256:resolved');
  assert.equal(result.resolvedDigest, 'sha256:resolved');
  assert.equal(result.error, 'container creation failed');
});

await test('normalizes non-Error failures and readiness failures into probe evidence', async () => {
  const identityFailure = controller({
    async resolveImageIdentity() {
      throw 'identity unavailable';
    },
  });
  const identityResult = await mod.validateAioEnvironment({
    controller: identityFailure,
    diagnostics: diagnostics(),
    environment: validEnvironment,
  });
  assert.equal(identityResult.error, 'identity unavailable');
  assert.equal(identityResult.probes[0].output, 'identity unavailable');

  const readinessFailure = controller({
    async waitForReadiness() {
      throw new Error('readiness failed');
    },
  });
  const readinessResult = await mod.validateAioEnvironment({
    controller: readinessFailure,
    diagnostics: diagnostics(),
    environment: validEnvironment,
  });
  assert.deepEqual(
    readinessResult.probes.map(({ name, ok }) => ({ name, ok })),
    [
      { name: 'create-container', ok: true },
      { name: 'validation-error', ok: false },
    ],
  );
});

await test('keeps a failed command as the terminal probe without duplicating an error probe', async () => {
  const fake = controller({
    async runSandboxExec() {
      return { exitCode: 17, output: 'missing executable' };
    },
  });
  const result = await mod.validateAioEnvironment({
    controller: fake,
    diagnostics: diagnostics(),
    environment: validEnvironment,
    requiredCommands: [{ name: 'claude', command: 'claude --version' }],
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'AIO environment probe claude failed with exit_code 17');
  assert.deepEqual(result.probes.at(-1), {
    name: 'claude',
    command: 'claude --version',
    ok: false,
    output: 'missing executable',
  });
  assert.equal(result.probes.some(({ name }) => name === 'validation-error'), false);
});

await test('turns cleanup failure after success into a failed validation result', async () => {
  const cleanupError = new Error('docker remove unavailable');
  let observedCleanupError;
  const fake = controller({
    async removeSandboxAndConfirm() {
      throw cleanupError;
    },
  });
  const result = await mod.validateAioEnvironment({
    controller: fake,
    diagnostics: diagnostics(),
    environment: validEnvironment,
    onCleanupError(error) {
      observedCleanupError = error;
    },
  });

  assert.equal(observedCleanupError, cleanupError);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'AIO environment probe cleanup failed.');
  assert.deepEqual(result.probes.at(-1), {
    name: 'cleanup',
    ok: false,
    output: 'AIO environment probe cleanup failed.',
  });
});

await test('preserves the primary validation error when best-effort cleanup also fails', async () => {
  const fake = controller({
    async removeSandboxAndConfirm() {
      throw new Error('secondary cleanup failure');
    },
  });
  const result = await mod.validateAioEnvironment({
    controller: fake,
    diagnostics: diagnostics(),
    environment: { sourceKind: 'aio-docker-image' },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'AIO environment image reference is missing.');
  assert.equal(result.probes.some(({ name }) => name === 'cleanup'), false);
});

await test('detects only a named volume mounted at the normalized destination', async () => {
  const inspector = mod.createRepoStoreVolumeInspector({
    async inspectSelf() {
      return {
        Mounts: [
          { Type: 'bind', Name: 'bind-source', Destination: '/repo-store' },
          { Type: 'volume', Name: 7, Destination: '/repo-store' },
          { Type: 'volume', Name: '', Destination: '/repo-store' },
          { Type: 'volume', Name: 'missing-destination' },
          { Type: 'volume', Name: 'repo-volume', Destination: '/repo-store///' },
          { Type: 'volume', Name: 'root-volume', Destination: '/' },
        ],
      };
    },
  });

  assert.equal(await inspector.resolveVolumeName('/repo-store/'), 'repo-volume');
  assert.equal(await inspector.resolveVolumeName('/'), 'root-volume');
  assert.equal(await inspector.resolveVolumeName('/unmounted'), null);
});

await test('fails closed when injected self-inspection rejects or has no mount list', async () => {
  const rejected = mod.createRepoStoreVolumeInspector({
    async inspectSelf() {
      throw new Error('docker unavailable');
    },
  });
  assert.equal(await rejected.resolveVolumeName('/repo-store'), null);

  const missingMounts = mod.createRepoStoreVolumeInspector({
    async inspectSelf() {
      return {};
    },
  });
  assert.equal(await missingMounts.resolveVolumeName('/repo-store'), null);
});

await test('uses Docker self-inspection with explicit and operating-system hostnames', async () => {
  const originalGetContainer = Docker.prototype.getContainer;
  const inspectedHostnames = [];
  Docker.prototype.getContainer = function getContainer(hostname) {
    inspectedHostnames.push(hostname);
    return {
      inspect() {
        if (hostname === 'explicit-api-container') {
          return Promise.resolve({
            Mounts: [
              {
                Type: 'volume',
                Name: 'compose_repo-store',
                Destination: '/repo-store',
              },
            ],
          });
        }
        return Promise.reject(new Error('container not found'));
      },
    };
  };
  try {
    const explicit = mod.createRepoStoreVolumeInspector({
      hostname: () => 'explicit-api-container',
    });
    assert.equal(
      await explicit.resolveVolumeName('/repo-store'),
      'compose_repo-store',
    );

    const operatingSystemHostname = mod.createRepoStoreVolumeInspector();
    assert.equal(await operatingSystemHostname.resolveVolumeName('/repo-store'), null);
    assert.equal(inspectedHostnames[0], 'explicit-api-container');
    assert.equal(typeof inspectedHostnames[1], 'string');
    assert.ok(inspectedHostnames[1].length > 0);
  } finally {
    Docker.prototype.getContainer = originalGetContainer;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
