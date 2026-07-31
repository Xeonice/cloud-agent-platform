import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  createAioCanaryCredentialLease,
  parseAioPreloadCredentialArgs,
} from './aio-preload-canary-credential.mjs';

const UNRELATED_PATH = '/unrelated/sandbox/keep';

/**
 * Proof that the CHILD has processed SIGTERM.
 *
 * The SIGTERM case below holds the credential-directory exec open, signals the
 * child, and then asserts that no credential write follows. That assertion is only
 * meaningful once the child has actually RUN its signal handler — the handler is
 * what sets the stop flag the product checks immediately before the write. Waiting
 * a turn of THIS process's event loop orders nothing in the child's, so the barrier
 * used to be decided by whichever process the scheduler happened to favour. It held
 * on an idle machine and gave way on a loaded CI runner, where the released exec
 * response reached the child before the queued signal did and the write went out —
 * failing an assertion about product behaviour on account of test timing.
 *
 * This is preloaded into the child and arms a SECOND SIGTERM listener, but only
 * after the script has registered its own: `--import` runs before the entry module,
 * so `setImmediate` re-arms until the entry module's synchronous top level (where
 * `runCli` registers its handler) has run. Node fires signal listeners in
 * registration order, so the product's handler completes — including the
 * synchronous `lease.requestStop()` — before this one writes its byte. The child is
 * single-threaded, so a byte on fd 3 means the stop flag is already set.
 */
const SIGTERM_OBSERVER = `data:text/javascript,${encodeURIComponent(`
import { writeSync } from 'node:fs';
const arm = () => {
  if (process.listenerCount('SIGTERM') > 0) {
    process.on('SIGTERM', () => {
      try { writeSync(3, 'stopped'); } catch {}
    });
    return;
  }
  setImmediate(arm);
};
setImmediate(arm);
`)}`;

function createEnvelope(runtime = 'codex') {
  if (runtime === 'codex') {
    const auth = JSON.stringify({ token: randomBytes(48).toString('base64url') });
    return {
      bytes: Buffer.from(JSON.stringify({ codexAuthJson: auth }), 'utf8'),
      material: auth,
    };
  }
  const material = randomBytes(48).toString('base64url');
  return {
    bytes: Buffer.from(JSON.stringify({ claudeOauthToken: material }), 'utf8'),
    material,
  };
}

function createRemoteHarness({ deferPrepare = false, failCleanup = false } = {}) {
  const files = new Map([[UNRELATED_PATH, Buffer.from('unrelated-owner')]]);
  const events = [];
  const commands = [];
  let releasePrepare;
  const prepareBarrier = deferPrepare
    ? new Promise((resolvePrepare) => {
        releasePrepare = resolvePrepare;
      })
    : null;
  return {
    files,
    events,
    commands,
    releasePrepare: () => releasePrepare?.(),
    async writeFile({ path, content }) {
      events.push('credential-write');
      files.set(path, Buffer.from(content));
    },
    async executeCommand({ command, label }) {
      commands.push(command);
      events.push(`${label}:start`);
      if (label === 'credential directory preparation') {
        if (prepareBarrier) await prepareBarrier;
        events.push(`${label}:session-cleaned`);
        return '';
      }
      if (label === 'private credential verification') {
        const credential = [...files.entries()].find(([path]) =>
          path.endsWith('/auth.json') || path.endsWith('/launch-env.sh'),
        )?.[1];
        events.push(`${label}:session-cleaned`);
        return credential
          ? `${createHash('sha256').update(credential).digest('hex')}\n`
          : '';
      }
      if (label === 'exact credential cleanup') {
        if (failCleanup) throw new Error('injected cleanup failure');
        const quotedPath = command.match(/rm -f -- '([^']+)'/u)?.[1];
        if (quotedPath) files.delete(quotedPath);
        events.push(`${label}:session-cleaned`);
        return '';
      }
      throw new Error('unexpected command');
    },
  };
}

test('standalone preload requires an explicit unsafe handoff acknowledgement', () => {
  const base = [
    '--endpoint',
    'http://127.0.0.1:18080',
    '--runtime',
    'codex',
    '--aio-state-ownership',
    'isolated-disposable',
  ];
  assert.throws(
    () => parseAioPreloadCredentialArgs(base),
    /unsafe preloaded credential handoff acknowledgement is required/u,
  );
  const parsed = parseAioPreloadCredentialArgs([
    ...base,
    '--unsafe-preloaded-credential-handoff',
    'acknowledged',
  ]);
  assert.equal(parsed.unsafePreloadedCredentialHandoff, true);
});

test('stop waits for the in-flight AIO operation before exact cleanup and starts no later preload work', async () => {
  const envelope = createEnvelope();
  const remote = createRemoteHarness({ deferPrepare: true });
  const lease = createAioCanaryCredentialLease({
    endpoint: 'http://127.0.0.1:18080',
    runtime: 'codex',
    envelopeBytes: envelope.bytes,
    executeCommand: remote.executeCommand,
    writeFile: remote.writeFile,
  });
  envelope.bytes.fill(0);

  const preload = lease.preload();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  lease.requestStop();
  const cleanup = lease.cleanup();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(remote.events, ['credential directory preparation:start']);

  remote.releasePrepare();
  await assert.rejects(preload, /credential preload was stopped/u);
  await cleanup;

  assert.deepEqual(remote.events, [
    'credential directory preparation:start',
    'credential directory preparation:session-cleaned',
    'exact credential cleanup:start',
    'exact credential cleanup:session-cleaned',
  ]);
  assert.equal(remote.files.has(lease.credentialPath), false);
  assert.equal(remote.files.get(UNRELATED_PATH)?.toString(), 'unrelated-owner');
  assert.equal(
    remote.commands.some((command) => command.includes(envelope.material)),
    false,
  );
});

