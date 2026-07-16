import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RemoteRefsCommandRunnerError,
  runRemoteRefsGitCommand,
  type RemoteRefsSpawn,
} from './remote-refs-command-runner';

test('abort requests SIGKILL but command promise settles only after child close', async () => {
  const events: string[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill(signal: NodeJS.Signals): boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    events.push(`kill:${signal}`);
    return true;
  };
  const spawnGit: RemoteRefsSpawn = (() => child) as unknown as RemoteRefsSpawn;
  const controller = new AbortController();
  const pending = runRemoteRefsGitCommand(
    { args: ['--version'], signal: controller.signal },
    spawnGit,
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
