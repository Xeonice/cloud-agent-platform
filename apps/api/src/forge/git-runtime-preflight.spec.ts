import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertGitRuntimeAvailable,
  GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE,
  GIT_RUNTIME_PREFLIGHT_MAX_TIMEOUT_MS,
  GitRuntimePreflightError,
} from './git-runtime-preflight';
import {
  RemoteRefsCommandRunnerError,
  type RemoteRefsCommandRunner,
} from './remote-refs-command-runner';

const SECRET_CANARY = 'cap-preflight-secret-canary-57d1bc';

function runner(
  run: RemoteRefsCommandRunner['run'],
): Pick<RemoteRefsCommandRunner, 'run'> {
  return { run };
}

function assertSanitizedDependencyFailure(error: unknown): boolean {
  assert.ok(error instanceof GitRuntimePreflightError);
  assert.equal(error.reason, 'platform_dependency_unavailable');
  assert.equal(error.dependency, 'git');
  assert.equal(error.message.includes(SECRET_CANARY), false);
  assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
  return true;
}

test('preflight executes only fixed git version argv under a bounded signal', async () => {
  let calls = 0;
  await assertGitRuntimeAvailable({
    runner: runner(async (request) => {
      calls += 1;
      assert.deepEqual(request.args, ['--version']);
      assert.equal(request.signal.aborted, false);
      return { exitCode: 0, stdout: 'git version 2.39.5\n', stderr: '' };
    }),
  });
  assert.equal(calls, 1);
});

test('missing executable is normalized without retaining ENOENT or secret diagnostics', async () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  try {
    await assert.rejects(
      assertGitRuntimeAvailable({
        runner: runner(async () => {
          throw Object.assign(
            new RemoteRefsCommandRunnerError('spawn_failed'),
            { raw: `ENOENT /secret/${SECRET_CANARY}/git` },
          );
        }),
      }),
      assertSanitizedDependencyFailure,
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logs, []);
  assert.equal(GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE.includes(SECRET_CANARY), false);
  assert.equal(GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE.includes('ENOENT'), false);
  assert.equal(GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE.includes('--version'), false);
});

test('non-zero, malformed, and output-limit outcomes collapse to one safe failure', async () => {
  const failures: Array<Pick<RemoteRefsCommandRunner, 'run'>> = [
    runner(async () => ({
      exitCode: 127,
      stdout: SECRET_CANARY,
      stderr: `raw failure ${SECRET_CANARY}`,
    })),
    runner(async () => ({
      exitCode: 0,
      stdout: `not-git ${SECRET_CANARY}`,
      stderr: '',
    })),
    runner(async () => {
      throw new RemoteRefsCommandRunnerError('output_limit');
    }),
  ];

  for (const candidate of failures) {
    await assert.rejects(
      assertGitRuntimeAvailable({ runner: candidate }),
      assertSanitizedDependencyFailure,
    );
  }
});

test('preflight timeout aborts its runner and exposes no AbortSignal reason', async () => {
  await assert.rejects(
    assertGitRuntimeAvailable({
      timeoutMs: 1,
      runner: runner(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => {
                reject(
                  Object.assign(new RemoteRefsCommandRunnerError('aborted'), {
                    raw: `timeout ${SECRET_CANARY}`,
                  }),
                );
              },
              { once: true },
            );
          }),
      ),
    }),
    assertSanitizedDependencyFailure,
  );
});

test('invalid timeout overrides cannot make startup preflight unbounded', async () => {
  for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, 1.5, GIT_RUNTIME_PREFLIGHT_MAX_TIMEOUT_MS + 1]) {
    await assert.rejects(
      assertGitRuntimeAvailable({
        timeoutMs,
        runner: runner(async () => ({
          exitCode: 0,
          stdout: 'git version 2.39.5',
          stderr: '',
        })),
      }),
      assertSanitizedDependencyFailure,
    );
  }
});

test('bootstrap runs the Git preflight before creating or listening on the Nest app', () => {
  const mainSource = readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'main.ts'),
    'utf8',
  );
  const preflight = mainSource.indexOf('await assertGitRuntimeAvailable()');
  const create = mainSource.indexOf('NestFactory.create(');
  const listen = mainSource.indexOf('await app.listen(');

  assert.ok(preflight >= 0, 'bootstrap must invoke the reusable Git preflight');
  assert.ok(create > preflight, 'preflight must precede Nest application creation');
  assert.ok(listen > create, 'listen remains after application creation');
  assert.match(
    mainSource,
    /catch \{[\s\S]*console\.error\(GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE\);[\s\S]*process\.exitCode = 1;[\s\S]*return;/u,
  );
});
