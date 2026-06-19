/**
 * Minimal test for the provision→connect→exit round-trip and the UPDATED
 * `recordExit` mapping (task-guardrail-controls 3.5).
 *
 * Round-trip under test (guardrails.service.ts):
 *   1. provision  — `startRunning` calls `sandbox.provision({ taskId })` (4.1),
 *                   with NO `taskToken` (4.4), and CAPTURES the returned
 *                   `SandboxConnection` handle.
 *   2. connect    — the gateway opens a (here, fake) `AioPtyClient`; on the
 *                   terminal WS close the client resolves an exit status and
 *                   invokes `onExit`.
 *   3. exit       — `onExit` feeds `recordExit(taskId, status)`, which now drives
 *                   the task to a TERMINAL state and FREES ITS SLOT on the single
 *                   exit (the connect-in fix — a clean/non-zero exit no longer
 *                   leaks the slot until idle/restart):
 *                     - zero code, not abnormal -> recordSuccess + transition `completed` + teardown + release
 *                     - non-zero code           -> recordFailure + transition `failed`    + teardown + release
 *                     - abnormal termination    -> forceFail('abnormal_exit') -> `failed`  + teardown + release
 *
 * This inlines a FAITHFUL re-creation of ONLY the seams under test — the
 * provision-capture seam and the `recordExit` mapping + the
 * transition→isTerminal→onTerminal teardown/release chain — mirroring
 * `guardrails.service.ts` so it stays a no-transpile `.mjs` script like its
 * siblings while pinning the documented contract.
 */

// ---- spies / fakes ----------------------------------------------------------

class SpyBreaker {
  constructor() {
    this.successes = [];
    this.failures = [];
  }
  recordSuccess(taskId) { this.successes.push(taskId); }
  recordFailure(taskId) { this.failures.push(taskId); }
}

class MockProvider {
  constructor() {
    this.provisionCalls = [];
    this.tornDown = [];   // taskId — STOP-only settle (retention: container KEPT)
    this.removed = [];    // taskId — force-remove (cleaner only; never lifecycle)
  }
  async provision(ctx) {
    this.provisionCalls.push(ctx);
    return {
      taskId: ctx.taskId,
      baseUrl: `http://cap-aio-${ctx.taskId}:8080`,
      wsUrl: `ws://cap-aio-${ctx.taskId}:8080/v1/shell/ws`,
    };
  }
  // session-sandbox-retention: teardown STOPS only (retains the container); the
  // separate removeSandbox is the cleaner-only force-remove. The lifecycle must
  // never call removeSandbox — asserted below.
  async teardownSandbox(taskId) { this.tornDown.push(taskId); }
  async removeSandbox(taskId) { this.removed.push(taskId); }
  async readRolloutFromContainer() { return null; }
  async sandboxExists() { return true; }
  getSandboxMode() { return 'danger-full-access'; }
}

class FakeAioPtyClient {
  constructor(taskId, wsUrl, baseUrl, onExit) {
    this.taskId = taskId;
    this.wsUrl = wsUrl;
    this.baseUrl = baseUrl;
    this.onExit = onExit;
  }
  // Returns the (possibly async) onExit result so callers can AWAIT the full
  // exit→transition→capture→teardown→release chain before asserting (3.4).
  closeWith(status) {
    if (this.onExit) return this.onExit(status);
    return undefined;
  }
}

/**
 * Best-effort transcript service spy (persist-session-transcripts 3.1). Records
 * every `capture(taskId)` call; when constructed with `{ throws: true }` it
 * REJECTS to prove a capture failure cannot block the terminal transition,
 * stop-only teardown, or slot release at either chokepoint (3.4).
 */
class SpyTranscripts {
  constructor({ throws = false } = {}) {
    this.throws = throws;
    this.captured = []; // taskId
  }
  async capture(taskId) {
    this.captured.push(taskId);
    if (this.throws) throw new Error(`boom capturing ${taskId}`);
    return { archived: true };
  }
}

/**
 * Harness mirroring the guardrails seams under test. `_transition` mirrors
 * `TasksService.transition`'s isTerminal→`onTerminal` chain (teardown + slot
 * release) so the test pins that EVERY exit frees the slot.
 */
