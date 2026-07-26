import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

function validConfig(overrides = {}) {
  const result = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'registry.example.test/cap-boxlite:v1',
    BOXLITE_PROVIDER_ID: 'boxlite-branch-test',
    BOXLITE_CAPABILITIES: 'command.exec',
    ...overrides,
  });
  assert.equal(result.status, 'valid', result.errors?.join('\n'));
  return result.config;
}

function workspacePlan() {
  return {
    repositoryUrl: 'https://code.example.test/acme/repo.git',
    callerBranch: null,
    resolvedBranch: 'main',
    deadlineMs: 5_000,
  };
}

function ownership(resourceGeneration = 'resource:branch') {
  return {
    ownerGeneration: 'owner:branch',
    resourceGeneration,
  };
}

function cleanupAuthorization(taskId, fence) {
  return {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-branch-test',
    ownership: fence,
  };
}

async function* chunks(...parts) {
  for (const part of parts) yield new Uint8Array(part);
}

await test('legacy environment ids populate metadata and custom preflight snapshots the environment', async () => {
  const client = new mod.FakeBoxLiteClient();
  const environment = {
    id: 'legacy-environment-id',
    name: 'Legacy environment',
    sourceKind: 'boxlite-image',
    sourceRef: 'registry.example.test/cap-boxlite:legacy',
  };
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    resolveEnvironment: async () => environment,
    preflight: async () => ({
      status: 'passed',
      checkedAt: '2026-07-25T00:00:00.000Z',
    }),
  });

  await provider.provision({
    taskId: 'legacy-environment-metadata',
    cloneSpec: null,
  });

  assert.equal(
    client.createCalls[0].metadata.sandboxEnvironmentId,
    'legacy-environment-id',
  );
  const selected = await provider.getSelectedSandboxRun(
    'legacy-environment-metadata',
  );
  assert.equal(selected.environment.id, 'legacy-environment-id');
  assert.equal(selected.preflight.environment.id, 'legacy-environment-id');
});

await test('an explicit null environment keeps the configured source', async () => {
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });

  await provider.provision({
    taskId: 'explicit-null-environment',
    cloneSpec: null,
    environment: null,
  });

  assert.equal(
    client.createCalls[0].image,
    'registry.example.test/cap-boxlite:v1',
  );
  assert.equal(
    client.createCalls[0].metadata.sandboxEnvironmentId,
    undefined,
  );
});

await test('incompatible legacy environments report id and unknown fallbacks', async () => {
  const identifiedProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: new mod.FakeBoxLiteClient(),
  });
  await assert.rejects(
    identifiedProvider.provision({
      taskId: 'identified-incompatible-environment',
      cloneSpec: null,
      environment: {
        id: 'legacy-incompatible',
        sourceKind: 'aio-docker-image',
      },
    }),
    /environment legacy-incompatible source aio-docker-image is not compatible/,
  );

  const unknownProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: new mod.FakeBoxLiteClient(),
  });
  await assert.rejects(
    unknownProvider.provision({
      taskId: 'unknown-incompatible-environment',
      cloneSpec: null,
      environment: {},
    }),
    /environment unknown source unknown is not compatible/,
  );
});

await test('an unresolved retained transcript runtime is passed through as null', async () => {
  const observedRuntimeIds = [];
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_CAPABILITIES: 'command.exec,transcript.retained-read',
    }),
    client: new mod.FakeBoxLiteClient(),
    resolveRuntimeId: async () => undefined,
    transcriptRead: async ({ runtimeId }) => {
      observedRuntimeIds.push(runtimeId);
      return { format: 'codex-rollout', jsonl: '' };
    },
  });

  await provider.provision({
    taskId: 'unresolved-transcript-runtime',
    cloneSpec: null,
  });
  await provider.readRolloutFromContainer('unresolved-transcript-runtime');

  assert.deepEqual(observedRuntimeIds, [null]);
});

await test('credentialed delivery forwards its cancellation signal', async () => {
  let deliveredPlan;
  const cancellation = new AbortController();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_CAPABILITIES: 'command.exec,workspace.git.deliver',
    }),
    client: new mod.FakeBoxLiteClient(),
    workspaceDelivery: async ({ plan }) => {
      deliveredPlan = plan;
      return { hadChanges: false, commitSha: null, error: null };
    },
  });
  await provider.provision({ taskId: 'delivery-signal', cloneSpec: null });

  await provider.deliverWorkspaceChanges('delivery-signal', {
    branch: 'main',
    commitMessage: 'deliver',
    credential: core.createExactHostGitCredential(
      'https://code.example.test/acme/repo.git',
      'Authorization: Basic branch-test',
    ),
    cancellationSignal: cancellation.signal,
  });

  assert.equal(deliveredPlan.cancellationSignal, cancellation.signal);
});

