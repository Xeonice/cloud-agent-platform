import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ApiImageSmokeError,
  CAP_API_IMAGE_PULL_TIMEOUT_MS,
  CAP_API_IMAGE_RUN_TIMEOUT_MS,
  CAP_API_RELEASE_PLATFORM,
  CONTAINER_PREFLIGHT_PROGRAM,
  GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE,
  smokeCapApiImage,
} from './cap-api-image-smoke.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const RELEASE_WORKFLOW = readFileSync(
  path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const IMAGE = 'ghcr.io/xeonice/cap-api:v1.2.3';
const SECRET_CANARY = 'cap-release-image-secret-canary-74ad19';

function workflowJob(name) {
  const marker = `  ${name}:\n`;
  const start = RELEASE_WORKFLOW.indexOf(marker);
  assert.ok(start >= 0, `release workflow defines ${name}`);
  const remainder = RELEASE_WORKFLOW.slice(start + marker.length);
  const next = remainder.search(/^  [a-z0-9][a-z0-9-]*:\s*$/mu);
  return next < 0
    ? RELEASE_WORKFLOW.slice(start)
    : RELEASE_WORKFLOW.slice(start, start + marker.length + next);
}

test('image smoke uses fixed no-shell argv for Git, shared preflight, and negative startup', () => {
  const calls = [];
  const responses = [
    { status: 0, stdout: 'git version 2.39.5\n', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
    {
      status: 1,
      stdout: '',
      stderr: `${GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE}\n`,
    },
  ];

  const result = smokeCapApiImage({
    image: IMAGE,
    negativeFixture: true,
    env: { PATH: '/test/bin' },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return responses[calls.length - 1];
    },
  });

  assert.deepEqual(result, {
    image: IMAGE,
    negativeFixtureVerified: true,
  });
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      [
        'docker',
        'run',
        '--rm',
        '--pull=never',
        '--platform',
        CAP_API_RELEASE_PLATFORM,
        '--entrypoint',
        'git',
        IMAGE,
        '--version',
      ],
      [
        'docker',
        'run',
        '--rm',
        '--pull=never',
        '--platform',
        CAP_API_RELEASE_PLATFORM,
        '--entrypoint',
        '/usr/local/bin/node',
        IMAGE,
        '-e',
        CONTAINER_PREFLIGHT_PROGRAM,
      ],
      [
        'docker',
        'run',
        '--rm',
        '--pull=never',
        '--platform',
        CAP_API_RELEASE_PLATFORM,
        '--tmpfs',
        '/usr/bin:rw,noexec,nosuid,size=64k',
        '--entrypoint',
        '/usr/local/bin/node',
        IMAGE,
        'dist/main.js',
      ],
    ],
  );
  assert.ok(calls.every(({ options }) => options.shell === false));
  assert.ok(calls.every(({ options }) => options.maxBuffer === 1024 * 1024));
  assert.ok(
    calls.every(
      ({ options }) =>
        options.timeout === CAP_API_IMAGE_RUN_TIMEOUT_MS &&
        options.killSignal === 'SIGKILL',
    ),
  );
  assert.ok(
    calls.every(
      ({ args }) =>
        !args.includes('--env') &&
        !args.some((arg) => arg.startsWith('--env=')) &&
        !args.includes('--publish') &&
        !args.includes('-p'),
    ),
    'the container receives no host credential or listening-port argument',
  );
});

test('published-image mode pulls one exact tag and then verifies only that local image', () => {
  const calls = [];
  const responses = [
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: 'git version 2.39.5\n', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ];
  smokeCapApiImage({
    image: IMAGE,
    pull: 'always',
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return responses[calls.length - 1];
    },
  });

  assert.deepEqual(calls[0].args, [
    'pull',
    '--platform',
    CAP_API_RELEASE_PLATFORM,
    IMAGE,
  ]);
  assert.equal(calls[0].options.timeout, CAP_API_IMAGE_PULL_TIMEOUT_MS);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
  assert.ok(calls.slice(1).every(({ args }) => args.includes('--pull=never')));
  assert.ok(calls.slice(1).every(({ args }) => args.includes(IMAGE)));
  assert.ok(
    calls
      .slice(1)
      .every(({ options }) => options.timeout === CAP_API_IMAGE_RUN_TIMEOUT_MS),
  );
});

