import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);

const CANARY = 'CAP_BOXLITE_ARCHIVE_CANARY_3e9f';

function result(overrides = {}) {
  return {
    exitCode: 0,
    output: '',
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function secretWriteRequest(signal) {
  return {
    kind: 'git-http-credential',
    credential: core.createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      `Authorization: Basic ${CANARY}`,
    ),
    ...(signal === undefined ? {} : { signal }),
  };
}

function preAbortedSignal() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
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

async function withDeadline(promise, timeoutMs = 2_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('test operation exceeded its deadline')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

assert.equal(
  mod.resolveBoxLiteGitSecretDirectory('/home/gem/workspace'),
  '/home/gem/.cap-git-credentials',
);
assert.equal(
  mod.resolveBoxLiteGitSecretDirectory('/workspace'),
  '/.cap-git-credentials',
);
assert.throws(
  () => mod.resolveBoxLiteGitSecretDirectory('home/gem/workspace'),
  (error) => error?.code === 'sandbox_provider_configuration_error',
);

{
  const uploads = [];
  const execCalls = [];
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async uploadArchive(request) {
        uploads.push({
          path: request.path,
          archive: Buffer.from(request.archive),
        });
      },
      async exec(request) {
        execCalls.push(request);
        return result();
      },
      async deleteSandbox() {},
      async getSandbox() {
        return { id: 'box-runtime-private-hidden', state: 'running' };
      },
    },
    sandboxId: 'box-runtime-private-hidden',
  });
  await adapter.runtimePrivateFiles.writeFile(
    core.createSandboxRuntimePrivateFile(
      '/home/gem/.claude.json',
      '{"hasCompletedOnboarding":true}',
    ),
  );

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, '/home/gem/..claude.json.upload');
  assert.equal(
    uploads[0].archive.toString('utf8', 0, '.claude.json'.length),
    '.claude.json',
  );
  assert.match(
    execCalls[0].command,
    /mkdir -p -- '\/home\/gem' '\/home\/gem\/\.\.claude\.json\.upload'/u,
  );
  assert.doesNotMatch(
    execCalls[0].command,
    /chmod 700 -- '\/home\/gem'(?:\s|$)/u,
  );
  assert.match(
    execCalls[0].command,
    /chmod 700 -- '\/home\/gem\/\.\.claude\.json\.upload'/u,
  );
  assert.match(
    execCalls[1].command,
    /mv -f -- "\$source" '\/home\/gem\/\.claude\.json'/u,
  );

  await adapter.settleCredentialSafety();
  assert.match(
    execCalls[2].command,
    /rm -rf -- '\/home\/gem\/\.\.claude\.json\.upload'/u,
  );
  assert.match(
    execCalls[2].command,
    /rm -f -- '\/home\/gem\/\.claude\.json'/u,
  );
}

{
  const uploads = [];
  const execCalls = [];
  const secretDirectory = '/home/gem/.cap-git-credentials';
  const secretName = 'cap-git-credential-fixture.config';
  const stagingDirectory = `${secretDirectory}/.${secretName}.upload`;
  let absent = false;
  const client = {
    async uploadArchive(request) {
      uploads.push({
        sandboxId: request.sandboxId,
        path: request.path,
        archive: Buffer.from(request.archive),
      });
    },
    async exec(request) {
      execCalls.push(request);
      return result();
    },
    async deleteSandbox() {
      absent = true;
    },
    async getSandbox() {
      return absent ? null : { id: 'box-secret-success', state: 'running' };
    },
  };
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client,
    sandboxId: 'box-secret-success',
    secretDirectory,
    createSecretId: () => 'fixture',
  });
  const handle = await adapter.secretFilePort.writeSecretFile({
    kind: 'git-http-credential',
    credential: core.createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      `Authorization: Basic ${CANARY}`,
    ),
  });

  assert.equal(handle.mode, 0o600);
  assert.equal(handle.path, `${secretDirectory}/${secretName}`);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, stagingDirectory);
  assert.equal(
    parseInt(uploads[0].archive.toString('ascii', 100, 107), 8),
    0o600,
  );
  assert.equal(uploads[0].archive.subarray(0, 512).includes(CANARY), false);
  assert(uploads[0].archive.indexOf(CANARY) >= 512);
  assert.doesNotMatch(
    JSON.stringify({
      upload: { sandboxId: uploads[0].sandboxId, path: uploads[0].path },
      execCalls,
      handle,
      adapter,
    }),
    new RegExp(CANARY, 'u'),
  );
  assert.match(execCalls[0].command, /mkdir -p/u);
  assert.match(execCalls[0].command, /chmod 700/u);
  assert.match(execCalls[1].command, /stat -c %a/u);
  assert.match(execCalls[1].command, /\/extracted\//u);
  assert.match(execCalls[1].command, /uid=\$\(id -u\)/u);
  assert.match(execCalls[1].command, /gid=\$\(id -g\)/u);
  assert.match(execCalls[1].command, /chown "\$uid:\$gid" "\$source"/u);
  assert.match(execCalls[1].command, /chmod 600 "\$source"/u);
  assert.match(execCalls[1].command, /mv -f -- "\$source"/u);
  assert.match(execCalls[1].command, /rm -rf --/u);
  assert.match(execCalls[1].command, /test -r/u);
  assert.match(execCalls[1].command, /stat -c %u/u);
  assert.match(execCalls[1].command, /stat -c %g/u);
  assert.doesNotMatch(execCalls[1].command, /sudo/u);
  assert.doesNotMatch(execCalls[0].command, /Authorization:/u);
  assert.doesNotMatch(execCalls[1].command, /Authorization:/u);
  assert.doesNotMatch(JSON.stringify(execCalls), new RegExp(CANARY, 'u'));

  await adapter.secretFilePort.deleteSecretFile(handle);
  assert.match(execCalls[2].command, /rm -f/u);
  assert.match(execCalls[2].command, /rmdir --/u);
  assert.equal(adapter.wasSandboxFenced(), false);
  await adapter.settleCredentialSafety();
}

