/**
 * Tests for the codex-process sampling additions (task-codex-process-metrics):
 *   - parseProcProbe (pure): `OK <ticks> <rssKB> <clk>` → {cpuSeconds, memoryBytes}; NONE/garbage → null;
 *   - carry-forward (D2/P1): a still-running container missing from a tick is carried
 *     forward up to CARRY_FORWARD_MAX, then dropped — so a transient miss never
 *     flips a live task to not-sampled;
 *   - taskReading scope selection: codex `process` primary + container background;
 *     `container` fallback when no process sample; null (not-running) when neither.
 *
 * Drives the REAL compiled ResourceSamplerService from dist/ (white-box: sets the
 * internal carry-forward / snapshot state, no live docker/fetch).
 * Requires `pnpm --filter @cap/api build`. Run: `node resource-sampler-process.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { ResourceSamplerService, parseProcProbe, CARRY_FORWARD_MAX } = require(
  path.resolve(here, '../../dist/metrics/resource-sampler.service.js'),
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Stateful fake for the pinned AIO REST shell contract. It deliberately does
 * not implement `/exec`'s implicit-session fallback: callers must first create
 * a known id and must exact-delete that same id after every probe.
 */
async function startStrictAioShellServer({ loseExecResponseAt = null } = {}) {
  const activeSessions = new Set();
  const lifecycles = new Map();
  const requests = [];
  const violations = [];
  let execCount = 0;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://strict-aio.test');
      const method = request.method ?? 'GET';

      if (method === 'POST' && url.pathname === '/v1/shell/sessions/create') {
        const body = await readJsonBody(request);
        assert.deepEqual(Object.keys(body).sort(), ['id']);
        assert.match(body.id, UUID_PATTERN);
        assert.equal(activeSessions.has(body.id), false, 'session id must be new');
        activeSessions.add(body.id);
        lifecycles.set(body.id, ['create']);
        requests.push({ method, path: url.pathname, id: body.id });
        sendJson(response, 200, {
          success: true,
          data: { session_id: body.id, working_dir: '/home/gem' },
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/shell/exec') {
        const body = await readJsonBody(request);
        assert.deepEqual(Object.keys(body).sort(), ['async_mode', 'command', 'id']);
        assert.equal(body.async_mode, false);
        assert.equal(typeof body.command, 'string');
        assert.equal(activeSessions.has(body.id), true, 'exec requires a created session');
        lifecycles.get(body.id).push('exec');
        requests.push({ method, path: url.pathname, id: body.id });
        execCount += 1;

        if (execCount === loseExecResponseAt) {
          // The command reached AIO and its session remains allocated, but the
          // client receives no response. Cleanup must still use the known id.
          request.socket.destroy();
          return;
        }

        sendJson(response, 200, {
          success: true,
          data: {
            session_id: body.id,
            command: body.command,
            status: 'completed',
            exit_code: 0,
            output: `OK ${100 + execCount} 2048 100`,
          },
        });
        return;
      }

      const deletePrefix = '/v1/shell/sessions/';
      if (method === 'DELETE' && url.pathname.startsWith(deletePrefix)) {
        const id = decodeURIComponent(url.pathname.slice(deletePrefix.length));
        assert.match(id, UUID_PATTERN);
        assert.equal(activeSessions.has(id), true, 'delete must target an active known session');
        lifecycles.get(id).push('delete');
        activeSessions.delete(id);
        requests.push({ method, path: url.pathname, id });
        sendJson(response, 200, {
          success: true,
          data: { session_id: id },
        });
        return;
      }

      throw new Error(`unexpected AIO route: ${method} ${url.pathname}`);
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, { success: false, message: 'strict fake rejected request' });
      } else {
        response.destroy();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    activeSessions,
    lifecycles,
    requests,
    violations,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections?.();
      await closed;
    },
  };
}

function configureHttpBackedSampler(fake, taskIds) {
  const sampler = new ResourceSamplerService({ cadenceMs: 1_000, staleAfterMs: 3_000 });
  const baseUrlLookups = [];
  sampler.setRunningTaskIdSource(() => [...taskIds]);
  sampler.setTaskBaseUrlSource((taskId) => {
    baseUrlLookups.push(taskId);
    return fake.baseUrl;
  });
  sampler.readContainers = async (_runningIds, now) =>
    taskIds.map((taskId, index) => ({
      taskId,
      cpuUsageUsec: null,
      cpuPercent: index + 1,
      readAtMs: now,
      memoryBytes: 1_024 * (index + 1),
      memoryLimitBytes: 16_384,
    }));
  return { sampler, baseUrlLookups };
}

