/**
 * AIO-sandbox execution-layer end-to-end suite (compose self-host topology).
 *
 * This is the BLACK-BOX counterpart to the in-process `api-e2e.mjs`. It proves
 * the real per-task execution path that the connect-in design (migrate-execution
 * -to-aio-sandbox) hinges on, and which CANNOT be exercised in-process:
 *
 *   The orchestrator must run INSIDE the compose `api` container, ON the `cap-net`
 *   network, with the host docker.sock mounted. Creating a task makes it
 *   dockerode-provision a SIBLING `cap-aio-<taskId>` container on cap-net and dial
 *   that container's terminal `/v1/shell/ws` OUT *by container name* — which only
 *   resolves because the orchestrator is itself on cap-net. A host-side
 *   in-process test (api-e2e.mjs) can never reach `cap-aio-<taskId>` by name, so
 *   the live-sandbox assertions live here and are driven entirely as an external
 *   operator over the api's published :8080 (REST + the /terminal WebSocket).
 *
 * Tests:
 *   (C) create task -> AIO sandbox provisioned -> AioPtyClient connects into its
 *       shell -> an injected command is EXECUTED (proven with arithmetic whose
 *       result is absent from the input, ruling out PTY input-echo).
 *   (D) write-lock: only the lease holder's keystrokes reach the PTY.
 *   (E) codex starts in-sandbox: injecting `codex` triggers crossterm's DSR
 *       cursor-position query; the AioPtyClient CPR injection must unblock it so
 *       codex renders its TUI instead of aborting with a cursor-read error.
 *
 * Topology / prereqs: the compose stack must be UP with a built derived AIO image
 * (AIO_SANDBOX_IMAGE) and the api reachable at `API` (default http://127.0.0.1:8080).
 * The `scripts/aio-e2e.sh` orchestrator builds the images, brings the stack up,
 * runs this suite, and tears it down. When `API` is unreachable every test is
 * SKIPPED (CI without docker / a built sandbox image), never failed.
 *
 * Run (stack already up):
 *   AUTH_TOKEN=... API=http://127.0.0.1:8080 node --test --test-force-exit test/aio-e2e.mjs
 * Or one-shot (build + up + run + down):
 *   pnpm --filter @cap/api test:e2e:aio
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const API = process.env.API ?? 'http://127.0.0.1:8080';
const WS_BASE = API.replace(/^http/, 'ws');
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? 'dev-local-operator-token-change-me';

const CONTROL = 'control';
const RAW = 'raw';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const send = (ws, frame) => ws.send(JSON.stringify(frame));
const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };

// Whole-suite gate: if the compose api is not reachable, SKIP (don't fail) — this
// is the CI-without-a-live-sandbox path. `scripts/aio-e2e.sh` ensures it is up.
const SKIP = await (async () => {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? false : `api at ${API} returned ${r.status}`;
  } catch {
    return `api not reachable at ${API} — bring the compose stack up (scripts/aio-e2e.sh)`;
  }
})();
if (SKIP) console.log(`# aio-e2e: SKIP — ${SKIP}`);

// AIO sandbox provisioning + boot can take tens of seconds; the live PTY round
// trips are quick once up. Generous bound, polled.
const PROVISION_TIMEOUT_MS = 120_000;

async function waitFor(predicate, { timeoutMs = PROVISION_TIMEOUT_MS, stepMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(stepMs);
  }
  return false;
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Create a repo + task via REST. Creating the task triggers admit -> provision. */
async function createTask(prompt = 'aio-e2e') {
  const repoRes = await fetch(`${API}/repos`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: `e2e-${randomUUID().slice(0, 6)}`, gitSource: 'https://x/y.git' }),
  });
  assert.ok(repoRes.ok, `POST /repos -> ${repoRes.status}`);
  const repo = await repoRes.json();
  const taskRes = await fetch(`${API}/repos/${repo.id}/tasks`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ prompt }),
  });
  assert.ok(taskRes.ok, `POST /repos/:id/tasks -> ${taskRes.status}`);
  const task = await taskRes.json();
  return task.id;
}

