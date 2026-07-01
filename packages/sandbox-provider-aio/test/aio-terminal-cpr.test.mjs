/**
 * Focused unit test for the CPR (Cursor Position Report) detector in the
 * AIO terminal bridge (harden-aio-execution, integration task 6.7; design D4).
 *
 * Spec/scenario under test (realtime-terminal / aio-sandbox-execution): the
 * orchestrator bridge MUST inject a synthetic CPR reply when codex's crossterm
 * emits its startup DSR cursor-position query, OR codex aborts with
 * "cursor position could not be read". The byte sequence codex emits, verified
 * against the live sandbox, is the standard DSR-6 `\x1b[6n` (hex `1b 5b 36 6e`)
 * — NOT the private-mode form `\x1b[?6n`. The detector MUST:
 *   - match the EXACT `\x1b[6n` sequence and inject the CPR reply `\x1b[1;1R`,
 *   - NOT match `\x1b[?6n` (matching that form silently disables injection and
 *     codex never starts).
 *
 * This drives the REAL AioPtyClient against a fake AIO terminal WS server:
 * it sends an `{type:"output",data}` frame carrying the DSR query and asserts
 * the client sends back an `{type:"input",data:"\x1b[1;1R"}` frame; a control
 * case sends the `\x1b[?6n` form and asserts NO CPR input is injected.
 *
 * Mirrors the repo's `.test.mjs` convention: import the built package dist,
 * drive it with a fake, plain `node`, inline assertions.
 */

import { WebSocketServer } from 'ws';

// ---- assertion helpers ------------------------------------------------------

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

// ---- fake AIO terminal WS server --------------------------------------------

/**
 * Start a fake AIO terminal WS server. On a client connection it sends
 * session_id+ready, then (after `onReady`) lets the test push frames. It records
 * every inbound frame the client sends so the test can assert CPR injection.
 */
function startFakeSandbox() {
  const inbound = []; // frames the client sent us
  const wss = new WebSocketServer({ port: 0 });
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
  const port = wss.address().port;
  return {
    inbound,
    ready,
    sendOutput(data) {
      socket.send(JSON.stringify({ type: 'output', data }));
    },
    wsUrl: `ws://127.0.0.1:${port}/v1/shell/ws`,
    baseUrl: `http://127.0.0.1:${port}`,
    close() {
      wss.close();
    },
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** The exact bytes verified against the live sandbox (hex 1b 5b 36 6e). */
const DSR_QUERY = '\x1b[6n';
/** The private-mode form the detector MUST NOT match. */
const PRIVATE_DSR_QUERY = '\x1b[?6n';
/** The synthetic CPR reply the bridge injects (row 1, col 1). */
const CPR_REPLY = '\x1b[1;1R';

async function main() {
  // Byte-identity guard: prove the constant under test is exactly 1b 5b 36 6e.
  const hex = Buffer.from(DSR_QUERY, 'binary').toString('hex');
  assert(hex === '1b5b366e', `DSR query bytes are 1b 5b 36 6e (got ${hex})`);
  assert(
    Buffer.from(PRIVATE_DSR_QUERY, 'binary').toString('hex') === '1b5b3f366e',
    'private-mode DSR query is the distinct sequence 1b 5b 3f 36 6e',
  );

  const { AioPtyClient } = await import(
    new URL('../dist/aio-pty-client.js', import.meta.url).href,
  );

  // --- Case 1: exact \x1b[6n in output triggers a CPR input injection --------
  {
    const sandbox = startFakeSandbox();
    const client = new AioPtyClient('task-cpr-1', sandbox.wsUrl, sandbox.baseUrl);
    await sandbox.ready;
    sandbox.sendOutput(`hello ${DSR_QUERY} world`);
    await delay(150);

    const cprFrames = sandbox.inbound.filter(
      (f) => f.type === 'input' && f.data === CPR_REPLY,
    );
    assert(
      cprFrames.length === 1,
      'exact \\x1b[6n in output injects exactly one CPR reply \\x1b[1;1R as input',
    );
    // The exact reply bytes must be 1b 5b 31 3b 31 52.
    if (cprFrames.length === 1) {
      assert(
        Buffer.from(cprFrames[0].data, 'binary').toString('hex') === '1b5b313b3152',
        'injected CPR reply bytes are exactly \\x1b[1;1R (1b 5b 31 3b 31 52)',
      );
    }
    client.pause(); // touch the surface so the import is real
    sandbox.close();
  }

  // --- Case 2: private-mode \x1b[?6n must NOT trigger CPR injection ----------
  {
    const sandbox = startFakeSandbox();
    new AioPtyClient('task-cpr-2', sandbox.wsUrl, sandbox.baseUrl);
    await sandbox.ready;
    sandbox.sendOutput(`prefix ${PRIVATE_DSR_QUERY} suffix`);
    await delay(150);

    const cprFrames = sandbox.inbound.filter(
      (f) => f.type === 'input' && f.data === CPR_REPLY,
    );
    assert(
      cprFrames.length === 0,
      'private-mode \\x1b[?6n does NOT inject a CPR reply (detector matches the no-? form only)',
    );
    sandbox.close();
  }

  // ---- summary --------------------------------------------------------------
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
