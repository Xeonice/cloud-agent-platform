import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);

const REPOSITORY_URL = 'https://code.example.test/acme/private.git';
const CANARY = 'CAP_BOXLITE_PROVIDER_CANARY_a821';

function validConfig(overrides = {}) {
  const result = mod.readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'token',
    BOXLITE_IMAGE: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest',
    BOXLITE_PROVIDER_ID: 'boxlite-workspace-test',
    BOXLITE_CAPABILITIES:
      'command.exec,workspace.git.materialize,workspace.git.deliver',
    BOXLITE_GIT_CLONE_TIMEOUT_MS: '60000',
    ...overrides,
  });
  assert.equal(result.status, 'valid');
  return result.config;
}

function context(taskId, overrides = {}) {
  return {
    taskId,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'headless-exec',
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    repositoryUrl: REPOSITORY_URL,
    callerBranch: null,
    resolvedBranch: 'main',
    deadlineMs: 1_234,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

{
  const client = new mod.FakeBoxLiteClient();
  let captured;
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async (workspace) => {
      captured = workspace;
      return { status: 'succeeded', stage: 'complete' };
    },
  });
  const boundary = async () => undefined;
  await provider.provision(
    context('canonical-precedence', {
      workspace: plan(),
      cloneSpec: {
        url: 'https://legacy.example.test/must-not-run.git',
        authHeader: 'Authorization: Basic legacy-secret',
      },
      beforeWorkspaceBoundary: boundary,
    }),
  );

  assert.equal(captured.plan.deadlineMs, 1_234);
  assert.equal(captured.plan.resolvedBranch, 'main');
  assert.equal(captured.plan.callerBranch, null);
  assert.equal(Object.isFrozen(captured.plan), true);
  assert.equal(captured.beforeBoundary, boundary);
  assert.equal(captured.workspaceDir, '/home/gem/workspace');
  assert.equal(
    client.execCalls.some((call) => call.command.includes('legacy.example.test')),
    false,
  );
}

{
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
  });
  await provider.provision(
    context('canonical-null', {
      workspace: null,
      cloneSpec: {
        url: 'https://legacy.example.test/must-not-run.git',
        authHeader: 'Authorization: Basic legacy-secret',
      },
    }),
  );
  assert.equal(
    client.execCalls.some((call) => call.command.includes('git clone')),
    false,
  );
}

{
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async () => ({
      status: 'failed',
      stage: 'workspace_transfer',
      cause: 'capacity_exhausted',
      retryable: false,
    }),
  });
  await assert.rejects(
    () =>
      provider.provision(
        context('typed-failure', { workspace: plan(), cloneSpec: null }),
      ),
    (error) =>
      error?.code === 'sandbox_workspace_materialization_error' &&
      error.failure?.cause === 'capacity_exhausted',
  );
  assert.deepEqual(await provider.listReadoptable(), []);
  assert.deepEqual(client.deletedSandboxIds, [
    'cap-boxlite-typed-failure',
  ]);
}

{
  const cleanupStarted = deferred();
  const cleanupReleased = deferred();
  const uploads = [];
  const client = new mod.FakeBoxLiteClient({
    execHandler: async (request) => {
      if (request.command.includes('rm -f --')) {
        cleanupStarted.resolve();
        return cleanupReleased.promise;
      }
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      };
    },
  });
  client.uploadArchive = async (request) => {
    uploads.push({
      path: request.path,
      archive: Buffer.from(request.archive),
    });
  };
  const credential = core.createExactHostGitCredential(
    REPOSITORY_URL,
    `Authorization: Basic ${CANARY}`,
  );
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async (workspace) => {
      await workspace.secretFilePort.writeSecretFile({
        kind: 'git-http-credential',
        credential,
      });
      return { status: 'succeeded', stage: 'complete' };
    },
  });

  let settled = false;
  const provisioning = provider
    .provision(
      context('cleanup-before-retention', {
        workspace: plan({ credential }),
        cloneSpec: null,
      }),
    )
    .finally(() => {
      settled = true;
    });
  await cleanupStarted.promise;
  assert.equal(settled, false);
  assert.deepEqual(await provider.listReadoptable(), []);
  assert.match(
    uploads[0].path,
    /^\/home\/gem\/\.cap-git-credentials\/\.cap-git-credential-.*\.config\.upload$/u,
  );
  assert.equal(uploads[0].archive.subarray(0, 512).includes(CANARY), false);
  assert(uploads[0].archive.indexOf(CANARY) >= 512);
  assert.ok(
    client.execCalls.every((call) => !call.command.includes(CANARY)),
    'provider credential setup and cleanup commands contain paths only',
  );
  cleanupReleased.resolve({
    exitCode: 0,
    stdout: '',
    stderr: '',
    output: '',
    timedOut: false,
  });
  await provisioning;
  assert.deepEqual(await provider.listReadoptable(), [
    'cleanup-before-retention',
  ]);
}

