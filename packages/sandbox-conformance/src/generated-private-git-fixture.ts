import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_FIXTURE_HOST = '127.0.0.1';
const DEFAULT_LARGE_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_BACKEND_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_BACKEND_DIAGNOSTIC_BYTES = 1024 * 1024;

export interface GeneratedPrivateGitTransferBarrier {
  arm(): void;
  waitUntilBlocked(signal?: AbortSignal): Promise<void>;
  release(): void;
}

export interface GeneratedPrivateGitAuthorizationEvidence {
  readonly repository:
    | 'root-private'
    | 'same-origin-private'
    | 'cross-origin-public';
  readonly authorizationReceived: boolean;
  readonly authorized: boolean;
}

export interface GeneratedPrivateGitFixtureDiagnostics {
  readonly disposed: boolean;
  readonly barrierState: 'idle' | 'armed' | 'blocked' | 'released' | 'disposed';
  /** Current in-flight request count; zero is the teardown invariant. */
  readonly activeRequests: number;
  readonly activeRequestCount: number;
  /** Cumulative HTTP requests served by both fixture origins. */
  readonly totalRequestCount: number;
  /** Backward-compatible current-count names used by compiled integration tests. */
  readonly requestCount: number;
  readonly activeBackendProcesses: number;
  readonly activeBackendCount: number;
  readonly crossOriginAuthorizationLeakCount: number;
  readonly rootUploadPackRequests: {
    readonly lsRefs: number;
    readonly fetch: number;
    readonly other: number;
    readonly barrierBlocks: number;
  };
}

export interface GeneratedPrivateGitFixture {
  readonly rootUrl: string;
  readonly defaultBranch: 'master';
  readonly firstCommitSha: string;
  readonly headCommitSha: string;
  readonly basicAuth: {
    readonly username: string;
    readonly password: string;
    readonly authorizationHeader: string;
  };
  readonly largeBlob: {
    readonly path: 'large-fixture.bin';
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly submodules: {
    readonly sameOriginUrl: string;
    readonly crossOriginUrl: string;
    readonly sameOriginPath: 'modules/same-origin';
    readonly crossOriginPath: 'modules/cross-origin';
    readonly sameOriginPrivate: {
      readonly url: string;
      readonly path: 'modules/same-origin';
    };
    readonly crossOriginPublic: {
      readonly url: string;
      readonly path: 'modules/cross-origin';
    };
  };
  readonly transferBarrier: GeneratedPrivateGitTransferBarrier;
  authorizationEvidence(): readonly GeneratedPrivateGitAuthorizationEvidence[];
  diagnostics(): GeneratedPrivateGitFixtureDiagnostics;
  dispose(): Promise<void>;
}

export interface CreateGeneratedPrivateGitFixtureOptions {
  /** Defaults to a random, incompressible 4 MiB blob. */
  readonly largeBlobBytes?: number;
  /**
   * Address or DNS hostname used by the host-side HTTP servers. Defaults to
   * `127.0.0.1`. A wildcard bind requires an explicit `advertisedHost`.
   */
  readonly listenHost?: string;
  /**
   * Hostname or IP literal embedded in repository URLs that a guest can reach.
   * Defaults to the non-wildcard `listenHost`.
   */
  readonly advertisedHost?: string;
}

interface GeneratedPrivateGitFixtureNetwork {
  readonly listenHost: string;
  readonly advertisedUrlHost: string;
}

interface ValidatedFixtureHost {
  readonly host: string;
  readonly urlHost: string;
  readonly wildcard: boolean;
}

interface MutableDiagnostics {
  activeRequests: number;
  totalRequestCount: number;
  rootAuthorizedRequests: number;
  sameOriginAuthorizedRequests: number;
  originRejectedRequests: number;
  crossOriginRequests: number;
  crossOriginAuthorizationViolations: number;
  authorizationEvidence: GeneratedPrivateGitAuthorizationEvidence[];
  rootUploadPackRequests: {
    lsRefs: number;
    fetch: number;
    other: number;
    barrierBlocks: number;
  };
}

interface GitHttpServer {
  readonly server: Server;
  readonly baseUrl: string;
  readonly backendProcesses: Set<ChildProcess>;
  close(): Promise<void>;
}

function resolveFixtureNetwork(
  options: CreateGeneratedPrivateGitFixtureOptions,
): GeneratedPrivateGitFixtureNetwork {
  const listen = validateFixtureHost(
    options.listenHost === undefined
      ? DEFAULT_FIXTURE_HOST
      : options.listenHost,
    'listenHost',
  );
  if (listen.wildcard && options.advertisedHost === undefined) {
    throw new TypeError(
      'Generated private Git fixture advertisedHost is required for a wildcard listenHost',
    );
  }

  const advertised = validateFixtureHost(
    options.advertisedHost === undefined
      ? listen.host
      : options.advertisedHost,
    'advertisedHost',
  );
  if (advertised.wildcard) {
    throw new TypeError(
      'Generated private Git fixture advertisedHost must not be a wildcard address',
    );
  }

  return {
    listenHost: listen.host,
    advertisedUrlHost: advertised.urlHost,
  };
}

function validateFixtureHost(
  value: unknown,
  optionName: 'listenHost' | 'advertisedHost',
): ValidatedFixtureHost {
  const prefix = `Generated private Git fixture ${optionName}`;
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${prefix} must be a non-empty host without whitespace`);
  }
  if (value.length > 253 || value.includes('%')) {
    throw new TypeError(`${prefix} must be a plain hostname or IP literal`);
  }

  const addressFamily = isIP(value);
  if (addressFamily === 4) {
    return {
      host: value,
      urlHost: value,
      wildcard: value === '0.0.0.0',
    };
  }
  if (addressFamily === 6) {
    const parsed = new URL(`http://[${value}]/`);
    const canonicalHost = parsed.hostname.slice(1, -1).toLowerCase();
    return {
      host: canonicalHost,
      urlHost: `[${canonicalHost}]`,
      wildcard: canonicalHost === '::',
    };
  }

