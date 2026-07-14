import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import type { RuntimeExecutionEnvironmentSnapshot } from '@cap/contracts';
import type { ModelDiscoveryClient } from '../settings/model-discovery.client';
import { CodexCompatibleModelAdapter } from './codex-compatible-model.adapter';
import { CodexOfficialModelAdapter } from './codex-official-model.adapter';
import { ClaudeSubscriptionModelAdapter } from './claude-subscription-model.adapter';
import {
  CHECKED_CLAUDE_MODEL_CAPABILITY_MANIFEST,
  ClaudeModelCapabilityManifestSchema,
} from './claude-model-capability-manifest';
import type {
  RuntimeModelAdapterDescriptor,
  ReadyRuntimeModelCredential,
} from './runtime-model-catalog.types';
import type { RuntimeModelTasklessProbeLifecycle } from './runtime-model-probe.port';

const OWNER = '00000000-0000-4000-a000-000000000101';
const CHECKSUM = `sha256:${'b'.repeat(64)}`;

function snapshot(
  runtime: 'codex' | 'claude-code',
  overrides: Partial<RuntimeExecutionEnvironmentSnapshot> = {},
): RuntimeExecutionEnvironmentSnapshot {
  const version = runtime === 'codex' ? '0.144.1' : '2.1.207';
  return {
    schemaVersion: 1,
    kind: 'deployment-default',
    managedEnvironmentId: null,
    validationId: null,
    validationContractVersion: null,
    provider: 'aio-local',
    providerFamily: 'aio',
    source: {
      kind: 'aio-docker-image',
      locator: 'sha256:image-a',
      digest: 'sha256:image-a',
      checksum: null,
    },
    immutableIdentity: 'sha256:image-a',
    fingerprint: 'environment-a',
    sandboxMetadata: {
      schemaVersion: 1,
      sandboxVersion: '1.2.3',
      dependencies: { [runtime]: version },
    },
    sandboxMetadataChecksum: `sha256:${'a'.repeat(64)}`,
    cliVersion: version,
    cliArtifactChecksum: CHECKSUM,
    resolvedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function input(
  credential: ReadyRuntimeModelCredential,
  environment: RuntimeExecutionEnvironmentSnapshot,
): Parameters<RuntimeModelAdapterDescriptor['discover']>[0] {
  return {
    ownerUserId: OWNER,
    credential,
    environment,
    policy: { version: 1, allow: null, deny: [], revision: 'policy-a' },
    deadlineAt: Date.now() + 10_000,
  };
}

test('official Codex adapter uses the taskless lifecycle and protocol model selectors', async () => {
  const calls: string[] = [];
  const lifecycle: RuntimeModelTasklessProbeLifecycle = {
    async create(args) {
      calls.push(`create:${args.ownerUserId}:${args.environment.immutableIdentity}`);
      return { id: 'probe-a' };
    },
    async discover(handle) {
      calls.push(`discover:${handle.id}`);
      return {
        defaultModel: 'gpt-selector',
        models: [
          {
            id: 'gpt-selector',
            displayName: 'GPT Selector',
            isDefault: true,
          },
        ],
      };
    },
    async cancel(handle) {
      calls.push(`cancel:${handle.id}`);
    },
    async destroy(handle) {
      calls.push(`destroy:${handle.id}`);
    },
    async reconcileOrphans() {
      return 0;
    },
  };
  const adapter = new CodexOfficialModelAdapter(lifecycle);
  const result = await adapter.discover(
    input(
      {
        runtime: 'codex',
        mode: 'official',
        ownerUserId: OWNER,
        scope: 'owner',
        revision: 'credential-a',
        authJson: '{"tokens":{"access_token":"secret"}}',
        effectiveDefaultModel: null,
      },
      snapshot('codex'),
    ),
  );
  assert.equal(result.models[0]?.id, 'gpt-selector');
  assert.deepEqual(calls, [
    'create:00000000-0000-4000-a000-000000000101:sha256:image-a',
    'discover:probe-a',
    'destroy:probe-a',
  ]);
});

test('compatible Codex adapter reuses bounded owner credential discovery', async () => {
  const calls: unknown[][] = [];
  const client = {
    async discover(...args: unknown[]) {
      calls.push(args);
      return { ok: true as const, models: ['provider/model-a', 'provider:model-b'] };
    },
  } as unknown as ModelDiscoveryClient;
  const adapter = new CodexCompatibleModelAdapter(client);
  const result = await adapter.discover(
    input(
      {
        runtime: 'codex',
        mode: 'compatible',
        ownerUserId: OWNER,
        scope: 'owner',
        revision: 'credential-b',
        baseUrl: 'https://provider.example.test/v1',
        apiKey: 'secret-provider-key',
        effectiveDefaultModel: 'provider/model-a',
      },
      snapshot('codex'),
    ),
  );
  assert.deepEqual(
    result.models.map((model) => model.id),
    ['provider/model-a', 'provider:model-b'],
  );
  assert.equal(result.defaultModel, 'provider/model-a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], 'https://provider.example.test/v1');
  assert.equal(calls[0]?.[1], 'secret-provider-key');
});

test('Codex adapters reject cross-owner credentials before any provider or taskless probe call', async () => {
  let probeCalls = 0;
  const lifecycle: RuntimeModelTasklessProbeLifecycle = {
    async create() {
      probeCalls += 1;
      return { id: 'must-not-exist' };
    },
    async discover() {
      probeCalls += 1;
      return { defaultModel: null, models: [] };
    },
    async cancel() {
      probeCalls += 1;
    },
    async destroy() {
      probeCalls += 1;
    },
    async reconcileOrphans() {
      return 0;
    },
  };
  let compatibleCalls = 0;
  const client = {
    async discover() {
      compatibleCalls += 1;
      return { ok: true as const, models: [] };
    },
  } as unknown as ModelDiscoveryClient;
  const anotherOwner = '00000000-0000-4000-a000-000000000999';

  await assert.rejects(
    new CodexOfficialModelAdapter(lifecycle).discover(
      input(
        {
          runtime: 'codex',
          mode: 'official',
          ownerUserId: anotherOwner,
          scope: 'owner',
          revision: 'credential-cross-owner',
          authJson: '{"tokens":{"access_token":"secret"}}',
          effectiveDefaultModel: null,
        },
        snapshot('codex'),
      ),
    ),
    /credential is unavailable/,
  );
  await assert.rejects(
    new CodexCompatibleModelAdapter(client).discover(
      input(
        {
          runtime: 'codex',
          mode: 'compatible',
          ownerUserId: anotherOwner,
          scope: 'owner',
          revision: 'credential-cross-owner',
          baseUrl: 'https://provider.example.test/v1',
          apiKey: 'secret-provider-key',
          effectiveDefaultModel: 'provider/default',
        },
        snapshot('codex'),
      ),
    ),
    /credential is unavailable/,
  );

  assert.equal(probeCalls, 0);
  assert.equal(compatibleCalls, 0);
});

test('Claude adapter is checksum-bound and an empty evidence manifest fails closed', async () => {
  const credential = {
    runtime: 'claude-code' as const,
    mode: 'subscription' as const,
    ownerUserId: OWNER,
    scope: 'owner' as const,
    revision: 'credential-c',
    oauthToken: 'secret-oauth',
    effectiveDefaultModel: null,
  };
  await assert.rejects(
    new ClaudeSubscriptionModelAdapter().discover(
      input(credential, snapshot('claude-code')),
    ),
    /evidence is unavailable/,
  );

  const manifest = ClaudeModelCapabilityManifestSchema.parse({
    schemaVersion: 1,
    cliPins: ['2.1.207'],
    artifacts: [
      {
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
        evidenceChecksum: `sha256:${'d'.repeat(64)}`,
        verifiedAt: '2026-07-14T00:00:00.000Z',
        verificationRef: 'gated-run:reference-subscription:123',
        gatedReferenceSubscription: true,
        selectors: [
          {
            id: 'vendor/selector:verified',
            displayName: 'Verified selector',
            provenance: 'https://docs.example.test/selector-argument',
            providerSeams: ['aio', 'boxlite'],
          },
        ],
      },
    ],
  });
  const result = await new ClaudeSubscriptionModelAdapter(manifest).discover(
    input(credential, snapshot('claude-code')),
  );
  assert.equal(result.models[0]?.id, 'vendor/selector:verified');
  await assert.rejects(
    new ClaudeSubscriptionModelAdapter(manifest).discover(
      input(
        credential,
        snapshot('claude-code', {
          cliArtifactChecksum: `sha256:${'c'.repeat(64)}`,
        }),
      ),
    ),
  );
});

test('Claude adapter exposes only selectors verified for the effective provider seam', async () => {
  const credential = {
    runtime: 'claude-code' as const,
    mode: 'subscription' as const,
    ownerUserId: OWNER,
    scope: 'owner' as const,
    revision: 'credential-provider-seam',
    oauthToken: 'secret-oauth',
    effectiveDefaultModel: null,
  };
  const manifest = ClaudeModelCapabilityManifestSchema.parse({
    schemaVersion: 1,
    cliPins: ['2.1.207'],
    artifacts: [
      {
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
        evidenceChecksum: `sha256:${'e'.repeat(64)}`,
        verifiedAt: '2026-07-14T00:00:00.000Z',
        verificationRef: 'gated-run:reference-subscription:provider-seams',
        gatedReferenceSubscription: true,
        selectors: [
          {
            id: 'vendor/aio-only',
            displayName: 'AIO only',
            provenance: 'https://docs.example.test/gated-launch/aio',
            providerSeams: ['aio'],
          },
          {
            id: 'vendor/boxlite-only',
            displayName: 'BoxLite only',
            provenance: 'https://docs.example.test/gated-launch/boxlite',
            providerSeams: ['boxlite'],
          },
          {
            id: 'vendor/shared',
            displayName: 'Shared',
            provenance:
              'https://docs.example.test/gated-launch/aio-and-boxlite',
            providerSeams: ['aio', 'boxlite'],
          },
        ],
      },
    ],
  });
  const adapter = new ClaudeSubscriptionModelAdapter(manifest);

  const aio = await adapter.discover(
    input(credential, snapshot('claude-code')),
  );
  assert.deepEqual(
    aio.models.map((model) => model.id),
    ['vendor/aio-only', 'vendor/shared'],
  );

  const boxlite = await adapter.discover(
    input(
      credential,
      snapshot('claude-code', {
        provider: 'boxlite',
        providerFamily: 'boxlite',
        source: {
          kind: 'boxlite-image',
          locator: 'fixture/boxlite@sha256:image-b',
          digest: 'sha256:image-b',
          checksum: null,
        },
        immutableIdentity: 'sha256:image-b',
      }),
    ),
  );
  assert.deepEqual(
    boxlite.models.map((model) => model.id),
    ['vendor/boxlite-only', 'vendor/shared'],
  );

  await assert.rejects(
    adapter.discover(
      input(
        credential,
        snapshot('claude-code', {
          provider: 'cloud-http',
          providerFamily: 'cloud-http',
          source: {
            kind: 'provider-snapshot',
            locator: 'fixture/cloud-http',
            digest: 'sha256:image-c',
            checksum: null,
          },
          immutableIdentity: 'sha256:image-c',
        }),
      ),
    ),
    /evidence is unavailable/,
  );

  const aioOnlyManifest = ClaudeModelCapabilityManifestSchema.parse({
    ...manifest,
    artifacts: [
      {
        ...manifest.artifacts[0],
        selectors: [manifest.artifacts[0]!.selectors[0]],
      },
    ],
  });
  await assert.rejects(
    new ClaudeSubscriptionModelAdapter(aioOnlyManifest).discover(
      input(
        credential,
        snapshot('claude-code', {
          provider: 'boxlite',
          providerFamily: 'boxlite',
        }),
      ),
    ),
    /evidence is unavailable/,
  );
});

test('checked Claude manifest pin cannot drift from either packaged image', async () => {
  const repoRoot = resolve(__dirname, '../../../..');
  const dockerfiles = await Promise.all([
    readFile(resolve(repoRoot, 'docker/aio-sandbox.Dockerfile'), 'utf8'),
    readFile(resolve(repoRoot, 'docker/boxlite-sandbox.Dockerfile'), 'utf8'),
  ]);
  const pins = dockerfiles.map((source) =>
    source.match(/ARG CLAUDE_CODE_VERSION=([^\s]+)/)?.[1],
  );
  assert.deepEqual(pins, ['2.1.207', '2.1.207']);
  assert.deepEqual(CHECKED_CLAUDE_MODEL_CAPABILITY_MANIFEST.cliPins, [
    '2.1.207',
  ]);
});
