import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const quickDeploy = resolve(repoRoot, 'scripts/quick-deploy.sh');
const preflightLib = resolve(repoRoot, 'scripts/install-preflight.sh');
const TEST_ADMISSION_ATTESTATION = JSON.stringify({
  schemaVersion: 1,
  deploymentId: 'quick-deploy-test',
  expectedWorkers: [{ instanceId: 'cap-api-1', roles: ['api', 'worker'] }],
  reports: [
    {
      schemaVersion: 1,
      instanceId: 'cap-api-1',
      role: 'api',
      buildIdentity: 'test-build',
      capabilities: ['task-admission-v2'],
      ready: true,
      reportedAt: '2026-07-16T00:00:00.000Z',
    },
    {
      schemaVersion: 1,
      instanceId: 'cap-api-1',
      role: 'worker',
      buildIdentity: 'test-build',
      capabilities: ['task-admission-v2'],
      ready: true,
      reportedAt: '2026-07-16T00:00:00.000Z',
    },
  ],
  attestedAt: '2026-07-16T00:01:00.000Z',
  expiresAt: '2099-07-16T01:01:00.000Z',
});

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
if [ -n "\${CAP_CUTOVER_BEARER_TOKEN:-}\${CAP_CUTOVER_BEARER_TOKEN_VALUE:-}\${BOXLITE_HOST_STORAGE_PATH:-}\${BOXLITE_HOST_AVAILABLE_GB:-}" ]; then
  echo "PROCESS_ONLY_VALUE_LEAKED_TO_DOCKER" >> "$CAP_TEST_LOG"
fi
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
  "version --format") echo "  engine OK: server test linux/amd64"; exit 0 ;;
esac
if [ "$1" = "context" ]; then exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then exit 0; fi
if [ "$1" = "load" ]; then cat >/dev/null; exit 0; fi
if [ "$1" = "compose" ]; then
  case "$*" in
    *"up -d --force-recreate api"*)
      [ "\${CAP_FAKE_ROLLBACK_RECREATE_FAIL:-0}" = "1" ] && exit 17
      exit 0
      ;;
    *" pull "*)
      [ "\${CAP_FAKE_COMPOSE_PULL_FAIL:-0}" = "1" ] && exit 18
      exit 0
      ;;
    *" up -d "*)
      [ "\${CAP_FAKE_COMPOSE_UP_FAIL:-0}" = "1" ] && exit 19
      exit 0
      ;;
    *"ps --status running --services"*)
      printf '%s\\n' "\${CAP_FAKE_COMPOSE_RUNNING_SERVICES:-}"
      exit 0
      ;;
    *"JSON.parse(process.argv[1])"*)
      [ "\${CAP_FAKE_ATTESTATION_SYNTAX_INVALID:-0}" = "1" ] && exit 2
      exit 0
      ;;
    *"sandboxEnvironment.findMany"*)
      [ "\${CAP_FAKE_CAPACITY_QUERY_FAIL:-0}" = "1" ] && exit 1
      case "$*" in
        *'status: "ready"'*'providerFamilies: { has: "boxlite" }'*) ;;
        *) exit 4 ;;
      esac
      printf 'persisted=%s\\nmaxReadyDisk=%s' \
        "\${CAP_FAKE_PERSISTED_CONCURRENCY:-none}" \
        "\${CAP_FAKE_MAX_READY_BOXLITE_DISK_GB:-0}"
      exit 0
      ;;
    *"value?.gate?.open === true"*)
      [ "\${CAP_FAKE_CAPABILITY_OPEN:-0}" = "1" ] && exit 0
      exit 2
      ;;
  esac
  exit 0
fi
exit 0
`);
  makeBin(bin, 'df', `
available="\${CAP_FAKE_HOST_AVAILABLE_KIB:-104857600}"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf '/dev/test 209715200 0 %s 0%% /test\\n' "$available"
`);
  makeBin(bin, 'zstd', `
echo "zstd $*" >> "$CAP_TEST_LOG"
if [ "$1" = "-dc" ]; then
  if [ -n "$2" ]; then cat "$2"; else cat; fi
  exit 0
fi
exit 0
`);
  makeBin(bin, 'tar', `
echo "tar $*" >> "$CAP_TEST_LOG"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || out="$CAP_FAKE_TAR_OUT"
mkdir -p "$out"
cat >/dev/null
echo "oci-layout" > "$out/oci-layout"
exit 0
`);
  makeBin(bin, 'curl', `
echo "curl $*" >> "$CAP_TEST_LOG"
if [ -n "\${CAP_CUTOVER_BEARER_TOKEN:-}\${CAP_CUTOVER_BEARER_TOKEN_VALUE:-}\${BOXLITE_HOST_STORAGE_PATH:-}\${BOXLITE_HOST_AVAILABLE_GB:-}" ]; then
  echo "PROCESS_ONLY_VALUE_LEAKED_TO_CURL" >> "$CAP_TEST_LOG"
fi
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
case "$*" in
  *docker-compose.prod.yml*)
    [ -n "$out" ] || out="$CAP_FAKE_CURL_OUT"
    cat > "$out" <<'COMPOSE'
# cap-managed-run-package: docker-compose.prod.yml
services:
  api:
    image: ghcr.io/xeonice/cap-api:vtest
