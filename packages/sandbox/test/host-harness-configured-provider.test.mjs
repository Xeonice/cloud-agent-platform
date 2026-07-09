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

const ENV_KEYS = [
  'CAP_SANDBOX_PROVIDER',
  'CAP_SANDBOX_LOCAL_PRIORITY',
  'CAP_SANDBOX_PREFER_LOCATION',
  'CAP_SANDBOX_CLOUD_HTTP_BASE_URL',
  'CAP_SANDBOX_CLOUD_HTTP_ID',
  'CAP_SANDBOX_CLOUD_HTTP_TOKEN',
  'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
  'CAP_SANDBOX_CLOUD_HTTP_PRIORITY',
  'BOXLITE_ENDPOINT',
  'BOXLITE_API_TOKEN',
  'BOXLITE_IMAGE',
  'BOXLITE_ROOTFS_PATH',
  'BOXLITE_CAPABILITIES',
  'BOXLITE_TERMINAL_MODE',
  'BOXLITE_WORKSPACE_PATH',
  'BOXLITE_PROVIDER_PRIORITY',
  'BOXLITE_PROVIDER_LOCATION',
  'BOXLITE_PROTOCOL_MODE',
  'BOXLITE_RUNTIME_REQUIRED_TOOLS',
];

async function withEnv(values, fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeRuntime(id, options = {}) {
  return {
    id,
    preflightProbes: () => options.probes ?? [],
    sandboxSetupCommands(ctx, material) {
      options.events?.push(['plan', id, ctx.workspaceDir, ctx.prompt, material]);
      return options.plan ?? { ok: true, commands: [] };
    },
    preStopTrimCommands: () => options.trimCommands ?? [],
    transcriptArtifact(ctx) {
      options.events?.push(['artifact', id, ctx.taskId, ctx.sessionId ?? null]);
      return {
        dir: options.transcriptDir ?? '/home/gem/.codex/sessions',
        filenameGlob: options.filenameGlob ?? /^session-.*\.jsonl$/,
      };
    },
    transcriptFormat: options.transcriptFormat ?? 'codex-jsonl',
    readTranscriptSource: {
      kind: options.readKind ?? 'single-newest-jsonl',
    },
  };
}

function makeExecutor(handler) {
  const calls = [];
  return {
    calls,
    executor: {
      async exec(request) {
        calls.push(request);
        return (
          (await handler?.(request)) ?? {
            exitCode: 0,
            output: '',
            stdout: '',
            stderr: '',
            timedOut: false,
          }
        );
      },
    },
  };
}

function makeLogger() {
  const logs = { debug: [], log: [], warn: [] };
  return {
    logs,
    logger: {
      debug: (message) => logs.debug.push(message),
      log: (message) => logs.log.push(message),
      warn: (message) => logs.warn.push(message),
    },
  };
}

function makeHost(options = {}) {
  const events = options.events ?? [];
  const { logger, logs } = options.loggerState ?? makeLogger();
  const defaultRuntime =
    options.defaultRuntime ??
    makeRuntime('codex', {
      events,
      probes: [],
      plan: { ok: true, commands: [] },
      trimCommands: [],
    });
  const taskRuntime = options.taskRuntime ?? defaultRuntime;
  const persistedAuth = [];
  return {
    events,
    logs,
    persistedAuth,
    host: {
      ownerStore: options.ownerStore,
      provisionLookup: {
        getCloneSpec: async (taskId) =>
          options.cloneSpecs?.get(taskId) ?? null,
        getTaskPrompt: async (taskId) =>
          options.prompts?.has(taskId)
            ? options.prompts.get(taskId)
            : `prompt:${taskId}`,
        ...(options.getTaskImageParameterProfile
          ? {
              getTaskImageParameterProfile:
                options.getTaskImageParameterProfile,
            }
          : {}),
        ...(options.getTaskSkills
          ? { getTaskSkills: options.getTaskSkills }
          : {}),
      },
      runtimeRegistry: {
        resolve(id) {
          if (options.resolveThrowsFor?.has(String(id ?? 'default'))) {
            throw new Error(`unknown runtime ${String(id ?? 'default')}`);
          }
          return options.resolve?.(id) ?? defaultRuntime;
        },
        ...(!options.omitResolveForTask
          ? {
              async resolveForTask(taskId) {
                if (options.resolveForTaskThrowsString) {
                  throw `runtime string lookup failed for ${taskId}`;
                }
                if (options.resolveForTaskThrows) {
                  throw new Error(`runtime lookup failed for ${taskId}`);
                }
                return options.resolveForTask?.(taskId) ?? taskRuntime;
              },
            }
          : {}),
      },
      materialResolvers: {
        async resolve(runtime, ctx) {
          events.push(['material', runtime.id, ctx.taskId]);
          return options.material ?? { kind: 'auth-material' };
        },
      },
      codexAuthSource:
        'codexAuthSource' in options
          ? options.codexAuthSource
          : {
              async persistRefreshedAuth(taskId, authJson) {
                persistedAuth.push([taskId, authJson]);
              },
            },
      skillInstallers: options.skillInstallers,
      sessionIdForTask: options.sessionIdForTask ?? ((taskId) => `session-${taskId}`),
      transcriptSource: options.transcriptSource,
      logger,
    },
  };
}

function onlyProvider(router) {
  const entries = router.registry.list();
  assert.equal(entries.length, 1);
  return entries[0].provider;
}

await test('configured AIO provider hooks delegate runtime, skills, transcript, and trim to the host harness', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio', CAP_SANDBOX_LOCAL_PRIORITY: '42' }, async () => {
    const events = [];
    const runtime = makeRuntime('codex', {
      events,
      probes: [{ name: 'node', command: 'node --version' }],
      plan: {
        ok: true,
        commands: [
          { command: 'setup-ok', tolerateUnresolvedExit: false },
          { command: 'setup-nan-ok', tolerateUnresolvedExit: true },
        ],
      },
      trimCommands: ['trim-ok', 'trim-fail', 'trim-throw'],
    });
    const loggerState = makeLogger();
    const { host, persistedAuth, logs } = makeHost({
      events,
      loggerState,
      defaultRuntime: runtime,
      taskRuntime: runtime,
      prompts: new Map([['task-1', 'fix task']]),
      getTaskSkills: async () => ['skill-ok', 'skill-missing', 'skill-bad', 'skill-throw'],
      getTaskImageParameterProfile: async () => ({
        parameters: [
          {
            name: 'GCODE_TOKEN',
            value: 'tool-secret',
            secret: true,
          },
        ],
      }),
      skillInstallers: {
        resolveSkillInstaller(id) {
          if (id === 'skill-missing') return undefined;
          return {
            id,
            label: `label:${id}`,
            command: () => [`install-${id}`],
          };
        },
      },
      transcriptSource: {
        create(source) {
          return { ...source, wrapped: true };
        },
      },
    });
    const { calls, executor } = makeExecutor(async (request) => {
      if (request.command === 'setup-nan-ok') {
        return { exitCode: Number.NaN, output: 'unresolved' };
      }
      if (request.command === 'install-skill-bad < /dev/null') {
        return {
          exitCode: 7,
          output: 'Authorization: Basic secret',
        };
      }
      if (request.command === 'install-skill-throw < /dev/null') {
        throw new Error('installer timeout');
      }
      if (request.command === 'cat /home/gem/.codex/auth.json 2>/dev/null') {
        return { exitCode: 0, output: ' {"token":"secret"} \n' };
      }
      if (request.command === 'trim-fail') {
        return { exitCode: 9, output: 'trim failed' };
      }
      if (request.command === 'trim-throw') {
        throw new Error('trim timeout');
      }
      return { exitCode: 0, output: '' };
    });

    const router = mod.createConfiguredSandboxProvider(host);
    assert.equal(router.registry.list()[0].priority, 42);
    const aio = onlyProvider(router);
    const hooks = aio.hooks;

    assert.equal(await hooks.provisionLookup.getCloneSpec('task-1'), null);
    assert.equal(await hooks.provisionLookup.getTaskPrompt('task-1'), 'fix task');
    assert.equal(await hooks.provisionLookup.getRuntimeId('task-1'), 'codex');
    const preflight = await hooks.runtimePreflight({
      taskId: 'task-1',
      executor,
      runtimeId: 'codex',
    });
    assert.equal(preflight.status, 'passed');
    assert.match(preflight.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(preflight.runtimeId, 'codex');
    await hooks.runtimeSetup({ taskId: 'task-1', executor, runtimeId: 'codex' });
    await hooks.skillPreinstall({ taskId: 'task-1', executor });
    const transcript = await hooks.transcriptRead({
      taskId: 'task-1',
      runtimeId: 'codex',
      controller: {
        async readSingleNewestJsonl(taskId, dir, filenameGlob) {
          assert.equal(taskId, 'task-1');
          assert.equal(dir, '/home/gem/.codex/sessions');
          assert(filenameGlob.test('session-abc.jsonl'));
          return '{"type":"message"}\n';
        },
      },
    });
    assert.deepEqual(transcript, {
      format: 'codex-jsonl',
      jsonl: '{"type":"message"}\n',
      wrapped: true,
    });

    await hooks.preStopTrim({ taskId: 'task-1', executor });

    assert.deepEqual(persistedAuth, [['task-1', '{"token":"secret"}']]);
    assert(calls.some((call) => call.command === 'node --version'));
    const toolSetupIndex = calls.findIndex((call) =>
      call.command.includes('/home/gem/.cap/image-env'),
    );
    assert(toolSetupIndex >= 0, 'AIO writes the CAP image parameter env file');
    assert(
      toolSetupIndex < calls.findIndex((call) => call.command === 'setup-ok'),
      'AIO writes image parameters before runtime setup',
    );
    assert(calls.some((call) => call.command === 'setup-ok'));
    assert(calls.some((call) => call.command === 'setup-nan-ok'));
    assert(calls.some((call) => call.command === 'install-skill-ok < /dev/null'));
    assert(logs.debug.some((line) => line.includes('preflight passed')));
    assert(logs.debug.some((line) => line.includes('preinstalled skill "skill-ok"')));
    assert(logs.debug.some((line) => line.includes('provisioned AIO image parameters')));
    assert(logs.warn.some((line) => line.includes('skill "skill-missing" is not allowlisted')));
    assert(logs.warn.some((line) => line.includes('installer exit_code 7')));
    assert(logs.warn.some((line) => line.includes('installer timeout')));
    assert(logs.warn.some((line) => line.includes('pre-stop HOME trim for task task-1 exited 9')));
    assert(logs.warn.some((line) => line.includes('trim timeout')));
    assert(events.some((event) => event[0] === 'artifact' && event[3] === 'session-task-1'));
  });
});

