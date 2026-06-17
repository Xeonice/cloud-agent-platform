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
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

import 'reflect-metadata';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const providerSrc = join(__dirname, 'aio-sandbox.provider.ts');
// The provider now imports `assertSafeProviderUrl` from
// `../settings/assert-safe-provider-url` (the SSRF guard shared with discovery,
// design D4). It is owned by the discovery-hardening track. When present we
// compile the REAL module so the isolated test exercises the genuine guard; when
// this track is built in isolation (before that file lands) we emit a faithful
// JS stub beside the compiled provider so its `require('../settings/...')`
// resolves and the unsafe-URL branch is still driven end to end.
const assertSafeProviderUrlSrc = join(
  __dirname,
  '..',
  'settings',
  'assert-safe-provider-url.ts',
);
const hasRealAssertSafeProviderUrl = existsSync(assertSafeProviderUrlSrc);

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

/**
 * Decode the config.toml text the provider injects. The injection command writes
 * config.toml via `printf %s '<base64>' | base64 -d > .../config.toml`, so we
 * pull the single-quoted base64 payload that immediately precedes the
 * config.toml redirect and base64-decode it back to TOML — exercising the same
 * payload the sandbox would decode. Returns '' when no config.toml write is found.
 */
function decodeInjectedConfigToml(command) {
  // Match the base64 payload feeding the config.toml redirect specifically (the
  // command may also carry an auth.json payload for official material).
  const m = command.match(/'([A-Za-z0-9+/=]+)'\s*\|\s*base64 -d\s*>\s*\/home\/gem\/\.codex\/config\.toml/);
  if (!m) return '';
  return Buffer.from(m[1], 'base64').toString('utf8');
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
  //
  // The provider imports the SSRF guard `../settings/assert-safe-provider-url`
  // (owned by the discovery-hardening track). When that real module is present we
  // compile IT; when this track is built in isolation (before that file lands) we
  // drop a faithful temp `.ts` stub into apps/api/src/settings/ so tsc can both
  // type-check the import AND emit a `settings/assert-safe-provider-url.js` the
  // compiled provider's require resolves to. The temp stub is removed in the
  // outer finally. {@link assertSafeProviderUrlCompileSrc} resolves to whichever.
  const compileSrc = assertSafeProviderUrlCompileSrc();
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
      join(__dirname, 'skill-allowlist.ts'),
      // The provider now imports the minimal tar reader (`./tar-extract`) for the
      // read-only rollout extraction (session-sandbox-retention 3.5). Listed so
      // its .js is emitted beside provider.js and the require resolves.
      join(__dirname, 'tar-extract.ts'),
      // The SSRF guard (real module or temp stub) — so its .js lands under
      // outDir/settings and the provider's `require('../settings/...')` resolves.
      compileSrc,
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
  const providerJs = existsSync(flat)
    ? flat
    : existsSync(join(outDir, 'sandbox', 'aio-sandbox.provider.js'))
      ? join(outDir, 'sandbox', 'aio-sandbox.provider.js')
      : findFile(outDir, 'aio-sandbox.provider.js');
  if (!providerJs) {
    throw new Error('compiled aio-sandbox.provider.js not found under ' + outDir);
  }
  return providerJs;
}

/** Path of the temp SSRF-guard stub written when the real module is absent. */
const stubTsPath = join(apiRoot, 'src', 'settings', 'assert-safe-provider-url.ts');
let wroteStub = false;

/**
 * Resolve the SSRF-guard source to compile: the real module when it exists,
 * otherwise a temp `.ts` stub written into apps/api/src/settings/ (tracked for
 * removal via {@link wroteStub}). The stub mirrors the real guard's contract —
 * async, throws on a non-http(s) scheme or a loopback/private/link-local/metadata
 * host — so the provider's unsafe-URL branch is driven for real in isolation.
 */
function assertSafeProviderUrlCompileSrc() {
  if (hasRealAssertSafeProviderUrl) return assertSafeProviderUrlSrc;
  mkdirSync(dirname(stubTsPath), { recursive: true });
  writeFileSync(stubTsPath, ASSERT_SAFE_PROVIDER_URL_STUB, 'utf8');
  wroteStub = true;
  return stubTsPath;
}

/** Remove the temp SSRF-guard stub if this run wrote one. */
function cleanupStub() {
  if (wroteStub) rmSync(stubTsPath, { force: true });
}

/**
 * A faithful TypeScript stub of `../settings/assert-safe-provider-url` for the
 * isolated provider build (the real module is owned by the discovery-hardening
 * track). Same contract the provider depends on: `assertSafeProviderUrl(url)` is
 * async and THROWS for a non-http(s) scheme or a loopback/private/link-local/
 * metadata host; resolves otherwise. Hostname DNS is not performed here — the
 * test only feeds literal-IP / localhost / scheme cases, which is what the
 * provider's unsafe-URL branch needs to be exercised.
 */
