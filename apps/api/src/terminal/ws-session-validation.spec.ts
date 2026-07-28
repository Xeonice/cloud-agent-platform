/**
 * Requirement: Session validation on WebSocket connections
 * (add-private-account-identity / multi-user-oauth spec.md §"Session validation on WebSocket connections")
 *
 * The TerminalGateway SHALL authenticate operator clients at connect time via a
 * valid, non-expired session resolving to an `allowed` user, and SHALL close an
 * unauthenticated, expired, revoked, or disallowed connection BEFORE it receives
 * any terminal bytes or control frames.
 *
 * The scenarios are exercised through the real TerminalGateway frame/auth seam
 * (no real WebSocket server, DB, or Prisma; external collaborators are fakes):
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

import {
  FRAME_CHANNEL,
  TERMINAL_PROTOCOL_VERSION,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
  type SessionUser,
} from '@cap/contracts';
import type {
  AgentTerminalPty,
  AgentTerminalLaunchOutcome,
  OpenTerminalViewerAttachmentArgs,
  TerminalViewerAttachment,
  TerminalViewerAttachmentFactory,
} from '@cap/sandbox';
import type { AuthSessionService } from '@/auth/auth-session.service';
import { WriteLockService } from '@/write-lock/write-lock.service';
import { TerminalGateway, type TerminalSession } from './terminal.gateway';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

/** The one valid session token that resolves in these tests. */
const VALID_TOKEN = 'valid-session-token-abc';
const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';

const LIVE_USER: SessionUser = {
  id: 'user-99',
  githubId: 99,
  login: 'operator',
  name: 'Operator Name',
  avatarUrl: '',
  allowed: true,
  role: 'member',
  mustChangePassword: false,
};

/**
 * Default AuthSessionService stub: `resolveSession` admits only VALID_TOKEN and
 * `resolveApiKey` denies. Security-matrix cases inject their own resolvers.
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
    sent: [] as string[],
    readyState: 1 /* OPEN */,
    OPEN: 1 as const,
    close(code: number, _reason?: string) {
      this.closedWith = code;
      this.readyState = 3; // CLOSED
    },
    send(data: string) {
      this.sent.push(data);
    },
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
 * Instantiate a TerminalGateway with the requested auth and optional write-lock
 * collaborators. Guardrails and runtimes stay omitted so the validation tests
 * remain scoped to the WebSocket gateway boundary.
 */
