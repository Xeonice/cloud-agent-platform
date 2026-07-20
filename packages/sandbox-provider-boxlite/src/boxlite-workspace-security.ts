import { posix as guestPosixPath } from 'node:path';

import {
  createSandboxMode0600FileArchive,
  createSandboxSecretFilePort,
  normalizeSandboxPhysicalCleanupResult,
  SandboxCleanupCoordinationPendingError,
  SandboxProviderConfigurationError,
  type SandboxCommandExecutionResult,
  type SandboxGitStageExecution,
  type SandboxGitStageExecutor,
  type SandboxOwnershipFence,
  type SandboxPhysicalCleanupResult,
  type SandboxProvisioningDiagnosticCommandKind,
  type SandboxProvisioningDiagnosticObserver,
  type SandboxProviderPrivateSecretFileDeleteRequest,
  type SandboxProviderPrivateSecretFileTransport,
  type SandboxProviderPrivateSecretFileWriteRequest,
  type SandboxRunCleanupAuthorization,
  type SandboxSecretFilePort,
} from '@cap/sandbox-core';

import type { BoxLiteClient, BoxLiteExecResult } from './boxlite-client.js';
import { boxLiteHttpStatusFromError } from './boxlite-client.js';
import { startBoxLiteProvisioningDiagnostic } from './boxlite-provisioning-diagnostics.js';

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
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
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
  /** Legacy completion-only acknowledgement for confirmed absence. */
  readonly afterSandboxCleanup?: (
    authorization: SandboxRunCleanupAuthorization,
  ) => Promise<void>;
  /** Typed acknowledgement for every physical attempt outcome. */
  readonly settleSandboxCleanupAttempt?: (
    authorization: SandboxRunCleanupAuthorization,
    physical: SandboxPhysicalCleanupResult,
  ) => Promise<void>;
  readonly deletionConfirmation?: Omit<
    BoxLiteSandboxDeletionConfirmationOptions,
    'client' | 'sandboxId' | 'diagnostics'
  >;
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
}

export interface BoxLiteWorkspaceSecurityAdapter {
  readonly secretFilePort: SandboxSecretFilePort;
  readonly stageExecutor: SandboxGitStageExecutor;
  /** Settles every provider-owned secret path before a run may be retained. */
  settleCredentialSafety(): Promise<void>;
  /** True only after sandbox deletion has been confirmed by an absence probe. */
  wasSandboxFenced(): boolean;
  /** True once this adapter entered its single cleanup/fencing lineage. */
  wasSandboxCleanupAttempted(): boolean;
  /**
   * True unless an authorized physical cleanup is awaiting its durable
   * acknowledgement.
   */
  wasSandboxCleanupAcknowledged(): boolean;
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
    (options.afterSandboxCleanup === undefined &&
      options.settleSandboxCleanupAttempt === undefined)
  ) {
    throw new SandboxProviderConfigurationError(
      'BoxLite cleanup callbacks must be provided together',
    );
  }
  if (
    options.ownership &&
    (!options.beforeSandboxCleanup ||
      (!options.afterSandboxCleanup &&
        !options.settleSandboxCleanupAttempt))
  ) {
    throw new SandboxProviderConfigurationError(
      'BoxLite durable workspace cleanup requires owner generation callbacks',
    );
  }
  const activeSecretPaths = new Set<string>();
  let sandboxFenced = false;
  let sandboxFenceRequired = false;
  let sandboxCleanupAttempted = false;
  let sandboxCleanupAcknowledged = true;
  let fencePromise: Promise<void> | null = null;

  const fenceSandbox = (): Promise<void> => {
    fencePromise ??= (async () => {
      sandboxCleanupAttempted = true;
      if (options.beforeSandboxCleanup) {
        // Until this callback and its matching evidence acknowledgement both
        // finish, any failure belongs to orchestration coordination.
        sandboxCleanupAcknowledged = false;
      }
      const cleanupAuthorization = options.beforeSandboxCleanup
        ? await options.beforeSandboxCleanup()
        : undefined;
      if (options.beforeSandboxCleanup && !cleanupAuthorization) {
        // Ownership moved to another worker. It owns subsequent resource and
        // credential cleanup; the stale worker must perform no more I/O.
        activeSecretPaths.clear();
        sandboxCleanupAcknowledged = true;
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
      const physical = await attemptDeleteBoxLiteSandboxAndConfirm({
        client: options.client,
        sandboxId: options.sandboxId,
        ...options.deletionConfirmation,
        diagnostics: options.diagnostics,
      });
      if (physical.outcome === 'succeeded') {
        // Physical absence is true even if the subsequent durable store
        // acknowledgement fails; keep those facts in separate state slots.
        sandboxFenced = true;
        activeSecretPaths.clear();
      }
      if (cleanupAuthorization) {
        if (options.settleSandboxCleanupAttempt) {
          await options.settleSandboxCleanupAttempt(
            cleanupAuthorization,
            physical,
          );
        } else if (physical.outcome === 'succeeded') {
          await options.afterSandboxCleanup?.(cleanupAuthorization);
        } else {
          throw new SandboxCleanupCoordinationPendingError();
        }
        sandboxCleanupAcknowledged = true;
      }
      if (physical.outcome !== 'succeeded') {
        throw new SandboxProviderConfigurationError(
          'BoxLite credential safety fencing could not be confirmed',
        );
      }
    })();
    return fencePromise;
  };

  const transport = createBoxLiteSecretFileTransport({
    client: options.client,
    sandboxId: options.sandboxId,
    activeSecretPaths,
    wasSandboxFenced: () => sandboxFenced,
    isSandboxFenceRequired: () => sandboxFenceRequired,
    requireSandboxFence: () => {
      sandboxFenceRequired = true;
    },
    fenceSandbox,
    diagnostics: options.diagnostics,
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
      requireSandboxFence: () => {
        sandboxFenceRequired = true;
      },
      diagnostics: options.diagnostics,
    }),
    async settleCredentialSafety(): Promise<void> {
      if (sandboxFenceRequired && activeSecretPaths.size === 0) {
        await fenceSandbox();
      }
      for (const path of [...activeSecretPaths]) {
        await transport.deleteFile({ path });
      }
    },
    wasSandboxFenced(): boolean {
      return sandboxFenced;
    },
    wasSandboxCleanupAttempted(): boolean {
      return sandboxCleanupAttempted;
    },
    wasSandboxCleanupAcknowledged(): boolean {
      return sandboxCleanupAcknowledged;
    },
  });
}

