import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const contracts = require(path.join(here, '..', 'dist', 'index.js'));

const {
  RuntimeExecutionEnvironmentSnapshotSchema,
  RuntimeModelCatalogQuerySchema,
  RuntimeModelCatalogSchema,
  RuntimeModelErrorSchema,
  RuntimeModelRejectedTaskFailureSchema,
  RuntimeModelSetupTaskFailureSchema,
  ScheduleLatestRunSchema,
  ScheduleRunResponseSchema,
  TaskFailureSchema,
} = contracts;

const environmentId = '11111111-1111-4111-8111-111111111111';

test('catalog query preserves omitted, null, and UUID environment intent', () => {
  const omitted = RuntimeModelCatalogQuerySchema.parse({ runtime: 'codex' });
  assert.equal(Object.hasOwn(omitted, 'sandboxEnvironmentId'), false);
  assert.equal(
    RuntimeModelCatalogQuerySchema.parse({
      runtime: 'codex',
      sandboxEnvironmentId: null,
    }).sandboxEnvironmentId,
    null,
  );
  assert.equal(
    RuntimeModelCatalogQuerySchema.parse({
      runtime: 'claude-code',
      sandboxEnvironmentId: environmentId,
    }).sandboxEnvironmentId,
    environmentId,
  );
  assert.throws(() =>
    RuntimeModelCatalogQuerySchema.parse({ runtime: 'codex', userId: 'other' }),
  );
});

test('catalog accepts dynamic provider selectors without a static enum', () => {
  const parsed = RuntimeModelCatalogSchema.parse({
    runtime: 'codex',
    effectiveEnvironment: {
      kind: 'managed',
      id: environmentId,
      name: 'AIO pinned',
      provider: 'aio',
      fingerprint: 'sha256:environment-fingerprint',
    },
    cliVersion: '0.144.1',
    source: 'codex-app-server',
    completeness: 'complete',
    revision: 'sha256:catalog-revision',
    defaultModel: 'provider/model:v1',
    models: [
      {
        id: 'provider/model:v1',
        displayName: 'Provider Model v1',
        isDefault: true,
        availabilityEvidence: 'account-discovered',
      },
    ],
  });
  assert.equal(parsed.models[0].id, 'provider/model:v1');
  assert.equal(parsed.effectiveEnvironment.kind, 'managed');
});

test('deployment snapshot enforces managed/null identity without secrets', () => {
  const base = {
    schemaVersion: 1,
    validationId: null,
    validationContractVersion: null,
    provider: 'boxlite',
    providerFamily: 'boxlite',
    source: {
      kind: 'boxlite-image',
      locator: 'ghcr.io/cap/boxlite@sha256:image-digest',
      digest: 'sha256:image-digest',
      checksum: null,
    },
    immutableIdentity: 'sha256:image-digest',
    fingerprint: 'sha256:environment-fingerprint',
    sandboxMetadata: {
      schemaVersion: 1,
      sandboxVersion: '1.2.3',
      dependencies: { 'claude-code': '2.1.207' },
    },
    sandboxMetadataChecksum: `sha256:${'a'.repeat(64)}`,
    cliVersion: '2.1.207',
    cliArtifactChecksum: `sha256:${'b'.repeat(64)}`,
    resolvedAt: '2026-07-14T00:00:00.000Z',
  };
  assert.doesNotThrow(() =>
    RuntimeExecutionEnvironmentSnapshotSchema.parse({
      ...base,
      kind: 'deployment-default',
      managedEnvironmentId: null,
      resources: { diskSizeGb: 9 },
    }),
  );
  assert.throws(() =>
    RuntimeExecutionEnvironmentSnapshotSchema.parse({
      ...base,
      kind: 'deployment-default',
      managedEnvironmentId: null,
      resources: { diskSizeGb: 0 },
    }),
  );
  assert.equal(
    RuntimeExecutionEnvironmentSnapshotSchema.parse({
      ...base,
      kind: 'deployment-default',
      managedEnvironmentId: null,
    }).resources,
    undefined,
  );
  assert.throws(() =>
    RuntimeExecutionEnvironmentSnapshotSchema.parse({
      ...base,
      kind: 'managed',
      managedEnvironmentId: null,
    }),
  );
  assert.throws(() =>
    RuntimeExecutionEnvironmentSnapshotSchema.parse({
      ...base,
      kind: 'deployment-default',
      managedEnvironmentId: null,
      source: {
        kind: 'provider-snapshot',
        locator: 'provider-source',
        digest: null,
        checksum: null,
      },
    }),
  );
  assert.doesNotThrow(() =>
    RuntimeExecutionEnvironmentSnapshotSchema.parse({
      ...base,
      kind: 'deployment-default',
      managedEnvironmentId: null,
      immutableIdentity: 'sha256:rootfs-checksum',
      source: {
        kind: 'boxlite-rootfs',
        locator: '/var/lib/boxlite/rootfs/cap',
        digest: null,
        checksum: 'sha256:rootfs-checksum',
      },
    }),
  );
});

