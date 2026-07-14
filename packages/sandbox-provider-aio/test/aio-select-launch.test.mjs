import assert from 'node:assert/strict';

const { selectLaunch } = await import(new URL('../dist/index.js', import.meta.url).href);

const CTX = {
  taskId: 'task-select-launch',
  workspaceDir: '/home/gem/workspace',
  sessionId: '11111111-2222-3333-4444-555555555555',
  model: { kind: 'runtime-default' },
};

function runtime(overrides = {}) {
  return {
    id: 'fake-runtime',
    terminalStartup: { replyToStartupDSR: true, promptSubmit: 'cr-on-quiesce' },
    buildLaunchLine: (ctx) => `interactive:${ctx.taskId}:${ctx.workspaceDir}`,
    buildHeadlessLine: (ctx) => `headless:${ctx.taskId}:${ctx.sessionId}`,
    async detectExit() {
      return { status: 'running' };
    },
    ...overrides,
  };
}

{
  const plan = selectLaunch(runtime(), 'interactive-pty', CTX, true);
  assert.equal(plan.line, 'interactive:task-select-launch:/home/gem/workspace');
  assert.deepEqual(plan.terminalStartup, {
    replyToStartupDSR: true,
    promptSubmit: 'cr-on-quiesce',
  });
  assert.equal(plan.armAutoSubmit, true);
}

{
  const plan = selectLaunch(runtime(), 'headless-exec', CTX, true);
  assert.equal(
    plan.line,
    'headless:task-select-launch:11111111-2222-3333-4444-555555555555',
  );
  assert.deepEqual(plan.terminalStartup, {
    replyToStartupDSR: false,
    promptSubmit: 'none',
  });
  assert.equal(plan.armAutoSubmit, false);
}

{
  const plan = selectLaunch(
    runtime({ terminalStartup: { replyToStartupDSR: false, promptSubmit: 'none' } }),
    'interactive-pty',
    CTX,
    true,
  );
  assert.equal(plan.line, 'interactive:task-select-launch:/home/gem/workspace');
  assert.deepEqual(plan.terminalStartup, {
    replyToStartupDSR: false,
    promptSubmit: 'none',
  });
  assert.equal(plan.armAutoSubmit, false);
}

{
  const noHeadless = runtime({ buildHeadlessLine: undefined });
  assert.throws(
    () => selectLaunch(noHeadless, 'headless-exec', CTX, true),
    /does not support headless execution/,
  );
}

{
  const plan = selectLaunch(runtime(), 'interactive-pty', CTX, false);
  assert.equal(plan.armAutoSubmit, false);
}

{
  const explicit = {
    ...CTX,
    model: {
      kind: 'explicit',
      path: '/home/gem/.cap/task-model.txt',
      checksum:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
  let seen;
  selectLaunch(
    runtime({
      buildLaunchLine(ctx) {
        seen = ctx.model;
        return 'explicit';
      },
    }),
    'interactive-pty',
    explicit,
    true,
  );
  assert.deepEqual(seen, explicit.model);
}

console.log('aio-select-launch.test.mjs passed');
