/**
 * Codex 0.131 hook-protocol adapter unit test
 * (harden-aio-execution, Track hooks-0131-adapter, task 5.3).
 *
 * Requirement (agent-events-and-approvals / aio-sandbox-execution
 * "Hook adapter speaks the codex 0.131 stdin/stdout protocol"):
 *   Given a codex `0.131` stdin payload, the adapter parses it (INCLUDING
 *   `tool_name` and `tool_input`), translates it to cap's `permission_request`
 *   frame for the internal sandbox approval round-trip, and emits the codex
 *   `0.131` decision form (`{hookSpecificOutput:{hookEventName,
 *   permissionDecision:"allow"|"deny", permissionDecisionReason?}}`, or exit `0`
 *   allow / exit `2` + stderr deny). This proves the adapter CONTRACT independent
 *   of codex actually firing the hook.
 *
 * This test is dependency-free (Node built-ins only) so it runs without an
 * installed toolchain — the same convention as `http-approval-roundtrip.test.mjs`
 * (the real `permission-request.hook.ts` imports `@cap/contracts`/`zod` and so
 * cannot be imported here without the transpiled build). The translation +
 * decision-emission logic below is kept in LOCK-STEP with that source.
 */

import { randomUUID } from 'node:crypto';

// ---- assertion helpers ----

let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ---- adapter logic (mirrors permission-request.hook.ts task 5.2) ----

const FRAME_CHANNEL_CONTROL = 'control';
const DEFAULT_HOOK_EVENT_NAME = 'PreToolUse';
const NIL_TASK_ID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the codex 0.131 stdin payload; `tool_name` is the only required field. */
function parseCodex0131Stdin(raw) {
  const payload = JSON.parse(raw);
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('not an object');
  }
  if (typeof payload.tool_name !== 'string' || payload.tool_name.length === 0) {
    throw new Error('missing tool_name');
  }
  return payload;
}

/** Translate a codex 0.131 payload into cap's permission_request frame. */
function codex0131ToPermissionRequestFrame(payload, taskId) {
  const requestId =
    payload.tool_use_id ?? payload.turn_id ?? payload.session_id ?? randomUUID();
  const candidateTaskId = taskId.length > 0 ? taskId : NIL_TASK_ID;
  // Mirror PermissionRequestFrameSchema's required shape.
  if (!UUID_RE.test(candidateTaskId)) {
    throw new Error('taskId is not a uuid');
  }
  return {
    channel: FRAME_CHANNEL_CONTROL,
    type: 'permission_request',
    requestId,
    taskId: candidateTaskId,
    toolName: payload.tool_name,
    toolInput: payload.tool_input ?? null,
  };
}

/** Render a cap decision into the codex 0.131 JSON decision form. */
function toCodex0131Decision(decision, hookEventName = DEFAULT_HOOK_EVENT_NAME) {
  return {
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: decision.behavior,
      ...(decision.message !== undefined
        ? { permissionDecisionReason: decision.message }
        : {}),
    },
  };
}

/** Emit a decision in both 0.131 channels; returns {json, exitCode, stderr}. */
function emitCodex0131Decision(decision, hookEventName) {
  const json = toCodex0131Decision(decision, hookEventName);
  if (decision.behavior === 'deny') {
    return { json, exitCode: 2, stderr: decision.message ?? 'denied by approval policy' };
  }
  return { json, exitCode: 0, stderr: '' };
}

/**
 * End-to-end adapter: parse 0.131 stdin -> cap frame -> (stub round-trip) ->
 * 0.131 decision. `decide` stands in for the cap-side approval round-trip
 * (proven separately by http-approval-roundtrip.test.mjs).
 */
function runAdapter(raw, taskId, decide) {
  const payload = parseCodex0131Stdin(raw);
  const hookEventName = payload.hook_event_name ?? DEFAULT_HOOK_EVENT_NAME;
  const frame = codex0131ToPermissionRequestFrame(payload, taskId);
  const decision = decide(frame);
  return { frame, ...emitCodex0131Decision(decision, hookEventName) };
}

// ---- fixtures ----

function stdin0131(overrides = {}) {
  return JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/gem/workspace',
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.5',
    permission_mode: 'default',
    turn_id: 'turn-1',
    tool_name: 'shell',
    tool_use_id: 'call-abc',
    tool_input: { command: 'rm -rf /' },
    ...overrides,
  });
}

const TASK_ID = '11111111-1111-1111-1111-111111111111';

console.log('\n=== codex 0.131 hook adapter contract ===\n');

