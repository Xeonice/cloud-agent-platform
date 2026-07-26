import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist/terminal');
const { ProviderTerminalStoryService } = await import(
  path.join(dist, 'provider-terminal-story.service.js')
);
const { ProviderTerminalStoryController } = await import(
  path.join(dist, 'provider-terminal-story.controller.js')
);

const ENV_KEYS = [
  'CAP_PROVIDER_TERMINAL_STORY',
  'CAP_PROVIDER_TERMINAL_STORY_PROVIDER',
  'CAP_SANDBOX_PROVIDER',
];

async function withEnv(overrides, fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeProvider({
  providerId = 'aio-local',
  capabilities = ['terminal.websocket'],
  provision = async () => undefined,
  provisionCreatesBeforeSettling = false,
  teardown = async () => undefined,
  existingTaskIds = [],
} = {}) {
  const calls = [];
  const sandboxes = new Set(existingTaskIds);
  const connection = {
    taskId: '',
    baseUrl: 'http://sandbox.internal',
    wsUrl: 'ws://sandbox.internal/v1/shell/ws',
  };
  const provider = {
    calls,
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => capabilities,
    async provision(ctx) {
      calls.push(['provision', ctx.taskId]);
      connection.taskId = ctx.taskId;
      if (provisionCreatesBeforeSettling) sandboxes.add(ctx.taskId);
      await provision(ctx);
      sandboxes.add(ctx.taskId);
      return { ...connection };
    },
    async teardownSandbox(taskId) {
      calls.push(['teardown', taskId]);
      await teardown(taskId);
      sandboxes.delete(taskId);
    },
    async readRolloutFromContainer() {
      return null;
    },
    async sandboxExists(taskId) {
      return sandboxes.has(taskId);
    },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
    async getSelectedSandboxRun(taskId) {
      calls.push(['selected-run', taskId]);
      return {
        taskId,
        providerId,
        providerSandboxId: 'provider-secret-sandbox-id',
        provider,
        capabilities,
        connection: { ...connection, taskId },
        terminal: {
          protocol: 'aio-json-v1',
          wsUrl: 'ws://provider-secret-terminal-url',
        },
      };
    },
    sandboxIds() {
      return [...sandboxes].sort();
    },
  };
  return provider;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeGateway({ openSession = () => ({ taskId: 'fixture', pty: {} }) } = {}) {
  const calls = [];
  const sessions = new Set();
  const observers = new Map();
  return {
    calls,
    openSession(connection, selectedRun, options) {
      calls.push(['openSession', connection.taskId, selectedRun?.providerId, options]);
      const result = openSession(connection, selectedRun, options);
      sessions.add(connection.taskId);
      return result;
    },
    unregisterSession(taskId) {
      calls.push(['unregisterSession', taskId]);
      sessions.delete(taskId);
    },
    observeProviderTerminalStory(taskId, observer) {
      const taskObservers = observers.get(taskId) ?? new Set();
      taskObservers.add(observer);
      observers.set(taskId, taskObservers);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          taskObservers.delete(observer);
          if (taskObservers.size === 0) observers.delete(taskId);
        },
      };
    },
    getProviderTerminalStoryResourceState(taskId) {
      return { ownerRegistered: sessions.has(taskId), activeViewerCount: 0 };
    },
    emitProviderTerminalStory(taskId, event) {
      for (const observer of observers.get(taskId) ?? []) observer.onEvent(event);
    },
    providerTerminalStoryObserverCount(taskId) {
      return observers.get(taskId)?.size ?? 0;
    },
  };
}

function makePrisma({ deleteRepo = async () => ({ count: 1 }) } = {}) {
  const calls = [];
  return {
    calls,
    repo: {
      async create(args) {
        const taskId = args?.data?.tasks?.create?.id ?? 'unknown';
        calls.push(['repo.create', taskId]);
        return { id: `repo-${taskId}` };
      },
      async deleteMany(args) {
        calls.push(['repo.deleteMany', args?.where?.id]);
        return deleteRepo(args);
      },
    },
  };
}

