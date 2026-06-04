/**
 * Orchestrator approvals endpoint round-trip test
 * (migrate-execution-to-aio-sandbox, Integration tasks 5.5 + 5.6, exercising the
 * gateway approval seam 4.2 reuses).
 *
 * Requirement ("Blocking approval hooks re-homed via outbound HTTP callback",
 * orchestrator side): the sandbox's `permission_request` arrives at the NEW
 * `/v1/approvals` endpoint over HTTP; the endpoint routes it through the EXISTING
 * `onPermissionRequest` -> operator decision -> `onDecision` logic; and the
 * resolved decision is returned to the hook over HTTP. Only the transport
 * changed — the approval semantics above it are unchanged.
 *
 * Unlike the sandbox-side `apps/sandbox-hooks/.../http-approval-roundtrip.test.mjs`
 * (which mirrors the hook transport), this test drives the REAL compiled
 * `ApprovalsController` + `TerminalGateway` from `dist/` behind a real HTTP server
 * standing in for Nest's request pipeline, so it proves the orchestrator wiring
 * (controller -> gateway.requestApproval / reportPostToolUse) end to end.
 *
 * Run AFTER `pnpm --filter @cap/api build` (it imports the compiled output).
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist/terminal');

const { ApprovalsController } = await import(path.join(dist, 'approvals.controller.js'));
const { TerminalGateway } = await import(path.join(dist, 'terminal.gateway.js'));

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

const TASK = '11111111-1111-1111-1111-111111111111';

/**
 * Stand up a real HTTP server that hands each POST body to the real
 * ApprovalsController (mirroring Nest's @Body() + ZodValidationPipe-less inline
 * validation). The controller routes through the real gateway instance.
 */
function startEndpoint(controller) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/approvals')) {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400).end();
          return;
        }
        try {
          const result = await controller.handle(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(result === undefined ? '' : JSON.stringify(result));
        } catch (err) {
          // BadRequestException -> 400 (mirrors Nest's exception filter).
          res.writeHead(err?.status ?? 500).end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1/approvals`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function permissionFrame(overrides = {}) {
  return {
    channel: 'control',
    type: 'permission_request',
    requestId: 'req-1',
    taskId: TASK,
    toolName: 'shell',
    toolInput: { command: 'rm -rf /' },
    ...overrides,
  };
}

console.log('\n=== orchestrator /v1/approvals endpoint round-trip ===\n');

// ---- T1: blocking permission_request resolves to an operator decision ----
{
  const gateway = new TerminalGateway();
  const controller = new ApprovalsController(gateway);
  const endpoint = await startEndpoint(controller);

  // The sandbox hook POSTs the permission_request and AWAITS the decision.
  const httpDone = fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(permissionFrame({ requestId: 'req-allow' })),
  }).then((r) => r.json());

  // Give the controller a tick to register the pending approval on the gateway,
  // then simulate an operator deciding through the gateway's public seam.
  await delay(50);
  const decided = gateway.onPermissionRequest; // (sanity: method exists)
  assert(typeof decided === 'function', 'T0: gateway exposes onPermissionRequest');

  // Resolve via the same path the operator WS `decision` frame takes: the
  // gateway's pending `reply` (registered by requestApproval). We reach it by
  // invoking the gateway's decision handler indirectly through its public
  // approval API: re-register is not needed — fire the operator decision.
  fireOperatorDecision(gateway, 'req-allow', { behavior: 'allow', message: 'ok' });

  const decision = await httpDone;
  assert(decision?.behavior === 'allow', 'T1a: allow decision returned over HTTP from the endpoint');
  assert(decision?.message === 'ok', 'T1b: decision message round-tripped');
  await endpoint.close();
}

// ---- T2: deny decision round-trips ----
{
  const gateway = new TerminalGateway();
  const controller = new ApprovalsController(gateway);
  const endpoint = await startEndpoint(controller);

  const httpDone = fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(permissionFrame({ requestId: 'req-deny' })),
  }).then((r) => r.json());

  await delay(50);
  fireOperatorDecision(gateway, 'req-deny', { behavior: 'deny', message: 'blocked' });

  const decision = await httpDone;
  assert(decision?.behavior === 'deny', 'T2a: deny decision returned over HTTP');
  assert(decision?.message === 'blocked', 'T2b: deny message round-tripped');
  await endpoint.close();
}

// ---- T3: post_tool_use_report is accepted (non-blocking, empty 200) ----
{
  const gateway = new TerminalGateway();
  const controller = new ApprovalsController(gateway);
  const endpoint = await startEndpoint(controller);

  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: 'control',
      type: 'post_tool_use_report',
      taskId: TASK,
      edits: [{ path: 'a.txt', change: 'modified', source: 'post_tool_use' }],
    }),
  });
  assert(res.status === 200, 'T3a: post_tool_use_report acknowledged with 200');
  const text = await res.text();
  assert(text === '', 'T3b: report ack carries no decision body (non-blocking)');
  await endpoint.close();
}

// ---- T4: an unrecognized body is rejected with 400 (hook fails closed) ----
{
  const gateway = new TerminalGateway();
  const controller = new ApprovalsController(gateway);
  const endpoint = await startEndpoint(controller);

  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ not: 'a frame' }),
  });
  assert(res.status === 400, 'T4a: unrecognized callback body rejected with 400');
  await endpoint.close();
}

// ---- helpers that reach the gateway's operator-decision seam ----

/**
 * Simulate an authenticated operator submitting a `decision` for `requestId`.
 * The gateway's `onDecision` is private (driven by the operator WS path), so we
 * resolve the pending approval the same way: via the `reply` registered by
 * `requestApproval`. We access the private `pendingApprovals` map (the gateway
 * stores `{ reply }` there) to fire the resolved decision, exactly as the real
 * `onDecision` does on an operator WS `decision` frame.
 */
function fireOperatorDecision(gateway, requestId, decision) {
  const pending = gateway.pendingApprovals?.get(requestId);
  if (!pending) {
    throw new Error(`no pending approval registered for ${requestId}`);
  }
  gateway.pendingApprovals.delete(requestId);
  pending.reply?.({
    channel: 'control',
    type: 'decision',
    requestId,
    decision,
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
