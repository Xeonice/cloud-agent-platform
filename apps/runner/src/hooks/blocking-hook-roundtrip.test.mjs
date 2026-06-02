/**
 * Minimal test for requirement:
 *   "Blocking hook forwards the approval round-trip"
 *
 * Requirement semantics (from permission-request.hook.ts and design D6):
 *   1. The hook forwards the PreToolUse event to the orchestrator via a
 *      transport and blocks until a decision returns.
 *   2. A single `allow` decision produces a `{ decision: { behavior: "allow" } }`
 *      envelope printed to stdout.
 *   3. A single `deny` decision produces `{ decision: { behavior: "deny" } }`.
 *   4. Any-deny-wins: if any contributing decision is `deny`, resolved is `deny`.
 *   5. An invalid behavior (outside allow/deny) is rejected — fail-closed deny.
 *   6. An unparseable orchestrator response is fail-closed deny.
 *   7. An unparseable stdin payload is fail-closed deny (no orchestrator call).
 *   8. The hook BLOCKS (the transport promise must resolve before stdout is written).
 */

import { Readable, Writable } from 'node:stream';
import { z } from 'zod';

// ---- inline the contract schemas (mirrors contract.ts, no transpile needed) ----

const DecisionBehaviorSchema = z.enum(['allow', 'deny']);

const DecisionSchema = z
  .object({
    behavior: DecisionBehaviorSchema,
    message: z.string().optional(),
  })
  .strict();

const DecisionEnvelopeSchema = z
  .object({
    decision: DecisionSchema,
  })
  .strict();

const PreToolUseEventSchema = z
  .object({
    type: z.literal('PreToolUse'),
    taskId: z.string(),
    requestId: z.string(),
    payload: z.unknown(),
  })
  .passthrough();

function parseDecision(input) {
  const result = DecisionSchema.safeParse(input);
  return result.success ? result.data : null;
}

// ---- inline resolveDecisions (mirrors resolve-decision.ts) ----

function resolveDecisions(decisions) {
  if (decisions.length === 0) {
    return { behavior: 'deny' };
  }
  const firstDeny = decisions.find((d) => d.behavior === 'deny');
  if (firstDeny) {
    return firstDeny.message !== undefined
      ? { behavior: 'deny', message: firstDeny.message }
      : { behavior: 'deny' };
  }
  const behavior = 'allow';
  const firstWithMessage = decisions.find((d) => d.message !== undefined);
  return firstWithMessage?.message !== undefined
    ? { behavior, message: firstWithMessage.message }
    : { behavior };
}

// ---- inline the DecisionResponseSchema + toContributingDecisions ----

const DecisionResponseSchema = z.union([
  DecisionSchema,
  z.array(z.unknown()),
]);

function toContributingDecisions(response) {
  const parsed = DecisionResponseSchema.safeParse(response);
  if (!parsed.success) {
    return null;
  }
  if (Array.isArray(parsed.data)) {
    const decisions = [];
    for (const candidate of parsed.data) {
      const decision = parseDecision(candidate);
      if (decision === null) {
        return [{ behavior: 'deny', message: 'rejected malformed contributing decision' }];
      }
      decisions.push(decision);
    }
    return decisions;
  }
  return [parsed.data];
}

// ---- inline runPermissionRequestHook (mirrors permission-request.hook.ts) ----

async function runPermissionRequestHook(event, transport) {
  const response = await transport.requestDecision(event);

  const contributing = toContributingDecisions(response);
  if (contributing === null) {
    return { decision: { behavior: 'deny', message: 'no valid decision returned' } };
  }

  const resolved = resolveDecisions(contributing);

  const validated = parseDecision(resolved);
  if (validated === null) {
    return { decision: { behavior: 'deny', message: 'resolved decision failed validation' } };
  }

  return { decision: validated };
}

// ---- inline main (mirrors permission-request.hook.ts#main) ----

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(transport, stdin, stdout) {
  const raw = await readAll(stdin);

  let event;
  try {
    event = PreToolUseEventSchema.parse(JSON.parse(raw));
  } catch {
    const denied = {
      decision: { behavior: 'deny', message: 'unparseable PreToolUse payload' },
    };
    stdout.write(JSON.stringify(denied));
    return;
  }

  const envelope = await runPermissionRequestHook(event, transport);
  stdout.write(JSON.stringify(envelope));
}

// ---- assertion helpers ----

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

// ---- helpers ----

/** Build a minimal valid PreToolUse event for tests. */
function makeEvent(overrides = {}) {
  return {
    type: 'PreToolUse',
    taskId: 'task-123',
    requestId: 'req-abc',
    payload: { tool: 'shell', command: 'rm -rf /' },
    ...overrides,
  };
}

/** Capture what a main() call writes to stdout. */
async function captureMain(transport, stdinData) {
  const r = new Readable({ read() {} });
  r.push(stdinData);
  r.push(null);

  let out = '';
  const w = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });

  await main(transport, r, w);
  return JSON.parse(out);
}

// ---- tests ----

console.log('\n=== Blocking hook forwards the approval round-trip ===\n');

