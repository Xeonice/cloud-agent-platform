import {
  normalizeSandboxCommandResult,
  SandboxProviderConfigurationError,
  scrubSandboxCommandOutput,
  type GitCloneSpec,
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
    text.includes('network is unreachable') ||
    text.includes('ssl certificate') ||
    text.includes('certificate verify') ||
    text.includes('tls')
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
      const stages = materializationCommands(
        context.plan.repositoryUrl,
        context.plan.resolvedBranch,
        context.workspaceDir,
        configPath,
      );
      for (const stage of stages) {
        const stageResult = await runMaterializationStage({
          context,
          deadline,
          stage: stage.stage,
          command: stage.command,
        });
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

async function runMaterializationStage(args: {
  readonly context: SandboxWorkspaceMaterializationHookContext;
  readonly deadline: OperationDeadline;
  readonly stage: MaterializationCommand['stage'];
  readonly command: string;
}): Promise<ActiveWorkspaceFailure | null> {
  const interruption = args.deadline.interruption(args.stage);
  if (interruption !== null) {
    await reportWorkspaceStageTerminal(args.context, interruption);
    return interruption;
  }
  await assertWorkspaceBoundary(args.context, args.stage, 'before');
  await reportWorkspaceStageStarted(args.context, args.stage);
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
      await reportWorkspaceStageTerminal(args.context, after);
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
        classification.retryable,
      );
      await reportWorkspaceStageTerminal(args.context, outcome);
      return outcome;
    }
    await reportWorkspaceStageTerminal(args.context, {
      status: 'succeeded',
      stage: args.stage,
    });
    return null;
  } catch (error) {
    const after = args.deadline.interruption(args.stage);
    if (after !== null) {
      await reportWorkspaceStageTerminal(args.context, after);
      return after;
    }
    const classification = classifySandboxGitFailure({
      stage: args.stage,
      error,
    });
    const outcome = failed(
      args.stage,
      classification.cause,
      classification.retryable,
    );
    await reportWorkspaceStageTerminal(args.context, outcome);
    return outcome;
  }
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
  dispose(): void;
}

function createOperationDeadline(args: {
  readonly deadlineMs: number;
  readonly cancellationSignal?: AbortSignal;
  readonly driver: SandboxGitDeadlineDriver;
}): OperationDeadline {
  const startedAt = args.driver.now();
  const deadlineAt = startedAt + args.deadlineMs;
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
  const cancelDeadline = args.driver.schedule(args.deadlineMs, () =>
    interrupt('deadline'),
  );

  return {
    signal: controller.signal,
    remainingTimeoutMs() {
      return Math.max(0, Math.floor(deadlineAt - args.driver.now()));
    },
    interruption(stage) {
      if (source === 'cancellation') return { status: 'cancelled', stage };
      if (source === 'deadline') return failed(stage, 'timeout', true);
      if (args.driver.now() >= deadlineAt) {
        interrupt('deadline');
        return failed(stage, 'timeout', true);
      }
      return null;
    },
    expire() {
      interrupt('deadline');
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
): Promise<void> {
  await reportProgress(context, { status: 'started', stage });
  emitWorkspaceDiagnostic(context, stage, { outcome: 'started' });
}

async function reportWorkspaceStageTerminal(
  context: SandboxWorkspaceMaterializationHookContext,
  event: ActiveWorkspaceTerminalProgress,
): Promise<void> {
  await reportProgress(context, event);
  if (event.status === 'succeeded') {
    emitWorkspaceDiagnostic(context, event.stage, {
      outcome: 'succeeded',
      cause: null,
      retryable: false,
    });
    return;
  }
  if (event.status === 'cancelled') {
    emitWorkspaceDiagnostic(context, event.stage, {
      outcome: 'cancelled',
      cause: 'cancelled',
      retryable: false,
    });
    return;
  }

  const timedOut = event.cause === 'timeout';
  emitWorkspaceDiagnostic(context, event.stage, {
    outcome: timedOut ? 'timed_out' : 'failed',
    cause: workspaceDiagnosticCause(event.stage, event.cause),
    retryable: event.retryable,
    ...(timedOut ? { timeoutMs: context.plan.deadlineMs } : {}),
  });
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
): void {
  const observer = context.diagnostics;
  if (observer === undefined) return;
  try {
    const descriptor = WORKSPACE_DIAGNOSTIC_DESCRIPTORS[stage];
    const operationId = observer.createOperationId(descriptor.replayKey);
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