{
  const execCalls = [];
  let absent = false;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async uploadArchive() {},
      async exec(request) {
        execCalls.push(request);
        return execCalls.length === 1 ? result() : result({ exitCode: 1 });
      },
      async deleteSandbox() {
        absent = true;
      },
      async getSandbox() {
        return absent ? null : { id: 'box-nested-normalization-failure' };
      },
    },
    sandboxId: 'box-nested-normalization-failure',
    secretDirectory: '/home/gem/.cap-git-credentials',
    createSecretId: () => 'nested-failure',
    deletionConfirmation: { attempts: 1 },
  });
  await assert.rejects(
    () =>
      adapter.secretFilePort.writeSecretFile({
        kind: 'git-http-credential',
        credential: core.createExactHostGitCredential(
          'https://code.example.test/acme/private.git',
          `Authorization: Basic ${CANARY}`,
        ),
      }),
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(adapter.wasSandboxFenced(), true);
  assert.match(execCalls[1].command, /\/extracted\//u);
  assert.match(execCalls[1].command, /chown "\$uid:\$gid" "\$source"/u);
  assert.match(execCalls[1].command, /stat -c %u/u);
  assert.match(execCalls[1].command, /stat -c %g/u);
  assert.doesNotMatch(JSON.stringify(execCalls), new RegExp(CANARY, 'u'));
}

{
  const verificationStarted = deferred();
  const lateVerification = deferred();
  const deleteStarted = deferred();
  const confirmation = deferred();
  let fenceStarted = false;
  let execCalls = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async uploadArchive() {},
      async exec() {
        execCalls += 1;
        if (execCalls === 1) return result();
        verificationStarted.resolve();
        return lateVerification.promise;
      },
      async deleteSandbox() {
        fenceStarted = true;
        deleteStarted.resolve();
      },
      async getSandbox() {
        return fenceStarted
          ? confirmation.promise
          : { id: 'box-mode-cancel', state: 'running' };
      },
    },
    sandboxId: 'box-mode-cancel',
    createSecretId: () => 'mode-cancel',
    deletionConfirmation: { attempts: 1 },
  });
  const cancellation = new AbortController();
  let settled = false;
  const writing = adapter.secretFilePort
    .writeSecretFile({
      kind: 'git-http-credential',
      credential: core.createExactHostGitCredential(
        'https://code.example.test/acme/private.git',
        `Authorization: Basic ${CANARY}`,
      ),
      signal: cancellation.signal,
    })
    .finally(() => {
      settled = true;
    });
  await verificationStarted.promise;
  cancellation.abort();
  await deleteStarted.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  confirmation.resolve(null);
  await assert.rejects(
    writing,
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(adapter.wasSandboxFenced(), true);
  lateVerification.reject(new Error('late BoxLite mode verification response'));
  await Promise.resolve();
}

{
  const confirmation = deferred();
  const deleteStarted = deferred();
  const events = [];
  let fenceStarted = false;
  let execCount = 0;
  const client = {
    async uploadArchive() {
      events.push('archive-written');
    },
    async exec() {
      execCount += 1;
      if (execCount <= 2) return result();
      events.push('rm-unconfirmed');
      return result({ exitCode: 1 });
    },
    async getSandbox() {
      if (!fenceStarted) return { id: 'box-delete-fence', state: 'running' };
      events.push('absence-probe-pending');
      return confirmation.promise;
    },
    async deleteSandbox() {
      fenceStarted = true;
      events.push('delete-requested');
      deleteStarted.resolve();
    },
  };
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client,
    sandboxId: 'box-delete-fence',
    createSecretId: () => 'delete-fence',
    deletionConfirmation: { attempts: 1 },
  });
  const handle = await adapter.secretFilePort.writeSecretFile({
    kind: 'git-http-credential',
    credential: core.createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      `Authorization: Basic ${CANARY}`,
    ),
  });

  let settled = false;
  const cleanup = adapter.secretFilePort.deleteSecretFile(handle);
  cleanup.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await deleteStarted.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  confirmation.resolve(null);
  await assert.rejects(
    cleanup,
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(adapter.wasSandboxFenced(), true);
  assert.deepEqual(events.slice(-3), [
    'rm-unconfirmed',
    'delete-requested',
    'absence-probe-pending',
  ]);
}

{
  const execStarted = deferred();
  const lateExec = deferred();
  const deleteStarted = deferred();
  const confirmation = deferred();
  let fenceStarted = false;
  const client = {
    async exec() {
      execStarted.resolve();
      return lateExec.promise;
    },
    async deleteSandbox() {
      fenceStarted = true;
      deleteStarted.resolve();
    },
    async getSandbox() {
      return fenceStarted
        ? confirmation.promise
        : { id: 'box-cancel-fence', state: 'running' };
    },
  };
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client,
    sandboxId: 'box-cancel-fence',
    deletionConfirmation: { attempts: 1 },
  });
  const cancellation = new AbortController();
  let settled = false;
  const running = adapter.stageExecutor
    .execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 5_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 5_000,
    })
    .finally(() => {
      settled = true;
    });
  await execStarted.promise;
  cancellation.abort();
  assert.deepEqual(await running, result({ exitCode: 124, timedOut: true }));
  assert.equal(settled, true);
  assert.equal(adapter.wasSandboxFenced(), false);
  const settlement = adapter.settleCredentialSafety();
  await deleteStarted.promise;
  confirmation.resolve(null);
  await settlement;
  assert.equal(adapter.wasSandboxFenced(), true);
  lateExec.reject(new Error('late dropped exec response'));
  await Promise.resolve();
}

