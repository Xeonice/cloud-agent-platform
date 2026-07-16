import { posix as guestPosixPath } from 'node:path';

import {
  createSandboxMode0600FileArchive,
  createSandboxSecretFilePort,
  SandboxProviderConfigurationError,
  type SandboxCommandExecutionResult,
  type SandboxGitStageExecution,
  type SandboxGitStageExecutor,
  type SandboxOwnershipFence,
  type SandboxProviderPrivateSecretFileDeleteRequest,
  type SandboxProviderPrivateSecretFileTransport,
  type SandboxProviderPrivateSecretFileWriteRequest,
  type SandboxRunCleanupAuthorization,
  type SandboxSecretFilePort,
} from '@cap/sandbox-core';

import type { BoxLiteClient, BoxLiteExecResult } from './boxlite-client.js';

const BOXLITE_SECRET_OPERATION_TIMEOUT_MS = 10_000;
const BOXLITE_SANDBOX_DELETE_CONFIRM_ATTEMPTS = 10;
const BOXLITE_SANDBOX_DELETE_CONFIRM_DELAY_MS = 100;
const BOXLITE_GIT_SECRET_DIRECTORY_NAME = '.cap-git-credentials';

/**
 * Keep provider-owned credentials on the root filesystem, beside the
 * workspace rather than inside it. Workspace materialization starts with an
 * idempotent `rm -rf` of the workspace itself, while BoxLite mounts `/tmp` as
 * tmpfs and cannot copy uploaded archives into that mount.
 */
export function resolveBoxLiteGitSecretDirectory(workspacePath: string): string {
  if (
    typeof workspacePath !== 'string' ||
    !guestPosixPath.isAbsolute(workspacePath) ||
    workspacePath.includes('\0')
  ) {
    throw new SandboxProviderConfigurationError(
      'BoxLite workspace path must be an absolute guest POSIX path',
    );
  }
  const normalizedWorkspace = guestPosixPath.normalize(workspacePath);
  if (normalizedWorkspace === '/') {
    throw new SandboxProviderConfigurationError(
      'BoxLite workspace path must not be the guest root directory',
    );
  }
  return guestPosixPath.join(
    guestPosixPath.dirname(normalizedWorkspace),
    BOXLITE_GIT_SECRET_DIRECTORY_NAME,
  );
}

export interface BoxLiteSandboxDeletionConfirmationOptions {
  readonly client: Pick<BoxLiteClient, 'deleteSandbox' | 'getSandbox'>;
  readonly sandboxId: string;
  readonly attempts?: number;
  /** Injectable for deterministic tests; called only between failed probes. */
  readonly waitForRetry?: (attempt: number) => Promise<void>;
}

export interface BoxLiteWorkspaceSecurityOptions {
  readonly client: BoxLiteClient;
  readonly sandboxId: string;
  readonly taskId?: string;
  readonly providerId?: string;
  readonly ownership?: SandboxOwnershipFence;
  readonly secretDirectory?: string;
  readonly createSecretId?: () => string;
  /** Durable cleanup must win the exact owner CAS before deleting the sandbox. */
  readonly beforeSandboxCleanup?: () => Promise<SandboxRunCleanupAuthorization | null>;
  /** Completes the exact owner cleanup only after absence is confirmed. */
  readonly afterSandboxCleanup?: (
    authorization: SandboxRunCleanupAuthorization,
  ) => Promise<void>;
  readonly deletionConfirmation?: Omit<
    BoxLiteSandboxDeletionConfirmationOptions,
    'client' | 'sandboxId'
  >;
}

export interface BoxLiteWorkspaceSecurityAdapter {
  readonly secretFilePort: SandboxSecretFilePort;
  readonly stageExecutor: SandboxGitStageExecutor;
  /** Settles every provider-owned secret path before a run may be retained. */
  settleCredentialSafety(): Promise<void>;
  /** True only after sandbox deletion has been confirmed by an absence probe. */
  wasSandboxFenced(): boolean;
}

/**
 * Provider-private BoxLite bridge for the shared staged Git engine. Archive
 * upload is the only token-bearing channel; exec requests contain paths only.
 */
