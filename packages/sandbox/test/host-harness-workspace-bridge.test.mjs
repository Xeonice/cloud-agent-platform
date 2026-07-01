const mod = await import(new URL('../dist/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`ok - ${label}`);
    passed++;
  } else {
    console.error(`not ok - ${label}`);
    failed++;
  }
}

function fakeExecutor(results = []) {
  const calls = [];
  return {
    calls,
    executor: {
      async exec(request) {
        calls.push(request);
        return results.shift() ?? {
          exitCode: 0,
          output: '',
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
    },
  };
}

assert(
  mod.buildGitCloneCommand({ url: 'https://github.com/acme/repo.git' }, '/workspace') ===
    "git clone -- 'https://github.com/acme/repo.git' '/workspace'",
  'clone command without auth shell-quotes dynamic args',
);
assert(
  mod.buildGitCloneCommand(
    {
      url: 'https://github.com/acme/private.git',
      authHeader: 'Authorization: Basic abc',
    },
    '/workspace',
  ) ===
    "git -c 'http.extraHeader=Authorization: Basic abc' clone -- 'https://github.com/acme/private.git' '/workspace'",
  'clone command with auth uses http.extraHeader, not URL userinfo',
);
assert(
  mod.buildGitCloneCommand(
    { url: "https://github.com/acme/repo.git; touch /tmp/pwn'$(whoami)" },
    "/workspace path/with spaces'; rm -rf /",
  ) ===
    "git clone -- 'https://github.com/acme/repo.git; touch /tmp/pwn'\\''$(whoami)' '/workspace path/with spaces'\\''; rm -rf /'",
  'clone command quotes adversarial URL and workspace inputs',
);

const nested = mod.parseAioExecResult({
  data: { exit_code: '7', stderr: 'boom' },
});
assert(nested.exitCode === 7 && nested.output === 'boom', 'nested AIO exec result parses exit code + stderr');
assert(
  Number.isNaN(mod.parseAioExecResult({ data: { output: 'missing code' } }).exitCode),
  'missing AIO exit code stays NaN (fail-closed)',
);
assert(
  mod.scrubAioExecSecrets('https://u:p@example.com/x Authorization: Basic secret') ===
    'https://***:***@example.com/x Authorization: Basic ***',
  'AIO exec output scrubber redacts URL userinfo and Basic auth',
);

const cloneOk = fakeExecutor();
await mod.materializeSandboxGitWorkspace({
  executor: cloneOk.executor,
  taskId: 'task-clone',
  spec: { url: 'https://github.com/acme/repo.git' },
  workspaceDir: '/home/gem/workspace',
});
assert(
  cloneOk.calls[0].command ===
    "git clone -- 'https://github.com/acme/repo.git' '/home/gem/workspace'",
  'materializeSandboxGitWorkspace issues the expected clone command',
);

const cloneFail = fakeExecutor([
  { exitCode: 1, output: 'fatal https://u:p@example.com/repo.git Authorization: Basic secret' },
]);
let cloneError = '';
try {
  await mod.materializeSandboxGitWorkspace({
    executor: cloneFail.executor,
    taskId: 'task-fail',
    spec: { url: 'https://github.com/acme/repo.git' },
    workspaceDir: '/home/gem/workspace',
  });
} catch (err) {
  cloneError = err instanceof Error ? err.message : String(err);
}
assert(
  cloneError.includes('task-fail') &&
    cloneError.includes('exit_code 1') &&
    cloneError.includes('https://***:***@') &&
    cloneError.includes('Authorization: Basic ***'),
  'materializeSandboxGitWorkspace fail-closed error carries task context and scrubbed output',
);

const cloneThrow = fakeExecutor();
cloneThrow.executor.exec = async () => {
  throw new Error('network down');
};
let cloneThrown = '';
try {
  await mod.materializeSandboxGitWorkspace({
    executor: cloneThrow.executor,
    taskId: 'task-throw',
    spec: { url: 'https://github.com/acme/repo.git' },
    workspaceDir: '/home/gem/workspace',
  });
} catch (err) {
  cloneThrown = String(err?.message ?? err);
}
assert(
  cloneThrown.includes('task-throw') && cloneThrown.includes('network down'),
  'materializeSandboxGitWorkspace wraps executor exceptions with task context',
);

const cloneThrowString = fakeExecutor();
cloneThrowString.executor.exec = async () => {
  throw 'string clone failure';
};
let cloneStringThrown = '';
try {
  await mod.materializeSandboxGitWorkspace({
    executor: cloneThrowString.executor,
    taskId: 'task-throw-string',
    spec: { url: 'https://github.com/acme/repo.git' },
    workspaceDir: '/home/gem/workspace',
  });
} catch (err) {
  cloneStringThrown = String(err?.message ?? err);
}
assert(
  cloneStringThrown.includes('string clone failure'),
  'materializeSandboxGitWorkspace reports non-Error executor exceptions',
);

const cloneFailQuiet = fakeExecutor([{ exitCode: 1, output: '' }]);
let cloneQuietError = '';
try {
  await mod.materializeSandboxGitWorkspace({
    executor: cloneFailQuiet.executor,
    taskId: 'task-fail-quiet',
    spec: { url: 'https://github.com/acme/repo.git' },
    workspaceDir: '/home/gem/workspace',
  });
} catch (err) {
  cloneQuietError = String(err?.message ?? err);
}
assert(
  cloneQuietError.endsWith('exit_code 1'),
  'materializeSandboxGitWorkspace omits empty scrubbed output',
);

const noChanges = fakeExecutor([{ exitCode: 0, output: '' }]);
const cleanResult = await mod.deliverSandboxGitWorkspaceChanges({
  executor: noChanges.executor,
  taskId: 'task-deliver-clean',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-clean',
    commitMessage: 'cap: clean',
  },
});
assert(cleanResult.hadChanges === false && cleanResult.error === null, 'delivery returns no_changes for clean porcelain');
assert(noChanges.calls.length === 1, 'clean delivery stops after git status');

const push = fakeExecutor([
  { exitCode: 0, output: ' M file.txt\n' },
  { exitCode: 0, output: '' },
  { exitCode: 0, output: '' },
  { exitCode: 0, output: 'abc123\n' },
  { exitCode: 0, output: '' },
]);
const pushedResult = await mod.deliverSandboxGitWorkspaceChanges({
  executor: push.executor,
  taskId: 'task-deliver',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-deliver',
    commitMessage: 'cap: deliver',
  },
});
assert(pushedResult.hadChanges === true && pushedResult.commitSha === 'abc123' && pushedResult.error === null, 'delivery returns pushed commit sha');
assert(
  push.calls.some((c) => c.command.includes("commit -F '/tmp/cap-commit-msg'")),
  'delivery writes commit message to a file and commits with -F',
);
assert(
  push.calls.some((c) => c.command.includes("-c 'http.extraHeader=Authorization: Basic push' push --force-with-lease")),
  'delivery pushes with http.extraHeader auth',
);

