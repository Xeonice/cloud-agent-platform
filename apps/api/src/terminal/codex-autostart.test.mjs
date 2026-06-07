/**
 * Focused integration test for the codex prompt auto-start in the AIO terminal
 * bridge (aio-codex-prompt-autostart), driving the REAL AioPtyClient against a
 * fake AIO terminal WS server.
 *
 * Spec scenarios under test (aio-sandbox-execution / codex launched in-shell):
 *   1. On `ready`, the auto-launched codex command is the file-based launch line
 *      (`"$(cat <prompt-file>)"`), NOT a raw `codex …` with an inlined prompt.
 *   2. Zero-touch auto-submit: AFTER codex's startup DSR is seen AND output has
 *      quiesced, the bridge injects exactly ONE Enter (`\r`) to submit the
 *      pre-filled prompt.
 *   3. The auto-submit is gated on autoLaunchCodex: an attach/replay terminal
 *      (autoLaunchCodex=false) neither launches codex nor injects the Enter.
 *
 * The quiescence window is forced small via env so the test runs fast. Compiles
 * the REAL aio-pty-client.ts with tsc, imports it, drives a fake WS (mirrors the
 * repo's cpr-detector.test.mjs harness).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

// MUST be set before importing the compiled client — the quiescence window is
// read from env at module eval time.
process.env.CODEX_AUTOSUBMIT_QUIESCE_MS = '40';

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

/** Fake AIO terminal WS server: sends session_id+ready, records inbound frames. */
function startFakeSandbox() {
  const inbound = [];
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
const DSR_QUERY = '\x1b[6n';
const CPR_REPLY = '\x1b[1;1R';
const ENTER = '\r';
const inputs = (inbound) => inbound.filter((f) => f.type === 'input');

async function main() {
  const { AioPtyClient } = await import(pathToFileURL(compileClient()).href);

  // --- Case 1+2: autoLaunchCodex=true → file-based launch line, then auto-submit
  {
    const sandbox = startFakeSandbox();
    const client = new AioPtyClient('task-autostart-1', sandbox.wsUrl, sandbox.baseUrl, undefined, true);
    await sandbox.ready;
    await delay(80); // let the client process `ready` and send the launch line

    const launch = inputs(sandbox.inbound).find(
      (f) => typeof f.data === 'string' && f.data.includes('cat /home/gem/.codex/task-prompt.txt'),
    );
    assert(!!launch, 'auto-launches codex with the file-based prompt launch line');
    if (launch) {
      assert(launch.data.includes('if [ -n "$P" ]'), 'launch line branches on a non-empty prompt');
      assert(launch.data.includes('codex'), 'launch line invokes codex');
      assert(
        !launch.data.includes('--yolo') && !launch.data.includes(' -s '),
        'launch line carries no hook-disabling flags',
      );
    }

    // No Enter should have been injected before the startup DSR is observed.
    assert(
      inputs(sandbox.inbound).filter((f) => f.data === ENTER).length === 0,
      'no auto-submit Enter before the codex startup DSR is seen',
    );

    // codex starts: emit the startup DSR, then go quiet so output quiesces.
    sandbox.sendOutput(`codex tui boot ${DSR_QUERY}`);
    await delay(200); // > quiescence window (40ms) + margin

    const cpr = inputs(sandbox.inbound).filter((f) => f.data === CPR_REPLY);
    assert(cpr.length === 1, 'injects exactly one CPR reply on the startup DSR');

    const enters = inputs(sandbox.inbound).filter((f) => f.data === ENTER);
    assert(enters.length === 1, 'injects exactly ONE Enter (auto-submit) after DSR + quiescence');

    client.pause();
    sandbox.close();
  }

  // --- Case 3: autoLaunchCodex=false → no launch, no auto-submit ---------------
  {
    const sandbox = startFakeSandbox();
    new AioPtyClient('task-autostart-2', sandbox.wsUrl, sandbox.baseUrl, undefined, false);
    await sandbox.ready;
    await delay(80);

    const launched = inputs(sandbox.inbound).some(
      (f) => typeof f.data === 'string' && f.data.includes('cat /home/gem/.codex/task-prompt.txt'),
    );
    assert(!launched, 'attach/replay terminal (autoLaunchCodex=false) does NOT auto-launch codex');

    // CPR is still injected (it is unconditional), but the auto-submit is NOT.
    sandbox.sendOutput(`something ${DSR_QUERY}`);
    await delay(200);

    const enters = inputs(sandbox.inbound).filter((f) => f.data === ENTER);
    assert(enters.length === 0, 'no auto-submit Enter when autoLaunchCodex is false');

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
