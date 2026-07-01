import { WebSocketServer } from 'ws';

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
  const mod = await import(new URL('../dist/index.js', import.meta.url).href);
  const { BoxLiteTerminalTransport, BOXLITE_TERMINAL_CHANNELS } = mod;
  const wsMessages = [];
  let wsPath = '';
  let wsAuth = '';
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, req) => {
    wsPath = req.url ?? '';
    wsAuth = req.headers.authorization ?? '';
    socket.on('message', (raw, isBinary) => {
      wsMessages.push({ raw: Buffer.from(raw), isBinary });
      if (!isBinary) {
        const text = Buffer.from(raw).toString('utf8');
        if (/"type"\s*:\s*"resize"/.test(text)) {
          socket.send(JSON.stringify({ type: 'exit', exit_code: 0 }));
        }
      }
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
  const closes = [];
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
  transport.onClose(() => closes.push('closed'));

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
  assert(wsMessages[0].isBinary === true, 'stdin uses a BoxLite binary frame');
  assert(wsMessages[0].raw.toString('utf8') === 'abc', 'stdin payload is raw UTF-8');
  assert(wsMessages[1].isBinary === false, 'resize uses a BoxLite text control frame');
  const resizeFrame = JSON.parse(wsMessages[1].raw.toString('utf8'));
  assert(resizeFrame.type === 'resize', 'resize payload declares the resize control type');
  assert(resizeFrame.cols === 100, 'resize payload contains cols');
  assert(resizeFrame.rows === 40, 'resize payload contains rows');
  await waitFor(() => frames.some((frame) => frame.type === 'exit'));
  assert(frames.some((frame) => frame.type === 'exit' && frame.data === '0'), 'text exit frame is emitted as a terminal exit');
  assert(errors.length === 0, 'no transport errors during happy path');
  transport.close();
  await waitFor(() => closes.length === 1);
  await new Promise((resolveClose) => server.close(resolveClose));
} finally {
  if (previousFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previousFetch;
  if (previousToken === undefined) delete process.env.BOXLITE_API_TOKEN;
  else process.env.BOXLITE_API_TOKEN = previousToken;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
