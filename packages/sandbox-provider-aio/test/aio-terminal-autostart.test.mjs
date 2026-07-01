/**
 * Focused integration test for the AIO terminal bridge (`AioPtyClient`) under the
 * survive-api-redeploy detached-session model, driving the REAL client against a
 * fake AIO sandbox (terminal WS + `/v1/shell/exec` + `/v1/shell/wait` HTTP).
 *
 * Spec scenarios under test:
 *   aio-codex-prompt-autostart (preserved WITHIN the detached session):
 *   1. On `ready` (session GONE), the bridge launches codex in a DETACHED named
 *      tmux session (`tmux -u new-session -d -s task<id> …`) carrying the file-based
 *      launch line (`"$(cat <prompt-file>)"`), then attaches to it.
 *   2. Zero-touch auto-submit: AFTER codex's startup DSR is seen AND output has
 *      quiesced, the bridge injects exactly ONE Enter (`\r`) to submit the
 *      pre-filled prompt.
 *   3. A `'replay-only'` terminal neither launches codex nor injects the Enter.
 *
 *   survive-api-redeploy (detached-session 2.2–2.4):
 *   4. Attach-vs-fresh: when the named session is ALREADY alive on `ready`, the
 *      bridge hides tmux's status line, ATTACHES, and does NOT launch a fresh codex
 *      (no `tmux -u new-session`, no auto-submit Enter into a running codex).
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
 *   9. Resize frames are translated to AIO `{type:"resize",data:{cols,rows}}`
 *      without passing through the operator input path.
 *  10. A stale/closed bridge is replaced on the next operator write; the new bridge
 *      re-attaches to the detached session and flushes queued input exactly through
 *      the fresh socket.
 *
 * The quiescence + liveness windows are forced small via env so the test runs
 * fast. Imports the built AIO provider dist and drives a fake sandbox.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

// MUST be set before importing the built client — both windows are read from
// env at module eval time.
process.env.CODEX_AUTOSUBMIT_QUIESCE_MS = '40';
process.env.CODEX_LIVENESS_POLL_MS = '30';

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

function expectedAttach(taskId) {
  return (
    `tmux -u set-option -t task${taskId} status off \\; ` +
    `attach -t task${taskId}`
  );
}

/**
 * Fake AIO sandbox: terminal WS (sends session_id+ready, records inbound frames)
 * PLUS an HTTP surface for `/v1/shell/exec` (tmux has-session probe + echo $?)
 * and `/v1/shell/wait` (authoritative exit). `sessionAlive` is mutable so a test
 * can flip a live session to gone and observe the liveness-driven termination.
 */
