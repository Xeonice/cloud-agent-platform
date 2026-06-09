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
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { ResourceSamplerService, parseProcProbe, CARRY_FORWARD_MAX } = require(
  path.resolve(here, '../../dist/metrics/resource-sampler.service.js'),
);

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
