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

await test('runtime command descriptors are strict, allowlisted, and ordered', () => {
  const setup = mod.validateSandboxRuntimeSetupCommandDescriptor(
    { commandKind: 'credential_setup', ordinal: 1 },
    1,
  );
  assert.deepEqual(setup, { commandKind: 'credential_setup', ordinal: 1 });
  assert.equal(Object.isFrozen(setup), true);
  assert.deepEqual(
    mod.validateSandboxRuntimePreflightCommandDescriptor(
      { commandKind: 'runtime_preflight', ordinal: 2 },
      2,
    ),
    { commandKind: 'runtime_preflight', ordinal: 2 },
  );
  const invalid = [
    { commandKind: 'runtime_setup', ordinal: 0 },
    { commandKind: 'provider-private-command', ordinal: 1 },
    { commandKind: 'runtime_setup', ordinal: 1, command: 'secret-canary' },
  ];
  for (const descriptor of invalid) {
    assert.throws(
      () => mod.validateSandboxRuntimeCommandDescriptor(descriptor),
      (error) =>
        error?.code === 'sandbox_command_classification_error' &&
        !error.message.includes('secret-canary'),
    );
  }
  assert.throws(
    () =>
      mod.validateSandboxRuntimePreflightCommandDescriptor(
        { commandKind: 'runtime_setup', ordinal: 1 },
        1,
      ),
    (error) => error?.code === 'sandbox_command_classification_error',
  );
  assert.throws(
    () =>
      mod.validateSandboxRuntimeSetupCommandDescriptor(
        { commandKind: 'credential_setup', ordinal: 2 },
        1,
      ),
    (error) => error?.code === 'sandbox_command_classification_error',
  );
});

