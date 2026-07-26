import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

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

const cleanupAttemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

await test('cleanup placeholders round-trip strict durable evidence', () => {
  const observedAt = new Date('2026-07-25T00:00:00.000Z');
  const placeholder = mod.sandboxCleanupAttemptPlaceholder(
    3,
    cleanupAttemptId,
    observedAt,
  );
  assert.deepEqual(placeholder, {
    attemptId: cleanupAttemptId,
    attempt: 3,
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
    observedAt,
  });
  assert.notEqual(placeholder.observedAt, observedAt);
  assert.deepEqual(mod.sandboxPhysicalCleanupResultFromEvidence(placeholder), {
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
  });

  for (const result of [
    {
      outcome: 'succeeded',
      proof: 'found-and-cleaned',
      cause: null,
      retryable: false,
    },
    {
      outcome: 'succeeded',
      proof: 'already-absent',
      cause: null,
      retryable: false,
    },
    {
      outcome: 'failed',
      proof: null,
      cause: 'cleanup_failed',
      retryable: false,
    },
    {
      outcome: 'failed',
      proof: null,
      cause: 'cleanup_failed',
      retryable: true,
    },
  ]) {
    const evidence = mod.sandboxCleanupAttemptEvidence(
      1,
      cleanupAttemptId,
      result,
      observedAt,
    );
    assert.deepEqual(mod.sandboxPhysicalCleanupResultFromEvidence(evidence), result);
  }
});

await test('cleanup normalization requires affirmative exact proof', () => {
  assert.deepEqual(
    mod.normalizeSandboxPhysicalCleanupResult({ kind: 'already-absent' }),
    {
      outcome: 'succeeded',
      proof: 'already-absent',
      cause: null,
      retryable: false,
    },
  );
  for (const malformed of [
    null,
    [],
    { kind: 'found-and-cleaned', extra: true },
    { kind: 'already-absent', extra: true },
    { kind: 'unknown' },
    { outcome: 'failed' },
  ]) {
    assert.deepEqual(mod.normalizeSandboxPhysicalCleanupResult(malformed), {
      outcome: 'indeterminate',
      proof: null,
      cause: 'cleanup_unconfirmed',
      retryable: true,
    });
  }
  assert.deepEqual(
    mod.classifySandboxPhysicalCleanupRejection(
      new mod.SandboxCleanupPendingError(),
    ),
    {
      outcome: 'indeterminate',
      proof: null,
      cause: 'cleanup_unconfirmed',
      retryable: true,
    },
  );
  assert.deepEqual(mod.classifySandboxPhysicalCleanupRejection('private error'), {
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
  });
});

await test('cleanup validators reject each malformed proof shape without data leakage', () => {
  const invalid = [
    null,
    [],
    Object.create({ outcome: 'succeeded' }),
    { outcome: 'succeeded', proof: null, cause: null, retryable: false },
    {
      outcome: 'succeeded',
      proof: 'found-and-cleaned',
      cause: 'cleanup_failed',
      retryable: false,
    },
    {
      outcome: 'succeeded',
      proof: 'found-and-cleaned',
      cause: null,
      retryable: true,
    },
    {
      outcome: 'failed',
      proof: 'already-absent',
      cause: 'cleanup_failed',
      retryable: false,
    },
    { outcome: 'failed', proof: null, cause: null, retryable: false },
    {
      outcome: 'failed',
      proof: null,
      cause: 'cleanup_failed',
      retryable: 'yes',
    },
    {
      outcome: 'indeterminate',
      proof: 'already-absent',
      cause: 'cleanup_unconfirmed',
      retryable: true,
    },
    { outcome: 'indeterminate', proof: null, cause: null, retryable: true },
    {
      outcome: 'indeterminate',
      proof: null,
      cause: 'cleanup_unconfirmed',
      retryable: false,
    },
    { outcome: 'unknown', proof: null, cause: null, retryable: false },
  ];
  for (const value of invalid) {
    assert.throws(
      () => mod.validateSandboxPhysicalCleanupResult(value),
      (error) => error?.code === 'sandbox_cleanup_result_validation_error',
    );
  }
  assert.throws(
    () => mod.validateSandboxCleanupAttemptId(null),
    (error) => error?.code === 'sandbox_cleanup_result_validation_error',
  );
});

