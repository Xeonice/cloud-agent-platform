import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRAME_CHANNEL,
  TERMINAL_PROTOCOL_VERSION,
  XTERM_5_5_0_RESPONSE_PROFILE,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
  type SessionUser,
} from '@cap-console/contracts';
import type {
  AgentTerminalPty,
  TerminalTransportCleanupSettlement,
  TerminalTransportWriteOutcome,
  TerminalViewerAttachment,
  TerminalViewerAttachmentFactory,
  TerminalViewerAttachmentOutcome,
} from '@cap-console/sandbox';
import type { AuthSessionService } from '@/auth/auth-session.service';
import { WriteLockService } from '@/write-lock/write-lock.service';
import { TerminalDiagnosticsMetricsService } from '@/metrics/terminal-diagnostics-metrics.service';
import {
  DEFAULT_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  TerminalGateway,
  type ProviderTerminalStoryTelemetryEvent,
  type TerminalSession,
} from './terminal.gateway';
import type {
  TerminalQueryObserver,
  TerminalResponseWriteCheckpoint,
  TerminalResponseWriteFence,
} from './terminal-query-observer';

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';
const USER_A: SessionUser = {
  id: 'user-a',
  githubId: null,
  login: null,
  name: 'A',
  avatarUrl: null,
  allowed: true,
  role: 'member',
  mustChangePassword: false,
};
const USER_B: SessionUser = { ...USER_A, id: 'user-b', name: 'B' };

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly frames: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  onSend?: (frame: Record<string, unknown>) => void;

  on(): void {}

  send(text: string): void {
    const frame = JSON.parse(text) as Record<string, unknown>;
    this.frames.push(frame);
    this.onSend?.(frame);
  }

  close(code: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
}

class FakeOwner implements AgentTerminalPty {
  readonly launchDecision: Promise<{ readonly kind: 'attached' }>;
  readonly cleanupDecision?: Promise<TerminalTransportCleanupSettlement>;
  readonly resizes: Array<[number, number]> = [];
  readonly writes: string[] = [];
  closed = false;

  constructor(
    decision: Promise<{ readonly kind: 'attached' }> = Promise.resolve({
      kind: 'attached',
    }),
    cleanupDecision?: Promise<TerminalTransportCleanupSettlement>,
  ) {
    this.launchDecision = decision;
    this.cleanupDecision = cleanupDecision;
  }

  onData(): { dispose(): void } {
    return { dispose() {} };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  pause(): void {}
  resume(): void {}

  close(): void {
    this.closed = true;
  }
}

class FakeAttachment implements TerminalViewerAttachment {
  readonly opaqueInputCapability = 'byte-preserving' as const;
  readonly writes: Uint8Array[] = [];
  readonly terminalResponseWrites: Uint8Array[] = [];
  readonly resizes: Array<[number, number]> = [];
  pauseCount = 0;
  resumeCount = 0;
  closeCount = 0;
  closed = false;
  throwOnWrite = false;
  nextWriteOutcome: TerminalTransportWriteOutcome | null = null;
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(
    readonly attachmentDecision: Promise<TerminalViewerAttachmentOutcome> =
      Promise.resolve({ kind: 'ready' }),
    readonly cleanupDecision?: Promise<TerminalTransportCleanupSettlement>,
  ) {}

