import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AioSandboxContainerController,
  BoxLiteRestClient,
  assertSandboxProviderSupportsResources,
  readBoxLiteProviderConfig,
  type AioDockerClient,
  type BoxLiteClient,
  type BoxLiteProviderConfig,
  type BoxLiteSandbox,
  type SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox';
import type { RuntimeExecutionEnvironmentSnapshot } from '@cap/contracts';
import type {
  ReadyOfficialCodexCredential,
  RuntimeModelAdapterResult,
} from './runtime-model-catalog.types';
import type {
  RuntimeModelTasklessProbeHandle,
  RuntimeModelTasklessProbeLifecycle,
} from './runtime-model-probe.port';

const PROBE_PREFIX = 'model-probe-';
const BOXLITE_PROBE_PREFIX = 'cap-model-probe-';
const PURPOSE_LABEL = 'cap.resource-purpose';
const PURPOSE = 'runtime-model-catalog';
const CREATED_AT_LABEL = 'cap.created-at';
const RESULT_PREFIX = 'CAP_RUNTIME_MODEL_RESULT:';
const MAX_RESULT_BYTES = 1024 * 1024;
const DEFAULT_ORPHAN_AGE_MS = 5 * 60_000;
const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_CLEANUP_ATTEMPTS = 3;

const ProbeResultSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            model: z.string().min(1),
            displayName: z.string().min(1),
            isDefault: z.boolean(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

type AioController = AioSandboxContainerController;

interface AioProbeState {
  readonly kind: 'aio';
  readonly id: string;
  readonly taskId: string;
  baseUrl: string | null;
  readonly credential: ReadyOfficialCodexCredential;
  readonly createdAt: number;
}

interface BoxLiteProbeState {
  readonly kind: 'boxlite';
  readonly id: string;
  sandboxId: string;
  readonly credential: ReadyOfficialCodexCredential;
  readonly client: BoxLiteClient;
  readonly config: BoxLiteProviderConfig;
  readonly createdAt: number;
}

type ProbeState = AioProbeState | BoxLiteProbeState;

export interface ConfiguredRuntimeModelTasklessProbeOptions {
  readonly aioController?: AioController;
  readonly docker?: Docker;
  readonly boxLiteClientFactory?: (config: BoxLiteProviderConfig) => BoxLiteClient;
  readonly boxLiteConfig?: () => ReturnType<typeof readBoxLiteProviderConfig>;
  readonly now?: () => number;
  readonly orphanAgeMs?: number;
  readonly orphanSweepIntervalMs?: number;
  readonly cleanupAttempts?: number;
}

/**
 * Production taskless catalog lifecycle. It consumes the exact immutable image
 * snapshot selected by catalog resolution and never enters Task admission or
 * creates a task-owned terminal/session.
 */
@Injectable()
export class ConfiguredRuntimeModelTasklessProbeLifecycle
  implements
    RuntimeModelTasklessProbeLifecycle,
    OnApplicationBootstrap,
    OnApplicationShutdown
{
  private readonly logger = new Logger(
    ConfiguredRuntimeModelTasklessProbeLifecycle.name,
  );
  private readonly docker: Docker;
  private readonly aio: AioController;
  private readonly boxLiteClientFactory: (
    config: BoxLiteProviderConfig,
  ) => BoxLiteClient;
  private readonly boxLiteConfig: () => ReturnType<
    typeof readBoxLiteProviderConfig
  >;
  private readonly now: () => number;
  private readonly orphanAgeMs: number;
  private readonly orphanSweepIntervalMs: number;
  private readonly cleanupAttempts: number;
  private readonly probes = new Map<string, ProbeState>();
  private readonly cleanupPending = new Set<string>();
  private readonly cleanupPromises = new Map<string, Promise<void>>();
  private orphanSweepTimer: NodeJS.Timeout | null = null;
  private orphanSweepPromise: Promise<void> | null = null;

  constructor(options: ConfiguredRuntimeModelTasklessProbeOptions = {}) {
    this.docker = options.docker ?? new Docker({ timeout: 30_000 });
    this.aio =
      options.aioController ??
      new AioSandboxContainerController({
        docker: this.docker as unknown as AioDockerClient,
      });
    this.boxLiteClientFactory =
      options.boxLiteClientFactory ??
      ((config) =>
        new BoxLiteRestClient({
          baseUrl: config.endpoint,
          apiToken: config.apiToken,
          timeoutMs: config.timeoutMs,
          protocolMode: config.protocolMode,
          pathPrefix: config.pathPrefix,
        }));
    this.boxLiteConfig = options.boxLiteConfig ?? readBoxLiteProviderConfig;
    this.now = options.now ?? Date.now;
    this.orphanAgeMs = positiveInteger(
      options.orphanAgeMs,
      DEFAULT_ORPHAN_AGE_MS,
    );
    this.orphanSweepIntervalMs = positiveInteger(
      options.orphanSweepIntervalMs,
      DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
    );
    this.cleanupAttempts = positiveInteger(
      options.cleanupAttempts,
      DEFAULT_CLEANUP_ATTEMPTS,
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.runOrphanSweep();
    this.orphanSweepTimer = setInterval(() => {
      void this.runOrphanSweep();
    }, this.orphanSweepIntervalMs);
    this.orphanSweepTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.orphanSweepTimer) {
      clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = null;
    }
    if (this.orphanSweepPromise) await this.orphanSweepPromise;
    const cleanup = await Promise.allSettled(
      [...this.probes.keys()].map((id) => this.cleanupProbe(id)),
    );
    if (cleanup.some((result) => result.status === 'rejected')) {
      this.logger.error(
        'One or more runtime-model probes could not be reclaimed during shutdown.',
      );
    }
  }

  async create(input: {
    readonly purpose: 'runtime-model-catalog';
    readonly labels: Readonly<Record<string, string>>;
    readonly ownerUserId: string;
    readonly environment: RuntimeExecutionEnvironmentSnapshot;
    readonly credential: import('./runtime-model-catalog.types').ReadyRuntimeModelCredential;
    readonly signal?: AbortSignal;
    readonly deadlineAt: number;
  }): Promise<RuntimeModelTasklessProbeHandle> {
    if (input.purpose !== PURPOSE || input.credential.mode !== 'official') {
      throw new Error('Unsupported runtime-model probe request.');
    }
    assertAvailable(input.signal, input.deadlineAt, this.now());
    const createdAt = this.now();
    const id = randomUUID();
    const labels = safeProbeLabels(input.labels, createdAt);

    if (
      input.environment.providerFamily === 'aio' &&
      input.environment.source.kind === 'aio-docker-image'
    ) {
      const taskId = `${PROBE_PREFIX}${id}`;
      const state: AioProbeState = {
        kind: 'aio',
        id,
        taskId,
        baseUrl: null,
        credential: input.credential,
        createdAt,
      };
      this.probes.set(id, state);
      try {
        const provisioned = await this.aio.createAndStart(
          taskId,
          snapshotEnvironment(input.environment),
          labels,
          { signal: input.signal },
        );
        state.baseUrl = provisioned.connection.baseUrl;
        await this.aio.waitForReadiness({
          baseUrl: provisioned.connection.baseUrl,
          taskId,
          timeoutMs: remainingMs(input.deadlineAt, this.now()),
          signal: input.signal,
        });
        return { id };
      } catch (error) {
        await this.cleanupProbe(id).catch(() => {
          this.logger.error(
            'A failed AIO runtime-model probe remains pending cleanup.',
          );
        });
        throw error;
      }
    }

    if (
      input.environment.providerFamily === 'boxlite' &&
      (input.environment.source.kind === 'boxlite-image' ||
        input.environment.source.kind === 'boxlite-rootfs')
    ) {
      const configResult = this.boxLiteConfig();
      if (
        configResult.status !== 'valid' ||
        configResult.config.providerId !== input.environment.provider
      ) {
        throw new Error('Selected BoxLite provider is unavailable.');
      }
      const config = configResult.config;
      const client = this.boxLiteClientFactory(config);
      assertSandboxProviderSupportsResources(
        config.capabilities,
        input.environment.resources,
      );
      const sandboxId = `${BOXLITE_PROBE_PREFIX}${createdAt}-${id}`;
      const state: BoxLiteProbeState = {
        kind: 'boxlite',
        id,
        sandboxId,
        credential: input.credential,
        client,
        config,
        createdAt,
      };
      this.probes.set(id, state);
      try {
        const sandbox = await client.createSandbox({
          taskId: sandboxId,
          sandboxId,
          ...(input.environment.source.kind === 'boxlite-image'
            ? { image: input.environment.source.locator }
            : { rootfsPath: input.environment.source.locator }),
          location: config.location,
          diskSizeGb: input.environment.resources?.diskSizeGb,
          env: {
            ...(config.sandboxEnv ?? {}),
            CAP_RESOURCE_PURPOSE: PURPOSE,
            CAP_PROBE_CREATED_AT: String(createdAt),
          },
          labels,
          metadata: {
            [PURPOSE_LABEL]: PURPOSE,
            [CREATED_AT_LABEL]: new Date(createdAt).toISOString(),
            provider: input.environment.provider,
            resources: input.environment.resources,
          },
        });
        state.sandboxId = sandbox.id;
        const preflight = await client.exec({
          sandboxId: sandbox.id,
          command: 'command -v node >/dev/null && command -v codex >/dev/null',
          cwd: config.workspacePath,
          timeoutMs: remainingMs(input.deadlineAt, this.now()),
        });
        if (preflight.exitCode !== 0 || preflight.timedOut) {
          throw new Error('BoxLite runtime-model probe preflight failed.');
        }
        return { id };
      } catch (error) {
        await this.cleanupProbe(id).catch(() => {
          this.logger.error(
            'A failed BoxLite runtime-model probe remains pending cleanup.',
          );
        });
        throw error;
      }
    }

    throw new Error('Selected runtime environment cannot host a Codex probe.');
  }

  async discover(
    handle: RuntimeModelTasklessProbeHandle,
    input: { readonly signal?: AbortSignal; readonly deadlineAt: number },
  ): Promise<RuntimeModelAdapterResult> {
    const state = this.requireState(handle);
    assertAvailable(input.signal, input.deadlineAt, this.now());
    const command = buildCodexModelProbeCommand(
      state.credential.authJson,
      remainingMs(input.deadlineAt, this.now()),
    );
    let output: string;
    let exitCode: number;
    let timedOut = false;
    if (state.kind === 'aio') {
      if (!state.baseUrl) {
        throw new Error('Runtime-model probe is not ready.');
      }
      const result = await this.aio.runSandboxExec(state.baseUrl, command, {
        signal: input.signal,
      });
      output = result.output;
      exitCode = result.exitCode;
    } else {
      const result = await state.client.exec({
        sandboxId: state.sandboxId,
        command,
        cwd: state.config.workspacePath,
        timeoutMs: remainingMs(input.deadlineAt, this.now()),
      });
      output = result.stdout || result.output;
      exitCode = result.exitCode;
      timedOut = result.timedOut === true;
    }
    if (exitCode !== 0 || timedOut) {
      throw new Error('Codex runtime-model probe failed.');
    }
    return parseCodexModelProbeOutput(output);
  }

  async cancel(handle: RuntimeModelTasklessProbeHandle): Promise<void> {
    await this.destroy(handle);
  }

  async destroy(handle: RuntimeModelTasklessProbeHandle): Promise<void> {
    await this.cleanupProbe(handle.id);
  }

  async reconcileOrphans(input: {
    readonly purpose: 'runtime-model-catalog';
    readonly olderThan: Date;
  }): Promise<number> {
    if (input.purpose !== PURPOSE) return 0;
    const olderThanMs = input.olderThan.getTime();
    const aio = await this.reconcileAioOrphans(olderThanMs);
    const boxlite = await this.reconcileBoxLiteOrphans(olderThanMs);
    return aio + boxlite;
  }

  private async cleanupProbe(id: string): Promise<void> {
    const inFlight = this.cleanupPromises.get(id);
    if (inFlight) return inFlight;
    const state = this.probes.get(id);
    if (!state) return;
    const cleanup = this.removeProbeState(state)
      .then(() => {
        if (this.probes.get(id) === state) this.probes.delete(id);
        this.cleanupPending.delete(id);
      })
      .catch(() => {
        this.cleanupPending.add(id);
        throw new Error('Runtime-model probe provider cleanup failed.');
      })
      .finally(() => {
        this.cleanupPromises.delete(id);
      });
    this.cleanupPromises.set(id, cleanup);
    return cleanup;
  }

  private async removeProbeState(state: ProbeState): Promise<void> {
    for (let attempt = 1; attempt <= this.cleanupAttempts; attempt += 1) {
      try {
        if (state.kind === 'aio') {
          await this.aio.removeSandbox(state.taskId, { bestEffort: false });
        } else {
          await state.client.deleteSandbox(state.sandboxId);
        }
        return;
      } catch {
        if (attempt === this.cleanupAttempts) throw new Error('cleanup failed');
      }
    }
  }

  private async runOrphanSweep(): Promise<void> {
    if (this.orphanSweepPromise) return this.orphanSweepPromise;
    const sweep = (async () => {
      for (const id of [...this.cleanupPending]) {
        await this.cleanupProbe(id).catch(() => undefined);
      }
      try {
        const reaped = await this.reconcileOrphans({
          purpose: PURPOSE,
          olderThan: new Date(this.now() - this.orphanAgeMs),
        });
        if (reaped > 0) {
          this.logger.log(`Reclaimed ${reaped} orphan runtime-model probe(s).`);
        }
      } catch {
        this.logger.error('Runtime-model probe orphan reconciliation failed.');
      }
    })().finally(() => {
      this.orphanSweepPromise = null;
    });
    this.orphanSweepPromise = sweep;
    return sweep;
  }

  private async reconcileAioOrphans(olderThanMs: number): Promise<number> {
    let containers: Awaited<ReturnType<Docker['listContainers']>>;
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`${PURPOSE_LABEL}=${PURPOSE}`] },
      });
    } catch {
      this.logger.error('AIO runtime-model orphan listing failed.');
      return 0;
    }
    let reaped = 0;
    for (const info of containers) {
      const createdAt =
        typeof info.Created === 'number' ? info.Created * 1_000 : Number.NaN;
      if (!Number.isFinite(createdAt) || createdAt > olderThanMs) continue;
      try {
        await this.docker.getContainer(info.Id).remove({ force: true });
        reaped += 1;
      } catch {
        this.logger.error('An AIO runtime-model orphan could not be reclaimed.');
      }
    }
    return reaped;
  }

  private async reconcileBoxLiteOrphans(olderThanMs: number): Promise<number> {
    const configResult = this.boxLiteConfig();
    if (configResult.status !== 'valid') return 0;
    const client = this.boxLiteClientFactory(configResult.config);
    if (!client.listSandboxes) return 0;
    let sandboxes: Awaited<ReturnType<NonNullable<BoxLiteClient['listSandboxes']>>>;
    try {
      sandboxes = await client.listSandboxes();
    } catch {
      this.logger.error('BoxLite runtime-model orphan listing failed.');
      return 0;
    }
    let reaped = 0;
    for (const sandbox of sandboxes) {
      const createdAt = boxLiteProbeCreatedAt(sandbox);
      if (createdAt === null || createdAt > olderThanMs) continue;
      try {
        await client.deleteSandbox(sandbox.id);
        reaped += 1;
      } catch {
        this.logger.error(
          'A BoxLite runtime-model orphan could not be reclaimed.',
        );
      }
    }
    return reaped;
  }

  private requireState(handle: RuntimeModelTasklessProbeHandle): ProbeState {
    const state = this.probes.get(handle.id);
    if (!state) throw new Error('Runtime-model probe handle is unavailable.');
    return state;
  }
}

