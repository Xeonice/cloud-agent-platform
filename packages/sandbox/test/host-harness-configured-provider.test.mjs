import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);

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
    preflightProbes: () =>
      (options.probes ?? []).map((probe, index) => ({
        descriptor: {
          commandKind: 'runtime_preflight',
          ordinal: index + 1,
        },
        ...probe,
      })),
    sandboxSetupCommands(ctx, material) {
      options.events?.push(['plan', id, ctx.workspaceDir, ctx.prompt, material]);
      const plan = options.plan ?? { ok: true, commands: [] };
      return plan.ok
        ? {
            ...plan,
            commands: plan.commands.map((command, index) => ({
              descriptor: {
                commandKind:
                  index === 0 ? 'credential_setup' : 'runtime_setup',
                ordinal: index + 1,
              },
              ...command,
            })),
          }
        : plan;
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

function makeExecutor(handler, metadataHandler) {
  const calls = [];
  return {
    calls,
    executor: {
      async exec(request) {
        calls.push(request);
        if (request.command === 'cat /etc/cap/sandbox-metadata.json') {
          return (await metadataHandler?.(request)) ?? {
            exitCode: 0,
            output: JSON.stringify({
              schemaVersion: 1,
              sandboxVersion: 'v1.2.3',
              dependencies: { codex: '0.132.0', 'claude-code': '2.1.181' },
            }),
            stdout: '',
            stderr: '',
            timedOut: false,
          };
        }
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

function makeRuntimePrivateFileCapture() {
  const writes = [];
  return {
    writes,
    port: core.createSandboxRuntimePrivateFilePort({
      rootDirectory: '/home/gem',
      transport: {
        async writeFile(request) {
          writes.push({
            path: request.path,
            mode: request.mode,
            content: Buffer.from(request.content).toString('utf8'),
          });
        },
        async deleteFile() {},
      },
    }),
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
  return {
    events,
    logs,
    host: {
      ownerStore: options.ownerStore,
      provisionLookup: {
        getTaskLaunchContext: async (taskId) =>
          options.launchContexts?.get(taskId) ?? {
            modelIntent: { kind: 'runtime-default' },
            ownerUserId: options.ownerUserId ?? 'owner-task-default',
            runtimeId: taskRuntime.id,
            executionMode: 'interactive-pty',
          },
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
        ...(options.getResolvedEnvironment
          ? { getResolvedEnvironment: options.getResolvedEnvironment }
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
          events.push(['material', runtime.id, ctx.taskId, ctx.ownerUserId]);
          return options.material ?? { kind: 'auth-material' };
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

function isRuntimeCommandError(error, expected) {
  return (
    error?.code === 'sandbox_runtime_command_execution_error' &&
    error?.descriptor?.commandKind === expected.commandKind &&
    error?.descriptor?.ordinal === expected.ordinal &&
    error?.classification?.settlement === expected.settlement &&
    (expected.exitCode === undefined ||
      error?.classification?.exitCode === expected.exitCode)
  );
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
      trimCommands: ['trim-ok'],
    });
    const loggerState = makeLogger();
    const { host, logs } = makeHost({
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
      return { exitCode: 0, output: '' };
    });

    const router = mod.createConfiguredSandboxProvider(host);
    assert.equal(router.registry.list()[0].priority, 42);
    const aio = onlyProvider(router);
    const hooks = aio.hooks;

    assert.equal(
      hooks.provisionLookup.getCloneSpec,
      undefined,
      'the production AIO descriptor never re-reads a legacy clone spec',
    );
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
    assert.equal(preflight.metadata.sandboxMetadata.dependencies.codex, '0.132.0');
    const privateFiles = makeRuntimePrivateFileCapture();
    await hooks.runtimeSetup({
      taskId: 'task-1',
      executor,
      runtimePrivateFiles: privateFiles.port,
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      modelIntent: { kind: 'runtime-default' },
    });
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

    assert(
      calls.every(
        (call) =>
          !call.command.includes('cat /home/gem/.codex/auth.json') &&
          !call.command.includes('persistRefreshedAuth'),
      ),
      'the YOLO sandbox is never trusted to write an owner credential back',
    );
    assert(calls.some((call) => call.command === 'node --version'));
    assert(
      calls.findIndex((call) => call.command === 'cat /etc/cap/sandbox-metadata.json') <
        calls.findIndex((call) => call.command === 'node --version'),
      'sandbox metadata is read before runtime probes',
    );
    const toolSetupIndex = calls.findIndex((call) =>
      call.command.includes('/home/gem/.cap/image-env'),
    );
    assert(toolSetupIndex >= 0, 'AIO writes the CAP image parameter env file');
    assert.equal(privateFiles.writes[0].path, '/home/gem/.cap/image-env');
    assert.match(privateFiles.writes[0].content, /export GCODE_TOKEN='tool-secret'/u);
    assert.doesNotMatch(JSON.stringify(calls), /tool-secret/u);
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
    assert(logs.warn.some((line) => line.includes('preinstall failed/timed out')));
    assert(logs.warn.every((line) => !line.includes('installer timeout')));
    assert(calls.some((call) => call.command === 'trim-ok'));
    assert(events.some((event) => event[0] === 'artifact' && event[3] === 'session-task-1'));
    assert(
      events.some(
        (event) =>
          event[0] === 'material' &&
          event[2] === 'task-1' &&
          event[3] === 'owner-task-default',
      ),
      'runtime material resolution receives the persisted task owner',
    );
  });
});

await test('configured AIO runtime preflight fails closed for unavailable metadata', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const runtime = makeRuntime('codex', {
      probes: [{ name: 'codex', command: 'codex --version' }],
    });
    const { host } = makeHost({ defaultRuntime: runtime, taskRuntime: runtime });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    const { calls, executor } = makeExecutor(undefined, async () => ({
      exitCode: 1,
      output: 'metadata missing',
      stdout: '',
      stderr: 'metadata missing',
      timedOut: false,
    }));

    await assert.rejects(
      hooks.runtimePreflight({ taskId: 'task-missing-metadata', executor, runtimeId: 'codex' }),
      /sandbox metadata preflight for AIO task task-missing-metadata failed:.*exit_code 1/,
    );
    assert.deepEqual(calls.map((call) => call.command), [
      'cat /etc/cap/sandbox-metadata.json',
    ]);
  });
});

await test('configured AIO runtime preflight requires the selected official runtime dependency', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const runtime = makeRuntime('codex', {
      probes: [{ name: 'codex', command: 'codex --version' }],
    });
    const { host } = makeHost({ defaultRuntime: runtime, taskRuntime: runtime });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    const { calls, executor } = makeExecutor(undefined, async () => ({
      exitCode: 0,
      output: JSON.stringify({
        schemaVersion: 1,
        sandboxVersion: 'v1.2.3',
        dependencies: { 'claude-code': '2.1.181' },
      }),
      stdout: '',
      stderr: '',
      timedOut: false,
    }));

    await assert.rejects(
      hooks.runtimePreflight({ taskId: 'task-runtime-omitted', executor, runtimeId: 'codex' }),
      /selected runtime dependency codex is not declared/,
    );
    assert.deepEqual(calls.map((call) => call.command), [
      'cat /etc/cap/sandbox-metadata.json',
    ]);
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

await test('configured AIO provider hooks fail closed and require an exact runtime', async () => {
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
          runtimeId: 'codex',
        }),
      (error) =>
        isRuntimeCommandError(error, {
          commandKind: 'runtime_preflight',
          ordinal: 1,
          settlement: 'exit',
          exitCode: 2,
        }) &&
        !error.message.includes('secret') &&
        !error.message.includes('codex --version'),
    );
    await assert.rejects(
      () =>
        hooks.runtimeSetup({
          taskId: 'task-setup-fail',
          executor,
          runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
          runtimeId: 'missing-runtime',
          executionMode: 'interactive-pty',
          modelIntent: { kind: 'runtime-default' },
        }),
      (error) =>
        error?.code === 'runtime_model_setup_failed' &&
        error?.phase === 'runtime-resolution',
    );
    await assert.rejects(
      () =>
        hooks.runtimeSetup({
          taskId: 'task-setup-plan-fail',
          executor,
          runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
          runtimeId: 'codex',
          executionMode: 'interactive-pty',
          modelIntent: { kind: 'runtime-default' },
        }),
      /setup for task task-setup-plan-fail failed: missing auth material/,
    );
    await hooks.skillPreinstall({ taskId: 'task-skills', executor });

    assert(logs.warn.some((line) => line.includes('could not resolve AgentRuntime for AIO task task-fallback')));
    assert(logs.warn.every((line) => !line.includes('runtime lookup failed')));
    assert.equal(
      logs.warn.some((line) => line.includes('could not resolve AgentRuntime "missing-runtime"')),
      false,
    );
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
      () =>
        hooks.runtimeSetup({
          taskId: 'task-command-fail',
          executor,
          runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
          runtimeId: 'codex',
          executionMode: 'interactive-pty',
          modelIntent: { kind: 'runtime-default' },
        }),
      (error) =>
        isRuntimeCommandError(error, {
          commandKind: 'credential_setup',
          ordinal: 1,
          settlement: 'indeterminate',
          exitCode: null,
        }) && !JSON.stringify(error).includes('Authorization'),
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
          runtimeId: 'codex',
          executor: makeExecutor(async () => ({ exitCode: 1, output: '' })).executor,
        }),
      (error) =>
        isRuntimeCommandError(error, {
          commandKind: 'runtime_preflight',
          ordinal: 1,
          settlement: 'exit',
          exitCode: 1,
        }),
    );
    await assert.rejects(
      () =>
        emptyHooks.runtimeSetup({
          taskId: 'task-empty-setup',
          executor: makeExecutor(async () => ({ exitCode: 1, output: '' })).executor,
          runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
          runtimeId: 'codex',
          executionMode: 'interactive-pty',
          modelIntent: { kind: 'runtime-default' },
        }),
      (error) =>
        isRuntimeCommandError(error, {
          commandKind: 'credential_setup',
          ordinal: 1,
          settlement: 'exit',
          exitCode: 1,
        }),
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
        line.includes('could not resolve AgentRuntime for AIO task task-string-runtime-error'),
      ),
    );
    assert(
      stringLookupFailure.logs.warn.every(
        (line) => !line.includes('runtime string lookup failed'),
      ),
    );

    let resolveCalls = 0;
    const strictMissingRuntime = makeHost({
      defaultRuntime: noProbeRuntime,
      resolve(id) {
        resolveCalls += 1;
        if (resolveCalls === 1 && id === null) throw 'resolve string failure';
        return noProbeRuntime;
      },
    });
    await assert.rejects(
      () =>
        onlyProvider(
          mod.createConfiguredSandboxProvider(strictMissingRuntime.host),
        ).hooks.runtimePreflight({
          taskId: 'task-runtime-id-missing',
          executor,
        }),
      (error) =>
        error?.code === 'runtime_model_setup_failed' &&
        error?.phase === 'runtime-resolution',
    );
    assert.equal(resolveCalls, 0);

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
        line.includes('could not resolve selected skills'),
      ),
    );
    assert(
      stringSkillError.logs.warn.every(
        (line) => !line.includes('skills string failure'),
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
        line.includes('preinstall failed/timed out'),
      ),
    );
    assert(
      quietSkillFail.logs.warn.every(
        (line) => !line.includes('installer string failure'),
      ),
    );

    const strictTrimRuntime = makeRuntime('codex', {
      trimCommands: ['remove-private-runtime-state'],
    });
    const strictTrim = makeHost({
      defaultRuntime: strictTrimRuntime,
      taskRuntime: strictTrimRuntime,
    });
    const strictTrimHooks = onlyProvider(
      mod.createConfiguredSandboxProvider(strictTrim.host),
    ).hooks;
    for (const [taskId, result, expected] of [
      [
        'task-trim-exit',
        async () => ({ exitCode: 9, output: 'private-secret-canary' }),
        /was not confirmed/,
      ],
      [
        'task-trim-timeout',
        async () => ({ exitCode: 0, timedOut: true, output: 'private-secret-canary' }),
        /was not confirmed/,
      ],
      [
        'task-trim-throw',
        async () => {
          throw new Error('transport private-secret-canary');
        },
        /did not settle/,
      ],
    ]) {
      await assert.rejects(
        () =>
          strictTrimHooks.preStopTrim({
            taskId,
            executor: makeExecutor(result).executor,
          }),
        (error) =>
          expected.test(error?.message) &&
          !error.message.includes('private-secret-canary'),
      );
    }
  });
});

