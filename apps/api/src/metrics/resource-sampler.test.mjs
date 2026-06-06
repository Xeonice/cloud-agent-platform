/**
 * Tests for the pure resource-sampling helpers (be-metrics 5.3 / 5.5).
 *
 * Requirement semantics (from resource-sampler.service.ts):
 *   1. buildSampledResources with NO containers → explicit empty/zero "no active
 *      containers" reading (NOT a stale prior sample): hasActiveContainers false,
 *      empty containers, zero aggregates, status 'available'.
 *   2. CPU% from cgroup delta of two readings; no prior baseline → 0% this tick.
 *   3. docker-stats reading carries a pre-computed cpuPercent used directly.
 *   4. memory% vs cgroup LIMIT; unlimited limit → memoryPercent null.
 *   5. freshnessStatus: within threshold available, beyond stale.
 *   6. parsers: cpu.stat usage_usec, memory.max (max→null), docker stats line,
 *      memory byte units.
 */

const AIO_CONTAINER_PREFIX = 'cap-aio-';

// ---- inline the pure helpers (mirror resource-sampler.service.ts) ----

function buildSampledResources(current, previous, sampledAtMs) {
  if (current.length === 0) {
    return {
      status: 'available',
      sampledAt: new Date(sampledAtMs),
      ageMs: 0,
      hasActiveContainers: false,
      containers: [],
      aggregateCpuPercent: 0,
      aggregateMemoryBytes: 0,
    };
  }
  const containers = [];
  let aggregateCpuPercent = 0;
  let aggregateMemoryBytes = 0;
  for (const reading of current) {
    const cpuPercent = computeCpuPercent(previous.get(reading.taskId), reading);
    const memoryPercent =
      reading.memoryLimitBytes !== null && reading.memoryLimitBytes > 0
        ? (reading.memoryBytes / reading.memoryLimitBytes) * 100
        : null;
    containers.push({
      taskId: reading.taskId,
      cpuPercent,
      memoryBytes: reading.memoryBytes,
      memoryLimitBytes: reading.memoryLimitBytes,
      memoryPercent,
    });
    aggregateCpuPercent += cpuPercent;
    aggregateMemoryBytes += reading.memoryBytes;
  }
  return {
    status: 'available',
    sampledAt: new Date(sampledAtMs),
    ageMs: 0,
    hasActiveContainers: true,
    containers,
    aggregateCpuPercent,
    aggregateMemoryBytes,
  };
}

function computeCpuPercent(prior, current) {
  if (current.cpuPercent !== null) return Math.max(0, current.cpuPercent);
  if (current.cpuUsageUsec === null || !prior || prior.cpuUsageUsec === null) return 0;
  const deltaCpuUsec = current.cpuUsageUsec - prior.cpuUsageUsec;
  const deltaWallUsec = (current.readAtMs - prior.readAtMs) * 1_000;
  if (deltaWallUsec <= 0 || deltaCpuUsec <= 0) return 0;
  return (deltaCpuUsec / deltaWallUsec) * 100;
}

function freshnessStatus(ageMs, staleAfterMs) {
  return ageMs > staleAfterMs ? 'stale' : 'available';
}

function parseCpuUsageUsec(cpuStat) {
  for (const line of cpuStat.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === 'usage_usec') return Number.parseInt(value, 10);
  }
  return Number.NaN;
}

function parseMemoryMax(memMax) {
  const trimmed = memMax.trim();
  if (trimmed === 'max') return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isNaN(value) ? null : value;
}

