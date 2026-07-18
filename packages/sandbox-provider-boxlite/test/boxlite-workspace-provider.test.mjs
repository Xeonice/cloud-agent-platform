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

function privateCredential() {
  return core.createExactHostGitCredential(
    REPOSITORY_URL,
    `Authorization: Basic ${CANARY}`,
  );
}

function credentialSettlementFailingClient() {
  return new mod.FakeBoxLiteClient({
    execHandler: (request) => ({
      exitCode: request.command.includes('rm -f --') ? 1 : 0,
      stdout: '',
      stderr: '',
      output: '',
      timedOut: false,
    }),
  });
}

function credentialSettlementUnconfirmedClient({
  cleanupRetrySucceeds = false,
} = {}) {
  const client = credentialSettlementFailingClient();
  let deleteAttempts = 0;
  client.deleteSandbox = async (sandboxId) => {
    deleteAttempts += 1;
    client.deletedSandboxIds.push(sandboxId);
    if (cleanupRetrySucceeds && deleteAttempts >= 2) {
      client.sandboxes.delete(sandboxId);
    }
  };
  return client;
}

async function leaveCredentialForProviderSettlement(workspace) {
  await workspace.secretFilePort.writeSecretFile({
    kind: 'git-http-credential',
    credential: privateCredential(),
  });
}

{
  const client = new mod.FakeBoxLiteClient();
  let captured;
  const diagnostics = Object.freeze({
    mode: 'task',
    attemptContext: Object.freeze({ providerFamily: 'unknown' }),
    createOperationId: () => '24000000-0000-4000-8000-000000000002',
    bindProviderFamily: () => undefined,
    emit: async () => undefined,
  });
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
      diagnostics,
    }),
  );

  assert.equal(captured.plan.deadlineMs, 1_234);
  assert.equal(captured.plan.resolvedBranch, 'main');
  assert.equal(captured.plan.callerBranch, null);
  assert.equal(Object.isFrozen(captured.plan), true);
  assert.equal(captured.beforeBoundary, boundary);
  assert.equal(captured.diagnostics, diagnostics);
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
  const primary = new Error('workspace hook primary');
  const client = credentialSettlementFailingClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      throw primary;
    },
  });
  await assert.rejects(
    () =>
      provider.provision(
        context('workspace-thrown-primary', {
          workspace: plan({ credential: privateCredential() }),
          cloneSpec: null,
        }),
      ),
    (error) => error === primary,
  );
  assert.deepEqual(await provider.listReadoptable(), []);
}

{
  const client = credentialSettlementFailingClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      return {
        status: 'failed',
        stage: 'workspace_transfer',
        cause: 'authentication',
        retryable: false,
      };
    },
  });
  await assert.rejects(
    () =>
      provider.provision(
        context('workspace-result-primary', {
          workspace: plan({ credential: privateCredential() }),
          cloneSpec: null,
        }),
      ),
    (error) =>
      error?.code === 'sandbox_workspace_materialization_error' &&
      error.failure?.stage === 'workspace_transfer' &&
      error.failure?.cause === 'authentication',
  );
  assert.deepEqual(await provider.listReadoptable(), []);
}

{
  const client = credentialSettlementFailingClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      return { status: 'succeeded', stage: 'complete' };
    },
  });
  await assert.rejects(
    () =>
      provider.provision(
        context('workspace-cleanup-only-failure', {
          workspace: plan({ credential: privateCredential() }),
          cloneSpec: null,
        }),
      ),
    (error) =>
      error?.code === 'sandbox_provider_configuration_error' &&
      error.message ===
        'BoxLite secret file removal required sandbox fencing' &&
      !error.message.includes(CANARY),
  );
  assert.deepEqual(await provider.listReadoptable(), []);
}

{
  const client = credentialSettlementUnconfirmedClient({
    cleanupRetrySucceeds: true,
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      return {
        status: 'failed',
        stage: 'workspace_transfer',
        cause: 'tls_network',
        retryable: true,
      };
    },
  });
  await assert.rejects(
    () =>
      provider.provision(
        context('workspace-cleanup-retry-recovers', {
          workspace: plan({ credential: privateCredential() }),
          cloneSpec: null,
        }),
      ),
    (error) =>
      error?.code === 'sandbox_workspace_materialization_error' &&
      error.failure?.stage === 'workspace_transfer' &&
      error.failure?.cause === 'tls_network' &&
      error.failure?.retryable === true,
  );
  assert.equal(client.deletedSandboxIds.length, 1);
  assert.equal(
    client.sandboxes.has('cap-boxlite-workspace-cleanup-retry-recovers'),
    true,
  );
  assert.deepEqual(await provider.listReadoptable(), []);
}

