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

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

await test('cloud HTTP capabilities default to interactive-only until explicitly declared', () => {
  withEnv('CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES', undefined, () => {
    assert.deepEqual(
      mod.readSandboxProviderCapabilitiesEnv(
        'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
        mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
      ),
      ['terminal.websocket'],
    );
  });
});

await test('cloud HTTP capabilities accept an explicit comma-separated subset', () => {
  withEnv(
    'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
    ' terminal.websocket, workspace.git.deliver, terminal.websocket ',
    () => {
      assert.deepEqual(
        mod.readSandboxProviderCapabilitiesEnv(
          'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
          mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
        ),
        ['terminal.websocket', 'workspace.git.deliver'],
      );
    },
  );
});

await test('cloud HTTP capabilities accept all as an explicit full-capability opt-in', () => {
  withEnv('CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES', 'all', () => {
    assert.deepEqual(
      mod.readSandboxProviderCapabilitiesEnv(
        'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
        mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
      ),
      [
        'terminal.websocket',
        'workspace.git.materialize',
        'workspace.git.deliver',
        'transcript.retained-read',
        'lifecycle.readopt',
      ],
    );
  });
});

await test('cloud HTTP capabilities fail closed on unknown entries', () => {
  withEnv(
    'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
    'terminal.websocket,unknown.capability',
    () => {
      assert.throws(
        () =>
          mod.readSandboxProviderCapabilitiesEnv(
            'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
            mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
          ),
        /unknown sandbox provider capabilities: unknown\.capability/,
      );
    },
  );
});

await test('config readers normalize invalid numbers, locations, and empty capability lists', () => {
  withEnv('CAP_SANDBOX_LOCAL_PRIORITY', 'not-a-number', () => {
    assert.equal(mod.readNumberEnv('CAP_SANDBOX_LOCAL_PRIORITY', 10), 10);
  });
  withEnv('CAP_SANDBOX_LOCAL_PRIORITY', '25', () => {
    assert.equal(mod.readNumberEnv('CAP_SANDBOX_LOCAL_PRIORITY', 10), 25);
  });
  withEnv('CAP_SANDBOX_PREFER_LOCATION', 'edge', () => {
    assert.equal(mod.readSandboxLocationEnv('CAP_SANDBOX_PREFER_LOCATION'), undefined);
  });
  withEnv('CAP_SANDBOX_PREFER_LOCATION', 'cloud', () => {
    assert.equal(mod.readSandboxLocationEnv('CAP_SANDBOX_PREFER_LOCATION'), 'cloud');
  });
  withEnv('CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES', ' , ', () => {
    assert.throws(
      () =>
        mod.readSandboxProviderCapabilitiesEnv(
          'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
          mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
        ),
      /must contain at least one sandbox provider capability/,
    );
  });
});

await test('normalizes configured provider family and aliases', () => {
  assert.equal(mod.normalizeConfiguredSandboxProviderFamily(undefined), 'auto');
  assert.equal(mod.normalizeConfiguredSandboxProviderFamily(''), 'auto');
  assert.equal(mod.normalizeConfiguredSandboxProviderFamily('aio'), 'aio');
  assert.equal(mod.normalizeConfiguredSandboxProviderFamily('boxlite'), 'boxlite');
  assert.equal(
    mod.normalizeConfiguredSandboxProviderFamily('control-plane-only'),
    'control-plane',
  );
  assert.throws(
    () => mod.normalizeConfiguredSandboxProviderFamily('docker'),
    /invalid CAP_SANDBOX_PROVIDER/,
  );
});

await test('explicit provider families constrain eligible providers', () => {
  assert.equal(mod.providerFamilyAllowsAio('aio'), true);
  assert.equal(mod.providerFamilyAllowsBoxLite('aio'), false);
  assert.equal(mod.providerFamilyAllowsAio('boxlite'), false);
  assert.equal(mod.providerFamilyAllowsBoxLite('boxlite'), true);
  assert.equal(mod.providerFamilyAllowsCloudHttp('boxlite'), false);
  assert.equal(mod.providerFamilyAllowsAio('control-plane'), false);
  assert.equal(mod.providerFamilyAllowsBoxLite('control-plane'), false);
  assert.equal(mod.explicitProviderFamilyLabel('boxlite'), 'boxlite');
  assert.equal(mod.explicitProviderFamilyLabel('auto'), undefined);
});

await test('auto keeps capability selection family open', () => {
  assert.equal(mod.providerFamilyAllowsAio('auto'), true);
  assert.equal(mod.providerFamilyAllowsBoxLite('auto'), true);
  assert.equal(mod.providerFamilyAllowsCloudHttp('auto'), true);
});