await test('configured provider center registers cloud HTTP candidates from host env', async () => {
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'auto',
      CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox-cloud.example.test',
      CAP_SANDBOX_CLOUD_HTTP_ID: 'managed-cloud',
      CAP_SANDBOX_CLOUD_HTTP_TOKEN: 'cloud-token',
      CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES: 'terminal.websocket',
      CAP_SANDBOX_CLOUD_HTTP_PRIORITY: '55',
      CAP_SANDBOX_PREFER_LOCATION: 'cloud',
    },
    async () => {
      const { host } = makeHost();
      const router = mod.createConfiguredSandboxProvider(host);
      const cloud = router.registry.list().find((entry) => entry.id === 'managed-cloud');
      assert.equal(cloud.priority, 55);
      assert.equal(cloud.location, 'cloud');
      assert.deepEqual(cloud.capabilities, ['terminal.websocket']);
    },
  );

  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'auto',
      CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox-cloud-default.example.test',
    },
    async () => {
      const { host } = makeHost();
      const router = mod.createConfiguredSandboxProvider(host);
      assert(router.registry.list().some((entry) => entry.id === 'cloud-http'));
    },
  );
});

await test('configured AIO provider hooks fail closed and fall back through host runtime registry', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const events = [];
    const fallbackRuntime = makeRuntime('codex', {
      events,
      probes: [{ name: 'codex', command: 'codex --version' }],
      plan: { ok: false, reason: 'missing auth material' },
    });
    const loggerState = makeLogger();
    const { host, logs } = makeHost({
      events,
      loggerState,
      defaultRuntime: fallbackRuntime,
      taskRuntime: fallbackRuntime,
      resolveForTaskThrows: true,
      resolveThrowsFor: new Set(['missing-runtime']),
      getTaskSkills: async () => {
        throw new Error('skills unavailable');
      },
    });
    const { executor } = makeExecutor(async (request) => {
      if (request.command === 'codex --version') {
        return {
          exitCode: 2,
          output: 'fatal https://user:secret@example.test/repo.git Authorization: Basic hidden',
        };
      }
      return { exitCode: 0, output: '' };
    });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;

    assert.equal(await hooks.provisionLookup.getRuntimeId('task-fallback'), 'codex');
    await assert.rejects(
      () =>
        hooks.runtimePreflight({
          taskId: 'task-fail',
          executor,
          runtimeId: 'missing-runtime',
        }),
      /runtime "codex" preflight .*exit_code 2 - fatal https:\/\/\*\*\*:\*\*\*@example\.test/,
    );
    await assert.rejects(
      () =>
        hooks.runtimeSetup({
          taskId: 'task-setup-fail',
          executor,
          runtimeId: 'missing-runtime',
        }),
      /setup for task task-setup-fail failed: missing auth material/,
    );
    await hooks.skillPreinstall({ taskId: 'task-skills', executor });

    assert(logs.warn.some((line) => line.includes('runtime lookup failed for task-fallback')));
    assert(logs.warn.some((line) => line.includes('could not resolve AgentRuntime "missing-runtime"')));
    assert(logs.warn.some((line) => line.includes('could not resolve selected skills')));
  });
});