await test('runtime command failures are classified before provider redaction', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const cases = [
      {
        settlement: 'timeout',
        execute: () => {
          throw Object.assign(new Error('timeout-secret-canary'), {
            name: 'TimeoutError',
          });
        },
      },
      {
        settlement: 'transport',
        execute: () => {
          throw new Error('transport-secret-canary');
        },
      },
      {
        settlement: 'protocol',
        execute: () => {
          throw new mod.SandboxCommandSettlementError('protocol');
        },
      },
      {
        settlement: 'cancellation',
        execute: () => {
          throw Object.assign(new Error('cancel-secret-canary'), {
            name: 'AbortError',
          });
        },
      },
    ];
    for (const item of cases) {
      const runtime = makeRuntime('codex', {
        plan: {
          ok: true,
          commands: [
            {
              command: `${item.settlement}-command-secret-canary`,
              tolerateUnresolvedExit: false,
            },
          ],
        },
      });
      const { host, logs } = makeHost({
        defaultRuntime: runtime,
        taskRuntime: runtime,
      });
      const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
      const { executor } = makeExecutor(async (request) => {
        if (request.command.includes('-command-secret-canary')) {
          return item.execute();
        }
        return { exitCode: 0, output: '' };
      });
      await assert.rejects(
        () =>
          hooks.runtimeSetup({
            taskId: `task-${item.settlement}`,
            executor,
            runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
            runtimeId: 'codex',
            executionMode: 'interactive-pty',
            modelIntent: { kind: 'runtime-default' },
          }),
        (error) =>
          isRuntimeCommandError(error, {
            commandKind: 'credential_setup',
            ordinal: 1,
            settlement: item.settlement,
            exitCode: null,
          }) &&
          !error.message.includes('secret-canary') &&
          !JSON.stringify(error).includes('secret-canary'),
      );
    }
  });
});

