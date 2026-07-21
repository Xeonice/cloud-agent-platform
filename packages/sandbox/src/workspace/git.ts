import {
  buildSandboxDetachedJobKillCommand,
  buildSandboxDetachedJobLaunchCommand,
  buildSandboxDetachedJobProbeCommand,
  normalizeSandboxCommandResult,
  resolveSandboxDetachedJobLivenessPolicy,
  sandboxDetachedJobMarkerPaths,
  SandboxProviderConfigurationError,
  SandboxWorkspaceTransferDetachedSignal,
  scrubSandboxCommandOutput,
  snapshotSandboxWorkspaceTransferProgress,
  triageSandboxDetachedJobProbeOutput,
  type GitCloneSpec,
  type SandboxDetachedJobProgressStat,
  type SandboxDetachedTransferOptions,
  type SandboxDetachedWorkspaceTransferJob,
  type SandboxDetachedWorkspaceTransferObservation,
  type SandboxDetachedWorkspaceTransferProbe,
  type SandboxWorkspaceTransferProgressSnapshot,
  type SandboxCommandExecutionResult,
  type SandboxGitCommandStage,
  type SandboxGitDeliveryResult,
  type SandboxGitStageExecutor,
  type SandboxProvisioningDiagnosticCause,
  type SandboxProvisioningDiagnosticCommandKind,
  type SandboxProvisioningDiagnosticOperation,
  type SandboxProvisioningDiagnosticReplayKey,
  type SandboxSecretFileHandle,
  type SandboxWorkspaceDeliveryHookContext,
  type SandboxWorkspaceMaterializationHookContext,
  type SandboxWorkspaceMaterializationResult,
  type SandboxWorkspaceMaterializationStage,
  type SandboxWorkspaceFailureCause,
  type SandboxWorkspaceProgressEvent,
} from '@cap/sandbox-core';

const DELIVERY_PENDING_MARKER = 'cap-delivery-base';
const DELIVERY_PENDING_SENTINEL = 'CAP_DELIVERY_PENDING';
const DELIVERY_COMMIT_MESSAGE_PATH = '/tmp/cap-delivery-commit-message';

/**
 * Defense-in-depth stall abort on the detached clone itself: git aborts the
 * transfer into a clean nonzero exit marker when throughput stays below the
 * limit for the configured time, so the external heartbeat gate is a backstop
 * rather than the only line of defense.
 */
export const GIT_HTTP_LOW_SPEED_LIMIT_BYTES_PER_SECOND = 1024;
export const GIT_HTTP_LOW_SPEED_TIME_SECONDS = 60;

/** Cadence of the short marker-probe polling execs for a detached transfer. */
export const DEFAULT_SANDBOX_TRANSFER_POLL_INTERVAL_MS = 2_000;
/** Timeout for the short detached-transfer control execs (launch/probe/kill). */
export const SANDBOX_TRANSFER_CONTROL_EXEC_TIMEOUT_MS = 30_000;
/** Bytes of progress-marker tail carried back by each polling exec. */
const TRANSFER_PROGRESS_TAIL_BYTES = 4_096;
const TRANSFER_PROGRESS_TAIL_SENTINEL = 'CAP_TRANSFER_PROGRESS_TAIL';
/** Sibling staging suffix; the tree flips to the workspace dir atomically. */
const TRANSFER_STAGING_SUFFIX = '.cap-stage';

type ActiveWorkspaceStage = Exclude<
  SandboxWorkspaceMaterializationStage,
  'complete'
>;

type ActiveWorkspaceFailure =
  | {
      readonly status: 'failed';
      readonly stage: ActiveWorkspaceStage;
      readonly cause: SandboxWorkspaceFailureCause;
      readonly retryable: boolean;
    }
  | {
      readonly status: 'cancelled';
      readonly stage: ActiveWorkspaceStage;
    };

type ActiveWorkspaceTerminalProgress =
  | {
      readonly status: 'succeeded';
      readonly stage: ActiveWorkspaceStage;
    }
  | ActiveWorkspaceFailure;

interface WorkspaceDiagnosticDescriptor {
  readonly replayKey: SandboxProvisioningDiagnosticReplayKey;
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly channel: 'primary' | 'cleanup';
  readonly commandKind: SandboxProvisioningDiagnosticCommandKind;
}

const WORKSPACE_DIAGNOSTIC_DESCRIPTORS = Object.freeze({
  credential_setup: {
    replayKey: 'workspace.credential_setup',
    operation: 'credential_setup',
    channel: 'primary',
    commandKind: 'credential_setup',
  },
  remote_ref_resolution: {
    replayKey: 'workspace.remote_ref_resolution',
    operation: 'remote_ref_resolve',
    channel: 'primary',
    commandKind: 'git_remote_ref',
  },
  workspace_transfer: {
    replayKey: 'workspace.workspace_transfer',
    operation: 'repository_transfer',
    channel: 'primary',
    commandKind: 'git_clone',
  },
  checkout: {
    replayKey: 'workspace.checkout',
    operation: 'checkout',
    channel: 'primary',
    commandKind: 'git_checkout',
  },
  submodules: {
    replayKey: 'workspace.submodules',
    operation: 'submodules',
    channel: 'primary',
    commandKind: 'git_submodules',
  },
  credential_cleanup: {
    replayKey: 'workspace.credential_cleanup',
    operation: 'credential_cleanup',
    channel: 'cleanup',
    commandKind: 'credential_cleanup',
  },
} as const satisfies Record<ActiveWorkspaceStage, WorkspaceDiagnosticDescriptor>);

export interface SandboxGitFailureClassification {
  readonly cause: SandboxWorkspaceFailureCause;
  readonly retryable: boolean;
}

export interface SandboxGitDeadlineDriver {
  /** Monotonic milliseconds. */
  now(): number;
  /** Returns an idempotent cancellation function for the trigger. */
  schedule(delayMs: number, trigger: () => void): () => void;
}

export const systemSandboxGitDeadlineDriver: SandboxGitDeadlineDriver =
  Object.freeze({
    now: () => performance.now(),
    schedule(delayMs: number, trigger: () => void) {
      const timer = setTimeout(trigger, delayMs);
      return () => clearTimeout(timer);
    },
  });

export interface SandboxGitHelperOptions {
  readonly deadlineDriver?: SandboxGitDeadlineDriver;
}

export interface SandboxGitFailureEvidence {
  readonly stage: SandboxGitCommandStage;
  readonly result?: Pick<
    SandboxCommandExecutionResult,
    'exitCode' | 'output' | 'stdout' | 'stderr' | 'timedOut'
  >;
  readonly error?: unknown;
  readonly deadlineExceeded?: boolean;
}

/**
 * Central secret-free classifier shared by real providers and conformance.
 * Raw evidence is inspected transiently and never copied into the result.
 */