await test('configured AIO hooks cover setup command failures and optional auth/skill branches', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const failingRuntime = makeRuntime('codex', {
      plan: {
        ok: true,
        commands: [{ command: 'setup-fails', tolerateUnresolvedExit: false }],
      },
    });
    const { host } = makeHost({
      defaultRuntime: failingRuntime,
      taskRuntime: failingRuntime,
    });
    const { executor } = makeExecutor(async (request) =>
      request.command === 'setup-fails'
        ? { exitCode: Number.NaN, output: 'Authorization: Basic secret' }
        : { exitCode: 0, output: '' },
    );
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    await assert.rejects(
      () => hooks.runtimeSetup({ taskId: 'task-command-fail', executor }),
      /setup for task task-command-fail failed: exit_code NaN - Authorization: Basic \*\*\*/,
    );

    const emptyFailureRuntime = makeRuntime('codex', {
      probes: [{ name: 'empty', command: 'probe-empty-fail' }],
      plan: {
        ok: true,
        commands: [{ command: 'setup-empty-fail', tolerateUnresolvedExit: false }],
      },
    });
    const emptyFailure = makeHost({
      defaultRuntime: emptyFailureRuntime,
      taskRuntime: emptyFailureRuntime,
      prompts: new Map([['task-empty-setup', null]]),
    });
    const emptyHooks = onlyProvider(
      mod.createConfiguredSandboxProvider(emptyFailure.host),
    ).hooks;
    await assert.rejects(
      () =>
        emptyHooks.runtimePreflight({
          taskId: 'task-empty-preflight',
          executor: makeExecutor(async () => ({ exitCode: 1, output: '' })).executor,
        }),
      /exit_code 1$/,
    );
    await assert.rejects(
      () =>
        emptyHooks.runtimeSetup({
          taskId: 'task-empty-setup',
          executor: makeExecutor(async () => ({ exitCode: 1, output: '' })).executor,
        }),
      /setup for task task-empty-setup failed: exit_code 1$/,
    );

    const noProbeRuntime = makeRuntime('codex');
    await onlyProvider(
      mod.createConfiguredSandboxProvider(
        makeHost({ defaultRuntime: noProbeRuntime, taskRuntime: noProbeRuntime }).host,
      ),
    ).hooks.runtimePreflight({
      taskId: 'task-no-probes',
      executor,
      runtimeId: 'codex',
    });

    const noResolveForTask = makeHost({
      defaultRuntime: noProbeRuntime,
      omitResolveForTask: true,
    });
    assert.equal(
      await onlyProvider(
        mod.createConfiguredSandboxProvider(noResolveForTask.host),
      ).hooks.provisionLookup.getRuntimeId('task-no-resolve-for-task'),
      'codex',
    );

    const stringLookupFailure = makeHost({
      defaultRuntime: noProbeRuntime,
      resolveForTaskThrowsString: true,
    });
    assert.equal(
      await onlyProvider(
        mod.createConfiguredSandboxProvider(stringLookupFailure.host),
      ).hooks.provisionLookup.getRuntimeId('task-string-runtime-error'),
      'codex',
    );
    assert(
      stringLookupFailure.logs.warn.some((line) =>
        line.includes('runtime string lookup failed'),
      ),
    );

    let resolveCalls = 0;
    const fallbackFromStringResolve = makeHost({
      defaultRuntime: noProbeRuntime,
      resolve(id) {
        resolveCalls += 1;
        if (resolveCalls === 1 && id === null) throw 'resolve string failure';
        return noProbeRuntime;
      },
    });
    await onlyProvider(
      mod.createConfiguredSandboxProvider(fallbackFromStringResolve.host),
    ).hooks.runtimePreflight({
      taskId: 'task-runtime-id-default',
      executor,
    });
    assert(
      fallbackFromStringResolve.logs.warn.some((line) =>
        line.includes('resolve string failure'),
      ),
    );

    const noInstaller = makeHost({
      getTaskSkills: async () => ['skill-needs-registry'],
    });
    const noInstallerHooks = onlyProvider(
      mod.createConfiguredSandboxProvider(noInstaller.host),
    ).hooks;
    await noInstallerHooks.skillPreinstall({
      taskId: 'task-no-installer',
      executor,
    });
    assert(
      noInstaller.logs.warn.some((line) =>
        line.includes('no skill installer registry is wired'),
      ),
    );

    const noSkillLookup = makeHost();
    await onlyProvider(
      mod.createConfiguredSandboxProvider(noSkillLookup.host),
    ).hooks.skillPreinstall({ taskId: 'task-no-skill-lookup', executor });

    const noSkills = makeHost({ getTaskSkills: async () => [] });
    await onlyProvider(mod.createConfiguredSandboxProvider(noSkills.host)).hooks.skillPreinstall({
      taskId: 'task-no-skills',
      executor,
    });

    const stringSkillError = makeHost({
      getTaskSkills: async () => {
        throw 'skills string failure';
      },
    });
    await onlyProvider(
      mod.createConfiguredSandboxProvider(stringSkillError.host),
    ).hooks.skillPreinstall({ taskId: 'task-string-skill-error', executor });
    assert(
      stringSkillError.logs.warn.some((line) =>
        line.includes('skills string failure'),
      ),
    );

    const quietSkillFail = makeHost({
      getTaskSkills: async () => ['skill-quiet-fail', 'skill-string-throw'],
      skillInstallers: {
        resolveSkillInstaller(id) {
          return {
            id,
            label: id,
            command: () => [`install-${id}`],
          };
        },
      },
    });
    await onlyProvider(
      mod.createConfiguredSandboxProvider(quietSkillFail.host),
    ).hooks.skillPreinstall({
      taskId: 'task-quiet-skill-fail',
      executor: makeExecutor(async (request) => {
        if (request.command === 'install-skill-string-throw < /dev/null') {
          throw 'installer string failure';
        }
        return { exitCode: 1, output: '' };
      }).executor,
    });
    assert(
      quietSkillFail.logs.warn.some((line) =>
        line.includes('installer string failure'),
      ),
    );

    const noAuth = makeHost({ codexAuthSource: undefined });
    await onlyProvider(mod.createConfiguredSandboxProvider(noAuth.host)).hooks.preStopTrim({
      taskId: 'task-no-auth',
      executor,
    });

    const nonCodex = makeHost({
      defaultRuntime: makeRuntime('codex'),
      taskRuntime: makeRuntime('claude-code'),
    });
    await onlyProvider(mod.createConfiguredSandboxProvider(nonCodex.host)).hooks.preStopTrim({
      taskId: 'task-non-codex',
      executor,
    });

    const authExit = makeHost();
    await onlyProvider(mod.createConfiguredSandboxProvider(authExit.host)).hooks.preStopTrim({
      taskId: 'task-auth-exit',
      executor: makeExecutor(async (request) =>
        request.command.includes('auth.json')
          ? { exitCode: 1, output: '' }
          : { exitCode: 0, output: '' },
      ).executor,
    });

    const emptyAuth = makeHost();
    await onlyProvider(mod.createConfiguredSandboxProvider(emptyAuth.host)).hooks.preStopTrim({
      taskId: 'task-empty-auth',
      executor: makeExecutor(async (request) =>
        request.command.includes('auth.json')
          ? { exitCode: 0, output: '   ' }
          : { exitCode: 0, output: '' },
      ).executor,
    });

    const persistFail = makeHost({
      codexAuthSource: {
        async persistRefreshedAuth() {
          throw 'database down';
        },
      },
    });
    await onlyProvider(mod.createConfiguredSandboxProvider(persistFail.host)).hooks.preStopTrim({
      taskId: 'task-persist-fail',
      executor: makeExecutor(async (request) =>
        request.command.includes('auth.json')
          ? { exitCode: 0, output: '{"token":"secret"}' }
          : { exitCode: 0, output: '' },
      ).executor,
    });
    assert(
      persistFail.logs.warn.some((line) =>
        line.includes('codex auth refresh-persist skipped'),
      ),
    );

    const persistFailError = makeHost({
      codexAuthSource: {
        async persistRefreshedAuth() {
          throw new Error('database error down');
        },
      },
    });
    await onlyProvider(
      mod.createConfiguredSandboxProvider(persistFailError.host),
    ).hooks.preStopTrim({
      taskId: 'task-persist-fail-error',
      executor: makeExecutor(async (request) =>
        request.command.includes('auth.json')
          ? { exitCode: 0, output: '{"token":"secret"}' }
          : { exitCode: 0, output: '' },
      ).executor,
    });
    assert(
      persistFailError.logs.warn.some((line) =>
        line.includes('database error down'),
      ),
    );

    const fallbackTrim = makeHost({
      defaultRuntime: makeRuntime('codex', {
        trimCommands: ['trim-string-throw'],
      }),
      resolveForTaskThrows: true,
    });
    await onlyProvider(mod.createConfiguredSandboxProvider(fallbackTrim.host)).hooks.preStopTrim({
      taskId: 'task-fallback-trim',
      executor: makeExecutor(async (request) => {
        if (request.command === 'trim-string-throw') throw 'trim string failure';
        return { exitCode: 0, output: '' };
      }).executor,
    });
    assert(
      fallbackTrim.logs.warn.some((line) => line.includes('trim string failure')),
    );
  });
});

