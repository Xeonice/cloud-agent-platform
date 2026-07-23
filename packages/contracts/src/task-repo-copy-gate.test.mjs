/**
 * add-repo-content-store (5.1) — the task-creation copy-readiness refusal
 * contract: a stable code distinct from the `repo_copy_*` acquisition failures,
 * a bounded body, and operator copy that always names the refresh path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REPO_COPY_REFRESH_PATH_TEMPLATE,
  REPO_IMPORT_FAILURE_CODES,
  TASK_REPO_COPY_NOT_READY_ERROR,
  TaskRepoCopyBlockingStatusSchema,
  TaskRepoCopyNotReadyErrorSchema,
  taskRepoCopyNotReadyMessage,
} from '../dist/index.js';

const REPO_ID = '11111111-1111-4111-8111-111111111111';

test('the task-gating code is stable and distinct from the repo_copy_* acquisition failures', () => {
  assert.equal(TASK_REPO_COPY_NOT_READY_ERROR, 'task_repo_copy_not_ready');
  // "copy acquisition failed" and "no usable copy, so no task may start" are
  // different verdicts with different remedies; they never share a code.
  assert.equal(
    REPO_IMPORT_FAILURE_CODES.includes(TASK_REPO_COPY_NOT_READY_ERROR),
    false,
  );
});

test('the blocking status set is every non-ready copy state plus a fail-closed unknown', () => {
  assert.deepEqual(TaskRepoCopyBlockingStatusSchema.options, [
    'missing',
    'refreshing',
    'failed',
    'unknown',
  ]);
  // `ready` is the admitting state and can never label a refusal.
  assert.equal(TaskRepoCopyBlockingStatusSchema.safeParse('ready').success, false);
});

test('every rejection message names the current status and the refresh-copy remedy', () => {
  assert.equal(REPO_COPY_REFRESH_PATH_TEMPLATE, 'POST /repos/:repoId/refresh-copy');

  for (const status of TaskRepoCopyBlockingStatusSchema.options) {
    const message = taskRepoCopyNotReadyMessage(REPO_ID, status);
    assert.ok(
      message.includes(`copyStatus "${status}"`),
      `${status}: message must name the current copy status`,
    );
    assert.ok(
      message.includes(`POST /repos/${REPO_ID}/refresh-copy`),
      `${status}: message must name the refresh-copy path (it also ACQUIRES a missing copy)`,
    );
    assert.ok(message.length <= 1_024, `${status}: message stays bounded`);

    assert.equal(
      TaskRepoCopyNotReadyErrorSchema.safeParse({
        error: TASK_REPO_COPY_NOT_READY_ERROR,
        repoId: REPO_ID,
        copyStatus: status,
        message,
      }).success,
      true,
      status,
    );
  }
});

test('the rejection body is bounded and rejects diagnostic fields', () => {
  const base = {
    error: TASK_REPO_COPY_NOT_READY_ERROR,
    repoId: REPO_ID,
    copyStatus: 'missing',
    message: taskRepoCopyNotReadyMessage(REPO_ID, 'missing'),
  };

  assert.equal(
    TaskRepoCopyNotReadyErrorSchema.safeParse({
      ...base,
      token: 'secret-canary',
      rawOutput: 'git clone --mirror diagnostic',
    }).success,
    false,
  );
  assert.equal(
    TaskRepoCopyNotReadyErrorSchema.safeParse({ ...base, copyStatus: 'ready' })
      .success,
    false,
  );
  assert.equal(
    TaskRepoCopyNotReadyErrorSchema.safeParse({
      ...base,
      message: 'x'.repeat(1_025),
    }).success,
    false,
  );
  assert.equal(
    TaskRepoCopyNotReadyErrorSchema.safeParse({
      ...base,
      error: 'repo_copy_missing',
    }).success,
    false,
  );
});
