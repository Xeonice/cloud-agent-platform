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
let rawCloneCommandRejected = false;
try {
  mod.buildGitCloneCommand(
    {
      url: 'https://github.com/acme/private.git',
      authHeader: 'Authorization: Basic abc',
    },
    '/workspace',
  );
} catch (error) {
  rawCloneCommandRejected = /Legacy raw-header Git clone is disabled/u.test(
    String(error?.message ?? error),
  );
}
assert(rawCloneCommandRejected, 'clone command rejects legacy raw auth headers');
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

const rawClone = fakeExecutor();
let rawCloneError = '';
try {
  await mod.materializeSandboxGitWorkspace({
    executor: rawClone.executor,
    taskId: 'task-raw-clone',
    spec: {
      url: 'https://github.com/acme/private.git',
      authHeader: 'Authorization: Basic clone-canary',
    },
    workspaceDir: '/home/gem/workspace',
  });
} catch (error) {
  rawCloneError = String(error?.message ?? error);
}
assert(
  rawCloneError.includes('Legacy raw-header Git clone is disabled'),
  'legacy materialization rejects raw auth headers',
);
assert(rawClone.calls.length === 0, 'raw clone is rejected before guest exec');

const rawDelivery = fakeExecutor();
const rawDeliveryResult = await mod.deliverSandboxGitWorkspaceChanges({
  executor: rawDelivery.executor,
  taskId: 'task-deliver-raw',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    authHeader: 'Authorization: Basic push-canary',
    branch: 'cap/task-raw',
    commitMessage: 'cap: raw',
  },
});
assert(
  rawDeliveryResult.error === 'Legacy raw-header Git delivery is disabled',
  'legacy workspace bridge rejects raw-header delivery',
);
assert(rawDelivery.calls.length === 0, 'raw delivery is rejected before guest exec');

const credentialedDelivery = fakeExecutor();
const credentialedDeliveryResult = await mod.deliverSandboxGitWorkspaceChanges({
  executor: credentialedDelivery.executor,
  taskId: 'task-deliver-credentialed',
  workspaceDir: '/home/gem/workspace',
  timeoutMs: 10_000,
  deliver: {
    credential: mod.createExactHostGitCredential(
      'https://code.example.test/org/repo.git',
      'Authorization: Basic CAP_BRIDGE_UNMIGRATED_CREDENTIAL_CANARY',
    ),
    branch: 'cap/task-credentialed',
    commitMessage: 'cap: credentialed',
  },
});
assert(
  credentialedDeliveryResult.error ===
    'Credentialed delivery requires the provider staged workspace adapter',
  'legacy workspace bridge rejects canonical credentialed delivery',
);
assert(
  credentialedDelivery.calls.length === 0,
  'legacy workspace bridge rejects canonical credential before exec',
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

const deliver = fakeExecutor();
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
assert(
  delivered.error === 'Legacy raw-header Git delivery is disabled',
  'workspace bridge keeps legacy raw-header delivery fail-closed',
);
assert(
  deliver.calls.length === 0,
  'workspace bridge rejects raw delivery before executor calls',
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
