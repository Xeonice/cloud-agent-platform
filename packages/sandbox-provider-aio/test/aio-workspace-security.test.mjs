import assert from 'node:assert/strict';

import {
  createExactHostGitCredential,
} from '@cap/sandbox-core';
import {
  AioSandboxContainerController,
  createAioMode0600FileArchive,
  createAioSandboxGitStageExecutor,
  createAioWorkspaceSecurityAdapter,
  extractFilesFromTar,
} from '../dist/index.js';

const CANARY = 'CAP_AIO_ARCHIVE_CANARY_91e4';

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
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

{
  const archive = createAioMode0600FileArchive(
    'credential.config',
    Buffer.from(CANARY),
  );
  assert.equal(parseInt(Buffer.from(archive).toString('ascii', 100, 107), 8), 0o600);
  assert.equal(parseInt(Buffer.from(archive).toString('ascii', 108, 115), 8), 1000);
  assert.equal(parseInt(Buffer.from(archive).toString('ascii', 116, 123), 8), 1000);
  const files = extractFilesFromTar(Buffer.from(archive), () => true);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'credential.config');
  assert.equal(files[0].content.toString('utf8'), CANARY);
}

{
  const archives = [];
  const commands = [];
  const controller = {
    async putPrivateArchive(_taskId, directory, archive) {
      archives.push({ directory, archive: Buffer.from(archive) });
    },
    async isSandboxConfirmedAbsent() {
      return false;
    },
    async removeSandboxAndConfirm() {
      assert.fail('normal secret operations must not remove the sandbox');
    },
  };
  const executor = {
    async exec(request) {
      commands.push(request);
      return result();
    },
  };
  const adapter = createAioWorkspaceSecurityAdapter({
    taskId: 'task-aio-secret',
    controller,
    executor,
    createSecretId: () => 'aio-fixture',
  });
  const handle = await adapter.secretFilePort.writeSecretFile({
    kind: 'git-http-credential',
    credential: createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      `Authorization: Basic ${CANARY}`,
    ),
  });
  assert.equal(handle.mode, 0o600);
  assert.equal(archives[0].directory, '/tmp');
  const files = extractFilesFromTar(archives[0].archive, () => true);
  assert.equal(files.length, 1);
  assert.match(files[0].content.toString('utf8'), new RegExp(CANARY, 'u'));
  assert.doesNotMatch(JSON.stringify(commands), new RegExp(CANARY, 'u'));
  assert.match(commands[0].command, /mkdir -p/u);
  const verification = commands.find(({ command }) => /stat -c %a/u.test(command));
  assert.ok(verification);
  assert.match(verification.command, /stat -c %u/u);
  assert.match(verification.command, /stat -c %g/u);
  await adapter.secretFilePort.deleteSecretFile(handle);
  assert.ok(commands.some(({ command }) => /rm -f/u.test(command)));
  assert.doesNotMatch(JSON.stringify(commands), /Authorization:/u);
}

{
  const events = [];
  const state = { retainedCredential: false, absent: false };
  let commandCount = 0;
  const adapter = createAioWorkspaceSecurityAdapter({
    taskId: 'task-aio-delete-fence',
    controller: {
      async putPrivateArchive() {
        state.retainedCredential = true;
        events.push('credential-written');
      },
      async isSandboxConfirmedAbsent() {
        events.push('inspect-uncertain');
        throw new Error('temporary Docker inspect failure');
      },
      async removeSandboxAndConfirm() {
        state.retainedCredential = false;
        state.absent = true;
        events.push('sandbox-removed-and-confirmed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec(request) {
        commandCount += 1;
        if (!/rm -f/u.test(request.command)) return result();
        events.push('credential-delete-unconfirmed');
        return result({ exitCode: 1 });
      },
    },
    createSecretId: () => 'delete-fence-fixture',
  });
  const handle = await adapter.secretFilePort.writeSecretFile({
    kind: 'git-http-credential',
    credential: createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      `Authorization: Basic ${CANARY}`,
    ),
  });
  await assert.rejects(
    adapter.secretFilePort.deleteSecretFile(handle),
    (error) =>
      error?.code === 'sandbox_secret_file_operation_error' &&
      !error.message.includes(CANARY),
  );
  assert.equal(state.absent, true);
  assert.equal(state.retainedCredential, false);
  assert.deepEqual(events.slice(-3), [
    'inspect-uncertain',
    'credential-delete-unconfirmed',
    'sandbox-removed-and-confirmed',
  ]);
}

