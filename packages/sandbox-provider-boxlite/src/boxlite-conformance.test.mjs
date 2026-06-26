import assert from 'node:assert/strict';
const boxlite = await import(new URL('../dist/index.js', import.meta.url).href);
const conformance = await import(new URL('../../sandbox-conformance/dist/index.js', import.meta.url).href);

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

function fakeConfig(overrides = {}) {
  const result = boxlite.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'cap-boxlite:2026-06-27',
    BOXLITE_CAPABILITIES: [
      'command.exec',
      'workspace.archive.transfer',
      'workspace.git.deliver',
      'lifecycle.readoption',
    ].join(','),
    ...overrides,
  });
  assert.equal(result.status, 'valid');
  return result.config;
}

await test('fake BoxLite provider satisfies provider conformance for declared features', async () => {
  const provider = new boxlite.BoxLiteSandboxProvider({
    config: fakeConfig(),
    client: new boxlite.FakeBoxLiteClient(),
  });
  const scenarios = conformance.createSandboxProviderConformanceScenarios(
    {
      provider,
      taskId: 'task-conformance',
      cloneSpec: null,
      requiredCapabilities: ['command.exec', 'workspace.archive.transfer'],
      expectTranscriptSource: false,
      expectReadoption: true,
      expectSelectedRun: true,
    },
    assert,
  );
  const teardown = scenarios.find((scenario) =>
    scenario.name.startsWith('teardown'),
  );
  for (const scenario of scenarios.filter((entry) => entry !== teardown)) {
    await scenario.run();
  }
  await teardown?.run();
});

await test('live BoxLite integration is guarded by BOXLITE_LIVE_TEST', async () => {
  if (process.env.BOXLITE_LIVE_TEST !== '1') {
    console.log('skip - set BOXLITE_LIVE_TEST=1 with BOXLITE_* env to run live BoxLite integration');
    return;
  }

  const descriptorResult = boxlite.defineBoxLiteSandboxProviderFromEnv({
    env: process.env,
  });
  assert.equal(descriptorResult.status, 'registered');
  const provider = descriptorResult.descriptor.provider;
  const taskId = `boxlite-live-${Date.now()}`;
  try {
    const connection = await provider.provision({ taskId, cloneSpec: null });
    assert.equal(connection.taskId, taskId);
    assert.equal(await provider.sandboxExists(taskId), true);
  } finally {
    await provider.teardownSandbox(taskId);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
