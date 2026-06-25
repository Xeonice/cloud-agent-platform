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

function provider(name, capabilities) {
  return {
    getSandboxMode: () => name,
    getProviderCapabilities: capabilities === undefined ? undefined : () => capabilities,
  };
}

await test('exports concrete capability and location vocabularies', () => {
  assert.deepEqual(mod.SANDBOX_PROVIDER_CAPABILITIES, [
    'terminal.websocket',
    'workspace.git.materialize',
    'workspace.git.deliver',
    'transcript.retained-read',
    'lifecycle.readopt',
  ]);
  assert.deepEqual(mod.SANDBOX_PROVIDER_LOCATIONS, ['local', 'cloud']);
  assert.deepEqual(mod.SANDBOX_EXECUTION_MODES, [
    'read-only',
    'workspace-write',
    'danger-full-access',
  ]);
});

await test('exports operation-specific required capability sets', () => {
  assert.deepEqual(mod.INTERACTIVE_SANDBOX_REQUIRED_CAPABILITIES, [
    'terminal.websocket',
  ]);
  assert.deepEqual(mod.MATERIALIZED_WORKSPACE_SANDBOX_REQUIRED_CAPABILITIES, [
    'terminal.websocket',
    'workspace.git.materialize',
  ]);
  assert.deepEqual(mod.DELIVERY_SANDBOX_REQUIRED_CAPABILITIES, [
    'workspace.git.deliver',
  ]);
  assert.deepEqual(mod.READOPTION_SANDBOX_REQUIRED_CAPABILITIES, [
    'lifecycle.readopt',
  ]);
  assert.deepEqual(mod.RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES, [
    'transcript.retained-read',
  ]);
});

await test('provider descriptor reads capabilities from declared providers', () => {
  const local = provider('aio-local', ['terminal.websocket']);
  const descriptor = mod.describeSandboxProvider({
    id: 'local-aio',
    provider: local,
    location: 'local',
    priority: 20,
  });
  assert.deepEqual(descriptor, {
    id: 'local-aio',
    provider: local,
    location: 'local',
    capabilities: ['terminal.websocket'],
    priority: 20,
  });
});

await test('provider descriptor accepts explicit capabilities for legacy providers', () => {
  const legacy = provider('legacy-local', undefined);
  const descriptor = mod.describeSandboxProvider({
    id: 'legacy-local',
    provider: legacy,
    location: 'local',
    capabilities: ['terminal.websocket'],
  });
  assert.deepEqual(descriptor.capabilities, ['terminal.websocket']);
});

await test('provider descriptor rejects undeclared adapters without explicit capabilities', () => {
  assert.throws(
    () =>
      mod.describeSandboxProvider({
        id: 'legacy-local',
        provider: provider('legacy-local', undefined),
        location: 'local',
      }),
    /requires declared capabilities/,
  );
});

await test('local and cloud helpers bind location metadata', () => {
  const localProvider = provider('aio-local', ['terminal.websocket']);
  const cloudProvider = provider('managed-cloud', ['terminal.websocket']);
  const local = mod.defineLocalSandboxProvider({
    id: 'local-aio',
    provider: localProvider,
    priority: 1,
  });
  const cloud = mod.defineCloudSandboxProvider({
    id: 'cloud-managed',
    provider: cloudProvider,
    priority: 2,
  });
  assert.equal(local.location, 'local');
  assert.equal(local.priority, 1);
  assert.equal(cloud.location, 'cloud');
  assert.equal(cloud.priority, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
