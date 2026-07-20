/**
 * Unit coverage for the sanitized git environments (isolate-fixture-git-env).
 * Plain-node, no I/O: proves GIT_* removal, non-git preservation, input
 * non-mutation, and the fixture-mode config keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanGitEnv, fixtureGitEnv } from './git-env.mjs';

const POISONED = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/Users/someone',
  GIT_DIR: '/real/repo/.git',
  GIT_INDEX_FILE: '/real/repo/.git/index.lock-swap',
  GIT_WORK_TREE: '/real/repo',
  GIT_PREFIX: 'packages/',
  GIT_OBJECT_DIRECTORY: '/real/repo/.git/objects',
  GIT_COMMON_DIR: '/real/repo/.git',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/objects',
  GIT_INTERNAL_SUPER_PREFIX: 'sub/',
  CAP_PUBLIC_SURFACE_BASE_SHA: 'base-sha',
});

test('cleanGitEnv drops every GIT_* key and preserves everything else', () => {
  const env = cleanGitEnv(POISONED);
  for (const key of Object.keys(env)) {
    assert.equal(/^GIT_/u.test(key), false, `leaked ${key}`);
  }
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/Users/someone');
  assert.equal(env.CAP_PUBLIC_SURFACE_BASE_SHA, 'base-sha');
  assert.equal(Object.keys(env).length, 3);
});

test('cleanGitEnv never mutates the input environment', () => {
  const base = { ...POISONED };
  cleanGitEnv(base);
  assert.deepEqual(base, POISONED);
});

test('fixtureGitEnv adds only the self-containment config on top of the clean env', () => {
  const env = fixtureGitEnv(POISONED);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_INDEX_FILE, undefined);
  assert.equal(env.PATH, '/usr/bin:/bin');
  const gitKeys = Object.keys(env).filter((key) => /^GIT_/u.test(key));
  assert.deepEqual(gitKeys.sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);
});

test('defaults read process.env without inheriting its GIT_* keys', () => {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = '/tmp/poison/.git';
  try {
    assert.equal(cleanGitEnv().GIT_DIR, undefined);
    assert.equal(fixtureGitEnv().GIT_DIR, undefined);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});