await test('configured AIO transcript hook returns null for unsupported and missing transcript sources', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const unsupported = makeRuntime('claude-code', {
      readKind: 'provider-owned',
    });
    const { host } = makeHost({
      defaultRuntime: unsupported,
      taskRuntime: unsupported,
    });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    assert.equal(
      await hooks.transcriptRead({
        taskId: 'task-no-jsonl',
        runtimeId: 'claude-code',
        controller: { readSingleNewestJsonl: async () => '{"unused":true}\n' },
      }),
      null,
    );

    const jsonlRuntime = makeRuntime('codex');
    const { host: hostWithJsonl } = makeHost({
      defaultRuntime: jsonlRuntime,
      taskRuntime: jsonlRuntime,
      codexAuthSource: undefined,
    });
    const jsonlHooks = onlyProvider(mod.createConfiguredSandboxProvider(hostWithJsonl)).hooks;
    assert.equal(
      await jsonlHooks.transcriptRead({
        taskId: 'task-missing-jsonl',
        runtimeId: 'codex',
        controller: { readSingleNewestJsonl: async () => null },
      }),
      null,
    );

    assert.deepEqual(
      await jsonlHooks.transcriptRead({
        taskId: 'task-jsonl-default-source',
        runtimeId: 'codex',
        controller: { readSingleNewestJsonl: async () => '{"ok":true}\n' },
      }),
      { format: 'codex-jsonl', jsonl: '{"ok":true}\n' },
    );
  });
});