{
  const events = [];
  let capturedArchive = null;
  const adapter = createAioWorkspaceSecurityAdapter({
    taskId: 'task-aio-archive-response-lost',
    controller: {
      async putPrivateArchive(_taskId, _directory, archive) {
        capturedArchive = Buffer.from(archive);
        events.push('private-bytes-reached-provider');
        throw new Error('archive response lost after extraction');
      },
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed-and-confirmed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec(request) {
        events.push(
          request.command.includes('mkdir -p')
            ? 'directory-ready'
            : request.command.includes('rm -f')
              ? 'post-fence-delete-attempt'
              : 'unexpected-exec',
        );
        return result();
      },
    },
    createSecretId: () => 'archive-response-lost',
  });
  await assert.rejects(
    adapter.secretFilePort.writeSecretFile({
      kind: 'git-http-credential',
      credential: createExactHostGitCredential(
        'https://code.example.test/acme/private.git',
        `Authorization: Basic ${CANARY}`,
      ),
    }),
    (error) =>
      error?.code === 'sandbox_secret_file_operation_error' &&
      !JSON.stringify(error).includes(CANARY) &&
      !JSON.stringify(error).includes('archive response lost'),
  );
  assert.ok(capturedArchive?.includes(Buffer.from(CANARY)));
  assert.equal(adapter.wasSandboxFenced(), true);
  assert.deepEqual(events, [
    'directory-ready',
    'private-bytes-reached-provider',
    'sandbox-removed-and-confirmed',
    'post-fence-delete-attempt',
  ]);
}

{
  const events = [];
  let removed = false;
  const notFound = Object.assign(new Error('container missing'), {
    statusCode: 404,
  });
  const container = {
    async inspect() {
      events.push('inspect');
      if (removed) throw notFound;
      return { id: 'ambiguous-remove' };
    },
    async remove() {
      events.push('remove-response-lost');
      removed = true;
      throw new Error('Docker response connection lost');
    },
  };
  const controller = new AioSandboxContainerController({
    docker: {
      getContainer() {
        return container;
      },
    },
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:test' },
  });
  await controller.removeSandboxAndConfirm('task-ambiguous-remove');
  assert.deepEqual(events, [
    'inspect',
    'remove-response-lost',
    'inspect',
  ]);
}

{
  const events = [];
  let inspectCount = 0;
  let removed = false;
  const notFound = Object.assign(new Error('container missing'), {
    statusCode: 404,
  });
  const container = {
    async inspect() {
      inspectCount += 1;
      events.push(`inspect-${inspectCount}`);
      if (inspectCount === 1) throw new Error('temporary inspect failure');
      if (removed) throw notFound;
      return { id: 'uncertain-inspect' };
    },
    async remove() {
      events.push('force-remove');
      removed = true;
    },
  };
  const controller = new AioSandboxContainerController({
    docker: {
      getContainer() {
        return container;
      },
    },
    env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:test' },
  });
  await controller.removeSandboxAndConfirm('task-uncertain-inspect');
  assert.deepEqual(events, ['inspect-1', 'force-remove', 'inspect-2']);
}

{
  const events = [];
  const state = { retainedCredential: false, absent: false };
  const adapter = createAioWorkspaceSecurityAdapter({
    taskId: 'task-aio-mode-fence',
    controller: {
      async putPrivateArchive() {
        state.retainedCredential = true;
        events.push('credential-written');
      },
      async isSandboxConfirmedAbsent() {
        return state.absent;
      },
      async removeSandboxAndConfirm() {
        state.retainedCredential = false;
        state.absent = true;
        events.push('sandbox-removed-and-confirmed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec(request) {
        if (/mkdir -p/u.test(request.command)) return result();
        events.push('mode-verification-failed');
        return result({ exitCode: 1 });
      },
    },
    createSecretId: () => 'mode-fence-fixture',
  });
  await assert.rejects(
    adapter.secretFilePort.writeSecretFile({
      kind: 'git-http-credential',
      credential: createExactHostGitCredential(
        'https://code.example.test/acme/private.git',
        `Authorization: Basic ${CANARY}`,
      ),
    }),
    (error) =>
      error?.code === 'sandbox_secret_file_operation_error' &&
      !error.message.includes(CANARY),
  );
  assert.equal(state.absent, true);
  assert.equal(state.retainedCredential, false);
  assert.deepEqual(events, [
    'credential-written',
    'mode-verification-failed',
    'sandbox-removed-and-confirmed',
  ]);
}

{
  const events = [];
  const settled = deferred();
  const started = deferred();
  const abort = new AbortController();
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-cancel',
    controller: {
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec() {
        events.push('guest-started');
        started.resolve();
        const value = await settled.promise;
        events.push('guest-stopped');
        return value;
      },
    },
  });
  const running = executor.execute({
    stage: 'workspace_transfer',
    request: { command: 'git clone', timeoutMs: 1_000 },
    signal: abort.signal,
    remainingTimeoutMs: 1_000,
  });
  await started.promise;
  abort.abort();
  await Promise.resolve();
  assert.deepEqual(events, ['guest-started']);
  settled.resolve(result());
  const completed = await running;
  assert.equal(completed.exitCode, 0);
  assert.deepEqual(events, ['guest-started', 'guest-stopped']);
}

