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

function provider(name, capabilities) {
  return {
    getSandboxMode: () => name,
    getProviderCapabilities: capabilities === undefined ? undefined : () => capabilities,
  };
}

await test('exports concrete capability and location vocabularies', () => {
  assert.deepEqual(mod.SANDBOX_PROVIDER_CAPABILITIES, [
    'terminal.websocket',
    'workspace.git.materialize',
    'workspace.git.deliver',
    'transcript.retained-read',
    'lifecycle.readopt',
  ]);
  assert.deepEqual(mod.SANDBOX_PROVIDER_FEATURE_CAPABILITIES, [
    'terminal.interactive',
    'command.exec',
    'workspace.archive.transfer',
    'transcript.retained-source',
    'lifecycle.readoption',
    'lifecycle.sleep',
    'lifecycle.snapshot',
    'resource.disk-size-gb',
    'port.expose',
  ]);
  assert.deepEqual(mod.SANDBOX_PROVIDER_KNOWN_CAPABILITIES, [
    'terminal.websocket',
    'workspace.git.materialize',
    'workspace.git.deliver',
    'transcript.retained-read',
    'lifecycle.readopt',
    'terminal.interactive',
    'command.exec',
    'workspace.archive.transfer',
    'transcript.retained-source',
    'lifecycle.readoption',
    'lifecycle.sleep',
    'lifecycle.snapshot',
    'resource.disk-size-gb',
    'port.expose',
  ]);
  assert.deepEqual(mod.SANDBOX_PROVIDER_LOCATIONS, ['local', 'cloud']);
  assert.deepEqual(mod.SANDBOX_EXECUTION_MODES, [
    'read-only',
    'workspace-write',
    'danger-full-access',
  ]);
});

await test('exports operation-specific required capability sets', () => {
  assert.deepEqual(mod.INTERACTIVE_SANDBOX_REQUIRED_CAPABILITIES, [
    'terminal.websocket',
  ]);
  assert.deepEqual(mod.MATERIALIZED_WORKSPACE_SANDBOX_REQUIRED_CAPABILITIES, [
    'terminal.websocket',
    'workspace.git.materialize',
  ]);
  assert.deepEqual(mod.DELIVERY_SANDBOX_REQUIRED_CAPABILITIES, [
    'workspace.git.deliver',
  ]);
  assert.deepEqual(mod.READOPTION_SANDBOX_REQUIRED_CAPABILITIES, [
    'lifecycle.readopt',
  ]);
  assert.deepEqual(mod.RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES, [
    'transcript.retained-read',
  ]);
  assert.deepEqual(mod.INTERACTIVE_SANDBOX_FEATURE_CAPABILITIES, [
    'terminal.interactive',
    'command.exec',
  ]);
  assert.deepEqual(mod.ARCHIVE_WORKSPACE_SANDBOX_FEATURE_CAPABILITIES, [
    'workspace.archive.transfer',
    'command.exec',
  ]);
  assert.deepEqual(mod.DELIVERY_SANDBOX_FEATURE_CAPABILITIES, [
    'workspace.git.deliver',
    'command.exec',
  ]);
  assert.deepEqual(mod.READOPTION_SANDBOX_FEATURE_CAPABILITIES, [
    'lifecycle.readoption',
  ]);
  assert.deepEqual(mod.RETAINED_TRANSCRIPT_SANDBOX_FEATURE_CAPABILITIES, [
    'transcript.retained-source',
  ]);
});