await test('configured BoxLite provider delegates runtime setup through the same host harness', async () => {
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'http://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'boxlite-image:latest',
      BOXLITE_CAPABILITIES:
        'terminal.websocket,command.exec,workspace.git.materialize,workspace.git.deliver,lifecycle.readopt',
      BOXLITE_TERMINAL_MODE: 'pty',
      BOXLITE_WORKSPACE_PATH: '/workspace',
      BOXLITE_PROVIDER_PRIORITY: '77',
      BOXLITE_RUNTIME_REQUIRED_TOOLS: 'sh git codex',
    },
    async () => {
      const events = [];
      const runtime = makeRuntime('codex', {
        events,
        plan: {
          ok: true,
          commands: [{ command: 'boxlite-setup', tolerateUnresolvedExit: false }],
        },
      });
      const { host, logs } = makeHost({
        events,
        defaultRuntime: runtime,
        taskRuntime: runtime,
        prompts: new Map([['box-task', 'box prompt']]),
        getTaskImageParameterProfile: async () => ({
          parameters: [
            {
              name: 'GCODE_TOKEN',
              value: 'box-tool-secret',
              secret: true,
            },
          ],
        }),
      });
      const { calls, executor } = makeExecutor();
      const router = mod.createConfiguredSandboxProvider(host);
      const entry = router.registry.list()[0];
      assert.equal(entry.id, 'boxlite');
      assert.equal(entry.priority, 77);
      assert(entry.capabilities.includes('workspace.git.deliver'));

      await entry.provider.runtimeSetup({
        taskId: 'box-task',
        sandbox: { id: 'box-task', status: 'running', image: 'boxlite-image:latest' },
        executor,
        workspacePath: '/workspace',
      });

      const commands = calls.map((call) => call.command);
      const toolSetupIndex = commands.findIndex((command) =>
        command.includes('/home/gem/.cap/image-env'),
      );
      assert(toolSetupIndex >= 0, 'BoxLite writes the CAP image parameter env file');
      assert.equal(commands.at(-1), 'boxlite-setup');
      assert(toolSetupIndex < commands.indexOf('boxlite-setup'));
      assert(events.some((event) => event[0] === 'plan' && event[2] === '/workspace'));
      assert(logs.debug.some((line) => line.includes('provisioned BoxLite runtime "codex" setup')));
      assert(logs.debug.some((line) => line.includes('provisioned BoxLite image parameters')));
    },
  );
});

await test('configured provider family fails closed when explicit BoxLite config is invalid', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'boxlite' }, async () => {
    const { host } = makeHost();
    assert.throws(
      () => mod.createConfiguredSandboxProvider(host),
      /CAP_SANDBOX_PROVIDER=boxlite selected but BoxLite is disabled/,
    );
  });
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'ftp://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'boxlite-image:latest',
    },
    async () => {
      const { host } = makeHost();
      assert.throws(
        () => mod.createConfiguredSandboxProvider(host),
        /CAP_SANDBOX_PROVIDER=boxlite selected but BoxLite config is invalid/,
      );
    },
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