COMPOSE
    exit 0
    ;;
  *cap-image-assets.json*)
    [ -n "$out" ] || out="$CAP_FAKE_CURL_OUT"
    if [ "$CAP_FAKE_SPLIT_ASSET" = "1" ]; then
      cat > "$out" <<'JSON'
{
  "schemaVersion": 2,
  "version": "vtest",
  "assets": [
    {
      "asset": "cap-aio-sandbox-vtest-linux-amd64.docker.tar.zst",
      "parts": [
        { "asset": "cap-aio-sandbox-vtest-linux-amd64.docker.tar.zst.part-0001" },
        { "asset": "cap-aio-sandbox-vtest-linux-amd64.docker.tar.zst.part-0002" }
      ]
    },
    {
      "asset": "cap-boxlite-sandbox-vtest-linux-arm64.oci.tar.zst",
      "parts": [
        { "asset": "cap-boxlite-sandbox-vtest-linux-arm64.oci.tar.zst.part-0001" },
        { "asset": "cap-boxlite-sandbox-vtest-linux-arm64.oci.tar.zst.part-0002" }
      ]
    },
    {
      "asset": "cap-boxlite-sandbox-vtest-linux-amd64.oci.tar.zst",
      "parts": [
        { "asset": "cap-boxlite-sandbox-vtest-linux-amd64.oci.tar.zst.part-0001" },
        { "asset": "cap-boxlite-sandbox-vtest-linux-amd64.oci.tar.zst.part-0002" }
      ]
    }
  ]
}
JSON
    else
      cat > "$out" <<'JSON'
{
  "schemaVersion": 1,
  "version": "vtest",
  "assets": [
    { "asset": "cap-aio-sandbox-vtest-linux-amd64.docker.tar.zst" },
    { "asset": "cap-boxlite-sandbox-vtest-linux-arm64.oci.tar.zst" },
    { "asset": "cap-boxlite-sandbox-vtest-linux-amd64.oci.tar.zst" }
  ]
}
JSON
    fi
    exit 0
    ;;
  *.sha256*)
    [ -n "$out" ] || out="$CAP_FAKE_CURL_OUT"
    name="$(basename "$out")"
    name="\${name%.captmp}"
    name="\${name%.sha256}"
    case "$name" in
      *.part-0001) content="asset-" ;;
      *.part-0002) content="content" ;;
      *) content="\${CAP_FAKE_ASSET_CONTENT:-asset-content}" ;;
    esac
    if command -v sha256sum >/dev/null 2>&1; then
      digest="$(printf '%s' "$content" | sha256sum | awk '{ print $1 }')"
    else
      digest="$(printf '%s' "$content" | shasum -a 256 | awk '{ print $1 }')"
    fi
    printf '%s  %s\\n' "$digest" "$name" > "$out"
    exit 0
    ;;
  *.tar.zst*)
    [ -n "$out" ] || out="$CAP_FAKE_CURL_OUT"
    case "$*" in
      *.part-0001*) content="asset-" ;;
      *.part-0002*)
        if [ "$CAP_FAKE_CORRUPT_PART" = "1" ]; then content="corrupt"; else content="content"; fi
        ;;
      *) content="\${CAP_FAKE_ASSET_CONTENT:-asset-content}" ;;
    esac
    printf '%s' "$content" > "$out"
    exit 0
    ;;
  *api.github.com/rate_limit*)
    echo 200
    exit 0
    ;;
  *"/auth/password"*)
    status="\${CAP_FAKE_ADMIN_LOGIN_STATUS:-200}"
    [ -z "$out" ] || printf '{"ok":true}' > "$out"
    echo "$status"
    exit 0
    ;;
  *"/deployment-capabilities/task-admission-v2"*)
    status="\${CAP_FAKE_CAPABILITY_STATUS:-200}"
    if [ "\${CAP_FAKE_CAPABILITY_OPEN:-0}" = "1" ]; then
      body='{"capability":"task-admission-v2","gate":{"capability":"task-admission-v2","open":true,"verifiedRoles":["api","worker"]},"localReports":[]}'
    else
      body='{"capability":"task-admission-v2","gate":{"capability":"task-admission-v2","open":false,"reason":"worker_not_ready","missingRoles":["worker"]},"localReports":[]}'
    fi
    [ -z "$out" ] && printf '%s\\n' "$body" || printf '%s' "$body" > "$out"
    echo "$status"
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

function curlTimeout(log, ...fragments) {
  const line = log
    .split('\n')
    .find((candidate) => candidate.startsWith('curl ') && fragments.every((fragment) => candidate.includes(fragment)));
  const match = line?.match(/(?:^|\s)-m\s+(\d+)(?:\s|$)/);
  return match ? Number(match[1]) : undefined;
}

function managedBoxliteRootfs(testCase, version, platform = 'linux-amd64') {
  return join(
    testCase.workdir,
    'sandbox-assets',
    'boxlite',
    'cap-boxlite-sandbox',
    version,
    platform,
    'oci',
  );
}

function materializeManagedBoxliteRootfs(rootfsPath) {
  mkdirSync(rootfsPath, { recursive: true });
  writeFileSync(
    join(rootfsPath, 'oci-layout'),
    '{"imageLayoutVersion":"1.0.0"}\n',
    'utf8',
  );
}

function seedBoxliteRootfsEnv(testCase, rootfsPath) {
  const content = [
    'CAP_VERSION=v0.37.1',
    'CAP_SANDBOX_PROVIDER=boxlite',
    'CAP_SANDBOX_IMAGE_DELIVERY=release-assets',
    `BOXLITE_ROOTFS_PATH=${rootfsPath}`,
    'EXISTING_SECRET=keep-me',
    '',
  ].join('\n');
  writeFileSync(join(testCase.workdir, '.env'), content, 'utf8');
  return content;
}

