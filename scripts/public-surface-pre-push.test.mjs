import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pushedRemoteShas,
  resolvePushBase,
  runPrePush,
} from './public-surface-pre-push.mjs';

test('existing remote ref uses the complete remote SHA as the base', () => {
  const base = 'a'.repeat(40);
  assert.equal(
    pushedRemoteShas(`refs/heads/topic ${'b'.repeat(40)} refs/heads/topic ${base}\n`),
    base,
  );
});

test('new branch resolves a merge-base with the remote default branch', () => {
  const calls = [];
  const base = resolvePushBase({
    input: `refs/heads/topic ${'b'.repeat(40)} refs/heads/topic ${'0'.repeat(40)}\n`,
    remoteName: 'origin',
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'origin/main\n' };
      }
      return { status: 0, stdout: `${'c'.repeat(40)}\n` };
    },
  });
  assert.equal(base, 'c'.repeat(40));
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('pre-push invokes the stable full root command once with the resolved base', () => {
  const calls = [];
  const base = 'd'.repeat(40);
  runPrePush({
    input: `refs/heads/topic ${'e'.repeat(40)} refs/heads/topic ${base}\n`,
    remoteName: 'origin',
    env: { FIXTURE: '1' },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pnpm');
  assert.deepEqual(calls[0].args, ['verify:public-surface']);
  assert.equal(calls[0].options.env.CAP_PUBLIC_SURFACE_BASE_SHA, base);
  assert.equal(calls[0].options.shell, false);
});

test('ambiguous or unresolved bases fail closed', () => {
  assert.throws(
    () =>
      pushedRemoteShas(
        `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${'2'.repeat(40)}\n` +
          `refs/heads/b ${'3'.repeat(40)} refs/heads/b ${'4'.repeat(40)}\n`,
      ),
    /Multiple remote bases/u,
  );
  assert.throws(
    () =>
      resolvePushBase({
        input: `refs/heads/topic ${'1'.repeat(40)} refs/heads/topic ${'0'.repeat(40)}\n`,
        remoteName: 'origin',
        spawnSyncImpl() {
          return { status: 1, stderr: 'missing' };
        },
      }),
    /Unable to resolve origin's default branch/u,
  );
});
