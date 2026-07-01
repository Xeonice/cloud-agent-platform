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

function response(status, body = { data: { exit_code: 0, output: '' } }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function makeContainer(name = 'container') {
  const calls = [];
  return {
    name,
    calls,
    async start() {
      calls.push(['start']);
    },
    async stop(options) {
      calls.push(['stop', options]);
    },
    async remove(options) {
      calls.push(['remove', options]);
    },
    async inspect() {
      calls.push(['inspect']);
      return { id: name };
    },
    async getArchive() {
      throw new Error('not implemented');
    },
  };
}

function makeDocker() {
  const created = [];
  const byName = new Map();
  let running = [];
  return {
    created,
    byName,
    setRunning(value) {
      running = value;
    },
    async createContainer(options) {
      const container = makeContainer(options.name);
      created.push({ options, container });
      byName.set(options.name, container);
      return container;
    },
    getContainer(name) {
      if (!byName.has(name)) byName.set(name, makeContainer(name));
      return byName.get(name);
    },
    async listContainers() {
      return running;
    },
  };
}

function makeFetch(handler) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { input, path: url.pathname, method: init.method ?? 'GET', body, init };
    calls.push(call);
    if (url.pathname === '/v1/docs') return response(200);
    return handler?.(call) ?? response(200);
  };
  return { fetch, calls };
}