await test('configured AIO transcript hook REFUSES an unsupported strategy and returns null only for a missing source', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const unsupported = makeRuntime('claude-code', {
      readKind: 'provider-owned',
    });
    const { host } = makeHost({
      defaultRuntime: unsupported,
      taskRuntime: unsupported,
    });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    // A strategy no provider implements used to return null, which upstream reads
    // as "this task has no transcript" — the operator got an empty session and no
    // reason. fail-loud-on-unknown-runtime makes the gap say where it is. A
    // MISSING source (below) still legitimately returns null.
    await assert.rejects(
      () =>
        hooks.transcriptRead({
          taskId: 'task-no-jsonl',
          runtimeId: 'claude-code',
          controller: { readSingleNewestJsonl: async () => '{"unused":true}\n' },
        }),
      /cannot read transcripts with strategy "provider-owned"/,
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

      const privateFiles = makeRuntimePrivateFileCapture();
      await entry.provider.runtimeSetup({
        taskId: 'box-task',
        modelIntent: { kind: 'runtime-default' },
        executionMode: 'interactive-pty',
        runtimeId: 'codex',
        sandbox: { id: 'box-task', status: 'running', image: 'boxlite-image:latest' },
        executor,
        runtimePrivateFiles: privateFiles.port,
        workspacePath: '/workspace',
      });

      const commands = calls.map((call) => call.command);
      const toolSetupIndex = commands.findIndex((command) =>
        command.includes('/home/gem/.cap/image-env'),
      );
      assert(toolSetupIndex >= 0, 'BoxLite writes the CAP image parameter env file');
      assert.equal(privateFiles.writes[0].path, '/home/gem/.cap/image-env');
      assert.match(privateFiles.writes[0].content, /export GCODE_TOKEN='box-tool-secret'/u);
      assert.doesNotMatch(JSON.stringify(calls), /box-tool-secret/u);
      assert.equal(commands.at(-1), 'boxlite-setup');
      assert(toolSetupIndex < commands.indexOf('boxlite-setup'));
      assert(events.some((event) => event[0] === 'plan' && event[2] === '/workspace'));
      assert(logs.debug.some((line) => line.includes('provisioned BoxLite runtime "codex" setup')));
      assert(logs.debug.some((line) => line.includes('provisioned BoxLite image parameters')));
    },
  );
});

