/**
 * Deploy-config compose assertions (multi-target-deploy track).
 *
 * Proves the docker-compose self-host deploy target wires the two operator
 * knobs through to the SAME env var names the orchestrator process reads:
 *
 *   - MAX_CONCURRENT_TASKS  — read by apps/api/src/guardrails/guardrails.module.ts
 *                             (process.env.MAX_CONCURRENT_TASKS -> semaphore cap).
 *   - TASK_REPO_URL         — read by the API provision lookup and passed into
 *                             the sandbox provider registry's selected provider.
 *
 * Satisfies multi-target-deploy:
 *   - "Concurrency and repo-URL env are passed through to the api" (4.1)
 *   - "Persistent volume for session.log survives restart" — the named volume
 *     backs the WORKSPACES_DIR path the orchestrator bridge writes session.log to (4.2)
 *
 * No YAML dependency: parse the `api` service env + volume block from text so the
 * test stays standalone (run with `node scripts/docker-compose.deploy-config.test.mjs`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const composePath = join(here, '..', 'docker-compose.yml');
const compose = readFileSync(composePath, 'utf8');
const prodComposePath = join(here, '..', 'docker-compose.prod.yml');
const prodCompose = readFileSync(prodComposePath, 'utf8');

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

/**
 * Extract the body of the top-level `api:` service (everything from `  api:`
 * up to the next top-level 2-space-indented service key, e.g. `  postgres:`).
 */
function apiServiceBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {2}api:\s*$/.test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

console.log('\n=== deploy-config: compose env + volume passthrough ===\n');

const api = apiServiceBlock(compose);
assert(api.length > 0, 'compose declares an `api` service');

// 4.1 — both env knobs are passed through to the api service environment,
//       keyed by the EXACT names the orchestrator reads.
const maxConcurrent = /^\s*MAX_CONCURRENT_TASKS:\s*.+$/m.test(api);
const taskRepoUrl = /^\s*TASK_REPO_URL:\s*.+$/m.test(api);
assert(maxConcurrent, '4.1: MAX_CONCURRENT_TASKS passed through to api environment');
assert(taskRepoUrl, '4.1: TASK_REPO_URL passed through to api environment');

// The env entries must sit under the api service's `environment:` map (not, e.g.,
// a stray comment), so the orchestrator process actually receives them.
const envIdx = api.indexOf('environment:');
assert(envIdx !== -1, '4.1: api service declares an `environment:` map');
assert(
  envIdx !== -1 && api.indexOf('MAX_CONCURRENT_TASKS:') > envIdx,
  '4.1: MAX_CONCURRENT_TASKS sits inside the environment map',
);
assert(
  envIdx !== -1 && api.indexOf('TASK_REPO_URL:') > envIdx,
  '4.1: TASK_REPO_URL sits inside the environment map',
);

// 4.2 — a named volume backs the workspaces path that holds session.log so it
//       survives an orchestrator restart. The orchestrator bridge writes
//       session.log under WORKSPACES_DIR, so the mount target MUST equal it.
const workspacesDir = (api.match(/^\s*WORKSPACES_DIR:\s*(\S+)\s*$/m) ?? [])[1];
assert(Boolean(workspacesDir), '4.2: api declares WORKSPACES_DIR (session.log lives here)');

