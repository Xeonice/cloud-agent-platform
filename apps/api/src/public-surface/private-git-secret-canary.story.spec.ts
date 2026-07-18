import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { Logger } from '@nestjs/common';
import {
  PUBLIC_V1_OPERATIONS,
  RepoResponseSchema,
  TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES,
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticsResponseSchema,
  TaskResponseSchema,
  type TaskProvisioningStage,
  type TaskProvisioningDiagnosticEvent,
  type TaskProvisioningDiagnosticsResponse,
  type TaskResponse,
} from '@cap/contracts';
import {
  createExactHostGitCredential,
  createSandboxSecretFilePort,
  deliverSandboxGitWorkspaceStaged,
  materializeSandboxGitWorkspaceStaged,
  type SandboxCommandExecutionResult,
  type SandboxGitDeadlineDriver,
  type SandboxGitStageExecution,
  type SandboxWorkspaceProgressEvent,
} from '@cap/sandbox';
import { createGeneratedPrivateGitFixture } from '@cap/sandbox/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import { basicAuthHeader, type ForgeTarget } from '../forge/forge.port';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { GiteeForge } from '../forge/gitee-forge';
import {
  assertGitRuntimeAvailable,
  GitRuntimePreflightError,
} from '../forge/git-runtime-preflight';
import { GithubForge } from '../forge/github-forge';
import { GitlabForge } from '../forge/gitlab-forge';
import {
  RemoteRefsCommandRunner,
  type RemoteRefsCommandRequest,
  type RemoteRefsCommandResult,
} from '../forge/remote-refs-command-runner';
import { GitRemoteRefsProbe } from '../forge/remote-refs-probe';
import { NodeRemoteRefsSecretStore } from '../forge/remote-refs-secret-store';
import { TaskBranchResolver } from '../forge/task-branch-resolver';
import { McpServerFactory } from '../mcp/mcp.server';
import { buildV1OpenApiDocument } from '../openapi/openapi.registry';
import { PrismaService } from '../prisma/prisma.service';
import { ReposController } from '../repos/repos.controller';
import { ReposService } from '../repos/repos.service';
import { SandboxRunOwnerService } from '../sandbox/sandbox-run-owner.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import type { TaskProvisioningDiagnosticsPublicQueryService } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-public-query.service';
import { TaskProvisioningDiagnosticsMetricsService } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-metrics.service';
import { TaskProvisioningDiagnosticsService } from '../task-provisioning-diagnostics/task-provisioning-diagnostics.service';
import { TasksController } from '../tasks/tasks.controller';
import {
  taskResponseFromRecord,
  type TaskResponseRecord,
} from '../tasks/task-response';
import { TasksService } from '../tasks/tasks.service';
import { IdempotencyService } from '../v1/idempotency.service';
import { V1TaskProvisioningDiagnosticsController } from '../v1/v1-task-provisioning-diagnostics.controller';
import { V1TasksController } from '../v1/v1-tasks.controller';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const REPOSITORY_URL =
  'https://forge.example.test:8443/acme/private-repository.git';
const DIFFERENT_HOST_SUBMODULE_URL =
  'https://modules.example.test/acme/shared.git';
const DEFAULT_BRANCH = 'master';
const WORKSPACE_DIR = '/home/gem/workspace';
const CREATED_AT = new Date('2026-07-16T00:00:00.000Z');
const SANDBOX_METADATA = Object.freeze({
  schemaVersion: 1 as const,
  sandboxVersion: '0.33.0',
  dependencies: Object.freeze({ codex: '0.131.0' }),
});
const CHECKSUM_A = `sha256:${'a'.repeat(64)}`;
const CHECKSUM_B = `sha256:${'b'.repeat(64)}`;
const RAW_PROVIDER_ID_CANARY =
  'boxlite-native-provider-id-private-git-canary';
const DIAGNOSTIC_ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';
const DIAGNOSTIC_EVENT_ID = '77777777-7777-4777-8777-777777777777';
const DIAGNOSTIC_OPERATION_ID = '88888888-8888-4888-8888-888888888888';

const PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: OWNER_ID,
    githubId: null,
    login: null,
    name: 'Private Git canary owner',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
};
const REQUEST = { operatorPrincipal: PRINCIPAL } as AuthenticatedRequest;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface CanaryVariant {
  readonly label: string;
  readonly value: string;
}

class SecretCanaryGuard {
  readonly variants: readonly CanaryVariant[];

  constructor(readonly token: string) {
    const xAccessPair = `x-access-token:${token}`;
    const oauthPair = `oauth2:${token}`;
    const fixturePair = `cap-fixture:${token}`;
    const xAccessPayload = Buffer.from(xAccessPair, 'utf8').toString('base64');
    const oauthPayload = Buffer.from(oauthPair, 'utf8').toString('base64');
    const fixturePayload = Buffer.from(fixturePair, 'utf8').toString('base64');
    const candidates: CanaryVariant[] = [
      { label: 'raw-token', value: token },
      { label: 'x-access-token-pair', value: xAccessPair },
      { label: 'oauth2-pair', value: oauthPair },
      { label: 'fixture-basic-pair', value: fixturePair },
      { label: 'x-access-token-basic-payload', value: xAccessPayload },
      { label: 'oauth2-basic-payload', value: oauthPayload },
      { label: 'fixture-basic-payload', value: fixturePayload },
      {
        label: 'x-access-token-authorization',
        value: `Authorization: Basic ${xAccessPayload}`,
      },
      {
        label: 'oauth2-authorization',
        value: `Authorization: Basic ${oauthPayload}`,
      },
      {
        label: 'fixture-authorization',
        value: `Authorization: Basic ${fixturePayload}`,
      },
      {
        label: 'raw-token-base64',
        value: Buffer.from(token, 'utf8').toString('base64'),
      },
      {
        label: 'raw-token-base64url',
        value: Buffer.from(token, 'utf8').toString('base64url'),
      },
      { label: 'raw-token-uri-component', value: encodeURIComponent(token) },
      {
        label: 'x-access-token-uri-component',
        value: encodeURIComponent(xAccessPair),
      },
      { label: 'oauth2-uri-component', value: encodeURIComponent(oauthPair) },
      {
        label: 'fixture-pair-uri-component',
        value: encodeURIComponent(fixturePair),
      },
    ];
    this.variants = [
      ...new Map(candidates.map((entry) => [entry.value, entry])).values(),
    ];
  }

  get giteeAuthorizationHeader(): string {
    return this.variant('x-access-token-authorization');
  }

  assertAbsent(value: unknown, surface: string): void {
    const serialized = serializeForLeakScan(value);
    for (const variant of this.variants) {
      if (serialized.includes(variant.value)) {
        assert.fail(`${surface} contains forbidden canary form: ${variant.label}`);
      }
    }
  }

  /**
   * Deliberately hostile provider/private-Git payload used only as boundary
   * input. Every value-bearing field is forbidden from diagnostic storage and
   * public observability; callers must never retain this object.
   */
  forbiddenDiagnosticPayload(rawProviderId: string): Record<string, unknown> {
    const value = (index: number) =>
      this.variants[index % this.variants.length]!.value;
    const encoded =
      this.variants.find(({ label }) => label.includes('uri-component'))
        ?.value ?? encodeURIComponent(`x-access-token:${this.token}`);
    const base64 =
      this.variants.find(({ label }) => label === 'raw-token-base64')?.value ??
      Buffer.from(this.token, 'utf8').toString('base64');
    const cause = new Error(`provider cause ${value(2)}`);
    cause.stack = `Error: provider cause stack ${value(3)}`;
    const error = new Error(`provider error ${value(4)}`) as Error & {
      cause?: unknown;
    };
    error.cause = cause;
    error.stack = `Error: provider stack ${value(5)}`;

    return {
      command: value(0),
      argv: ['git', value(1), Buffer.from(this.token, 'utf8')],
      cwd: `/tmp/${encoded}`,
      prompt: value(2),
      stdout: value(3),
      stderr: value(4),
      error,
      cause,
      stack: error.stack,
      body: {
        token: value(5),
        encoded,
        base64,
        bytes: new Uint8Array(Buffer.from(this.token, 'utf8')),
      },
      wsReason: value(6),
      tokenUrl: `https://provider.example.test/attach?token=${encoded}`,
      header: this.giteeAuthorizationHeader,
      headers: { authorization: this.giteeAuthorizationHeader },
      temporaryPath: `/tmp/cap-git-credential-${encoded}`,
      providerSandboxId: rawProviderId,
      providerResourceId: rawProviderId,
      executionId: rawProviderId,
    };
  }