export function classifySandboxGitFailure(
  evidence: SandboxGitFailureEvidence,
): SandboxGitFailureClassification {
  if (evidence.deadlineExceeded || evidence.result?.timedOut === true) {
    return { cause: 'timeout', retryable: true };
  }

  const text = [
    evidence.result?.output,
    evidence.result?.stdout,
    evidence.result?.stderr,
    errorText(evidence.error),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();

  if (
    text.includes('no space left on device') ||
    text.includes('disk quota exceeded') ||
    text.includes('enospc') ||
    text.includes('filesystem is full')
  ) {
    return { cause: 'capacity_exhausted', retryable: false };
  }
  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('access denied') ||
    text.includes('permission denied') ||
    /(?:http|status)[^\n]*(?:401|403)/u.test(text)
  ) {
    return { cause: 'authentication', retryable: false };
  }
  if (
    (evidence.stage === 'remote_ref_resolution' &&
      evidence.result?.exitCode === 2) ||
    text.includes("couldn't find remote ref") ||
    text.includes('remote ref does not exist') ||
    text.includes('unknown revision') ||
    text.includes('reference is not a tree') ||
    text.includes('pathspec')
  ) {
    return { cause: 'ref_not_found', retryable: false };
  }
  if (
    text.includes('could not resolve host') ||
    text.includes('failed to connect') ||
    text.includes('connection refused') ||
    text.includes('connection reset') ||
    text.includes('connection timed out') ||
    text.includes('network is unreachable') ||
    text.includes('ssl certificate') ||
    text.includes('certificate verify') ||
    text.includes('tls') ||
    // Mid-transfer stream death signatures (live incident 2026-07-21: an
    // 818 MB pack over an unstable link dies with these long-stable git/curl
    // phrasings; previously they fell into the unknown bucket).
    text.includes('rpc failed') ||
    text.includes('unexpected disconnect') ||
    text.includes('early eof') ||
    text.includes('transfer closed') ||
    text.includes('operation too slow') ||
    text.includes('the remote end hung up')
  ) {
    return { cause: 'tls_network', retryable: true };
  }
  return { cause: 'unknown', retryable: false };
}

export async function materializeSandboxGitWorkspaceStaged(
  context: SandboxWorkspaceMaterializationHookContext,
  options: SandboxGitHelperOptions = {},
): Promise<SandboxWorkspaceMaterializationResult> {
  const deadline = createOperationDeadline({
    deadlineMs: context.plan.deadlineMs,
    cancellationSignal: context.cancellationSignal,
    driver: options.deadlineDriver ?? systemSandboxGitDeadlineDriver,
  });
  let result: ActiveWorkspaceFailure | null = null;
  let handle: SandboxSecretFileHandle | null = null;

  try {
    await assertWorkspaceBoundary(context, 'credential_setup', 'before');
    await reportWorkspaceStageStarted(context, 'credential_setup');
    if (context.plan.credential !== undefined) {
      if (!context.secretFilePort) {
        result = failed('credential_setup', 'unknown', false);
      } else {
        try {
          handle = await context.secretFilePort.writeSecretFile({
            kind: 'git-http-credential',
            credential: context.plan.credential,
            signal: deadline.signal,
          });
          if (handle.mode !== 0o600) {
            result = failed('credential_setup', 'unknown', false);
          }
        } catch {
          result = failed('credential_setup', 'unknown', false);
        }
      }
    }
    await assertWorkspaceBoundary(context, 'credential_setup', 'after');
    const credentialInterruption = deadline.interruption('credential_setup');
    if (credentialInterruption !== null) result = credentialInterruption;
    if (result !== null) {
      await reportWorkspaceStageTerminal(context, result);
    }
    if (result === null) {
      await reportWorkspaceStageTerminal(context, {
        status: 'succeeded',
        stage: 'credential_setup',
      });
      const configPath = handle?.path;
      const driver = options.deadlineDriver ?? systemSandboxGitDeadlineDriver;
      const stages = materializationCommands(
        context.plan.repositoryUrl,
        context.plan.resolvedBranch,
        context.workspaceDir,
        configPath,
      );
      for (const stage of stages) {
        let stageResult: ActiveWorkspaceFailure | null;
        if (stage.stage === 'workspace_transfer') {
          stageResult = await runTransferWithRetries({
            context,
            deadline,
            driver,
            configPath,
            stage: stage.stage,
            command: stage.command,
          });
        } else {
          stageResult = await runMaterializationStage({
            context,
            deadline,
            stage: stage.stage,
            command: stage.command,
          });
        }
        if (stageResult !== null) {
          result = stageResult;
          break;
        }
      }
    }
  } finally {
    await reportWorkspaceStageStarted(context, 'credential_cleanup');
    let cleanupResult: ActiveWorkspaceTerminalProgress = {
      status: 'succeeded',
      stage: 'credential_cleanup',
    };
    try {
      if (handle !== null && context.secretFilePort) {
        await context.secretFilePort.deleteSecretFile(handle);
      }
    } catch {
      cleanupResult = failed('credential_cleanup', 'unknown', false);
    }

    const cleanupInterruption = deadline.interruption('credential_cleanup');
    if (cleanupInterruption !== null) cleanupResult = cleanupInterruption;
    await reportWorkspaceStageTerminal(context, cleanupResult);
    if (cleanupResult.status !== 'succeeded' && result === null) {
      result = cleanupResult;
    }
    deadline.dispose();
  }

  if (result === null) {
    const completed = { status: 'succeeded', stage: 'complete' } as const;
    await reportProgress(context, completed);
    return completed;
  }

  return result;
}

export async function deliverSandboxGitWorkspaceStaged(
  context: SandboxWorkspaceDeliveryHookContext,
  options: SandboxGitHelperOptions = {},
): Promise<SandboxGitDeliveryResult> {
  const deadline = createOperationDeadline({
    deadlineMs: context.plan.deadlineMs,
    cancellationSignal: context.plan.cancellationSignal,
    driver: options.deadlineDriver ?? systemSandboxGitDeadlineDriver,
  });
  let handle: SandboxSecretFileHandle | null = null;
  let pushSucceeded = false;
  let result: SandboxGitDeliveryResult = deliveryFailure(
    false,
    null,
    'workspace_git_unknown',
  );

  try {
    operation: {
      const status = await runDeliveryCommand({
        context,
        deadline,
        stage: 'delivery_status',
        command: deliveryStatusCommand(),
      });
      if (!status.ok) {
        result = status.result;
        break operation;
      }

      const statusLines = status.execution.output.split(/\r?\n/u);
      const pending = statusLines[0] === DELIVERY_PENDING_SENTINEL;
      const dirty = statusLines
        .slice(pending ? 1 : 0)
        .some((line) => line.length > 0);
      if (!dirty && !pending) {
        result = { hadChanges: false, commitSha: null, error: null };
        break operation;
      }

      if (dirty) {
        const committed = await runDeliveryCommand({
          context,
          deadline,
          stage: 'delivery_commit',
          command: deliveryCommitCommand(context.plan.commitMessage),
        });
        if (!committed.ok) {
          result = withDeliveryChanges(committed.result);
          break operation;
        }
      }

      const sha = await runDeliveryCommand({
        context,
        deadline,
        stage: 'delivery_commit',
        command: 'git rev-parse HEAD',
      });
      if (!sha.ok) {
        result = withDeliveryChanges(sha.result);
        break operation;
      }
      const commitSha = firstToken(sha.execution.output);

      try {
        handle = await context.secretFilePort.writeSecretFile({
          kind: 'git-http-credential',
          credential: context.plan.credential,
          signal: deadline.signal,
        });
        if (handle.mode !== 0o600) {
          result = deliveryFailure(
            true,
            commitSha,
            'workspace_git_credential_setup_unknown',
          );
          break operation;
        }
      } catch {
        const interruption = deadline.interruption('credential_setup');
        result =
          interruption === null
            ? deliveryFailure(
                true,
                commitSha,
                'workspace_git_credential_setup_unknown',
              )
            : deliveryInterruption(true, commitSha, interruption);
        break operation;
      }

      const credentialInterruption = deadline.interruption('credential_setup');
      if (credentialInterruption !== null) {
        result = deliveryInterruption(
          true,
          commitSha,
          credentialInterruption,
        );
        break operation;
      }

      const push = await runDeliveryCommand({
        context,
        deadline,
        stage: 'delivery_push',
        command: gitCommand(
          handle.path,
          `push --force-with-lease origin ${shellQuote(
            `HEAD:refs/heads/${context.plan.branch}`,
          )}`,
        ),
      });
      if (!push.ok) {
        result = withDeliveryChanges(push.result, commitSha);
        break operation;
      }

      pushSucceeded = true;
      result = { hadChanges: true, commitSha, error: null };
    }
  } finally {
    if (handle !== null) {
      try {
        await context.secretFilePort.deleteSecretFile(handle);
      } catch {
        result = deliveryFailure(
          result.hadChanges,
          result.commitSha,
          'workspace_git_credential_cleanup_unknown',
        );
      }
    }
    const interruption = deadline.interruption('credential_cleanup');
    if (
      interruption !== null &&
      (result.error === null || result.error.endsWith('_unknown'))
    ) {
      result = deliveryInterruption(
        result.hadChanges,
        result.commitSha,
        interruption,
      );
    }
    if (pushSucceeded && result.error === null) {
      const finalized = await runDeliveryCommand({
        context,
        deadline,
        stage: 'delivery_commit',
        command: deliveryFinalizeCommand(),
      });
      if (!finalized.ok) {
        result = withDeliveryChanges(finalized.result, result.commitSha);
      }
    }
    deadline.dispose();
  }
  return result;
}