console.log('\n=== quick-deploy preflight ===\n');

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_IMAGE_DELIVERY: 'bad',
  });
  assert(result.status !== 0, 'invalid sandbox image delivery mode fails early');
  assert(/invalid CAP_SANDBOX_IMAGE_DELIVERY/.test(result.stderr), 'invalid delivery mode prints accepted values');
}

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
    CAP_SANDBOX_PROVIDER: 'aio',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
  });
  const log = readLog(tc);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'AIO Release-asset delivery stages sandbox archive before readiness');
  assert(/cap-image-assets\.json/.test(log), 'AIO asset delivery fetches the manifest');
  assert(/cap-aio-sandbox-vtest-linux-amd64\.docker\.tar\.zst/.test(log), 'AIO asset delivery fetches the Docker archive');
  assert(/zstd -dc/.test(log), 'AIO asset delivery decompresses the archive');
  assert(/docker load/.test(log), 'AIO asset delivery loads the Docker archive');
  assert(/AIO readiness: staged ghcr\.io\/xeonice\/cap-aio-sandbox:vtest from Release asset/.test(combined), 'AIO asset readiness reports staged image');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_SPLIT_ASSET: '1',
    CAP_SANDBOX_PROVIDER: 'aio',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
  });
  const log = readLog(tc);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'AIO split Release asset is downloaded, verified, and streamed');
  assert(/\.docker\.tar\.zst\.part-0001/.test(log), 'AIO split delivery downloads part 0001');
  assert(/\.docker\.tar\.zst\.part-0002/.test(log), 'AIO split delivery downloads part 0002');
  assert(/combined checksum verified/.test(combined), 'AIO split delivery verifies the logical whole-asset checksum');
  assert(/docker load/.test(log), 'AIO split delivery streams the verified parts into docker load');
}

{
  const tc = makeCase();
  const previousCompose = '# cap-managed-run-package: docker-compose.prod.yml\nservices: {}\n';
  const previousEnv = 'CAP_VERSION=vprevious\nEXISTING_SECRET=keep-me\n';
  writeFileSync(join(tc.workdir, 'docker-compose.prod.yml'), previousCompose, 'utf8');
  writeFileSync(join(tc.workdir, '.env'), previousEnv, 'utf8');
  const result = runQuickDeploy(tc, {
    CAP_FAKE_SPLIT_ASSET: '1',
    CAP_FAKE_CORRUPT_PART: '1',
    CAP_SANDBOX_PROVIDER: 'aio',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
  });
  const log = readLog(tc);
  assert(result.status !== 0, 'a corrupt AIO asset part blocks provider readiness');
  assert(!/docker load/.test(log), 'a corrupt split asset is rejected before docker load');
  assert(
    readFileSync(join(tc.workdir, '.env'), 'utf8') === previousEnv,
    'a corrupt split asset restores the previous env file byte-for-byte',
  );
  assert(
    readFileSync(join(tc.workdir, 'docker-compose.prod.yml'), 'utf8') === previousCompose,
    'a corrupt split asset restores the previous compose file byte-for-byte',
  );
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'BoxLite Release-asset delivery stages rootfs before env gate');
  assert(/cap-boxlite-sandbox-vtest-linux-amd64\.oci\.tar\.zst/.test(log), 'BoxLite asset delivery fetches the host platform OCI asset');
  assert(/tar -C .*boxlite\/cap-boxlite-sandbox\/vtest\/linux-amd64\/oci/.test(log), 'BoxLite asset delivery extracts the OCI asset');
  assert(/CAP_SANDBOX_IMAGE_DELIVERY=release-assets/.test(envFile), 'quick-deploy persists Release-asset delivery mode');
  assert(/BOXLITE_ROOTFS_PATH=.*boxlite\/cap-boxlite-sandbox\/vtest\/linux-amd64\/oci/.test(envFile), 'quick-deploy writes BoxLite rootfs path');
  assert(!/BOXLITE_IMAGE=/.test(envFile), 'quick-deploy does not persist a BoxLite image when rootfs path is staged');
}

{
  const tc = makeCase();
  const previousRootfs = managedBoxliteRootfs(tc, 'v0.37.1');
  const currentRootfs = managedBoxliteRootfs(tc, 'vtest');
  seedBoxliteRootfsEnv(tc, previousRootfs);
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'a stale managed BoxLite rootfs is upgraded with CAP_VERSION');
  assert(/cap-image-assets\.json/.test(log), 'a managed rootfs upgrade fetches the current asset manifest');
  assert(/cap-boxlite-sandbox-vtest-linux-amd64\.oci\.tar\.zst/.test(log), 'a managed rootfs upgrade fetches the current OCI asset');
  assert(envFile.includes(`BOXLITE_ROOTFS_PATH=${currentRootfs}`), 'a managed rootfs upgrade persists the current release path');
  assert(!envFile.includes(previousRootfs), 'a managed rootfs upgrade removes the stale release path');
}

