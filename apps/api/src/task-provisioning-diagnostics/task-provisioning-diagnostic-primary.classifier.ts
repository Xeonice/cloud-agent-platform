import type { TaskProvisioningStage } from '@cap/contracts';
import {
  SandboxProviderCapabilityError,
  SandboxProviderConfigurationError,
  SandboxProviderSelectionError,
  isSandboxProvisioningCapacityError,
  isSandboxProvisioningStageError,
  isSandboxRuntimeModelSetupError,
  isSandboxWorkspaceMaterializationError,
  SANDBOX_PROVISIONING_DIAGNOSTIC_WORKSPACE_SOURCE_KINDS,
  type SandboxProvisioningDiagnosticCause,
  type SandboxProvisioningDiagnosticCommandKind,
  type SandboxProvisioningDiagnosticOperation,
  type SandboxProvisioningDiagnosticStage,
  type SandboxProvisioningDiagnosticWorkspaceSourceKind,
} from '@cap/sandbox';

import {
  isTaskBranchResolutionError,
  type TaskBranchResolutionError,
} from '../forge/task-branch-resolver';
import { TaskAdmissionProcessingError } from '../task-admission/task-admission.types';
import {
  isWorkspaceSourceResolutionError,
  type WorkspaceSourceResolutionError,
} from '../sandbox/workspace-source-resolver';
import type { ProvisioningTaskFailureCode } from '../tasks/task-failure';

type ClassifiedPrimaryOutcome = 'failed' | 'timed_out' | 'cancelled';

/**
 * Safe terminal evidence produced before Guardrails records the primary event
 * and attempt summary. Observation time and completion remain caller-owned so
 * this pure classifier cannot create a second lifecycle authority.
 */
export interface ClassifiedTaskProvisioningDiagnosticPrimaryFailure {
  readonly state: 'failed' | 'cancelled';
  readonly stage: SandboxProvisioningDiagnosticStage;
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
  /**
   * Workspace-source variant in force when the failure happened, carried only
   * for workspace-materialization stages (add-repo-content-store). Absent for
   * every other stage: those operations materialize no workspace and must not
   * claim a variant.
   */
  readonly workspaceSourceKind?: SandboxProvisioningDiagnosticWorkspaceSourceKind;
  readonly outcome: ClassifiedPrimaryOutcome;
  readonly cause: SandboxProvisioningDiagnosticCause;
  readonly retryable: boolean;
  readonly exitCode: null;
}

/** Ambient facts the caller already knows; never derived from raw error text. */
export interface TaskProvisioningDiagnosticPrimaryClassificationContext {
  readonly workspaceSourceKind?: SandboxProvisioningDiagnosticWorkspaceSourceKind;
}

const WORKSPACE_MATERIALIZATION_STAGES: ReadonlySet<string> = new Set([
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
]);

interface StageDescriptor {
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
}

const DIAGNOSTIC_STAGE_DESCRIPTORS: Readonly<
  Record<SandboxProvisioningDiagnosticStage, StageDescriptor>
> = Object.freeze({
  accepted: Object.freeze({ operation: 'provider_select' }),
  sandbox_creation: Object.freeze({ operation: 'sandbox_create' }),
  credential_setup: Object.freeze({
    operation: 'credential_setup',
    commandKind: 'credential_setup',
  }),
  remote_ref_resolution: Object.freeze({
    operation: 'remote_ref_resolve',
    commandKind: 'git_remote_ref',
  }),
  workspace_transfer: Object.freeze({
    operation: 'repository_transfer',
    commandKind: 'git_clone',
  }),
  checkout: Object.freeze({
    operation: 'checkout',
    commandKind: 'git_checkout',
  }),
  submodules: Object.freeze({
    operation: 'submodules',
    commandKind: 'git_submodules',
  }),
  credential_cleanup: Object.freeze({
    operation: 'credential_cleanup',
    commandKind: 'credential_cleanup',
  }),
  runtime_setup: Object.freeze({
    operation: 'runtime_setup',
    commandKind: 'runtime_setup',
  }),
  readiness: Object.freeze({
    operation: 'runtime_preflight',
    commandKind: 'runtime_preflight',
  }),
  agent_launch: Object.freeze({
    operation: 'agent_launch',
    commandKind: 'agent_launch',
  }),
  complete: Object.freeze({
    operation: 'agent_launch',
    commandKind: 'agent_launch',
  }),
  provider_selection: Object.freeze({ operation: 'provider_select' }),
  sandbox_start: Object.freeze({ operation: 'sandbox_start' }),
  sandbox_inspect: Object.freeze({ operation: 'sandbox_inspect' }),
  native_execution: Object.freeze({ operation: 'native_exec_settlement' }),
  settlement: Object.freeze({ operation: 'native_exec_settlement' }),
  cleanup: Object.freeze({
    operation: 'sandbox_delete',
    commandKind: 'sandbox_cleanup',
  }),
});

