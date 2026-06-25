/**
 * Minimal focused test for requirement (sandbox-readoption):
 *   "API shutdown does not stop provisioned sandboxes"
 *
 * Spec scenario under test (D5):
 *   Scenario: SIGTERM leaves running sandboxes alive
 *     WHEN  the api receives SIGTERM (onModuleDestroy) while tasks are running
 *     THEN  the api releases its in-memory handles and exits WITHOUT stopping
 *           those tasks' cap-aio-* containers, leaving the detached codex sessions
 *           running for the next process to re-adopt
 *
 * Two sub-scenarios:
 *   A) A normally-provisioned running sandbox is NOT stopped/removed on shutdown.
 *   B) A re-adopted running sandbox (from boot re-adoption) is NOT stopped/removed on shutdown.
 *
 * Self-contained: compiles the real AioSandboxProvider, injects fake dockerode,
 * mocks fetch, runs onModuleDestroy(), asserts stop/remove call counts = 0.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'reflect-metadata';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const providerSrc = join(__dirname, 'aio-sandbox.provider.ts');

// ---- assertion helpers -------------------------------------------------------
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
const outDir = mkdtempSync(join(apiRoot, '.shutdown-no-stop-test-'));

function compileProvider() {
  execFileSync(
    tscBin,
    [
      providerSrc,
      join(__dirname, 'codex-auth-source.port.ts'),
      join(__dirname, 'claude-auth-source.port.ts'),
      join(__dirname, 'runtime-material-resolver.ts'),
      join(__dirname, '..', 'agent-runtime', 'agent-runtime.port.ts'),
      join(__dirname, '..', 'settings', 'assert-safe-provider-url.ts'),
      join(__dirname, '..', 'agent-runtime', 'codex-runtime.ts'),
      join(__dirname, 'provision-lookup.port.ts'),
      join(__dirname, '..', 'terminal', 'codex-launch.ts'),
      join(__dirname, 'skill-allowlist.ts'),
      '--outDir', outDir,
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'ES2021',
      '--experimentalDecorators',
      '--emitDecoratorMetadata',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const flat = join(outDir, 'aio-sandbox.provider.js');
  if (existsSync(flat)) return flat;
  function findFile(dir, name) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { const f = findFile(p, name); if (f) return f; }
      else if (entry.name === name) return p;
    }
    return null;
  }
  const hit = findFile(outDir, 'aio-sandbox.provider.js');
  if (hit) return hit;
  throw new Error('compiled aio-sandbox.provider.js not found under ' + outDir);
}

// ---- test fixtures ----------------------------------------------------------

/** A fake container that records every stop/remove call (throws if called). */
function makeStrictContainer() {
  const calls = { started: 0, stopped: 0, removed: 0 };
  return {
    calls,
    async start() { calls.started++; },
    async stop() {
      calls.stopped++;
      // NOT throwing — we want to observe the call count, not crash the test
    },
    async remove() {
      calls.removed++;
    },
    async inspect() { return { State: { Running: true } }; },
    async getArchive() { throw new Error('no archive'); },
  };
}

function makeFakeDocker(containers = {}) {
  const created = {};
  return {
    created,
    async createContainer(options) {
      const name = options.name;
      if (!containers[name]) {
        containers[name] = makeStrictContainer();
      }
      created[name] = options;
      return containers[name];
    },
    getContainer(nameOrId) {
      // Return from the map by name or id — fall back to a strict container.
      return containers[nameOrId] ?? makeStrictContainer();
    },
    async listContainers(opts) {
      // Return all names that match the cap-aio- prefix as RUNNING
      return Object.keys(containers)
        .filter((n) => n.startsWith('cap-aio-'))
        .map((n) => ({ Id: n, Names: [`/${n}`] }));
    },
  };
}

function makeLookup() {
  return {
    async getCloneSpec() { return null; },
    async getTaskPrompt() { return null; },
    async getTaskSkills() { return []; },
  };
}
function makeCodexAuthSource() {
  return { async getCodexAuth() { return null; }, async persistRefreshedAuth() {} };
}

/** Mock fetch: readiness ok; all shell/exec succeed with exit_code 0. */
function installFetchMock() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/v1/shell/exec')) {
      return {
        ok: true, status: 200,
        async json() {
          return { success: true, data: { exit_code: 0, output: '' } };
        },
      };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  return () => { globalThis.fetch = original; };
}

// ---- run tests --------------------------------------------------------------
console.log('\n=== API shutdown does not stop provisioned sandboxes (D5) ===\n');

let exitCode = 0;
const restoreFetch = installFetchMock();
const prevImage = process.env.AIO_SANDBOX_IMAGE;
process.env.AIO_SANDBOX_IMAGE = 'cap-aio-sandbox:0.1.0';