{
  const events = [];
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-unsafe-error',
    controller: {
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed-and-confirmed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec() {
        events.push('transport-failed');
        throw new Error('connection disappeared');
      },
    },
  });
  await assert.rejects(
    executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    }),
    /could not be observed safely/u,
  );
  assert.deepEqual(events, [
    'transport-failed',
    'sandbox-removed-and-confirmed',
  ]);
}

{
  const events = [];
  const exactOwnership = {
    ownerGeneration: 'workspace-owner-denied',
    resourceGeneration: 'workspace-resource-denied',
  };
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-cleanup-denied',
    ownership: exactOwnership,
    beforeSandboxCleanup: async () => {
      events.push('cleanup-cas-denied');
      return null;
    },
    afterSandboxCleanup: async () => {
      events.push('cleanup-settled');
    },
    controller: {
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec() {
        events.push('transport-failed');
        throw new Error('connection disappeared');
      },
    },
  });
  await assert.rejects(
    executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    }),
    /cleanup was not authorized/u,
  );
  assert.deepEqual(events, ['transport-failed', 'cleanup-cas-denied']);
}

{
  const events = [];
  const exactOwnership = {
    ownerGeneration: 'workspace-owner-authorized',
    resourceGeneration: 'workspace-resource-authorized',
  };
  const authorization = {
    kind: 'generation',
    taskId: 'task-aio-cleanup-authorized',
    providerId: 'aio-local',
    ownership: exactOwnership,
  };
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-cleanup-authorized',
    ownership: exactOwnership,
    beforeSandboxCleanup: async () => {
      events.push('cleanup-cas-won');
      return authorization;
    },
    afterSandboxCleanup: async (received) => {
      assert.equal(received, authorization);
      events.push('cleanup-settled');
    },
    controller: {
      async removeSandboxAndConfirm(taskId, ownership) {
        assert.equal(taskId, 'task-aio-cleanup-authorized');
        assert.equal(ownership, exactOwnership);
        events.push('exact-sandbox-removed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec() {
        events.push('transport-failed');
        throw new Error('connection disappeared');
      },
    },
  });
  await assert.rejects(
    executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    }),
    /could not be observed safely/u,
  );
  assert.deepEqual(events, [
    'transport-failed',
    'cleanup-cas-won',
    'exact-sandbox-removed',
    'cleanup-settled',
  ]);
}

{
  // Detached transfer (inherited through the shared configured-provider
  // hook): a dropped polling exec is never settlement evidence and must not
  // force whole-sandbox fencing — the next marker probe settles the stage
  // from the job's pid/exit markers.
  const events = [];
  let execCount = 0;
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-detached-drop',
    controller: {
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec() {
        execCount += 1;
        if (execCount === 1) {
          events.push('poll-dropped');
          throw new Error('connection disappeared');
        }
        events.push('marker-probe');
        return result({ output: 'exit 0\nprogress 4096 1750000000\n' });
      },
    },
  });
  const signal = new AbortController().signal;
  const dropped = await executor.execute({
    stage: 'workspace_transfer',
    request: { command: 'probe transfer markers', timeoutMs: 30_000 },
    signal,
    remainingTimeoutMs: 30_000,
  });
  assert.deepEqual(dropped, result({ exitCode: 124, timedOut: true }));
  assert.deepEqual(events, ['poll-dropped']);
  const settledProbe = await executor.execute({
    stage: 'workspace_transfer',
    request: { command: 'probe transfer markers', timeoutMs: 30_000 },
    signal,
    remainingTimeoutMs: 30_000,
  });
  assert.equal(settledProbe.exitCode, 0);
  assert.match(settledProbe.output, /^exit 0$/mu);
  // Transient exec loss never reached the sandbox-removal path.
  assert.deepEqual(events, ['poll-dropped', 'marker-probe']);
}

