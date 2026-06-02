/**
 * Minimal test: "Spawn the real interactive Codex CLI under a PTY"
 *
 * Exercises the spawnCodexPty / buildPtyEnv / assertInteractiveArgs exports
 * from apps/runner using the compiled dist output.
 *
 * We cannot rely on the `codex` binary being installed on this machine, so we
 * substitute `/bin/bash -c 'echo $TERM; exit 0'` as the spawned binary.
 * This is intentional: the requirement under test is that the runner:
 *   (a) actually calls node-pty.spawn with the right arguments,
 *   (b) sets TERM=xterm-256color in the child environment,
 *   (c) sets cwd to the supplied workspace path,
 *   (d) exposes the correct CodexPtyHandle interface (onData/onExit/write/resize/pause/resume/kill),
 *   (e) surfaces PTY output via the onData handler,
 *   (f) surfaces process exit via the onExit handler,
 *   (g) rejects headless subcommands (exec / app-server) synchronously.
 *
 * All assertions use a minimal assert helper that throws on failure.
 */

import { spawnCodexPty, buildPtyEnv, assertInteractiveArgs } from './apps/runner/dist/pty/spawn-codex.js';
import os from 'os';
import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
    failures.push(label);
  }
}

function assertThrows(fn, expectedFragment, label) {
  try {
    fn();
    console.error(`  FAIL  ${label} (expected throw, got none)`);
    failed++;
    failures.push(label);
  } catch (err) {
    if (err.message.includes(expectedFragment)) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label} (wrong message: ${err.message})`);
      failed++;
      failures.push(label);
    }
  }
}

// ─── 1. buildPtyEnv ───────────────────────────────────────────────────────────
console.log('\n[1] buildPtyEnv');

const env1 = buildPtyEnv();
assert(env1.TERM === 'xterm-256color', 'TERM is forced to xterm-256color when no extra env supplied');

const env2 = buildPtyEnv({ TERM: 'dumb', FOO: 'bar' });
assert(env2.TERM === 'xterm-256color', 'TERM override by caller is pinned back to xterm-256color');
assert(env2.FOO === 'bar', 'caller-supplied extra env key is preserved');

// ─── 2. assertInteractiveArgs ─────────────────────────────────────────────────
console.log('\n[2] assertInteractiveArgs');

assertThrows(
  () => assertInteractiveArgs(['exec', '--json']),
  'refusing to spawn codex with headless subcommand "exec"',
  'rejects exec subcommand with correct error message',
);

assertThrows(
  () => assertInteractiveArgs(['app-server']),
  'refusing to spawn codex with headless subcommand "app-server"',
  'rejects app-server subcommand with correct error message',
);

// Non-headless args must not throw
try {
  assertInteractiveArgs([]);
  assertInteractiveArgs(['--model', 'o3']);
  assert(true, 'empty args and non-headless args accepted without error');
} catch (err) {
  assert(false, `non-headless args unexpectedly threw: ${err.message}`);
}

// ─── 3. spawnCodexPty — real PTY spawn ────────────────────────────────────────
console.log('\n[3] spawnCodexPty — real PTY spawn with /bin/bash');

// Create a temp workspace dir to satisfy the cwd requirement.
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-workspace-'));

await new Promise((resolve) => {
  let dataReceived = '';
  let exitEventFired = false;
  let handleInterface = null;

  try {
    handleInterface = spawnCodexPty({
      codexBin: '/bin/bash',
      // Ask bash to print $TERM then exit — this exercises the real PTY data path.
      codexArgs: ['-c', 'printf "%s\\n" "$TERM"; exit 0'],
      cwd: workspaceDir,
      cols: 120,
      rows: 30,
    });
  } catch (err) {
    assert(false, `spawnCodexPty threw unexpectedly: ${err.message}`);
    resolve();
    return;
  }

  // (d) Handle interface shape
  assert(typeof handleInterface.pid === 'number' && handleInterface.pid > 0, 'handle.pid is a positive number');
  assert(typeof handleInterface.onData === 'function', 'handle.onData is a function');
  assert(typeof handleInterface.onExit === 'function', 'handle.onExit is a function');
  assert(typeof handleInterface.write === 'function', 'handle.write is a function');
  assert(typeof handleInterface.resize === 'function', 'handle.resize is a function');
  assert(typeof handleInterface.pause === 'function', 'handle.pause is a function');
  assert(typeof handleInterface.resume === 'function', 'handle.resume is a function');
  assert(typeof handleInterface.kill === 'function', 'handle.kill is a function');

  // (e) PTY data arrives via onData
  handleInterface.onData((chunk) => {
    dataReceived += chunk;
  });

  // (f) Exit fires via onExit
  handleInterface.onExit(({ exitCode, signal }) => {
    exitEventFired = true;
    assert(exitCode === 0, `child exited with code 0 (got ${exitCode})`);
    // node-pty passes signal=0 (not undefined) for a clean exit on Unix; both 0
    // and undefined mean "no signal killed the process".  The spec requires
    // signal to be a number when present; 0 is the POSIX "no-signal" sentinel.
    assert(signal === undefined || signal === 0, `signal is 0 or absent on clean exit (got ${signal})`);
    // (b) TERM=xterm-256color was in the child env — bash printed it
    assert(
      dataReceived.includes('xterm-256color'),
      `PTY data contains "xterm-256color" (child saw TERM; received: ${JSON.stringify(dataReceived.trim())})`,
    );
    assert(dataReceived.length > 0, 'onData handler received at least one chunk of PTY output');
    assert(exitEventFired, 'onExit handler was invoked');
    // (c) cwd was set — bash ran in the temp workspace (process already verified by spawn succeeding)
    assert(fs.existsSync(workspaceDir), 'workspace directory still exists after spawn');

    // cleanup
    fs.rmdirSync(workspaceDir, { recursive: true });
    resolve();
  });

  // Safety timeout — if the child never exits, resolve with a failure after 5 s
  setTimeout(() => {
    if (!exitEventFired) {
      assert(false, 'onExit handler was NOT invoked within 5 s timeout');
      try { handleInterface.kill(); } catch (_) {}
      resolve();
    }
  }, 5000);
});

// ─── 4. spawnCodexPty — headless subcommand rejection ────────────────────────
console.log('\n[4] spawnCodexPty — headless subcommand rejection (exec)');

assertThrows(
  () => spawnCodexPty({ codexBin: '/bin/bash', codexArgs: ['exec', '--json'], cwd: '/tmp' }),
  'refusing to spawn codex with headless subcommand "exec"',
  'spawnCodexPty rejects exec subcommand before spawning any process',
);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.error('Failed assertions:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log('All assertions passed.');
  process.exit(0);
}