export function createBoxLiteWorkspaceSecurityAdapter(
  options: BoxLiteWorkspaceSecurityOptions,
): BoxLiteWorkspaceSecurityAdapter {
  if (
    (options.beforeSandboxCleanup === undefined) !==
    (options.afterSandboxCleanup === undefined)
  ) {
    throw new SandboxProviderConfigurationError(
      'BoxLite cleanup callbacks must be provided together',
    );
  }
  if (
    options.ownership &&
    (!options.beforeSandboxCleanup || !options.afterSandboxCleanup)
  ) {
    throw new SandboxProviderConfigurationError(
      'BoxLite durable workspace cleanup requires owner generation callbacks',
    );
  }
  const activeSecretPaths = new Set<string>();
  let sandboxFenced = false;
  let fencePromise: Promise<void> | null = null;

  const fenceSandbox = (): Promise<void> => {
    fencePromise ??= (async () => {
      const cleanupAuthorization = options.beforeSandboxCleanup
        ? await options.beforeSandboxCleanup()
        : undefined;
      if (options.beforeSandboxCleanup && !cleanupAuthorization) {
        // Ownership moved to another worker. It owns subsequent resource and
        // credential cleanup; the stale worker must perform no more I/O.
        activeSecretPaths.clear();
        return;
      }
      if (
        cleanupAuthorization &&
        ((options.taskId !== undefined &&
          cleanupAuthorization.taskId !== options.taskId) ||
          (options.providerId !== undefined &&
            cleanupAuthorization.providerId !== options.providerId) ||
          (options.ownership !== undefined &&
            (cleanupAuthorization.kind !== 'generation' ||
              cleanupAuthorization.ownership.resourceGeneration !==
                options.ownership.resourceGeneration)))
      ) {
        throw new SandboxProviderConfigurationError(
          'BoxLite cleanup authorization does not match the selected run',
        );
      }
      await deleteBoxLiteSandboxAndConfirm({
        client: options.client,
        sandboxId: options.sandboxId,
        ...options.deletionConfirmation,
      });
      sandboxFenced = true;
      activeSecretPaths.clear();
      if (cleanupAuthorization) {
        await options.afterSandboxCleanup?.(cleanupAuthorization);
      }
    })();
    return fencePromise;
  };

  const transport = createBoxLiteSecretFileTransport({
    client: options.client,
    sandboxId: options.sandboxId,
    activeSecretPaths,
    wasSandboxFenced: () => sandboxFenced,
    fenceSandbox,
  });

  return Object.freeze({
    secretFilePort: createSandboxSecretFilePort({
      directory: options.secretDirectory ?? '/tmp',
      transport,
      createId: options.createSecretId,
    }),
    stageExecutor: createBoxLiteSandboxGitStageExecutor({
      client: options.client,
      sandboxId: options.sandboxId,
      fenceSandbox,
    }),
    async settleCredentialSafety(): Promise<void> {
      for (const path of [...activeSecretPaths]) {
        await transport.deleteFile({ path });
      }
    },
    wasSandboxFenced(): boolean {
      return sandboxFenced;
    },
  });
}

export function createBoxLiteSandboxGitStageExecutor(options: {
  readonly client: Pick<BoxLiteClient, 'exec'>;
  readonly sandboxId: string;
  readonly fenceSandbox: () => Promise<void>;
}): SandboxGitStageExecutor {
  return Object.freeze({
    async execute(
      execution: SandboxGitStageExecution,
    ): Promise<SandboxCommandExecutionResult> {
      if (execution.signal.aborted) {
        await options.fenceSandbox();
        return timedOutResult();
      }

      const onAbort = deferredAbort(execution.signal);
      if (execution.signal.aborted) {
        onAbort.dispose();
        await options.fenceSandbox();
        return timedOutResult();
      }
      const observedExec = options.client
        .exec({
          sandboxId: options.sandboxId,
          command: execution.request.command,
          cwd: execution.request.cwd,
          timeoutMs: execution.remainingTimeoutMs,
        })
        .then<ObservedExecOutcome, ObservedExecOutcome>(
          (result) => ({ kind: 'result', result }),
          (error: unknown) => ({ kind: 'error', error }),
        );
      const outcome = await Promise.race([observedExec, onAbort.promise]);
      onAbort.dispose();

      if (outcome.kind === 'abort') {
        // observedExec already owns both fulfillment and rejection handlers, so
        // a late/dropped transport response cannot become an unhandled promise.
        await options.fenceSandbox();
        return timedOutResult();
      }
      if (outcome.kind === 'error') {
        await options.fenceSandbox();
        if (execution.signal.aborted || isAbortLike(outcome.error)) {
          return timedOutResult();
        }
        throw new SandboxProviderConfigurationError(
          'BoxLite workspace command settlement could not be observed safely',
        );
      }

      const result = normalizeExecResult(outcome.result);
      if (result.timedOut || execution.signal.aborted) {
        await options.fenceSandbox();
        return execution.signal.aborted ? timedOutResult() : result;
      }
      return result;
    },
  });
}

