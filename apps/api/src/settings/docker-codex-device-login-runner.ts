import { PassThrough, Writable, type Duplex } from 'node:stream';
import { Inject, Injectable, Optional } from '@nestjs/common';
import Docker from 'dockerode';

import {
  CodexAppServerClient,
  CodexAppServerClientError,
} from './codex-app-server-client';
import {
  CodexDeviceLoginRunnerError,
  type CodexDeviceLoginCompletion,
  type CodexDeviceLoginOperationOptions,
  type CodexDeviceLoginRunner,
  type CodexDeviceLoginRunnerErrorCategory,
  type CodexDeviceLoginRunnerHandle,
  type CodexDeviceLoginStartOptions,
} from './codex-device-login-runner';

export const CODEX_DEVICE_LOGIN_DOCKER = Symbol('CodexDeviceLoginDocker');
export const CODEX_DEVICE_LOGIN_RUNNER_OPTIONS = Symbol('CodexDeviceLoginRunnerOptions');

export const CODEX_LOGIN_COMPONENT_LABEL = 'com.cloud-agent-platform.component';
export const CODEX_LOGIN_COMPONENT_VALUE = 'codex-device-login';
export const CODEX_LOGIN_SESSION_LABEL =
  'com.cloud-agent-platform.codex-device-login.session-id';

export const CODEX_LOGIN_HOME = '/home/gem';
export const CODEX_LOGIN_CODEX_HOME = `${CODEX_LOGIN_HOME}/.codex`;
export const CODEX_LOGIN_AUTH_PATH = `${CODEX_LOGIN_CODEX_HOME}/auth.json`;
export const CODEX_LOGIN_NUMERIC_USER = '1000:1000';

const DEFAULT_STAGE_TIMEOUT_MS = 10_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;
const DEFAULT_CREDENTIAL_MAX_BYTES = 256 * 1024;
const DEFAULT_STDERR_MAX_BYTES = 8 * 1024;
const DIRECT_EXEC_MAX_BYTES = 16 * 1024;
const REMOVE_CONFLICT_OBSERVATION_MS = 250;
const REMOVE_INSPECT_POLL_MS = 25;
const SECCOMP_UNCONFINED = 'seccomp=unconfined';
const SHM_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/** Exact argv verified against the pinned Codex 0.144.1 app-server help. */
export const CODEX_APP_SERVER_ARGV = [
  'codex',
  'app-server',
  '--stdio',
  '-c',
  'cli_auth_credentials_store="file"',
] as const;

export interface DockerCodexDeviceLoginRunnerOptions {
  readonly image?: string;
  readonly network?: string;
  readonly stageTimeoutMs?: number;
  readonly cancelTimeoutMs?: number;
  readonly credentialMaxBytes?: number;
  readonly protocolMaxLineBytes?: number;
  readonly protocolRequestTimeoutMs?: number;
  readonly stderrMaxBytes?: number;
}

class BoundedSink extends Writable {
  private readonly chunks: Buffer[] = [];
  private keptBytes = 0;
  totalBytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.totalBytes += buffer.length;
    const remaining = this.maxBytes - this.keptBytes;
    if (remaining > 0) {
      const kept = buffer.subarray(0, remaining);
      this.chunks.push(Buffer.from(kept));
      this.keptBytes += kept.length;
    }
    if (buffer.length > remaining) this.truncated = true;
    callback();
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.keptBytes);
  }

  /** Deliberately exposes metadata only; stderr content is fully redacted. */
  redactedSummary(): string {
    return `[stderr redacted; bytes=${this.totalBytes}; truncated=${String(this.truncated)}]`;
  }
}

interface WorkerResources {
  readonly container: Docker.Container;
  readonly raw: Duplex;
  readonly stdout: PassThrough;
  readonly stderr: BoundedSink;
  readonly client: CodexAppServerClient;
}

interface DirectExecResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrSummary: string;
}

class BoundedOperationError extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? 'bounded operation timed out' : 'bounded operation aborted');
  }
}

/**
 * Docker implementation of the disposable Codex App Server authentication port.
 * It does not depend on AIO HTTP readiness or AIO's shell endpoint.
 */
@Injectable()
export class DockerCodexDeviceLoginRunner implements CodexDeviceLoginRunner {
  private readonly docker: Docker;
  private readonly options: DockerCodexDeviceLoginRunnerOptions;

