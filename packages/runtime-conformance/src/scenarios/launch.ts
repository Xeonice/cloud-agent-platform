/**
 * Launch family — assertions PORTED from the api seed suites, not invented:
 *
 *   - `apps/api/src/agent-runtime/codex-launch.test.mjs` (the byte-exact
 *     GOLDEN detached launch line, the `$(cat …)` positional-prompt contract,
 *     the detached-tmux wrapper shape);
 *   - `apps/api/src/agent-runtime/agent-runtime.test.mjs` (per-runtime launch
 *     flags/env, incompatible-flag absence, the sessionId requirement);
 *   - `apps/api/src/agent-runtime/headless-execution.spec.ts` (the composed
 *     interactive bypass policy: no legacy/interactive-only flags).
 *
 * The suite owns every assertion; the runtime's harness contributes only the
 * launch context, the golden fixture bytes, and include/exclude expectations.
 */
import assert from 'node:assert/strict';

import { detachedSessionName } from '@cap-console/sandbox';

import type { RuntimeHarness } from '../harness.js';

export async function runLaunchFamily(harness: RuntimeHarness): Promise<void> {
  const { runtime, hooks } = harness;
  const { context, goldenDetachedLine, mustInclude, mustExclude, requiresSessionId } =
    hooks.launch;

  const line = runtime.buildLaunchLine(context);

  // Every runtime launches in the UTF-8 DETACHED named tmux session
  // `task<taskId>` with the workspace as cwd (the shared launch mechanism).
  // `detachedSessionName` is the tmux protocol's single declaration.
  assert.ok(
    line.startsWith(
      `tmux -u new-session -d -s ${detachedSessionName(context.taskId)} `,
    ),
    `${runtime.id}: launch line starts the UTF-8 detached named tmux session`,
  );
  assert.ok(
    line.includes(`-c ${context.workspaceDir}`),
    `${runtime.id}: detached session cwd is the task workspace`,
  );

  // The prompt rides the `"$(cat <file>)"` shape — never inlined into argv.
  assert.ok(
    line.includes('$(cat '),
    `${runtime.id}: prompt is delivered via the "$(cat …)" file shape`,
  );

  // Launch lines are a pure function of the context (no hidden state): the
  // prompt free-text physically cannot enter the argv.
  assert.equal(
    runtime.buildLaunchLine(context),
    line,
    `${runtime.id}: launch line is deterministic from the context alone`,
  );

  // Byte-exact golden (codex): the fixture is MOVED from the seed suite; the
  // launch line must reproduce it byte-for-byte.
  if (goldenDetachedLine !== undefined) {
    assert.equal(
      line,
      goldenDetachedLine,
      `${runtime.id}: detached launch line is byte-identical to the golden fixture`,
    );
  }

  for (const fragment of mustInclude) {
    assert.ok(
      line.includes(fragment),
      `${runtime.id}: launch line must include ${JSON.stringify(fragment)}`,
    );
  }
  for (const fragment of mustExclude) {
    assert.ok(
      !line.includes(fragment),
      `${runtime.id}: launch line must not include ${JSON.stringify(fragment)}`,
    );
  }

  // The sessionId requirement (claude: the `--session-id` uuid names the
  // transcript JSONL, so a launch without it must refuse).
  const withoutSession = { ...context, sessionId: undefined };
  if (requiresSessionId) {
    assert.throws(
      () => runtime.buildLaunchLine(withoutSession),
      `${runtime.id}: buildLaunchLine must refuse a context without a sessionId`,
    );
  } else {
    assert.doesNotThrow(
      () => runtime.buildLaunchLine(withoutSession),
      `${runtime.id}: buildLaunchLine must tolerate an absent sessionId`,
    );
  }
}