/**
 * BoxLite bridge for the shared staged Git engine. Non-transfer stages treat
 * exec resolution as a process-settlement boundary and fence the sandbox when
 * settlement cannot be observed. The `workspace_transfer` stage instead runs
 * as a detached supervised job driven by short polling execs: a dropped poll
 * settles from the job's pid/exit markers on a later probe rather than
 * forcing whole-sandbox fencing.
 */
export function createBoxLiteSandboxGitStageExecutor(options: {
  readonly client: Pick<BoxLiteClient, 'exec'>;
  readonly sandboxId: string;
  readonly fenceSandbox: () => Promise<void>;
  /** Defer fencing until the shared workspace layer has emitted its primary. */
  readonly requireSandboxFence?: () => void;
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
}): SandboxGitStageExecutor {
  const requireSandboxFence = async (): Promise<void> => {
    if (options.requireSandboxFence) {
      options.requireSandboxFence();
      return;
    }
    // Compatibility for direct users of this exported adapter. The provider
    // security bridge always supplies the deferred marker above.
    await options.fenceSandbox();
  };
  return Object.freeze({
    async execute(
      execution: SandboxGitStageExecution,
    ): Promise<SandboxCommandExecutionResult> {
      // Detached workspace-transfer settlement (spec: BoxLite detached
      // supervised transfer): every `workspace_transfer` exec is a short
      // control-plane exec (launch/marker probe/kill) against a detached
      // supervised job, so a dropped, timed-out, or cancelled response is
      // never settlement evidence and MUST NOT force whole-sandbox fencing.
      // The job's pid/exit markers carry the settlement proof and a
      // subsequent probe settles the stage from them; the kill path travels
      // this same seam and must reach the guest job, not a fenced sandbox.
      // All other stages keep the process-settlement boundary: an
      // unobservable exec still fences the sandbox.
      const markerSettled = execution.stage === 'workspace_transfer';
      if (execution.signal.aborted) {
        if (!markerSettled) await requireSandboxFence();
        return timedOutResult();
      }

      const onAbort = deferredAbort(execution.signal);
      if (execution.signal.aborted) {
        onAbort.dispose();
        if (!markerSettled) await requireSandboxFence();
        return timedOutResult();
      }
      const observedExec = options.client
        .exec({
          sandboxId: options.sandboxId,
          command: execution.request.command,
          cwd: execution.request.cwd,
          timeoutMs: execution.remainingTimeoutMs,
          cancellationSignal: execution.signal,
          diagnostics: options.diagnostics,
          commandKind: boxLiteGitCommandKind(execution.stage),
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
        if (!markerSettled) await requireSandboxFence();
        return timedOutResult();
      }
      if (outcome.kind === 'error') {
        if (markerSettled) {
          // A dropped poll settles nothing: report it as a timed-out control
          // exec and let the next marker probe settle the stage.
          return timedOutResult();
        }
        await requireSandboxFence();
        if (execution.signal.aborted || isAbortLike(outcome.error)) {
          return timedOutResult();
        }
        throw new SandboxProviderConfigurationError(
          'BoxLite workspace command settlement could not be observed safely',
        );
      }

      const result = normalizeExecResult(outcome.result);
      if (result.timedOut || execution.signal.aborted) {
        if (!markerSettled) await requireSandboxFence();
        return execution.signal.aborted ? timedOutResult() : result;
      }
      return result;
    },
  });
}

function boxLiteGitCommandKind(
  stage: SandboxGitStageExecution['stage'],
): SandboxProvisioningDiagnosticCommandKind | undefined {
  switch (stage) {
    case 'remote_ref_resolution':
      return 'git_remote_ref';
    case 'workspace_transfer':
      return 'git_clone';
    case 'checkout':
      return 'git_checkout';
    case 'submodules':
      return 'git_submodules';
    case 'delivery_status':
    case 'delivery_commit':
    case 'delivery_push':
      return undefined;
  }
}

/**
 * Execute one bounded physical delete/confirmation attempt.
 *
 * Provider transport values stay private. The result is the only value that
 * may cross into orchestration cleanup evidence.
 */
export async function attemptDeleteBoxLiteSandboxAndConfirm(
  options: BoxLiteSandboxDeletionConfirmationOptions,
): Promise<SandboxPhysicalCleanupResult> {
  const attempts =
    options.attempts ?? BOXLITE_SANDBOX_DELETE_CONFIRM_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new SandboxProviderConfigurationError(
      'BoxLite sandbox deletion confirmation attempts must be positive',
    );
  }

  const deleteDiagnostic = startBoxLiteProvisioningDiagnostic(
    options.diagnostics,
    {
      stage: 'cleanup',
      operation: 'sandbox_delete',
      channel: 'cleanup',
      commandKind: 'sandbox_cleanup',
    },
  );
  let deleteRetryable = true;
  let deleteSucceeded = false;
  try {
    await options.client.deleteSandbox(options.sandboxId);
    deleteSucceeded = true;
    deleteDiagnostic.succeed();
  } catch (error) {
    const status = boxLiteHttpStatusFromError(error);
    if (status === undefined) {
      deleteDiagnostic.fail(error, {
        outcome: 'indeterminate',
        cause: 'cleanup_unconfirmed',
        retryable: true,
      });
    } else {
      deleteRetryable = status === 408 || status === 429 || status >= 500;
      deleteDiagnostic.failHttp(status, {
        cause: status === 408 ? 'cleanup_unconfirmed' : 'cleanup_failed',
        retryable: deleteRetryable,
      });
    }
    // A rejected or lost delete request cannot prove presence or absence. Only
    // the subsequent absence probe can settle the fence successfully.
  }

  const confirmDiagnostic = startBoxLiteProvisioningDiagnostic(
    options.diagnostics,
    {
      stage: 'cleanup',
      operation: 'sandbox_absence_confirm',
      channel: 'cleanup',
      commandKind: 'sandbox_cleanup',
    },
  );
  const waitForRetry =
    options.waitForRetry ??
    (() => wait(BOXLITE_SANDBOX_DELETE_CONFIRM_DELAY_MS));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if ((await options.client.getSandbox(options.sandboxId)) === null) {
        confirmDiagnostic.succeed();
        return settleBoxLiteCleanupDiagnostics(
          options.diagnostics,
          confirmedBoxLiteCleanup(
            deleteSucceeded ? 'found-and-cleaned' : 'already-absent',
          ),
        );
      }
      if (attempt === attempts) {
        confirmDiagnostic.settle({
          outcome: 'failed',
          cause: 'cleanup_failed',
          retryable: deleteRetryable,
        });
        return settleBoxLiteCleanupDiagnostics(
          options.diagnostics,
          failedBoxLiteCleanup(deleteRetryable),
        );
      }
    } catch {
      // A probe error is uncertainty, never proof of absence.
      if (attempt === attempts) {
        confirmDiagnostic.settle({
          outcome: 'indeterminate',
          cause: 'cleanup_unconfirmed',
          retryable: true,
        });
        return settleBoxLiteCleanupDiagnostics(
          options.diagnostics,
          indeterminateBoxLiteCleanup(),
        );
      }
    }
    if (attempt < attempts) {
      try {
        await waitForRetry(attempt);
      } catch {
        confirmDiagnostic.settle({
          outcome: 'indeterminate',
          cause: 'cleanup_unconfirmed',
          retryable: true,
        });
        return settleBoxLiteCleanupDiagnostics(
          options.diagnostics,
          indeterminateBoxLiteCleanup(),
        );
      }
    }
  }
  return settleBoxLiteCleanupDiagnostics(
    options.diagnostics,
    indeterminateBoxLiteCleanup(),
  );
}

