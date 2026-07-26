import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const GENERATION = 'boxlite-test-generation';

function listen(server) {
  return new Promise((resolveListen) => {
    if (server.address()) {
      resolveListen(server.address().port);
      return;
    }
    server.on('listening', () => resolveListen(server.address().port));
  });
}

function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  return new Promise((resolveWait, rejectWait) => {
    const tick = () => {
      if (predicate()) {
        resolveWait();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        rejectWait(new Error('condition timed out'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function outputLine(sequence, payload) {
  return `O ${GENERATION} ${sequence} ${payload.toString('base64')}\n`;
}

const previousFetch = globalThis.fetch;
const previousToken = process.env.BOXLITE_API_TOKEN;

try {
  const mod = await import(new URL('../dist/index.js', import.meta.url).href);
  const { BoxLiteTerminalTransport, BOXLITE_TERMINAL_CHANNELS } = mod;
  const wsMessages = [];
  let wsPath = '';
  let wsAuth = '';
  let attachedSocket;
  const childOutput = Buffer.from('A中─文B\r\n', 'utf8');
  const outerProtocol = Buffer.from(
    [
      `R ${GENERATION} 1 321 shell 80 24\n`,
      ...[...childOutput].map((byte, index) =>
        outputLine(index + 1, Buffer.from([byte])),
      ),
    ].join(''),
    'ascii',
  );

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, req) => {
    attachedSocket = socket;
    wsPath = req.url ?? '';
    wsAuth = req.headers.authorization ?? '';
    socket.on('message', (raw, isBinary) => {
      const payload = Buffer.from(raw);
      wsMessages.push({ raw: payload, isBinary });
      if (
        isBinary &&
        payload.toString('ascii') === `S ${GENERATION} 100 40\n`
      ) {
        socket.send(
          Buffer.concat([
            Buffer.from([BOXLITE_TERMINAL_CHANNELS.stdout]),
            Buffer.from(`X ${GENERATION} child_exit 0\n`, 'ascii'),
          ]),
        );
        socket.send(JSON.stringify({ type: 'exit', exit_code: 0 }));
      }
    });

    // Deliberately split ASCII protocol lines at unrelated provider chunk
    // boundaries. One chunk also contains multiple complete lines.
    const splitSizes = [1, 2, 7, 3, 29, 5, 61, 4, 97];
    let offset = 0;
    let splitIndex = 0;
    while (offset < outerProtocol.length) {
      const size = splitSizes[splitIndex % splitSizes.length];
      const end = Math.min(offset + size, outerProtocol.length);
      socket.send(
        Buffer.concat([
          Buffer.from([BOXLITE_TERMINAL_CHANNELS.stdout]),
          outerProtocol.subarray(offset, end),
        ]),
      );
      offset = end;
      splitIndex += 1;
    }
  });
  const port = await listen(server);
  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    if (init.method === 'DELETE') {
      return { ok: true, status: 204, async json() { return {}; } };
    }
    if (init.method === 'GET') {
      return { ok: false, status: 404, async json() { return {}; } };
    }
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
  }, {
    bridgeGenerationFactory: () => GENERATION,
  });
  transport.onFrame((frame) => frames.push(frame));
  transport.onError((error) => errors.push(error));
  transport.onClose(() => closes.push('closed'));

  await waitFor(() => frames.some((frame) => frame.type === 'ready'));
  assert.equal(transport.readyState, 'open');
  const execBody = JSON.parse(fetchCalls[0].init.body);
  assert.equal(execBody.command, '/usr/local/bin/cap-pty-byte-bridge');
  assert.deepEqual(execBody.args, [
    '--shell',
    '--generation',
    GENERATION,
    '--cols',
    '80',
    '--rows',
    '24',
    '--term',
    'xterm-256color',
  ]);
  assert.equal(execBody.working_dir, '/workspace');
  assert.equal(execBody.tty, true);
  assert.equal(fetchCalls[0].init.headers.authorization, 'Bearer terminal-secret');
  assert.equal(
    wsPath,
    '/v1/default/boxes/box-task/executions/exec-123/attach',
  );
  assert.equal(wsAuth, 'Bearer terminal-secret');
  assert.ok(
    frames.some((frame) => frame.type === 'session_id' && frame.data === undefined),
  );

  await waitFor(() =>
    Buffer.concat(
      frames
        .filter((frame) => frame.type === 'output')
        .map((frame) => Buffer.from(frame.bytes)),
    ).equals(childOutput),
  );
  const outputBytes = Buffer.concat(
    frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => Buffer.from(frame.bytes)),
  );
  const outputText = frames
    .filter((frame) => frame.type === 'output')
    .map((frame) => frame.data)
    .join('');
  assert.deepEqual(outputBytes, childOutput);
  assert.equal(outputText, childOutput.toString('utf8'));
  assert.equal(outputText.includes('�'), false);

  const everyByte = Uint8Array.from({ length: 256 }, (_unused, byte) => byte);
  assert.equal(transport.sendInputBytes(everyByte), 'written');
  assert.equal(transport.sendInput('abc'), true);
  const response = Uint8Array.of(0x1b, 0x5b, 0x30, 0x6e);
  assert.equal(transport.sendTerminalResponseBytes(response), 'written');
  assert.equal(transport.sendResize(100, 40), true);
  await waitFor(() => wsMessages.length >= 4);
  assert.equal(wsMessages.every(({ isBinary }) => isBinary), true);
  const sentLines = wsMessages.map(({ raw }) => raw.toString('ascii'));
  assert.deepEqual(
    Buffer.from(sentLines[0].split(' ')[2], 'base64'),
    Buffer.from(everyByte),
  );
  assert.equal(sentLines[0], `I ${GENERATION} ${Buffer.from(everyByte).toString('base64')}\n`);
  assert.equal(sentLines[1], `I ${GENERATION} YWJj\n`);
  assert.equal(sentLines[2], `I ${GENERATION} G1swbg==\n`);
  assert.equal(sentLines[3], `S ${GENERATION} 100 40\n`);
  await waitFor(() => frames.some((frame) => frame.type === 'exit'));
  assert.equal(
    frames.filter((frame) => frame.type === 'exit').length,
    1,
  );
  assert.ok(frames.some((frame) => frame.type === 'exit' && frame.data === '0'));
  assert.deepEqual(errors, []);

  transport.close();
  const cleanup = await transport.cleanupDecision;
  assert.equal(cleanup.kind, 'confirmed');
  assert.equal(cleanup.deletedIdentities, 1);
  assert.equal(fetchCalls[1].init.method, 'DELETE');
  assert.equal(fetchCalls[2].init.method, 'GET');
  assert.equal(fetchCalls[2].url, fetchCalls[1].url);
  await waitFor(() => closes.length === 1);
  attachedSocket?.terminate();
  await new Promise((resolveClose) => server.close(resolveClose));
} finally {
  if (previousFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previousFetch;
  if (previousToken === undefined) delete process.env.BOXLITE_API_TOKEN;
  else process.env.BOXLITE_API_TOKEN = previousToken;
}

console.log('BoxLite terminal byte bridge happy-path test passed');