{
  const tc = makeCase();
  const customRootfs = join(tc.dir, 'user-managed', 'boxlite-rootfs');
  seedBoxliteRootfsEnv(tc, customRootfs);
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'a user-managed BoxLite rootfs survives a CAP upgrade');
  assert(!/cap-image-assets\.json/.test(log), 'a user-managed rootfs does not trigger Release-asset staging');
  assert(envFile.includes(`BOXLITE_ROOTFS_PATH=${customRootfs}`), 'a user-managed rootfs path is preserved');
}

{
  const tc = makeCase();
  const previousRootfs = managedBoxliteRootfs(tc, 'v0.37.1');
  const explicitRootfs = managedBoxliteRootfs(tc, 'v0.36.0');
  seedBoxliteRootfsEnv(tc, previousRootfs);
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_ROOTFS_PATH: explicitRootfs,
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'an explicit BoxLite rootfs process override wins during upgrade');
  assert(!/cap-image-assets\.json/.test(log), 'an explicit rootfs override does not trigger Release-asset staging');
  assert(envFile.includes(`BOXLITE_ROOTFS_PATH=${explicitRootfs}`), 'an explicit managed-looking rootfs override is preserved');
}

{
  const tc = makeCase();
  const previousRootfs = managedBoxliteRootfs(tc, 'v0.37.1');
  const explicitRootfsMap = 'default=/srv/user-managed/boxlite-rootfs';
  seedBoxliteRootfsEnv(tc, previousRootfs);
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_ROOTFS_PATH: '',
    BOXLITE_ROOTFS_PATH_MAP: explicitRootfsMap,
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'an explicit BoxLite rootfs map overrides a stale managed scalar');
  assert(!/cap-image-assets\.json/.test(log), 'an explicit rootfs map does not trigger Release-asset staging');
  assert(!/^BOXLITE_ROOTFS_PATH=/m.test(envFile), 'an explicit rootfs map removes the stale scalar key');
  assert(envFile.includes(`BOXLITE_ROOTFS_PATH_MAP=${explicitRootfsMap}`), 'an explicit rootfs map is persisted without scalar ambiguity');
}

{
  const tc = makeCase();
  const currentRootfs = managedBoxliteRootfs(tc, 'vtest');
  materializeManagedBoxliteRootfs(currentRootfs);
  seedBoxliteRootfsEnv(tc, currentRootfs);
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'a current managed BoxLite rootfs is reusable');
  assert(!/cap-image-assets\.json/.test(log), 'a current managed rootfs is not staged again');
  assert(envFile.includes(`BOXLITE_ROOTFS_PATH=${currentRootfs}`), 'a current managed rootfs path remains unchanged');
}

{
  const tc = makeCase();
  const currentRootfs = managedBoxliteRootfs(tc, 'vtest');
  mkdirSync(currentRootfs, { recursive: true });
  writeFileSync(join(currentRootfs, 'incomplete'), 'missing oci-layout\n', 'utf8');
  seedBoxliteRootfsEnv(tc, currentRootfs);
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'an incomplete current managed BoxLite rootfs is staged again');
  assert(/cap-image-assets\.json/.test(log), 'an incomplete current rootfs fetches the current asset manifest');
  assert(/tar -C .*boxlite\/cap-boxlite-sandbox\/vtest\/linux-amd64\/oci/.test(log), 'an incomplete current rootfs is replaced from the OCI asset');
  assert(existsSync(join(currentRootfs, 'oci-layout')), 'restaging restores the managed OCI layout marker');
  assert(envFile.includes(`BOXLITE_ROOTFS_PATH=${currentRootfs}`), 'restaging keeps the canonical current rootfs path');
}

{
  const tc = makeCase();
  const previousRootfs = managedBoxliteRootfs(tc, 'v0.37.1');
  seedBoxliteRootfsEnv(tc, previousRootfs);
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'registry delivery replaces a stale managed BoxLite rootfs');
  assert(!/cap-image-assets\.json/.test(log), 'registry delivery does not fetch BoxLite Release assets');
  assert(!/BOXLITE_ROOTFS_PATH=/.test(envFile), 'registry delivery removes the stale managed rootfs path');
  assert(/BOXLITE_IMAGE=ghcr\.io\/xeonice\/cap-boxlite-sandbox:vtest/.test(envFile), 'registry delivery pins the current BoxLite image');
  assert(/CAP_SANDBOX_IMAGE_DELIVERY=registry/.test(envFile), 'registry delivery remains explicit in the env file');
}

{
  const tc = makeCase();
  const currentRootfs = managedBoxliteRootfs(tc, 'vtest');
  materializeManagedBoxliteRootfs(currentRootfs);
  seedBoxliteRootfsEnv(tc, currentRootfs);
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const log = readLog(tc);
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'registry delivery replaces a current managed BoxLite rootfs');
  assert(!/cap-image-assets\.json/.test(log), 'same-version registry delivery does not fetch BoxLite Release assets');
  assert(!/^BOXLITE_ROOTFS_PATH=/m.test(envFile), 'same-version registry delivery removes the managed rootfs path');
  assert(/BOXLITE_IMAGE=ghcr\.io\/xeonice\/cap-boxlite-sandbox:vtest/.test(envFile), 'same-version registry delivery persists the current image');
  assert(/CAP_SANDBOX_IMAGE_DELIVERY=registry/.test(envFile), 'same-version registry delivery remains explicit');
}