{
  const taskId = '28000000-0000-4000-8000-000000000001';
  const terminalRecordEntered = deferred();
  const releaseTerminalRecord = deferred();
  const deleteCompleted = deferred();
  let identity = 0;
  const nextIdentity = (prefix) =>
    `${prefix}-0000-4000-8000-${String(++identity).padStart(12, '0')}`;
  const diagnostics = core.createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: 1,
      taskId,
      attemptId: '28000000-0000-4000-8000-000000000002',
      attempt: 1,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
    },
    createEventId: () => nextIdentity('29000000'),
    createOperationId: () => nextIdentity('2a000000'),
    record: async (event) => {
      if (
        event.channel === 'primary' &&
        event.operation === 'provider_select' &&
        event.outcome === 'failed'
      ) {
        terminalRecordEntered.resolve();
        await releaseTerminalRecord.promise;
      }
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  const primaryOperationId = diagnostics.createOperationId();
  await diagnostics.emit({
    operationId: primaryOperationId,
    stage: 'provider_selection',
    operation: 'provider_select',
    channel: 'primary',
    outcome: 'started',
  });
  const stalledPrimaryRecord = diagnostics.emit({
    operationId: primaryOperationId,
    stage: 'provider_selection',
    operation: 'provider_select',
    channel: 'primary',
    outcome: 'failed',
    durationMs: 1,
    cause: 'provider_unavailable',
    retryable: true,
  });
  await withDeadline(terminalRecordEntered.promise);

  let absent = false;
  let deleteCalls = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        throw new Error('pre-aborted stage must not execute');
      },
      async deleteSandbox() {
        deleteCalls += 1;
        absent = true;
        deleteCompleted.resolve();
      },
      async getSandbox() {
        return absent ? null : { id: 'box-stalled-diagnostics' };
      },
    },
    sandboxId: 'box-stalled-diagnostics',
    diagnostics,
    deletionConfirmation: { attempts: 1 },
  });
  const cancellation = new AbortController();
  cancellation.abort();
  assert.deepEqual(
    await adapter.stageExecutor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );

  const settlement = adapter.settleCredentialSafety();
  try {
    await withDeadline(deleteCompleted.promise);
    await withDeadline(settlement);
    assert.equal(deleteCalls, 1);
    assert.equal(absent, true);
    assert.equal(adapter.wasSandboxFenced(), true);
  } finally {
    releaseTerminalRecord.resolve();
  }
  await withDeadline(stalledPrimaryRecord);
  await withDeadline(diagnostics.flush());
}

{
  const flushEntered = deferred();
  const neverFlushes = new Promise(() => {});
  let operationIdentity = 0;
  const diagnostics = {
    mode: 'non-persisting',
    createOperationId: () =>
      `2c000000-0000-4000-8000-${String(++operationIdentity).padStart(12, '0')}`,
    async emit() {},
    async flush() {
      flushEntered.resolve();
      await neverFlushes;
    },
  };
  let absent = false;
  let deleteCalls = 0;
  const physical = await withDeadline(
    mod.attemptDeleteBoxLiteSandboxAndConfirm({
      client: {
        async deleteSandbox() {
          deleteCalls += 1;
          absent = true;
        },
        async getSandbox() {
          return absent ? null : { id: 'box-never-flushed-cleanup' };
        },
      },
      sandboxId: 'box-never-flushed-cleanup',
      attempts: 1,
      diagnostics,
    }),
  );
  assert.deepEqual(physical, {
    outcome: 'succeeded',
    proof: 'found-and-cleaned',
    cause: null,
    retryable: false,
  });
  await withDeadline(flushEntered.promise);
  assert.equal(deleteCalls, 1);
  assert.equal(absent, true);
}

