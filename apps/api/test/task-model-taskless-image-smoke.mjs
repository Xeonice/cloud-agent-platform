import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { BoxLiteRestClient } from '@cap/sandbox';
import { CodexOfficialModelAdapter } from '../dist/runtime-models/codex-official-model.adapter.js';
import { ConfiguredRuntimeModelTasklessProbeLifecycle } from '../dist/runtime-models/configured-runtime-model-taskless-probe.js';
import { buildRuntimeExecutionEnvironmentSnapshot } from '../dist/runtime-models/runtime-model-snapshot.js';

/**
 * Gated packaged-image seam. The caller supplies metadata/checksums read from
 * the image it just built, plus either AIO_SANDBOX_IMAGE or a BoxLite REST
 * endpoint + immutable OCI rootfs. The test deliberately uses an empty Codex
 * auth file: model/list is structural/package evidence, while owner entitlement
 * and transcript evidence remain in the separate real-credential E2E gate.
 */

const PURPOSE_LABEL = 'cap.resource-purpose=runtime-model-catalog';
const OWNER_LABEL = 'cap.owner-user-id=';
const BOXLITE_PROBE_PREFIX = 'cap-model-probe-';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseMetadata() {
  const value = JSON.parse(required('TASK_MODEL_SMOKE_METADATA_JSON'));
  assert.equal(value.schemaVersion, 1);
  assert.equal(typeof value.sandboxVersion, 'string');
  assert.equal(value.dependencies?.codex, '0.144.1');
  return value;
}

const provider = required('TASK_MODEL_SMOKE_PROVIDER');
assert.ok(provider === 'aio' || provider === 'boxlite');
const cliArtifactChecksum = `sha256:${required('TASK_MODEL_SMOKE_CODEX_CHECKSUM')}`;
assert.match(cliArtifactChecksum, /^sha256:[0-9a-f]{64}$/);
const metadata = parseMetadata();
const ownerUserId = `task-model-image-smoke-${provider}`;
const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: 30_000 });

let source;
let immutableIdentity;
if (provider === 'aio') {
  const image = required('AIO_SANDBOX_IMAGE');
  const inspected = await docker.getImage(image).inspect();
  assert.match(inspected.Id, /^sha256:[0-9a-f]{64}$/);
  source = {
    kind: 'aio-docker-image',
    locator: inspected.Id,
    digest: inspected.Id,
    checksum: null,
  };
  immutableIdentity = inspected.Id;
} else {
  const rootfsPath = required('BOXLITE_ROOTFS_PATH');
  const rootfsChecksum = `sha256:${required('TASK_MODEL_SMOKE_ROOTFS_CHECKSUM')}`;
  assert.match(rootfsChecksum, /^sha256:[0-9a-f]{64}$/);
  source = {
    kind: 'boxlite-rootfs',
    locator: rootfsPath,
    digest: null,
    checksum: rootfsChecksum,
  };
  immutableIdentity = rootfsChecksum;
}

const environment = buildRuntimeExecutionEnvironmentSnapshot({
  schemaVersion: 1,
  kind: 'deployment-default',
  managedEnvironmentId: null,
  validationId: null,
  validationContractVersion: null,
  provider: provider === 'aio' ? 'aio-local' : 'boxlite',
  providerFamily: provider,
  source,
  immutableIdentity,
  sandboxMetadata: metadata,
  cliVersion: metadata.dependencies.codex,
  cliArtifactChecksum,
  resolvedAt: new Date().toISOString(),
});
const credential = {
  runtime: 'codex',
  mode: 'official',
  ownerUserId,
  scope: 'owner',
  revision: `image-smoke-${provider}`,
  authJson: '{}',
  effectiveDefaultModel: null,
};

const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({ docker });
const adapter = new CodexOfficialModelAdapter(lifecycle);
let result;
try {
  result = await adapter.discover({
    ownerUserId,
    runtime: 'codex',
    environment,
    credential,
    policyRevision: 'image-smoke',
    deadlineAt: Date.now() + 120_000,
  });
} finally {
  await lifecycle.onApplicationShutdown();
}

assert.ok(result.models.length > 0, 'the packaged Codex App Server must return models');
assert.ok(
  result.defaultModel === null ||
    result.models.some((model) => model.id === result.defaultModel && model.isDefault),
  'a reported default must be one of the discovered model selectors',
);

if (provider === 'aio') {
  const leftovers = await docker.listContainers({
    all: true,
    filters: {
      label: [PURPOSE_LABEL, `${OWNER_LABEL}${ownerUserId}`],
    },
  });
  assert.equal(leftovers.length, 0, 'the AIO taskless probe must be destroyed before return');
} else {
  const client = new BoxLiteRestClient({
    baseUrl: required('BOXLITE_ENDPOINT'),
    apiToken: required('BOXLITE_API_TOKEN'),
    timeoutMs: 30_000,
    protocolMode: 'native',
    pathPrefix: process.env.BOXLITE_PATH_PREFIX ?? 'default',
  });
  const leftovers = (await client.listSandboxes()).filter(
    (sandbox) =>
      sandbox.id.startsWith(BOXLITE_PROBE_PREFIX) ||
      sandbox.taskId?.startsWith(BOXLITE_PROBE_PREFIX),
  );
  assert.equal(
    leftovers.length,
    0,
    'the BoxLite taskless probe must be destroyed before return',
  );
}

process.stdout.write(
  `${JSON.stringify({
    provider,
    modelCount: result.models.length,
    defaultCount: result.models.filter((model) => model.isDefault).length,
    cleanup: 'verified',
  })}\n`,
);