function makeProvider(options = {}) {
  const docker = options.docker ?? makeDocker();
  const fetchState = makeFetch(options.fetchHandler);
  const controller = new mod.AioSandboxContainerController({
    docker,
    fetch: fetchState.fetch,
    env: {
      AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0',
      AIO_SANDBOX_NETWORK: 'cap-private',
    },
    delay: async () => undefined,
  });
  const provider = new mod.AioSandboxProvider({
    controller,
    fetch: fetchState.fetch,
    hooks: options.hooks,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  return { provider, controller, docker, fetchState };
}

function isDeliveryCommand(command) {
  return [
    'git status --porcelain',
    'git add -A',
    '/tmp/cap-commit-msg',
    'commit -F',
    'git rev-parse HEAD',
    'push --force-with-lease',
  ].some((needle) => command.includes(needle));
}

await test('provisions AIO containers through provider hooks and descriptors', async () => {
  const events = [];
  const { provider, docker, fetchState } = makeProvider({
    hooks: {
      provisionLookup: {
        getRuntimeId: async () => 'codex',
        getTaskPrompt: async () => 'fix the task',
      },
      runtimePreflight: async (context) => {
        events.push(['preflight', context.runtimeId, context.workspaceDir]);
        return {
          status: 'passed',
          checkedAt: '2026-01-02T03:04:05.000Z',
          runtimeId: String(context.runtimeId),
        };
      },
      promptAuthInjection: async (context) => {
        events.push(['prompt-auth', context.prompt, context.containerName]);
      },
      runtimeSetup: async (context) => {
        events.push(['setup', context.runtimeId]);
      },
      skillPreinstall: async (context) => {
        events.push(['skills', context.providerSandboxId]);
      },
    },
  });

  assert.equal(provider.getSandboxMode(), 'danger-full-access');
  const connection = await provider.provision({
    taskId: 'task-1',
    cloneSpec: {
      url: 'https://example.invalid/repo.git',
      authHeader: 'Authorization: Basic secret',
    },
  });

  assert.equal(docker.created[0].options.name, 'cap-aio-task-1');
  assert.equal(docker.created[0].options.HostConfig.NetworkMode, 'cap-private');
  assert.deepEqual(connection, {
    taskId: 'task-1',
    baseUrl: 'http://cap-aio-task-1:8080',
    wsUrl: 'ws://cap-aio-task-1:8080/v1/shell/ws',
  });
  assert.equal(await provider.provision({ taskId: 'task-1' }), connection);
  assert.deepEqual(events, [
    ['preflight', 'codex', '/home/gem/workspace'],
    ['prompt-auth', 'fix the task', 'cap-aio-task-1'],
    ['setup', 'codex'],
    ['skills', 'task-1'],
  ]);
  assert.ok(
    fetchState.calls.some(
      (call) =>
        call.path === '/v1/shell/exec' &&
        call.body.command.includes('git -c') &&
        call.body.command.includes('clone --recursive'),
    ),
  );

  const selected = await provider.getSelectedSandboxRun('task-1');
  assert.equal(selected.providerId, 'aio-local');
  assert.equal(selected.providerSandboxId, 'task-1');
  assert.equal(selected.terminal.protocol, 'aio-json-v1');
  assert.equal(selected.command.protocol, 'aio-http-exec-v1');
  assert.equal(selected.command.workingDirectory, '/home/gem/workspace');
  assert.equal(selected.workspace.mode, 'git');
  assert.equal(selected.retention.mode, 'stop-retain');
  assert.deepEqual(selected.preflight, {
    status: 'passed',
    checkedAt: '2026-01-02T03:04:05.000Z',
    runtimeId: 'codex',
  });

  const descriptor = mod.defineAioSandboxProvider({
    controller: new mod.AioSandboxContainerController({
      docker: makeDocker(),
      env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
    }),
  });
  assert.equal(descriptor.id, 'aio-local');
  assert.equal(descriptor.location, 'local');
  assert.ok(descriptor.capabilities.includes('lifecycle.readopt'));
});

await test('uses lookup clone specs, delivers workspace changes, and scrubs failures', async () => {
  const commands = [];
  const execCalls = [];
  const { provider } = makeProvider({
    hooks: {
      provisionLookup: {
        getCloneSpec: () => ({ url: 'https://user:secret@example.invalid/repo.git' }),
      },
    },
    fetchHandler(call) {
      if (call.path !== '/v1/shell/exec') return response(200);
      execCalls.push(call);
      commands.push(call.body.command);
      if (call.body.command.includes('git status')) {
        return response(200, { data: { exit_code: 0, output: ' M file.txt\n' } });
      }
      if (call.body.command.includes('git rev-parse HEAD')) {
        return response(200, { data: { exit_code: 0, output: 'abc123\n' } });
      }
      if (call.body.command.includes(' push --force-with-lease ')) {
        return response(200, { data: { exit_code: 1, output: 'Bearer abc.def' } });
      }
      return response(200);
    },
  });

  await provider.provision({ taskId: 'task-2' });
  assert.ok(
    commands.some((command) =>
      command.includes("git  clone --recursive -- 'https://user:secret@example.invalid/repo.git'"),
    ),
  );

  const delivered = await provider.deliverWorkspaceChanges('task-2', {
    authHeader: 'Authorization: Basic xyz',
    branch: 'cap/result',
    commitMessage: "don't break quoting",
  });
  assert.deepEqual(delivered, {
    hadChanges: true,
    commitSha: 'abc123',
    error: 'git push failed: Bearer ***',
  });
  assert.ok(
    commands.some((command) =>
      command.includes("push --force-with-lease origin 'HEAD:cap/result'"),
    ),
    'delivery pushes the current HEAD to the requested remote branch',
  );
  const deliveryCalls = execCalls.filter((call) =>
    isDeliveryCommand(call.body.command),
  );
  assert.equal(
    deliveryCalls.length,
    6,
    'delivery runs status, add, message write, commit, rev-parse, and push',
  );
  assert.ok(
    deliveryCalls.every((call) => call.init.signal),
    'delivery git commands use bounded AbortSignal timeouts',
  );
});

await test('readopts running sandboxes and runs pre-stop hooks on teardown', async () => {
  const docker = makeDocker();
  docker.setRunning([{ Id: 'container-3', Names: ['/cap-aio-task-3'] }]);
  const trimCalls = [];
  const { provider } = makeProvider({
    docker,
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'codex',
      },
      preStopTrim: async (context) => {
        trimCalls.push([context.taskId, context.runtimeId, context.baseUrl]);
      },
      transcriptRead: async (context) => ({
        format: 'codex-jsonl',
        jsonl: `task=${context.taskId}`,
      }),
    },
    fetchHandler(call) {
      if (call.body?.command?.includes('tmux has-session')) {
        return response(200, { data: { exit_code: 0, output: '' } });
      }
      return response(200);
    },
  });

  assert.deepEqual(await provider.listReadoptable(), ['task-3']);
  const connection = await provider.reattach('task-3');
  assert.equal(connection.baseUrl, 'http://cap-aio-task-3:8080');
  const selected = await provider.getSelectedSandboxRun('task-3');
  assert.equal(selected.preflight.status, 'skipped');
  assert.equal(selected.preflight.runtimeId, 'codex');
  assert.deepEqual(await provider.readRolloutFromContainer('task-3'), {
    format: 'codex-jsonl',
    jsonl: 'task=task-3',
  });

  await provider.teardownSandbox('task-3');
  assert.deepEqual(trimCalls, [
    ['task-3', 'codex', 'http://cap-aio-task-3:8080'],
  ]);
  assert.deepEqual(docker.byName.get('cap-aio-task-3').calls.at(-1), ['stop', { t: 0 }]);
});