{
  const primary = new Error('workspace primary with pending cleanup');
  const taskId = 'workspace-cleanup-remains-pending';
  const client = credentialSettlementUnconfirmedClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceMaterialization: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      throw primary;
    },
  });
  await assert.rejects(
    () =>
      provider.provision(
        context(taskId, {
          workspace: plan({ credential: privateCredential() }),
          cloneSpec: null,
        }),
      ),
    (error) => error === primary,
  );
  assert.equal(client.deletedSandboxIds.length, 1);
  assert.equal(client.sandboxes.has(`cap-boxlite-${taskId}`), true);
  assert.equal(await provider.sandboxExists(taskId), true);
  assert.deepEqual(await provider.listReadoptable(), []);
  assert.equal(await provider.reattach(taskId), null);
  await assert.rejects(
    () =>
      provider.provision(
        context(taskId, {
          workspace: plan({ credential: privateCredential() }),
          cloneSpec: null,
        }),
      ),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );
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
  const taskId = 'delivery-result-primary';
  const ownership = {
    ownerGeneration: 'owner:delivery-result-primary',
    resourceGeneration: 'resource:delivery-result-primary',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-workspace-test',
    ownership,
  };
  const cleanupEvents = [];
  const client = credentialSettlementFailingClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      return {
        hadChanges: false,
        commitSha: null,
        error: 'delivery_primary_failure',
      };
    },
  });
  await provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );
  const result = await provider.deliverWorkspaceChanges(taskId, {
    branch: 'cap/delivery-result-primary',
    commitMessage: 'preserve delivery result',
    credential: privateCredential(),
    ownership,
    beforeSandboxCleanup: async () => {
      cleanupEvents.push('authorized');
      return authorization;
    },
    afterSandboxCleanup: async (received) => {
      assert.equal(received, authorization);
      cleanupEvents.push('completed');
    },
  });
  assert.deepEqual(result, {
    hadChanges: false,
    commitSha: null,
    error: 'delivery_primary_failure',
  });
  assert.deepEqual(cleanupEvents, ['authorized', 'completed']);
  assert.deepEqual(await provider.listReadoptable(), []);
  await provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );
  assert.deepEqual(await provider.listReadoptable(), [taskId]);
}

for (const primaryKind of ['thrown', 'typed-result']) {
  const taskId = `delivery-ack-rejected-${primaryKind}`;
  const ownership = {
    ownerGeneration: `owner:${primaryKind}`,
    resourceGeneration: `resource:${primaryKind}`,
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-workspace-test',
    ownership,
  };
  const primary =
    primaryKind === 'thrown'
      ? new Error('delivery hook primary')
      : Object.freeze({
          hadChanges: false,
          commitSha: null,
          error: 'delivery_primary_failure',
        });
  const client = credentialSettlementFailingClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      if (primaryKind === 'thrown') throw primary;
      return primary;
    },
  });
  await provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );
  const sandboxId = client.createCalls[0].sandboxId;
  let pending;
  await assert.rejects(
    () =>
      provider.deliverWorkspaceChanges(taskId, {
        branch: `cap/${taskId}`,
        commitMessage: 'preserve primary across rejected cleanup acknowledgement',
        credential: privateCredential(),
        ownership,
        beforeSandboxCleanup: async () => authorization,
        afterSandboxCleanup: async () => {
          throw new Error(`owner-store acknowledgement rejected: ${CANARY}`);
        },
      }),
    (error) => {
      pending = error;
      return (
        error?.code === 'sandbox_cleanup_coordination_pending' &&
        error.primary === primary &&
        !Object.keys(error).includes('primary')
      );
    },
  );
  assert.equal(client.sandboxes.has(sandboxId), false);
  assert.equal(await provider.sandboxExists(taskId), false);
  assert.equal(
    await provider.reattach(taskId, { ownership, providerSandboxId: sandboxId }),
    null,
  );
  assert.deepEqual(await provider.listReadoptable(), []);
  assert.doesNotMatch(JSON.stringify(pending), new RegExp(CANARY, 'u'));
  await assert.rejects(
    () =>
      provider.provision(
        context(taskId, { workspace: null, cloneSpec: null, ownership }),
      ),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );

  if (primaryKind === 'typed-result') {
    assert.deepEqual(
      await provider.teardownSandbox(taskId, {
        ownership,
        cleanupAuthorization: authorization,
        providerSandboxId: sandboxId,
      }),
      { kind: 'already-absent' },
    );
    await provider.provision(
      context(taskId, { workspace: null, cloneSpec: null, ownership }),
    );
    assert.deepEqual(await provider.listReadoptable(), [taskId]);
  }
}

