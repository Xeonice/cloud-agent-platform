/**
 * Minimal test: "Blocking hook forwards the approval round-trip"
 *
 * Requirement (approvals contract + terminal.gateway.ts section 6.5):
 *   A blocking Codex PreToolUse/PermissionRequest hook:
 *     1. Sends a `permission_request` control frame to the orchestrator.
 *     2. The orchestrator records the pending approval keyed by `requestId` and
 *        fans the frame out to every authenticated operator watching the task.
 *     3. An operator submits a `decision` frame (lock-INDEPENDENT).
 *     4. The orchestrator correlates by `requestId`, removes the pending entry,
 *        delivers the resolved `decision` back to the exact blocked runner
 *        connection, and broadcasts the decision to operators so duplicate
 *        surfaces clear.
 *     5. The runner hook receives `{decision}` and unblocks, printing the
 *        `DecisionEnvelope` JSON to stdout for Codex.
 *
 * The test exercises the full round-trip in-process using the compiled
 * contracts package (no live server required).
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, 'packages/contracts/dist');

const {
  PermissionRequestFrameSchema,
  DecisionFrameSchema,
  DecisionEnvelopeSchema,
} = await import(join(dist, 'approvals.js'));

const { FRAME_CHANNEL } = await import(join(dist, 'ws-frames.js'));
const { ControlFrameSchema } = await import(join(dist, 'control-frame.js'));

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// In-process simulation of the gateway approval routing (mirrors
// TerminalGateway.onPermissionRequest + onDecision, section 6.5).
// ---------------------------------------------------------------------------

/**
 * Minimal mock WebSocket: tracks sent frames and exposes readyState.
 */