{
  // Detached transfer: a timed-out polling exec result is returned as-is
  // (dual-gate liveness owns transfer timeout semantics), a pre-aborted
  // control exec settles as timed out, and neither removes the sandbox; the
  // kill exec then reaches the guest job through the same stage seam.
  const events = [];
  const commands = [];
  let execCount = 0;
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-detached-kill',
    controller: {
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed');
        return { kind: 'found-and-cleaned' };
      },
    },
    executor: {
      async exec(request) {
        commands.push(request.command);
        execCount += 1;
        if (execCount === 1) return result({ exitCode: 124, timedOut: true });
        return result();
      },
    },
  });
  const timedOut = await executor.execute({
    stage: 'workspace_transfer',
    request: { command: 'probe transfer markers', timeoutMs: 30_000 },
    signal: new AbortController().signal,
    remainingTimeoutMs: 30_000,
  });
  assert.deepEqual(timedOut, result({ exitCode: 124, timedOut: true }));
  assert.deepEqual(events, []);
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(
    await executor.execute({
      stage: 'workspace_transfer',
      request: { command: 'probe transfer markers', timeoutMs: 30_000 },
      signal: aborted.signal,
      remainingTimeoutMs: 30_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.deepEqual(events, []);
  const killResult = await executor.execute({
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
  assert.match(commands[1], /kill -TERM/u);
  assert.deepEqual(events, []);
}

{
  const events = [];
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-timeout-fence',
    controller: {
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed-and-confirmed');
      },
    },
    executor: {
      async exec() {
        events.push('checkout-timed-out');
        return result({ exitCode: 124, timedOut: true });
      },
    },
  });
  assert.deepEqual(
    await executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.deepEqual(events, [
    'checkout-timed-out',
    'sandbox-removed-and-confirmed',
  ]);
}

{
  const events = [];
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-abort-error',
    controller: {
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed-and-confirmed');
      },
    },
    executor: {
      async exec() {
        events.push('checkout-aborted');
        const error = new Error('request aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
  });
  assert.deepEqual(
    await executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    }),
    result({ exitCode: 124, timedOut: true }),
  );
  assert.deepEqual(events, [
    'checkout-aborted',
    'sandbox-removed-and-confirmed',
  ]);
}

{
  const events = [];
  const adapter = createAioWorkspaceSecurityAdapter({
    taskId: 'task-aio-mode-response-lost',
    controller: {
      async putPrivateArchive() {
        events.push('credential-written');
      },
      async isSandboxConfirmedAbsent() {
        return events.includes('sandbox-removed-and-confirmed');
      },
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed-and-confirmed');
      },
    },
    executor: {
      async exec(request) {
        if (/mkdir -p/u.test(request.command)) return result();
        events.push('mode-response-lost');
        throw new Error('verification response lost');
      },
    },
    onSandboxFenced() {
      events.push('fence-observed');
    },
    createSecretId: () => 'mode-response-lost',
  });
  await assert.rejects(
    adapter.secretFilePort.writeSecretFile({
      kind: 'git-http-credential',
      credential: createExactHostGitCredential(
        'https://code.example.test/acme/private.git',
        `Authorization: Basic ${CANARY}`,
      ),
    }),
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(adapter.wasSandboxFenced(), true);
  assert.deepEqual(events, [
    'credential-written',
    'mode-response-lost',
    'sandbox-removed-and-confirmed',
    'fence-observed',
  ]);
}

