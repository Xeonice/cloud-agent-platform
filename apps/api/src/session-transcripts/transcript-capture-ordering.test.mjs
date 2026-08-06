/**
 * The happens-before this move must not break: transcript capture COMPLETES
 * before the stop-only teardown begins (collapse-three-collaborator-groups N3).
 *
 * The archive is read out of the task's container. Teardown stops that container.
 * So the guarantee is not "capture is called first" — it is "capture has
 * FINISHED first", and the mechanism carrying it is the `await` in front of the
 * capture call at the orchestrator's terminal chokepoint. Moving the capture
 * service into its own context changes who owns it and how it is injected; it
 * must not change that.
 *
 * Two things make this a REGRESSION guard rather than a description:
 *
 *   1. It drives the REAL compiled `GuardrailsService` from `dist/` — the same
 *      way `metrics.verify.test.mjs` loads real compiled code — instead of a
 *      hand-written mirror of the seam. A mirror would keep passing while the
 *      orchestrator changed underneath it.
 *   2. It runs the SAME assertion a second time against the same implementation
 *      with the `await` removed, and requires that run to FAIL. An ordering
 *      assertion that passes against an awaited AND a non-awaited implementation
 *      is not testing the ordering — it is testing that a call happened.
 *
 * The assertion is on the recorded completion ORDER, never on elapsed time:
 * capture is made artificially slow, and both runs wait for capture to finish
 * before asserting, so the non-awaited build fails because it captured AFTER
 * teardown — not because the test looked too early.
 *
 * This file lives here, with the capture owner, and deliberately NOT under
 * `apps/api/src/guardrails/`: that directory's characterization baseline (its
 * `test()` / `*.spec.ts` / `*.test.mjs` counts) is frozen by a standing
 * requirement, and a new suite there would move it.
 *
 * Requires a built `dist/` (`pnpm --filter @cap-console/api build`), which the
 * api package's own `pretest` step guarantees.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The real compiled orchestrator. */
const ORCHESTRATOR_JS = path.resolve(
  here,
  '../../dist/guardrails/guardrails.service.js',
);

/**
 * The awaited capture call, as the compiled orchestrator emits it. This exact
 * text is what carries the guarantee, so the test anchors on it and refuses to
 * run if it is not there EXACTLY once — a silent anchor miss would turn the
 * discrimination half of this suite into a no-op.
 */
const AWAITED_CAPTURE = 'await this.transcripts.capture(taskId);';

/** The same call, not awaited. `.catch` only keeps the rejection handled. */
const NON_AWAITED_CAPTURE =
  'this.transcripts.capture(taskId).catch(() => undefined);';

/**
 * The non-awaited build is written NEXT TO the real one so its own relative
 * requires still resolve; it is removed again in `after()`. `dist/` is build
 * output, and this name matches no suite glob.
 */
const NON_AWAITED_JS = path.resolve(
  here,
  '../../dist/guardrails/.guardrails.service.non-awaited.test-artifact.js',
);

const TASK_ID = 'task-ordering-1';

/** Loaded in `before()`: the awaited build and the non-awaited build. */
let awaitedBuild;
let nonAwaitedBuild;

before(() => {
  assert.ok(
    existsSync(ORCHESTRATOR_JS),
    `compiled orchestrator missing at ${ORCHESTRATOR_JS} — build the api package first (pnpm --filter @cap-console/api build)`,
  );
  const compiled = readFileSync(ORCHESTRATOR_JS, 'utf8');
  const occurrences = compiled.split(AWAITED_CAPTURE).length - 1;
  assert.equal(
    occurrences,
    1,
    `expected exactly one \`${AWAITED_CAPTURE}\` in the compiled orchestrator, found ${occurrences} — the awaited capture call IS the happens-before mechanism; if it moved or changed shape, re-anchor this test rather than deleting it`,
  );
  writeFileSync(
    NON_AWAITED_JS,
    compiled.replace(AWAITED_CAPTURE, NON_AWAITED_CAPTURE),
  );

  awaitedBuild = require(ORCHESTRATOR_JS).GuardrailsService;
  nonAwaitedBuild = require(NON_AWAITED_JS).GuardrailsService;
});