class MockSocket {
  constructor(label) {
    this.label = label;
    this.sent = [];
    this.readyState = 1; // OPEN
    this.OPEN = 1;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

/**
 * Simulates the gateway's approval-routing state machine.
 *
 * Mirrors the production code paths:
 *   onPermissionRequest (runner → pendingApprovals + fan-out to operators)
 *   onDecision          (operator, lock-independent → route to runner + broadcast)
 */
class ApprovalGateway {
  constructor() {
    /** @type {Map<string, { runner: MockSocket, taskId: string }>} */
    this.pendingApprovals = new Map();
  }

  /**
   * Called when an authenticated runner sends a permission_request frame.
   * Mirrors TerminalGateway.onPermissionRequest.
   *
   * @param {object} rawFrame   - unparsed frame object
   * @param {MockSocket} runner - the runner socket
   * @param {MockSocket[]} operators - all authenticated operator sockets for this task
   * @returns {boolean} true if frame is valid and was routed
   */
  onPermissionRequest(rawFrame, runner, operators) {
    // 5.1 — validate against the contracts schema before acting.
    const result = ControlFrameSchema.safeParse(rawFrame);
    if (!result.success) return false;
    const frame = result.data;
    if (frame.type !== 'permission_request') return false;

    // Record pending so the decision can be correlated back.
    this.pendingApprovals.set(frame.requestId, {
      runner,
      taskId: frame.taskId,
    });

    // Fan out to every authenticated operator watching this task (lock-independent).
    for (const op of operators) {
      op.send(JSON.stringify(frame));
    }
    return true;
  }

  /**
   * Called when an authenticated OPERATOR sends a decision frame.
   * Lock-INDEPENDENT: no write-lease check.
   * Mirrors TerminalGateway.onDecision.
   *
   * @param {object} rawFrame       - unparsed frame object
   * @param {MockSocket[]} operators - all authenticated operator sockets (for broadcast)
   * @returns {boolean} true if frame is valid and was routed
   */
  onDecision(rawFrame, operators) {
    // 5.1 — validate.
    const result = ControlFrameSchema.safeParse(rawFrame);
    if (!result.success) return false;
    const frame = result.data;
    if (frame.type !== 'decision') return false;

    const pending = this.pendingApprovals.get(frame.requestId);
    if (!pending) return false; // no matching pending request

    this.pendingApprovals.delete(frame.requestId);

    // Deliver resolved decision to the blocked runner hook.
    pending.runner.send(JSON.stringify(frame));

    // Broadcast to operators so duplicate approval surfaces clear.
    for (const op of operators) {
      op.send(JSON.stringify(frame));
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REQUEST_ID = 'req-hook-42';

const permissionRequestFrame = {
  channel: FRAME_CHANNEL.CONTROL,
  type: 'permission_request',
  requestId: REQUEST_ID,
  taskId: TASK_ID,
  toolName: 'shell',
  toolInput: { cmd: 'git push origin main' },
};

const allowDecisionFrame = {
  channel: FRAME_CHANNEL.CONTROL,
  type: 'decision',
  requestId: REQUEST_ID,
  decision: { behavior: 'allow' },
};

const denyDecisionFrame = {
  channel: FRAME_CHANNEL.CONTROL,
  type: 'decision',
  requestId: REQUEST_ID,
  decision: { behavior: 'deny', message: 'not permitted in CI' },
};

// ---------------------------------------------------------------------------
// Section 1: Contract schema validation (both frame types round-trip)
// ---------------------------------------------------------------------------

console.log('\n=== 1. Contract schema validation ===\n');

{
  const r = PermissionRequestFrameSchema.safeParse(permissionRequestFrame);
  assert(r.success, '1a: permission_request frame validates against contracts schema');
  assert(r.data.type === 'permission_request', '1b: type field is "permission_request"');
  assert(r.data.requestId === REQUEST_ID,       '1c: requestId is preserved');
  assert(r.data.taskId === TASK_ID,             '1d: taskId (UUID) is preserved');
  assert(r.data.toolName === 'shell',           '1e: toolName is preserved');
}

{
  const r = DecisionFrameSchema.safeParse(allowDecisionFrame);
  assert(r.success,                                   '1f: allow decision frame validates');
  assert(r.data.requestId === REQUEST_ID,             '1g: requestId round-trips in decision');
  assert(r.data.decision.behavior === 'allow',        '1h: allow behavior preserved');
}

{
  const r = DecisionFrameSchema.safeParse(denyDecisionFrame);
  assert(r.success,                                   '1i: deny decision frame validates');
  assert(r.data.decision.behavior === 'deny',         '1j: deny behavior preserved');
  assert(r.data.decision.message === 'not permitted in CI', '1k: deny message preserved');
}

// ---------------------------------------------------------------------------
// Section 2: Full allow round-trip
//   runner → permission_request → operators fanned out
//   operator → allow decision → runner unblocked, operators notified
// ---------------------------------------------------------------------------

console.log('\n=== 2. Full allow approval round-trip ===\n');

{
  const gateway = new ApprovalGateway();
  const runner  = new MockSocket('runner');
  const opA     = new MockSocket('opA');
  const opB     = new MockSocket('opB');
  const ops     = [opA, opB];

  // Step 1: runner sends permission_request
  const accepted = gateway.onPermissionRequest(permissionRequestFrame, runner, ops);
  assert(accepted, '2a: permission_request accepted by gateway');

  // Step 2: gateway records pending and fans out to operators
  assert(gateway.pendingApprovals.has(REQUEST_ID), '2b: pending approval recorded by requestId');
  assert(opA.sent.length === 1, '2c: opA received the permission_request fan-out');
  assert(opB.sent.length === 1, '2d: opB received the permission_request fan-out');
  assert(opA.sent[0].type === 'permission_request', '2e: fanned frame type is permission_request');
  assert(opA.sent[0].requestId === REQUEST_ID,      '2f: fanned frame carries requestId');
  assert(runner.sent.length === 0,                  '2g: runner has received nothing yet (blocked)');

  // Step 3: operator submits allow decision (lock-independent)
  const decided = gateway.onDecision(allowDecisionFrame, ops);
  assert(decided, '2h: decision accepted by gateway');

  // Step 4: pending entry cleared
  assert(!gateway.pendingApprovals.has(REQUEST_ID), '2i: pending entry removed after decision');

  // Step 5: runner receives the resolved decision (unblocks the hook)
  assert(runner.sent.length === 1,                        '2j: runner received exactly one decision');
  assert(runner.sent[0].type === 'decision',              '2k: delivered frame type is "decision"');
  assert(runner.sent[0].requestId === REQUEST_ID,         '2l: decision carries correct requestId');
  assert(runner.sent[0].decision.behavior === 'allow',    '2m: decision.behavior is "allow"');

  // Step 6: operators also receive the resolved decision (surfaces clear)
  assert(opA.sent.length === 2, '2n: opA received the decision broadcast (total 2 frames)');
  assert(opB.sent.length === 2, '2o: opB received the decision broadcast (total 2 frames)');
  assert(opA.sent[1].type === 'decision', '2p: second frame to opA is the decision');
}

// ---------------------------------------------------------------------------
// Section 3: Full deny round-trip
// ---------------------------------------------------------------------------

console.log('\n=== 3. Full deny approval round-trip ===\n');

{
  const gateway = new ApprovalGateway();
  const runner  = new MockSocket('runner');
  const op      = new MockSocket('op');

  gateway.onPermissionRequest(permissionRequestFrame, runner, [op]);
  gateway.onDecision(denyDecisionFrame, [op]);

  const runnerDecision = runner.sent[0];
  assert(runnerDecision !== undefined,                         '3a: runner received decision on deny path');
  assert(runnerDecision.decision.behavior === 'deny',          '3b: deny behavior delivered to runner');
  assert(runnerDecision.decision.message === 'not permitted in CI', '3c: deny message delivered intact');
  assert(!gateway.pendingApprovals.has(REQUEST_ID),            '3d: pending entry cleared on deny');
}

// ---------------------------------------------------------------------------
// Section 4: Lock-independence — decision accepted with no write-lock held
// ---------------------------------------------------------------------------

console.log('\n=== 4. Lock-independence of approval decision ===\n');

{
  // In the real gateway, onDecision has NO lease check (7.5 / D7).
  // We simulate by calling onDecision from a client that explicitly
  // does NOT hold any write lease.
  const gateway = new ApprovalGateway();
  const runner  = new MockSocket('runner');
  const reader  = new MockSocket('reader'); // an operator who is NOT the write-lock holder

  gateway.onPermissionRequest(permissionRequestFrame, runner, [reader]);

  // A reader (non-lease-holder) decides — gateway must accept it.
  const decided = gateway.onDecision(allowDecisionFrame, [reader]);
  assert(decided, '4a: decision accepted from a non-lease-holder (lock-independent)');
  assert(runner.sent.length === 1, '4b: runner unblocked even without write-lock');
}

// ---------------------------------------------------------------------------
// Section 5: Stale / unknown requestId rejected
// ---------------------------------------------------------------------------

console.log('\n=== 5. Stale / duplicate / unknown requestId handling ===\n');

{
  const gateway = new ApprovalGateway();
  const runner  = new MockSocket('runner');

  // Decision with no corresponding permission_request
  const decided = gateway.onDecision(allowDecisionFrame, []);
  assert(!decided, '5a: decision with unknown requestId is rejected (no pending entry)');
  assert(runner.sent.length === 0, '5b: runner receives nothing for orphan decision');
}

{
  // Second decision for the same requestId after the first already resolved it
  const gateway = new ApprovalGateway();
  const runner  = new MockSocket('runner');
  const op      = new MockSocket('op');

  gateway.onPermissionRequest(permissionRequestFrame, runner, [op]);
  gateway.onDecision(allowDecisionFrame, [op]);    // first decision — accepted
  const second = gateway.onDecision(allowDecisionFrame, [op]); // duplicate
  assert(!second, '5c: duplicate decision (same requestId) rejected after first resolution');
  assert(runner.sent.length === 1, '5d: runner only receives the first decision');
}

// ---------------------------------------------------------------------------
// Section 6: Runner hook DecisionEnvelope output format
//   After receiving the decision frame the runner hook must emit the
//   {decision} envelope to stdout for Codex to consume.
// ---------------------------------------------------------------------------

console.log('\n=== 6. Runner hook DecisionEnvelope output format ===\n');

{
  // Simulate the runner hook's stdout path: extract the Decision from the
  // received DecisionFrame and wrap it in the DecisionEnvelope.
  const gateway = new ApprovalGateway();
  const runner  = new MockSocket('runner');
  const op      = new MockSocket('op');

  gateway.onPermissionRequest(permissionRequestFrame, runner, [op]);
  gateway.onDecision(allowDecisionFrame, [op]);

  const receivedDecisionFrame = runner.sent[0];

  // The runner hook extracts the decision and wraps it:
  const envelope = { decision: receivedDecisionFrame.decision };
  const r = DecisionEnvelopeSchema.safeParse(envelope);
  assert(r.success,                              '6a: received decision wraps into valid DecisionEnvelope');
  assert(r.data.decision.behavior === 'allow',   '6b: allow behavior survives envelope round-trip');
}

{
  // Same for deny:
  const gateway = new ApprovalGateway();
  const runner  = new MockSocket('runner');
  const op      = new MockSocket('op');

  gateway.onPermissionRequest(permissionRequestFrame, runner, [op]);
  gateway.onDecision(denyDecisionFrame, [op]);

  const receivedDecisionFrame = runner.sent[0];
  const envelope = { decision: receivedDecisionFrame.decision };
  const r = DecisionEnvelopeSchema.safeParse(envelope);
  assert(r.success,                                    '6c: deny decision wraps into valid DecisionEnvelope');
  assert(r.data.decision.behavior === 'deny',          '6d: deny behavior survives envelope round-trip');
  assert(r.data.decision.message === 'not permitted in CI', '6e: deny message survives envelope round-trip');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('\nAll tests PASSED.');
  process.exit(0);
} else {
  console.error('\nSome tests FAILED.');
  process.exit(1);
}