  constructor(
    @Optional() @Inject(CODEX_DEVICE_LOGIN_DOCKER) docker?: Docker,
    @Optional()
    @Inject(CODEX_DEVICE_LOGIN_RUNNER_OPTIONS)
    options?: DockerCodexDeviceLoginRunnerOptions,
  ) {
    this.options = options ?? {};
    // Dockerode's image-inspect API does not expose AbortSignal in its public
    // type, so the client-level socket timeout is the final bound for that one
    // read-only pre-create call. All mutating/container/exec calls additionally
    // receive the stage AbortSignal below.
    this.docker = docker ?? new Docker({ timeout: this.stageTimeoutMs });
  }

  async start(options: CodexDeviceLoginStartOptions): Promise<CodexDeviceLoginRunnerHandle> {
    const image = this.options.image ?? process.env.AIO_SANDBOX_IMAGE;
    if (!image) {
      throw new CodexDeviceLoginRunnerError('device_login_worker_not_configured');
    }
    if (options.signal?.aborted) {
      throw new CodexDeviceLoginRunnerError('device_login_cancelled');
    }

    const preparationTimeoutMs = positiveInteger(options.timeoutMs, this.stageTimeoutMs);
    const preparationDeadlineMs = Date.now() + preparationTimeoutMs;
    await this.inspectImage(
      image,
      options.signal,
      Math.max(1, preparationDeadlineMs - Date.now()),
    );

    let container: Docker.Container | undefined;
    let resources: WorkerResources | undefined;
    try {
      container = await this.bounded(
        options.signal,
        remainingUntil(preparationDeadlineMs),
        (signal) =>
          this.docker.createContainer({
            Image: image,
            name: `cap-codexlogin-${options.sessionId}`,
            Labels: {
              [CODEX_LOGIN_COMPONENT_LABEL]: CODEX_LOGIN_COMPONENT_VALUE,
              [CODEX_LOGIN_SESSION_LABEL]: options.sessionId,
            },
            HostConfig: {
              SecurityOpt: [SECCOMP_UNCONFINED],
              ShmSize: SHM_SIZE_BYTES,
              AutoRemove: true,
              NetworkMode: this.options.network ?? process.env.AIO_SANDBOX_NETWORK ?? 'cap-net',
            },
            abortSignal: signal,
          }),
      );
      await this.bounded(options.signal, remainingUntil(preparationDeadlineMs), (signal) =>
        container!.start({ abortSignal: signal }),
      );

      await this.preflight(container, options.signal, preparationDeadlineMs);
      resources = await this.startAppServer(
        container,
        options.signal,
        remainingUntil(preparationDeadlineMs),
      );

      await resources.client.initialize({
        signal: options.signal,
        timeoutMs: Math.min(
          this.protocolRequestTimeoutMs,
          remainingUntil(preparationDeadlineMs),
        ),
      });
      const authorization = await resources.client.startDeviceCode({
        signal: options.signal,
        timeoutMs: Math.min(
          this.protocolRequestTimeoutMs,
          remainingUntil(preparationDeadlineMs),
        ),
      });

      return new DockerCodexDeviceLoginHandle(
        options.sessionId,
        authorization,
        this.docker,
        resources,
        {
          cancelTimeoutMs: this.cancelTimeoutMs,
          credentialMaxBytes: this.credentialMaxBytes,
          stageTimeoutMs: this.stageTimeoutMs,
        },
        options.signal,
      );
    } catch (error) {
      let cleanupError: unknown;
      if (resources) {
        await disposeWorkerResources(resources, this.stageTimeoutMs).catch((failure) => {
          cleanupError = failure;
        });
      } else if (container) {
        await disposeContainer(container, this.stageTimeoutMs).catch((failure) => {
          cleanupError = failure;
        });
      }
      if (cleanupError) {
        throw new CodexDeviceLoginRunnerError('device_login_worker_cleanup_failed');
      }
      if (options.signal?.aborted) {
        throw new CodexDeviceLoginRunnerError('device_login_cancelled');
      }
      throw this.mapStartError(error);
    }
  }

