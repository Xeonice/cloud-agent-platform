import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// --- host-shell harness: `setsid` shim so wrapper semantics run on any POSIX host

const harness = mkdtempSync(join(tmpdir(), 'cap-detached-jobs-'));
const shimDir = join(harness, 'bin');
mkdirSync(shimDir, { recursive: true });
writeFileSync(join(shimDir, 'setsid'), '#!/bin/sh\nexec "$@"\n');
chmodSync(join(shimDir, 'setsid'), 0o755);
const markerRoot = join(harness, 'cap-jobs');

function runShell(command) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForFile(path, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

// --- marker layout (task 2.1)

await test('marker layout: per-job dir under /tmp/cap-jobs with pid/progress/exit', () => {
  assert.equal(mod.SANDBOX_DETACHED_JOBS_ROOT, '/tmp/cap-jobs');
  assert.deepEqual(mod.SANDBOX_DETACHED_JOB_MARKER_FILES, ['pid', 'progress', 'exit']);
  const paths = mod.sandboxDetachedJobMarkerPaths('clone-task_1.a');
  assert.deepEqual(paths, {
    dir: '/tmp/cap-jobs/clone-task_1.a',
    pid: '/tmp/cap-jobs/clone-task_1.a/pid',
    progress: '/tmp/cap-jobs/clone-task_1.a/progress',
    exit: '/tmp/cap-jobs/clone-task_1.a/exit',
  });
  for (const bad of ['', '.hidden', 'a/b', 'a b', '../x', "a'b", 'a'.repeat(129)]) {
    assert.throws(
      () => mod.sandboxDetachedJobMarkerPaths(bad),
      (error) => error?.code === 'sandbox_provider_configuration_error',
    );
  }
});

await test('launch command uses setsid (never nohup), detaches, and orders pid -> child -> publish -> exit', () => {
  const command = mod.buildSandboxDetachedJobLaunchCommand({
    jobId: 'job1',
    command: 'git clone repo /staging/tree',
    publish: { stagingPath: '/staging/tree', finalPath: '/workspace/tree' },
  });
  assert.ok(command.includes('( setsid sh -c '));
  assert.ok(!command.includes('nohup'));
  // wrapper is double-forked into the background and detached from stdio
  assert.ok(command.includes(`</dev/null >/dev/null 2>&1 & )`));
  // pid marker is awaited before the launch exec returns
  assert.ok(/while \[ ! -s '[^']*\/pid' \]/.test(command));
  assert.ok(command.trimEnd().endsWith(`[ -s '/tmp/cap-jobs/job1/pid' ]`));
  // ordering inside the wrapper: pid write, then child, then publish, then exit
  const pidWrite = command.indexOf('/tmp/cap-jobs/job1/pid.tmp');
  const child = command.indexOf('git clone repo /staging/tree');
  const publish = command.indexOf('/workspace/tree');
  const exitWrite = command.indexOf('/tmp/cap-jobs/job1/exit.tmp');
  assert.ok(pidWrite >= 0 && child > pidWrite && publish > child && exitWrite > publish);
  // publish only happens on child success and its failure flips the exit code
  assert.ok(command.includes('-eq 0 ]; then mv '));
  assert.ok(command.includes('|| cap_job_exit=1'));
  // child output stream is the progress marker
  assert.ok(/<\/dev\/null >> [^\n]*\/tmp\/cap-jobs\/job1\/progress[^\n]* 2>&1/.test(command));

  assert.throws(
    () => mod.buildSandboxDetachedJobLaunchCommand({ jobId: 'job1', command: '  ' }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );
  assert.throws(
    () =>
      mod.buildSandboxDetachedJobLaunchCommand({
        jobId: 'job1',
        command: 'true',
        publish: { stagingPath: '/same', finalPath: '/same' },
      }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );
  assert.throws(
    () =>
      mod.buildSandboxDetachedJobLaunchCommand({
        jobId: 'job1',
        command: 'true',
        cwd: 'relative/path',
      }),
    (error) => error?.code === 'sandbox_provider_configuration_error',
  );
});

// --- functional: launch survives launcher teardown, markers behave (tasks 2.1, 2.2)

await test('functional: launch returns with pid marker readable; wrapper waits and writes exit 0 exactly once', async () => {
  const paths = mod.sandboxDetachedJobMarkerPaths('ok-job', markerRoot);
  const launch = await runShell(
    mod.buildSandboxDetachedJobLaunchCommand({
      jobId: 'ok-job',
      command: `printf '%s' "single'quote-ok"`,
      markerRoot,
    }),
  );
  assert.equal(launch.code, 0, launch.stderr);
  // pid marker already readable when the launch exec has returned
  const pid = readFileSync(paths.pid, 'utf8');
  assert.ok(/^\d+$/.test(pid));
  await waitForFile(paths.exit);
  assert.equal(readFileSync(paths.exit, 'utf8'), '0');
  assert.equal(readFileSync(paths.progress, 'utf8'), "single'quote-ok");
});

await test('functional: nonzero child exit code is captured in the exit marker', async () => {
  const paths = mod.sandboxDetachedJobMarkerPaths('fail-job', markerRoot);
  const launch = await runShell(
    mod.buildSandboxDetachedJobLaunchCommand({
      jobId: 'fail-job',
      command: 'echo boom; exit 7',
      markerRoot,
    }),
  );
  assert.equal(launch.code, 0, launch.stderr);
  await waitForFile(paths.exit);
  assert.equal(readFileSync(paths.exit, 'utf8'), '7');
});

await test('functional: atomic publish flips staging to final before the success exit marker', async () => {
  const staging = join(harness, 'staging-ok');
  const final = join(harness, 'final-ok');
  const paths = mod.sandboxDetachedJobMarkerPaths('publish-ok', markerRoot);
  const launch = await runShell(
    mod.buildSandboxDetachedJobLaunchCommand({
      jobId: 'publish-ok',
      command: `mkdir -p ${staging} && echo content > ${staging}/file`,
      publish: { stagingPath: staging, finalPath: final },
      markerRoot,
    }),
  );
  assert.equal(launch.code, 0, launch.stderr);
  await waitForFile(paths.exit);
  assert.equal(readFileSync(paths.exit, 'utf8'), '0');
  assert.equal(readFileSync(join(final, 'file'), 'utf8'), 'content\n');
  assert.ok(!existsSync(staging));
});

await test('functional: failed job never publishes to the final path', async () => {
  const staging = join(harness, 'staging-fail');
  const final = join(harness, 'final-fail');
  const paths = mod.sandboxDetachedJobMarkerPaths('publish-fail', markerRoot);
  await runShell(
    mod.buildSandboxDetachedJobLaunchCommand({
      jobId: 'publish-fail',
      command: `mkdir -p ${staging} && echo partial > ${staging}/file && exit 3`,
      publish: { stagingPath: staging, finalPath: final },
      markerRoot,
    }),
  );
  await waitForFile(paths.exit);
  assert.equal(readFileSync(paths.exit, 'utf8'), '3');
  assert.ok(!existsSync(final));
});

// --- probe triage three-way (task 2.2)

await test('probe output parses into the three-way triage contract, failing closed to unknown', () => {
  assert.deepEqual(mod.triageSandboxDetachedJobProbeOutput('exit 0\nprogress 42 1700000000'), {
    state: 'exited',
    exitCode: 0,
    progress: { sizeBytes: 42, mtimeEpochSeconds: 1700000000 },
  });
  assert.deepEqual(mod.triageSandboxDetachedJobProbeOutput('exit 128'), {
    state: 'exited',
    exitCode: 128,
  });
  assert.deepEqual(mod.triageSandboxDetachedJobProbeOutput('alive 4242\nprogress   7 12'), {
    state: 'alive',
    pid: 4242,
    progress: { sizeBytes: 7, mtimeEpochSeconds: 12 },
  });
  for (const raw of ['unknown', '', '   \n', 'garbage', 'exit abc', 'exit', 'alive', 'alive -5', 'alive x']) {
    assert.deepEqual(mod.triageSandboxDetachedJobProbeOutput(raw), { state: 'unknown' });
  }
  // malformed progress stat is dropped, not fatal
  assert.deepEqual(mod.triageSandboxDetachedJobProbeOutput('exit 0\nprogress x y'), {
    state: 'exited',
    exitCode: 0,
  });
});

await test('settlement: exit marker is the only success proof; unknown fails closed', () => {
  assert.deepEqual(mod.settleSandboxDetachedJobTriage({ state: 'alive', pid: 1 }), {
    kind: 'running',
  });
  assert.deepEqual(mod.settleSandboxDetachedJobTriage({ state: 'exited', exitCode: 0 }), {
    kind: 'exited',
    outcome: 'succeeded',
    exitCode: 0,
  });
  assert.deepEqual(mod.settleSandboxDetachedJobTriage({ state: 'exited', exitCode: 9 }), {
    kind: 'exited',
    outcome: 'failed',
    exitCode: 9,
  });
  assert.deepEqual(mod.settleSandboxDetachedJobTriage({ state: 'unknown' }), {
    kind: 'unprovable',
  });
});

await test('functional: probe command classifies a completed and a running job', async () => {
  const done = await runShell(mod.buildSandboxDetachedJobProbeCommand('ok-job', markerRoot));
  const doneTriage = mod.triageSandboxDetachedJobProbeOutput(done.stdout);
  assert.equal(doneTriage.state, 'exited');
  assert.equal(doneTriage.exitCode, 0);
  assert.ok(doneTriage.progress.sizeBytes > 0);

  await runShell(
    mod.buildSandboxDetachedJobLaunchCommand({
      jobId: 'long-job',
      command: 'sleep 5',
      markerRoot,
    }),
  );
  // the launcher shell has already exited; the detached job must still be alive
  const running = await runShell(mod.buildSandboxDetachedJobProbeCommand('long-job', markerRoot));
  const runningTriage = mod.triageSandboxDetachedJobProbeOutput(running.stdout);
  assert.equal(runningTriage.state, 'alive');
  assert.ok(runningTriage.pid > 0);

  const missing = await runShell(mod.buildSandboxDetachedJobProbeCommand('never-launched', markerRoot));
  assert.deepEqual(mod.triageSandboxDetachedJobProbeOutput(missing.stdout), { state: 'unknown' });
});

// --- kill contract (task 2.4)

await test('kill command checks the exit marker first and always exits 0', () => {
  const command = mod.buildSandboxDetachedJobKillCommand('job1');
  assert.ok(command.startsWith(`if [ ! -f '/tmp/cap-jobs/job1/exit' ]`));
  assert.ok(command.includes(`kill -TERM -- "-$cap_pid"`));
  assert.ok(command.includes(`kill -KILL -- "-$cap_pid"`));
  assert.ok(command.trimEnd().endsWith('exit 0'));
});

await test('functional: kill terminates a running job and repeated kills are idempotent no-ops', async () => {
  const paths = mod.sandboxDetachedJobMarkerPaths('long-job', markerRoot);
  const first = await runShell(mod.buildSandboxDetachedJobKillCommand('long-job', markerRoot));
  assert.equal(first.code, 0, first.stderr);
  // wrapper died before writing an exit marker: the job is now unprovable, never succeeded
  const probe = await runShell(mod.buildSandboxDetachedJobProbeCommand('long-job', markerRoot));
  assert.deepEqual(mod.triageSandboxDetachedJobProbeOutput(probe.stdout), { state: 'unknown' });
  assert.ok(!existsSync(paths.exit));
  const second = await runShell(mod.buildSandboxDetachedJobKillCommand('long-job', markerRoot));
  assert.equal(second.code, 0);
});

await test('functional: killing an already-exited job is a no-op that preserves the exit marker', async () => {
  const paths = mod.sandboxDetachedJobMarkerPaths('ok-job', markerRoot);
  const result = await runShell(mod.buildSandboxDetachedJobKillCommand('ok-job', markerRoot));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(paths.exit, 'utf8'), '0');
});

await test('no resurrection: a terminal settlement is never replaced by a later observation', () => {
  const stopped = Object.freeze({ kind: 'exited', outcome: 'failed', exitCode: 143 });
  const lateSuccess = Object.freeze({ kind: 'exited', outcome: 'succeeded', exitCode: 0 });
  assert.equal(mod.reconcileSandboxDetachedJobSettlement(stopped, lateSuccess), stopped);
  assert.equal(
    mod.reconcileSandboxDetachedJobSettlement({ kind: 'unprovable' }, lateSuccess).kind,
    'unprovable',
  );
  // a running observation can still settle
  assert.equal(
    mod.reconcileSandboxDetachedJobSettlement({ kind: 'running' }, lateSuccess),
    lateSuccess,
  );
  assert.equal(mod.reconcileSandboxDetachedJobSettlement(null, lateSuccess), lateSuccess);
  assert.equal(mod.isTerminalSandboxDetachedJobSettlement({ kind: 'running' }), false);
  assert.equal(mod.isTerminalSandboxDetachedJobSettlement({ kind: 'unprovable' }), true);
});

// --- dual-gate liveness knobs (task 2.6)

await test('liveness policy snapshot validates min/max like snapshotSandboxProvisioningPolicy', () => {
  assert.equal(mod.DEFAULT_SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS, 90_000);
  assert.equal(mod.DEFAULT_SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS, 3_600_000);
  assert.deepEqual(mod.snapshotSandboxDetachedJobLivenessPolicy({}), {});
  assert.deepEqual(
    mod.snapshotSandboxDetachedJobLivenessPolicy({ heartbeatWindowMs: 5_000, absoluteCapMs: 60_000 }),
    { heartbeatWindowMs: 5_000, absoluteCapMs: 60_000 },
  );
  for (const invalid of [
    { heartbeatWindowMs: 999 },
    { heartbeatWindowMs: mod.SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS_MAX + 1 },
    { heartbeatWindowMs: 5_000.5 },
    { absoluteCapMs: 999 },
    { absoluteCapMs: mod.SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS_MAX + 1 },
    { heartbeatWindowMs: 120_000, absoluteCapMs: 60_000 },
  ]) {
    assert.throws(
      () => mod.snapshotSandboxDetachedJobLivenessPolicy(invalid),
      (error) => error?.code === 'sandbox_provider_configuration_error',
    );
  }
  assert.deepEqual(mod.resolveSandboxDetachedJobLivenessPolicy(), {
    heartbeatWindowMs: 90_000,
    absoluteCapMs: 3_600_000,
  });
  assert.deepEqual(mod.resolveSandboxDetachedJobLivenessPolicy({ heartbeatWindowMs: 30_000 }), {
    heartbeatWindowMs: 30_000,
    absoluteCapMs: 3_600_000,
  });
});

// --- clone-progress event variant (task 2.5)

await test('transfer progress snapshot is numeric-only with explicit unknowns', () => {
  const populated = mod.snapshotSandboxWorkspaceTransferProgress({
    percent: 42.5,
    receivedObjects: 100,
    totalObjects: 400,
    receivedBytes: 1024,
    throughputBytesPerSecond: 512,
  });
  assert.equal(populated.percent, 42.5);
  assert.ok(Object.isFrozen(populated));
  const indeterminate = mod.snapshotSandboxWorkspaceTransferProgress({
    percent: null,
    receivedObjects: null,
    totalObjects: null,
    receivedBytes: null,
    throughputBytesPerSecond: null,
  });
  assert.equal(indeterminate.percent, null);
  for (const invalid of [
    { percent: 101, receivedObjects: null, totalObjects: null, receivedBytes: null, throughputBytesPerSecond: null },
    { percent: -1, receivedObjects: null, totalObjects: null, receivedBytes: null, throughputBytesPerSecond: null },
    { percent: Number.NaN, receivedObjects: null, totalObjects: null, receivedBytes: null, throughputBytesPerSecond: null },
    { percent: '50', receivedObjects: null, totalObjects: null, receivedBytes: null, throughputBytesPerSecond: null },
    { percent: null, receivedObjects: null, totalObjects: null, receivedBytes: null, throughputBytesPerSecond: null, extra: 1 },
  ]) {
    assert.throws(
      () => mod.snapshotSandboxWorkspaceTransferProgress(invalid),
      (error) => error?.code === 'sandbox_provider_configuration_error',
    );
  }
});

await test('reportSandboxWorkspaceProgress stays best-effort for the progress variant', async () => {
  const events = [];
  mod.reportSandboxWorkspaceProgress((event) => events.push(event), {
    status: 'progress',
    stage: 'workspace_transfer',
    progress: mod.snapshotSandboxWorkspaceTransferProgress({
      percent: null,
      receivedObjects: null,
      totalObjects: null,
      receivedBytes: 10,
      throughputBytesPerSecond: null,
    }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'progress');
  // a throwing or rejecting reporter never surfaces an error
  mod.reportSandboxWorkspaceProgress(
    () => {
      throw new Error('sync drop');
    },
    { status: 'started', stage: 'workspace_transfer' },
  );
  mod.reportSandboxWorkspaceProgress(
    () => Promise.reject(new Error('async drop')),
    { status: 'progress', stage: 'workspace_transfer', progress: {
      percent: null, receivedObjects: null, totalObjects: null, receivedBytes: null, throughputBytesPerSecond: null,
    } },
  );
  await new Promise((r) => setTimeout(r, 10));
  mod.reportSandboxWorkspaceProgress(undefined, {
    status: 'started',
    stage: 'workspace_transfer',
  });
});

rmSync(harness, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed (detached-jobs)`);
if (failed > 0) process.exit(1);