  onData(listener: (chunk: Uint8Array) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onClose(listener: () => void): { dispose(): void } {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onError(listener: (error: Error) => void): { dispose(): void } {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  write(data: Uint8Array): TerminalTransportWriteOutcome {
    if (this.closed) return 'closed';
    if (this.throwOnWrite) throw new Error('provider write failed');
    if (this.nextWriteOutcome) {
      const outcome = this.nextWriteOutcome;
      this.nextWriteOutcome = null;
      return outcome;
    }
    this.writes.push(new Uint8Array(data));
    return 'written';
  }

  writeTerminalResponse(data: Uint8Array): TerminalTransportWriteOutcome {
    if (this.closed) return 'closed';
    if (this.throwOnWrite) throw new Error('provider write failed');
    if (this.nextWriteOutcome) {
      const outcome = this.nextWriteOutcome;
      this.nextWriteOutcome = null;
      return outcome;
    }
    this.terminalResponseWrites.push(new Uint8Array(data));
    return 'written';
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  pause(): void {
    this.pauseCount += 1;
  }

  resume(): void {
    this.resumeCount += 1;
  }

  close(): void {
    this.closeCount += 1;
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  emit(data: Uint8Array): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class FakeViewerFactory implements TerminalViewerAttachmentFactory {
  readonly attachments: FakeAttachment[] = [];
  readonly opens: Array<{ cols: number; rows: number; signal?: AbortSignal }> = [];

  constructor(
    private readonly create: () => FakeAttachment = () => new FakeAttachment(),
  ) {}

  open(args: { cols: number; rows: number; signal?: AbortSignal }): FakeAttachment {
    const attachment = this.create();
    this.attachments.push(attachment);
    this.opens.push(args);
    return attachment;
  }
}

function makeAuthService(
  resolveSession: (token: string) => Promise<SessionUser | null> = async (token) =>
    token === 'token-a' ? USER_A : null,
): AuthSessionService {
  return {
    resolveSession,
    resolveApiKey: async () => null,
  } as unknown as AuthSessionService;
}

function makeGateway(
  writeLock = new WriteLockService(),
  authSession = makeAuthService(),
  terminalMetrics?: TerminalDiagnosticsMetricsService,
): TerminalGateway {
  return new TerminalGateway(
    writeLock,
    undefined,
    authSession,
    undefined,
    undefined,
    terminalMetrics,
  );
}

function terminalMetricCount(
  entries: readonly { outcome: string; count: number }[],
  outcome: string,
): number {
  return entries.find((entry) => entry.outcome === outcome)?.count ?? -1;
}

function register(
  gateway: TerminalGateway,
  taskId: string,
  factory: TerminalViewerAttachmentFactory,
  owner = new FakeOwner(),
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

async function connect(
  gateway: TerminalGateway,
  socket: FakeSocket,
  taskId = TASK_A,
  token = 'token-a',
): Promise<void> {
  gateway.handleConnection(
    socket as never,
    { url: `/terminal?taskId=${taskId}&token=${token}`, headers: {} } as never,
  );
  await settle();
}

function message(gateway: TerminalGateway, socket: FakeSocket, frame: object): void {
  gateway.handleMessage(JSON.stringify(frame), socket as never);
}

function attach(
  gateway: TerminalGateway,
  socket: FakeSocket,
  cols: number,
  rows: number,
): void {
  message(gateway, socket, {
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

function framesOf(socket: FakeSocket, type: string): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => frame.type === type);
}

function assertNoLiveHistoryFrames(
  sockets: readonly FakeSocket[],
  context: string,
): void {
  for (const socket of sockets) {
    assert.deepEqual(
      socket.frames.filter(
        (frame) => frame.type === 'snapshot' || frame.type === 'tail_replay',
      ),
      [],
      context,
    );
  }
}

test('graceful shutdown closes owner/viewer resources and aggregates confirmed cleanup', async () => {
  const ownerCleanup: TerminalTransportCleanupSettlement = {
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 2,
    alreadyAbsentIdentities: 0,
    cause: null,
  };
  const viewerCleanup: TerminalTransportCleanupSettlement = {
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 1,
    alreadyAbsentIdentities: 1,
    cause: null,
  };
  const terminalMetrics = new TerminalDiagnosticsMetricsService();
  const gateway = makeGateway(
    new WriteLockService(),
    makeAuthService(),
    terminalMetrics,
  );
  const factory = new FakeViewerFactory(
    () =>
      new FakeAttachment(
        Promise.resolve({ kind: 'ready' }),
        Promise.resolve(viewerCleanup),
      ),
  );
  const owner = new FakeOwner(
    Promise.resolve({ kind: 'attached' }),
    Promise.resolve(ownerCleanup),
  );
  register(gateway, TASK_A, factory, owner);
  const socket = new FakeSocket();
  await connect(gateway, socket);
  attach(gateway, socket, 80, 24);
  await settle();

  const summary = await gateway.shutdownTerminalResources();

  assert.equal(owner.closed, true);
  assert.equal(factory.attachments[0]!.closeCount, 1);
  assert.equal(socket.closedWith, 1001);
  assert.deepEqual(
    gateway.getProviderTerminalStoryResourceState(TASK_A),
    { ownerRegistered: false, activeViewerCount: 0 },
  );
  assert.deepEqual(summary, {
    kind: 'confirmed',
    timeoutMs: summary.timeoutMs,
    elapsedMs: summary.elapsedMs,
    closedClientCount: 1,
    closedSessionCount: 1,
    sourceCount: 2,
    ownerSourceCount: 1,
    viewerSourceCount: 1,
    confirmedSourceCount: 2,
    indeterminateSourceCount: 0,
    timedOutSourceCount: 0,
    expectedIdentities: 4,
    observedIdentities: 4,
    confirmedIdentities: 4,
    deletedIdentities: 3,
    alreadyAbsentIdentities: 1,
    causes: {
      identityUnavailable: 0,
      cleanupUnsupported: 0,
      cleanupUnconfirmed: 0,
      timeout: 0,
    },
  });
  assert.ok(summary.elapsedMs >= 0);
  assert.equal(
    summary.timeoutMs,
    DEFAULT_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  );
  assert.strictEqual(await gateway.shutdownTerminalResources(), summary);
  const metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 0, pausedViewers: 0 });
  assert.equal(terminalMetricCount(metrics.attachOutcomes, 'ready'), 1);
  assert.equal(terminalMetricCount(metrics.cleanupOutcomes, 'confirmed'), 2);
  assert.equal(terminalMetricCount(metrics.cleanupOutcomes, 'indeterminate'), 0);
});

test('graceful shutdown is bounded and never promotes missing cleanup seams', async () => {
  const previousTimeout = process.env.CAP_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS;
  process.env.CAP_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS = '15';
  const terminalMetrics = new TerminalDiagnosticsMetricsService();
  const gateway = makeGateway(
    new WriteLockService(),
    makeAuthService(),
    terminalMetrics,
  );
  if (previousTimeout === undefined) {
    delete process.env.CAP_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS;
  } else {
    process.env.CAP_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS = previousTimeout;
  }
  const never = new Promise<TerminalTransportCleanupSettlement>(() => {});
  const factory = new FakeViewerFactory(
    () =>
      new FakeAttachment(Promise.resolve({ kind: 'ready' }), never),
  );
  register(gateway, TASK_A, factory, new FakeOwner());
  const socket = new FakeSocket();
  await connect(gateway, socket);
  attach(gateway, socket, 80, 24);
  await settle();

  const startedAt = Date.now();
  const summary = await gateway.shutdownTerminalResources();

  assert.equal(summary.kind, 'indeterminate');
  assert.equal(summary.timeoutMs, 15);
  assert.equal(summary.sourceCount, 2);
  assert.equal(summary.ownerSourceCount, 1);
  assert.equal(summary.viewerSourceCount, 1);
  assert.equal(summary.confirmedSourceCount, 0);
  assert.equal(summary.indeterminateSourceCount, 1);
  assert.equal(summary.timedOutSourceCount, 1);
  assert.equal(summary.causes.cleanupUnsupported, 1);
  assert.equal(summary.causes.timeout, 1);
  assert.ok(Date.now() - startedAt < 500, 'shutdown exceeded its hard bound');
  assert.equal(ownerCleanupIdentityLeak(summary), false);
  const metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 0, pausedViewers: 0 });
  assert.equal(terminalMetricCount(metrics.cleanupOutcomes, 'confirmed'), 0);
  assert.equal(terminalMetricCount(metrics.cleanupOutcomes, 'indeterminate'), 2);
});

function ownerCleanupIdentityLeak(value: unknown): boolean {
  return /session[_-]?id|execution[_-]?id|provider[_-]?(?:url|endpoint)|token/iu.test(
    JSON.stringify(value),
  );
}

test('gateway rejects protocol/profile mismatch before provider open and counts reload outcomes', async () => {
  const terminalMetrics = new TerminalDiagnosticsMetricsService();
  const gateway = makeGateway(
    new WriteLockService(),
    makeAuthService(),
    terminalMetrics,
  );
  const factory = new FakeViewerFactory();
  register(gateway, TASK_A, factory);
  const gatewayInternals = gateway as unknown as {
    createTerminalQueryObserver(state: unknown): TerminalQueryObserver;
  };
  let queryObserverCreationCount = 0;
  gatewayInternals.createTerminalQueryObserver = () => {
    queryObserverCreationCount += 1;
    throw new Error('mismatch must not create a terminal query observer');
  };

  const protocolMismatch = new FakeSocket();
  await connect(gateway, protocolMismatch);
  message(gateway, protocolMismatch, {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'terminal_attach',
    protocolVersion: TERMINAL_PROTOCOL_VERSION + 1,
    responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
    cols: 80,
    rows: 24,
  });

  const profileMismatch = new FakeSocket();
  await connect(gateway, profileMismatch);
  message(gateway, profileMismatch, {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'terminal_attach',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    responseProfileId: `xterm-response-v1-sha256-${'0'.repeat(64)}`,
    cols: 80,
    rows: 24,
  });
  await settle();

  for (const [socket, reason] of [
    [protocolMismatch, 'protocol_mismatch'],
    [profileMismatch, 'response_profile_mismatch'],
  ] as const) {
    const frame = framesOf(socket, 'terminal_attachment_state').at(-1)!;
    assert.equal(frame.state, 'failed');
    assert.equal(frame.reason, reason);
    assert.equal(frame.reloadRequired, true);
    assert.equal(socket.closedWith, 1008, 'reload-required mismatch closes its socket');

    attach(gateway, socket, 80, 24);
  }
  await settle();

  assert.equal(factory.opens.length, 0, 'mismatch cannot open a provider PTY');
  assert.equal(
    gateway.getProviderTerminalStoryResourceState(TASK_A).activeViewerCount,
    0,
    'mismatch cannot activate a viewer',
  );
  assert.equal(
    queryObserverCreationCount,
    0,
    'negotiation mismatch must precede query-observer construction',
  );
  assert.deepEqual(
    [protocolMismatch, profileMismatch].map(
      (socket) => framesOf(socket, 'terminal_attachment_state').length,
    ),
    [1, 1],
    'the failed first attach consumes the sole attempt on each socket',
  );
  const metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 0, pausedViewers: 0 });
  assert.equal(terminalMetricCount(metrics.attachOutcomes, 'protocol_mismatch'), 1);
  assert.equal(
    terminalMetricCount(metrics.attachOutcomes, 'response_profile_mismatch'),
    1,
  );
});

test('fresh viewers have independent PTYs, byte input, backpressure, and writer geometry', async () => {
  const terminalMetrics = new TerminalDiagnosticsMetricsService();
  const gateway = makeGateway(
    new WriteLockService(),
    makeAuthService(),
    terminalMetrics,
  );
  const factory = new FakeViewerFactory();
  const owner = new FakeOwner();
  const session = register(gateway, TASK_A, factory, owner);
  const writer = new FakeSocket();
  const reader = new FakeSocket();
  await connect(gateway, writer);
  await connect(gateway, reader);

  attach(gateway, writer, 120, 40);
  attach(gateway, reader, 90, 30);
  await settle();

  assert.equal(factory.opens.length, 2);
  assert.notEqual(factory.attachments[0], factory.attachments[1]);
  assert.deepEqual(factory.opens.map(({ cols, rows }) => [cols, rows]), [
    [120, 40],
    [120, 40],
  ]);
  assert.deepEqual(session.geometry, { cols: 120, rows: 40 });
  assert.deepEqual(owner.resizes.at(-1), [120, 40]);
  assert.equal(framesOf(writer, 'terminal_attachment_state').at(-1)?.state, 'ready');
  assert.equal(framesOf(reader, 'terminal_attachment_state').at(-1)?.state, 'ready');
  let metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 2, pausedViewers: 0 });
  assert.equal(terminalMetricCount(metrics.attachOutcomes, 'ready'), 2);

  message(gateway, writer, {
    channel: 'control',
    type: 'heartbeat',
    sessionId: TASK_A,
    writerClientId: 'browser-tab-writer',
  });
  assert.equal(writer.closedWith, null);

  factory.attachments[0]!.emit(Uint8Array.of(0x41));
  factory.attachments[1]!.emit(Uint8Array.of(0x42));
  const writerRaw = writer.frames.filter((frame) => frame.channel === 'raw');
  const readerRaw = reader.frames.filter((frame) => frame.channel === 'raw');
  assert.deepEqual(writerRaw.map((frame) => Buffer.from(String(frame.data), 'base64')), [
    Buffer.from([0x41]),
  ]);
  assert.deepEqual(readerRaw.map((frame) => Buffer.from(String(frame.data), 'base64')), [
    Buffer.from([0x42]),
  ]);

  const opaque = Buffer.from([0x00, 0x1b, 0x80, 0xff]);
  message(gateway, writer, {
    channel: 'control',
    type: 'keystroke',
    sessionId: TASK_A,
    data: opaque.toString('base64'),
  });
  message(gateway, reader, {
    channel: 'control',
    type: 'keystroke',
    sessionId: TASK_A,
    data: Buffer.from('reader').toString('base64'),
  });
  assert.deepEqual(
    factory.attachments[0]!.writes.map((data) => Buffer.from(data)),
    [opaque],
  );
  assert.deepEqual(factory.attachments[1]!.writes, []);
  assert.deepEqual(owner.writes, [], 'browser input never targets ownerPty');

  const statusResponse = Buffer.from('\u001b[0n');
  const mixedWriterBurst = Buffer.concat([statusResponse, Buffer.from('x')]);
  factory.attachments[0]!.emit(Buffer.from('\u001b[5n'));
  message(gateway, writer, {
    channel: 'control',
    type: 'keystroke',
    sessionId: TASK_A,
    data: mixedWriterBurst.toString('base64'),
  });
  message(gateway, writer, {
    channel: 'control',
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: statusResponse.toString('base64'),
  });
  assert.deepEqual(
    factory.attachments[0]!.writes.map((data) => Buffer.from(data)),
    [opaque, mixedWriterBurst],
    'mixed writer input is written once unchanged and consumes replay authority',
  );
  assert.deepEqual(
    factory.attachments[0]!.terminalResponseWrites,
    [],
    'a response replay cannot cross into the explicit terminal-response channel',
  );

  message(gateway, reader, {
    channel: 'control',
    type: 'resize',
    cols: 100,
    rows: 20,
  });
  assert.deepEqual(session.geometry, { cols: 120, rows: 40 });

  message(gateway, writer, {
    channel: 'control',
    type: 'resize',
    cols: 110,
    rows: 35,
  });
  assert.deepEqual(session.geometry, { cols: 110, rows: 35 });
  assert.deepEqual(owner.resizes.at(-1), [110, 35]);
  assert.deepEqual(factory.attachments[0]!.resizes.at(-1), [110, 35]);
  assert.deepEqual(factory.attachments[1]!.resizes.at(-1), [110, 35]);

  message(gateway, reader, {
    channel: 'control',
    type: 'takeover_request',
    sessionId: TASK_A,
    clientId: 'browser-tab-reader',
  });
  assert.deepEqual(session.geometry, { cols: 100, rows: 20 });

  const slow = new Uint8Array(500_000);
  factory.attachments[0]!.emit(slow);
  assert.equal(factory.attachments[0]!.pauseCount, 1);
  assert.equal(factory.attachments[1]!.pauseCount, 0);
  metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 2, pausedViewers: 1 });
  assert.equal(metrics.flowControl.pauseCount, 1);
  const lastRaw = writer.frames.filter((frame) => frame.channel === 'raw').at(-1)!;
  message(gateway, writer, {
    channel: 'control',
    type: 'ack',
    seq: lastRaw.seq,
  });
  assert.equal(factory.attachments[0]!.resumeCount, 1);
  assert.equal(factory.attachments[1]!.resumeCount, 0);
  metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 2, pausedViewers: 0 });
  assert.equal(metrics.flowControl.resumeCount, 1);

  const frozen = (
    gateway as unknown as {
      clients: Map<unknown, { binding: unknown }>;
    }
  ).clients.get(writer)!.binding;
  assert.equal(JSON.stringify(frozen).includes('token-a'), false);

  gateway.handleDisconnect(writer as never);
  assert.equal(factory.attachments[0]!.closed, true);
  assert.equal(factory.attachments[1]!.closed, false);
  assert.equal(owner.closed, false, 'one viewer disconnect cannot close the owner');

  gateway.handleDisconnect(reader as never);
  assert.equal(factory.attachments[1]!.closed, true);
  assert.equal(owner.closed, false, 'full browser disconnect keeps the task owner live');
  await settle();
  metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 0, pausedViewers: 0 });

  const replacementViewer = new FakeSocket();
  await connect(gateway, replacementViewer);
  attach(gateway, replacementViewer, 100, 20);
  await settle();
  assert.equal(factory.attachments.length, 3);
  assert.notEqual(factory.attachments[2], factory.attachments[0]);
  assert.equal(
    framesOf(replacementViewer, 'terminal_attachment_state').at(-1)?.state,
    'ready',
  );
  assert.equal(owner.closed, false, 'fresh viewer reconnect never relaunches or replaces owner');
  metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 1, pausedViewers: 0 });
  assert.equal(terminalMetricCount(metrics.attachOutcomes, 'ready'), 3);
  assertNoLiveHistoryFrames(
    [writer, reader, replacementViewer],
    'normal writer, reader, and replacement frames cannot contain snapshot/tail replay',
  );
});

