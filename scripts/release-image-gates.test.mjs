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

/**
 * A job with its `#` comment lines removed.
 *
 * Needed because prose satisfied a gate here. `'the release publishes the console'`
 * asserted `/VITE_BUILD_ID/` against the raw job text and passed for the job's whole
 * life while the variable was NEVER set — the only occurrences were in a comment
 * explaining why it mattered. The workflow that exists to stop the console baking a
 * sentinel was baking one, and the assertion about it was green.
 *
 * Only whole-line comments are stripped. A `#` inside a shell string or a `${{ }}`
 * expression is code, and this must not eat it.
 */
function jobCode(name) {
  return workflowJob(name)
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
}

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

// The verify and the promote used to be two steps of one job. They are two jobs
// now, so that the console can be published BETWEEN them: a console that fails to
// publish then leaves `latest` on the previous release, where the images and the
// console still match, instead of on a release whose console never shipped.
//
// The property these cases protect is unchanged — every version image is proven
// to exist before any `latest` moves, and the promotion only ever creates
// manifests — so it is still asserted, now across the split rather than inside
// one job. The earlier single-job assertion was pinning the implementation; this
// pins the property.
const IMAGE_SET = 'cap-api cap-web cap-aio-sandbox cap-boxlite-sandbox';

test('every version image is proven to exist before any latest moves', () => {
  const verify = workflowJob('verify-image-set');
  assert.match(
    verify,
    /^    needs: \[resolve-release, build-smoke-push-api, build-push\]$/mu,
  );
  assert.match(verify, /^    timeout-minutes: 15$/mu);
  assert.match(verify, /uses: docker\/setup-buildx-action@v3/u);
  assert.match(verify, /uses: docker\/login-action@v3/u);
  assert.equal(verify.match(new RegExp(`for image in ${IMAGE_SET}`, 'gu'))?.length, 1);
  assert.match(verify, /docker buildx imagetools inspect/u);
  // The verify job must not promote — that is the whole point of the split.
  assert.doesNotMatch(verify, /docker buildx imagetools create/u);
});

test('latest promotion waits for the verified set AND the published console', () => {
  const promotion = workflowJob('promote-latest');
  assert.match(
    promotion,
    /^    needs: \[resolve-release, verify-image-set, deploy-console\]$/mu,
  );
  assert.match(promotion, /^    timeout-minutes: 15$/mu);
  assert.match(promotion, /uses: docker\/setup-buildx-action@v3/u);
  assert.match(promotion, /uses: docker\/login-action@v3/u);

  // A SKIPPED console (workflow_dispatch, where the console job does not run) must
  // still let `latest` move; a FAILED one must not. Without this condition the
  // coupling would have silently stopped dispatch runs from ever promoting,
  // because a skipped dependency skips its dependents.
  assert.match(promotion, /needs\.deploy-console\.result == 'success'/u);
  assert.match(promotion, /needs\.deploy-console\.result == 'skipped'/u);
  assert.doesNotMatch(promotion, /needs\.deploy-console\.result == 'failure'/u);

  assert.equal(promotion.match(new RegExp(`for image in ${IMAGE_SET}`, 'gu'))?.length, 1);
  assert.match(
    promotion,
    /docker buildx imagetools create[\s\S]*--tag "ghcr\.io\/xeonice\/\$\{image\}:latest"[\s\S]*"ghcr\.io\/xeonice\/\$\{image\}:\$\{RELEASE_VERSION\}"/u,
  );
  assert.doesNotMatch(promotion, /\bdocker (?:pull|tag|push)\b/u);
});

test('the cap-web IMAGE is built with the release version too', () => {
  // Both deployment paths must carry the version, and only one of them had a test.
  // If this build-arg line is ever dropped, the published cap-web image ships the
  // sentinel silently — which is exactly how the Vercel path went unplumbed for
  // its whole life while the image path looked fine.
  const build = workflowJob('build-push');
  assert.match(
    build,
    /VITE_BUILD_ID=\$\{\{ needs\.resolve-release\.outputs\.version \}\}/u,
  );
});

test('the sentinel default is the one the contract refuses on', () => {
  // Three files spell the fallback and the api refuses on it; a drift between any
  // of them turns a refusal into a pass. Checked as text because the Dockerfile
  // and the vite define cannot import from the contracts package — the reason a
  // constant for it was written and deleted rather than shipped.
  const dockerfile = readFileSync(
    path.join(REPO_ROOT, 'apps/web/Dockerfile'),
    'utf8',
  );
  const viteConfig = readFileSync(
    path.join(REPO_ROOT, 'apps/web/vite.config.ts'),
    'utf8',
  );
  const config = readFileSync(
    path.join(REPO_ROOT, 'apps/web/src/lib/config.ts'),
    'utf8',
  );
  const contracts = readFileSync(
    path.join(REPO_ROOT, 'packages/contracts/src/version.ts'),
    'utf8',
  );
  assert.match(dockerfile, /^ARG VITE_BUILD_ID=dev$/mu);
  assert.match(viteConfig, /process\.env\.VITE_BUILD_ID \?\? "dev"/u);
  assert.match(config, /readEnv\("VITE_BUILD_ID"\) \?\? "dev"/u);
  assert.match(contracts, /CONSOLE_BUILD_ID_SENTINEL = 'dev'/u);
});

