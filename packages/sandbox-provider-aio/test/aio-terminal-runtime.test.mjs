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

await test('adapts legacy exec results for terminal runtimes', async () => {
  const calls = [];
  const exec = mod.toAioTerminalRuntimeExec(async (command) => {
    calls.push(command);
    return command === 'timeout'
      ? { exitCode: Number.NaN, output: 'timed out' }
      : { exitCode: 7, output: 'done' };
  });

  assert.deepEqual(await exec.exec('echo ok'), { stdout: 'done', code: 7 });
  assert.deepEqual(await exec.exec('timeout'), { stdout: 'timed out', code: null });
  assert.deepEqual(calls, ['echo ok', 'timeout']);
});

await test('creates stable per-task AIO session ids', async () => {
  const first = mod.aioSessionIdForTask('task-a');
  const second = mod.aioSessionIdForTask('task-a');
  const other = mod.aioSessionIdForTask('task-b');

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