test('provider terminal story creation is disabled by default and creates no provider resource', async () => {
  await withEnv({}, async () => {
    const provider = makeProvider();
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(
      () => service.createSession({}),
      /CAP_PROVIDER_TERMINAL_STORY=1 is required/,
    );
    assert.deepEqual(provider.calls, []);
    assert.deepEqual(gateway.calls, []);
    assert.deepEqual(prisma.calls, []);
  });
});

test('provider terminal story returns only CAP session projection', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider({ providerId: 'aio-local' });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    const session = await service.createSession({ provider: 'aio', ttlMs: 10_000 });
    assert.match(session.sessionId, /^terminal-story-/);
    assert.equal(session.providerId, 'aio-local');
    assert.equal(session.terminalPath, '/terminal');
    assert.equal(JSON.stringify(session).includes('repo-'), false);
    assert.equal(JSON.stringify(session).includes('provider-secret'), false);
    assert.equal(JSON.stringify(session).includes('ws://'), false);
    assert.deepEqual(prisma.calls[0], ['repo.create', session.sessionId]);
    assert.equal(gateway.calls[0][0], 'openSession');
    assert.equal(gateway.calls[0][3].mode, 'provider-story-fixture');
    assert.equal(gateway.calls[0][3].recordExit, false);

    gateway.emitProviderTerminalStory(session.sessionId, {
      type: 'provider_write',
      taskId: session.sessionId,
      attachmentId: 'client-1:1',
      source: 'keystroke',
      bytesBase64: Buffer.from([0xe4, 0xb8, 0xad, 0x0d]).toString('base64'),
      outcome: 'written',
    });
    const inventory = service.getInventory(session.sessionId);
    assert.equal(inventory.sessionId, session.sessionId);
    assert.equal(inventory.truncated, false);
    assert.deepEqual(inventory.gateway, {
      ownerRegistered: true,
      activeViewerCount: 0,
    });
    assert.equal(inventory.events.length, 1);
    assert.equal(inventory.events[0].sequence, 1);
    assert.equal(inventory.events[0].event.type, 'provider_write');
    assert.equal(JSON.stringify(inventory).includes('provider-secret'), false);

    const teardown = await service.teardownSession(session.sessionId);
    assert.equal(teardown.status, 'torn_down');
    assert.deepEqual(teardown.cleanupEvidence, {
      gatewayOwnerReleased: true,
      gatewayViewersReleased: true,
      providerAbsent: true,
      backingRepoRemoved: true,
      telemetryObserverReleased: true,
    });
    assert.equal(gateway.providerTerminalStoryObserverCount(session.sessionId), 0);
    assert.deepEqual(
      prisma.calls.at(-1),
      ['repo.deleteMany', `repo-${session.sessionId}`],
    );
    assert.deepEqual(provider.calls.at(-1), ['teardown', session.sessionId]);
  });
});

test('explicit BoxLite story setup relies on sandbox selection, not API-side BoxLite env probing', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'boxlite' }, async () => {
    const provider = makeProvider({
      providerId: 'boxlite',
      capabilities: ['terminal.websocket', 'terminal.interactive'],
    });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    const session = await service.createSession({ provider: 'boxlite', ttlMs: 10_000 });
    assert.equal(session.providerId, 'boxlite');
    assert.equal(provider.calls[0][0], 'provision');
    assert.equal(gateway.calls[0][0], 'openSession');

    await service.teardownSession(session.sessionId);
  });
});

test('explicit BoxLite story setup requires interactive terminal capability', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'boxlite' }, async () => {
    const provider = makeProvider({
      providerId: 'boxlite',
      capabilities: ['terminal.websocket'],
    });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(
      () => service.createSession({ provider: 'boxlite' }),
      /terminal\.interactive/,
    );
    assert.deepEqual(provider.calls, []);
    assert.deepEqual(gateway.calls, []);
    assert.deepEqual(prisma.calls, []);
  });
});

test('explicit BoxLite story setup does not silently fall back to AIO', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider({ providerId: 'aio-local' });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(
      () => service.createSession({ provider: 'boxlite' }),
      /requested boxlite, but CAP_SANDBOX_PROVIDER=aio is configured/,
    );
    assert.deepEqual(provider.calls, []);
    assert.deepEqual(gateway.calls, []);
    assert.deepEqual(prisma.calls, []);
  });
});