  const labels = value.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
    )
  ) {
    throw new TypeError(`${prefix} must be a plain hostname or IP literal`);
  }

  const canonicalHost = value.toLowerCase();
  const parsed = new URL(`http://${canonicalHost}/`);
  if (parsed.hostname !== canonicalHost) {
    throw new TypeError(`${prefix} uses an ambiguous hostname representation`);
  }
  return { host: canonicalHost, urlHost: canonicalHost, wildcard: false };
}

/**
 * Infrastructure-free real Git fixture used by integration tests.
 *
 * It serves smart HTTP through the host's `git http-backend`; no forge, Docker,
 * network service, or wall-clock delay is required. The origin is private and
 * accepts exactly one Basic header. A second origin is public but rejects any
 * Authorization header, which turns cross-origin credential leakage into a
 * deterministic failure instead of a passive assertion.
 */
export async function createGeneratedPrivateGitFixture(
  options: CreateGeneratedPrivateGitFixtureOptions = {},
): Promise<GeneratedPrivateGitFixture> {
  const network = resolveFixtureNetwork(options);
  const largeBlobBytes = options.largeBlobBytes ?? DEFAULT_LARGE_BLOB_BYTES;
  if (
    !Number.isSafeInteger(largeBlobBytes) ||
    largeBlobBytes < 2 * 1024 * 1024 ||
    largeBlobBytes > 16 * 1024 * 1024
  ) {
    throw new RangeError(
      'Generated private Git fixture blob must be an integer from 2 MiB to 16 MiB',
    );
  }

  const root = await mkdtemp(join(tmpdir(), 'cap-private-git-fixture-'));
  const originProjects = join(root, 'origin-projects');
  const crossOriginProjects = join(root, 'cross-origin-projects');
  const worktrees = join(root, 'worktrees');
  await Promise.all([
    mkdir(originProjects, { recursive: true }),
    mkdir(crossOriginProjects, { recursive: true }),
    mkdir(worktrees, { recursive: true }),
  ]);

  const username = 'cap-fixture';
  const password = `private-${randomUUID()}`;
  const authorizationValue = `Basic ${Buffer.from(`${username}:${password}`).toString(
    'base64',
  )}`;
  const authorizationHeader = `Authorization: ${authorizationValue}`;
  const diagnostics = createMutableDiagnostics();
  const transferBarrier = new TransferBarrier();
  let originServer: GitHttpServer | null = null;
  let crossOriginServer: GitHttpServer | null = null;
  let disposed = false;
  let disposalPromise: Promise<void> | null = null;

  try {
    originServer = await startGitHttpServer({
      projectRoot: originProjects,
      expectedAuthorization: authorizationValue,
      diagnostics,
      transferBarrier,
      kind: 'origin',
      ...network,
    });
    crossOriginServer = await startGitHttpServer({
      projectRoot: crossOriginProjects,
      expectedAuthorization: null,
      diagnostics,
      transferBarrier: null,
      kind: 'cross-origin',
      ...network,
    });

    const sameOriginUrl = `${originServer.baseUrl}/same-origin.git`;
    const crossOriginUrl = `${crossOriginServer.baseUrl}/cross-origin.git`;
    const sameOriginSha = await createSingleCommitBareRepository({
      barePath: join(originProjects, 'same-origin.git'),
      worktreePath: join(worktrees, 'same-origin'),
      fileName: 'same-origin.txt',
      content: 'private same-origin submodule\n',
    });
    const crossOriginSha = await createSingleCommitBareRepository({
      barePath: join(crossOriginProjects, 'cross-origin.git'),
      worktreePath: join(worktrees, 'cross-origin'),
      fileName: 'cross-origin.txt',
      content: 'public cross-origin submodule\n',
    });
    const generated = await createRootBareRepository({
      barePath: join(originProjects, 'root.git'),
      worktreePath: join(worktrees, 'root'),
      largeBlobBytes,
      sameOriginUrl,
      sameOriginSha,
      crossOriginUrl,
      crossOriginSha,
    });

    const stableOriginServer = originServer;
    const stableCrossOriginServer = crossOriginServer;
    const allBackendProcesses = () =>
      stableOriginServer.backendProcesses.size +
      stableCrossOriginServer.backendProcesses.size;

    return {
      rootUrl: `${stableOriginServer.baseUrl}/root.git`,
      defaultBranch: 'master',
      firstCommitSha: generated.firstCommitSha,
      headCommitSha: generated.headCommitSha,
      basicAuth: { username, password, authorizationHeader },
      largeBlob: {
        path: 'large-fixture.bin',
        bytes: largeBlobBytes,
        sha256: generated.largeBlobSha256,
      },
      submodules: {
        sameOriginUrl,
        crossOriginUrl,
        sameOriginPath: 'modules/same-origin',
        crossOriginPath: 'modules/cross-origin',
        sameOriginPrivate: {
          url: sameOriginUrl,
          path: 'modules/same-origin',
        },
        crossOriginPublic: {
          url: crossOriginUrl,
          path: 'modules/cross-origin',
        },
      },
      transferBarrier,
      authorizationEvidence: () =>
        diagnostics.authorizationEvidence.map((entry) => ({ ...entry })),
      diagnostics: () => ({
        disposed,
        barrierState: transferBarrier.state,
        activeRequests: diagnostics.activeRequests,
        activeRequestCount: diagnostics.activeRequests,
        totalRequestCount: diagnostics.totalRequestCount,
        requestCount: diagnostics.activeRequests,
        activeBackendProcesses: allBackendProcesses(),
        activeBackendCount: allBackendProcesses(),
        crossOriginAuthorizationLeakCount:
          diagnostics.crossOriginAuthorizationViolations,
        rootUploadPackRequests: { ...diagnostics.rootUploadPackRequests },
      }),
      dispose(): Promise<void> {
        if (disposalPromise !== null) return disposalPromise;
        disposed = true;
        transferBarrier.dispose();
        disposalPromise = (async () => {
          const closeResults = await Promise.allSettled([
            stableOriginServer.close(),
            stableCrossOriginServer.close(),
          ]);
          await rm(root, { recursive: true, force: true });
          const failures = closeResults.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              'Generated Git HTTP fixture did not dispose cleanly',
            );
          }
        })();
        return disposalPromise;
      },
    };
  } catch (error) {
    transferBarrier.dispose();
    await Promise.allSettled([
      originServer?.close() ?? Promise.resolve(),
      crossOriginServer?.close() ?? Promise.resolve(),
    ]);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

class TransferBarrier implements GeneratedPrivateGitTransferBarrier {
  private armed = false;
  private disposed = false;
  private blocked = deferred<void>();
  private released = deferred<void>();
  private currentState: GeneratedPrivateGitFixtureDiagnostics['barrierState'] =
    'idle';

  get state(): GeneratedPrivateGitFixtureDiagnostics['barrierState'] {
    return this.currentState;
  }

  arm(): void {
    if (this.disposed) throw new Error('Generated Git transfer barrier is disposed');
    if (this.armed) throw new Error('Generated Git transfer barrier is already armed');
    this.armed = true;
    this.currentState = 'armed';
    this.blocked = deferred<void>();
    this.released = deferred<void>();
  }

  async waitUntilBlocked(signal?: AbortSignal): Promise<void> {
    if (!this.armed) throw new Error('Generated Git transfer barrier is not armed');
    if (!signal) return this.blocked.promise;
    if (signal.aborted) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void this.blocked.promise.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
      if (signal.aborted) onAbort();
    });
  }

  release(): void {
    if (!this.armed) return;
    this.currentState = 'released';
    this.released.resolve();
  }

  async blockFetch(): Promise<boolean> {
    if (!this.armed || this.disposed) return false;
    this.currentState = 'blocked';
    this.blocked.resolve();
    await this.released.promise;
    this.armed = false;
    if (!this.disposed) this.currentState = 'idle';
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.released.resolve();
    this.blocked.resolve();
    this.armed = false;
    this.currentState = 'disposed';
  }
}