{
  const taskId = 'delivery-ack-rejected-after-success';
  const ownership = {
    ownerGeneration: 'owner:delivery-success',
    resourceGeneration: 'resource:delivery-success',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-workspace-test',
    ownership,
  };
  const client = credentialSettlementFailingClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      return { hadChanges: true, commitSha: 'unsafe-sha', error: null };
    },
  });
  await provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );
  const sandboxId = client.createCalls[0].sandboxId;
  let pending;
  await assert.rejects(
    () =>
      provider.deliverWorkspaceChanges(taskId, {
        branch: `cap/${taskId}`,
        commitMessage: 'successful delivery still requires cleanup acknowledgement',
        credential: privateCredential(),
        ownership,
        beforeSandboxCleanup: async () => authorization,
        afterSandboxCleanup: async () => {
          throw new Error(`cleanup acknowledgement canary: ${CANARY}`);
        },
      }),
    (error) => {
      pending = error;
      return (
        error?.code === 'sandbox_cleanup_coordination_pending' &&
        error.primary?.code === 'sandbox_provider_configuration_error' &&
        error.primary.message ===
          'BoxLite credential safety settlement could not be confirmed' &&
        !Object.keys(error).includes('primary')
      );
    },
  );
  assert.equal(client.sandboxes.has(sandboxId), false);
  assert.equal(await provider.sandboxExists(taskId), false);
  assert.equal(await provider.reattach(taskId), null);
  assert.deepEqual(await provider.listReadoptable(), []);
  assert.doesNotMatch(JSON.stringify(pending), new RegExp(CANARY, 'u'));
}

{
  const taskId = 'delivery-ack-rejected-inside-workspace-run';
  const ownership = {
    ownerGeneration: 'owner:delivery-run-fence',
    resourceGeneration: 'resource:delivery-run-fence',
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
        request: { command: 'git push', timeoutMs: 1_000 },
        signal: cancellation.signal,
        remainingTimeoutMs: 1_000,
      });
      assert.deepEqual(stage, {
        exitCode: 124,
        output: '',
        stdout: '',
        stderr: '',
        timedOut: true,
      });
      return { hadChanges: false, commitSha: null, error: null };
    },
  });
  await provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );
  const sandboxId = client.createCalls[0].sandboxId;
  let pending;
  await assert.rejects(
    () =>
      provider.deliverWorkspaceChanges(taskId, {
        branch: `cap/${taskId}`,
        commitMessage: 'fence inside workspace hook',
        credential: privateCredential(),
        ownership,
        beforeSandboxCleanup: async () => authorization,
        afterSandboxCleanup: async () => {
          throw new Error(`in-hook acknowledgement rejected: ${CANARY}`);
        },
      }),
    (error) => {
      pending = error;
      return (
        error?.code === 'sandbox_cleanup_coordination_pending' &&
        error.primary?.code === 'sandbox_provider_configuration_error' &&
        error.primary.message ===
          'BoxLite credential safety settlement could not be confirmed' &&
        !Object.keys(error).includes('primary')
      );
    },
  );
  assert.equal(client.sandboxes.has(sandboxId), false);
  assert.equal(await provider.sandboxExists(taskId), false);
  assert.equal(await provider.reattach(taskId), null);
  assert.deepEqual(await provider.listReadoptable(), []);
  assert.doesNotMatch(JSON.stringify(pending), new RegExp(CANARY, 'u'));
  await assert.rejects(
    () =>
      provider.provision(
        context(taskId, { workspace: null, cloneSpec: null, ownership }),
      ),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );
}

