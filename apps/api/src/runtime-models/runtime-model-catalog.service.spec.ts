import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  RuntimeExecutionEnvironmentSnapshot,
  RuntimeModelCatalogQuery,
} from '@cap/contracts';
import { RuntimeModelCatalogCache } from './runtime-model-catalog-cache';
import { RuntimeModelAdapterRegistry } from './runtime-model-catalog.port';
import { RuntimeModelCatalogService } from './runtime-model-catalog.service';
import { RuntimeModelPreflightService } from './runtime-model-preflight.service';
import { OwnerFairProbeScheduler } from './owner-fair-probe-scheduler';
import type {
  EffectiveRuntimeModelPolicy,
  ResolvedRuntimeModelCatalog,
  RuntimeModelAdapterDescriptor,
} from './runtime-model-catalog.types';

const OWNER_A = '00000000-0000-4000-a000-000000000101';
const OWNER_B = '00000000-0000-4000-a000-000000000102';
const ENVIRONMENT_ID = '00000000-0000-4000-a000-000000000201';
const VALIDATION_ID = '00000000-0000-4000-a000-000000000301';

function snapshot(
  kind: 'managed' | 'deployment-default' = 'managed',
  fingerprint = 'sha256:environment-a',
): RuntimeExecutionEnvironmentSnapshot {
  return {
    schemaVersion: 1,
    kind,
    managedEnvironmentId: kind === 'managed' ? ENVIRONMENT_ID : null,
    validationId: kind === 'managed' ? VALIDATION_ID : null,
    validationContractVersion: kind === 'managed' ? 'v2' : null,
    provider: 'aio-local',
    providerFamily: 'aio',
    source: {
      kind: 'aio-docker-image',
      locator: 'sha256:image-a',
      digest: 'sha256:image-a',
      checksum: null,
    },
    immutableIdentity: 'sha256:image-a',
    fingerprint,
    sandboxMetadata: {
      schemaVersion: 1,
      sandboxVersion: '1.2.3',
      dependencies: { codex: '0.144.1' },
    },
    sandboxMetadataChecksum: `sha256:${'a'.repeat(64)}`,
    cliVersion: '0.144.1',
    cliArtifactChecksum: `sha256:${'b'.repeat(64)}`,
    resolvedAt: '2026-07-14T00:00:00.000Z',
  };
}

function policy(revision = 'policy-a'): EffectiveRuntimeModelPolicy {
  return { version: 1, allow: null, deny: [], revision };
}

function defaultAdapter(
  discover: RuntimeModelAdapterDescriptor['discover'],
  overrides: Partial<RuntimeModelAdapterDescriptor> = {},
): RuntimeModelAdapterDescriptor {
  return {
    runtime: 'codex',
    credentialMode: 'official',
    source: 'codex-app-server',
    completeness: 'complete',
    availabilityEvidence: 'account-discovered',
    capacityClass: 'taskless-probe',
    adapterRevision: 'adapter-a',
    discover,
    ...overrides,
  };
}