{
  const tc = makeCase();
  const previousCompose = '# cap-managed-run-package: docker-compose.prod.yml\nservices: {}\n';
  writeFileSync(join(tc.workdir, 'docker-compose.prod.yml'), previousCompose, 'utf8');
  const previousEnv = seedBoxliteRootfsEnv(tc, managedBoxliteRootfs(tc, 'v0.37.1'));
  const result = runQuickDeploy(tc, {
    CAP_FAKE_SPLIT_ASSET: '1',
    CAP_FAKE_CORRUPT_PART: '1',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, 'a corrupt BoxLite upgrade asset blocks the managed rootfs replacement');
  assert(/checksum mismatch/.test(combined), 'a corrupt BoxLite upgrade reports its checksum failure');
  assert(readFileSync(join(tc.workdir, '.env'), 'utf8') === previousEnv, 'a failed BoxLite rootfs upgrade restores the previous env file byte-for-byte');
  assert(readFileSync(join(tc.workdir, 'docker-compose.prod.yml'), 'utf8') === previousCompose, 'a failed BoxLite rootfs upgrade restores the previous compose file byte-for-byte');
}

for (const [name, value, pattern] of [
  ['BOXLITE_DISK_SIZE_GB', '0', /BOXLITE_DISK_SIZE_GB must be an integer from 1 to 1024/],
  ['BOXLITE_DISK_SIZE_GB', '1025', /BOXLITE_DISK_SIZE_GB must be an integer from 1 to 1024/],
  ['BOXLITE_DISK_SIZE_GB', '1.5', /BOXLITE_DISK_SIZE_GB must be a base-10 integer from 1 to 1024/],
  ['BOXLITE_GIT_CLONE_TIMEOUT_MS', '999', /BOXLITE_GIT_CLONE_TIMEOUT_MS must be an integer from 1000 to 86400000/],
  ['BOXLITE_GIT_CLONE_TIMEOUT_MS', '86400001', /BOXLITE_GIT_CLONE_TIMEOUT_MS must be an integer from 1000 to 86400000/],
  ['BOXLITE_GIT_CLONE_TIMEOUT_MS', '1e3', /BOXLITE_GIT_CLONE_TIMEOUT_MS must be a base-10 integer from 1000 to 86400000/],
]) {
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    [name]: value,
  });
  assert(result.status !== 0, `${name}=${value} fails before provider readiness`);
  assert(pattern.test(result.stderr), `${name}=${value} reports its canonical range`);
}

for (const [value, pattern] of [
  ['unsafe instance', /CAP_INSTANCE_ID must contain only/],
  ['a'.repeat(257), /CAP_INSTANCE_ID must be at most 256 characters/],
]) {
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_INSTANCE_ID: value,
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
  });
  assert(result.status !== 0, 'quick-deploy rejects an unsafe CAP_INSTANCE_ID before startup');
  assert(pattern.test(result.stderr), 'unsafe CAP_INSTANCE_ID reports the stable identity contract');
}

{
  const tc = makeCase();
  writeFileSync(
    join(tc.workdir, '.env'),
    'CAP_INSTANCE_ID=existing-api-7\nCAP_INSTANCE_ID=duplicate-api-8\n',
    'utf8',
  );
  const result = runQuickDeploy(tc, { CAP_QUICK_DEPLOY_STOP_AFTER: 'env' });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'quick-deploy accepts an existing safe CAP_INSTANCE_ID');
  assert(/^CAP_INSTANCE_ID=existing-api-7$/m.test(envFile), 'quick-deploy preserves the existing stable instance identity');
  assert((envFile.match(/^CAP_INSTANCE_ID=/gm) ?? []).length === 1, 'quick-deploy collapses duplicate instance identity keys to one canonical value');
}

