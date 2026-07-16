import { access, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { DefaultForgeRegistry } from './forge-registry';
import { basicAuthHeader, type Forge, type ForgeTarget } from './forge.port';
import {
  buildRemoteRefsGitEnvironment,
  RemoteRefsCommandRunner,
  RemoteRefsCommandRunnerError,
  type RemoteRefsCommandRequest,
  type RemoteRefsCommandResult,
} from './remote-refs-command-runner';
import { GitRemoteRefsProbe } from './remote-refs-probe';
import {
  NodeRemoteRefsSecretStore,
  RemoteRefsSecretStore,
  RemoteRefsSecretStoreError,
} from './remote-refs-secret-store';

const SECRET_CANARY = 'cap-remote-probe-secret-canary-4c5817';
const AUTH_HEADER = basicAuthHeader('x-access-token', SECRET_CANARY);

const TARGET: ForgeTarget = {
  kind: 'gitee',
  apiBaseUrl: 'https://gitee.example.test/api/v5',
  cloneUrl: 'https://gitee.example.test/team/private.git',
  repoId: { style: 'owner-repo', owner: 'team', repo: 'private' },
  token: SECRET_CANARY,
};

type RunProbeCommand = (
  request: RemoteRefsCommandRequest,
) => Promise<RemoteRefsCommandResult>;

function probeWith(
  run: RunProbeCommand,
  secretStore: RemoteRefsSecretStore = new NodeRemoteRefsSecretStore(),
): GitRemoteRefsProbe {
  const forge = {
    kind: 'gitee',
    cloneAuthHeader: (target: ForgeTarget) =>
      basicAuthHeader('x-access-token', target.token),
  } as unknown as Forge;
  const registry = { forKind: () => forge } as unknown as DefaultForgeRegistry;
  const runner: RemoteRefsCommandRunner = { run };
  return new GitRemoteRefsProbe(registry, runner, secretStore);
}

function configPathFrom(request: RemoteRefsCommandRequest): string {
  const include = request.args.find((arg) => arg.startsWith('include.path='));
  assert.ok(include, 'git argv references the temporary config path');
  return include.slice('include.path='.length);
}

test('probes real symbolic HEAD through an exact-host 0600 config and cleans it', async () => {
  let configPath = '';
  let capturedArgs: readonly string[] = [];
  let configText = '';
  let configMode = 0;
  let directoryMode = 0;
  const probe = probeWith(async (request) => {
    capturedArgs = request.args;
    configPath = configPathFrom(request);
    configText = await readFile(configPath, 'utf8');
    configMode = (await stat(configPath)).mode & 0o777;
    directoryMode = (await stat(dirname(configPath))).mode & 0o777;
    return {
      exitCode: 0,
      stdout: 'ref: refs/heads/master\tHEAD\n0123456789\tHEAD\n',
      stderr: '',
    };
  });

  assert.deepEqual(
    await probe.resolveDefaultBranch(TARGET, new AbortController().signal),
    { ok: true, defaultBranch: 'master' },
  );
  assert.equal(configMode, 0o600);
  assert.equal(directoryMode, 0o700);
  assert.match(configText, /\[http "https:\/\/gitee\.example\.test\/"\]/u);
  assert.match(configText, /followRedirects = false/u);
  assert.match(configText, /helper =/u);
  assert.equal(configText.includes(AUTH_HEADER), true);
  assert.equal(configText.includes('another.example.test'), false);
  assert.deepEqual(capturedArgs.slice(2), [
    'ls-remote',
    '--symref',
    '--exit-code',
    TARGET.cloneUrl,
    'HEAD',
  ]);
  assert.equal(capturedArgs.join('\n').includes(SECRET_CANARY), false);
  assert.equal(capturedArgs.join('\n').includes(AUTH_HEADER), false);
  await assert.rejects(() => access(configPath));
  await assert.rejects(() => access(dirname(configPath)));
});

for (const fixture of [
  {
    diagnostic: 'authentication rejection',
    stderr: `fatal: Authentication failed for repository ${SECRET_CANARY}`,
    reason: 'authentication_failed',
  },
  {
    diagnostic: 'access rejection',
    stderr: `remote: repository not found ${SECRET_CANARY}`,
    reason: 'access_denied',
  },
  {
    diagnostic: 'DNS failure',
    stderr: `fatal: unable to access repository: Could not resolve host ${SECRET_CANARY}`,
    reason: 'network_unavailable',
  },
  {
    diagnostic: 'TLS failure',
    stderr: `fatal: unable to access repository: TLS certificate problem ${SECRET_CANARY}`,
    reason: 'network_unavailable',
  },
] as const) {
  test(`classifies ${fixture.diagnostic} as ${fixture.reason} and discards raw git diagnostics`, async () => {
    const probe = probeWith(async () => ({
      exitCode: 128,
      stdout: '',
      stderr: fixture.stderr,
    }));
    const result = await probe.resolveDefaultBranch(
      TARGET,
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: false, reason: fixture.reason });
    assert.equal(JSON.stringify(result).includes(SECRET_CANARY), false);
  });
}

test('missing symbolic HEAD never fabricates main', async () => {
  const directHead = probeWith(async () => ({
    exitCode: 0,
    stdout: '0123456789abcdef\tHEAD\n',
    stderr: '',
  }));
  assert.deepEqual(
    await directHead.resolveDefaultBranch(TARGET, new AbortController().signal),
    { ok: false, reason: 'default_branch_unresolved' },
  );

  const missingHead = probeWith(async () => ({ exitCode: 2, stdout: '', stderr: '' }));
  assert.deepEqual(
    await missingHead.resolveDefaultBranch(TARGET, new AbortController().signal),
    { ok: false, reason: 'default_branch_unresolved' },
  );
});