  private variant(label: string): string {
    const variant = this.variants.find((entry) => entry.label === label);
    assert.ok(variant, `missing canary form ${label}`);
    return variant.value;
  }
}

function serializeForLeakScan(value: unknown): string {
  const text: string[] = [];
  const seen = new WeakSet<object>();

  const visitBytes = (bytes: Uint8Array): void => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    text.push(
      buffer.toString('utf8'),
      buffer.toString('base64'),
      buffer.toString('base64url'),
      buffer.toString('hex'),
    );
  };
  const visit = (candidate: unknown): void => {
    if (candidate === null || candidate === undefined) return;
    if (typeof candidate === 'string') {
      text.push(candidate);
      return;
    }
    if (
      typeof candidate === 'number' ||
      typeof candidate === 'boolean' ||
      typeof candidate === 'bigint' ||
      typeof candidate === 'symbol'
    ) {
      text.push(String(candidate));
      return;
    }
    if (typeof candidate === 'function') {
      text.push(candidate.name);
      return;
    }
    if (Buffer.isBuffer(candidate) || candidate instanceof Uint8Array) {
      visitBytes(candidate);
      return;
    }
    if (candidate instanceof Date) {
      text.push(candidate.toISOString());
      return;
    }
    if (candidate instanceof URL) {
      text.push(candidate.toString());
      return;
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (candidate instanceof Error) {
      text.push(candidate.name, candidate.message, candidate.stack ?? '');
      visit((candidate as Error & { readonly cause?: unknown }).cause);
    } else if (candidate instanceof Map) {
      for (const [key, entry] of candidate) {
        visit(key);
        visit(entry);
      }
      return;
    } else if (candidate instanceof Set) {
      for (const entry of candidate) visit(entry);
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      text.push(key);
      visit(entry);
    }
  };

  visit(value);
  return text.join('\n');
}

function calibrateCanaryScanner(canary: SecretCanaryGuard): void {
  for (const variant of canary.variants) {
    assert.throws(
      () => canary.assertAbsent(variant.value, `scanner calibration ${variant.label}`),
      /contains forbidden canary form/u,
    );
  }

  const errorCause = new Error('safe cause');
  errorCause.stack = `Error: encoded cause ${canary.variants[3]!.value}`;
  const error = new Error('safe outer error') as Error & { cause?: unknown };
  error.cause = errorCause;
  error.stack = `Error: stack contains ${canary.token}`;
  const containers: readonly [string, unknown][] = [
    ['Error stack and cause', error],
    ['Map', new Map([['credential', canary.token]])],
    ['Set', new Set([canary.variants[4]!.value])],
    ['Buffer', Buffer.from(canary.token, 'utf8')],
    ['Uint8Array', new TextEncoder().encode(canary.variants[5]!.value)],
  ];
  for (const [label, value] of containers) {
    assert.throws(
      () => canary.assertAbsent(value, `scanner calibration ${label}`),
      /contains forbidden canary form/u,
    );
  }
}

function canonicalDiagnosticsForTask(
  taskId: string,
): TaskProvisioningDiagnosticsResponse {
  const fixture =
    TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES
      .partialPrimaryAndCleanup.value;
  return TaskProvisioningDiagnosticsResponseSchema.parse({
    ...fixture,
    taskId,
    attempts: fixture.attempts.map((attempt) => ({ ...attempt, taskId })),
    events: fixture.events.map((event) => ({ ...event, taskId })),
  });
}

function pathsContainingString(value: unknown, needle: string): string[] {
  const paths: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, path: string): void => {
    if (typeof candidate === 'string') {
      if (candidate.includes(needle)) paths.push(path);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (candidate instanceof Date) return;
    if (Buffer.isBuffer(candidate) || candidate instanceof Uint8Array) {
      if (Buffer.from(candidate).toString('utf8').includes(needle)) {
        paths.push(path);
      }
      return;
    }
    if (candidate instanceof Map) {
      let index = 0;
      for (const [key, entry] of candidate) {
        visit(key, `${path}.mapKey[${index}]`);
        visit(entry, `${path}.mapValue[${index}]`);
        index += 1;
      }
      return;
    }
    if (candidate instanceof Set) {
      let index = 0;
      for (const entry of candidate) visit(entry, `${path}.set[${index++}]`);
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      visit(entry, path ? `${path}.${key}` : key);
    }
  };
  visit(value, '');
  return paths.sort();
}

interface RepoRow extends Record<string, unknown> {
  readonly id: string;
  name: string;
  gitSource: string;
  forge: string | null;
  defaultBranch: string | null;
  description: string | null;
  githubId: string | null;
  gitlabProjectId: string | null;
  readonly createdAt: Date;
  updatedAt: Date | null;
  branchCount: number | null;
  isDefault: boolean;
}

class RepoPrismaFixture {
  readonly rows: RepoRow[] = [];
  readonly prisma: PrismaService;

  constructor() {
    const repo = {
      findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
        this.rows.find((row) => matchesWhere(row, where ?? {})) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: RepoRow = {
          id: REPO_ID,
          name: String(data.name),
          gitSource: String(data.gitSource),
          forge: typeof data.forge === 'string' ? data.forge : null,
          defaultBranch:
            typeof data.defaultBranch === 'string' ? data.defaultBranch : null,
          description:
            typeof data.description === 'string' ? data.description : null,
          githubId: typeof data.githubId === 'string' ? data.githubId : null,
          gitlabProjectId:
            typeof data.gitlabProjectId === 'string'
              ? data.gitlabProjectId
              : null,
          createdAt: CREATED_AT,
          updatedAt: null,
          branchCount: null,
          isDefault: false,
        };
        this.rows.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = this.rows.find((entry) => entry.id === where.id);
        assert.ok(row, `missing repo ${where.id}`);
        Object.assign(row, data, { updatedAt: CREATED_AT });
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where?: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of this.rows) {
          if (!matchesWhere(row, where ?? {})) continue;
          Object.assign(row, data, { updatedAt: CREATED_AT });
          count += 1;
        }
        return { count };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        this.rows.find((row) => row.id === where.id) ?? null,
      findMany: async () => [...this.rows],
    };
    const transactionClient = {
      repo,
      async $queryRaw(_query: unknown): Promise<readonly unknown[]> {
        return [];
      },
    };
    this.prisma = {
      repo,
      async $transaction(
        operation: (client: typeof transactionClient) => Promise<unknown>,
      ): Promise<unknown> {
        return operation(transactionClient);
      },
    } as unknown as PrismaService;
  }
}

function matchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (
      expected &&
      typeof expected === 'object' &&
      !Array.isArray(expected) &&
      'in' in expected
    ) {
      const values = (expected as { in?: readonly unknown[] }).in ?? [];
      return values.includes(row[key]);
    }
    return row[key] === expected;
  });
}

class CanaryRemoteRefsRunner extends RemoteRefsCommandRunner {
  readonly observations: Array<{
    readonly configPath: string;
    readonly mode: number;
    readonly exactHost: true;
    readonly authorization: true;
  }> = [];

  constructor(private readonly canary: SecretCanaryGuard) {
    super();
  }

  async run(
    request: RemoteRefsCommandRequest,
  ): Promise<RemoteRefsCommandResult> {
    this.canary.assertAbsent(request, 'remote refs argv and signal');
    const include = request.args.find((arg) => arg.startsWith('include.path='));
    assert.ok(include, 'refs probe must reference its private config by path');
    const configPath = include.slice('include.path='.length);
    const [config, configStat] = await Promise.all([
      readFile(configPath, 'utf8'),
      stat(configPath),
    ]);
    assert.equal(configStat.mode & 0o777, 0o600);
    assert.equal(
      occurrences(config, this.canary.giteeAuthorizationHeader),
      1,
      'the raw authorization header exists only in the private refs config',
    );
    assert.equal(
      config.includes('[http "https://forge.example.test:8443/"]'),
      true,
    );
    assert.equal(config.includes('modules.example.test'), false);
    this.observations.push({
      configPath,
      mode: configStat.mode & 0o777,
      exactHost: true,
      authorization: true,
    });
    return {
      exitCode: 0,
      stdout: `ref: refs/heads/${DEFAULT_BRANCH}\tHEAD\n0123456789abcdef\tHEAD\n`,
      stderr: '',
    };
  }
}

interface SecretWriteProof {
  readonly path: string;
  readonly mode: number;
  readonly exactHost: true;
  readonly authorization: true;
}

