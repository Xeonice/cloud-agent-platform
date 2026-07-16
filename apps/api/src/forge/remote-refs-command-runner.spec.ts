import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REMOTE_REFS_OUTPUT_BYTES,
  RemoteRefsCommandRunnerError,
  runRemoteRefsGitCommand,
  type RemoteRefsSpawn,
} from './remote-refs-command-runner';

const SECRET_CANARY = 'cap-runner-secret-canary-c99a45';

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(signal: NodeJS.Signals): boolean;
};

function fakeChild(events: string[] = []): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    events.push(`kill:${signal}`);
    return true;
  };
  return child;
}

function asSpawn(child: FakeChild): RemoteRefsSpawn {
  return (() => child) as unknown as RemoteRefsSpawn;
}

test('abort requests SIGKILL but command promise settles only after child close', async () => {
  const events: string[] = [];
  const child = fakeChild(events);
  const controller = new AbortController();
  const pending = runRemoteRefsGitCommand(
    { args: ['--version'], signal: controller.signal },
    asSpawn(child),
  );
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  controller.abort();
  await Promise.resolve();
  assert.deepEqual(events, ['kill:SIGKILL']);
  assert.equal(settled, false, 'credential cleanup must still be blocked before close');

  events.push('close');
  child.emit('close', null);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof RemoteRefsCommandRunnerError && error.reason === 'aborted',
  );
  assert.equal(settled, true);
  assert.deepEqual(events, ['kill:SIGKILL', 'close']);
});

test('a synchronous missing-executable failure preserves spawn identity without its raw cause', async () => {
  const missing = Object.assign(
    new Error(`spawn git ENOENT ${SECRET_CANARY}`),
    { code: 'ENOENT' },
  );
  const spawnGit = (() => {
    throw missing;
  }) as unknown as RemoteRefsSpawn;

  await assert.rejects(
    runRemoteRefsGitCommand(
      { args: ['--version'], signal: new AbortController().signal },
      spawnGit,
    ),
    (error: unknown) => {
      assert.ok(error instanceof RemoteRefsCommandRunnerError);
      assert.equal(error.reason, 'spawn_failed');
      assert.equal(error.message.includes(SECRET_CANARY), false);
      assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
      return true;
    },
  );
});

test('an asynchronous ENOENT waits for close and stays a sanitized spawn failure', async () => {
  const events: string[] = [];
  const child = fakeChild(events);
  const pending = runRemoteRefsGitCommand(
    { args: ['--version'], signal: new AbortController().signal },
    asSpawn(child),
  );
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });

  child.emit(
    'error',
    Object.assign(new Error(`ENOENT ${SECRET_CANARY}`), { code: 'ENOENT' }),
  );
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(events, [], 'a process that never spawned is not killed');

  child.emit('close', -2);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RemoteRefsCommandRunnerError);
    assert.equal(error.reason, 'spawn_failed');
    assert.equal(JSON.stringify(error).includes(SECRET_CANARY), false);
    return true;
  });
});

test('captured output is bounded and output-limit errors expose no captured bytes', async () => {
  const events: string[] = [];
  const child = fakeChild(events);
  const pending = runRemoteRefsGitCommand(
    { args: ['--version'], signal: new AbortController().signal },
    asSpawn(child),
  );

  child.stdout.emit(
    'data',
    Buffer.alloc(MAX_REMOTE_REFS_OUTPUT_BYTES + 1, SECRET_CANARY),
  );
  assert.deepEqual(events, ['kill:SIGKILL']);
  child.emit('close', null);

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RemoteRefsCommandRunnerError);
    assert.equal(error.reason, 'output_limit');
    assert.equal(error.message.includes(SECRET_CANARY), false);
    return true;
  });
});

test('an exited Git process returns its non-zero status and diagnostics for probe classification', async () => {
  const child = fakeChild();
  const pending = runRemoteRefsGitCommand(
    {
      args: ['ls-remote', 'https://example.test/repo.git', 'HEAD'],
      signal: new AbortController().signal,
    },
    asSpawn(child),
  );
  child.stdout.emit('data', 'partial stdout');
  child.stderr.emit('data', `fatal: authentication failed ${SECRET_CANARY}`);
  child.emit('close', 128);

  assert.deepEqual(await pending, {
    exitCode: 128,
    stdout: 'partial stdout',
    stderr: `fatal: authentication failed ${SECRET_CANARY}`,
  });
});
