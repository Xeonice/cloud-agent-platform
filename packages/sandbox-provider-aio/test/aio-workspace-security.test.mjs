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
  assert.match(commands[0].command, /stat -c %a/u);
  await adapter.secretFilePort.deleteSecretFile(handle);
  assert.match(commands[1].command, /rm -f/u);
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
      async exec() {
        commandCount += 1;
        if (commandCount === 1) return result();
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
      async exec() {
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
      stage: 'workspace_transfer',
      request: { command: 'git clone', timeoutMs: 1_000 },
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
      stage: 'workspace_transfer',
      request: { command: 'git clone', timeoutMs: 1_000 },
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
      stage: 'workspace_transfer',
      request: { command: 'git clone', timeoutMs: 1_000 },
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

console.log('aio workspace security tests passed');