interface MaterializationCommand {
  readonly stage: Exclude<
    ActiveWorkspaceStage,
    'credential_setup' | 'credential_cleanup'
  >;
  readonly command: string;
}

function materializationCommands(
  repositoryUrl: string,
  branch: string,
  workspaceDir: string,
  configPath: string | undefined,
): readonly MaterializationCommand[] {
  const parent = dirname(workspaceDir);
  const remoteRef = `refs/heads/${branch}`;
  return [
    {
      stage: 'remote_ref_resolution',
      command: gitCommand(
        configPath,
        `ls-remote --exit-code --heads -- ${shellQuote(
          repositoryUrl,
        )} ${shellQuote(remoteRef)}`,
      ),
    },
    {
      stage: 'workspace_transfer',
      command:
        `rm -rf -- ${shellQuote(workspaceDir)} && ` +
        `mkdir -p -- ${shellQuote(parent)} && ` +
        gitCommand(
          configPath,
          `clone --no-checkout --single-branch --branch ${shellQuote(
            branch,
          )} -- ${shellQuote(repositoryUrl)} ${shellQuote(workspaceDir)}`,
        ),
    },
    {
      stage: 'checkout',
      command: gitCommand(
        configPath,
        `-C ${shellQuote(workspaceDir)} checkout --force -B ${shellQuote(
          branch,
        )} ${shellQuote(`refs/remotes/origin/${branch}`)}`,
      ),
    },
    {
      stage: 'submodules',
      command:
        gitCommand(
          configPath,
          `-C ${shellQuote(workspaceDir)} submodule sync --recursive`,
        ) +
        ' && ' +
        gitCommand(
          configPath,
          `-C ${shellQuote(
            workspaceDir,
          )} submodule update --init --recursive`,
        ),
    },
  ];
}

/**
 * Bounded automatic retry for the INLINE repository-transfer stage
 * (fix-clone-retry-and-tui-classifier, design D1). Live incident 2026-07-21:
 * an 818 MB pack over an intermittently unstable link failed 3 of 6 platform
 * clones; a single retry would have recovered every one. Only transient causes
 * retry (tls_network, plus the unknown fallback that mid-transfer stream death
 * collapses into when the exec output is lost); deterministic causes
 * (authentication, missing ref, capacity, timeout) settle immediately. Each
 * attempt is independently observable: a non-final failure settles
 * `retryable: true` and the next attempt emits its own start — never a silent
 * in-place retry. The stage command starts with `rm -rf`, so every attempt is
 * a clean slate. The detached dual-gate transfer path has its own liveness
 * model and is untouched.
 */
const TRANSFER_MAX_ATTEMPTS = 3;
const TRANSFER_RETRY_BACKOFF_MS = 5_000;
/** No attempt starts with less remaining deadline budget than this. */
const TRANSFER_RETRY_MIN_BUDGET_MS = 60_000;
const TRANSFER_RETRYABLE_CAUSES: ReadonlySet<SandboxWorkspaceFailureCause> =
  new Set(['tls_network', 'unknown']);

async function runTransferWithRetries(args: {
  readonly context: SandboxWorkspaceMaterializationHookContext;
  readonly deadline: OperationDeadline;
  readonly driver: SandboxGitDeadlineDriver;
  readonly configPath: string | undefined;
  readonly stage: MaterializationCommand['stage'];
  readonly command: string;
}): Promise<ActiveWorkspaceFailure | null> {
  const detached = args.context.detachedTransfer;
  for (let attempt = 1; attempt <= TRANSFER_MAX_ATTEMPTS; attempt += 1) {
    const anotherAttemptPossible =
      attempt < TRANSFER_MAX_ATTEMPTS &&
      args.deadline.remainingTimeoutMs() >
        TRANSFER_RETRY_MIN_BUDGET_MS + TRANSFER_RETRY_BACKOFF_MS;
    // Attempts after the first mint a fresh operation identity so each
    // attempt's start/terminal pair survives replay-key idempotency.
    const attemptOperationId =
      attempt > 1 ? args.context.diagnostics?.createOperationId() : undefined;
    let outcome: ActiveWorkspaceFailure | null;
    if (detached !== undefined) {
      // Dual-gate liveness replaces the wall clock for this stage only:
      // pause the operation deadline so transfer time never burns the
      // other stages' budget, then resume it between attempts and for
      // checkout onwards. Both the git-side low-speed abort (observed live:
      // throughput collapse below 1 KB/s for 60 s kills the clone at ~62 s)
      // and mid-transfer stream death land here as retryable tls_network.
      args.deadline.pause();
      try {
        outcome = await runDetachedWorkspaceTransfer({
          context: args.context,
          deadline: args.deadline,
          driver: args.driver,
          configPath: args.configPath,
          options: detached,
          attemptOperationId,
        });
      } finally {
        args.deadline.resume();
      }
    } else {
      outcome = await runMaterializationStage({
        context: args.context,
        deadline: args.deadline,
        stage: args.stage,
        command: args.command,
        plannedRetryCauses: anotherAttemptPossible
          ? TRANSFER_RETRYABLE_CAUSES
          : undefined,
        attemptOperationId,
      });
    }
    if (outcome === null) return null;
    const willRetry =
      anotherAttemptPossible &&
      outcome.status === 'failed' &&
      TRANSFER_RETRYABLE_CAUSES.has(outcome.cause) &&
      args.deadline.interruption(args.stage) === null;
    if (!willRetry) return outcome;
    await sleepWithDriver(args.driver, TRANSFER_RETRY_BACKOFF_MS);
    if (args.deadline.remainingTimeoutMs() <= TRANSFER_RETRY_MIN_BUDGET_MS) {
      return outcome;
    }
  }
  // Unreachable: the final loop iteration always returns.
  return failed(args.stage, 'unknown', false);
}