await test('capability helpers report missing required entries', () => {
  assert.deepEqual(
    mod.missingCapabilities(['terminal.websocket'], [
      'terminal.websocket',
      'workspace.git.materialize',
    ]),
    ['workspace.git.materialize'],
  );
  assert.deepEqual(
    mod.missingCapabilities(undefined, ['terminal.websocket']),
    ['terminal.websocket'],
  );
  assert.deepEqual(
    mod.missingCapabilities(['lifecycle.readoption'], ['lifecycle.readopt']),
    [],
  );
  assert.equal(
    mod.hasAllCapabilities(['lifecycle.readopt'], ['lifecycle.readoption']),
    true,
  );
  assert.equal(
    mod.hasAllCapabilities(['terminal.websocket'], ['terminal.websocket']),
    true,
  );
  assert.equal(
    mod.hasAllCapabilities(['terminal.websocket'], ['command.exec']),
    false,
  );
});

await test('provider descriptor reads capabilities from declared providers', () => {
  const local = provider('aio-local', ['terminal.websocket']);
  const descriptor = mod.describeSandboxProvider({
    id: 'local-aio',
    provider: local,
    location: 'local',
    priority: 20,
  });
  assert.deepEqual(descriptor, {
    id: 'local-aio',
    provider: local,
    location: 'local',
    capabilities: ['terminal.websocket'],
    priority: 20,
  });
});

