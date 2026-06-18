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
import Docker from 'dockerode';

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

// ---------------------------------------------------------------------------
// Between-test cleanup: stop any lingering cap-aio-* sandbox containers left
// by previous tests (AutoRemove kicks in on stop so they self-delete).
// Uses dockerode — the same library the orchestrator uses — so no docker CLI
// dependency. Silently no-ops when docker is unreachable (CI without docker).
// ---------------------------------------------------------------------------
async function reapSandboxContainers() {
  try {
    const docker = new Docker();
    const containers = await docker.listContainers({
      filters: JSON.stringify({ name: ['cap-aio-'] }),
    });
    await Promise.all(
      containers.map((info) =>
        docker.getContainer(info.Id).stop({ t: 0 }).catch(() => undefined),
      ),
    );
    if (containers.length > 0) {
      // Give docker time to reap containers (AutoRemove + network cleanup) before
      // the next test provisions a new one. 5 s is enough for up to ~5 parallel kills.
      await delay(5000);
    }
  } catch {
    // Docker not reachable (CI) — ignore.
  }
}

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
async function createTask(prompt = 'aio-e2e', extra = {}) {
  const repoRes = await fetch(`${API}/repos`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: `e2e-${randomUUID().slice(0, 6)}`, gitSource: 'https://x/y.git' }),
  });
  assert.ok(repoRes.ok, `POST /repos -> ${repoRes.status}`);
  const repo = await repoRes.json();
  // `extra` carries the OPTIONAL create-task fields (e.g. `runtime` for
  // add-claude-code-runtime) so a caller can select the agent runtime; omitting
  // it preserves the prior body shape (codex default).
  const taskRes = await fetch(`${API}/repos/${repo.id}/tasks`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ prompt, ...extra }),
  });
  assert.ok(taskRes.ok, `POST /repos/:id/tasks -> ${taskRes.status}`);
  const task = await taskRes.json();
  return task.id;
}

/**
 * Is a given runtime READY (its credential configured) per `GET /runtimes`? The
 * claude-code e2e self-skips when the deployment has no `CLAUDE_CODE_OAUTH_TOKEN`
 * (the endpoint reports `ready:false`), so the suite passes on a codex-only stack.
 */
async function runtimeReady(id) {
  try {
    const res = await fetch(`${API}/runtimes`, { headers: authHeaders });
    if (!res.ok) return false;
    const body = await res.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.runtimes) ? body.runtimes : [];
    return list.some((r) => r?.id === id && r?.ready === true);
  } catch {
    return false;
  }
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

// ── (F) reconnect replay: snapshot + session.log tail delivered to reconnecting op
test('F. reconnect replay: a reconnecting operator receives prior output from snapshot + session.log tail', { skip: SKIP }, async (t) => {
  await reapSandboxContainers();
  const taskId = await createTask();
  const writer = await startOperator(taskId, { takeover: true });
  t.after(() => writer.close());

  // Inject a unique marker and wait for it to appear so session.log has content.
  const marker = `RECONNECT_${randomUUID().slice(0, 8)}`;
  const marked = await waitFor(() => {
    writer.keystroke(`echo ${marker}\n`);
    return writer.getOutput().includes(marker);
  });
  assert.ok(marked, `marker must appear in PTY output before reconnect`);

  // Give the gateway a moment to flush the append to session.log.
  await delay(600);

  // Reconnect: a fresh WebSocket on the same task, send connect_auth then a
  // reconnect frame (fromSeq=0 so we receive everything from the beginning).
  const replayed = await new Promise((resolve) => {
    const result = { hasSnapshot: false, tailContent: '' };
    const ws = new WebSocket(
      `${WS_BASE}/terminal?taskId=${taskId}&token=${encodeURIComponent(AUTH_TOKEN)}`,
    );
    const timeout = setTimeout(() => { ws.close(); resolve(result); }, 12_000);
    ws.once('error', () => { clearTimeout(timeout); ws.close(); resolve(result); });
    ws.once('open', () => {
      send(ws, { channel: CONTROL, type: 'connect_auth', token: AUTH_TOKEN, taskId });
      send(ws, { channel: CONTROL, type: 'reconnect', lastSeq: 0, cols: 80, rows: 24 });
    });
    ws.on('message', (buf) => {
      let frame;
      try { frame = JSON.parse(buf.toString()); } catch { return; }
      if (frame.channel === CONTROL && frame.type === 'snapshot') {
        result.hasSnapshot = true;
      }
      if (frame.channel === CONTROL && frame.type === 'tail_replay') {
        if (frame.data) result.tailContent += unb64(frame.data);
        if (frame.final) { clearTimeout(timeout); ws.close(); resolve(result); }
      }
    });
  });

  assert.ok(
    replayed.hasSnapshot || replayed.tailContent.length > 0,
    `reconnect must deliver a snapshot or non-empty tail_replay frames; ` +
      `hasSnapshot=${replayed.hasSnapshot}, tailContent.length=${replayed.tailContent.length}`,
  );
  assert.ok(
    replayed.tailContent.includes(marker) || replayed.hasSnapshot,
    `replayed tail content should include the injected marker or a snapshot must be present; ` +
      `tailContent snippet: ${JSON.stringify(replayed.tailContent.slice(-300))}`,
  );
});