  async disposeOrphans(options: CodexDeviceLoginOperationOptions = {}): Promise<void> {
    const timeoutMs = positiveInteger(options.timeoutMs, this.stageTimeoutMs);
    const deadlineMs = Date.now() + timeoutMs;
    const containers = await this.bounded(
      options.signal,
      remainingUntil(deadlineMs),
      (signal) =>
        this.docker.listContainers({
          all: true,
          filters: {
            label: [`${CODEX_LOGIN_COMPONENT_LABEL}=${CODEX_LOGIN_COMPONENT_VALUE}`],
          },
          abortSignal: signal,
        }),
    ).catch((error: unknown) => {
      throw this.mapDockerError(error, 'device_login_worker_start_failed');
    });

    await Promise.all(
      containers.map((info) =>
        disposeContainer(
          this.docker.getContainer(info.Id),
          Math.max(1, deadlineMs - Date.now()),
        ),
      ),
    );
  }

  private async inspectImage(
    image: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    try {
      await this.bounded(signal, timeoutMs, () => this.docker.getImage(image).inspect());
    } catch (error) {
      if (error instanceof BoundedOperationError && !error.timedOut) {
        throw new CodexDeviceLoginRunnerError('device_login_cancelled');
      }
      throw new CodexDeviceLoginRunnerError('device_login_worker_image_unavailable');
    }
  }

  private async preflight(
    container: Docker.Container,
    signal: AbortSignal | undefined,
    deadlineMs: number,
  ): Promise<void> {
    const commands: readonly (readonly string[])[] = [
      ['mkdir', '-p', CODEX_LOGIN_CODEX_HOME],
      ['test', '-w', CODEX_LOGIN_CODEX_HOME],
      ['codex', '--version'],
    ];
    try {
      for (const argv of commands) {
        const result = await runBoundedDirectExec(
          this.docker,
          container,
          argv,
          DIRECT_EXEC_MAX_BYTES,
          signal,
          remainingUntil(deadlineMs),
        );
        if (result.exitCode !== 0 || result.stdoutTruncated) {
          throw new CodexDeviceLoginRunnerError('device_login_worker_preflight_failed');
        }
      }
    } catch (error) {
      if (error instanceof CodexDeviceLoginRunnerError) throw error;
      if (error instanceof BoundedOperationError && !error.timedOut) {
        throw new CodexDeviceLoginRunnerError('device_login_cancelled');
      }
      throw new CodexDeviceLoginRunnerError('device_login_worker_preflight_failed');
    }
  }

  private async startAppServer(
    container: Docker.Container,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<WorkerResources> {
    try {
      return await this.bounded(signal, timeoutMs, async (boundedSignal) => {
        const exec = await container.exec({
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Cmd: [...CODEX_APP_SERVER_ARGV],
          User: CODEX_LOGIN_NUMERIC_USER,
          WorkingDir: CODEX_LOGIN_HOME,
          Env: [`HOME=${CODEX_LOGIN_HOME}`, `CODEX_HOME=${CODEX_LOGIN_CODEX_HOME}`],
          abortSignal: boundedSignal,
        });
        const raw = await exec.start({
          hijack: true,
          stdin: true,
          Tty: false,
          abortSignal: boundedSignal,
        });
        const stdout = new PassThrough();
        const stderr = new BoundedSink(this.stderrMaxBytes);
        this.docker.modem.demuxStream(raw, stdout, stderr);
        endDemuxDestinationsWithRaw(raw, stdout, stderr);
        const client = new CodexAppServerClient(
          { readable: stdout, writable: raw },
          {
            maxLineBytes: this.options.protocolMaxLineBytes,
            requestTimeoutMs: this.protocolRequestTimeoutMs,
          },
        );
        return { container, raw, stdout, stderr, client };
      });
    } catch (error) {
      if (error instanceof BoundedOperationError && !error.timedOut) {
        throw new CodexDeviceLoginRunnerError('device_login_cancelled');
      }
      throw new CodexDeviceLoginRunnerError('device_login_worker_start_failed');
    }
  }

  private mapStartError(error: unknown): CodexDeviceLoginRunnerError {
    if (error instanceof CodexDeviceLoginRunnerError) return error;
    if (error instanceof CodexAppServerClientError) return mapProtocolError(error);
    if (error instanceof BoundedOperationError) {
      return new CodexDeviceLoginRunnerError(
        error.timedOut ? 'device_login_protocol_timeout' : 'device_login_cancelled',
      );
    }
    return new CodexDeviceLoginRunnerError('device_login_worker_start_failed');
  }

  private mapDockerError(
    error: unknown,
    fallback: CodexDeviceLoginRunnerErrorCategory,
  ): CodexDeviceLoginRunnerError {
    if (error instanceof CodexDeviceLoginRunnerError) return error;
    if (error instanceof BoundedOperationError && !error.timedOut) {
      return new CodexDeviceLoginRunnerError('device_login_cancelled');
    }
    return new CodexDeviceLoginRunnerError(fallback);
  }

  private bounded<T>(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return runBoundedOperation(signal, timeoutMs, operation);
  }

  private get stageTimeoutMs(): number {
    return positiveInteger(this.options.stageTimeoutMs, DEFAULT_STAGE_TIMEOUT_MS);
  }

  private get cancelTimeoutMs(): number {
    return positiveInteger(this.options.cancelTimeoutMs, DEFAULT_CANCEL_TIMEOUT_MS);
  }

  private get credentialMaxBytes(): number {
    return positiveInteger(this.options.credentialMaxBytes, DEFAULT_CREDENTIAL_MAX_BYTES);
  }

  private get stderrMaxBytes(): number {
    return positiveInteger(this.options.stderrMaxBytes, DEFAULT_STDERR_MAX_BYTES);
  }

  private get protocolRequestTimeoutMs(): number {
    return positiveInteger(this.options.protocolRequestTimeoutMs, this.stageTimeoutMs);
  }
}

class DockerCodexDeviceLoginHandle implements CodexDeviceLoginRunnerHandle {
  private disposePromise?: Promise<void>;
  private cancelPromise?: Promise<void>;
  private readonly abortListener?: () => void;

