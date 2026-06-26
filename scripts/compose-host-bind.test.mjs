import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
let skipped = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}
function skip(label) {
  console.log(`  SKIP  ${label}`);
  skipped++;
}

function dockerAvailable() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function render(composeFile, env = {}) {
  const json = execFileSync(
    'docker',
    ['compose', '-f', composeFile, '--env-file', '/dev/null', 'config', '--format', 'json'],
    {
      cwd: repoRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        AUTH_TOKEN: process.env.AUTH_TOKEN ?? 'x',
        COMPOSE_PROFILES: 'web',
        ...env,
      },
    },
  ).toString('utf8');
  return JSON.parse(json);
}

function portHost(config, serviceName, target) {
  const ports = config.services?.[serviceName]?.ports ?? [];
  const found = ports.find((port) => String(port.target) === String(target));
  return found?.host_ip ?? found?.hostIp ?? found?.host_ip_address ?? '';
}

console.log('\n=== compose host-bind defaults ===\n');

if (!dockerAvailable()) {
  skip('docker compose unavailable — host-bind render checks skipped');
} else {
  for (const file of ['docker-compose.yml', 'docker-compose.prod.yml']) {
    const defaults = render(resolve(repoRoot, file));
    assert(portHost(defaults, 'api', 8080) === '0.0.0.0', `${file}: api binds 0.0.0.0 by default`);
    assert(portHost(defaults, 'web', 3000) === '0.0.0.0', `${file}: web binds 0.0.0.0 by default`);

    const loopback = render(resolve(repoRoot, file), {
      API_HOST_BIND: '127.0.0.1',
      WEB_HOST_BIND: '127.0.0.1',
    });
    assert(portHost(loopback, 'api', 8080) === '127.0.0.1', `${file}: api loopback override works`);
    assert(portHost(loopback, 'web', 3000) === '127.0.0.1', `${file}: web loopback override works`);

    const grafanaHost = portHost(defaults, 'grafana', 3000);
    if (grafanaHost) {
      assert(grafanaHost === '127.0.0.1', `${file}: grafana remains loopback-only`);
    }
  }
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
console.error('SOME TESTS FAILED');
process.exit(1);
