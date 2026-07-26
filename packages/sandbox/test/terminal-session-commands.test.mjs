import assert from 'node:assert/strict';

// Provider-neutral detached-session command coverage.

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

await test('builds headless detached session and exit sentinel paths', async () => {
  assert.equal(
    mod.headlessExitFile('task-headless'),
    '/home/gem/.cap-headless-task-headless.exit',
  );
  assert.equal(
    mod.wrapHeadlessDetachedSession('task-headless', 'node run.js', '/work'),
    "tmux -u new-session -d -s tasktask-headless -c /work 'node run.js; echo $? > /home/gem/.cap-headless-task-headless.exit'",
  );
});

await test('builds an exact attach-only viewer command on the default tmux socket', async () => {
  assert.equal(mod.exactDetachedSessionTarget('viewer-1'), '=taskviewer-1');
  assert.equal(
    mod.buildExactHasSessionCommand('viewer-1'),
    'tmux -u has-session -t =taskviewer-1',
  );
  assert.equal(
    mod.buildAttachSessionCommand('viewer-1'),
    'tmux -u set-window-option -t =taskviewer-1: window-size manual \\; set-option -t =taskviewer-1: status off \\; attach-session -f ignore-size -t =taskviewer-1',
  );
  assert.equal(
    mod.buildViewerAttachSessionCommand('viewer-1'),
    'tmux -u set-window-option -t =taskviewer-1: window-size manual \\; set-option -t =taskviewer-1: status off \\; attach-session -f ignore-size -t =taskviewer-1',
  );
  assert.equal(
    mod.buildResizeDetachedSessionCommand('viewer-1', 123, 45),
    'tmux -u resize-window -t =taskviewer-1: -x 123 -y 45',
  );
  assert.match(
    mod.buildResizeDetachedSessionCommand('viewer', 90, 30),
    /-t =taskviewer:/u,
  );
  assert.match(
    mod.buildResizeDetachedSessionCommand('viewer-longer', 90, 30),
    /-t =taskviewer-longer:/u,
  );
  assert.doesNotMatch(mod.buildViewerAttachSessionCommand('viewer-1'), /(?:^|\s)-L(?:\s|$)/u);
  assert.doesNotMatch(mod.buildViewerAttachSessionCommand('viewer-1'), /new-session/u);
  assert.throws(
    () => mod.buildViewerAttachSessionCommand('viewer 1; touch leaked'),
    /safe tmux session target/u,
  );
  assert.throws(
    () => mod.buildResizeDetachedSessionCommand('viewer 1; touch leaked', 80, 24),
    /safe tmux session target/u,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