await test('provider-neutral control errors preserve only safe structured facts', () => {
  const pending = new mod.SandboxCleanupPendingError();
  assert.equal(pending.code, 'sandbox_cleanup_pending');
  assert.equal(
    pending.message,
    'Sandbox cleanup is pending settlement of an in-flight create',
  );
  assert.equal(mod.isSandboxCleanupCoordinationPendingError(null), false);
  assert.equal(
    mod.isSandboxCleanupCoordinationPendingError({
      code: 'sandbox_cleanup_coordination_pending',
    }),
    true,
  );
  assert.equal(
    mod.isSandboxCleanupCoordinationPendingError({ code: 'other' }),
    false,
  );

  const cancelled = new mod.SandboxWorkspaceMaterializationError({
    status: 'cancelled',
    stage: 'workspace_transfer',
  });
  assert.match(cancelled.message, /cancelled during workspace_transfer/);
  const failedError = new mod.SandboxWorkspaceMaterializationError({
    status: 'failed',
    stage: 'checkout',
    cause: 'ref_not_found',
    retryable: false,
  });
  assert.match(failedError.message, /failed during checkout: ref_not_found/);
  assert.equal(Object.isFrozen(failedError.failure), true);
  const mutableFailure = {
    status: 'failed',
    stage: 'checkout',
    cause: 'ref_not_found',
    retryable: false,
    privateDetail: 'CAP_PRIVATE_FAILURE_CANARY',
  };
  const snapshottedError = new mod.SandboxWorkspaceMaterializationError(
    mutableFailure,
  );
  mutableFailure.stage = 'credential_setup';
  assert.equal(snapshottedError.failure.stage, 'checkout');
  assert.equal(JSON.stringify(snapshottedError).includes('CAP_PRIVATE_FAILURE_CANARY'), false);
  assert.equal(mod.isSandboxWorkspaceMaterializationError(cancelled), true);
  assert.equal(
    mod.isSandboxWorkspaceMaterializationError({
      code: 'sandbox_workspace_materialization_error',
    }),
    false,
  );
  assert.equal(
    mod.isSandboxWorkspaceMaterializationError({
      code: 'sandbox_workspace_materialization_error',
      failure: {
        status: 'failed',
        stage: 'checkout',
        cause: 'ref_not_found',
        retryable: false,
      },
    }),
    true,
  );
  assert.equal(
    mod.isSandboxWorkspaceMaterializationError({
      code: 'sandbox_workspace_materialization_error',
      failure: { status: 'cancelled', stage: 'workspace_transfer' },
    }),
    true,
  );
  for (const failure of [
    null,
    [],
    { status: 'cancelled', stage: 'private-stage' },
    { status: 'cancelled', stage: 'checkout', extra: true },
    { status: 'failed', stage: 'checkout', cause: null, retryable: false },
    { status: 'failed', stage: 'checkout', cause: 'private', retryable: false },
    { status: 'failed', stage: 'checkout', cause: 'unknown', retryable: null },
    {
      status: 'failed',
      stage: 'checkout',
      cause: 'unknown',
      retryable: false,
      extra: true,
    },
  ]) {
    assert.equal(
      mod.isSandboxWorkspaceMaterializationError({
        code: 'sandbox_workspace_materialization_error',
        failure,
      }),
      false,
    );
  }
  assert.equal(mod.isSandboxWorkspaceMaterializationError(null), false);
  assert.equal(
    mod.isSandboxWorkspaceMaterializationError({ code: 'different' }),
    false,
  );
});

await test('model setup failures retain only allowlisted phases', () => {
  const phases = [
    'lookup',
    'snapshot',
    'provider-selection',
    'runtime-resolution',
    'launch-context',
    'material-write',
    'material-verify',
  ];
  for (const phase of phases) {
    const error = new mod.SandboxRuntimeModelSetupError(phase);
    assert.equal(error.code, 'runtime_model_setup_failed');
    assert.equal(error.phase, phase);
    assert.equal(mod.isSandboxRuntimeModelSetupError(error), true);
    const redacted = mod.redactSandboxProvisioningStageFailure(
      'runtime_setup',
      error,
    );
    assert.equal(redacted.code, 'runtime_model_setup_failed');
    assert.equal(redacted.phase, phase);
  }
  assert.equal(
    mod.isSandboxRuntimeModelSetupError({ code: 'runtime_model_setup_failed' }),
    false,
  );
  assert.equal(
    mod.isSandboxRuntimeModelSetupError({
      code: 'runtime_model_setup_failed',
      phase: 'lookup',
    }),
    true,
  );
  assert.equal(mod.isSandboxRuntimeModelSetupError(null), false);
  assert.equal(mod.isSandboxRuntimeModelSetupError({ code: 'other' }), false);
  const forged = mod.redactSandboxProvisioningStageFailure('readiness', {
    code: 'runtime_model_setup_failed',
    phase: 'private-phase',
  });
  assert.equal(forged.code, 'sandbox_provisioning_stage_error');
  assert.equal(forged.stage, 'readiness');
  assert.equal(
    mod.redactSandboxProvisioningStageFailure(
      'readiness',
      new mod.SandboxProvisioningCapacityError(),
    ).code,
    'sandbox_provisioning_capacity_error',
  );
});