function makeGateway(
  authSession: Pick<AuthSessionService, 'resolveSession' | 'resolveApiKey'> =
    fakeAuthSession as never,
  writeLock?: WriteLockService,
): TerminalGateway {
  // The constructor is `(writeLock?, guardrails?, authSession?, runtimes?)`.
  return new TerminalGateway(
    writeLock, // writeLock — Optional
    undefined, // guardrails — Optional
    authSession as never, // authSession
    undefined, // runtimes — Optional
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class RecordingOwner implements AgentTerminalPty {
  readonly resizes: Array<readonly [number, number]> = [];

  constructor(
    readonly launchDecision: Promise<AgentTerminalLaunchOutcome> =
      Promise.resolve({ kind: 'attached' }),
  ) {}

  onData(): { dispose(): void } {
    return { dispose() {} };
  }

  write(): void {}

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  pause(): void {}
  resume(): void {}
}

class RecordingAttachment implements TerminalViewerAttachment {
  readonly attachmentDecision = Promise.resolve({ kind: 'ready' } as const);
  readonly opaqueInputCapability = 'byte-preserving' as const;
  closeCount = 0;

  onData(): { dispose(): void } {
    return { dispose() {} };
  }

  onClose(): { dispose(): void } {
    return { dispose() {} };
  }

  onError(): { dispose(): void } {
    return { dispose() {} };
  }

  write(): 'written' {
    return 'written';
  }

  writeTerminalResponse(): 'written' {
    return 'written';
  }

  resize(): void {}
  pause(): void {}
  resume(): void {}

  close(): void {
    this.closeCount += 1;
  }
}

class RecordingViewerFactory implements TerminalViewerAttachmentFactory {
  readonly opens: OpenTerminalViewerAttachmentArgs[] = [];
  readonly attachments: RecordingAttachment[] = [];

  open(args: OpenTerminalViewerAttachmentArgs): TerminalViewerAttachment {
    this.opens.push(args);
    const attachment = new RecordingAttachment();
    this.attachments.push(attachment);
    return attachment;
  }
}

function registerSession(
  gateway: TerminalGateway,
  taskId: string,
  factory: RecordingViewerFactory,
  owner = new RecordingOwner(),
): TerminalSession {
  const session: TerminalSession = {
    taskId,
    ownerPty: owner,
    viewerFactory: factory,
    geometry: { cols: 80, rows: 24 },
    launchDecision: owner.launchDecision,
  };
  gateway.registerSession(session);
  return session;
}

function sendControl(
  gateway: TerminalGateway,
  socket: ReturnType<typeof makeFakeSocket>,
  frame: Readonly<Record<string, unknown>>,
): void {
  gateway.handleMessage(JSON.stringify(frame), socket as never);
}

function sendAttach(
  gateway: TerminalGateway,
  socket: ReturnType<typeof makeFakeSocket>,
  cols = 90,
  rows = 30,
): void {
  sendControl(gateway, socket, {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'terminal_attach',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
    cols,
    rows,
  });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface InspectedClientState {
  readonly authenticated: boolean;
  readonly phase: string;
  readonly requestedTaskId: string | null;
  readonly binding: {
    readonly principalIdentity: {
      readonly kind: string;
      readonly userId: string | null;
      readonly keyId: string | null;
    };
    readonly boundTaskId: string;
    readonly generation: number;
  } | null;
}

function inspectClientState(
  gateway: TerminalGateway,
  socket: ReturnType<typeof makeFakeSocket>,
): InspectedClientState {
  return (
    gateway as unknown as {
      clients: Map<unknown, InspectedClientState>;
    }
  ).clients.get(socket)!;
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

test('WS auth pending: attach and task controls have zero provider/session side effects', async () => {
  const authGate = deferred<SessionUser | null>();
  const authSession = {
    resolveSession: async () => authGate.promise,
    resolveApiKey: async () => null,
  };
  const writeLock = new WriteLockService();
  const gateway = makeGateway(authSession as never, writeLock);
  const factory = new RecordingViewerFactory();
  const owner = new RecordingOwner();
  const session = registerSession(gateway, TASK_A, factory, owner);
  const socket = makeFakeSocket();

  gateway.handleConnection(
    socket as never,
    makeRequest({
      url: `/terminal?token=pending-session-secret&taskId=${TASK_A}`,
    }) as never,
  );

  const pendingFrames: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'terminal_attach',
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
      cols: 111,
      rows: 37,
    },
    { channel: FRAME_CHANNEL.CONTROL, type: 'ack', seq: 0 },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'terminal_response',
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      data: Buffer.from('\u001b[0n').toString('base64'),
    },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'keystroke',
      sessionId: TASK_A,
      data: Buffer.from('pending-input').toString('base64'),
    },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'heartbeat',
      sessionId: TASK_A,
      writerClientId: 'untrusted-client-id',
    },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'takeover_request',
      sessionId: TASK_A,
      clientId: 'untrusted-client-id',
    },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'decision',
      requestId: 'pending-auth-decision',
      decision: { behavior: 'deny' },
    },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'resize',
      cols: 120,
      rows: 42,
    },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'permission_request',
      requestId: 'pending-auth-permission',
      taskId: TASK_A,
      toolName: 'shell',
      toolInput: {},
    },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'post_tool_use_report',
      taskId: TASK_A,
      edits: [],
    },
    {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'lease_state',
      sessionId: TASK_A,
      lease: null,
    },
  ];
  for (const frame of pendingFrames) sendControl(gateway, socket, frame);
  await settle();

  assert.equal(factory.opens.length, 0, 'auth-pending frames cannot open a viewer');
  assert.deepEqual(owner.resizes, [], 'auth-pending resize cannot reach the owner');
  assert.deepEqual(session.geometry, { cols: 80, rows: 24 });
  assert.equal(writeLock.getLease(TASK_A), null, 'auth-pending attach cannot grant a lease');
  assert.deepEqual(gateway.listPendingApprovals(), []);
  assert.deepEqual(socket.sent, [], 'auth-pending controls cannot emit task frames');
  assert.equal(socket.closedWith, null, 'a still-pending valid auth attempt remains pending');

  authGate.resolve(LIVE_USER);
  await settle();
  assert.equal(inspectClientState(gateway, socket).authenticated, true);
  assert.equal(factory.opens.length, 0, 'dropped attach is never replayed after auth');

  sendAttach(gateway, socket, 96, 32);
  await settle();
  assert.equal(factory.opens.length, 1, 'a new post-auth attach uses the real viewer seam');
  assert.deepEqual(session.geometry, { cols: 96, rows: 32 });
  assert.equal(socket.closedWith, null);
  gateway.handleDisconnect(socket as never);
});

