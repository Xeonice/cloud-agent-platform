import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { guardHandshakeOrigin, type UpgradableServer } from './origin-checked-ws-adapter';

/**
 * Browsers do NOT apply the same-origin policy to WebSocket connections, and the
 * HTTP CORS allow-list does not cover them. The terminal gateway authenticates
 * from the handshake cookie, which is `SameSite=None` in the cross-origin shape,
 * so without a handshake check any page could open a socket with the operator's
 * cookie attached and drive a PTY.
 *
 * The refusal must happen at the UPGRADE: nothing created, no gateway state
 * touched, the gateway's own authentication never reached.
 */

const CONSOLE_ORIGIN = 'https://console.example.com';
const FOREIGN_ORIGIN = 'https://evil.example';
const API_HOST = 'api.example.com';

async function withEnv(
  patch: Record<string, string | undefined>,
  run: () => void,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A ws server whose handshake entry point records whether it was reached. */
function fakeServer() {
  const state = { upgraded: 0 };
  const server: UpgradableServer = {
    handleUpgrade: () => {
      state.upgraded += 1;
    },
  };
  return { server, state };
}

/** A socket that records what was written to it and whether it was destroyed. */
function fakeSocket() {
  const state = { written: '', destroyed: false };
  const socket = {
    write: (chunk: string) => {
      state.written += chunk;
      return true;
    },
    destroy: () => {
      state.destroyed = true;
    },
  };
  return { socket: socket as unknown as Duplex, state };
}

function upgradeRequest(origin: string | undefined): IncomingMessage {
  const headers: Record<string, string> = { host: API_HOST };
  if (origin !== undefined) headers.origin = origin;
  return { headers, url: '/terminal' } as unknown as IncomingMessage;
}

function attempt(origin: string | undefined) {
  const { server, state: serverState } = fakeServer();
  const refused: string[] = [];
  guardHandshakeOrigin(server, (o) => refused.push(o));
  const { socket, state: socketState } = fakeSocket();
  server.handleUpgrade(upgradeRequest(origin), socket, Buffer.alloc(0), () => {});
  return { upgraded: serverState.upgraded, refused, socket: socketState };
}

test('a handshake from an untrusted origin is refused before any connection exists', async () => {
  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, () => {
    const result = attempt(FOREIGN_ORIGIN);
    assert.equal(result.upgraded, 0, 'the upgrade must not be handed to the ws server');
    assert.equal(result.socket.destroyed, true, 'the socket must be closed');
    assert.match(result.socket.written, /^HTTP\/1\.1 403 /, 'the peer gets a refusal, not a hang');
  });
});

test('the refused origin is reported, since the browser only sees a generic failure', async () => {
  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, () => {
    const result = attempt(FOREIGN_ORIGIN);
    assert.deepEqual(result.refused, [FOREIGN_ORIGIN]);
  });
});

test('the configured console origin completes the handshake', async () => {
  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, () => {
    const result = attempt(CONSOLE_ORIGIN);
    assert.equal(result.upgraded, 1, 'the console terminal must keep working');
    assert.equal(result.socket.destroyed, false);
    assert.deepEqual(result.refused, []);
  });
});

test('a same-origin handshake completes with no WEB_ORIGIN configured', async () => {
  await withEnv({ WEB_ORIGIN: undefined }, () => {
    const result = attempt(`https://${API_HOST}`);
    assert.equal(result.upgraded, 1, 'a same-host install must keep working');
  });
});

test('a handshake with no Origin completes', async () => {
  // A non-browser client (the CLI, a probe) legitimately omits it, and a page
  // cannot suppress the header a browser attaches to every handshake it opens —
  // so absence is not the threat this guards.
  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, () => {
    const result = attempt(undefined);
    assert.equal(result.upgraded, 1);
    assert.deepEqual(result.refused, []);
  });
});
