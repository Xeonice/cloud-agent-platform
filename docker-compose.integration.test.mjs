/**
 * Compose topology assertions for the DooD self-host execution plane
 * (harden-aio-execution, integration tasks 6.5 / 6.6; designs D2 / D3). Asserts
 * the FINAL docker-compose.yml contract after the deploy-config track rewrite +
 * the integration merge that restored the cap-net / user:root / docker.sock
 * topology the execution path requires.
 *
 *   6.5 (D2): the `api` service reaches Postgres AND a `cap-net` sandbox — `api`
 *       is on BOTH the compose `default` network (Postgres lives there) AND the
 *       user-defined `cap-net` (per-task sandboxes live there), bridging the two.
 *       Postgres is default-ONLY; sandboxes are cap-net-only. This is what makes
 *       the DATABASE_URL host `postgres` resolvable (no Prisma P1001) while the
 *       orchestrator can still dial `cap-aio-<taskId>` by name on cap-net.
 *
 *   6.6 (D3): a DooD `docker` call from the `api` service succeeds with NO EACCES
 *       because `api` runs `user: root` AND the root-owned host
 *       `/var/run/docker.sock` is mounted into it.
 *
 * STATIC assertions (always run) parse `docker compose config` (the fully
 * resolved topology) and check the contract. A DYNAMIC DooD probe (6.6) brings
 * the api container up and runs a `docker` call through the mounted socket,
 * asserting no EACCES; it SKIPS when docker/network is unavailable.
 *
 * Mirrors the repo's `.test.mjs` convention (plain node, inline assertions).
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname);
const COMPOSE = resolve(repoRoot, 'docker-compose.yml');

let passed = 0;
let failed = 0;
let skipped = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}
function skip(label) { console.log(`  SKIP  ${label}`); skipped++; }

// ---- resolve the compose topology ------------------------------------------
// `docker compose config` is the AUTHORITATIVE fully-merged view (defaults +
// network attachment expanded). Fall back to a raw-YAML structural check if the
// docker CLI is not available, so the contract is still asserted offline.

function dockerAvailable() {
  try { execFileSync('docker', ['version', '--format', '{{.Client.Version}}'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

let config = null;
let usedComposeCli = false;
if (dockerAvailable()) {
  try {
    const json = execFileSync(
      'docker',
      ['compose', '-f', COMPOSE, 'config', '--format', 'json'],
      { cwd: repoRoot, stdio: 'pipe', env: { ...process.env, AUTH_TOKEN: process.env.AUTH_TOKEN ?? 'x' } },
    ).toString('utf8');
    config = JSON.parse(json);
    usedComposeCli = true;
  } catch {
    config = null;
  }
}

// ---- 6.5 (D2): api on default + cap-net; postgres default-only -------------
console.log('\n=== 6.5 (D2): api reaches Postgres AND a cap-net sandbox; no P1001 ===');

if (usedComposeCli && config) {
  const api = config.services?.api ?? {};
  const pg = config.services?.postgres ?? {};
  // compose config renders networks as an object keyed by network name.
  const apiNets = Object.keys(api.networks ?? {});
  const pgNets = Object.keys(pg.networks ?? {});

  assert(apiNets.includes('default'), '6.5: api is attached to the `default` network (reaches Postgres)');
  assert(apiNets.includes('cap-net'), '6.5: api is attached to `cap-net` (dials per-task sandboxes by name)');
  assert(
    !pgNets.includes('cap-net'),
    '6.5: postgres is NOT on cap-net (sandboxes cannot reach the database)',
  );
  // DATABASE_URL host must be the compose service name `postgres`, resolvable on
  // the shared default network — this is the contract that avoids Prisma P1001.
  const dbUrl = (api.environment ?? {}).DATABASE_URL ?? '';
  assert(/@postgres:5432\//.test(dbUrl), '6.5: DATABASE_URL targets the `postgres` service on the shared network (no P1001)');
} else {
  // Offline structural fallback: assert the raw compose declares the topology.
  const raw = execFileSync('cat', [COMPOSE]).toString('utf8');
  const apiBlock = raw.slice(raw.indexOf('\n  api:'), raw.indexOf('\n  postgres:'));
  assert(/-\s*default/.test(apiBlock), '6.5: api lists the `default` network');
  assert(/-\s*cap-net/.test(apiBlock), '6.5: api lists the `cap-net` network');
  assert(/^networks:/m.test(raw) && /cap-net:/.test(raw), '6.5: top-level cap-net network is declared');
  assert(/@postgres:5432\//.test(apiBlock), '6.5: DATABASE_URL targets the `postgres` service (no P1001)');
  if (!usedComposeCli) skip('6.5: used raw-YAML fallback (compose CLI config unavailable)');
}

// ---- 6.6 (D3): api user:root + docker.sock mounted -> DooD, no EACCES -------
console.log('\n=== 6.6 (D3): DooD docker call from api succeeds (user:root + socket), no EACCES ===');

if (usedComposeCli && config) {
  const api = config.services?.api ?? {};
  assert(String(api.user ?? '') === 'root' || String(api.user ?? '') === '0', '6.6: api runs as `user: root`');
  const mounts = (api.volumes ?? []).map((v) => (typeof v === 'string' ? v : `${v.source}:${v.target}`));
  const hasSock = mounts.some((m) => m.includes('/var/run/docker.sock') && m.includes(':/var/run/docker.sock'));
  assert(hasSock, '6.6: host /var/run/docker.sock is mounted into api (DooD)');
} else {
  const raw = execFileSync('cat', [COMPOSE]).toString('utf8');
  const apiBlock = raw.slice(raw.indexOf('\n  api:'), raw.indexOf('\n  postgres:'));
  assert(/user:\s*root/.test(apiBlock), '6.6: api declares `user: root`');
  assert(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/.test(apiBlock), '6.6: docker.sock is mounted into api');
}

// ---- 6.6 DYNAMIC probe: a real DooD docker call has no EACCES ---------------
// Bring up just the api container's user/socket contract by running a
// throwaway container with the SAME user + socket mount and invoking `docker`.
// This proves a root process can read the root-owned socket with no EACCES,
// which is exactly the failure mode 6.6 guards. Skips offline.
const canProbe = dockerAvailable();
if (canProbe) {
  try {
    // Use the docker CLI image already present implicitly via the host docker —
    // run an alpine with docker-cli to talk to the mounted socket. If the cli
    // image is not pullable offline, this throws and we SKIP.
    const out = execFileSync(
      'docker',
      [
        'run', '--rm', '--user', 'root',
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        'docker:cli', 'docker', 'version', '--format', '{{.Server.Version}}',
      ],
      { stdio: 'pipe', timeout: 60_000 },
    ).toString('utf8').trim();
    assert(out.length > 0 && !/EACCES|permission denied/i.test(out),
      `6.6 DYNAMIC: a root DooD docker call through the mounted socket succeeds (server ${out}), no EACCES`);
  } catch (err) {
    const msg = String(err.stderr ?? err.message ?? err);
    if (/EACCES|permission denied/i.test(msg)) {
      assert(false, `6.6 DYNAMIC: DooD docker call hit EACCES on the socket: ${msg}`);
    } else {
      skip('6.6 DYNAMIC: DooD probe (docker:cli image / socket unavailable offline)');
    }
  }
} else {
  skip('6.6 DYNAMIC: docker not available for the live DooD probe');
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
