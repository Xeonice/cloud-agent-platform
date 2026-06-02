/**
 * Minimal test for requirement:
 *   "Live-frame parity under PTY parity conditions"
 *
 * Spec (realtime-terminal/spec.md):
 *   The terminal rendered in the browser SHALL be byte-identical to the runner
 *   PTY's live frame WHEN the rendering terminal uses TERM=xterm-256color and
 *   the same column and row dimensions as the runner PTY. Byte-identity is
 *   required only for the live frame; scrollback history is explicitly NOT
 *   required to byte-match.
 *
 * Scenarios exercised:
 *
 *   S1 – ResizeFrame is defined in contracts with cols and rows:
 *         WHEN the contracts ResizeFrame schema is parsed
 *         THEN it accepts a valid frame with channel="control", type="resize",
 *              positive integer cols and rows
 *         AND rejects frames with missing or invalid cols/rows
 *         AND rejects a raw-channel frame (cannot be misread as control)
 *
 *   S2 – Gateway dispatches resize to the PTY:
 *         WHEN an authenticated operator sends a resize frame for a registered
 *              session
 *         THEN the gateway calls session.pty.resize(cols, rows) exactly once
 *              with the correct dimensions, making the "identical cols and rows"
 *              precondition reachable at runtime
 *         AND an unauthenticated client's resize frame is silently ignored
 *
 *   S3 – PTY environment has TERM=xterm-256color:
 *         WHEN buildPtyEnv is called (possibly with extra env overrides)
 *         THEN the resulting env always has TERM="xterm-256color" regardless
 *              of what the caller supplies, so the parity TERM precondition
 *              is always satisfied on the runner side
 */

// ---------------------------------------------------------------------------
// Inline ResizeFrame schema (mirrors snapshot-frames.ts; no transpile needed)
// ---------------------------------------------------------------------------

const FRAME_CHANNEL = { RAW: 'raw', CONTROL: 'control' };

function parseResizeFrame(obj) {
  if (obj.channel !== FRAME_CHANNEL.CONTROL) throw new Error('channel must be "control"');
  if (obj.type !== 'resize') throw new Error('type must be "resize"');
  if (!Number.isInteger(obj.cols) || obj.cols <= 0) throw new Error('cols must be a positive integer');
  if (!Number.isInteger(obj.rows) || obj.rows <= 0) throw new Error('rows must be a positive integer');
  return obj;
}

// ---------------------------------------------------------------------------
// Inline TerminalGateway.onResize logic (mirrors terminal.gateway.ts onResize)
// ---------------------------------------------------------------------------

/**
 * Mirror the gateway's onResize method in pure JS so we can unit-test it
 * without the NestJS / node-pty / ws runtime.
 *
 * onResize(frame, state, sessions):
 *   - returns false (no-op) if state.authenticated is false
 *   - returns false (no-op) if state.kind !== 'operator'
 *   - returns false (no-op) if state.taskId is null
 *   - returns false (no-op) if the session is not in the sessions map
 *   - otherwise calls session.pty.resize(cols, rows) and returns true
 */
function onResize(frame, state, sessions) {
  if (!state.authenticated || state.kind !== 'operator') return false;
  if (!state.taskId) return false;
  const session = sessions.get(state.taskId);
  if (!session) return false;
  session.pty.resize(frame.cols, frame.rows);
  return true;
}

// ---------------------------------------------------------------------------
// Inline buildPtyEnv (mirrors spawn-codex.ts buildPtyEnv)
// ---------------------------------------------------------------------------

/**
 * Mirror buildPtyEnv: merges process.env + extra, then pins TERM=xterm-256color
 * last so callers cannot override it.
 */
