import {
  createSandboxSecretFilePort,
  createSandboxMode0600FileArchive,
  SandboxProviderConfigurationError,
  type SandboxCommandExecutionResult,
  type SandboxCommandExecutor,
  type SandboxGitStageExecutor,
  type SandboxGitStageExecution,
  type SandboxOwnershipFence,
  type SandboxProviderPrivateSecretFileDeleteRequest,
  type SandboxProviderPrivateSecretFileTransport,
  type SandboxProviderPrivateSecretFileWriteRequest,
  type SandboxRunCleanupAuthorization,
  type SandboxSecretFilePort,
} from '@cap/sandbox-core';
import type { AioSandboxContainerController } from './aio-provider-controller.js';

const AIO_SECRET_OPERATION_TIMEOUT_MS = 10_000;

export interface AioWorkspaceSecurityOptions {
  readonly taskId: string;
  readonly controller: AioSandboxContainerController;
  readonly executor: SandboxCommandExecutor;
  readonly providerId?: string;
  readonly ownership?: SandboxOwnershipFence;
  readonly beforeSandboxCleanup?: () => Promise<SandboxRunCleanupAuthorization | null>;
  readonly afterSandboxCleanup?: (
    authorization: SandboxRunCleanupAuthorization,
  ) => Promise<void>;
  /** Provider-private notification after physical absence is authoritative. */
  readonly onSandboxFenced?: () => void;
  /** Adapter-level single-flight shared by stage and secret cleanup paths. */
  readonly fenceSandbox?: () => Promise<void>;
  readonly secretDirectory?: string;
  readonly createSecretId?: () => string;
}

export interface AioWorkspaceSecurityAdapter {
  readonly secretFilePort: SandboxSecretFilePort;
  readonly stageExecutor: SandboxGitStageExecutor;
  /** True only after the selected sandbox was confirmed absent. */
  wasSandboxFenced(): boolean;
}

/**
 * Provider-owned secure adapter: Docker archive input carries secret bytes,
 * while ordinary AIO exec sees only the generated path.
 */
export function createAioWorkspaceSecurityAdapter(
  options: AioWorkspaceSecurityOptions,
): AioWorkspaceSecurityAdapter {
  let sandboxFenced = false;
  let fencePromise: Promise<void> | null = null;
  const fenceOptions: AioWorkspaceSecurityOptions = {
    ...options,
    onSandboxFenced: () => {
      sandboxFenced = true;
      options.onSandboxFenced?.();
    },
  };
  const adapterOptions: AioWorkspaceSecurityOptions = {
    ...fenceOptions,
    fenceSandbox: () => {
      fencePromise ??= forceRemoveSandboxAndConfirm(fenceOptions);
      return fencePromise;
    },
  };
  const transport = createAioSecretFileTransport(adapterOptions);
  return Object.freeze({
    secretFilePort: createSandboxSecretFilePort({
      directory: options.secretDirectory ?? '/tmp',
      transport,
      createId: options.createSecretId,
    }),
    stageExecutor: createAioSandboxGitStageExecutor(adapterOptions),
    wasSandboxFenced(): boolean {
      return sandboxFenced;
    },
  });
}

export function createAioSandboxGitStageExecutor(
  options: Pick<
    AioWorkspaceSecurityOptions,
    | 'taskId'
    | 'controller'
    | 'executor'
    | 'providerId'
    | 'ownership'
    | 'beforeSandboxCleanup'
    | 'afterSandboxCleanup'
    | 'onSandboxFenced'
    | 'fenceSandbox'
  >,
): SandboxGitStageExecutor {
  return Object.freeze({
    async execute(
      execution: SandboxGitStageExecution,
    ): Promise<SandboxCommandExecutionResult> {
      if (execution.signal.aborted) {
        await fenceSandboxAndConfirm(options);
        return timedOutResult();
      }
      try {
        const result = await options.executor.exec({
          ...execution.request,
          signal: execution.signal,
          timeoutMs: execution.remainingTimeoutMs,
        });
        if (result.timedOut) {
          await fenceSandboxAndConfirm(options);
        }
        return result;
      } catch (error) {
        // A dropped/aborted HTTP response cannot prove the guest git process
        // stopped. Force-remove and verify absence before the stage settles.
        await fenceSandboxAndConfirm(options);
        if (execution.signal.aborted || isAbortLike(error)) {
          return timedOutResult();
        }
        throw new SandboxProviderConfigurationError(
          'AIO workspace command settlement could not be observed safely',
        );
      }
    },
  });
}