  constructor(
    readonly sessionId: string,
    readonly authorization: CodexDeviceLoginRunnerHandle['authorization'],
    private readonly docker: Docker,
    private readonly resources: WorkerResources,
    private readonly options: {
      readonly cancelTimeoutMs: number;
      readonly credentialMaxBytes: number;
      readonly stageTimeoutMs: number;
    },
    private readonly lifetimeSignal?: AbortSignal,
  ) {
    if (lifetimeSignal) {
      this.abortListener = () => {
        void this.cancel().catch(() => undefined);
      };
      lifetimeSignal.addEventListener('abort', this.abortListener, { once: true });
      if (lifetimeSignal.aborted) this.abortListener();
    }
  }

  async waitForCompletion(
    options: CodexDeviceLoginOperationOptions = {},
  ): Promise<CodexDeviceLoginCompletion> {
    try {
      const completion = await this.resources.client.waitForCompletion(
        this.authorization.loginId,
        options,
      );
      return completion.success
        ? { loginId: completion.loginId, success: true }
        : {
            loginId: completion.loginId,
            success: false,
            category: 'device_login_authorization_failed',
          };
    } catch (error) {
      throw mapHandleError(error);
    }
  }

  async cancel(options: CodexDeviceLoginOperationOptions = {}): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    if (this.disposePromise) return this.disposePromise;
    const attempt = (async () => {
      const timeoutMs = positiveInteger(options.timeoutMs, this.options.cancelTimeoutMs);
      const deadlineMs = Date.now() + timeoutMs;
      try {
        await this.resources.client.cancel(this.authorization.loginId, {
          signal: options.signal,
          // Reserve most of the caller's budget for authoritative worker
          // teardown even when App Server does not acknowledge cancellation.
          timeoutMs: Math.max(1, Math.floor(timeoutMs * 0.4)),
        });
      } catch {
        // Cancellation remains authoritative even if App Server already exited
        // or cannot acknowledge the request. Resource reclamation is mandatory.
      } finally {
        await this.disposeWithin(Math.max(1, deadlineMs - Date.now()));
      }
    })();
    this.cancelPromise = attempt.catch((error: unknown) => {
      if (this.cancelPromise) this.cancelPromise = undefined;
      throw error;
    });
    return this.cancelPromise;
  }