await test('runtime command settlement classifies safe facts without raw material', async () => {
  const result = (exitCode, timedOut = false) => ({
    exitCode,
    output: 'CAP_COMMAND_OUTPUT_SECRET_CANARY',
    stdout: 'CAP_COMMAND_STDOUT_SECRET_CANARY',
    stderr: 'CAP_COMMAND_STDERR_SECRET_CANARY',
    timedOut,
  });
  const matrix = [
    [mod.classifySandboxCommandExecutionResult(result(0)), 'exit', 'succeeded'],
    [mod.classifySandboxCommandExecutionResult(result(7)), 'exit', 'failed'],
    [mod.classifySandboxCommandExecutionResult(result(0, true)), 'timeout', 'timed_out'],
    [mod.classifySandboxCommandExecutionResult(result(Number.NaN)), 'indeterminate', 'indeterminate'],
    [
      mod.classifySandboxCommandExecutionRejection(
        new mod.SandboxCommandSettlementError('failed_without_exit'),
      ),
      'failed_without_exit',
      'failed',
    ],
    [
      mod.classifySandboxCommandExecutionRejection(
        new mod.SandboxCommandSettlementError('protocol'),
      ),
      'protocol',
      'failed',
    ],
    [
      mod.classifySandboxCommandExecutionRejection(
        new mod.SandboxCommandSettlementError('indeterminate'),
      ),
      'indeterminate',
      'indeterminate',
    ],
    [
      mod.classifySandboxCommandExecutionRejection(
        Object.assign(new Error('CAP_RAW_ERROR_SECRET_CANARY'), {
          name: 'AbortError',
        }),
      ),
      'cancellation',
      'cancelled',
    ],
    [
      mod.classifySandboxCommandExecutionRejection(
        Object.assign(new Error('CAP_RAW_ERROR_SECRET_CANARY'), {
          name: 'TimeoutError',
        }),
      ),
      'timeout',
      'timed_out',
    ],
    [
      mod.classifySandboxCommandExecutionRejection(
        new Error('CAP_RAW_ERROR_SECRET_CANARY'),
      ),
      'transport',
      'failed',
    ],
  ];
  for (const [classification, settlement, outcome] of matrix) {
    assert.equal(classification.settlement, settlement);
    assert.equal(classification.outcome, outcome);
    assert.equal(Object.isFrozen(classification), true);
    const serialized = JSON.stringify(classification);
    assert(!serialized.includes('SECRET_CANARY'));
    assert(!('command' in classification));
    assert(!('output' in classification));
    assert(!('error' in classification));
    const diagnosticFields = mod.sandboxCommandExecutionDiagnosticFields(
      classification,
    );
    assert(!('settlement' in diagnosticFields));
    assert.equal(Object.isFrozen(diagnosticFields), true);
    assert.deepEqual(
      mod.validateSandboxProvisioningDiagnosticFact({
        operationId: '55555555-5555-4555-8555-555555555555',
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        channel: 'primary',
        commandKind: 'runtime_setup',
        ...diagnosticFields,
      }),
      {
        operationId: '55555555-5555-4555-8555-555555555555',
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        channel: 'primary',
        commandKind: 'runtime_setup',
        ...diagnosticFields,
      },
    );
  }

  const failedWithoutExit = mod.classifySandboxCommandExecutionRejection(
    new mod.SandboxCommandSettlementError('failed_without_exit'),
  );
  assert.deepEqual(failedWithoutExit, {
    settlement: 'failed_without_exit',
    outcome: 'failed',
    cause: 'missing_exit_code',
    retryable: false,
    exitCode: null,
    anomaly: 'missing_exit_code',
  });
  assert.deepEqual(
    mod.sandboxCommandExecutionDiagnosticFields(failedWithoutExit),
    {
      outcome: 'failed',
      cause: 'missing_exit_code',
      retryable: false,
      exitCode: null,
      anomaly: 'missing_exit_code',
    },
  );

  let observedRuntimeRequest;
  const safe = await mod.classifySandboxRuntimeCommandExecution({
    executor: {
      exec: async (request) => {
        observedRuntimeRequest = request;
        return result(4);
      },
    },
    request: {
      command: 'CAP_COMMAND_TEXT_SECRET_CANARY',
      cwd: '/CAP/PATH/SECRET/CANARY',
    },
    descriptor: { commandKind: 'runtime_setup', ordinal: 1 },
  });
  assert.deepEqual(observedRuntimeRequest?.diagnosticDescriptor, {
    commandKind: 'runtime_setup',
    ordinal: 1,
  });
  assert.deepEqual(safe, {
    settlement: 'exit',
    outcome: 'failed',
    cause: 'command_failed',
    retryable: false,
    exitCode: 4,
  });
  assert(!JSON.stringify(safe).includes('SECRET_CANARY'));

  const error = new mod.SandboxRuntimeCommandExecutionError(
    { commandKind: 'runtime_setup', ordinal: 1 },
    safe,
  );
  assert.equal(mod.isSandboxRuntimeCommandExecutionError(error), true);
  assert(!error.message.includes('SECRET_CANARY'));
  assert(!JSON.stringify(error).includes('SECRET_CANARY'));
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

const diagnosticIds = {
  taskId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  eventId: '44444444-4444-4444-8444-444444444444',
};

function diagnosticAttemptContext(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: diagnosticIds.taskId,
    attemptId: diagnosticIds.attemptId,
    attempt: 2,
    admissionMode: 'durable',
    providerFamily: 'unknown',
    ...overrides,
  };
}

function startedDiagnosticFact(overrides = {}) {
  return {
    operationId: diagnosticIds.operationId,
    stage: 'provider_selection',
    operation: 'provider_select',
    channel: 'primary',
    outcome: 'started',
    ...overrides,
  };
}

function terminalDiagnosticFact(overrides = {}) {
  return {
    operationId: diagnosticIds.operationId,
    stage: 'provider_selection',
    operation: 'provider_select',
    channel: 'primary',
    outcome: 'failed',
    durationMs: 25,
    cause: 'missing_exit_code',
    retryable: false,
    httpStatusClass: null,
    nativeState: 'failed',
    anomaly: 'missing_exit_code',
    exitCode: null,
    timeoutMs: null,
    ...overrides,
  };
}

function indexedDiagnosticUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

await test('diagnostic emitter injects strict task correlation and serial identities', async () => {
  const recorded = [];
  const observedAt = new Date('2026-07-17T04:00:00.000Z');
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async (event) => {
      recorded.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
    createEventId: () => diagnosticIds.eventId,
    createOperationId: () => diagnosticIds.operationId,
    now: () => observedAt,
  });

  assert.equal(Object.isFrozen(emitter), true);
  assert.equal(emitter.mode, 'task');
  assert.equal(emitter.createOperationId(), diagnosticIds.operationId);
  assert.equal(Object.isFrozen(emitter.attemptContext), true);
  assert.equal(emitter.attemptContext.providerFamily, 'unknown');
  emitter.bindProviderFamily('boxlite');
  emitter.bindProviderFamily('boxlite');
  assert.equal(emitter.attemptContext.providerFamily, 'boxlite');
  assert.throws(
    () => emitter.bindProviderFamily('aio'),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );

  await emitter.emit(startedDiagnosticFact());
  await assert.rejects(
    emitter.emit(
      terminalDiagnosticFact({ operation: 'native_exec_settlement' }),
    ),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
  await emitter.emit(terminalDiagnosticFact());
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded[0], {
    schemaVersion: 1,
    eventId: diagnosticIds.eventId,
    idempotencyKey: `${diagnosticIds.operationId}:started`,
    taskId: diagnosticIds.taskId,
    attemptId: diagnosticIds.attemptId,
    attempt: 2,
    sequence: 1,
    operationId: diagnosticIds.operationId,
    admissionMode: 'durable',
    providerFamily: 'boxlite',
    stage: 'provider_selection',
    operation: 'provider_select',
    channel: 'primary',
    observedAt,
    outcome: 'started',
  });
  assert.equal(Object.isFrozen(recorded[0]), true);
  assert.equal(recorded[0].observedAt === observedAt, false);
  assert.equal(recorded[1].sequence, 2);
  assert.equal(recorded[1].idempotencyKey, `${diagnosticIds.operationId}:terminal`);
  assert.equal(recorded[1].channel, 'primary');
  assert.equal(recorded[1].anomaly, 'missing_exit_code');
  assert(!Object.hasOwn(recorded[0], 'cause'));
  assert(!Object.hasOwn(recorded[1], 'command'));
  assert(!Object.hasOwn(recorded[1], 'output'));

  await emitter.emit(startedDiagnosticFact());
  assert.equal(recorded.length, 2, 'same fact is locally idempotent');
  await assert.rejects(
    emitter.emit(startedDiagnosticFact({ stage: 'accepted' })),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );

  const runtimeOperationId = indexedDiagnosticUuid(10);
  await emitter.emit(
    startedDiagnosticFact({
      operationId: runtimeOperationId,
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      commandKind: 'runtime_setup',
    }),
  );
  await emitter.emit(
    terminalDiagnosticFact({
      operationId: runtimeOperationId,
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      commandKind: 'runtime_setup',
      outcome: 'succeeded',
      cause: null,
      nativeState: undefined,
      anomaly: undefined,
      exitCode: 0,
    }),
  );
  assert.equal(recorded[2].commandKind, 'runtime_setup');
  assert.equal(recorded[3].commandKind, 'runtime_setup');
});

