import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const quickDeploy = resolve(repoRoot, 'scripts/quick-deploy.sh');
const preflightLib = resolve(repoRoot, 'scripts/install-preflight.sh');

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

function makeBin(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

function makeCase() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-quick-deploy-'));
  const bin = join(dir, 'bin');
  const workdir = join(dir, 'work');
  const log = join(dir, 'commands.log');
  spawnSync('mkdir', ['-p', bin, workdir]);
  makeBin(bin, 'timeout', 'echo "timeout should-not-run" >> "$CAP_TEST_LOG"; exit 99\n');
  makeBin(bin, 'docker', `
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
  "version --format") echo "  engine OK: server test linux/amd64"; exit 0 ;;
esac
if [ "$1" = "context" ]; then exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then exit 0; fi
if [ "$1" = "compose" ]; then exit 0; fi
exit 0
`);
  makeBin(bin, 'curl', `
echo "curl $*" >> "$CAP_TEST_LOG"
case "$*" in
  *docker-compose.prod.yml*)
    out=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "-o" ]; then out="$arg"; fi
      prev="$arg"
    done
    [ -n "$out" ] || out="$CAP_FAKE_CURL_OUT"
    cat > "$out" <<'COMPOSE'
# cap-managed-run-package: docker-compose.prod.yml
services:
  api:
    image: ghcr.io/xeonice/cap-api:vtest
COMPOSE
    exit 0
    ;;
  *api.github.com/rate_limit*)
    echo 200
    exit 0
    ;;
  *"-w %{http_code}"*"/health"*)
    if [ "$CAP_FAKE_HEALTH_FAIL" = "1" ]; then exit 22; fi
    echo 200
    exit 0
    ;;
  *"/health"*)
    if [ "$CAP_FAKE_HEALTH_FAIL" = "1" ]; then exit 22; fi
    echo '{"status":"ok"}'
    exit 0
    ;;
  *"/v1/sandboxes/"*"/exec"*)
    if [ "$CAP_FAKE_BOXLITE_READY" = "1" ]; then echo '{"exitCode":0,"output":""}'; else echo '{"exitCode":1,"output":"missing"}'; fi
    exit 0
    ;;
  *"-X DELETE"*"/v1/sandboxes/"*)
    echo '{}'
    exit 0
    ;;
  *"/v1/sandboxes"*)
    if [ "$CAP_FAKE_BOXLITE_READY" = "1" ]; then echo '{"id":"cap-quick-deploy-preflight-test"}'; else echo '{}'; fi
    exit 0
    ;;
  *"/v1/default/boxes/probe-box/executions/exec-probe"*)
    if [ "$CAP_FAKE_BOXLITE_READY" = "1" ]; then echo '{"exit_code":0}'; else echo 404; fi
    exit 0
    ;;
  *"/v1/default/executions/exec-probe"*)
    echo 404
    exit 0
    ;;
  *"/v1/default/boxes/probe-box/exec"*)
    if [ "$CAP_FAKE_BOXLITE_READY" = "1" ]; then echo '{"execution_id":"exec-probe"}'; else echo 404; fi
    exit 0
    ;;
  *"/v1/default/boxes/probe-box/start"*)
    if [ "$CAP_FAKE_BOXLITE_READY" = "1" ]; then echo '{"box_id":"probe-box","status":"running"}'; else echo 404; fi
    exit 0
    ;;
  *"/v1/default/boxes/"*"/exec"*)
    echo 404
    exit 0
    ;;
  *"-w %{http_code}"*"/v1/default/boxes"*)
    if [ "$CAP_FAKE_BOXLITE_READY" = "1" ]; then echo 200; else echo 404; fi
    exit 0
    ;;
  *"/v1/default/boxes"*)
    if [ "$CAP_FAKE_BOXLITE_READY" = "1" ]; then echo '{"box_id":"probe-box"}'; else echo 404; fi
    exit 0
    ;;
  *)
    echo '{}'
    exit 0
    ;;
esac
`);
  return { dir, bin, workdir, log };
}

function runQuickDeploy(testCase, env = {}, options = {}) {
  const input = options.stdin ? readFileSync(quickDeploy, 'utf8') : undefined;
  const args = options.stdin ? ['-s'] : [quickDeploy];
  return spawnSync('bash', args, {
    cwd: repoRoot,
    input,
    env: {
      ...process.env,
      PATH: `${testCase.bin}:/usr/bin:/bin`,
      CAP_PREFLIGHT_LIB_PATH: preflightLib,
      CAP_TEST_LOG: testCase.log,
      CAP_FAKE_CURL_OUT: join(testCase.workdir, 'curl.out'),
      CAP_TEST_UNAME: 'Linux',
      CAP_TEST_ARCH: 'x86_64',
      CAP_WORKDIR: testCase.workdir,
      CAP_VERSION: 'vtest',
      CAP_SANDBOX_PROVIDER: 'control-plane',
      WITH_WEB: '0',
      ...env,
    },
    encoding: 'utf8',
  });
}