await test('configured BoxLite provider reads the newest runtime-owned transcript before teardown', async () => {
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'http://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'boxlite-image:latest',
      BOXLITE_CAPABILITIES:
        'command.exec,transcript.retained-read,transcript.retained-source',
      BOXLITE_WORKSPACE_PATH: '/workspace',
    },
    async () => {
      const events = [];
      const runtime = makeRuntime('claude-code', {
        events,
        transcriptDir: "/home/gem/.claude/projects/it's-safe",
        filenameGlob: /(^|\/)session-box-task\.jsonl$/,
        transcriptFormat: 'claude-jsonl',
      });
      const { host } = makeHost({
        events,
        defaultRuntime: runtime,
        taskRuntime: runtime,
        transcriptSource: {
          create: (source) => ({ ...source, wrapped: true }),
        },
      });
      const provider = onlyProvider(mod.createConfiguredSandboxProvider(host));
      const transcript = '{"type":"assistant","message":{"model":"claude-sonnet"}}\n';
      const client = new mod.FakeBoxLiteClient({
        execHandler: (request) => {
          const result = {
            exitCode: 0,
            output: '',
            stdout: '',
            stderr: '',
            timedOut: false,
          };
          if (request.command === 'cat /etc/cap/sandbox-metadata.json') {
            result.output = JSON.stringify({
              schemaVersion: 1,
              sandboxVersion: 'v1.2.3',
              dependencies: { 'claude-code': '2.1.207' },
            });
          } else if (request.command.startsWith('find ')) {
            result.stdout = [
              "/home/gem/.claude/projects/it's-safe/older.jsonl",
              "/home/gem/.claude/projects/it's-safe/session-box-task.jsonl",
            ].join('\n');
          } else if (request.command.startsWith('cat ')) {
            result.stdout = transcript;
          }
          result.output ||= result.stdout;
          return result;
        },
      });
      provider.client = client;

      await provider.provision({
        taskId: 'box-task',
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'claude-code',
        executionMode: 'headless-exec',
      });
      assert.deepEqual(
        await provider.readRolloutFromContainer('box-task', 'claude-code'),
        {
          format: 'claude-jsonl',
          jsonl: transcript,
          wrapped: true,
        },
      );
      assert(
        client.execCalls.some(
          (call) =>
            call.command ===
            "find '/home/gem/.claude/projects/it'\\''s-safe' -type f -print",
        ),
      );
      assert(
        client.execCalls.some(
          (call) =>
            call.command ===
            "cat '/home/gem/.claude/projects/it'\\''s-safe/session-box-task.jsonl'",
        ),
      );
      assert(
        events.some(
          (event) =>
            event[0] === 'artifact' &&
            event[1] === 'claude-code' &&
            event[3] === 'session-box-task',
        ),
      );
    },
  );
});