{
  let execCalls = 0;
  let probes = 0;
  let waits = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        execCalls += 1;
        return result();
      },
      async deleteSandbox() {},
      async getSandbox() {
        probes += 1;
        return { id: 'box-unconfirmed-fence', state: 'running' };
      },
    },
    sandboxId: 'box-unconfirmed-fence',
    deletionConfirmation: {
      attempts: 2,
      async waitForRetry() {
        waits += 1;
      },
    },
  });
  const cancellation = new AbortController();
  cancellation.abort();
  assert.deepEqual(
    await adapter.stageExecutor.execute({
      stage: 'remote_ref_resolution',
      request: { command: 'git ls-remote', timeoutMs: 1_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.equal(execCalls, 0);
  assert.equal(probes, 0);
  assert.equal(waits, 0);
  assert.equal(adapter.wasSandboxFenced(), false);
  await assert.rejects(
    () => adapter.settleCredentialSafety(),
    (error) =>
      error?.code === 'sandbox_provider_configuration_error' &&
      error.message === 'BoxLite credential safety fencing could not be confirmed',
  );
  assert.equal(probes, 2);
  assert.equal(waits, 1);
  assert.equal(adapter.wasSandboxFenced(), false);
}

{
  const scenarios = [
    {
      outcome: 'succeeded',
      probe: 'absent',
      expected: {
        outcome: 'succeeded',
        proof: 'found-and-cleaned',
        cause: null,
        retryable: false,
      },
    },
    {
      outcome: 'failed',
      probe: 'present',
      expected: {
        outcome: 'failed',
        proof: null,
        cause: 'cleanup_failed',
        retryable: true,
      },
    },
    {
      outcome: 'indeterminate',
      probe: 'throws',
      expected: {
        outcome: 'indeterminate',
        proof: null,
        cause: 'cleanup_unconfirmed',
        retryable: true,
      },
    },
  ];

  for (const scenario of scenarios) {
    const taskId = `task-physical-${scenario.outcome}`;
    const sandboxId = `RAW_PHYSICAL_${scenario.outcome.toUpperCase()}_CANARY`;
    const transportCanary = `RAW_PHYSICAL_${scenario.outcome.toUpperCase()}_TRANSPORT_CANARY`;
    const ownership = {
      ownerGeneration: `owner:physical-${scenario.outcome}`,
      resourceGeneration: `resource:physical-${scenario.outcome}`,
    };
    const authorization = {
      kind: 'generation',
      taskId,
      providerId: 'boxlite-test',
      ownership,
    };
    const acknowledgements = [];
    const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
      client: {
        async exec() {
          throw new Error('pre-aborted stage must not execute');
        },
        async deleteSandbox() {
          if (scenario.outcome !== 'succeeded') {
            throw new Error(transportCanary);
          }
        },
        async getSandbox() {
          if (scenario.probe === 'absent') return null;
          if (scenario.probe === 'present') {
            return { id: sandboxId, state: 'running' };
          }
          throw new Error(transportCanary);
        },
      },
      sandboxId,
      taskId,
      providerId: 'boxlite-test',
      ownership,
      beforeSandboxCleanup: async () => authorization,
      settleSandboxCleanupAttempt: async (receivedAuthorization, physical) => {
        acknowledgements.push({ receivedAuthorization, physical });
      },
      deletionConfirmation: { attempts: 1 },
    });
    const cancellation = new AbortController();
    cancellation.abort();
    const execution = () =>
      adapter.stageExecutor.execute({
        stage: 'checkout',
        request: { command: 'git checkout', timeoutMs: 1_000 },
        signal: cancellation.signal,
        remainingTimeoutMs: 1_000,
      });

    assert.deepEqual(
      await execution(),
      result({ exitCode: 124, timedOut: true }),
    );
    assert.equal(acknowledgements.length, 0, scenario.outcome);
    assert.equal(adapter.wasSandboxFenced(), false, scenario.outcome);

    if (scenario.outcome === 'succeeded') {
      await adapter.settleCredentialSafety();
    } else {
      await assert.rejects(
        () => adapter.settleCredentialSafety(),
        (error) =>
          error?.code === 'sandbox_provider_configuration_error' &&
          error.code !== 'sandbox_cleanup_coordination_pending',
      );
    }

    assert.equal(acknowledgements.length, 1, scenario.outcome);
    assert.equal(
      acknowledgements[0].receivedAuthorization,
      authorization,
      scenario.outcome,
    );
    assert.deepEqual(
      acknowledgements[0].physical,
      scenario.expected,
      scenario.outcome,
    );
    assert.equal(
      Object.isFrozen(acknowledgements[0].physical),
      true,
      scenario.outcome,
    );
    assert.equal(
      JSON.stringify(acknowledgements).includes(sandboxId),
      false,
      `${scenario.outcome} leaked the provider sandbox id`,
    );
    assert.equal(
      JSON.stringify(acknowledgements).includes(transportCanary),
      false,
      `${scenario.outcome} leaked the transport failure`,
    );
    assert.equal(
      adapter.wasSandboxFenced(),
      scenario.outcome === 'succeeded',
      scenario.outcome,
    );
    assert.equal(adapter.wasSandboxCleanupAcknowledged(), true);
  }
}

{
  const taskId = 'task-cleanup-ack-rejected';
  const ownership = {
    ownerGeneration: 'owner:cleanup-ack-rejected',
    resourceGeneration: 'resource:cleanup-ack-rejected',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-test',
    ownership,
  };
  const acknowledgementFailure = new Error(
    'owner-store acknowledgement rejected',
  );
  let absent = false;
  let receivedAuthorization;
  let receivedPhysical;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        throw new Error('pre-aborted stage must not execute');
      },
      async deleteSandbox() {
        absent = true;
      },
      async getSandbox() {
        return absent ? null : { id: 'box-cleanup-ack-rejected' };
      },
    },
    sandboxId: 'box-cleanup-ack-rejected',
    taskId,
    providerId: 'boxlite-test',
    ownership,
    beforeSandboxCleanup: async () => authorization,
    settleSandboxCleanupAttempt: async (nextAuthorization, physical) => {
      receivedAuthorization = nextAuthorization;
      receivedPhysical = physical;
      throw acknowledgementFailure;
    },
    deletionConfirmation: { attempts: 1 },
  });
  const cancellation = new AbortController();
  cancellation.abort();
  assert.equal(adapter.wasSandboxCleanupAcknowledged(), true);
  assert.deepEqual(
    await adapter.stageExecutor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.equal(receivedAuthorization, undefined);
  assert.equal(receivedPhysical, undefined);
  await assert.rejects(
    () => adapter.settleCredentialSafety(),
    (error) => error === acknowledgementFailure,
  );
  assert.equal(adapter.wasSandboxFenced(), true);
  assert.equal(adapter.wasSandboxCleanupAcknowledged(), false);
  assert.equal(receivedAuthorization, authorization);
  assert.deepEqual(receivedPhysical, {
    outcome: 'succeeded',
    proof: 'found-and-cleaned',
    cause: null,
    retryable: false,
  });
}

{
  const cleanupAuthorityEntered = deferred();
  const cleanupAuthorityDecision = deferred();
  let deleteCalls = 0;
  let cleanupCompletions = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        throw new Error('pre-aborted stage must not execute');
      },
      async deleteSandbox() {
        deleteCalls += 1;
      },
      async getSandbox() {
        return { id: 'box-stale-worker', state: 'running' };
      },
    },
    sandboxId: 'box-stale-worker',
    taskId: 'task-box-stale-worker',
    providerId: 'boxlite-test',
    ownership: {
      ownerGeneration: 'owner:stale-worker',
      resourceGeneration: 'resource:stale-worker',
    },
    beforeSandboxCleanup: async () => {
      cleanupAuthorityEntered.resolve();
      return cleanupAuthorityDecision.promise;
    },
    afterSandboxCleanup: async () => {
      cleanupCompletions += 1;
    },
    deletionConfirmation: { attempts: 1 },
  });
  const cancellation = new AbortController();
  cancellation.abort();
  assert.deepEqual(
    await adapter.stageExecutor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.equal(deleteCalls, 0);
  const staleCleanup = adapter.settleCredentialSafety();

  await cleanupAuthorityEntered.promise;
  assert.equal(deleteCalls, 0);
  cleanupAuthorityDecision.resolve(null);
  await staleCleanup;
  assert.equal(deleteCalls, 0);
  assert.equal(cleanupCompletions, 0);
  assert.equal(adapter.wasSandboxFenced(), false);
}

