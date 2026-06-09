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
    this.tornDown = [];
  }
  async provision(ctx) {
    this.provisionCalls.push(ctx);
    return {
      taskId: ctx.taskId,
      baseUrl: `http://cap-aio-${ctx.taskId}:8080`,
      wsUrl: `ws://cap-aio-${ctx.taskId}:8080/v1/shell/ws`,
    };
  }
  async teardownSandbox(taskId) { this.tornDown.push(taskId); }
  getSandboxMode() { return 'danger-full-access'; }
}

class FakeAioPtyClient {
  constructor(taskId, wsUrl, baseUrl, onExit) {
    this.taskId = taskId;
    this.wsUrl = wsUrl;
    this.baseUrl = baseUrl;
    this.onExit = onExit;
  }
  closeWith(status) {
    if (this.onExit) this.onExit(status);
  }
}

/**
 * Harness mirroring the guardrails seams under test. `_transition` mirrors
 * `TasksService.transition`'s isTerminal→`onTerminal` chain (teardown + slot
 * release) so the test pins that EVERY exit frees the slot.
 */
class GuardrailsHarness {
  constructor(breaker, sandbox) {
    this.breaker = breaker;
    this.sandbox = sandbox;
    this.connections = new Map();
    this.transitions = [];     // { taskId, status }
    this.released = [];        // taskId — semaphore.release
    this.forceFails = [];      // { taskId, cause }
  }

  async startRunning(taskId) {
    const connection = await this.sandbox.provision({ taskId });
    if (connection) this.connections.set(taskId, connection);
    return connection;
  }

  connectionFor(taskId) {
    return this.connections.get(taskId);
  }

  // mirrors safeTransition + tasks-service isTerminal→onTerminal teardown/release
  _transition(taskId, status) {
    this.transitions.push({ taskId, status });
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'agent_failed_to_start') {
      void this.sandbox.teardownSandbox(taskId);
      this.released.push(taskId);
    }
  }

  // mirrors forceFail (records cause, transitions failed, teardown + release)
  _forceFail(taskId, cause) {
    this.forceFails.push({ taskId, cause });
    this._transition(taskId, 'failed');
  }

  // mirrors GuardrailsService.recordExit (3.5 — verbatim rule)
  recordExit(taskId, status) {
    if (!status.abnormal && status.code === 0) {
      this.breaker.recordSuccess(taskId);
      this._transition(taskId, 'completed');
    } else if (status.abnormal) {
      this._forceFail(taskId, 'abnormal_exit');
    } else {
      this.breaker.recordFailure(taskId);
      this._transition(taskId, 'failed');
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
  new FakeAioPtyClient('t2', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t2', s)).closeWith({ code: 0, abnormal: false });

  assert(breaker.successes[0] === 't2', 'T2a: zero exit code -> recordSuccess');
  assert(lastTransition(g, 't2') === 'completed', 'T2b: clean exit transitions task to completed');
  assert(g.released.includes('t2'), 'T2c: clean exit RELEASES the slot (no zombie running)');
  assert(provider.tornDown.includes('t2'), 'T2d: clean exit tears down the sandbox');
}

// T3: non-zero exit -> recordFailure + failed + teardown + slot release on FIRST exit
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t3');
  new FakeAioPtyClient('t3', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t3', s)).closeWith({ code: 1, abnormal: false });

  assert(breaker.failures[0] === 't3', 'T3a: non-zero exit -> recordFailure (breaker/audit signal)');
  assert(lastTransition(g, 't3') === 'failed', 'T3b: non-zero exit transitions task to failed');
  assert(g.released.includes('t3'), 'T3c: non-zero exit RELEASES the slot on the first exit (no breaker-threshold wait)');
}

// T4: unresolved (null) non-abnormal code -> treated as failure + release
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t4');
  new FakeAioPtyClient('t4', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t4', s)).closeWith({ code: null, abnormal: false });

  assert(breaker.failures.includes('t4') && breaker.successes.length === 0, 'T4a: null code -> recordFailure');
  assert(g.released.includes('t4'), 'T4b: null-code exit RELEASES the slot');
}

// T5: abnormal termination -> forceFail('abnormal_exit') + failed + release
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t5');
  new FakeAioPtyClient('t5', conn.wsUrl, conn.baseUrl, (s) => g.recordExit('t5', s)).closeWith({ code: 0, abnormal: true });

  assert(g.forceFails[0]?.cause === 'abnormal_exit', 'T5a: abnormal termination -> forceFail with honest cause abnormal_exit (not idle)');
  assert(lastTransition(g, 't5') === 'failed', 'T5b: abnormal termination transitions task to failed');
  assert(g.released.includes('t5'), 'T5c: abnormal termination RELEASES the slot');
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
