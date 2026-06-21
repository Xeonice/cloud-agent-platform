/**
 * add-multi-forge-task-delivery — ForgeRegistry detection ladder.
 *
 * explicit Repo.forge → public-host inference → ForgeConnection (self-hosted) →
 * null/skip. Verifies the per-kind apiBase + repoId (gitlab project id preferred),
 * and that an unresolved / non-url source returns null (push-back is skipped).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DefaultForgeRegistry } from './forge-registry';
import { GithubForge } from './github-forge';
import { GiteeForge } from './gitee-forge';
import { GitlabForge } from './gitlab-forge';
import type { PrismaService } from '../prisma/prisma.service';

function makeRegistry(connection: unknown = null) {
  const prisma = {
    forgeConnection: { findUnique: async () => connection },
  } as unknown as PrismaService;
  return new DefaultForgeRegistry(
    prisma,
    new GithubForge(),
    new GiteeForge(),
    new GitlabForge(),
  );
}

test('public github inference', async () => {
  const loc = await makeRegistry().detect({ gitSource: 'https://github.com/o/r.git' });
  assert.deepEqual(loc, {
    kind: 'github',
    apiBaseUrl: 'https://api.github.com',
    cloneUrl: 'https://github.com/o/r.git',
    repoId: { style: 'owner-repo', owner: 'o', repo: 'r' },
  });
});

test('public gitlab inference prefers the cached numeric project id', async () => {
  const loc = await makeRegistry().detect({
    gitSource: 'https://gitlab.com/g/sub/p.git',
    gitlabProjectId: '42',
  });
  assert.equal(loc?.kind, 'gitlab');
  assert.equal(loc?.apiBaseUrl, 'https://gitlab.com/api/v4');
  assert.deepEqual(loc?.repoId, { style: 'project', idOrPath: '42' });
});

test('gitlab without a cached id falls back to the namespace path', async () => {
  const loc = await makeRegistry().detect({ gitSource: 'https://gitlab.com/g/sub/p.git' });
  assert.deepEqual(loc?.repoId, { style: 'project', idOrPath: 'g/sub/p' });
});

test('self-hosted host resolves via a ForgeConnection', async () => {
  const reg = makeRegistry({
    host: 'git.corp.com',
    kind: 'gitlab',
    apiBaseUrl: 'https://git.corp.com/api/v4',
  });
  const loc = await reg.detect({ gitSource: 'https://git.corp.com/g/p.git' });
  assert.equal(loc?.kind, 'gitlab');
  assert.equal(loc?.apiBaseUrl, 'https://git.corp.com/api/v4');
  assert.deepEqual(loc?.repoId, { style: 'project', idOrPath: 'g/p' });
});

test('explicit Repo.forge overrides host inference', async () => {
  const reg = makeRegistry({
    host: 'code.internal',
    kind: 'gitee',
    apiBaseUrl: 'https://code.internal/api/v5',
  });
  const loc = await reg.detect({ gitSource: 'https://code.internal/o/r.git', forge: 'gitee' });
  assert.equal(loc?.kind, 'gitee');
  assert.deepEqual(loc?.repoId, { style: 'owner-repo', owner: 'o', repo: 'r' });
});

test('unresolved (unknown host, no connection) → null', async () => {
  const loc = await makeRegistry(null).detect({ gitSource: 'https://unknown.example/x/y.git' });
  assert.equal(loc, null);
});

test('non-url git source → null (out of scope)', async () => {
  const loc = await makeRegistry().detect({ gitSource: 'git@github.com:o/r.git' });
  assert.equal(loc, null);
});

test('forKind returns the matching impl', () => {
  const reg = makeRegistry();
  assert.equal(reg.forKind('github').kind, 'github');
  assert.equal(reg.forKind('gitee').kind, 'gitee');
  assert.equal(reg.forKind('gitlab').kind, 'gitlab');
});
