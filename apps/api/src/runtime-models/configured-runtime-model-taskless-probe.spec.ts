import assert from 'node:assert/strict';
import test from 'node:test';
import type Docker from 'dockerode';
import type {
  AioSandboxContainerController,
  BoxLiteClient,
  BoxLiteProviderConfig,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox';
import type { RuntimeExecutionEnvironmentSnapshot } from '@cap/contracts';
import {
  ConfiguredRuntimeModelTasklessProbeLifecycle,
  buildCodexModelProbeCommand,
  parseCodexModelProbeOutput,
} from './configured-runtime-model-taskless-probe';

const OWNER = '00000000-0000-4000-a000-000000000101';

function snapshot(): RuntimeExecutionEnvironmentSnapshot {
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
      locator: 'registry.example.test/cap@sha256:aaaaaaaa',
      digest: 'sha256:aaaaaaaa',
      checksum: null,
    },
    immutableIdentity: 'sha256:aaaaaaaa',
    fingerprint: 'environment-a',
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

function boxLiteSnapshot(): RuntimeExecutionEnvironmentSnapshot {
  return {
    ...snapshot(),
    provider: 'boxlite',
    providerFamily: 'boxlite',
    source: {
      kind: 'boxlite-image',
      locator: 'registry.example.test/cap@sha256:bbbbbbbb',
      digest: 'sha256:bbbbbbbb',
      checksum: null,
    },
    immutableIdentity: 'sha256:bbbbbbbb',
  };
}

const BOXLITE_CONFIG = {
  providerId: 'boxlite',
  endpoint: 'http://boxlite.test',
  apiToken: 'fixture-token',
  defaultImage: '',
  imageByRuntime: {},
  defaultRootfsPath: '',
  rootfsPathByRuntime: {},
  priority: 0,
  location: 'local',
  capabilities: [],
  workspacePath: '/workspace',
  sandboxIdPrefix: 'cap-',
  sandboxEnv: {},
  sandboxMode: 'danger-full-access',
  clientMode: 'rest',
  protocolMode: 'cap-rest',
  pathPrefix: '',
  terminalMode: 'pty',
  timeoutMs: 10_000,
} as const satisfies BoxLiteProviderConfig;

function createInput(
  environment: RuntimeExecutionEnvironmentSnapshot = snapshot(),
) {
  return {
    purpose: 'runtime-model-catalog' as const,
    labels: {
      'cap.resource-purpose': 'runtime-model-catalog',
      'cap.owner-user-id': OWNER,
    },
    ownerUserId: OWNER,
    environment,
    credential: {
      runtime: 'codex' as const,
      mode: 'official' as const,
      ownerUserId: OWNER,
      scope: 'owner' as const,
      revision: 'credential-a',
      authJson: '{"auth":"secret"}',
      effectiveDefaultModel: null,
    },
    deadlineAt: Date.now() + 10_000,
  };
}

function encodedResult(models: unknown): string {
  return (
    'CAP_RUNTIME_MODEL_RESULT:' +
    Buffer.from(JSON.stringify({ models }), 'utf8').toString('base64') +
    '\n'
  );
}

test('probe command uses bounded file material and parser keeps selector, not preset id', () => {
  const auth = '{"tokens":{"access_token":"do-not-echo"}}';
  const command = buildCodexModelProbeCommand(auth, 5_000);
  assert.ok(!command.includes('do-not-echo'));
  assert.match(command, /^set -e;/);
  assert.doesNotMatch(
    command,
    /(?:^|;\s*)set\s+-[^;]*u/u,
    'AIO shell/exec reads $! after the command and is incompatible with nounset',
  );
  assert.match(command, /base64 -d/);
  assert.match(command, /CAP_MODEL_PROBE_TIMEOUT_MS='5000'/);

  const parsed = parseCodexModelProbeOutput(
    encodedResult([
      {
        model: 'actual/selector:1',
        displayName: 'Actual selector',
        isDefault: true,
      },
    ]),
  );
  assert.equal(parsed.defaultModel, 'actual/selector:1');
  assert.equal(parsed.models[0]?.id, 'actual/selector:1');
  assert.throws(() =>
    parseCodexModelProbeOutput(
      encodedResult([
        { model: 'a', displayName: 'A', isDefault: true },
        { model: 'b', displayName: 'B', isDefault: true },
      ]),
    ),
  );
});

test('AIO taskless lifecycle consumes the exact snapshot, labels, and strict teardown', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const aio = {
    async createAndStart(
      taskId: string,
      environment: SandboxResolvedEnvironmentMetadata,
      labels: Readonly<Record<string, string>>,
    ) {
      calls.push({ stage: 'create', taskId, environment, labels });
      return {
        connection: { taskId, baseUrl: `http://${taskId}:8080`, wsUrl: '' },
      };
    },
    async waitForReadiness(args: Record<string, unknown>) {
      calls.push({ stage: 'ready', ...args });
    },
    async runSandboxExec(_baseUrl: string, command: string) {
      calls.push({ stage: 'exec', command });
      return {
        exitCode: 0,
        output: encodedResult([
          {
            model: 'gpt-selector',
            displayName: 'GPT Selector',
            isDefault: false,
          },
        ]),
      };
    },
    async removeSandbox(taskId: string, options?: Record<string, unknown>) {
      calls.push({ stage: 'remove', taskId, options });
    },
  } as unknown as AioSandboxContainerController;
  const docker = {
    async listContainers() {
      return [];
    },
  } as unknown as Docker;
  const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({
    aioController: aio,
    docker,
    boxLiteConfig: () => ({ status: 'disabled', reason: 'test' }),
  });
  const handle = await lifecycle.create({
    purpose: 'runtime-model-catalog',
    labels: {
      'cap.resource-purpose': 'runtime-model-catalog',
      'cap.owner-user-id': OWNER,
    },
    ownerUserId: OWNER,
    environment: snapshot(),
    credential: {
      runtime: 'codex',
      mode: 'official',
      ownerUserId: OWNER,
      scope: 'owner',
      revision: 'credential-a',
      authJson: '{"auth":"secret"}',
      effectiveDefaultModel: null,
    },
    deadlineAt: Date.now() + 10_000,
  });
  const result = await lifecycle.discover(handle, {
    deadlineAt: Date.now() + 10_000,
  });
  await lifecycle.destroy(handle);

  const create = calls.find((call) => call.stage === 'create');
  const environment = create?.environment as SandboxResolvedEnvironmentMetadata;
  const labels = create?.labels as Record<string, string>;
  assert.equal(environment.sourceRef, snapshot().source.locator);
  assert.equal(environment.digest, snapshot().source.digest);
  assert.equal(labels['cap.resource-purpose'], 'runtime-model-catalog');
  assert.equal(labels['cap.owner-user-id'], OWNER);
  assert.equal(result.models[0]?.id, 'gpt-selector');
  const remove = calls.find((call) => call.stage === 'remove');
  assert.deepEqual(remove?.options, { bestEffort: false });
});