{
  // Detached transfer: a dropped polling exec is never settlement evidence
  // and must not force whole-sandbox fencing — the next marker probe settles
  // the stage from the job's pid/exit markers.
  let deleteCalls = 0;
  let execCount = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        execCount += 1;
        if (execCount === 1) {
          throw new Error('poll response dropped mid-transfer');
        }
        return result({ output: 'exit 0\nprogress 4096 1750000000\n' });
      },
      async deleteSandbox() {
        deleteCalls += 1;
      },
      async getSandbox() {
        return { id: 'box-detached-drop', state: 'running' };
      },
    },
    sandboxId: 'box-detached-drop',
  });
  const signal = new AbortController().signal;
  const dropped = await adapter.stageExecutor.execute({
    stage: 'workspace_transfer',
    request: { command: 'probe transfer markers', timeoutMs: 30_000 },
    signal,
    remainingTimeoutMs: 30_000,
  });
  assert.deepEqual(dropped, result({ exitCode: 124, timedOut: true }));
  assert.equal(adapter.wasSandboxFenced(), false);
  assert.equal(adapter.wasSandboxCleanupAttempted(), false);
  const settledProbe = await adapter.stageExecutor.execute({
    stage: 'workspace_transfer',
    request: { command: 'probe transfer markers', timeoutMs: 30_000 },
    signal,
    remainingTimeoutMs: 30_000,
  });
  assert.equal(settledProbe.exitCode, 0);
  assert.match(settledProbe.output, /^exit 0$/mu);
  // Transient exec loss requires no fencing lineage at settlement time.
  await adapter.settleCredentialSafety();
  assert.equal(deleteCalls, 0);
  assert.equal(adapter.wasSandboxFenced(), false);
  assert.equal(adapter.wasSandboxCleanupAttempted(), false);
}

{
  // Detached transfer: a timed-out polling exec result is returned as-is
  // (the dual-gate liveness policy owns transfer timeout semantics) and does
  // not trigger sandbox fencing.
  let deleteCalls = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        return result({ exitCode: 124, timedOut: true });
      },
      async deleteSandbox() {
        deleteCalls += 1;
      },
      async getSandbox() {
        return { id: 'box-detached-timeout', state: 'running' };
      },
    },
    sandboxId: 'box-detached-timeout',
  });
  const timedOut = await adapter.stageExecutor.execute({
    stage: 'workspace_transfer',
    request: { command: 'probe transfer markers', timeoutMs: 30_000 },
    signal: new AbortController().signal,
    remainingTimeoutMs: 30_000,
  });
  assert.deepEqual(timedOut, result({ exitCode: 124, timedOut: true }));
  await adapter.settleCredentialSafety();
  assert.equal(deleteCalls, 0);
  assert.equal(adapter.wasSandboxFenced(), false);
  assert.equal(adapter.wasSandboxCleanupAttempted(), false);
}

{
  // Detached transfer: after a cancelled control exec whose transport
  // response is lost, the kill exec still travels the stage seam with a
  // fresh signal and reaches the guest job instead of a fenced sandbox.
  const execCommands = [];
  let deleteCalls = 0;
  const lateExec = deferred();
  let execCount = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec(request) {
        execCommands.push(request.command);
        execCount += 1;
        if (execCount === 1) return lateExec.promise;
        return result();
      },
      async deleteSandbox() {
        deleteCalls += 1;
      },
      async getSandbox() {
        return { id: 'box-detached-kill', state: 'running' };
      },
    },
    sandboxId: 'box-detached-kill',
  });
  const cancellation = new AbortController();
  const running = adapter.stageExecutor.execute({
    stage: 'workspace_transfer',
    request: {
      command: 'probe transfer markers',
      timeoutMs: 30_000,
      signal: cancellation.signal,
    },
    signal: cancellation.signal,
    remainingTimeoutMs: 30_000,
  });
  await Promise.resolve();
  cancellation.abort();
  assert.deepEqual(await running, result({ exitCode: 124, timedOut: true }));
  assert.equal(adapter.wasSandboxFenced(), false);
  const killResult = await adapter.stageExecutor.execute({
    stage: 'workspace_transfer',
    request: {
      command:
        `kill -TERM -- "-$(cat '/tmp/cap-jobs/ws-transfer-task/pid')" 2>/dev/null; exit 0`,
      timeoutMs: 30_000,
    },
    signal: new AbortController().signal,
    remainingTimeoutMs: 30_000,
  });
  assert.equal(killResult.exitCode, 0);
  assert.equal(killResult.timedOut, false);
  assert.equal(execCommands.length, 2);
  assert.match(execCommands[1], /kill -TERM/u);
  await adapter.settleCredentialSafety();
  assert.equal(deleteCalls, 0);
  assert.equal(adapter.wasSandboxFenced(), false);
  lateExec.resolve(result());
  await Promise.resolve();
}

assert.throws(
  () => mod.resolveBoxLiteGitSecretDirectory('/'),
  (error) => error?.code === 'sandbox_provider_configuration_error',
);

{
  const client = {
    async exec() {
      return result();
    },
    async deleteSandbox() {},
    async getSandbox() {
      return null;
    },
  };
  assert.throws(
    () =>
      mod.createBoxLiteWorkspaceSecurityAdapter({
        client,
        sandboxId: 'box-callback-before-only',
        beforeSandboxCleanup: async () => null,
      }),
    /cleanup callbacks must be provided together/,
  );
  assert.throws(
    () =>
      mod.createBoxLiteWorkspaceSecurityAdapter({
        client,
        sandboxId: 'box-callback-after-only',
        afterSandboxCleanup: async () => undefined,
      }),
    /cleanup callbacks must be provided together/,
  );
  assert.throws(
    () =>
      mod.createBoxLiteWorkspaceSecurityAdapter({
        client,
        sandboxId: 'box-ownership-without-callbacks',
        ownership: {
          ownerGeneration: 'owner:missing-callbacks',
          resourceGeneration: 'resource:missing-callbacks',
        },
      }),
    /requires owner generation callbacks/,
  );
}