const ASSERT_SAFE_PROVIDER_URL_STUB = `export class UnsafeProviderUrlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UnsafeProviderUrlError';
  }
}
function unsafeIpv4(a: string): boolean {
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}
export async function assertSafeProviderUrl(baseUrl: string): Promise<URL> {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new UnsafeProviderUrlError('malformed_url', 'bad url'); }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') throw new UnsafeProviderUrlError('unsupported_scheme', scheme);
  const host = url.hostname;
  if (!host) throw new UnsafeProviderUrlError('missing_host', 'no host');
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '::1' || lower === '::') throw new UnsafeProviderUrlError('unsafe_host', host);
  if (/^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(host) && unsafeIpv4(host)) throw new UnsafeProviderUrlError('unsafe_host', host);
  if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) throw new UnsafeProviderUrlError('unsafe_host', host);
  return url;
}
`;

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
function makeLookup(cloneUrl = null, taskPrompt = null, taskSkills = []) {
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
    // task-preinstall-skills: the provider resolves the task's selected skill ids
    // through this port and preinstalls each allowlisted one (fail-soft).
    async getTaskSkills() {
      return taskSkills;
    },
  };
}

/**
 * Stub {@link CodexAuthSource}: returns fixed material (or null to skip codex
 * auth injection). Returning null keeps these option/clone-focused assertions
 * from seeing an extra `/v1/shell/exec` (the credential write) before the clone.
 *
 * Material is the discriminated union (wire-compatible-provider-execution D2):
 * `{ kind:'official', authJson }` or `{ kind:'compatible', baseUrl, apiKey,
 * model }`. For backward-compat with the option/clone tests that pass a bare
 * `{ authJson }`, an untagged object is treated as `kind:'official'`.
 *
 * `getCodexAuth(taskId)` is now OWNER-SCOPED (design D3): it receives the task
 * id. The stub records every received id on `receivedTaskIds` so a test can
 * assert the provider passes the task identity through, and may map material per
 * task id (the owner-scope resolution test) via the `byTaskId` lookup.
 */
