/**
 * Focused unit test for requirement (aio-sandbox-execution):
 *   "Per-task AIO Sandbox container provisioning"
 *
 * Spec scenario under test:
 *   Scenario: Container is created with required security and network options
 *     WHEN  AioSandboxProvider provisions a sandbox for a task with id <taskId>
 *     THEN  it calls dockerode createContainer with name cap-aio-<taskId> from
 *           the pinned AIO image
 *     AND   HostConfig.SecurityOpt includes seccomp=unconfined
 *     AND   the container is attached to the cap-net network with no PortBindings
 *           so no host port is published
 *
 * This test exercises the REAL AioSandboxProvider (not a mirror): it compiles
 * the actual `aio-sandbox.provider.ts` to a temp module with `tsc`, imports it,
 * injects a mocked dockerode `Docker` whose `createContainer` records the
 * options it was called with, mocks `fetch` for the readiness poll, runs
 * `provision()`, and asserts the captured `createContainer` options.
 *
 * Mirrors the repo's `.test.mjs` convention (self-contained, plain `node`,
 * inline assertions, no test framework).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import 'reflect-metadata';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const providerSrc = join(__dirname, 'aio-sandbox.provider.ts');

// ---- assertion helpers ------------------------------------------------------

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

// ---- compile the REAL provider to a temp module -----------------------------

// Emit INSIDE apps/api so Node module resolution walks up to the repo
// node_modules for `dockerode` / `@nestjs/common` (a system tmp dir cannot).
const outDir = mkdtempSync(join(apiRoot, '.aio-provider-test-'));

function compileProvider() {
  // Compile only the provider; its sole non-type import is `dockerode`, and the
  // `./sandbox-provider.port.js` import is type-only and gets elided.
  execFileSync(
    tscBin,
    [
      providerSrc,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'ES2021',
      '--experimentalDecorators',
      '--emitDecoratorMetadata',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  return join(outDir, 'aio-sandbox.provider.js');
}

// ---- test fixtures ----------------------------------------------------------

const TASK_ID = 'task-123';
const IMAGE = 'cap-aio-sandbox:0.1.0'; // a PINNED tag (not :latest)

/** A fake dockerode Container that records start/stop/remove without doing I/O. */
function makeFakeContainer() {
  const calls = { started: 0, stopped: 0, removed: 0 };
  return {
    calls,
    async start() {
      calls.started++;
    },
    async stop() {
      calls.stopped++;
    },
    async remove() {
      calls.removed++;
    },
  };
}

/** A fake dockerode Docker that captures the createContainer options. */
function makeFakeDocker(container) {
  const captured = { createContainerOptions: undefined, createContainerCalls: 0 };
  return {
    captured,
    async createContainer(options) {
      captured.createContainerCalls++;
      captured.createContainerOptions = options;
      return container;
    },
  };
}

/**
 * Mock global fetch: readiness `/v1/docs` ok; `/v1/shell/exec` returns a body
 * carrying an `exit_code` (so the provider can parse a clone's success/failure).
 *
 * @param execExitCode the `exit_code` the mocked clone returns (default 0 = ok).
 * @param execOutput   the `output` the mocked clone returns.
 */