{
  const tc = makeCase();
  writeFileSync(join(tc.workdir, '.env'), 'CAP_INSTANCE_ID=existing-api-7\n', 'utf8');
  const result = runQuickDeploy(tc, {
    CAP_INSTANCE_ID: 'explicit-api-9',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
  });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'quick-deploy accepts an explicit safe CAP_INSTANCE_ID override');
  assert(/^CAP_INSTANCE_ID=explicit-api-9$/m.test(envFile), 'explicit CAP_INSTANCE_ID replaces the prior run-package value deterministically');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_TASK_ADMISSION_V2_ENABLED: 'yes',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
  });
  assert(result.status !== 0, 'admission-v2 rejects an ambiguous boolean value');
  assert(/CAP_TASK_ADMISSION_V2_ENABLED must be true\/false or 1\/0/.test(result.stderr), 'admission-v2 boolean failure names accepted values');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROTOCOL_MODE: 'cap-rest',
  });
  assert(result.status !== 0, 'cap-rest cannot enable admission-v2');
  assert(/cap-rest cannot prove disk_size_gb\/rootfs enforcement/.test(result.stderr), 'cap-rest gate-on failure explains the missing proof');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_FAKE_PERSISTED_CONCURRENCY: '3',
    CAP_FAKE_MAX_READY_BOXLITE_DISK_GB: '9',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    MAX_CONCURRENT_TASKS: '1',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_READINESS_ENDPOINT: 'http://127.0.0.1:7331',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROTOCOL_MODE: 'native',
  });
  assert(result.status !== 0, 'external BoxLite gate-on fails when host capacity evidence is absent');
  assert(/BOXLITE_HOST_AVAILABLE_GB/.test(result.stderr), 'remote runtime remains external even when readiness uses a localhost tunnel');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_FAKE_PERSISTED_CONCURRENCY: '3',
    CAP_FAKE_MAX_READY_BOXLITE_DISK_GB: '9',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    MAX_CONCURRENT_TASKS: '1',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROTOCOL_MODE: 'native',
    BOXLITE_HOST_AVAILABLE_GB: '26',
  });
  assert(result.status !== 0, 'ready BoxLite environment max disk and persisted concurrency block insufficient host capacity');
  assert(/9 GiB x effective persisted concurrency 3 requires at least 27 GiB/.test(result.stderr), 'capacity failure uses ready BoxLite max disk and DB ceiling rather than env seed');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_FAKE_PERSISTED_CONCURRENCY: '3',
    CAP_FAKE_MAX_READY_BOXLITE_DISK_GB: '9',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROTOCOL_MODE: 'native',
    BOXLITE_HOST_AVAILABLE_GB: '27',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'external BoxLite gate-on accepts exact proven aggregate capacity');
  assert(/external host reports 27 GiB available >= 9 GiB x persisted concurrency 3/.test(combined), 'capacity success reports its exact DB/environment calculation');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_SPLIT_ASSET: '1',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'release-assets',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const log = readLog(tc);
  assert(result.status === 0, 'BoxLite split Release asset is verified and streamed into extraction');
  assert(/linux-amd64\.oci\.tar\.zst\.part-0001/.test(log), 'BoxLite split delivery downloads part 0001');
  assert(/linux-amd64\.oci\.tar\.zst\.part-0002/.test(log), 'BoxLite split delivery downloads part 0002');
  assert(/tar -C .*boxlite\/cap-boxlite-sandbox\/vtest\/linux-amd64\/oci/.test(log), 'BoxLite split delivery extracts the ordered stream');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_DISK_SIZE_GB: '7',
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
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_DISK_SIZE_GB: '7',
  });
  const log = readLog(tc);
  const combined = `${result.stdout}\n${result.stderr}`;
  const createTimeout = curlTimeout(log, '"image":"cap-boxlite:test"', '/v1/default/boxes');
  const startTimeout = curlTimeout(log, '/v1/default/boxes/probe-box/start');
  const execTimeout = curlTimeout(log, '/v1/default/boxes/probe-box/exec');
  const deleteTimeout = curlTimeout(log, '-X DELETE', '/v1/default/boxes/probe-box');
  assert(result.status === 0, 'BoxLite native runtime readiness succeeds before pull/up');
  assert(/\/v1\/default\/boxes\/probe-box\/start/.test(log), 'BoxLite readiness starts native probe sandbox before exec');
  assert(createTimeout === 600, 'BoxLite native create keeps a long image preparation timeout');
  assert(startTimeout === 120, 'BoxLite native start reserves enough time for cold ownership and initialization');
  assert(execTimeout === 60, 'BoxLite native exec has a bounded runtime probe timeout');
  assert(deleteTimeout === 30, 'BoxLite native delete has a bounded cleanup timeout');
  assert(/"disk_size_gb":7/.test(log), 'BoxLite native readiness sends the resolved deployment disk_size_gb');
  assert(/df -Pk \/ \| awk -v minimum=6606028/.test(log), 'BoxLite native readiness verifies the rootfs with the production 90% tolerance');
  assert(!/\{"name":"cap-quick-deploy-preflight-[0-9]+","image":"cap-boxlite:test","working_dir"/.test(log), 'BoxLite native create payload omits working_dir');
  assert(/runtime sandbox disk_size_gb\/rootfs\/source\/workspace\/tools probe passed/.test(combined), 'BoxLite readiness runs disk/rootfs/source/workspace/tools probe');
  assert(!combined.includes('box-secret-token'), 'BoxLite runtime probe output redacts token');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_RUNTIME_PROBE_CREATE_TIMEOUT_SECONDS: '601',
    BOXLITE_RUNTIME_PROBE_START_TIMEOUT_SECONDS: '121',
    BOXLITE_RUNTIME_PROBE_EXEC_TIMEOUT_SECONDS: '61',
    BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS: '31',
  });
  const log = readLog(tc);
  assert(result.status === 0, 'BoxLite native runtime readiness accepts custom operation timeouts');
  assert(
    curlTimeout(log, '"image":"cap-boxlite:test"', '/v1/default/boxes') === 601,
    'BoxLite native create uses the configured timeout',
  );
  assert(
    curlTimeout(log, '/v1/default/boxes/probe-box/start') === 121,
    'BoxLite native start uses the configured timeout',
  );
  assert(
    curlTimeout(log, '/v1/default/boxes/probe-box/exec') === 61,
    'BoxLite native exec uses the configured timeout',
  );
  assert(
    curlTimeout(log, '-X DELETE', '/v1/default/boxes/probe-box') === 31,
    'BoxLite native delete uses the configured timeout',
  );
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    BOXLITE_RUNTIME_PROBE_START_TIMEOUT_SECONDS: '0',
  });
  assert(result.status !== 0, 'BoxLite runtime probe rejects a non-positive operation timeout');
  assert(
    /BOXLITE_RUNTIME_PROBE_START_TIMEOUT_SECONDS must be a positive integer/.test(result.stderr),
    'BoxLite runtime probe reports the invalid timeout variable',
  );
}

