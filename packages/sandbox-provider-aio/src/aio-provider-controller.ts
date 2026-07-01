import type { SandboxConnection } from '@cap/sandbox-core';
import {
  normalizeSandboxCommandResult,
  scrubSandboxCommandOutput,
} from '@cap/sandbox-core';
import {
  AIO_SANDBOX_CONTAINER_PREFIX,
  AIO_SANDBOX_SESSION_PROBE_TIMEOUT_MS,
  AIO_SANDBOX_TRIM_TIMEOUT_MS,
  buildAioLocalSandboxProvisionSpec,
  buildAioSandboxBaseUrl,
  buildAioSandboxConnection,
  buildAioSandboxContainerName,
  parseAioTaskIdFromContainerNames,
  type AioLocalSandboxContainerConfig,
  type AioLocalSandboxEnv,
  type AioLocalSandboxProvisionSpec,
} from './aio-local-provider.js';
import { extractFilesFromTar } from './tar-extract.js';

export type AioFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface AioDockerContainer {
  start(): Promise<void>;
  stop(options?: { readonly t?: number }): Promise<void>;
  remove(options?: { readonly force?: boolean }): Promise<void>;
  inspect(): Promise<unknown>;
  getArchive(options: { readonly path: string }): Promise<NodeJS.ReadableStream>;
}

export interface AioDockerContainerInfo {
  readonly Id: string;
  readonly Names?: readonly string[];
}

export interface AioDockerClient<TContainer extends AioDockerContainer = AioDockerContainer> {
  createContainer(options: AioLocalSandboxContainerConfig): Promise<TContainer>;
  getContainer(idOrName: string): TContainer;
  listContainers(options: {
    readonly all: false;
    readonly filters: {
      readonly name: readonly string[];
      readonly status: readonly string[];
    };
  }): Promise<readonly AioDockerContainerInfo[]>;
}

export interface AioProviderControllerLogger {
  debug?(message: string): void;
  log?(message: string): void;
  warn?(message: string): void;
}

export interface AioSandboxExecResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface AioSandboxContainerControllerOptions<
  TContainer extends AioDockerContainer = AioDockerContainer,
> {
  readonly docker: AioDockerClient<TContainer>;
  readonly fetch?: AioFetch;
  readonly env?: AioLocalSandboxEnv;
  readonly logger?: AioProviderControllerLogger;
  readonly delay?: (ms: number) => Promise<void>;
}

export interface AioProvisionedContainer<TContainer extends AioDockerContainer> {
  readonly spec: AioLocalSandboxProvisionSpec;
  readonly container: TContainer;
  readonly connection: SandboxConnection;
}

export interface AioTeardownHooks {
  beforeStop?(args: {
    readonly taskId: string;
    readonly baseUrl: string;
  }): Promise<void>;
}

export class AioSandboxContainerController<
  TContainer extends AioDockerContainer = AioDockerContainer,