test('setup failure exact-cleans the provider and backing repo', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider();
    const gateway = makeGateway({
      openSession() {
        throw new Error('fixture owner failed');
      },
    });
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(() => service.createSession({ provider: 'aio' }), /fixture owner failed/);
    const provision = provider.calls.find(([name]) => name === 'provision');
    assert.ok(provision);
    const sessionId = provision[1];
    assert.deepEqual(provider.calls.at(-1), ['teardown', sessionId]);
    assert.deepEqual(prisma.calls.at(-1), ['repo.deleteMany', `repo-${sessionId}`]);
    assert.deepEqual(gateway.calls.at(-1), ['unregisterSession', sessionId]);
  });
});

test('request cancellation during provider setup exact-cleans every observed resource', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const cancellation = new AbortController();
    const provider = makeProvider({
      provision: async (ctx) => {
        assert.notEqual(ctx.cancellationSignal, cancellation.signal);
        assert.equal(ctx.cancellationSignal.aborted, false);
        cancellation.abort();
        assert.equal(ctx.cancellationSignal.aborted, true);
      },
    });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(
      () => service.createSession({ provider: 'aio' }, cancellation.signal),
      /provider terminal story request cancelled/,
    );
    const provisionCall = provider.calls.find(([name]) => name === 'provision');
    assert.ok(provisionCall);
    const sessionId = provisionCall[1];
    assert.deepEqual(provider.calls.at(-1), ['teardown', sessionId]);
    assert.deepEqual(prisma.calls.at(-1), ['repo.deleteMany', `repo-${sessionId}`]);
    assert.deepEqual(gateway.calls.at(-1), ['unregisterSession', sessionId]);
    assert.equal(gateway.calls.some(([name]) => name === 'openSession'), false);
  });
});

test('an already-cancelled story request allocates no provider, repo, or gateway resource', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const provider = makeProvider();
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(
      () => service.createSession({ provider: 'aio' }, cancellation.signal),
      /provider terminal story request cancelled/,
    );
    assert.deepEqual(provider.calls, []);
    assert.deepEqual(gateway.calls, []);
    assert.deepEqual(prisma.calls, []);
  });
});

test('HTTP request abort is forwarded as the story provisioning cancellation signal', async () => {
  const request = new EventEmitter();
  request.aborted = false;
  let observedSignal;
  const service = {
    createSession(_body, signal) {
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('observed request abort')),
          { once: true },
        );
      });
    },
  };
  const controller = new ProviderTerminalStoryController(service);
  const pending = controller.create({ provider: 'aio' }, request);

  request.emit('aborted');

  await assert.rejects(pending, /observed request abort/);
  assert.equal(observedSignal.aborted, true);
  assert.equal(request.listenerCount('aborted'), 0);
});

test('HTTP abort listener is removed after successful story creation', async () => {
  const request = new EventEmitter();
  request.aborted = false;
  const response = new EventEmitter();
  response.destroyed = false;
  const created = {
    sessionId: 'terminal-story-success',
    status: 'running',
  };
  const controller = new ProviderTerminalStoryController({
    async createSession(_body, signal) {
      assert.equal(signal.aborted, false);
      return created;
    },
  });

  assert.equal(
    await controller.create({ provider: 'aio' }, request, response),
    created,
  );
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);
});

test('HTTP response close cancels provisioning after the request body completed', async () => {
  const request = new EventEmitter();
  request.aborted = false;
  const response = new EventEmitter();
  response.destroyed = false;
  let observedSignal;
  const controller = new ProviderTerminalStoryController({
    createSession(_body, signal) {
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('observed response close')),
          { once: true },
        );
      });
    },
  });
  const pending = controller.create({ provider: 'aio' }, request, response);

  response.emit('close');

  await assert.rejects(pending, /observed response close/);
  assert.equal(observedSignal.aborted, true);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);
});