await test('command executor helpers normalize provider command results', async () => {
  const nested = mod.normalizeSandboxCommandResult({
    data: {
      exit_code: '7',
      stderr: 'boom',
      timed_out: true,
    },
  });
  assert.equal(nested.exitCode, 7);
  assert.equal(nested.output, 'boom');
  assert.equal(nested.stderr, 'boom');
  assert.equal(nested.stdout, '');
  assert.equal(nested.timedOut, true);

  const flat = mod.normalizeSandboxCommandResult({
    code: 0,
    stdout: 'ok',
  });
  assert.equal(flat.exitCode, 0);
  assert.equal(flat.output, 'ok');
  assert.equal(flat.timedOut, false);

  assert(Number.isNaN(mod.normalizeSandboxCommandResult({ output: 'missing' }).exitCode));
  assert(Number.isNaN(mod.normalizeSandboxCommandResult(null).exitCode));
  assert.equal(
    mod.normalizeSandboxCommandResult({ exitCode: 2, stdout: '', stderr: '' }).output,
    '',
  );
  assert.equal(
    mod.normalizeSandboxCommandResult({ exit_code: 0, timeout: true }).timedOut,
    true,
  );
  assert.equal(
    mod.normalizeSandboxCommandResult({ exit_code: 0, timedOut: true }).timedOut,
    true,
  );

  const executor = mod.createSandboxCommandExecutor(async (request) => ({
    exitCode: 0,
    output: `${request.command} @ ${request.cwd ?? ''}`,
  }));
  const result = await executor.exec({
    command: 'pwd',
    cwd: '/home/gem/workspace',
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'pwd @ /home/gem/workspace');
});

await test('command executor helpers wrap cwd and scrub command output', () => {
  assert.equal(mod.buildSandboxCommandLine({ command: 'pwd' }), 'pwd');
  assert.equal(
    mod.buildSandboxCommandLine({
      cwd: "/workspace path/with spaces'; rm -rf /",
      command: 'git status',
    }),
    "cd '/workspace path/with spaces'\\''; rm -rf /' && git status",
  );
  assert.equal(
    mod.scrubSandboxCommandOutput(
      'https://u:p@example.com/x Authorization: Basic abc Bearer secret.token',
    ),
    'https://***:***@example.com/x Authorization: Basic *** Bearer ***',
  );
  assert.equal(
    mod.normalizeSandboxCommandResult(
      {
        exit_code: 1,
        output: 'Authorization: Basic abc',
      },
      { scrubOutput: true },
    ).output,
    'Authorization: Basic ***',
  );
});

await test('provider descriptor accepts explicit capabilities for legacy providers', () => {
  const legacy = provider('legacy-local', undefined);
  const descriptor = mod.describeSandboxProvider({
    id: 'legacy-local',
    provider: legacy,
    location: 'local',
    capabilities: ['terminal.websocket'],
  });
  assert.deepEqual(descriptor.capabilities, ['terminal.websocket']);
});

await test('provider descriptor rejects undeclared adapters without explicit capabilities', () => {
  assert.throws(
    () =>
      mod.describeSandboxProvider({
        id: 'legacy-local',
        provider: provider('legacy-local', undefined),
        location: 'local',
      }),
    (err) =>
      err?.name === 'SandboxProviderConfigurationError' &&
      err?.code === 'sandbox_provider_configuration_error' &&
      /requires declared capabilities/.test(err.message),
  );
});

await test('provider-neutral environment metadata is carried by provision-shaped values', () => {
  const environment = {
    id: 'env-1',
    environmentId: 'env-1',
    name: 'internal tools',
    providerFamily: 'aio',
    runtimeId: 'codex',
    sourceKind: 'aio-docker-image',
    sourceRef: 'ghcr.io/example/cap-aio-sandbox:v1.2.3',
    digest: 'sha256:example',
    validationId: 'validation-1',
    validationVersion: '1',
    contractVersion: 'sandbox-contract-v1',
  };
  const context = {
    taskId: 'task-1',
    environment,
    cloneSpec: null,
  };
  const run = {
    taskId: 'task-1',
    providerId: 'aio-local',
    provider: provider('aio-local', ['terminal.websocket']),
    capabilities: ['terminal.websocket'],
    connection: {
      taskId: 'task-1',
      baseUrl: 'http://cap-aio-task-1:8080',
      wsUrl: 'ws://cap-aio-task-1:8080/v1/shell/ws',
    },
    environment,
    preflight: {
      status: 'passed',
      environment,
    },
    owner: {
      taskId: 'task-1',
      providerId: 'aio-local',
      status: 'running',
      environment,
    },
  };
  assert.equal(context.environment, environment);
  assert.equal(run.environment, environment);
  assert.equal(run.preflight.environment, environment);
  assert.equal(run.owner.environment, environment);
});

await test('resolved resource snapshots are copied, frozen, and capability-gated', () => {
  const mutable = { diskSizeGb: 8 };
  const snapshot = mod.snapshotSandboxResources(mutable);
  assert.deepEqual(snapshot, { diskSizeGb: 8 });
  assert.notEqual(snapshot, mutable);
  assert.equal(Object.isFrozen(snapshot), true);
  mutable.diskSizeGb = 16;
  assert.equal(snapshot.diskSizeGb, 8);
  const resolved = mod.resolveSandboxResources({
    explicit: { diskSizeGb: 12 },
    fallback: { diskSizeGb: 5 },
  });
  assert.deepEqual(resolved, { diskSizeGb: 12 });
  assert.equal(Object.isFrozen(resolved), true);
  assert.deepEqual(
    mod.resolveSandboxResources({ explicit: {}, fallback: { diskSizeGb: 5 } }),
    { diskSizeGb: 5 },
  );
  const policy = mod.snapshotSandboxProvisioningPolicy({
    resources: resolved,
    workspaceMaterializationDeadlineMs: 900_000,
  });
  assert.equal(Object.isFrozen(policy), true);
  assert.deepEqual(policy.resources, resolved);
  assert.equal(Object.isFrozen(policy.resources), true);
  assert.throws(
    () =>
      mod.snapshotSandboxProvisioningPolicy({
        workspaceMaterializationDeadlineMs: 999,
      }),
    /integer from 1000 to 86400000/,
  );
  assert.throws(
    () =>
      mod.snapshotSandboxProvisioningPolicy({
        workspaceMaterializationDeadlineMs: 86_400_001,
      }),
    /integer from 1000 to 86400000/,
  );
  assert.deepEqual(mod.sandboxResourceRequiredCapabilities(snapshot), [
    'resource.disk-size-gb',
  ]);
  assert.doesNotThrow(() =>
    mod.assertSandboxProviderSupportsResources(
      ['resource.disk-size-gb'],
      snapshot,
    ),
  );
  assert.throws(
    () => mod.assertSandboxProviderSupportsResources([], snapshot),
    (err) =>
      err?.name === 'SandboxProviderCapabilityError' &&
      err?.code === 'sandbox_provider_capability_error' &&
      err?.missingCapabilities?.[0] === 'resource.disk-size-gb',
  );
  assert.throws(
    () => mod.snapshotSandboxResources({ diskSizeGb: 0 }),
    /integer from 1 to 1024/,
  );
  assert.throws(
    () => mod.snapshotSandboxResources({ diskSizeGb: 1025 }),
    /integer from 1 to 1024/,
  );
  assert.throws(
    () => mod.snapshotSandboxResources({ diskSizeGb: 8, nativeMemoryMb: 1 }),
    /Unsupported sandbox resource snapshot keys: nativeMemoryMb/,
  );
  const capacityError = new mod.SandboxProvisioningCapacityError();
  assert.equal(capacityError.code, 'sandbox_provisioning_capacity_error');
  assert.equal(
    capacityError.message,
    'Sandbox provisioned capacity is below the resolved resource policy',
  );
  assert.equal(mod.isSandboxProvisioningCapacityError(capacityError), true);
  assert.equal(
    mod.isSandboxProvisioningCapacityError({
      code: 'sandbox_provisioning_capacity_error',
    }),
    true,
  );
  const stageError = new mod.SandboxProvisioningStageError('readiness');
  assert.equal(stageError.code, 'sandbox_provisioning_stage_error');
  assert.equal(stageError.stage, 'readiness');
  assert.equal(
    stageError.message,
    'Sandbox provisioning failed during readiness',
  );
  assert.equal(mod.isSandboxProvisioningStageError(stageError), true);
  assert.equal(
    mod.isSandboxProvisioningStageError({
      code: 'sandbox_provisioning_stage_error',
      stage: 'runtime_setup',
      diagnostic: 'must be ignored by orchestration',
    }),
    true,
  );
  assert.equal(
    mod.isSandboxProvisioningStageError({
      code: 'sandbox_provisioning_stage_error',
      stage: 'workspace_transfer',
    }),
    false,
  );
  const canary = 'secret-provider-diagnostic';
  const redacted = mod.redactSandboxProvisioningStageFailure(
    'runtime_setup',
    new Error(canary),
  );
  assert.equal(redacted.code, 'sandbox_provisioning_stage_error');
  assert.equal(redacted.stage, 'runtime_setup');
  assert.equal(redacted.message.includes(canary), false);
  const rehydrated = mod.redactSandboxProvisioningStageFailure('readiness', {
    code: 'sandbox_provisioning_stage_error',
    stage: 'runtime_setup',
    message: canary,
  });
  assert.equal(rehydrated.stage, 'runtime_setup');
  assert.equal(rehydrated.message.includes(canary), false);
});

await test('workspace plans keep caller intent separate from the resolved branch', () => {
  assert.deepEqual(mod.SANDBOX_WORKSPACE_MATERIALIZATION_STAGES, [
    'credential_setup',
    'remote_ref_resolution',
    'workspace_transfer',
    'checkout',
    'submodules',
    'credential_cleanup',
    'complete',
  ]);
  assert.deepEqual(mod.SANDBOX_WORKSPACE_FAILURE_CAUSES, [
    'capacity_exhausted',
    'timeout',
    'authentication',
    'tls_network',
    'ref_not_found',
    'unknown',
  ]);

  const credential = mod.createExactHostGitCredential(
    'https://code.example.test/org/repo.git',
    'Authorization: Basic workspace-plan-token',
  );
  const mutable = {
    repositoryUrl: 'https://code.example.test/org/repo.git',
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs: 900_000,
    credential,
  };
  const snapshot = mod.snapshotSandboxWorkspacePlan(mutable);
  assert.deepEqual(snapshot, mutable);
  assert.notEqual(snapshot, mutable);
  assert.equal(Object.isFrozen(snapshot), true);
  mutable.resolvedBranch = 'main';
  assert.equal(snapshot.callerBranch, null);
  assert.equal(snapshot.resolvedBranch, 'master');
  assert.equal(snapshot.credential, credential);

  const explicit = mod.snapshotSandboxWorkspacePlan({
    ...snapshot,
    callerBranch: 'release/next',
    resolvedBranch: 'release/next',
  });
  assert.equal(explicit.callerBranch, 'release/next');
  assert.throws(
    () => mod.snapshotSandboxWorkspacePlan({ ...snapshot, deadlineMs: 0 }),
    /deadlineMs must be a positive safe integer/,
  );
  assert.throws(
    () => mod.snapshotSandboxWorkspacePlan({ ...snapshot, resolvedBranch: '' }),
    /resolvedBranch must be non-empty/,
  );
  assert.throws(
    () =>
      mod.snapshotSandboxWorkspacePlan({
        ...snapshot,
        repositoryUrl: 'https://user:secret@example.test/repo.git',
      }),
    /must not contain userinfo/,
  );
  assert.throws(
    () =>
      mod.snapshotSandboxWorkspacePlan({
        ...snapshot,
        repositoryUrl: 'ssh://git@example.test/repo.git',
      }),
    /must use HTTP or HTTPS/,
  );
  assert.throws(
    () =>
      mod.snapshotSandboxWorkspacePlan({
        ...snapshot,
        repositoryUrl: 'https://example.test/repo.git?token=secret',
      }),
    /must not contain a query or fragment/,
  );
  assert.throws(
    () =>
      mod.snapshotSandboxWorkspacePlan({
        ...snapshot,
        callerBranch: ' master ',
      }),
    /callerBranch must be null or non-empty without surrounding whitespace/,
  );
  assert.throws(
    () =>
      mod.snapshotSandboxWorkspacePlan({
        ...snapshot,
        credential: mod.createExactHostGitCredential(
          'https://other.example.test/repo.git',
          'Authorization: Basic other-host-token',
        ),
      }),
    /credential must match the normalized repository scheme and host/,
  );
});

await test('exact-host credentials normalize scope and redact a unique canary', () => {
  const canary = 'CAP_SECRET_CANARY_2_2_f38d730a';
  const credential = mod.createExactHostGitCredential(
    'https://CODE.Example.TEST:443/org/repo.git',
    `Authorization: Basic ${canary}`,
  );

  assert.equal(credential.scheme, 'https');
  assert.equal(credential.host, 'code.example.test');
  assert.equal(credential.port, 443);
  assert.equal(credential.origin, 'https://code.example.test');
  assert.equal(credential.urlPrefix, 'https://code.example.test/');
  assert.equal(String(credential.authorizationHeader), '[REDACTED]');
  assert(!String(credential).includes(canary));
  assert(!JSON.stringify(credential).includes(canary));
  assert(!JSON.stringify({ ...credential }).includes(canary));
  assert.equal(Object.isFrozen(credential), true);
  assert.equal(Object.isFrozen(credential.authorizationHeader), true);

  const nonDefaultPort = mod.createExactHostGitCredential(
    'http://git.example.test:8080/org/repo.git',
    'Authorization: Basic safe-token',
  );
  assert.equal(nonDefaultPort.port, 8080);
  assert.equal(nonDefaultPort.origin, 'http://git.example.test:8080');
  assert.equal(nonDefaultPort.urlPrefix, 'http://git.example.test:8080/');

  for (const suffix of ['\rInjected: yes', '\nInjected: yes', '\0tail']) {
    assert.throws(
      () =>
        mod.createExactHostGitCredential(
          'https://code.example.test/org/repo.git',
          `Authorization: Basic ${canary}${suffix}`,
        ),
      /must not contain control characters/,
    );
  }
});

await test('secret-file port writes only through redacted provider-private input', async () => {
  const canary = 'CAP_SECRET_CANARY_2_2_56cb2d8e';
  const credential = mod.createExactHostGitCredential(
    'https://code.example.test/org/repo.git',
    `Authorization: Basic ${canary}`,
  );
  const writes = [];
  const deletes = [];
  let borrowedContent;
  const cancellation = new AbortController();
  const port = mod.createSandboxSecretFilePort({
    directory: '/run/cap/secrets',
    createId: () => 'fixture-1',
    transport: {
      async writeFile(request) {
        borrowedContent = request.content;
        writes.push({
          path: request.path,
          mode: request.mode,
          content: Buffer.from(request.content).toString('utf8'),
          signal: request.signal,
          keys: Object.keys(request),
          serialized: JSON.stringify(request),
          displayed: String(request),
        });
      },
      async deleteFile(request) {
        deletes.push({
          path: request.path,
          keys: Object.keys(request),
          serialized: JSON.stringify(request),
          displayed: String(request),
        });
      },
    },
  });

  const handle = await port.writeSecretFile({
    kind: 'git-http-credential',
    credential,
    signal: cancellation.signal,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/run/cap/secrets/cap-git-credential-fixture-1.config');
  assert.equal(writes[0].mode, 0o600);
  assert.equal(writes[0].signal, cancellation.signal);
  assert.deepEqual(writes[0].keys, []);
  assert(!writes[0].serialized.includes(canary));
  assert(!writes[0].displayed.includes(canary));
  assert.match(writes[0].content, /^\[credential\]\n\thelper =\n\tinteractive = never\n/);
  assert(writes[0].content.includes('[http]\n\tfollowRedirects = false\n'));
  assert(writes[0].content.includes('[http "https://code.example.test/"]'));
  assert(writes[0].content.includes(`extraHeader = "Authorization: Basic ${canary}"`));
  assert(!writes[0].content.includes('/org/repo.git'));
  assert(borrowedContent.every((value) => value === 0));

  assert.equal(handle.path, writes[0].path);
  assert.equal(handle.mode, 0o600);
  assert(!String(handle).includes(handle.path));
  assert(!JSON.stringify(handle).includes(handle.path));
  assert(!JSON.stringify(handle).includes(canary));
  assert.deepEqual(Object.keys(handle), ['kind', 'mode']);

  await port.deleteSecretFile(handle);
  await port.deleteSecretFile(handle);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].path, handle.path);
  assert.deepEqual(deletes[0].keys, []);
  assert(!deletes[0].serialized.includes(handle.path));
  assert(!deletes[0].displayed.includes(handle.path));
});

await test('secret-file port sanitizes transport failures and cleans partial writes', async () => {
  const canary = 'CAP_SECRET_CANARY_2_2_1b9145e6';
  const cleanup = [];
  const port = mod.createSandboxSecretFilePort({
    directory: '/run/cap/secrets',
    createId: () => 'failed-write',
    transport: {
      async writeFile() {
        throw new Error(`transport copied ${canary}`);
      },
      async deleteFile(request) {
        cleanup.push(request.path);
      },
    },
  });

  await assert.rejects(
    port.writeSecretFile({
      kind: 'git-http-credential',
      credential: mod.createExactHostGitCredential(
        'https://code.example.test/org/repo.git',
        `Authorization: Basic ${canary}`,
      ),
    }),
    (err) =>
      err?.code === 'sandbox_secret_file_operation_error' &&
      err?.operation === 'write' &&
      !err.message.includes(canary),
  );
  assert.deepEqual(cleanup, [
    '/run/cap/secrets/cap-git-credential-failed-write.config',
  ]);
});

await test('provision context normalization preserves legacy input and snapshots new facts', () => {
  const controller = new AbortController();
  const progress = () => undefined;
  const provisioningProgress = () => undefined;
  const provisioningBoundary = () => undefined;
  const externalBoundaryGuard = async () => undefined;
  const context = mod.snapshotSandboxProvisionContext({
    taskId: 'task-context',
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    environment: { resources: { diskSizeGb: 5 } },
    cloneSpec: { url: 'https://example.test/repo.git' },
    workspace: {
      repositoryUrl: 'https://example.test/repo.git',
      callerBranch: null,
      resolvedBranch: 'master',
      deadlineMs: 900_000,
    },
    cancellationSignal: controller.signal,
    onWorkspaceProgress: progress,
    onProvisioningProgress: provisioningProgress,
    beforeProvisioningBoundary: provisioningBoundary,
    externalBoundaryGuard,
  });

  assert.deepEqual(context.resources, { diskSizeGb: 5 });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.resources), true);
  assert.equal(Object.isFrozen(context.environment), true);
  assert.equal(context.environment.resources, context.resources);
  assert.equal(Object.isFrozen(context.workspace), true);
  assert.equal(context.cloneSpec.url, 'https://example.test/repo.git');
  assert.equal(context.cancellationSignal, controller.signal);
  assert.equal(context.onWorkspaceProgress, progress);
  assert.equal(context.onProvisioningProgress, provisioningProgress);
  assert.equal(context.beforeProvisioningBoundary, provisioningBoundary);
  assert.equal(context.externalBoundaryGuard, externalBoundaryGuard);
  assert.equal(mod.hasSandboxWorkspaceMaterialization(context), true);
  assert.equal(
    mod.hasSandboxWorkspaceMaterialization({
      workspace: null,
      cloneSpec: { url: 'https://legacy.example.test/repo.git' },
    }),
    false,
  );
});