function createAioSecretFileTransport(
  options: AioWorkspaceSecurityOptions,
): SandboxProviderPrivateSecretFileTransport {
  return Object.freeze({
    async writeFile(
      request: SandboxProviderPrivateSecretFileWriteRequest,
    ): Promise<void> {
      const target = splitAbsoluteFilePath(request.path);
      const archive = createAioMode0600FileArchive(
        target.name,
        request.content,
      );
      try {
        await options.controller.putPrivateArchive(
          options.taskId,
          target.directory,
          archive,
        );
      } finally {
        archive.fill(0);
      }
      let verified: SandboxCommandExecutionResult;
      try {
        verified = await options.executor.exec({
          command:
            `test -f ${shellQuote(request.path)} && ` +
            `test "$(stat -c %a ${shellQuote(request.path)})" = 600`,
          timeoutMs: AIO_SECRET_OPERATION_TIMEOUT_MS,
        });
      } catch {
        await fenceSandboxAndConfirm(options);
        throw new SandboxProviderConfigurationError(
          'AIO secret file mode could not be verified',
        );
      }
      if (verified.exitCode !== 0 || verified.timedOut) {
        await fenceSandboxAndConfirm(options);
        throw new SandboxProviderConfigurationError(
          'AIO secret file mode could not be verified',
        );
      }
    },

    async deleteFile(
      request: SandboxProviderPrivateSecretFileDeleteRequest,
    ): Promise<void> {
      try {
        if (await options.controller.isSandboxConfirmedAbsent(options.taskId)) {
          return;
        }
      } catch {
        // A non-404 inspect failure is uncertainty, not proof of absence. Keep
        // going until rm/test succeeds or force-removal is confirmed by 404.
      }
      try {
        const deleted = await options.executor.exec({
          command:
            `rm -f -- ${shellQuote(request.path)} && ` +
            `test ! -e ${shellQuote(request.path)}`,
          timeoutMs: AIO_SECRET_OPERATION_TIMEOUT_MS,
        });
        if (deleted.exitCode === 0 && !deleted.timedOut) return;
      } catch {
        // Loss of the exec response is also not proof that the file is absent.
      }
      await fenceSandboxAndConfirm(options);
      throw new SandboxProviderConfigurationError(
        'AIO secret file removal required sandbox fencing',
      );
    },
  });
}

function fenceSandboxAndConfirm(
  options: AioWorkspaceSecurityOptions,
): Promise<void> {
  return options.fenceSandbox?.() ?? forceRemoveSandboxAndConfirm(options);
}

async function forceRemoveSandboxAndConfirm(
  options: Pick<
    AioWorkspaceSecurityOptions,
    | 'taskId'
    | 'controller'
    | 'providerId'
    | 'ownership'
    | 'beforeSandboxCleanup'
    | 'afterSandboxCleanup'
    | 'onSandboxFenced'
  >,
): Promise<void> {
  const authorization = options.beforeSandboxCleanup
    ? await options.beforeSandboxCleanup()
    : null;
  if (options.beforeSandboxCleanup && !authorization) {
    throw new SandboxProviderConfigurationError(
      'AIO credential safety cleanup was not authorized',
    );
  }
  if (options.ownership && !authorization) {
    throw new SandboxProviderConfigurationError(
      'AIO credential safety cleanup requires current durable authorization',
    );
  }
  if (
    authorization &&
    (authorization.taskId !== options.taskId ||
      (options.providerId !== undefined &&
        authorization.providerId !== options.providerId))
  ) {
    throw new SandboxProviderConfigurationError(
      'AIO credential safety cleanup authorization does not match the selected run',
    );
  }
  if (
    authorization &&
    options.ownership &&
    (authorization.kind !== 'generation' ||
      authorization.ownership.resourceGeneration !==
        options.ownership.resourceGeneration)
  ) {
    throw new SandboxProviderConfigurationError(
      'AIO credential safety cleanup authorization changed physical generation',
    );
  }
  const ownership =
    authorization?.kind === 'generation'
      ? authorization.ownership
      : authorization?.kind === 'legacy'
        ? undefined
        : options.ownership;
  try {
    await options.controller.removeSandboxAndConfirm(
      options.taskId,
      ownership,
    );
  } catch {
    throw new SandboxProviderConfigurationError(
      'AIO credential safety fencing could not be confirmed',
    );
  }
  if (authorization) {
    // Absence is physical proof, but only the owner-store CAS knows whether an
    // entered create can still return. Idle owners complete; entered owners
    // reject here and retain their deleting tombstone for recovery.
    await options.afterSandboxCleanup?.(authorization);
  }
  options.onSandboxFenced?.();
}

/** Minimal ustar archive containing exactly one mode-0600 regular file. */
export function createAioMode0600FileArchive(
  name: string,
  content: Uint8Array,
): Uint8Array {
  return createSandboxMode0600FileArchive(name, content);
}

function splitAbsoluteFilePath(path: string): {
  readonly directory: string;
  readonly name: string;
} {
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new SandboxProviderConfigurationError(
      'AIO secret file path must be absolute',
    );
  }
  const index = path.lastIndexOf('/');
  if (index <= 0 || index === path.length - 1) {
    throw new SandboxProviderConfigurationError(
      'AIO secret file path must name a file',
    );
  }
  return { directory: path.slice(0, index), name: path.slice(index + 1) };
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

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
