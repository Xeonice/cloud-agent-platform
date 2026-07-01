import assert from 'node:assert/strict';

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