/** Delete once, then resolve only after BoxLite reports the sandbox absent. */
export async function deleteBoxLiteSandboxAndConfirm(
  options: BoxLiteSandboxDeletionConfirmationOptions,
): Promise<void> {
  const result = await attemptDeleteBoxLiteSandboxAndConfirm(options);
  if (result.outcome !== 'succeeded') {
    throw new SandboxProviderConfigurationError(
      'BoxLite credential safety fencing could not be confirmed',
    );
  }
}

function confirmedBoxLiteCleanup(
  proof: 'found-and-cleaned' | 'already-absent',
): SandboxPhysicalCleanupResult {
  return normalizeSandboxPhysicalCleanupResult({ kind: proof });
}

function failedBoxLiteCleanup(retryable: boolean): SandboxPhysicalCleanupResult {
  return normalizeSandboxPhysicalCleanupResult({
    outcome: 'failed',
    proof: null,
    cause: 'cleanup_failed',
    retryable,
  });
}

function indeterminateBoxLiteCleanup(): SandboxPhysicalCleanupResult {
  return normalizeSandboxPhysicalCleanupResult(undefined);
}

function settleBoxLiteCleanupDiagnostics(
  diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
  result: SandboxPhysicalCleanupResult,
): SandboxPhysicalCleanupResult {
  void flushProvisioningDiagnostics(diagnostics);
  return result;
}

