import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const installScript = resolve(repoRoot, 'apps/www/public/install.sh');
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
  const dir = mkdtempSync(join(tmpdir(), 'cap-install-preflight-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'commands.log');
  spawnSync('mkdir', ['-p', bin]);
  return { dir, bin, log };
}

function runInstall(testCase, env = {}) {
  return spawnSync('sh', [installScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${testCase.bin}:/usr/bin:/bin`,
      CAP_INSTALL_PREFLIGHT_LIB_PATH: preflightLib,
      CAP_INSTALL_PREFLIGHT_ONLY: '1',
      CAP_TEST_ASSUME_ROOT: '1',
      CAP_TEST_LOG: testCase.log,
      CAP_FAKE_BIN: testCase.bin,
      CAP_FAKE_BREW_PREFIX: join(testCase.dir, 'homebrew'),
      CAP_TEST_IGNORE_SYSTEM_BREW: '1',
      HOME: testCase.dir,
      ...env,
    },
    encoding: 'utf8',
  });
}

function runPreflightSnippet(testCase, script, env = {}) {
  return spawnSync('sh', ['-c', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${testCase.bin}:/usr/bin:/bin`,
      CAP_INSTALL_PREFLIGHT_LIB_PATH: preflightLib,
      CAP_TEST_ASSUME_ROOT: '1',
      CAP_TEST_LOG: testCase.log,
      CAP_FAKE_BIN: testCase.bin,
      CAP_FAKE_BREW_PREFIX: join(testCase.dir, 'homebrew'),
      CAP_TEST_IGNORE_SYSTEM_BREW: '1',
      HOME: testCase.dir,
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

console.log('\n=== install-preflight ===\n');

{
  const tc = makeCase();
  makeBin(tc.bin, 'docker', `
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
`);
  makeBin(tc.bin, 'apt-get', 'echo "apt-get $*" >> "$CAP_TEST_LOG"; exit 9\n');
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Linux' });
  const log = readLog(tc);
  assert(result.status === 0, 'usable Docker preflight succeeds');
  assert(!log.includes('apt-get'), 'usable Docker does not install packages');
  assert(/docker compose version/.test(log) && /docker info/.test(log), 'usable Docker checks compose and info');
  assert(/macOS missing-Docker or missing-Compose: Homebrew installer/.test(result.stdout), 'dependency report names macOS Homebrew installer dependency');
  assert(/Xcode Command Line Tools via Apple Software Update/.test(result.stdout), 'dependency report names macOS CLT dependency');
  assert(/kern\.hv_support=1/.test(result.stdout), 'dependency report names BoxLite macOS Hypervisor dependency');
  assert(/read\/write \/dev\/kvm/.test(result.stdout), 'dependency report names BoxLite Linux KVM dependency');
}

{
  const tc = makeCase();
  const homebrewBin = join(tc.dir, 'hidden-homebrew/bin');
  spawnSync('mkdir', ['-p', homebrewBin]);
  makeBin(homebrewBin, 'docker', `
echo "homebrew-docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
`);
  makeBin(homebrewBin, 'brew', 'echo "brew $*" >> "$CAP_TEST_LOG"; exit 9\n');
  makeBin(tc.bin, 'colima', 'echo "colima $*" >> "$CAP_TEST_LOG"; exit 9\n');
  const result = runInstall(tc, {
    CAP_TEST_UNAME: 'Darwin',
    CAP_TEST_IGNORE_SYSTEM_BREW: '0',
    CAP_TEST_HOMEBREW_BIN_DIRS: homebrewBin,
  });
  const log = readLog(tc);
  assert(result.status === 0, 'macOS Docker installed in Homebrew bin but missing from PATH is detected');
  assert(/homebrew-docker compose version/.test(log) && /homebrew-docker info/.test(log), 'macOS Homebrew Docker path is used for preflight checks');
  assert(!/brew install/.test(log), 'macOS Homebrew Docker path detection does not reinstall Docker');
  assert(!/colima start/.test(log), 'macOS usable Docker from Homebrew path does not restart Colima');
  assert(/Docker CLI, Compose, and engine are usable; leaving Docker untouched/.test(result.stdout), 'macOS Homebrew Docker path reports Docker untouched');
}

{
  const tc = makeCase();
  const homebrewBin = join(tc.dir, 'hidden-homebrew/bin');
  spawnSync('mkdir', ['-p', homebrewBin]);
  makeBin(homebrewBin, 'docker', `
echo "homebrew-docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
`);
  const result = runPreflightSnippet(tc, `
. "$CAP_INSTALL_PREFLIGHT_LIB_PATH"
cap_ensure_docker
command -v docker
docker compose version
`, {
    CAP_TEST_UNAME: 'Darwin',
    CAP_TEST_IGNORE_SYSTEM_BREW: '0',
    CAP_TEST_HOMEBREW_BIN_DIRS: homebrewBin,
  });
  const log = readLog(tc);
  assert(result.status === 0, 'cap_ensure_docker preserves adopted Homebrew Docker PATH for callers');
  assert(result.stdout.includes(`${homebrewBin}/docker`), 'adopted Homebrew Docker path remains visible after cap_ensure_docker');
  assert(/homebrew-docker compose version/.test(log), 'caller can run docker compose after Homebrew Docker path adoption');
}

{
  const tc = makeCase();
  makeBin(tc.bin, 'docker', `
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
`);
  makeBin(tc.bin, 'curl', `
echo "curl $*" >> "$CAP_TEST_LOG"
cat <<'QUICK_DEPLOY'
#!/usr/bin/env bash
printf 'quick deploy preflight url: %s\\n' "$CAP_PREFLIGHT_LIB_URL"
QUICK_DEPLOY
exit 0
`);
  const result = runInstall(tc, {
    CAP_INSTALL_PREFLIGHT_ONLY: '0',
    CAP_INSTALL_BASE: 'http://127.0.0.1:18088',
    CAP_TEST_UNAME: 'Darwin',
  });
  const log = readLog(tc);
  assert(result.status === 0, 'CAP_INSTALL_BASE release delegation succeeds');
  assert(/curl -fsSL http:\/\/127\.0\.0\.1:18088\/quick-deploy\.sh/.test(log), 'CAP_INSTALL_BASE fetches quick-deploy from explicit base');
  assert(/quick deploy preflight url: http:\/\/127\.0\.0\.1:18088\/install-preflight\.sh/.test(result.stdout), 'CAP_INSTALL_BASE forwards matching preflight URL');
}

{
  const tc = makeCase();
  makeBin(tc.bin, 'apt-get', `
echo "apt-get $*" >> "$CAP_TEST_LOG"
case "$*" in
  *install*)
    cat > "$CAP_FAKE_BIN/docker" <<'DOCKER'
#!/bin/sh
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
DOCKER
    chmod +x "$CAP_FAKE_BIN/docker"
    ;;
esac
exit 0
`);
  makeBin(tc.bin, 'systemctl', 'echo "systemctl $*" >> "$CAP_TEST_LOG"; exit 0\n');
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Linux' });
  const log = readLog(tc);
  assert(result.status === 0, 'absent Docker on Linux installs and then succeeds');
  assert(/apt-get update/.test(log), 'Linux install runs package-manager update');
  assert(/apt-get install -y docker\.io docker-compose-plugin/.test(log), 'Linux install requests Docker plus Compose plugin');
  assert(/docker info/.test(log), 'Linux install verifies docker info after installation');
}

{
  const tc = makeCase();
  makeBin(tc.bin, 'docker', `
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") [ -f "$CAP_FAKE_BIN/compose-installed" ]; exit $? ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
`);
  makeBin(tc.bin, 'apt-get', `
echo "apt-get $*" >> "$CAP_TEST_LOG"
case "$*" in
  *docker-compose*) touch "$CAP_FAKE_BIN/compose-installed" ;;
  *docker.io*) exit 9 ;;
esac
exit 0
`);
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Linux' });
  const log = readLog(tc);
  assert(result.status === 0, 'Linux installed Docker with missing Compose installs only Compose');
  assert(/apt-get install -y docker-compose-plugin/.test(log), 'Linux missing Compose requests Compose plugin');
  assert(!/apt-get install -y docker\.io/.test(log), 'Linux missing Compose does not reinstall Docker Engine');
}

{
  const tc = makeCase();
  makeBin(tc.bin, 'brew', `
echo "brew $*" >> "$CAP_TEST_LOG"
if [ "$1" = "--prefix" ]; then
  printf '%s\\n' "$CAP_FAKE_BREW_PREFIX"
  exit 0
fi
if [ "$1" = "list" ]; then
  exit 1
fi
case "$*" in
  *install*)
    mkdir -p "$CAP_FAKE_BREW_PREFIX/lib/docker/cli-plugins"
    cat > "$CAP_FAKE_BREW_PREFIX/lib/docker/cli-plugins/docker-compose" <<'COMPOSE'
#!/bin/sh
exit 0
COMPOSE
    chmod +x "$CAP_FAKE_BREW_PREFIX/lib/docker/cli-plugins/docker-compose"
    cat > "$CAP_FAKE_BIN/docker" <<'DOCKER'
#!/bin/sh
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") [ -x "$HOME/.docker/cli-plugins/docker-compose" ]; exit $? ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
DOCKER
    chmod +x "$CAP_FAKE_BIN/docker"
    ;;
esac
exit 0
`);
  makeBin(tc.bin, 'colima', 'echo "colima $*" >> "$CAP_TEST_LOG"; exit 0\n');
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Darwin' });
  const log = readLog(tc);
  assert(result.status === 0, 'absent Docker on macOS with Homebrew installs and then succeeds');
  assert(/brew install docker docker-compose colima/.test(log), 'macOS install requests docker docker-compose colima');
  assert(/colima start/.test(log), 'macOS install starts Colima');
  assert(/configured Docker Compose plugin/.test(result.stdout), 'macOS install links Homebrew Compose plugin for Docker CLI discovery');
}

{
  const tc = makeCase();
  spawnSync('mkdir', ['-p', join(tc.dir, 'homebrew/lib/docker/cli-plugins')]);
  writeFileSync(join(tc.dir, 'homebrew/lib/docker/cli-plugins/docker-compose'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  makeBin(tc.bin, 'brew', `
echo "brew $*" >> "$CAP_TEST_LOG"
if [ "$1" = "--prefix" ]; then
  printf '%s\\n' "$CAP_FAKE_BREW_PREFIX"
  exit 0
fi
exit 0
`);
  makeBin(tc.bin, 'docker', `
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") [ -x "$HOME/.docker/cli-plugins/docker-compose" ]; exit $? ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
`);
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Darwin' });
  const log = readLog(tc);
  assert(result.status === 0, 'macOS installed Docker with hidden Homebrew Compose plugin is repaired');
  assert(!/brew install/.test(log), 'macOS hidden Compose repair does not reinstall Docker');
  assert(/configured Docker Compose plugin/.test(result.stdout), 'macOS hidden Compose repair links plugin');
}

{
  const tc = makeCase();
  makeBin(tc.bin, 'curl', `
echo "curl $*" >> "$CAP_TEST_LOG"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || out="$CAP_FAKE_BIN/homebrew-install.sh"
cat > "$out" <<'BREW'
cat > "$CAP_FAKE_BIN/brew" <<'BREW_BIN'
#!/bin/sh
echo "brew $*" >> "$CAP_TEST_LOG"
if [ "$1" = "list" ]; then
  exit 1
fi
case "$*" in
  *install*)
    cat > "$CAP_FAKE_BIN/docker" <<'DOCKER'
#!/bin/sh
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "info") exit 0 ;;
esac
exit 0
DOCKER
    chmod +x "$CAP_FAKE_BIN/docker"
    ;;
esac
exit 0
BREW_BIN
chmod +x "$CAP_FAKE_BIN/brew"
BREW
exit 0
`);
  makeBin(tc.bin, 'colima', 'echo "colima $*" >> "$CAP_TEST_LOG"; exit 0\n');
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Darwin' });
  const log = readLog(tc);
  assert(result.status === 0, 'absent Docker on macOS without Homebrew bootstraps Homebrew and then succeeds');
  assert(/raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh/.test(log), 'macOS bootstrap fetches the Homebrew installer');
  assert(/brew install docker docker-compose colima/.test(log), 'macOS bootstrap then installs Docker packages with Homebrew');
  assert(/colima start/.test(log), 'macOS bootstrap starts Colima after Docker install');
}

{
  const tc = makeCase();
  makeBin(tc.bin, 'curl', `
echo "curl $*" >> "$CAP_TEST_LOG"
exit 7
`);
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Darwin' });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, 'macOS Homebrew installer fetch failure fails preflight');
  assert(/could not fetch Homebrew installer/.test(combined), 'macOS Homebrew fetch failure names the failed dependency');
  assert(/raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh/.test(combined), 'macOS Homebrew fetch failure prints the installer URL');
  assert(!/Homebrew installation finished/.test(combined), 'macOS Homebrew fetch failure does not misreport a completed install');
}

{
  const tc = makeCase();
  makeBin(tc.bin, 'curl', `
echo "curl $*" >> "$CAP_TEST_LOG"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || out="$CAP_FAKE_BIN/homebrew-install.sh"
cat > "$out" <<'BREW'
exit 42
BREW
exit 0
`);
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Darwin' });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, 'macOS Homebrew installer execution failure fails preflight');
  assert(/Homebrew installer failed with exit 42/.test(combined), 'macOS Homebrew installer execution failure includes exit code');
  assert(/Xcode Command Line Tools/.test(combined), 'macOS Homebrew installer execution failure points to CLT dependency');
  assert(/softwareupdate\/proxy egress/.test(combined), 'macOS Homebrew installer execution failure points to softwareupdate/proxy remediation');
}

{
  const tc = makeCase();
  makeBin(tc.bin, 'docker', `
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "info ") exit 1 ;;
  "info") exit 1 ;;
esac
exit 0
`);
  makeBin(tc.bin, 'systemctl', 'echo "systemctl $*" >> "$CAP_TEST_LOG"; exit 0\n');
  makeBin(tc.bin, 'apt-get', 'echo "apt-get $*" >> "$CAP_TEST_LOG"; exit 0\n');
  const result = runInstall(tc, { CAP_TEST_UNAME: 'Linux' });
  const log = readLog(tc);
  assert(result.status !== 0, 'installed but unreachable Docker fails preflight');
  assert(/systemctl start docker/.test(log), 'unreachable Docker gets a bounded safe start attempt');
  assert(!/apt-get/.test(log), 'unreachable Docker is not reinstalled');
  assert(/docker.sock is not reachable/.test(result.stderr), 'unreachable Docker failure names socket/context remediation');
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
console.error('SOME TESTS FAILED');
process.exit(1);