const statusFail = await mod.deliverSandboxGitWorkspaceChanges({
  executor: fakeExecutor([{ exitCode: 128, output: 'fatal' }]).executor,
  taskId: 'task-status-fail',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-status-fail',
    commitMessage: 'cap: status',
  },
});
assert(statusFail.error === 'git status exit 128', 'delivery reports git status failures');

const writeFail = await mod.deliverSandboxGitWorkspaceChanges({
  executor: fakeExecutor([
    { exitCode: 0, output: ' M file.txt\n' },
    { exitCode: 1, output: 'write failed' },
  ]).executor,
  taskId: 'task-write-fail',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-write-fail',
    commitMessage: 'cap: write',
  },
});
assert(
  writeFail.hadChanges === true && writeFail.error === 'failed to stage commit message',
  'delivery reports commit-message staging failures',
);

const commitFail = await mod.deliverSandboxGitWorkspaceChanges({
  executor: fakeExecutor([
    { exitCode: 0, output: ' M file.txt\n' },
    { exitCode: 0, output: '' },
    { exitCode: 1, output: 'Authorization: Basic secret' },
  ]).executor,
  taskId: 'task-commit-fail',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-commit-fail',
    commitMessage: 'cap: commit',
  },
});
assert(commitFail.error === 'Authorization: Basic ***', 'delivery scrubs git commit failures');

const commitFailQuiet = await mod.deliverSandboxGitWorkspaceChanges({
  executor: fakeExecutor([
    { exitCode: 0, output: ' M file.txt\n' },
    { exitCode: 0, output: '' },
    { exitCode: 1, output: '' },
  ]).executor,
  taskId: 'task-commit-fail-quiet',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-commit-fail-quiet',
    commitMessage: 'cap: commit quiet',
  },
});
assert(commitFailQuiet.error === 'commit failed', 'delivery falls back for empty commit failure output');

const pushFail = await mod.deliverSandboxGitWorkspaceChanges({
  executor: fakeExecutor([
    { exitCode: 0, output: ' M file.txt\n' },
    { exitCode: 0, output: '' },
    { exitCode: 0, output: '' },
    { exitCode: 1, output: 'rev failed' },
    { exitCode: 1, output: '' },
  ]).executor,
  taskId: 'task-push-fail',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-push-fail',
    commitMessage: 'cap: push',
  },
});
assert(
  pushFail.hadChanges === true &&
    pushFail.commitSha === null &&
    pushFail.error === 'push failed',
  'delivery handles failed rev-parse and push fallback errors',
);

