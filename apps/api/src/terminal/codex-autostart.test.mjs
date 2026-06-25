/**
 * Focused integration test for the AIO terminal bridge (`AioPtyClient`) under the
 * survive-api-redeploy detached-session model, driving the REAL client against a
 * fake AIO sandbox (terminal WS + `/v1/shell/exec` + `/v1/shell/wait` HTTP).
 *
 * Spec scenarios under test:
 *   aio-codex-prompt-autostart (preserved WITHIN the detached session):
 *   1. On `ready` (session GONE), the bridge launches codex in a DETACHED named
 *      tmux session (`tmux new-session -d -s task<id> …`) carrying the file-based
 *      launch line (`"$(cat <prompt-file>)"`), then attaches to it.
 *   2. Zero-touch auto-submit: AFTER codex's startup DSR is seen AND output has
 *      quiesced, the bridge injects exactly ONE Enter (`\r`) to submit the
 *      pre-filled prompt.
 *   3. A `'replay-only'` terminal neither launches codex nor injects the Enter.
 *
 *   survive-api-redeploy (detached-session 2.2–2.4):
 *   4. Attach-vs-fresh: when the named session is ALREADY alive on `ready`, the
 *      bridge ATTACHES (`tmux attach -t task<id>`) and does NOT launch a fresh
 *      codex (no `tmux new-session`, no auto-submit Enter into a running codex).
 *   5. A WS close while the session is still ALIVE is NON-TERMINAL: it does NOT
 *      resolve an exit (onExit is not called) — codex is left for re-adoption.
 *   6. Session-gone resolves the exit: when liveness polling observes the named
 *      session GONE, the bridge resolves the exit status (via /v1/shell/wait or
 *      echo $?) and calls onExit exactly once.
 *   7. Single-writer seam: the bridge's `write()` forwards operator input verbatim
 *      as an `{type:"input"}` frame — the lease gate lives ABOVE the seam in the
 *      gateway, so the bridge itself is the unconditional input forwarder.
 *   8. Terminal-teardown release (4.3): once `close()` is called (the D5 release the
 *      gateway's `unregisterSession` invokes after a task is already terminal), a
 *      subsequently-GONE session does NOT fire a second `onExit` — the
 *      liveness-driven termination drives `recordExit` EXACTLY ONCE even when a
 *      `forceFail` backstop tore the session down while the poller was still armed.
 *
 * The quiescence + liveness windows are forced small via env so the test runs
 * fast. Compiles the REAL aio-pty-client.ts with tsc, imports it, drives a fake
 * sandbox (mirrors the repo's cpr-detector.test.mjs harness).
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

// MUST be set before importing the compiled client — both windows are read from
// env at module eval time.
process.env.CODEX_AUTOSUBMIT_QUIESCE_MS = '40';
process.env.CODEX_LIVENESS_POLL_MS = '30';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const clientSrc = join(__dirname, 'aio-pty-client.ts');

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

const outDir = mkdtempSync(join(apiRoot, '.aio-autostart-test-'));

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

function compileClient() {
  execFileSync(
    tscBin,
    [
      clientSrc,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'ES2021',
      '--experimentalDecorators',
      '--emitDecoratorMetadata',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const flat = join(outDir, 'aio-pty-client.js');
  if (existsSync(flat)) return flat;
  const nested = join(outDir, 'terminal', 'aio-pty-client.js');
  if (existsSync(nested)) return nested;
  const hit = findFile(outDir, 'aio-pty-client.js');
  if (hit) return hit;
  throw new Error('compiled aio-pty-client.js not found under ' + outDir);
}

/**
 * Fake AIO sandbox: terminal WS (sends session_id+ready, records inbound frames)
 * PLUS an HTTP surface for `/v1/shell/exec` (tmux has-session probe + echo $?)
 * and `/v1/shell/wait` (authoritative exit). `sessionAlive` is mutable so a test
 * can flip a live session to gone and observe the liveness-driven termination.
 */