await test('diagnostic workspace replay keys reuse ids only within one observer', () => {
  let taskIds = 20;
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async (event) => ({ kind: 'recorded', sequence: event.sequence }),
    createOperationId: () => indexedDiagnosticUuid(taskIds++),
  });
  const setup = emitter.createOperationId('workspace.credential_setup');
  assert.equal(
    emitter.createOperationId('workspace.credential_setup'),
    setup,
  );
  assert.notEqual(
    emitter.createOperationId('workspace.workspace_transfer'),
    setup,
  );
  assert.equal(taskIds, 22);
  assert.throws(
    () => emitter.createOperationId('workspace.provider-private'),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );

  let probeIds = 30;
  const taskless =
    mod.createNonPersistingSandboxProvisioningDiagnosticObserver({
      createOperationId: () => indexedDiagnosticUuid(probeIds++),
    });
  const cleanup = taskless.createOperationId('workspace.credential_cleanup');
  assert.equal(
    taskless.createOperationId('workspace.credential_cleanup'),
    cleanup,
  );
  assert.notEqual(taskless.createOperationId('workspace.checkout'), cleanup);
  assert.equal(probeIds, 32);
});

await test('diagnostic emitter preserves sequence across duplicate and failed recorder writes', async () => {
  const sequences = [];
  const results = [
    { kind: 'duplicate', sequence: 2 },
    new Error('diagnostic store unavailable'),
    { kind: 'recorded', sequence: 5 },
    { kind: 'duplicate', sequence: 6 },
    { kind: 'recorded', sequence: 7 },
  ];
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext({ providerFamily: 'aio' }),
    initialSequence: 4,
    record: async (event) => {
      sequences.push(event.sequence);
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  });

  await emitter.emit(startedDiagnosticFact());
  const second = terminalDiagnosticFact({
    operationId: indexedDiagnosticUuid(7),
    commandKind: undefined,
    httpStatusClass: undefined,
    exitCode: undefined,
    timeoutMs: undefined,
  });
  await assert.rejects(emitter.emit(second), /diagnostic store unavailable/);
  await emitter.emit(second);
  await emitter.emit(
    startedDiagnosticFact({ operationId: indexedDiagnosticUuid(8) }),
  );
  await emitter.emit(
    startedDiagnosticFact({ operationId: indexedDiagnosticUuid(9) }),
  );
  assert.deepEqual(sequences, [5, 5, 5, 6, 7]);
});