class GuardrailsHarness {
  constructor(breaker, sandbox, transcripts) {
    this.breaker = breaker;
    this.sandbox = sandbox;
    // persist-session-transcripts 3.1 — OPTIONAL best-effort transcript service.
    // Undefined in a guardrails-only context; capture then becomes a no-op.
    this.transcripts = transcripts;
    this.connections = new Map();
    this.transitions = [];     // { taskId, status }
    this.released = [];        // taskId — semaphore.release
    this.forceFails = [];      // { taskId, cause }
    this.exitDetails = [];     // { taskId, code, abnormal } — record-task-failure-reason
    // Ordered side-effect trace per task to pin capture-BEFORE-teardown ordering
    // and the unconditional teardown/release-after-capture-throw guarantees (3.4):
    // entries are 'capture:<id>' / 'teardown:<id>' / 'release:<id>'.
    this.events = [];
  }

  // mirrors GuardrailsService.recordExitDetail (best-effort `task.exited` detail
  // capture; here it records the resolved code+abnormal into a spy)
  _recordExitDetail(taskId, status) {
    this.exitDetails.push({ taskId, code: status.code, abnormal: status.abnormal });
  }

  // mirrors GuardrailsService.captureTranscript (persist-session-transcripts
  // 3.2/3.3): best-effort, AWAITED-and-swallowed — any throw/rejection from the
  // injected service is caught here so the terminal transition / teardown /
  // slot release that follow proceed unconditionally. No-op when unwired.
  async _captureTranscript(taskId) {
    if (!this.transcripts) return;
    this.events.push(`capture:${taskId}`);
    try {
      await this.transcripts.capture(taskId);
    } catch {
      // swallowed — never blocks the stop-only teardown or the slot release
    }
  }

  async startRunning(taskId) {
    const connection = await this.sandbox.provision({ taskId });
    if (connection) this.connections.set(taskId, connection);
    return connection;
  }

  connectionFor(taskId) {
    return this.connections.get(taskId);
  }

  // mirrors safeTransition + tasks-service isTerminal→onTerminal teardown/release.
  // onTerminal now captures the transcript (3.2) BEFORE the stop-only teardown.
  async _transition(taskId, status) {
    this.transitions.push({ taskId, status });
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'agent_failed_to_start') {
      // persist-session-transcripts 3.2 — capture BEFORE the stop-only teardown.
      await this._captureTranscript(taskId);
      this.events.push(`teardown:${taskId}`);
      void this.sandbox.teardownSandbox(taskId);
      this.events.push(`release:${taskId}`);
      this.released.push(taskId);
    }
  }

  // mirrors forceFail: records cause, transitions to the cause's terminal status,
  // then captures the transcript (3.3) BEFORE the stop-only teardown, then releases.
  // align-claude-runtime-resident-session: an `idle` ceiling on a resident session is
  // a graceful end of life → `completed`; every other cause is a force-`failed`.
  async _forceFail(taskId, cause) {
    this.forceFails.push({ taskId, cause });
    const terminal = cause === 'idle' ? 'completed' : 'failed';
    this.transitions.push({ taskId, status: terminal });
    // persist-session-transcripts 3.3 — capture BEFORE the stop-only teardown.
    await this._captureTranscript(taskId);
    this.events.push(`teardown:${taskId}`);
    void this.sandbox.teardownSandbox(taskId);
    this.events.push(`release:${taskId}`);
    this.released.push(taskId);
  }

  // mirrors GuardrailsService.recordExit (3.5 — verbatim rule)
  async recordExit(taskId, status) {
    if (!status.abnormal && status.code === 0) {
      this.breaker.recordSuccess(taskId);
      await this._transition(taskId, 'completed');
    } else if (status.abnormal) {
      this._recordExitDetail(taskId, status);
      await this._forceFail(taskId, 'abnormal_exit');
    } else {
      this.breaker.recordFailure(taskId);
      this._recordExitDetail(taskId, status);
      await this._transition(taskId, 'failed');
    }
  }
}

// ---- assertion helpers ------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const lastTransition = (g, taskId) =>
  [...g.transitions].reverse().find((t) => t.taskId === taskId)?.status;

// ---- tests ------------------------------------------------------------------

// T1: provision is called with ONLY { taskId } and the handle is captured
{
  const g = new GuardrailsHarness(new SpyBreaker(), new MockProvider());
  const conn = await g.startRunning('t1');
  assert(g.connectionFor('t1') === conn, 'T1: SandboxConnection captured for the gateway');
  assert(conn.wsUrl === 'ws://cap-aio-t1:8080/v1/shell/ws', 'T1: returns wsUrl handle');
}