await test('task model launch material hashes explicit selectors without returning them', () => {
  const runtimeDefault = { kind: 'runtime-default' };
  const defaultMaterial = mod.taskModelLaunchMaterial(runtimeDefault);
  assert.deepEqual(defaultMaterial, runtimeDefault);
  assert.notEqual(defaultMaterial, runtimeDefault);
  assert.equal(Object.isFrozen(defaultMaterial), true);
  runtimeDefault.kind = 'explicit';
  runtimeDefault.selector = 'must-not-alias';
  assert.deepEqual(defaultMaterial, { kind: 'runtime-default' });
  const selector = 'provider/private-model';
  const material = mod.taskModelLaunchMaterial({ kind: 'explicit', selector });
  assert.deepEqual(material, {
    kind: 'explicit',
    path: mod.TASK_MODEL_MATERIAL_PATH,
    checksum: `sha256:${createHash('sha256').update(selector).digest('hex')}`,
  });
  assert.equal(Object.isFrozen(material), true);
  assert.equal(JSON.stringify(material).includes(selector), false);
});

await test('detached workspace transfer signal is recognized only with its job seam', () => {
  const job = {
    taskId: 'task-detached',
    jobId: 'job-detached',
    probe: async () => ({ kind: 'alive' }),
    kill: async () => undefined,
  };
  const signal = new mod.SandboxWorkspaceTransferDetachedSignal(job);
  assert.equal(signal.job, job);
  assert.match(signal.message, /task-detached/);
  assert.equal(mod.isSandboxWorkspaceTransferDetachedSignal(signal), true);

  const structural = new Error('cross-package signal');
  structural.name = 'SandboxWorkspaceTransferDetachedSignal';
  structural.job = job;
  assert.equal(mod.isSandboxWorkspaceTransferDetachedSignal(structural), true);

  for (const invalid of [
    null,
    { name: 'SandboxWorkspaceTransferDetachedSignal', job },
    Object.assign(new Error('wrong name'), { job }),
    Object.assign(new Error('missing probe'), {
      name: 'SandboxWorkspaceTransferDetachedSignal',
      job: { ...job, probe: undefined },
    }),
    Object.assign(new Error('missing kill'), {
      name: 'SandboxWorkspaceTransferDetachedSignal',
      job: { ...job, kill: undefined },
    }),
    Object.assign(new Error('missing task id'), {
      name: 'SandboxWorkspaceTransferDetachedSignal',
      job: { ...job, taskId: undefined },
    }),
    Object.assign(new Error('empty task id'), {
      name: 'SandboxWorkspaceTransferDetachedSignal',
      job: { ...job, taskId: '' },
    }),
    Object.assign(new Error('missing job id'), {
      name: 'SandboxWorkspaceTransferDetachedSignal',
      job: { ...job, jobId: undefined },
    }),
    Object.assign(new Error('empty job id'), {
      name: 'SandboxWorkspaceTransferDetachedSignal',
      job: { ...job, jobId: '' },
    }),
  ]) {
    assert.equal(mod.isSandboxWorkspaceTransferDetachedSignal(invalid), false);
  }
});

await test('legacy delivery args are discriminated from credentialed delivery', () => {
  assert.equal(
    mod.isSandboxLegacyDeliverWorkspaceArgs({
      branch: 'main',
      commitMessage: 'legacy',
      authHeader: 'Authorization: Basic token',
    }),
    true,
  );
  assert.equal(
    mod.isSandboxLegacyDeliverWorkspaceArgs({
      branch: 'main',
      commitMessage: 'canonical',
      credential: mod.createExactHostGitCredential(
        'https://git.example.test/org/repo.git',
        'Authorization: Basic token',
      ),
    }),
    false,
  );
});