const pushFailWithEmptySha = await mod.deliverSandboxGitWorkspaceChanges({
  executor: fakeExecutor([
    { exitCode: 0, output: ' M file.txt\n' },
    { exitCode: 0, output: '' },
    { exitCode: 0, output: '' },
    { exitCode: 0, output: '   \n' },
    { exitCode: 1, output: 'push denied' },
  ]).executor,
  taskId: 'task-push-empty-sha',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-push-empty-sha',
    commitMessage: 'cap: push empty sha',
  },
});
assert(
  pushFailWithEmptySha.commitSha === null &&
    pushFailWithEmptySha.error === 'push denied',
  'delivery treats empty rev-parse output as null commit sha',
);

const deliverThrow = fakeExecutor([{ exitCode: 0, output: ' M file.txt\n' }]);
deliverThrow.executor.exec = async (request) => {
  deliverThrow.calls.push(request);
  if (deliverThrow.calls.length > 1) throw new Error('disk full');
  return { exitCode: 0, output: ' M file.txt\n' };
};
const thrownDelivery = await mod.deliverSandboxGitWorkspaceChanges({
  executor: deliverThrow.executor,
  taskId: 'task-deliver-throw',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-deliver-throw',
    commitMessage: 'cap: throw',
  },
});
assert(thrownDelivery.error === 'disk full', 'delivery catches executor exceptions');

const deliverThrowString = fakeExecutor([{ exitCode: 0, output: ' M file.txt\n' }]);
deliverThrowString.executor.exec = async (request) => {
  deliverThrowString.calls.push(request);
  if (deliverThrowString.calls.length > 1) throw 'string disk full';
  return { exitCode: 0, output: ' M file.txt\n' };
};
assert(
  (await mod.deliverSandboxGitWorkspaceChanges({
    executor: deliverThrowString.executor,
    taskId: 'task-deliver-throw-string',
    workspaceDir: '/home/gem/workspace',
    timeoutMs: 10_000,
    deliver: {
      authHeader: 'Authorization: Basic push',
      branch: 'cap/task-deliver-throw-string',
      commitMessage: 'cap: throw string',
    },
  })).error === 'string disk full',
  'delivery reports non-Error exceptions',
);

const connection = {
  taskId: 'task-1',
  baseUrl: 'http://aio',
  wsUrl: 'ws://aio/v1/shell/ws',
};
const fallback = mod.resolveSandboxWorkspaceDescriptor({ connection });
assert(fallback.mode === 'git', 'fallback workspace descriptor is git');
assert(fallback.path === '/home/gem/workspace', 'fallback workspace path is AIO workspace');
assert(fallback.git?.deliverable === true, 'fallback workspace is deliverable');

const selectedRun = {
  workspace: {
    mode: 'git',
    path: '/work/custom',
    git: { materialized: true, deliverable: true },
  },
};
const selected = mod.resolveSandboxWorkspaceDescriptor({ connection, selectedRun });
assert(selected.path === '/work/custom', 'selected-run workspace descriptor takes precedence');

const materialize = fakeExecutor();
await mod.buildSandboxWorkspaceBridge({
  executor: materialize.executor,
  descriptor: selected,
}).materializeGit({
  taskId: 'task-1',
  spec: { url: 'https://github.com/acme/repo.git' },
});
assert(
  materialize.calls[0].command.includes("'https://github.com/acme/repo.git' '/work/custom'"),
  'git materialization uses descriptor workspace path',
);

const defaultBridge = mod.buildSandboxWorkspaceBridge({
  executor: fakeExecutor().executor,
});
assert(
  defaultBridge.workspaceDir === '/home/gem/workspace',
  'workspace bridge defaults to AIO workspace path',
);

const pathlessBridge = mod.buildSandboxWorkspaceBridge({
  executor: fakeExecutor().executor,
  descriptor: {
    mode: 'git',
    git: { materialized: true, deliverable: true },
  },
});
assert(
  pathlessBridge.workspaceDir === '/home/gem/workspace',
  'workspace bridge falls back when descriptor path is absent',
);

