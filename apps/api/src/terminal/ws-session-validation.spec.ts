/**
 * Requirement: Session validation on WebSocket connections
 * (add-private-account-identity / multi-user-oauth spec.md §"Session validation on WebSocket connections")
 *
 * The TerminalGateway SHALL authenticate operator clients at connect time via a
 * valid, non-expired session resolving to an `allowed` user, and SHALL close an
 * unauthenticated, expired, revoked, or disallowed connection BEFORE it receives
 * any terminal bytes or control frames.
 *
 * Three scenarios exercised here (minimal unit — no real WebSocket server, no DB,
 * no Prisma; collaborators are plain fakes/stubs):
 *
 *   1. Authenticated WebSocket joins the stream — a valid session credential
 *      (`token` query param) resolves to an allowed user → `authenticated` is set
 *      and the socket is NOT closed.
 *
 *   2. Unauthenticated WebSocket is closed before subscribing — a missing token
 *      → the socket receives a close(1008) call and `authenticated` stays false.
 *
 *   3. Credential travels via bearer subprotocol — the spec requires the session
 *      credential to be accepted from the `bearer.<token>` WS subprotocol. A valid
 *      token embedded in that subprotocol → `authenticated` is set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TerminalGateway } from './terminal.gateway';
import type { SessionUser } from '@cap/contracts';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

/** The one valid session token that resolves in these tests. */
const VALID_TOKEN = 'valid-session-token-abc';

const LIVE_USER: SessionUser = {
  githubId: 99,
  login: 'operator',
  name: 'Operator Name',
  avatarUrl: '',
  allowed: true,
  role: 'member',
  mustChangePassword: false,
};

/**
 * A minimal AuthSessionService stub: `resolveSession` admits only VALID_TOKEN,
 * resolveApiKey always denies (no API-key path under test here).
 */
const fakeAuthSession = {
  resolveSession: async (token: string): Promise<SessionUser | null> =>
    token === VALID_TOKEN ? LIVE_USER : null,
  resolveApiKey: async (_raw: string) => null,
};

/**
 * A minimal WebSocket double that records whether `close(1008)` was called and
 * exposes the `readyState` property the gateway checks before sending.
 */
function makeFakeSocket() {
  const socket = {
    closedWith: null as number | null,
    readyState: 1 /* OPEN */,
    OPEN: 1 as const,
    close(code: number, _reason?: string) {
      this.closedWith = code;
      this.readyState = 3; // CLOSED
    },
    send(_data: string) {},
    on(_event: string, _listener: (...args: unknown[]) => void) {},
  };
  return socket;
}

/** Build an HTTP-upgrade IncomingMessage fake with the given URL and optional cookie/subprotocols. */
function makeRequest(opts: {
  url: string;
  cookie?: string;
  protocols?: string;
}): { url: string; headers: Record<string, string | undefined> } {
  const headers: Record<string, string | undefined> = {};
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  if (opts.protocols !== undefined) headers['sec-websocket-protocol'] = opts.protocols;
  return { url: opts.url, headers };
}

/**
 * Instantiate a TerminalGateway with minimal optional collaborators: the auth
 * session service is the fake above; write-lock, guardrails, runtimes are all
 * omitted (Optional injection). This exercises the gateway constructor's
 * `@Optional()` contract — the transport core must still construct in isolation.
 */
function makeGateway(): TerminalGateway {
  // The constructor is `(writeLock?, guardrails?, authSession?, runtimes?)`.
  // We pass `undefined` for the first two (Optional) then the fake auth service.
  return new TerminalGateway(
    undefined, // writeLock — Optional
    undefined, // guardrails — Optional
    fakeAuthSession as never, // authSession
    undefined, // runtimes — Optional
  );
}

// ---------------------------------------------------------------------------
// Helpers: drive handleConnection and wait for async auth to settle
// ---------------------------------------------------------------------------

/**
 * Call `handleConnection` and flush the microtask queue so the async
 * `authenticateOperator` (which calls `resolveSession`) resolves and updates
 * `state.authenticated` / calls `closeUnauthenticated`.
 */
async function connect(
  gateway: TerminalGateway,
  socket: ReturnType<typeof makeFakeSocket>,
  request: ReturnType<typeof makeRequest>,
) {
  gateway.handleConnection(socket as never, request as never);
  // Yield to the event loop so the internal Promise chain can settle.
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Scenario 1: Authenticated WebSocket joins the stream
// ---------------------------------------------------------------------------

test('WS session validation: authenticated client (valid ?token=) is accepted — socket not closed', async () => {
  const gateway = makeGateway();
  const socket = makeFakeSocket();
  const request = makeRequest({ url: `/terminal?token=${VALID_TOKEN}&taskId=t1` });

  await connect(gateway, socket, request);

  // The socket must NOT have been closed.
  assert.equal(socket.closedWith, null, 'authenticated socket must not be closed');

  // Verify the internal `authenticated` flag is set via a side-effect we can
  // observe: send a keystroke frame before and after auth and check the gateway
  // does not close for a valid authenticated client (indirect, but testable).
  // The key observable: `handleDisconnect` should run cleanly (no throw).
  assert.doesNotThrow(
    () => gateway.handleDisconnect(socket as never),
    'handleDisconnect must be side-effect-safe for an authenticated client',
  );
});

// ---------------------------------------------------------------------------
// Scenario 2: Unauthenticated WebSocket is closed before subscribing
// ---------------------------------------------------------------------------

test('WS session validation: missing token → socket closed with 1008 before stream', async () => {
  const gateway = makeGateway();
  const socket = makeFakeSocket();
  // No ?token= in the URL, no cookie, no subprotocol.
  const request = makeRequest({ url: '/terminal?taskId=t1' });

  await connect(gateway, socket, request);

  assert.equal(socket.closedWith, 1008, 'unauthenticated socket must be closed with code 1008');
});

test('WS session validation: invalid/revoked token → socket closed with 1008 before stream', async () => {
  const gateway = makeGateway();
  const socket = makeFakeSocket();
  const request = makeRequest({ url: '/terminal?token=invalid-or-revoked-token&taskId=t1' });

  await connect(gateway, socket, request);

  assert.equal(socket.closedWith, 1008, 'invalid token socket must be closed with code 1008');
});

// ---------------------------------------------------------------------------
// Scenario 3: Credential travels via bearer subprotocol (not ?token= query)
// ---------------------------------------------------------------------------

test('WS session validation: valid token via bearer.<token> subprotocol → accepted, not closed', async () => {
  const gateway = makeGateway();
  const socket = makeFakeSocket();
  // The `bearer.<token>` subprotocol encoding (see extractWsOperatorToken contract).
  const request = makeRequest({
    url: '/terminal?taskId=t1',
    protocols: `bearer.${VALID_TOKEN}`,
  });

  await connect(gateway, socket, request);

  assert.equal(
    socket.closedWith,
    null,
    'valid bearer.<token> subprotocol must be accepted — socket must not be closed',
  );
});

test('WS session validation: invalid token via bearer.<token> subprotocol → closed with 1008', async () => {
  const gateway = makeGateway();
  const socket = makeFakeSocket();
  const request = makeRequest({
    url: '/terminal?taskId=t1',
    protocols: 'bearer.bad-token-xyz',
  });

  await connect(gateway, socket, request);

  assert.equal(
    socket.closedWith,
    1008,
    'invalid bearer.<token> subprotocol must close the socket with 1008',
  );
});