/** An operator: authenticated at connect time (token on URL), collects raw output. */
async function startOperator(taskId, { takeover = true } = {}) {
  const ws = await openWs(`${WS_BASE}/terminal?taskId=${taskId}&token=${encodeURIComponent(AUTH_TOKEN)}`);
  let output = '';
  ws.on('message', (buf) => {
    let frame;
    try {
      frame = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (frame.channel === RAW) output += unb64(frame.data);
  });
  send(ws, { channel: CONTROL, type: 'connect_auth', token: AUTH_TOKEN, taskId });
  if (takeover) {
    send(ws, {
      channel: CONTROL,
      type: 'takeover_request',
      sessionId: taskId,
      clientId: `op-${randomUUID().slice(0, 6)}`,
    });
  }
  return {
    ws,
    getOutput: () => output,
    keystroke: (text) =>
      send(ws, { channel: CONTROL, type: 'keystroke', sessionId: taskId, data: b64(text) }),
    close: () => ws.close(),
  };
}

// ── (C) provision a real AIO sandbox; an injected command is EXECUTED ─────────
test('C. creating a task provisions an AIO sandbox whose shell EXECUTES injected commands', { skip: SKIP }, async (t) => {
  const taskId = await createTask();
  const operator = await startOperator(taskId);
  t.after(() => operator.close());

  // Arithmetic whose RESULT is absent from the INPUT: seeing it proves the AIO
  // shell executed the command, ruling out mere PTY input-echo of the keystrokes.
  const a = 60070;
  const b = 9913;
  const result = String(a + b); // 69983
  const inputLine = `echo RES=$((${a} + ${b}))`;
  assert.ok(!inputLine.includes(result), 'invariant: result must not appear in the injected input');

  // Re-inject on a poll so we don't race provisioning + session establishment;
  // once the AioPtyClient session is live the keystroke reaches the shell.
  const executed = await waitFor(() => {
    operator.keystroke(`${inputLine}\n`);
    return operator.getOutput().includes(`RES=${result}`);
  });
  assert.ok(
    executed,
    `the provisioned AIO sandbox's shell should EXECUTE the injected command (expected RES=${result}); ` +
      `last output tail: ${JSON.stringify(operator.getOutput().slice(-200))}`,
  );
});

// ── (D) write-lock gate: a non-writer's keystrokes never reach the PTY ────────
test('D. write-lock: a reader without the lease cannot inject commands', { skip: SKIP }, async (t) => {
  const taskId = await createTask();
  const writer = await startOperator(taskId, { takeover: true });
  const reader = await startOperator(taskId, { takeover: false });
  t.after(() => {
    writer.close();
    reader.close();
  });

  const wMark = `WRITER_${randomUUID().slice(0, 6)}`;
  const rMark = `READER_${randomUUID().slice(0, 6)}`;
  const writerSeen = await waitFor(() => {
    writer.keystroke(`echo ${wMark}\n`);
    reader.keystroke(`echo ${rMark}\n`); // must be dropped (no lease)
    return writer.getOutput().includes(wMark);
  });
  assert.ok(writerSeen, 'the lease holder can inject commands');
  await delay(1000); // give any (wrongly) routed reader keystroke time to echo
  assert.ok(
    !writer.getOutput().includes(rMark) && !reader.getOutput().includes(rMark),
    'a reader without the lease cannot inject — its keystrokes never reach the PTY',
  );
});

// ── (E) codex starts in-sandbox via the AioPtyClient CPR injection ────────────
test('E. codex starts in the AIO sandbox (AioPtyClient CPR injection unblocks crossterm)', { skip: SKIP }, async (t) => {
  const taskId = await createTask('codex');
  const operator = await startOperator(taskId);
  t.after(() => operator.close());

  // Confirm the shell is live first, so a codex failure later is codex-specific
  // and not just an unprovisioned session.
  const ready = `READY_${randomUUID().slice(0, 6)}`;
  const shellLive = await waitFor(() => {
    operator.keystroke(`echo ${ready}\n`);
    return operator.getOutput().includes(ready);
  });
  assert.ok(shellLive, 'shell must be live before launching codex');

  // Launch codex in-shell. crossterm emits a DSR cursor-position query (\x1b[6n)
  // on startup and ABORTS with "cursor position could not be read" unless a CPR
  // reply arrives; the AioPtyClient must inject the synthetic CPR (\x1b[1;1R).
  const before = operator.getOutput().length;
  operator.keystroke('codex\n');
  // codex needs a few seconds to start, probe the cursor, and render (or fail).
  const rendered = await waitFor(
    () => {
      const out = operator.getOutput().slice(before);
      return /welcome to codex|openai|sign in|\/help|to get started/i.test(out) || out.includes('\x1b[?1049h');
    },
    { timeoutMs: 30_000 },
  );
  const codexOut = operator.getOutput().slice(before);
  const hasCursorError = /cursor position could not be read/i.test(codexOut);

  assert.ok(!hasCursorError, 'CPR injection must prevent the crossterm cursor-position read error');
  assert.ok(
    rendered,
    `codex should render its TUI in the AIO sandbox; last output tail: ${JSON.stringify(codexOut.slice(-200))}`,
  );
});