test('a hard Docker timeout fails closed without retaining child diagnostics', () => {
  let observedOptions;
  assert.throws(
    () =>
      smokeCapApiImage({
        image: IMAGE,
        spawnSyncImpl(_command, _args, options) {
          observedOptions = options;
          return {
            status: null,
            stdout: '',
            stderr: `timed out with ${SECRET_CANARY}`,
            error: Object.assign(new Error(`timeout ${SECRET_CANARY}`), {
              code: 'ETIMEDOUT',
            }),
          };
        },
      }),
    (error) => {
      assert.ok(error instanceof ApiImageSmokeError);
      assert.equal(error.code, 'git_unavailable');
      assert.equal(JSON.stringify(error).includes(SECRET_CANARY), false);
      return true;
    },
  );
  assert.equal(observedOptions.timeout, CAP_API_IMAGE_RUN_TIMEOUT_MS);
  assert.equal(observedOptions.killSignal, 'SIGKILL');
});

test('Git and preflight failures expose actionable fixed errors without child diagnostics', () => {
  for (const fixture of [
    {
      responses: [
        { status: 127, stdout: '', stderr: `ENOENT ${SECRET_CANARY}` },
      ],
      code: 'git_unavailable',
      message: /required Git executable is unavailable/u,
    },
    {
      responses: [
        { status: 0, stdout: 'git version 2.39.5\n', stderr: '' },
        { status: 1, stdout: SECRET_CANARY, stderr: `raw ${SECRET_CANARY}` },
      ],
      code: 'startup_preflight_failed',
      message: /Git startup preflight failed/u,
    },
  ]) {
    let call = 0;
    assert.throws(
      () =>
        smokeCapApiImage({
          image: IMAGE,
          spawnSyncImpl() {
            const result = fixture.responses[call];
            call += 1;
            return result;
          },
        }),
      (error) => {
        assert.ok(error instanceof ApiImageSmokeError);
        assert.equal(error.code, fixture.code);
        assert.match(error.message, fixture.message);
        assert.equal(JSON.stringify(error).includes(SECRET_CANARY), false);
        return true;
      },
    );
  }
});