// `<named-volume>:<WORKSPACES_DIR>` mount present in the api volumes block.
const mountRe = workspacesDir
  ? new RegExp(`^\\s*-\\s*([A-Za-z0-9_.-]+):${workspacesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm')
  : null;
const mountMatch = mountRe ? api.match(mountRe) : null;
assert(Boolean(mountMatch), '4.2: a named volume is mounted at WORKSPACES_DIR in the api service');

const volumeName = mountMatch ? mountMatch[1] : null;
// The mount source must be a top-level named volume (not a host bind path) so it
// is docker-managed and persists across `docker compose restart api`. Extract the
// top-level `volumes:` block (from the line `volumes:` to EOF / next top-level key).
function topLevelBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}
const topLevelVolumes = topLevelBlock(compose, 'volumes');
assert(
  Boolean(volumeName) && new RegExp(`^\\s{2}${volumeName}:`, 'm').test(topLevelVolumes),
  '4.2: the workspaces mount source is a declared top-level named volume (persistent)',
);
assert(
  Boolean(volumeName) && !volumeName.includes('/'),
  '4.2: workspaces mount source is a named volume, not a host bind path',
);

// ── add-repo-content-store: the repo-store named volume (7.1) ────────────────
// Repo content copies (bare mirrors, one per Repo) are written by the api at
// import time and injected into sandboxes at task start, so they MUST live on a
// docker-managed named volume mounted at the SAME path the api reads from
// (CAP_REPO_STORE_DIR) — otherwise the copies land on the container filesystem
// and every recreate silently drops every Repo back to `missing`.
for (const [label, text] of [
  ['dev', compose],
  ['prod', prodCompose],
]) {
  const service = apiServiceBlock(text);
  const storeDir = (service.match(/^\s*CAP_REPO_STORE_DIR:\s*(\S+)\s*$/m) ?? [])[1];
  assert(Boolean(storeDir), `7.1 (${label}): api declares CAP_REPO_STORE_DIR`);
  const storeMount = storeDir
    ? service.match(
        new RegExp(
          `^\\s*-\\s*([A-Za-z0-9_.-]+):${storeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          'm',
        ),
      )
    : null;
  assert(Boolean(storeMount), `7.1 (${label}): a named volume is mounted at CAP_REPO_STORE_DIR`);
  const storeVolume = storeMount ? storeMount[1] : null;
  assert(
    Boolean(storeVolume) && !storeVolume.includes('/'),
    `7.1 (${label}): the repo-store mount source is a named volume, not a host bind path`,
  );
  assert(
    Boolean(storeVolume) &&
      new RegExp(`^\\s{2}${storeVolume}:`, 'm').test(topLevelBlock(text, 'volumes')),
    `7.1 (${label}): the repo-store mount source is a declared top-level named volume`,
  );
  // The local-import allowlist root and the git-fallback rollback switch are
  // operator config that must flow through env_file. Redeclaring either as
  // `${VAR:-}` would clobber a file-only value — and an EMPTY
  // CAP_LOCAL_IMPORT_ROOT must stay indistinguishable from unset (= disabled).
  for (const key of ['CAP_LOCAL_IMPORT_ROOT', 'CAP_WORKSPACE_GIT_FALLBACK_ENABLED']) {
    assert(
      !new RegExp(`^\\s+${key}:`, 'm').test(service),
      `7.1 (${label}): compose does not clobber env-file ${key} in environment`,
    );
  }
}

// ── fix-large-repo-task-provisioning: source-free env-file passthrough ───────
// The production run package deliberately relies on env_file for these values.
// Redeclaring them in `environment:` as `${VAR:-}` would replace a Dokploy
// file-only value with the empty shell interpolation, so test both halves of the
// contract: both optional env files are loaded and no clobbering key is present.
const prodApi = apiServiceBlock(prodCompose);
assert(prodApi.length > 0, 'prod compose declares an `api` service');
assert(
  /env_file:\s*\n\s*- path: \.env\s*\n\s*required: false\s*\n\s*- path: \.\.\/files\/api\.env\s*\n\s*required: false/m.test(
    prodApi,
  ),
  'prod compose loads both local and Dokploy api env files as optional inputs',
);

const admissionPassthroughKeys = [
  'BOXLITE_DISK_SIZE_GB',
  'BOXLITE_GIT_CLONE_TIMEOUT_MS',
  'CAP_TASK_ADMISSION_V2_ENABLED',
  'CAP_TASK_ADMISSION_V2_ATTESTATION_JSON',
];
for (const key of admissionPassthroughKeys) {
  assert(prodApi.includes(key), `prod compose documents ${key} env-file passthrough`);
  assert(
    !new RegExp(`^\\s+${key}:`, 'm').test(prodApi),
    `prod compose does not clobber env-file ${key} in environment`,
  );
}