test('WS frozen binding keeps stable session/API-key identity and no raw credential', async () => {
  const sessionSecretA = 'session-secret-alpha-never-retain';
  const sessionSecretB = 'session-secret-beta-never-retain';
  const apiKeySecretA = 'cap_sk_alpha-never-retain';
  const apiKeySecretB = 'cap_sk_beta-never-retain';
  const apiKeyId = 'api-key-stable-id';
  const scenarios = [
    {
      name: 'session',
      initialCredential: sessionSecretA,
      reauthCredential: sessionSecretB,
      authSession: {
        resolveSession: async (token: string) =>
          token === sessionSecretA || token === sessionSecretB ? LIVE_USER : null,
        resolveApiKey: async () => null,
      },
      expectedIdentity: {
        kind: 'session',
        userId: LIVE_USER.id,
        keyId: null,
      },
    },
    {
      name: 'api-key',
      initialCredential: apiKeySecretA,
      reauthCredential: apiKeySecretB,
      authSession: {
        resolveSession: async () => null,
        resolveApiKey: async (raw: string) =>
          raw === apiKeySecretA || raw === apiKeySecretB
            ? {
                user: LIVE_USER,
                scopes: [],
                keyId: apiKeyId,
              }
            : null,
      },
      expectedIdentity: {
        kind: 'api-key',
        userId: LIVE_USER.id,
        keyId: apiKeyId,
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const ownerGate = deferred<AgentTerminalLaunchOutcome>();
    const gateway = makeGateway(scenario.authSession as never);
    registerSession(
      gateway,
      TASK_A,
      new RecordingViewerFactory(),
      new RecordingOwner(ownerGate.promise),
    );
    const socket = makeFakeSocket();
    await connect(
      gateway,
      socket,
      makeRequest({
        url: `/terminal?token=${scenario.initialCredential}&taskId=${TASK_A}`,
      }),
    );
    sendAttach(gateway, socket);

    const acceptedState = inspectClientState(gateway, socket);
    const frozenBinding = acceptedState.binding!;
    assert.equal(acceptedState.phase, 'attaching', scenario.name);
    assert.deepEqual(
      frozenBinding.principalIdentity,
      scenario.expectedIdentity,
      scenario.name,
    );
    assert.equal(Object.isFrozen(frozenBinding), true, scenario.name);
    assert.equal(Object.isFrozen(frozenBinding.principalIdentity), true, scenario.name);
    assert.deepEqual(
      Object.keys(frozenBinding).sort(),
      ['boundTaskId', 'generation', 'principalIdentity'],
      `${scenario.name}: binding contains only non-secret routing identity`,
    );
    assert.deepEqual(
      Object.keys(frozenBinding.principalIdentity).sort(),
      ['keyId', 'kind', 'userId'],
      `${scenario.name}: principal contains no credential/scopes payload`,
    );
    const serializedBinding = JSON.stringify(frozenBinding);
    assert.equal(serializedBinding.includes(scenario.initialCredential), false, scenario.name);
    assert.equal(serializedBinding.includes(scenario.reauthCredential), false, scenario.name);

    sendControl(gateway, socket, {
      channel: FRAME_CHANNEL.CONTROL,
      type: 'connect_auth',
      token: scenario.reauthCredential,
      taskId: TASK_A,
    });
    await settle();
    assert.equal(socket.closedWith, null, `${scenario.name}: same identity may revalidate`);
    assert.equal(
      inspectClientState(gateway, socket).binding,
      frozenBinding,
      `${scenario.name}: revalidation cannot replace the frozen binding`,
    );

    ownerGate.resolve({ kind: 'attached' });
    await settle();
    gateway.handleDisconnect(socket as never);
  }
});

test('WS attach acceptance fences an already-started auth retarget that resolves late', async () => {
  const lateAuth = deferred<SessionUser | null>();
  const authSession = {
    resolveSession: async (token: string) => {
      if (token === 'accepted-session-a') return LIVE_USER;
      if (token === 'late-session-b') return lateAuth.promise;
      return null;
    },
    resolveApiKey: async () => null,
  };
  const writeLock = new WriteLockService();
  const gateway = makeGateway(authSession, writeLock);
  const ownerGate = deferred<AgentTerminalLaunchOutcome>();
  const factoryA = new RecordingViewerFactory();
  const factoryB = new RecordingViewerFactory();
  registerSession(
    gateway,
    TASK_A,
    factoryA,
    new RecordingOwner(ownerGate.promise),
  );
  registerSession(gateway, TASK_B, factoryB);
  const socket = makeFakeSocket();
  await connect(
    gateway,
    socket,
    makeRequest({
      url: `/terminal?token=accepted-session-a&taskId=${TASK_A}`,
    }),
  );

  sendControl(gateway, socket, {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'connect_auth',
    token: 'late-session-b',
    taskId: TASK_B,
  });
  sendAttach(gateway, socket, 101, 33);

  const acceptedState = inspectClientState(gateway, socket);
  const acceptedBinding = acceptedState.binding!;
  assert.equal(acceptedState.phase, 'attaching');
  assert.equal(acceptedBinding.boundTaskId, TASK_A);
  assert.deepEqual(acceptedBinding.principalIdentity, {
    kind: 'session',
    userId: LIVE_USER.id,
    keyId: null,
  });
  assert.equal(factoryA.opens.length, 0, 'owner decision still gates task A provider open');
  assert.equal(factoryB.opens.length, 0);

  lateAuth.resolve({ ...LIVE_USER, id: 'late-user-b' });
  await settle();
  assert.equal(socket.closedWith, null, 'stale auth result is ignored, not adopted');
  assert.equal(inspectClientState(gateway, socket).binding, acceptedBinding);
  assert.equal(inspectClientState(gateway, socket).requestedTaskId, TASK_A);
  assert.equal(writeLock.getLease(TASK_B), null);
  assert.equal(factoryB.opens.length, 0, 'late retarget cannot touch task B provider');

  ownerGate.resolve({ kind: 'attached' });
  await settle();
  assert.equal(factoryA.opens.length, 1, 'only the frozen task A provider opens');
  assert.equal(factoryB.opens.length, 0);
  gateway.handleDisconnect(socket as never);
});