await test('BoxLite runtime required tools default and normalize overrides', () => {
  assert.deepEqual(mod.readBoxLiteRuntimeRequiredTools({}), [
    'bash',
    'claude',
    'codex',
    'git',
    'gzip',
    'node',
    'openspec',
    'sh',
    'tar',
    'tmux',
  ]);
  assert.deepEqual(
    mod.readBoxLiteRuntimeRequiredTools({
      BOXLITE_RUNTIME_REQUIRED_TOOLS: 'sh, git  bash git',
    }),
    ['sh', 'git', 'bash'],
  );
  assert.throws(
    () =>
      mod.readBoxLiteRuntimeRequiredTools({
        BOXLITE_RUNTIME_REQUIRED_TOOLS: 'git;rm',
      }),
    /invalid tool name/,
  );
});

await test('deployment environment target follows configured provider and runtime image', () => {
  assert.deepEqual(
    mod.resolveConfiguredDeploymentEnvironmentTarget('codex', {
      CAP_SANDBOX_PROVIDER: 'aio',
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
    }),
    {
      name: 'Deployment AIO',
      providerId: 'aio-local',
      providerFamily: 'aio',
      source: {
        kind: 'aio-docker-image',
        image: 'cap-aio-sandbox:v1.2.3',
      },
      provisioningPolicy: {},
    },
  );

  const boxlite = mod.resolveConfiguredDeploymentEnvironmentTarget(
    'claude-code',
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'https://boxlite.example.test',
      BOXLITE_API_TOKEN: 'not-returned',
      BOXLITE_IMAGE: 'cap-boxlite@sha256:default',
      BOXLITE_IMAGE_MAP:
        'claude-code=cap-boxlite@sha256:claude-runtime',
      BOXLITE_CAPABILITIES: 'terminal.websocket,command.exec',
      BOXLITE_TERMINAL_MODE: 'pty',
    },
  );
  assert.equal(boxlite.providerFamily, 'boxlite');
  assert.equal(
    boxlite.source.image,
    'cap-boxlite@sha256:claude-runtime',
  );
  assert.deepEqual(boxlite.provisioningPolicy.resources, { diskSizeGb: 5 });
  assert.equal(
    boxlite.provisioningPolicy.workspaceMaterializationDeadlineMs,
    900_000,
  );
  assert.equal(Object.isFrozen(boxlite.provisioningPolicy.resources), true);
  assert.equal(JSON.stringify(boxlite).includes('not-returned'), false);
});

await test('configured provisioning policy freezes explicit resources over fallback', () => {
  const env = {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'not-returned',
    BOXLITE_IMAGE: 'cap-boxlite@sha256:default',
    BOXLITE_DISK_SIZE_GB: '7',
  };
  const fallback = mod.resolveConfiguredProviderProvisioningPolicyForFamily(
    { providerFamily: 'boxlite', resources: null },
    env,
  );
  assert.deepEqual(fallback.resources, { diskSizeGb: 7 });
  assert.equal(fallback.capabilities.includes('resource.disk-size-gb'), true);

  const explicit = mod.resolveConfiguredProviderProvisioningPolicyForFamily(
    { providerFamily: 'boxlite', resources: { diskSizeGb: 11 } },
    env,
  );
  assert.deepEqual(explicit.resources, { diskSizeGb: 11 });
  env.BOXLITE_DISK_SIZE_GB = '13';
  assert.deepEqual(explicit.resources, { diskSizeGb: 11 });
  assert.equal(Object.isFrozen(explicit), true);
  assert.equal(Object.isFrozen(explicit.resources), true);
});

await test('task provisioning policy mirrors Router candidates and materialized-workspace ranking', () => {
  const cloud = mod.resolveConfiguredTaskProvisioningPolicy({}, {
    CAP_SANDBOX_PROVIDER: 'auto',
    CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox.example.test',
    CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES: 'all',
  });
  assert.equal(cloud.providerId, 'cloud-http');
  assert.equal(cloud.providerFamily, 'cloud-http');
  assert.deepEqual(cloud.resources ?? {}, {});

  const fallbackAio = mod.resolveConfiguredTaskProvisioningPolicy({}, {
    CAP_SANDBOX_PROVIDER: 'auto',
    AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
    CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox.example.test',
  });
  assert.equal(fallbackAio.providerId, 'aio-local');
  assert.deepEqual(fallbackAio.resources ?? {}, {});

  const preferredAio = mod.resolveConfiguredTaskProvisioningPolicy({}, {
    CAP_SANDBOX_PROVIDER: 'auto',
    AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
    CAP_SANDBOX_LOCAL_PRIORITY: '50',
    CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox.example.test',
    CAP_SANDBOX_CLOUD_HTTP_PRIORITY: '50',
    CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES: 'all',
    CAP_SANDBOX_PREFER_LOCATION: 'local',
  });
  assert.equal(preferredAio.providerId, 'aio-local');

  assert.throws(
    () =>
      mod.resolveConfiguredTaskProvisioningPolicy({}, {
        CAP_SANDBOX_PROVIDER: 'auto',
      }),
    /Selected sandbox provider candidate aio-local is unavailable/,
  );
  assert.throws(
    () =>
      mod.resolveConfiguredTaskProvisioningPolicy({}, {
        CAP_SANDBOX_PROVIDER: 'aio',
      }),
    /Selected sandbox provider candidate aio-local is unavailable/,
  );
  assert.throws(
    () =>
      mod.resolveConfiguredTaskProvisioningPolicy({}, {
        CAP_SANDBOX_PROVIDER: 'auto',
        CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox.example.test',
        CAP_SANDBOX_CLOUD_HTTP_PRIORITY: '5',
        CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES: 'all',
      }),
    /Selected sandbox provider candidate aio-local is unavailable/,
  );
});