function buildHarness(options: {
  readonly adapter?: RuntimeModelAdapterDescriptor | null;
  readonly unready?: boolean;
  readonly environmentFingerprint?: () => string;
  readonly credentialRevision?: () => string;
  readonly authJson?: string;
  readonly effectivePolicy?: () => EffectiveRuntimeModelPolicy;
} = {}) {
  let environmentCalls = 0;
  let credentialCalls = 0;
  let policyCalls = 0;
  const selections: string[] = [];
  const environmentResolver = {
    async resolve(input: {
      selection: { kind: string };
    }) {
      environmentCalls += 1;
      selections.push(input.selection.kind);
      const kind =
        input.selection.kind === 'deployment-default'
          ? 'deployment-default'
          : 'managed';
      const resolvedSnapshot = snapshot(
        kind,
        options.environmentFingerprint?.() ?? 'sha256:environment-a',
      );
      return {
        effectiveEnvironment:
          kind === 'managed'
            ? {
                kind: 'managed' as const,
                id: ENVIRONMENT_ID,
                name: 'Managed AIO',
                provider: 'aio-local',
                fingerprint: resolvedSnapshot.fingerprint,
              }
            : {
                kind: 'deployment-default' as const,
                id: null,
                name: 'Deployment AIO',
                provider: 'aio-local',
                fingerprint: resolvedSnapshot.fingerprint,
              },
        snapshot: resolvedSnapshot,
      };
    },
  };
  const credentialResolver = {
    async resolve(ownerUserId: string) {
      credentialCalls += 1;
      if (options.unready) {
        return {
          status: 'unready' as const,
          ownerUserId,
          runtime: 'codex' as const,
          reason: 'missing' as const,
          revision: 'unready-a',
        };
      }
      return {
        status: 'ready' as const,
        credential: {
          runtime: 'codex' as const,
          mode: 'official' as const,
          ownerUserId,
          scope: 'owner' as const,
          revision: options.credentialRevision?.() ?? 'credential-a',
          authJson: options.authJson ?? '{"auth_mode":"chatgpt"}',
          effectiveDefaultModel: null,
        },
      };
    },
  };
  const policyResolver = {
    async resolve() {
      policyCalls += 1;
      return options.effectivePolicy?.() ?? policy();
    },
  };
  const adapters = new RuntimeModelAdapterRegistry(
    options.adapter === null
      ? []
      : [
          options.adapter ??
            defaultAdapter(async () => ({
              defaultModel: 'provider/model:b',
              models: [
                {
                  id: 'provider/model:b',
                  displayName: 'Model B',
                  isDefault: true,
                },
                {
                  id: 'arn:vendor:model/a',
                  displayName: 'Model A',
                  isDefault: false,
                },
              ],
            })),
        ],
  );
  const cache = new RuntimeModelCatalogCache<ResolvedRuntimeModelCatalog>({
    ttlMs: 60_000,
    maxEntries: 32,
    maxInFlight: 8,
    maxInFlightPerOwner: 2,
  });
  const scheduler = new OwnerFairProbeScheduler({
    globalConcurrency: 2,
    perOwnerConcurrency: 1,
    globalQueueLimit: 16,
    perOwnerQueueLimit: 8,
    queueWaitTimeoutMs: 1_000,
  });
  const service = new RuntimeModelCatalogService({
    environmentResolver,
    credentialResolver,
    policyResolver,
    adapters,
    cache,
    scheduler,
    requestTimeoutMs: 1_000,
  });
  return {
    service,
    counters: {
      environment: () => environmentCalls,
      credential: () => credentialCalls,
      policy: () => policyCalls,
    },
    selections,
  };
}

test('catalog preserves omitted, null and UUID environment intent in production flow', async () => {
  const harness = buildHarness();
  const queries: RuntimeModelCatalogQuery[] = [
    { runtime: 'codex' },
    { runtime: 'codex', sandboxEnvironmentId: null },
    { runtime: 'codex', sandboxEnvironmentId: ENVIRONMENT_ID },
  ];
  const results = [];
  for (const query of queries) results.push(await harness.service.query(OWNER_A, query));

  assert.deepEqual(harness.selections, [
    'managed-default',
    'deployment-default',
    'managed',
  ]);
  assert.equal(results[0]?.ok && results[0].value.effectiveEnvironment.kind, 'managed');
  assert.equal(
    results[1]?.ok && results[1].value.effectiveEnvironment.kind,
    'deployment-default',
  );
  assert.equal(
    results[1]?.ok && results[1].value.effectiveEnvironment.id,
    null,
  );
});

test('normalization order and revision are deterministic across adapter order', async () => {
  const models = [
    { id: 'z/model', displayName: 'Z', isDefault: false },
    { id: 'a:model', displayName: 'A', isDefault: true },
  ];
  const first = buildHarness({
    adapter: defaultAdapter(async () => ({ defaultModel: 'a:model', models })),
  });
  const second = buildHarness({
    adapter: defaultAdapter(async () => ({
      defaultModel: 'a:model',
      models: [...models].reverse(),
    })),
  });
  const left = await first.service.query(OWNER_A, { runtime: 'codex' });
  const right = await second.service.query(OWNER_A, { runtime: 'codex' });
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (!left.ok || !right.ok) return;
  assert.deepEqual(left.value.models.map((item) => item.id), ['a:model', 'z/model']);
  assert.equal(left.value.revision, right.value.revision);
});