await test('configured BoxLite provision validates metadata against the task-selected runtime', async () => {
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'http://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'boxlite-image:v1',
      BOXLITE_CAPABILITIES: 'command.exec,lifecycle.readopt',
      BOXLITE_WORKSPACE_PATH: '/home/gem/workspace',
    },
    async () => {
      const defaultRuntime = makeRuntime('codex');
      const taskRuntime = makeRuntime('claude-code');
      const { host } = makeHost({ defaultRuntime, taskRuntime });
      const provider = onlyProvider(mod.createConfiguredSandboxProvider(host));
      const client = new mod.FakeBoxLiteClient({
        execHandler: (request) => ({
          exitCode: 0,
          output:
            request.command === 'cat /etc/cap/sandbox-metadata.json'
              ? JSON.stringify({
                  schemaVersion: 1,
                  sandboxVersion: 'v1.2.3',
                  dependencies: { codex: '0.132.0' },
                })
              : '',
          stdout: '',
          stderr: '',
          timedOut: false,
        }),
      });
      provider.client = client;

      await assert.rejects(
        () =>
          provider.provision({
            taskId: 'box-task-claude-metadata',
            cloneSpec: null,
            modelIntent: { kind: 'runtime-default' },
            runtimeId: 'claude-code',
            executionMode: 'interactive-pty',
          }),
        (error) =>
          error?.code === 'sandbox_provisioning_stage_error' &&
          error.stage === 'runtime_setup' &&
          !error.message.includes('claude-code'),
      );

      assert.equal(client.execCalls.length, 2);
      assert.match(client.execCalls[0].command, /^df -Pk \/ \| awk /);
      assert.equal(
        client.execCalls[1].command,
        'cat /etc/cap/sandbox-metadata.json',
      );
      assert.deepEqual(client.deletedSandboxIds, [
        'cap-boxlite-box-task-claude-metadata',
      ]);
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

await test('configured BoxLite hooks resolve the frozen environment and runtime before retained cleanup', async () => {
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'http://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'boxlite-image:v1',
      BOXLITE_CAPABILITIES:
        'command.exec,lifecycle.readopt,transcript.retained-read,transcript.retained-source',
      BOXLITE_WORKSPACE_PATH: '/home/gem/workspace',
    },
    async () => {
      const environmentCalls = [];
      const runtime = makeRuntime('codex', {
        filenameGlob: /(^|\/)session-.*\.jsonl$/,
      });
      const { host, logs } = makeHost({
        defaultRuntime: runtime,
        taskRuntime: runtime,
        getResolvedEnvironment: async (...args) => {
          environmentCalls.push(args);
          return {
            id: 'box-env-v1',
            providerId: 'boxlite',
            providerFamily: 'boxlite',
            runtimeId: 'codex',
            sourceKind: 'boxlite-image',
            sourceRef: 'boxlite-image:v1',
          };
        },
      });
      const provider = onlyProvider(mod.createConfiguredSandboxProvider(host));
      const transcript = '{"type":"message"}\n';
      const client = new mod.FakeBoxLiteClient({
        execHandler: (request) => {
          const result = {
            exitCode: 0,
            output: '',
            stdout: '',
            stderr: '',
            timedOut: false,
          };
          if (request.command === 'cat /etc/cap/sandbox-metadata.json') {
            result.output = JSON.stringify({
              schemaVersion: 1,
              sandboxVersion: 'v1.2.3',
              dependencies: { codex: '0.132.0' },
            });
          } else if (request.command.startsWith('find ')) {
            result.stdout = '/home/gem/.codex/sessions/session-final.jsonl\n';
          } else if (request.command.includes('session-final.jsonl')) {
            result.stdout = transcript;
          } else if (request.command.includes('/home/gem/.cap/image-env')) {
            result.exitCode = 8;
          }
          result.output ||= result.stdout;
          return result;
        },
      });
      provider.client = client;

      await provider.provision({
        taskId: 'box-hook-task',
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
      });
      assert.deepEqual(environmentCalls, [
        ['box-hook-task', 'boxlite', 'codex'],
      ]);
      assert.deepEqual(await provider.readRolloutFromContainer('box-hook-task'), {
        format: 'codex-jsonl',
        jsonl: transcript,
      });
      assert.equal(
        (await provider.preflightRuntime({ taskId: 'box-hook-task' })).status,
        'passed',
      );

      await provider.teardownSandbox('box-hook-task');
      assert(
        client.execCalls.some(
          (call) =>
            call.command.includes('/home/gem/.cap/image-env') &&
            call.command.includes('rm -f'),
        ),
        'retained BoxLite cleanup removes the task image-parameter file',
      );
      assert(
        logs.warn.some((line) =>
          line.includes('image parameter cleanup for task box-hook-task failed'),
        ),
      );
    },
  );
});

await test('configured transcript hooks cover fallback and BoxLite retained-read edge outcomes', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const runtime = makeRuntime('codex');
    const loggerState = makeLogger();
    const { host, logs } = makeHost({
      defaultRuntime: runtime,
      taskRuntime: runtime,
      loggerState,
      resolveThrowsFor: new Set(['missing-runtime']),
    });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    assert.deepEqual(
      await hooks.transcriptRead({
        taskId: 'aio-runtime-fallback',
        runtimeId: 'missing-runtime',
        controller: {
          readSingleNewestJsonl: async () => '{"fallback":true}\n',
        },
      }),
      { format: 'codex-jsonl', jsonl: '{"fallback":true}\n' },
    );
    assert(logs.warn.some((line) => line.includes('missing-runtime')));
  });

  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'http://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'boxlite-image:v1',
      BOXLITE_CAPABILITIES:
        'command.exec,lifecycle.readopt,transcript.retained-read,transcript.retained-source',
    },
    async () => {
      const supported = makeRuntime('codex', {
        filenameGlob: /(^|\/)session-.*\.jsonl$/,
      });
      const unsupported = makeRuntime('provider-owned', {
        readKind: 'provider-owned',
      });
      let mode = 'list-failed';
      const { host } = makeHost({
        defaultRuntime: supported,
        taskRuntime: supported,
        resolve: (id) => (id === 'provider-owned' ? unsupported : supported),
      });
      const provider = onlyProvider(mod.createConfiguredSandboxProvider(host));
      const client = new mod.FakeBoxLiteClient({
        execHandler: (request) => {
          const result = {
            exitCode: 0,
            output: '',
            stdout: '',
            stderr: '',
            timedOut: false,
          };
          if (request.command === 'cat /etc/cap/sandbox-metadata.json') {
            result.output = JSON.stringify({
              schemaVersion: 1,
              sandboxVersion: 'v1.2.3',
              dependencies: { codex: '0.132.0' },
            });
          } else if (request.command.startsWith('find ')) {
            if (mode === 'list-failed') result.exitCode = 3;
            else if (mode === 'no-match') result.stdout = '/tmp/not-a-session.txt\n';
            else if (mode === 'list-output-fallback') {
              result.output = '/home/gem/.codex/sessions/session-edge.jsonl\n';
            }
            else result.stdout = '/home/gem/.codex/sessions/session-edge.jsonl\n';
          } else if (request.command.includes('session-edge.jsonl')) {
            if (mode === 'read-failed') result.exitCode = 4;
            else result.output = '{"outputFallback":true}\n';
          }
          result.output ||= result.stdout;
          return result;
        },
      });
      provider.client = client;
      await provider.provision({
        taskId: 'box-transcript-edges',
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
      });

      // Same boundary on the BoxLite side: an unimplemented strategy is refused,
      // while the three genuine read failures below still degrade to null.
      await assert.rejects(
        () =>
          provider.readRolloutFromContainer(
            'box-transcript-edges',
            'provider-owned',
          ),
        /cannot read transcripts with strategy "provider-owned"/,
      );
      for (const nextMode of ['list-failed', 'no-match', 'read-failed']) {
        mode = nextMode;
        assert.equal(
          await provider.readRolloutFromContainer('box-transcript-edges', 'codex'),
          null,
        );
      }
      mode = 'output-fallback';
      assert.deepEqual(
        await provider.readRolloutFromContainer('box-transcript-edges', 'codex'),
        {
          format: 'codex-jsonl',
          jsonl: '{"outputFallback":true}\n',
        },
      );
      mode = 'list-output-fallback';
      assert.deepEqual(
        await provider.readRolloutFromContainer('box-transcript-edges', 'codex'),
        {
          format: 'codex-jsonl',
          jsonl: '{"outputFallback":true}\n',
        },
      );
      await provider.teardownSandbox('box-transcript-edges');
    },
  );
});