function parseDockerStats(stdout) {
  const out = new Map();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, cpuPerc, memUsage] = trimmed.split('\t');
    if (!name || !name.startsWith(AIO_CONTAINER_PREFIX)) continue;
    const taskId = name.slice(AIO_CONTAINER_PREFIX.length);
    const [usedRaw, limitRaw] = (memUsage ?? '').split('/').map((s) => s.trim());
    out.set(taskId, {
      cpuPercent: parsePercent(cpuPerc),
      memoryBytes: parseMemBytes(usedRaw),
      memoryLimitBytes: limitRaw ? parseMemBytes(limitRaw) : null,
    });
  }
  return out;
}
function parsePercent(token) {
  if (!token) return 0;
  const value = Number.parseFloat(token.replace('%', ''));
  return Number.isNaN(value) ? 0 : value;
}
function parseMemBytes(token) {
  if (!token) return 0;
  const match = token.match(/^([\d.]+)\s*([KMGT]?i?B)?$/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  if (Number.isNaN(value)) return 0;
  const unit = (match[2] ?? 'B').toUpperCase();
  const factor = {
    B: 1, KB: 1_000, MB: 1_000_000, GB: 1_000_000_000, TB: 1_000_000_000_000,
    KIB: 1_024, MIB: 1_024 ** 2, GIB: 1_024 ** 3, TIB: 1_024 ** 4,
  };
  return Math.round(value * (factor[unit] ?? 1));
}

const cg = (taskId, cpuUsageUsec, readAtMs, memoryBytes, memoryLimitBytes) => ({
  taskId, cpuUsageUsec, cpuPercent: null, readAtMs, memoryBytes, memoryLimitBytes,
});
const ds = (taskId, cpuPercent, readAtMs, memoryBytes, memoryLimitBytes) => ({
  taskId, cpuUsageUsec: null, cpuPercent, readAtMs, memoryBytes, memoryLimitBytes,
});

// ---- assertion helpers ----

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// T1: no containers → explicit empty reading (not a stale sample).
{
  const r = buildSampledResources([], new Map(), 1_000);
  assert(r.hasActiveContainers === false, 'T1a: hasActiveContainers false');
  assert(r.containers.length === 0, 'T1b: empty containers');
  assert(r.aggregateCpuPercent === 0 && r.aggregateMemoryBytes === 0, 'T1c: zero aggregates');
  assert(r.status === 'available', 'T1d: empty reading is available (an exact fact)');
  assert(r.sampledAt instanceof Date, 'T1e: sampledAt stamped');
}

// T2: cgroup CPU% from delta of two readings.
//   1s wall, 0.5s cpu (500_000 usec) → 50%.
{
  const prev = new Map([['t1', cg('t1', 1_000_000, 0, 0, null)]]);
  const cur = [cg('t1', 1_500_000, 1_000, 100, 200)]; // +500_000 usec over 1000ms
  const r = buildSampledResources(cur, prev, 1_000);
  assert(approx(r.containers[0].cpuPercent, 50), 'T2a: 50% CPU from cgroup delta');
  assert(approx(r.containers[0].memoryPercent, 50), 'T2b: 50% memory vs limit');
  assert(approx(r.aggregateCpuPercent, 50), 'T2c: aggregate CPU===container CPU');
}

// T3: no prior baseline → 0% this tick (not fabricated).
{
  const r = buildSampledResources([cg('t1', 9_999, 1_000, 100, 200)], new Map(), 1_000);
  assert(r.containers[0].cpuPercent === 0, 'T3: no baseline → 0% CPU');
}

// T4: non-positive wall delta → 0% (no divide-by-zero / spurious spike).
{
  const prev = new Map([['t1', cg('t1', 0, 1_000, 0, null)]]);
  const cur = [cg('t1', 500_000, 1_000, 0, null)]; // same readAtMs → Δwall 0
  const r = buildSampledResources(cur, prev, 1_000);
  assert(r.containers[0].cpuPercent === 0, 'T4: Δwall<=0 → 0% CPU');
}

// T5: docker-stats reading uses pre-computed cpuPercent directly.
{
  const r = buildSampledResources([ds('t1', 42.5, 1_000, 100, 200)], new Map(), 1_000);
  assert(approx(r.containers[0].cpuPercent, 42.5), 'T5: docker-stats cpuPercent used directly');
}

// T6: unlimited memory limit → memoryPercent null.
{
  const r = buildSampledResources([cg('t1', 0, 1_000, 100, null)], new Map(), 1_000);
  assert(r.containers[0].memoryPercent === null, 'T6: unlimited limit → memoryPercent null');
  assert(r.containers[0].memoryLimitBytes === null, 'T6b: limit null preserved');
}

// T7: aggregates sum across multiple containers.
{
  const prev = new Map([
    ['t1', cg('t1', 0, 0, 0, null)],
    ['t2', cg('t2', 0, 0, 0, null)],
  ]);
  const cur = [
    cg('t1', 1_000_000, 1_000, 100, 1_000), // +1s over 1s = 100%
    cg('t2', 500_000, 1_000, 200, 1_000), //  +0.5s over 1s = 50%
  ];
  const r = buildSampledResources(cur, prev, 1_000);
  assert(approx(r.aggregateCpuPercent, 150), 'T7a: aggregate CPU 100+50===150');
  assert(r.aggregateMemoryBytes === 300, 'T7b: aggregate memory 100+200===300');
}

// T8: freshness gating.
{
  assert(freshnessStatus(1_000, 5_000) === 'available', 'T8a: within threshold → available');
  assert(freshnessStatus(6_000, 5_000) === 'stale', 'T8b: beyond threshold → stale');
  assert(freshnessStatus(5_000, 5_000) === 'available', 'T8c: at threshold → available');
}

// T9: cpu.stat parsing.
{
  const blob = 'usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n';
  assert(parseCpuUsageUsec(blob) === 123456, 'T9a: usage_usec parsed');
  assert(Number.isNaN(parseCpuUsageUsec('user_usec 5\n')), 'T9b: missing usage_usec → NaN');
}

// T10: memory.max parsing (byte count vs 'max').
{
  assert(parseMemoryMax('536870912\n') === 536870912, 'T10a: byte limit parsed');
  assert(parseMemoryMax('max\n') === null, 'T10b: max → null (unlimited)');
}

// T11: docker stats line parsing, name→taskId, mem used/limit.
{
  const out = parseDockerStats(
    'cap-aio-abc\t42.50%\t128MiB / 512MiB\nsome-other\t9%\t1MiB / 2MiB\n',
  );
  assert(out.size === 1, 'T11a: only cap-aio- lines kept');
  const stat = out.get('abc');
  assert(stat && approx(stat.cpuPercent, 42.5), 'T11b: cpu percent parsed');
  assert(stat.memoryBytes === 128 * 1024 ** 2, 'T11c: used MiB → bytes');
  assert(stat.memoryLimitBytes === 512 * 1024 ** 2, 'T11d: limit MiB → bytes');
}

// T12: memory byte unit parsing.
{
  assert(parseMemBytes('1.5GiB') === Math.round(1.5 * 1024 ** 3), 'T12a: GiB');
  assert(parseMemBytes('512MB') === 512_000_000, 'T12b: MB (decimal)');
  assert(parseMemBytes('100B') === 100, 'T12c: bytes');
  assert(parseMemBytes('') === 0, 'T12d: empty → 0');
}

// ---- summary ----
console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