const PROVIDER_SELECTION_DESCRIPTOR =
  DIAGNOSTIC_STAGE_DESCRIPTORS.provider_selection;

/**
 * Reduce only typed or fixed-code structural failures to the closed diagnostic
 * vocabulary. No raw error field is copied, formatted, or serialized.
 */
export function classifyTaskProvisioningDiagnosticPrimaryFailure(
  error: unknown,
  fallbackStage: SandboxProvisioningDiagnosticStage,
  classificationContext: TaskProvisioningDiagnosticPrimaryClassificationContext = {},
): ClassifiedTaskProvisioningDiagnosticPrimaryFailure {
  const classified = (() => {
    try {
      return classifyKnownTaskProvisioningDiagnosticPrimaryFailure(
        error,
        fallbackStage,
      );
    } catch {
      // A malformed cross-bundle value (including an accessor that throws) is
      // still only unknown evidence; classification must never become authority.
      return unknownPrimaryFailure(fallbackStage);
    }
  })();
  return withWorkspaceSourceKind(
    classified,
    classificationContext.workspaceSourceKind,
  );
}

/**
 * Name the workspace-source variant on workspace-materialization evidence only.
 * The three variants share one closed stage vocabulary, so without this the
 * synthesized primary cannot say whether a `workspace_transfer` failure was a
 * mount preparation, an archive transfer, or a network clone.
 */
function withWorkspaceSourceKind(
  classified: ClassifiedTaskProvisioningDiagnosticPrimaryFailure,
  workspaceSourceKind:
    | SandboxProvisioningDiagnosticWorkspaceSourceKind
    | undefined,
): ClassifiedTaskProvisioningDiagnosticPrimaryFailure {
  if (
    workspaceSourceKind === undefined ||
    !SANDBOX_PROVISIONING_DIAGNOSTIC_WORKSPACE_SOURCE_KINDS.includes(
      workspaceSourceKind,
    ) ||
    !WORKSPACE_MATERIALIZATION_STAGES.has(classified.stage)
  ) {
    return classified;
  }
  return Object.freeze({ ...classified, workspaceSourceKind });
}

function classifyKnownTaskProvisioningDiagnosticPrimaryFailure(
  error: unknown,
  fallbackStage: SandboxProvisioningDiagnosticStage,
): ClassifiedTaskProvisioningDiagnosticPrimaryFailure {
  if (error instanceof TaskAdmissionProcessingError) {
    const descriptor = taskStageDescriptor(error.stage);
    const terminal = taskFailureTerminal(error.causeCode);
    if (descriptor !== undefined && terminal !== undefined) {
      return primaryFailure(
        error.stage,
        descriptor,
        terminal.outcome,
        terminal.cause,
        error.retryable,
      );
    }
  }

  if (isTaskBranchResolutionError(error)) {
    return classifyBranchResolutionFailure(error);
  }

  if (isSandboxProvisioningCapacityError(error)) {
    return primaryFailure(
      'sandbox_creation',
      DIAGNOSTIC_STAGE_DESCRIPTORS.sandbox_creation,
      'failed',
      'capacity_exhausted',
      false,
    );
  }

  if (isSandboxWorkspaceMaterializationError(error)) {
    const classified = classifyWorkspaceMaterializationFailure(error.failure);
    if (classified !== undefined) return classified;
  }

  if (isWorkspaceSourceResolutionError(error)) {
    return classifyWorkspaceSourceResolutionFailure(error);
  }

  if (isProviderAvailabilityError(error)) {
    return primaryFailure(
      'provider_selection',
      PROVIDER_SELECTION_DESCRIPTOR,
      'failed',
      'provider_unavailable',
      false,
    );
  }

  if (isSandboxProvisioningStageError(error)) {
    if (error.stage === 'runtime_setup') {
      return primaryFailure(
        'runtime_setup',
        DIAGNOSTIC_STAGE_DESCRIPTORS.runtime_setup,
        'failed',
        'command_failed',
        false,
      );
    }
    return primaryFailure(
      'readiness',
      DIAGNOSTIC_STAGE_DESCRIPTORS.readiness,
      'failed',
      'unknown',
      false,
    );
  }

  if (isSandboxRuntimeModelSetupError(error)) {
    if (error.phase === 'provider-selection') {
      return primaryFailure(
        'provider_selection',
        PROVIDER_SELECTION_DESCRIPTOR,
        'failed',
        'provider_unavailable',
        false,
      );
    }
    if (isRuntimeModelSetupPhase(error.phase)) {
      return primaryFailure(
        'runtime_setup',
        DIAGNOSTIC_STAGE_DESCRIPTORS.runtime_setup,
        'failed',
        'command_failed',
        false,
      );
    }
  }

  return unknownPrimaryFailure(fallbackStage);
}