function startFakeSandbox(opts = {}) {
  const inbound = [];
  const execCommands = [];
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
        execCommands.push(command);
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
  let connectionCount = 0;
  const connectionWaiters = [];
  function notifyConnectionWaiters() {
    for (let i = connectionWaiters.length - 1; i >= 0; i--) {
      const waiter = connectionWaiters[i];
      if (connectionCount >= waiter.count) {
        connectionWaiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }
  const ready = new Promise((resolveReady) => {
    wss.on('connection', (ws) => {
      socket = ws;
      connectionCount++;
      notifyConnectionWaiters();
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
    execCommands,
    ready,
    listening,
    waitForConnectionCount(count) {
      if (connectionCount >= count) return Promise.resolve();
      return new Promise((resolveWaiter) => {
        connectionWaiters.push({ count, resolve: resolveWaiter });
      });
    },
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

class FakeTransport {
  frameListeners = new Set();
  closeListeners = new Set();
  input = [];
  resizes = [];
  closed = false;
  readyState = 'open';

  onFrame(listener) {
    this.frameListeners.add(listener);
    return { dispose: () => this.frameListeners.delete(listener) };
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }
  onError() {
    return { dispose() {} };
  }
  sendInput(data) {
    this.input.push(data);
    return true;
  }
  sendResize(cols, rows) {
    this.resizes.push([cols, rows]);
    return true;
  }
  sendPong() {
    return true;
  }
  pause() {}
  resume() {}
  close() {
    this.closed = true;
  }
  emit(frame) {
    for (const listener of this.frameListeners) listener(frame);
  }
}

async function main() {
  const { AioPtyClient } = await import(
    new URL('../dist/aio-pty-client.js', import.meta.url).href,
  );

  // --- Case 0: provider story fixture mode launches deterministic shell fixture
  //     without detached-session lifecycle commands. --------------------------
  {
    const transport = new FakeTransport();
    const execCalls = [];
    const client = new AioPtyClient(
      'terminal-story-test',
      'ws://unused',
      'http://unused',
      undefined,
      'provider-story-fixture',
      undefined,
      undefined,
      { open: () => transport },
      {
        async exec(request) {
          execCalls.push(request);
          return {
            exitCode: 0,
            output: '',
            stdout: '',
            stderr: '',
            timedOut: false,
          };
        },
      },
    );

    transport.emit({ type: 'session_id', data: 'fake' });
    transport.emit({ type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));
    assert(execCalls.length === 1, 'provider story fixture installs exactly one script');
    assert(/PROVIDER_STORY_BEGIN/.test(execCalls[0].command), 'fixture script emits begin marker');
    assert(/PROVIDER_STORY_ECHO/.test(execCalls[0].command), 'fixture script echoes input');
    assert(
      /exec \/bin\/sh \/tmp\/cap-provider-terminal-story\.sh/.test(
        transport.input.join('\n'),
      ),
      'fixture mode starts the deterministic shell fixture',
    );
    assert(
      !/CAP_PROVIDER_TERMINAL_STORY_SCRIPT/.test(transport.input.join('\n')),
      'fixture script body is installed through exec, not typed into the terminal',
    );

    client.write('hello-from-test\r');
    client.resize(132, 43);
    client.close();

    assert(transport.input.at(-1) === 'hello-from-test\r', 'fixture mode forwards operator input');
    assert(
      JSON.stringify(transport.resizes) === JSON.stringify([[132, 43]]),
      'fixture mode forwards resize to provider transport only',
    );
    assert(
      execCalls.length === 1,
      'fixture mode must not run detached tmux resize commands',
    );
    assert(transport.closed === true, 'fixture mode closes provider transport');
  }

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
        launch.startsWith('tmux -u new-session -d -s taskautostart-1 '),
        'fresh launch wraps codex in a UTF-8 DETACHED named tmux session',
      );
      assert(launch.includes('if [ -n "$P" ]'), 'launch line branches on a non-empty prompt');
      assert(
        launch.includes('--dangerously-bypass-approvals-and-sandbox'),
        'launch line carries the documented Codex bypass/YOLO flag',
      );
    }
    assert(
      inputData(sandbox.inbound).some((d) =>
        d.startsWith(expectedAttach('autostart-1')),
      ),
      'after a fresh launch the bridge hides tmux status and attaches to the new session',
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
      d.startsWith(expectedAttach('autostart-3')),
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

  // --- Case 9: resize translates to an AIO resize frame -----------------------
  {
    const sandbox = startFakeSandbox({ sessionAlive: true });
    await sandbox.listening;
    const client = new AioPtyClient('autostart-8', sandbox.wsUrl, sandbox.baseUrl, undefined, 'replay-only');
    await sandbox.ready;
    await delay(60);

    client.resize(123, 45);
    await delay(60);

    const resizeFrames = sandbox.inbound.filter((f) => f.type === 'resize');
    assert(resizeFrames.length === 1, 'resize() emits exactly one AIO resize frame');
    if (resizeFrames.length === 1) {
      assert(
        resizeFrames[0].data?.cols === 123 && resizeFrames[0].data?.rows === 45,
        'resize frame carries the browser cols/rows unchanged',
      );
    }
    assert(
      sandbox.execCommands.some((command) =>
        command.includes('tmux -u resize-window -t taskautostart-8 -x 123 -y 45'),
      ),
      'resize() best-effort resizes the detached tmux window to the browser geometry',
    );
    assert(
      !inputs(sandbox.inbound).some((f) => f.data === '123x45'),
      'resize does not pass through the raw input path',
    );

    client.close();
    sandbox.close();
  }

  // --- Case 10: stale bridge replacement re-attaches and flushes input --------
  {
    const sandbox = startFakeSandbox({ sessionAlive: true });
    await sandbox.listening;
    const client = new AioPtyClient(
      'autostart-9',
      sandbox.wsUrl,
      sandbox.baseUrl,
      undefined,
      'launch-or-attach',
    );
    await sandbox.ready;
    await delay(120); // first socket established + attached

    const attachBefore = inputData(sandbox.inbound).filter((d) =>
      d.startsWith(expectedAttach('autostart-9')),
    ).length;
    assert(attachBefore === 1, 'initial live session attach happens once');

    sandbox.closeServerSocket();
    await delay(80);
    client.write('queued-after-stale-bridge\r');

    await sandbox.waitForConnectionCount(2);
    await delay(250); // new socket ready, attach, pending-input flush

    const attachAfter = inputData(sandbox.inbound).filter((d) =>
      d.startsWith(expectedAttach('autostart-9')),
    ).length;
    assert(
      attachAfter === 2,
      'typing after a stale bridge opens a replacement socket and re-attaches once',
    );
    assert(
      inputData(sandbox.inbound).filter((d) => d === 'queued-after-stale-bridge\r').length === 1,
      'queued operator input is flushed once through the replacement bridge',
    );

    client.close();
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
    process.exit(failed === 0 ? 0 : 1);
  });
