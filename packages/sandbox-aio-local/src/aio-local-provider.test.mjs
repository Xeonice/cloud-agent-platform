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

await test('validates that AIO images are pinned tags', () => {
  assert.equal(
    mod.requirePinnedAioSandboxImage('registry.example.test/cap/aio:2026-06-24'),
    'registry.example.test/cap/aio:2026-06-24',
  );
  assert.throws(
    () => mod.requirePinnedAioSandboxImage(undefined),
    /AIO_SANDBOX_IMAGE must be set/,
  );
  assert.throws(
    () => mod.requirePinnedAioSandboxImage('cap-aio-sandbox:latest'),
    /must be a pinned tag/,
  );
  assert.throws(
    () => mod.requirePinnedAioSandboxImage('localhost:5000/cap-aio-sandbox'),
    /must be a pinned tag/,
  );
});

await test('builds deterministic local AIO connection URLs', () => {
  assert.equal(mod.buildAioSandboxContainerName('task-1'), 'cap-aio-task-1');
  assert.deepEqual(mod.buildAioSandboxConnection('task-1'), {
    taskId: 'task-1',
    baseUrl: 'http://cap-aio-task-1:8080',
    wsUrl: 'ws://cap-aio-task-1:8080/v1/shell/ws',
  });
});

await test('reads environment defaults and normalizes approval base', () => {
  assert.deepEqual(
    mod.readAioLocalSandboxConfig({
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      ORCHESTRATOR_APPROVALS_BASE: 'http://api:8080/',
    }),
    {
      image: 'cap-aio-sandbox:0.1.0',
      network: 'cap-net',
      readinessTimeoutMs: 60000,
      approvalsBase: 'http://api:8080',
    },
  );
});

await test('reads explicit network and readiness timeout values', () => {
  assert.deepEqual(
    mod.readAioLocalSandboxConfig({
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
      AIO_SANDBOX_READINESS_TIMEOUT_MS: '1500',
      ORCHESTRATOR_APPROVALS_BASE: 'http://api:8080///',
    }),
    {
      image: 'cap-aio-sandbox:0.1.0',
      network: 'cap-private',
      readinessTimeoutMs: 1500,
      approvalsBase: 'http://api:8080',
    },
  );
});

await test('blank readiness timeout uses the default', () => {
  assert.equal(
    mod.readAioLocalSandboxConfig({
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_READINESS_TIMEOUT_MS: '  ',
    }).readinessTimeoutMs,
    60000,
  );
});

await test('rejects invalid readiness timeouts', () => {
  assert.throws(
    () =>
      mod.readAioLocalSandboxConfig({
        AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
        AIO_SANDBOX_READINESS_TIMEOUT_MS: 'NaN',
      }),
    /AIO_SANDBOX_READINESS_TIMEOUT_MS must be a positive integer/,
  );
});

await test('seccomp assertion rejects invalid AIO host config', () => {
  assert.doesNotThrow(() => mod.assertAioSeccompUnconfined(['seccomp=unconfined']));
  assert.throws(
    () => mod.assertAioSeccompUnconfined([]),
    /HostConfig\.SecurityOpt must include 'seccomp=unconfined'/,
  );
});

await test('builds Docker-compatible container config without host port bindings', () => {
  const spec = mod.buildAioLocalSandboxProvisionSpec({
    taskId: 'task-1',
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
      PORT: '9090',
    },
  });
  assert.equal(spec.containerName, 'cap-aio-task-1');
  assert.equal(spec.containerConfig.Image, 'cap-aio-sandbox:0.1.0');
  assert.equal(spec.containerConfig.name, 'cap-aio-task-1');
  assert.deepEqual(spec.containerConfig.Env, [
    'TASK_ID=task-1',
    'ORCHESTRATOR_APPROVALS_URL=http://api:9090/internal/sandbox/approvals',
  ]);
  assert.equal(spec.containerConfig.HostConfig.AutoRemove, false);
  assert.equal(spec.containerConfig.HostConfig.NetworkMode, 'cap-private');
  assert.equal(spec.containerConfig.HostConfig.ShmSize, 2 * 1024 * 1024 * 1024);
  assert.ok(
    spec.containerConfig.HostConfig.SecurityOpt.includes('seccomp=unconfined'),
  );
  assert.equal('PortBindings' in spec.containerConfig.HostConfig, false);
});

await test('parses task ids from Docker container names', () => {
  assert.equal(
    mod.parseAioTaskIdFromContainerNames(['/cap-aio-task-live']),
    'task-live',
  );
  assert.equal(
    mod.parseAioTaskIdFromContainerNames(['foreign', '/cap-aio-']),
    null,
  );
  assert.equal(mod.parseAioTaskIdFromContainerNames(undefined), null);
});

await test('local provider descriptor defaults to full AIO capabilities', () => {
  const descriptor = mod.defineAioLocalSandboxProvider({
    provider: { getSandboxMode: () => 'danger-full-access' },
  });
  assert.equal(descriptor.id, 'aio-local');
  assert.equal(descriptor.location, 'local');
  assert.deepEqual(descriptor.capabilities, [
    'terminal.websocket',
    'workspace.git.materialize',
    'workspace.git.deliver',
    'transcript.retained-read',
    'lifecycle.readopt',
  ]);
});

await test('local provider descriptor accepts explicit and provider-declared capabilities', () => {
  const declared = mod.defineAioLocalSandboxProvider({
    provider: {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
    },
  });
  assert.deepEqual(declared.capabilities, ['terminal.websocket']);

  const explicit = mod.defineAioLocalSandboxProvider({
    provider: {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
    },
    capabilities: ['workspace.git.deliver'],
    priority: 5,
  });
  assert.deepEqual(explicit.capabilities, ['workspace.git.deliver']);
  assert.equal(explicit.priority, 5);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
