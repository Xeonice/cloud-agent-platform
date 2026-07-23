import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PrismaService } from '../prisma/prisma.service';
import {
  buildRepoStoreGitEnvironment,
  NodeRepoStoreCommandRunner,
  NodeRepoStoreCredentialStore,
  RepoStoreCredentialStore,
  runRepoStoreGitCommand,
  type RepoStoreCredentialLease,
  type RepoStoreProgressEvent,
} from './repo-store-git';
import {
  REPO_STORE_DIR_ENV,
  REPO_STORE_STAGING_DIRNAME,
  RepoStoreService,
} from './repo-store.service';

/**
 * Integration-style unit tests: the repo-store IS filesystem + git behavior, so
 * these drive the real `git` binary against real temporary directories. Every
 * git invocation runs through {@link buildRepoStoreGitEnvironment}, which pins
 * `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` and inherits no
 * HOME — the fixture repositories therefore cannot read or write any real
 * developer git configuration, and every path stays under the OS temp dir.
 */

interface RepoUpdate {
  readonly where: { readonly id: string };
  readonly data: Record<string, unknown>;
}

function fakePrisma(): { prisma: PrismaService; updates: RepoUpdate[] } {
  const updates: RepoUpdate[] = [];
  const prisma = {
    repo: {
      updateMany: async (args: RepoUpdate) => {
        updates.push({ where: args.where, data: { ...args.data } });
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  return { prisma, updates };
}

function lastStatus(updates: RepoUpdate[]): unknown {
  return updates.at(-1)?.data.copyStatus;
}

async function makeTempRoot(prefix: string): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, prefix));
  // Guard against ever pointing the destructive paths at a real workspace.
  assert.ok(dir.startsWith(base), 'temp root must live under the OS temp dir');
  return dir;
}

