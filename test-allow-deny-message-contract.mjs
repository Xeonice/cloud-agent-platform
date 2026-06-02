/**
 * Minimal test: "Allow/deny/message decision contract"
 *
 * Exercises:
 *  1. DecisionBehavior is constrained to exactly {allow, deny}
 *  2. Decision carries behavior + optional message
 *  3. DecisionEnvelope wraps {decision} for runner stdout
 *  4. PermissionRequestFrame shape (channel, type, requestId, taskId, toolName, toolInput)
 *  5. DecisionFrame shape (channel, type, requestId, decision)
 *  6. Gateway routing: runner permission_request → fan-out to operators →
 *     operator decision → returned to blocked runner by requestId
 *  7. Approvals are lock-INDEPENDENT (no write-lock check)
 *  8. Any-deny-wins: if ANY contributing decision is deny, the resolved
 *     outcome is deny; allow only when all allow
 *
 * The test uses the compiled contracts dist (no transpile needed) and an
 * in-process simulation of the TerminalGateway routing logic so nothing
 * external needs to run.
 */

// ---------------------------------------------------------------------------
// Load compiled contracts
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractsDist = join(__dirname, 'packages/contracts/dist');

// Dynamic import via file URL so we get ES-module semantics from the dist
const {
  DecisionBehaviorSchema,
  DecisionSchema,
  DecisionEnvelopeSchema,
  PermissionRequestFrameSchema,
  DecisionFrameSchema,
} = await import(join(contractsDist, 'approvals.js'));

const { FRAME_CHANNEL, ControlFrameSchema: _unused } = await import(
  join(contractsDist, 'ws-frames.js')
);

// ---------------------------------------------------------------------------
// Assertion helpers
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

function assertParses(schema, value, label) {
  const result = schema.safeParse(value);
  assert(result.success, label);
}

function assertRejects(schema, value, label) {
  const result = schema.safeParse(value);
  assert(!result.success, label);
}

// ---------------------------------------------------------------------------
// 1. DecisionBehavior: constrained to exactly {allow, deny}
// ---------------------------------------------------------------------------

console.log('\n=== 1. DecisionBehavior schema ===\n');

assertParses(DecisionBehaviorSchema, 'allow', '1a: "allow" is a valid behavior');
assertParses(DecisionBehaviorSchema, 'deny',  '1b: "deny" is a valid behavior');
assertRejects(DecisionBehaviorSchema, 'approve', '1c: "approve" is rejected');
assertRejects(DecisionBehaviorSchema, 'ALLOW',   '1d: upper-case "ALLOW" is rejected');
assertRejects(DecisionBehaviorSchema, '',        '1e: empty string is rejected');
assertRejects(DecisionBehaviorSchema, null,      '1f: null is rejected');

// ---------------------------------------------------------------------------
// 2. Decision: behavior + optional message
// ---------------------------------------------------------------------------

console.log('\n=== 2. Decision schema (behavior + optional message) ===\n');

assertParses(DecisionSchema,
  { behavior: 'allow' },
  '2a: allow without message is valid');

assertParses(DecisionSchema,
  { behavior: 'deny' },
  '2b: deny without message is valid');

assertParses(DecisionSchema,
  { behavior: 'deny', message: 'this command is dangerous' },
  '2c: deny with message is valid');

assertParses(DecisionSchema,
  { behavior: 'allow', message: 'approved' },
  '2d: allow with message is valid');

assertRejects(DecisionSchema,
  { behavior: 'maybe' },
  '2e: unknown behavior is rejected');

assertRejects(DecisionSchema,
  { message: 'no behavior' },
  '2f: missing behavior is rejected');

// ---------------------------------------------------------------------------
// 3. DecisionEnvelope: {decision} wrapper for runner stdout
// ---------------------------------------------------------------------------

console.log('\n=== 3. DecisionEnvelope schema ===\n');

assertParses(DecisionEnvelopeSchema,
  { decision: { behavior: 'allow' } },
  '3a: allow envelope is valid');

assertParses(DecisionEnvelopeSchema,
  { decision: { behavior: 'deny', message: 'blocked by policy' } },
  '3b: deny-with-message envelope is valid');

assertRejects(DecisionEnvelopeSchema,
  { behavior: 'allow' },           // missing wrapper
  '3c: bare decision without envelope wrapper is rejected');

assertRejects(DecisionEnvelopeSchema,
  { decision: { behavior: 'unknown' } },
  '3d: envelope with invalid behavior is rejected');

// ---------------------------------------------------------------------------
// 4. PermissionRequestFrame shape
// ---------------------------------------------------------------------------

console.log('\n=== 4. PermissionRequestFrame schema ===\n');

const VALID_TASK_ID = '00000000-0000-0000-0000-000000000001';

const validPermissionRequest = {
  channel: FRAME_CHANNEL.CONTROL,
  type: 'permission_request',
  requestId: 'req-abc-123',
  taskId: VALID_TASK_ID,
  toolName: 'shell',
  toolInput: { cmd: 'rm -rf /tmp/foo' },
};

assertParses(PermissionRequestFrameSchema, validPermissionRequest,
  '4a: valid permission_request frame parses');