{
  let deleteCalls = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        throw new Error('pre-aborted stage must not execute');
      },
      async deleteSandbox() {
        deleteCalls += 1;
      },
      async getSandbox() {
        return null;
      },
    },
    sandboxId: 'box-mismatched-cleanup-authorization',
    taskId: 'task-expected-authorization',
    providerId: 'boxlite-test',
    ownership: {
      ownerGeneration: 'owner:expected-authorization',
      resourceGeneration: 'resource:expected-authorization',
    },
    beforeSandboxCleanup: async () => ({
      kind: 'generation',
      taskId: 'task-different-authorization',
      providerId: 'boxlite-test',
      ownership: {
        ownerGeneration: 'owner:expected-authorization',
        resourceGeneration: 'resource:expected-authorization',
      },
    }),
    afterSandboxCleanup: async () => undefined,
  });
  assert.deepEqual(
    await adapter.stageExecutor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: preAbortedSignal(),
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  await assert.rejects(
    () => adapter.settleCredentialSafety(),
    /cleanup authorization does not match the selected run/,
  );
  assert.equal(deleteCalls, 0);
}

{
  const taskId = 'task-legacy-failed-cleanup';
  const ownership = {
    ownerGeneration: 'owner:legacy-failed-cleanup',
    resourceGeneration: 'resource:legacy-failed-cleanup',
  };
  const authorization = {
    kind: 'generation',
    taskId,
    providerId: 'boxlite-test',
    ownership,
  };
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        throw new Error('pre-aborted stage must not execute');
      },
      async deleteSandbox() {
        throw new Error('delete transport unavailable');
      },
      async getSandbox() {
        return { id: 'box-legacy-failed-cleanup', state: 'running' };
      },
    },
    sandboxId: 'box-legacy-failed-cleanup',
    taskId,
    providerId: 'boxlite-test',
    ownership,
    beforeSandboxCleanup: async () => authorization,
    afterSandboxCleanup: async () => undefined,
    deletionConfirmation: { attempts: 1 },
  });
  await adapter.stageExecutor.execute({
    stage: 'checkout',
    request: { command: 'git checkout', timeoutMs: 1_000 },
    signal: preAbortedSignal(),
    remainingTimeoutMs: 1_000,
  });
  await assert.rejects(
    () => adapter.settleCredentialSafety(),
    (error) => error?.code === 'sandbox_cleanup_coordination_pending',
  );
  assert.equal(adapter.wasSandboxCleanupAcknowledged(), false);
}

await assert.rejects(
  () =>
    mod.attemptDeleteBoxLiteSandboxAndConfirm({
      client: {
        async deleteSandbox() {},
        async getSandbox() {
          return null;
        },
      },
      sandboxId: 'box-invalid-confirm-attempts',
      attempts: 0,
    }),
  /confirmation attempts must be positive/,
);

{
  const client = new mod.BoxLiteRestClient({
    baseUrl: 'https://boxlite.example.test',
    protocolMode: 'cap-rest',
    fetch: async (_input, init = {}) => ({
      ok: init.method !== 'DELETE',
      status: init.method === 'DELETE' ? 408 : 200,
      async json() {
        return { id: 'box-delete-408', state: 'running' };
      },
    }),
  });
  assert.deepEqual(
    await mod.attemptDeleteBoxLiteSandboxAndConfirm({
      client,
      sandboxId: 'box-delete-408',
      attempts: 1,
    }),
    {
      outcome: 'failed',
      proof: null,
      cause: 'cleanup_failed',
      retryable: true,
    },
  );
}

{
  let waits = 0;
  assert.deepEqual(
    await mod.attemptDeleteBoxLiteSandboxAndConfirm({
      client: {
        async deleteSandbox() {},
        async getSandbox() {
          return { id: 'box-delete-wait-failure', state: 'running' };
        },
      },
      sandboxId: 'box-delete-wait-failure',
      attempts: 2,
      async waitForRetry() {
        waits += 1;
        throw new Error('retry scheduler unavailable');
      },
    }),
    {
      outcome: 'indeterminate',
      proof: null,
      cause: 'cleanup_unconfirmed',
      retryable: true,
    },
  );
  assert.equal(waits, 1);
}

{
  let probes = 0;
  let waits = 0;
  assert.deepEqual(
    await mod.attemptDeleteBoxLiteSandboxAndConfirm({
      client: {
        async deleteSandbox() {},
        async getSandbox() {
          probes += 1;
          if (probes === 1) throw new Error('transient absence probe failure');
          return null;
        },
      },
      sandboxId: 'box-delete-transient-probe',
      attempts: 2,
      async waitForRetry(attempt) {
        waits += 1;
        assert.equal(attempt, 1);
      },
    }),
    {
      outcome: 'succeeded',
      proof: 'found-and-cleaned',
      cause: null,
      retryable: false,
    },
  );
  assert.equal(probes, 2);
  assert.equal(waits, 1);
}

{
  let flushCalls = 0;
  const physical = await mod.attemptDeleteBoxLiteSandboxAndConfirm({
    client: {
      async deleteSandbox() {},
      async getSandbox() {
        return null;
      },
    },
    sandboxId: 'box-cleanup-flush-rejection',
    attempts: 1,
    diagnostics: {
      mode: 'non-persisting',
      createOperationId: () => '33000000-0000-4000-8000-000000000001',
      async emit() {},
      async flush() {
        flushCalls += 1;
        throw new Error('diagnostic flush unavailable');
      },
    },
  });
  assert.equal(physical.outcome, 'succeeded');
  await Promise.resolve();
  assert.equal(flushCalls, 1);
}