await test('configured setup hooks fail closed and suppress arbitrary private diagnostics', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const runtime = makeRuntime('codex');
    const loggerState = makeLogger();
    const profileSecret = 'profile-secret-canary';
    const { host, logs } = makeHost({
      defaultRuntime: runtime,
      taskRuntime: runtime,
      loggerState,
      getTaskImageParameterProfile: async (taskId) => {
        if (taskId === 'profile-lookup-failed') {
          throw 'profile lookup string failure';
        }
        if (taskId === 'profile-lookup-error') {
          throw new Error('profile lookup error failure');
        }
        if (taskId === 'profile-absent') return undefined;
        return {
          parameters: [
            { name: 'GCODE_TOKEN', value: profileSecret, secret: true },
          ],
        };
      },
    });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    const absentProfile = makeExecutor();
    await hooks.runtimeSetup({
      taskId: 'profile-absent',
      executor: absentProfile.executor,
      runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      modelIntent: { kind: 'runtime-default' },
    });
    assert(
      absentProfile.calls.every(
        (request) => !request.command.includes('/home/gem/.cap/image-env'),
      ),
    );
    await hooks.runtimeSetup({
      taskId: 'profile-lookup-failed',
      executor: makeExecutor().executor,
      runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      modelIntent: { kind: 'runtime-default' },
    });
    assert(logs.warn.some((line) => line.includes('could not resolve image parameters')));
    assert(logs.warn.every((line) => !line.includes('profile lookup string failure')));
    await hooks.runtimeSetup({
      taskId: 'profile-lookup-error',
      executor: makeExecutor().executor,
      runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      modelIntent: { kind: 'runtime-default' },
    });
    assert(logs.warn.every((line) => !line.includes('profile lookup error failure')));

    const failingSetup = makeExecutor(async (request) =>
      request.command.includes('/home/gem/.cap/image-env')
        ? { exitCode: 9, output: `Bearer ${profileSecret}` }
        : { exitCode: 0, output: '' },
    );
    await assert.rejects(
      hooks.runtimeSetup({
        taskId: 'profile-command-failed',
        executor: failingSetup.executor,
        runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
        modelIntent: { kind: 'runtime-default' },
      }),
      (error) =>
        /image parameter setup for AIO task/.test(error?.message) &&
        !error.message.includes(profileSecret) &&
        !error.message.includes(Buffer.from(profileSecret).toString('base64')) &&
        !error.message.includes(Buffer.from(profileSecret).toString('hex')),
    );

    const unresolvedImageSetup = makeExecutor(async (request) =>
      request.command.includes('/home/gem/.cap/image-env')
        ? { exitCode: Number.NaN, output: '   ' }
        : { exitCode: 0, output: '' },
    );
    await assert.rejects(
      hooks.runtimeSetup({
        taskId: 'profile-command-unresolved',
        executor: unresolvedImageSetup.executor,
        runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
        modelIntent: { kind: 'runtime-default' },
      }),
      (error) =>
        /exit_code NaN$/u.test(error?.message) && !error.message.includes(' - '),
    );

    const invalidMetadata = makeExecutor(undefined, async () => ({
      exitCode: 0,
      output: '{not-json',
      stdout: '',
      stderr: '',
      timedOut: false,
    }));
    await assert.rejects(
      hooks.runtimePreflight({
        taskId: 'invalid-metadata',
        executor: invalidMetadata.executor,
        runtimeId: 'codex',
      }),
      /sandbox metadata preflight for AIO task invalid-metadata failed/,
    );

    const cleanupFailure = makeExecutor(async (request) =>
      request.command.includes('/home/gem/.cap/image-env')
        ? { exitCode: 8, output: 'cleanup failed' }
        : { exitCode: 1, output: '' },
    );
    await assert.rejects(
      () =>
        hooks.preStopTrim({
          taskId: 'image-cleanup-failed',
          executor: cleanupFailure.executor,
        }),
      (error) =>
        error?.message ===
          'image parameter cleanup for task image-cleanup-failed was not confirmed' &&
        !error.message.includes('cleanup failed'),
    );
  });

  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'http://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'boxlite-image:v1',
      BOXLITE_CAPABILITIES: 'command.exec',
    },
    async () => {
      const environmentCalls = [];
      const { host } = makeHost({
        getResolvedEnvironment: async (...args) => {
          environmentCalls.push(args);
          return null;
        },
      });
      const provider = onlyProvider(mod.createConfiguredSandboxProvider(host));
      await assert.rejects(
        provider.runtimeSetup({
          taskId: 'box-missing-runtime',
          modelIntent: { kind: 'runtime-default' },
          executionMode: 'interactive-pty',
          executor: makeExecutor().executor,
          runtimePrivateFiles: makeRuntimePrivateFileCapture().port,
          workspacePath: '/home/gem/workspace',
          sandbox: {
            id: 'box-missing-runtime',
            image: 'boxlite-image:v1',
            status: 'running',
          },
        }),
        (error) => error?.phase === 'runtime-resolution',
      );

      provider.client = new mod.FakeBoxLiteClient({
        execHandler: (request) => ({
          exitCode: 0,
          output:
            request.command === 'cat /etc/cap/sandbox-metadata.json'
              ? JSON.stringify({
                  schemaVersion: 1,
                  sandboxVersion: 'v1.2.3',
                  dependencies: { codex: '0.132.0' },
                })
              : '',
          stdout: '',
          stderr: '',
          timedOut: false,
        }),
      });
      await assert.rejects(
        provider.provision({
          taskId: 'box-provision-missing-runtime',
          cloneSpec: null,
          modelIntent: { kind: 'runtime-default' },
          executionMode: 'interactive-pty',
        }),
        (error) => error?.phase === 'runtime-resolution',
      );
      assert(
        environmentCalls.some(
          (args) =>
            args[0] === 'box-provision-missing-runtime' && args[2] === null,
        ),
      );
    },
  );
});