async function createSingleCommitBareRepository(args: {
  readonly barePath: string;
  readonly worktreePath: string;
  readonly fileName: string;
  readonly content: string;
}): Promise<string> {
  await initializeWorktree(args.worktreePath);
  await writeFile(join(args.worktreePath, args.fileName), args.content, 'utf8');
  await git(['add', '--', args.fileName], args.worktreePath);
  await git(['commit', '-m', 'fixture: initial commit'], args.worktreePath);
  const sha = await gitOutput(['rev-parse', 'HEAD'], args.worktreePath);
  await publishBareRepository(args.worktreePath, args.barePath);
  return sha;
}

async function createRootBareRepository(args: {
  readonly barePath: string;
  readonly worktreePath: string;
  readonly largeBlobBytes: number;
  readonly sameOriginUrl: string;
  readonly sameOriginSha: string;
  readonly crossOriginUrl: string;
  readonly crossOriginSha: string;
}): Promise<{
  readonly firstCommitSha: string;
  readonly headCommitSha: string;
  readonly largeBlobSha256: string;
}> {
  await initializeWorktree(args.worktreePath);
  await writeFile(
    join(args.worktreePath, 'README.md'),
    '# Generated private Git fixture\n',
    'utf8',
  );
  await git(['add', '--', 'README.md'], args.worktreePath);
  await git(['commit', '-m', 'fixture: root history one'], args.worktreePath);
  const firstCommitSha = await gitOutput(['rev-parse', 'HEAD'], args.worktreePath);

  const blob = randomBytes(args.largeBlobBytes);
  const largeBlobSha256 = createHash('sha256').update(blob).digest('hex');
  await writeFile(join(args.worktreePath, 'large-fixture.bin'), blob, {
    flag: 'wx',
    mode: 0o600,
  });
  blob.fill(0);
  await git(['add', '--', 'large-fixture.bin'], args.worktreePath);
  await git(['commit', '-m', 'fixture: incompressible transfer'], args.worktreePath);

  await writeFile(
    join(args.worktreePath, '.gitmodules'),
    `[submodule "same-origin"]\n` +
      `\tpath = modules/same-origin\n` +
      `\turl = ${args.sameOriginUrl}\n` +
      `[submodule "cross-origin"]\n` +
      `\tpath = modules/cross-origin\n` +
      `\turl = ${args.crossOriginUrl}\n`,
    'utf8',
  );
  await git(['add', '--', '.gitmodules'], args.worktreePath);
  await git(
    [
      'update-index',
      '--add',
      '--cacheinfo',
      '160000',
      args.sameOriginSha,
      'modules/same-origin',
    ],
    args.worktreePath,
  );
  await git(
    [
      'update-index',
      '--add',
      '--cacheinfo',
      '160000',
      args.crossOriginSha,
      'modules/cross-origin',
    ],
    args.worktreePath,
  );
  await git(['commit', '-m', 'fixture: exact-origin submodules'], args.worktreePath);
  const headCommitSha = await gitOutput(['rev-parse', 'HEAD'], args.worktreePath);
  await publishBareRepository(args.worktreePath, args.barePath);
  return { firstCommitSha, headCommitSha, largeBlobSha256 };
}