class RetainedWorkspaceSecretChannel {
  readonly activePaths = new Set<string>();
  readonly allPaths: string[] = [];
  readonly contentReferences: Uint8Array[] = [];
  readonly proofs: SecretWriteProof[] = [];
  readonly retainedWorkspaceFiles = new Set<string>();
  readonly guestFiles = new Map<string, Uint8Array | string>();
  readonly port: ReturnType<typeof createSandboxSecretFilePort>;
  private sequence = 0;

  constructor(private readonly canary: SecretCanaryGuard) {
    this.port = createSandboxSecretFilePort({
      directory: '/run/cap-secrets',
      createId: () => `canary-${++this.sequence}`,
      transport: {
        writeFile: async (request) => {
          const config = Buffer.from(request.content).toString('utf8');
          assert.equal(request.mode, 0o600);
          assert.equal(
            occurrences(config, this.canary.giteeAuthorizationHeader),
            1,
            'the authorization header exists only in the provider-private config',
          );
          assert.equal(
            config.includes('[http "https://forge.example.test:8443/"]'),
            true,
          );
          assert.equal(config.includes('modules.example.test'), false);
          this.activePaths.add(request.path);
          this.guestFiles.set(request.path, Buffer.from(request.content));
          this.allPaths.push(request.path);
          this.contentReferences.push(request.content);
          this.proofs.push({
            path: request.path,
            mode: request.mode,
            exactHost: true,
            authorization: true,
          });
        },
        deleteFile: async (request) => {
          this.activePaths.delete(request.path);
          this.guestFiles.delete(request.path);
        },
      },
    });
  }

  assertRetainedWorkspaceIsSecretFree(): void {
    assert.equal(
      [...this.retainedWorkspaceFiles].some((path) =>
        path.includes('cap-git-credential'),
      ),
      false,
    );
    assert.equal(this.activePaths.size, 0);
    assert.equal(
      [...this.guestFiles.keys()].some((path) =>
        path.includes('cap-git-credential'),
      ),
      false,
    );
    this.canary.assertAbsent(
      this.guestFiles,
      'retained guest filesystem paths and contents',
    );
    for (const content of this.contentReferences) {
      assert.equal(
        content.every((byte) => byte === 0),
        true,
        'the provider-private credential buffer must be zeroed after transport',
      );
    }
  }
}

class HostSecretFileChannel {
  readonly activePaths = new Set<string>();
  readonly writtenPaths = new Set<string>();
  readonly contentReferences: Uint8Array[] = [];
  readonly port: ReturnType<typeof createSandboxSecretFilePort>;
  private sequence = 0;

  private constructor(
    readonly directory: string,
    expectedAuthorizationHeader: string,
  ) {
    this.port = createSandboxSecretFilePort({
      directory,
      createId: () => `real-fixture-${++this.sequence}`,
      transport: {
        writeFile: async (request) => {
          const content = Buffer.from(request.content);
          assert.equal(request.mode, 0o600);
          assert.equal(content.includes(expectedAuthorizationHeader), true);
          await writeFile(request.path, content, {
            flag: 'wx',
            mode: request.mode,
          });
          await chmod(request.path, request.mode);
          assert.equal((await stat(request.path)).mode & 0o777, 0o600);
          this.activePaths.add(request.path);
          this.writtenPaths.add(request.path);
          this.contentReferences.push(request.content);
        },
        deleteFile: async (request) => {
          await rm(request.path, { force: true });
          this.activePaths.delete(request.path);
        },
      },
    });
  }

  static async create(
    root: string,
    expectedAuthorizationHeader: string,
  ): Promise<HostSecretFileChannel> {
    const directory = join(root, 'secrets');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return new HostSecretFileChannel(directory, expectedAuthorizationHeader);
  }

  async assertClean(): Promise<void> {
    assert.equal(this.activePaths.size, 0);
    assert.ok(this.writtenPaths.size > 0);
    for (const path of this.writtenPaths) await assert.rejects(stat(path));
    for (const content of this.contentReferences) {
      assert.equal(content.every((byte) => byte === 0), true);
    }
  }
}

class BoundedHostStageExecutor {
  readonly observations: SafeExecutionObservation[] = [];

  constructor(private readonly canary: SecretCanaryGuard) {}

  async execute(
    execution: SandboxGitStageExecution,
  ): Promise<SandboxCommandExecutionResult> {
    const environment = gitProcessEnvironment();
    this.canary.assertAbsent(
      {
        argv: ['/bin/sh', '-lc', execution.request.command],
        cwd: execution.request.cwd,
        environment,
      },
      'real fixture stage argv and environment',
    );
    this.observations.push({
      phase: 'real-generated-fixture',
      stage: execution.stage,
      command: execution.request.command,
      ...(execution.request.cwd === undefined
        ? {}
        : { cwd: execution.request.cwd }),
      timeoutMs: execution.request.timeoutMs,
    });

    return new Promise<SandboxCommandExecutionResult>((resolve) => {
      execFile(
        '/bin/sh',
        ['-lc', execution.request.command],
        {
          ...(execution.request.cwd === undefined
            ? {}
            : { cwd: execution.request.cwd }),
          env: environment,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          signal: execution.signal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const output = stderr || stdout;
          this.canary.assertAbsent(
            { stdout, stderr, error },
            'real fixture settled command output',
          );
          const errorCode =
            error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
          resolve({
            exitCode: execution.signal.aborted ? 124 : errorCode,
            output,
            stdout,
            stderr,
            timedOut: execution.signal.aborted,
          });
        },
      );
    });
  }
}

function gitProcessEnvironment(): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SSL_CERT_FILE
      ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE }
      : {}),
    ...(process.env.SSL_CERT_DIR
      ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR }
      : {}),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LC_ALL: 'C',
  };
}

async function inspectRetainedWorkspace(
  root: string,
): Promise<Map<string, Uint8Array | string>> {
  const files = new Map<string, Uint8Array | string>();
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath);
      if (entry.isSymbolicLink()) {
        files.set(relativePath, await readlink(absolutePath));
      } else if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() || (await lstat(absolutePath)).isFile()) {
        files.set(relativePath, await readFile(absolutePath));
      }
    }
  };
  await walk(root);
  return files;
}

interface SafeExecutionObservation {
  readonly phase: string;
  readonly stage: string;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

function observeExecution(
  canary: SecretCanaryGuard,
  observations: SafeExecutionObservation[],
  phase: string,
  execution: SandboxGitStageExecution,
): void {
  canary.assertAbsent(execution, `${phase} ordinary stage execution`);
  observations.push({
    phase,
    stage: execution.stage,
    command: execution.request.command,
    ...(execution.request.cwd === undefined
      ? {}
      : { cwd: execution.request.cwd }),
    timeoutMs: execution.request.timeoutMs,
  });
}

function commandResult(
  overrides: Partial<SandboxCommandExecutionResult> = {},
): SandboxCommandExecutionResult {
  return {
    exitCode: 0,
    output: '',
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

class ManualDeadline {
  private current = 0;
  private sequence = 0;
  private readonly scheduled = new Map<
    number,
    { readonly at: number; readonly trigger: () => void }
  >();

  readonly driver: SandboxGitDeadlineDriver = {
    now: () => this.current,
    schedule: (delayMs, trigger) => {
      const id = ++this.sequence;
      this.scheduled.set(id, { at: this.current + delayMs, trigger });
      return () => {
        this.scheduled.delete(id);
      };
    },
  };

  advance(milliseconds: number): void {
    this.current += milliseconds;
    const due = [...this.scheduled.entries()]
      .filter(([, timer]) => timer.at <= this.current)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      if (!this.scheduled.delete(id)) continue;
      timer.trigger();
    }
  }
}

interface SandboxRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly createdAt: Date;
  updatedAt: Date;
}

class SandboxRunDelegateFixture {
  readonly runs: SandboxRunRow[] = [];
  private sequence = 0;