  async readCredential(
    options: CodexDeviceLoginOperationOptions = {},
  ): Promise<string> {
    if (this.disposePromise) {
      throw new CodexDeviceLoginRunnerError('device_login_credential_read_failed');
    }
    try {
      const result = await runBoundedDirectExec(
        this.docker,
        this.resources.container,
        ['cat', CODEX_LOGIN_AUTH_PATH],
        this.options.credentialMaxBytes,
        options.signal,
        options.timeoutMs ?? this.options.stageTimeoutMs,
      );
      if (result.stdoutTruncated) {
        throw new CodexDeviceLoginRunnerError('device_login_credential_too_large');
      }
      if (result.exitCode !== 0 || result.stdout.length === 0) {
        throw new CodexDeviceLoginRunnerError('device_login_credential_read_failed');
      }
      return result.stdout.toString('utf8');
    } catch (error) {
      if (error instanceof CodexDeviceLoginRunnerError) throw error;
      if (error instanceof BoundedOperationError && !error.timedOut) {
        throw new CodexDeviceLoginRunnerError('device_login_cancelled');
      }
      throw new CodexDeviceLoginRunnerError('device_login_credential_read_failed');
    }
  }

  dispose(): Promise<void> {
    return this.disposeWithin(this.options.stageTimeoutMs);
  }

  private disposeWithin(timeoutMs: number): Promise<void> {
    if (!this.disposePromise) {
      const attempt = (async () => {
        if (this.abortListener) {
          this.lifetimeSignal?.removeEventListener('abort', this.abortListener);
        }
        await disposeWorkerResources(this.resources, timeoutMs);
      })();
      this.disposePromise = attempt.catch((error: unknown) => {
        if (this.disposePromise) this.disposePromise = undefined;
        throw error;
      });
    }
    return this.disposePromise;
  }
}

function mapProtocolError(error: CodexAppServerClientError): CodexDeviceLoginRunnerError {
  switch (error.kind) {
    case 'aborted':
      return new CodexDeviceLoginRunnerError('device_login_cancelled');
    case 'request_timeout':
      return new CodexDeviceLoginRunnerError('device_login_protocol_timeout');
    case 'process_exited':
    case 'transport_failed':
      return new CodexDeviceLoginRunnerError('device_login_worker_exited');
    case 'malformed_message':
    case 'message_too_large':
    case 'request_failed':
      return new CodexDeviceLoginRunnerError('device_login_protocol_invalid');
  }
}

function mapHandleError(error: unknown): CodexDeviceLoginRunnerError {
  if (error instanceof CodexDeviceLoginRunnerError) return error;
  if (error instanceof CodexAppServerClientError) return mapProtocolError(error);
  return new CodexDeviceLoginRunnerError('device_login_worker_exited');
}

async function runBoundedDirectExec(
  docker: Docker,
  container: Docker.Container,
  argv: readonly string[],
  stdoutMaxBytes: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<DirectExecResult> {
  return runBoundedOperation(signal, timeoutMs, async (boundedSignal) => {
    const exec = await container.exec({
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: [...argv],
      User: CODEX_LOGIN_NUMERIC_USER,
      WorkingDir: CODEX_LOGIN_HOME,
      Env: [`HOME=${CODEX_LOGIN_HOME}`, `CODEX_HOME=${CODEX_LOGIN_CODEX_HOME}`],
      abortSignal: boundedSignal,
    });
    const raw = await exec.start({
      hijack: true,
      stdin: false,
      Tty: false,
      abortSignal: boundedSignal,
    });
    const stdout = new BoundedSink(stdoutMaxBytes);
    const stderr = new BoundedSink(DEFAULT_STDERR_MAX_BYTES);
    docker.modem.demuxStream(raw, stdout, stderr);
    await waitForRawEnd(raw, boundedSignal);
    const inspected = await exec.inspect({ abortSignal: boundedSignal });
    return {
      exitCode: inspected.ExitCode ?? -1,
      stdout: stdout.toBuffer(),
      stdoutTruncated: stdout.truncated,
      stderrSummary: stderr.redactedSummary(),
    };
  });
}

function waitForRawEnd(raw: Duplex, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    raw.destroy();
    return Promise.reject(new BoundedOperationError(false));
  }
  if (raw.readableEnded) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      raw.off('end', onEnd);
      raw.off('close', onEnd);
      raw.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onEnd = (): void => finish(resolve);
    const onError = (): void =>
      finish(() => reject(new CodexAppServerClientError('transport_failed')));
    const onAbort = (): void => {
      raw.destroy();
      finish(() => reject(new BoundedOperationError(false)));
    };
    raw.once('end', onEnd);
    raw.once('close', onEnd);
    raw.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function endDemuxDestinationsWithRaw(
  raw: Duplex,
  stdout: PassThrough,
  stderr: BoundedSink,
): void {
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    stdout.end();
    stderr.end();
  };
  if (raw.readableEnded) {
    end();
    return;
  }
  raw.once('end', end);
  raw.once('close', end);
  raw.once('error', end);
}

