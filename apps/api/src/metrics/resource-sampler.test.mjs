/**
 * Tests for the pure resource-sampling helpers (be-metrics 5.3 / 5.5).
 *
 * Requirement semantics (from resource-sampler.service.ts):
 *   1. buildSampledResources with NO containers → explicit empty/zero "no active
 *      containers" reading (NOT a stale prior sample): hasActiveContainers false,
 *      empty containers, zero aggregates, status 'available'.
 *   2. CPU% from cgroup delta of two readings; no prior baseline → 0% this tick.
 *   3. a reading carrying a pre-computed cpuPercent is used directly.
 *   4. memory% vs cgroup LIMIT; unlimited limit → memoryPercent null.
 *   5. freshnessStatus: within threshold available, beyond stale.
 *   6. parsers: cpu.stat usage_usec, memory.max (max→null).
 *   7. dockerStatsToLine: CPU% from cpu_stats/precpu_stats deltas; memory
 *      (usage − reclaimable cache, v1 total_inactive_file before v2
 *      inactive_file, guarded by < usage) vs the cgroup limit; missing → null.
 */

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

function dockerStatsToLine(stats) {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  const mem = stats.memory_stats;
  if (!cpu || !mem) return null;
  const cpuDelta =
    (cpu.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const onlineCpus = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0
      ? (cpuDelta / systemDelta) * onlineCpus * 100
      : 0;
  const usage = mem.usage ?? 0;
  const memStats = mem.stats;
  const totalInactive = memStats?.total_inactive_file;
  const inactive = memStats?.inactive_file;
  let memoryBytes;
  if (typeof totalInactive === 'number' && totalInactive < usage) {
    memoryBytes = usage - totalInactive; // cgroup v1 hierarchical total
  } else if (typeof inactive === 'number' && inactive < usage) {
    memoryBytes = usage - inactive; // cgroup v2
  } else {
    memoryBytes = usage; // cache ≥ usage (or absent) → raw usage
  }
  const limit = mem.limit ?? 0;
  return {
    cpuPercent: Math.max(0, cpuPercent),
    memoryBytes,
    memoryLimitBytes: limit > 0 ? limit : null,
  };
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

// T11: dockerStatsToLine — CPU% from cpu_stats vs precpu_stats deltas, and
//   memory = usage − inactive_file (cgroup v2 cache subtraction).
//   Δcpu = 1e6, Δsystem = 5e6, 4 online cpus → (1/5)*4*100 = 80%.
{
  const stats = {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000, percpu_usage: [0, 0, 0, 0] },
      system_cpu_usage: 10_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000, percpu_usage: [0, 0, 0, 0] },
      system_cpu_usage: 5_000_000,
      online_cpus: 4,
    },
    memory_stats: {
      usage: 200 * 1024 ** 2, // 200MiB raw
      stats: { inactive_file: 72 * 1024 ** 2 }, // 72MiB reclaimable cache
      limit: 512 * 1024 ** 2, // 512MiB cgroup limit
    },
  };
  const line = dockerStatsToLine(stats);
  assert(line !== null, 'T11a: line produced');
  assert(approx(line.cpuPercent, 80), 'T11b: CPU% = (Δcpu/Δsys)*onlineCpus*100');
  assert(line.memoryBytes === 128 * 1024 ** 2, 'T11c: memory = usage − inactive_file');
  assert(line.memoryLimitBytes === 512 * 1024 ** 2, 'T11d: cgroup limit carried');
}

// T12: dockerStatsToLine — zero deltas → 0% (no fabricated spike), cgroup v1
//   total_inactive_file fallback, limit 0 → unlimited (null), missing → null.
{
  const flat = {
    cpu_stats: {
      cpu_usage: { total_usage: 1_000_000, percpu_usage: [0] },
      system_cpu_usage: 5_000_000,
      online_cpus: 1,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000, percpu_usage: [0] },
      system_cpu_usage: 5_000_000,
      online_cpus: 1,
    },
    memory_stats: {
      usage: 50 * 1024 ** 2,
      stats: { total_inactive_file: 10 * 1024 ** 2 }, // cgroup v1 field name
      limit: 0, // no per-container limit
    },
  };
  const line = dockerStatsToLine(flat);
  assert(line.cpuPercent === 0, 'T12a: zero deltas → 0% CPU (no fabricated spike)');
  assert(line.memoryBytes === 40 * 1024 ** 2, 'T12b: cgroup v1 total_inactive_file subtracted');
  assert(line.memoryLimitBytes === null, 'T12c: limit 0 → unlimited (null)');
  assert(dockerStatsToLine({}) === null, 'T12d: missing cpu/memory blocks → null');
}

// T13: cgroup v1 DUAL-KEY payload — both inactive_file (leaf) and
//   total_inactive_file (hierarchical) present. Must subtract the hierarchical
//   total (docker CLI precedence), NOT the leaf — a nullish-coalescing
//   `inactive_file ?? total_inactive_file` would wrongly pick the leaf 0.
{
  const z = { total_usage: 0, percpu_usage: [0] };
  const v1 = {
    cpu_stats: { cpu_usage: z, system_cpu_usage: 0, online_cpus: 1 },
    precpu_stats: { cpu_usage: z, system_cpu_usage: 0, online_cpus: 1 },
    memory_stats: {
      usage: 200 * 1024 ** 2,
      stats: {
        inactive_file: 0, // leaf — must NOT be chosen
        total_inactive_file: 72 * 1024 ** 2, // hierarchical cache
      },
      limit: 512 * 1024 ** 2,
    },
  };
  const line = dockerStatsToLine(v1);
  assert(
    line.memoryBytes === 128 * 1024 ** 2,
    'T13: v1 dual-key → total_inactive_file wins (200−72=128MiB), not the leaf',
  );
}

// T14: cache ≥ usage → report raw usage (CLI `< usage` guard), no collapse to 0.
{
  const z = { total_usage: 0, percpu_usage: [0] };
  const odd = {
    cpu_stats: { cpu_usage: z, system_cpu_usage: 0, online_cpus: 1 },
    precpu_stats: { cpu_usage: z, system_cpu_usage: 0, online_cpus: 1 },
    memory_stats: {
      usage: 100 * 1024 ** 2,
      stats: { total_inactive_file: 150 * 1024 ** 2 }, // cache > usage
      limit: 512 * 1024 ** 2,
    },
  };
  const line = dockerStatsToLine(odd);
  assert(line.memoryBytes === 100 * 1024 ** 2, 'T14: cache≥usage → raw usage (CLI guard)');
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