async function runMaterializationStage(args: {
  readonly context: SandboxWorkspaceMaterializationHookContext;
  readonly deadline: OperationDeadline;
  readonly stage: MaterializationCommand['stage'];
  readonly command: string;
  /**
   * When set, a failure whose cause is in this set is emitted `retryable: true`
   * (the caller intends another attempt); absent = final-attempt semantics.
   */
  readonly plannedRetryCauses?: ReadonlySet<SandboxWorkspaceFailureCause>;
  /** Distinct operation identity for retry attempts (attempt > 1). */
  readonly attemptOperationId?: string;
}): Promise<ActiveWorkspaceFailure | null> {
  const interruption = args.deadline.interruption(args.stage);
  if (interruption !== null) {
    await reportWorkspaceStageTerminal(
      args.context,
      interruption,
      undefined,
      args.attemptOperationId,
    );
    return interruption;
  }
  await assertWorkspaceBoundary(args.context, args.stage, 'before');
  await reportWorkspaceStageStarted(
    args.context,
    args.stage,
    args.attemptOperationId,
  );
  let execution: SandboxCommandExecutionResult | null = null;
  let executionError: unknown;
  try {
    execution = await executeStage({
      executor: args.context.stageExecutor,
      deadline: args.deadline,
      stage: args.stage,
      command: args.command,
    });
  } catch (error) {
    executionError = error;
  }
  await assertWorkspaceBoundary(args.context, args.stage, 'after');
  try {
    const after = args.deadline.interruption(args.stage);
    if (after !== null) {
      await reportWorkspaceStageTerminal(
        args.context,
        after,
        undefined,
        args.attemptOperationId,
      );
      return after;
    }
    if (executionError !== undefined) throw executionError;
    if (!execution) throw new Error('Workspace stage returned no execution result');
    if (execution.timedOut || execution.exitCode !== 0) {
      const classification = classifySandboxGitFailure({
        stage: args.stage,
        result: execution,
      });
      const outcome = failed(
        args.stage,
        classification.cause,
        classification.retryable ||
          (args.plannedRetryCauses?.has(classification.cause) ?? false),
      );
      await reportWorkspaceStageTerminal(
        args.context,
        outcome,
        undefined,
        args.attemptOperationId,
      );
      return outcome;
    }
    await reportWorkspaceStageTerminal(
      args.context,
      {
        status: 'succeeded',
        stage: args.stage,
      },
      undefined,
      args.attemptOperationId,
    );
    return null;
  } catch (error) {
    const after = args.deadline.interruption(args.stage);
    if (after !== null) {
      await reportWorkspaceStageTerminal(
        args.context,
        after,
        undefined,
        args.attemptOperationId,
      );
      return after;
    }
    const classification = classifySandboxGitFailure({
      stage: args.stage,
      error,
    });
    const outcome = failed(
      args.stage,
      classification.cause,
      classification.retryable ||
        (args.plannedRetryCauses?.has(classification.cause) ?? false),
    );
    await reportWorkspaceStageTerminal(
      args.context,
      outcome,
      undefined,
      args.attemptOperationId,
    );
    return outcome;
  }
}

/**
 * Deterministic detached-job id for a task's workspace transfer so probe/kill
 * callers (admission parking, stop) can re-derive the marker paths from the
 * task id alone.
 */
export function sandboxWorkspaceTransferJobId(taskId: string): string {
  const sanitized = taskId.replace(/[^A-Za-z0-9._-]/gu, '-');
  const id = `ws-transfer-${sanitized}`.slice(0, 128);
  if (!/^[A-Za-z0-9]/u.test(id)) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace transfer job id must start alphanumeric',
    );
  }
  return id;
}

/**
 * Detached clone child command (spec: workspace transfer reports parsed clone
 * progress): `--progress` on a stderr that the job wrapper redirects into the
 * progress marker, plus git-native low-speed stall abort as defense in depth.
 * The clone materializes into a sibling staging path; the wrapper's atomic
 * publish flips it to the workspace dir before the exit marker.
 */
function detachedTransferCloneCommand(args: {
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly workspaceDir: string;
  readonly stagingDir: string;
  readonly configPath: string | undefined;
}): string {
  return (
    `rm -rf -- ${shellQuote(args.stagingDir)} ${shellQuote(args.workspaceDir)} && ` +
    `mkdir -p -- ${shellQuote(dirname(args.workspaceDir))} && ` +
    `env GIT_HTTP_LOW_SPEED_LIMIT=${GIT_HTTP_LOW_SPEED_LIMIT_BYTES_PER_SECOND} ` +
    `GIT_HTTP_LOW_SPEED_TIME=${GIT_HTTP_LOW_SPEED_TIME_SECONDS} ` +
    gitCommand(
      args.configPath,
      `clone --progress --no-checkout --single-branch --branch ${shellQuote(
        args.branch,
      )} -- ${shellQuote(args.repositoryUrl)} ${shellQuote(args.stagingDir)}`,
    )
  );
}

/** Marker probe plus a bounded tail of the progress stream in one short exec. */
function detachedTransferProbeCommand(
  jobId: string,
  markerRoot: string | undefined,
): string {
  const progressPath = sandboxDetachedJobMarkerPaths(jobId, markerRoot).progress;
  return (
    `${buildSandboxDetachedJobProbeCommand(jobId, markerRoot)}; ` +
    `printf '%s\\n' ${shellQuote(TRANSFER_PROGRESS_TAIL_SENTINEL)}; ` +
    `tail -c ${TRANSFER_PROGRESS_TAIL_BYTES} -- ${shellQuote(progressPath)} 2>/dev/null || :`
  );
}

function splitDetachedProbeOutput(output: string): {
  readonly triageText: string;
  readonly progressTail: string;
} {
  const index = output.indexOf(TRANSFER_PROGRESS_TAIL_SENTINEL);
  if (index < 0) return { triageText: output, progressTail: '' };
  return {
    triageText: output.slice(0, index),
    progressTail: output.slice(
      index + TRANSFER_PROGRESS_TAIL_SENTINEL.length,
    ),
  };
}

const GIT_RECEIVING_OBJECTS_PATTERN =
  /Receiving objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s+([\d.]+)\s+(B|KiB|MiB|GiB|TiB))?(?:\s*\|\s*([\d.]+)\s+(B|KiB|MiB|GiB|TiB)\/s)?/u;
const GIT_INDETERMINATE_PHASE_PATTERN =
  /(?:remote:\s*)?(?:Enumerating|Counting|Compressing) objects:|Resolving deltas:|Updating files:/u;

const GIT_SIZE_UNIT_BYTES: Readonly<Record<string, number>> = Object.freeze({
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
});

/**
 * Host-side parser for git's clone stderr progress stream. Tolerates multiple
 * phases (Counting/Compressing/Receiving objects/Resolving deltas) and
 * CR-delimited lines. Phases before "Receiving objects" — and any unparsed
 * content — report an explicitly indeterminate snapshot (never 0%); only a
 * completely empty stream returns null ("no observation yet").
 */