test('cancellation after gateway registration exact-cleans owner, observer, provider, and repo', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const cancellation = new AbortController();
    const provider = makeProvider();
    const gateway = makeGateway({
      openSession() {
        cancellation.abort();
        return { taskId: 'fixture', pty: {} };
      },
    });
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(
      () => service.createSession({ provider: 'aio' }, cancellation.signal),
      /provider terminal story request cancelled/,
    );
    const provisionCall = provider.calls.find(([name]) => name === 'provision');
    assert.ok(provisionCall);
    const sessionId = provisionCall[1];
    assert.deepEqual(provider.calls.at(-1), ['teardown', sessionId]);
    assert.deepEqual(prisma.calls.at(-1), ['repo.deleteMany', `repo-${sessionId}`]);
    assert.deepEqual(gateway.calls.at(-1), ['unregisterSession', sessionId]);
    assert.deepEqual(gateway.getProviderTerminalStoryResourceState(sessionId), {
      ownerRegistered: false,
      activeViewerCount: 0,
    });
    assert.equal(gateway.providerTerminalStoryObserverCount(sessionId), 0);
  });
});

test('SIGTERM fences a committed in-flight provision, awaits unwind, and exact-cleans it', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provisionEntered = deferred();
    const releaseProvision = deferred();
    let providerSignal;
    const provider = makeProvider({
      existingTaskIds: ['unrelated-sandbox'],
      provisionCreatesBeforeSettling: true,
      provision: async (ctx) => {
        providerSignal = ctx.cancellationSignal;
        provisionEntered.resolve();
        await releaseProvision.promise;
      },
    });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    const creation = service.createSession({ provider: 'aio' });
    const creationRejected = assert.rejects(
      creation,
      /provider terminal story request cancelled/,
    );
    await provisionEntered.promise;

    let shutdownSettled = false;
    const shutdown = service.onApplicationShutdown('SIGTERM');
    void shutdown.then(
      () => {
        shutdownSettled = true;
      },
      () => {
        shutdownSettled = true;
      },
    );
    assert.equal(providerSignal.aborted, true);
    await assert.rejects(
      () => service.createSession({ provider: 'aio' }),
      /service is shutting down/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownSettled, false);

    releaseProvision.resolve();
    await creationRejected;
    await shutdown;

    const provisionCall = provider.calls.find(([name]) => name === 'provision');
    assert.ok(provisionCall);
    const sessionId = provisionCall[1];
    assert.equal(gateway.calls.some(([name]) => name === 'openSession'), false);
    assert.deepEqual(provider.sandboxIds(), ['unrelated-sandbox']);
    assert.deepEqual(provider.calls.at(-1), ['teardown', sessionId]);
    assert.deepEqual(prisma.calls.at(-1), [
      'repo.deleteMany',
      `repo-${sessionId}`,
    ]);
  });
});

test('SIGTERM during gateway open drains the late owner and telemetry observer', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider({ existingTaskIds: ['unrelated-sandbox'] });
    let service;
    let shutdown;
    const gateway = makeGateway({
      openSession() {
        shutdown = service.onApplicationShutdown('SIGTERM');
        return { taskId: 'fixture', pty: {} };
      },
    });
    const prisma = makePrisma();
    service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(
      () => service.createSession({ provider: 'aio' }),
      /provider terminal story request cancelled/,
    );
    await shutdown;

    const provisionCall = provider.calls.find(([name]) => name === 'provision');
    assert.ok(provisionCall);
    const sessionId = provisionCall[1];
    assert.deepEqual(
      gateway.getProviderTerminalStoryResourceState(sessionId),
      { ownerRegistered: false, activeViewerCount: 0 },
    );
    assert.equal(gateway.providerTerminalStoryObserverCount(sessionId), 0);
    assert.deepEqual(provider.sandboxIds(), ['unrelated-sandbox']);
    assert.deepEqual(provider.calls.at(-1), ['teardown', sessionId]);
    assert.deepEqual(prisma.calls.at(-1), [
      'repo.deleteMany',
      `repo-${sessionId}`,
    ]);
  });
});