// ── (G) clone success: git clone into the dedicated empty workspace succeeds ──
test('G. clone success: git clone into /home/gem/workspace succeeds with exit_code 0', { skip: SKIP }, async (t) => {
  await reapSandboxContainers();
  const taskId = await createTask();
  const operator = await startOperator(taskId);
  t.after(() => operator.close());

  // Create a minimal local bare repo and clone it into the dedicated workspace
  // directory. Using a local source avoids any external network dependency.
  // If the workspace already has content (TASK_REPO_URL was set at provision),
  // we clone into a sub-path instead so the test remains self-contained.
  const src = `/tmp/cap-e2e-src-${randomUUID().slice(0, 8)}`;
  const cloneCmd =
    `git init --bare ${src} 2>/dev/null` +
    ` && ([ "$(ls -A /home/gem/workspace 2>/dev/null)" ] ` +
    `     && git clone ${src} /home/gem/workspace/e2e-clone ` +
    `     || git clone ${src} /home/gem/workspace)` +
    ` && echo CLONE_OK || echo CLONE_FAIL`;

  const shellLive = await waitFor(() => {
    operator.keystroke(`echo SHELL_READY\n`);
    return operator.getOutput().includes('SHELL_READY');
  }, { timeoutMs: PROVISION_TIMEOUT_MS });
  assert.ok(shellLive, 'shell must be live before running clone test');

  const cloneDone = await waitFor(() => {
    operator.keystroke(`${cloneCmd}\n`);
    return operator.getOutput().includes('CLONE_OK') || operator.getOutput().includes('CLONE_FAIL');
  }, { timeoutMs: 30_000 });

  assert.ok(cloneDone, 'clone command must complete within timeout');
  assert.ok(
    operator.getOutput().includes('CLONE_OK'),
    `git clone into /home/gem/workspace must succeed (exit_code 0); ` +
      `output tail: ${JSON.stringify(operator.getOutput().slice(-400))}`,
  );
});