export function parseGitTransferProgress(
  text: string,
): SandboxWorkspaceTransferProgressSnapshot | null {
  const lines = text
    .split(/[\r\n]+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const receiving = GIT_RECEIVING_OBJECTS_PATTERN.exec(line);
    if (receiving !== null) {
      try {
        return snapshotSandboxWorkspaceTransferProgress({
          percent: Number(receiving[1]),
          receivedObjects: Number(receiving[2]),
          totalObjects: Number(receiving[3]),
          receivedBytes: gitSizeToBytes(receiving[4], receiving[5]),
          throughputBytesPerSecond: gitSizeToBytes(
            receiving[6],
            receiving[7],
          ),
        });
      } catch {
        return INDETERMINATE_TRANSFER_PROGRESS;
      }
    }
    if (GIT_INDETERMINATE_PHASE_PATTERN.test(line)) {
      return INDETERMINATE_TRANSFER_PROGRESS;
    }
  }
  // Unparsed-but-present output counts as "unknown phase, still alive".
  return INDETERMINATE_TRANSFER_PROGRESS;
}

const INDETERMINATE_TRANSFER_PROGRESS: SandboxWorkspaceTransferProgressSnapshot =
  Object.freeze({
    percent: null,
    receivedObjects: null,
    totalObjects: null,
    receivedBytes: null,
    throughputBytesPerSecond: null,
  });

function gitSizeToBytes(
  value: string | undefined,
  unit: string | undefined,
): number | null {
  if (value === undefined || unit === undefined) return null;
  const scale = GIT_SIZE_UNIT_BYTES[unit];
  const parsed = Number(value);
  if (scale === undefined || !Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed * scale);
}

function transferProgressEquals(
  left: SandboxWorkspaceTransferProgressSnapshot | null,
  right: SandboxWorkspaceTransferProgressSnapshot,
): boolean {
  return (
    left !== null &&
    left.percent === right.percent &&
    left.receivedObjects === right.receivedObjects &&
    left.totalObjects === right.totalObjects &&
    left.receivedBytes === right.receivedBytes &&
    left.throughputBytesPerSecond === right.throughputBytesPerSecond
  );
}

/**
 * Detached workspace-transfer stage: setsid launch + short polling execs
 * through the same stage executor replace the single long-held exec. Liveness
 * is governed by dual gates (no-progress heartbeat on progress-marker
 * byte-growth/mtime advance, absolute cap backstop) instead of the operation
 * deadline; the deadline is paused for this stage only, so the transfer's
 * duration never burns the other stages' wall clock. Settlement always comes
 * from markers: exit marker = proof, progress = output stream, and an
 * unprovable job is a typed failure — never success, never indefinite waiting.
 *
 * Diagnostics stay bounded (spec: detached-job lifecycle is bounded events):
 * exactly one started and one terminal `git_clone` event per job through the
 * existing observer; per-poll observations never reach the event ledger.
 */