{
  const tc = makeCase();
  const kvmDevice = join(tc.dir, 'dev-kvm');
  writeFileSync(kvmDevice, '', { mode: 0o600 });
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_TEST_DEV_KVM_PATH: kvmDevice,
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
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
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
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
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
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
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
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
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
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
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
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
  writeFileSync(
    join(tc.workdir, '.env'),
    `CAP_TASK_ADMISSION_V2_ENABLED=true\nCAP_TASK_ADMISSION_V2_ATTESTATION_JSON=${TEST_ADMISSION_ATTESTATION}\n`,
    'utf8',
  );
  const result = runQuickDeploy(tc, {
    CAP_TASK_ADMISSION_V2_ENABLED: 'false',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
  });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'gate-disabled synthesis succeeds over a previously enabled run package');
  assert(/^CAP_TASK_ADMISSION_V2_ENABLED=false$/m.test(envFile), 'gate-disabled synthesis persists the closed state');
  assert(!/^CAP_TASK_ADMISSION_V2_ATTESTATION_JSON=/m.test(envFile), 'gate-disabled synthesis removes stale deployment attestation evidence');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
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
    HOSTNAME: 'random-container-hostname',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'env',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_API_TOKEN: 'box-secret-token',
  });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'BoxLite env gate defaults the official runtime image when unset');
  assert(
    /BOXLITE_IMAGE=ghcr\.io\/xeonice\/cap-boxlite-sandbox:vtest/.test(envFile),
    'quick-deploy pins default BoxLite image to CAP_VERSION',
  );
  assert(
    /BOXLITE_WORKSPACE_PATH=\/home\/gem\/workspace/.test(envFile),
    'quick-deploy defaults BoxLite workspace to the AIO launch path',
  );
  assert(/BOXLITE_DISK_SIZE_GB=5/.test(envFile), 'quick-deploy persists the BoxLite 5 GiB safe fallback');
  assert(/BOXLITE_GIT_CLONE_TIMEOUT_MS=900000/.test(envFile), 'quick-deploy persists the independent 15-minute Git deadline');
  assert(/CAP_TASK_ADMISSION_V2_ENABLED=false/.test(envFile), 'quick-deploy persists admission-v2 default closed');
  assert(/^CAP_INSTANCE_ID=cap-api-1$/m.test(envFile), 'single-instance quick-deploy persists a stable admission identity');
  assert(!envFile.includes('random-container-hostname'), 'quick-deploy never persists the transient container hostname as its identity');
}

{
  const tc = makeCase();
  writeFileSync(
    join(tc.workdir, '.env'),
    'CAP_CUTOVER_BEARER_TOKEN=stale-cutover-secret\nBOXLITE_HOST_STORAGE_PATH=/stale/host/path\nBOXLITE_HOST_AVAILABLE_GB=99\n',
    'utf8',
  );
  const result = runQuickDeploy(tc, { CAP_QUICK_DEPLOY_STOP_AFTER: 'env' });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  assert(result.status === 0, 'ordinary synthesis scrubs stale process-only rollout values');
  for (const key of ['CAP_CUTOVER_BEARER_TOKEN', 'BOXLITE_HOST_STORAGE_PATH', 'BOXLITE_HOST_AVAILABLE_GB']) {
    assert(!new RegExp(`^${key}=`, 'm').test(envFile), `${key} is never retained in the api env file`);
  }
}

{
  const tc = makeCase();
  const cutoverToken = 'cap_sk_process_only_cutover_test';
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_FAKE_CAPABILITY_OPEN: '1',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_CUTOVER_BEARER_TOKEN: cutoverToken,
    TMPDIR: tc.dir,
    CAP_SANDBOX_PROVIDER: 'aio',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
  });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  const log = readLog(tc);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'gate-on completes only when the restarted api reports capability gate.open=true');
  assert(/running api reports gate\.open=true/.test(combined), 'gate-on reports the exact runtime capability proof');
  assert(!envFile.includes(cutoverToken), 'process-only cutover bearer is never persisted to .env');
  assert(!log.includes(cutoverToken) && !combined.includes(cutoverToken), 'process-only cutover bearer is absent from command/output logs');
  assert(!/PROCESS_ONLY_VALUE_LEAKED_TO_(DOCKER|CURL)/.test(log), 'process-only cutover bearer is removed before child processes run');
  assert(/-H @- .*deployment-capabilities\/task-admission-v2/.test(log), 'cutover verification streams its authorization header over stdin');
  assert(!readdirSync(tc.dir).some((name) => name.startsWith('cap-admission-v2-')), 'cutover verification leaves no auth or capability temp file behind');
}

for (const [label, capabilityEnv] of [
  ['closed', { CAP_FAKE_CAPABILITY_OPEN: '0' }],
  ['unauthorized', { CAP_FAKE_CAPABILITY_OPEN: '0', CAP_FAKE_CAPABILITY_STATUS: '401' }],
]) {
  const tc = makeCase();
  writeFileSync(
    join(tc.workdir, '.env'),
    'CAP_INSTANCE_ID=cap-api-1\nCAP_INSTANCE_ID=duplicate-runtime-id\nCAP_TASK_ADMISSION_V2_ENABLED=true\nCAP_TASK_ADMISSION_V2_ENABLED=true\n',
    'utf8',
  );
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_CUTOVER_BEARER_TOKEN: 'cap_sk_process_only_cutover_test',
    HOSTNAME: 'random-container-after-recreate',
    CAP_SANDBOX_PROVIDER: 'aio',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    ...capabilityEnv,
  });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  const log = readLog(tc);
  assert(result.status !== 0, `runtime capability ${label} fails the deploy`);
  assert(/CAP_TASK_ADMISSION_V2_ENABLED=false/.test(envFile), `runtime capability ${label} rolls the gate back to false`);
  assert(!/CAP_TASK_ADMISSION_V2_ATTESTATION_JSON=/.test(envFile), `runtime capability ${label} removes the rejected attestation`);
  assert(/up -d --force-recreate api/.test(log), `runtime capability ${label} force-recreates api after closing the gate`);
  assert(/^CAP_INSTANCE_ID=cap-api-1$/m.test(envFile), `runtime capability ${label} keeps the same instance identity through rollback force-recreate`);
  assert((envFile.match(/^CAP_INSTANCE_ID=/gm) ?? []).length === 1, `runtime capability ${label} collapses duplicate instance identity keys`);
  assert((envFile.match(/^CAP_TASK_ADMISSION_V2_ENABLED=/gm) ?? []).length === 1, `runtime capability ${label} leaves one fail-closed gate key`);
  assert(!envFile.includes('random-container-after-recreate'), `runtime capability ${label} never falls back to the recreated container hostname`);
}