test('controlled abort settles the runner and cleans secrets without sleep', async () => {
  let configPath = '';
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const probe = probeWith(async (request) => {
    configPath = configPathFrom(request);
    signalStarted();
    return new Promise<RemoteRefsCommandResult>((_resolve, reject) => {
      request.signal.addEventListener(
        'abort',
        () => reject(new RemoteRefsCommandRunnerError('aborted')),
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const pending = probe.resolveDefaultBranch(TARGET, controller.signal);

  await started;
  controller.abort(new Error(`timeout ${SECRET_CANARY}`));

  assert.deepEqual(await pending, { ok: false, reason: 'network_unavailable' });
  assert.ok(configPath);
  await assert.rejects(() => access(configPath));
});

test('cancellation waits for command settlement before credential cleanup', async () => {
  const events: string[] = [];
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const store: RemoteRefsSecretStore = {
    async create() {
      return {
        configPath: '/safe/non-secret/gitconfig',
        async cleanup() {
          assert.deepEqual(events, ['runner-stopped']);
          events.push('credential-cleaned');
        },
      };
    },
  };
  const probe = probeWith(async (request) => {
    signalStarted();
    return new Promise<RemoteRefsCommandResult>((_resolve, reject) => {
      request.signal.addEventListener(
        'abort',
        () => {
          events.push('runner-stopped');
          reject(new RemoteRefsCommandRunnerError('aborted'));
        },
        { once: true },
      );
    });
  }, store);
  const controller = new AbortController();
  const pending = probe.resolveDefaultBranch(TARGET, controller.signal);
  await started;
  controller.abort();

  assert.deepEqual(await pending, { ok: false, reason: 'network_unavailable' });
  assert.deepEqual(events, ['runner-stopped', 'credential-cleaned']);
});

test('cleanup failure overrides a successful HEAD probe and stays secret-free', async () => {
  const store: RemoteRefsSecretStore = {
    async create() {
      return {
        configPath: '/safe/non-secret/gitconfig',
        async cleanup() {
          throw new RemoteRefsSecretStoreError('cleanup_failed');
        },
      };
    },
  };
  const probe = probeWith(
    async () => ({
      exitCode: 0,
      stdout: 'ref: refs/heads/master\tHEAD\n0123456789\tHEAD\n',
      stderr: '',
    }),
    store,
  );
  const result = await probe.resolveDefaultBranch(TARGET, new AbortController().signal);
  assert.deepEqual(result, { ok: false, reason: 'access_denied' });
  assert.equal(JSON.stringify(result).includes(SECRET_CANARY), false);
  assert.equal(JSON.stringify(result).includes('/safe/non-secret'), false);
});

test('missing Git cleans the config and reports a platform dependency, not network', async () => {
  let configPath = '';
  const probe = probeWith(async (request) => {
    configPath = configPathFrom(request);
    throw new RemoteRefsCommandRunnerError('spawn_failed');
  });
  const result = await probe.resolveDefaultBranch(TARGET, new AbortController().signal);
  assert.deepEqual(result, {
    ok: false,
    reason: 'platform_dependency_unavailable',
  });
  await assert.rejects(() => access(configPath));
});

test('bounded-output and unknown non-zero outcomes remain secret-free access failures', async () => {
  for (const run of [
    async () => {
      throw new RemoteRefsCommandRunnerError('output_limit');
    },
    async () => ({
      exitCode: 99,
      stdout: SECRET_CANARY,
      stderr: `unrecognized remote failure ${SECRET_CANARY}`,
    }),
  ]) {
    const result = await probeWith(run).resolveDefaultBranch(
      TARGET,
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: false, reason: 'access_denied' });
    assert.equal(JSON.stringify(result).includes(SECRET_CANARY), false);
  }
});

test('credential canary is absent from argv, env, logs, and public result', async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  console.warn = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '));

  try {
    const probe = probeWith(async (request) => {
      const argv = request.args.join('\n');
      assert.equal(argv.includes(SECRET_CANARY), false);
      assert.equal(argv.includes(AUTH_HEADER), false);
      assert.equal(argv.includes('@gitee.example.test'), false);
      return {
        exitCode: 128,
        stdout: '',
        stderr: `fatal: Authentication failed ${SECRET_CANARY}`,
      };
    });
    const result = await probe.resolveDefaultBranch(
      TARGET,
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: false, reason: 'authentication_failed' });
    assert.equal(JSON.stringify(result).includes(SECRET_CANARY), false);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  const env = buildRemoteRefsGitEnvironment({
    PATH: '/usr/bin',
    FORGE_TOKEN: SECRET_CANARY,
    GIT_ASKPASS: SECRET_CANARY,
    HTTPS_PROXY: `https://${SECRET_CANARY}@proxy.example.test`,
  });
  assert.equal(Object.values(env).join('\n').includes(SECRET_CANARY), false);
  assert.equal(logs.join('\n').includes(SECRET_CANARY), false);
});

test('credential-bearing clone URL fails before command execution', async () => {
  let calls = 0;
  const probe = probeWith(async () => {
    calls += 1;
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const result = await probe.resolveDefaultBranch(
    { ...TARGET, cloneUrl: `https://${SECRET_CANARY}@gitee.example.test/team/repo.git` },
    new AbortController().signal,
  );
  assert.deepEqual(result, { ok: false, reason: 'access_denied' });
  assert.equal(calls, 0);
});
