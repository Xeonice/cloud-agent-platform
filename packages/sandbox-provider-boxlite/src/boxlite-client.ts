import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import type {
  SandboxCreateObservation,
  SandboxExternalBoundaryGuard,
  SandboxProvisioningDiagnosticChannel,
  SandboxProvisioningDiagnosticCommandKind,
  SandboxProvisioningDiagnosticObserver,
} from '@cap/sandbox-core';
import {
  classifySandboxCommandExecutionRejection,
  classifySandboxCommandExecutionResult,
  runSandboxExternalBoundary,
  sandboxCommandExecutionDiagnosticFields,
  SandboxCommandOutputSettlementError,
  SandboxCommandSettlementError,
} from '@cap/sandbox-core';
import {
  boxLiteHttpStatusClass,
  startBoxLiteProvisioningDiagnostic,
  type BoxLiteProvisioningDiagnosticFailureDefaults,
  type BoxLiteProvisioningDiagnosticLifecycle,
  type BoxLiteProvisioningDiagnosticOperationKey,
} from './boxlite-provisioning-diagnostics.js';

export interface BoxLiteSandboxMetadata {
  readonly [key: string]: unknown;
}

export interface BoxLiteSandbox {
  readonly id: string;
  readonly taskId?: string;
  readonly state?: string;
  readonly image?: string;
  readonly rootfsPath?: string;
  readonly diskSizeGb?: number;
  readonly baseUrl?: string;
  readonly terminalUrl?: string;
  readonly metadata?: BoxLiteSandboxMetadata;
}

/**
 * BoxLite create/setup may succeed before its response authority check or start
 * step fails. Surface the created identity to the provider and let its ownership
 * fence authorize any cleanup.
 */
export class BoxLitePartialCreateError extends Error {
  readonly sandbox: BoxLiteSandbox;
  override readonly cause: unknown;

  constructor(sandbox: BoxLiteSandbox, cause: unknown) {
    super(
      `BoxLite sandbox ${sandbox.id} was created but setup did not complete`,
    );
    this.name = 'BoxLitePartialCreateError';
    this.sandbox = sandbox;
    this.cause = cause;
  }
}

export interface BoxLiteCreateSandboxRequest {
  readonly taskId: string;
  readonly sandboxId?: string;
  readonly image?: string;
  readonly rootfsPath?: string;
  /** Native BoxLite root disk capacity; serialized as disk_size_gb. */
  readonly diskSizeGb?: number;
  readonly location?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly metadata?: BoxLiteSandboxMetadata;
  /** Internal durable-admission authority; never serialized to BoxLite. */
  readonly externalBoundaryGuard?: SandboxExternalBoundaryGuard;
  /** Internal durable create observation; never serialized to BoxLite. */
  readonly onSandboxCreateObserved?: (
    observation: SandboxCreateObservation,
  ) => Promise<void>;
  readonly cancellationSignal?: AbortSignal;
  /** Internal safe observer; never serialized to BoxLite. */
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
  /** Internal attempt/resource lineage; never serialized to BoxLite. */
  readonly diagnosticScope?: string;
}

export interface BoxLiteDiagnosticOperationOptions {
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
  readonly channel?: SandboxProvisioningDiagnosticChannel;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
  readonly cancellationSignal?: AbortSignal;
  readonly diagnosticKey?: BoxLiteProvisioningDiagnosticOperationKey;
  readonly diagnosticScope?: string;
}

export interface BoxLiteExecRequest {
  readonly sandboxId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly cancellationSignal?: AbortSignal;
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
  readonly diagnosticChannel?: SandboxProvisioningDiagnosticChannel;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
}

export type BoxLiteNativeExecutionState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'timed_out'
  | 'unknown';

export type BoxLiteNativeExecutionTerminalState = Extract<
  BoxLiteNativeExecutionState,
  'completed' | 'failed' | 'killed' | 'timed_out'
>;

export interface BoxLiteNativeExecutionOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

export type BoxLiteNativeExecutionAttachResult =
  | {
      readonly kind: 'success';
      readonly exitCode: number;
      readonly output: BoxLiteNativeExecutionOutput;
    }
  | {
      readonly kind: 'degraded';
      readonly settlement: 'transport' | 'protocol';
    }
  | {
      readonly kind: 'timed_out';
      readonly settlement: 'timeout';
    }
  | {
      readonly kind: 'cancelled';
      readonly settlement: 'cancellation';
    }
  | {
      /** Poll failed first, so output observation was intentionally stopped. */
      readonly kind: 'stopped';
    };

interface BoxLiteNativeExecutionAttachHandle {
  readonly result: Promise<BoxLiteNativeExecutionAttachResult>;
  stopAfterProcessFailure(): Promise<BoxLiteNativeExecutionAttachResult>;
}

type BoxLiteNativeExecutionBudgetReason = 'deadline' | 'cancellation';

interface BoxLiteNativeExecutionBudget {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  reason(): BoxLiteNativeExecutionBudgetReason | null;
  dispose(): void;
}

/** @internal Deterministic monotonic clock seam for native-exec conformance. */
export interface BoxLiteNativeExecutionDeadlineDriver {
  now(): number;
  schedule(delayMs: number, trigger: () => void): () => void;
}

/**
 * Provider-native poll classification before adapting to CAP's numeric command
 * result. Native terminal proof and its nullable exit code remain independent.
 */
export type BoxLiteNativeExecutionPollResult =
  | {
      readonly kind: 'pending';
      readonly nativeState: 'pending' | 'running';
      readonly exitCode: null;
    }
  | (BoxLiteNativeExecutionOutput & {
      readonly kind: 'terminal';
      readonly nativeState: BoxLiteNativeExecutionTerminalState;
      readonly exitCode: number | null;
      readonly outcome: 'succeeded' | 'failed' | 'timed_out';
      readonly cause:
        | null
        | 'command_failed'
        | 'missing_exit_code'
        | 'settlement_unknown';
      readonly retryable: boolean;
      readonly anomaly: 'missing_exit_code' | null;
    })
  | {
      readonly kind: 'invalid';
      readonly nativeState: BoxLiteNativeExecutionState;
      readonly exitCode: number | null;
      readonly outcome: 'failed';
      readonly cause: 'protocol_failed';
      readonly retryable: false;
      readonly anomaly: 'invalid_poll_settlement';
    };

export interface BoxLiteExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly timedOut?: boolean;
  /** Native-only safe state; ignored by the provider-neutral numeric adapter. */
  readonly nativeState?: BoxLiteNativeExecutionTerminalState;
  /** Exact provider value before a compatibility timeout sentinel is applied. */
  readonly nativeExitCode?: number | null;
}

export interface BoxLiteArchiveUploadRequest {
  readonly sandboxId: string;
  readonly path: string;
  /**
   * Archive bytes. An async iterable is streamed to the daemon as it is
   * produced (add-repo-content-store D4: a repo mirror is never buffered
   * wholesale in the API process); a `Uint8Array` keeps the existing
   * small-payload callers (secret files) unchanged.
   */
  readonly archive: Uint8Array | AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface BoxLiteArchiveDownloadRequest {
  readonly sandboxId: string;
  readonly path: string;
}

export interface BoxLiteStartExecutionRequest {
  readonly sandboxId: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly tty?: boolean;
  readonly timeoutMs?: number;
  readonly cancellationSignal?: AbortSignal;
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
  readonly diagnosticChannel?: SandboxProvisioningDiagnosticChannel;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
}

export interface BoxLiteStartedExecution {
  readonly id: string;
  readonly sandboxId: string;
}

export interface BoxLiteClient {
  createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox>;
  listSandboxes?(): Promise<readonly BoxLiteSandbox[]>;
  getSandbox(
    sandboxId: string,
    options?: BoxLiteDiagnosticOperationOptions,
  ): Promise<BoxLiteSandbox | null>;
  deleteSandbox(
    sandboxId: string,
    options?: BoxLiteDiagnosticOperationOptions,
  ): Promise<void>;
  exec(request: BoxLiteExecRequest): Promise<BoxLiteExecResult>;
  uploadArchive?(request: BoxLiteArchiveUploadRequest): Promise<void>;
  downloadArchive?(request: BoxLiteArchiveDownloadRequest): Promise<Uint8Array | null>;
  startExecution?(request: BoxLiteStartExecutionRequest): Promise<BoxLiteStartedExecution>;
}

export interface BoxLiteFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type BoxLiteFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string | Uint8Array | ReadableStream<Uint8Array>;
    /** Set with a streaming body; required by fetch/undici. */
    readonly duplex?: 'half';
    readonly signal?: unknown;
  },
) => Promise<BoxLiteFetchResponse>;