async function runDetachedWorkspaceTransfer(args: {
  readonly context: SandboxWorkspaceMaterializationHookContext;
  readonly deadline: OperationDeadline;
  readonly driver: SandboxGitDeadlineDriver;
  readonly configPath: string | undefined;
  readonly options: SandboxDetachedTransferOptions;
  /** Distinct operation identity for retry attempts (attempt > 1). */
  readonly attemptOperationId?: string;
}): Promise<ActiveWorkspaceFailure | null> {
  const { context, deadline, driver } = args;
  const stage = 'workspace_transfer' as const;
  const before = deadline.interruption(stage);
  if (before !== null) {
    await reportWorkspaceStageTerminal(
      context,
      before,
      undefined,
      args.attemptOperationId,
    );
    return before;
  }
  await assertWorkspaceBoundary(context, stage, 'before');
  await reportWorkspaceStageStarted(context, stage, args.attemptOperationId);

  const liveness = resolveSandboxDetachedJobLivenessPolicy(
    args.options.liveness ?? undefined,
  );
  const pollIntervalMs =
    args.options.pollIntervalMs ?? DEFAULT_SANDBOX_TRANSFER_POLL_INTERVAL_MS;
  const markerRoot = args.options.markerRoot;
  const jobId = sandboxWorkspaceTransferJobId(context.taskId);
  const stagingDir = `${context.workspaceDir}${TRANSFER_STAGING_SUFFIX}`;
  const launchCommand = buildSandboxDetachedJobLaunchCommand({
    jobId,
    command: detachedTransferCloneCommand({
      repositoryUrl: context.plan.repositoryUrl,
      branch: context.plan.resolvedBranch,
      workspaceDir: context.workspaceDir,
      stagingDir,
      configPath: args.configPath,
    }),
    publish: { stagingPath: stagingDir, finalPath: context.workspaceDir },
    ...(markerRoot === undefined ? {} : { markerRoot }),
  });
  const probeCommand = detachedTransferProbeCommand(jobId, markerRoot);
  const jobPort = createDetachedTransferJobPort({
    context,
    jobId,
    probeCommand,
    markerRoot,
  });

  const settle = async (
    outcome: ActiveWorkspaceFailure | null,
    diagnosticTimeoutMs?: number,
  ): Promise<ActiveWorkspaceFailure | null> => {
    await assertWorkspaceBoundary(context, stage, 'after');
    await reportWorkspaceStageTerminal(
      context,
      outcome ?? { status: 'succeeded', stage },
      diagnosticTimeoutMs === undefined
        ? undefined
        : { timeoutMs: diagnosticTimeoutMs },
      args.attemptOperationId,
    );
    return outcome;
  };
  const killAndSettle = async (
    outcome: ActiveWorkspaceFailure,
    diagnosticTimeoutMs?: number,
  ): Promise<ActiveWorkspaceFailure | null> => {
    await killDetachedTransferJob(context, jobId, markerRoot);
    return settle(outcome, diagnosticTimeoutMs);
  };

  const detachment = context.detachment;
  if (detachment?.resume !== undefined) {
    // Resume of previously parked work (detach-workspace-clone D9): gather
    // marker evidence through the sandbox exec seam and delegate the
    // three-way decision to the caller-owned (admission claim path) triage
    // BEFORE any relaunch. A finished clone settles from its exit marker and
    // is never re-run from scratch; an unprovable job fails the attempt.
    let probeExec: SandboxCommandExecutionResult | null = null;
    try {
      probeExec = await transferControlExec(
        context,
        probeCommand,
        deadline.signal,
      );
    } catch {
      probeExec = null;
    }
    let evidence: SandboxDetachedWorkspaceTransferProbe = {
      pidAlive: false,
      exitMarker: null,
      progressObserved: false,
    };
    let progressTail = '';
    if (probeExec !== null && !probeExec.timedOut && probeExec.exitCode === 0) {
      const split = splitDetachedProbeOutput(probeExec.output);
      progressTail = split.progressTail;
      const triaged = triageSandboxDetachedJobProbeOutput(split.triageText);
      evidence = {
        pidAlive: triaged.state === 'alive',
        exitMarker:
          triaged.state === 'exited'
            ? { exitCode: triaged.exitCode }
            : null,
        progressObserved:
          progressTail.trim().length > 0 ||
          (triaged.state !== 'unknown' && triaged.progress !== undefined),
      };
    }
    const decision = detachment.resume.triage(evidence);
    if (decision === 'settle_from_exit') {
      const exitCode = evidence.exitMarker?.exitCode ?? 1;
      if (exitCode === 0) return settle(null);
      const classification = classifySandboxGitFailure({
        stage,
        result: {
          exitCode,
          output: progressTail,
          stdout: '',
          stderr: '',
          timedOut: false,
        },
      });
      return settle(
        failed(stage, classification.cause, classification.retryable),
      );
    }
    if (decision === 'fail_attempt') {
      // Neither pid liveness nor an exit marker is provable: typed failure,
      // never success, never a from-scratch transfer re-run.
      return settle(failed(stage, 'unknown', false));
    }
    // keep_parked: the job is provably still running. A parking caller takes
    // the seam back; a blocking caller falls through to the poll loop below
    // WITHOUT relaunching.
    if (detachment.park === true) {
      throw new SandboxWorkspaceTransferDetachedSignal(jobPort);
    }
  } else {
    // Launch: a short exec that returns once the pid marker is readable.
    let launch: SandboxCommandExecutionResult;
    try {
      launch = await transferControlExec(
        context,
        launchCommand,
        deadline.signal,
      );
    } catch (error) {
      const interrupted = deadline.interruption(stage);
      if (interrupted !== null) return killAndSettle(interrupted);
      const classification = classifySandboxGitFailure({ stage, error });
      return settle(
        failed(stage, classification.cause, classification.retryable),
      );
    }
    if (launch.timedOut || launch.exitCode !== 0) {
      const interrupted = deadline.interruption(stage);
      if (interrupted !== null) return killAndSettle(interrupted);
      const classification = classifySandboxGitFailure({
        stage,
        result: launch,
      });
      return settle(
        failed(stage, classification.cause, classification.retryable),
      );
    }
    if (detachment?.park === true) {
      // Cooperative parking (D3): the detached job is launched and its marker
      // layout is known. Hand the probe/kill seam back to the caller instead
      // of blocking this slot through the poll loop. The stage stays open —
      // settlement later comes from the markers via the resume triage.
      throw new SandboxWorkspaceTransferDetachedSignal(jobPort);
    }
  }

  const startedAtMs = driver.now();
  let lastAdvanceAtMs = startedAtMs;
  let lastProgressStat: SandboxDetachedJobProgressStat | null = null;
  let lastEmittedProgress: SandboxWorkspaceTransferProgressSnapshot | null =
    null;

  for (;;) {
    const interrupted = deadline.interruption(stage);
    if (interrupted !== null) return killAndSettle(interrupted);
    await sleepWithDriver(driver, pollIntervalMs);
    const afterSleep = deadline.interruption(stage);
    if (afterSleep !== null) return killAndSettle(afterSleep);

    let probe: SandboxCommandExecutionResult | null = null;
    try {
      probe = await transferControlExec(context, probeCommand, deadline.signal);
    } catch {
      // A dropped poll is never settlement evidence; the job settles from its
      // markers on a later poll, or the host-clock gates fire below.
      probe = null;
    }
    const nowMs = driver.now();
    if (probe !== null && !probe.timedOut && probe.exitCode === 0) {
      const { triageText, progressTail } = splitDetachedProbeOutput(
        probe.output,
      );
      const triage = triageSandboxDetachedJobProbeOutput(triageText);
      if (triage.state === 'exited') {
        if (triage.exitCode === 0) return settle(null);
        const classification = classifySandboxGitFailure({
          stage,
          result: {
            exitCode: triage.exitCode,
            output: progressTail,
            stdout: '',
            stderr: '',
            timedOut: false,
          },
        });
        return settle(
          failed(stage, classification.cause, classification.retryable),
        );
      }
      if (triage.state === 'unknown') {
        // Neither pid liveness nor an exit marker is provable: typed failure,
        // never success and never indefinite parking.
        return settle(failed(stage, 'unknown', false));
      }
      const stat = triage.progress;
      if (
        stat !== undefined &&
        (lastProgressStat === null ||
          stat.sizeBytes !== lastProgressStat.sizeBytes ||
          stat.mtimeEpochSeconds !== lastProgressStat.mtimeEpochSeconds)
      ) {
        lastProgressStat = stat;
        lastAdvanceAtMs = nowMs;
      }
      const snapshot = parseGitTransferProgress(progressTail);
      if (
        snapshot !== null &&
        !transferProgressEquals(lastEmittedProgress, snapshot)
      ) {
        lastEmittedProgress = snapshot;
        await reportProgress(context, {
          status: 'progress',
          stage,
          progress: snapshot,
        });
      }
    }

    // Dual gates run on the host clock regardless of poll delivery.
    if (nowMs - startedAtMs >= liveness.absoluteCapMs) {
      return killAndSettle(
        failed(stage, 'timeout', true),
        liveness.absoluteCapMs,
      );
    }
    if (nowMs - lastAdvanceAtMs >= liveness.heartbeatWindowMs) {
      return killAndSettle(
        failed(stage, 'timeout', true),
        liveness.heartbeatWindowMs,
      );
    }
  }
}

async function transferControlExec(
  context: SandboxWorkspaceMaterializationHookContext,
  command: string,
  signal: AbortSignal,
): Promise<SandboxCommandExecutionResult> {
  return context.stageExecutor.execute({
    stage: 'workspace_transfer',
    request: {
      command,
      timeoutMs: SANDBOX_TRANSFER_CONTROL_EXEC_TIMEOUT_MS,
      signal,
    },
    signal,
    remainingTimeoutMs: SANDBOX_TRANSFER_CONTROL_EXEC_TIMEOUT_MS,
  });
}

/**
 * Probe/kill seam handed to a parking caller (detach-workspace-clone D3).
 * Both operations are short marker execs through the SAME stage executor —
 * i.e. the sandbox exec channel for this task — created with fresh abort
 * signals because the materialization's operation deadline is disposed once
 * provisioning unwinds on the detach signal. `probe` throws on transport
 * failure (transient — the parked observer keeps the entry and durable lease
 * expiry remains the recovery horizon) and reports `unknown` only when the
 * exec itself succeeded without proving pid liveness or an exit marker.
 */
function createDetachedTransferJobPort(args: {
  readonly context: SandboxWorkspaceMaterializationHookContext;
  readonly jobId: string;
  readonly probeCommand: string;
  readonly markerRoot: string | undefined;
}): SandboxDetachedWorkspaceTransferJob {
  const { context, jobId, probeCommand, markerRoot } = args;
  return Object.freeze({
    taskId: context.taskId,
    jobId,
    async probe(): Promise<SandboxDetachedWorkspaceTransferObservation> {
      const execution = await transferControlExec(
        context,
        probeCommand,
        new AbortController().signal,
      );
      if (execution.timedOut || execution.exitCode !== 0) {
        throw new Error(
          `Sandbox detached transfer probe for job ${jobId} did not complete`,
        );
      }
      const { triageText, progressTail } = splitDetachedProbeOutput(
        execution.output,
      );
      const triage = triageSandboxDetachedJobProbeOutput(triageText);
      if (triage.state === 'exited') return { kind: 'exited' };
      if (triage.state === 'alive') {
        return {
          kind: 'alive',
          progress: parseGitTransferProgress(progressTail),
        };
      }
      return { kind: 'unknown' };
    },
    kill(): Promise<void> {
      return killDetachedTransferJob(context, jobId, markerRoot);
    },
  });
}