try {
  const providerJs = compileProvider();
  const mod = await import(pathToFileURL(providerJs).href);
  const { AioSandboxProvider } = mod;
  assert(typeof AioSandboxProvider === 'function', 'AioSandboxProvider class compiled and exported');

  // ── Scenario A: normally-provisioned running sandbox survives SIGTERM ────────
  {
    const container = makeStrictContainer();
    const docker = makeFakeDocker({ 'cap-aio-task-running': container });
    const provider = new AioSandboxProvider(makeLookup(), makeCodexAuthSource());
    provider.docker = docker;

    await provider.provision({ taskId: 'task-running' });
    assert(container.calls.started === 1, '[A] sandbox was started (provision succeeded)');
    assert(container.calls.stopped === 0, '[A] sandbox not stopped before onModuleDestroy');

    // Simulate SIGTERM → NestJS calls onModuleDestroy()
    provider.onModuleDestroy();

    assert(
      container.calls.stopped === 0,
      '[A] SIGTERM: onModuleDestroy does NOT stop the running container',
    );
    assert(
      container.calls.removed === 0,
      '[A] SIGTERM: onModuleDestroy does NOT remove the running container',
    );
    // In-memory maps must be cleared so the process is ready to exit cleanly
    assert(
      (await provider.listReadoptable()).length === 0,
      '[A] SIGTERM: in-memory readopted set is cleared after onModuleDestroy',
    );
  }

  // ── Scenario B: re-adopted running sandbox (boot re-adoption) survives SIGTERM
  {
    // Fake docker reports one RUNNING cap-aio-task-readopted container
    const adopted = makeStrictContainer();
    let hasSessionCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/v1/shell/exec')) {
        const cmd = JSON.parse(init.body ?? '{}').command ?? '';
        if (cmd.startsWith('tmux has-session')) {
          hasSessionCalled = true;
          // Alive — return exit_code 0
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
      }
      return { ok: true, status: 200, async json() { return {}; } };
    };

    const docker = {
      async listContainers() {
        return [{ Id: 'container-readopted', Names: ['/cap-aio-task-readopted'] }];
      },
      getContainer(nameOrId) {
        return adopted;
      },
    };

    const provider = new AioSandboxProvider(makeLookup(), makeCodexAuthSource());
    provider.docker = docker;

    await provider.onApplicationBootstrap();
    globalThis.fetch = origFetch;

    assert(hasSessionCalled, '[B] boot re-adoption probed tmux has-session for the running container');
    assert(
      (await provider.listReadoptable()).includes('task-readopted'),
      '[B] boot re-adoption registered the live-session container as re-adoptable',
    );
    assert(adopted.calls.stopped === 0, '[B] boot re-adoption does NOT stop the re-adopted container');
    assert(adopted.calls.removed === 0, '[B] boot re-adoption does NOT remove the re-adopted container');

    // Now simulate SIGTERM
    provider.onModuleDestroy();

    assert(
      adopted.calls.stopped === 0,
      '[B] SIGTERM: onModuleDestroy does NOT stop the re-adopted running container',
    );
    assert(
      adopted.calls.removed === 0,
      '[B] SIGTERM: onModuleDestroy does NOT remove the re-adopted running container',
    );
    assert(
      (await provider.listReadoptable()).length === 0,
      '[B] SIGTERM: in-memory readopted set is cleared after onModuleDestroy',
    );
  }

  // ── Scenario C: normal task teardown (non-shutdown) still stops + retains ───
  // This confirms the "Normal terminal teardown is unaffected" sub-scenario:
  // only teardownSandbox (the REAL task-done path) stops the container; the
  // shutdown hook never does.
  {
    const container = makeStrictContainer();
    const docker = makeFakeDocker({ 'cap-aio-task-terminal': container });
    const provider = new AioSandboxProvider(makeLookup(), makeCodexAuthSource());
    provider.docker = docker;

    await provider.provision({ taskId: 'task-terminal' });
    // Real task teardown (task reached terminal state, NOT an api shutdown)
    await provider.teardownSandbox('task-terminal');

    assert(
      container.calls.stopped >= 1,
      '[C] normal task teardown DOES stop the container (retention path unchanged)',
    );
    assert(
      container.calls.removed === 0,
      '[C] normal task teardown STOPS but does NOT remove the container (kept as retained history)',
    );
  }

} catch (err) {
  console.error('  FAIL  unexpected error during test run');
  console.error(err);
  failed++;
} finally {
  restoreFetch();
  if (prevImage === undefined) delete process.env.AIO_SANDBOX_IMAGE;
  else process.env.AIO_SANDBOX_IMAGE = prevImage;
  rmSync(outDir, { recursive: true, force: true });
}

// ---- summary ----------------------------------------------------------------
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.error('SOME TESTS FAILED');
  exitCode = 1;
}
process.exit(exitCode);