after(() => {
  rmSync(NON_AWAITED_JS, { force: true });
});

/**
 * Drive one terminal settlement through the given orchestrator build and return
 * the ordered side-effect log.
 *
 * Capture is artificially slow and records its OWN start and completion, so the
 * log distinguishes "capture was called" from "capture finished". Both are
 * recorded by the same stub for both builds — the only difference between the
 * two runs is the implementation under test.
 */
async function recordTerminalSettlement(GuardrailsService) {
  const events = [];
  let captureFinished;
  const captureDone = new Promise((resolve) => {
    captureFinished = resolve;
  });

  const sandbox = {
    getSandboxMode() {
      return 'test';
    },
    async teardownSandbox(taskId) {
      events.push(`teardown:${taskId}`);
    },
  };

  const transcripts = {
    async capture(taskId) {
      events.push(`capture:start:${taskId}`);
      // Artificially slow: long enough that a non-awaited call is guaranteed to
      // still be in flight when teardown runs, and short enough to stay cheap.
      await new Promise((resolve) => setTimeout(resolve, 25));
      events.push(`capture:end:${taskId}`);
      captureFinished();
      return 'captured';
    },
  };

  const service = new GuardrailsService(
    /* moduleRef      */ {},
    /* creds          */ { destroyForSession() {} },
    /* sandbox        */ sandbox,
    /* config         */ {
      maxConcurrentTasks: 1,
      defaultIdleTimeoutMs: null,
      circuitBreakerThreshold: 3,
    },
    /* provisionLookup*/ undefined,
    /* audit          */ undefined,
    /* prisma         */ undefined,
    /* transcripts    */ transcripts,
  );

  await service.onTerminal(TASK_ID, 'completed');
  // Let a non-awaited capture land too, so the assertion below judges ORDER and
  // not whether the test finished before the capture did.
  await Promise.race([
    captureDone,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  return events;
}

/**
 * THE assertion — one function, used against both builds, so "the same
 * assertion" is a fact about this file rather than a claim in a comment.
 */
function assertCaptureCompletedBeforeTeardown(events) {
  const captureEnd = events.indexOf(`capture:end:${TASK_ID}`);
  const teardown = events.indexOf(`teardown:${TASK_ID}`);
  assert.notEqual(
    captureEnd,
    -1,
    `capture never completed — recorded: ${JSON.stringify(events)}`,
  );
  assert.notEqual(
    teardown,
    -1,
    `teardown was never invoked — recorded: ${JSON.stringify(events)}`,
  );
  assert.ok(
    captureEnd < teardown,
    `transcript capture must COMPLETE before the sandbox is torn down (the archive is read out of the container teardown stops) — recorded: ${JSON.stringify(events)}`,
  );
}

test('capture completes before teardown begins, in the real orchestrator', async () => {
  const events = await recordTerminalSettlement(awaitedBuild);
  assertCaptureCompletedBeforeTeardown(events);
  assert.deepEqual(
    events,
    [
      `capture:start:${TASK_ID}`,
      `capture:end:${TASK_ID}`,
      `teardown:${TASK_ID}`,
    ],
    'the terminal chokepoint must call capture, wait for it, and only then tear the sandbox down',
  );
});

test('the same assertion FAILS against a non-awaited capture', async () => {
  const events = await recordTerminalSettlement(nonAwaitedBuild);
  // Capture still HAPPENS here — it just is not waited for. That is exactly the
  // regression this suite exists to catch, and an assertion that cannot tell the
  // two apart would be worthless.
  assert.ok(
    events.includes(`capture:start:${TASK_ID}`),
    'the non-awaited build must still CALL capture — otherwise this run proves nothing about awaiting',
  );
  assert.throws(
    () => assertCaptureCompletedBeforeTeardown(events),
    assert.AssertionError,
    'the ordering assertion passed against an implementation that does not await capture — it is not testing the happens-before and must be rewritten',
  );
});