// T1: parses the 0.131 stdin (incl tool_name/tool_input) -> cap frame.
{
  const { frame } = runAdapter(stdin0131(), TASK_ID, () => ({ behavior: 'allow' }));
  check(frame.channel === 'control', 'T1a: frame channel is control');
  check(frame.type === 'permission_request', 'T1b: frame type is permission_request');
  check(frame.toolName === 'shell', 'T1c: tool_name -> toolName');
  check(
    frame.toolInput && frame.toolInput.command === 'rm -rf /',
    'T1d: tool_input forwarded verbatim as toolInput',
  );
  check(frame.taskId === TASK_ID, 'T1e: cap TASK_ID carried onto the frame');
  check(frame.requestId === 'call-abc', 'T1f: tool_use_id used as the requestId correlation');
}

// T2: allow decision -> 0.131 JSON form + exit 0, no stderr.
{
  const out = runAdapter(stdin0131(), TASK_ID, () => ({ behavior: 'allow', message: 'ok' }));
  check(
    out.json.hookSpecificOutput.permissionDecision === 'allow',
    'T2a: emits permissionDecision allow',
  );
  check(
    out.json.hookSpecificOutput.hookEventName === 'PreToolUse',
    'T2b: echoes the hookEventName',
  );
  check(
    out.json.hookSpecificOutput.permissionDecisionReason === 'ok',
    'T2c: decision message -> permissionDecisionReason',
  );
  check(out.exitCode === 0, 'T2d: allow exits 0');
  check(out.stderr === '', 'T2e: allow writes no stderr');
}

// T3: deny decision -> 0.131 JSON form + exit 2 + stderr reason.
{
  const out = runAdapter(stdin0131({ tool_use_id: 'call-deny' }), TASK_ID, () => ({
    behavior: 'deny',
    message: 'blocked by policy',
  }));
  check(
    out.json.hookSpecificOutput.permissionDecision === 'deny',
    'T3a: emits permissionDecision deny',
  );
  check(
    out.json.hookSpecificOutput.permissionDecisionReason === 'blocked by policy',
    'T3b: deny reason -> permissionDecisionReason',
  );
  check(out.exitCode === 2, 'T3c: deny exits 2');
  check(out.stderr === 'blocked by policy', 'T3d: deny writes the reason to stderr');
}

// T4: requestId falls back through turn_id -> session_id -> generated uuid.
{
  const noUseId = runAdapter(
    stdin0131({ tool_use_id: undefined }),
    TASK_ID,
    () => ({ behavior: 'allow' }),
  );
  check(noUseId.frame.requestId === 'turn-1', 'T4a: falls back to turn_id when tool_use_id absent');

  const onlySession = runAdapter(
    stdin0131({ tool_use_id: undefined, turn_id: undefined }),
    TASK_ID,
    () => ({ behavior: 'allow' }),
  );
  check(
    onlySession.frame.requestId === 'sess-1',
    'T4b: falls back to session_id when tool_use_id+turn_id absent',
  );

  const generated = runAdapter(
    stdin0131({ tool_use_id: undefined, turn_id: undefined, session_id: undefined }),
    TASK_ID,
    () => ({ behavior: 'allow' }),
  );
  check(
    UUID_RE.test(generated.frame.requestId),
    'T4c: generates a uuid requestId when codex sends no correlation id',
  );
}

// T5: missing cap TASK_ID -> nil-uuid fallback keeps the frame schema-valid
//     (forwards rather than failing open).
{
  const { frame } = runAdapter(stdin0131(), '', () => ({ behavior: 'allow' }));
  check(frame.taskId === NIL_TASK_ID, 'T5a: nil-uuid taskId fallback when TASK_ID is unset');
  check(UUID_RE.test(frame.taskId), 'T5b: nil-uuid fallback is still a valid uuid');
}

// T6: unparseable / non-0.131 stdin throws so the CLI fails closed (deny).
{
  let threw = false;
  try {
    parseCodex0131Stdin('not json');
  } catch {
    threw = true;
  }
  check(threw, 'T6a: unparseable stdin is rejected (CLI fails closed -> deny)');

  let threwNoTool = false;
  try {
    parseCodex0131Stdin(JSON.stringify({ session_id: 'x' }));
  } catch {
    threwNoTool = true;
  }
  check(threwNoTool, 'T6b: payload with no tool_name is rejected (fails closed)');
}

// T7: tool_input is preserved opaquely (non-shell tool with structured input).
{
  const { frame } = runAdapter(
    stdin0131({ tool_name: 'apply_patch', tool_input: { path: 'a.ts', patch: '@@' } }),
    TASK_ID,
    () => ({ behavior: 'allow' }),
  );
  check(frame.toolName === 'apply_patch', 'T7a: non-shell tool_name carried');
  check(
    frame.toolInput && frame.toolInput.path === 'a.ts' && frame.toolInput.patch === '@@',
    'T7b: structured tool_input forwarded verbatim for operator review',
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
