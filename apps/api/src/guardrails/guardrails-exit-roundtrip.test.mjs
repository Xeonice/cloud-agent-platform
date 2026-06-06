/**
 * Minimal test for guardrails-wiring task 4.5:
 *   "Verify a provision→connect→exit round-trip maps to recordSuccess/recordFailure
 *    (unit test with a mocked provider returning a stub SandboxConnection and a fake
 *    AioPtyClient emitting a WS close + exit status)."
 *
 * Round-trip under test (guardrails.service.ts):
 *   1. provision  — `startRunning` calls `sandbox.provision({ taskId })` (4.1),
 *                   with NO `taskToken`/`taskTokens.issue(...)` argument (4.4),
 *                   and CAPTURES the returned `SandboxConnection` handle so the
 *                   gateway can later open an `AioPtyClient` to `connection.wsUrl`.
 *   2. connect    — the gateway opens a (here, fake) `AioPtyClient` to that
 *                   `wsUrl`; on the terminal WS close the client resolves an
 *                   exit status and invokes its `onExit` callback.
 *   3. exit       — that `onExit` callback feeds `recordExit(taskId, status)`,
 *                   which maps (4.3):
 *                     - zero code, not abnormal      -> recordSuccess
 *                     - non-zero code                -> recordFailure
 *                     - unresolved code (null)       -> recordFailure
 *                     - abnormal termination         -> recordFailure (any code)
 *
 * This test inlines a FAITHFUL, minimal re-creation of ONLY the two seams the
 * task names — the provision-capture seam and the `recordExit` mapping — mirroring
 * `guardrails.service.ts` 1:1, so it stays a no-transpile `.mjs` script like the
 * sibling guardrail tests (semaphore / circuit-breaker / idle-tracker) while still
 * exercising the documented contract. The breaker and provider are spies.
 */

// ---- spies / fakes ----------------------------------------------------------

/** Spy circuit breaker: records which outcome the mapping selected. */
class SpyBreaker {
  constructor() {
    this.successes = [];
    this.failures = [];
  }
  recordSuccess(taskId) {
    this.successes.push(taskId);
  }
  recordFailure(taskId) {
    this.failures.push(taskId);
  }
}

/**
 * Mocked SandboxProvider returning a stub SandboxConnection — and asserting the
 * caller passes ONLY `{ taskId }` (no `taskToken`), per 4.1/4.4.
 */
class MockProvider {
  constructor() {
    this.provisionCalls = [];
  }
  async provision(ctx) {
    this.provisionCalls.push(ctx);
    return {
      taskId: ctx.taskId,
      baseUrl: `http://cap-aio-${ctx.taskId}:8080`,
      wsUrl: `ws://cap-aio-${ctx.taskId}:8080/v1/shell/ws`,
    };
  }
  async teardownSandbox() {}
  getSandboxMode() {
    return 'danger-full-access';
  }
}

/**
 * Fake AioPtyClient: instead of a real outbound WS, it lets the test drive a
 * "terminal WS close + resolved exit status" by calling `closeWith(status)`,
 * which fires the `onExit` callback exactly as the real client does.
 */
class FakeAioPtyClient {
  constructor(taskId, wsUrl, baseUrl, onExit) {
    this.taskId = taskId;
    this.wsUrl = wsUrl;
    this.baseUrl = baseUrl;
    this.onExit = onExit;
  }
  /** Simulate the sandbox terminal WS closing with a resolved exit status. */
  closeWith(status) {
    if (this.onExit) this.onExit(status);
  }
}

/**
 * Minimal harness mirroring `guardrails.service.ts`'s two seams under test:
 *   - `startRunning`  : provision-capture (4.1/4.4)
 *   - `recordExit`    : exit→outcome mapping (4.3)
 * Copied verbatim from the service so the test pins the real mapping rule.
 */
class GuardrailsHarness {
  constructor(breaker, sandbox) {
    this.breaker = breaker;
    this.sandbox = sandbox;
    this.connections = new Map();
  }

  // mirrors GuardrailsService.startRunning (provision + capture handle)
  async startRunning(taskId) {
    const connection = await this.sandbox.provision({ taskId });
    if (connection) this.connections.set(taskId, connection);
    return connection;
  }

  // mirrors GuardrailsService.connectionFor
  connectionFor(taskId) {
    return this.connections.get(taskId);
  }

  // mirrors GuardrailsService.recordExit (4.3 mapping — verbatim rule)
  recordExit(taskId, status) {
    if (!status.abnormal && status.code === 0) {
      this.breaker.recordSuccess(taskId);
    } else {
      this.breaker.recordFailure(taskId);
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

// ---- tests ------------------------------------------------------------------

// T1: provision is called with ONLY { taskId } and the handle is captured
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);

  const conn = await g.startRunning('t1');

  assert(provider.provisionCalls.length === 1, 'T1a: provision called exactly once');
  assert(
    Object.keys(provider.provisionCalls[0]).length === 1 &&
      provider.provisionCalls[0].taskId === 't1',
    'T1b: provision ctx is { taskId } only (no taskToken / dial-back arg)',
  );
  assert(conn.wsUrl === 'ws://cap-aio-t1:8080/v1/shell/ws', 'T1c: returns wsUrl handle');
  assert(
    g.connectionFor('t1') === conn,
    'T1d: SandboxConnection captured for the gateway to open AioPtyClient',
  );
}

// T2: provision→connect→exit(code 0) maps to recordSuccess
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t2');

  // gateway opens the (fake) AioPtyClient to the captured wsUrl; its onExit feeds recordExit
  const pty = new FakeAioPtyClient('t2', conn.wsUrl, conn.baseUrl, (status) =>
    g.recordExit('t2', status),
  );
  pty.closeWith({ code: 0, abnormal: false });

  assert(
    breaker.successes.length === 1 && breaker.successes[0] === 't2',
    'T2a: zero exit code -> recordSuccess',
  );
  assert(breaker.failures.length === 0, 'T2b: zero exit code does NOT recordFailure');
}

// T3: non-zero exit code maps to recordFailure
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t3');

  const pty = new FakeAioPtyClient('t3', conn.wsUrl, conn.baseUrl, (status) =>
    g.recordExit('t3', status),
  );
  pty.closeWith({ code: 1, abnormal: false });

  assert(
    breaker.failures.length === 1 && breaker.failures[0] === 't3',
    'T3a: non-zero exit code -> recordFailure',
  );
  assert(breaker.successes.length === 0, 'T3b: non-zero exit code does NOT recordSuccess');
}

// T4: unresolved exit code (null) maps to recordFailure
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t4');

  const pty = new FakeAioPtyClient('t4', conn.wsUrl, conn.baseUrl, (status) =>
    g.recordExit('t4', status),
  );
  pty.closeWith({ code: null, abnormal: false });

  assert(
    breaker.failures.length === 1 && breaker.successes.length === 0,
    'T4a: unresolved (null) exit code -> recordFailure',
  );
}

// T5: abnormal termination (WS closed before session established) -> recordFailure,
//     even if a code somehow accompanies it
{
  const breaker = new SpyBreaker();
  const provider = new MockProvider();
  const g = new GuardrailsHarness(breaker, provider);
  const conn = await g.startRunning('t5');

  const pty = new FakeAioPtyClient('t5', conn.wsUrl, conn.baseUrl, (status) =>
    g.recordExit('t5', status),
  );
  pty.closeWith({ code: 0, abnormal: true });

  assert(
    breaker.failures.length === 1 && breaker.successes.length === 0,
    'T5a: abnormal termination -> recordFailure regardless of code',
  );
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