await test('workspace downloads distinguish configured and explicit paths', async () => {
  const client = new mod.FakeBoxLiteClient();
  const paths = [];
  client.downloadArchive = async ({ path }) => {
    paths.push(path);
    return null;
  };
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_WORKSPACE_PATH: '/srv/workspace' }),
    client,
  });
  await provider.provision({ taskId: 'download-paths', cloneSpec: null });

  await provider.downloadWorkspaceArchive({ taskId: 'download-paths' });
  await provider.downloadWorkspaceArchive({
    taskId: 'download-paths',
    path: '/srv/custom.bin',
  });

  assert.deepEqual(paths, ['/srv/workspace', '/srv/custom.bin']);
});

await test('canonical workspace forwards optional controls and archive upload controls', async () => {
  const client = new mod.FakeBoxLiteClient();
  const cancellation = new AbortController();
  const transferCancellation = new AbortController();
  const progress = () => undefined;
  const detachment = { park: true };
  const fence = ownership('resource:canonical-controls');
  let captured;
  let uploadedBytes = 0;
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({
      BOXLITE_CAPABILITIES: [
        'command.exec',
        'workspace.archive.transfer',
        'workspace.source.archive',
        'workspace.git.materialize',
      ].join(','),
      BOXLITE_ARCHIVE_PART_BYTES: '2',
    }),
    client,
    workspaceMaterialization: async (context) => {
      captured = context;
      await context.archiveTransfer.uploadArchive({
        path: '/repo-source',
        archive: chunks([1, 2], [3]),
        signal: transferCancellation.signal,
        onBytesUploaded(bytes) {
          uploadedBytes = bytes;
        },
      });
      await context.archiveTransfer.uploadArchive({
        path: '/repo-source-without-observers',
        archive: chunks([4]),
      });
      return { status: 'succeeded', stage: 'complete' };
    },
  });

  await provider.provision({
    taskId: 'canonical-controls',
    cloneSpec: null,
    workspace: workspacePlan(),
    ownership: fence,
    cancellationSignal: cancellation.signal,
    onWorkspaceProgress: progress,
    workspaceTransferDetachment: detachment,
    beforeSandboxCleanup: async () =>
      cleanupAuthorization('canonical-controls', fence),
    settleSandboxCleanupAttempt: async () => undefined,
  });

  assert.equal(captured.cancellationSignal, cancellation.signal);
  assert.equal(captured.onProgress, progress);
  assert.equal(captured.detachment, detachment);
  assert.equal(uploadedBytes, 3);
  assert.equal(
    client.archivePaths(client.createCalls[0].sandboxId).length,
    2,
  );
});

await test('detached workspace transfers preserve both new and readopted sandboxes', async () => {
  const detachedJob = {
    taskId: 'detached-workspace',
    jobId: 'clone-job',
    async probe() {
      return { status: 'running' };
    },
    async kill() {},
  };
  const signal = new core.SandboxWorkspaceTransferDetachedSignal(detachedJob);

  const newClient = new mod.FakeBoxLiteClient();
  const newProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: newClient,
    workspaceMaterialization: async () => {
      throw signal;
    },
  });
  await assert.rejects(
    newProvider.provision({
      taskId: 'detached-new',
      cloneSpec: null,
      workspace: workspacePlan(),
    }),
    (error) => error === signal,
  );
  assert.equal(newClient.sandboxes.has('cap-boxlite-detached-new'), true);
  assert.deepEqual(newClient.deletedSandboxIds, []);

  const existingClient = new mod.FakeBoxLiteClient();
  const seedProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: existingClient,
  });
  await seedProvider.provision({
    taskId: 'detached-existing',
    cloneSpec: null,
  });
  const readoptingProvider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client: existingClient,
    workspaceMaterialization: async () => {
      throw signal;
    },
  });
  await assert.rejects(
    readoptingProvider.provision({
      taskId: 'detached-existing',
      cloneSpec: null,
      workspace: workspacePlan(),
    }),
    (error) => error === signal,
  );
  assert.equal(
    existingClient.sandboxes.has('cap-boxlite-detached-existing'),
    true,
  );
  assert.deepEqual(existingClient.deletedSandboxIds, []);
});

await test('a create conflict closes readiness diagnostics before capacity cleanup', async () => {
  const client = new mod.FakeBoxLiteClient();
  const create = client.createSandbox.bind(client);
  client.createSandbox = async (request) => {
    const sandbox = await create(request);
    const mismatched = {
      ...sandbox,
      diskSizeGb: request.diskSizeGb + 1,
    };
    client.sandboxes.set(sandbox.id, mismatched);
    throw Object.assign(new Error('BoxLite create failed: HTTP 409'), {
      statusCode: 409,
    });
  };
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig({ BOXLITE_DISK_SIZE_GB: '4' }),
    client,
  });

  await assert.rejects(
    provider.provision({ taskId: 'conflict-capacity', cloneSpec: null }),
    (error) => error?.code === 'sandbox_provisioning_capacity_error',
  );
  assert.deepEqual(client.deletedSandboxIds, [
    'cap-boxlite-conflict-capacity',
  ]);
});

