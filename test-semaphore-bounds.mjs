/**
 * Minimal test: "Concurrency semaphore bounds running tasks"
 *
 * Uses Node.js built-in assert. No external test framework needed.
 * Compiles the semaphore TS to a temp dir, then exercises it.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 1. Compile the semaphore source to a temp directory
// ---------------------------------------------------------------------------
const SRC = resolve('/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/guardrails/semaphore.ts');
const tmpDir = mkdtempSync(join(tmpdir(), 'semaphore-test-'));
const tsconfig = join(tmpDir, 'tsconfig.json');

writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    module: 'commonjs',
    target: 'ES2021',
    strict: true,
    skipLibCheck: true,
    outDir: tmpDir,
  },
  files: [SRC],
}));

execSync(
  `"${resolve('/Users/tanghehui/ExploreProject/cloud-agent-platform/node_modules/.bin/tsc')}" --project "${tsconfig}"`,
  { stdio: 'inherit' },
);

const compiledPath = join(tmpDir, 'semaphore.js');
const req = createRequire(import.meta.url);
const { ConcurrencySemaphore } = req(compiledPath);

// ---------------------------------------------------------------------------
// 2. Tests
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

console.log('\nConcurrency semaphore bounds running tasks\n');

// --- Test 1: tasks up to the cap are admitted as running ---------------
test('tasks up to cap are admitted as "running"', () => {
  const sem = new ConcurrencySemaphore({ maxConcurrentTasks: 3 });
  assert.equal(sem.offer('t1'), 'running');
  assert.equal(sem.offer('t2'), 'running');
  assert.equal(sem.offer('t3'), 'running');
  assert.equal(sem.runningCount, 3);
  assert.equal(sem.queuedCount, 0);
});

// --- Test 2: tasks beyond the cap are queued, not running ---------------
test('tasks beyond cap are held in queue ("queued"), not admitted', () => {
  const sem = new ConcurrencySemaphore({ maxConcurrentTasks: 2 });
  sem.offer('t1');
  sem.offer('t2');
  // Cap is full — next two must be queued
  assert.equal(sem.offer('t3'), 'queued');
  assert.equal(sem.offer('t4'), 'queued');
  // Running count never exceeds 2
  assert.equal(sem.runningCount, 2, 'running count must not exceed cap');
  assert.equal(sem.queuedCount, 2);
});

// --- Test 3: releasing a running task admits the oldest queued task ------
test('release admits oldest queued task (FIFO) and cap is respected', () => {
  const admitted = [];
  const sem = new ConcurrencySemaphore({
    maxConcurrentTasks: 2,
    onAdmit: (id) => admitted.push(id),
  });
  sem.offer('t1');
  sem.offer('t2');
  sem.offer('t3'); // queued
  sem.offer('t4'); // queued

  // Release one running task
  const next = sem.release('t1');
  assert.equal(next, 't3', 'FIFO: oldest queued ("t3") must be admitted first');
  assert.deepEqual(admitted, ['t3'], 'onAdmit must be called exactly once with the admitted id');
  assert.equal(sem.runningCount, 2, 'running count stays at cap after admission');
  assert.equal(sem.queuedCount, 1, 'only one task remains queued');
});

// --- Test 4: running count never exceeds cap across many tasks ----------
test('running count never exceeds cap regardless of admission order', () => {
  const MAX = 3;
  const sem = new ConcurrencySemaphore({ maxConcurrentTasks: MAX });
  const ids = ['a','b','c','d','e','f','g'];
  for (const id of ids) sem.offer(id);

  assert.ok(
    sem.runningCount <= MAX,
    `running count ${sem.runningCount} exceeds cap ${MAX}`,
  );

  // Release all running tasks one by one and check cap is never exceeded
  for (const id of ids) {
    sem.release(id);
    assert.ok(sem.runningCount <= MAX, `cap violated after releasing ${id}`);
  }
});

// --- Test 5: cancelling a queued task does not open a phantom slot -------
test('releasing a queued (never-ran) task does not admit a replacement', () => {
  const admitted = [];
  const sem = new ConcurrencySemaphore({
    maxConcurrentTasks: 1,
    onAdmit: (id) => admitted.push(id),
  });
  sem.offer('r');  // running
  sem.offer('q1'); // queued
  sem.offer('q2'); // queued

  // Cancel q1 (queued, never ran) — should NOT admit q2
  const result = sem.release('q1');
  assert.equal(result, null, 'releasing a queued task must return null (no admission)');
  assert.deepEqual(admitted, [], 'onAdmit must NOT be called when releasing a queued task');
  assert.equal(sem.runningCount, 1, 'running slot is still held by "r"');
  assert.equal(sem.queuedCount, 1, 'q2 is still queued');
});

// ---------------------------------------------------------------------------
// 3. Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);

// Cleanup
try { rmSync(tmpDir, { recursive: true }); } catch (_) {}

if (failed > 0) process.exit(1);