/** Streaming archive bodies arrive as async byte iterables. */
function isAsyncByteIterable(
  value: unknown,
): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
      'function'
  );
}

function asByteReadableStream(
  source: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

/** Buffer an archive body; only for callers that must hold the whole payload. */
export async function collectBoxLiteArchiveBytes(
  archive: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  if (archive instanceof Uint8Array) return archive.slice();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of archive) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface BoxLiteRestClientOptions {
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly timeoutMs?: number;
  readonly protocolMode?: 'native' | 'cap-rest';
  readonly pathPrefix?: string;
  readonly fetch?: BoxLiteFetch;
  /** Deterministic transport seam; production defaults to the ws client. */
  readonly webSocketFactory?: (
    url: string,
    options: { readonly headers: Readonly<Record<string, string>> },
  ) => WebSocket;
  /** @internal Deterministic deadline seam; production uses the monotonic clock. */
  readonly nativeExecutionDeadlineDriver?: BoxLiteNativeExecutionDeadlineDriver;
}

export class BoxLiteRestClient implements BoxLiteClient {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly timeoutMs: number;
  private readonly protocolMode: 'native' | 'cap-rest';
  private readonly pathPrefix: string;
  private readonly fetchImpl: BoxLiteFetch;
  private readonly webSocketFactory: NonNullable<
    BoxLiteRestClientOptions['webSocketFactory']
  >;
  private readonly nativeExecutionDeadlineDriver: BoxLiteNativeExecutionDeadlineDriver;

  constructor(options: BoxLiteRestClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.protocolMode = options.protocolMode ?? 'native';
    this.pathPrefix = normalizePathPrefix(options.pathPrefix ?? 'default');
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.nativeExecutionDeadlineDriver =
      options.nativeExecutionDeadlineDriver ??
      systemNativeExecutionDeadlineDriver;
    this.fetchImpl =
      options.fetch ??
      ((input, init) => {
        const fetchImpl = (globalThis as { readonly fetch?: BoxLiteFetch }).fetch;
        if (!fetchImpl) throw new Error('global fetch is not available');
        return fetchImpl(input, init);
      });
  }

  async createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox> {
    validateSandboxSource(request);
    if (this.protocolMode === 'native') {
      let createDiagnostic: BoxLiteProvisioningDiagnosticLifecycle | undefined;
      let created: BoxLiteSandbox | undefined;
      try {
        created = await runSandboxExternalBoundary({
          taskId: request.taskId,
          action: 'sandbox.create',
          guard: request.externalBoundaryGuard,
          signal: request.cancellationSignal,
          run: async () => {
            const diagnostic = startBoxLiteProvisioningDiagnostic(
              request.diagnostics,
              {
                key: 'sandbox.create',
                scope: request.diagnosticScope,
                stage: 'sandbox_creation',
                operation: 'sandbox_create',
                channel: 'primary',
              },
            );
            createDiagnostic = diagnostic;
            let sandbox: BoxLiteSandbox;
            try {
              sandbox = parseSandbox(
                await this.requestJson(this.nativeBoxesPath(), {
                  method: 'POST',
                  signal: request.cancellationSignal,
                  onDefinitiveRejection: async () => {
                    await request.onSandboxCreateObserved?.({
                      kind: 'not-created',
                    });
                  },
                  body: {
                    name: request.sandboxId ?? request.taskId,
                    ...(request.rootfsPath
                      ? { rootfs_path: request.rootfsPath }
                      : { image: request.image }),
                    disk_size_gb: request.diskSizeGb,
                    env: request.env,
                  },
                }),
              );
            } catch (error) {
              settleBoxLiteRequestDiagnostic(diagnostic, error, {
                signal: request.cancellationSignal,
                outcome: 'indeterminate',
                cause: 'settlement_unknown',
                retryable: true,
              });
              throw error;
            }
            diagnostic.succeed();
            created = sandbox;
            await request.onSandboxCreateObserved?.({
              kind: 'created',
              providerSandboxId: sandbox.id,
            });
            return sandbox;
          },
        });
      } catch (error) {
        if (createDiagnostic !== undefined) {
          settleBoxLiteRequestDiagnostic(createDiagnostic, error, {
            signal: request.cancellationSignal,
            outcome: 'indeterminate',
            cause: 'settlement_unknown',
            retryable: true,
          });
        }
        if (created) throw new BoxLitePartialCreateError(created, error);
        throw error;
      }
      if (!created) throw new Error('BoxLite create returned no sandbox');
      const sandbox = created;
      let startDiagnostic: BoxLiteProvisioningDiagnosticLifecycle | undefined;
      try {
        const started = await runSandboxExternalBoundary({
          taskId: request.taskId,
          action: 'sandbox.start',
          guard: request.externalBoundaryGuard,
          signal: request.cancellationSignal,
          run: async () => {
            const diagnostic = startBoxLiteProvisioningDiagnostic(
              request.diagnostics,
              {
                key: 'sandbox.start',
                scope: request.diagnosticScope,
                stage: 'sandbox_start',
                operation: 'sandbox_start',
                channel: 'primary',
              },
            );
            startDiagnostic = diagnostic;
            try {
              const value = parseSandbox(
                await this.requestJson(`${this.sandboxPath(sandbox.id)}/start`, {
                  method: 'POST',
                  signal: request.cancellationSignal,
                }),
              );
              diagnostic.succeed();
              return value;
            } catch (error) {
              settleBoxLiteRequestDiagnostic(diagnostic, error, {
                signal: request.cancellationSignal,
                outcome: 'indeterminate',
                cause: 'settlement_unknown',
                retryable: true,
              });
              throw error;
            }
          },
        });
        return {
          ...sandbox,
          ...started,
          diskSizeGb: started.diskSizeGb ?? sandbox.diskSizeGb,
        };
      } catch (error) {
        if (startDiagnostic !== undefined) {
          settleBoxLiteRequestDiagnostic(startDiagnostic, error, {
            signal: request.cancellationSignal,
            outcome: 'indeterminate',
            cause: 'settlement_unknown',
            retryable: true,
          });
        }
        throw new BoxLitePartialCreateError(sandbox, error);
      }
    }
    if (request.rootfsPath) {
      throw new Error('BoxLite rootfsPath create is only supported with native protocol mode');
    }
    if (request.diskSizeGb !== undefined) {
      throw new Error(
        'BoxLite diskSizeGb create is only supported with native protocol mode',
      );
    }
    let createDiagnostic: BoxLiteProvisioningDiagnosticLifecycle | undefined;
    let created: BoxLiteSandbox | undefined;
    try {
      return await runSandboxExternalBoundary({
        taskId: request.taskId,
        action: 'sandbox.create',
        guard: request.externalBoundaryGuard,
        signal: request.cancellationSignal,
        run: async () => {
          const diagnostic = startBoxLiteProvisioningDiagnostic(
            request.diagnostics,
            {
              key: 'sandbox.create',
              scope: request.diagnosticScope,
              stage: 'sandbox_creation',
              operation: 'sandbox_create',
              channel: 'primary',
            },
          );
          createDiagnostic = diagnostic;
          let sandbox: BoxLiteSandbox;
          try {
            sandbox = parseSandbox(
              await this.requestJson('/v1/sandboxes', {
                method: 'POST',
                signal: request.cancellationSignal,
                onDefinitiveRejection: async () => {
                  await request.onSandboxCreateObserved?.({
                    kind: 'not-created',
                  });
                },
                body: stripCreateBoundaryFields(request),
              }),
            );
          } catch (error) {
            settleBoxLiteRequestDiagnostic(diagnostic, error, {
              signal: request.cancellationSignal,
              outcome: 'indeterminate',
              cause: 'settlement_unknown',
              retryable: true,
            });
            throw error;
          }
          diagnostic.succeed();
          created = sandbox;
          await request.onSandboxCreateObserved?.({
            kind: 'created',
            providerSandboxId: sandbox.id,
          });
          return sandbox;
        },
      });
    } catch (error) {
      if (createDiagnostic !== undefined) {
        settleBoxLiteRequestDiagnostic(createDiagnostic, error, {
          signal: request.cancellationSignal,
          outcome: 'indeterminate',
          cause: 'settlement_unknown',
          retryable: true,
        });
      }
      if (created) throw new BoxLitePartialCreateError(created, error);
      throw error;
    }
  }

  async getSandbox(
    sandboxId: string,
    options: BoxLiteDiagnosticOperationOptions = {},
  ): Promise<BoxLiteSandbox | null> {
    const diagnostic = startBoxLiteProvisioningDiagnostic(
      options.diagnostics,
      {
        ...(options.diagnosticKey === undefined
          ? {}
          : { key: options.diagnosticKey }),
        scope: options.diagnosticScope,
        stage: 'sandbox_inspect',
        operation: 'sandbox_inspect',
        channel: options.channel ?? 'primary',
      },
    );
    let res: BoxLiteFetchResponse;
    try {
      res = await this.request(this.sandboxPath(sandboxId), {
        method: 'GET',
        signal: options.cancellationSignal,
      });
    } catch (error) {
      settleBoxLiteRequestDiagnostic(diagnostic, error, {
        signal: options.cancellationSignal,
      });
      throw error;
    }
    if (res.status === 404 || res.status === 204) {
      diagnostic.succeed({ httpStatusClass: boxLiteHttpStatusClass(res.status) });
      return null;
    }
    if (!res.ok) {
      diagnostic.failHttp(res.status);
      throw new Error(`BoxLite get sandbox ${sandboxId} failed: HTTP ${res.status}`);
    }
    try {
      const sandbox = parseOptionalSandbox(
        await res.json().catch(() => undefined),
      );
      diagnostic.succeed({ httpStatusClass: boxLiteHttpStatusClass(res.status) });
      return sandbox;
    } catch (error) {
      diagnostic.fail(error, {
        cause: 'protocol_failed',
        retryable: false,
      });
      throw error;
    }
  }

  async listSandboxes(): Promise<readonly BoxLiteSandbox[]> {
    const raw = await this.requestJson(
      this.protocolMode === 'native' ? this.nativeBoxesPath() : '/v1/sandboxes',
      { method: 'GET' },
    );
    return parseSandboxList(raw);
  }

  async deleteSandbox(
    sandboxId: string,
    options: BoxLiteDiagnosticOperationOptions = {},
  ): Promise<void> {
    const diagnostic = startBoxLiteProvisioningDiagnostic(
      options.diagnostics,
      {
        stage: 'cleanup',
        operation: 'sandbox_delete',
        channel: options.channel ?? 'cleanup',
        commandKind: 'sandbox_cleanup',
      },
    );
    let res: BoxLiteFetchResponse;
    try {
      res = await this.request(this.sandboxPath(sandboxId), {
        method: 'DELETE',
        signal: options.cancellationSignal,
      });
    } catch (error) {
      settleBoxLiteRequestDiagnostic(diagnostic, error, {
        signal: options.cancellationSignal,
        outcome: 'indeterminate',
        cause: 'cleanup_unconfirmed',
        retryable: true,
      });
      throw error;
    }
    if (!res.ok && res.status !== 404) {
      diagnostic.failHttp(res.status, {
        cause: 'cleanup_failed',
        retryable: res.status === 408 || res.status === 429 || res.status >= 500,
      });
      throw new BoxLiteHttpRequestError(
        res.status,
        `BoxLite delete sandbox ${sandboxId} failed: HTTP ${res.status}`,
      );
    }
    diagnostic.succeed({ httpStatusClass: boxLiteHttpStatusClass(res.status) });
  }

  async exec(request: BoxLiteExecRequest): Promise<BoxLiteExecResult> {
    if (this.protocolMode === 'native') {
      const budget = createNativeExecutionBudget(
        request.timeoutMs ?? this.timeoutMs,
        request.cancellationSignal,
        this.nativeExecutionDeadlineDriver,
      );
      const settlementDiagnostic = startBoxLiteProvisioningDiagnostic(
        request.diagnostics,
        {
          stage: 'settlement',
          operation: 'native_exec_settlement',
          channel: request.diagnosticChannel ?? 'primary',
          ...(request.commandKind === undefined
            ? {}
            : { commandKind: request.commandKind }),
        },
      );
      try {
        throwIfNativeExecutionBudgetEnded(budget);
        let started: BoxLiteStartedExecution;
        try {
          started = await this.startNativeExecution(
            {
              sandboxId: request.sandboxId,
              command: 'sh',
              args: ['-lc', request.command],
              cwd: request.cwd,
              tty: false,
              timeoutMs: request.timeoutMs,
              cancellationSignal: request.cancellationSignal,
              diagnostics: request.diagnostics,
              diagnosticChannel: request.diagnosticChannel,
              commandKind: request.commandKind,
            },
            budget.signal,
            null,
            budget,
          );
        } catch (error) {
          throw mapNativeExecutionBudgetRejection(error, budget);
        }
        const attach = this.collectNativeExecutionOutput(
          started.sandboxId,
          started.id,
          budget,
          request.diagnostics,
          request.diagnosticChannel,
          request.commandKind,
        );
        throwIfNativeExecutionBudgetEnded(budget);
        let polled: BoxLiteExecResult;
        try {
          polled = await this.waitForNativeExecution(
            started.sandboxId,
            started.id,
            budget,
            request.diagnostics,
            request.diagnosticChannel,
            request.commandKind,
            request.cancellationSignal,
          );
        } catch (error) {
          await attach.stopAfterProcessFailure();
          throw error;
        }
        const attached = await attach.result;
        const result = mergeExecOutput(polled, attached);
        settleBoxLiteExecResultDiagnostic(
          settlementDiagnostic,
          result,
          budget.timeoutMs,
        );
        return result;
      } catch (error) {
        settleBoxLiteCommandRejectionDiagnostic(
          settlementDiagnostic,
          error,
          request.cancellationSignal,
          budget.timeoutMs,
        );
        throw error;
      } finally {
        budget.dispose();
      }
    }
    const startDiagnostic = startBoxLiteProvisioningDiagnostic(
      request.diagnostics,
      {
        stage: 'native_execution',
        operation: 'native_exec_start',
        channel: request.diagnosticChannel ?? 'primary',
        ...(request.commandKind === undefined
          ? {}
          : { commandKind: request.commandKind }),
      },
    );
    const settlementDiagnostic = startBoxLiteProvisioningDiagnostic(
      request.diagnostics,
      {
        stage: 'settlement',
        operation: 'native_exec_settlement',
        channel: request.diagnosticChannel ?? 'primary',
        ...(request.commandKind === undefined
          ? {}
          : { commandKind: request.commandKind }),
      },
    );
    try {
      const result = parseExecResult(
        await this.requestJson(
          `/v1/sandboxes/${encodeURIComponent(request.sandboxId)}/exec`,
          {
            method: 'POST',
            signal: request.cancellationSignal,
            body: {
              command: request.command,
              cwd: request.cwd,
              timeoutMs: request.timeoutMs,
            },
          },
        ),
      );
      startDiagnostic.succeed();
      settleBoxLiteExecResultDiagnostic(
        settlementDiagnostic,
        result,
        request.timeoutMs,
      );
      return result;
    } catch (error) {
      settleBoxLiteRequestDiagnostic(startDiagnostic, error, {
        signal: request.cancellationSignal,
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
      });
      settleBoxLiteCommandRejectionDiagnostic(
        settlementDiagnostic,
        error,
        request.cancellationSignal,
        request.timeoutMs,
      );
      throw error;
    }
  }

  async uploadArchive(request: BoxLiteArchiveUploadRequest): Promise<void> {
    // A streamed archive owns its own deadline through the caller's signal:
    // the shared request timeout is sized for control-plane calls, not for
    // moving a repository-sized tar.
    const streaming = !(request.archive instanceof Uint8Array);
    const transfer = {
      body: request.archive,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(streaming ? { timeoutMs: null as null } : {}),
    };
    if (this.protocolMode === 'native') {
      const path = encodeURIComponent(request.path);
      const res = await this.request(
        `${this.sandboxPath(request.sandboxId)}/files?path=${path}`,
        {
          method: 'PUT',
          ...transfer,
        },
      );
      if (!res.ok) {
        throw new Error(
          `BoxLite file upload for sandbox ${request.sandboxId} failed: HTTP ${res.status}`,
        );
      }
      return;
    }
    const path = encodeURIComponent(request.path);
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(request.sandboxId)}/archive?path=${path}`,
      {
        method: 'PUT',
        ...transfer,
      },
    );
    if (!res.ok) {
      throw new Error(
        `BoxLite archive upload for sandbox ${request.sandboxId} failed: HTTP ${res.status}`,
      );
    }
  }

  async downloadArchive(
    request: BoxLiteArchiveDownloadRequest,
  ): Promise<Uint8Array | null> {
    if (this.protocolMode === 'native') {
      const path = encodeURIComponent(request.path);
      const res = await this.request(
        `${this.sandboxPath(request.sandboxId)}/files?path=${path}`,
        { method: 'GET' },
      );
      if (res.status === 404 || res.status === 204) return null;
      if (!res.ok) {
        throw new Error(
          `BoxLite file download for sandbox ${request.sandboxId} failed: HTTP ${res.status}`,
        );
      }
      const buffer = await res.arrayBuffer?.();
      return buffer ? new Uint8Array(buffer) : null;
    }
    const path = encodeURIComponent(request.path);
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(request.sandboxId)}/archive?path=${path}`,
      { method: 'GET' },
    );
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) {
      throw new Error(
        `BoxLite archive download for sandbox ${request.sandboxId} failed: HTTP ${res.status}`,
      );
    }
    const buffer = await res.arrayBuffer?.();
    return buffer ? new Uint8Array(buffer) : null;
  }

  async startExecution(
    request: BoxLiteStartExecutionRequest,
  ): Promise<BoxLiteStartedExecution> {
    return this.startNativeExecution(
      request,
      request.cancellationSignal,
      undefined,
      undefined,
    );
  }

  private async startNativeExecution(
    request: BoxLiteStartExecutionRequest,
    transportSignal: AbortSignal | undefined,
    requestTimeoutMs: number | null | undefined,
    sharedBudget: BoxLiteNativeExecutionBudget | undefined,
  ): Promise<BoxLiteStartedExecution> {
    const diagnostic = startBoxLiteProvisioningDiagnostic(
      request.diagnostics,
      {
        stage: 'native_execution',
        operation: 'native_exec_start',
        channel: request.diagnosticChannel ?? 'primary',
        ...(request.commandKind === undefined
          ? {}
          : { commandKind: request.commandKind }),
      },
    );
    let raw: unknown;
    try {
      raw = await this.requestJson(
        `${this.sandboxPath(request.sandboxId)}/exec`,
        {
          method: 'POST',
          signal: transportSignal,
          timeoutMs: requestTimeoutMs,
          body: {
            command: request.command,
            args: request.args,
            working_dir: request.cwd,
            tty: request.tty === true,
            timeout_seconds:
              request.timeoutMs === undefined
                ? undefined
                : Math.max(1, Math.ceil(request.timeoutMs / 1000)),
          },
        },
      );
    } catch (error) {
      const budgetError = nativeExecutionBudgetError(sharedBudget);
      if (budgetError !== null && sharedBudget !== undefined) {
        settleNativeExecutionStartBudgetDiagnostic(
          diagnostic,
          budgetError,
          sharedBudget,
        );
        throw budgetError;
      }
      settleBoxLiteRequestDiagnostic(diagnostic, error, {
        signal: request.cancellationSignal,
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
      });
      throw error;
    }
    const postRequestBudgetError = nativeExecutionBudgetError(sharedBudget);
    if (postRequestBudgetError !== null && sharedBudget !== undefined) {
      settleNativeExecutionStartBudgetDiagnostic(
        diagnostic,
        postRequestBudgetError,
        sharedBudget,
      );
      throw postRequestBudgetError;
    }
    try {
      const started = parseStartedExecution(raw, request.sandboxId);
      diagnostic.succeed();
      return started;
    } catch {
      const budgetError = nativeExecutionBudgetError(sharedBudget);
      if (budgetError !== null && sharedBudget !== undefined) {
        settleNativeExecutionStartBudgetDiagnostic(
          diagnostic,
          budgetError,
          sharedBudget,
        );
        throw budgetError;
      }
      const error = new SandboxCommandSettlementError('protocol');
      settleBoxLiteRequestDiagnostic(diagnostic, error, {
        outcome: 'failed',
        cause: 'protocol_failed',
        retryable: false,
      });
      throw error;
    }
  }

  private async requestJson(
    path: string,
    init: {
      readonly method: string;
      readonly body?: unknown;
      readonly onDefinitiveRejection?: () => Promise<void>;
      readonly signal?: AbortSignal;
      /** null means an outer operation already owns the only deadline timer. */
      readonly timeoutMs?: number | null;
    },
  ): Promise<unknown> {
    const res = await this.request(path, init);
    if (!res.ok) {
      if (isDefinitiveCreateRejectionStatus(res.status)) {
        await init.onDefinitiveRejection?.();
      }
      const text =
        typeof res.text === 'function'
          ? await res.text().catch(() => '')
          : '';
      const detail = text.trim() ? `: ${text.trim().slice(0, 500)}` : '';
      throw new BoxLiteHttpRequestError(
        res.status,
        `BoxLite request ${init.method} ${path} failed: HTTP ${res.status}${detail}`,
      );
    }
    return res.json().catch(() => undefined);
  }

  private async request(
    path: string,
    init: {
      readonly method: string;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number | null;
    },
  ): Promise<BoxLiteFetchResponse> {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    let body: string | Uint8Array | ReadableStream<Uint8Array> | undefined;
    let streamed = false;
    if (typeof init.body === 'string' || init.body instanceof Uint8Array) {
      body = init.body;
      if (init.body instanceof Uint8Array) {
        headers['content-type'] = 'application/octet-stream';
      }
    } else if (isAsyncByteIterable(init.body)) {
      // Streamed archive upload: the bytes are forwarded as they are produced,
      // so an arbitrarily large repo copy never lands in one buffer.
      headers['content-type'] = 'application/octet-stream';
      body = asByteReadableStream(init.body);
      streamed = true;
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    if (this.apiToken) {
      Object.assign(headers, this.authHeaders());
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body,
        // Required by fetch (undici) whenever the body is a stream.
        ...(streamed ? { duplex: 'half' as const } : {}),
        signal:
          init.timeoutMs === null
            ? init.signal
            : combineRequestSignal(
                init.timeoutMs ?? this.timeoutMs,
                init.signal,
              ),
      });
    } catch (error) {
      markBoxLiteTransportRequestFailure(error);
      throw error;
    }
  }

  private sandboxPath(sandboxId: string): string {
    return this.protocolMode === 'native'
      ? `${this.nativeBoxesPath()}/${encodePathSegment(sandboxId)}`
      : `/v1/sandboxes/${encodeURIComponent(sandboxId)}`;
  }

  private nativeBoxesPath(): string {
    return `${this.nativeApiPath()}/boxes`;
  }

  private nativeExecutionPath(sandboxId: string, executionId: string): string {
    return `${this.sandboxPath(sandboxId)}/executions/${encodePathSegment(executionId)}`;
  }

  private nativeApiPath(): string {
    return this.pathPrefix ? `/v1/${this.pathPrefix}` : '/v1';
  }

  private async waitForNativeExecution(
    sandboxId: string,
    executionId: string,
    budget: BoxLiteNativeExecutionBudget,
    diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
    diagnosticChannel: SandboxProvisioningDiagnosticChannel | undefined,
    commandKind: SandboxProvisioningDiagnosticCommandKind | undefined,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<BoxLiteExecResult> {
    const pollDiagnostic = startBoxLiteProvisioningDiagnostic(diagnostics, {
      stage: 'settlement',
      operation: 'native_exec_poll',
      channel: diagnosticChannel ?? 'primary',
      ...(commandKind === undefined ? {} : { commandKind }),
    });
    while (true) {
      const budgetReason = budget.reason();
      if (
        budgetReason === 'cancellation' ||
        cancellationSignal?.aborted === true
      ) {
        const terminal = {
          outcome: 'cancelled',
          cause: 'cancelled',
          retryable: false,
          exitCode: null,
        } as const;
        pollDiagnostic.settle(terminal);
        throw new SandboxCommandSettlementError('cancellation');
      }
      if (budgetReason === 'deadline') break;
      if (budget.remainingMs() <= 0) break;
      let raw: unknown;
      try {
        raw = await this.requestJson(
          this.nativeExecutionPath(sandboxId, executionId),
          { method: 'GET', signal: budget.signal, timeoutMs: null },
        );
      } catch (error) {
        const failureReason = budget.reason();
        if (
          failureReason === 'cancellation' ||
          isSignalAborted(cancellationSignal)
        ) {
          const terminal = {
            outcome: 'cancelled',
            cause: 'cancelled',
            retryable: false,
            exitCode: null,
          } as const;
          pollDiagnostic.settle(terminal);
          throw new SandboxCommandSettlementError('cancellation');
        }
        if (failureReason === 'deadline') break;
        settleBoxLiteRequestDiagnostic(pollDiagnostic, error, {
          anomaly: 'poll_transport_failure',
          retryable: true,
        });
        // Provider request details and raw failures stay below this boundary.
        throw new SandboxCommandSettlementError('transport');
      }
      const postRequestReason = budget.reason();
      if (
        postRequestReason === 'cancellation' ||
        isSignalAborted(cancellationSignal)
      ) {
        pollDiagnostic.settle({
          outcome: 'cancelled',
          cause: 'cancelled',
          retryable: false,
          exitCode: null,
        });
        throw new SandboxCommandSettlementError('cancellation');
      }
      if (
        postRequestReason === 'deadline' ||
        budget.remainingMs() <= 0
      ) {
        break;
      }
      const result = parseBoxLiteNativeExecutionPollResult(raw);
      if (result.kind !== 'pending') {
        if (result.kind === 'invalid') {
          const terminal = {
            outcome: result.outcome,
            cause: result.cause,
            retryable: result.retryable,
            nativeState: result.nativeState,
            anomaly: result.anomaly,
            exitCode: result.exitCode,
          } as const;
          pollDiagnostic.settle(terminal);
        } else {
          pollDiagnostic.succeed({
            nativeState: result.nativeState,
            exitCode: result.exitCode,
          });
        }
        return adaptBoxLiteNativeExecutionResult(result);
      }
      await waitForNativePollInterval(
        Math.min(250, budget.remainingMs()),
        budget.signal,
      );
    }
    const terminal = {
      outcome: 'indeterminate',
      cause: 'settlement_unknown',
      retryable: true,
      nativeState: 'unknown',
      anomaly: 'poll_timeout',
      exitCode: null,
      timeoutMs: budget.timeoutMs,
    } as const;
    pollDiagnostic.settle(terminal);
    // A poll deadline is absence of terminal proof, not a provider timeout or
    // an invented numeric exit code.
    throw new SandboxCommandSettlementError('indeterminate');
  }

  private collectNativeExecutionOutput(
    sandboxId: string,
    executionId: string,
    budget: BoxLiteNativeExecutionBudget,
    diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
    diagnosticChannel: SandboxProvisioningDiagnosticChannel | undefined,
    commandKind: SandboxProvisioningDiagnosticCommandKind | undefined,
  ): BoxLiteNativeExecutionAttachHandle {
    const diagnostic = startBoxLiteProvisioningDiagnostic(diagnostics, {
      stage: 'native_execution',
      operation: 'native_exec_attach',
      channel: diagnosticChannel ?? 'primary',
      ...(commandKind === undefined ? {} : { commandKind }),
    });
    let stopAfterProcessFailure: () => Promise<BoxLiteNativeExecutionAttachResult>;
    const result = new Promise<BoxLiteNativeExecutionAttachResult>((resolve) => {
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let settled = false;
      let socket: WebSocket | null = null;
      const finish = (
        settlement:
          | 'success'
          | 'transport'
          | 'protocol'
          | 'timed_out'
          | 'cancelled'
          | 'stopped',
        exitCode?: number,
        socketAlreadyClosed = false,
      ) => {
        if (settled) return;
        settled = true;
        budget.signal.removeEventListener('abort', onBudgetAbort);
        const finalStdout = stdout + stdoutDecoder.end();
        const finalStderr = stderr + stderrDecoder.end();
        stdout = '';
        stderr = '';
        let successfulDrain = false;
        if (settlement === 'timed_out') {
          diagnostic.settle({
            outcome: 'timed_out',
            cause: 'settlement_unknown',
            retryable: true,
            anomaly: 'attach_degraded',
            timeoutMs: budget.timeoutMs,
          });
          resolve({ kind: 'timed_out', settlement: 'timeout' });
        } else if (settlement === 'transport') {
          diagnostic.settle({
            outcome: 'degraded',
            cause: 'transport_failed',
            retryable: true,
            anomaly: 'attach_degraded',
          });
          resolve({ kind: 'degraded', settlement: 'transport' });
        } else if (settlement === 'protocol') {
          diagnostic.settle({
            outcome: 'degraded',
            cause: 'protocol_failed',
            retryable: false,
            anomaly: 'attach_degraded',
          });
          resolve({ kind: 'degraded', settlement: 'protocol' });
        } else if (settlement === 'cancelled') {
          diagnostic.settle({
            outcome: 'cancelled',
            cause: 'cancelled',
            retryable: false,
            anomaly: 'attach_degraded',
          });
          resolve({ kind: 'cancelled', settlement: 'cancellation' });
        } else if (settlement === 'stopped') {
          diagnostic.settle({
            outcome: 'degraded',
            cause: 'settlement_unknown',
            retryable: true,
            anomaly: 'attach_degraded',
          });
          resolve({ kind: 'stopped' });
        } else {
          if (!Number.isSafeInteger(exitCode)) {
            diagnostic.settle({
              outcome: 'degraded',
              cause: 'protocol_failed',
              retryable: false,
              anomaly: 'attach_degraded',
            });
            resolve({ kind: 'degraded', settlement: 'protocol' });
          } else {
            const settledExitCode = exitCode as number;
            successfulDrain = true;
            diagnostic.succeed({ exitCode: settledExitCode });
            resolve({
              kind: 'success',
              exitCode: settledExitCode,
              output: {
                stdout: finalStdout,
                stderr: finalStderr,
                output: `${finalStdout}${finalStderr}`,
              },
            });
          }
        }
        if (socketAlreadyClosed) {
          detachSocketListeners(socket);
          socket = null;
        } else {
          shutdownSocket(successfulDrain ? 'graceful' : 'force');
        }
      };

      function detachSocketListeners(target: WebSocket | null): void {
        if (target === null) return;
        target.off('message', onMessage);
        target.off('close', onClose);
        target.off('error', onError);
      }

      function shutdownSocket(mode: 'graceful' | 'force'): void {
        const target = socket;
        if (target === null) return;
        detachSocketListeners(target);
        const needsShutdownGuard =
          typeof target.readyState === 'number' &&
          target.readyState !== WebSocket.CLOSED;
        const removeShutdownGuards = (): void => {
          target.off('error', onShutdownError);
          target.off('close', onShutdownClose);
          if (socket === target) socket = null;
        };
        const onShutdownError = (): void => {};
        const onShutdownClose = (): void => removeShutdownGuards();
        // ws can emit one or more transport errors while CONNECTING, OPEN, or
        // CLOSING. Keep the no-op error guard until close owns final cleanup.
        if (needsShutdownGuard) {
          target.on('error', onShutdownError);
          target.once('close', onShutdownClose);
        }
        try {
          if (mode === 'force' && typeof target.terminate === 'function') {
            target.terminate();
          } else {
            target.close();
          }
        } catch {
          removeShutdownGuards();
          socket = null;
          return;
        }
        if (
          !needsShutdownGuard ||
          Number(target.readyState) === WebSocket.CLOSED
        ) {
          removeShutdownGuards();
        }
      }

      function onMessage(raw: WebSocket.RawData, isBinary: boolean): void {
        if (settled) return;
        const messageBudgetReason = budget.reason();
        if (messageBudgetReason !== null) {
          finish(
            messageBudgetReason === 'cancellation'
              ? 'cancelled'
              : 'timed_out',
          );
          return;
        }
        try {
          if (!isBinary) {
            const text = rawToBuffer(raw).toString('utf8');
            const frame = parseControlFrame(text);
            if (frame === null) {
              finish('protocol');
            } else {
              finish('success', frame.exitCode);
            }
            return;
          }
          const buffer = rawToBuffer(raw);
          if (buffer.length === 0) {
            finish('protocol');
            return;
          }
          const channel = buffer[0];
          const payload = buffer.subarray(1);
          if (channel === 1) {
            stdout += stdoutDecoder.write(payload);
          } else if (channel === 2) {
            stderr += stderrDecoder.write(payload);
          } else {
            finish('protocol');
          }
        } catch {
          finish('protocol');
        }
      }

      function onClose(): void {
        if (!settled) finish('transport', undefined, true);
        detachSocketListeners(socket);
        socket = null;
      }

      function onError(): void {
        if (!settled) finish('transport');
      }

      function onBudgetAbort(): void {
        finish(
          budget.reason() === 'cancellation' ? 'cancelled' : 'timed_out',
        );
      }

      stopAfterProcessFailure = () => {
        if (!settled) {
          const reason = budget.reason();
          finish(
            reason === 'cancellation'
              ? 'cancelled'
              : reason === 'deadline'
                ? 'timed_out'
                : 'stopped',
          );
        }
        return result;
      };

      budget.signal.addEventListener('abort', onBudgetAbort, { once: true });
      const initialReason = budget.reason();
      if (initialReason !== null) {
        onBudgetAbort();
        return;
      }

      try {
        socket = this.webSocketFactory(
          `${this.baseUrl.replace(/^http/, 'ws')}${this.nativeExecutionPath(sandboxId, executionId)}/attach`,
          { headers: this.authHeaders() },
        );
      } catch {
        finish('transport');
        return;
      }

      if (settled) {
        shutdownSocket('force');
        return;
      }

      try {
        socket.on('message', onMessage);
        socket.on('close', onClose);
        socket.on('error', onError);
      } catch {
        finish('transport');
      }
    });
    return Object.freeze({
      result,
      stopAfterProcessFailure: () => stopAfterProcessFailure(),
    });
  }

  private authHeaders(): Record<string, string> {
    return this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {};
  }
}

function isDefinitiveCreateRejectionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

class BoxLiteHttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BoxLiteHttpRequestError';
  }
}

/** Extract only the bounded HTTP status needed by the outer cleanup seam. */
export function boxLiteHttpStatusFromError(
  error: unknown,
): number | undefined {
  return error instanceof BoxLiteHttpRequestError ? error.status : undefined;
}

function settleBoxLiteRequestDiagnostic(
  diagnostic: BoxLiteProvisioningDiagnosticLifecycle,
  error: unknown,
  defaults: BoxLiteProvisioningDiagnosticFailureDefaults = {},
): void {
  if (error instanceof BoxLiteHttpRequestError) {
    const {
      outcome: _transportOutcome,
      cause: _transportCause,
      retryable: _transportRetryable,
      signal: _transportSignal,
      ...httpSafeFacts
    } = defaults;
    void _transportOutcome;
    void _transportCause;
    void _transportRetryable;
    void _transportSignal;
    diagnostic.failHttp(error.status, httpSafeFacts);
    return;
  }
  if (isBoxLiteTransportRequestFailure(error)) {
    diagnostic.fail(error, defaults);
    return;
  }
  diagnostic.fail(error, {
    cause: 'protocol_failed',
    retryable: false,
    ...(defaults.signal === undefined ? {} : { signal: defaults.signal }),
    ...(defaults.nativeState === undefined
      ? {}
      : { nativeState: defaults.nativeState }),
    ...(defaults.anomaly === undefined ? {} : { anomaly: defaults.anomaly }),
    ...(defaults.exitCode === undefined ? {} : { exitCode: defaults.exitCode }),
    ...(defaults.timeoutMs === undefined
      ? {}
      : { timeoutMs: defaults.timeoutMs }),
  });
}