  async findFirst(args: {
    readonly where?: Record<string, unknown>;
    readonly select?: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null> {
    const run = [...this.runs]
      .filter((entry) => matchesWhere(entry, args.where ?? {}))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    if (!run) return null;
    if (!args.select) return run;
    return Object.fromEntries(
      Object.entries(args.select)
        .filter(([, selected]) => selected)
        .map(([field]) => [field, run[field]]),
    );
  }

  async findMany(args: {
    readonly where?: Record<string, unknown>;
  }): Promise<readonly SandboxRunRow[]> {
    return this.runs.filter((entry) => matchesWhere(entry, args.where ?? {}));
  }

  async create({
    data,
  }: {
    readonly data: Record<string, unknown>;
  }): Promise<SandboxRunRow> {
    const now = new Date(CREATED_AT.getTime() + ++this.sequence);
    const row: SandboxRunRow = {
      id: `sandbox-run-${this.sequence}`,
      createdAt: now,
      updatedAt: now,
      providerSandboxId: null,
      ownerGeneration: null,
      resourceGeneration: null,
      createState: 'idle',
      terminalAt: null,
      removedAt: null,
      ...data,
    };
    this.runs.push(row);
    return row;
  }

  async update({
    where,
    data,
  }: {
    readonly where: { id: string };
    readonly data: Record<string, unknown>;
  }): Promise<SandboxRunRow> {
    const row = this.runs.find((entry) => entry.id === where.id);
    assert.ok(row, `missing sandbox run ${where.id}`);
    Object.assign(row, data, {
      updatedAt: new Date(row.updatedAt.getTime() + 1),
    });
    return row;
  }

  async updateMany({
    where,
    data,
  }: {
    readonly where?: Record<string, unknown>;
    readonly data: Record<string, unknown>;
  }): Promise<{ readonly count: number }> {
    let count = 0;
    for (const row of this.runs) {
      if (!matchesWhere(row, where ?? {})) continue;
      Object.assign(row, data, {
        updatedAt: new Date(row.updatedAt.getTime() + 1),
      });
      count += 1;
    }
    return { count };
  }
}

class DiagnosticEventStoreFixture {
  readonly rows: Record<string, unknown>[] = [];
  readonly prisma: PrismaService;
  transactionCount = 0;
  private eventCount = 0;

  constructor() {
    const transaction = {
      $queryRaw: async () => [{ acquired: true }],
      taskProvisioningDiagnosticAttempt: {
        findFirst: async () => ({
          id: DIAGNOSTIC_ATTEMPT_ID,
          taskId: TASK_ID,
          attempt: 1,
          admissionMode: 'durable',
          completenessMarkedAt: null,
          providerFamily: 'boxlite',
          state: 'active',
          eventCount: this.eventCount,
        }),
        updateMany: async ({ where }: { where: { eventCount: number } }) => {
          if (where.eventCount !== this.eventCount) return { count: 0 };
          this.eventCount += 1;
          return { count: 1 };
        },
      },
      taskProvisioningDiagnosticEvent: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          this.rows.push({ ...data });
          return data;
        },
      },
    };
    this.prisma = {
      $transaction: async (
        operation: (client: typeof transaction) => Promise<unknown>,
      ) => {
        this.transactionCount += 1;
        return operation(transaction);
      },
    } as unknown as PrismaService;
  }
}

function captureNestLogs(): {
  readonly entries: unknown[][];
  restore(): void;
} {
  const entries: unknown[][] = [];
  const prototype = Logger.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const originals = new Map<string, (...args: unknown[]) => unknown>();
  for (const method of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal']) {
    const original = prototype[method];
    if (typeof original !== 'function') continue;
    originals.set(method, original);
    prototype[method] = (...args: unknown[]) => {
      entries.push([method, ...args]);
    };
  }
  return {
    entries,
    restore() {
      for (const [method, original] of originals) prototype[method] = original;
    },
  };
}

test(
  'one private Git canary stays inside ephemeral exact-host secret channels',
  { timeout: 60_000 },
  async (t) => {
    const generatedFixture = await createGeneratedPrivateGitFixture({
      largeBlobBytes: 2 * 1024 * 1024,
    });
    const canary = new SecretCanaryGuard(generatedFixture.basicAuth.password);
    assert.equal(
      basicAuthHeader(generatedFixture.basicAuth.username, canary.token),
      generatedFixture.basicAuth.authorizationHeader,
    );
    calibrateCanaryScanner(canary);
    const realFixtureRoot = await mkdtemp(
      join(tmpdir(), 'cap-private-git-canary-story-'),
    );
    const logs = captureNestLogs();
    t.after(() => logs.restore());
    t.after(async () => {
      generatedFixture.transferBarrier.release();
      await rm(realFixtureRoot, { recursive: true, force: true });
      await generatedFixture.dispose();
      const diagnostics = generatedFixture.diagnostics();
      assert.equal(diagnostics.disposed, true);
      assert.equal(diagnostics.activeRequests, 0);
      assert.equal(diagnostics.activeBackendProcesses, 0);
      assert.equal(diagnostics.crossOriginAuthorizationLeakCount, 0);
    });

    const startupRequests: Array<{ readonly args: readonly string[] }> = [];
    await assertGitRuntimeAvailable({
      runner: {
        async run(request) {
          canary.assertAbsent(request, 'startup preflight argv and signal');
          assert.equal('env' in request, false);
          startupRequests.push({ args: [...request.args] });
          return {
            exitCode: 0,
            stdout: 'git version 2.50.1\n',
            stderr: `ignored startup diagnostic ${canary.token}`,
          };
        },
      },
    });
    const sanitizedStartupFailure = await (async () => {
      try {
        await assertGitRuntimeAvailable({
          runner: {
            async run(request) {
              canary.assertAbsent(
                request,
                'failing startup preflight argv and signal',
              );
              throw new Error(`ENOENT /private/${canary.token}/git`);
            },
          },
        });
        assert.fail('the missing startup dependency must fail closed');
      } catch (error) {
        assert.ok(error instanceof GitRuntimePreflightError);
        return error;
      }
    })();
    new Logger('PrivateGitCanaryStartup').error(sanitizedStartupFailure.message);
    canary.assertAbsent(
      { startupRequests, sanitizedStartupFailure },
      'startup preflight retained observations',
    );

    const repoDatabase = new RepoPrismaFixture();
    const forgeTarget: ForgeTarget = {
      kind: 'gitee',
      apiBaseUrl: 'https://forge.example.test:8443/api/v5',
      cloneUrl: REPOSITORY_URL,
      repoId: { style: 'owner-repo', owner: 'acme', repo: 'private-repository' },
      token: canary.token,
    };
    const forgeRegistry = new DefaultForgeRegistry(
      repoDatabase.prisma,
      new GithubForge(),
      new GiteeForge(),
      new GitlabForge(),
    );
    const forgeAuthorizationHeader = forgeRegistry
      .forKind(forgeTarget.kind)
      .cloneAuthHeader(forgeTarget);
    assert.equal(
      forgeAuthorizationHeader,
      canary.giteeAuthorizationHeader,
      'the story credential must be produced by the registered forge',
    );
    const forgeTargetResolver = {
      async resolveForOwner(
        ownerUserId: string,
        input: { readonly gitSource: string; readonly forge?: string },
      ) {
        assert.equal(ownerUserId, OWNER_ID);
        assert.equal(input.gitSource, REPOSITORY_URL);
        assert.equal(input.forge, 'gitee');
        return { ok: true as const, target: forgeTarget };
      },
    } as unknown as ForgeTargetResolver;
    const refsRunner = new CanaryRemoteRefsRunner(canary);
    const refsProbe = new GitRemoteRefsProbe(
      forgeRegistry,
      refsRunner,
      new NodeRemoteRefsSecretStore(),
    );
    const repos = new ReposService(
      repoDatabase.prisma,
      forgeTargetResolver,
      refsProbe,
      forgeRegistry,
    );
    const reposController = new ReposController(repos);
    const importedRepo = RepoResponseSchema.parse(
      await reposController.create(REQUEST, {
        name: 'Private Git canary repository',
        gitSource: REPOSITORY_URL,
        forge: 'gitee',
        importSource: 'url',
      }),
    );
    assert.equal(importedRepo.defaultBranch, DEFAULT_BRANCH);
    const refreshedRepo = RepoResponseSchema.parse(
      await reposController.refreshDefaultBranch(REQUEST, importedRepo.id),
    );
    assert.equal(refreshedRepo.id, importedRepo.id);
    assert.equal(refreshedRepo.defaultBranch, DEFAULT_BRANCH);
    assert.equal(refsRunner.observations.length, 2);
    for (const observation of refsRunner.observations) {
      await assert.rejects(
        () => access(observation.configPath),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT',
        'the refs credential directory must be absent after import/refresh',
      );
    }

    const recoveryBranchResolver = new TaskBranchResolver(
      {
        task: {
          async findUnique() {
            return {
              id: TASK_ID,
              branch: null,
              repo: {
                id: importedRepo.id,
                gitSource: importedRepo.gitSource,
                defaultBranch: refreshedRepo.defaultBranch,
              },
            };
          },
        },
        taskAdmissionWork: {
          async findUnique() {
            return { resolvedBranch: DEFAULT_BRANCH };
          },
          async updateMany() {
            assert.fail('recovery must consume the immutable existing snapshot');
          },
        },
      } as unknown as PrismaService,
      forgeTargetResolver,
      refsProbe,
    );
    const recoveryBranch = await recoveryBranchResolver.resolve(TASK_ID);
    assert.equal(recoveryBranch.source, 'snapshot');
    assert.equal(recoveryBranch.resolvedBranch, DEFAULT_BRANCH);
    canary.assertAbsent(recoveryBranch, 'task recovery branch snapshot');

    const credential = createExactHostGitCredential(
      REPOSITORY_URL,
      forgeAuthorizationHeader,
    );
    const secrets = new RetainedWorkspaceSecretChannel(canary);
    const executions: SafeExecutionObservation[] = [];
    const progress: SandboxWorkspaceProgressEvent[] = [];
    const workspacePlan = Object.freeze({
      repositoryUrl: REPOSITORY_URL,
      callerBranch: null,
      resolvedBranch: DEFAULT_BRANCH,
      deadlineMs: 60_000,
      credential,
    });

    // Controlled execution injects raw secret-bearing diagnostics at settlement
    // boundaries. A real generated smart-HTTP clone follows below and inspects the
    // complete retained tree. Delivery remains controlled because the generated
    // fixture is upload-pack-only; this story does not claim a receive-pack proof.
    const materialized = await materializeSandboxGitWorkspaceStaged({
      taskId: `${TASK_ID}-success`,
      plan: workspacePlan,
      workspaceDir: WORKSPACE_DIR,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          observeExecution(canary, executions, 'materialize-success', execution);
          if (execution.stage === 'workspace_transfer') {
            const headPath = `${WORKSPACE_DIR}/.git/HEAD`;
            secrets.retainedWorkspaceFiles.add(headPath);
            secrets.guestFiles.set(
              headPath,
              `ref: refs/heads/${DEFAULT_BRANCH}\n`,
            );
          }
          if (execution.stage === 'submodules') {
            const submodulePath = `${WORKSPACE_DIR}/vendor/shared/.git`;
            secrets.retainedWorkspaceFiles.add(submodulePath);
            secrets.guestFiles.set(
              submodulePath,
              `gitdir: ${WORKSPACE_DIR}/.git/modules/vendor/shared\n`,
            );
          }
          return commandResult();
        },
      },
      onProgress: (event) => {
        progress.push(event);
      },
    });
    assert.deepEqual(materialized, { status: 'succeeded', stage: 'complete' });
    const transfer = executions.find(
      (entry) =>
        entry.phase === 'materialize-success' &&
        entry.stage === 'workspace_transfer',
    );
    assert.ok(transfer?.command.includes('--single-branch'));
    assert.equal(transfer?.command.includes('--depth'), false);
    const submodules = executions.find(
      (entry) =>
        entry.phase === 'materialize-success' && entry.stage === 'submodules',
    );
    assert.ok(submodules?.command.includes('submodule update --init --recursive'));
    assert.equal(submodules?.command.includes(DIFFERENT_HOST_SUBMODULE_URL), false);
    secrets.assertRetainedWorkspaceIsSecretFree();