{
  const taskId = 'delivery-cleanup-remains-pending';
  const ownership = {
    ownerGeneration: 'owner:delivery-cleanup-pending',
    resourceGeneration: 'resource:delivery-cleanup-pending',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-workspace-test',
    ownership,
  };
  const primary = Object.freeze({
    hadChanges: false,
    commitSha: null,
    error: 'delivery_primary_failure',
  });
  const cleanupEvents = [];
  let receivedPhysical;
  const client = credentialSettlementUnconfirmedClient({
    cleanupRetrySucceeds: true,
  });
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      return primary;
    },
  });
  await provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );
  const sandboxId = client.createCalls[0].sandboxId;
  await assert.rejects(
    () =>
      provider.deliverWorkspaceChanges(taskId, {
        branch: 'cap/delivery-cleanup-remains-pending',
        commitMessage: 'retain cleanup authority',
        credential: privateCredential(),
        ownership,
        beforeSandboxCleanup: async () => {
          cleanupEvents.push('authorized');
          return authorization;
        },
        settleSandboxCleanupAttempt: async (receivedAuthorization, physical) => {
          assert.equal(receivedAuthorization, authorization);
          receivedPhysical = physical;
          cleanupEvents.push('completed');
        },
      }),
    (error) => error === primary,
  );
  assert.deepEqual(cleanupEvents, ['authorized', 'completed']);
  assert.deepEqual(receivedPhysical, {
    outcome: 'failed',
    proof: null,
    cause: 'cleanup_failed',
    retryable: true,
  });
  assert.equal(client.sandboxes.has(sandboxId), true);
  assert.equal(await provider.sandboxExists(taskId), true);
  assert.equal(
    await provider.reattach(taskId, { ownership, providerSandboxId: sandboxId }),
    null,
  );
  assert.equal(await provider.getSelectedSandboxRun(taskId), null);
  assert.deepEqual(await provider.listReadoptable(), []);

  assert.deepEqual(
    await provider.teardownSandbox(taskId, {
      ownership,
      cleanupAuthorization: authorization,
      providerSandboxId: sandboxId,
    }),
    { kind: 'found-and-cleaned' },
  );
  assert.equal(await provider.sandboxExists(taskId), false);
  await provider.provision(
    context(taskId, { workspace: null, cloneSpec: null, ownership }),
  );
  assert.deepEqual(await provider.listReadoptable(), [taskId]);
}

{
  const primary = new Error('delivery hook primary');
  const client = credentialSettlementFailingClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      throw primary;
    },
  });
  await provider.provision(
    context('delivery-thrown-primary', { workspace: null, cloneSpec: null }),
  );
  await assert.rejects(
    () =>
      provider.deliverWorkspaceChanges('delivery-thrown-primary', {
        branch: 'cap/delivery-thrown-primary',
        commitMessage: 'preserve thrown delivery error',
        credential: privateCredential(),
      }),
    (error) => error === primary,
  );
  assert.deepEqual(await provider.listReadoptable(), []);
}

{
  const taskId = 'delivery-cleanup-only-failure';
  const client = credentialSettlementUnconfirmedClient();
  const provider = new mod.BoxLiteSandboxProvider({
    config: validConfig(),
    client,
    workspaceDelivery: async (workspace) => {
      await leaveCredentialForProviderSettlement(workspace);
      return { hadChanges: true, commitSha: 'unsafe-sha', error: null };
    },
  });
  await provider.provision(
    context(taskId, {
      workspace: null,
      cloneSpec: null,
    }),
  );
  await assert.rejects(
    () =>
      provider.deliverWorkspaceChanges(taskId, {
        branch: 'cap/delivery-cleanup-only-failure',
        commitMessage: 'cleanup must fail closed',
        credential: privateCredential(),
      }),
    (error) =>
      error?.code === 'sandbox_provider_configuration_error' &&
      error.message ===
        'BoxLite credential safety fencing could not be confirmed' &&
      !error.message.includes(CANARY),
  );
  assert.equal(await provider.sandboxExists(taskId), true);
  assert.equal(await provider.reattach(taskId), null);
  assert.deepEqual(await provider.listReadoptable(), []);
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
