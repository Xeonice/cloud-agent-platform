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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  assert.match(execCalls[1].command, /mv -- "\$source"/u);
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
      stage: 'workspace_transfer',
      request: { command: 'git clone', timeoutMs: 5_000 },
      signal: cancellation.signal,
      remainingTimeoutMs: 5_000,
    })
    .finally(() => {
      settled = true;
    });
  await execStarted.promise;
  cancellation.abort();
  await deleteStarted.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  confirmation.resolve(null);
  assert.deepEqual(await running, result({ exitCode: 124, timedOut: true }));
  assert.equal(adapter.wasSandboxFenced(), true);
  lateExec.reject(new Error('late dropped exec response'));
  await Promise.resolve();
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
  await assert.rejects(
    () =>
      adapter.stageExecutor.execute({
        stage: 'remote_ref_resolution',
        request: { command: 'git ls-remote', timeoutMs: 1_000 },
        signal: cancellation.signal,
        remainingTimeoutMs: 1_000,
      }),
    (error) =>
      error?.code === 'sandbox_provider_configuration_error' &&
      error.message === 'BoxLite credential safety fencing could not be confirmed',
  );
  assert.equal(execCalls, 0);
  assert.equal(probes, 2);
  assert.equal(waits, 1);
  assert.equal(adapter.wasSandboxFenced(), false);
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
  const staleCleanup = adapter.stageExecutor.execute({
    stage: 'workspace_transfer',
    request: { command: 'git clone', timeoutMs: 1_000 },
    signal: cancellation.signal,
    remainingTimeoutMs: 1_000,
  });

  await cleanupAuthorityEntered.promise;
  assert.equal(deleteCalls, 0);
  cleanupAuthorityDecision.resolve(null);
  assert.deepEqual(
    await staleCleanup,
    result({ exitCode: 124, timedOut: true }),
  );
  assert.equal(deleteCalls, 0);
  assert.equal(cleanupCompletions, 0);
  assert.equal(adapter.wasSandboxFenced(), false);
}

console.log('BoxLite workspace security tests passed');
