import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(scriptDir, "..");
const repoRoot = path.join(appRoot, "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "cap-www-assets-"));

mkdirSync(outDir, { recursive: true });
copyFileSync(
  path.join(appRoot, "public", "install.sh"),
  path.join(outDir, "install.sh"),
);

const result = spawnSync("node", [path.join(scriptDir, "inject-install-sh.mjs")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAP_WWW_OUT_DIR: outDir,
    NEXT_PUBLIC_SITE_URL: "https://assets.example.test/",
  },
  encoding: "utf8",
});

assert.equal(
  result.status,
  0,
  `inject-install-sh failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);

const installSh = readFileSync(path.join(outDir, "install.sh"), "utf8");
const quickDeploySh = readFileSync(path.join(outDir, "quick-deploy.sh"), "utf8");
const preflightSh = readFileSync(path.join(outDir, "install-preflight.sh"), "utf8");
const compose = readFileSync(path.join(outDir, "docker-compose.prod.yml"), "utf8");

assert.match(installSh, /https:\/\/assets\.example\.test\/install\.sh/);
assert.doesNotMatch(installSh, /__CAP_SITE_DOMAIN__/);
assert.match(installSh, /CAP_INSTALL_BASE/);
assert.match(installSh, /quick-deploy\.sh/);
assert.match(installSh, /install-preflight\.sh/);

assert.match(
  quickDeploySh,
  /RAW_BASE="\$\{CAP_RAW_BASE:-https:\/\/assets\.example\.test\}"/,
);
assert.doesNotMatch(quickDeploySh, /__CAP_COMPOSE_BASE__/);
assert.match(quickDeploySh, /install-preflight\.sh/);
assert.match(quickDeploySh, /COMPOSE_MANAGED_MARKER="cap-managed-run-package: docker-compose\.prod\.yml"/);

assert.match(preflightSh, /cap_ensure_docker\(\)/);
assert.match(preflightSh, /cap_docker_state\(\)/);

assert.match(compose, /^# cap-managed-run-package: docker-compose\.prod\.yml/m);
assert.doesNotMatch(compose, /^\s*build:/m);
assert.doesNotMatch(compose, /^\s*-\s*\.:/m);

assert.ok(existsSync(path.join(outDir, "index.html")), "root redirect page is written");

console.log("install asset injection test passed");