assertRejects(PermissionRequestFrameSchema,
  { ...validPermissionRequest, channel: FRAME_CHANNEL.RAW },
  '4b: raw channel rejected for permission_request');

assertRejects(PermissionRequestFrameSchema,
  { ...validPermissionRequest, requestId: '' },
  '4c: empty requestId rejected');

assertRejects(PermissionRequestFrameSchema,
  { ...validPermissionRequest, taskId: 'not-a-uuid' },
  '4d: non-UUID taskId rejected');

assertRejects(PermissionRequestFrameSchema,
  { ...validPermissionRequest, toolName: '' },
  '4e: empty toolName rejected');

// toolInput is z.unknown() — any value is accepted
assertParses(PermissionRequestFrameSchema,
  { ...validPermissionRequest, toolInput: null },
  '4f: null toolInput accepted (z.unknown)');

// ---------------------------------------------------------------------------
// 5. DecisionFrame shape
// ---------------------------------------------------------------------------

console.log('\n=== 5. DecisionFrame schema ===\n');

const validDecisionFrame = {
  channel: FRAME_CHANNEL.CONTROL,
  type: 'decision',
  requestId: 'req-abc-123',
  decision: { behavior: 'allow' },
};

assertParses(DecisionFrameSchema, validDecisionFrame,
  '5a: valid allow decision frame parses');

assertParses(DecisionFrameSchema,
  { ...validDecisionFrame, decision: { behavior: 'deny', message: 'no' } },
  '5b: deny-with-message decision frame parses');

assertRejects(DecisionFrameSchema,
  { ...validDecisionFrame, requestId: '' },
  '5c: empty requestId in decision frame rejected');

assertRejects(DecisionFrameSchema,
  { ...validDecisionFrame, decision: { behavior: 'unknown' } },
  '5d: invalid behavior in decision frame rejected');

assertRejects(DecisionFrameSchema,
  { ...validDecisionFrame, channel: FRAME_CHANNEL.RAW },
  '5e: raw channel rejected for decision frame');

// ---------------------------------------------------------------------------
// 6 & 7. Gateway routing simulation: permission_request → fan-out → decision
//         + lock-independence
//
// We simulate the TerminalGateway's in-process state to avoid standing up a
// full NestJS server.  The key behaviours from onPermissionRequest /
// onDecision are re-implemented here against the same contracts shapes.
// ---------------------------------------------------------------------------

console.log('\n=== 6 & 7. Gateway routing + lock-independence ===\n');

/**
 * Minimal in-process simulation of the gateway's approval routing.
 *
 * The implementation intentionally mirrors gateway.ts:
 *   - pendingApprovals: Map<requestId, {runner, taskId}>
 *   - onPermissionRequest: runner → records pending, fans out to operators
 *   - onDecision: operator (lock-independent) → correlates by requestId,
 *                 sends decision to runner, broadcasts to operators
 */
class ApprovalRouter {
  pendingApprovals = new Map(); // requestId → { runner, taskId }
  runnerReceived   = [];        // frames delivered to the runner
  operatorsNotified = [];       // frames fanned to operator clients

  // simulate the runner socket: just records what it receives
  runnerSocket = {
    readyState: 1, // OPEN
    received: [],
    send(frame) { this.received.push(frame); },
  };

  // simulate two operator clients (lock-independent: neither holds the write lock)
  opA = { readyState: 1, taskId: VALID_TASK_ID, received: [] };
  opB = { readyState: 1, taskId: null,           received: [] }; // taskId null = any task
  operators = [this.opA, this.opB];

  /**
   * Simulate runner sending a permission_request.
   * Returns false if the frame fails schema validation.
   */
  onPermissionRequest(rawFrame) {
    const result = PermissionRequestFrameSchema.safeParse(rawFrame);
    if (!result.success) return false;
    const frame = result.data;

    this.pendingApprovals.set(frame.requestId, {
      runner: this.runnerSocket,
      taskId: frame.taskId,
    });

    // Fan out to every operator whose taskId matches or is null (any task)
    for (const op of this.operators) {
      if (op.taskId === null || op.taskId === frame.taskId) {
        op.received.push(frame);
      }
    }
    return true;
  }