await test('surfaces command executor HTTP failures and release/remove helpers', async () => {
  const docker = makeDocker();
  const { provider, controller } = makeProvider({
    docker,
    fetchHandler() {
      return response(503, { data: { exit_code: 1, output: 'down' } });
    },
  });

  const executor = provider.createCommandExecutor('http://cap-aio-task-4:8080');
  assert.deepEqual(await executor.exec({ command: 'echo ok' }), {
    exitCode: Number.NaN,
    output: '/v1/shell/exec responded 503',
    stdout: '',
    stderr: '/v1/shell/exec responded 503',
    timedOut: false,
  });

  assert.equal(await provider.sandboxExists('task-4'), true);
  await provider.removeSandbox('task-4');
  assert.deepEqual(docker.byName.get('cap-aio-task-4').calls.at(-1), [
    'remove',
    { force: true },
  ]);
  controller.registerConnection({
    taskId: 'task-4',
    baseUrl: 'http://cap-aio-task-4:8080',
    wsUrl: 'ws://cap-aio-task-4:8080/v1/shell/ws',
  });
  provider.releaseHandles();
  assert.equal(controller.getConnection('task-4'), undefined);
});

await test('fails closed on preflight and clone materialization errors', async () => {
  const preflightDocker = makeDocker();
  const preflight = makeProvider({
    docker: preflightDocker,
    hooks: {
      runtimePreflight: async () => ({
        status: 'failed',
        checkedAt: '2026-01-02T03:04:05.000Z',
        runtimeId: 'codex',
        error: 'node is missing',
      }),
    },
  }).provider;
  await assert.rejects(
    () => preflight.provision({ taskId: 'task-preflight-fail' }),
    /node is missing/,
  );
  assert.deepEqual(
    preflightDocker.byName.get('cap-aio-task-preflight-fail').calls.at(-1),
    ['stop', { t: 0 }],
  );

  const runtimeLookupDocker = makeDocker();
  const runtimeLookup = makeProvider({
    docker: runtimeLookupDocker,
    hooks: {
      provisionLookup: {
        getRuntimeId: async () => {
          throw new Error('runtime lookup unavailable');
        },
      },
      preStopTrim: async () => {
        throw new Error('pre-stop trim should not run for failed provision cleanup');
      },
    },
  }).provider;
  await assert.rejects(
    () => runtimeLookup.provision({ taskId: 'task-runtime-lookup-fail' }),
    /runtime lookup unavailable/,
  );
  assert.deepEqual(
    runtimeLookupDocker.byName.get('cap-aio-task-runtime-lookup-fail').calls.at(-1),
    ['stop', { t: 0 }],
  );

  const cloneFailDocker = makeDocker();
  const cloneTrimCalls = [];
  const cloneFail = makeProvider({
    docker: cloneFailDocker,
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'codex',
      },
      runtimeSetup: async () => undefined,
      preStopTrim: async (context) => {
        cloneTrimCalls.push([context.taskId, context.runtimeId, context.baseUrl]);
      },
    },
    fetchHandler(call) {
      if (call.body?.command?.includes('clone --recursive')) {
        return response(200, {
          data: {
            exit_code: 1,
            output: 'https://user:secret@example.invalid/repo.git failed',
          },
        });
      }
      return response(200);
    },
  }).provider;
  await assert.rejects(
    () =>
      cloneFail.provision({
        taskId: 'task-clone-fail',
        cloneSpec: { url: 'https://example.invalid/repo.git' },
    }),
    /AIO git materialization failed: https:\/\/\*\*\*:\*\*\*@example.invalid/,
  );
  assert.deepEqual(cloneTrimCalls, [
    ['task-clone-fail', 'codex', 'http://cap-aio-task-clone-fail:8080'],
  ]);
  assert.deepEqual(
    cloneFailDocker.byName.get('cap-aio-task-clone-fail').calls.at(-1),
    ['stop', { t: 0 }],
  );
});