// ---- parseProcProbe (pure) --------------------------------------------------

test('parseProcProbe OK → cpuSeconds + RSS bytes', () => {
  const r = parseProcProbe('OK 292 129560 100');
  assert.equal(r.cpuSeconds, 2.92, '(170+122)/100');
  assert.equal(r.memoryBytes, 129560 * 1024);
});

test('parseProcProbe NONE → null (codex not running yet)', () => {
  assert.equal(parseProcProbe('NONE'), null);
});

test('parseProcProbe ignores leading noise, uses the OK line', () => {
  const r = parseProcProbe('warn: something\nOK 100 2048 100\n');
  assert.equal(r.cpuSeconds, 1);
  assert.equal(r.memoryBytes, 2048 * 1024);
});

test('parseProcProbe bad/zero clk → null', () => {
  assert.equal(parseProcProbe('OK 100 2048 0'), null);
  assert.equal(parseProcProbe('garbage'), null);
});

// ---- periodic AIO probe session lifecycle ----------------------------------

test('repeated metrics sampling exact-pairs every AIO create/exec/delete without session growth', async () => {
  const fake = await startStrictAioShellServer();
  const taskIds = ['task-a', 'task-b'];
  const { sampler, baseUrlLookups } = configureHttpBackedSampler(fake, taskIds);
  const rounds = 6;

  try {
    for (let round = 1; round <= rounds; round += 1) {
      await sampler.sampleOnce(round * 1_000);
      assert.equal(
        fake.activeSessions.size,
        0,
        `round ${round} must leave no REST shell session active`,
      );
    }

    const expectedProbeCount = rounds * taskIds.length;
    assert.equal(fake.lifecycles.size, expectedProbeCount, 'one unique session per task and round');
    assert.equal(fake.requests.length, expectedProbeCount * 3, 'exactly three REST calls per probe');
    assert.equal(
      fake.requests.filter((request) => request.path === '/v1/shell/sessions/create').length,
      expectedProbeCount,
    );
    assert.equal(
      fake.requests.filter((request) => request.path === '/v1/shell/exec').length,
      expectedProbeCount,
    );
    assert.equal(
      fake.requests.filter((request) => request.method === 'DELETE').length,
      expectedProbeCount,
    );
    for (const [sessionId, lifecycle] of fake.lifecycles) {
      assert.deepEqual(lifecycle, ['create', 'exec', 'delete'], `${sessionId} exact lifecycle`);
      assert.deepEqual(
        fake.requests.filter((request) => request.id === sessionId).map((request) => request.id),
        [sessionId, sessionId, sessionId],
        'create, exec, and delete must carry the identical id',
      );
    }
    assert.deepEqual(fake.violations, [], 'strict AIO contract accepted every request');
    assert.equal(baseUrlLookups.length, expectedProbeCount, 'taskBaseUrl is resolved for every probe');
    assert.deepEqual(
      new Set(baseUrlLookups),
      new Set(taskIds),
      'the configured taskBaseUrl source serves every running task',
    );
    for (const taskId of taskIds) {
      assert.equal(sampler.taskReading(taskId, rounds * 1_000).scope, 'process');
    }
  } finally {
    await fake.close();
  }
});

test('lost AIO exec response still exact-deletes the known id and metrics fail closed', async () => {
  const fake = await startStrictAioShellServer({ loseExecResponseAt: 1 });
  const { sampler } = configureHttpBackedSampler(fake, ['task-loss']);

  try {
    await sampler.sampleOnce(1_000);

    assert.equal(fake.activeSessions.size, 0, 'the response-loss session is not leaked');
    assert.equal(fake.lifecycles.size, 1);
    const [[lostSessionId, lostLifecycle]] = fake.lifecycles;
    assert.deepEqual(lostLifecycle, ['create', 'exec', 'delete']);
    assert.deepEqual(
      fake.requests.map((request) => [request.method, request.id]),
      [
        ['POST', lostSessionId],
        ['POST', lostSessionId],
        ['DELETE', lostSessionId],
      ],
      'cleanup targets the preallocated id even though exec returned no response',
    );
    assert.equal(sampler.processSamples.has('task-loss'), false, 'lost output is never accepted');
    assert.equal(sampler.previousProcessCpu.has('task-loss'), false, 'lost output creates no CPU baseline');
    assert.equal(
      sampler.taskReading('task-loss', 1_000).scope,
      'container',
      'metrics falls back to its proven container sample instead of fabricating process data',
    );
    assert.deepEqual(fake.violations, []);

    // A later tick recovers normally, demonstrating that the failed probe did
    // not poison the loop or leave an id that collides with future sessions.
    await sampler.sampleOnce(2_000);
    assert.equal(fake.activeSessions.size, 0);
    assert.equal(fake.lifecycles.size, 2);
    for (const lifecycle of fake.lifecycles.values()) {
      assert.deepEqual(lifecycle, ['create', 'exec', 'delete']);
    }
    assert.equal(sampler.taskReading('task-loss', 2_000).scope, 'process');
  } finally {
    await fake.close();
  }
});