test('orphan reconciliation removes only old purpose-labeled AIO resources', async () => {
  const removed: string[] = [];
  const filters: unknown[] = [];
  const docker = {
    async listContainers(options: unknown) {
      filters.push(options);
      return [
        { Id: 'old', Created: 100 },
        { Id: 'new', Created: 300 },
      ];
    },
    getContainer(id: string) {
      return {
        async remove() {
          removed.push(id);
        },
      };
    },
  } as unknown as Docker;
  const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({
    docker,
    aioController: {} as AioSandboxContainerController,
    boxLiteConfig: () => ({ status: 'disabled', reason: 'test' }),
  });
  const count = await lifecycle.reconcileOrphans({
    purpose: 'runtime-model-catalog',
    olderThan: new Date(200_000),
  });
  assert.equal(count, 1);
  assert.deepEqual(removed, ['old']);
  assert.deepEqual(filters, [
    {
      all: true,
      filters: { label: ['cap.resource-purpose=runtime-model-catalog'] },
    },
  ]);
});

test('destroy retries provider cleanup and removes state only after success', async () => {
  let removeCalls = 0;
  const aio = {
    async createAndStart(taskId: string) {
      return {
        connection: { taskId, baseUrl: 'http://probe.test', wsUrl: '' },
      };
    },
    async waitForReadiness() {},
    async removeSandbox() {
      removeCalls += 1;
      if (removeCalls < 3) throw new Error('fixture cleanup failure');
    },
  } as unknown as AioSandboxContainerController;
  const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({
    aioController: aio,
    docker: { listContainers: async () => [] } as unknown as Docker,
    boxLiteConfig: () => ({ status: 'disabled', reason: 'test' }),
    cleanupAttempts: 3,
  });
  const handle = await lifecycle.create(createInput());

  await lifecycle.destroy(handle);
  assert.equal(removeCalls, 3);
  await lifecycle.destroy(handle);
  assert.equal(removeCalls, 3, 'successful cleanup removes the tracked state');
});