await test('configured transcript fallback handles a default runtime string failure', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const runtime = makeRuntime('codex');
    let defaultLookups = 0;
    const { host, logs } = makeHost({
      defaultRuntime: runtime,
      resolve(id) {
        if (id === null && defaultLookups++ === 0) {
          throw 'default runtime string failure';
        }
        return runtime;
      },
    });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    assert.equal(
      await hooks.transcriptRead({
        taskId: 'default-runtime-fallback',
        controller: { readSingleNewestJsonl: async () => null },
      }),
      null,
    );
    assert(
      logs.warn.some(
        (line) =>
          line.includes('AgentRuntime "default"') &&
          line.includes('defaulting'),
      ),
    );
    assert(
      logs.warn.every((line) => !line.includes('default runtime string failure')),
    );
  });
});

await test('configured runtime preflight maps the claude alias to claude-code metadata', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const runtime = makeRuntime('claude');
    const { host } = makeHost({ defaultRuntime: runtime, taskRuntime: runtime });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    assert.equal(
      (
        await hooks.runtimePreflight({
          taskId: 'claude-alias',
          executor: makeExecutor().executor,
          runtimeId: 'claude',
        })
      ).status,
      'passed',
    );
  });
});

await test('configured router resolves immutable provider identity for readoption', async () => {
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'auto',
      CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox.example.test',
      CAP_SANDBOX_CLOUD_HTTP_ID: 'cloud-only',
    },
    async () => {
      const launchContexts = new Map([
        [
          'runtime-default-task',
          {
            modelIntent: { kind: 'runtime-default' },
            ownerUserId: 'owner-1',
            runtimeId: 'codex',
            executionMode: 'interactive-pty',
          },
        ],
        [
          'explicit-task',
          {
            modelIntent: { kind: 'explicit', selector: 'provider/model:v1' },
            environment: { providerId: 'cloud-only' },
            ownerUserId: 'owner-1',
            runtimeId: 'codex',
            executionMode: 'interactive-pty',
          },
        ],
        [
          'missing-provider-task',
          {
            modelIntent: { kind: 'explicit', selector: 'provider/model:v1' },
            ownerUserId: 'owner-1',
            runtimeId: 'codex',
            executionMode: 'interactive-pty',
          },
        ],
      ]);
      const { host } = makeHost({
        launchContexts,
        ownerStore: {
          async getSandboxRunOwner(taskId) {
            return {
              taskId,
              providerId: 'cloud-only',
              createState: 'idle',
              status: 'running',
              cleanupAttemptInFlight: false,
              cleanupAttemptCount: 0,
            };
          },
        },
      });
      const router = mod.createConfiguredSandboxProvider(host);
      const previousFetch = globalThis.fetch;
      const requests = [];
      globalThis.fetch = async (input, init) => {
        requests.push([String(input), init?.method]);
        return { status: 404, ok: false };
      };
      try {
        assert.equal(await router.sandboxExists('runtime-default-task'), false);
        assert.equal(await router.sandboxExists('explicit-task'), false);
        await assert.rejects(
          router.sandboxExists('missing-provider-task'),
          (error) => error?.phase === 'snapshot',
        );
      } finally {
        globalThis.fetch = previousFetch;
      }
      assert.equal(requests.length, 4, 'readoption reattach and existence probe both run');
    },
  );
});

await test('configured workspace hook preserves detached options and cancellation', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const { host } = makeHost();
    const hook = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks
      .workspaceMaterialization;
    const plan = {
      repositoryUrl: 'https://example.test/repo.git',
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 60_000,
    };
    for (const detachedTransfer of [undefined, { pollIntervalMs: 5 }]) {
      const cancellation = new AbortController();
      cancellation.abort();
      const result = await hook({
        taskId: detachedTransfer ? 'detached-present' : 'detached-absent',
        plan,
        workspaceDir: '/home/gem/workspace',
        stageExecutor: {
          async execute() {
            throw new Error('cancelled materialization must not execute a stage');
          },
        },
        cancellationSignal: cancellation.signal,
        ...(detachedTransfer === undefined ? {} : { detachedTransfer }),
      });
      assert.equal(result.status, 'cancelled');
    }
  });
});