    const realWorkspaceDir = join(realFixtureRoot, 'workspace');
    const realSecrets = await HostSecretFileChannel.create(
      realFixtureRoot,
      generatedFixture.basicAuth.authorizationHeader,
    );
    const realExecutor = new BoundedHostStageExecutor(canary);
    const realProgress: SandboxWorkspaceProgressEvent[] = [];
    const realCredential = createExactHostGitCredential(
      generatedFixture.rootUrl,
      generatedFixture.basicAuth.authorizationHeader,
    );
    const realMaterialized = await materializeSandboxGitWorkspaceStaged({
      taskId: `${TASK_ID}-real-generated-fixture`,
      plan: {
        repositoryUrl: generatedFixture.rootUrl,
        callerBranch: null,
        resolvedBranch: generatedFixture.defaultBranch,
        deadlineMs: 30_000,
        credential: realCredential,
      },
      workspaceDir: realWorkspaceDir,
      secretFilePort: realSecrets.port,
      stageExecutor: realExecutor,
      onProgress: (event) => {
        realProgress.push(event);
      },
    });
    assert.deepEqual(realMaterialized, {
      status: 'succeeded',
      stage: 'complete',
    });
    await realSecrets.assertClean();
    const retainedWorkspace = await inspectRetainedWorkspace(realWorkspaceDir);
    assert.ok(retainedWorkspace.has('.git/config'));
    assert.ok(retainedWorkspace.has('.git/HEAD'));
    const retainedLargeBlob = retainedWorkspace.get(
      generatedFixture.largeBlob.path,
    );
    assert.ok(retainedLargeBlob instanceof Uint8Array);
    assert.equal(retainedLargeBlob.byteLength, generatedFixture.largeBlob.bytes);
    assert.ok(
      retainedWorkspace.has(
        `${generatedFixture.submodules.sameOriginPath}/same-origin.txt`,
      ),
    );
    assert.ok(
      retainedWorkspace.has(
        `${generatedFixture.submodules.crossOriginPath}/cross-origin.txt`,
      ),
    );
    assert.equal(
      [...retainedWorkspace.keys()].some((path) =>
        path.includes('cap-git-credential'),
      ),
      false,
    );
    canary.assertAbsent(
      retainedWorkspace,
      'entire real retained workspace including Git internals',
    );
    const realAuthorizationEvidence = generatedFixture.authorizationEvidence();
    const realRootEvidence = realAuthorizationEvidence.filter(
      (entry) => entry.repository === 'root-private',
    );
    const realSameOriginEvidence = realAuthorizationEvidence.filter(
      (entry) => entry.repository === 'same-origin-private',
    );
    const realCrossOriginEvidence = realAuthorizationEvidence.filter(
      (entry) => entry.repository === 'cross-origin-public',
    );
    assert.ok(realRootEvidence.length > 0);
    assert.ok(realSameOriginEvidence.length > 0);
    assert.ok(realCrossOriginEvidence.length > 0);
    assert.ok(
      realRootEvidence.every(
        (entry) => entry.authorizationReceived && entry.authorized,
      ),
    );
    assert.ok(
      realSameOriginEvidence.every(
        (entry) => entry.authorizationReceived && entry.authorized,
      ),
    );
    assert.ok(
      realCrossOriginEvidence.every(
        (entry) => !entry.authorizationReceived && entry.authorized,
      ),
    );
    assert.equal(
      generatedFixture.diagnostics().crossOriginAuthorizationLeakCount,
      0,
    );
    canary.assertAbsent(
      {
        result: realMaterialized,
        progress: realProgress,
        executions: realExecutor.observations,
        authorizationEvidence: realAuthorizationEvidence,
      },
      'real generated fixture observations',
    );