test('transport-neutral model errors expose only stable safe data', () => {
  const parsed = RuntimeModelErrorSchema.parse({
    code: 'runtime_model_catalog_unavailable',
    message: 'Model catalog is temporarily unavailable.',
    retryable: true,
    context: { runtime: 'codex', model: 'provider/model:v1' },
    capacity: { scope: 'owner', retryAfterMs: 500 },
  });
  assert.equal(parsed.retryable, true);
  assert.equal('rawStderr' in parsed, false);
  assert.equal('credential' in parsed, false);
  assert.throws(() =>
    RuntimeModelErrorSchema.parse({
      code: 'runtime_model_not_available',
      message: 'Model is unavailable.',
      retryable: true,
    }),
  );
  assert.throws(() =>
    RuntimeModelErrorSchema.parse({
      code: 'runtime_model_not_available',
      message: 'Model is unavailable.',
      retryable: false,
      capacity: { scope: 'owner', retryAfterMs: 500 },
    }),
  );
});

test('model TaskFailure branches reject invalid code/action combinations', () => {
  const common = {
    runtime: 'codex',
    message: 'safe',
    occurredAt: '2026-07-14T00:00:00.000Z',
    exitCode: null,
  };
  assert.doesNotThrow(() =>
    RuntimeModelSetupTaskFailureSchema.parse({
      ...common,
      code: 'runtime_model_setup_failed',
      action: 'retry_task',
    }),
  );
  assert.doesNotThrow(() =>
    RuntimeModelRejectedTaskFailureSchema.parse({
      ...common,
      code: 'runtime_model_rejected',
      action: 'choose_another_model',
    }),
  );
  assert.throws(() =>
    TaskFailureSchema.parse({
      ...common,
      code: 'runtime_model_rejected',
      action: 'reconnect_runtime',
    }),
  );
});

test('schedule retrying state carries stable catalog retry metadata', () => {
  const common = {
    id: '22222222-2222-4222-8222-222222222222',
    scheduledFor: '2026-07-14T00:00:00.000Z',
    status: 'retrying',
    taskId: null,
    error: 'Model catalog is temporarily unavailable.',
    errorCode: 'runtime_model_catalog_unavailable',
    retryAt: '2026-07-14T00:00:05.000Z',
    retryAttempt: 1,
  };
  assert.doesNotThrow(() => ScheduleLatestRunSchema.parse(common));
  assert.doesNotThrow(() =>
    ScheduleRunResponseSchema.parse({
      ...common,
      scheduleId: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }),
  );
  assert.throws(() =>
    ScheduleLatestRunSchema.parse({ ...common, retryAt: null }),
  );
  assert.throws(() =>
    ScheduleLatestRunSchema.parse({
      ...common,
      taskId: '44444444-4444-4444-8444-444444444444',
    }),
  );
});