{
  const cancellation = new AbortController();
  cancellation.abort();
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async () => ({
      status: 'succeeded',
      stage: 'complete',
    }),
  });
  await assert.rejects(
    () =>
      provider.provision(
        context('pre-aborted', {
          cancellationSignal: cancellation.signal,
          workspace: plan(),
        }),
      ),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(client.createCalls.length, 0);
}

{
  const client = new mod.FakeBoxLiteClient();
  client.sandboxes.set('cap-boxlite-recovered', {
    id: 'cap-boxlite-recovered',
    taskId: 'recovered',
    state: 'running',
    image: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest',
  });
  let materializations = 0;
  let setups = 0;
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async () => {
      materializations += 1;
      return { status: 'succeeded', stage: 'complete' };
    },
    runtimeSetup: async () => {
      setups += 1;
    },
  });
  await provider.provision(
    context('recovered', { workspace: plan(), cloneSpec: null }),
  );
  assert.equal(materializations, 1);
  assert.equal(setups, 1);
}

{
  const cleanupStarted = deferred();
  const cleanupReleased = deferred();
  const uploadPaths = [];
  const client = new mod.FakeBoxLiteClient({
    execHandler: async (request) => {
      if (request.command.includes('rm -f --')) {
        cleanupStarted.resolve();
        return cleanupReleased.promise;
      }
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      };
    },
  });
  client.uploadArchive = async (request) => {
    uploadPaths.push(request.path);
  };
  const credential = core.createExactHostGitCredential(
    REPOSITORY_URL,
    `Authorization: Basic ${CANARY}`,
  );
  let captured;
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      captured = workspace;
      await workspace.secretFilePort.writeSecretFile({
        kind: 'git-http-credential',
        credential,
      });
      return { hadChanges: true, commitSha: 'abc123', error: null };
    },
  });
  await provider.provision(
    context('delivery-cleanup', { workspace: null, cloneSpec: null }),
  );

  let settled = false;
  const delivery = provider
    .deliverWorkspaceChanges('delivery-cleanup', {
      branch: 'cap/delivery-cleanup',
      commitMessage: 'deliver',
      credential,
      deadlineMs: 2_222,
    })
    .finally(() => {
      settled = true;
    });
  await cleanupStarted.promise;
  assert.equal(settled, false);
  assert.equal(captured.plan.deadlineMs, 2_222);
  assert.equal(Object.isFrozen(captured.plan), true);
  assert.equal(uploadPaths.length, 1);
  assert.match(
    uploadPaths[0],
    /^\/home\/gem\/\.cap-git-credentials\/\.cap-git-credential-.*\.config\.upload$/u,
  );
  assert.ok(
    client.execCalls.every((call) => !call.command.includes(CANARY)),
    'delivery credential commands contain paths only',
  );
  cleanupReleased.resolve({
    exitCode: 0,
    stdout: '',
    stderr: '',
    output: '',
    timedOut: false,
  });
  assert.deepEqual(await delivery, {
    hadChanges: true,
    commitSha: 'abc123',
    error: null,
  });
  assert.deepEqual(await provider.listReadoptable(), ['delivery-cleanup']);
}

{
  const events = [];
  const taskId = 'delivery-fence-owner';
  const ownership = {
    ownerGeneration: 'owner:delivery-fence',
    resourceGeneration: 'resource:delivery-fence',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-workspace-test',
    ownership,
  };
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      const cancellation = new AbortController();
      cancellation.abort();
      const stage = await workspace.stageExecutor.execute({
        stage: 'delivery_push',
        request: { command: 'git push', timeoutMs: 5_000 },
        signal: cancellation.signal,
        remainingTimeoutMs: 5_000,
      });
      assert.equal(stage.timedOut, true);
      return {
        hadChanges: true,
        commitSha: 'delivery-fence-sha',
        error: 'delivery_timeout',
      };
    },
  });
  await provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );

  const result = await provider.deliverWorkspaceChanges(taskId, {
    branch: `cap/${taskId}`,
    commitMessage: 'delivery fence',
    credential: core.createExactHostGitCredential(
      REPOSITORY_URL,
      `Authorization: Basic ${CANARY}`,
    ),
    ownership,
    beforeSandboxCleanup: async () => {
      events.push('cleanup-authorized');
      return authorization;
    },
    afterSandboxCleanup: async (received) => {
      assert.equal(received, authorization);
      events.push('cleanup-completed');
    },
  });

  assert.deepEqual(result, {
    hadChanges: true,
    commitSha: 'delivery-fence-sha',
    error: 'delivery_timeout',
  });
  assert.deepEqual(events, ['cleanup-authorized', 'cleanup-completed']);
  assert.deepEqual(client.deletedSandboxIds, [client.createCalls[0].sandboxId]);
  assert.deepEqual(await provider.listReadoptable(), []);
}