/** Best-effort, idempotent kill via the pid marker; never replaces settlement. */
async function killDetachedTransferJob(
  context: SandboxWorkspaceMaterializationHookContext,
  jobId: string,
  markerRoot: string | undefined,
): Promise<void> {
  try {
    await transferControlExec(
      context,
      buildSandboxDetachedJobKillCommand(jobId, markerRoot),
      new AbortController().signal,
    );
  } catch {
    // The kill contract is idempotent and best-effort from the host side.
  }
}

function sleepWithDriver(
  driver: SandboxGitDeadlineDriver,
  delayMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    driver.schedule(delayMs, resolve);
  });
}

type DeliveryCommandOutcome =
  | {
      readonly ok: true;
      readonly execution: SandboxCommandExecutionResult;
    }
  | { readonly ok: false; readonly result: SandboxGitDeliveryResult };

async function runDeliveryCommand(args: {
  readonly context: SandboxWorkspaceDeliveryHookContext;
  readonly deadline: OperationDeadline;
  readonly stage: Extract<
    SandboxGitCommandStage,
    'delivery_status' | 'delivery_commit' | 'delivery_push'
  >;
  readonly command: string;
}): Promise<DeliveryCommandOutcome> {
  const interruption = args.deadline.interruption('credential_cleanup');
  if (interruption !== null) {
    return {
      ok: false,
      result: deliveryFailure(
        false,
        null,
        interruption.status === 'cancelled'
          ? 'workspace_git_cancelled'
          : 'workspace_git_timeout',
      ),
    };
  }
  try {
    const execution = await executeStage({
      executor: args.context.stageExecutor,
      deadline: args.deadline,
      stage: args.stage,
      command: args.command,
      cwd: args.context.workspaceDir,
    });
    const after = args.deadline.interruption('credential_cleanup');
    if (after !== null) {
      return {
        ok: false,
        result: deliveryFailure(
          false,
          null,
          after.status === 'cancelled'
            ? 'workspace_git_cancelled'
            : 'workspace_git_timeout',
        ),
      };
    }
    if (execution.timedOut || execution.exitCode !== 0) {
      const classified = classifySandboxGitFailure({
        stage: args.stage,
        result: execution,
      });
      return {
        ok: false,
        result: deliveryFailure(
          false,
          null,
          `workspace_git_${classified.cause}`,
        ),
      };
    }
    return { ok: true, execution };
  } catch (error) {
    const after = args.deadline.interruption('credential_cleanup');
    if (after !== null) {
      return {
        ok: false,
        result: deliveryFailure(
          false,
          null,
          after.status === 'cancelled'
            ? 'workspace_git_cancelled'
            : 'workspace_git_timeout',
        ),
      };
    }
    const classified = classifySandboxGitFailure({
      stage: args.stage,
      error,
    });
    return {
      ok: false,
      result: deliveryFailure(
        false,
        null,
        `workspace_git_${classified.cause}`,
      ),
    };
  }
}

async function executeStage(args: {
  readonly executor: SandboxGitStageExecutor;
  readonly deadline: OperationDeadline;
  readonly stage: SandboxGitCommandStage;
  readonly command: string;
  readonly cwd?: string;
}): Promise<SandboxCommandExecutionResult> {
  const remainingTimeoutMs = args.deadline.remainingTimeoutMs();
  if (remainingTimeoutMs <= 0) {
    args.deadline.expire();
    return {
      exitCode: 124,
      output: '',
      stdout: '',
      stderr: '',
      timedOut: true,
    };
  }
  return args.executor.execute({
    stage: args.stage,
    request: {
      command: args.command,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      timeoutMs: remainingTimeoutMs,
      signal: args.deadline.signal,
    },
    signal: args.deadline.signal,
    remainingTimeoutMs,
  });
}

interface OperationDeadline {
  readonly signal: AbortSignal;
  remainingTimeoutMs(): number;
  interruption(stage: ActiveWorkspaceStage): ActiveWorkspaceFailure | null;
  expire(): void;
  /**
   * Suspend the wall clock while a detached transfer runs under dual-gate
   * liveness. Cancellation keeps firing while paused; only the deadline's
   * clock stops advancing.
   */
  pause(): void;
  resume(): void;
  dispose(): void;
}

function createOperationDeadline(args: {
  readonly deadlineMs: number;
  readonly cancellationSignal?: AbortSignal;
  readonly driver: SandboxGitDeadlineDriver;
}): OperationDeadline {
  const startedAt = args.driver.now();
  let deadlineAt = startedAt + args.deadlineMs;
  let pausedAt: number | null = null;
  const controller = new AbortController();
  let source: 'cancellation' | 'deadline' | null = null;

  const interrupt = (next: 'cancellation' | 'deadline') => {
    if (source !== null) return;
    source = next;
    controller.abort(next);
  };
  const onCancellation = () => interrupt('cancellation');
  if (args.cancellationSignal?.aborted) onCancellation();
  else args.cancellationSignal?.addEventListener('abort', onCancellation);
  let cancelDeadline = args.driver.schedule(args.deadlineMs, () =>
    interrupt('deadline'),
  );

  return {
    signal: controller.signal,
    remainingTimeoutMs() {
      const reference = pausedAt ?? args.driver.now();
      return Math.max(0, Math.floor(deadlineAt - reference));
    },
    interruption(stage) {
      if (source === 'cancellation') return { status: 'cancelled', stage };
      if (source === 'deadline') return failed(stage, 'timeout', true);
      if (pausedAt === null && args.driver.now() >= deadlineAt) {
        interrupt('deadline');
        return failed(stage, 'timeout', true);
      }
      return null;
    },
    expire() {
      interrupt('deadline');
    },
    pause() {
      if (pausedAt !== null || source !== null) return;
      pausedAt = args.driver.now();
      cancelDeadline();
    },
    resume() {
      if (pausedAt === null) return;
      const pausedFor = Math.max(0, args.driver.now() - pausedAt);
      pausedAt = null;
      deadlineAt += pausedFor;
      if (source !== null) return;
      cancelDeadline = args.driver.schedule(
        Math.max(0, deadlineAt - args.driver.now()),
        () => interrupt('deadline'),
      );
    },
    dispose() {
      cancelDeadline();
      args.cancellationSignal?.removeEventListener('abort', onCancellation);
    },
  };
}

function failed(
  stage: ActiveWorkspaceStage,
  cause: SandboxWorkspaceFailureCause,
  retryable: boolean,
): ActiveWorkspaceFailure {
  return { status: 'failed', stage, cause, retryable };
}

async function assertWorkspaceBoundary(
  context: SandboxWorkspaceMaterializationHookContext,
  stage: ActiveWorkspaceStage,
  position: 'before' | 'after',
): Promise<void> {
  await context.beforeBoundary?.({ stage, position });
}

async function reportWorkspaceStageStarted(
  context: SandboxWorkspaceMaterializationHookContext,
  stage: ActiveWorkspaceStage,
  operationId?: string,
): Promise<void> {
  await reportProgress(context, { status: 'started', stage });
  emitWorkspaceDiagnostic(context, stage, { outcome: 'started' }, operationId);
}