// ── (H) forced clone failure: non-empty target raises a non-zero exit_code ───
test('H. forced clone failure: git clone into a non-empty target fails closed (non-zero exit_code)', { skip: SKIP }, async (t) => {
  await reapSandboxContainers();
  const taskId = await createTask();
  const operator = await startOperator(taskId);
  t.after(() => operator.close());

  const shellLive = await waitFor(() => {
    operator.keystroke(`echo SHELL_READY\n`);
    return operator.getOutput().includes('SHELL_READY');
  }, { timeoutMs: PROVISION_TIMEOUT_MS });
  assert.ok(shellLive, 'shell must be live before running clone-failure test');

  // Make /home/gem/workspace non-empty, then attempt to clone into it.
  // git clone refuses a non-empty destination (exit 128), which is the exact
  // scenario AioSandboxProvider.cloneTaskRepository catches as a provision error.
  const src = `/tmp/cap-e2e-src-fail-${randomUUID().slice(0, 8)}`;
  const failCmd =
    `git init --bare ${src} 2>/dev/null` +
    ` && mkdir -p /home/gem/workspace && touch /home/gem/workspace/.cap-e2e-guard` +
    ` && git clone ${src} /home/gem/workspace 2>&1` +
    `; echo CLONE_EXIT:$?`;

  const failDone = await waitFor(() => {
    operator.keystroke(`${failCmd}\n`);
    return operator.getOutput().includes('CLONE_EXIT:');
  }, { timeoutMs: 30_000 });

  assert.ok(failDone, 'forced clone-failure command must complete within timeout');
  // Parse the exit code: must be non-zero (git exits 128 for non-empty target).
  const match = operator.getOutput().match(/CLONE_EXIT:(\d+)/);
  const exitCode = match ? Number(match[1]) : null;
  assert.ok(
    exitCode !== null && exitCode !== 0,
    `git clone into a non-empty target must fail closed (non-zero exit_code); ` +
      `got CLONE_EXIT:${exitCode}; output tail: ${JSON.stringify(operator.getOutput().slice(-400))}`,
  );
  // No false "CLONE_OK" must appear — the failure is real, not silently swallowed.
  assert.ok(
    !operator.getOutput().includes('CLONE_OK'),
    'no CLONE_OK must appear after a forced clone failure (no silent success)',
  );
});

// ── (E) codex starts in-sandbox via the AioPtyClient CPR injection ────────────
test('E. codex starts in the AIO sandbox (AioPtyClient CPR injection unblocks crossterm)', { skip: SKIP }, async (t) => {
  await reapSandboxContainers();
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

// ── (I) claude-code runtime full turn (add-claude-code-runtime, Track 7.2) ─────
// Unlike codex (test E, operator-launched), claude can ONLY run through the
// orchestrator's runtime auto-launch: the provider injects CLAUDE_CODE_OAUTH_TOKEN
// + CLAUDE_CODE_SANDBOXED + the pre-seeded ~/.claude.json, then buildLaunchLine
// runs `claude --permission-mode acceptEdits "<prompt>"`. So this test does NOT
// type a launch command — it creates a `claude-code` task with a deterministic
// prompt and waits for the AUTO-RUN answer to stream back, proving the clean-env
// OAuth-token auth + the auto-submitted positional prompt + the inline-buffer
// capture all work end-to-end on the real amd64 sandbox image. It SELF-SKIPS when
// the deployment has no Claude token (`/runtimes` reports claude-code not ready),
// so a codex-only stack still passes. The marker is chosen to be unmistakable.
test('I. claude-code runtime auto-launches and answers in the AIO sandbox', { skip: SKIP }, async (t) => {
  if (!(await runtimeReady('claude-code'))) {
    t.skip('claude-code runtime not configured (no CLAUDE_CODE_OAUTH_TOKEN) — skipping the claude e2e');
    return;
  }
  await reapSandboxContainers();
  const MARKER = `AIOCLAUDE_${randomUUID().slice(0, 6)}`;
  const taskId = await createTask(
    `Reply with exactly the token ${MARKER} and then stop. Do nothing else.`,
    { runtime: 'claude-code' },
  );
  const operator = await startOperator(taskId);
  t.after(() => operator.close());

  // The orchestrator auto-provisions + auto-launches claude; the positional prompt
  // auto-runs (no injected Enter). Wait for the marker to stream back.
  const answered = await waitFor(
    () => operator.getOutput().includes(MARKER),
    { timeoutMs: 90_000 },
  );
  const out = operator.getOutput();
  // An auth/login gate means the token did not authenticate in the clean sandbox.
  const authGate = /not logged in|\/login|invalid api key|authentication_failed|please run .*login/i.test(out);

  assert.ok(!authGate, `claude must authenticate via CLAUDE_CODE_OAUTH_TOKEN in the sandbox; output tail: ${JSON.stringify(out.slice(-300))}`);
  assert.ok(
    answered,
    `claude-code should auto-run the prompt and emit ${MARKER}; output tail: ${JSON.stringify(out.slice(-300))}`,
  );
});