test('the console deploy links its target explicitly and asserts it', () => {
  // Two failures a rehearsal found, both of which look like SUCCESS in CI:
  //
  //  1. VERCEL_ORG_ID/VERCEL_PROJECT_ID as env vars are not honoured by this CLI.
  //     With `--yes` and no link, `vercel pull` CREATES a project named after the
  //     directory and deploys there — the release goes green, `latest` moves, and
  //     the console an operator looks at never changes.
  //  2. The cap-web project carries `Root Directory = apps/web` server-side, so
  //     running the CLI from inside `apps/web` resolves `apps/web/apps/web`.
  const console_ = workflowJob('deploy-console');
  assert.match(console_, /\.vercel\/project\.json/u, 'the link must be written, not inherited');
  assert.match(console_, /EXPECTED_PROJECT_ID/u, 'the link must be re-asserted after pull rewrites it');
  assert.doesNotMatch(
    console_,
    /working-directory: apps\/web/u,
    'the CLI runs from the repository root; the project supplies its own root directory',
  );
});

test('the release publishes the console, and only for a real Release', () => {
  const console_ = workflowJob('deploy-console');
  assert.match(console_, /^    needs: \[resolve-release, verify-image-set\]$/mu);
  // A real Release always publishes it; a manual run only when asked. The
  // rehearsal switch exists because the first version of this job could only be
  // tested by cutting a release, and both defects it had would have surfaced
  // mid-release with the images already pushed.
  assert.match(console_, /github\.event_name == 'release'/u);
  assert.match(console_, /inputs\.deploy_console == true/u);
  // The release version must reach the console build as an ACTUAL assignment, or
  // the console ships carrying the sentinel — the exact gap this job exists to
  // close. Matched against comment-stripped text: the previous version of this
  // assertion accepted the raw job, and a comment mentioning the name satisfied it
  // while nothing set the variable.
  assert.match(
    jobCode('deploy-console'),
    /^\s+VITE_BUILD_ID:\s*\$\{\{\s*needs\.resolve-release\.outputs\.version\s*\}\}\s*$/mu,
    'the release version must be ASSIGNED to VITE_BUILD_ID, not merely mentioned',
  );
  // And the deploy succeeding is not evidence the value arrived: assert it is in
  // the built output rather than trusting the exit code.
  assert.match(console_, /\.vercel\/output/u);
  // All three secrets are checked by name, so "one of three is missing" names
  // which one.
  for (const secret of ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']) {
    assert.match(console_, new RegExp(secret, 'u'));
  }
});

test('a rehearsal deploys a preview; only a Release moves production', () => {
  // The rehearsal switch was added so this job could be exercised without cutting a
  // release, and it deployed `--prod`. That is not a rehearsal — it is a release of
  // the console ALONE, which is the split-version state this change exists to
  // prevent, delivered by its own test switch. Concretely: rehearsing right after
  // the change landed would have published a console sending `x-cap-console-build`
  // to a deployed api built before that header was admitted, and every request
  // would have died at the CORS preflight.
  const code = jobCode('deploy-console');
  assert.match(code, /environment=production/u, 'a Release must target production');
  assert.match(code, /environment=preview/u, 'anything else must target a preview');
  assert.match(
    code,
    /if \[\[ '\$\{\{ github\.event_name \}\}' == 'release' \]\]/u,
    'the target must be chosen by whether this is a real Release',
  );
  // The production flag is derived, never hardcoded onto build/deploy — a literal
  // `--prod` on either line would send every rehearsal to production regardless of
  // what the target step decided.
  for (const line of code.split('\n')) {
    if (!/npx .*vercel@latest (build|deploy)/u.test(line)) continue;
    assert.doesNotMatch(
      line,
      /--prod\b/u,
      `\`--prod\` is hardcoded on: ${line.trim()} — it must come from steps.target`,
    );
    assert.match(line, /steps\.target\.outputs\.prod/u);
  }
});