await test('failed provisioning retains ownership when cleanup authorization is absent', async () => {
  const taskId = 'cleanup-authorization-absent';
  const fence = ownership('resource:cleanup-absent');
  const client = new mod.FakeBoxLiteClient();
  let authorizationChecks = 0;
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preflight: async () => ({
      status: 'failed',
      checkedAt: '2026-07-25T00:00:00.000Z',
      error: 'expected failure',
    }),
  });

  await assert.rejects(
    provider.provision({
      taskId,
      cloneSpec: null,
      ownership: fence,
      beforeSandboxCleanup: async () => {
        authorizationChecks += 1;
        return null;
      },
      afterSandboxCleanup: async () => undefined,
    }),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );

  assert.equal(authorizationChecks, 1);
  assert.equal(client.sandboxes.has(client.createCalls[0].sandboxId), true);
  assert.deepEqual(client.deletedSandboxIds, []);
});

await test('an existing cleanup-pending primary survives a cleanup callback rejection', async () => {
  const taskId = 'cleanup-pending-primary';
  const fence = ownership('resource:cleanup-pending-primary');
  const underlying = new Error('underlying workspace failure');
  const primary = new core.SandboxCleanupCoordinationPendingError(underlying);
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async () => {
      throw primary;
    },
  });

  await assert.rejects(
    provider.provision({
      taskId,
      cloneSpec: null,
      workspace: workspacePlan(),
      ownership: fence,
      beforeSandboxCleanup: async () => {
        throw new Error('cleanup callback failed');
      },
      afterSandboxCleanup: async () => undefined,
    }),
    (error) => error === primary,
  );
  assert.equal(client.sandboxes.has(client.createCalls[0].sandboxId), true);
});

await test('cached runs survive fallback inspection and retain environment metadata', async () => {
  const client = new mod.FakeBoxLiteClient();
  let provisionedSandbox;
  const environment = {
    environmentId: 'cached-environment',
    sourceKind: 'boxlite-image',
    sourceRef: 'registry.example.test/cap-boxlite:cached',
  };
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    preflight: async ({ sandbox }) => {
      provisionedSandbox = sandbox;
      return {
        status: 'passed',
        checkedAt: '2026-07-25T00:00:00.000Z',
      };
    },
  });
  const firstConnection = await provider.provision({
    taskId: 'cached-fallback',
    cloneSpec: null,
    environment,
  });

  let inspections = 0;
  client.getSandbox = async () => {
    inspections += 1;
    return inspections === 1 ? null : provisionedSandbox;
  };
  const exactConnection = await provider.provision({
    taskId: 'cached-fallback',
    cloneSpec: null,
    environment,
  });
  assert.equal(exactConnection, firstConnection);

  const replacement = { ...provisionedSandbox };
  inspections = 0;
  client.getSandbox = async () => {
    inspections += 1;
    return inspections === 1 ? null : replacement;
  };
  const selected = await provider.getSelectedSandboxRun('cached-fallback');
  assert.equal(selected.environment.environmentId, 'cached-environment');
  assert.equal(selected.providerSandboxId, replacement.id);
});

await test('generation-scoped empty task ids use the stable task hint', async () => {
  const client = new mod.FakeBoxLiteClient();
  const fence = ownership('resource:empty-task');
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });

  await provider.provision({
    taskId: '',
    cloneSpec: null,
    ownership: fence,
    beforeSandboxCleanup: async () => cleanupAuthorization('', fence),
    afterSandboxCleanup: async () => undefined,
  });

  assert.match(
    client.createCalls[0].sandboxId,
    /^cap-boxlite-task-g-[a-f0-9]{32}$/,
  );
});

await test('primitive create rejections are never mistaken for conflicts', async () => {
  for (const rejection of [null, 'BoxLite create failed: HTTP 409']) {
    const client = new mod.FakeBoxLiteClient();
    client.createSandbox = async () => {
      throw rejection;
    };
    const provider = new mod.BoxLiteSandboxProvider({
      config: validConfig(),
      client,
    });
    let observed = Symbol('not rejected');
    try {
      await provider.provision({
        taskId: `primitive-rejection-${String(rejection)}`,
        cloneSpec: null,
      });
    } catch (error) {
      observed = error;
    }
    assert.equal(observed, rejection);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