function settleBoxLiteExecResultDiagnostic(
  diagnostic: BoxLiteProvisioningDiagnosticLifecycle,
  result: BoxLiteExecResult,
  timeoutMs: number | undefined,
): void {
  const classification = classifySandboxCommandExecutionResult({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.output,
    timedOut: result.timedOut === true,
  });
  diagnostic.settle({
    ...sandboxCommandExecutionDiagnosticFields(classification),
    ...(result.nativeState === undefined
      ? {}
      : { nativeState: result.nativeState }),
    ...(result.nativeExitCode === undefined
      ? {}
      : { exitCode: result.nativeExitCode }),
    ...(classification.outcome === 'timed_out' && timeoutMs !== undefined
      ? { timeoutMs }
      : {}),
  });
}

function settleBoxLiteCommandRejectionDiagnostic(
  diagnostic: BoxLiteProvisioningDiagnosticLifecycle,
  error: unknown,
  cancellationSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): void {
  const classification = classifySandboxCommandExecutionRejection(
    error,
    cancellationSignal,
  );
  diagnostic.settle({
    ...sandboxCommandExecutionDiagnosticFields(classification),
    ...(classification.outcome === 'timed_out' && timeoutMs !== undefined
      ? { timeoutMs }
      : {}),
  });
}

const boxLiteTransportRequestFailures = new WeakSet<object>();