await test('workspace command executor normalizes provider result and runtime rejection', async () => {
  const observed = [];
  const executor = mod.createSandboxWorkspaceCommandExecutor(
    async (request) => {
      observed.push(request);
      return { exit_code: '0', stdout: 'Authorization: Basic private' };
    },
    { scrubOutput: true },
  );
  const result = await executor.exec({
    command: 'git status',
    cwd: '/workspace',
    timeoutMs: 1_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'Authorization: Basic ***');
  assert.equal(observed.length, 1);

  const rejection = await mod.classifySandboxRuntimeCommandExecution({
    executor: {
      exec: async () => {
        throw Object.assign(new Error('provider private'), { code: 'ERR_TIMEOUT' });
      },
    },
    request: { command: 'runtime command' },
    descriptor: { commandKind: 'runtime_setup', ordinal: 1 },
  });
  assert.equal(rejection.settlement, 'timeout');
});

await test('command classification rejects malformed structural evidence', () => {
  assert.throws(
    () => mod.validateSandboxRuntimeCommandDescriptor(null),
    (error) => error?.code === 'sandbox_command_classification_error',
  );
  assert.throws(
    () => new mod.SandboxCommandSettlementError('not-a-settlement'),
    (error) => error?.code === 'sandbox_command_classification_error',
  );

  const descriptor = { commandKind: 'runtime_setup', ordinal: 1 };
  const validExit = {
    settlement: 'exit',
    outcome: 'succeeded',
    cause: null,
    retryable: false,
    exitCode: 0,
  };
  const invalidClassifications = [
    null,
    [],
    { ...validExit, extra: true },
    { ...validExit, exitCode: Number.NaN },
    { ...validExit, outcome: 'failed' },
    { ...validExit, cause: 'command_failed' },
    { ...validExit, retryable: true },
    {
      settlement: null,
      outcome: 'failed',
      cause: 'transport_failed',
      retryable: true,
      exitCode: null,
    },
    {
      settlement: 'unknown',
      outcome: 'failed',
      cause: 'transport_failed',
      retryable: true,
      exitCode: null,
    },
  ];
  for (const classification of invalidClassifications) {
    assert.throws(
      () => new mod.SandboxRuntimeCommandExecutionError(descriptor, classification),
      (error) => error?.code === 'sandbox_command_classification_error',
    );
  }

  const canonical = [
    validExit,
    mod.classifySandboxCommandExecutionRejection(
      new mod.SandboxCommandSettlementError('failed_without_exit'),
    ),
    mod.classifySandboxCommandExecutionRejection(
      new mod.SandboxCommandSettlementError('timeout'),
    ),
    mod.classifySandboxCommandExecutionRejection(
      new mod.SandboxCommandSettlementError('transport'),
    ),
    mod.classifySandboxCommandExecutionRejection(
      new mod.SandboxCommandSettlementError('protocol'),
    ),
    mod.classifySandboxCommandExecutionRejection(
      new mod.SandboxCommandSettlementError('cancellation'),
    ),
    mod.classifySandboxCommandExecutionRejection(
      new mod.SandboxCommandSettlementError('indeterminate'),
    ),
  ];
  for (const classification of canonical) {
    assert.doesNotThrow(
      () => new mod.SandboxRuntimeCommandExecutionError(descriptor, classification),
    );
  }

  const transport = canonical.find((value) => value.settlement === 'transport');
  for (const malformed of [
    { ...transport, extra: true },
    { ...transport, outcome: 'cancelled' },
    { ...transport, cause: 'protocol_failed' },
    { ...transport, retryable: false },
    { ...transport, exitCode: 1 },
    { ...transport, anomaly: 'missing_exit_code' },
  ]) {
    assert.throws(
      () => new mod.SandboxRuntimeCommandExecutionError(descriptor, malformed),
      (error) => error?.code === 'sandbox_command_classification_error',
    );
  }
});

await test('runtime command error guard validates descriptor and classification', () => {
  const valid = new mod.SandboxRuntimeCommandExecutionError(
    { commandKind: 'runtime_setup', ordinal: 1 },
    {
      settlement: 'exit',
      outcome: 'succeeded',
      cause: null,
      retryable: false,
      exitCode: 0,
    },
  );
  assert.equal(mod.isSandboxRuntimeCommandExecutionError(valid), true);
  assert.equal(mod.isSandboxRuntimeCommandExecutionError(null), false);
  assert.equal(mod.isSandboxRuntimeCommandExecutionError({ code: 'other' }), false);
  assert.equal(
    mod.isSandboxRuntimeCommandExecutionError({
      code: 'sandbox_runtime_command_execution_error',
      descriptor: { commandKind: 'private', ordinal: 1 },
      classification: valid.classification,
    }),
    false,
  );
  const nullPrototypeDescriptor = Object.assign(Object.create(null), {
    commandKind: 'runtime_setup',
    ordinal: 2,
  });
  const nullPrototypeClassification = Object.assign(Object.create(null), {
    settlement: 'exit',
    outcome: 'failed',
    cause: 'command_failed',
    retryable: false,
    exitCode: 2,
  });
  assert.doesNotThrow(
    () =>
      new mod.SandboxRuntimeCommandExecutionError(
        nullPrototypeDescriptor,
        nullPrototypeClassification,
      ),
  );
  assert.equal(
    mod.isSandboxRuntimeCommandExecutionError({
      code: 'sandbox_runtime_command_execution_error',
      descriptor: valid.descriptor,
      classification: { ...valid.classification, retryable: true },
    }),
    false,
  );
});

await test('command rejection recognizes cancellation and timeout codes safely', () => {
  const aborted = new AbortController();
  aborted.abort('cancelled');
  assert.equal(
    mod.classifySandboxCommandExecutionRejection(new Error('private'), aborted.signal)
      .settlement,
    'cancellation',
  );
  for (const error of [
    { code: 'ABORT_ERR' },
    { name: 'AbortError' },
  ]) {
    assert.equal(
      mod.classifySandboxCommandExecutionRejection(error).settlement,
      'cancellation',
    );
  }
  for (const error of [
    { code: 'ERR_TIMEOUT' },
    { name: 'TimeoutError' },
    { code: 'ETIMEDOUT' },
  ]) {
    assert.equal(
      mod.classifySandboxCommandExecutionRejection(error).settlement,
      'timeout',
    );
  }
  assert.equal(
    mod.classifySandboxCommandExecutionRejection(null).settlement,
    'transport',
  );
});

await test('resource and workspace snapshots exercise absent and invalid boundaries', () => {
  assert.equal(mod.snapshotSandboxResources(null), undefined);
  assert.deepEqual(mod.snapshotSandboxResources({}), {});
  assert.equal(mod.resolveSandboxResources({}), undefined);
  assert.deepEqual(
    mod.resolveSandboxResources({ explicit: { diskSizeGb: 7 } }),
    { diskSizeGb: 7 },
  );
  assert.deepEqual(
    mod.resolveSandboxResources({ fallback: { diskSizeGb: 6 } }),
    { diskSizeGb: 6 },
  );
  assert.deepEqual(mod.snapshotSandboxProvisioningPolicy({}), {});
  assert.deepEqual(
    mod.snapshotSandboxProvisioningPolicy({ workspaceMaterializationDeadlineMs: 1_000 }),
    { workspaceMaterializationDeadlineMs: 1_000 },
  );
  assert.deepEqual(mod.sandboxResourceRequiredCapabilities({}), []);
  assert.doesNotThrow(() => mod.assertSandboxProviderSupportsResources(undefined, {}));

  const base = {
    repositoryUrl: 'https://git.example.test/org/repo.git',
    callerBranch: null,
    resolvedBranch: 'main',
    deadlineMs: 1_000,
  };
  assert.equal(mod.snapshotSandboxWorkspacePlan(null), null);
  const invalidPlans = [
    { ...base, repositoryUrl: '' },
    { ...base, repositoryUrl: ' https://git.example.test/org/repo.git' },
    { ...base, repositoryUrl: 'not a url' },
    { ...base, repositoryUrl: 'https://git.example.test' },
  ];
  for (const plan of invalidPlans) {
    assert.throws(
      () => mod.snapshotSandboxWorkspacePlan(plan),
      (error) => error?.code === 'sandbox_provider_configuration_error',
    );
  }
});

await test('progress and external-boundary optional paths remain non-blocking and fenced', async () => {
  assert.doesNotThrow(() =>
    mod.reportSandboxProvisioningProgress(undefined, {
      status: 'started',
      stage: 'readiness',
    }),
  );
  assert.doesNotThrow(() =>
    mod.reportSandboxWorkspaceProgress(undefined, {
      status: 'started',
      stage: 'checkout',
    }),
  );
  assert.equal(mod.latchSandboxExternalBoundaryGuard(undefined), undefined);
  const successfulGuard = mod.latchSandboxExternalBoundaryGuard(async () => undefined);
  await successfulGuard({
    taskId: 'task-successful-guard',
    action: 'sandbox.inspect',
    position: 'before',
  });
  assert.equal(
    await mod.runSandboxExternalBoundary({
      taskId: 'task-no-guard',
      action: 'sandbox.inspect',
      run: async () => 'ok',
    }),
    'ok',
  );

  const explicit = new AbortController();
  const reason = new Error('lease cancelled');
  explicit.abort(reason);
  await assert.rejects(
    () =>
      mod.runSandboxExternalBoundary({
        taskId: 'task-aborted',
        action: 'sandbox.create',
        signal: explicit.signal,
        run: async () => 'must not run',
      }),
    (error) => error === reason,
  );
  const implicit = new AbortController();
  implicit.abort();
  await assert.rejects(
    () =>
      mod.runSandboxExternalBoundary({
        taskId: 'task-aborted-default',
        action: 'sandbox.create',
        signal: implicit.signal,
        run: async () => 'must not run',
      }),
    (error) => error?.name === 'AbortError',
  );
  await assert.rejects(
    () =>
      mod.runSandboxExternalBoundary({
        taskId: 'task-aborted-fallback',
        action: 'sandbox.create',
        signal: { aborted: true, reason: undefined },
        run: async () => 'must not run',
      }),
    /Sandbox external boundary was aborted/,
  );
});

await test('git credential input validation closes malformed scope and header paths', () => {
  for (const secret of [null, '', 'line\nfeed']) {
    assert.throws(
      () => mod.createRedactedSecret(secret),
      (error) => error?.code === 'sandbox_provider_configuration_error',
    );
  }
  const secret = mod.createRedactedSecret('opaque-value');
  assert.equal(String(secret), mod.SANDBOX_REDACTED_VALUE);
  assert.equal(JSON.stringify(secret), `"${mod.SANDBOX_REDACTED_VALUE}"`);
  assert.equal(mod.isExactHostGitCredential(null), false);
  assert.equal(mod.isExactHostGitCredential({}), false);

  const validUrl = 'https://git.example.test/org/repo.git';
  for (const header of [
    null,
    '',
    `Authorization: Basic ${'a'.repeat(8_200)}`,
    ' Authorization: Basic token',
    'Authorization: Basic token\nInjected: yes',
  ]) {
    assert.throws(
      () => mod.createExactHostGitCredential(validUrl, header),
      (error) => error?.code === 'sandbox_provider_configuration_error',
    );
  }
  for (const repositoryUrl of [
    null,
    '',
    ' https://git.example.test/org/repo.git',
    'https://git.example.test/org/repo.git\n',
    'not a url',
    'ssh://git.example.test/org/repo.git',
    'https://user:password@git.example.test/org/repo.git',
    'https://git.example.test/org/repo.git?token=private',
    'https://git.example.test/org/repo.git#fragment',
    'https://git.example.test/',
  ]) {
    assert.throws(
      () =>
        mod.createExactHostGitCredential(
          repositoryUrl,
          'Authorization: Basic token',
        ),
      (error) => error?.code === 'sandbox_provider_configuration_error',
    );
  }

  const credential = mod.createExactHostGitCredential(
    validUrl,
    'Authorization: Basic token',
  );
  assert.equal(
    mod.exactHostGitCredentialMatchesRepository(
      credential,
      'https://git.example.test/other/repo.git',
    ),
    true,
  );
  assert.equal(
    mod.exactHostGitCredentialMatchesRepository(
      credential,
      'https://other.example.test/org/repo.git',
    ),
    false,
  );
});

await test('secret-file port rejects invalid ownership, ids, collisions, and transport failures', async () => {
  const credential = mod.createExactHostGitCredential(
    'http://git.example.test/org/repo.git',
    'Authorization: Basic token',
  );
  for (const directory of [null, '', 'relative/path', ' /absolute', '/bad\npath']) {
    assert.throws(
      () =>
        mod.createSandboxSecretFilePort({
          directory,
          transport: {
            writeFile: async () => undefined,
            deleteFile: async () => undefined,
          },
        }),
      (error) => error?.code === 'sandbox_provider_configuration_error',
    );
  }

  const writes = [];
  const port = mod.createSandboxSecretFilePort({
    directory: '/',
    createId: () => 'same-id',
    transport: {
      writeFile: async (request) => writes.push(request.path),
      deleteFile: async () => undefined,
    },
  });
  await assert.rejects(
    port.writeSecretFile({ kind: 'wrong', credential }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );
  await assert.rejects(
    port.writeSecretFile({ kind: 'git-http-credential', credential: {} }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );
  const first = await port.writeSecretFile({
    kind: 'git-http-credential',
    credential,
  });
  assert.equal(writes[0], '/cap-git-credential-same-id.config');
  await assert.rejects(
    port.writeSecretFile({ kind: 'git-http-credential', credential }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );

  const foreignPort = mod.createSandboxSecretFilePort({
    directory: '/tmp/secrets',
    transport: {
      writeFile: async () => undefined,
      deleteFile: async () => undefined,
    },
  });
  await assert.rejects(
    foreignPort.deleteSecretFile(first),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );

  const invalidIdPort = mod.createSandboxSecretFilePort({
    directory: '/tmp/secrets',
    createId: () => '../escape',
    transport: {
      writeFile: async () => undefined,
      deleteFile: async () => undefined,
    },
  });
  await assert.rejects(
    invalidIdPort.writeSecretFile({ kind: 'git-http-credential', credential }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );

  const writeFailure = mod.createSandboxSecretFilePort({
    directory: '/tmp/secrets',
    createId: () => 'write-failure',
    transport: {
      writeFile: async () => {
        throw new Error('private write failure');
      },
      deleteFile: async () => {
        throw new Error('private cleanup failure');
      },
    },
  });
  await assert.rejects(
    writeFailure.writeSecretFile({ kind: 'git-http-credential', credential }),
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );

  const deleteFailure = mod.createSandboxSecretFilePort({
    directory: '/tmp/secrets',
    createId: () => 'delete-failure',
    transport: {
      writeFile: async () => undefined,
      deleteFile: async () => {
        throw new Error('private delete failure');
      },
    },
  });
  const handle = await deleteFailure.writeSecretFile({
    kind: 'git-http-credential',
    credential,
  });
  await assert.rejects(
    deleteFailure.deleteSecretFile(handle),
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
});

await test('detached job edge evidence stays fail-closed', () => {
  const command = mod.buildSandboxDetachedJobLaunchCommand({
    jobId: 'job-with-cwd',
    command: 'printf done',
    cwd: '/workspace',
  });
  assert(command.includes('/workspace'));
  const alive = mod.triageSandboxDetachedJobProbeOutput(
    'alive 123\nprogress 20 30\n',
  );
  assert.equal(alive.state, 'alive');
  assert.deepEqual(alive.progress, { sizeBytes: 20, mtimeEpochSeconds: 30 });
  const aliveWithoutProgress = mod.triageSandboxDetachedJobProbeOutput('alive 123\n');
  assert.equal(aliveWithoutProgress.state, 'alive');
  assert.equal(Object.hasOwn(aliveWithoutProgress, 'progress'), false);
  assert.equal(
    mod.triageSandboxDetachedJobProbeOutput(
      `alive ${Number.MAX_SAFE_INTEGER}0\n`,
    ).state,
    'unknown',
  );
});

await test('provision context keeps environment without inventing resources', () => {
  const context = mod.snapshotSandboxProvisionContext({
    taskId: 'task-environment-without-resources',
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'headless-exec',
    environment: { id: 'environment-without-resources' },
  });
  assert.deepEqual(context.environment, { id: 'environment-without-resources' });
  assert.equal(Object.hasOwn(context.environment, 'resources'), false);
});

await test('diagnostic events retain optional workspace source kind', async () => {
  const recorded = [];
  const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const emitter = mod.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attempt: 1,
      admissionMode: 'durable',
      providerFamily: 'aio',
    },
    record: async (event) => {
      recorded.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
    createEventId: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    now: () => new Date('2026-07-25T00:00:00.000Z'),
  });
  await emitter.emit({
    operationId,
    stage: 'workspace_transfer',
    operation: 'workspace_materialize',
    channel: 'primary',
    workspaceSourceKind: 'git',
    outcome: 'started',
  });
  assert.equal(recorded[0].workspaceSourceKind, 'git');
});

console.log(`\n${passed} passed, ${failed} failed (sandbox-core regressions)`);
if (failed > 0) process.exit(1);