test('cache coalesces same key and isolates owner and credential revisions', async () => {
  let calls = 0;
  let release!: () => void;
  let credentialRevision = 'credential-a';
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = buildHarness({
    credentialRevision: () => credentialRevision,
    adapter: defaultAdapter(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return {
        defaultModel: null,
        models: [{ id: 'model/a', displayName: 'A', isDefault: false }],
      };
    }),
  });
  const first = harness.service.query(OWNER_A, { runtime: 'codex' });
  const second = harness.service.query(OWNER_A, { runtime: 'codex' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await harness.service.query(OWNER_A, { runtime: 'codex' });
  assert.equal(calls, 1);
  await harness.service.query(OWNER_B, { runtime: 'codex' });
  assert.equal(calls, 2);
  credentialRevision = 'credential-b';
  await harness.service.query(OWNER_A, { runtime: 'codex' });
  assert.equal(calls, 3);
});

test('cache returns defensive catalog clones', async () => {
  const harness = buildHarness();
  const first = await harness.service.query(OWNER_A, { runtime: 'codex' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  (first.value.models as unknown as Array<unknown>).push({ id: 'poisoned' });
  const second = await harness.service.query(OWNER_A, { runtime: 'codex' });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.models.some((item) => item.id === 'poisoned'), false);
});

test('unready credential and missing exact adapter fail closed without discovery', async () => {
  let calls = 0;
  const unready = buildHarness({
    unready: true,
    adapter: defaultAdapter(async () => {
      calls += 1;
      return { defaultModel: null, models: [] };
    }),
  });
  const noAdapter = buildHarness({ adapter: null });
  const unreadyResult = await unready.service.query(OWNER_A, { runtime: 'codex' });
  const noAdapterResult = await noAdapter.service.query(OWNER_A, { runtime: 'codex' });
  assert.equal(unreadyResult.ok, false);
  assert.equal(noAdapterResult.ok, false);
  assert.equal(calls, 0);
});

test('adapter registry rejects authority metadata that could bypass taskless scheduling', () => {
  assert.throws(
    () =>
      new RuntimeModelAdapterRegistry([
        defaultAdapter(async () => ({ defaultModel: null, models: [] }), {
          capacityClass: 'none',
        }),
      ]),
    /authority metadata is invalid/,
  );
});

test('adapter diagnostics, secrets and control labels never reach safe errors', async () => {
  const sentinel = 'sk-secret-at-https://10.0.0.7/private';
  const outage = buildHarness({
    adapter: defaultAdapter(async () => {
      throw new Error(sentinel);
    }),
  });
  const unsafeLabel = buildHarness({
    adapter: defaultAdapter(async () => ({
      defaultModel: null,
      models: [{ id: 'model/a', displayName: `unsafe\u001b[31m`, isDefault: false }],
    })),
  });
  for (const harness of [outage, unsafeLabel]) {
    const result = await harness.service.query(OWNER_A, { runtime: 'codex' });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.equal(JSON.stringify(result).includes('\u001b'), false);
    if (!result.ok) {
      assert.equal(result.error.code, 'runtime_model_catalog_unavailable');
    }
  }
});

test('successful adapter payloads containing credential material fail closed', async () => {
  const token = 'runtime-owner-token-never-public';
  const harness = buildHarness({
    authJson: JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: token },
    }),
    adapter: defaultAdapter(async () => ({
      defaultModel: null,
      models: [
        {
          id: 'model/safe',
          displayName: `Unsafe ${token}`,
          isDefault: false,
        },
      ],
    })),
  });

  const result = await harness.service.query(OWNER_A, { runtime: 'codex' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(token), false);
  if (!result.ok) {
    assert.equal(result.error.code, 'runtime_model_catalog_unavailable');
  }
});

test('preflight omission performs zero resolution and explicit lookup is exact', async () => {
  const harness = buildHarness();
  const preflight = new RuntimeModelPreflightService(harness.service);
  const omitted = await preflight.preflight({
    ownerUserId: OWNER_A,
    query: { runtime: 'codex' },
  });
  assert.deepEqual(omitted, {
    ok: true,
    value: {
      intent: 'runtime-default',
      model: null,
      executionEnvironmentSnapshot: null,
    },
  });
  assert.deepEqual(
    [
      harness.counters.environment(),
      harness.counters.credential(),
      harness.counters.policy(),
    ],
    [0, 0, 0],
  );

  const accepted = await preflight.preflight({
    ownerUserId: OWNER_A,
    query: { runtime: 'codex' },
    model: 'provider/model:b',
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.value.intent, 'explicit');
    assert.equal(
      accepted.value.executionEnvironmentSnapshot?.immutableIdentity,
      'sha256:image-a',
    );
  }
  const rejected = await preflight.preflight({
    ownerUserId: OWNER_A,
    query: { runtime: 'codex' },
    model: 'PROVIDER/MODEL:B',
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'runtime_model_not_available');
});

test('policy filtering removes denied defaults without fabricating another default', async () => {
  const harness = buildHarness({
    effectivePolicy: () => ({
      version: 1,
      allow: null,
      deny: ['provider/model:b'],
      revision: 'policy-deny-b',
    }),
  });
  const result = await harness.service.query(OWNER_A, { runtime: 'codex' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.defaultModel, null);
  assert.deepEqual(result.value.models.map((item) => item.id), ['arn:vendor:model/a']);
  assert.equal(result.value.models[0]?.isDefault, false);
});