function markBoxLiteTransportRequestFailure(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    boxLiteTransportRequestFailures.add(error);
  }
}

function isBoxLiteTransportRequestFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    boxLiteTransportRequestFailures.has(error)
  );
}

export interface FakeBoxLiteClientOptions {
  readonly execHandler?: (request: BoxLiteExecRequest) => BoxLiteExecResult | Promise<BoxLiteExecResult>;
  /**
   * Modeled daemon request-body limit. BoxLite serve buffers each file upload
   * wholesale and rejects bodies above ~2MB with 413 `length limit exceeded`
   * (observed on 0.9.5, chunk-archive-injection-with-progress); the fake
   * enforces the same ceiling so tests cannot regress to single oversized
   * uploads. Override only to model a different daemon build.
   */
  readonly uploadBodyLimitBytes?: number;
}

export const FAKE_BOXLITE_UPLOAD_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export class FakeBoxLiteClient implements BoxLiteClient {
  readonly sandboxes = new Map<string, BoxLiteSandbox>();
  readonly createCalls: BoxLiteCreateSandboxRequest[] = [];
  readonly execCalls: BoxLiteExecRequest[] = [];
  readonly startExecutionCalls: BoxLiteStartExecutionRequest[] = [];
  readonly deletedSandboxIds: string[] = [];
  private readonly archives = new Map<string, Uint8Array>();
  private readonly execHandler?: FakeBoxLiteClientOptions['execHandler'];
  private readonly uploadBodyLimitBytes: number;

  constructor(options: FakeBoxLiteClientOptions = {}) {
    this.execHandler = options.execHandler;
    this.uploadBodyLimitBytes =
      options.uploadBodyLimitBytes ?? FAKE_BOXLITE_UPLOAD_BODY_LIMIT_BYTES;
  }

  async createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox> {
    validateSandboxSource(request);
    let created: BoxLiteSandbox | undefined;
    try {
      return await runSandboxExternalBoundary({
        taskId: request.taskId,
        action: 'sandbox.create',
        guard: request.externalBoundaryGuard,
        signal: request.cancellationSignal,
        run: async () => {
          this.createCalls.push(request);
          const id = request.sandboxId ?? request.taskId;
          const sandbox: BoxLiteSandbox = {
            id,
            taskId: request.taskId,
            state: 'running',
            image: request.image,
            rootfsPath: request.rootfsPath,
            diskSizeGb: request.diskSizeGb,
            baseUrl: `boxlite://${id}`,
            terminalUrl: `boxlite://${id}/terminal`,
            metadata: request.metadata,
          };
          this.sandboxes.set(id, sandbox);
          created = sandbox;
          await request.onSandboxCreateObserved?.({
            kind: 'created',
            providerSandboxId: sandbox.id,
          });
          return sandbox;
        },
      });
    } catch (error) {
      if (created) throw new BoxLitePartialCreateError(created, error);
      throw error;
    }
  }

  async getSandbox(sandboxId: string): Promise<BoxLiteSandbox | null> {
    return this.sandboxes.get(sandboxId) ?? null;
  }

  async listSandboxes(): Promise<readonly BoxLiteSandbox[]> {
    return [...this.sandboxes.values()];
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.deletedSandboxIds.push(sandboxId);
    this.sandboxes.delete(sandboxId);
  }

  async exec(request: BoxLiteExecRequest): Promise<BoxLiteExecResult> {
    this.execCalls.push(request);
    if (this.execHandler) return this.execHandler(request);
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
      timedOut: false,
    };
  }

  async startExecution(
    request: BoxLiteStartExecutionRequest,
  ): Promise<BoxLiteStartedExecution> {
    this.startExecutionCalls.push(request);
    return {
      id: `exec-${this.startExecutionCalls.length}`,
      sandboxId: request.sandboxId,
    };
  }

  async uploadArchive(request: BoxLiteArchiveUploadRequest): Promise<void> {
    const bytes = await collectBoxLiteArchiveBytes(request.archive);
    if (bytes.byteLength > this.uploadBodyLimitBytes) {
      throw new Error(
        `BoxLite file upload for sandbox ${request.sandboxId} failed: HTTP 413 ` +
          'Failed to buffer the request body: length limit exceeded',
      );
    }
    this.archives.set(archiveKey(request.sandboxId, request.path), bytes);
  }

  /** Uploaded archive paths for one sandbox, in upload order (test helper). */
  archivePaths(sandboxId: string): readonly string[] {
    const prefix = archiveKey(sandboxId, '');
    return [...this.archives.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  async downloadArchive(
    request: BoxLiteArchiveDownloadRequest,
  ): Promise<Uint8Array | null> {
    return this.archives.get(archiveKey(request.sandboxId, request.path)) ?? null;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function normalizePathPrefix(pathPrefix: string): string {
  return pathPrefix
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map(encodePathSegment)
    .join('/');
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function unwrapData(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in raw) {
    return (raw as { readonly data?: unknown }).data;
  }
  return raw;
}

function parseOptionalSandbox(raw: unknown): BoxLiteSandbox | null {
  const value = unwrapData(raw);
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('BoxLite response did not include a sandbox or explicit null');
  }
  return parseSandbox(value);
}

function parseSandboxList(raw: unknown): readonly BoxLiteSandbox[] {
  const value = unwrapData(raw);
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { boxes?: unknown }).boxes)
      ? (value as { boxes: unknown[] }).boxes
      : value &&
          typeof value === 'object' &&
          Array.isArray((value as { sandboxes?: unknown }).sandboxes)
        ? (value as { sandboxes: unknown[] }).sandboxes
        : null;
  if (!list) throw new Error('BoxLite response did not include a sandbox list');
  return list.map(parseSandbox);
}