function makeCodexAuthSource(material = null, byTaskId = null) {
  const normalize = (m) =>
    m && typeof m === 'object' && m.kind === undefined && 'authJson' in m
      ? { kind: 'official', ...m }
      : m;
  const source = {
    receivedTaskIds: [],
    async getCodexAuth(taskId) {
      source.receivedTaskIds.push(taskId);
      if (byTaskId) return normalize(byTaskId[taskId] ?? null);
      return normalize(material);
    },
  };
  return source;
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

    // RETENTION D1: AutoRemove must be false so a stopped container is NOT
    // auto-deleted by the daemon — it is kept for read-only history replay.
    assert(
      opts?.HostConfig?.AutoRemove === false,
      'HostConfig.AutoRemove is false (settled container retained, not auto-removed)',
    );

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
      // 3.5 (official path unchanged): official material writes NO compatible
      // [model_providers.cap] provider block — that belongs to compatible mode.
      const configCall = authMock.fetchCalls.find(
        (c) =>
          c.url.endsWith('/v1/shell/exec') &&
          JSON.parse(c.init.body).command.includes('/home/gem/.codex/config.toml'),
      );
      const officialConfigCmd = configCall
        ? JSON.parse(configCall.init.body).command
        : '';
      const officialConfigToml = officialConfigCmd
        ? decodeInjectedConfigToml(officialConfigCmd)
        : '';
      assert(
        !officialConfigToml.includes('[model_providers.cap]'),
        'official material does NOT write a compatible [model_providers.cap] block',
      );
    } finally {
      authMock.restore();
    }

    // ---- 3.5: compatible material → config.toml provider block, NO auth.json ----
    // A compatible credential makes the provider APPEND a [model_providers.cap]
    // block (base_url + wire_api="responses" + experimental_bearer_token) plus
    // top-level model/model_provider to config.toml (per codex 0.131, task 3.1),
    // base64-decoded in-container, and writes NO auth.json for the custom provider.
    const compatMock = installFetchMock(0, '');
    try {
      // A literal PUBLIC IP host (RFC 5737 TEST-NET-3, non-private/non-loopback)
      // so the REAL assertSafeProviderUrl classifies it directly with NO DNS —
      // hostnames like provider.example.com would force a live lookup the
      // hermetic test cannot rely on (and which fails closed → no block written).
      const baseUrl = 'https://203.0.113.10/v1';
      const apiKey = 'sk-compat-secret-key';
      const model = 'gpt-4.1-mini';
      const pCompat = new AioSandboxProvider(
        makeLookup(null), // skip clone — isolate the credential-inject exec
        makeCodexAuthSource({ kind: 'compatible', baseUrl, apiKey, model }),
      );
      pCompat.docker = makeFakeDocker(makeFakeContainer());
      await pCompat.provision({ taskId: 'task-compat' });

      const configCall = compatMock.fetchCalls.find(
        (c) =>
          c.url.endsWith('/v1/shell/exec') &&
          JSON.parse(c.init.body).command.includes('/home/gem/.codex/config.toml'),
      );
      assert(configCall !== undefined, 'compatible material writes config.toml via /v1/shell/exec');
      const ccmd = configCall ? JSON.parse(configCall.init.body).command : '';
      const toml = decodeInjectedConfigToml(ccmd);
      assert(
        toml.includes('[model_providers.cap]'),
        'config.toml carries a [model_providers.cap] provider block',
      );
      assert(
        toml.includes(`base_url = "${baseUrl}"`),
        'the provider block base_url is the saved compatible Base URL',
      );
      assert(
        toml.includes('wire_api = "responses"'),
        'the provider block sets wire_api = "responses" (the only codex 0.131 value)',
      );
      assert(
        toml.includes(`experimental_bearer_token = "${apiKey}"`),
        'the decrypted key is delivered via experimental_bearer_token in the block',
      );
      assert(
        toml.includes('model_provider = "cap"') && toml.includes(`model = "${model}"`),
        'top-level model_provider = "cap" + model = "<defaultModel>" are emitted',
      );
      // TOML ordering: the bare top-level keys MUST precede EVERY table header,
      // else they would parse as keys nested under the first table ([projects.*]).
      const firstTableIdx = toml.search(/^\[/m);
      const modelIdx = toml.indexOf('model = ');
      const providerIdx = toml.indexOf('model_provider = ');
      assert(
        firstTableIdx > 0 &&
          modelIdx >= 0 &&
          modelIdx < firstTableIdx &&
          providerIdx >= 0 &&
          providerIdx < firstTableIdx,
        'top-level model/model_provider precede every [table] header (not nested under [projects.*])',
      );
      // The workspace trust block is preserved alongside the provider block.
      assert(
        toml.includes('trust_level = "trusted"'),
        'the workspace trust_level block is preserved alongside the provider block',
      );
      // NO auth.json is written for the compatible custom provider.
      const compatAuthCall = compatMock.fetchCalls.find(
        (c) =>
          c.url.endsWith('/v1/shell/exec') &&
          JSON.parse(c.init.body).command.includes('/home/gem/.codex/auth.json'),
      );
      assert(
        compatAuthCall === undefined,
        'compatible mode writes NO ~/.codex/auth.json (key rides config.toml, not auth.json)',
      );
      // The raw secret never appears outside the single-quoted base64 payload.
      assert(
        !ccmd.includes(apiKey),
        'the API key never appears as plaintext in the shell command (only inside the base64 payload)',
      );
    } finally {
      compatMock.restore();
    }

    // ---- 3.5: owner-scoped resolution — operator B's task gets B's credential ----
    // getCodexAuth is threaded the taskId so the source resolves the TASK OWNER's
    // credential. With a per-task material map, operator A's task and operator B's
    // task each receive THEIR OWN compatible provider — never the other's.
    {
      const orig = globalThis.fetch;
      let configCmd = '';
      // Literal PUBLIC IP hosts (RFC 5737 TEST-NET-3) so the real SSRF guard
      // accepts each without DNS while staying distinct per owner.
      const source = makeCodexAuthSource(null, {
        'task-owner-a': {
          kind: 'compatible',
          baseUrl: 'https://203.0.113.20/v1',
          apiKey: 'sk-key-a',
          model: 'model-a',
        },
        'task-owner-b': {
          kind: 'compatible',
          baseUrl: 'https://203.0.113.21/v1',
          apiKey: 'sk-key-b',
          model: 'model-b',
        },
      });
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          const cmd = JSON.parse(init.body).command;
          if (cmd.includes('/home/gem/.codex/config.toml')) configCmd = cmd;
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      let tomlB;
      try {
        const p = new AioSandboxProvider(makeLookup(null), source);
        p.docker = makeFakeDocker(makeFakeContainer());
        await p.provision({ taskId: 'task-owner-b' });
        tomlB = decodeInjectedConfigToml(configCmd);
      } finally {
        globalThis.fetch = orig;
      }
      assert(
        source.receivedTaskIds.includes('task-owner-b'),
        'the provider threads the taskId into getCodexAuth (owner-scoped resolution)',
      );
      assert(
        tomlB.includes('base_url = "https://203.0.113.21/v1"') &&
          tomlB.includes('experimental_bearer_token = "sk-key-b"') &&
          tomlB.includes('model = "model-b"'),
        "operator B's task is injected with operator B's credential, not A's",
      );
      assert(
        !tomlB.includes('203.0.113.20') && !tomlB.includes('sk-key-a'),
        "operator A's credential never leaks into operator B's task",
      );
    }

    // ---- 3.6: end-to-end smoke — the injected config IS what codex 0.131 consumes
    // The LIVE smoke (a real AIO sandbox + a real Responses-API provider, asserting
    // codex actually issues requests against the custom base_url + model and
    // authenticates via experimental_bearer_token) runs against a deployed sandbox
    // and cannot execute in this hermetic unit. Here we assert the OFFLINE
    // equivalent: provision drives the FULL injection path and the EXACT bytes the
    // sandbox decodes into ~/.codex/config.toml form a complete, self-consistent
    // codex 0.131 custom-provider config — top-level model/model_provider pointing
    // at the same [model_providers.cap] id, base_url = the custom URL, wire_api =
    // "responses", and the key inline as experimental_bearer_token — so a live
    // codex picks up THIS provider, key, and model with no further wiring. If a
    // live run shows experimental_bearer_token is unstable on 0.131, the design's
    // fallback is env_key + an injected process env var (recorded in D1/Risks).
    {
      const orig = globalThis.fetch;
      let configCmd = '';
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          const cmd = JSON.parse(init.body).command;
          if (cmd.includes('/home/gem/.codex/config.toml')) configCmd = cmd;
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      // Literal PUBLIC IP host (RFC 5737 TEST-NET-3) so the real SSRF guard
      // accepts it without DNS in this hermetic offline smoke.
      const baseUrl = 'https://203.0.113.30/v1';
      const apiKey = 'sk-smoke-e2e-key';
      const model = 'gpt-4.1';
      let toml;
      try {
        const p = new AioSandboxProvider(
          makeLookup(null),
          makeCodexAuthSource({ kind: 'compatible', baseUrl, apiKey, model }),
        );
        p.docker = makeFakeDocker(makeFakeContainer());
        await p.provision({ taskId: 'task-smoke-e2e' });
        toml = decodeInjectedConfigToml(configCmd);
      } finally {
        globalThis.fetch = orig;
      }
      // The top-level model_provider names the SAME provider id the block defines —
      // a mismatch would leave codex pointing at an undefined provider.
      const providerId = (toml.match(/model_provider = "([^"]+)"/) || [])[1];
      assert(
        providerId === 'cap' && toml.includes(`[model_providers.${providerId}]`),
        '3.6 smoke: top-level model_provider names the SAME id the provider block defines',
      );
      assert(
        toml.includes(`base_url = "${baseUrl}"`) && toml.includes(`model = "${model}"`),
        '3.6 smoke: codex is pointed at the custom base_url + the selected model (not OpenAI defaults)',
      );
      assert(
        toml.includes('wire_api = "responses"') &&
          toml.includes(`experimental_bearer_token = "${apiKey}"`),
        '3.6 smoke: codex authenticates to the custom provider via experimental_bearer_token over the Responses API',
      );
    }

    // ---- 3.5: an UNSAFE compatible Base URL is NOT written into the sandbox ----
    // A Base URL resolving to a loopback/metadata host fails assertSafeProviderUrl,
    // so the provider skips the provider block (codex launches unauthenticated) and
    // NEVER writes that Base URL into config.toml — and never writes auth.json.
    for (const unsafe of [
      'http://169.254.169.254/v1', // cloud metadata
      'http://127.0.0.1:11434/v1', // loopback
      'http://localhost:8000/v1', // loopback name
    ]) {
      const unsafeMock = installFetchMock(0, '');
      try {
        const p = new AioSandboxProvider(
          makeLookup(null),
          makeCodexAuthSource({
            kind: 'compatible',
            baseUrl: unsafe,
            apiKey: 'sk-unsafe',
            model: 'm',
          }),
        );
        p.docker = makeFakeDocker(makeFakeContainer());
        // Provision still SUCCEEDS — an unsafe URL is skipped, not fatal.
        await p.provision({ taskId: `task-unsafe-${unsafe.length}` });
        const configCall = unsafeMock.fetchCalls.find(
          (c) =>
            c.url.endsWith('/v1/shell/exec') &&
            JSON.parse(c.init.body).command.includes('/home/gem/.codex/config.toml'),
        );
        const toml = configCall
          ? decodeInjectedConfigToml(JSON.parse(configCall.init.body).command)
          : '';
        assert(
          !toml.includes(unsafe) && !toml.includes('[model_providers.cap]'),
          `unsafe Base URL ${unsafe} is NOT written into config.toml (provider block skipped)`,
        );
        const authCall = unsafeMock.fetchCalls.find(
          (c) =>
            c.url.endsWith('/v1/shell/exec') &&
            JSON.parse(c.init.body).command.includes('/home/gem/.codex/auth.json'),
        );
        assert(
          authCall === undefined,
          `unsafe Base URL ${unsafe} writes no auth.json either (credential treated as unusable)`,
        );
      } finally {
        unsafeMock.restore();
      }
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

    // ---- task-preinstall-skills: selected allowlisted skills run their installers
    // A capturing fetch mock records every /v1/shell/exec command so we can assert
    // which installer commands ran. All exits 0 (happy path).
    {
      const cmds = [];
      const orig = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          cmds.push(JSON.parse(init.body).command);
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      try {
        const p = new AioSandboxProvider(
          makeLookup(null, null, ['openspec', 'bmad']),
          makeCodexAuthSource(),
        );
        p.docker = makeFakeDocker(makeFakeContainer());
        await p.provision({ taskId: 'task-skills' });
      } finally {
        globalThis.fetch = orig;
      }
      const openspecCmd = cmds.find((c) => /(^|\s)openspec init\b/.test(c));
      const bmadCmd = cmds.find((c) => c.includes('bmad-method'));
      assert(
        openspecCmd && openspecCmd.includes('--tools codex') && openspecCmd.includes('/home/gem/workspace'),
        'openspec skill runs the baked `openspec init --tools codex` against the workspace',
      );
      assert(
        bmadCmd && bmadCmd.includes('install') && bmadCmd.includes('--tools codex') && bmadCmd.includes('--yes'),
        'bmad skill runs its allowlisted install --tools codex --yes',
      );
      assert(
        cmds.every((c) => c.includes('< /dev/null') || !c.includes('npx')),
        'skill installer commands read stdin from /dev/null (non-interactive, no TTY)',
      );
    }

    // ---- a non-allowlisted skill id is NEVER executed --------------------------
    {
      const cmds = [];
      const orig = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          cmds.push(JSON.parse(init.body).command);
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      try {
        const p = new AioSandboxProvider(
          makeLookup(null, null, ['rm-rf-evil', 'openspec']),
          makeCodexAuthSource(),
        );
        p.docker = makeFakeDocker(makeFakeContainer());
        await p.provision({ taskId: 'task-skills-evil' });
      } finally {
        globalThis.fetch = orig;
      }
      assert(
        !cmds.some((c) => c.includes('rm-rf-evil')),
        'a non-allowlisted skill id is never serialized into an exec command',
      );
      assert(
        cmds.some((c) => /(^|\s)openspec init\b/.test(c)),
        'the allowlisted skill alongside it still installs',
      );
    }

    // ---- a failing skill installer is FAIL-SOFT (provision still succeeds) ------
    {
      const orig = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          const cmd = JSON.parse(init.body).command;
          // openspec installer fails (exit 1); everything else succeeds.
          const exit_code = /(^|\s)openspec init\b/.test(cmd) ? 1 : 0;
          return { ok: true, status: 200, async json() { return { data: { exit_code, output: exit_code ? 'install boom' : '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      let connection;
      let threw = false;
      try {
        const p = new AioSandboxProvider(makeLookup(null, null, ['openspec']), makeCodexAuthSource());
        p.docker = makeFakeDocker(makeFakeContainer());
        connection = await p.provision({ taskId: 'task-skill-softfail' });
      } catch {
        threw = true;
      } finally {
        globalThis.fetch = orig;
      }
      assert(!threw, 'a failing skill installer does NOT throw (fail-soft, not fail-closed)');
      assert(
        connection && connection.taskId === 'task-skill-softfail',
        'provision still returns the handle (codex launches without the failed skill)',
      );
    }

    // ---- no skills selected → no installer exec (no-op) ------------------------
    {
      const cmds = [];
      const orig = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          cmds.push(JSON.parse(init.body).command);
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      try {
        const p = new AioSandboxProvider(makeLookup(null, null, []), makeCodexAuthSource());
        p.docker = makeFakeDocker(makeFakeContainer());
        await p.provision({ taskId: 'task-no-skills' });
      } finally {
        globalThis.fetch = orig;
      }
      assert(
        !cmds.some((c) => c.includes('npx')),
        'no skills selected → no installer command is run (no-op)',
      );
    }

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

    // ---- V.2: a provision FAILURE after auth-inject STILL zeros auth.json ------
    // A provision that fails AFTER injectCodexAuth (here the clone exits non-zero)
    // tears down via the FAILURE path, where no connection was ever registered.
    // The pre-stop trim must STILL fire (reconstructed deterministic baseUrl) and
    // zero auth.json — a retained container must never hold a live credential.
    {
      const execCmds = [];
      const orig = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          const cmd = JSON.parse(init.body).command;
          execCmds.push(cmd);
          // git clone fails (exit 128); config/auth/trim execs succeed (exit 0).
          const exit_code = cmd.includes('git clone') ? 128 : 0;
          return { ok: true, status: 200, async json() { return { data: { exit_code, output: exit_code ? 'clone boom' : '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      const c = makeFakeContainer();
      let threw = false;
      try {
        const p = new AioSandboxProvider(
          makeLookup('https://example.test/repo.git'), // clone runs (and fails)
          makeCodexAuthSource({ authJson: '{"auth_mode":"chatgpt"}' }), // auth IS injected
        );
        p.docker = makeFakeDocker(c);
        await p.provision({ taskId: 'task-provfail-cred' });
      } catch {
        threw = true;
      } finally {
        globalThis.fetch = orig;
      }
      assert(threw, 'V.2: a post-auth provision failure (clone non-zero) rejects provision');
      const trim = execCmds.find(
        (cmd) =>
          cmd.includes('rm -rf /home/gem/.codex/cache') &&
          cmd.includes(': > /home/gem/.codex/auth.json'),
      );
      assert(
        trim !== undefined,
        'V.2: the provision-failure teardown ran the pre-stop trim (zeroing auth.json) despite no registered connection',
      );
      assert(
        c.calls.stopped >= 1 && c.calls.removed === 0,
        'V.2: the failed-provision container is stopped + retained (not removed)',
      );
    }

    // ---- retention D1/D4: settle = STOP-ONLY + pre-stop ~/.codex trim ----------
    // teardownSandbox must STOP (retain) the container — never remove — after a
    // best-effort trim that drops the codex cache/sqlite logs + zeroes auth.json
    // while KEEPING ~/.codex/sessions (the rollout).
    {
      const execCmds = [];
      const orig = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          execCmds.push(JSON.parse(init.body).command);
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      const retainContainer = makeFakeContainer();
      try {
        const p = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
        p.docker = makeFakeDocker(retainContainer);
        await p.provision({ taskId: 'task-retain' });
        const execsBefore = execCmds.length;
        await p.teardownSandbox('task-retain');
        assert(retainContainer.calls.stopped >= 1, 'settle teardown STOPS the container');
        assert(
          retainContainer.calls.removed === 0,
          'settle teardown does NOT remove the container (kept as read-only history)',
        );
        const trimCmd = execCmds.slice(execsBefore).find((c) => c.includes('/home/gem/.codex'));
        assert(trimCmd !== undefined, 'teardown issues a pre-stop ~/.codex trim exec while the sandbox is live');
        assert(
          trimCmd.includes('auth.json'),
          'pre-stop trim zeroes auth.json (a kept container holds no live credential)',
        );
        assert(
          trimCmd.includes('cache') && trimCmd.includes('logs_'),
          'pre-stop trim drops the codex cache + sqlite logs (the trimmable bulk)',
        );
        assert(
          !/\bsessions\b/.test(trimCmd),
          'pre-stop trim KEEPS ~/.codex/sessions (the rollout) — it is never a delete target',
        );
      } finally {
        globalThis.fetch = orig;
      }
    }

    // ---- a trim failure (wedged sandbox) still stops + retains, never throws ----
    {
      const orig = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          const cmd = JSON.parse(init.body).command;
          // Fail ONLY the teardown trim (it truncates auth.json); provision execs ok.
          if (cmd.includes('> /home/gem/.codex/auth.json')) throw new Error('exec down');
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };
      const c = makeFakeContainer();
      let threw = false;
      try {
        const p = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
        p.docker = makeFakeDocker(c);
        await p.provision({ taskId: 'task-retain-trimfail' });
        await p.teardownSandbox('task-retain-trimfail');
      } catch {
        threw = true;
      } finally {
        globalThis.fetch = orig;
      }
      assert(!threw, 'a pre-stop trim failure never throws into the teardown caller');
      assert(
        c.calls.stopped >= 1 && c.calls.removed === 0,
        'a trim failure still stops + retains the container (no remove)',
      );
    }

    // ---- removeSandbox: the cleaner-only force-remove of a retained container ----
    {
      const c = makeFakeContainer();
      const p = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      p.docker = makeFakeDocker(c);
      await p.provision({ taskId: 'task-remove' });
      await p.removeSandbox('task-remove');
      assert(c.calls.removed >= 1, 'removeSandbox force-removes the (retained) container');

      // When the container was NOT provisioned by this process (cleaner removing a
      // prior process's container), removeSandbox addresses it by cap-aio-<id> name.
      let gotName;
      const removed = [];
      const p2 = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      p2.docker = {
        getContainer(name) {
          gotName = name;
          return { async remove() { removed.push(name); } };
        },
      };
      await p2.removeSandbox('task-orphan');
      assert(
        gotName === 'cap-aio-task-orphan',
        'removeSandbox addresses the container by cap-aio-<taskId> name when not in the live map',
      );
      assert(removed.length === 1, 'removeSandbox force-removes the addressed container');
    }

    // ---- 3.5: read the rollout out of a STOPPED container via getArchive --------
    // A minimal USTAR builder so the test feeds the real tar reader a real tar.
    function makeTar(entries) {
      const blocks = [];
      for (const { name, content } of entries) {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const header = Buffer.alloc(512);
        header.write(name, 0, 'utf8');
        header.write('0000644', 100, 'ascii');
        header.write('0000000', 108, 'ascii');
        header.write('0000000', 116, 'ascii');
        header.write(data.length.toString(8).padStart(11, '0'), 124, 'ascii');
        header.write('00000000000', 136, 'ascii');
        header[156] = '0'.charCodeAt(0);
        header.write('ustar\0', 257, 'ascii');
        header.write('00', 263, 'ascii');
        for (let i = 148; i < 156; i += 1) header[i] = 0x20;
        let sum = 0;
        for (let i = 0; i < 512; i += 1) sum += header[i];
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
        blocks.push(header, data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) blocks.push(Buffer.alloc(pad));
      }
      blocks.push(Buffer.alloc(1024)); // two zero blocks = archive end
      return Buffer.concat(blocks);
    }
    {
      const rolloutBody =
        '{"timestamp":"t","type":"session_meta","payload":{}}\n' +
        '{"timestamp":"t","type":"event_msg","payload":{"type":"user_message"}}\n';
      const tar = makeTar([
        // A history.jsonl sibling that MUST be ignored, plus the real rollout.
        { name: 'sessions/2026/06/11/history.jsonl', content: '{"ignored":true}\n' },
        { name: 'sessions/2026/06/11/rollout-2026-06-11T00-00-00-abc.jsonl', content: rolloutBody },
      ]);
      let archivePath;
      const c = {
        async start() {},
        async stop() {},
        async remove() {},
        async getArchive(opts) {
          archivePath = opts?.path;
          return Readable.from([tar]);
        },
      };
      const p = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      p.docker = makeFakeDocker(c);
      await p.provision({ taskId: 'task-rollout' });
      const text = await p.readRolloutFromContainer('task-rollout');
      assert(text === rolloutBody, 'readRolloutFromContainer returns the rollout JSONL text (not history.jsonl)');
      assert(
        archivePath === '/home/gem/.codex/sessions',
        'getArchive is scoped to ~/.codex/sessions only (never auth.json or any credential)',
      );
    }

    // ---- getArchive 404 / no rollout → null, never throws ----------------------
    {
      const c = {
        async start() {},
        async stop() {},
        async remove() {},
        async getArchive() {
          throw Object.assign(new Error('no such file or directory'), { statusCode: 404 });
        },
      };
      const p = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      p.docker = makeFakeDocker(c);
      await p.provision({ taskId: 'task-no-rollout' });
      let threw = false;
      let text;
      try {
        text = await p.readRolloutFromContainer('task-no-rollout');
      } catch {
        threw = true;
      }
      assert(!threw, 'readRolloutFromContainer never throws when the rollout is absent');
      assert(text === null, 'readRolloutFromContainer returns null when the container/rollout is gone');
    }

    // ---- 3.x: boot RE-ADOPTION — keep live-session sandboxes, reap only no-live ----
    // onApplicationBootstrap now lists RUNNING cap-aio-* and, per container, probes
    // the detached `task<taskId>` tmux session via POST /v1/shell/exec
    // (`tmux has-session`): a LIVE session is re-adopted (re-registered, NOT
    // removed); a RUNNING container with NO live session is force-removed; stopped
    // retained history is never even listed (status:['running'] filter).
    {
      // A fetch mock that answers the has-session probe per task: task-live exits 0
      // (alive), task-dead exits non-zero (gone). Any other exec is exit 0.
      const orig = globalThis.fetch;
      const probed = [];
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v1/shell/exec')) {
          const cmd = JSON.parse(init.body).command;
          if (cmd.startsWith('tmux has-session')) {
            probed.push({ url: u, cmd });
            // Alive when the probe targets the live task's named session.
            const exit_code = cmd.includes('task-live') ? 0 : 1;
            return { ok: true, status: 200, async json() { return { data: { exit_code, output: '' } }; } };
          }
          return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      };

      const removed = [];
      let listFilter;
      let listAll;
      const readoptDocker = {
        async listContainers(options) {
          listFilter = options?.filters;
          listAll = options?.all;
          // Only RUNNING cap-aio-* are listed (status:['running']); stopped
          // retained history is never returned here, so it is never reaped. One
          // container has a live codex session (re-adopt), one does not (reap).
          return [
            { Id: 'id-live', Names: ['/cap-aio-task-live'] },
            { Id: 'id-dead', Names: ['/cap-aio-task-dead'] },
          ];
        },
        getContainer(id) {
          return {
            // dockerode addresses both by Id (reap path) and by name (reregister).
            async remove() {
              removed.push(id);
            },
            async stop() {
              throw new Error('shutdown must not stop a re-adopted container');
            },
          };
        },
      };
      const pReadopt = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      pReadopt.docker = readoptDocker;
      try {
        await pReadopt.onApplicationBootstrap();
      } finally {
        globalThis.fetch = orig;
      }

      assert(
        Array.isArray(listFilter?.name) &&
          listFilter.name.some((n) => n.includes('cap-aio-')),
        'boot re-adoption lists containers filtered by the cap-aio- name prefix',
      );
      assert(
        Array.isArray(listFilter?.status) && listFilter.status.includes('running'),
        'boot re-adoption lists ONLY running containers (retention: stopped history is spared)',
      );
      assert(listAll === false, 'boot re-adoption does not list stopped containers (all:false)');
      assert(
        probed.some((p) => p.cmd === 'tmux has-session -t tasktask-live') &&
          probed.some((p) => p.cmd === 'tmux has-session -t tasktask-dead'),
        'boot re-adoption probes each RUNNING container with tmux has-session -t task<taskId>',
      );
      assert(
        removed.length === 1 && removed.includes('id-dead') && !removed.includes('id-live'),
        'boot re-adoption force-removes ONLY the running orphan with no live session (live one spared)',
      );
      const readoptable = await pReadopt.listReadoptable();
      assert(
        readoptable.includes('task-live') && !readoptable.includes('task-dead'),
        'the live-session task is surfaced as re-adoptable; the dead one is not',
      );

      // reattach(taskId) returns the addressable handle for a re-adopted task, and
      // null for an unknown one (nothing to re-attach).
      const handle = pReadopt.reattach('task-live');
      assert(
        handle &&
          handle.taskId === 'task-live' &&
          handle.baseUrl === 'http://cap-aio-task-live:8080' &&
          handle.wsUrl === 'ws://cap-aio-task-live:8080/v1/shell/ws',
        'reattach re-registers a re-adopted task and returns its addressable connection',
      );
      assert(
        pReadopt.reattach('task-unknown') === null,
        'reattach returns null for a task that was not re-adopted at boot',
      );

      // D5 — shutdown is NON-destructive: release in-memory handles WITHOUT stopping
      // the re-adopted running container (its getContainer().stop throws if called).
      let destroyThrew = false;
      try {
        pReadopt.onModuleDestroy();
      } catch {
        destroyThrew = true;
      }
      assert(!destroyThrew, 'onModuleDestroy does not stop provisioned/re-adopted sandboxes (handles released only)');
      assert(
        (await pReadopt.listReadoptable()).length === 0,
        'onModuleDestroy releases the in-memory re-adopted handles',
      );
    }

    // ---- REGRESSION (survive-api-redeploy split-brain): listReadoptable MUST
    // trigger the boot scan even when called BEFORE onApplicationBootstrap. In
    // production the tasks-service recovery hook ran first and called
    // listReadoptable() before the provider's own onApplicationBootstrap had
    // populated `readopted` → it read an EMPTY set and force-failed a live task
    // whose sandbox the provider then independently re-adopted (container alive,
    // task row failed). The memoized scan makes the result order-independent. ----
    {
      const orig = globalThis.fetch;
      const probed = [];
      globalThis.fetch = async (url, opts) => {
        // gem-server /v1/shell/exec liveness probe: the single task has a LIVE
        // session. Response shape is the AIO-nested `{ data: { exit_code } }`.
        const body = JSON.parse(opts?.body ?? '{}');
        probed.push(body.command);
        return { ok: true, status: 200, async json() { return { data: { exit_code: 0, output: '' } }; } };
      };
      let scans = 0;
      const pRace = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      pRace.docker = {
        async listContainers() {
          scans += 1; // count how many times the scan actually lists containers
          return [{ Id: 'id-live', Names: ['/cap-aio-task-race'] }];
        },
        getContainer() {
          return { async remove() {}, async stop() {} };
        },
      };
      try {
        // Call listReadoptable() FIRST — WITHOUT onApplicationBootstrap. The bug
        // would return [] here; the fix makes it trigger the scan and return the set.
        const first = await pRace.listReadoptable();
        // Now the provider's own hook fires (as Nest would, in either order).
        await pRace.onApplicationBootstrap();
        const second = await pRace.listReadoptable();
        assert(
          first.includes('task-race'),
          'listReadoptable() called BEFORE onApplicationBootstrap still triggers the scan (split-brain fix)',
        );
        assert(
          second.includes('task-race'),
          'listReadoptable() is stable after onApplicationBootstrap too',
        );
        assert(
          scans === 1,
          'the re-adoption scan runs EXACTLY ONCE (memoized) across listReadoptable + onApplicationBootstrap, in any order',
        );
      } finally {
        globalThis.fetch = orig;
      }
    }

    // ---- D5: shutdown does NOT stop a freshly-provisioned running sandbox --------
    // A normally-provisioned container must survive onModuleDestroy so the next
    // process re-adopts it; the old "stop every container on shutdown" is gone.
    {
      const c = makeFakeContainer();
      const p = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      p.docker = makeFakeDocker(c);
      await p.provision({ taskId: 'task-survive-shutdown' });
      assert(c.calls.started === 1, 'sandbox provisioned + started before shutdown');
      p.onModuleDestroy();
      assert(
        c.calls.stopped === 0 && c.calls.removed === 0,
        'onModuleDestroy leaves the running sandbox container alive (not stopped/removed)',
      );
    }

    // ---- boot re-adoption with no running containers — nothing reaped, no throw --
    {
      const removed2 = [];
      const pNone = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      pNone.docker = {
        async listContainers() {
          return [];
        },
        getContainer() {
          return { async remove() { removed2.push(1); } };
        },
      };
      await pNone.onApplicationBootstrap();
      assert(removed2.length === 0, 'boot re-adoption removes nothing when there are no running containers');
      assert((await pNone.listReadoptable()).length === 0, 'no running containers → nothing re-adopted');
    }

    // ---- a docker failure during boot re-adoption is swallowed (never blocks boot)
    {
      const pErr = new AioSandboxProvider(makeLookup(null), makeCodexAuthSource());
      pErr.docker = {
        async listContainers() {
          throw new Error('docker down');
        },
      };
      let readoptThrew = false;
      try {
        await pErr.onApplicationBootstrap();
      } catch {
        readoptThrew = true;
      }
      assert(!readoptThrew, 'boot re-adoption swallows docker errors (never blocks app startup)');
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
  cleanupStub();
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