for (const [label, relativePath] of [
  ['root', '.env.example'],
  ['api', 'apps/api/.env.example'],
  ['prod', 'docker-compose.prod.env.example'],
]) {
  const example = readFileSync(join(here, '..', relativePath), 'utf8');
  assert(/^BOXLITE_DISK_SIZE_GB=5$/m.test(example), `${label} env example pins the 5 GiB BoxLite fallback`);
  assert(/^BOXLITE_GIT_CLONE_TIMEOUT_MS=900000$/m.test(example), `${label} env example pins the 15-minute Git deadline`);
  assert(/^CAP_TASK_ADMISSION_V2_ENABLED=false$/m.test(example), `${label} env example keeps admission-v2 closed by default`);
  assert(/^# CAP_TASK_ADMISSION_V2_ATTESTATION_JSON=$/m.test(example), `${label} env example documents the staged attestation input`);
  // add-repo-content-store (7.1): both operator knobs are DOCUMENTED and stay
  // COMMENTED OUT — local import is fail-closed on an unset allowlist root, and
  // the git fallback is a rollback switch that must not ship enabled.
  assert(
    /^# CAP_LOCAL_IMPORT_ROOT=/m.test(example),
    `${label} env example documents the local-import allowlist root, disabled by default`,
  );
  assert(
    /^# CAP_WORKSPACE_GIT_FALLBACK_ENABLED=false$/m.test(example),
    `${label} env example keeps the in-sandbox git-clone fallback closed by default`,
  );
}

// ── add-release-upgrade-scripts: force-both + release-image guards ────────────
// The manual upgrade path MUST stage BOTH images together (api + the aio-sandbox
// stager); a single-service upgrade is the v0.20.0 footgun. Guard the invariant so
// it can't silently regress. (Mirrors self-update's CAP_SERVICES/PULL_ONLY split.)
const upgradeSh = readFileSync(join(here, 'upgrade.sh'), 'utf8');
const upgradeServices = (upgradeSh.match(/^SERVICES=\(([^)]*)\)/m) || [, ''])[1];
assert(
  /\bapi\b/.test(upgradeServices) && /\baio-sandbox-image\b/.test(upgradeServices),
  'upgrade.sh: SERVICES forces BOTH api and aio-sandbox-image (no single-service door)',
);
assert(
  /pull "\$\{SERVICES\[@\]\}"/.test(upgradeSh) && /up -d "\$\{SERVICES\[@\]\}"/.test(upgradeSh),
  'upgrade.sh: pull AND up -d both operate on the full SERVICES set',
);

// The release tail MUST verify every release image, including both sandbox
// runtimes, so manual publishing cannot forget the per-task runtime images.
const releaseSh = readFileSync(join(here, 'release.sh'), 'utf8');
assert(
  /cap-api/.test(releaseSh) &&
    /cap-web/.test(releaseSh) &&
    /cap-aio-sandbox/.test(releaseSh) &&
    /cap-boxlite-sandbox/.test(releaseSh),
  'release.sh: verifies release images (cap-api, cap-web, cap-aio-sandbox, cap-boxlite-sandbox)',
);
assert(
  /cap-image-assets\.json/.test(releaseSh) &&
    /release-image-assets\.mjs list/.test(releaseSh) &&
    /manifest_assets/.test(releaseSh),
  'release.sh: verifies manifest-driven direct or split sandbox image Release assets',
);

// The api image's isolated Docker build must build the sandbox provider graph
// before Nest compiles @cap/api; otherwise TS resolves @cap/sandbox/provider
// package imports to missing dist/.
const apiDockerfile = readFileSync(join(here, '..', 'apps/api/Dockerfile'), 'utf8');
const sandboxCoreBuildIdx = apiDockerfile.indexOf('pnpm --filter @cap/sandbox-core build');
const aioProviderBuildIdx = apiDockerfile.indexOf('pnpm --filter @cap/sandbox-provider-aio build');
const boxLiteProviderBuildIdx = apiDockerfile.indexOf(
  'pnpm --filter @cap/sandbox-provider-boxlite build',
);
const sandboxBuildIdx = apiDockerfile.indexOf('pnpm --filter @cap/sandbox build');
const apiBuildIdx = apiDockerfile.indexOf('pnpm --filter @cap/api build');
assert(
  sandboxCoreBuildIdx !== -1 &&
    aioProviderBuildIdx !== -1 &&
    boxLiteProviderBuildIdx !== -1 &&
    sandboxBuildIdx !== -1 &&
    apiBuildIdx !== -1 &&
    sandboxCoreBuildIdx < aioProviderBuildIdx &&
    sandboxCoreBuildIdx < boxLiteProviderBuildIdx &&
    aioProviderBuildIdx < sandboxBuildIdx &&
    boxLiteProviderBuildIdx < sandboxBuildIdx &&
    sandboxBuildIdx < apiBuildIdx,
  'api Dockerfile: builds sandbox core/providers before @cap/sandbox, then @cap/api',
);

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