await test('configured AIO environment lookup normalizes runtime identity', async () => {
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const calls = [];
    const { host } = makeHost({
      getResolvedEnvironment: async (...args) => {
        calls.push(args);
        return args[2] === null ? undefined : { id: 'environment-v1' };
      },
    });
    const lookup = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks
      .provisionLookup.getResolvedEnvironment;
    assert.equal(await lookup('task-null-runtime', null), null);
    assert.deepEqual(await lookup('task-runtime', 123), { id: 'environment-v1' });
    assert.deepEqual(calls, [
      ['task-null-runtime', 'aio', null],
      ['task-runtime', 'aio', '123'],
    ]);
  });
});

await test('explicit cloud-http composes the cloud family exclusively and fails closed without an endpoint', async () => {
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'cloud-http',
      CAP_SANDBOX_CLOUD_HTTP_BASE_URL: 'https://sandbox-cloud.example.test',
    },
    async () => {
      const { host } = makeHost();
      const router = mod.createConfiguredSandboxProvider(host);
      const entries = router.registry.list();
      assert.equal(entries.length, 1, 'no aio/boxlite candidate leaks in');
      assert.equal(entries[0].id, 'cloud-http');
      assert.equal(entries[0].location, 'cloud');
    },
  );

  // Same explicit-family fail-closed semantics as boxlite: a selection that
  // cannot be honoured throws an actionable error naming the missing
  // configuration instead of silently falling back to another family.
  await withEnv({ CAP_SANDBOX_PROVIDER: 'cloud-http' }, async () => {
    const { host } = makeHost();
    assert.throws(
      () => mod.createConfiguredSandboxProvider(host),
      /CAP_SANDBOX_PROVIDER=cloud-http selected but CAP_SANDBOX_CLOUD_HTTP_BASE_URL is not configured/,
    );
  });
});

await test('the transcript seam dispatches the per-message-json-dir strategy without a registered runtime', async () => {
  // D3: the second vocabulary member is real. A harness-supplied runtime
  // declaring `per-message-json-dir` (no production registration exists) must
  // dispatch to that strategy's implementation instead of hitting the former
  // single-member refusal.
  await withEnv(
    {
      CAP_SANDBOX_PROVIDER: 'boxlite',
      BOXLITE_ENDPOINT: 'http://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'boxlite-image:v1',
      BOXLITE_CAPABILITIES:
        'command.exec,lifecycle.readopt,transcript.retained-read,transcript.retained-source',
      BOXLITE_WORKSPACE_PATH: '/home/gem/workspace',
    },
    async () => {
      const codexRuntime = makeRuntime('codex', {
        filenameGlob: /(^|\/)session-.*\.jsonl$/,
      });
      const perMessageRuntime = makeRuntime('per-message', {
        readKind: 'per-message-json-dir',
        transcriptDir: '/home/gem/.opencode/messages',
        filenameGlob: /(^|\/)message-.*\.json$/,
        transcriptFormat: 'per-message-json',
      });
      const { host } = makeHost({
        defaultRuntime: codexRuntime,
        taskRuntime: codexRuntime,
        resolve: (id) => (id === 'per-message' ? perMessageRuntime : codexRuntime),
      });
      const provider = onlyProvider(mod.createConfiguredSandboxProvider(host));
      const client = new mod.FakeBoxLiteClient({
        execHandler: (request) => {
          const result = {
            exitCode: 0,
            output: '',
            stdout: '',
            stderr: '',
            timedOut: false,
          };
          if (request.command === 'cat /etc/cap/sandbox-metadata.json') {
            result.output = JSON.stringify({
              schemaVersion: 1,
              sandboxVersion: 'v1.2.3',
              dependencies: { codex: '0.132.0' },
            });
          } else if (request.command.startsWith('find ')) {
            // Deliberately unsorted: ascending path order is the strategy's job.
            result.stdout = [
              '/home/gem/.opencode/messages/message-002.json',
              '/home/gem/.opencode/messages/skip.txt',
              '/home/gem/.opencode/messages/message-001.json',
            ].join('\n');
          } else if (request.command.includes('message-001.json')) {
            result.stdout = '{"role":"user"}\n';
          } else if (request.command.includes('message-002.json')) {
            result.stdout = '{"role":"assistant"}';
          }
          result.output ||= result.stdout;
          return result;
        },
      });
      provider.client = client;

      await provider.provision({
        taskId: 'per-message-task',
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
      });
      assert.deepEqual(
        await provider.readRolloutFromContainer('per-message-task', 'per-message'),
        {
          format: 'per-message-json',
          jsonl: '{"role":"user"}\n{"role":"assistant"}\n',
        },
      );
      await provider.teardownSandbox('per-message-task');
    },
  );

  // The AIO seam dispatches the member too; its container controller cannot
  // enumerate per-message artifacts, and that PROVIDER gap fails loudly under
  // its own name — distinguishable from the unknown-strategy refusal.
  await withEnv({ CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const perMessageRuntime = makeRuntime('per-message', {
      readKind: 'per-message-json-dir',
    });
    const { host } = makeHost({
      defaultRuntime: perMessageRuntime,
      taskRuntime: perMessageRuntime,
    });
    const hooks = onlyProvider(mod.createConfiguredSandboxProvider(host)).hooks;
    await assert.rejects(
      () =>
        hooks.transcriptRead({
          taskId: 'aio-per-message',
          runtimeId: 'per-message',
          controller: { readSingleNewestJsonl: async () => '{"unused":true}\n' },
        }),
      (error) =>
        /AIO cannot enumerate per-message transcript artifacts/.test(
          error?.message,
        ) && !/cannot read transcripts with strategy/.test(error?.message),
    );
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