await test('composite provisioning progress is immutable, nonblocking, and best-effort', async () => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let observed;
  assert.doesNotThrow(() =>
    mod.reportSandboxProvisioningProgress(async (event) => {
      observed = event;
      await barrier;
      throw new Error('progress-recorder-private-diagnostic');
    }, {
      status: 'started',
      stage: 'readiness',
    }),
  );
  assert.deepEqual(observed, { status: 'started', stage: 'readiness' });
  assert.equal(Object.isFrozen(observed), true);
  assert.doesNotThrow(() =>
    mod.reportSandboxProvisioningProgress(() => {
      throw new Error('synchronous-progress-recorder-failure');
    }, {
      status: 'started',
      stage: 'runtime_setup',
    }),
  );
  release();
  await Promise.resolve();
  await Promise.resolve();
});

await test('provider-neutral error types expose stable codes', () => {
  const config = new mod.SandboxProviderConfigurationError('bad config');
  assert.equal(config.name, 'SandboxProviderConfigurationError');
  assert.equal(config.code, 'sandbox_provider_configuration_error');

  const capability = new mod.SandboxProviderCapabilityError('missing', [
    'terminal.websocket',
  ]);
  assert.equal(capability.name, 'SandboxProviderCapabilityError');
  assert.equal(capability.code, 'sandbox_provider_capability_error');
  assert.deepEqual(capability.missingCapabilities, ['terminal.websocket']);

  const selection = new mod.SandboxProviderSelectionError('no provider');
  assert.equal(selection.name, 'SandboxProviderSelectionError');
  assert.equal(selection.code, 'sandbox_provider_selection_error');
});