// T2: clean exit (code 0) -> recordSuccess + completed + teardown + slot release
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t2');
  await new FakeAioPtyClient('t2', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t2', s)).closeWith({ code: 0, abnormal: false });

  assert(breaker.successes[0] === 't2', 'T2a: zero exit code -> recordSuccess');
  assert(lastTransition(g, 't2') === 'completed', 'T2b: clean exit transitions task to completed');
  assert(g.released.includes('t2'), 'T2c: clean exit RELEASES the slot (no zombie running)');
  assert(provider.tornDown.includes('t2'), 'T2d: clean exit tears down the sandbox');
  assert(g.exitDetails.length === 0, 'T2e: clean exit records NO task.exited failure-detail');
}

// T3: non-zero exit -> recordFailure + failed + teardown + slot release on FIRST exit
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t3');
  await new FakeAioPtyClient('t3', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t3', s)).closeWith({ code: 1, abnormal: false });

  assert(breaker.failures[0] === 't3', 'T3a: non-zero exit -> recordFailure (breaker/audit signal)');
  assert(lastTransition(g, 't3') === 'failed', 'T3b: non-zero exit transitions task to failed');
  assert(g.released.includes('t3'), 'T3c: non-zero exit RELEASES the slot on the first exit (no breaker-threshold wait)');
  assert(
    g.exitDetails.some((d) => d.taskId === 't3' && d.code === 1 && d.abnormal === false),
    'T3d: non-zero exit records a task.exited detail carrying the exit code',
  );
}

// T4: unresolved (null) non-abnormal code -> treated as failure + release
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t4');
  await new FakeAioPtyClient('t4', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t4', s)).closeWith({ code: null, abnormal: false });

  assert(breaker.failures.includes('t4') && breaker.successes.length === 0, 'T4a: null code -> recordFailure');
  assert(g.released.includes('t4'), 'T4b: null-code exit RELEASES the slot');
}

// T5: abnormal termination -> forceFail('abnormal_exit') + failed + release
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t5');
  await new FakeAioPtyClient('t5', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t5', s)).closeWith({ code: 0, abnormal: true });

  assert(g.forceFails[0]?.cause === 'abnormal_exit', 'T5a: abnormal termination -> forceFail with honest cause abnormal_exit (not idle)');
  assert(lastTransition(g, 't5') === 'failed', 'T5b: abnormal termination transitions task to failed');
  assert(g.released.includes('t5'), 'T5c: abnormal termination RELEASES the slot');
  assert(provider.tornDown.includes('t5'), 'T5d: abnormal termination STOPS the sandbox (settle)');
  assert(!provider.removed.includes('t5'), 'T5e: abnormal termination RETAINS the container (stop-only, never removeSandbox)');
  assert(
    g.exitDetails.some((d) => d.taskId === 't5' && d.abnormal === true),
    'T5f: abnormal termination records a task.exited detail flagged abnormal',
  );
}