{
  let fences = 0;
  let execCalls = 0;
  const executor = mod.createBoxLiteSandboxGitStageExecutor({
    client: {
      async exec() {
        execCalls += 1;
        return result();
      },
    },
    sandboxId: 'box-direct-executor-fence',
    fenceSandbox: async () => {
      fences += 1;
    },
  });
  assert.deepEqual(
    await executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: preAbortedSignal(),
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.equal(execCalls, 0);
  assert.equal(fences, 1);
}

{
  const cancellation = new AbortController();
  const signal = cancellation.signal;
  const addEventListener = signal.addEventListener.bind(signal);
  Object.defineProperty(signal, 'addEventListener', {
    configurable: true,
    value(type, listener, options) {
      addEventListener(type, listener, options);
      cancellation.abort();
    },
  });
  let execCalls = 0;
  let fenceRequirements = 0;
  const executor = mod.createBoxLiteSandboxGitStageExecutor({
    client: {
      async exec() {
        execCalls += 1;
        return result();
      },
    },
    sandboxId: 'box-abort-during-listener-arm',
    fenceSandbox: async () => assert.fail('deferred marker should own fencing'),
    requireSandboxFence: () => {
      fenceRequirements += 1;
    },
  });
  assert.deepEqual(
    await executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.equal(execCalls, 0);
  assert.equal(fenceRequirements, 1);
}

{
  for (const [failure, expected] of [
    [
      Object.assign(new Error('BoxLite execution aborted'), {
        name: 'AbortError',
      }),
      'timed-out',
    ],
    [new Error('BoxLite execution response lost'), 'configuration-error'],
  ]) {
    let fenceRequirements = 0;
    const executor = mod.createBoxLiteSandboxGitStageExecutor({
      client: {
        async exec() {
          throw failure;
        },
      },
      sandboxId: `box-stage-${expected}`,
      fenceSandbox: async () => assert.fail('deferred marker should own fencing'),
      requireSandboxFence: () => {
        fenceRequirements += 1;
      },
    });
    const execution = executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    });
    if (expected === 'timed-out') {
      assert.deepEqual(
        await execution,
        result({ exitCode: 124, timedOut: true }),
      );
    } else {
      await assert.rejects(
        () => execution,
        /workspace command settlement could not be observed safely/,
      );
    }
    assert.equal(fenceRequirements, 1);
  }
}

{
  let fenceRequirements = 0;
  const timedOutExecutor = mod.createBoxLiteSandboxGitStageExecutor({
    client: {
      async exec() {
        return result({ exitCode: 124, timedOut: true });
      },
    },
    sandboxId: 'box-stage-timed-out-result',
    fenceSandbox: async () => assert.fail('deferred marker should own fencing'),
    requireSandboxFence: () => {
      fenceRequirements += 1;
    },
  });
  assert.deepEqual(
    await timedOutExecutor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );

  const cancellation = new AbortController();
  const settledThenCancelled = mod.createBoxLiteSandboxGitStageExecutor({
    client: {
      async exec() {
        return {
          exitCode: 0,
          output: 'settled',
          stdout: 'settled',
          stderr: '',
          get timedOut() {
            cancellation.abort();
            return false;
          },
        };
      },
    },
    sandboxId: 'box-stage-cancelled-after-settlement',
    fenceSandbox: async () => assert.fail('deferred marker should own fencing'),
    requireSandboxFence: () => {
      fenceRequirements += 1;
    },
  });
  assert.deepEqual(
    await settledThenCancelled.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.equal(fenceRequirements, 2);
}

{
  const commandKinds = [];
  const executor = mod.createBoxLiteSandboxGitStageExecutor({
    client: {
      async exec(request) {
        commandKinds.push(request.commandKind);
        return result();
      },
    },
    sandboxId: 'box-delivery-stage-command-kinds',
    fenceSandbox: async () => assert.fail('successful stages must not fence'),
  });
  for (const stage of ['delivery_status', 'delivery_commit']) {
    assert.equal(
      (
        await executor.execute({
          stage,
          request: { command: `git ${stage}`, timeoutMs: 1_000 },
          signal: new AbortController().signal,
          remainingTimeoutMs: 1_000,
        })
      ).exitCode,
      0,
    );
  }
  assert.deepEqual(commandKinds, [undefined, undefined]);
}

{
  let execCalls = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        execCalls += 1;
        return result();
      },
      async deleteSandbox() {},
      async getSandbox() {
        return null;
      },
    },
    sandboxId: 'box-secret-without-upload',
    createSecretId: () => 'without-upload',
  });
  await assert.rejects(
    () => adapter.secretFilePort.writeSecretFile(secretWriteRequest()),
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(execCalls, 0);
}

{
  const uploads = [];
  const execCalls = [];
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async uploadArchive(request) {
        uploads.push({ path: request.path, archive: Buffer.from(request.archive) });
      },
      async exec(request) {
        execCalls.push(request);
        return result();
      },
      async deleteSandbox() {},
      async getSandbox() {
        return { id: 'box-root-secret-directory', state: 'running' };
      },
    },
    sandboxId: 'box-root-secret-directory',
    secretDirectory: '/',
    createSecretId: () => 'root-directory',
  });
  const handle = await adapter.secretFilePort.writeSecretFile(
    secretWriteRequest(),
  );
  assert.equal(handle.path, '/cap-git-credential-root-directory.config');
  assert.equal(
    uploads[0].path,
    '/.cap-git-credential-root-directory.config.upload',
  );
  assert.doesNotMatch(uploads[0].path, /^\/\//u);
  assert.match(execCalls[0].command, /mkdir -p -- '\/'/u);
  assert.doesNotMatch(execCalls[0].command, /\/\/\.cap-git/u);
  await adapter.secretFilePort.deleteSecretFile(handle);
  assert.match(
    execCalls[2].command,
    /rm -rf -- '\/\.cap-git-credential-root-directory\.config\.upload'/u,
  );
  assert.match(execCalls[2].command, /rmdir -- '\/'/u);
  assert.doesNotMatch(execCalls[2].command, /\/\/\.cap-git/u);
}