function snapshotEnvironment(
  snapshot: RuntimeExecutionEnvironmentSnapshot,
): SandboxResolvedEnvironmentMetadata {
  return {
    id: snapshot.managedEnvironmentId ?? `deployment-${snapshot.fingerprint}`,
    environmentId: snapshot.managedEnvironmentId ?? undefined,
    name: snapshot.kind === 'managed' ? 'Managed environment' : 'Deployment environment',
    providerId: snapshot.provider,
    providerFamily: snapshot.providerFamily,
    sourceKind: snapshot.source.kind,
    sourceRef: snapshot.source.locator,
    digest: snapshot.source.digest ?? undefined,
    checksum: snapshot.source.checksum ?? undefined,
    contractVersion: snapshot.validationContractVersion ?? undefined,
    runtimeId: 'codex',
  };
}

function safeProbeLabels(
  requested: Readonly<Record<string, string>>,
  createdAt: number,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {
    [PURPOSE_LABEL]: PURPOSE,
    [CREATED_AT_LABEL]: new Date(createdAt).toISOString(),
  };
  for (const [key, value] of Object.entries(requested)) {
    if (/^[A-Za-z0-9._-]{1,128}$/u.test(key) && value.length <= 256) {
      out[key] = value;
    }
  }
  return out;
}