// T6 (session-sandbox-retention 6.1/6.2): teardown at BOTH chokepoints is
// stop-only-retain — the container is STOPPED (kept for replay) and the slot is
// freed, and the lifecycle NEVER force-removes (that is the cleaner's job).
{
  const provider = new MockProvider();
  const g = new GuardrailsHarness(new SpyBreaker(), provider);

  // clean exit (onTerminal path) + abnormal exit (forceFail path)
  let conn = await g.startRunning('t6a');
  await new FakeAioPtyClient('t6a', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t6a', s)).closeWith({ code: 0, abnormal: false });
  conn = await g.startRunning('t6b');
  await new FakeAioPtyClient('t6b', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t6b', s)).closeWith({ code: 0, abnormal: true });

  assert(provider.tornDown.includes('t6a') && provider.tornDown.includes('t6b'), 'T6a: both natural-completion and forced-failure STOP (settle) the sandbox');
  assert(g.released.includes('t6a') && g.released.includes('t6b'), 'T6b: both chokepoints still FREE the slot');
  assert(provider.removed.length === 0, 'T6c: the lifecycle NEVER force-removes a container (retention: only the cleaner removes)');
}

// T7 (persist-session-transcripts 3.2/3.3): the transcript is CAPTURED at BOTH
// terminal chokepoints — natural completion (onTerminal) and force-fail — and
// the capture is ORDERED before the stop-only teardown while the container is
// still present.
{
  // onTerminal path: a clean exit drives `completed` -> capture -> teardown.
  const transcripts = new SpyTranscripts();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(new SpyBreaker(), provider, transcripts);
  let conn = await g.startRunning('t7a');
  await new FakeAioPtyClient('t7a', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t7a', s)).closeWith({ code: 0, abnormal: false });

  assert(transcripts.captured.includes('t7a'), 'T7a: onTerminal (natural completion) invokes transcript capture');
  assert(
    g.events.indexOf('capture:t7a') < g.events.indexOf('teardown:t7a'),
    'T7b: onTerminal captures BEFORE the stop-only teardown (container still present)',
  );

  // forceFail path: an abnormal exit drives forceFail -> capture -> teardown.
  conn = await g.startRunning('t7b');
  await new FakeAioPtyClient('t7b', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t7b', s)).closeWith({ code: 0, abnormal: true });

  assert(transcripts.captured.includes('t7b'), 'T7c: forceFail (abnormal cause) invokes transcript capture');
  assert(
    g.events.indexOf('capture:t7b') < g.events.indexOf('teardown:t7b'),
    'T7d: forceFail captures BEFORE the stop-only teardown (container still present)',
  );
}

// T8 (persist-session-transcripts 3.4): a THROWN capture error is swallowed and
// does NOT block the terminal transition, the stop-only teardown, or the slot
// release — at EITHER chokepoint.
{
  const transcripts = new SpyTranscripts({ throws: true });
  const provider = new MockProvider();
  const g = new GuardrailsHarness(new SpyBreaker(), provider, transcripts);

  // onTerminal path (clean exit) — capture throws.
  let conn = await g.startRunning('t8a');
  await new FakeAioPtyClient('t8a', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t8a', s)).closeWith({ code: 0, abnormal: false });

  assert(transcripts.captured.includes('t8a'), 'T8a: onTerminal still attempts capture even though it throws');
  assert(lastTransition(g, 't8a') === 'completed', 'T8b: capture throw does NOT block the onTerminal transition');
  assert(provider.tornDown.includes('t8a'), 'T8c: capture throw does NOT block the stop-only teardown (onTerminal)');
  assert(g.released.includes('t8a'), 'T8d: capture throw does NOT block the slot release (onTerminal)');

  // forceFail path (abnormal exit) — capture throws.
  conn = await g.startRunning('t8b');
  await new FakeAioPtyClient('t8b', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t8b', s)).closeWith({ code: 0, abnormal: true });

  assert(transcripts.captured.includes('t8b'), 'T8e: forceFail still attempts capture even though it throws');
  assert(lastTransition(g, 't8b') === 'failed', 'T8f: capture throw does NOT block the forceFail transition');
  assert(provider.tornDown.includes('t8b'), 'T8g: capture throw does NOT block the stop-only teardown (forceFail)');
  assert(g.released.includes('t8b'), 'T8h: capture throw does NOT block the slot release (forceFail)');
  assert(provider.removed.length === 0, 'T8i: capture throw never causes a force-remove (retention preserved)');
}

// T9 (align-claude-runtime-resident-session): an `idle` ceiling on a RESIDENT session
// is a graceful end of life -> `completed` (NOT a force-`failed`), while every other
// force-fail cause stays `failed`. Both still stop-only teardown + release the slot.
{
  const provider = new MockProvider();
  const g = new GuardrailsHarness(new SpyBreaker(), provider);
  await g.startRunning('t9idle');
  await g._forceFail('t9idle', 'idle');
  assert(lastTransition(g, 't9idle') === 'completed', 'T9a: an idle reclamation transitions a resident task to COMPLETED (graceful), not failed');
  assert(g.released.includes('t9idle'), 'T9b: idle reclamation RELEASES the slot');
  assert(provider.tornDown.includes('t9idle'), 'T9c: idle reclamation STOPS the sandbox (settle)');
  assert(!provider.removed.includes('t9idle'), 'T9d: idle reclamation RETAINS the container (stop-only)');

  await g.startRunning('t9dl');
  await g._forceFail('t9dl', 'deadline');
  assert(lastTransition(g, 't9dl') === 'failed', 'T9e: a non-idle cause (deadline) still force-fails to failed');
}

// ---- summary ----------------------------------------------------------------

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