/**
 * Workspace-source selection failures (add-repo-content-store Track 4.5).
 *
 * These happen BEFORE any provider boundary, so they must still land on a
 * distinguishable durable stage/cause. The mapping keeps the closed diagnostic
 * vocabulary and separates the three selection failures from an in-sandbox
 * materialization failure:
 *
 *   copy_not_ready          -> workspace_transfer + ref_not_found
 *                              (the recorded content copy is absent/not ready;
 *                               the operator action is "refresh the repo")
 *   unsupported_provider    -> provider_selection + provider_unavailable
 *                              (no declared injection variant, fallback gate off)
 *   store_volume_unresolved -> workspace_transfer + protocol_failed
 *                              (deployment wiring: the repo-store volume name)
 *   repo_unavailable        -> remote_ref_resolution + unknown
 */
function classifyWorkspaceSourceResolutionFailure(
  error: WorkspaceSourceResolutionError,
): ClassifiedTaskProvisioningDiagnosticPrimaryFailure {
  switch (error.reason) {
    case 'copy_not_ready':
      return primaryFailure(
        'workspace_transfer',
        DIAGNOSTIC_STAGE_DESCRIPTORS.workspace_transfer,
        'failed',
        'ref_not_found',
        false,
      );
    case 'unsupported_provider':
      return primaryFailure(
        'provider_selection',
        PROVIDER_SELECTION_DESCRIPTOR,
        'failed',
        'provider_unavailable',
        false,
      );
    case 'store_volume_unresolved':
      return primaryFailure(
        'workspace_transfer',
        DIAGNOSTIC_STAGE_DESCRIPTORS.workspace_transfer,
        'failed',
        'protocol_failed',
        false,
      );
    default:
      return primaryFailure(
        'remote_ref_resolution',
        DIAGNOSTIC_STAGE_DESCRIPTORS.remote_ref_resolution,
        'failed',
        'unknown',
        false,
      );
  }
}

function classifyBranchResolutionFailure(
  error: TaskBranchResolutionError,
): ClassifiedTaskProvisioningDiagnosticPrimaryFailure {
  const cause =
    error.reason === 'access_denied'
      ? 'access_denied'
      : taskFailureTerminal(error.failureCode)?.cause ?? 'unknown';
  return primaryFailure(
    'remote_ref_resolution',
    DIAGNOSTIC_STAGE_DESCRIPTORS.remote_ref_resolution,
    'failed',
    cause,
    error.failureCode === 'provisioning_tls_network_failed',
  );
}

function classifyWorkspaceMaterializationFailure(
  value: unknown,
): ClassifiedTaskProvisioningDiagnosticPrimaryFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const failure = value as {
    readonly status?: unknown;
    readonly stage?: unknown;
    readonly cause?: unknown;
    readonly retryable?: unknown;
  };
  const descriptor = workspaceStageDescriptor(failure.stage);
  if (descriptor === undefined) return undefined;

  if (failure.status === 'cancelled') {
    return Object.freeze({
      state: 'cancelled',
      stage: descriptor.stage,
      operation: descriptor.operation,
      ...(descriptor.commandKind === undefined
        ? {}
        : { commandKind: descriptor.commandKind }),
      outcome: 'cancelled',
      cause: 'cancelled',
      retryable: false,
      exitCode: null,
    });
  }
  if (failure.status !== 'failed') return undefined;

  switch (failure.cause) {
    case 'capacity_exhausted':
      return primaryFailure(
        descriptor.stage,
        descriptor,
        'failed',
        'capacity_exhausted',
        false,
      );
    case 'timeout':
      return primaryFailure(
        descriptor.stage,
        descriptor,
        'timed_out',
        'workspace_timeout',
        false,
      );
    case 'authentication':
      return primaryFailure(
        descriptor.stage,
        descriptor,
        'failed',
        'authentication_failed',
        false,
      );
    case 'tls_network':
      return primaryFailure(
        descriptor.stage,
        descriptor,
        'failed',
        'tls_network_failed',
        failure.retryable === true,
      );
    case 'ref_not_found':
      return primaryFailure(
        descriptor.stage,
        descriptor,
        'failed',
        'ref_not_found',
        false,
      );
    case 'unknown':
      return primaryFailure(
        descriptor.stage,
        descriptor,
        'failed',
        'unknown',
        false,
      );
    default:
      return undefined;
  }
}