function readLog(testCase) {
  try {
    return readFileSync(testCase.log, 'utf8');
  } catch {
    return '';
  }
}

console.log('\n=== quick-deploy preflight ===\n');

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_RAW_BASE: 'https://assets.example.test',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'run-package',
  }, { stdin: true });
  const log = readLog(tc);
  assert(result.status === 0, 'piped quick-deploy reaches run-package gate');
  assert(existsSync(join(tc.workdir, 'docker-compose.prod.yml')), 'piped quick-deploy fetches compose without a script path');
  assert(!/timeout should-not-run/.test(log), 'quick-deploy does not call GNU timeout');
}

{
  const tc = makeCase();
  const compose = join(tc.workdir, 'docker-compose.prod.yml');
  writeFileSync(compose, '# cap-managed-run-package: docker-compose.prod.yml\nservices: {}\n', 'utf8');
  const result = runQuickDeploy(tc, { CAP_QUICK_DEPLOY_STOP_AFTER: 'run-package' });
  assert(result.status === 0, 'managed stale compose refresh succeeds');
  assert(readdirSync(tc.workdir).some((name) => name.startsWith('docker-compose.prod.yml.bak.')), 'managed stale compose is backed up');
  assert(/SELF-CONTAINED|cap-api/.test(readFileSync(compose, 'utf8')), 'managed stale compose is replaced with current package');
}

{
  const tc = makeCase();
  const compose = join(tc.workdir, 'docker-compose.prod.yml');
  writeFileSync(compose, 'services: {}\n', 'utf8');
  const result = runQuickDeploy(tc, { CAP_QUICK_DEPLOY_STOP_AFTER: 'run-package' });
  assert(result.status !== 0, 'user-managed compose is refused by default');
  assert(/no CAP managed marker/.test(result.stderr), 'user-managed refusal explains marker requirement');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, 'BoxLite readiness failure blocks success before pull/up');
  assert(/BOXLITE_PROTOCOL_MODE=native is not compatible/.test(combined), 'BoxLite readiness reports protocol mismatch');
  assert(!combined.includes('box-secret-token'), 'BoxLite readiness output redacts token');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });
  const log = readLog(tc);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'BoxLite native runtime readiness succeeds before pull/up');
  assert(/\/v1\/default\/boxes\/probe-box\/start/.test(log), 'BoxLite readiness starts native probe sandbox before exec');
  assert(!/\{"name":"cap-quick-deploy-preflight-[0-9]+","image":"cap-boxlite:test","working_dir"/.test(log), 'BoxLite native create payload omits working_dir');
  assert(/runtime image\/workspace\/tools probe passed/.test(combined), 'BoxLite readiness runs image/workspace/tools probe');
  assert(!combined.includes('box-secret-token'), 'BoxLite runtime probe output redacts token');
}