// ---- carry-forward (white-box on the real class) ----------------------------

const cReading = (taskId, mem) => ({
  taskId,
  cpuUsageUsec: null,
  cpuPercent: 1,
  readAtMs: 0,
  memoryBytes: mem,
  memoryLimitBytes: 1000,
});

test('carry-forward keeps a still-running unread container, drops past the bound', () => {
  const s = new ResourceSamplerService({});
  const a = cReading('a', 10);
  const b = cReading('b', 20);
  s.previousReadings = new Map([
    ['a', a],
    ['b', b],
  ]);
  s.containerMisses = new Map();

  // Tick 1: 'a' fresh, 'b' missing → 'b' carried (miss 1).
  let eff = s.carryForwardContainers(['a', 'b'], [a]);
  assert.deepEqual(eff.map((r) => r.taskId).sort(), ['a', 'b'], 'b carried at miss 1');
  s.previousReadings = new Map(eff.map((r) => [r.taskId, r]));

  // Keep 'b' missing through the bound — still carried at exactly CARRY_FORWARD_MAX.
  for (let i = 2; i <= CARRY_FORWARD_MAX; i++) {
    eff = s.carryForwardContainers(['a', 'b'], [a]);
    s.previousReadings = new Map(eff.map((r) => [r.taskId, r]));
  }
  assert.ok(eff.map((r) => r.taskId).includes('b'), `b still carried at miss ${CARRY_FORWARD_MAX}`);

  // One miss past the bound → 'b' dropped (genuinely not-sampled); 'a' stays fresh.
  eff = s.carryForwardContainers(['a', 'b'], [a]);
  assert.ok(!eff.map((r) => r.taskId).includes('b'), 'b dropped past the bound');
  assert.ok(eff.map((r) => r.taskId).includes('a'), 'a stays (fresh each tick)');
});

// ---- taskReading scope selection (white-box) --------------------------------

const sample = (taskId, cpu, mem) => ({
  taskId,
  cpuPercent: cpu,
  memoryBytes: mem,
  memoryLimitBytes: 8e9,
  memoryPercent: (mem / 8e9) * 100,
});

const snapshotWith = (containers, sampledAtMs) => ({
  status: containers.length ? 'available' : 'available',
  sampledAt: new Date(sampledAtMs),
  ageMs: 0,
  hasActiveContainers: containers.length > 0,
  containers,
  aggregateCpuPercent: containers.reduce((a, c) => a + c.cpuPercent, 0),
  aggregateMemoryBytes: containers.reduce((a, c) => a + c.memoryBytes, 0),
});

test('taskReading: codex process primary + container background', () => {
  const s = new ResourceSamplerService({});
  s.lastSnapshot = snapshotWith([sample('t', 2.3, 1.5e9)], 1000);
  s.processSamples = new Map([
    ['t', { sample: sample('t', 5, 1.26e8), freshAtMs: 1000, misses: 0 }],
  ]);
  const r = s.taskReading('t', 1000);
  assert.equal(r.scope, 'process');
  assert.equal(r.sample.memoryBytes, 1.26e8, 'primary is codex RSS (~126MB)');
  assert.ok(r.container && r.container.memoryBytes === 1.5e9, 'container total as background');
});

test('taskReading: container fallback when no process sample', () => {
  const s = new ResourceSamplerService({});
  s.lastSnapshot = snapshotWith([sample('t', 2.3, 1.5e9)], 1000);
  s.processSamples = new Map();
  const r = s.taskReading('t', 1000);
  assert.equal(r.scope, 'container');
  assert.equal(r.container, null, 'no duplicate background in container scope');
  assert.equal(r.sample.memoryBytes, 1.5e9);
});

test('taskReading: null (not-running) when neither process nor container', () => {
  const s = new ResourceSamplerService({});
  s.lastSnapshot = snapshotWith([], 1000);
  s.processSamples = new Map();
  assert.equal(s.taskReading('t', 1000), null);
});