function installFetchMock(execExitCode = 0, execOutput = '') {
  const original = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (u.endsWith('/v1/shell/exec')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { exit_code: execExitCode, output: execOutput };
        },
      };
    }
    // readiness `/v1/docs` (and anything else): ok with an empty body.
    return {
      ok: true,
      status: 200,
      async json() {
        return {};
      },
    };
  };
  return {
    fetchCalls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ---- run --------------------------------------------------------------------

console.log('\n=== AioSandboxProvider: per-task container provisioning ===\n');

let exitCode = 0;
try {
  const providerJs = compileProvider();
  const mod = await import(pathToFileURL(providerJs).href);
  const { AioSandboxProvider } = mod;
  assert(typeof AioSandboxProvider === 'function', 'provider class is exported');

  const fakeContainer = makeFakeContainer();
  const fakeDocker = makeFakeDocker(fakeContainer);
  const fetchMock = installFetchMock();

  const prevImage = process.env.AIO_SANDBOX_IMAGE;
  const prevNetwork = process.env.AIO_SANDBOX_NETWORK;
  const prevRepo = process.env.TASK_REPO_URL;
  process.env.AIO_SANDBOX_IMAGE = IMAGE;
  delete process.env.AIO_SANDBOX_NETWORK; // exercise the cap-net default
  delete process.env.TASK_REPO_URL; // skip clone for this options-focused test

  let connection;
  try {
    const provider = new AioSandboxProvider();
    // Inject the mocked dockerode in place of the real `new Docker()`.
    provider.docker = fakeDocker;

    connection = await provider.provision({ taskId: TASK_ID });

    const opts = fakeDocker.captured.createContainerOptions;
    assert(fakeDocker.captured.createContainerCalls === 1, 'createContainer called exactly once');
    assert(opts?.name === `cap-aio-${TASK_ID}`, 'container name is cap-aio-<taskId>');
    assert(opts?.Image === IMAGE, 'container created from the pinned AIO image');

    const securityOpt = opts?.HostConfig?.SecurityOpt ?? [];
    assert(
      Array.isArray(securityOpt) && securityOpt.includes('seccomp=unconfined'),
      'HostConfig.SecurityOpt includes seccomp=unconfined',
    );

    assert(opts?.HostConfig?.NetworkMode === 'cap-net', 'container joins the cap-net network');

    const hasPortBindings =
      opts?.HostConfig?.PortBindings !== undefined && opts.HostConfig.PortBindings !== null;
    assert(!hasPortBindings, 'no PortBindings (no host port published)');

    assert(fakeContainer.calls.started === 1, 'container was started');

    // Returned handle is addressable by container name (2.6).
    assert(connection?.taskId === TASK_ID, 'connection.taskId is the task id');
    assert(
      connection?.baseUrl === `http://cap-aio-${TASK_ID}:8080`,
      'connection.baseUrl is http://cap-aio-<taskId>:8080',
    );
    assert(
      connection?.wsUrl === `ws://cap-aio-${TASK_ID}:8080/v1/shell/ws`,
      'connection.wsUrl is ws://cap-aio-<taskId>:8080/v1/shell/ws',
    );

    // Readiness was polled against /v1/docs before the handle returned (2.3).
    assert(
      fetchMock.fetchCalls.some((c) => c.url.endsWith('/v1/docs')),
      'readiness polled GET /v1/docs before returning',
    );

    // Idempotent: a second provision returns the same handle, no new container.
    const again = await provider.provision({ taskId: TASK_ID });
    assert(again === connection, 'provision is idempotent (same handle, no new container)');
    assert(
      fakeDocker.captured.createContainerCalls === 1,
      'idempotent provision does not create a second container',
    );

    // A pinned :latest / untagged image must be rejected (2.2 pinning guard).
    process.env.AIO_SANDBOX_IMAGE = 'cap-aio-sandbox:latest';
    let rejectedLatest = false;
    try {
      const p2 = new AioSandboxProvider();
      p2.docker = makeFakeDocker(makeFakeContainer());
      await p2.provision({ taskId: 'task-latest' });
    } catch {
      rejectedLatest = true;
    }
    assert(rejectedLatest, ':latest image tag is rejected (pinning enforced)');

    // ---- 2.3: clone into a dedicated EMPTY workspace dir + failure surfaces ----

    // Successful clone (exit_code 0) into the empty workspace dir returns the
    // addressable handle, and clones into /home/gem/workspace, NOT /home/gem.
    process.env.AIO_SANDBOX_IMAGE = IMAGE;
    process.env.TASK_REPO_URL = 'https://example.test/repo.git';
    const okClone = installFetchMock(0, '');
    let cloneConnection;
    try {
      const p3 = new AioSandboxProvider();
      p3.docker = makeFakeDocker(makeFakeContainer());
      cloneConnection = await p3.provision({ taskId: 'task-clone-ok' });

      const execCall = okClone.fetchCalls.find((c) => c.url.endsWith('/v1/shell/exec'));
      assert(execCall !== undefined, 'clone issued via POST /v1/shell/exec');
      const cmd = execCall ? JSON.parse(execCall.init.body).command : '';
      assert(
        cmd.includes('/home/gem/workspace'),
        'clone targets the dedicated empty workspace dir /home/gem/workspace',
      );
      assert(
        !/git clone \S+ \.$/.test(cmd) && !/\s\/home\/gem$/.test(cmd),
        'clone does NOT target the non-empty /home/gem HOME',
      );
      assert(
        !cmd.includes('| head') && !cmd.includes('|head'),
        'clone command has no trailing pipe so exit_code is the clone’s own',
      );
      assert(
        cloneConnection?.taskId === 'task-clone-ok' &&
          cloneConnection?.baseUrl === 'http://cap-aio-task-clone-ok:8080',
        'successful clone returns the addressable SandboxConnection handle',
      );
    } finally {
      okClone.restore();
    }

    // Induced clone failure (non-zero exit_code, e.g. non-empty dir) raises a
    // provision error carrying the command output — never a silent success.
    const failClone = installFetchMock(
      128,
      "fatal: destination path '/home/gem/workspace' already exists and is not an empty directory.",
    );
    let cloneRejected = false;
    let cloneErrMsg = '';
    try {
      const p4 = new AioSandboxProvider();
      p4.docker = makeFakeDocker(makeFakeContainer());
      await p4.provision({ taskId: 'task-clone-fail' });
    } catch (err) {
      cloneRejected = true;
      cloneErrMsg = err instanceof Error ? err.message : String(err);
    } finally {
      failClone.restore();
    }
    assert(cloneRejected, 'non-zero clone exit_code raises a provision error');
    assert(
      cloneErrMsg.includes('128') && cloneErrMsg.includes('already exists'),
      'provision error carries the clone exit_code and output',
    );
  } finally {
    fetchMock.restore();
    if (prevImage === undefined) delete process.env.AIO_SANDBOX_IMAGE;
    else process.env.AIO_SANDBOX_IMAGE = prevImage;
    if (prevNetwork === undefined) delete process.env.AIO_SANDBOX_NETWORK;
    else process.env.AIO_SANDBOX_NETWORK = prevNetwork;
    if (prevRepo === undefined) delete process.env.TASK_REPO_URL;
    else process.env.TASK_REPO_URL = prevRepo;
  }
} catch (err) {
  console.error('  FAIL  unexpected error during test run');
  console.error(err);
  failed++;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// ---- summary ----------------------------------------------------------------

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  exitCode = 0;
} else {
  console.error('SOME TESTS FAILED');
  exitCode = 1;
}
process.exit(exitCode);