test('cleanup exhaustion retains the handle so a later destroy can retry', async () => {
  let removeCalls = 0;
  let failing = true;
  const aio = {
    async createAndStart(taskId: string) {
      return {
        connection: { taskId, baseUrl: 'http://probe.test', wsUrl: '' },
      };
    },
    async waitForReadiness() {},
    async removeSandbox() {
      removeCalls += 1;
      if (failing) throw new Error('fixture cleanup failure');
    },
  } as unknown as AioSandboxContainerController;
  const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({
    aioController: aio,
    docker: { listContainers: async () => [] } as unknown as Docker,
    boxLiteConfig: () => ({ status: 'disabled', reason: 'test' }),
    cleanupAttempts: 2,
  });
  const handle = await lifecycle.create(createInput());

  await assert.rejects(lifecycle.destroy(handle), /provider cleanup failed/);
  assert.equal(removeCalls, 2);
  failing = false;
  await lifecycle.destroy(handle);
  assert.equal(removeCalls, 3, 'the retained state is retried on the next call');
});

test('a readiness failure uses the same bounded cleanup path', async () => {
  let removeCalls = 0;
  const aio = {
    async createAndStart(taskId: string) {
      return {
        connection: { taskId, baseUrl: 'http://probe.test', wsUrl: '' },
      };
    },
    async waitForReadiness() {
      throw new Error('fixture readiness failure');
    },
    async removeSandbox() {
      removeCalls += 1;
      if (removeCalls < 3) throw new Error('fixture cleanup failure');
    },
  } as unknown as AioSandboxContainerController;
  const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({
    aioController: aio,
    docker: { listContainers: async () => [] } as unknown as Docker,
    boxLiteConfig: () => ({ status: 'disabled', reason: 'test' }),
    cleanupAttempts: 3,
  });

  await assert.rejects(lifecycle.create(createInput()), /readiness failure/);
  assert.equal(removeCalls, 3);
});

test('BoxLite taskless lifecycle tracks and deletes the provider-returned id', async () => {
  const createCalls: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const client = {
    async createSandbox(request: Record<string, unknown>) {
      createCalls.push(request);
      return { id: 'provider-generated-id', metadata: request.metadata };
    },
    async exec() {
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      };
    },
    async deleteSandbox(id: string) {
      deleted.push(id);
    },
  } as unknown as BoxLiteClient;
  const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({
    aioController: {} as AioSandboxContainerController,
    docker: { listContainers: async () => [] } as unknown as Docker,
    boxLiteConfig: () => ({ status: 'valid', config: BOXLITE_CONFIG }),
    boxLiteClientFactory: () => client,
  });

  const handle = await lifecycle.create(createInput(boxLiteSnapshot()));
  await lifecycle.destroy(handle);

  assert.equal(createCalls.length, 1);
  assert.match(String(createCalls[0]?.taskId), /^cap-model-probe-/);
  assert.equal(
    (createCalls[0]?.metadata as Record<string, unknown>)[
      'cap.resource-purpose'
    ],
    'runtime-model-catalog',
  );
  assert.deepEqual(deleted, ['provider-generated-id']);
});