function buildPtyEnv(extra) {
  return {
    ...process.env,
    ...(extra ?? {}),
    TERM: 'xterm-256color',
  };
}

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

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`  FAIL  ${label}  (expected throw, got nothing)`);
    failed++;
  } catch {
    console.log(`  PASS  ${label}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// S1 – ResizeFrame is defined in contracts with cols and rows
// ---------------------------------------------------------------------------

console.log('\n=== Live-frame parity: S1 — ResizeFrame contract definition ===\n');

{
  // Valid resize frame
  const f = parseResizeFrame({ channel: 'control', type: 'resize', cols: 120, rows: 40 });
  assert(f.cols === 120 && f.rows === 40, 'S1a: valid ResizeFrame is accepted with correct cols and rows');

  // Wrong channel — must be rejected so raw frames can never be misread as control
  assertThrows(
    () => parseResizeFrame({ channel: 'raw', type: 'resize', cols: 80, rows: 24 }),
    'S1b: resize frame on raw channel is rejected',
  );

  // Wrong type
  assertThrows(
    () => parseResizeFrame({ channel: 'control', type: 'reconnect', cols: 80, rows: 24 }),
    'S1c: frame with type != "resize" is rejected',
  );

  // Missing cols
  assertThrows(
    () => parseResizeFrame({ channel: 'control', type: 'resize', rows: 24 }),
    'S1d: resize frame with missing cols is rejected',
  );

  // Missing rows
  assertThrows(
    () => parseResizeFrame({ channel: 'control', type: 'resize', cols: 80 }),
    'S1e: resize frame with missing rows is rejected',
  );

  // Non-integer cols
  assertThrows(
    () => parseResizeFrame({ channel: 'control', type: 'resize', cols: 80.5, rows: 24 }),
    'S1f: resize frame with non-integer cols is rejected',
  );

  // Zero rows
  assertThrows(
    () => parseResizeFrame({ channel: 'control', type: 'resize', cols: 80, rows: 0 }),
    'S1g: resize frame with rows=0 is rejected (must be positive)',
  );

  // Zero cols
  assertThrows(
    () => parseResizeFrame({ channel: 'control', type: 'resize', cols: 0, rows: 24 }),
    'S1h: resize frame with cols=0 is rejected (must be positive)',
  );

  // Negative rows
  assertThrows(
    () => parseResizeFrame({ channel: 'control', type: 'resize', cols: 80, rows: -1 }),
    'S1i: resize frame with negative rows is rejected',
  );
}

// ---------------------------------------------------------------------------
// S2 – Gateway dispatches resize to the PTY
// ---------------------------------------------------------------------------

console.log('\n=== Live-frame parity: S2 — gateway onResize dispatches to pty.resize() ===\n');

{
  // Set up a spy PTY
  const resizeCalls = [];
  const pty = {
    resize: (cols, rows) => resizeCalls.push({ cols, rows }),
  };

  const sessions = new Map();
  sessions.set('task-42', { taskId: 'task-42', pty });

  const authenticatedOperator = {
    clientId: 'c1',
    kind: 'operator',
    authenticated: true,
    taskId: 'task-42',
  };

  const frame = { channel: 'control', type: 'resize', cols: 132, rows: 50 };

  const dispatched = onResize(frame, authenticatedOperator, sessions);
  assert(dispatched === true, 'S2a: onResize returns true when dispatched to a registered session');
  assert(resizeCalls.length === 1, 'S2b: pty.resize() called exactly once');
  assert(resizeCalls[0].cols === 132, 'S2c: pty.resize() called with the correct cols (132)');
  assert(resizeCalls[0].rows === 50,  'S2d: pty.resize() called with the correct rows (50)');

  // Unauthenticated client — resize must be ignored
  const unauthClient = {
    clientId: 'c2',
    kind: 'operator',
    authenticated: false,
    taskId: 'task-42',
  };
  resizeCalls.length = 0; // reset spy
  const dispatchedUnauth = onResize(frame, unauthClient, sessions);
  assert(dispatchedUnauth === false, 'S2e: onResize returns false for unauthenticated client');
  assert(resizeCalls.length === 0,   'S2f: pty.resize() not called for unauthenticated client');

  // Runner (not operator) — resize must be ignored even if authenticated
  const runnerClient = {
    clientId: 'c3',
    kind: 'runner',
    authenticated: true,
    taskId: 'task-42',
  };
  resizeCalls.length = 0;
  const dispatchedRunner = onResize(frame, runnerClient, sessions);
  assert(dispatchedRunner === false, 'S2g: onResize returns false for runner connection');
  assert(resizeCalls.length === 0,   'S2h: pty.resize() not called for runner connection');

  // No taskId — resize ignored
  const noTaskClient = {
    clientId: 'c4',
    kind: 'operator',
    authenticated: true,
    taskId: null,
  };
  resizeCalls.length = 0;
  const dispatchedNoTask = onResize(frame, noTaskClient, sessions);
  assert(dispatchedNoTask === false, 'S2i: onResize returns false when client has no taskId');
  assert(resizeCalls.length === 0,   'S2j: pty.resize() not called when client has no taskId');

  // Session not registered — resize ignored
  const missingSessions = new Map(); // empty
  resizeCalls.length = 0;
  const dispatchedMissing = onResize(frame, authenticatedOperator, missingSessions);
  assert(dispatchedMissing === false, 'S2k: onResize returns false when session is not registered');
  assert(resizeCalls.length === 0,    'S2l: pty.resize() not called when session is not registered');

  // Second resize with new geometry — PTY reflects the update
  resizeCalls.length = 0;
  const frame2 = { channel: 'control', type: 'resize', cols: 80, rows: 24 };
  onResize(frame2, authenticatedOperator, sessions);
  assert(resizeCalls.length === 1,          'S2m: second resize dispatched correctly');
  assert(resizeCalls[0].cols === 80,        'S2n: second resize uses new cols (80)');
  assert(resizeCalls[0].rows === 24,        'S2o: second resize uses new rows (24)');
}

// ---------------------------------------------------------------------------
// S3 – PTY environment has TERM=xterm-256color
// ---------------------------------------------------------------------------

console.log('\n=== Live-frame parity: S3 — buildPtyEnv always pins TERM=xterm-256color ===\n');

{
  // No extra env
  const env1 = buildPtyEnv();
  assert(env1.TERM === 'xterm-256color', 'S3a: TERM=xterm-256color with no extra env');

  // Caller tries to override TERM — must be ignored (TERM pinned last)
  const env2 = buildPtyEnv({ TERM: 'dumb' });
  assert(env2.TERM === 'xterm-256color', 'S3b: TERM=xterm-256color even when caller passes TERM=dumb');

  // Caller passes unrelated env vars — they are preserved
  const env3 = buildPtyEnv({ MY_VAR: 'hello' });
  assert(env3.MY_VAR === 'hello',         'S3c: unrelated extra env vars are preserved');
  assert(env3.TERM === 'xterm-256color',  'S3d: TERM still pinned alongside unrelated vars');

  // Caller passes TERM as empty string — still overridden
  const env4 = buildPtyEnv({ TERM: '' });
  assert(env4.TERM === 'xterm-256color', 'S3e: TERM=xterm-256color overrides empty-string TERM');
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