test('request timeout aborts an in-flight committed provision and exact-cleans it', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider({
      existingTaskIds: ['unrelated-sandbox'],
      provisionCreatesBeforeSettling: true,
      provision: async (ctx) =>
        new Promise((_, reject) => {
          const abort = () => reject(new Error('provider observed request timeout'));
          if (ctx.cancellationSignal.aborted) {
            abort();
            return;
          }
          ctx.cancellationSignal.addEventListener('abort', abort, { once: true });
        }),
    });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);
    const requestTimeout = new AbortController();
    const timeout = setTimeout(() => requestTimeout.abort(), 20);

    try {
      await assert.rejects(
        () =>
          service.createSession({ provider: 'aio' }, requestTimeout.signal),
        /provider observed request timeout/,
      );
    } finally {
      clearTimeout(timeout);
    }

    const provisionCall = provider.calls.find(([name]) => name === 'provision');
    assert.ok(provisionCall);
    const sessionId = provisionCall[1];
    assert.equal(gateway.calls.some(([name]) => name === 'openSession'), false);
    assert.deepEqual(provider.sandboxIds(), ['unrelated-sandbox']);
    assert.deepEqual(provider.calls.at(-1), ['teardown', sessionId]);
    assert.deepEqual(prisma.calls.at(-1), [
      'repo.deleteMany',
      `repo-${sessionId}`,
    ]);
  });
});

test('transient setup cleanup failure retries without replacing the primary assertion', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    let teardownAttempts = 0;
    const provider = makeProvider({
      existingTaskIds: ['unrelated-sandbox'],
      teardown: async () => {
        teardownAttempts += 1;
        if (teardownAttempts === 1) throw new Error('transient setup cleanup');
      },
    });
    const gateway = makeGateway({
      openSession() {
        throw new Error('fixture assertion failed');
      },
    });
    const service = new ProviderTerminalStoryService(
      provider,
      gateway,
      makePrisma(),
    );

    await assert.rejects(
      () => service.createSession({ provider: 'aio' }),
      /fixture assertion failed/,
    );
    assert.equal(teardownAttempts, 2);
    assert.deepEqual(provider.sandboxIds(), ['unrelated-sandbox']);
  });
});

test('failed setup cleanup remains registered and is retried on later shutdown', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    let cleanupAllowed = false;
    let teardownAttempts = 0;
    const provider = makeProvider({
      existingTaskIds: ['unrelated-sandbox'],
      teardown: async () => {
        teardownAttempts += 1;
        if (!cleanupAllowed) throw new Error('persistent setup cleanup failure');
      },
    });
    const gateway = makeGateway({
      openSession() {
        throw new Error('fixture assertion failed');
      },
    });
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);

    await assert.rejects(
      () => service.createSession({ provider: 'aio' }),
      /setup failed and exact cleanup was incomplete/,
    );
    const provisionCall = provider.calls.find(([name]) => name === 'provision');
    assert.ok(provisionCall);
    const sessionId = provisionCall[1];
    assert.equal(teardownAttempts, 3);
    assert.deepEqual(
      provider.sandboxIds(),
      ['unrelated-sandbox', sessionId].sort(),
    );
    assert.equal(
      prisma.calls.filter(([name]) => name === 'repo.deleteMany').length,
      1,
    );

    cleanupAllowed = true;
    await service.onApplicationShutdown('SIGTERM');

    assert.equal(teardownAttempts, 4);
    assert.deepEqual(provider.sandboxIds(), ['unrelated-sandbox']);
    assert.equal(
      prisma.calls.filter(([name]) => name === 'repo.deleteMany').length,
      1,
    );
  });
});

test('provider story inventory is bounded and explicitly reports truncation', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider();
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);
    const session = await service.createSession({ provider: 'aio' });

    for (let index = 0; index < 4_100; index += 1) {
      gateway.emitProviderTerminalStory(session.sessionId, {
        type: 'provider_write',
        taskId: session.sessionId,
        attachmentId: 'client-1:1',
        source: 'keystroke',
        bytesBase64: Buffer.from([index & 0xff]).toString('base64'),
        outcome: 'written',
      });
    }

    const inventory = service.getInventory(session.sessionId);
    assert.equal(inventory.events.length, 4_096);
    assert.equal(inventory.events[0].sequence, 1);
    assert.equal(inventory.events.at(-1).sequence, 4_096);
    assert.equal(inventory.truncated, true);
    await service.teardownSession(session.sessionId);
  });
});