await test('diagnostic flush waits for the accepted recorder tail', async () => {
  let releaseRecord;
  let markRecorderEntered;
  const recorderEntered = new Promise((resolve) => {
    markRecorderEntered = resolve;
  });
  const recordReleased = new Promise((resolve) => {
    releaseRecord = resolve;
  });
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async (event) => {
      markRecorderEntered();
      await recordReleased;
      return { kind: 'recorded', sequence: event.sequence };
    },
  });

  const emission = emitter.emit(startedDiagnosticFact());
  await recorderEntered;
  let flushed = false;
  const flush = emitter.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  assert.equal(flushed, false, 'flush must wait for the recorder barrier');

  releaseRecord();
  await emission;
  await flush;
  assert.equal(flushed, true);
});

await test('diagnostic flush absorbs recorder failure as non-authoritative evidence', async () => {
  const recorderFailure = new Error('diagnostic recorder unavailable');
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async () => {
      throw recorderFailure;
    },
  });

  const failedEmission = assert.rejects(
    emitter.emit(startedDiagnosticFact()),
    (error) => error === recorderFailure,
  );
  await assert.doesNotReject(emitter.flush());
  await failedEmission;
});

await test('diagnostic boundary rejects raw fields and unsafe fact shapes without echoing them', async () => {
  const forbidden = [
    'command',
    'argv',
    'stdout',
    'stderr',
    'output',
    'prompt',
    'requestBody',
    'responseBody',
    'headers',
    'url',
    'endpoint',
    'credentialPath',
    'token',
    'environment',
    'providerResourceId',
    'providerExecutionId',
    'leaseOwner',
    'stack',
    'message',
    'metadata',
    'taskId',
    'eventId',
    'observedAt',
  ];
  let recordCalls = 0;
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async (event) => {
      recordCalls += 1;
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  const canary = 'CAP_DIAGNOSTIC_SECRET_CANARY';
  for (const field of forbidden) {
    await assert.rejects(
      emitter.emit({ ...startedDiagnosticFact(), [field]: canary }),
      (error) =>
        error?.code === 'sandbox_provisioning_diagnostic_validation_error' &&
        !error.message.includes(canary),
    );
  }
  const invalidFacts = [
    null,
    [],
    new Date(),
    (({ outcome: _outcome, ...withoutOutcome }) => withoutOutcome)(
      startedDiagnosticFact(),
    ),
    startedDiagnosticFact({ operationId: 'not-a-uuid' }),
    startedDiagnosticFact({ outcome: 'success' }),
    startedDiagnosticFact({ stage: 'provider-private-stage' }),
    startedDiagnosticFact({ operation: 'raw-command' }),
    startedDiagnosticFact({ channel: 'secondary' }),
    startedDiagnosticFact({ commandKind: 'shell' }),
    startedDiagnosticFact({ cause: 'unknown' }),
    terminalDiagnosticFact({ cause: undefined }),
    terminalDiagnosticFact({ cause: 'provider-message' }),
    terminalDiagnosticFact({ retryable: 'yes' }),
    terminalDiagnosticFact({ durationMs: -1 }),
    terminalDiagnosticFact({ durationMs: Number.MAX_VALUE }),
    terminalDiagnosticFact({ httpStatusClass: '404' }),
    terminalDiagnosticFact({ nativeState: 'terminated' }),
    terminalDiagnosticFact({ anomaly: 'provider_error' }),
    terminalDiagnosticFact({ exitCode: 1.5 }),
    terminalDiagnosticFact({ timeoutMs: 0 }),
  ];
  for (const invalid of invalidFacts) {
    await assert.rejects(
      emitter.emit(invalid),
      (error) =>
        error?.code === 'sandbox_provisioning_diagnostic_validation_error',
    );
  }
  assert.equal(recordCalls, 0);
});

await test('diagnostic emitter enforces the shared per-attempt bound', async () => {
  let recordCalls = 0;
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext({ providerFamily: 'cloud-http' }),
    record: async (event) => {
      recordCalls += 1;
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  for (let index = 1; index <= 32; index += 1) {
    const operationId = indexedDiagnosticUuid(index);
    await emitter.emit(startedDiagnosticFact({ operationId }));
    await emitter.emit(
      terminalDiagnosticFact({
        operationId,
        commandKind: undefined,
        outcome: 'succeeded',
        durationMs: undefined,
        cause: null,
        nativeState: undefined,
        anomaly: undefined,
        exitCode: 0,
      }),
    );
  }
  assert.equal(
    recordCalls,
    mod.SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
  );
  await emitter.emit(startedDiagnosticFact({ operationId: indexedDiagnosticUuid(1) }));
  assert.equal(recordCalls, 64, 'known replay does not consume the bound');
  await assert.rejects(
    emitter.emit(startedDiagnosticFact({ operationId: indexedDiagnosticUuid(99) })),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
  assert.equal(recordCalls, 64, 'overflow is rejected before recorder side effects');
});

await test('diagnostic emitter reserves the final slot for an accepted start terminal', async () => {
  const recorded = [];
  let recordCalls = 0;
  let failTerminalOnce = true;
  const finalOperationId = indexedDiagnosticUuid(32);
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext({ providerFamily: 'boxlite' }),
    record: async (event) => {
      recordCalls += 1;
      if (
        failTerminalOnce &&
        event.operationId === finalOperationId &&
        event.outcome !== 'started'
      ) {
        failTerminalOnce = false;
        throw new Error('diagnostic store unavailable at reserved terminal');
      }
      recorded.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
  });

  for (let index = 1; index <= 31; index += 1) {
    const operationId = indexedDiagnosticUuid(index);
    await emitter.emit(startedDiagnosticFact({ operationId }));
    await emitter.emit(
      terminalDiagnosticFact({
        operationId,
        commandKind: undefined,
        outcome: 'succeeded',
        durationMs: undefined,
        cause: null,
        nativeState: undefined,
        anomaly: undefined,
        exitCode: 0,
      }),
    );
  }

  const finalStart = startedDiagnosticFact({
    operationId: finalOperationId,
  });
  const finalTerminal = terminalDiagnosticFact({
    operationId: finalOperationId,
    commandKind: undefined,
    outcome: 'succeeded',
    durationMs: undefined,
    cause: null,
    nativeState: undefined,
    anomaly: undefined,
    exitCode: 0,
  });
  await emitter.emit(finalStart);
  assert.equal(recorded.at(-1).sequence, 63);

  for (const unrelated of [
    startedDiagnosticFact({ operationId: indexedDiagnosticUuid(99) }),
    terminalDiagnosticFact({ operationId: indexedDiagnosticUuid(98) }),
  ]) {
    await assert.rejects(
      emitter.emit(unrelated),
      (error) =>
        error?.code === 'sandbox_provisioning_diagnostic_validation_error',
    );
  }
  assert.equal(recordCalls, 63, 'unrelated facts cannot steal the terminal slot');

  await assert.rejects(
    emitter.emit(finalTerminal),
    /diagnostic store unavailable at reserved terminal/,
  );
  assert.equal(recordCalls, 64);
  await assert.rejects(
    emitter.emit(
      terminalDiagnosticFact({ operationId: indexedDiagnosticUuid(97) }),
    ),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
  assert.equal(
    recordCalls,
    64,
    'recorder failure keeps the reserved slot unavailable to other facts',
  );

  await emitter.emit(finalTerminal);
  assert.equal(recordCalls, 65, 'the exact terminal retries the recorder');
  assert.equal(recorded.length, 64);
  assert.deepEqual(
    recorded.map((event) => event.sequence),
    Array.from({ length: 64 }, (_value, index) => index + 1),
  );

  await emitter.emit(finalStart);
  await emitter.emit(finalTerminal);
  assert.equal(recordCalls, 65, 'accepted phase replay remains local');
});

await test('taskless diagnostic observer validates but cannot persist task evidence', async () => {
  const observer = mod.createNonPersistingSandboxProvisioningDiagnosticObserver({
    createOperationId: () => diagnosticIds.operationId,
  });
  assert.equal(observer.mode, 'non-persisting');
  assert.equal(Object.isFrozen(observer), true);
  assert.equal(observer.createOperationId(), diagnosticIds.operationId);
  assert.equal(Object.hasOwn(observer, 'attemptContext'), false);
  assert.equal(Object.hasOwn(observer, 'record'), false);
  await observer.flush();
  await observer.emit(startedDiagnosticFact());
  await observer.emit(startedDiagnosticFact());
  await observer.emit(terminalDiagnosticFact());
  await assert.rejects(
    observer.emit(terminalDiagnosticFact({ outcome: 'timed_out' })),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
  await assert.rejects(
    observer.emit({ ...startedDiagnosticFact(), responseBody: 'secret-canary' }),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );

  const bounded = mod.createNonPersistingSandboxProvisioningDiagnosticObserver();
  for (let index = 1; index <= 31; index += 1) {
    const operationId = indexedDiagnosticUuid(index);
    await bounded.emit(startedDiagnosticFact({ operationId }));
    await bounded.emit(
      terminalDiagnosticFact({
        operationId,
        commandKind: undefined,
        outcome: 'succeeded',
        durationMs: undefined,
        cause: null,
        nativeState: undefined,
        anomaly: undefined,
        exitCode: 0,
      }),
    );
  }
  const reservedOperationId = indexedDiagnosticUuid(32);
  const reservedStart = startedDiagnosticFact({
    operationId: reservedOperationId,
  });
  const reservedTerminal = terminalDiagnosticFact({
    operationId: reservedOperationId,
    commandKind: undefined,
    outcome: 'succeeded',
    durationMs: undefined,
    cause: null,
    nativeState: undefined,
    anomaly: undefined,
    exitCode: 0,
  });
  await bounded.emit(reservedStart);
  for (const unrelated of [
    startedDiagnosticFact({ operationId: indexedDiagnosticUuid(99) }),
    terminalDiagnosticFact({ operationId: indexedDiagnosticUuid(98) }),
  ]) {
    await assert.rejects(
      bounded.emit(unrelated),
      (error) =>
        error?.code === 'sandbox_provisioning_diagnostic_validation_error',
    );
  }
  await bounded.emit(reservedTerminal);
  await bounded.emit(reservedStart);
  await bounded.emit(reservedTerminal);
  await assert.rejects(
    bounded.emit(
      terminalDiagnosticFact({ operationId: indexedDiagnosticUuid(97) }),
    ),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
});

await test('diagnostic attempt context and emitter dependencies fail closed', async () => {
  const invalidContexts = [
    null,
    [],
    new Date(),
    diagnosticAttemptContext({ schemaVersion: 2 }),
    diagnosticAttemptContext({ taskId: 'task-1' }),
    diagnosticAttemptContext({ attemptId: 'attempt-1' }),
    diagnosticAttemptContext({ attempt: 0 }),
    diagnosticAttemptContext({ attempt: 1.5 }),
    diagnosticAttemptContext({ admissionMode: 'worker' }),
    diagnosticAttemptContext({ providerFamily: 'custom' }),
    { ...diagnosticAttemptContext(), metadata: { raw: true } },
  ];
  for (const attemptContext of invalidContexts) {
    assert.throws(
      () =>
        mod.createSandboxProvisioningDiagnosticEmitter({
          attemptContext,
          record: async (event) => ({ kind: 'recorded', sequence: event.sequence }),
        }),
      (error) =>
        error?.code === 'sandbox_provisioning_diagnostic_validation_error',
    );
  }
  for (const initialSequence of [-1, 65, 1.5]) {
    assert.throws(
      () =>
        mod.createSandboxProvisioningDiagnosticEmitter({
          attemptContext: diagnosticAttemptContext(),
          initialSequence,
          record: async (event) => ({ kind: 'recorded', sequence: event.sequence }),
        }),
      (error) =>
        error?.code === 'sandbox_provisioning_diagnostic_validation_error',
    );
  }
  assert.throws(
    () =>
      mod.createSandboxProvisioningDiagnosticEmitter({
        attemptContext: diagnosticAttemptContext(),
        record: null,
      }),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );

  const invalidEventId = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async (event) => ({ kind: 'recorded', sequence: event.sequence }),
    createEventId: () => 'invalid-event-id',
  });
  await assert.rejects(
    invalidEventId.emit(startedDiagnosticFact()),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
  const invalidTime = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async (event) => ({ kind: 'recorded', sequence: event.sequence }),
    now: () => new Date('invalid'),
  });
  await assert.rejects(
    invalidTime.emit(startedDiagnosticFact()),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
  const invalidResult = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async () => ({ kind: 'ignored', sequence: 1 }),
  });
  await assert.rejects(
    invalidResult.emit(startedDiagnosticFact()),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
  const invalidRecordedSequence =
    mod.createSandboxProvisioningDiagnosticEmitter({
      attemptContext: diagnosticAttemptContext(),
      initialSequence: 1,
      record: async () => ({ kind: 'recorded', sequence: 1 }),
    });
  await assert.rejects(
    invalidRecordedSequence.emit(startedDiagnosticFact()),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
  const invalidOperationId = mod.createNonPersistingSandboxProvisioningDiagnosticObserver({
    createOperationId: () => 'invalid-operation-id',
  });
  assert.throws(
    () => invalidOperationId.createOperationId(),
    (error) =>
      error?.code === 'sandbox_provisioning_diagnostic_validation_error',
  );
});

await test('provision context carries diagnostics without breaking legacy callers', () => {
  const diagnostics = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: diagnosticAttemptContext(),
    record: async (event) => ({ kind: 'recorded', sequence: event.sequence }),
  });
  const context = mod.snapshotSandboxProvisionContext({
    taskId: diagnosticIds.taskId,
    diagnostics,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'headless-exec',
  });
  assert.equal(context.diagnostics, diagnostics);
  assert.equal(context.diagnostics.mode, 'task');
  const legacy = mod.snapshotSandboxProvisionContext({
    taskId: 'legacy-task',
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'headless-exec',
  });
  assert.equal(legacy.diagnostics, undefined);
});

await test('physical cleanup seam preserves primary and reduces cleanup to safe secondary facts', async () => {
  const primary = new Error('primary workspace failure');
  const confirmed = await mod.runSandboxPhysicalCleanup(async () => ({
    kind: 'found-and-cleaned',
  }));
  const combined = mod.preserveSandboxPrimaryWithCleanup(primary, confirmed);
  assert.equal(combined.primary, primary);
  assert.deepEqual(combined.cleanup, {
    outcome: 'succeeded',
    proof: 'found-and-cleaned',
    cause: null,
    retryable: false,
  });
  assert.equal(Object.isFrozen(combined), true);
  assert.equal(Object.isFrozen(combined.cleanup), true);

  const canary = 'CAP_CLEANUP_PRIVATE_ERROR_CANARY';
  const rejected = await mod.runSandboxPhysicalCleanup(async () => {
    throw new Error(`${canary} https://provider.invalid/private`);
  });
  assert.deepEqual(rejected, {
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
  });
  assert.equal(JSON.stringify(rejected).includes(canary), false);

  const definitive = await mod.runSandboxPhysicalCleanup(async () => ({
    outcome: 'failed',
    proof: null,
    cause: 'cleanup_failed',
    retryable: false,
  }));
  assert.deepEqual(definitive, {
    outcome: 'failed',
    proof: null,
    cause: 'cleanup_failed',
    retryable: false,
  });

  const unconfirmed = await mod.runSandboxPhysicalCleanup(async () => undefined);
  assert.deepEqual(unconfirmed, {
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
  });

  const coordination = new mod.SandboxCleanupCoordinationPendingError();
  await assert.rejects(
    mod.runSandboxPhysicalCleanup(async () => {
      throw coordination;
    }),
    (error) => error === coordination,
    'cleanup authority failures must not be downgraded to physical evidence',
  );
});

await test('cleanup evidence is strict, bounded, and cannot accept raw provider material', () => {
  const observedAt = new Date('2026-07-17T08:00:00.000Z');
  const attemptId = '77777777-7777-4777-8777-777777777777';
  const evidence = mod.sandboxCleanupAttemptEvidence(
    2,
    attemptId,
    {
      outcome: 'indeterminate',
      proof: null,
      cause: 'cleanup_unconfirmed',
      retryable: true,
    },
    observedAt,
  );
  assert.deepEqual(evidence, {
    attemptId,
    attempt: 2,
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
    observedAt,
  });
  assert.notEqual(evidence.observedAt, observedAt);
  assert.equal(Object.isFrozen(evidence), true);

  for (const invalid of [
    { ...evidence, attempt: 0 },
    { ...evidence, attempt: 1.5 },
    { ...evidence, attempt: mod.SANDBOX_CLEANUP_ATTEMPT_MAX + 1 },
    { ...evidence, attemptId: 'provider-native-id' },
    { ...evidence, cause: 'cleanup_failed' },
    { ...evidence, proof: 'already-absent' },
    { ...evidence, retryable: false },
    { ...evidence, outcome: 'provider-error' },
    { ...evidence, observedAt: new Date('invalid') },
    { ...evidence, providerResourceId: 'raw-id' },
    { ...evidence, message: 'secret-canary' },
  ]) {
    assert.throws(
      () => mod.validateSandboxCleanupAttemptEvidence(invalid),
      (error) => error?.code === 'sandbox_cleanup_result_validation_error',
    );
  }
  assert.throws(
    () =>
      mod.validateSandboxPhysicalCleanupResult({
        outcome: 'failed',
        proof: null,
        cause: 'cleanup_failed',
        retryable: true,
        responseBody: 'secret-canary',
      }),
    (error) =>
      error?.code === 'sandbox_cleanup_result_validation_error' &&
      !error.message.includes('secret-canary'),
  );

  const coordination = new mod.SandboxCleanupCoordinationPendingError(
    'exact-primary',
  );
  assert.equal(coordination.code, 'sandbox_cleanup_coordination_pending');
  assert.equal(coordination.primary, 'exact-primary');
  assert.equal(JSON.stringify(coordination).includes('exact-primary'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
