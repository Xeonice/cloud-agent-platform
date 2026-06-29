import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const src = join(__dirname, 'boxlite-terminal-transport.ts');

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

const outDir = mkdtempSync(join(apiRoot, '.boxlite-terminal-transport-test-'));

function compile() {
  execFileSync(
    tscBin,
    [
      src,
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
  const hit = findFile(outDir, 'boxlite-terminal-transport.js');
  if (hit) return hit;
  throw new Error('compiled boxlite-terminal-transport.js not found under ' + outDir);
}

function listen(server) {
  return new Promise((resolveListen) => {
    if (server.address()) {
      resolveListen(server.address().port);
      return;
    }
    server.on('listening', () => resolveListen(server.address().port));
  });
}

function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolveWait, rejectWait) => {
    const tick = () => {
      if (predicate()) {
        resolveWait();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        rejectWait(new Error('condition timed out'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

const previousFetch = globalThis.fetch;
const previousToken = process.env.BOXLITE_API_TOKEN;

try {
  const mod = await import(pathToFileURL(compile()).href);
  const { BoxLiteTerminalTransport, BOXLITE_TERMINAL_CHANNELS } = mod;
  const wsMessages = [];
  let wsPath = '';
  let wsAuth = '';
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, req) => {
    wsPath = req.url ?? '';
    wsAuth = req.headers.authorization ?? '';
    socket.on('message', (raw) => {
      wsMessages.push(Buffer.from(raw));
    });
    const sendFrame = (channel, payload) => {
      socket.send(Buffer.concat([Buffer.from([channel]), payload]));
    };
    sendFrame(
      BOXLITE_TERMINAL_CHANNELS.stdout,
      Buffer.from('hello from boxlite', 'utf8'),
    );
    const splitStdout = Buffer.from('A中文B', 'utf8');
    sendFrame(BOXLITE_TERMINAL_CHANNELS.stdout, splitStdout.subarray(0, 2));
    sendFrame(BOXLITE_TERMINAL_CHANNELS.stdout, splitStdout.subarray(2));
    const splitStderr = Buffer.from('E错误F', 'utf8');
    sendFrame(BOXLITE_TERMINAL_CHANNELS.stderr, splitStderr.subarray(0, 2));
    sendFrame(BOXLITE_TERMINAL_CHANNELS.stderr, splitStderr.subarray(2));
  });
  const port = await listen(server);
  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { execution_id: 'exec-123' };
      },
    };
  };
  process.env.BOXLITE_API_TOKEN = 'terminal-secret';
  const frames = [];
  const errors = [];
  const transport = new BoxLiteTerminalTransport('task-boxlite', {
    protocol: 'boxlite-v1',
    wsUrl: `ws://127.0.0.1:${port}`,
    metadata: {
      endpoint: `http://127.0.0.1:${port}`,
      sandboxId: 'box-task',
      pathPrefix: 'default',
      workspacePath: '/workspace',
    },
  });
  transport.onFrame((frame) => frames.push(frame));
  transport.onError((error) => errors.push(error));

  await waitFor(() => frames.some((frame) => frame.type === 'ready'));
  await waitFor(() => frames.some((frame) => frame.type === 'output'));
  assert(fetchCalls[0].url.endsWith('/v1/default/boxes/box-task/exec'), 'starts a native BoxLite PTY execution');
  const execBody = JSON.parse(fetchCalls[0].init.body);
  assert(execBody.args[1].startsWith('export TERM=xterm-256color &&'), 'PTY shell exports an xterm-compatible TERM before bash');
  assert(execBody.args[1].includes("cd '/workspace' && exec bash -l"), 'PTY shell enters the workspace before login bash');
  assert(fetchCalls[0].init.headers.authorization === 'Bearer terminal-secret', 'REST exec uses bearer token');
  assert(wsPath === '/v1/default/boxes/box-task/executions/exec-123/attach', 'attaches to execution websocket');
  assert(wsAuth === 'Bearer terminal-secret', 'websocket attach uses bearer token');
  assert(frames.some((frame) => frame.type === 'session_id' && frame.data === 'exec-123'), 'emits session_id frame');
  assert(frames.some((frame) => frame.type === 'output' && frame.data === 'hello from boxlite'), 'stdout channel becomes output frame');
  await waitFor(() => {
    const output = frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => frame.data)
      .join('');
    return output.includes('A中文B') && output.includes('E错误F');
  });
  const output = frames
    .filter((frame) => frame.type === 'output')
    .map((frame) => frame.data)
    .join('');
  assert(output.includes('A中文B'), 'split stdout UTF-8 is reassembled without replacement chars');
  assert(output.includes('E错误F'), 'split stderr UTF-8 is reassembled without replacement chars');
  assert(!output.includes('�'), 'split UTF-8 output contains no replacement characters');

  assert(transport.sendInput('abc') === true, 'sendInput writes to open websocket');
  assert(transport.sendResize(100, 40) === true, 'sendResize writes to open websocket');
  await waitFor(() => wsMessages.length >= 2);
  assert(wsMessages[0][0] === BOXLITE_TERMINAL_CHANNELS.stdin, 'stdin uses BoxLite stdin channel');
  assert(wsMessages[0].subarray(1).toString('utf8') === 'abc', 'stdin payload is raw UTF-8');
  assert(wsMessages[1][0] === BOXLITE_TERMINAL_CHANNELS.resize, 'resize uses BoxLite resize channel');
  assert(/"cols":100/.test(wsMessages[1].subarray(1).toString('utf8')), 'resize payload contains cols');
  assert(errors.length === 0, 'no transport errors during happy path');
  transport.close();
  await new Promise((resolveClose) => server.close(resolveClose));
} finally {
  if (previousFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previousFetch;
  if (previousToken === undefined) delete process.env.BOXLITE_API_TOKEN;
  else process.env.BOXLITE_API_TOKEN = previousToken;
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