test('negative runtime fixture must fail with the fixed startup dependency reason', () => {
  const responses = [
    { status: 0, stdout: 'git version 2.39.5\n', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ];
  let call = 0;
  assert.throws(
    () =>
      smokeCapApiImage({
        image: IMAGE,
        negativeFixture: true,
        spawnSyncImpl() {
          const result = responses[call];
          call += 1;
          return result;
        },
      }),
    (error) => {
      assert.ok(error instanceof ApiImageSmokeError);
      assert.equal(error.code, 'negative_fixture_not_rejected');
      assert.equal(error.message.includes(SECRET_CANARY), false);
      return true;
    },
  );
});

test('release workflow smokes the exact loaded API tag before the first push', () => {
  const apiJob = workflowJob('build-smoke-push-api');
  const build = apiJob.indexOf('name: Build local cap-api image');
  const smoke = apiJob.indexOf('name: Smoke built cap-api image');
  const login = apiJob.indexOf('name: Log in to GHCR');
  const push = apiJob.indexOf('name: Push verified cap-api version image');

  assert.ok(build >= 0 && smoke > build && login > smoke && push > login);
  assert.match(apiJob, /^    timeout-minutes: 45$/mu);
  assert.match(apiJob, /uses: docker\/build-push-action@v6/u);
  assert.match(apiJob, /^\s+load: true$/mu);
  assert.doesNotMatch(apiJob, /^\s+push: true$/mu);
  assert.match(
    apiJob,
    /ghcr\.io\/xeonice\/cap-api:\$\{\{ needs\.resolve-release\.outputs\.version \}\}/u,
  );
  assert.match(
    apiJob,
    /node scripts\/cap-api-image-smoke\.mjs[\s\S]*--pull never[\s\S]*--negative-fixture/u,
  );
  assert.match(
    apiJob,
    /run: docker push "ghcr\.io\/xeonice\/cap-api:\$\{\{ needs\.resolve-release\.outputs\.version \}\}"/u,
  );
  assert.doesNotMatch(apiJob, /ghcr\.io\/xeonice\/cap-api:latest/u);
});

test('non-API release images stay version-matched and BoxLite stays multi-arch', () => {
  const imageJob = workflowJob('build-push');
  assert.match(imageJob, /^\s+needs: \[resolve-release, build-smoke-push-api\]$/mu);
  assert.match(imageJob, /^    timeout-minutes: 90$/mu);
  assert.doesNotMatch(imageJob, /^\s+- name: cap-api$/mu);
  for (const image of ['cap-web', 'cap-aio-sandbox', 'cap-boxlite-sandbox']) {
    assert.match(imageJob, new RegExp(`^\\s+- name: ${image}$`, 'mu'));
  }
  assert.match(
    imageJob,
    /name: cap-boxlite-sandbox[\s\S]*platforms: linux\/amd64,linux\/arm64/u,
  );
  assert.match(imageJob, /^\s+push: true$/mu);
  assert.match(
    imageJob,
    /ghcr\.io\/xeonice\/\$\{\{ matrix\.name \}\}:\$\{\{ needs\.resolve-release\.outputs\.version \}\}/u,
  );
  assert.doesNotMatch(
    imageJob,
    /ghcr\.io\/xeonice\/\$\{\{ matrix\.name \}\}:latest/u,
  );
});

test('latest promotion waits for all four version images and preserves registry manifests', () => {
  const promotion = workflowJob('promote-latest');
  assert.match(
    promotion,
    /^    needs: \[resolve-release, build-smoke-push-api, build-push\]$/mu,
  );
  assert.match(promotion, /^    timeout-minutes: 15$/mu);
  assert.match(promotion, /uses: docker\/setup-buildx-action@v3/u);
  assert.match(promotion, /uses: docker\/login-action@v3/u);

  const images = 'cap-api cap-web cap-aio-sandbox cap-boxlite-sandbox';
  assert.equal(promotion.match(new RegExp(`for image in ${images}`, 'gu'))?.length, 2);
  const inspect = promotion.indexOf('docker buildx imagetools inspect');
  const promote = promotion.indexOf('docker buildx imagetools create');
  assert.ok(inspect >= 0 && promote > inspect);
  assert.match(
    promotion,
    /docker buildx imagetools create[\s\S]*--tag "ghcr\.io\/xeonice\/\$\{image\}:latest"[\s\S]*"ghcr\.io\/xeonice\/\$\{image\}:\$\{RELEASE_VERSION\}"/u,
  );
  assert.doesNotMatch(promotion, /\bdocker (?:pull|tag|push)\b/u);
});

test('deployable Release assets wait for the complete-set latest promotion gate', () => {
  const runAssets = workflowJob('attach-run-assets');
  const sandboxAssets = workflowJob('attach-sandbox-image-assets');
  assert.match(
    runAssets,
    /^    needs: \[verify-run-package, promote-latest\]$/mu,
  );
  assert.match(runAssets, /^    timeout-minutes: 10$/mu);
  assert.match(sandboxAssets, /^    needs: promote-latest$/mu);
  assert.match(sandboxAssets, /^    timeout-minutes: 60$/mu);
});

test('every release job has an explicit hard workflow timeout', () => {
  const expectedMinutes = new Map([
    ['verify-run-package', 10],
    ['resolve-release', 5],
    ['build-smoke-push-api', 45],
    ['build-push', 90],
    ['promote-latest', 15],
    ['attach-run-assets', 10],
    ['attach-sandbox-image-assets', 60],
  ]);
  for (const [job, minutes] of expectedMinutes) {
    assert.match(
      workflowJob(job),
      new RegExp(`^    timeout-minutes: ${minutes}$`, 'mu'),
      job,
    );
  }
});