function taskFailureTerminal(
  causeCode: ProvisioningTaskFailureCode,
):
  | {
      readonly outcome: ClassifiedPrimaryOutcome;
      readonly cause: SandboxProvisioningDiagnosticCause;
    }
  | undefined {
  switch (causeCode) {
    case 'provisioning_capacity_exhausted':
      return { outcome: 'failed', cause: 'capacity_exhausted' };
    case 'provisioning_workspace_timeout':
      return { outcome: 'timed_out', cause: 'workspace_timeout' };
    case 'provisioning_forge_auth_failed':
      return { outcome: 'failed', cause: 'authentication_failed' };
    case 'provisioning_tls_network_failed':
      return { outcome: 'failed', cause: 'tls_network_failed' };
    case 'provisioning_ref_not_found':
      return { outcome: 'failed', cause: 'ref_not_found' };
    case 'provisioning_platform_dependency_unavailable':
      return { outcome: 'failed', cause: 'provider_unavailable' };
    case 'provisioning_unknown':
      return { outcome: 'failed', cause: 'unknown' };
  }
}

/**
 * Project a durable admission failure code into the same closed diagnostic
 * cause vocabulary used by terminal evidence. Legacy retry rows may not carry
 * a cause, so absence degrades to the bounded `unknown` bucket.
 */
export function taskProvisioningDiagnosticCauseFromFailureCode(
  causeCode: ProvisioningTaskFailureCode | null | undefined,
): SandboxProvisioningDiagnosticCause {
  return causeCode === null || causeCode === undefined
    ? 'unknown'
    : (taskFailureTerminal(causeCode)?.cause ?? 'unknown');
}

function taskStageDescriptor(value: unknown): StageDescriptor | undefined {
  switch (value) {
    case 'accepted':
    case 'sandbox_creation':
    case 'credential_setup':
    case 'remote_ref_resolution':
    case 'workspace_transfer':
    case 'checkout':
    case 'submodules':
    case 'credential_cleanup':
    case 'runtime_setup':
    case 'readiness':
    case 'agent_launch':
    case 'complete':
      return DIAGNOSTIC_STAGE_DESCRIPTORS[value];
    default:
      return undefined;
  }
}

function workspaceStageDescriptor(
  value: unknown,
): (StageDescriptor & { readonly stage: TaskProvisioningStage }) | undefined {
  switch (value) {
    case 'credential_setup':
    case 'remote_ref_resolution':
    case 'workspace_transfer':
    case 'checkout':
    case 'submodules':
    case 'credential_cleanup':
      return { stage: value, ...DIAGNOSTIC_STAGE_DESCRIPTORS[value] };
    default:
      return undefined;
  }
}

function isProviderAvailabilityError(error: unknown): boolean {
  if (
    error instanceof SandboxProviderConfigurationError ||
    error instanceof SandboxProviderCapabilityError ||
    error instanceof SandboxProviderSelectionError
  ) {
    return true;
  }
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return (
    code === 'sandbox_provider_configuration_error' ||
    code === 'sandbox_provider_capability_error' ||
    code === 'sandbox_provider_selection_error'
  );
}

function isRuntimeModelSetupPhase(value: unknown): boolean {
  switch (value) {
    case 'lookup':
    case 'snapshot':
    case 'runtime-resolution':
    case 'launch-context':
    case 'material-write':
    case 'material-verify':
      return true;
    default:
      return false;
  }
}

function primaryFailure(
  stage: SandboxProvisioningDiagnosticStage,
  descriptor: StageDescriptor,
  outcome: ClassifiedPrimaryOutcome,
  cause: SandboxProvisioningDiagnosticCause,
  retryable: boolean,
): ClassifiedTaskProvisioningDiagnosticPrimaryFailure {
  return Object.freeze({
    state: 'failed',
    stage,
    operation: descriptor.operation,
    ...(descriptor.commandKind === undefined
      ? {}
      : { commandKind: descriptor.commandKind }),
    outcome,
    cause,
    retryable,
    exitCode: null,
  });
}

function unknownPrimaryFailure(
  fallbackStage: SandboxProvisioningDiagnosticStage,
): ClassifiedTaskProvisioningDiagnosticPrimaryFailure {
  return primaryFailure(
    fallbackStage,
    DIAGNOSTIC_STAGE_DESCRIPTORS[fallbackStage],
    'failed',
    'unknown',
    false,
  );
}