{
  const events = [];
  let execCount = 0;
  const adapter = createAioWorkspaceSecurityAdapter({
    taskId: 'task-aio-delete-response-lost',
    controller: {
      async putPrivateArchive() {},
      async isSandboxConfirmedAbsent() {
        return false;
      },
      async removeSandboxAndConfirm() {
        events.push('sandbox-removed-and-confirmed');
      },
    },
    executor: {
      async exec(request) {
        execCount += 1;
        if (!/rm -f/u.test(request.command)) return result();
        events.push('delete-response-lost');
        throw new Error('delete response lost');
      },
    },
    createSecretId: () => 'delete-response-lost',
  });
  const handle = await adapter.secretFilePort.writeSecretFile({
    kind: 'git-http-credential',
    credential: createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      `Authorization: Basic ${CANARY}`,
    ),
  });
  await assert.rejects(
    adapter.secretFilePort.deleteSecretFile(handle),
    (error) => error?.code === 'sandbox_secret_file_operation_error',
  );
  assert.equal(adapter.wasSandboxFenced(), true);
  assert.deepEqual(events, [
    'delete-response-lost',
    'sandbox-removed-and-confirmed',
  ]);
}

{
  const archives = [];
  const adapter = createAioWorkspaceSecurityAdapter({
    taskId: 'task-aio-root-secret-directory',
    secretDirectory: '/',
    controller: {
      async putPrivateArchive(_taskId, directory) {
        archives.push(directory);
      },
      async isSandboxConfirmedAbsent() {
        return false;
      },
      async removeSandboxAndConfirm() {
        assert.fail('successful root-directory secret operations must not fence');
      },
    },
    executor: { async exec() { return result(); } },
    createSecretId: () => 'root-directory',
  });
  const handle = await adapter.secretFilePort.writeSecretFile({
    kind: 'git-http-credential',
    credential: createExactHostGitCredential(
      'https://code.example.test/acme/private.git',
      `Authorization: Basic ${CANARY}`,
    ),
  });
  assert.equal(handle.path, '/cap-git-credential-root-directory.config');
  assert.deepEqual(archives, ['/']);
  await adapter.secretFilePort.deleteSecretFile(handle);
}

{
  const ownership = {
    ownerGeneration: 'workspace-owner-requires-authorization',
    resourceGeneration: 'workspace-resource-requires-authorization',
  };
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-requires-authorization',
    ownership,
    controller: {
      async removeSandboxAndConfirm() {
        assert.fail('cleanup without durable authorization must not remove');
      },
    },
    executor: {
      async exec() {
        return result({ exitCode: 124, timedOut: true });
      },
    },
  });
  await assert.rejects(
    executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    }),
    /requires current durable authorization/u,
  );
}

for (const fixture of [
  {
    name: 'task mismatch',
    providerId: 'aio-local',
    authorization: {
      kind: 'legacy',
      taskId: 'another-task',
      providerId: 'aio-local',
    },
    expected: /does not match the selected run/u,
  },
  {
    name: 'provider mismatch',
    providerId: 'aio-local',
    authorization: {
      kind: 'legacy',
      taskId: 'task-aio-invalid-authorization',
      providerId: 'boxlite',
    },
    expected: /does not match the selected run/u,
  },
  {
    name: 'legacy authorization with generation ownership',
    ownership: {
      ownerGeneration: 'workspace-owner-current',
      resourceGeneration: 'workspace-resource-current',
    },
    authorization: {
      kind: 'legacy',
      taskId: 'task-aio-invalid-authorization',
      providerId: 'aio-local',
    },
    expected: /changed physical generation/u,
  },
  {
    name: 'changed resource generation',
    ownership: {
      ownerGeneration: 'workspace-owner-current',
      resourceGeneration: 'workspace-resource-current',
    },
    authorization: {
      kind: 'generation',
      taskId: 'task-aio-invalid-authorization',
      providerId: 'aio-local',
      ownership: {
        ownerGeneration: 'workspace-owner-current',
        resourceGeneration: 'workspace-resource-stale',
      },
    },
    expected: /changed physical generation/u,
  },
]) {
  const executor = createAioSandboxGitStageExecutor({
    taskId: 'task-aio-invalid-authorization',
    providerId: fixture.providerId,
    ownership: fixture.ownership,
    beforeSandboxCleanup: async () => fixture.authorization,
    controller: {
      async removeSandboxAndConfirm() {
        assert.fail(`${fixture.name} must fail before physical cleanup`);
      },
    },
    executor: {
      async exec() {
        return result({ exitCode: 124, timedOut: true });
      },
    },
  });
  await assert.rejects(
    executor.execute({
      stage: 'checkout',
      request: { command: 'git checkout', timeoutMs: 1_000 },
      signal: new AbortController().signal,
      remainingTimeoutMs: 1_000,
    }),
    fixture.expected,
  );
}

console.log('aio workspace security tests passed');