function boxLiteProbeCreatedAt(sandbox: BoxLiteSandbox): number | null {
  const purpose = sandbox.metadata?.[PURPOSE_LABEL];
  const identity = [sandbox.id, sandbox.taskId].find((value) =>
    value?.startsWith(BOXLITE_PROBE_PREFIX),
  );
  if (purpose !== PURPOSE && !identity) return null;

  const metadataCreatedAt = sandbox.metadata?.[CREATED_AT_LABEL];
  if (typeof metadataCreatedAt === 'string') {
    const parsed = Date.parse(metadataCreatedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (!identity) return null;
  const raw = identity.slice(BOXLITE_PROBE_PREFIX.length).split('-', 1)[0];
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertAvailable(
  signal: AbortSignal | undefined,
  deadlineAt: number,
  now: number,
): void {
  if (signal?.aborted || !Number.isFinite(deadlineAt) || deadlineAt <= now) {
    throw new Error('Runtime-model probe deadline elapsed.');
  }
}

function remainingMs(deadlineAt: number, now: number): number {
  return Math.max(1, Math.min(60_000, Math.floor(deadlineAt - now)));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

/** Fixed helper program executed inside the selected immutable sandbox image. */
export function buildCodexModelProbeCommand(
  authJson: string,
  timeoutMs: number,
): string {
  const auth = Buffer.from(authJson, 'utf8').toString('base64');
  const program = Buffer.from(CODEX_MODEL_PROBE_PROGRAM, 'utf8').toString(
    'base64',
  );
  const timeout = Math.max(1_000, Math.min(60_000, Math.floor(timeoutMs)));
  return [
    // AIO /v1/shell/exec appends its own background-process bookkeeping after
    // the submitted command and reads `$!` even when this probe starts no
    // background process. Enabling shell nounset here therefore turns a
    // successful App Server probe into `bash: $!: unbound variable`. Keep
    // fail-fast execution without leaking shell options into the AIO wrapper.
    'set -e',
    'umask 077',
    'probe_dir="$(mktemp -d /tmp/cap-runtime-model-probe.XXXXXX)"',
    "trap 'rm -rf \"$probe_dir\"' EXIT HUP INT TERM",
    'mkdir -p "$probe_dir/home/.codex"',
    `printf '%s' '${auth}' | base64 -d > "$probe_dir/home/.codex/auth.json"`,
    `printf '%s' '${program}' | base64 -d > "$probe_dir/probe.cjs"`,
    `HOME="$probe_dir/home" CODEX_HOME="$probe_dir/home/.codex" CAP_MODEL_PROBE_TIMEOUT_MS='${timeout}' node "$probe_dir/probe.cjs"`,
  ].join('; ');
}

export function parseCodexModelProbeOutput(
  output: string,
): RuntimeModelAdapterResult {
  if (Buffer.byteLength(output, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('Codex runtime-model probe returned oversized output.');
  }
  const trimmed = output.trim();
  if (!trimmed.startsWith(RESULT_PREFIX) || trimmed.includes('\n')) {
    throw new Error('Codex runtime-model probe returned invalid output.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(trimmed.slice(RESULT_PREFIX.length), 'base64').toString('utf8'),
    );
  } catch {
    throw new Error('Codex runtime-model probe returned invalid output.');
  }
  const result = ProbeResultSchema.parse(parsed);
  const defaults = result.models.filter((model) => model.isDefault);
  if (defaults.length > 1) {
    throw new Error('Codex runtime-model probe returned multiple defaults.');
  }
  return {
    defaultModel: defaults[0]?.model ?? null,
    models: result.models.map((model) => ({
      id: model.model,
      displayName: model.displayName,
      isDefault: model.isDefault,
    })),
  };
}

const CODEX_MODEL_PROBE_PROGRAM = String.raw`
'use strict';
const { spawn } = require('node:child_process');
const RESULT_PREFIX = '${RESULT_PREFIX}';
const timeoutMs = Math.max(1000, Math.min(60000, Number(process.env.CAP_MODEL_PROBE_TIMEOUT_MS) || 10000));
const child = spawn('codex', ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});
let buffer = '';
let bufferBytes = 0;
let stderrBytes = 0;
let nextId = 1;
let finished = false;
const pending = new Map();
const timer = setTimeout(fail, timeoutMs);

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }
function write(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ id, method, params });
  });
}
function fail() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { child.kill('SIGKILL'); } catch {}
  process.exitCode = 1;
}
function succeed(models) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const payload = Buffer.from(JSON.stringify({ models }), 'utf8').toString('base64');
  process.stdout.write(RESULT_PREFIX + payload + '\n');
  try { child.kill('SIGTERM'); } catch {}
}
function consume(line) {
  let message;
  try { message = JSON.parse(line); } catch { fail(); return; }
  if (!object(message) || !('id' in message)) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if ('error' in message || !('result' in message)) waiter.reject(new Error('request failed'));
  else waiter.resolve(message.result);
}
child.stdout.on('data', (chunk) => {
  if (finished) return;
  bufferBytes += chunk.length;
  if (bufferBytes > 4 * 1024 * 1024) { fail(); return; }
  buffer += chunk.toString('utf8');
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (Buffer.byteLength(line, 'utf8') > 256 * 1024) { fail(); return; }
    if (line.trim()) consume(line);
  }
});
child.stderr.on('data', (chunk) => {
  stderrBytes += chunk.length;
  if (stderrBytes > 256 * 1024) fail();
});
child.once('error', fail);
child.once('exit', () => { if (!finished) fail(); });

(async () => {
  const initialized = await request('initialize', {
    clientInfo: { name: 'cloud-agent-platform', version: '1', title: 'Cloud Agent Platform' },
    capabilities: null,
  });
  if (!object(initialized) || !text(initialized.codexHome) || !text(initialized.platformFamily) ||
      !text(initialized.platformOs) || !text(initialized.userAgent)) throw new Error('bad initialize');
  write({ method: 'initialized' });
  const models = [];
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const value = await request('model/list', { cursor, limit: 100, includeHidden: false });
    if (!object(value) || !Array.isArray(value.data)) throw new Error('bad page');
    for (const item of value.data) {
      if (!object(item) || !text(item.id) || !text(item.model) || !text(item.displayName) ||
          typeof item.description !== 'string' || typeof item.hidden !== 'boolean' ||
          typeof item.isDefault !== 'boolean' || !text(item.defaultReasoningEffort) ||
          !Array.isArray(item.supportedReasoningEfforts)) throw new Error('bad model');
      if (!item.hidden) models.push({ model: item.model, displayName: item.displayName, isDefault: item.isDefault });
      if (models.length > 1000) throw new Error('too many models');
    }
    const next = value.nextCursor == null ? null : value.nextCursor;
    if (next !== null && !text(next)) throw new Error('bad cursor');
    if (next === null) { succeed(models); return; }
    if (cursors.has(next)) throw new Error('cursor loop');
    cursors.add(next);
    cursor = next;
  }
  throw new Error('too many pages');
})().catch(fail);
`;
