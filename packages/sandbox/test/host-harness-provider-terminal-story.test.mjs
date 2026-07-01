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

function withProvider(value, fn) {
  const previous = process.env.CAP_SANDBOX_PROVIDER;
  if (value === undefined) delete process.env.CAP_SANDBOX_PROVIDER;
  else process.env.CAP_SANDBOX_PROVIDER = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CAP_SANDBOX_PROVIDER;
    else process.env.CAP_SANDBOX_PROVIDER = previous;
  }
}

await test('terminal story provider parser and matcher are provider-id based', () => {
  assert.equal(mod.readSandboxTerminalStoryProvider(undefined), 'auto');
  assert.equal(mod.readSandboxTerminalStoryProvider(' boxlite '), 'boxlite');
  assert.throws(
    () => mod.readSandboxTerminalStoryProvider('docker'),
    /invalid provider-backed terminal story provider/,
  );
  assert.equal(
    mod.providerMatchesSandboxTerminalStoryRequest('auto', 'anything'),
    true,
  );
  assert.equal(
    mod.providerMatchesSandboxTerminalStoryRequest('aio', 'AIO-local'),
    true,
  );
  assert.equal(
    mod.providerMatchesSandboxTerminalStoryRequest('aio', 'boxlite'),
    false,
  );
  assert.equal(
    mod.providerMatchesSandboxTerminalStoryRequest('boxlite', 'managed-boxlite'),
    true,
  );
});

await test('terminal story readiness reports disabled and capability-missing states', () => {
  withProvider('auto', () => {
    assert.deepEqual(
      mod.resolveSandboxTerminalStoryReadiness({
        enabled: false,
        rawProvider: 'aio',
        capabilities: ['terminal.websocket'],
        requiredCapabilities: ['terminal.websocket'],
        enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
      }),
      {
        enabled: false,
        ready: false,
        requestedProvider: 'aio',
        configuredProvider: 'auto',
        providerId: null,
        reason:
          'CAP_PROVIDER_TERMINAL_STORY=1 is required to create provider-backed terminal stories',
        capabilities: ['terminal.websocket'],
      },
    );

    assert.deepEqual(
      mod.resolveSandboxTerminalStoryReadiness({
        enabled: true,
        envProvider: 'auto',
        capabilities: ['terminal.websocket'],
        requiredCapabilities: ['terminal.websocket', 'command.exec'],
        enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
      }),
      {
        enabled: true,
        ready: false,
        requestedProvider: 'auto',
        configuredProvider: 'auto',
        providerId: null,
        reason:
          'configured sandbox provider is missing required capabilities: command.exec',
        capabilities: ['terminal.websocket'],
      },
    );
  });
});

await test('terminal story readiness respects configured provider family', () => {
  withProvider('control-plane', () => {
    assert.match(
      mod.resolveSandboxTerminalStoryReadiness({
        enabled: true,
        rawProvider: 'auto',
        capabilities: ['terminal.websocket'],
        requiredCapabilities: ['terminal.websocket'],
        enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
      }).reason,
      /control-plane has no sandbox provider/,
    );
  });

  withProvider('boxlite', () => {
    assert.deepEqual(
      mod.resolveSandboxTerminalStoryReadiness({
        enabled: true,
        rawProvider: 'aio',
        capabilities: ['terminal.websocket'],
        requiredCapabilities: ['terminal.websocket'],
        enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
      }),
      {
        enabled: true,
        ready: false,
        requestedProvider: 'aio',
        configuredProvider: 'boxlite',
        providerId: null,
        reason:
          'provider-backed terminal story requested aio, but CAP_SANDBOX_PROVIDER=boxlite is configured',
        capabilities: ['terminal.websocket'],
      },
    );
    const explicitBoxLiteMissingInteractive = mod.resolveSandboxTerminalStoryReadiness({
      enabled: true,
      rawProvider: 'boxlite',
      capabilities: ['terminal.websocket'],
      requiredCapabilities: ['terminal.websocket'],
      enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
    });
    assert.equal(explicitBoxLiteMissingInteractive.ready, false);
    assert.equal(explicitBoxLiteMissingInteractive.providerId, null);
    assert.match(
      explicitBoxLiteMissingInteractive.reason,
      /terminal\.interactive/,
    );

    assert.deepEqual(
      mod.resolveSandboxTerminalStoryReadiness({
        enabled: true,
        rawProvider: 'boxlite',
        capabilities: ['terminal.websocket', 'terminal.interactive'],
        requiredCapabilities: ['terminal.websocket'],
        enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
      }),
      {
        enabled: true,
        ready: true,
        requestedProvider: 'boxlite',
        configuredProvider: 'boxlite',
        providerId: 'boxlite',
        reason: null,
        capabilities: ['terminal.websocket', 'terminal.interactive'],
      },
    );

    const autoBoxLiteMissingInteractive = mod.resolveSandboxTerminalStoryReadiness({
      enabled: true,
      rawProvider: 'auto',
      capabilities: ['terminal.websocket'],
      requiredCapabilities: ['terminal.websocket'],
      enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
    });
    assert.equal(autoBoxLiteMissingInteractive.ready, false);
    assert.equal(autoBoxLiteMissingInteractive.providerId, null);
    assert.match(autoBoxLiteMissingInteractive.reason, /terminal\.interactive/);

    assert.equal(
      mod.resolveSandboxTerminalStoryReadiness({
        enabled: true,
        rawProvider: 'auto',
        capabilities: ['terminal.websocket', 'terminal.interactive'],
        requiredCapabilities: ['terminal.websocket'],
        enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
      }).providerId,
      'boxlite',
    );
  });

  withProvider('aio', () => {
    assert.equal(
      mod.resolveSandboxTerminalStoryReadiness({
        enabled: true,
        rawProvider: 'aio',
        capabilities: ['terminal.websocket'],
        requiredCapabilities: ['terminal.websocket'],
        enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
      }).providerId,
      'aio-local',
    );
    assert.match(
      mod.resolveSandboxTerminalStoryReadiness({
        enabled: true,
        rawProvider: 'boxlite',
        capabilities: ['terminal.websocket'],
        requiredCapabilities: ['terminal.websocket'],
        enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
      }).reason,
      /requested boxlite, but CAP_SANDBOX_PROVIDER=aio/,
    );
  });

  withProvider('auto', () => {
    const ready = mod.resolveSandboxTerminalStoryReadiness({
      enabled: true,
      rawProvider: 'auto',
      capabilities: ['terminal.websocket'],
      requiredCapabilities: ['terminal.websocket'],
      enableEnvName: 'CAP_PROVIDER_TERMINAL_STORY',
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.providerId, null);
    assert.equal(ready.reason, null);
  });
});

await test('configured retention-store factory returns a package-owned retention store', () => {
  const store = mod.createConfiguredSandboxRetentionStore();
  assert.equal(typeof store.listStoppedSandboxes, 'function');
  assert.equal(typeof store.removeStopped, 'function');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