await test('task provisioning applies each candidate fallback before resource capability eligibility', () => {
  const commonBoxLite = {
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'not-returned',
    BOXLITE_IMAGE: 'cap-boxlite@sha256:default',
    BOXLITE_PROVIDER_PRIORITY: '25',
    BOXLITE_CAPABILITIES:
      'terminal.websocket,command.exec,workspace.git.materialize',
    BOXLITE_TERMINAL_MODE: 'pty',
  };
  const fallbackAio = mod.resolveConfiguredTaskProvisioningPolicy({}, {
    CAP_SANDBOX_PROVIDER: 'auto',
    AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
    ...commonBoxLite,
    BOXLITE_PROTOCOL_MODE: 'cap-rest',
  });
  assert.equal(fallbackAio.providerId, 'aio-local');
  assert.deepEqual(fallbackAio.resources ?? {}, {});

  const nativeBoxLite = mod.resolveConfiguredTaskProvisioningPolicy({}, {
    CAP_SANDBOX_PROVIDER: 'auto',
    ...commonBoxLite,
    BOXLITE_DISK_SIZE_GB: '9',
    BOXLITE_GIT_CLONE_TIMEOUT_MS: '123456',
  });
  assert.equal(nativeBoxLite.providerFamily, 'boxlite');
  assert.deepEqual(nativeBoxLite.resources, { diskSizeGb: 9 });
  assert.equal(nativeBoxLite.workspaceMaterializationDeadlineMs, 123456);
  assert.equal(Object.isFrozen(nativeBoxLite), true);
  assert.equal(Object.isFrozen(nativeBoxLite.resources), true);

  assert.throws(
    () =>
      mod.resolveConfiguredTaskProvisioningPolicy({}, {
        CAP_SANDBOX_PROVIDER: 'boxlite',
        ...commonBoxLite,
        BOXLITE_PROTOCOL_MODE: 'cap-rest',
      }),
    /missing resource\.disk-size-gb/,
  );
});

await test('configured resource eligibility fails closed before unsupported create protocols', () => {
  assert.throws(
    () =>
      mod.resolveConfiguredProviderProvisioningPolicyForFamily(
        { providerFamily: 'boxlite', resources: null },
        {
          CAP_SANDBOX_PROVIDER: 'boxlite',
          BOXLITE_ENDPOINT: 'https://boxlite.example.test',
          BOXLITE_API_TOKEN: 'not-returned',
          BOXLITE_IMAGE: 'cap-boxlite@sha256:default',
          BOXLITE_PROTOCOL_MODE: 'cap-rest',
        },
      ),
    /missing capabilities: resource\.disk-size-gb/,
  );
  assert.throws(
    () =>
      mod.resolveConfiguredProviderProvisioningPolicyForFamily(
        { providerFamily: 'aio', resources: { diskSizeGb: 5 } },
        {
          CAP_SANDBOX_PROVIDER: 'aio',
          AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
        },
      ),
    /missing capabilities: resource\.disk-size-gb/,
  );
  assert.doesNotThrow(() =>
    mod.resolveConfiguredProviderProvisioningPolicyForFamily(
      { providerFamily: 'aio', resources: null },
      {
        CAP_SANDBOX_PROVIDER: 'aio',
        AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
      },
    ),
  );
});

await test('deployment environment target fails closed for unsupported selected sources', () => {
  assert.throws(
    () =>
      mod.resolveConfiguredDeploymentEnvironmentTarget('codex', {
        CAP_SANDBOX_PROVIDER: 'control-plane',
      }),
    /no local runtime source/,
  );
  assert.throws(
    () =>
      mod.resolveConfiguredDeploymentEnvironmentTarget('codex', {
        CAP_SANDBOX_PROVIDER: 'auto',
        AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
        CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox.example.test',
      }),
    /cannot prove an immutable runtime source/,
  );
});

await test('managed provider identity is taken from the enabled provider config', () => {
  assert.equal(
    mod.resolveConfiguredProviderIdForFamily('aio', {
      CAP_SANDBOX_PROVIDER: 'aio',
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
    }),
    'aio-local',
  );
  assert.equal(
    mod.resolveConfiguredProviderIdForFamily('boxlite', {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'https://boxlite.example.test',
      BOXLITE_API_TOKEN: 'secret',
      BOXLITE_IMAGE: 'cap-boxlite@sha256:runtime',
      BOXLITE_PROVIDER_ID: 'boxlite-prod',
    }),
    'boxlite-prod',
  );
  assert.throws(
    () =>
      mod.resolveConfiguredProviderIdForFamily('boxlite', {
        CAP_SANDBOX_PROVIDER: 'aio',
        AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:v1.2.3',
      }),
    /unavailable/,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