/** Delete once, then resolve only after BoxLite reports the sandbox absent. */
export async function deleteBoxLiteSandboxAndConfirm(
  options: BoxLiteSandboxDeletionConfirmationOptions,
): Promise<void> {
  const attempts =
    options.attempts ?? BOXLITE_SANDBOX_DELETE_CONFIRM_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new SandboxProviderConfigurationError(
      'BoxLite sandbox deletion confirmation attempts must be positive',
    );
  }

  try {
    await options.client.deleteSandbox(options.sandboxId);
  } catch {
    // A lost delete response is ambiguous. Only a subsequent absence probe can
    // settle the fence successfully.
  }

  const waitForRetry =
    options.waitForRetry ??
    (() => wait(BOXLITE_SANDBOX_DELETE_CONFIRM_DELAY_MS));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if ((await options.client.getSandbox(options.sandboxId)) === null) {
        return;
      }
    } catch {
      // A probe error is uncertainty, never proof of absence.
    }
    if (attempt < attempts) await waitForRetry(attempt);
  }
  throw new SandboxProviderConfigurationError(
    'BoxLite credential safety fencing could not be confirmed',
  );
}

function createBoxLiteSecretFileTransport(options: {
  readonly client: BoxLiteClient;
  readonly sandboxId: string;
  readonly activeSecretPaths: Set<string>;
  readonly wasSandboxFenced: () => boolean;
  readonly fenceSandbox: () => Promise<void>;
}): SandboxProviderPrivateSecretFileTransport {
  return Object.freeze({
    async writeFile(
      request: SandboxProviderPrivateSecretFileWriteRequest,
    ): Promise<void> {
      if (request.mode !== 0o600) {
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file mode must be 0600',
        );
      }
      if (!options.client.uploadArchive) {
        throw new SandboxProviderConfigurationError(
          'BoxLite private secret-file transport requires archive upload support',
        );
      }

      const target = splitAbsoluteFilePath(request.path);
      const upload = secretUploadPaths(target);
      options.activeSecretPaths.add(request.path);
      const prepared = await observeAbortableOperation(request.signal, () =>
        options.client.exec({
          sandboxId: options.sandboxId,
          command:
            `umask 077 && mkdir -p -- ${shellQuote(target.directory)} ` +
            `${shellQuote(upload.stagingDirectory)} && ` +
            `chmod 700 -- ${shellQuote(target.directory)} ` +
            `${shellQuote(upload.stagingDirectory)}`,
          timeoutMs: BOXLITE_SECRET_OPERATION_TIMEOUT_MS,
        }),
      );
      if (
        prepared.kind !== 'result' ||
        prepared.result.exitCode !== 0 ||
        prepared.result.timedOut === true
      ) {
        await options.fenceSandbox();
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file staging could not be prepared safely',
        );
      }
      const archive = createSandboxMode0600FileArchive(
        target.name,
        request.content,
      );
      let uploaded: ObservedOperationOutcome<void>;
      try {
        uploaded = await observeAbortableOperation(
          request.signal,
          () =>
            options.client.uploadArchive!({
              sandboxId: options.sandboxId,
              path: upload.stagingDirectory,
              archive,
            }),
        );
      } finally {
        archive.fill(0);
      }
      if (uploaded.kind === 'abort') {
        await options.fenceSandbox();
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file upload was cancelled',
        );
      }
      if (uploaded.kind === 'error') {
        await options.fenceSandbox();
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file upload could not be observed safely',
        );
      }

      const verified = await observeAbortableOperation(request.signal, () =>
        options.client.exec({
          sandboxId: options.sandboxId,
          command:
            'uid=$(id -u) && gid=$(id -g) && ' +
            `if test -f ${shellQuote(upload.directCandidate)} && ` +
            `test ! -e ${shellQuote(upload.nestedCandidate)}; then ` +
            `source=${shellQuote(upload.directCandidate)}; ` +
            `elif test ! -e ${shellQuote(upload.directCandidate)} && ` +
            `test -f ${shellQuote(upload.nestedCandidate)}; then ` +
            `source=${shellQuote(upload.nestedCandidate)}; ` +
            'else exit 1; fi && ' +
            'chown "$uid:$gid" "$source" && ' +
            'chmod 600 "$source" && ' +
            `test ! -e ${shellQuote(request.path)} && ` +
            `mv -- "$source" ${shellQuote(request.path)} && ` +
            `rm -rf -- ${shellQuote(upload.stagingDirectory)} && ` +
            `test -f ${shellQuote(request.path)} && ` +
            `test -r ${shellQuote(request.path)} && ` +
            `test "$(stat -c %a ${shellQuote(request.path)})" = 600 && ` +
            `test "$(stat -c %u ${shellQuote(request.path)})" = "$uid" && ` +
            `test "$(stat -c %g ${shellQuote(request.path)})" = "$gid"`,
          timeoutMs: BOXLITE_SECRET_OPERATION_TIMEOUT_MS,
        }),
      );
      if (verified.kind !== 'result') {
        await options.fenceSandbox();
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file mode could not be verified',
        );
      }
      if (
        verified.result.exitCode !== 0 ||
        verified.result.timedOut === true
      ) {
        await options.fenceSandbox();
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file mode could not be verified',
        );
      }
    },

    async deleteFile(
      request: SandboxProviderPrivateSecretFileDeleteRequest,
    ): Promise<void> {
      if (!options.activeSecretPaths.has(request.path)) return;
      if (options.wasSandboxFenced()) {
        options.activeSecretPaths.delete(request.path);
        return;
      }

      try {
        if ((await options.client.getSandbox(options.sandboxId)) === null) {
          options.activeSecretPaths.delete(request.path);
          return;
        }
      } catch {
        // Continue to the rm/test proof. A failed lookup is not absence.
      }

      try {
        const target = splitAbsoluteFilePath(request.path);
        const upload = secretUploadPaths(target);
        const deleted = await options.client.exec({
          sandboxId: options.sandboxId,
          command:
            `rm -f -- ${shellQuote(request.path)} && ` +
            `rm -rf -- ${shellQuote(upload.stagingDirectory)} && ` +
            `(rmdir -- ${shellQuote(target.directory)} 2>/dev/null || :) && ` +
            `test ! -e ${shellQuote(request.path)} && ` +
            `test ! -e ${shellQuote(upload.stagingDirectory)}`,
          timeoutMs: BOXLITE_SECRET_OPERATION_TIMEOUT_MS,
        });
        if (deleted.exitCode === 0 && deleted.timedOut !== true) {
          options.activeSecretPaths.delete(request.path);
          return;
        }
      } catch {
        // A missing exec response cannot prove the file is absent.
      }

      await options.fenceSandbox();
      options.activeSecretPaths.delete(request.path);
      throw new SandboxProviderConfigurationError(
        'BoxLite secret file removal required sandbox fencing',
      );
    },
  });
}

