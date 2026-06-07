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
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
  // Compile the provider PLUS its value-imported, same-directory ports
  // (codex-auth-source.port, provision-lookup.port) so their emitted .js sit
  // beside provider.js in outDir and the provider's `require('./...port')`
  // resolves. The `./sandbox-provider.port.js` import is type-only and gets
  // elided; `dockerode` / `@nestjs/common` resolve from the repo node_modules at
  // runtime (outDir lives under apps/api so module resolution walks up to them).
  execFileSync(
    tscBin,
    [
      providerSrc,
      join(__dirname, 'codex-auth-source.port.ts'),
      join(__dirname, 'provision-lookup.port.ts'),
      // The provider now imports the shared launch contract (the prompt-file path)
      // from ../terminal/codex-launch — a dependency-free leaf. Listed so its .js
      // is emitted; the cross-directory import makes tsc preserve the src/ tree, so
      // the emitted provider lands under a nested path (findFile resolves it).
      join(__dirname, '..', 'terminal', 'codex-launch.ts'),
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
  const flat = join(outDir, 'aio-sandbox.provider.js');
  if (existsSync(flat)) return flat;
  const nested = join(outDir, 'sandbox', 'aio-sandbox.provider.js');
  if (existsSync(nested)) return nested;
  const hit = findFile(outDir, 'aio-sandbox.provider.js');
  if (hit) return hit;
  throw new Error('compiled aio-sandbox.provider.js not found under ' + outDir);
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
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
        // The live AIO server NESTS the result under `data` — mirror that so the
        // test exercises the real shape the provider must parse (a flat top-level
        // exit_code would mask the data-vs-top-level bug).
        async json() {
          return {
            success: true,
            message: 'Command executed',
            data: { status: 'completed', exit_code: execExitCode, output: execOutput },
          };
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

/**
 * Stub {@link ProvisionLookup}: returns a fixed clone spec (or null to skip the
 * clone). The provider now resolves the per-task clone spec through this port
 * instead of reading `TASK_REPO_URL` directly. `cloneUrl` becomes `{ url }`
 * (no auth header — the option/clone assertions use a public test URL).
 */
function makeLookup(cloneUrl = null, taskPrompt = null) {
  return {
    async getCloneSpec() {
      return cloneUrl ? { url: cloneUrl } : null;
    },
    // aio-codex-prompt-autostart: the provider resolves the task's prompt through
    // this port and injects it as a file. Null/empty → no prompt file written
    // (blank composer) and no extra /v1/shell/exec.
    async getTaskPrompt() {
      return taskPrompt;
    },
  };
}

/**
 * Stub {@link CodexAuthSource}: returns fixed material (or null to skip codex
 * auth injection). Returning null keeps these option/clone-focused assertions
 * from seeing an extra `/v1/shell/exec` (the auth.json write) before the clone.
 */
function makeCodexAuthSource(material = null) {
  return {
    async getCodexAuth() {
      return material;
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
    const provider = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
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
      const p2 = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
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
      const p3 = new AioSandboxProvider(
        makeLookup('https://example.test/repo.git'),
        makeCodexAuthSource(),
      );
      p3.docker = makeFakeDocker(makeFakeContainer());
      cloneConnection = await p3.provision({ taskId: 'task-clone-ok' });

      // provision now emits the codex config.toml exec FIRST, then the clone, so
      // match the clone command specifically (not merely the first /v1/shell/exec).
      const execCall = okClone.fetchCalls.find(
        (c) =>
          c.url.endsWith('/v1/shell/exec') &&
          JSON.parse(c.init.body).command.includes('git clone'),
      );
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
      const p4 = new AioSandboxProvider(
        makeLookup('https://example.test/repo.git'),
        makeCodexAuthSource(),
      );
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

    // ---- codex auth injection (material non-null) writes auth.json correctly ----
    // With a CodexAuthSource returning material, provision injects auth.json into
    // /home/gem/.codex via /v1/shell/exec, base64-decoding the authJson + chmod 600.
    const authMock = installFetchMock(0, '');
    try {
      const authJson = '{"auth_mode":"chatgpt","tokens":{}}';
      const pAuth = new AioSandboxProvider(
        makeLookup(null), // skip clone — isolate the auth-inject exec
        makeCodexAuthSource({ authJson }),
      );
      pAuth.docker = makeFakeDocker(makeFakeContainer());
      await pAuth.provision({ taskId: 'task-auth' });
      const injectCall = authMock.fetchCalls.find(
        (c) =>
          c.url.endsWith('/v1/shell/exec') &&
          JSON.parse(c.init.body).command.includes('/home/gem/.codex/auth.json'),
      );
      assert(
        injectCall !== undefined,
        'codex auth injected via POST /v1/shell/exec to /home/gem/.codex/auth.json',
      );
      const acmd = injectCall ? JSON.parse(injectCall.init.body).command : '';
      const expectedB64 = Buffer.from(authJson, 'utf8').toString('base64');
      assert(
        acmd.includes(`'${expectedB64}'`),
        'auth payload is the single-quoted base64 of material.authJson',
      );
      assert(
        acmd.includes('base64 -d') && acmd.includes('chmod 600'),
        'injection base64-decodes the payload and chmod 600 the auth.json',
      );
    } finally {
      authMock.restore();
    }

    // ---- task prompt injection (aio-codex-prompt-autostart) ------------------
    // A non-empty task prompt is written into the sandbox at
    // /home/gem/.codex/task-prompt.txt via /v1/shell/exec, base64-decoded +
    // chmod 600 — the shell-injection-safe idiom, so arbitrary free-text never
    // reaches the shell or the launch argv.
    const promptMock = installFetchMock(0, '');
    try {
      const prompt = 'fix the bug; do NOT use --yolo & echo "$HOME" `whoami`';
      const pPrompt = new AioSandboxProvider(
        makeLookup(null, prompt), // skip clone — isolate the prompt-inject exec
        makeCodexAuthSource(),
      );
      pPrompt.docker = makeFakeDocker(makeFakeContainer());
      await pPrompt.provision({ taskId: 'task-prompt' });
      const promptCall = promptMock.fetchCalls.find(
        (c) =>
          c.url.endsWith('/v1/shell/exec') &&
          JSON.parse(c.init.body).command.includes('/home/gem/.codex/task-prompt.txt'),
      );
      assert(
        promptCall !== undefined,
        'task prompt injected via POST /v1/shell/exec to /home/gem/.codex/task-prompt.txt',
      );
      const pcmd = promptCall ? JSON.parse(promptCall.init.body).command : '';
      const expectedB64 = Buffer.from(prompt, 'utf8').toString('base64');
      assert(
        pcmd.includes(`'${expectedB64}'`),
        'prompt payload is the single-quoted base64 of task.prompt (no raw text inlined)',
      );
      assert(
        !pcmd.includes('--yolo') && !pcmd.includes('whoami') && !pcmd.includes('$HOME'),
        'raw prompt free-text (quotes/$/backticks/--yolo) never appears in the shell command',
      );
      assert(
        pcmd.includes('base64 -d') && pcmd.includes('chmod 600'),
        'prompt injection base64-decodes the payload and chmod 600 the file',
      );
    } finally {
      promptMock.restore();
    }

    // ---- empty prompt → NO task-prompt.txt write (codex opens a blank composer)
    const noPromptMock = installFetchMock(0, '');
    try {
      const pNo = new AioSandboxProvider(makeLookup(null, null), makeCodexAuthSource());
      pNo.docker = makeFakeDocker(makeFakeContainer());
      await pNo.provision({ taskId: 'task-no-prompt' });
      const promptCall = noPromptMock.fetchCalls.find(
        (c) =>
          c.url.endsWith('/v1/shell/exec') &&
          JSON.parse(c.init.body).command.includes('task-prompt.txt'),
      );
      assert(
        promptCall === undefined,
        'empty prompt → no task-prompt.txt write (codex opens a blank composer)',
      );
    } finally {
      noPromptMock.restore();
    }

    // ---- prompt injection fails CLOSED on a non-zero exit --------------------
    // Bespoke mock: the config.toml/auth exec succeeds (exit 0) but the
    // task-prompt.txt write exits non-zero, isolating the prompt-inject failure.
    const promptFailContainer = makeFakeContainer();
    const origFetch = globalThis.fetch;
    let promptFailThrew = false;
    let pfMsg = '';
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/v1/shell/exec')) {
        const cmd = JSON.parse(init.body).command;
        const exit_code = cmd.includes('task-prompt.txt') ? 1 : 0;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: { status: 'completed', exit_code, output: exit_code ? 'prompt write boom' : '' },
            };
          },
        };
      }
      return { ok: true, status: 200, async json() { return {}; } };
    };
    try {
      const pPf = new AioSandboxProvider(makeLookup(null, 'some goal'), makeCodexAuthSource());
      pPf.docker = makeFakeDocker(promptFailContainer);
      await pPf.provision({ taskId: 'task-prompt-fail' });
    } catch (err) {
      promptFailThrew = true;
      pfMsg = err instanceof Error ? err.message : String(err);
    } finally {
      globalThis.fetch = origFetch;
    }
    assert(promptFailThrew, 'provision rejects when prompt injection exits non-zero (fail-closed)');
    assert(
      pfMsg.includes('prompt injection') && pfMsg.includes('1'),
      'fail-closed error identifies the prompt-injection failure and exit code',
    );
    assert(
      promptFailContainer.calls.started === 1 &&
        (promptFailContainer.calls.stopped >= 1 || promptFailContainer.calls.removed >= 1),
      'a prompt-injection failure tears the started container down (no leak)',
    );

    // ---- post-start provision failure tears the container down (no leak) -------
    // A non-zero codex-auth-inject exit fails provision (fail-closed); the already
    // STARTED container MUST be stopped/removed (teardownSandbox), never left
    // running — the high-severity container-leak fix.
    const teardownContainer = makeFakeContainer();
    const teardownMock = installFetchMock(1, 'inject boom'); // every exec exits 1
    let teardownProvisionThrew = false;
    try {
      const pTd = new AioSandboxProvider(
        makeLookup(null),
        makeCodexAuthSource({ authJson: '{"auth_mode":"chatgpt"}' }),
      );
      pTd.docker = makeFakeDocker(teardownContainer);
      await pTd.provision({ taskId: 'task-teardown' });
    } catch {
      teardownProvisionThrew = true;
    } finally {
      teardownMock.restore();
    }
    assert(
      teardownProvisionThrew,
      'provision rejects when codex auth injection exits non-zero (fail-closed)',
    );
    assert(
      teardownContainer.calls.started === 1 &&
        (teardownContainer.calls.stopped >= 1 || teardownContainer.calls.removed >= 1),
      'a post-start provision failure tears the started container down (no leak)',
    );

    // ---- startup reap: orphaned cap-aio-* containers from a prior process ----
    // onApplicationBootstrap lists every cap-aio-* container and force-removes it
    // (after a restart the orchestrator owns no live session, so all are orphans).
    {
      const removed = [];
      let listFilter;
      const reapDocker = {
        async listContainers(options) {
          listFilter = options?.filters;
          return [{ Id: 'orphan-1' }, { Id: 'orphan-2' }];
        },
        getContainer(id) {
          return {
            async remove() {
              removed.push(id);
            },
          };
        },
      };
      const pReap = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      pReap.docker = reapDocker;
      await pReap.onApplicationBootstrap();
      assert(
        Array.isArray(listFilter?.name) &&
          listFilter.name.some((n) => n.includes('cap-aio-')),
        'startup reap lists containers filtered by the cap-aio- name prefix',
      );
      assert(
        removed.length === 2 && removed.includes('orphan-1') && removed.includes('orphan-2'),
        'startup reap force-removes every orphaned cap-aio-* container',
      );

      // No orphans -> nothing removed, no throw.
      const removed2 = [];
      const pReap2 = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      pReap2.docker = {
        async listContainers() {
          return [];
        },
        getContainer() {
          return {
            async remove() {
              removed2.push(1);
            },
          };
        },
      };
      await pReap2.onApplicationBootstrap();
      assert(removed2.length === 0, 'startup reap removes nothing when there are no orphans');

      // A docker failure during reap is swallowed (never blocks app startup).
      const pReap3 = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      pReap3.docker = {
        async listContainers() {
          throw new Error('docker down');
        },
      };
      let reapThrew = false;
      try {
        await pReap3.onApplicationBootstrap();
      } catch {
        reapThrew = true;
      }
      assert(!reapThrew, 'startup reap swallows docker errors (never blocks app startup)');
    }
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