{
  const taskId = 'delivery-fence-provider-alias';
  const providerId = 'boxlite-provider-alias';
  const ownership = {
    ownerGeneration: 'owner:provider-alias',
    resourceGeneration: 'resource:provider-alias',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId,
    ownership,
  };
  const client = new mod.FakeBoxLiteClient();
  const descriptor = mod.defineBoxLiteSandboxProvider({
    id: providerId,
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      const cancellation = new AbortController();
      cancellation.abort();
      await workspace.stageExecutor.execute({
        stage: 'delivery_push',
        request: { command: 'git push', timeoutMs: 5_000 },
        signal: cancellation.signal,
        remainingTimeoutMs: 5_000,
      });
      return {
        hadChanges: false,
        commitSha: null,
        error: 'delivery_timeout',
      };
    },
  });
  assert.equal(descriptor.provider.getProviderId(), providerId);
  await descriptor.provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );

  let cleanupCompleted = false;
  const result = await descriptor.provider.deliverWorkspaceChanges(taskId, {
    branch: `cap/${taskId}`,
    commitMessage: 'provider alias cleanup',
    credential: core.createExactHostGitCredential(
      REPOSITORY_URL,
      `Authorization: Basic ${CANARY}`,
    ),
    ownership,
    beforeSandboxCleanup: async () => authorization,
    afterSandboxCleanup: async (received) => {
      assert.equal(received, authorization);
      cleanupCompleted = true;
    },
  });
  assert.equal(result.error, 'delivery_timeout');
  assert.equal(cleanupCompleted, true);
  assert.deepEqual(await descriptor.provider.listReadoptable(), []);
}

{
  const taskId = 'generated-delivery-refuses-legacy-run';
  const ownership = {
    ownerGeneration: 'owner:generated-delivery',
    resourceGeneration: 'resource:generated-delivery',
  };
  let deliveryCalls = 0;
  const client = new mod.FakeBoxLiteClient({
    execHandler: (request) => ({
      exitCode: request.command.includes('CAP_RESOURCE_GENERATION') ? 1 : 0,
      stdout: '',
      stderr: '',
      output: '',
      timedOut: false,
    }),
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async () => {
      deliveryCalls += 1;
      return { hadChanges: false, commitSha: null, error: null };
    },
  });
  await provider.provision(context(taskId, { workspace: null, cloneSpec: null }));
  const legacySandboxId = client.createCalls[0].sandboxId;

  await assert.rejects(
    provider.deliverWorkspaceChanges(taskId, {
      branch: `cap/${taskId}`,
      commitMessage: 'must not use a legacy sandbox',
      credential: core.createExactHostGitCredential(
        REPOSITORY_URL,
        `Authorization: Basic ${CANARY}`,
      ),
      ownership,
      beforeSandboxCleanup: async () => {
        assert.fail('an unverified legacy run must not enter cleanup');
      },
      afterSandboxCleanup: async () => {
        assert.fail('an unverified legacy run must not complete cleanup');
      },
    }),
    /BoxLite sandbox resource generation mismatch/u,
  );
  assert.equal(deliveryCalls, 0);
  assert.equal(client.sandboxes.has(legacySandboxId), true);
  assert.deepEqual(client.deletedSandboxIds, []);
}

{
  const taskId = 'legacy-delivery-fence';
  const authorization = {
    kind: 'legacy',
    taskId,
    providerId: 'boxlite-workspace-test',
  };
  const client = new mod.FakeBoxLiteClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      const cancellation = new AbortController();
      cancellation.abort();
      await workspace.stageExecutor.execute({
        stage: 'delivery_push',
        request: { command: 'git push', timeoutMs: 1_000 },
        signal: cancellation.signal,
        remainingTimeoutMs: 1_000,
      });
      return {
        hadChanges: false,
        commitSha: null,
        error: 'delivery_timeout',
      };
    },
  });
  await provider.provision(context(taskId, { workspace: null, cloneSpec: null }));
  let cleanupCompleted = false;
  const result = await provider.deliverWorkspaceChanges(taskId, {
    branch: `cap/${taskId}`,
    commitMessage: 'legacy cleanup',
    credential: core.createExactHostGitCredential(
      REPOSITORY_URL,
      `Authorization: Basic ${CANARY}`,
    ),
    beforeSandboxCleanup: async () => authorization,
    afterSandboxCleanup: async (received) => {
      assert.equal(received, authorization);
      cleanupCompleted = true;
    },
  });
  assert.equal(result.error, 'delivery_timeout');
  assert.equal(cleanupCompleted, true);
  assert.deepEqual(await provider.listReadoptable(), []);
}

console.log('BoxLite workspace provider tests passed');