function parseSandbox(raw: unknown): BoxLiteSandbox {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('BoxLite response did not include a sandbox object');
  }
  const record = value as Record<string, unknown>;
  const id =
    typeof record.id === 'string'
      ? record.id
      : typeof record.box_id === 'string'
        ? record.box_id
        : typeof record.name === 'string'
          ? record.name
          : null;
  if (!id) throw new Error('BoxLite sandbox response missing id');
  return {
    id,
    taskId:
      typeof record.taskId === 'string'
        ? record.taskId
        : typeof record.task_id === 'string'
          ? record.task_id
          : undefined,
    state:
      typeof record.state === 'string'
        ? record.state
        : typeof record.status === 'string'
          ? record.status
          : undefined,
    image: typeof record.image === 'string' ? record.image : undefined,
    rootfsPath:
      typeof record.rootfsPath === 'string'
        ? record.rootfsPath
        : typeof record.rootfs_path === 'string'
          ? record.rootfs_path
          : undefined,
    diskSizeGb:
      typeof record.diskSizeGb === 'number'
        ? record.diskSizeGb
        : typeof record.disk_size_gb === 'number'
          ? record.disk_size_gb
          : undefined,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : undefined,
    terminalUrl: typeof record.terminalUrl === 'string' ? record.terminalUrl : undefined,
    metadata:
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as BoxLiteSandboxMetadata)
        : undefined,
  };
}