test('concurrent and repeated successful teardown share one exact cleanup', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider({
      teardown: () => new Promise((resolve) => setImmediate(resolve)),
    });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);
    const session = await service.createSession({ provider: 'aio' });

    const [first, second] = await Promise.all([
      service.teardownSession(session.sessionId),
      service.teardownSession(session.sessionId),
    ]);
    assert.equal(first.status, 'torn_down');
    assert.deepEqual(second, first);
    assert.deepEqual(await service.teardownSession(session.sessionId), first);
    assert.equal(
      provider.calls.filter(([name]) => name === 'teardown').length,
      1,
    );
    assert.equal(
      prisma.calls.filter(([name]) => name === 'repo.deleteMany').length,
      1,
    );
  });
});

test('cleanup failure is sanitized and a later teardown retries the same story only', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    let attempts = 0;
    const provider = makeProvider({
      teardown: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Bearer provider-secret-token');
      },
    });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);
    const session = await service.createSession({ provider: 'aio' });

    const failed = await service.teardownSession(session.sessionId);
    assert.equal(failed.status, 'torn_down');
    assert.equal(failed.teardownError, 'provider cleanup failed');
    assert.equal(JSON.stringify(failed).includes('provider-secret-token'), false);
    assert.equal(failed.cleanupEvidence.providerAbsent, false);

    const retried = await service.teardownSession(session.sessionId);
    assert.equal(retried.status, 'torn_down');
    assert.equal(retried.teardownError, undefined);
    assert.equal(retried.cleanupEvidence.providerAbsent, true);
    assert.equal(attempts, 2);
  });
});

test('gateway cleanup failure does not prevent provider, observer, or repo cleanup', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider();
    const gateway = makeGateway();
    const unregister = gateway.unregisterSession.bind(gateway);
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);
    const session = await service.createSession({ provider: 'aio' });
    gateway.unregisterSession = (taskId) => {
      unregister(taskId);
      throw new Error('Bearer gateway-secret-token');
    };

    const failed = await service.teardownSession(session.sessionId);
    assert.equal(failed.status, 'torn_down');
    assert.equal(failed.teardownError, 'gateway cleanup failed');
    assert.equal(JSON.stringify(failed).includes('gateway-secret-token'), false);
    assert.deepEqual(failed.cleanupEvidence, {
      gatewayOwnerReleased: false,
      gatewayViewersReleased: false,
      providerAbsent: true,
      backingRepoRemoved: true,
      telemetryObserverReleased: true,
    });
    assert.deepEqual(provider.calls.at(-1), ['teardown', session.sessionId]);
    assert.deepEqual(prisma.calls.at(-1), [
      'repo.deleteMany',
      `repo-${session.sessionId}`,
    ]);
    assert.equal(gateway.providerTerminalStoryObserverCount(session.sessionId), 0);

    gateway.unregisterSession = unregister;
    const retried = await service.teardownSession(session.sessionId);
    assert.equal(retried.teardownError, undefined);
    assert.deepEqual(retried.cleanupEvidence, {
      gatewayOwnerReleased: true,
      gatewayViewersReleased: true,
      providerAbsent: true,
      backingRepoRemoved: true,
      telemetryObserverReleased: true,
    });
  });
});

test('application shutdown drains every live story through the teardown seam', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    const provider = makeProvider({ existingTaskIds: ['unrelated-sandbox'] });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);
    const first = await service.createSession({ provider: 'aio' });
    const second = await service.createSession({ provider: 'aio' });

    await service.onApplicationShutdown('SIGTERM');

    assert.equal(service.getSession(first.sessionId).status, 'torn_down');
    assert.equal(service.getSession(second.sessionId).status, 'torn_down');
    assert.deepEqual(service.getSession(first.sessionId).cleanupEvidence, {
      gatewayOwnerReleased: true,
      gatewayViewersReleased: true,
      providerAbsent: true,
      backingRepoRemoved: true,
      telemetryObserverReleased: true,
    });
    assert.deepEqual(service.getSession(second.sessionId).cleanupEvidence, {
      gatewayOwnerReleased: true,
      gatewayViewersReleased: true,
      providerAbsent: true,
      backingRepoRemoved: true,
      telemetryObserverReleased: true,
    });
    assert.deepEqual(
      provider.calls.filter(([name]) => name === 'teardown').map(([, id]) => id).sort(),
      [first.sessionId, second.sessionId].sort(),
    );
    assert.deepEqual(provider.sandboxIds(), ['unrelated-sandbox']);
    assert.equal(gateway.providerTerminalStoryObserverCount(first.sessionId), 0);
    assert.equal(gateway.providerTerminalStoryObserverCount(second.sessionId), 0);
  });
});