  /**
   * Simulate an operator (lock-independent) sending a decision.
   * Returns false if the frame fails schema validation or has no pending entry.
   */
  onDecision(rawFrame, isWriter = false /* write lock state — irrelevant */) {
    const result = DecisionFrameSchema.safeParse(rawFrame);
    if (!result.success) return false;
    const frame = result.data;

    const pending = this.pendingApprovals.get(frame.requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(frame.requestId);

    // Return resolved decision to the blocked runner
    pending.runner.received.push(frame);
    // Broadcast to all operators
    for (const op of this.operators) op.received.push(frame);

    return true;
  }
}

// T6a: permission_request from runner is fanned to both operators
{
  const router = new ApprovalRouter();
  const ok = router.onPermissionRequest(validPermissionRequest);
  assert(ok, '6a: permission_request schema validates and is accepted');
  assert(router.opA.received.length === 1, '6b: opA received the permission_request');
  assert(router.opB.received.length === 1, '6c: opB (taskId=null) received the permission_request');
  assert(router.runnerSocket.received.length === 0, '6d: runner has not received anything yet');
  assert(router.pendingApprovals.has('req-abc-123'), '6e: pending approval recorded by requestId');
}

// T6b: operator decision resolves the approval and returns it to the runner
{
  const router = new ApprovalRouter();
  router.onPermissionRequest(validPermissionRequest);

  const decisionFrame = {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'decision',
    requestId: 'req-abc-123',
    decision: { behavior: 'allow' },
  };

  const ok = router.onDecision(decisionFrame);
  assert(ok, '6f: decision is accepted and routed');
  assert(router.runnerSocket.received.length === 1, '6g: decision delivered to runner');
  assert(
    router.runnerSocket.received[0].requestId === 'req-abc-123',
    '6h: decision carries correct requestId',
  );
  assert(
    router.runnerSocket.received[0].decision.behavior === 'allow',
    '6i: decision.behavior is "allow"',
  );
  assert(!router.pendingApprovals.has('req-abc-123'), '6j: pending entry cleared after decision');
}

// T6c: deny decision with message is routed intact
{
  const router = new ApprovalRouter();
  router.onPermissionRequest(validPermissionRequest);

  const denyFrame = {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'decision',
    requestId: 'req-abc-123',
    decision: { behavior: 'deny', message: 'too dangerous' },
  };
  router.onDecision(denyFrame);

  const runnerDecision = router.runnerSocket.received[0];
  assert(runnerDecision.decision.behavior === 'deny', '6k: deny routed to runner');
  assert(runnerDecision.decision.message  === 'too dangerous', '6l: message routed intact');
}

// T7: Lock-independence — decision accepted even when isWriter=false (no lock held)
{
  const router = new ApprovalRouter();
  router.onPermissionRequest(validPermissionRequest);
  // Explicitly passing isWriter=false (simulating a reader / non-lock-holder)
  const ok = router.onDecision(
    { ...validDecisionFrame, requestId: 'req-abc-123' },
    false, // isWriter = false
  );
  assert(ok, '7a: decision accepted WITHOUT holding write lock (lock-independent)');
  assert(router.runnerSocket.received.length === 1, '7b: runner received decision regardless of lock');
}

// T7b: decision with unknown requestId is rejected (no matching pending)
{
  const router = new ApprovalRouter();
  const ok = router.onDecision({
    channel: FRAME_CHANNEL.CONTROL,
    type: 'decision',
    requestId: 'no-such-request',
    decision: { behavior: 'allow' },
  });
  assert(!ok, '7c: decision with unknown requestId is rejected (no pending entry)');
}

// ---------------------------------------------------------------------------
// 8. Any-deny-wins: if ANY contributing decision is deny, outcome is deny
//    This simulates the runner-hook resolution rule documented in the spec.
// ---------------------------------------------------------------------------

console.log('\n=== 8. Any-deny-wins resolution ===\n');

/**
 * Implement the "any deny wins" rule: given multiple Decision objects
 * (e.g. from multiple notification adapter responses), the resolved decision
 * is deny if any are deny; allow only if ALL are allow.
 *
 * @param {Array<{behavior: string, message?: string}>} decisions
 * @returns {{behavior: string, message?: string}}
 */
function resolveDecisions(decisions) {
  const deny = decisions.find((d) => d.behavior === 'deny');
  if (deny) return deny;
  // All allow — return the first (or a synthetic allow)
  return decisions[0] ?? { behavior: 'allow' };
}

// All allow → allow
{
  const resolved = resolveDecisions([
    { behavior: 'allow' },
    { behavior: 'allow' },
  ]);
  assert(resolved.behavior === 'allow', '8a: all-allow resolves to allow');
}

// One deny among allows → deny (any-deny-wins)
{
  const resolved = resolveDecisions([
    { behavior: 'allow' },
    { behavior: 'deny', message: 'blocked' },
    { behavior: 'allow' },
  ]);
  assert(resolved.behavior === 'deny', '8b: one deny in allow set resolves to deny (any-deny-wins)');
  assert(resolved.message === 'blocked', '8c: deny message preserved through resolution');
}

// All deny → deny
{
  const resolved = resolveDecisions([
    { behavior: 'deny', message: 'reason A' },
    { behavior: 'deny', message: 'reason B' },
  ]);
  assert(resolved.behavior === 'deny', '8d: all-deny resolves to deny');
}

// Single deny → deny
{
  const resolved = resolveDecisions([{ behavior: 'deny' }]);
  assert(resolved.behavior === 'deny', '8e: single deny resolves to deny');
}

// Single allow → allow
{
  const resolved = resolveDecisions([{ behavior: 'allow' }]);
  assert(resolved.behavior === 'allow', '8f: single allow resolves to allow');
}

// The resolved decision is a valid Decision schema
{
  const resolved = resolveDecisions([
    { behavior: 'allow' },
    { behavior: 'deny', message: 'policy' },
  ]);
  const result = DecisionSchema.safeParse(resolved);
  assert(result.success, '8g: any-deny-wins output satisfies DecisionSchema');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
