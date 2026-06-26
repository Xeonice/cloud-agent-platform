import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const LIB = resolve(repoRoot, 'scripts/sandbox-provider-selection.sh');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function sh(script, env = {}) {
  return execFileSync('sh', ['-c', `. "${LIB}"; ${script}`], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  }).toString('utf8').trim();
}

console.log('\n=== sandbox-provider-selection ===\n');

assert(
  sh('cap_provider_resolve auto', { CAP_TEST_UNAME: 'Darwin' }) === 'boxlite',
  'auto on Darwin resolves to boxlite',
);
assert(
  sh('cap_provider_resolve auto', { CAP_TEST_UNAME: 'Linux' }) === 'aio',
  'auto on Linux resolves to aio',
);
assert(
  sh('cap_provider_resolve boxlite', { CAP_TEST_UNAME: 'Linux' }) === 'boxlite',
  'explicit boxlite override wins on Linux',
);
assert(
  sh('cap_provider_resolve aio', { CAP_TEST_UNAME: 'Darwin' }) === 'aio',
  'explicit aio override wins on Darwin',
);
assert(
  sh('cap_provider_resolve control-plane-only', { CAP_TEST_UNAME: 'Darwin' }) === 'control-plane',
  'control-plane-only alias normalizes to control-plane',
);
assert(
  sh('cap_provider_make_target control-plane', { CAP_TEST_UNAME: 'Linux' }) === 'up-cp',
  'control-plane maps to make up-cp',
);
assert(
  sh('cap_provider_make_target boxlite', { CAP_TEST_UNAME: 'Linux' }) === 'up',
  'boxlite maps to make up',
);

const invalid = spawnSync('sh', ['-c', `. "${LIB}"; cap_provider_resolve nope`], {
  cwd: repoRoot,
  env: process.env,
  encoding: 'utf8',
});
assert(invalid.status === 2, 'invalid provider exits 2');
assert(/invalid CAP_SANDBOX_PROVIDER/.test(invalid.stderr), 'invalid provider explains valid values');

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
console.error('SOME TESTS FAILED');
process.exit(1);