// T1: allow decision round-trip — hook blocks until transport resolves
{
  const event = makeEvent();
  let receivedEvent = null;
  let resolveDecision;
  const blocked = new Promise((res) => { resolveDecision = res; });

  const transport = {
    requestDecision(ev) {
      receivedEvent = ev;
      return blocked;
    },
  };

  // Start the hook — it must block until the transport resolves.
  let settled = false;
  const hookPromise = runPermissionRequestHook(event, transport).then((r) => {
    settled = true;
    return r;
  });

  // The promise should NOT have settled yet (transport is still blocking).
  await Promise.resolve(); // one microtask tick
  assert(!settled, 'T1a: hook blocks until transport resolves');

  // Now resolve the transport with an allow decision.
  resolveDecision({ behavior: 'allow' });
  const envelope = await hookPromise;

  assert(settled, 'T1b: hook unblocks after transport resolves');
  assert(
    receivedEvent?.type === 'PreToolUse',
    'T1c: transport received the forwarded PreToolUse event',
  );
  assert(
    receivedEvent?.requestId === 'req-abc',
    'T1d: forwarded event carries the correct requestId',
  );
  assert(envelope?.decision?.behavior === 'allow', 'T1e: resolved envelope is allow');
  assert(
    DecisionEnvelopeSchema.safeParse(envelope).success,
    'T1f: envelope validates against DecisionEnvelopeSchema',
  );
}

// T2: deny decision round-trip
{
  const event = makeEvent({ requestId: 'req-deny' });
  const transport = {
    requestDecision: async () => ({ behavior: 'deny', message: 'too dangerous' }),
  };

  const envelope = await runPermissionRequestHook(event, transport);

  assert(envelope?.decision?.behavior === 'deny', 'T2a: resolved envelope is deny');
  assert(envelope?.decision?.message === 'too dangerous', 'T2b: deny message propagated');
}

// T3: any-deny-wins — mixed allow+deny array resolves to deny
{
  const event = makeEvent({ requestId: 'req-mixed' });
  const transport = {
    requestDecision: async () => [
      { behavior: 'allow' },
      { behavior: 'deny', message: 'one deny wins' },
      { behavior: 'allow' },
    ],
  };

  const envelope = await runPermissionRequestHook(event, transport);

  assert(envelope?.decision?.behavior === 'deny', 'T3a: any-deny-wins resolves to deny');
  assert(envelope?.decision?.message === 'one deny wins', 'T3b: first deny message preserved');
}

// T4: all-allow array resolves to allow
{
  const event = makeEvent({ requestId: 'req-all-allow' });
  const transport = {
    requestDecision: async () => [
      { behavior: 'allow' },
      { behavior: 'allow' },
    ],
  };

  const envelope = await runPermissionRequestHook(event, transport);

  assert(envelope?.decision?.behavior === 'allow', 'T4a: all-allow array resolves to allow');
}

// T5: invalid behavior in response (e.g., "approve") → fail-closed deny
{
  const event = makeEvent({ requestId: 'req-invalid' });
  const transport = {
    requestDecision: async () => ({ behavior: 'approve' }), // not in allow|deny
  };

  const envelope = await runPermissionRequestHook(event, transport);

  assert(
    envelope?.decision?.behavior === 'deny',
    'T5a: out-of-range behavior yields fail-closed deny',
  );
}

// T6: malformed (unparseable) orchestrator response → fail-closed deny
{
  const event = makeEvent({ requestId: 'req-unparseable' });
  const transport = {
    requestDecision: async () => null,  // null is not a Decision or array
  };

  const envelope = await runPermissionRequestHook(event, transport);

  assert(
    envelope?.decision?.behavior === 'deny',
    'T6a: unparseable orchestrator response yields fail-closed deny',
  );
}

// T7: invalid stdin payload → fail-closed deny, transport never called
{
  let transportCalled = false;
  const transport = {
    requestDecision: async () => {
      transportCalled = true;
      return { behavior: 'allow' };
    },
  };

  const result = await captureMain(transport, 'NOT VALID JSON {{{}}}');

  assert(result?.decision?.behavior === 'deny', 'T7a: unparseable stdin yields deny');
  assert(!transportCalled, 'T7b: transport never called for invalid stdin');
}

// T8: valid end-to-end through main() including stdin/stdout wiring
{
  const event = makeEvent({ requestId: 'req-e2e' });
  const transport = {
    requestDecision: async () => ({ behavior: 'allow', message: 'looks safe' }),
  };

  const result = await captureMain(transport, JSON.stringify(event));

  assert(result?.decision?.behavior === 'allow', 'T8a: main() end-to-end allow');
  assert(result?.decision?.message === 'looks safe', 'T8b: message propagated through main()');
  assert(
    DecisionEnvelopeSchema.safeParse(result).success,
    'T8c: main() output validates against DecisionEnvelopeSchema',
  );
}

// T9: empty contributions array → fail-closed deny
{
  const event = makeEvent({ requestId: 'req-empty' });
  const transport = {
    requestDecision: async () => [],  // empty array
  };

  const envelope = await runPermissionRequestHook(event, transport);

  assert(
    envelope?.decision?.behavior === 'deny',
    'T9a: empty decisions array yields fail-closed deny',
  );
}

// ---- summary ----

console.log(`\n${'─'.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
