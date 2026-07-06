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

const aioImage = {
  kind: 'aio-docker-image',
  image: 'ghcr.io/example/cap-aio-sandbox:v1.2.3',
  digest: 'sha256:aio',
};

const boxliteImage = {
  kind: 'boxlite-image',
  image: 'ghcr.io/example/cap-boxlite-sandbox:v1.2.3',
  digest: 'sha256:boxlite',
};

const boxliteRootfs = {
  kind: 'boxlite-rootfs',
  rootfsPath: '/var/lib/cap/rootfs/v1.2.3',
  checksum: 'sha256:rootfs',
};

await test('source descriptors map to provider families and references', () => {
  assert.deepEqual(mod.providerFamiliesForEnvironmentSource(aioImage), ['aio']);
  assert.deepEqual(mod.providerFamiliesForEnvironmentSource(boxliteImage), ['boxlite']);
  assert.deepEqual(mod.providerFamiliesForEnvironmentSource(boxliteRootfs), ['boxlite']);
  assert.deepEqual(
    mod.providerFamiliesForEnvironmentSource({
      kind: 'provider-template',
      providerFamily: 'cloud-http',
      templateId: 'template-a',
    }),
    ['cloud-http'],
  );
  assert.equal(mod.sourceReference(aioImage), aioImage.image);
  assert.equal(mod.sourceReference(boxliteRootfs), boxliteRootfs.rootfsPath);
  assert.equal(mod.sourceDigest(boxliteImage), 'sha256:boxlite');
  assert.equal(mod.sourceChecksum(boxliteRootfs), 'sha256:rootfs');
});

await test('selects exactly one source for provider family', () => {
  assert.equal(
    mod.selectEnvironmentSourceForProvider({
      sources: [aioImage, boxliteRootfs],
      providerFamily: 'aio',
    }),
    aioImage,
  );
  assert.equal(
    mod.selectEnvironmentSourceForProvider({
      sources: [aioImage, boxliteRootfs],
      providerFamily: 'boxlite',
    }),
    boxliteRootfs,
  );
});

await test('source ambiguity fails closed', () => {
  assert.throws(
    () =>
      mod.selectEnvironmentSourceForProvider({
        sources: [boxliteImage, boxliteRootfs],
        providerFamily: 'boxlite',
      }),
    (err) =>
      err?.name === 'SandboxEnvironmentSourceError' &&
      err?.code === 'sandbox_environment_source_error' &&
      /multiple sources/.test(err.message),
  );
  assert.throws(
    () =>
      mod.selectEnvironmentSourceForProvider({
        sources: [boxliteRootfs],
        providerFamily: 'aio',
      }),
    (err) =>
      err?.name === 'SandboxEnvironmentSourceError' &&
      /No sandbox environment source/.test(err.message),
  );
});

await test('ready status and compatibility gate selection', () => {
  const environment = {
    id: 'env-1',
    status: 'ready',
    compatibility: {
      providerFamilies: ['aio'],
      runtimeIds: ['codex'],
    },
  };
  assert.equal(
    mod.isEnvironmentCompatible({
      environment,
      providerFamily: 'aio',
      runtimeId: 'codex',
    }),
    true,
  );
  assert.equal(
    mod.isEnvironmentCompatible({
      environment,
      providerFamily: 'boxlite',
      runtimeId: 'codex',
    }),
    false,
  );
  assert.equal(
    mod.isEnvironmentCompatible({
      environment,
      providerFamily: 'aio',
      runtimeId: 'claude-code',
    }),
    false,
  );
  assert.equal(
    mod.isEnvironmentCompatible({
      environment: { ...environment, status: 'stale' },
      providerFamily: 'aio',
      runtimeId: 'codex',
    }),
    false,
  );
});

await test('assertEnvironmentSelectable reports readiness and compatibility errors', () => {
  assert.throws(
    () =>
      mod.assertEnvironmentSelectable({
        environment: {
          id: 'env-stale',
          status: 'stale',
          compatibility: { providerFamilies: ['aio'] },
        },
        providerFamily: 'aio',
      }),
    (err) =>
      err?.name === 'SandboxEnvironmentCompatibilityError' &&
      /not ready: stale/.test(err.message),
  );
  assert.throws(
    () =>
      mod.assertEnvironmentSelectable({
        environment: {
          id: 'env-boxlite',
          status: 'ready',
          compatibility: { providerFamilies: ['boxlite'] },
        },
        providerFamily: 'aio',
      }),
    (err) =>
      err?.name === 'SandboxEnvironmentCompatibilityError' &&
      /not compatible with provider/.test(err.message),
  );
});

await test('normalizes immutable resolved environment metadata', () => {
  const metadata = mod.normalizeResolvedEnvironment({
    environment: {
      id: 'env-1',
      name: '内网基础环境',
      source: aioImage,
      lastValidationId: 'validation-1',
      contractVersion: 'sandbox-contract-v1',
    },
    providerFamily: 'aio',
    runtimeId: 'codex',
    validationVersion: '1',
  });
  assert.deepEqual(metadata, {
    id: 'env-1',
    environmentId: 'env-1',
    name: '内网基础环境',
    providerFamily: 'aio',
    runtimeId: 'codex',
    sourceKind: 'aio-docker-image',
    sourceRef: 'ghcr.io/example/cap-aio-sandbox:v1.2.3',
    digest: 'sha256:aio',
    validationId: 'validation-1',
    validationVersion: '1',
    contractVersion: 'sandbox-contract-v1',
    source: aioImage,
  });
  assert(!('checksum' in metadata));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