test('application shutdown retries transient cleanup and preserves unrelated sandboxes', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    let teardownAttempts = 0;
    const provider = makeProvider({
      existingTaskIds: ['unrelated-sandbox'],
      teardown: async () => {
        teardownAttempts += 1;
        if (teardownAttempts === 1) throw new Error('transient cleanup fault');
      },
    });
    const service = new ProviderTerminalStoryService(
      provider,
      makeGateway(),
      makePrisma(),
    );
    const first = await service.createSession({ provider: 'aio' });
    const second = await service.createSession({ provider: 'aio' });

    await service.onApplicationShutdown('SIGTERM');

    assert.equal(service.getSession(first.sessionId).teardownError, undefined);
    assert.equal(service.getSession(second.sessionId).teardownError, undefined);
    assert.equal(teardownAttempts, 3);
    assert.deepEqual(provider.sandboxIds(), ['unrelated-sandbox']);
  });
});

test('application shutdown rejects after bounded persistent cleanup failure', async () => {
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    let teardownAttempts = 0;
    const provider = makeProvider({
      existingTaskIds: ['unrelated-sandbox'],
      teardown: async () => {
        teardownAttempts += 1;
        throw new Error('persistent provider secret');
      },
    });
    const service = new ProviderTerminalStoryService(
      provider,
      makeGateway(),
      makePrisma(),
    );
    const session = await service.createSession({ provider: 'aio' });

    await assert.rejects(
      () => service.onApplicationShutdown('SIGTERM'),
      /cleanup remained incomplete for 1 session/,
    );

    assert.equal(teardownAttempts, 3);
    assert.equal(service.getSession(session.sessionId).cleanupEvidence.providerAbsent, false);
    assert.equal(
      JSON.stringify(service.getSession(session.sessionId)).includes(
        'persistent provider secret',
      ),
      false,
    );
    assert.deepEqual(
      provider.sandboxIds(),
      ['unrelated-sandbox', session.sessionId].sort(),
    );
  });
});

test('TTL expiry invokes the same exact teardown seam and removes the backing repo', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withEnv({ CAP_PROVIDER_TERMINAL_STORY: '1', CAP_SANDBOX_PROVIDER: 'aio' }, async () => {
    let teardownFinished;
    const teardownObserved = new Promise((resolve) => {
      teardownFinished = resolve;
    });
    const provider = makeProvider({
      teardown: async () => teardownFinished(),
    });
    const gateway = makeGateway();
    const prisma = makePrisma();
    const service = new ProviderTerminalStoryService(provider, gateway, prisma);
    const session = await service.createSession({ provider: 'aio', ttlMs: 10_000 });

    t.mock.timers.tick(10_000);
    await teardownObserved;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(service.getSession(session.sessionId).status, 'torn_down');
    assert.equal(
      provider.calls.filter(([name, id]) => name === 'teardown' && id === session.sessionId).length,
      1,
    );
    assert.deepEqual(prisma.calls.at(-1), [
      'repo.deleteMany',
      `repo-${session.sessionId}`,
    ]);
    assert.deepEqual(gateway.calls.at(-1), ['unregisterSession', session.sessionId]);
    assert.deepEqual(service.getSession(session.sessionId).cleanupEvidence, {
      gatewayOwnerReleased: true,
      gatewayViewersReleased: true,
      providerAbsent: true,
      backingRepoRemoved: true,
      telemetryObserverReleased: true,
    });
  });
});
