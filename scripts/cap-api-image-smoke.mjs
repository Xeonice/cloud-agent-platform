#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;
export const CAP_API_RELEASE_PLATFORM = 'linux/amd64';
/** Registry transfer may be slow, but it must never hold the release tail forever. */
export const CAP_API_IMAGE_PULL_TIMEOUT_MS = 5 * 60_000;
/** Local image probes are bounded independently from the longer registry pull. */
export const CAP_API_IMAGE_RUN_TIMEOUT_MS = 30_000;

export const GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE =
  'FATAL: platform_dependency_unavailable: required executable git could not be verified.';

export const CONTAINER_PREFLIGHT_PROGRAM = Object.freeze([
  "const { assertGitRuntimeAvailable } = require('./dist/forge/git-runtime-preflight.js');",
  'assertGitRuntimeAvailable().then(() => undefined, () => { process.exitCode = 1; });',
].join('\n'));

export class ApiImageSmokeError extends Error {
  constructor(readonlyCode, message) {
    super(message);
    this.name = 'ApiImageSmokeError';
    this.code = readonlyCode;
  }
}

function validateImageReference(image) {
  if (
    typeof image !== 'string' ||
    image.length === 0 ||
    image.length > 512 ||
    image.startsWith('-') ||
    /[\s\u0000-\u001f\u007f]/u.test(image)
  ) {
    throw new ApiImageSmokeError(
      'invalid_image_reference',
      'a valid cap-api image reference is required',
    );
  }
  return image;
}

function runDocker(
  args,
  {
    cwd,
    env,
    spawnSyncImpl,
    code,
    message,
    timeoutMs,
  },
) {
  let result;
  try {
    result = spawnSyncImpl('docker', args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: MAX_CAPTURED_OUTPUT_BYTES,
      shell: false,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch {
    throw new ApiImageSmokeError(code, message);
  }
  if (result.error || !Number.isInteger(result.status)) {
    throw new ApiImageSmokeError(code, message);
  }
  return result;
}

/**
 * Verify the production API image with fixed, no-shell Docker argv.
 *
 * The direct Git check proves the packaged executable can run. The second check
 * imports and executes the same compiled preflight used by API bootstrap. The
 * optional negative fixture masks the image's `/usr/bin` at runtime and starts
 * the real entry point with an absolute Node path; startup must terminate with
 * only the stable dependency message before Nest can listen on a port.
 */
export function smokeCapApiImage({
  image,
  pull = 'never',
  negativeFixture = false,
  cwd = REPO_ROOT,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const imageReference = validateImageReference(image);
  if (pull !== 'never' && pull !== 'always') {
    throw new ApiImageSmokeError(
      'invalid_pull_policy',
      'cap-api image pull policy must be never or always',
    );
  }

  const options = { cwd, env, spawnSyncImpl };
  if (pull === 'always') {
    const pulled = runDocker(
      ['pull', '--platform', CAP_API_RELEASE_PLATFORM, imageReference],
      {
        ...options,
        code: 'image_pull_failed',
        message: 'could not pull the requested cap-api image',
        timeoutMs: CAP_API_IMAGE_PULL_TIMEOUT_MS,
      },
    );
    if (pulled.status !== 0) {
      throw new ApiImageSmokeError(
        'image_pull_failed',
        'could not pull the requested cap-api image',
      );
    }
  }

  const gitVersion = runDocker(
    [
      'run',
      '--rm',
      '--pull=never',
      '--platform',
      CAP_API_RELEASE_PLATFORM,
      '--entrypoint',
      'git',
      imageReference,
      '--version',
    ],
    {
      ...options,
      code: 'git_unavailable',
      message: 'required Git executable is unavailable in the cap-api image',
      timeoutMs: CAP_API_IMAGE_RUN_TIMEOUT_MS,
    },
  );
  if (
    gitVersion.status !== 0 ||
    !/^git version \S+(?:\s.*)?$/u.test(String(gitVersion.stdout ?? '').trim())
  ) {
    throw new ApiImageSmokeError(
      'git_unavailable',
      'required Git executable is unavailable in the cap-api image',
    );
  }

  const preflight = runDocker(
    [
      'run',
      '--rm',
      '--pull=never',
      '--platform',
      CAP_API_RELEASE_PLATFORM,
      '--entrypoint',
      '/usr/local/bin/node',
      imageReference,
      '-e',
      CONTAINER_PREFLIGHT_PROGRAM,
    ],
    {
      ...options,
      code: 'startup_preflight_failed',
      message: 'cap-api image Git startup preflight failed',
      timeoutMs: CAP_API_IMAGE_RUN_TIMEOUT_MS,
    },
  );
  if (preflight.status !== 0) {
    throw new ApiImageSmokeError(
      'startup_preflight_failed',
      'cap-api image Git startup preflight failed',
    );
  }

  if (negativeFixture) {
    const negative = runDocker(
      [
        'run',
        '--rm',
        '--pull=never',
        '--platform',
        CAP_API_RELEASE_PLATFORM,
        '--tmpfs',
        '/usr/bin:rw,noexec,nosuid,size=64k',
        '--entrypoint',
        '/usr/local/bin/node',
        imageReference,
        'dist/main.js',
      ],
      {
        ...options,
        code: 'negative_fixture_failed',
        message: 'missing-Git runtime fixture could not be executed',
        timeoutMs: CAP_API_IMAGE_RUN_TIMEOUT_MS,
      },
    );
    const output = `${String(negative.stdout ?? '')}\n${String(negative.stderr ?? '')}`;
    if (
      negative.status === 0 ||
      !output.split(/\r?\n/u).includes(GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE)
    ) {
      throw new ApiImageSmokeError(
        'negative_fixture_not_rejected',
        'missing-Git runtime fixture was not safely rejected before API startup',
      );
    }
  }

  return Object.freeze({
    image: imageReference,
    negativeFixtureVerified: negativeFixture,
  });
}

function usage() {
  return 'Usage: node scripts/cap-api-image-smoke.mjs --image <reference> [--pull never|always] [--negative-fixture]';
}

export function main(argv = process.argv.slice(2)) {
  let image;
  let pull = 'never';
  let negativeFixture = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--image' && index + 1 < argv.length) {
      image = argv[index + 1];
      index += 1;
    } else if (argument === '--pull' && index + 1 < argv.length) {
      pull = argv[index + 1];
      index += 1;
    } else if (argument === '--negative-fixture') {
      negativeFixture = true;
    } else {
      throw new ApiImageSmokeError('invalid_arguments', usage());
    }
  }

  smokeCapApiImage({ image, pull, negativeFixture });
  process.stdout.write(
    negativeFixture
      ? 'cap-api image smoke passed: Git, startup preflight, and missing-Git rejection verified\n'
      : 'cap-api image smoke passed: Git and startup preflight verified\n',
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    const message =
      error instanceof ApiImageSmokeError
        ? error.message
        : 'unexpected cap-api image verification failure';
    process.stderr.write(`cap-api image smoke failed: ${message}\n`);
    process.exitCode = 1;
  }
}