> {
  private readonly docker: AioDockerClient<TContainer>;
  private readonly fetchImpl: AioFetch;
  private readonly env?: AioLocalSandboxEnv;
  private readonly logger?: AioProviderControllerLogger;
  private readonly delayImpl: (ms: number) => Promise<void>;
  private readonly containers = new Map<string, TContainer>();
  private readonly connections = new Map<string, SandboxConnection>();
  private readonly readopted = new Set<string>();
  private readoptScan?: Promise<void>;

  constructor(options: AioSandboxContainerControllerOptions<TContainer>) {
    this.docker = options.docker;
    this.fetchImpl =
      options.fetch ??
      ((input, init) => globalThis.fetch(input, init) as ReturnType<AioFetch>);
    this.env = options.env;
    this.logger = options.logger;
    this.delayImpl =
      options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getConnection(taskId: string): SandboxConnection | undefined {
    return this.connections.get(taskId);
  }

  resolveBaseUrl(taskId: string): string {
    return this.connections.get(taskId)?.baseUrl ?? buildAioSandboxBaseUrl(taskId);
  }

  async createAndStart(taskId: string): Promise<AioProvisionedContainer<TContainer>> {
    const spec = buildAioLocalSandboxProvisionSpec({ taskId, env: this.env });
    const container = await this.docker.createContainer(spec.containerConfig);
    this.containers.set(taskId, container);
    await container.start();
    this.logger?.debug?.(`provisioned AIO container ${spec.containerName} from ${spec.image}`);
    return { spec, container, connection: spec.connection };
  }

  registerConnection(connection: SandboxConnection): SandboxConnection {
    this.connections.set(connection.taskId, connection);
    return connection;
  }

  async waitForReadiness(args: {
    readonly baseUrl: string;
    readonly taskId: string;
    readonly timeoutMs: number;
  }): Promise<void> {
    const intervalMs = 250;
    const deadline = Date.now() + args.timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${args.baseUrl}/v1/docs`);
        if (res.ok) return;
        lastError = new Error(`/v1/docs responded with status ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await this.delayImpl(intervalMs);
    }

    throw new Error(
      `AIO sandbox for task ${args.taskId} did not become ready within ${args.timeoutMs}ms ` +
        `(last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`,
    );
  }

  async teardownSandbox(taskId: string, hooks: AioTeardownHooks = {}): Promise<void> {
    const connection = this.connections.get(taskId);
    this.connections.delete(taskId);
    this.readopted.delete(taskId);
    const container = this.containers.get(taskId);
    if (!container) return;
    this.containers.delete(taskId);

    const baseUrl = connection?.baseUrl ?? buildAioSandboxBaseUrl(taskId);
    await hooks.beforeStop?.({ taskId, baseUrl });
    await container.stop({ t: 0 }).catch(() => undefined);
  }

  async removeSandbox(taskId: string): Promise<void> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(buildAioSandboxContainerName(taskId));
    this.containers.delete(taskId);
    this.readopted.delete(taskId);
    await container.remove({ force: true }).catch(() => undefined);
  }

  async sandboxExists(taskId: string): Promise<boolean> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(buildAioSandboxContainerName(taskId));
    try {
      await container.inspect();
      return true;
    } catch {
      return false;
    }
  }

  async readSingleNewestJsonl(
    taskId: string,
    dir: string,
    filenameGlob: RegExp,
  ): Promise<string | null> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(buildAioSandboxContainerName(taskId));
    let stream: NodeJS.ReadableStream;
    try {
      stream = await container.getArchive({ path: dir });
    } catch {
      return null;
    }
    let tar: Buffer;
    try {
      tar = await streamToBuffer(stream);
    } catch {
      return null;
    }
    const files = extractFilesFromTar(tar, (name) => filenameGlob.test(name));
    if (files.length === 0) return null;
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files[files.length - 1]!.content.toString('utf8');
  }

  async runSandboxExec(baseUrl: string, command: string): Promise<AioSandboxExecResult> {
    const res = await this.fetchImpl(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) {
      return { exitCode: Number.NaN, output: `/v1/shell/exec responded ${res.status}` };
    }
    return parseAioExecResult(await res.json().catch(() => undefined));
  }

  async runShellExecBestEffort(args: {
    readonly baseUrl: string;
    readonly taskId: string;
    readonly command: string;
    readonly timeoutMs?: number;
    readonly label?: string;
  }): Promise<void> {
    const label = args.label ?? 'AIO shell exec';
    try {
      const res = await this.fetchImpl(`${args.baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: args.command }),
        signal: AbortSignal.timeout(args.timeoutMs ?? AIO_SANDBOX_TRIM_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger?.warn?.(
          `${label} for task ${args.taskId} returned HTTP ${res.status} (not fatal)`,
        );
      }
    } catch (err) {
      this.logger?.warn?.(
        `${label} for task ${args.taskId} failed (not fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async listReadoptable(): Promise<string[]> {
    await this.ensureReadoptionScan();
    return [...this.readopted];
  }

  reattach(taskId: string): SandboxConnection | null {
    if (!this.readopted.has(taskId)) return null;
    this.reregister(taskId);
    return this.connections.get(taskId)!;
  }

  releaseHandles(): void {
    this.containers.clear();
    this.connections.clear();
    this.readopted.clear();
    this.readoptScan = Promise.resolve();
  }

  private ensureReadoptionScan(): Promise<void> {
    return (this.readoptScan ??= this.scanForReadoption());
  }

  private async scanForReadoption(): Promise<void> {
    try {
      const running = await this.docker.listContainers({
        all: false,
        filters: {
          name: [AIO_SANDBOX_CONTAINER_PREFIX],
          status: ['running'],
        },
      });
      if (running.length === 0) return;

      let readopted = 0;
      let reaped = 0;
      await Promise.all(
        running.map(async (info) => {
          const taskId = parseAioTaskIdFromContainerNames(info.Names);
          if (taskId && (await this.hasLiveSession(taskId))) {
            this.reregister(taskId);
            this.readopted.add(taskId);
            readopted += 1;
            return;
          }
          await this.docker
            .getContainer(info.Id)
            .remove({ force: true })
            .catch(() => undefined);
          reaped += 1;
        }),
      );

      this.logger?.log?.(
        `startup re-adoption: re-adopted ${readopted} still-running ` +
          `${AIO_SANDBOX_CONTAINER_PREFIX}* sandbox(es) with a live agent session, ` +
          `force-removed ${reaped} orphan(s) with no live task ` +
          `(stopped containers spared as retained history)`,
      );
    } catch (err) {
      this.logger?.warn?.(
        `startup re-adoption of running sandboxes failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private reregister(taskId: string): void {
    if (!this.containers.has(taskId)) {
      this.containers.set(taskId, this.docker.getContainer(buildAioSandboxContainerName(taskId)));
    }
    if (!this.connections.has(taskId)) {
      this.connections.set(taskId, buildAioSandboxConnection(taskId));
    }
  }

  private async hasLiveSession(taskId: string): Promise<boolean> {
    const baseUrl = buildAioSandboxBaseUrl(taskId);
    const command = `tmux has-session -t task${taskId}`;
    try {
      const res = await this.fetchImpl(`${baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(AIO_SANDBOX_SESSION_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const { exitCode } = parseAioExecResult(
        await res.json().catch(() => undefined),
      );
      return exitCode === 0;
    } catch {
      return false;
    }
  }
}

export function scrubAioExecSecrets(output: string): string {
  return scrubSandboxCommandOutput(output);
}

export function parseAioExecResult(raw: unknown): AioSandboxExecResult {
  const result = normalizeSandboxCommandResult(raw);
  return { exitCode: result.exitCode, output: result.output };
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