test('the console build refuses to run without an identity to bake', () => {
  // The proof step is a presence check on the built output and cannot express a
  // precondition: it runs after a build that already baked whatever it had. If the
  // variable is empty the build must not happen at all, because the api now refuses
  // a sentinel from a deployed console — so a console built without it is a console
  // the release ships and the api rejects.
  const code = jobCode('deploy-console');
  assert.match(
    code,
    /if \[\[ -z "\$\{VITE_BUILD_ID:-\}" \]\]; then/u,
    'the build must refuse an empty VITE_BUILD_ID rather than baking the sentinel',
  );
  // And the proof searches for a QUOTED literal: Vite bakes the value via
  // JSON.stringify, so a bare substring search would also match the version
  // appearing in a source-map path and report success for a sentinel build.
  assert.match(code, /grep -rqF -- "\\"\$\{expected\}\\""/u);
});

test('deployable Release assets wait for the complete-set latest promotion gate', () => {
  const runAssets = workflowJob('attach-run-assets');
  const sandboxAssets = workflowJob('attach-sandbox-image-assets');
  assert.match(
    runAssets,
    /^    needs: \[verify-run-package, resolve-release, promote-latest\]$/mu,
  );
  assert.match(runAssets, /^    timeout-minutes: 20$/mu);
  assert.match(sandboxAssets, /^    needs: promote-latest$/mu);
  assert.match(sandboxAssets, /^    timeout-minutes: 60$/mu);
});

test('release identity resolves GIT_SHA once and every image build-arg consumes it', () => {
  const resolve = workflowJob('resolve-release');
  assert.match(resolve, /^\s+git_sha: \$\{\{ steps\.version\.outputs\.git_sha \}\}$/mu);
  assert.match(resolve, /echo "git_sha=\$\{GITHUB_SHA\}" >> "\$GITHUB_OUTPUT"/u);
  // Both image build jobs take GIT_SHA from the single resolve-release source
  // of truth — a directly-resolved `github.sha` build-arg would reopen the
  // SHA-context drift the attestation buildIdentity binding guards against.
  for (const job of ['build-smoke-push-api', 'build-push']) {
    assert.match(
      workflowJob(job),
      /^\s+GIT_SHA=\$\{\{ needs\.resolve-release\.outputs\.git_sha \}\}$/mu,
      job,
    );
  }
  assert.doesNotMatch(RELEASE_WORKFLOW, /GIT_SHA=\$\{\{ github\.sha \}\}/u);
});

test('attestation is generated only from verified check-run evidence, drift-guarded, and uploaded', () => {
  const runAssets = workflowJob('attach-run-assets');

  // Honesty split (D1): the verified-compat gate runs BEFORE generation, and
  // the drift-guard assertion runs BEFORE upload.
  const verify = runAssets.indexOf('name: Verify task model N-1 compatibility check-run');
  const generate = runAssets.indexOf('name: Generate task model attestation asset');
  const drift = runAssets.indexOf(
    'name: Assert attested buildIdentity matches the api image GIT_SHA build-arg',
  );
  const upload = runAssets.indexOf(
    'name: Attach source-free run package and task-model attestation to the Release',
  );
  assert.ok(verify >= 0 && generate > verify && drift > generate && upload > drift);

  // The compat evidence is queried from the release commit's check-runs API —
  // never assumed from workflow adjacency — and anything but completed:success
  // fails the step closed.
  assert.match(runAssets, /^      checks: read$/mu);
  assert.match(
    runAssets,
    /gh api -X GET[\s\S]*\/check-runs[\s\S]*check_name='task model N-1 compatibility'/u,
  );
  assert.match(runAssets, /if \[ "\$result" != "completed:success" \]; then/u);

  // The generator consumes the SAME resolve-release git_sha the api image was
  // built with, and only ever a verified `--compat-verified true`.
  assert.match(
    runAssets,
    /RELEASE_GIT_SHA: \$\{\{ needs\.resolve-release\.outputs\.git_sha \}\}/u,
  );
  assert.match(
    runAssets,
    /node scripts\/generate-task-model-attestation\.mjs \\\n\s+--version "\$\{\{ github\.event\.release\.tag_name \}\}" \\\n\s+--git-sha "\$\{RELEASE_GIT_SHA\}" \\\n\s+--compat-verified true \\\n\s+--out dist\/task-model-attestation/u,
  );

  // SHA-context drift guard: attested buildIdentity === api GIT_SHA build-arg.
  assert.match(
    runAssets,
    /jq -e --arg sha "\$RELEASE_GIT_SHA"[\s\S]*all\(\. == \$sha\)/u,
  );

  // Both the JSON and its .sha256 companion ride the existing upload path.
  assert.match(
    runAssets,
    /gh release upload "\$\{\{ github\.event\.release\.tag_name \}\}"[\s\S]*dist\/task-model-attestation\/\*/u,
  );
});

test('every release job has an explicit hard workflow timeout', () => {
  const expectedMinutes = new Map([
    ['verify-run-package', 10],
    ['resolve-release', 5],
    ['build-smoke-push-api', 45],
    ['build-push', 90],
    ['promote-latest', 15],
    ['attach-run-assets', 20],
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