for (const [label, failureEnv] of [
  ['pull', { CAP_FAKE_COMPOSE_PULL_FAIL: '1' }],
  ['up', { CAP_FAKE_COMPOSE_UP_FAIL: '1' }],
]) {
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_CUTOVER_BEARER_TOKEN: 'cap_sk_process_only_cutover_test',
    CAP_SANDBOX_PROVIDER: 'aio',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    ...failureEnv,
  });
  const envFile = readFileSync(join(tc.workdir, '.env'), 'utf8');
  const log = readLog(tc);
  assert(result.status !== 0, `Gate6 ${label} failure aborts admission-v2 cutover`);
  assert(/^CAP_TASK_ADMISSION_V2_ENABLED=false$/m.test(envFile), `Gate6 ${label} failure closes the persisted gate`);
  assert(!/^CAP_TASK_ADMISSION_V2_ATTESTATION_JSON=/m.test(envFile), `Gate6 ${label} failure removes the rejected attestation`);
  assert(/up -d --force-recreate api/.test(log), `Gate6 ${label} failure force-recreates api with the gate closed`);
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_FAKE_CAPABILITY_OPEN: '0',
    CAP_FAKE_ROLLBACK_RECREATE_FAIL: '1',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_CUTOVER_BEARER_TOKEN: 'cap_sk_process_only_cutover_test',
    CAP_SANDBOX_PROVIDER: 'aio',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
  });
  const log = readLog(tc);
  assert(result.status !== 0, 'failed rollback force-recreate aborts the cutover');
  assert(/stop api/.test(log), 'failed rollback force-recreate stops api fail-closed');
  assert(/api was stopped fail-closed/.test(result.stderr), 'failed rollback reports the verified stopped runtime state');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_COMPOSE_RUNNING_SERVICES: 'api',
    CAP_FAKE_HEALTH_FAIL: '1',
    CAP_HEALTH_TIMEOUT_SECONDS: '1',
    CAP_ADMISSION_ROLLBACK_HEALTH_TIMEOUT_SECONDS: '1',
    CAP_TASK_ADMISSION_V2_ENABLED: 'true',
    CAP_TASK_ADMISSION_V2_ATTESTATION_JSON: TEST_ADMISSION_ATTESTATION,
    CAP_CUTOVER_BEARER_TOKEN: 'cap_sk_process_only_cutover_test',
    CAP_SANDBOX_PROVIDER: 'aio',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
  });
  const log = readLog(tc);
  assert(result.status !== 0, 'unhealthy gate-on api aborts after bounded probes');
  assert(/--connect-timeout 2 --max-time 3 .*\/health/.test(log), 'health probes use per-request connect and total timeouts');
  assert(/stop api/.test(log), 'unverified rollback health stops api fail-closed');
}

{
  const tc = makeCase();
  const result = runQuickDeploy(tc, {
    CAP_FAKE_BOXLITE_READY: '1',
    CAP_SANDBOX_PROVIDER: 'boxlite',
    CAP_SANDBOX_IMAGE_DELIVERY: 'registry',
    CAP_QUICK_DEPLOY_STOP_AFTER: 'provider-readiness',
    BOXLITE_ENDPOINT: 'https://boxlite.example.test',
    BOXLITE_READINESS_PATH: '/health',
    BOXLITE_API_TOKEN: 'box-secret-token',
    BOXLITE_IMAGE: 'cap-boxlite:test',
    BOXLITE_PROTOCOL_MODE: 'cap-rest',
    BOXLITE_RUNTIME_PROBE_CREATE_TIMEOUT_SECONDS: '602',
    BOXLITE_RUNTIME_PROBE_EXEC_TIMEOUT_SECONDS: '62',
    BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS: '32',
  });
  const log = readLog(tc);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status === 0, 'BoxLite cap-rest runtime readiness succeeds before pull/up');
  assert(/\/v1\/sandboxes/.test(log), 'BoxLite cap-rest readiness creates a probe sandbox');
  assert(curlTimeout(log, '"taskId":"quick-deploy-preflight"', '/v1/sandboxes') === 602, 'BoxLite cap-rest create uses the configured timeout');
  assert(curlTimeout(log, '/v1/sandboxes/', '/exec') === 62, 'BoxLite cap-rest exec uses the configured timeout');
  assert(curlTimeout(log, '-X DELETE', '/v1/sandboxes/') === 32, 'BoxLite cap-rest delete uses the configured timeout');
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
