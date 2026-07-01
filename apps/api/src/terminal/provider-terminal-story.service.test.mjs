import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist/terminal');
const { ProviderTerminalStoryService } = await import(
  path.join(dist, 'provider-terminal-story.service.js')
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

function makeProvider({ providerId = 'aio-local', capabilities = ['terminal.websocket'] } = {}) {
  const calls = [];
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
      return { ...connection };
    },
    async teardownSandbox(taskId) {
      calls.push(['teardown', taskId]);
    },
    async readRolloutFromContainer() {
      return null;
    },
    async sandboxExists() {
      return false;
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
  };
  return provider;
}

function makeGateway() {
  const calls = [];
  return {
    calls,
    openSession(connection, selectedRun, options) {
      calls.push(['openSession', connection.taskId, selectedRun?.providerId, options]);
      return { taskId: connection.taskId, pty: {}, snapshots: {} };
    },
    unregisterSession(taskId) {
      calls.push(['unregisterSession', taskId]);
    },
  };
}

function makePrisma() {
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
        return { count: 1 };
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

    const teardown = await service.teardownSession(session.sessionId);
    assert.equal(teardown.status, 'torn_down');
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