await test('defines docker-backed descriptors and null readoption paths', async () => {
  const docker = makeDocker();
  const descriptor = mod.defineAioSandboxProviderFromDocker({
    id: 'docker-aio',
    docker,
    priority: 77,
    capabilities: ['terminal.websocket'],
    logger: { debug() {}, log() {}, warn() {} },
  });
  assert.equal(descriptor.id, 'docker-aio');
  assert.equal(descriptor.priority, 77);
  assert.deepEqual(descriptor.capabilities, ['terminal.websocket']);
  assert.equal(descriptor.provider.getSandboxMode(), 'danger-full-access');

  const defaultDockerDescriptor = mod.defineAioSandboxProviderFromDocker({
    id: 'default-docker-aio',
  });
  assert.equal(defaultDockerDescriptor.id, 'default-docker-aio');

  const { provider } = makeProvider({
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'fallback-runtime',
      },
    },
  });
  assert.equal(await provider.reattach('task-missing'), null);
  assert.equal(await provider.readRolloutFromContainer('task-missing', 'explicit'), null);
  await provider.teardownSandbox('task-untracked');

  const transcriptProvider = makeProvider({
    hooks: {
      transcriptRead: async (context) => ({
        format: 'codex-jsonl',
        jsonl: `runtime=${context.runtimeId ?? 'none'}`,
      }),
    },
  }).provider;
  assert.deepEqual(await transcriptProvider.readRolloutFromContainer('task-no-run'), {
    format: 'codex-jsonl',
    jsonl: 'runtime=none',
  });
});

