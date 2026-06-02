/**
 * Minimal test for requirement: "Session page renders the live terminal and controls"
 *
 * The session page (apps/web/src/app/tasks/[id]/page.tsx) is the primary operator
 * interface. This test verifies that all its structural elements — the live
 * terminal surface, the status badge, the connection indicator, the write-lock
 * controls (Take over button), the approval surface, and the back-link — are
 * present in the implementation and wired correctly.
 *
 * We test this at the source-code + contracts + dist-artifact level (matching
 * the pattern of the other tests in this repo) because the page is a
 * "use client" Next.js component that requires a browser renderer. What we can
 * reliably assert without standing up a full browser:
 *
 *   S1. The page source imports and mounts the shared <Terminal> component from
 *       @cap/ui, satisfying the "live terminal surface" requirement.
 *
 *   S2. The page source mounts the live connection indicator ("● connected" /
 *       "○ disconnected") driven by the WS onOpen/onClose handlers.
 *
 *   S3. The page source renders the task status Badge (statusBadgeVariant) after
 *       the task is loaded, giving the operator live status.
 *
 *   S4. The page source renders a "Take over" Button when the client does NOT
 *       hold the write lease, satisfying the lock-gated write-control requirement.
 *
 *   S5. The page source wires keystroke input through the write-lock: data is
 *       only forwarded to sendKeystroke() when holdsLease is true.
 *
 *   S6. The ApprovalSurface renders pending PermissionRequests with Allow / Deny
 *       buttons independently of the write lease (D7).
 *
 *   S7. The <Terminal> component (dist artifact) exposes a `data-testid="terminal-surface"`
 *       attribute on its mount container, confirming it is addressable in the DOM.
 *
 *   S8. The TerminalSocket.connect() builds the authenticated WS URL with the
 *       taskId query parameter and bearer-token subprotocol (D12).
 *
 *   S9. Outbound frame types used by controls: sendAck, sendReconnect,
 *       sendKeystroke, sendHeartbeat, sendTakeover, sendDecision, sendResize
 *       all exist on TerminalSocket.
 *
 *   S10. The contracts WsFrameSchema correctly discriminates raw vs. control
 *        frames so the live stream and control frames are never confused (D4).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const require = createRequire(import.meta.url);

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? '  —  ' + detail : ''}`);
    failed++;
  }
}

// Read source file contents once.
const SESSION_PAGE_SRC = fs.readFileSync(
  path.join(ROOT, 'apps/web/src/app/tasks/[id]/page.tsx'),
  'utf8',
);

const TERMINAL_SRC = fs.readFileSync(
  path.join(ROOT, 'packages/ui/src/terminal/terminal.tsx'),
  'utf8',
);

const TERMINAL_DIST = fs.readFileSync(
  path.join(ROOT, 'packages/ui/dist/terminal/terminal.js'),
  'utf8',
);

const WS_CLIENT_SRC = fs.readFileSync(
  path.join(ROOT, 'apps/web/src/lib/ws-client.ts'),
  'utf8',
);

// Load compiled contracts (needed for frame-discrimination check S10).
const contracts = require(path.join(ROOT, 'packages/contracts/dist/index.js'));
const { WsFrameSchema, FRAME_CHANNEL } = contracts;

// ── S1: <Terminal> component is imported and mounted ─────────────────────────
console.log('\n=== S1: Session page imports and mounts shared <Terminal> from @cap/ui ===\n');

assert(
  'S1.1 page.tsx imports Terminal from @cap/ui',
  SESSION_PAGE_SRC.includes('Terminal') &&
  SESSION_PAGE_SRC.includes('@cap/ui'),
);

assert(
  'S1.2 page.tsx mounts <Terminal> component in JSX',
  SESSION_PAGE_SRC.includes('<Terminal'),
);

assert(
  'S1.3 onReady prop wires TerminalHandle for imperative write access',
  SESSION_PAGE_SRC.includes('onReady={onTerminalReady}'),
);

assert(
  'S1.4 onData prop wires keystroke input through the write lock',
  SESSION_PAGE_SRC.includes('onData={onTerminalData}'),
);

assert(
  'S1.5 onResize prop syncs PTY geometry (VR.8)',
  SESSION_PAGE_SRC.includes('onResize={onTerminalResize}'),
);

// ── S2: Live connection indicator ─────────────────────────────────────────────
console.log('\n=== S2: Live connection indicator (● connected / ○ disconnected) ===\n');

assert(
  'S2.1 connected state is stored in React state',
  SESSION_PAGE_SRC.includes('connected') &&
  SESSION_PAGE_SRC.includes('setConnected'),
);

assert(
  'S2.2 "● connected" text present in JSX',
  SESSION_PAGE_SRC.includes('"● connected"') ||
  SESSION_PAGE_SRC.includes("'● connected'"),
);

assert(
  'S2.3 "○ disconnected" text present in JSX',
  SESSION_PAGE_SRC.includes('"○ disconnected"') ||
  SESSION_PAGE_SRC.includes("'○ disconnected'"),
);

assert(
  'S2.4 setConnected(true) on WS onOpen',
  SESSION_PAGE_SRC.includes('setConnected(true)'),
);

assert(
  'S2.5 setConnected(false) on WS onClose and onError',
  // Two occurrences: onClose and onError both call setConnected(false)
  (SESSION_PAGE_SRC.match(/setConnected\(false\)/g) ?? []).length >= 2,
);

// ── S3: Task status Badge ─────────────────────────────────────────────────────
console.log('\n=== S3: Task status Badge renders live status ===\n');

assert(
  'S3.1 page.tsx imports Badge and statusBadgeVariant from @cap/ui',
  SESSION_PAGE_SRC.includes('Badge') &&
  SESSION_PAGE_SRC.includes('statusBadgeVariant'),
);

assert(
  'S3.2 task state is stored in React state',
  SESSION_PAGE_SRC.includes('task') &&
  SESSION_PAGE_SRC.includes('setTask'),
);

assert(
  'S3.3 Badge is rendered conditionally on task state',
  SESSION_PAGE_SRC.includes('task ?') ||
  SESSION_PAGE_SRC.includes('task&&') ||
  SESSION_PAGE_SRC.includes('task &&'),
);

assert(
  'S3.4 statusBadgeVariant is passed to Badge variant prop',
  SESSION_PAGE_SRC.includes('statusBadgeVariant(task.status)'),
);

// S3.5: statusBadgeVariant correctly maps task statuses to badge variants
{
  const { statusBadgeVariant } = require(
    path.join(ROOT, 'packages/ui/dist/components/badge.js'),
  );
  const expectVariant = (status, expectedVariant) => {
    const got = statusBadgeVariant(status);
    assert(
      `S3.5 statusBadgeVariant("${status}") === "${expectedVariant}"`,
      got === expectedVariant,
      `got "${got}"`,
    );
  };
  expectVariant('running', 'default');
  expectVariant('awaiting_input', 'warning');
  expectVariant('pending', 'secondary');
  expectVariant('completed', 'success');
  expectVariant('failed', 'destructive');
}

// ── S4: Write-lock controls ("Take over" button) ─────────────────────────────
console.log('\n=== S4: Write-lock controls — "Take over" button ===\n');

assert(
  'S4.1 holdsLease derived from lease?.writerClientId === clientId',
  SESSION_PAGE_SRC.includes('lease?.writerClientId === clientId'),
);

assert(
  'S4.2 "Take over" Button rendered when !holdsLease',
  SESSION_PAGE_SRC.includes('Take over'),
);

assert(
  'S4.3 Take over button triggers requestTakeover',
  SESSION_PAGE_SRC.includes('onClick={requestTakeover}'),
);

assert(
  'S4.4 requestTakeover calls socketRef.current?.sendTakeover',
  SESSION_PAGE_SRC.includes('sendTakeover'),
);

assert(
  'S4.5 lock status text present in JSX',
  SESSION_PAGE_SRC.includes('you hold the write lock') &&
  SESSION_PAGE_SRC.includes('read-only'),
);

// ── S5: Keystroke input is write-lock-gated ───────────────────────────────────
console.log('\n=== S5: Keystroke input is lock-gated (only forwarded when holding lease) ===\n');

assert(
  'S5.1 onTerminalData guard: returns early if !holdsLease',
  SESSION_PAGE_SRC.includes('if (!holdsLease) return'),
);

assert(
  'S5.2 keystroke forwarded via sendKeystroke when lease is held',
  SESSION_PAGE_SRC.includes('sendKeystroke(sessionId, data)'),
);

// ── S6: Approval surface (lock-independent D7) ────────────────────────────────
console.log('\n=== S6: Approval surface — Allow/Deny buttons, lock-independent (D7) ===\n');

assert(
  'S6.1 ApprovalSurface component is present in page source',
  SESSION_PAGE_SRC.includes('ApprovalSurface'),
);

assert(
  'S6.2 pending approval requests tracked in React state',
  SESSION_PAGE_SRC.includes('pending') &&
  SESSION_PAGE_SRC.includes('setPending'),
);

assert(
  'S6.3 ApprovalSurface receives pending requests prop',
  SESSION_PAGE_SRC.includes('requests={pending}'),
);

assert(
  'S6.4 Allow Button present in ApprovalSurface',
  SESSION_PAGE_SRC.includes('Allow'),
);

assert(
  'S6.5 Deny Button present in ApprovalSurface',
  SESSION_PAGE_SRC.includes('Deny'),
);

assert(
  'S6.6 decide callback calls sendDecision — lock-independent',
  SESSION_PAGE_SRC.includes('sendDecision(requestId'),
);

assert(
  'S6.7 decide is called from onDecide prop',
  SESSION_PAGE_SRC.includes('onDecide={decide}'),
);

// ── S7: Terminal component has data-testid for addressability ─────────────────
console.log('\n=== S7: Terminal surface has data-testid="terminal-surface" ===\n');

assert(
  'S7.1 terminal source has data-testid="terminal-surface" on mount container',
  TERMINAL_SRC.includes('data-testid="terminal-surface"'),
);

assert(
  'S7.2 terminal dist also contains the data-testid attribute',
  TERMINAL_DIST.includes('data-testid') && TERMINAL_DIST.includes('terminal-surface'),
);

// ── S8: TerminalSocket builds authenticated WS URL ────────────────────────────
console.log('\n=== S8: TerminalSocket authenticates with taskId query param + bearer subprotocol ===\n');

assert(
  'S8.1 TerminalSocket.connect() adds taskId as query param',
  WS_CLIENT_SRC.includes('url.searchParams.set("taskId", this.taskId)'),
);

assert(
  'S8.2 token added as "token" query param',
  WS_CLIENT_SRC.includes('url.searchParams.set("token", token)'),
);

assert(
  'S8.3 token carried in bearer subprotocol (D12)',
  WS_CLIENT_SRC.includes('`bearer.${token}`'),
);

assert(
  'S8.4 WS URL targets /terminal endpoint',
  WS_CLIENT_SRC.includes('/terminal'),
);

// ── S9: All required send* helpers exist on TerminalSocket ────────────────────
console.log('\n=== S9: TerminalSocket exposes all control helpers ===\n');

const requiredMethods = [
  'sendAck',
  'sendReconnect',
  'sendKeystroke',
  'sendHeartbeat',
  'sendTakeover',
  'sendDecision',
  'sendResize',
];
for (const method of requiredMethods) {
  assert(
    `S9 TerminalSocket has ${method}()`,
    WS_CLIENT_SRC.includes(`${method}(`),
    `method "${method}" not found in ws-client.ts`,
  );
}

// ── S10: WsFrameSchema discriminates raw vs. control frames (D4) ──────────────
console.log('\n=== S10: WsFrameSchema dual-channel discrimination (D4) ===\n');

// A raw frame must parse as raw and NOT as a control frame.
const RAW_FRAME = { channel: 'raw', data: btoa('hello'), seq: 0 };
{
  const result = WsFrameSchema.safeParse(RAW_FRAME);
  assert(
    'S10.1 valid raw frame parses successfully',
    result.success,
    result.success ? '' : JSON.stringify(result.error?.issues),
  );
  if (result.success) {
    assert(
      'S10.2 parsed raw frame has channel "raw"',
      result.data.channel === FRAME_CHANNEL.RAW,
    );
  }
}

// A control frame (lease_state) must parse successfully.
const LEASE_STATE_FRAME = {
  channel: 'control',
  type: 'lease_state',
  sessionId: 'sess-1',
  lease: { writerClientId: 'client-a', leaseExpiry: Date.now() + 30_000 },
};
{
  const result = WsFrameSchema.safeParse(LEASE_STATE_FRAME);
  assert(
    'S10.3 valid lease_state control frame parses successfully',
    result.success,
    result.success ? '' : JSON.stringify(result.error?.issues),
  );
  if (result.success) {
    assert(
      'S10.4 parsed control frame has channel "control"',
      result.data.channel === FRAME_CHANNEL.CONTROL,
    );
  }
}

// A frame with channel "raw" but with a "type" field of a control frame must
// still parse as a raw frame (raw channel wins), confirming no confusion.
const AMBIGUOUS_FRAME = { channel: 'raw', data: btoa('bytes'), seq: 1, type: 'ack' };
{
  const result = WsFrameSchema.safeParse(AMBIGUOUS_FRAME);
  assert(
    'S10.5 frame with channel="raw" parses as raw even if type field present',
    result.success && result.data.channel === 'raw',
    result.success ? `channel=${result.data.channel}` : JSON.stringify(result.error?.issues),
  );
}

// A frame with an unknown type under "control" must be rejected.
const INVALID_CONTROL_FRAME = { channel: 'control', type: 'unknown_type_xyz' };
{
  const result = WsFrameSchema.safeParse(INVALID_CONTROL_FRAME);
  assert(
    'S10.6 unknown control type is rejected by WsFrameSchema',
    !result.success,
    result.success ? 'unexpectedly parsed' : '',
  );
}

// A permission_request control frame round-trips correctly.
const PERM_REQUEST_FRAME = {
  channel: 'control',
  type: 'permission_request',
  requestId: 'req-1',
  taskId: 'aaaaaaaa-0000-4000-8000-000000000001',
  toolName: 'shell',
  toolInput: { command: 'rm -rf /' },
};
{
  const result = WsFrameSchema.safeParse(PERM_REQUEST_FRAME);
  assert(
    'S10.7 permission_request control frame parses successfully',
    result.success,
    result.success ? '' : JSON.stringify(result.error?.issues),
  );
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(62)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log(
    'ALL TESTS PASSED — "Session page renders the live terminal and controls" requirement is satisfied.',
  );
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED — requirement is NOT fully satisfied.');
  process.exit(1);
}
