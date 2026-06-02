/**
 * Minimal test: "Isolated per-task workspace" requirement.
 *
 * Verifies that createTaskWorkspace (task 4.1) produces a distinct,
 * non-overlapping directory for each task id, creates each directory on disk,
 * and is idempotent (a second call for the same id does not wipe any content).
 */

import { createTaskWorkspace, DEFAULT_WORKSPACES_ROOT } from './apps/runner/dist/task-entry.js';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

async function directoryExists(p) {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// --- set up a temp root so we don't pollute the repo ---
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'cap-workspace-test-'));

try {
  console.log('\n=== Isolated per-task workspace ===\n');

  // SCENARIO 1: two distinct task ids produce two distinct directories
  const dirA = await createTaskWorkspace({ taskId: 'task-aaa', workspacesRoot: tmpRoot });
  const dirB = await createTaskWorkspace({ taskId: 'task-bbb', workspacesRoot: tmpRoot });

  assert(dirA !== dirB, 'distinct task ids yield distinct workspace paths');
  assert(await directoryExists(dirA), 'workspace directory for task-aaa is created on disk');
  assert(await directoryExists(dirB), 'workspace directory for task-bbb is created on disk');

  // SCENARIO 2: paths are isolated — task-bbb's dir is NOT inside task-aaa's dir
  assert(
    !dirB.startsWith(dirA + path.sep),
    'task-bbb workspace is not nested inside task-aaa workspace',
  );

  // SCENARIO 3: each workspace path ends with its task id (predictable, addressable)
  assert(
    dirA.endsWith(path.sep + 'task-aaa'),
    'workspace path for task-aaa ends with the task id',
  );
  assert(
    dirB.endsWith(path.sep + 'task-bbb'),
    'workspace path for task-bbb ends with the task id',
  );

  // SCENARIO 4: idempotence — re-calling for the same task id does not wipe existing content
  const sentinel = path.join(dirA, 'sentinel.txt');
  await writeFile(sentinel, 'hello from task-aaa');
  const dirA2 = await createTaskWorkspace({ taskId: 'task-aaa', workspacesRoot: tmpRoot });
  const content = await readFile(sentinel, 'utf8');
  assert(dirA2 === dirA, 'second call for same task id returns same path');
  assert(content === 'hello from task-aaa', 'existing workspace content is preserved on re-entry');

  // SCENARIO 5: workspacesRoot defaults to cwd/workspaces when not supplied
  //   We can't easily test the real default without changing cwd, but we can verify
  //   the contract via the exported constant:
  assert(DEFAULT_WORKSPACES_ROOT === 'workspaces', 'DEFAULT_WORKSPACES_ROOT is "workspaces"');

} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