async function disposeWorkerResources(
  resources: WorkerResources,
  timeoutMs: number,
): Promise<void> {
  resources.client.close();
  resources.raw.destroy();
  resources.stdout.destroy();
  resources.stderr.destroy();
  await disposeContainer(resources.container, timeoutMs);
}

async function disposeContainer(
  container: Docker.Container,
  timeoutMs: number,
): Promise<void> {
  const boundedTimeoutMs = positiveInteger(timeoutMs, DEFAULT_STAGE_TIMEOUT_MS);
  const deadlineMs = Date.now() + boundedTimeoutMs;
  const stopBudgetMs = Math.max(1, Math.min(1_000, Math.floor(boundedTimeoutMs / 3)));

  // Stop is best effort; force-remove remains the authoritative cleanup path.
  await runBoundedOperation(undefined, stopBudgetMs, (signal) =>
    container.stop({ t: 0, abortSignal: signal }),
  ).catch(() => undefined);

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptsLeft = 2 - attempt;
    const remainingMs = Math.max(1, deadlineMs - Date.now());
    const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / attemptsLeft));
    try {
      await runBoundedOperation(undefined, attemptTimeoutMs, (signal) =>
        container.remove({
          force: true,
          // dockerode 5 forwards this field even though @types/dockerode 4 does
          // not yet declare it on ContainerRemoveOptions.
          abortSignal: signal,
        } as Docker.ContainerRemoveOptions),
      );
      return;
    } catch (error) {
      if (isDockerNotFound(error)) return;
      lastError = error;
      if (isDockerConflict(error)) {
        const remainingAfterRemoveMs = Math.max(1, deadlineMs - Date.now());
        const observationTimeoutMs =
          attempt === 1
            ? remainingAfterRemoveMs
            : Math.min(
                REMOVE_CONFLICT_OBSERVATION_MS,
                Math.max(1, Math.floor(remainingAfterRemoveMs / 3)),
              );
        if (
          await waitForContainerAbsent(container, observationTimeoutMs).catch(
            () => false,
          )
        ) {
          return;
        }
      }
    }
  }

  void lastError;
  throw new CodexDeviceLoginRunnerError('device_login_worker_cleanup_failed');
}

async function waitForContainerAbsent(
  container: Docker.Container,
  timeoutMs: number,
): Promise<boolean> {
  const deadlineMs = Date.now() + positiveInteger(timeoutMs, 1);
  while (Date.now() < deadlineMs) {
    const remainingMs = Math.max(1, deadlineMs - Date.now());
    try {
      await runBoundedOperation(undefined, remainingMs, (signal) =>
        container.inspect({ abortSignal: signal }),
      );
    } catch (error) {
      if (isDockerNotFound(error)) return true;
      if (error instanceof BoundedOperationError) return false;
    }

    const delayMs = Math.min(
      REMOVE_INSPECT_POLL_MS,
      Math.max(0, deadlineMs - Date.now()),
    );
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

function runBoundedOperation<T>(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const boundedTimeoutMs = positiveInteger(timeoutMs, DEFAULT_STAGE_TIMEOUT_MS);
  if (parentSignal?.aborted) {
    return Promise.reject(new BoundedOperationError(false));
  }

  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = (): void => controller.abort();
  parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, boundedTimeoutMs);

  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new BoundedOperationError(timedOut)),
      { once: true },
    );
  });

  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([operationPromise, aborted]).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardAbort);
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function remainingUntil(deadlineMs: number): number {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new BoundedOperationError(true);
  return remainingMs;
}

function isDockerNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'statusCode' in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

function isDockerConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'statusCode' in error &&
    (error as { statusCode?: unknown }).statusCode === 409
  );
}

/** Internal test hook proving stderr is bounded and never surfaced verbatim. */
export function summarizeRedactedStderrForTest(
  chunks: readonly Buffer[],
  maxBytes = DEFAULT_STDERR_MAX_BYTES,
): string {
  const sink = new BoundedSink(maxBytes);
  for (const chunk of chunks) sink.write(chunk);
  sink.end();
  return sink.redactedSummary();
}