async function initializeWorktree(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(['init', '--initial-branch=master'], path);
  await git(['config', 'user.name', 'CAP Fixture'], path);
  await git(['config', 'user.email', 'fixture@cap.invalid'], path);
}

async function publishBareRepository(
  worktreePath: string,
  barePath: string,
): Promise<void> {
  await git(['init', '--bare', barePath]);
  await git(['remote', 'add', 'fixture-origin', barePath], worktreePath);
  await git(['push', 'fixture-origin', 'master:refs/heads/master'], worktreePath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/master'], barePath);
}

async function git(args: readonly string[], cwd?: string): Promise<void> {
  await execFileAsync('git', [...args], {
    ...(cwd ? { cwd } : {}),
    env: fixtureGitEnvironment(),
    maxBuffer: MAX_BACKEND_DIAGNOSTIC_BYTES,
  });
}

async function gitOutput(
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    ...(cwd ? { cwd } : {}),
    env: fixtureGitEnvironment(),
    maxBuffer: MAX_BACKEND_DIAGNOSTIC_BYTES,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

async function startGitHttpServer(args: {
  readonly projectRoot: string;
  readonly expectedAuthorization: string | null;
  readonly diagnostics: MutableDiagnostics;
  readonly transferBarrier: TransferBarrier | null;
  readonly kind: 'origin' | 'cross-origin';
  readonly listenHost: string;
  readonly advertisedUrlHost: string;
}): Promise<GitHttpServer> {
  const backendProcesses = new Set<ChildProcess>();
  const backendSettlements = new Map<ChildProcess, Promise<void>>();
  const handlerSettlements = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;
  const server = createServer((request, response) => {
    if (closing) {
      response.writeHead(503, { connection: 'close' }).end();
      return;
    }
    args.diagnostics.activeRequests += 1;
    args.diagnostics.totalRequestCount += 1;
    const handler = handleGitHttpRequest({
      ...args,
      request,
      response,
      backendProcesses,
      backendSettlements,
    })
      .catch(() => {
        if (!response.headersSent) response.statusCode = 500;
        if (!response.writableEnded) response.end();
      });
    handlerSettlements.add(handler);
    void handler.finally(() => {
      args.diagnostics.activeRequests -= 1;
      handlerSettlements.delete(handler);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, args.listenHost, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Generated Git fixture did not receive a TCP address');
  }
  return {
    server,
    baseUrl: `http://${args.advertisedUrlHost}:${address.port}`,
    backendProcesses,
    async close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closing = true;
      closePromise = (async () => {
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error?: Error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        server.closeAllConnections?.();
        for (const child of backendProcesses) child.kill('SIGKILL');
        await Promise.allSettled([...handlerSettlements]);
        for (const child of backendProcesses) child.kill('SIGKILL');
        await Promise.allSettled([...backendSettlements.values()]);
        await closed;
        if (
          handlerSettlements.size !== 0 ||
          backendProcesses.size !== 0 ||
          backendSettlements.size !== 0
        ) {
          throw new Error('Generated Git HTTP fixture did not drain cleanly');
        }
      })();
      return closePromise;
    },
  };
}

async function handleGitHttpRequest(args: {
  readonly projectRoot: string;
  readonly expectedAuthorization: string | null;
  readonly diagnostics: MutableDiagnostics;
  readonly transferBarrier: TransferBarrier | null;
  readonly kind: 'origin' | 'cross-origin';
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly backendProcesses: Set<ChildProcess>;
  readonly backendSettlements: Map<ChildProcess, Promise<void>>;
}): Promise<void> {
  const authorization = singleHeader(args.request.headers.authorization);
  const path = new URL(args.request.url ?? '/', 'http://fixture.invalid').pathname;
  if (path.includes('\0') || path.split('/').includes('..')) {
    args.response.writeHead(400).end();
    return;
  }

  if (args.kind === 'origin') {
    const repository = path.startsWith('/same-origin.git/')
      ? 'same-origin-private'
      : 'root-private';
    const authorized = authorization === args.expectedAuthorization;
    args.diagnostics.authorizationEvidence.push({
      repository,
      authorizationReceived: authorization !== undefined,
      authorized,
    });
    if (!authorized) {
      args.diagnostics.originRejectedRequests += 1;
      args.response.writeHead(401, {
        'www-authenticate': 'Basic realm="cap-private-git-fixture"',
      });
      args.response.end();
      return;
    }
    if (path.startsWith('/root.git/')) {
      args.diagnostics.rootAuthorizedRequests += 1;
    } else if (path.startsWith('/same-origin.git/')) {
      args.diagnostics.sameOriginAuthorizedRequests += 1;
    }
  } else {
    args.diagnostics.crossOriginRequests += 1;
    args.diagnostics.authorizationEvidence.push({
      repository: 'cross-origin-public',
      authorizationReceived: authorization !== undefined,
      authorized: authorization === undefined,
    });
    if (authorization) {
      args.diagnostics.crossOriginAuthorizationViolations += 1;
      args.response.writeHead(403).end();
      return;
    }
  }

  const body = await readBoundedRequestBody(args.request);
  const uploadPackKind = classifyUploadPackRequest(args.request, path, body);
  const isRootRepositoryRequest = path.startsWith('/root.git/');
  if (isRootRepositoryRequest) {
    args.diagnostics.rootUploadPackRequests[uploadPackKind] += 1;
  }
  if (
    isRootRepositoryRequest &&
    uploadPackKind === 'fetch' &&
    args.transferBarrier
  ) {
    if (await args.transferBarrier.blockFetch()) {
      args.diagnostics.rootUploadPackRequests.barrierBlocks += 1;
    }
    if (args.response.destroyed || args.response.writableEnded) return;
  }

  await runGitHttpBackend({ ...args, path, body });
}

async function runGitHttpBackend(args: {
  readonly projectRoot: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly backendProcesses: Set<ChildProcess>;
  readonly backendSettlements: Map<ChildProcess, Promise<void>>;
  readonly path: string;
  readonly body: Buffer;
}): Promise<void> {
  const requestUrl = new URL(
    args.request.url ?? args.path,
    'http://fixture.invalid',
  );
  let child!: ChildProcess;
  const output = new Promise<Buffer>((resolve, reject) => {
    child = execFile(
      'git',
      ['http-backend'],
      {
        env: {
          ...fixtureGitEnvironment(),
          GIT_PROJECT_ROOT: args.projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: args.request.method ?? 'GET',
          PATH_INFO: args.path,
          QUERY_STRING: requestUrl.search.slice(1),
          CONTENT_TYPE:
            singleHeader(args.request.headers['content-type']) ?? '',
          CONTENT_LENGTH: String(args.body.byteLength),
          REMOTE_ADDR: args.request.socket.remoteAddress ?? '127.0.0.1',
          REMOTE_USER: 'cap-fixture',
          HTTP_GIT_PROTOCOL:
            singleHeader(args.request.headers['git-protocol']) ?? '',
        },
        encoding: 'buffer',
        maxBuffer: MAX_BACKEND_OUTPUT_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('git http-backend failed'));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
  const settled = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  args.backendProcesses.add(child);
  args.backendSettlements.set(child, settled);
  const clientClosed = () => child.kill('SIGKILL');
  args.response.once('close', clientClosed);
  child.stdin?.end(args.body);
  try {
    const stdout = await output;
    if (args.response.destroyed || args.response.writableEnded) return;
    writeCgiResponse(args.response, stdout);
  } finally {
    args.response.off('close', clientClosed);
    args.backendProcesses.delete(child);
    args.backendSettlements.delete(child);
  }
}

function writeCgiResponse(response: ServerResponse, output: Buffer): void {
  let separator = output.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (separator < 0) {
    separator = output.indexOf('\n\n');
    separatorLength = 2;
  }
  if (separator < 0 || separator > 64 * 1024) {
    throw new Error('git http-backend returned invalid CGI headers');
  }
  const headerText = output.subarray(0, separator).toString('utf8');
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of headerText.split(/\r?\n/u)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name.toLowerCase() === 'status') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed)) status = parsed;
    } else {
      headers[name] = value;
    }
  }
  response.writeHead(status, headers);
  response.end(output.subarray(separator + separatorLength));
}

function classifyUploadPackRequest(
  request: IncomingMessage,
  path: string,
  body: Buffer,
): 'lsRefs' | 'fetch' | 'other' {
  if (request.method !== 'POST' || !path.endsWith('/git-upload-pack')) {
    return 'other';
  }
  const value = body.toString('latin1');
  if (value.includes('command=ls-refs')) return 'lsRefs';
  if (value.includes('command=fetch') || value.includes('want ')) return 'fetch';
  return 'other';
}

async function readBoundedRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new Error('Generated Git HTTP request exceeded the fixture limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function createMutableDiagnostics(): MutableDiagnostics {
  return {
    activeRequests: 0,
    totalRequestCount: 0,
    rootAuthorizedRequests: 0,
    sameOriginAuthorizedRequests: 0,
    originRejectedRequests: 0,
    crossOriginRequests: 0,
    crossOriginAuthorizationViolations: 0,
    authorizationEvidence: [],
    rootUploadPackRequests: {
      lsRefs: 0,
      fetch: 0,
      other: 0,
      barrierBlocks: 0,
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let resolver!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolver = next;
  });
  return {
    promise,
    resolve(value) {
      resolver(value as T | PromiseLike<T>);
    },
  };
}

/** Useful in diagnostics without returning fixture filesystem roots. */
export function generatedPrivateGitRepositoryName(url: string): string {
  return basename(new URL(url).pathname);
}