async function flushProvisioningDiagnostics(
  diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
): Promise<void> {
  try {
    await diagnostics?.flush?.();
  } catch {
    // Evidence persistence is never cleanup authority.
  }
}

function createBoxLiteSecretFileTransport(options: {
  readonly client: BoxLiteClient;
  readonly sandboxId: string;
  readonly activeSecretPaths: Set<string>;
  readonly wasSandboxFenced: () => boolean;
  readonly isSandboxFenceRequired: () => boolean;
  readonly requireSandboxFence: () => void;
  readonly fenceSandbox: () => Promise<void>;
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
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
          cancellationSignal: request.signal,
          diagnostics: options.diagnostics,
          commandKind: 'credential_setup',
        }),
      );
      if (
        prepared.kind !== 'result' ||
        prepared.result.exitCode !== 0 ||
        prepared.result.timedOut === true
      ) {
        options.requireSandboxFence();
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
        options.requireSandboxFence();
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file upload was cancelled',
        );
      }
      if (uploaded.kind === 'error') {
        options.requireSandboxFence();
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
          cancellationSignal: request.signal,
          diagnostics: options.diagnostics,
          commandKind: 'credential_setup',
        }),
      );
      if (verified.kind !== 'result') {
        options.requireSandboxFence();
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file mode could not be verified',
        );
      }
      if (
        verified.result.exitCode !== 0 ||
        verified.result.timedOut === true
      ) {
        options.requireSandboxFence();
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
      if (options.isSandboxFenceRequired()) {
        await options.fenceSandbox();
        options.activeSecretPaths.delete(request.path);
        throw new SandboxProviderConfigurationError(
          'BoxLite secret file removal required sandbox fencing',
        );
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
          diagnostics: options.diagnostics,
          diagnosticChannel: 'cleanup',
          commandKind: 'credential_cleanup',
        });
        if (deleted.exitCode === 0 && deleted.timedOut !== true) {
          options.activeSecretPaths.delete(request.path);
          return;
        }
      } catch {
        // The native cleanup aggregate and shared credential-cleanup stage own
        // the bounded evidence; a missing response still requires fencing.
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