type ObservedExecOutcome =
  | { readonly kind: 'result'; readonly result: BoxLiteExecResult }
  | { readonly kind: 'error'; readonly error: unknown };

type ObservedOperationOutcome<T> =
  | { readonly kind: 'result'; readonly result: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'abort' };

async function observeAbortableOperation<T>(
  signal: AbortSignal | undefined,
  start: () => Promise<T>,
): Promise<ObservedOperationOutcome<T>> {
  if (signal === undefined) {
    try {
      return { kind: 'result', result: await start() };
    } catch (error) {
      return { kind: 'error', error };
    }
  }

  const abort = deferredAbort(signal);
  if (signal.aborted) {
    abort.dispose();
    return { kind: 'abort' };
  }
  let operation: Promise<T>;
  try {
    operation = start();
  } catch (error) {
    abort.dispose();
    return { kind: 'error', error };
  }
  const observed = operation.then<
    ObservedOperationOutcome<T>,
    ObservedOperationOutcome<T>
  >(
    (result) => ({ kind: 'result', result }),
    (error: unknown) => ({ kind: 'error', error }),
  );
  const outcome = await Promise.race([observed, abort.promise]);
  abort.dispose();
  return outcome;
}

function deferredAbort(signal: AbortSignal): {
  readonly promise: Promise<{ readonly kind: 'abort' }>;
  dispose(): void;
} {
  let onAbort: () => void = () => undefined;
  const promise = new Promise<{ readonly kind: 'abort' }>((resolve) => {
    onAbort = () => resolve({ kind: 'abort' });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', onAbort),
  };
}

function normalizeExecResult(
  result: BoxLiteExecResult,
): SandboxCommandExecutionResult {
  return {
    exitCode: result.exitCode,
    output: result.output,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut === true,
  };
}

function timedOutResult(): SandboxCommandExecutionResult {
  return {
    exitCode: 124,
    output: '',
    stdout: '',
    stderr: '',
    timedOut: true,
  };
}

function splitAbsoluteFilePath(path: string): {
  readonly directory: string;
  readonly name: string;
} {
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new SandboxProviderConfigurationError(
      'BoxLite secret file path must be absolute',
    );
  }
  const index = path.lastIndexOf('/');
  if (index <= 0 || index === path.length - 1) {
    throw new SandboxProviderConfigurationError(
      'BoxLite secret file path must name a file',
    );
  }
  return { directory: path.slice(0, index), name: path.slice(index + 1) };
}

function secretUploadPaths(target: {
  readonly directory: string;
  readonly name: string;
}): {
  readonly stagingDirectory: string;
  readonly directCandidate: string;
  readonly nestedCandidate: string;
} {
  const stagingDirectory = `${target.directory}/.${target.name}.upload`;
  return {
    stagingDirectory,
    directCandidate: `${stagingDirectory}/${target.name}`,
    nestedCandidate: `${stagingDirectory}/extracted/${target.name}`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /abort|cancel/iu.test(error.message))
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