{
  const tc = makeCase();
  const kvmDevice = join(tc.dir, 'dev-kvm');
  writeFileSync(kvmDevice, '', { mode: 0o600 });
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_TEST_DEV_KVM_PATH: kvmDevice,
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'http://host.docker.internal:7331',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'BoxLite host.docker.internal runtime endpoint can use loopback readiness');
  assert(/http:\/\/127\.0\.0\.1:7331\/v1\/default\/boxes/.test(log), 'BoxLite readiness probes the host loopback endpoint');
  assert(!/http:\/\/host\.docker\.internal:7331\/v1\/default\/boxes/.test(log), 'BoxLite readiness avoids host.docker.internal on the host side');
  assert(/BOXLITE_ENDPOINT=http:\/\/host\.docker\.internal:7331/.test(envFile), 'BoxLite api runtime endpoint remains container-facing');
  assert(/BOXLITE_READINESS_ENDPOINT=http:\/\/127\.0\.0\.1:7331/.test(envFile), 'BoxLite loopback readiness endpoint is persisted for repeat runs');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_TEST_UNAME: 'Darwin',
    CAP_TEST_ARCH: 'arm64',
    CAP_TEST_MACOS_VERSION: '14.5',
    CAP_TEST_KERN_HV_SUPPORT: '0',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'http://127.0.0.1:7331',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });
  const log = readLog(tc);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, 'BoxLite local macOS readiness fails before endpoint probe when Hypervisor is unavailable');
  assert(/kern\.hv_support=0/.test(combined), 'BoxLite local macOS failure reports kern.hv_support value');
  assert(!/http:\/\/127\.0\.0\.1:7331\/v1\/default\/boxes/.test(log), 'BoxLite local macOS host dependency failure happens before BoxLite endpoint curl');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_TEST_UNAME: 'Darwin',
    CAP_TEST_ARCH: 'arm64',
    CAP_TEST_MACOS_VERSION: '14.5',
    CAP_TEST_KERN_HV_SUPPORT: '1',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'http://127.0.0.1:7331',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'BoxLite local macOS readiness passes when Hypervisor is available');
  assert(/Hypervisor\.framework available/.test(combined), 'BoxLite local macOS readiness reports Hypervisor dependency');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_TEST_UNAME: 'Darwin',
    CAP_TEST_ARCH: 'x86_64',
    CAP_TEST_MACOS_VERSION: '14.5',
    CAP_TEST_KERN_HV_SUPPORT: '1',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'http://localhost:7331',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, 'BoxLite local macOS readiness fails on non-Apple-Silicon host');
  assert(/requires Apple Silicon arm64/.test(combined), 'BoxLite local macOS architecture failure names arm64 requirement');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_TEST_UNAME: 'Darwin',
    CAP_TEST_ARCH: 'arm64',
    CAP_TEST_MACOS_VERSION: '14.5',
    CAP_TEST_KERN_HV_SUPPORT: '0',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'BoxLite external endpoint skips local macOS Hypervisor requirement');
  assert(/external endpoint; local Hypervisor\/KVM check skipped/.test(combined), 'BoxLite external endpoint reports skipped local host dependency check');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_TEST_DEV_KVM_PATH: join(tc.dir, 'missing-kvm'),
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'http://127.0.0.1:7331',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, 'BoxLite local Linux readiness fails when KVM device is missing');
  assert(/requires Linux KVM/.test(combined), 'BoxLite local Linux failure names KVM dependency');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    API_HOST_PORT: '18080',
    WEB_HOST_PORT: '13000',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROTOCOL_MODE: 'rest',
  });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'BoxLite legacy protocol alias reaches env gate');
  assert(/BOXLITE_PROTOCOL_MODE=cap-rest/.test(envFile), 'BoxLite legacy protocol alias is normalized for the API');
  assert(/BOXLITE_RUNTIME_REQUIRED_TOOLS=.*codex/.test(envFile), 'quick-deploy persists BoxLite runtime tool contract');
  assert(/API_HOST_PORT=18080/.test(envFile), 'quick-deploy persists api host port for future compose runs');
  assert(/WEB_HOST_PORT=13000/.test(envFile), 'quick-deploy persists web host port for future compose runs');
  assert(/CAP_PUBLIC_API_PORT=18080/.test(envFile), 'quick-deploy aligns public api port with host port');
  assert(/CAP_PUBLIC_WEB_PORT=13000/.test(envFile), 'quick-deploy aligns public web port with host port');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_READINESS_PATH: '/health',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROTOCOL_MODE: 'cap-rest',
  });
  const log = readLog(tc);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'BoxLite cap-rest runtime readiness succeeds before pull/up');
  assert(/\/v1\/sandboxes/.test(log), 'BoxLite cap-rest readiness creates a probe sandbox');
  assert(/command -v 'codex'/.test(log), 'BoxLite cap-rest readiness checks the AIO runtime tool contract');
  assert(/cap-rest runtime image\/workspace\/tools probe passed/.test(combined), 'BoxLite cap-rest readiness reports runtime probe success');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_HEALTH_FAIL: '1',
    CAP_HEALTH_TIMEOUT_SECONDS: '1',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, 'health timeout failure blocks install success');
  assert(/waiting up to 1s for api \/health/.test(combined), 'health wait announces configured timeout');
  assert(/api did not become healthy in 1s/.test(combined), 'health timeout error uses configured timeout');
}

{
  const tc = makeCase();
  writeFileSync(join(tc.workdir, '.env.github-validation'), 'GITHUB_VALIDATION_TOKEN=ghp_secret_token_for_test\n', 'utf8');
  const result = runQuickDeploy(tc, {
    RUN_GITHUB_VALIDATION: '1',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'GitHub validation succeeds with ignored local token');
  assert(/token from env\/ignored file \(redacted\)/.test(combined), 'GitHub validation reports redacted token source');
  assert(!combined.includes('ghp_secret_token_for_test'), 'GitHub validation output does not print token');
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
console.error('SOME TESTS FAILED');
process.exit(1);