function validateSandboxSource(request: BoxLiteCreateSandboxRequest): void {
  if (request.image && request.rootfsPath) {
    throw new Error('BoxLite createSandbox requires either image or rootfsPath, not both');
  }
  if (!request.image && !request.rootfsPath) {
    throw new Error('BoxLite createSandbox requires image or rootfsPath');
  }
}

function stripCreateBoundaryFields(
  request: BoxLiteCreateSandboxRequest,
): Omit<
  BoxLiteCreateSandboxRequest,
  | 'externalBoundaryGuard'
  | 'onSandboxCreateObserved'
  | 'cancellationSignal'
  | 'diagnostics'
  | 'diagnosticScope'
> {
  const {
    externalBoundaryGuard: _externalBoundaryGuard,
    onSandboxCreateObserved: _onSandboxCreateObserved,
    cancellationSignal: _cancellationSignal,
    diagnostics: _diagnostics,
    diagnosticScope: _diagnosticScope,
    ...wireRequest
  } = request;
  void _externalBoundaryGuard;
  void _onSandboxCreateObserved;
  void _cancellationSignal;
  void _diagnostics;
  void _diagnosticScope;
  return wireRequest;
}

function parseStartedExecution(
  raw: unknown,
  sandboxId: string,
): BoxLiteStartedExecution {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('BoxLite exec response did not include an execution object');
  }
  const record = value as Record<string, unknown>;
  const id =
    typeof record.execution_id === 'string'
      ? record.execution_id
      : typeof record.id === 'string'
        ? record.id
        : null;
  if (!id) throw new Error('BoxLite exec response missing execution id');
  return { id, sandboxId };
}

export function parseBoxLiteNativeExecutionPollResult(
  raw: unknown,
): BoxLiteNativeExecutionPollResult {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidNativeExecutionPoll('unknown', null);
  }
  const record = value as Record<string, unknown>;
  const state = readNativeExecutionState(record);
  const parsedExitCode = readNativeExecutionExitCode(record);
  if (!state.valid || !parsedExitCode.valid) {
    return invalidNativeExecutionPoll(
      state.valid ? state.nativeState : 'unknown',
      parsedExitCode.valid ? parsedExitCode.exitCode : null,
    );
  }
  const nativeState = state.nativeState;
  const exitCode = parsedExitCode.exitCode;
  if (nativeState === 'pending' || nativeState === 'running') {
    return exitCode === null
      ? { kind: 'pending', nativeState, exitCode: null }
      : invalidNativeExecutionPoll(nativeState, exitCode);
  }
  if (nativeState === 'unknown') {
    return invalidNativeExecutionPoll(nativeState, exitCode);
  }

  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const output =
    typeof record.output === 'string'
      ? record.output
      : stdout || stderr
        ? `${stdout}${stderr}`
        : '';

  if (nativeState === 'completed') {
    if (exitCode === null) {
      return invalidNativeExecutionPoll(nativeState, null);
    }
    return {
      kind: 'terminal',
      nativeState,
      exitCode,
      stdout,
      stderr,
      output,
      outcome: exitCode === 0 ? 'succeeded' : 'failed',
      cause: exitCode === 0 ? null : 'command_failed',
      retryable: false,
      anomaly: null,
    };
  }

  if (nativeState === 'failed' || nativeState === 'killed') {
    if (exitCode === 0) {
      return invalidNativeExecutionPoll(nativeState, exitCode);
    }
    return {
      kind: 'terminal',
      nativeState,
      exitCode,
      stdout,
      stderr,
      output,
      outcome: 'failed',
      cause: exitCode === null ? 'missing_exit_code' : 'command_failed',
      retryable: false,
      anomaly: exitCode === null ? 'missing_exit_code' : null,
    };
  }

  if (exitCode === 0) {
    return invalidNativeExecutionPoll(nativeState, exitCode);
  }
  return {
    kind: 'terminal',
    nativeState,
    exitCode,
    stdout,
    stderr,
    output,
    outcome: 'timed_out',
    cause: 'settlement_unknown',
    retryable: true,
    anomaly: null,
  };
}

function adaptBoxLiteNativeExecutionResult(
  parsed: Exclude<BoxLiteNativeExecutionPollResult, { readonly kind: 'pending' }>,
): BoxLiteExecResult {
  if (parsed.kind === 'invalid') {
    throw new SandboxCommandSettlementError('protocol');
  }
  if (
    (parsed.nativeState === 'failed' || parsed.nativeState === 'killed') &&
    parsed.exitCode === null
  ) {
    throw new SandboxCommandSettlementError('failed_without_exit');
  }
  const exitCode =
    parsed.exitCode ?? (parsed.nativeState === 'timed_out' ? 124 : null);
  if (exitCode === null) {
    throw new SandboxCommandSettlementError('protocol');
  }
  return {
    exitCode,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    output: parsed.output,
    timedOut: parsed.nativeState === 'timed_out',
    nativeState: parsed.nativeState,
    nativeExitCode: parsed.exitCode,
  };
}

function invalidNativeExecutionPoll(
  nativeState: BoxLiteNativeExecutionState,
  exitCode: number | null,
): Extract<BoxLiteNativeExecutionPollResult, { readonly kind: 'invalid' }> {
  return {
    kind: 'invalid',
    nativeState,
    exitCode,
    outcome: 'failed',
    cause: 'protocol_failed',
    retryable: false,
    anomaly: 'invalid_poll_settlement',
  };
}