function startFakeSandbox(opts = {}) {
  const inbound = [];
  let sessionAlive = opts.sessionAlive ?? false; // false = no named session yet
  const waitExitCode = opts.waitExitCode ?? 0;

  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url || '';
      if (url.startsWith('/v1/shell/exec')) {
        let command = '';
        try {
          command = JSON.parse(raw).command ?? '';
        } catch {
          command = '';
        }
        let stdout = '';
        if (command.includes('has-session')) {
          // Mirror the bridge's `tmux has-session -t <name>; echo __cap_has__$?`:
          // exit 0 when alive, non-zero when gone.
          stdout = `__cap_has__${sessionAlive ? 0 : 1}\n`;
        } else if (command.includes('echo $?')) {
          stdout = `${waitExitCode}\n`;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stdout }));
        return;
      }
      if (url.startsWith('/v1/shell/wait')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exitCode: waitExitCode }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  const wss = new WebSocketServer({ server: http });
  let socket;
  const ready = new Promise((resolveReady) => {
    wss.on('connection', (ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        try {
          inbound.push(JSON.parse(raw.toString('utf8')));
        } catch {
          inbound.push({ _unparseable: raw.toString('utf8') });
        }
      });
      ws.send(JSON.stringify({ type: 'session_id', data: 'sess-1' }));
      ws.send(JSON.stringify({ type: 'ready' }));
      resolveReady();
    });
  });

  const listening = new Promise((r) => http.listen(0, '127.0.0.1', r));
  return {
    inbound,
    ready,
    listening,
    setSessionAlive(v) {
      sessionAlive = v;
    },
    closeServerSocket() {
      // Close the SERVER side of the WS so the client observes a WS close while
      // the (mocked) named session may still be alive.
      socket?.close();
    },
    sendOutput(data) {
      socket.send(JSON.stringify({ type: 'output', data }));
    },
    get port() {
      return http.address().port;
    },
    get wsUrl() {
      return `ws://127.0.0.1:${http.address().port}/v1/shell/ws`;
    },
    get baseUrl() {
      return `http://127.0.0.1:${http.address().port}`;
    },
    close() {
      wss.close();
      http.close();
    },
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const DSR_QUERY = '\x1b[6n';
const CPR_REPLY = '\x1b[1;1R';
const ENTER = '\r';
const inputs = (inbound) => inbound.filter((f) => f.type === 'input');
const inputData = (inbound) =>
  inputs(inbound).map((f) => (typeof f.data === 'string' ? f.data : ''));

async function main() {
  const { AioPtyClient } = await import(pathToFileURL(compileClient()).href);

  // --- Case 1+2: launch-or-attach with a GONE session → fresh detached launch,
  //     then auto-submit. ------------------------------------------------------
  {
    const sandbox = startFakeSandbox({ sessionAlive: false });
    await sandbox.listening;
    const client = new AioPtyClient(
      'autostart-1',
      sandbox.wsUrl,
      sandbox.baseUrl,
      undefined,
      'launch-or-attach',
    );
    await sandbox.ready;
    await delay(120); // process `ready`, run the has-session probe, send launch

    const launch = inputData(sandbox.inbound).find((d) =>
      d.includes('cat /home/gem/.codex/task-prompt.txt'),
    );
    assert(!!launch, 'launches codex with the file-based prompt launch line');
    if (launch) {
      assert(
        launch.startsWith('tmux new-session -d -s taskautostart-1 '),
        'fresh launch wraps codex in a DETACHED named tmux session',
      );
      assert(launch.includes('if [ -n "$P" ]'), 'launch line branches on a non-empty prompt');
      assert(
        launch.includes('--dangerously-bypass-approvals-and-sandbox'),
        'launch line carries the documented Codex bypass/YOLO flag',
      );
    }
    assert(
      inputData(sandbox.inbound).some((d) => d.startsWith('tmux attach -t taskautostart-1')),
      'after a fresh launch the bridge attaches to the new session',
    );

    // No Enter should have been injected before the startup DSR is observed.
    assert(
      inputs(sandbox.inbound).filter((f) => f.data === ENTER).length === 0,
      'no auto-submit Enter before the codex startup DSR is seen',
    );

    // codex starts: emit the startup DSR, then go quiet so output quiesces.
    sandbox.sendOutput(`codex tui boot ${DSR_QUERY}`);
    await delay(200);

    const cpr = inputs(sandbox.inbound).filter((f) => f.data === CPR_REPLY);
    assert(cpr.length === 1, 'injects exactly one CPR reply on the startup DSR');

    const enters = inputs(sandbox.inbound).filter((f) => f.data === ENTER);
    assert(enters.length === 1, 'injects exactly ONE Enter (auto-submit) after DSR + quiescence');

    client.close();
    sandbox.close();
  }

  // --- Case 3: replay-only → no launch, no attach, no auto-submit -------------
  {
    const sandbox = startFakeSandbox({ sessionAlive: true });
    await sandbox.listening;
    new AioPtyClient('autostart-2', sandbox.wsUrl, sandbox.baseUrl, undefined, 'replay-only');
    await sandbox.ready;
    await delay(120);

    assert(
      inputs(sandbox.inbound).length === 0,
      'replay-only terminal sends NO input (no launch, no attach)',
    );

    // CPR is still injected (unconditional), but the auto-submit is NOT.
    sandbox.sendOutput(`something ${DSR_QUERY}`);
    await delay(200);
    const enters = inputs(sandbox.inbound).filter((f) => f.data === ENTER);
    assert(enters.length === 0, 'no auto-submit Enter for a replay-only terminal');
    // The CPR reply is the only inbound input.
    assert(
      inputData(sandbox.inbound).every((d) => d === CPR_REPLY),
      'replay-only terminal only ever injects the unconditional CPR reply',
    );

    sandbox.close();
  }

  // --- Case 4: attach-vs-fresh — session ALREADY alive on ready → ATTACH ------
  {
    const sandbox = startFakeSandbox({ sessionAlive: true });
    await sandbox.listening;
    const client = new AioPtyClient(
      'autostart-3',
      sandbox.wsUrl,
      sandbox.baseUrl,
      undefined,
      'launch-or-attach',
    );
    await sandbox.ready;
    await delay(120);

    const attached = inputData(sandbox.inbound).some((d) =>
      d.startsWith('tmux attach -t taskautostart-3'),
    );
    assert(attached, 'a live named session is RE-ATTACHED on ready (re-adoption)');
    assert(
      !inputData(sandbox.inbound).some((d) => d.includes('tmux new-session')),
      'attach does NOT launch a fresh codex (no `tmux new-session`)',
    );

    // Even with a DSR (e.g. from a redraw of the attached codex), NO auto-submit
    // Enter is injected into an already-running codex.
    sandbox.sendOutput(`redraw ${DSR_QUERY}`);
    await delay(200);
    assert(
      inputs(sandbox.inbound).filter((f) => f.data === ENTER).length === 0,
      'attach never injects a stray auto-submit Enter into a running codex',
    );

    client.close();
    sandbox.close();
  }

  // --- Case 5: WS close while the session is ALIVE is NON-TERMINAL ------------
  {
    const sandbox = startFakeSandbox({ sessionAlive: true });
    await sandbox.listening;
    let exitCalls = 0;
    const client = new AioPtyClient(
      'autostart-4',
      sandbox.wsUrl,
      sandbox.baseUrl,
      () => {
        exitCalls++;
      },
      'launch-or-attach',
    );
    await sandbox.ready;
    await delay(120); // established + attached + liveness poller armed

    // Close the SERVER side of the WS — the operator/api "disconnects" — while the
    // named session is still alive. This must NOT resolve an exit.
    sandbox.closeServerSocket();
    await delay(200); // > several liveness poll ticks (30ms)

    assert(exitCalls === 0, 'a WS close with a LIVE session does NOT resolve an exit');

    client.close();
    sandbox.close();
  }

  // --- Case 6: session GONE resolves the exit exactly once --------------------
  {
    const sandbox = startFakeSandbox({ sessionAlive: true, waitExitCode: 0 });
    await sandbox.listening;
    const exits = [];
    const client = new AioPtyClient(
      'autostart-5',
      sandbox.wsUrl,
      sandbox.baseUrl,
      (status) => exits.push(status),
      'launch-or-attach',
    );
    await sandbox.ready;
    await delay(120); // attached + poller armed; still alive → no exit yet
    assert(exits.length === 0, 'while the session is alive no exit is resolved');

    // The detached codex finishes: the named session disappears.
    sandbox.setSessionAlive(false);
    await delay(200); // let the liveness poller observe it gone

    assert(exits.length === 1, 'a GONE session resolves the exit exactly once');
    if (exits.length === 1) {
      assert(exits[0].code === 0 && exits[0].abnormal === false, 'exit 0 maps to a clean exit status');
    }

    // Further ticks must not re-fire the exit.
    await delay(120);
    assert(exits.length === 1, 'the exit is not re-resolved on subsequent liveness ticks');

    client.close();
    sandbox.close();
  }

  // --- Case 7: single-writer seam — write() forwards input verbatim -----------
  {
    const sandbox = startFakeSandbox({ sessionAlive: true });
    await sandbox.listening;
    const client = new AioPtyClient('autostart-6', sandbox.wsUrl, sandbox.baseUrl, undefined, 'replay-only');
    await sandbox.ready;
    await delay(60);

    client.write('ls -la\r');
    await delay(60);
    const forwarded = inputData(sandbox.inbound).some((d) => d === 'ls -la\r');
    assert(
      forwarded,
      'write() forwards operator input verbatim as an {type:"input"} frame (lease gating lives above the seam)',
    );

    client.close();
    sandbox.close();
  }

  // --- Case 8: terminal-teardown release suppresses a second exit (4.3) --------
  // Models the `forceFail` backstop: the task is force-failed (deadline/idle/
  // circuit) while the liveness poller is STILL ARMED, the gateway's
  // `unregisterSession` calls `pty.close()`, and only THEN does the session
  // disappear (the stop took effect). The closed bridge must NOT re-fire onExit.
  {
    const sandbox = startFakeSandbox({ sessionAlive: true, waitExitCode: 0 });
    await sandbox.listening;
    const exits = [];
    const client = new AioPtyClient(
      'autostart-7',
      sandbox.wsUrl,
      sandbox.baseUrl,
      (status) => exits.push(status),
      'launch-or-attach',
    );
    await sandbox.ready;
    await delay(120); // attached + poller armed; session still alive

    // The gateway tears the session down (terminal teardown path) BEFORE the
    // session is observed gone — exactly what unregisterSession → pty.close() does.
    client.close();
    // Now the session disappears (the forceFail's stop took effect).
    sandbox.setSessionAlive(false);
    await delay(200); // > several liveness poll ticks — but the poller is stopped

    assert(
      exits.length === 0,
      'after close() (terminal-teardown release) a GONE session does NOT re-fire onExit (exactly-once)',
    );

    sandbox.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    failed++;
  })
  .finally(() => {
    rmSync(outDir, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  });