await test('provider-neutral private archive contains one mode-0600 file', () => {
  const content = Buffer.from('archive-body-only');
  const archive = Buffer.from(
    mod.createSandboxMode0600FileArchive('credential.config', content),
  );
  assert.equal(archive.length % 512, 0);
  assert.equal(
    archive.toString('utf8', 0, 'credential.config'.length),
    'credential.config',
  );
  assert.equal(parseInt(archive.toString('ascii', 100, 107), 8), 0o600);
  assert.equal(parseInt(archive.toString('ascii', 124, 135), 8), content.length);
  assert.equal(
    archive.subarray(512, 512 + content.length).toString('utf8'),
    'archive-body-only',
  );
  assert.equal(archive.subarray(512 + content.length).every((byte) => byte === 0), true);
  assert.throws(
    () => mod.createSandboxMode0600FileArchive('../credential', content),
    /secret archive file name is invalid/u,
  );
});

await test('local and cloud helpers bind location metadata', () => {
  const localProvider = provider('aio-local', ['terminal.websocket']);
  const cloudProvider = provider('managed-cloud', ['terminal.websocket']);
  const local = mod.defineLocalSandboxProvider({
    id: 'local-aio',
    provider: localProvider,
    priority: 1,
  });
  const cloud = mod.defineCloudSandboxProvider({
    id: 'cloud-managed',
    provider: cloudProvider,
    priority: 2,
  });
  assert.equal(local.location, 'local');
  assert.equal(local.priority, 1);
  assert.equal(cloud.location, 'cloud');
  assert.equal(cloud.priority, 2);
});