function readNativeExecutionState(record: Record<string, unknown>):
  | { readonly valid: true; readonly nativeState: BoxLiteNativeExecutionState }
  | { readonly valid: false } {
  const rawStates = [
    ...(hasOwn(record, 'status') ? [record.status] : []),
    ...(hasOwn(record, 'state') ? [record.state] : []),
  ];
  const hasTimedOut = hasOwn(record, 'timed_out');
  if (hasTimedOut && typeof record.timed_out !== 'boolean') {
    return { valid: false };
  }
  if (rawStates.length === 0) {
    return record.timed_out === true
      ? { valid: true, nativeState: 'timed_out' }
      : { valid: false };
  }
  const normalized = rawStates.map(normalizeNativeExecutionState);
  if (normalized.some((state) => state === null)) {
    return { valid: false };
  }
  const first = normalized[0] as BoxLiteNativeExecutionState;
  if (normalized.some((state) => state !== first)) {
    return { valid: false };
  }
  if (record.timed_out === true && first !== 'timed_out') {
    return { valid: false };
  }
  return { valid: true, nativeState: first };
}

function normalizeNativeExecutionState(
  raw: unknown,
): BoxLiteNativeExecutionState | null {
  if (typeof raw !== 'string') return null;
  switch (raw.trim().toLowerCase()) {
    case 'pending':
    case 'queued':
    case 'created':
    case 'starting':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
    case 'complete':
    case 'exited':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
      return 'killed';
    case 'timeout':
    case 'timed_out':
      return 'timed_out';
    default:
      return null;
  }
}

function readNativeExecutionExitCode(record: Record<string, unknown>):
  | { readonly valid: true; readonly exitCode: number | null }
  | { readonly valid: false } {
  const values = ['exit_code', 'exitCode', 'code']
    .filter((key) => hasOwn(record, key))
    .map((key) => record[key]);
  if (values.length === 0) {
    return { valid: true, exitCode: null };
  }
  if (values.some((value) => !Number.isSafeInteger(value))) {
    return { valid: false };
  }
  const exitCode = values[0] as number;
  if (values.some((value) => value !== exitCode)) {
    return { valid: false };
  }
  return { valid: true, exitCode };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function mergeExecOutput(
  polled: BoxLiteExecResult,
  attached: BoxLiteNativeExecutionAttachResult,
): BoxLiteExecResult {
  if (attached.kind !== 'success') {
    const settlement =
      attached.kind === 'degraded'
        ? attached.settlement
        : attached.kind === 'timed_out'
          ? 'timeout'
          : attached.kind === 'cancelled'
            ? 'cancellation'
            : 'protocol';
    throw new SandboxCommandOutputSettlementError(settlement);
  }
  if (
    polled.nativeExitCode !== undefined &&
    polled.nativeExitCode !== null &&
    polled.nativeExitCode !== attached.exitCode
  ) {
    throw new SandboxCommandOutputSettlementError('protocol');
  }
  return {
    ...polled,
    ...attached.output,
  };
}

function rawToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function parseControlFrame(
  text: string,
): { readonly type: 'exit'; readonly exitCode: number } | null {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const frame = parsed as Record<string, unknown>;
    return frame.type === 'exit' && Number.isSafeInteger(frame.exit_code)
      ? { type: 'exit', exitCode: frame.exit_code as number }
      : null;
  } catch {
    return null;
  }
}

function parseExecResult(raw: unknown): BoxLiteExecResult {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('BoxLite exec response did not include a result object');
  }
  const record = value as Record<string, unknown>;
  const exitCode =
    typeof record.exitCode === 'number'
      ? record.exitCode
      : typeof record.exit_code === 'number'
        ? record.exit_code
        : Number.NaN;
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const output =
    typeof record.output === 'string'
      ? record.output
      : stdout || stderr
        ? `${stdout}${stderr}`
        : '';
  return {
    exitCode,
    stdout,
    stderr,
    output,
    timedOut: record.timedOut === true || record.timed_out === true,
  };
}

function archiveKey(sandboxId: string, path: string): string {
  return `${sandboxId}\0${path}`;
}

function combineRequestSignal(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): unknown {
  const abortSignal = (
    globalThis as {
      readonly AbortSignal?: {
        timeout(timeoutMs: number): AbortSignal;
        any?(signals: readonly AbortSignal[]): AbortSignal;
      };
    }
  ).AbortSignal;
  const timeout = abortSignal?.timeout(timeoutMs);
  if (signal === undefined) return timeout;
  if (timeout === undefined) return signal;
  return abortSignal?.any?.([signal, timeout]) ?? signal;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function createNativeExecutionBudget(
  timeoutMs: number,
  cancellationSignal: AbortSignal | undefined,
  deadlineDriver: BoxLiteNativeExecutionDeadlineDriver,
): BoxLiteNativeExecutionBudget {
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.max(1, Math.floor(timeoutMs))
      : 1;
  const deadlineAt = deadlineDriver.now() + normalizedTimeoutMs;
  const controller = new AbortController();
  let terminalReason: BoxLiteNativeExecutionBudgetReason | null = null;
  let disposed = false;
  let cancelDeadline: (() => void) | null = null;

  const settle = (reason: BoxLiteNativeExecutionBudgetReason): void => {
    if (disposed || terminalReason !== null) return;
    terminalReason = reason;
    controller.abort(
      new DOMException(
        reason === 'cancellation'
          ? 'BoxLite native execution cancelled'
          : 'BoxLite native execution deadline elapsed',
        reason === 'cancellation' ? 'AbortError' : 'TimeoutError',
      ),
    );
  };
  const onCancellation = (): void => settle('cancellation');
  const refreshDeadline = (): void => {
    if (terminalReason === null && deadlineDriver.now() >= deadlineAt) {
      settle('deadline');
    }
  };

  if (cancellationSignal?.aborted === true) {
    settle('cancellation');
  } else {
    cancellationSignal?.addEventListener('abort', onCancellation, {
      once: true,
    });
    cancelDeadline = deadlineDriver.schedule(normalizedTimeoutMs, () =>
      settle('deadline'),
    );
  }

  return Object.freeze({
    timeoutMs: normalizedTimeoutMs,
    signal: controller.signal,
    remainingMs() {
      refreshDeadline();
      return terminalReason === null
        ? Math.max(0, deadlineAt - deadlineDriver.now())
        : 0;
    },
    reason() {
      refreshDeadline();
      return terminalReason;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelDeadline?.();
      cancelDeadline = null;
      cancellationSignal?.removeEventListener('abort', onCancellation);
    },
  });
}

const systemNativeExecutionDeadlineDriver: BoxLiteNativeExecutionDeadlineDriver =
  Object.freeze({
    now: () => performance.now(),
    schedule(delayMs: number, trigger: () => void) {
      const timer = setTimeout(trigger, delayMs);
      return () => clearTimeout(timer);
    },
  });

function throwIfNativeExecutionBudgetEnded(
  budget: BoxLiteNativeExecutionBudget,
): void {
  const error = nativeExecutionBudgetError(budget);
  if (error !== null) throw error;
}

function mapNativeExecutionBudgetRejection(
  error: unknown,
  budget: BoxLiteNativeExecutionBudget,
): unknown {
  return nativeExecutionBudgetError(budget) ?? error;
}

function nativeExecutionBudgetError(
  budget: BoxLiteNativeExecutionBudget | undefined,
): SandboxCommandSettlementError | null {
  const reason = budget?.reason() ?? null;
  return reason === 'cancellation'
    ? new SandboxCommandSettlementError('cancellation')
    : reason === 'deadline'
      ? new SandboxCommandSettlementError('timeout')
      : null;
}

function settleNativeExecutionStartBudgetDiagnostic(
  diagnostic: BoxLiteProvisioningDiagnosticLifecycle,
  error: SandboxCommandSettlementError,
  budget: BoxLiteNativeExecutionBudget,
): void {
  if (error.settlement === 'cancellation') {
    diagnostic.settle({
      outcome: 'cancelled',
      cause: 'cancelled',
      retryable: false,
    });
    return;
  }
  diagnostic.settle({
    outcome: 'timed_out',
    cause: 'settlement_unknown',
    retryable: true,
    timeoutMs: budget.timeoutMs,
  });
}

function waitForNativePollInterval(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, delayMs);
  });
}
