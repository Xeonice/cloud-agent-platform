/**
 * Lifecycle family — the declarative terminal-startup (DSR/quiesce) policy and
 * the `tmux has-session` exit-detection contract. Assertions PORTED from
 * `apps/api/src/agent-runtime/agent-runtime.test.mjs`:
 *
 *   - the runtime DECLARES its startup policy (`replyToStartupDSR` +
 *     `promptSubmit`); the shared pty mechanism reads it — no agent-identity
 *     branch (codex: DSR reply + cr-on-quiesce; claude: neither);
 *   - the quiesce window stays env-tunable with the documented default (codex);
 *   - `detectExit` probes `tmux has-session -t task<taskId>`: a GONE session is
 *     `done`, an EXISTING session is `running`, an inconclusive probe (no
 *     sentinel) reads as `running` so a transport blip never fakes completion;
 *   - `detectExit` NEVER kills the session or tails the transcript (the
 *     resident-session contract).
 */
import assert from 'node:assert/strict';

import { detachedSessionName } from '@cap-console/sandbox';

import type { ConformanceExec, RuntimeHarness } from '../harness.js';

function scriptedExec(
  responder: (command: string) => { stdout: string; code: number | null } | undefined,
): ConformanceExec & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: async (command: string) => {
      calls.push(command);
      return responder(command) ?? { stdout: '', code: 0 };
    },
  };
}

export async function runLifecycleFamily(harness: RuntimeHarness): Promise<void> {
  const { runtime, hooks } = harness;
  const { context, startup, quiesceTunable } = hooks.lifecycle;

  // ---- declarative terminal-startup policy --------------------------------
  assert.equal(
    runtime.terminalStartup.replyToStartupDSR,
    startup.replyToStartupDSR,
    `${runtime.id}: declares the expected replyToStartupDSR policy`,
  );
  assert.equal(
    runtime.terminalStartup.promptSubmit,
    startup.promptSubmit,
    `${runtime.id}: declares the expected promptSubmit policy`,
  );

  if (quiesceTunable) {
    const previous = process.env[quiesceTunable.envVar];
    try {
      process.env[quiesceTunable.envVar] = '20';
      assert.equal(
        runtime.terminalStartup.quiesceMs,
        20,
        `${runtime.id}: quiesceMs reads ${quiesceTunable.envVar} at access time`,
      );
      delete process.env[quiesceTunable.envVar];
      assert.equal(
        runtime.terminalStartup.quiesceMs,
        quiesceTunable.defaultMs,
        `${runtime.id}: quiesceMs defaults to ${quiesceTunable.defaultMs}`,
      );
    } finally {
      if (previous === undefined) delete process.env[quiesceTunable.envVar];
      else process.env[quiesceTunable.envVar] = previous;
    }
  }

  // ---- exit detection: gone => done ---------------------------------------
  const gone = scriptedExec((cmd) =>
    cmd.includes('has-session') ? { stdout: '__cap_has__1\n', code: 0 } : undefined,
  );
  const goneSignal = await runtime.detectExit(gone, context);
  assert.equal(
    goneSignal.status,
    'done',
    `${runtime.id}: a GONE tmux session is done`,
  );
  assert.ok(
    gone.calls.some((cmd) =>
      cmd.includes(`tmux has-session -t ${detachedSessionName(context.taskId)}`),
    ),
    `${runtime.id}: detectExit probes \`tmux has-session\` for the task session`,
  );
  assert.ok(
    !gone.calls.some((cmd) => cmd.includes('kill-session')) &&
      !gone.calls.some((cmd) => cmd.startsWith('cat ')),
    `${runtime.id}: detectExit never kills the session or tails the transcript`,
  );

  // ---- exit detection: alive => running -----------------------------------
  const alive = scriptedExec((cmd) =>
    cmd.includes('has-session') ? { stdout: '__cap_has__0\n', code: 0 } : undefined,
  );
  const aliveSignal = await runtime.detectExit(alive, context);
  assert.equal(
    aliveSignal.status,
    'running',
    `${runtime.id}: an EXISTING tmux session is still running`,
  );
  assert.ok(
    !alive.calls.some((cmd) => cmd.includes('kill-session')),
    `${runtime.id}: a finished-looking probe never triggers a kill`,
  );

  // ---- exit detection: inconclusive probe => running ----------------------
  const blip = scriptedExec(() => ({ stdout: 'no sentinel here', code: 0 }));
  const blipSignal = await runtime.detectExit(blip, context);
  assert.equal(
    blipSignal.status,
    'running',
    `${runtime.id}: an inconclusive probe (no sentinel) reads as running`,
  );
}
