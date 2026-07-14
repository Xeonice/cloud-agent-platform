import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  RuntimeModelTasklessProbeHandle,
  RuntimeModelTasklessProbeLifecycle,
} from './runtime-model-probe.port';
import {
  RuntimeModelProbeCleanupError,
  RuntimeModelTasklessProbeAbortedError,
  runTasklessRuntimeModelProbe,
} from './runtime-model-probe.port';
import type { RuntimeExecutionEnvironmentSnapshot } from '@cap/contracts';

const HANDLE: RuntimeModelTasklessProbeHandle = { id: 'probe-1' };
const ENVIRONMENT = {
  schemaVersion: 1,
  kind: 'deployment-default',
  managedEnvironmentId: null,
  validationId: null,
  validationContractVersion: null,
  provider: 'aio-local',
  providerFamily: 'aio',
  source: {
    kind: 'aio-docker-image',
    locator: 'sha256:image',
    digest: 'sha256:image',
    checksum: null,
  },
  immutableIdentity: 'sha256:image',
  fingerprint: 'sha256:environment',
  sandboxMetadata: {
    schemaVersion: 1,
    sandboxVersion: '1.2.3',
    dependencies: { codex: '0.144.1' },
  },
  sandboxMetadataChecksum: `sha256:${'a'.repeat(64)}`,
  cliVersion: '0.144.1',
  cliArtifactChecksum: `sha256:${'b'.repeat(64)}`,
  resolvedAt: '2026-07-14T00:00:00.000Z',
} as RuntimeExecutionEnvironmentSnapshot;

function input(lifecycle: RuntimeModelTasklessProbeLifecycle) {
  return {
    lifecycle,
    ownerUserId: '00000000-0000-4000-a000-000000000101',
    environment: ENVIRONMENT,
    credential: {
      runtime: 'codex' as const,
      mode: 'official' as const,
      ownerUserId: '00000000-0000-4000-a000-000000000101',
      scope: 'owner' as const,
      revision: 'credential-a',
      authJson: '{"auth_mode":"chatgpt"}',
      effectiveDefaultModel: null,
    },
    deadlineAt: Date.now() + 1_000,
  };
}

test('successful taskless discovery is destroyed before returning', async () => {
  const events: string[] = [];
  const lifecycle: RuntimeModelTasklessProbeLifecycle = {
    create: async (args) => {
      assert.equal(args.purpose, 'runtime-model-catalog');
      assert.equal(
        args.labels['cap.resource-purpose'],
        'runtime-model-catalog',
      );
      events.push('create');
      return HANDLE;
    },
    discover: async () => {
      events.push('discover');
      return { defaultModel: null, models: [] };
    },
    cancel: async () => {
      events.push('cancel');
    },
    destroy: async () => {
      events.push('destroy');
    },
    reconcileOrphans: async () => 0,
  };

  assert.deepEqual(await runTasklessRuntimeModelProbe(input(lifecycle)), {
    defaultModel: null,
    models: [],
  });
  assert.deepEqual(events, ['create', 'discover', 'destroy']);
});

test('running abort triggers cancel, waits for it and then destroys', async () => {
  const events: string[] = [];
  const controller = new AbortController();
  let rejectDiscover!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const lifecycle: RuntimeModelTasklessProbeLifecycle = {
    create: async () => HANDLE,
    discover: () =>
      new Promise((_resolve, reject) => {
        rejectDiscover = reject;
        markStarted();
      }),
    cancel: async () => {
      events.push('cancel');
      rejectDiscover(new RuntimeModelTasklessProbeAbortedError());
    },
    destroy: async () => {
      events.push('destroy');
    },
    reconcileOrphans: async () => 0,
  };

  const running = runTasklessRuntimeModelProbe({
    ...input(lifecycle),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(running, RuntimeModelTasklessProbeAbortedError);
  assert.deepEqual(events, ['cancel', 'destroy']);
});

test('cleanup failures are observable and fail the probe closed', async () => {
  const observed: string[] = [];
  const lifecycle: RuntimeModelTasklessProbeLifecycle = {
    create: async () => HANDLE,
    discover: async () => ({ defaultModel: null, models: [] }),
    cancel: async () => undefined,
    destroy: async () => {
      throw new Error('provider-private-cleanup-detail');
    },
    reconcileOrphans: async () => 0,
  };

  await assert.rejects(
    runTasklessRuntimeModelProbe({
      ...input(lifecycle),
      onCleanupError: (stage) => observed.push(stage),
    }),
    (error: unknown) =>
      error instanceof RuntimeModelProbeCleanupError &&
      !error.message.includes('provider-private-cleanup-detail'),
  );
  assert.deepEqual(observed, ['destroy']);
});