test('runtime start failure is fenced by the same credential lease finally', async () => {
  const envelope = createEnvelope('claude-code');
  const remote = createRemoteHarness();
  const lease = createAioCanaryCredentialLease({
    endpoint: 'http://127.0.0.1:18080',
    runtime: 'claude-code',
    envelopeBytes: envelope.bytes,
    executeCommand: remote.executeCommand,
    writeFile: remote.writeFile,
  });
  envelope.bytes.fill(0);

  await assert.rejects(
    async () => {
      try {
        await lease.preload();
        throw new Error('simulated runtime start failure');
      } finally {
        await lease.cleanup();
      }
    },
    /simulated runtime start failure/u,
  );

  assert.equal(remote.files.has(lease.credentialPath), false);
  assert.equal(remote.files.get(UNRELATED_PATH)?.toString(), 'unrelated-owner');
  assert.equal(
    remote.commands.some((command) => command.includes(envelope.material)),
    false,
  );
});

test('cleanup failure is returned to the owner without exposing credential material', async () => {
  const envelope = createEnvelope();
  const remote = createRemoteHarness({ failCleanup: true });
  const lease = createAioCanaryCredentialLease({
    endpoint: 'http://127.0.0.1:18080',
    runtime: 'codex',
    envelopeBytes: envelope.bytes,
    executeCommand: remote.executeCommand,
    writeFile: remote.writeFile,
  });
  envelope.bytes.fill(0);
  await lease.preload();
  const error = await lease.cleanup().catch((caught) => caught);
  assert.match(error.message, /exact credential cleanup failed/u);
  assert.equal(error.message.includes(envelope.material), false);
  assert.equal(
    remote.commands.some((command) => command.includes(envelope.material)),
    false,
  );
  assert.equal(remote.files.get(UNRELATED_PATH)?.toString(), 'unrelated-owner');
});

test('standalone SIGTERM waits for exact session cleanup before removing only its credential', async (t) => {
  const sessions = new Set();
  const events = [];
  let releasePrepare;
  let notifyPrepare;
  const prepareSeen = new Promise((resolvePrepareSeen) => {
    notifyPrepare = resolvePrepareSeen;
  });
  const prepareHeld = new Promise((resolvePrepare) => {
    releasePrepare = resolvePrepare;
  });
  let prepareHeldOnce = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : undefined;
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && request.url === '/v1/shell/sessions/create') {
      sessions.add(body.id);
      events.push(`create:${body.id}`);
      response.end(
        JSON.stringify({
          success: true,
          data: { session_id: body.id, working_dir: '/home/gem' },
        }),
      );
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/shell/exec') {
      if (!prepareHeldOnce && body.command.includes('install -d -m 700')) {
        prepareHeldOnce = true;
        events.push(`prepare:${body.id}`);
        notifyPrepare();
        await prepareHeld;
      } else if (body.command.includes('rm -f --')) {
        events.push(`credential-cleanup:${body.id}`);
      } else {
        assert.fail('unexpected exec after stop barrier');
      }
      response.end(
        JSON.stringify({
          success: true,
          data: {
            session_id: body.id,
            command: body.command,
            status: 'completed',
            exit_code: 0,
            output: '',
          },
        }),
      );
      return;
    }
    if (request.method === 'DELETE' && request.url?.startsWith('/v1/shell/sessions/')) {
      const id = decodeURIComponent(request.url.split('/').at(-1));
      sessions.delete(id);
      events.push(`delete:${id}`);
      response.end(JSON.stringify({ success: true, data: { session_id: id } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/file/write') {
      assert.fail('credential write crossed the signal stop barrier');
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const envelope = createEnvelope();
  const child = spawn(
    process.execPath,
    [
      '--import',
      SIGTERM_OBSERVER,
      resolve('scripts/aio-preload-canary-credential.mjs'),
      '--endpoint',
      `http://127.0.0.1:${address.port}`,
      '--runtime',
      'codex',
      '--aio-state-ownership',
      'isolated-disposable',
      '--unsafe-preloaded-credential-handoff',
      'acknowledged',
    ],
    { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
  );
  // Latched before the first await so the byte cannot arrive unobserved.
  const childProcessedSigterm = once(child.stdio[3], 'data');
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(envelope.bytes);
  envelope.bytes.fill(0);

  await prepareSeen;
  child.kill('SIGTERM');
  // Wait for the CHILD to have run its handler, not for a turn of our own loop.
  // Raced against exit because `node --test` applies no default timeout here and
  // run-suite passes none, so a regression must fail rather than hang the suite.
  await Promise.race([
    childProcessedSigterm,
    once(child, 'exit').then(() => {
      throw new Error('child exited before it processed SIGTERM');
    }),
  ]);
  assert.equal(child.exitCode, null);
  assert.equal(events.some((event) => event.startsWith('credential-cleanup:')), false);
  releasePrepare();

  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 143);
  assert.equal(signal, null);
  assert.equal(sessions.size, 0);
  assert.equal(events.some((event) => event.startsWith('credential-cleanup:')), true);
  assert.equal(Buffer.concat(stdout).byteLength, 0);
  assert.equal(Buffer.concat(stderr).byteLength, 0);
});