{
  async function assertPreparationFailure({ signal, exec }) {
    let absent = false;
    let execCalls = 0;
    const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
      client: {
        async uploadArchive() {
          assert.fail('failed preparation must not upload an archive');
        },
        exec(request) {
          execCalls += 1;
          return exec(request);
        },
        async deleteSandbox() {
          absent = true;
        },
        async getSandbox() {
          return absent ? null : { id: 'box-secret-prepare-failure' };
        },
      },
      sandboxId: 'box-secret-prepare-failure',
      createSecretId: () => `prepare-failure-${execCalls}`,
      deletionConfirmation: { attempts: 1 },
    });
    await assert.rejects(
      () => adapter.secretFilePort.writeSecretFile(secretWriteRequest(signal)),
      (error) => error?.code === 'sandbox_secret_file_operation_error',
    );
    assert.equal(adapter.wasSandboxFenced(), true);
    return execCalls;
  }

  assert.equal(
    await assertPreparationFailure({
      signal: undefined,
      exec() {
        throw new Error('synchronous preparation failure without a signal');
      },
    }),
    1,
  );
  assert.equal(
    await assertPreparationFailure({
      signal: preAbortedSignal(),
      exec() {
        return Promise.resolve(result());
      },
    }),
    0,
  );
  assert.equal(
    await assertPreparationFailure({
      signal: new AbortController().signal,
      exec() {
        throw new Error('synchronous preparation failure with a signal');
      },
    }),
    1,
  );
}

{
  const uploadStarted = deferred();
  const lateUpload = deferred();
  let absent = false;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        return result();
      },
      async uploadArchive() {
        uploadStarted.resolve();
        return lateUpload.promise;
      },
      async deleteSandbox() {
        absent = true;
      },
      async getSandbox() {
        return absent ? null : { id: 'box-secret-upload-cancelled' };
      },
    },
    sandboxId: 'box-secret-upload-cancelled',
    createSecretId: () => 'upload-cancelled',
    deletionConfirmation: { attempts: 1 },
  });
  const cancellation = new AbortController();
  const writing = adapter.secretFilePort.writeSecretFile(
    secretWriteRequest(cancellation.signal),
  );
  await uploadStarted.promise;
  cancellation.abort();
  await assert.rejects(
    writing,
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(adapter.wasSandboxFenced(), true);
  lateUpload.resolve();
  await Promise.resolve();
}

{
  let absent = false;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async exec() {
        return result();
      },
      async uploadArchive() {
        throw new Error('archive upload response lost');
      },
      async deleteSandbox() {
        absent = true;
      },
      async getSandbox() {
        return absent ? null : { id: 'box-secret-upload-error' };
      },
    },
    sandboxId: 'box-secret-upload-error',
    createSecretId: () => 'upload-error',
    deletionConfirmation: { attempts: 1 },
  });
  await assert.rejects(
    () => adapter.secretFilePort.writeSecretFile(secretWriteRequest()),
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(adapter.wasSandboxFenced(), true);
}

{
  for (const lookup of ['absent', 'throws']) {
    let execCalls = 0;
    const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
      client: {
        async uploadArchive() {},
        async exec() {
          execCalls += 1;
          return result();
        },
        async deleteSandbox() {},
        async getSandbox() {
          if (lookup === 'absent') return null;
          throw new Error('sandbox lookup unavailable');
        },
      },
      sandboxId: `box-secret-delete-${lookup}`,
      createSecretId: () => `delete-${lookup}`,
    });
    const handle = await adapter.secretFilePort.writeSecretFile(
      secretWriteRequest(),
    );
    await adapter.secretFilePort.deleteSecretFile(handle);
    assert.equal(execCalls, lookup === 'absent' ? 2 : 3);
    assert.equal(adapter.wasSandboxFenced(), false);
  }
}

{
  let absent = false;
  let execCalls = 0;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async uploadArchive() {},
      async exec() {
        execCalls += 1;
        if (execCalls === 3) throw new Error('secret delete response lost');
        return result();
      },
      async deleteSandbox() {
        absent = true;
      },
      async getSandbox() {
        return absent ? null : { id: 'box-secret-delete-error' };
      },
    },
    sandboxId: 'box-secret-delete-error',
    createSecretId: () => 'delete-error',
    deletionConfirmation: { attempts: 1 },
  });
  const handle = await adapter.secretFilePort.writeSecretFile(
    secretWriteRequest(),
  );
  await assert.rejects(
    () => adapter.secretFilePort.deleteSecretFile(handle),
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(adapter.wasSandboxFenced(), true);
}

{
  let absent = false;
  const adapter = mod.createBoxLiteWorkspaceSecurityAdapter({
    client: {
      async uploadArchive() {},
      async exec() {
        return result();
      },
      async deleteSandbox() {
        absent = true;
      },
      async getSandbox() {
        return absent ? null : { id: 'box-secret-after-fence' };
      },
    },
    sandboxId: 'box-secret-after-fence',
    createSecretId: () => 'after-fence',
    deletionConfirmation: { attempts: 1 },
  });
  await adapter.stageExecutor.execute({
    stage: 'checkout',
    request: { command: 'git checkout', timeoutMs: 1_000 },
    signal: preAbortedSignal(),
    remainingTimeoutMs: 1_000,
  });
  await adapter.settleCredentialSafety();
  assert.equal(adapter.wasSandboxFenced(), true);
  const handle = await adapter.secretFilePort.writeSecretFile(
    secretWriteRequest(),
  );
  await adapter.secretFilePort.deleteSecretFile(handle);
  assert.equal(adapter.wasSandboxFenced(), true);
}

console.log('BoxLite workspace security tests passed');