async function reportWorkspaceStageTerminal(
  context: SandboxWorkspaceMaterializationHookContext,
  event: ActiveWorkspaceTerminalProgress,
  diagnosticOptions?: {
    /**
     * Safe numeric gate fact for detached-transfer liveness timeouts (the
     * fired gate's configured window/cap in ms) replacing the operation
     * deadline in the terminal diagnostic event.
     */
    readonly timeoutMs?: number;
  },
  operationId?: string,
): Promise<void> {
  await reportProgress(context, event);
  if (event.status === 'succeeded') {
    emitWorkspaceDiagnostic(
      context,
      event.stage,
      {
        outcome: 'succeeded',
        cause: null,
        retryable: false,
      },
      operationId,
    );
    return;
  }
  if (event.status === 'cancelled') {
    emitWorkspaceDiagnostic(
      context,
      event.stage,
      {
        outcome: 'cancelled',
        cause: 'cancelled',
        retryable: false,
      },
      operationId,
    );
    return;
  }

  const timedOut = event.cause === 'timeout';
  emitWorkspaceDiagnostic(
    context,
    event.stage,
    {
      outcome: timedOut ? 'timed_out' : 'failed',
      cause: workspaceDiagnosticCause(event.stage, event.cause),
      retryable: event.retryable,
      ...(timedOut
        ? { timeoutMs: diagnosticOptions?.timeoutMs ?? context.plan.deadlineMs }
        : {}),
    },
    operationId,
  );
}

function emitWorkspaceDiagnostic(
  context: SandboxWorkspaceMaterializationHookContext,
  stage: ActiveWorkspaceStage,
  terminal:
    | { readonly outcome: 'started' }
    | {
        readonly outcome: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
        readonly cause: SandboxProvisioningDiagnosticCause | null;
        readonly retryable: boolean;
        readonly timeoutMs?: number;
      },
  operationIdOverride?: string,
): void {
  const observer = context.diagnostics;
  if (observer === undefined) return;
  try {
    const descriptor = WORKSPACE_DIAGNOSTIC_DESCRIPTORS[stage];
    // Retry attempts carry their own operation identity so each attempt keeps
    // the one-start/one-terminal invariant instead of colliding on the
    // replay-key-cached operation of attempt 1.
    const operationId =
      operationIdOverride ?? observer.createOperationId(descriptor.replayKey);
    void Promise.resolve(
      observer.emit({
        operationId,
        stage,
        operation: descriptor.operation,
        channel: descriptor.channel,
        commandKind: descriptor.commandKind,
        ...terminal,
      }),
    ).catch(() => undefined);
  } catch {
    // Synchronous observer faults are evidence failures, never admission truth.
  }
}

function workspaceDiagnosticCause(
  stage: ActiveWorkspaceStage,
  cause: SandboxWorkspaceFailureCause,
): SandboxProvisioningDiagnosticCause {
  switch (cause) {
    case 'capacity_exhausted':
      return 'capacity_exhausted';
    case 'timeout':
      return 'workspace_timeout';
    case 'authentication':
      return 'authentication_failed';
    case 'tls_network':
      return 'tls_network_failed';
    case 'ref_not_found':
      return 'ref_not_found';
    case 'unknown':
      return stage === 'credential_cleanup' ? 'cleanup_failed' : 'unknown';
  }
}

function deliveryInterruption(
  hadChanges: boolean,
  commitSha: string | null,
  interruption: ActiveWorkspaceFailure,
): SandboxGitDeliveryResult {
  return deliveryFailure(
    hadChanges,
    commitSha,
    interruption.status === 'cancelled'
      ? 'workspace_git_cancelled'
      : 'workspace_git_timeout',
  );
}

async function reportProgress(
  context: Pick<
    SandboxWorkspaceMaterializationHookContext,
    'onProgress'
  >,
  event: SandboxWorkspaceProgressEvent,
): Promise<void> {
  try {
    await context.onProgress?.(event);
  } catch {
    // Durable work state remains authoritative; progress reporting is best-effort.
  }
}

function deliveryStatusCommand(): string {
  return (
    `marker=$(git rev-parse --git-path ${shellQuote(
      DELIVERY_PENDING_MARKER,
    )}) && ` +
    `if test -f "$marker"; then printf '%s\\n' ${shellQuote(
      DELIVERY_PENDING_SENTINEL,
    )}; fi && git status --porcelain`
  );
}

function deliveryCommitCommand(commitMessage: string): string {
  const message = Buffer.from(commitMessage, 'utf8').toString('base64');
  return (
    `marker=$(git rev-parse --git-path ${shellQuote(
      DELIVERY_PENDING_MARKER,
    )}) && ` +
    'if test ! -f "$marker"; then git rev-parse HEAD > "$marker"; fi && ' +
    'git add -A && ' +
    `printf %s ${shellQuote(message)} | base64 -d > ${shellQuote(
      DELIVERY_COMMIT_MESSAGE_PATH,
    )} && ` +
    `git -c ${shellQuote('user.name=cap-bot')} -c ${shellQuote(
      'user.email=cap-bot@users.noreply.github.com',
    )} commit -F ${shellQuote(DELIVERY_COMMIT_MESSAGE_PATH)}`
  );
}

function deliveryFinalizeCommand(): string {
  return (
    `marker=$(git rev-parse --git-path ${shellQuote(
      DELIVERY_PENDING_MARKER,
    )}) && ` +
    `rm -f -- "$marker" ${shellQuote(DELIVERY_COMMIT_MESSAGE_PATH)}`
  );
}

function gitCommand(configPath: string | undefined, command: string): string {
  const config =
    configPath === undefined
      ? ''
      : ` -c ${shellQuote(`include.path=${configPath}`)}`;
  return `git${config} ${command}`;
}

function deliveryFailure(
  hadChanges: boolean,
  commitSha: string | null,
  error: string,
): SandboxGitDeliveryResult {
  return { hadChanges, commitSha, error };
}

function withDeliveryChanges(
  result: SandboxGitDeliveryResult,
  commitSha: string | null = result.commitSha,
): SandboxGitDeliveryResult {
  return { ...result, hadChanges: true, commitSha };
}

function firstToken(value: string): string | null {
  return value.trim().split(/\s+/u)[0] || null;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
}

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/u, '');
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '/' : normalized.slice(0, idx);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * @deprecated Public-repository compatibility only. Credentialed callers must
 * use materializeSandboxGitWorkspaceStaged.
 */
export function buildGitCloneCommand(
  spec: GitCloneSpec,
  workspaceDir: string,
): string {
  if (spec.authHeader !== undefined) {
    throw new SandboxProviderConfigurationError(
      'Legacy raw-header Git clone is disabled',
    );
  }
  return `git clone -- ${shellQuote(spec.url)} ${shellQuote(workspaceDir)}`;
}

/** @deprecated Raw-header delivery is deliberately disabled. */
export function buildGitDeliveryCommands(): never {
  throw new SandboxProviderConfigurationError(
    'Legacy raw-header Git delivery is disabled',
  );
}

export function scrubSandboxExecSecrets(output: string): string {
  return scrubSandboxCommandOutput(output);
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly output: string;
}

export function parseSandboxExecResult(raw: unknown): SandboxExecResult {
  const parsed = normalizeSandboxCommandResult(raw);
  return { exitCode: parsed.exitCode, output: parsed.output };
}