await test('covers workspace success, validation, and degradation paths', async () => {
  const commands = [];
  const { provider } = makeProvider({
    hooks: {
      cloneSpecToGitCloneSpec: async (cloneSpec) =>
        cloneSpec && typeof cloneSpec === 'object' && 'repo' in cloneSpec
          ? { url: cloneSpec.repo, authHeader: cloneSpec.authHeader }
          : null,
    },
    fetchHandler(call) {
      if (call.path !== '/v1/shell/exec') return response(200);
      commands.push(call.body.command);
      if (call.body.command.includes('git status')) {
        return response(200, { data: { exit_code: 0, output: ' M file.txt\n' } });
      }
      if (call.body.command.includes('base64 -d')) {
        return response(200);
      }
      if (call.body.command.includes('git commit')) {
        return response(200);
      }
      if (call.body.command.includes('git rev-parse HEAD')) {
        return response(200, { data: { exit_code: 0, output: 'def456\n' } });
      }
      if (call.body.command.includes('push --force-with-lease')) {
        return response(200);
      }
      return response(200);
    },
  });

  await provider.provision({
    taskId: 'task-workspace-success',
    cloneSpec: {
      repo: 'https://example.invalid/repo.git',
      authHeader: 'Authorization: Basic secret',
    },
  });
  assert.ok(
    commands.some((command) =>
      command.includes("git -c http.extraHeader='Authorization: Basic secret' clone --recursive --"),
    ),
  );

  assert.deepEqual(
    await provider.deliverWorkspaceChanges('task-workspace-success', {
      authHeader: 'Authorization: Basic xyz',
      branch: 'cap/success',
      commitMessage: 'ship it',
    }),
    { hadChanges: true, commitSha: 'def456', error: null },
  );

  const statusFail = makeProvider({
    fetchHandler(call) {
      if (call.body?.command?.includes('git status')) {
        return response(200, { data: { exit_code: 1, output: 'Bearer token' } });
      }
      return response(200);
    },
  }).provider;
  assert.deepEqual(
    await statusFail.deliverWorkspaceChanges('task-status-fail', {
      authHeader: 'Authorization: Basic xyz',
      branch: 'cap/fail',
      commitMessage: 'fail',
    }),
    { hadChanges: false, commitSha: null, error: 'git status failed: Bearer ***' },
  );

  const noChanges = makeProvider({
    fetchHandler(call) {
      if (call.body?.command?.includes('git status')) {
        return response(200, { data: { exit_code: 0, output: '   \n' } });
      }
      return response(200);
    },
  }).provider;
  assert.deepEqual(
    await noChanges.deliverWorkspaceChanges('task-no-changes', {
      authHeader: 'Authorization: Basic xyz',
      branch: 'cap/no-changes',
      commitMessage: 'none',
    }),
    { hadChanges: false, commitSha: null, error: null },
  );

  const messageFail = makeProvider({
    fetchHandler(call) {
      if (call.body?.command?.includes('git status')) {
        return response(200, { data: { exit_code: 0, output: ' M file.txt\n' } });
      }
      if (call.body?.command?.includes('base64 -d')) {
        return response(200, {
          data: { exit_code: 1, output: 'Authorization: Basic abc123' },
        });
      }
      return response(200);
    },
  }).provider;
  assert.deepEqual(
    await messageFail.deliverWorkspaceChanges('task-message-fail', {
      authHeader: 'Authorization: Basic xyz',
      branch: 'cap/message-fail',
      commitMessage: 'fail',
    }),
    {
      hadChanges: true,
      commitSha: null,
      error: 'git commit message write failed: Authorization: Basic ***',
    },
  );

  const invalid = makeProvider().provider;
  await assert.rejects(
    () => invalid.provision({ taskId: 'task-invalid-clone', cloneSpec: {} }),
    /requires a clone spec with a url/,
  );

  const defaultNowFetch = makeFetch(() => response(200));
  const defaultNowProvider = new mod.AioSandboxProvider({
    controller: new mod.AioSandboxContainerController({
      docker: makeDocker(),
      env: { AIO_SANDBOX_IMAGE: 'cap-aio-sandbox:0.1.0' },
      fetch: defaultNowFetch.fetch,
      delay: async () => undefined,
    }),
    fetch: defaultNowFetch.fetch,
  });
  await defaultNowProvider.provision({ taskId: 'task-default-now' });
  assert.equal(
    (await defaultNowProvider.getSelectedSandboxRun('task-default-now')).preflight.status,
    'skipped',
  );
  defaultNowProvider.runs.delete('task-default-now');
  await defaultNowProvider.teardownSandbox('task-default-now');

  const fallbackSelected = await defaultNowProvider.getSelectedSandboxRun('task-never-registered');
  assert.equal(fallbackSelected.connection.baseUrl, 'http://cap-aio-task-never-registered:8080');

  const fallbackTrimCalls = [];
  const fallbackTrim = makeProvider({
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'resolved-after-run-delete',
      },
      preStopTrim: (context) => {
        fallbackTrimCalls.push(context.runtimeId);
      },
    },
  }).provider;
  await fallbackTrim.provision({ taskId: 'task-trim-fallback' });
  fallbackTrim.runs.delete('task-trim-fallback');
  await fallbackTrim.teardownSandbox('task-trim-fallback');
  assert.deepEqual(fallbackTrimCalls, ['resolved-after-run-delete']);

  const failedWithoutError = makeProvider({
    hooks: {
      runtimePreflight: async () => ({
        status: 'failed',
        checkedAt: '2026-01-02T03:04:05.000Z',
      }),
    },
  }).provider;
  await assert.rejects(
    () => failedWithoutError.provision({ taskId: 'task-preflight-default-error' }),
    /AIO runtime preflight failed for task task-preflight-default-error/,
  );

  const cloneSkip = makeProvider({
    hooks: {
      provisionLookup: {
        getCloneSpec: () => null,
      },
    },
  }).provider;
  await cloneSkip.provision({ taskId: 'task-clone-skip' });

  const failures = [
    ['git add', 'git add failed: add failed'],
    ['git commit', 'git commit failed: commit failed'],
    ['git rev-parse HEAD', 'git rev-parse failed: sha failed'],
  ];
  for (const [index, [failingCommand, expectedError]] of failures.entries()) {
    const failing = makeProvider({
      fetchHandler(call) {
        if (call.body?.command?.includes('git status')) {
          return response(200, { data: { exit_code: 0, output: ' M file.txt\n' } });
        }
        const command = call.body?.command ?? '';
        const matchesFailure =
          command.includes(failingCommand) ||
          (failingCommand === 'git commit' && command.includes('commit -F'));
        if (matchesFailure) {
          return response(200, {
            data: {
              exit_code: 1,
              output:
                failingCommand === 'git add'
                  ? 'add failed'
                  : failingCommand === 'git commit'
                    ? 'commit failed'
                    : 'sha failed',
            },
          });
        }
        return response(200);
      },
    }).provider;
    assert.deepEqual(
      await failing.deliverWorkspaceChanges(`task-workspace-fail-${index}`, {
        authHeader: 'Authorization: Basic xyz',
        branch: 'cap/fail',
        commitMessage: 'fail',
      }),
      { hadChanges: true, commitSha: null, error: expectedError },
    );
  }

  const blankSha = makeProvider({
    fetchHandler(call) {
      if (call.body?.command?.includes('git status')) {
        return response(200, { data: { exit_code: 0, output: ' M file.txt\n' } });
      }
      if (call.body?.command?.includes('git rev-parse HEAD')) {
        return response(200, { data: { exit_code: 0, output: '   \n' } });
      }
      return response(200);
    },
  }).provider;
  assert.deepEqual(
    await blankSha.deliverWorkspaceChanges('task-blank-sha', {
      authHeader: 'Authorization: Basic xyz',
      branch: 'cap/blank-sha',
      commitMessage: 'blank',
    }),
    { hadChanges: true, commitSha: null, error: null },
  );

  const rootWorkspace = makeProvider({
    fetchHandler() {
      return response(200);
    },
  }).provider;
  rootWorkspace.workspaceDir = 'workspace';
  await rootWorkspace.provision({
    taskId: 'task-root-workspace',
    cloneSpec: { url: 'https://example.invalid/repo.git' },
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