test('orphan reconciliation isolates failures and recognizes BoxLite metadata/task ids', async () => {
  const aioRemoved: string[] = [];
  const boxRemoved: string[] = [];
  const docker = {
    async listContainers() {
      return [
        { Id: 'aio-fails', Created: 100 },
        { Id: 'aio-succeeds', Created: 100 },
      ];
    },
    getContainer(id: string) {
      return {
        async remove() {
          if (id === 'aio-fails') throw new Error('fixture remove failure');
          aioRemoved.push(id);
        },
      };
    },
  } as unknown as Docker;
  const client = {
    async listSandboxes() {
      return [
        {
          id: 'provider-generated-id',
          metadata: {
            'cap.resource-purpose': 'runtime-model-catalog',
            'cap.created-at': '1970-01-01T00:01:40.000Z',
          },
        },
        {
          id: 'unrelated-id',
          taskId: 'cap-model-probe-100000-task-identity',
        },
        {
          id: 'unrelated',
          metadata: {
            'cap.resource-purpose': 'another-purpose',
            'cap.created-at': '1970-01-01T00:01:40.000Z',
          },
        },
      ];
    },
    async deleteSandbox(id: string) {
      boxRemoved.push(id);
    },
  } as unknown as BoxLiteClient;
  const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({
    aioController: {} as AioSandboxContainerController,
    docker,
    boxLiteConfig: () => ({ status: 'valid', config: BOXLITE_CONFIG }),
    boxLiteClientFactory: () => client,
  });

  const count = await lifecycle.reconcileOrphans({
    purpose: 'runtime-model-catalog',
    olderThan: new Date(200_000),
  });
  assert.equal(count, 3);
  assert.deepEqual(aioRemoved, ['aio-succeeds']);
  assert.deepEqual(boxRemoved, ['provider-generated-id', 'unrelated-id']);
});

test('bootstrap starts periodic orphan sweeps and shutdown clears live probes', async () => {
  let now = 1_000;
  const containers = new Set(['old-after-grace']);
  const removed: string[] = [];
  const aio = {
    async createAndStart(taskId: string) {
      return {
        connection: { taskId, baseUrl: 'http://probe.test', wsUrl: '' },
      };
    },
    async waitForReadiness() {},
    async removeSandbox(taskId: string) {
      removed.push(`live:${taskId}`);
    },
  } as unknown as AioSandboxContainerController;
  const docker = {
    async listContainers() {
      return [...containers].map((Id) => ({ Id, Created: 1 }));
    },
    getContainer(id: string) {
      return {
        async remove() {
          removed.push(`orphan:${id}`);
          containers.delete(id);
        },
      };
    },
  } as unknown as Docker;
  const lifecycle = new ConfiguredRuntimeModelTasklessProbeLifecycle({
    aioController: aio,
    docker,
    boxLiteConfig: () => ({ status: 'disabled', reason: 'test' }),
    now: () => now,
    orphanAgeMs: 500,
    orphanSweepIntervalMs: 5,
  });
  await lifecycle.onApplicationBootstrap();
  assert.equal(removed.length, 0, 'initial grace period preserves the resource');
  await lifecycle.create(createInput());

  now = 2_000;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(removed.includes('orphan:old-after-grace'));
  await lifecycle.onApplicationShutdown();
  assert.ok(removed.some((value) => value.startsWith('live:model-probe-')));
});