test('viewer repaint is excluded from owner-only activity accounting', async () => {
  const activity: string[] = [];
  const gateway = new TerminalGateway(
    new WriteLockService(),
    { recordActivity: (taskId: string) => activity.push(taskId) } as never,
    makeAuthService(),
  );
  const factory = new FakeViewerFactory();
  register(gateway, TASK_A, factory);
  const socket = new FakeSocket();
  await connect(gateway, socket);
  attach(gateway, socket, 80, 24);
  await settle();

  factory.attachments[0]!.emit(Uint8Array.of(0x1b, 0x5b, 0x32, 0x4a));
  assert.deepEqual(activity, []);

  (
    gateway as unknown as {
      onPtyOutput(taskId: string, chunk: string): void;
    }
  ).onPtyOutput(TASK_A, 'canonical owner output\r\n');
  assert.deepEqual(activity, [TASK_A]);
});

test('attaching reader responses are query-correlated before raw delivery', async () => {
  const ready = deferred<TerminalViewerAttachmentOutcome>();
  const factory = new FakeViewerFactory(() => new FakeAttachment(ready.promise));
  const writeLock = new WriteLockService();
  const gateway = makeGateway(writeLock);
  const owner = new FakeOwner();
  register(gateway, TASK_A, factory, owner);
  const writer = new FakeSocket();
  const reader = new FakeSocket();
  await connect(gateway, writer);
  await connect(gateway, reader);
  attach(gateway, writer, 80, 24);
  attach(gateway, reader, 80, 24);
  await settle();

  const query = Buffer.from('\u001b[5n');
  const response = Buffer.from('\u001b[0n');
  reader.onSend = (frame) => {
    if (frame.channel !== 'raw') return;
    message(gateway, reader, {
      channel: 'control',
      type: 'terminal_response',
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      data: response.toString('base64'),
    });
  };
  factory.attachments[1]!.emit(query);

  assert.deepEqual(
    factory.attachments[1]!.terminalResponseWrites.map((bytes) => Buffer.from(bytes)),
    [response],
    'query token must exist before the raw trigger reaches the browser',
  );
  assert.deepEqual(factory.attachments[1]!.writes, []);
  assert.deepEqual(factory.attachments[0]!.writes, []);
  assert.deepEqual(factory.attachments[0]!.terminalResponseWrites, []);
  assert.deepEqual(owner.writes, []);

  reader.onSend = undefined;
  factory.attachments[1]!.emit(query);
  message(gateway, writer, {
    channel: 'control',
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: response.toString('base64'),
  });
  assert.deepEqual(factory.attachments[0]!.writes, []);
  message(gateway, reader, {
    channel: 'control',
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: response.toString('base64'),
  });
  message(gateway, reader, {
    channel: 'control',
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: response.toString('base64'),
  });
  assert.deepEqual(
    factory.attachments[1]!.terminalResponseWrites.map((bytes) => Buffer.from(bytes)),
    [response, response],
    'cross-viewer and replayed responses cannot reuse a reader token',
  );
  assert.deepEqual(factory.attachments[1]!.writes, []);

  factory.attachments[1]!.emit(query);
  factory.attachments[1]!.nextWriteOutcome = 'unsupported';
  message(gateway, reader, {
    channel: 'control',
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: response.toString('base64'),
  });
  assert.equal(factory.attachments[1]!.closed, true);
  assert.equal(
    framesOf(reader, 'terminal_attachment_state').at(-1)?.reason,
    'provider_failed',
  );

  ready.resolve({ kind: 'ready' });
  await settle();
});