    const rawCloneFailure =
      `fatal: authentication failed while using ${canary.token}`;
    const failedMaterialization = await materializeSandboxGitWorkspaceStaged({
      taskId: `${TASK_ID}-failure`,
      plan: workspacePlan,
      workspaceDir: WORKSPACE_DIR,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          observeExecution(canary, executions, 'materialize-failure', execution);
          return execution.stage === 'remote_ref_resolution'
            ? commandResult({
                exitCode: 1,
                output: rawCloneFailure,
                stderr: rawCloneFailure,
              })
            : commandResult();
        },
      },
      onProgress: (event) => {
        progress.push(event);
      },
    });
    assert.deepEqual(failedMaterialization, {
      status: 'failed',
      stage: 'remote_ref_resolution',
      cause: 'authentication',
      retryable: false,
    });
    secrets.assertRetainedWorkspaceIsSecretFree();

    let deliveryAttempt: 'first' | 'retry' = 'first';
    let commitExecutions = 0;
    const deliveryPlan = Object.freeze({
      branch: `cap/task-${TASK_ID}`,
      commitMessage: `cap: deliver task ${TASK_ID}`,
      credential,
      deadlineMs: 60_000,
    });
    const deliveryExecutor = {
      async execute(
        execution: SandboxGitStageExecution,
      ): Promise<SandboxCommandExecutionResult> {
        observeExecution(
          canary,
          executions,
          `delivery-${deliveryAttempt}`,
          execution,
        );
        if (execution.request.command.includes(' commit -F ')) {
          commitExecutions += 1;
        }
        if (execution.stage === 'delivery_status') {
          return commandResult({
            output:
              deliveryAttempt === 'first'
                ? ' M changed.txt\n'
                : 'CAP_DELIVERY_PENDING\n',
          });
        }
        if (execution.request.command === 'git rev-parse HEAD') {
          return commandResult({ output: 'abc123\n' });
        }
        if (
          execution.stage === 'delivery_push' &&
          deliveryAttempt === 'first'
        ) {
          const rawPushFailure =
            `SSL certificate problem while using ${canary.token}`;
          return commandResult({
            exitCode: 1,
            output: rawPushFailure,
            stderr: rawPushFailure,
          });
        }
        return commandResult();
      },
    };
    const firstDelivery = await deliverSandboxGitWorkspaceStaged({
      taskId: `${TASK_ID}-delivery`,
      plan: deliveryPlan,
      workspaceDir: WORKSPACE_DIR,
      secretFilePort: secrets.port,
      stageExecutor: deliveryExecutor,
    });
    assert.deepEqual(firstDelivery, {
      hadChanges: true,
      commitSha: 'abc123',
      error: 'workspace_git_tls_network',
    });
    secrets.assertRetainedWorkspaceIsSecretFree();
    deliveryAttempt = 'retry';
    const retryDelivery = await deliverSandboxGitWorkspaceStaged({
      taskId: `${TASK_ID}-delivery`,
      plan: deliveryPlan,
      workspaceDir: WORKSPACE_DIR,
      secretFilePort: secrets.port,
      stageExecutor: deliveryExecutor,
    });
    assert.deepEqual(retryDelivery, {
      hadChanges: true,
      commitSha: 'abc123',
      error: null,
    });
    assert.equal(commitExecutions, 1, 'delivery retry must not duplicate the commit');
    secrets.assertRetainedWorkspaceIsSecretFree();

    const pushDeadline = new ManualDeadline();
    const pushTimeoutEntered = deferred<void>();
    const pushTimeoutStopped = deferred<SandboxCommandExecutionResult>();
    let pushTimeoutSettled = false;
    const pushTimeoutOperation = deliverSandboxGitWorkspaceStaged(
      {
        taskId: `${TASK_ID}-delivery-timeout`,
        plan: { ...deliveryPlan, deadlineMs: 400 },
        workspaceDir: WORKSPACE_DIR,
        secretFilePort: secrets.port,
        stageExecutor: {
          async execute(execution) {
            observeExecution(canary, executions, 'delivery-timeout', execution);
            if (execution.stage === 'delivery_status') {
              return commandResult({ output: ' M timeout.txt\n' });
            }
            if (execution.request.command === 'git rev-parse HEAD') {
              return commandResult({ output: 'timeout123\n' });
            }
            if (execution.stage === 'delivery_push') {
              pushTimeoutEntered.resolve();
              return pushTimeoutStopped.promise;
            }
            return commandResult();
          },
        },
      },
      { deadlineDriver: pushDeadline.driver },
    ).finally(() => {
      pushTimeoutSettled = true;
    });
    await pushTimeoutEntered.promise;
    assert.equal(secrets.activePaths.size, 1);
    pushDeadline.advance(400);
    assert.equal(pushTimeoutSettled, false);
    assert.equal(
      secrets.activePaths.size,
      1,
      'delivery timeout keeps the credential until the guest push settles',
    );
    pushTimeoutStopped.resolve(
      commandResult({
        exitCode: 1,
        output: `late push timeout diagnostic ${canary.token}`,
      }),
    );
    const pushTimedOut = await pushTimeoutOperation;
    assert.deepEqual(pushTimedOut, {
      hadChanges: true,
      commitSha: 'timeout123',
      error: 'workspace_git_timeout',
    });
    secrets.assertRetainedWorkspaceIsSecretFree();

    const pushCancellation = new AbortController();
    const pushCancelDeadline = new ManualDeadline();
    const pushCancelEntered = deferred<void>();
    const pushCancelStopped = deferred<SandboxCommandExecutionResult>();
    let pushCancellationSettled = false;
    const pushCancellationOperation = deliverSandboxGitWorkspaceStaged(
      {
        taskId: `${TASK_ID}-delivery-cancel`,
        plan: {
          ...deliveryPlan,
          cancellationSignal: pushCancellation.signal,
        },
        workspaceDir: WORKSPACE_DIR,
        secretFilePort: secrets.port,
        stageExecutor: {
          async execute(execution) {
            observeExecution(canary, executions, 'delivery-cancel', execution);
            if (execution.stage === 'delivery_status') {
              return commandResult({ output: ' M cancel.txt\n' });
            }
            if (execution.request.command === 'git rev-parse HEAD') {
              return commandResult({ output: 'cancel123\n' });
            }
            if (execution.stage === 'delivery_push') {
              pushCancelEntered.resolve();
              return pushCancelStopped.promise;
            }
            return commandResult();
          },
        },
      },
      { deadlineDriver: pushCancelDeadline.driver },
    ).finally(() => {
      pushCancellationSettled = true;
    });
    await pushCancelEntered.promise;
    assert.equal(secrets.activePaths.size, 1);
    pushCancellation.abort();
    assert.equal(pushCancellationSettled, false);
    assert.equal(
      secrets.activePaths.size,
      1,
      'delivery cancellation keeps the credential until the guest push settles',
    );
    pushCancelStopped.resolve(
      commandResult({
        exitCode: 1,
        output: `late push cancellation diagnostic ${canary.token}`,
      }),
    );
    const pushCancelled = await pushCancellationOperation;
    assert.deepEqual(pushCancelled, {
      hadChanges: true,
      commitSha: 'cancel123',
      error: 'workspace_git_cancelled',
    });
    secrets.assertRetainedWorkspaceIsSecretFree();

    const deadline = new ManualDeadline();
    const timeoutEntered = deferred<void>();
    const timeoutStopped = deferred<SandboxCommandExecutionResult>();
    let timeoutSettled = false;
    const timeoutOperation = materializeSandboxGitWorkspaceStaged(
      {
        taskId: `${TASK_ID}-timeout`,
        plan: { ...workspacePlan, deadlineMs: 500 },
        workspaceDir: WORKSPACE_DIR,
        secretFilePort: secrets.port,
        stageExecutor: {
          async execute(execution) {
            observeExecution(canary, executions, 'materialize-timeout', execution);
            if (execution.stage !== 'workspace_transfer') return commandResult();
            timeoutEntered.resolve();
            return timeoutStopped.promise;
          },
        },
        onProgress: (event) => {
          progress.push(event);
        },
      },
      { deadlineDriver: deadline.driver },
    ).finally(() => {
      timeoutSettled = true;
    });
    await timeoutEntered.promise;
    deadline.advance(500);
    assert.equal(timeoutSettled, false);
    assert.equal(secrets.activePaths.size, 1);
    timeoutStopped.resolve(
      commandResult({
        exitCode: 1,
        output: `late timeout diagnostic ${canary.token}`,
      }),
    );
    const timedOut = await timeoutOperation;
    assert.deepEqual(timedOut, {
      status: 'failed',
      stage: 'workspace_transfer',
      cause: 'timeout',
      retryable: true,
    });
    secrets.assertRetainedWorkspaceIsSecretFree();

    const cancellation = new AbortController();
    const cancelEntered = deferred<void>();
    const cancelStopped = deferred<SandboxCommandExecutionResult>();
    let cancellationSettled = false;
    const cancellationOperation = materializeSandboxGitWorkspaceStaged({
      taskId: `${TASK_ID}-cancel`,
      plan: workspacePlan,
      cancellationSignal: cancellation.signal,
      workspaceDir: WORKSPACE_DIR,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          observeExecution(canary, executions, 'materialize-cancel', execution);
          if (execution.stage !== 'workspace_transfer') return commandResult();
          cancelEntered.resolve();
          return cancelStopped.promise;
        },
      },
      onProgress: (event) => {
        progress.push(event);
      },
    }).finally(() => {
      cancellationSettled = true;
    });
    await cancelEntered.promise;
    cancellation.abort();
    assert.equal(cancellationSettled, false);
    assert.equal(secrets.activePaths.size, 1);
    cancelStopped.resolve(
      commandResult({
        exitCode: 1,
        output: `late cancellation diagnostic ${canary.token}`,
      }),
    );
    const cancelled = await cancellationOperation;
    assert.deepEqual(cancelled, {
      status: 'cancelled',
      stage: 'workspace_transfer',
    });
    secrets.assertRetainedWorkspaceIsSecretFree();

    const auditRows = new Map<string, Record<string, unknown>>();
    const audit = new AuditService({
      auditEvent: {
        async upsert({
          where,
          create,
        }: {
          where: { dedupeKey: string };
          create: Record<string, unknown>;
        }) {
          const existing = auditRows.get(where.dedupeKey);
          if (existing) return existing;
          auditRows.set(where.dedupeKey, create);
          return create;
        },
      },
    } as unknown as PrismaService);
    await audit.recordProvisioningProgress(
      `${TASK_ID}-failure`,
      'workspace_transfer',
      1,
    );
    assert.equal(
      await audit.recordProvisioningFailure(
        `${TASK_ID}-failure`,
        'workspace_transfer',
        1,
        {
          code: 'provisioning_tls_network_failed',
          message: `raw provider failure ${canary.token}`,
          action: 'retry_task',
          occurredAt: CREATED_AT,
        },
      ),
      true,
    );
    assert.equal(
      await audit.recordTaskCancellation(`${TASK_ID}-cancel`),
      true,
    );
    await audit.recordProvisioningProgress(
      `${TASK_ID}-invalid-log`,
      canary.token as TaskProvisioningStage,
      0,
    );
    assert.ok(logs.entries.length > 0, 'the story must capture a real log call');

    const diagnosticStore = new DiagnosticEventStoreFixture();
    const diagnosticRecorder = new TaskProvisioningDiagnosticsService(
      diagnosticStore.prisma,
    );
    const diagnosticContext = {
      taskId: TASK_ID,
      attemptId: DIAGNOSTIC_ATTEMPT_ID,
      attempt: 1,
      admissionMode: 'durable' as const,
    };
    const safeDiagnosticEvent: TaskProvisioningDiagnosticEvent = {
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      eventId: DIAGNOSTIC_EVENT_ID,
      idempotencyKey: 'private-git-canary:runtime-setup:terminal',
      taskId: TASK_ID,
      attemptId: DIAGNOSTIC_ATTEMPT_ID,
      attempt: 1,
      sequence: 1,
      operationId: DIAGNOSTIC_OPERATION_ID,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      channel: 'primary',
      commandKind: 'runtime_setup',
      outcome: 'failed',
      observedAt: CREATED_AT,
      durationMs: 25,
      cause: 'command_failed',
      retryable: false,
      nativeState: 'failed',
      exitCode: 9,
    };
    const forbiddenDiagnosticInput = {
      ...safeDiagnosticEvent,
      ...canary.forbiddenDiagnosticPayload(RAW_PROVIDER_ID_CANARY),
    };
    const rejectedDiagnostic = await diagnosticRecorder.appendEvent(
      diagnosticContext,
      forbiddenDiagnosticInput,
    );
    assert.deepEqual(rejectedDiagnostic, {
      ok: false,
      code: 'invalid_evidence',
      safeCause: 'coordination_failed',
    });
    assert.equal(
      diagnosticStore.transactionCount,
      0,
      'forbidden diagnostic fields must be rejected before any Prisma transaction',
    );
    assert.equal(diagnosticStore.rows.length, 0);

    const recordedDiagnostic = await diagnosticRecorder.appendEvent(
      diagnosticContext,
      safeDiagnosticEvent,
    );
    assert.equal(
      recordedDiagnostic.ok,
      true,
      `safe diagnostic event was rejected: ${JSON.stringify(recordedDiagnostic)}`,
    );
    assert.equal(diagnosticStore.transactionCount, 1);
    assert.equal(diagnosticStore.rows.length, 1);
    canary.assertAbsent(diagnosticStore.rows, 'diagnostic database rows');
    assert.equal(
      serializeForLeakScan(diagnosticStore.rows).includes(
        RAW_PROVIDER_ID_CANARY,
      ),
      false,
    );

    const diagnosticsMetrics = new TaskProvisioningDiagnosticsMetricsService(
      {} as PrismaService,
      { now: () => CREATED_AT.getTime() },
    );
    const safeMetricEvent = {
      providerFamily: 'boxlite',
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      outcome: 'failed',
      durationMs: 25,
      anomaly: null,
    } as const;
    diagnosticsMetrics.observeEvent({
      ...safeMetricEvent,
      ...canary.forbiddenDiagnosticPayload(RAW_PROVIDER_ID_CANARY),
    });
    diagnosticsMetrics.observeEvent(safeMetricEvent);
    diagnosticsMetrics.observeAttemptOutcome({
      providerFamily: 'boxlite',
      outcome: 'failed',
      cause: 'command_failed',
      retryable: false,
      durationMs: 25,
      ...canary.forbiddenDiagnosticPayload(RAW_PROVIDER_ID_CANARY),
    });
    diagnosticsMetrics.observeAttemptOutcome({
      providerFamily: 'boxlite',
      outcome: 'failed',
      cause: 'command_failed',
      retryable: false,
      durationMs: 25,
    });
    diagnosticsMetrics.observeCleanupTransition({
      providerFamily: 'boxlite',
      cleanupState: 'failed',
      cause: 'cleanup_failed',
      ...canary.forbiddenDiagnosticPayload(RAW_PROVIDER_ID_CANARY),
    });
    diagnosticsMetrics.observeCleanupTransition({
      providerFamily: 'boxlite',
      cleanupState: 'failed',
      cause: 'cleanup_failed',
    });
    const diagnosticMetricsSnapshot = diagnosticsMetrics.currentSnapshot();
    assert.equal(diagnosticMetricsSnapshot.stageOutcomes[0]?.count, 1);
    assert.equal(diagnosticMetricsSnapshot.attemptOutcomes[0]?.count, 1);
    assert.equal(diagnosticMetricsSnapshot.cleanupOutcomes[0]?.count, 1);
    canary.assertAbsent(diagnosticMetricsSnapshot, 'diagnostic metrics');
    assert.equal(
      serializeForLeakScan(diagnosticMetricsSnapshot).includes(
        RAW_PROVIDER_ID_CANARY,
      ),
      false,
    );

    const runDelegate = new SandboxRunDelegateFixture();
    const ownerStore = new SandboxRunOwnerService({
      sandboxRun: runDelegate,
    } as unknown as PrismaService);
    await ownerStore.recordSandboxRunOwner({
      taskId: TASK_ID,
      providerId: 'boxlite-canary',
      providerSandboxId: RAW_PROVIDER_ID_CANARY,
      status: 'running',
      connection: {
        taskId: TASK_ID,
        baseUrl: 'https://boxlite.example.test/sandboxes/current',
        wsUrl: 'wss://boxlite.example.test/sandboxes/current/ws',
      },
      metadata: {
        sandboxMetadata: SANDBOX_METADATA,
        token: canary.token,
        privateField: {
          authorizationHeader: canary.giteeAuthorizationHeader,
        },
      },
      environment: {
        id: '44444444-4444-4444-8444-444444444444',
        environmentId: '44444444-4444-4444-8444-444444444444',
        name: 'Canary BoxLite environment',
        providerId: 'boxlite-canary',
        providerFamily: 'boxlite',
        runtimeId: 'codex',
        sourceKind: 'boxlite-image',
        sourceRef: 'ghcr.io/xeonice/cap-boxlite-sandbox@sha256:safe',
        digest: CHECKSUM_A,
        checksum: CHECKSUM_B,
        runtimeArtifactChecksums: { codex: CHECKSUM_A },
        cliArtifactChecksum: CHECKSUM_A,
        validationId: '55555555-5555-4555-8555-555555555555',
        validationVersion: '1',
        contractVersion: '1',
        resources: { diskSizeGb: 8 },
        metadata: {
          immutableIdentity: CHECKSUM_A,
          fingerprint: CHECKSUM_B,
          sandboxMetadata: SANDBOX_METADATA,
          sandboxMetadataChecksum: CHECKSUM_A,
          cliVersion: '0.131.0',
          secret: canary.token,
        },
      },
    });
    const owner = await ownerStore.getSandboxRunOwner(TASK_ID);
    assert.ok(owner);
    assert.deepEqual(owner.metadata?.sandboxMetadata, SANDBOX_METADATA);
    canary.assertAbsent(runDelegate.runs, 'SandboxRun persisted rows');
    canary.assertAbsent(owner, 'SandboxRun owner read projection');
    assert.deepEqual(
      pathsContainingString(
        { persistedRuns: runDelegate.runs, owner },
        RAW_PROVIDER_ID_CANARY,
      ),
      ['owner.providerSandboxId', 'persistedRuns.0.providerSandboxId'],
      'a raw provider id may survive only in the existing internal ownership column and its internal read projection',
    );

    const taskRecord: TaskResponseRecord = {
      id: TASK_ID,
      repoId: importedRepo.id,
      prompt: 'verify private repository without exposing credentials',
      status: 'failed',
      failureCode: 'provisioning_tls_network_failed',
      failureAt: CREATED_AT,
      failureExitCode: null,
      createdAt: CREATED_AT,
      branch: DEFAULT_BRANCH,
      strategy: null,
      skills: [],
      idleTimeoutMs: null,
      deadlineMs: 60_000,
      runtime: 'codex',
      model: null,
      sandboxEnvironmentId: null,
      executionMode: 'headless-exec',
      deliver: 'branch',
      deliverStatus: 'failed',
      branchPushed: null,
      commitSha: null,
      changeRequestUrl: null,
      changeRequestNumber: null,
      admissionWork: {
        state: 'failed',
        stage: 'workspace_transfer',
        attempt: 1,
        resolvedBranch: DEFAULT_BRANCH,
        updatedAt: CREATED_AT,
      },
      sandboxRuns: [
        {
          providerId: 'boxlite-canary',
          metadata: runDelegate.runs[0]?.metadata,
        },
      ],
    };
    const projectedTask = TaskResponseSchema.parse(
      taskResponseFromRecord(taskRecord),
    );
    const taskService = {
      async findById(id: string): Promise<TaskResponse> {
        assert.equal(id, TASK_ID);
        return projectedTask;
      },
    } as unknown as TasksService;
    const tasksController = new TasksController(taskService);
    const v1TasksController = new V1TasksController(
      taskService,
      {} as PrismaService,
      {} as IdempotencyService,
    );
    const diagnosticProjection = canonicalDiagnosticsForTask(TASK_ID);
    const diagnosticsFacade = {
      async readForOwner(
        ownerUserId: string,
        taskId: string,
        query: { readonly limit: number; readonly cursor?: string },
      ): Promise<TaskProvisioningDiagnosticsResponse> {
        assert.equal(ownerUserId, OWNER_ID);
        assert.equal(taskId, TASK_ID);
        assert.equal(query.limit, 50);
        assert.equal(query.cursor, undefined);
        return diagnosticProjection;
      },
    } as unknown as TaskProvisioningDiagnosticsPublicQueryService;
    const v1DiagnosticsController =
      new V1TaskProvisioningDiagnosticsController(diagnosticsFacade);
    const mcpFactory = new McpServerFactory(
      taskService,
      repos,
      {} as never,
      {} as never,
      { assertOpen() {} } as never,
      repoDatabase.prisma,
      {} as never,
      {} as never,
      {} as SandboxProvider,
      diagnosticsFacade,
    );
    const consoleTask = await tasksController.findById(TASK_ID);
    const v1Task = await v1TasksController.findById(TASK_ID, REQUEST);
    const v1Diagnostics = await v1DiagnosticsController.read(
      TASK_ID,
      { limit: 50 },
      REQUEST,
    );
    assert.deepEqual(
      TaskProvisioningDiagnosticsResponseSchema.parse(v1Diagnostics),
      diagnosticProjection,
    );
    const mcpServer = mcpFactory.createServer();
    const mcpClient = new Client({
      name: 'private-git-secret-canary-story',
      version: '1.0.0',
    });
    t.after(async () => {
      await mcpClient.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      send(message, {
        ...options,
        authInfo: {
          token: 'safe_mcp_story_token',
          clientId: 'private-git-canary-story',
          scopes: ['tasks:read', 'tasks:diagnostics', 'repos:read'],
          expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
          extra: { userId: OWNER_ID },
        },
      });
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const mcpTask = await mcpClient.callTool({
      name: 'get_task',
      arguments: { id: TASK_ID },
    });
    assert.deepEqual(
      TaskResponseSchema.parse(mcpTask.structuredContent),
      projectedTask,
    );
    const mcpDiagnostics = await mcpClient.callTool({
      name: 'get_task_provisioning_diagnostics',
      arguments: { id: TASK_ID, limit: 50 },
    });
    const mcpDiagnosticsStructured =
      TaskProvisioningDiagnosticsResponseSchema.parse(
        mcpDiagnostics.structuredContent,
      );
    assert.deepEqual(mcpDiagnosticsStructured, diagnosticProjection);
    assert.ok(Array.isArray(mcpDiagnostics.content));
    const mcpDiagnosticsText = (
      mcpDiagnostics.content as Array<{
        readonly type?: string;
        readonly text?: string;
      }>
    ).find(
      (content) => content.type === 'text' && typeof content.text === 'string',
    );
    assert.ok(
      mcpDiagnosticsText?.type === 'text' &&
        typeof mcpDiagnosticsText.text === 'string',
    );
    assert.deepEqual(
      TaskProvisioningDiagnosticsResponseSchema.parse(
        JSON.parse(mcpDiagnosticsText.text) as unknown,
      ),
      diagnosticProjection,
    );

    const diagnosticsOperation = PUBLIC_V1_OPERATIONS.find(
      (operation) => operation.id === 'tasks.provisioningDiagnostics',
    );
    assert.ok(diagnosticsOperation);
    const openApiDocument = buildV1OpenApiDocument();
    const playgroundFixtures = diagnosticsOperation.responseExamples;
    assert.ok(playgroundFixtures);
    for (const example of Object.values(playgroundFixtures)) {
      assert.equal(
        TaskProvisioningDiagnosticsResponseSchema.safeParse(example.value)
          .success,
        true,
      );
    }
    canary.assertAbsent(openApiDocument, 'OpenAPI document and examples');
    canary.assertAbsent(playgroundFixtures, 'Playground diagnostic fixtures');
    assert.equal(
      serializeForLeakScan({ openApiDocument, playgroundFixtures }).includes(
        RAW_PROVIDER_ID_CANARY,
      ),
      false,
    );

    const publicArtifacts = {
      startupRequests,
      sanitizedStartupFailure,
      importedRepo,
      refreshedRepo,
      repoRows: repoDatabase.rows,
      recoveryBranch,
      refsObservations: refsRunner.observations.map(
        ({ configPath: _configPath, ...observation }) => observation,
      ),
      materialized,
      realMaterialized,
      realProgress,
      realExecutions: realExecutor.observations,
      realAuthorizationEvidence,
      realRetainedWorkspace: retainedWorkspace,
      failedMaterialization,
      firstDelivery,
      retryDelivery,
      pushTimedOut,
      pushCancelled,
      timedOut,
      cancelled,
      progress,
      executions,
      auditRows: [...auditRows.values()],
      logs: logs.entries,
      diagnosticDatabaseRows: diagnosticStore.rows,
      rejectedDiagnostic,
      recordedDiagnostic,
      diagnosticMetricsSnapshot,
      sandboxRuns: runDelegate.runs,
      owner,
      consoleTask,
      v1Task,
      v1Diagnostics,
      mcpTask,
      mcpDiagnostics,
      openApiDocument,
      playgroundFixtures,
      retainedWorkspaceFiles: secrets.retainedWorkspaceFiles,
      retainedGuestFiles: secrets.guestFiles,
      secretBufferZeroed: secrets.contentReferences.map((content) =>
        content.every((byte) => byte === 0),
      ),
    };
    canary.assertAbsent(publicArtifacts, 'aggregate canary story artifacts');
    assert.deepEqual(
      pathsContainingString(publicArtifacts, RAW_PROVIDER_ID_CANARY),
      ['owner.providerSandboxId', 'sandboxRuns.0.providerSandboxId'],
      'only internal SandboxRun ownership may retain a required raw provider id',
    );

    const publicProjection = serializeForLeakScan({
      auditRows: [...auditRows.values()],
      logs: logs.entries,
      diagnosticDatabaseRows: diagnosticStore.rows,
      diagnosticMetricsSnapshot,
      consoleTask,
      v1Task,
      v1Diagnostics,
      mcpTask,
      mcpDiagnostics,
      openApiDocument,
      playgroundFixtures,
    });
    assert.equal(publicProjection.includes(RAW_PROVIDER_ID_CANARY), false);
    for (const credentialPath of [
      ...refsRunner.observations.map((observation) => observation.configPath),
      ...secrets.allPaths,
      ...realSecrets.writtenPaths,
    ]) {
      assert.equal(
        publicProjection.includes(credentialPath),
        false,
        'public/audit/run/log projections must exclude temporary credential paths',
      );
    }
  },
);

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}
