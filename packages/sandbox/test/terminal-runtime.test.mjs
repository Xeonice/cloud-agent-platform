import assert from 'node:assert/strict';

// Provider-neutral runtime adapter coverage.

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
  const exec = mod.toSandboxTerminalRuntimeExec(async (command) => {
    calls.push(command);
    return command === 'timeout'
      ? { exitCode: Number.NaN, output: 'timed out' }
      : { exitCode: 7, output: 'done' };
  });

  assert.deepEqual(await exec.exec('echo ok'), { stdout: 'done', code: 7 });
  assert.deepEqual(await exec.exec('timeout'), { stdout: 'timed out', code: null });
  assert.deepEqual(calls, ['echo ok', 'timeout']);
});

await test('creates stable per-task terminal session ids', async () => {
  const first = mod.terminalSessionIdForTask('task-a');
  const second = mod.terminalSessionIdForTask('task-a');
  const other = mod.terminalSessionIdForTask('task-b');

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

await test('native Codex policy retains YOLO and rejects stale terminal or approval flags', async () => {
  assert.equal(
    mod.assertNativeCodexInteractiveLaunchArgv(
      mod.DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
    ),
    mod.DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
  );
  assert.match(
    mod.DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
    /--dangerously-bypass-approvals-and-sandbox/,
  );
  assert.doesNotMatch(
    mod.DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV,
    /--no-alt-screen/,
  );

  for (const argv of [
    'codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox',
    'codex --full-auto',
    'codex --ask-for-approval never --sandbox danger-full-access',
  ]) {
    assert.throws(() => mod.assertNativeCodexInteractiveLaunchArgv(argv));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