test('gateway rejects unauthorized terminal-response matrix without any unintended PTY write', async () => {
  const statusQuery = Buffer.from('\u001b[5n');
  const statusResponse = Buffer.from('\u001b[0n');
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly expectedObserverReason:
      | 'invalid_response'
      | 'profile_disabled'
      | 'unmatched'
      | null;
    readonly prepare?: (context: {
      readonly gateway: TerminalGateway;
      readonly factory: FakeViewerFactory;
      readonly writer: FakeSocket;
      readonly reader: FakeSocket;
      readonly clock: { now: number };
    }) => void | Promise<void>;
    readonly reject: (context: {
      readonly gateway: TerminalGateway;
      readonly factory: FakeViewerFactory;
      readonly writer: FakeSocket;
      readonly reader: FakeSocket;
      readonly clock: { now: number };
    }) => void;
  }> = [
    {
      name: 'unsolicited',
      expectedObserverReason: 'unmatched',
      reject: ({ gateway, reader }) => {
        message(gateway, reader, {
          channel: 'control',
          type: 'terminal_response',
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          data: statusResponse.toString('base64'),
        });
      },
    },
    {
      name: 'expired at the exact TTL boundary',
      expectedObserverReason: 'unmatched',
      prepare: ({ factory, clock }) => {
        factory.attachments[1]!.emit(statusQuery);
        clock.now = 10;
      },
      reject: ({ gateway, reader }) => {
        message(gateway, reader, {
          channel: 'control',
          type: 'terminal_response',
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          data: statusResponse.toString('base64'),
        });
      },
    },
    {
      name: 'unsupported response grammar',
      expectedObserverReason: null,
      prepare: ({ factory }) => {
        factory.attachments[1]!.emit(statusQuery);
      },
      reject: ({ gateway, reader }) => {
        message(gateway, reader, {
          channel: 'control',
          type: 'terminal_response',
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          data: Buffer.from('\u001b[3n').toString('base64'),
        });
      },
    },
    {
      name: 'profile-disabled window-report grammar',
      expectedObserverReason: null,
      prepare: ({ factory }) => {
        factory.attachments[1]!.emit(Buffer.from('\u001b[14t'));
      },
      reject: ({ gateway, reader }) => {
        message(gateway, reader, {
          channel: 'control',
          type: 'terminal_response',
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          data: Buffer.from('\u001b[4;480;640t').toString('base64'),
        });
      },
    },
    {
      name: 'replay after one valid response',
      expectedObserverReason: 'unmatched',
      prepare: async ({ gateway, factory, reader }) => {
        factory.attachments[1]!.emit(statusQuery);
        message(gateway, reader, {
          channel: 'control',
          type: 'terminal_response',
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          data: statusResponse.toString('base64'),
        });
        await settle();
        assert.deepEqual(
          factory.attachments[1]!.terminalResponseWrites.map((bytes) =>
            Buffer.from(bytes),
          ),
          [statusResponse],
          'the replay case must first exercise one authorized response write',
        );
      },
      reject: ({ gateway, reader }) => {
        message(gateway, reader, {
          channel: 'control',
          type: 'terminal_response',
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          data: statusResponse.toString('base64'),
        });
      },
    },
    {
      name: 'cross-viewer response',
      expectedObserverReason: 'unmatched',
      prepare: ({ factory }) => {
        factory.attachments[1]!.emit(statusQuery);
      },
      reject: ({ gateway, writer }) => {
        message(gateway, writer, {
          channel: 'control',
          type: 'terminal_response',
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          data: statusResponse.toString('base64'),
        });
      },
    },
    {
      name: 'close-cleared response',
      expectedObserverReason: null,
      prepare: ({ gateway, factory, reader }) => {
        factory.attachments[1]!.emit(statusQuery);
        const observer = (
          gateway as unknown as {
            clients: Map<unknown, { queryObserver: TerminalQueryObserver }>;
          }
        ).clients.get(reader)!.queryObserver;
        assert.equal(observer.pending, 1, 'close case must begin with one live query');
        gateway.handleDisconnect(reader as never);
        assert.equal(observer.isClosed, true);
        assert.equal(observer.pending, 0, 'close must clear every query token');
      },
      reject: ({ gateway, reader }) => {
        message(gateway, reader, {
          channel: 'control',
          type: 'terminal_response',
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          data: statusResponse.toString('base64'),
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    const clock = { now: 0 };
    const gateway = makeGateway();
    const queryConfig = (
      gateway as unknown as {
        terminalQueryConfig: {
          ttlMs?: number;
          now?: () => number;
        };
      }
    ).terminalQueryConfig;
    queryConfig.ttlMs = 10;
    queryConfig.now = () => clock.now;

    const factory = new FakeViewerFactory();
    const owner = new FakeOwner();
    register(gateway, TASK_A, factory, owner);
    const events: ProviderTerminalStoryTelemetryEvent[] = [];
    const observation = gateway.observeProviderTerminalStory(TASK_A, {
      onEvent(event) {
        events.push(event);
      },
    });
    const writer = new FakeSocket();
    const reader = new FakeSocket();
    await connect(gateway, writer);
    await connect(gateway, reader);
    attach(gateway, writer, 80, 24);
    attach(gateway, reader, 80, 24);
    await settle();

    const context = { gateway, factory, writer, reader, clock };
    await scenario.prepare?.(context);
    const writesBeforeRejection = factory.attachments.map((attachment) => ({
      keystrokes: attachment.writes.map((bytes) => Buffer.from(bytes)),
      terminalResponses: attachment.terminalResponseWrites.map((bytes) =>
        Buffer.from(bytes),
      ),
    }));
    const ownerWritesBeforeRejection = [...owner.writes];
    const responseEventsBeforeRejection = events.filter(
      (event) => event.type === 'response',
    ).length;

    scenario.reject(context);
    await settle();

    assert.deepEqual(
      factory.attachments.map((attachment) =>
        ({
          keystrokes: attachment.writes.map((bytes) => Buffer.from(bytes)),
          terminalResponses: attachment.terminalResponseWrites.map((bytes) =>
            Buffer.from(bytes),
          ),
        }),
      ),
      writesBeforeRejection,
      `${scenario.name}: rejected response reached an attachment PTY`,
    );
    assert.deepEqual(
      owner.writes,
      ownerWritesBeforeRejection,
      `${scenario.name}: browser response reached the owner PTY`,
    );
    assertNoLiveHistoryFrames(
      [writer, reader],
      `${scenario.name}: gateway emitted removed snapshot/tail replay`,
    );

    const responseEventsAfterRejection = events
      .filter((event) => event.type === 'response')
      .slice(responseEventsBeforeRejection);
    if (scenario.expectedObserverReason === null) {
      assert.deepEqual(
        responseEventsAfterRejection,
        [],
        `${scenario.name}: frame must be rejected before observer validation`,
      );
    } else {
      assert.equal(responseEventsAfterRejection.length, 1, scenario.name);
      const rejected = responseEventsAfterRejection[0];
      assert.equal(rejected?.type, 'response', scenario.name);
      if (rejected?.type === 'response') {
        assert.equal(rejected.accepted, false, scenario.name);
        assert.equal(
          rejected.reason,
          scenario.expectedObserverReason,
          scenario.name,
        );
      }
    }

    observation.dispose();
    gateway.handleDisconnect(writer as never);
    gateway.handleDisconnect(reader as never);
  }
});

test('task unregister closes query authorization before a later response', async () => {
  const factory = new FakeViewerFactory();
  const gateway = makeGateway();
  register(gateway, TASK_A, factory);
  const socket = new FakeSocket();
  await connect(gateway, socket);
  attach(gateway, socket, 80, 24);
  await settle();

  factory.attachments[0]!.emit(Buffer.from('\u001b[5n'));
  gateway.unregisterSession(TASK_A);
  message(gateway, socket, {
    channel: 'control',
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: Buffer.from('\u001b[0n').toString('base64'),
  });

  assert.equal(factory.attachments[0]!.closed, true);
  assert.deepEqual(factory.attachments[0]!.writes, []);
  assert.deepEqual(factory.attachments[0]!.terminalResponseWrites, []);
});

test('generation recheck prevents an old-PTY write after query consume', async () => {
  const factory = new FakeViewerFactory();
  const gateway = makeGateway();
  register(gateway, TASK_A, factory);
  const socket = new FakeSocket();
  await connect(gateway, socket);
  attach(gateway, socket, 80, 24);
  await settle();

  factory.attachments[0]!.emit(Buffer.from('\u001b[5n'));
  const state = (
    gateway as unknown as {
      clients: Map<unknown, { queryObserver: TerminalQueryObserver }>;
    }
  ).clients.get(socket)!;
  const observer = state.queryObserver;
  const consume = observer.consumeAndWriteResponse.bind(observer);
  observer.consumeAndWriteResponse = (bytes, geometry, write) =>
    consume(bytes, geometry, (authorizedBytes) => {
      // Inject the close exactly after the observer consumed the token and
      // immediately before Gateway's captured attachment write callback.
      gateway.unregisterSession(TASK_A);
      return write(authorizedBytes);
    });

  message(gateway, socket, {
    channel: 'control',
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: Buffer.from('\u001b[0n').toString('base64'),
  });
  await settle();

  assert.equal(factory.attachments[0]!.closed, true);
  assert.deepEqual(factory.attachments[0]!.writes, []);
  assert.deepEqual(factory.attachments[0]!.terminalResponseWrites, []);
});

test('close/replacement/auth/task-unregister fence response writes at every transaction checkpoint', async () => {
  const checkpoints: readonly TerminalResponseWriteCheckpoint[] = [
    'before_validation',
    'after_validation',
    'after_consume',
  ];
  const lifecycleKinds = [
    'close',
    'replacement',
    'auth_failure',
    'task_unregister',
  ] as const;

  for (const lifecycleKind of lifecycleKinds) {
    for (const checkpoint of checkpoints) {
      const factory = new FakeViewerFactory();
      const gateway = makeGateway();
      register(gateway, TASK_A, factory);
      const socket = new FakeSocket();
      await connect(gateway, socket);
      attach(gateway, socket, 80, 24);
      await settle();

      const oldAttachment = factory.attachments[0]!;
      oldAttachment.emit(Buffer.from('\u001b[5n'));
      const state = (
        gateway as unknown as {
          clients: Map<unknown, {
            queryObserver: TerminalQueryObserver;
          }>;
          failAuthentication(client: unknown, state: unknown): void;
        }
      ).clients.get(socket)!;
      const observer = state.queryObserver;
      const consume = observer.consumeAndWriteResponse.bind(observer);
      let checkpointTriggered = false;

      const invalidate = (): void => {
        switch (lifecycleKind) {
          case 'close':
            gateway.handleDisconnect(socket as never);
            return;
          case 'replacement':
            register(gateway, TASK_A, new FakeViewerFactory());
            return;
          case 'auth_failure':
            (
              gateway as unknown as {
                failAuthentication(client: unknown, state: unknown): void;
              }
            ).failAuthentication(socket, state);
            return;
          case 'task_unregister':
            gateway.unregisterSession(TASK_A);
        }
      };

      observer.consumeAndWriteResponse = (bytes, geometry, write, fence) =>
        consume(
          bytes,
          geometry,
          write,
          ((currentCheckpoint) => {
            if (!checkpointTriggered && currentCheckpoint === checkpoint) {
              checkpointTriggered = true;
              invalidate();
            }
            return fence?.(currentCheckpoint) ?? true;
          }) satisfies TerminalResponseWriteFence,
        );

      message(gateway, socket, {
        channel: 'control',
        type: 'terminal_response',
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        data: Buffer.from('\u001b[0n').toString('base64'),
      });
      await settle();

      assert.equal(
        checkpointTriggered,
        true,
        `${lifecycleKind}/${checkpoint} checkpoint was not exercised`,
      );
      assert.equal(oldAttachment.closed, true, `${lifecycleKind}/${checkpoint}`);
      assert.equal(oldAttachment.closeCount, 1, `${lifecycleKind}/${checkpoint}`);
      assert.deepEqual(oldAttachment.writes, [], `${lifecycleKind}/${checkpoint}`);
      assert.deepEqual(
        oldAttachment.terminalResponseWrites,
        [],
        `${lifecycleKind}/${checkpoint}`,
      );
    }
  }
});

test('reauth failure clears query authorization and closes only its viewer', async () => {
  const factory = new FakeViewerFactory();
  const gateway = makeGateway();
  register(gateway, TASK_A, factory);
  const socket = new FakeSocket();
  const peer = new FakeSocket();
  await connect(gateway, socket);
  await connect(gateway, peer);
  attach(gateway, socket, 80, 24);
  attach(gateway, peer, 80, 24);
  await settle();

  factory.attachments[0]!.emit(Buffer.from('\u001b[5n'));
  message(gateway, socket, {
    channel: 'control',
    type: 'connect_auth',
    token: 'invalid-token',
    taskId: TASK_A,
  });
  await settle();
  message(gateway, socket, {
    channel: 'control',
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: Buffer.from('\u001b[0n').toString('base64'),
  });

  assert.equal(socket.closedWith, 1008);
  assert.equal(factory.attachments[0]!.closed, true);
  assert.equal(factory.attachments[1]!.closed, false);
  assert.deepEqual(factory.attachments[0]!.writes, []);
  assert.deepEqual(factory.attachments[0]!.terminalResponseWrites, []);
});

test('binding is frozen before owner await and retarget closes without provider open', async () => {
  const ownerGate = deferred<{ readonly kind: 'attached' }>();
  const owner = new FakeOwner(ownerGate.promise);
  const factory = new FakeViewerFactory();
  const gateway = makeGateway();
  register(gateway, TASK_A, factory, owner);
  const socket = new FakeSocket();
  await connect(gateway, socket);

  attach(gateway, socket, 100, 30);
  const state = (
    gateway as unknown as {
      clients: Map<unknown, {
        phase: string;
        binding: { boundTaskId: string; principalIdentity: { userId: string } };
      }>;
    }
  ).clients.get(socket)!;
  assert.equal(state.phase, 'attaching');
  assert.equal(state.binding.boundTaskId, TASK_A);
  assert.equal(state.binding.principalIdentity.userId, USER_A.id);
  assert.equal(factory.opens.length, 0, 'owner decision is awaited after binding freeze');

  message(gateway, socket, {
    channel: 'control',
    type: 'connect_auth',
    token: 'token-a',
    taskId: TASK_B,
  });
  assert.equal(socket.closedWith, 1008);
  ownerGate.resolve({ kind: 'attached' });
  await settle();
  assert.equal(factory.opens.length, 0);
});

test('pending provider attachment cross-task and wrong-direction frame matrix fail-closes exactly', async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly frame: Readonly<Record<string, unknown>>;
    readonly pendingApprovalTask?: string;
  }> = [
    {
      name: 'connect_auth',
      frame: {
        channel: 'control',
        type: 'connect_auth',
        token: 'token-a',
        taskId: TASK_B,
      },
    },
    {
      name: 'second terminal_attach',
      frame: {
        channel: 'control',
        type: 'terminal_attach',
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
        cols: 90,
        rows: 30,
      },
    },
    {
      name: 'keystroke',
      frame: {
        channel: 'control',
        type: 'keystroke',
        sessionId: TASK_B,
        data: Buffer.from('cross-task').toString('base64'),
      },
    },
    {
      name: 'heartbeat',
      frame: {
        channel: 'control',
        type: 'heartbeat',
        sessionId: TASK_B,
        writerClientId: 'browser-client-id',
      },
    },
    {
      name: 'takeover_request',
      frame: {
        channel: 'control',
        type: 'takeover_request',
        sessionId: TASK_B,
        clientId: 'browser-client-id',
      },
    },
    {
      name: 'pending approval decision',
      pendingApprovalTask: TASK_B,
      frame: {
        channel: 'control',
        type: 'decision',
        requestId: 'pending-task-b',
        decision: { behavior: 'deny' },
      },
    },
    {
      name: 'permission_request',
      frame: {
        channel: 'control',
        type: 'permission_request',
        requestId: 'cross-task-permission',
        taskId: TASK_B,
        toolName: 'shell',
        toolInput: {},
      },
    },
    {
      name: 'post_tool_use_report',
      frame: {
        channel: 'control',
        type: 'post_tool_use_report',
        taskId: TASK_B,
        edits: [],
      },
    },
    {
      name: 'lease_state',
      frame: {
        channel: 'control',
        type: 'lease_state',
        sessionId: TASK_B,
        lease: null,
      },
    },
    { name: 'pause', frame: { channel: 'control', type: 'pause' } },
    { name: 'resume', frame: { channel: 'control', type: 'resume' } },
  ];

  for (const scenario of cases) {
    const decision = deferred<TerminalViewerAttachmentOutcome>();
    const factory = new FakeViewerFactory(
      () => new FakeAttachment(decision.promise),
    );
    const writeLock = new WriteLockService();
    const gateway = makeGateway(writeLock);
    const owner = new FakeOwner();
    register(gateway, TASK_A, factory, owner);
    const socket = new FakeSocket();
    await connect(gateway, socket);
    attach(gateway, socket, 80, 24);
    await settle();
    assert.equal(factory.opens.length, 1, scenario.name);

    if (scenario.pendingApprovalTask) {
      gateway.onPermissionRequest({
        channel: 'control',
        type: 'permission_request',
        requestId: 'pending-task-b',
        taskId: scenario.pendingApprovalTask,
        toolName: 'shell',
        toolInput: {},
      });
    }
    message(gateway, socket, scenario.frame);

    assert.equal(socket.closedWith, 1008, scenario.name);
    assert.equal(factory.attachments[0]!.closed, true, scenario.name);
    assert.equal(factory.attachments[0]!.closeCount, 1, scenario.name);
    assert.deepEqual(factory.attachments[0]!.writes, [], scenario.name);
    assert.equal(owner.closed, false, scenario.name);
    assert.equal(writeLock.getLease(TASK_B), null, scenario.name);
    if (scenario.pendingApprovalTask) {
      assert.equal(
        gateway.listPendingApprovals().some(({ requestId }) => requestId === 'pending-task-b'),
        true,
        'cross-task decision cannot consume another task approval',
      );
    }

    decision.resolve({ kind: 'ready' });
    await settle();
    assert.equal(factory.attachments[0]!.closeCount, 1, `${scenario.name} late ready`);
  }
});

test('auth-attempt epoch ignores a late pre-attach resolution', async () => {
  const oldAuth = deferred<SessionUser | null>();
  const auth = makeAuthService(async (token) => {
    if (token === 'old') return oldAuth.promise;
    if (token === 'new') return USER_B;
    return null;
  });
  const writeLock = new WriteLockService();
  const gateway = makeGateway(writeLock, auth);
  const socket = new FakeSocket();
  gateway.handleConnection(
    socket as never,
    { url: `/terminal?taskId=${TASK_A}&token=old`, headers: {} } as never,
  );
  message(gateway, socket, {
    channel: 'control',
    type: 'connect_auth',
    token: 'new',
    taskId: TASK_B,
  });
  await settle();
  oldAuth.resolve(USER_A);
  await settle();

  const state = (
    gateway as unknown as {
      clients: Map<unknown, {
        requestedTaskId: string;
        principalIdentity: { userId: string };
      }>;
    }
  ).clients.get(socket)!;
  assert.equal(state.requestedTaskId, TASK_B);
  assert.equal(state.principalIdentity.userId, USER_B.id);
  assert.equal(socket.closedWith, null);
  assert.equal(writeLock.getLease(TASK_A), null);
  assert.equal(writeLock.getLease(TASK_B), null);
});

test('viewer admission configuration fails closed outside hard bounds', () => {
  const priorLimit = process.env.CAP_TERMINAL_VIEWER_LIMIT_PER_TASK;
  const priorTimeout = process.env.CAP_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS;
  try {
    process.env.CAP_TERMINAL_VIEWER_LIMIT_PER_TASK = '65';
    delete process.env.CAP_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS;
    assert.throws(() => makeGateway(), /CAP_TERMINAL_VIEWER_LIMIT_PER_TASK/);

    process.env.CAP_TERMINAL_VIEWER_LIMIT_PER_TASK = '8';
    process.env.CAP_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS = '0';
    assert.throws(() => makeGateway(), /CAP_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS/);
  } finally {
    if (priorLimit === undefined) {
      delete process.env.CAP_TERMINAL_VIEWER_LIMIT_PER_TASK;
    } else {
      process.env.CAP_TERMINAL_VIEWER_LIMIT_PER_TASK = priorLimit;
    }
    if (priorTimeout === undefined) {
      delete process.env.CAP_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS;
    } else {
      process.env.CAP_TERMINAL_VIEWER_ATTACH_TIMEOUT_MS = priorTimeout;
    }
  }
});

test('invalid terminal-query configuration fails before provider open', async () => {
  const names = [
    'CAP_TERMINAL_QUERY_TTL_MS',
    'CAP_TERMINAL_QUERY_CAPACITY',
    'CAP_TERMINAL_RESPONSE_RATE_LIMIT',
    'CAP_TERMINAL_RESPONSE_RATE_WINDOW_MS',
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const invalid: ReadonlyArray<readonly [(typeof names)[number], string]> = [
    ['CAP_TERMINAL_QUERY_TTL_MS', 'NaN'],
    ['CAP_TERMINAL_QUERY_TTL_MS', 'Infinity'],
    ['CAP_TERMINAL_QUERY_TTL_MS', '0'],
    ['CAP_TERMINAL_QUERY_TTL_MS', '-1'],
    ['CAP_TERMINAL_QUERY_TTL_MS', '30001'],
    ['CAP_TERMINAL_QUERY_CAPACITY', '1.5'],
    ['CAP_TERMINAL_QUERY_CAPACITY', '257'],
    ['CAP_TERMINAL_RESPONSE_RATE_LIMIT', '513'],
    ['CAP_TERMINAL_RESPONSE_RATE_WINDOW_MS', '10001'],
  ];

  try {
    for (const [invalidName, invalidValue] of invalid) {
      for (const name of names) delete process.env[name];
      process.env[invalidName] = invalidValue;

      const gateway = makeGateway();
      const factory = new FakeViewerFactory();
      register(gateway, TASK_A, factory);
      const socket = new FakeSocket();
      await connect(gateway, socket);
      attach(gateway, socket, 80, 24);
      await settle();

      assert.equal(factory.opens.length, 0, `${invalidName} opened a provider PTY`);
      const state = framesOf(socket, 'terminal_attachment_state').at(-1)!;
      assert.equal(state.state, 'failed');
      assert.equal(state.reason, 'internal_error');
    }
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('viewer limit and attach timeout are explicit and consume the socket attempt', async () => {
  const lateDecision = deferred<TerminalViewerAttachmentOutcome>();
  const factory = new FakeViewerFactory(() => new FakeAttachment(lateDecision.promise));
  const writeLock = new WriteLockService();
  const terminalMetrics = new TerminalDiagnosticsMetricsService();
  const gateway = makeGateway(writeLock, makeAuthService(), terminalMetrics);
  (
    gateway as unknown as {
      viewerLimitPerTask: number;
      viewerAttachTimeoutMs: number;
    }
  ).viewerLimitPerTask = 1;
  (
    gateway as unknown as { viewerAttachTimeoutMs: number }
  ).viewerAttachTimeoutMs = 5;
  register(gateway, TASK_A, factory);
  const first = new FakeSocket();
  const overflow = new FakeSocket();
  await connect(gateway, first);
  await connect(gateway, overflow);

  attach(gateway, first, 80, 24);
  attach(gateway, overflow, 80, 24);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  await settle();

  const overflowState = framesOf(overflow, 'terminal_attachment_state').at(-1)!;
  assert.equal(overflowState.state, 'unavailable');
  assert.equal(overflowState.reason, 'viewer_limit');
  const firstState = framesOf(first, 'terminal_attachment_state').at(-1)!;
  assert.equal(firstState.state, 'failed');
  assert.equal(firstState.reason, 'attach_timeout');
  assert.equal(factory.opens.length, 1);
  assert.equal(factory.attachments[0]!.closed, true);
  assert.equal(factory.attachments[0]!.closeCount, 1, 'timeout exact-closes its one PTY');
  assert.equal(writeLock.getLease(TASK_A), null);
  const metrics = terminalMetrics.currentSnapshot();
  assert.deepEqual(metrics.gauges, { activeViewers: 0, pausedViewers: 0 });
  assert.equal(terminalMetricCount(metrics.attachOutcomes, 'viewer_limit'), 1);
  assert.equal(terminalMetricCount(metrics.attachOutcomes, 'attach_timeout'), 1);

  lateDecision.resolve({ kind: 'ready' });
  await settle();
  assert.equal(
    factory.attachments[0]!.closeCount,
    1,
    'late provider settlement cannot close or adopt the timed-out PTY twice',
  );

  attach(gateway, overflow, 80, 24);
  assert.equal(overflow.closedWith, 1008, 'a failed/overflow attach cannot retry in-place');
});

test('cross-task task-scoped frames close and exact-close only that viewer', async () => {
  const factory = new FakeViewerFactory();
  const gateway = makeGateway();
  register(gateway, TASK_A, factory);
  const socket = new FakeSocket();
  await connect(gateway, socket);
  attach(gateway, socket, 80, 24);
  await settle();

  const clientId = (
    gateway as unknown as { clients: Map<unknown, { clientId: string }> }
  ).clients.get(socket)!.clientId;
  message(gateway, socket, {
    channel: 'control',
    type: 'heartbeat',
    sessionId: TASK_B,
    writerClientId: clientId,
  });
  assert.equal(socket.closedWith, 1008);
  assert.equal(factory.attachments[0]!.closed, true);
  assert.equal(
    socket.frames.some((frame) => frame.type === 'snapshot' || frame.type === 'tail_replay'),
    false,
  );
});

test('every task-scoped operator frame enforces the frozen task binding', async () => {
  const frames: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    {
      channel: 'control',
      type: 'keystroke',
      sessionId: TASK_B,
      data: Buffer.from('cross-task').toString('base64'),
    },
    {
      channel: 'control',
      type: 'heartbeat',
      sessionId: TASK_B,
      writerClientId: 'browser-client-id',
    },
    {
      channel: 'control',
      type: 'takeover_request',
      sessionId: TASK_B,
      clientId: 'browser-client-id',
    },
    {
      channel: 'control',
      type: 'permission_request',
      requestId: 'cross-task-permission',
      taskId: TASK_B,
      toolName: 'shell',
      toolInput: {},
    },
    {
      channel: 'control',
      type: 'post_tool_use_report',
      taskId: TASK_B,
      edits: [],
    },
    {
      channel: 'control',
      type: 'lease_state',
      sessionId: TASK_B,
      lease: null,
    },
  ];

  for (const frame of frames) {
    const factory = new FakeViewerFactory();
    const gateway = makeGateway();
    register(gateway, TASK_A, factory);
    const socket = new FakeSocket();
    await connect(gateway, socket);
    attach(gateway, socket, 80, 24);
    await settle();

    message(gateway, socket, frame);

    assert.equal(socket.closedWith, 1008, String(frame.type));
    assert.equal(factory.attachments[0]!.closed, true, String(frame.type));
    assert.deepEqual(factory.attachments[0]!.writes, [], String(frame.type));
  }
});

test('approval decisions cannot resolve another task and server-only frames close', async () => {
  const serverOnlyFrames: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    {
      channel: 'control',
      type: 'permission_request',
      requestId: 'same-task-server-only',
      taskId: TASK_A,
      toolName: 'shell',
      toolInput: {},
    },
    { channel: 'control', type: 'pause' },
    { channel: 'control', type: 'resume' },
  ];

  for (const frame of serverOnlyFrames) {
    const factory = new FakeViewerFactory();
    const gateway = makeGateway();
    register(gateway, TASK_A, factory);
    const socket = new FakeSocket();
    await connect(gateway, socket);
    attach(gateway, socket, 80, 24);
    await settle();
    message(gateway, socket, frame);
    assert.equal(socket.closedWith, 1008, String(frame.type));
    assert.equal(factory.attachments[0]!.closed, true, String(frame.type));
  }

  const factory = new FakeViewerFactory();
  const gateway = makeGateway();
  register(gateway, TASK_A, factory);
  const socket = new FakeSocket();
  await connect(gateway, socket);
  attach(gateway, socket, 80, 24);
  await settle();
  gateway.onPermissionRequest({
    channel: 'control',
    type: 'permission_request',
    requestId: 'task-b-decision',
    taskId: TASK_B,
    toolName: 'shell',
    toolInput: {},
  });
  message(gateway, socket, {
    channel: 'control',
    type: 'decision',
    requestId: 'task-b-decision',
    decision: { behavior: 'deny' },
  });

  assert.equal(socket.closedWith, 1008);
  assert.equal(factory.attachments[0]!.closed, true);
  assert.equal(
    gateway.listPendingApprovals().some(({ requestId }) => requestId === 'task-b-decision'),
    true,
    'a cross-task decision must not consume the pending approval',
  );
});

test('provider story inventories the complete active profile and rejects reader onData/onBinary input', async () => {
  const gateway = makeGateway();
  const factory = new FakeViewerFactory();
  register(gateway, TASK_A, factory);
  const events: ProviderTerminalStoryTelemetryEvent[] = [];
  const observation = gateway.observeProviderTerminalStory(TASK_A, {
    onEvent(event) {
      events.push(event);
    },
  });
  const writer = new FakeSocket();
  const reader = new FakeSocket();
  await connect(gateway, writer);
  await connect(gateway, reader);
  attach(gateway, writer, 100, 30);
  attach(gateway, reader, 80, 24);
  await settle();

  const opened = events.filter((event) => event.type === 'viewer_opened');
  assert.equal(opened.length, 2);
  assert.equal(new Set(opened.map((event) => event.attachmentId)).size, 2);
  const readerAttachmentId = opened[1]!.attachmentId;
  assert.deepEqual(gateway.getProviderTerminalStoryResourceState(TASK_A), {
    ownerRegistered: true,
    activeViewerCount: 2,
  });

  const activeProfileInventory = [
    {
      responseClass: 'da1',
      query: Buffer.from('\u001b[c'),
      response: Buffer.from('\u001b[?1;2c'),
    },
    {
      responseClass: 'da2',
      query: Buffer.from('\u001b[>0c'),
      response: Buffer.from('\u001b[>0;276;0c'),
    },
    {
      responseClass: 'dsr_status',
      query: Buffer.from('\u001b[5n'),
      response: Buffer.from('\u001b[0n'),
    },
    {
      responseClass: 'cpr',
      query: Buffer.from('\u001b[6n'),
      response: Buffer.from('\u001b[12;34R'),
    },
    {
      responseClass: 'private_cpr',
      query: Buffer.from('\u001b[?6n'),
      response: Buffer.from('\u001b[?12;34R'),
    },
    {
      responseClass: 'decrqm_ansi',
      query: Buffer.from('\u001b[4$p'),
      response: Buffer.from('\u001b[4;1$y'),
    },
    {
      responseClass: 'decrqm_private',
      query: Buffer.from('\u001b[?1049$p'),
      response: Buffer.from('\u001b[?1049;2$y'),
    },
    {
      responseClass: 'decrqss',
      query: Buffer.from('\u001bP$qm\u001b\\'),
      response: Buffer.from('\u001bP1$r0m\u001b\\'),
    },
    {
      responseClass: 'osc_4',
      query: Buffer.from('\u001b]4;7;?\u0007'),
      response: Buffer.from('\u001b]4;7;rgb:ffff/0000/abcd\u001b\\'),
    },
    {
      responseClass: 'osc_10',
      query: Buffer.from('\u001b]10;?\u0007'),
      response: Buffer.from('\u001b]10;rgb:ffff/ffff/ffff\u001b\\'),
    },
    {
      responseClass: 'osc_11',
      query: Buffer.from('\u001b]11;?\u0007'),
      response: Buffer.from('\u001b]11;rgb:0000/0000/0000\u001b\\'),
    },
    {
      responseClass: 'osc_12',
      query: Buffer.from('\u001b]12;?\u0007'),
      response: Buffer.from('\u001b]12;rgb:ffff/0000/ffff\u001b\\'),
    },
  ] as const;
  assert.deepEqual(
    activeProfileInventory.map(({ responseClass }) => responseClass),
    XTERM_5_5_0_RESPONSE_PROFILE.descriptor.responseClasses,
    'the integrated story must inventory every response class negotiated by the active profile',
  );

  const readerOnData = Buffer.from('READER_ONDATA_MUST_NOT_WRITE');
  const readerOnBinaryLegacyMouse = Buffer.from([
    0x1b, 0x5b, 0x4d, 0x20, 0x80, 0xff,
  ]);
  for (const data of [readerOnData, readerOnBinaryLegacyMouse]) {
    message(gateway, reader, {
      channel: 'control',
      type: 'keystroke',
      sessionId: TASK_A,
      data: data.toString('base64'),
    });
  }
  assert.deepEqual(
    factory.attachments[1]!.writes,
    [],
    'reader onData and low-8-bit onBinary mouse bytes share the lease-gated opaque input path',
  );

  for (const { query, response } of activeProfileInventory) {
    factory.attachments[1]!.emit(query);
    message(gateway, reader, {
      channel: 'control',
      type: 'terminal_response',
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      data: response.toString('base64'),
    });
  }
  await settle();

  const opaqueInput = Buffer.from([0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x99, 0x82, 0x0d]);
  message(gateway, writer, {
    channel: 'control',
    type: 'keystroke',
    sessionId: TASK_A,
    data: opaqueInput.toString('base64'),
  });
  message(gateway, reader, {
    channel: 'control',
    type: 'resize',
    cols: 70,
    rows: 20,
  });
  message(gateway, writer, {
    channel: 'control',
    type: 'resize',
    cols: 110,
    rows: 35,
  });

  const queryEvents = events.filter(
    (
      event,
    ): event is Extract<ProviderTerminalStoryTelemetryEvent, { type: 'query' }> =>
      event.type === 'query' && event.attachmentId === readerAttachmentId,
  );
  assert.deepEqual(
    queryEvents.map((event) => ({
      responseClass: event.responseClass,
      bytesBase64: event.bytesBase64,
      admitted: event.admitted,
    })),
    activeProfileInventory.map(({ responseClass, query }) => ({
      responseClass,
      bytesBase64: query.toString('base64'),
      admitted: true,
    })),
    'the read-only attachment must observe and admit the complete active-profile query inventory',
  );
  assert.deepEqual(
    events
      .filter(
        (
          event,
        ): event is Extract<
          ProviderTerminalStoryTelemetryEvent,
          { type: 'response' }
        > =>
          event.type === 'response' && event.attachmentId === readerAttachmentId,
      )
      .map((event) => ({
        responseClass: event.responseClass,
        bytesBase64: event.bytesBase64,
        accepted: event.accepted,
      })),
    activeProfileInventory.map(({ responseClass, response }) => ({
      responseClass,
      bytesBase64: response.toString('base64'),
      accepted: true,
    })),
    'every profile response must correlate on the reader attachment',
  );
  assert.deepEqual(
    events
      .filter(
        (
          event,
        ): event is Extract<
          ProviderTerminalStoryTelemetryEvent,
          { type: 'provider_write' }
        > =>
          event.type === 'provider_write' &&
          event.attachmentId === readerAttachmentId &&
          event.source === 'terminal_response',
      )
      .map((event) => ({
        bytesBase64: event.bytesBase64,
        outcome: event.outcome,
      })),
    activeProfileInventory.map(({ response }) => ({
      bytesBase64: response.toString('base64'),
      outcome: 'written',
    })),
    'correlated reader replies must cross only their own provider-write seam',
  );
  assert.deepEqual(
    factory.attachments[1]!.terminalResponseWrites.map((bytes) =>
      Buffer.from(bytes),
    ),
    activeProfileInventory.map(({ response }) => response),
  );
  assert.deepEqual(factory.attachments[0]!.terminalResponseWrites, []);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'provider_write' &&
        event.attachmentId === readerAttachmentId &&
        event.source === 'keystroke' &&
        (event.bytesBase64 === readerOnData.toString('base64') ||
          event.bytesBase64 === readerOnBinaryLegacyMouse.toString('base64')),
    ),
    false,
    'rejected reader onData/onBinary bytes must never be reported as provider writes',
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'provider_write' &&
        event.source === 'keystroke' &&
        event.bytesBase64 === opaqueInput.toString('base64') &&
        event.outcome === 'written',
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === 'resize' && event.authoritative === false,
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === 'resize' && event.authoritative === true,
    ),
  );

  const failedInput = Buffer.from('write-that-throws');
  factory.attachments[0]!.throwOnWrite = true;
  message(gateway, writer, {
    channel: 'control',
    type: 'keystroke',
    sessionId: TASK_A,
    data: failedInput.toString('base64'),
  });
  assert.ok(
    events.some(
      (event) =>
        event.type === 'provider_write' &&
        event.source === 'keystroke' &&
        event.bytesBase64 === failedInput.toString('base64') &&
        event.outcome === 'threw',
    ),
  );

  gateway.unregisterSession(TASK_A);
  assert.deepEqual(gateway.getProviderTerminalStoryResourceState(TASK_A), {
    ownerRegistered: false,
    activeViewerCount: 0,
  });
  assert.equal(
    events.filter((event) => event.type === 'viewer_closed').length,
    2,
  );

  observation.dispose();
  const eventCount = events.length;
  gateway.registerSession({
    taskId: TASK_A,
    ownerPty: new FakeOwner(),
    viewerFactory: new FakeViewerFactory(),
    geometry: { cols: 80, rows: 24 },
    launchDecision: Promise.resolve({ kind: 'attached' }),
  });
  gateway.unregisterSession(TASK_A);
  assert.equal(events.length, eventCount, 'disposed story observer cannot retain events');
});