const deliver = fakeExecutor([
  { exitCode: 0, output: ' M file.txt\n', stdout: '', stderr: '', timedOut: false },
  { exitCode: 0, output: '', stdout: '', stderr: '', timedOut: false },
  { exitCode: 0, output: '', stdout: '', stderr: '', timedOut: false },
  { exitCode: 0, output: 'abc123\n', stdout: '', stderr: '', timedOut: false },
  { exitCode: 0, output: '', stdout: '', stderr: '', timedOut: false },
]);
const delivered = await mod.buildSandboxWorkspaceBridge({
  executor: deliver.executor,
  descriptor: selected,
}).deliverGit({
  taskId: 'task-1',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-1',
    commitMessage: 'cap: task',
  },
});
assert(delivered.commitSha === 'abc123', 'git delivery returns commit sha through bridge');
assert(
  deliver.calls.every((call) => call.timeoutMs === 10_000),
  'git delivery forwards timeout to executor calls',
);
assert(
  deliver.calls.some((call) => call.command.includes("git -C '/work/custom'")),
  'git delivery uses descriptor workspace path',
);

const archiveBridge = mod.buildSandboxWorkspaceBridge({
  executor: fakeExecutor().executor,
  descriptor: {
    mode: 'archive',
    path: '/archive/workspace',
    archive: { upload: true, download: true },
  },
});
let materializeUnsupported = false;
try {
  await archiveBridge.materializeGit({
    taskId: 'task-archive',
    spec: { url: 'https://github.com/acme/repo.git' },
  });
} catch (err) {
  materializeUnsupported = /does not support git materialization/.test(
    String(err?.message ?? err),
  );
}
assert(materializeUnsupported, 'archive descriptor does not pretend to support git materialization');

let deliveryUnsupported = false;
try {
  await archiveBridge.deliverGit({
    taskId: 'task-archive',
    timeoutMs: 10_000,
    deliver: {
      authHeader: 'Authorization: Basic push',
      branch: 'cap/task-archive',
      commitMessage: 'cap: archive',
    },
  });
} catch (err) {
  deliveryUnsupported = /does not support git delivery/.test(String(err?.message ?? err));
}
assert(deliveryUnsupported, 'archive descriptor does not pretend to support git delivery');

const archiveGitBridge = mod.buildSandboxWorkspaceBridge({
  executor: fakeExecutor().executor,
  descriptor: {
    mode: 'archive',
    path: '/archive-git',
    git: { materialized: true, deliverable: true },
    archive: { upload: true, download: true },
  },
});
await archiveGitBridge.materializeGit({
  taskId: 'task-archive-git',
  spec: { url: 'https://github.com/acme/repo.git' },
});
await archiveGitBridge.deliverGit({
  taskId: 'task-archive-git',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push',
    branch: 'cap/task-archive-git',
    commitMessage: 'cap: archive git',
  },
});
assert(
  archiveGitBridge.workspaceDir === '/archive-git',
  'workspace bridge allows non-git descriptors with explicit git materialization support',
);

let missingExecutor = false;
try {
  await mod.materializeSandboxGitWorkspace({
    taskId: 'task-no-executor',
    spec: { url: 'https://github.com/acme/repo.git' },
    workspaceDir: '/workspace',
  });
} catch (err) {
  missingExecutor = /workspace command executor is required/.test(
    String(err?.message ?? err),
  );
}
assert(missingExecutor, 'workspace helpers require an executor or baseUrl');

const previousFetch = globalThis.fetch;
const fetchCalls = [];
globalThis.fetch = async (input, init = {}) => {
  fetchCalls.push({ input: String(input), body: JSON.parse(init.body) });
  return {
    ok: true,
    status: 200,
    async json() {
      return { data: { exit_code: 0, output: 'remote-ok' } };
    },
  };
};
try {
  await mod.materializeSandboxGitWorkspace({
    baseUrl: 'http://aio-shell',
    taskId: 'task-base-url',
    spec: { url: 'https://github.com/acme/repo.git' },
    workspaceDir: '/workspace',
  });
  const shellOk = await mod.runSandboxAioShellExec(
    'http://aio-shell',
    'echo ok',
    123,
  );
  assert(
    shellOk.exitCode === 0 && shellOk.output === 'remote-ok',
    'runSandboxAioShellExec returns normalized AIO exec output',
  );
  assert(
    fetchCalls[0].input === 'http://aio-shell/v1/shell/exec',
    'runSandboxAioShellExec posts to AIO shell exec',
  );

  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async json() {
      return {};
    },
  });
  let shellError = '';
  try {
    await mod.runSandboxAioShellExec('http://aio-shell', 'echo fail');
  } catch (err) {
    shellError = String(err?.message ?? err);
  }
  assert(
    shellError.includes('/v1/shell/exec responded 503'),
    'runSandboxAioShellExec throws normalized AIO HTTP failures',
  );
} finally {
  globalThis.fetch = previousFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
