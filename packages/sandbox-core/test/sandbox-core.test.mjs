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
  assert.deepEqual(mod.SANDBOX_PROVIDER_FEATURE_CAPABILITIES, [
    'terminal.interactive',
    'command.exec',
    'workspace.archive.transfer',
    'transcript.retained-source',
    'lifecycle.readoption',
    'lifecycle.sleep',
    'lifecycle.snapshot',
    'port.expose',
  ]);
  assert.deepEqual(mod.SANDBOX_PROVIDER_KNOWN_CAPABILITIES, [
    'terminal.websocket',
    'workspace.git.materialize',
    'workspace.git.deliver',
    'transcript.retained-read',
    'lifecycle.readopt',
    'terminal.interactive',
    'command.exec',
    'workspace.archive.transfer',
    'transcript.retained-source',
    'lifecycle.readoption',
    'lifecycle.sleep',
    'lifecycle.snapshot',
    'port.expose',
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
  assert.deepEqual(mod.INTERACTIVE_SANDBOX_FEATURE_CAPABILITIES, [
    'terminal.interactive',
    'command.exec',
  ]);
  assert.deepEqual(mod.ARCHIVE_WORKSPACE_SANDBOX_FEATURE_CAPABILITIES, [
    'workspace.archive.transfer',
    'command.exec',
  ]);
  assert.deepEqual(mod.DELIVERY_SANDBOX_FEATURE_CAPABILITIES, [
    'workspace.git.deliver',
    'command.exec',
  ]);
  assert.deepEqual(mod.READOPTION_SANDBOX_FEATURE_CAPABILITIES, [
    'lifecycle.readoption',
  ]);
  assert.deepEqual(mod.RETAINED_TRANSCRIPT_SANDBOX_FEATURE_CAPABILITIES, [
    'transcript.retained-source',
  ]);
});

await test('capability helpers report missing required entries', () => {
  assert.deepEqual(
    mod.missingCapabilities(['terminal.websocket'], [
      'terminal.websocket',
      'workspace.git.materialize',
    ]),
    ['workspace.git.materialize'],
  );
  assert.deepEqual(
    mod.missingCapabilities(undefined, ['terminal.websocket']),
    ['terminal.websocket'],
  );
  assert.deepEqual(
    mod.missingCapabilities(['lifecycle.readoption'], ['lifecycle.readopt']),
    [],
  );
  assert.equal(
    mod.hasAllCapabilities(['lifecycle.readopt'], ['lifecycle.readoption']),
    true,
  );
  assert.equal(
    mod.hasAllCapabilities(['terminal.websocket'], ['terminal.websocket']),
    true,
  );
  assert.equal(
    mod.hasAllCapabilities(['terminal.websocket'], ['command.exec']),
    false,
  );
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

await test('command executor helpers normalize provider command results', async () => {
  const nested = mod.normalizeSandboxCommandResult({
    data: {
      exit_code: '7',
      stderr: 'boom',
      timed_out: true,
    },
  });
  assert.equal(nested.exitCode, 7);
  assert.equal(nested.output, 'boom');
  assert.equal(nested.stderr, 'boom');
  assert.equal(nested.stdout, '');
  assert.equal(nested.timedOut, true);

  const flat = mod.normalizeSandboxCommandResult({
    code: 0,
    stdout: 'ok',
  });
  assert.equal(flat.exitCode, 0);
  assert.equal(flat.output, 'ok');
  assert.equal(flat.timedOut, false);

  assert(Number.isNaN(mod.normalizeSandboxCommandResult({ output: 'missing' }).exitCode));
  assert(Number.isNaN(mod.normalizeSandboxCommandResult(null).exitCode));
  assert.equal(
    mod.normalizeSandboxCommandResult({ exitCode: 2, stdout: '', stderr: '' }).output,
    '',
  );
  assert.equal(
    mod.normalizeSandboxCommandResult({ exit_code: 0, timeout: true }).timedOut,
    true,
  );
  assert.equal(
    mod.normalizeSandboxCommandResult({ exit_code: 0, timedOut: true }).timedOut,
    true,
  );

  const executor = mod.createSandboxCommandExecutor(async (request) => ({
    exitCode: 0,
    output: `${request.command} @ ${request.cwd ?? ''}`,
  }));
  const result = await executor.exec({
    command: 'pwd',
    cwd: '/home/gem/workspace',
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'pwd @ /home/gem/workspace');
});

await test('command executor helpers wrap cwd and scrub command output', () => {
  assert.equal(mod.buildSandboxCommandLine({ command: 'pwd' }), 'pwd');
  assert.equal(
    mod.buildSandboxCommandLine({
      cwd: "/workspace path/with spaces'; rm -rf /",
      command: 'git status',
    }),
    "cd '/workspace path/with spaces'\\''; rm -rf /' && git status",
  );
  assert.equal(
    mod.scrubSandboxCommandOutput(
      'https://u:p@example.com/x Authorization: Basic abc Bearer secret.token',
    ),
    'https://***:***@example.com/x Authorization: Basic *** Bearer ***',
  );
  assert.equal(
    mod.normalizeSandboxCommandResult(
      {
        exit_code: 1,
        output: 'Authorization: Basic abc',
      },
      { scrubOutput: true },
    ).output,
    'Authorization: Basic ***',
  );
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
    (err) =>
      err?.name === 'SandboxProviderConfigurationError' &&
      err?.code === 'sandbox_provider_configuration_error' &&
      /requires declared capabilities/.test(err.message),
  );
});

await test('provider-neutral error types expose stable codes', () => {
  const config = new mod.SandboxProviderConfigurationError('bad config');
  assert.equal(config.name, 'SandboxProviderConfigurationError');
  assert.equal(config.code, 'sandbox_provider_configuration_error');

  const capability = new mod.SandboxProviderCapabilityError('missing', [
    'terminal.websocket',
  ]);
  assert.equal(capability.name, 'SandboxProviderCapabilityError');
  assert.equal(capability.code, 'sandbox_provider_capability_error');
  assert.deepEqual(capability.missingCapabilities, ['terminal.websocket']);

  const selection = new mod.SandboxProviderSelectionError('no provider');
  assert.equal(selection.name, 'SandboxProviderSelectionError');
  assert.equal(selection.code, 'sandbox_provider_selection_error');
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