await test('external-boundary runner fences actions before and after without projecting stages', async () => {
  const events = [];
  const value = await mod.runSandboxExternalBoundary({
    taskId: 'task-boundary',
    action: 'runtime.preflight',
    guard: async (event) => {
      events.push([event.action, event.position]);
      assert.equal('stage' in event, false);
    },
    run: async () => {
      events.push(['action', 'run']);
      return 42;
    },
  });

  assert.equal(value, 42);
  assert.deepEqual(events, [
    ['runtime.preflight', 'before'],
    ['action', 'run'],
    ['runtime.preflight', 'after'],
  ]);
});

await test('external-boundary after guard runs on action failure and remains load-bearing', async () => {
  const actionFailure = new Error('provider action failed');
  const leaseFailure = new Error('lease lost');
  const events = [];

  await assert.rejects(
    () =>
      mod.runSandboxExternalBoundary({
        taskId: 'task-boundary-failure',
        action: 'skills.preinstall',
        guard: async (event) => {
          events.push(event.position);
          if (event.position === 'after') throw leaseFailure;
        },
        run: async () => {
          events.push('action');
          throw actionFailure;
        },
      }),
    (error) => error === leaseFailure,
  );
  assert.deepEqual(events, ['before', 'action', 'after']);
});

await test('external-boundary before guard rejection prevents the action', async () => {
  const leaseFailure = new Error('lease lost before action');
  let actionCalls = 0;
  await assert.rejects(
    () =>
      mod.runSandboxExternalBoundary({
        taskId: 'task-boundary-before-failure',
        action: 'sandbox.create',
        guard: async () => {
          throw leaseFailure;
        },
        run: async () => {
          actionCalls += 1;
        },
      }),
    (error) => error === leaseFailure,
  );
  assert.equal(actionCalls, 0);
});

await test('external-boundary preserves the action error when the after guard succeeds', async () => {
  const actionFailure = new Error('provider action failed');
  await assert.rejects(
    () =>
      mod.runSandboxExternalBoundary({
        taskId: 'task-boundary-action-failure',
        action: 'runtime.setup',
        guard: async () => undefined,
        run: async () => {
          throw actionFailure;
        },
      }),
    (error) => error === actionFailure,
  );
});

await test('latched external-boundary guard preserves the first rejection', async () => {
  const leaseFailure = new Error('one-shot lease failure');
  let calls = 0;
  const guard = mod.latchSandboxExternalBoundaryGuard(async () => {
    calls += 1;
    if (calls === 1) throw leaseFailure;
  });

  await assert.rejects(
    guard({
      taskId: 'task-latched-boundary',
      action: 'command.execute',
      position: 'after',
    }),
    (error) => error === leaseFailure,
  );
  await assert.rejects(
    guard({
      taskId: 'task-latched-boundary',
      action: 'runtime.setup',
      position: 'after',
    }),
    (error) => error === leaseFailure,
  );
  assert.equal(calls, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
