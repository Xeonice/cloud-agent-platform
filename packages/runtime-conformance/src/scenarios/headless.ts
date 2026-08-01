/**
 * Headless family — argv assertions PORTED from the existing argv-capture
 * suite (`apps/api/src/agent-runtime/headless-execution.spec.ts`):
 *
 *   - a runtime declaring `headless-exec` MUST provide the headless builders;
 *   - the headless line's argv carries the runtime's non-interactive flags and
 *     none of the interactive/legacy ones (the include/exclude sets);
 *   - headless lines append the exit-code sentinel INSIDE the single-quoted
 *     inner (`; echo $? > <exit-file>`); interactive lines never do;
 *   - resume lines continue a prior session with the same policy flags;
 *   - a shell-active resume id is refused (codex);
 *   - bypass flags appear exactly once per launch mode (claude).
 *
 * The live-tmux boundary capture (spawning a real tmux with a stub executable)
 * stays with the api seed suite, which keeps exercising the real binary in the
 * api lane; this family ports its argv-level assertion vocabulary.
 */
import assert from 'node:assert/strict';

import { detachedSessionName } from '@cap-console/sandbox';

import { ConformanceParticipationError } from '../participation.js';
import type { RuntimeHarness } from '../harness.js';

export async function runHeadlessFamily(harness: RuntimeHarness): Promise<void> {
  const { runtime, hooks } = harness;
  const h = hooks.headless;
  if (!h) {
    throw new ConformanceParticipationError(
      runtime.id,
      'headless',
      'its harness supplies no headless hooks',
    );
  }
  if (
    typeof runtime.buildHeadlessLine !== 'function' ||
    typeof runtime.buildResumeLine !== 'function'
  ) {
    throw new ConformanceParticipationError(
      runtime.id,
      'headless',
      'the runtime does not provide the headless launch builders',
    );
  }

  // ---- the one-shot headless line -----------------------------------------
  const line = runtime.buildHeadlessLine(h.context);
  assert.ok(
    line.startsWith(
      `tmux -u new-session -d -s ${detachedSessionName(h.context.taskId)} `,
    ),
    `${runtime.id}: headless line runs in the same detached named tmux session`,
  );
  for (const fragment of h.mustInclude) {
    assert.ok(
      line.includes(fragment),
      `${runtime.id}: headless line must include ${JSON.stringify(fragment)}`,
    );
  }
  for (const fragment of h.mustExclude) {
    assert.ok(
      !line.includes(fragment),
      `${runtime.id}: headless line must not include ${JSON.stringify(fragment)}`,
    );
  }

  // ---- the exit-code sentinel: headless writes it, interactive never ------
  assert.ok(
    line.includes(`; echo $? > ${h.exitSentinelPath}'`),
    `${runtime.id}: headless line appends the exit sentinel inside the quoted inner`,
  );
  assert.ok(
    !runtime.buildLaunchLine(hooks.launch.context).includes(h.exitSentinelPath),
    `${runtime.id}: interactive line does NOT write the exit sentinel`,
  );

  // ---- the headless resume line -------------------------------------------
  const resume = runtime.buildResumeLine(h.context, h.resume.previousSessionId);
  for (const fragment of h.resume.mustInclude) {
    assert.ok(
      resume.includes(fragment),
      `${runtime.id}: resume line must include ${JSON.stringify(fragment)}`,
    );
  }
  for (const fragment of h.resume.mustExclude) {
    assert.ok(
      !resume.includes(fragment),
      `${runtime.id}: resume line must not include ${JSON.stringify(fragment)}`,
    );
  }

  // ---- hostile resume ids are refused -------------------------------------
  if (h.hostileResume) {
    const { sessionId, rejectionPattern } = h.hostileResume;
    assert.throws(
      () => runtime.buildResumeLine!(h.context, sessionId),
      new RegExp(rejectionPattern),
      `${runtime.id}: a shell-active resume session id is refused`,
    );
  }

  // ---- exactly-once flags across every launch mode ------------------------
  if (h.exactlyOnceFlags) {
    const modes: readonly (readonly [string, string])[] = [
      ['interactive', runtime.buildLaunchLine(hooks.launch.context)],
      ['headless', line],
      ['resume', resume],
    ];
    for (const flag of h.exactlyOnceFlags) {
      for (const [label, candidate] of modes) {
        assert.equal(
          candidate.split(flag).length - 1,
          1,
          `${runtime.id}: ${label} line carries ${JSON.stringify(flag)} exactly once`,
        );
      }
    }
  }
}