async function git(args: readonly string[]): Promise<void> {
  const result = await runRepoStoreGitCommand({
    args,
    signal: AbortSignal.timeout(30_000),
    stage: 'preparing',
  });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function gitOutput(args: readonly string[]): Promise<string> {
  const result = await runRepoStoreGitCommand({
    args,
    signal: AbortSignal.timeout(30_000),
    stage: 'preparing',
  });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function commitFile(repo: string, name: string, body: string): Promise<void> {
  await writeFile(join(repo, name), body, 'utf8');
  await git(['-C', repo, 'add', '--', name]);
  await git([
    '-C',
    repo,
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'user.name=Repo Store Fixture',
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    `add ${name}`,
  ]);
}

async function makeSourceRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  await git(['init', '--quiet', '--initial-branch=main', repo]);
  await commitFile(repo, 'README.md', 'hello\n');
  return repo;
}

function serviceFor(prisma: PrismaService, credentials?: RepoStoreCredentialStore) {
  return new RepoStoreService(
    prisma,
    new NodeRepoStoreCommandRunner(),
    credentials ?? new NodeRepoStoreCredentialStore(),
  );
}

async function withStore(
  name: string,
  body: (context: {
    readonly root: string;
    readonly store: string;
    readonly service: RepoStoreService;
    readonly prisma: PrismaService;
    readonly updates: RepoUpdate[];
  }) => Promise<void>,
): Promise<void> {
  const root = await makeTempRoot(name);
  const store = join(root, 'repo-store');
  const previous = process.env[REPO_STORE_DIR_ENV];
  process.env[REPO_STORE_DIR_ENV] = store;
  const { prisma, updates } = fakePrisma();
  try {
    await mkdir(store, { recursive: true });
    await body({ root, store, service: serviceFor(prisma), prisma, updates });
  } finally {
    if (previous === undefined) delete process.env[REPO_STORE_DIR_ENV];
    else process.env[REPO_STORE_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function stagingEntries(store: string): Promise<string[]> {
  try {
    return await readdir(join(store, REPO_STORE_STAGING_DIRNAME));
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('acquire materializes a bare mirror atomically and clears staging', async () => {
  await withStore('cap-repo-store-acquire-', async ({ root, store, service, updates }) => {
    const source = await makeSourceRepo(root, 'source');
    const events: RepoStoreProgressEvent[] = [];

    const result = await service.acquire({
      repoId: 'repo-one',
      source,
      onProgress: (event) => events.push(event),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.path, join(store, 'repo-one.git'));
    assert.equal(result.subpath, 'repo-one.git');

    // A real bare mirror carrying the source's refs.
    assert.equal(
      await gitOutput(['-C', result.path, 'rev-parse', '--is-bare-repository']),
      'true',
    );
    assert.equal(
      await gitOutput(['-C', result.path, 'rev-parse', 'refs/heads/main']),
      await gitOutput(['-C', source, 'rev-parse', 'HEAD']),
    );

    // Nothing is left behind in staging, and the copy is the only entry.
    assert.deepEqual(await stagingEntries(store), []);

    // Progress is observable and the publish step is reported.
    assert.ok(events.length > 0, 'acquisition reports progress');
    assert.ok(events.some((event) => event.stage === 'finalizing'));

    assert.equal(lastStatus(updates), 'ready');
    assert.ok(updates.at(-1)?.data.copyUpdatedAt instanceof Date);
    assert.deepEqual(
      updates.map((update) => update.data.copyStatus),
      ['refreshing', 'ready'],
    );
  });
});

test('failed acquisition leaves no copy and the retry needs no cleanup', async () => {
  await withStore('cap-repo-store-retry-', async ({ root, store, service, updates }) => {
    const missing = join(root, 'not-a-repo');

    const failure = await service.acquire({ repoId: 'repo-two', source: missing });
    assert.equal(failure.ok, false);
    if (failure.ok) return;
    assert.equal(failure.reason, 'source_invalid');
    assert.equal(failure.stage, 'transferring');
    assert.equal(lastStatus(updates), 'failed');

    // No half-written copy at the final path, nothing stranded in staging.
    assert.equal(await exists(join(store, 'repo-two.git')), false);
    assert.deepEqual(await stagingEntries(store), []);

    // Retrying the same repo id succeeds without any operator cleanup.
    const source = await makeSourceRepo(root, 'source');
    const retry = await service.acquire({ repoId: 'repo-two', source });
    assert.equal(retry.ok, true);
    assert.equal(lastStatus(updates), 'ready');
    assert.deepEqual(await stagingEntries(store), []);
  });
});

test('re-acquiring replaces the copy in place and keeps staging empty', async () => {
  await withStore('cap-repo-store-replace-', async ({ root, store, service }) => {
    const source = await makeSourceRepo(root, 'source');
    assert.equal((await service.acquire({ repoId: 'repo-three', source })).ok, true);

    await commitFile(source, 'second.md', 'second\n');
    const again = await service.acquire({ repoId: 'repo-three', source });
    assert.equal(again.ok, true);
    if (!again.ok) return;

    assert.equal(
      await gitOutput(['-C', again.path, 'rev-parse', 'refs/heads/main']),
      await gitOutput(['-C', source, 'rev-parse', 'HEAD']),
    );
    assert.deepEqual(await stagingEntries(store), []);
  });
});

test('refresh fast-forwards the stored mirror and stamps the timestamp', async () => {
  await withStore('cap-repo-store-refresh-', async ({ root, service, updates }) => {
    const source = await makeSourceRepo(root, 'source');
    const acquired = await service.acquire({ repoId: 'repo-four', source });
    assert.equal(acquired.ok, true);

    await commitFile(source, 'second.md', 'second\n');
    const refreshed = await service.refresh({ repoId: 'repo-four' });
    assert.equal(refreshed.ok, true);
    if (!refreshed.ok) return;

    assert.equal(
      await gitOutput(['-C', refreshed.path, 'rev-parse', 'refs/heads/main']),
      await gitOutput(['-C', source, 'rev-parse', 'HEAD']),
    );
    assert.equal(lastStatus(updates), 'ready');
    assert.ok(updates.at(-1)?.data.copyUpdatedAt instanceof Date);
  });
});

test('refresh prunes refs deleted upstream', async () => {
  await withStore('cap-repo-store-prune-', async ({ root, service }) => {
    const source = await makeSourceRepo(root, 'source');
    await git(['-C', source, 'branch', 'feature/gone']);
    const acquired = await service.acquire({ repoId: 'repo-five', source });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    assert.ok(
      (await gitOutput(['-C', acquired.path, 'for-each-ref', '--format=%(refname)'])).includes(
        'refs/heads/feature/gone',
      ),
    );

    await git(['-C', source, 'branch', '-D', 'feature/gone']);
    const refreshed = await service.refresh({ repoId: 'repo-five' });
    assert.equal(refreshed.ok, true);
    assert.ok(
      !(
        await gitOutput(['-C', acquired.path, 'for-each-ref', '--format=%(refname)'])
      ).includes('refs/heads/feature/gone'),
    );
  });
});

test('a failed refresh keeps the last-good copy and reports a typed cause', async () => {
  await withStore('cap-repo-store-lastgood-', async ({ root, service, updates }) => {
    const source = await makeSourceRepo(root, 'source');
    const acquired = await service.acquire({ repoId: 'repo-six', source });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    const goodHead = await gitOutput(['-C', acquired.path, 'rev-parse', 'refs/heads/main']);
    const readyAt = updates.at(-1)?.data.copyUpdatedAt;

    // The remote disappears (equivalent to an unreachable / revoked source).
    await rm(source, { recursive: true, force: true });
    const failure = await service.refresh({ repoId: 'repo-six' });
    assert.equal(failure.ok, false);
    if (failure.ok) return;
    assert.equal(failure.reason, 'source_invalid');
    assert.equal(failure.stage, 'transferring');

    // Last-good content survives untouched and remains readable.
    assert.equal(
      await gitOutput(['-C', acquired.path, 'rev-parse', 'refs/heads/main']),
      goodHead,
    );
    // Status degrades to failed, but the successful-copy timestamp is not moved.
    assert.equal(lastStatus(updates), 'failed');
    assert.ok(readyAt instanceof Date);
    assert.equal(
      updates.filter((update) => update.data.copyUpdatedAt !== undefined).length,
      1,
    );
  });
});

test('refresh without a stored copy reports copy_missing and records missing', async () => {
  await withStore('cap-repo-store-nocopy-', async ({ service, updates }) => {
    const result = await service.refresh({ repoId: 'repo-seven' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'copy_missing');
    assert.equal(lastStatus(updates), 'missing');
    // `missing` must retract the successful-copy timestamp: the DB shape check
    // rejects a `missing` row that still claims one.
    assert.equal(updates.at(-1)?.data.copyUpdatedAt, null);
  });
});

test('a copy deleted out of band demotes a ready Repo to missing with no timestamp', async () => {
  await withStore('cap-repo-store-vanished-', async ({ root, service, updates }) => {
    const source = await makeSourceRepo(root, 'source');
    const acquired = await service.acquire({ repoId: 'repo-thirteen', source });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    assert.ok(updates.at(-1)?.data.copyUpdatedAt instanceof Date);

    // The volume lost the copy (operator wiped it, volume recreated, ...).
    await rm(acquired.path, { recursive: true, force: true });

    const result = await service.refresh({ repoId: 'repo-thirteen' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'copy_missing');
    assert.equal(lastStatus(updates), 'missing');
    assert.equal(updates.at(-1)?.data.copyUpdatedAt, null);
  });
});

test('remove deletes the copy, sweeps staging leftovers, and is idempotent', async () => {
  await withStore('cap-repo-store-remove-', async ({ root, store, service }) => {
    const source = await makeSourceRepo(root, 'source');
    const acquired = await service.acquire({ repoId: 'repo-eight', source });
    assert.equal(acquired.ok, true);

    // Simulate a crashed acquisition leaving a staging directory behind.
    const stranded = join(store, REPO_STORE_STAGING_DIRNAME, 'repo-eight-abandoned');
    await mkdir(stranded, { recursive: true });
    // A different repo's staging entry must survive.
    const other = join(store, REPO_STORE_STAGING_DIRNAME, 'repo-nine-abandoned');
    await mkdir(other, { recursive: true });

    await service.remove('repo-eight');
    assert.equal(await exists(join(store, 'repo-eight.git')), false);
    assert.equal(await exists(stranded), false);
    assert.equal(await exists(other), true);

    // Idempotent: removing again (and removing a repo that never had a copy) is
    // a no-op rather than an error.
    await service.remove('repo-eight');
    await service.remove('repo-never-imported');
    assert.equal(await exists(join(store, 'repo-eight.git')), false);
  });
});

test('acquire never persists a credential and cleans the temporary config', async () => {
  await withStore('cap-repo-store-secret-', async ({ store, service: _unused, prisma }) => {
    const leases: string[] = [];
    const inner = new NodeRepoStoreCredentialStore();
    const recording: RepoStoreCredentialStore = {
      async create(cleanUrl: string, authHeader: string): Promise<RepoStoreCredentialLease> {
        const lease = await inner.create(cleanUrl, authHeader);
        leases.push(lease.configPath);
        return lease;
      },
    };
    const service = serviceFor(prisma, recording);

    // Port 1 refuses instantly: a deterministic transport failure with auth on.
    const failure = await service.acquire({
      repoId: 'repo-ten',
      source: 'http://127.0.0.1:1/private.git',
      authHeader: 'Authorization:Basic-canary-4c5817',
    });
    assert.equal(failure.ok, false);
    if (failure.ok) return;
    assert.equal(failure.reason, 'network_unavailable');
    assert.ok(!failure.detail.includes('canary'), 'failure detail carries no credential');

    assert.equal(leases.length, 1);
    assert.equal(await exists(leases[0] as string), false, 'credential file is removed');
    assert.equal(await exists(join(store, 'repo-ten.git')), false);
    assert.deepEqual(await stagingEntries(store), []);
  });
});

test('acquire refuses a credential for a non-http source', async () => {
  await withStore('cap-repo-store-localauth-', async ({ root, service }) => {
    const source = await makeSourceRepo(root, 'source');
    const result = await service.acquire({
      repoId: 'repo-eleven',
      source,
      authHeader: 'Authorization:Basic-canary',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'source_invalid');
  });
});

test('the stored mirror carries no credential material in its config', async () => {
  await withStore('cap-repo-store-config-', async ({ root, service }) => {
    const source = await makeSourceRepo(root, 'source');
    const acquired = await service.acquire({ repoId: 'repo-twelve', source });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    const config = await readFile(join(acquired.path, 'config'), 'utf8');
    assert.equal(config.toLowerCase().includes('extraheader'), false);
    assert.equal(config.toLowerCase().includes('include'), false);
  });
});

test('invalid repo ids are rejected before any filesystem work', async () => {
  await withStore('cap-repo-store-badid-', async ({ root, service }) => {
    const source = await makeSourceRepo(root, 'source');
    for (const repoId of ['../escape', '.staging', 'a/b', '']) {
      const result = await service.acquire({ repoId, source });
      assert.equal(result.ok, false, `${repoId} must be rejected`);
      if (result.ok) continue;
      assert.equal(result.reason, 'source_invalid');
    }
  });
});

test('progress percentages are parsed out of streamed git output', async () => {
  const events: RepoStoreProgressEvent[] = [];
  const script =
    'printf "Receiving objects:  10%% (1/10)\\rReceiving objects:  60%% (6/10)\\r" >&2; ' +
    'printf "Resolving deltas: 100%% (3/3), done.\\n" >&2';
  const result = await runRepoStoreGitCommand(
    {
      args: ['clone'],
      signal: AbortSignal.timeout(10_000),
      stage: 'transferring',
      onProgress: (event) => events.push(event),
    },
    (_args, env) =>
      spawn('sh', ['-c', script], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      }),
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    events.map((event) => event.percent),
    [10, 60, 100],
  );
  assert.ok(events.every((event) => event.stage === 'transferring'));
});

test('the git environment inherits no credential-bearing variables', () => {
  const env = buildRepoStoreGitEnvironment(undefined, {
    PATH: '/usr/bin',
    HOME: '/home/operator',
    GITHUB_TOKEN: 'canary',
    GIT_ASKPASS: '/tmp/askpass',
    https_proxy: 'http://user:secret@proxy.invalid',
  } as NodeJS.ProcessEnv);

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GIT_ASKPASS, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(env.GIT_CONFIG_GLOBAL === '/dev/null' || env.GIT_CONFIG_GLOBAL === 'NUL');
});
