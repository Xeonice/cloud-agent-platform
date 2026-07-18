export class SandboxCoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SandboxProviderConfigurationError extends SandboxCoreError {
  constructor(message: string) {
    super(message, 'sandbox_provider_configuration_error');
  }
}

export class SandboxProviderCapabilityError extends SandboxCoreError {
  constructor(
    message: string,
    readonly missingCapabilities: readonly string[],
  ) {
    super(message, 'sandbox_provider_capability_error');
  }
}

export class SandboxProviderSelectionError extends SandboxCoreError {
  constructor(message: string) {
    super(message, 'sandbox_provider_selection_error');
  }
}

/**
 * Cleanup observed no resource while a create may still be in flight.  The
 * deleting owner tombstone must remain durable and recovery must retry later.
 */
export class SandboxCleanupPendingError extends SandboxCoreError {
  constructor() {
    super(
      'Sandbox cleanup is pending settlement of an in-flight create',
      'sandbox_cleanup_pending',
    );
  }
}

/**
 * Durable cleanup could not be authorized or acknowledged under its exact
 * owner fence. The fixed error is safe to propagate so orchestration retains
 * its lease/slot. When cleanup followed a primary provider failure, that exact
 * primary value is retained in a non-enumerable slot rather than replaced.
 */
export class SandboxCleanupCoordinationPendingError extends SandboxCoreError {
  declare readonly primary: unknown | undefined;

  constructor(primary?: unknown) {
    super(
      'Sandbox cleanup coordination is pending recovery',
      'sandbox_cleanup_coordination_pending',
    );
    Object.defineProperty(this, 'primary', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: primary,
    });
  }
}

export function isSandboxCleanupCoordinationPendingError(
  error: unknown,
): error is SandboxCleanupCoordinationPendingError {
  return (
    error instanceof SandboxCleanupCoordinationPendingError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code ===
        'sandbox_cleanup_coordination_pending')
  );
}

/**
 * Stable, secret-free failure emitted when a provider-created sandbox does not
 * actually satisfy the immutable capacity policy resolved before create.
 *
 * The fixed message deliberately excludes provider output and request details
 * so orchestration can safely classify and persist the failure.
 */
export class SandboxProvisioningCapacityError extends SandboxCoreError {
  constructor() {
    super(
      'Sandbox provisioned capacity is below the resolved resource policy',
      'sandbox_provisioning_capacity_error',
    );
  }
}

/** Structural guard also works across package and bundle boundaries. */
export function isSandboxProvisioningCapacityError(
  error: unknown,
): error is SandboxProvisioningCapacityError {
  return (
    error instanceof SandboxProvisioningCapacityError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code ===
        'sandbox_provisioning_capacity_error')
  );
}

export type SandboxProvisioningFailureStage = 'runtime_setup' | 'readiness';

/**
 * Stable, provider-neutral stage failure for composite provider operations.
 * Providers deliberately discard the underlying diagnostic before crossing
 * this boundary; orchestration persists only the allowlisted stage and its
 * generic provisioning cause.
 */
export class SandboxProvisioningStageError extends SandboxCoreError {
  constructor(readonly stage: SandboxProvisioningFailureStage) {
    super(
      `Sandbox provisioning failed during ${stage}`,
      'sandbox_provisioning_stage_error',
    );
  }
}

/** Structural guard also works across package and bundle boundaries. */
export function isSandboxProvisioningStageError(
  error: unknown,
): error is SandboxProvisioningStageError {
  if (
    typeof error !== 'object' ||
    error === null ||
    (error as { code?: unknown }).code !==
      'sandbox_provisioning_stage_error'
  ) {
    return false;
  }
  const stage = (error as { stage?: unknown }).stage;
  return stage === 'runtime_setup' || stage === 'readiness';
}

/**
 * Remove provider-private diagnostics at the composite provisioning boundary
 * while preserving stable errors that orchestration already classifies more
 * precisely.
 */
export function redactSandboxProvisioningStageFailure(
  stage: SandboxProvisioningFailureStage,
  error: unknown,
): SandboxCoreError {
  if (isSandboxProvisioningStageError(error)) {
    return new SandboxProvisioningStageError(error.stage);
  }
  if (isSandboxProvisioningCapacityError(error)) {
    return new SandboxProvisioningCapacityError();
  }
  if (
    isSandboxRuntimeModelSetupError(error) &&
    isRuntimeModelSetupFailurePhase(error.phase)
  ) {
    return new SandboxRuntimeModelSetupError(error.phase);
  }
  return new SandboxProvisioningStageError(stage);
}

export type SandboxSecretFileOperation = 'write' | 'delete';

/**
 * Stable secret-free error emitted by the redacted provider secret-file port.
 * The underlying transport error is intentionally not attached because it may
 * include a serialized provider-private request.
 */
export class SandboxSecretFileOperationError extends SandboxCoreError {
  constructor(readonly operation: SandboxSecretFileOperation) {
    super(
      `Sandbox secret file ${operation} failed`,
      'sandbox_secret_file_operation_error',
    );
  }
}

export type SandboxWorkspaceOperationFailure =
  | {
      readonly status: 'failed';
      readonly stage:
        | 'credential_setup'
        | 'remote_ref_resolution'
        | 'workspace_transfer'
        | 'checkout'
        | 'submodules'
        | 'credential_cleanup';
      readonly cause:
        | 'capacity_exhausted'
        | 'timeout'
        | 'authentication'
        | 'tls_network'
        | 'ref_not_found'
        | 'unknown';
      readonly retryable: boolean;
    }
  | {
      readonly status: 'cancelled';
      readonly stage:
        | 'credential_setup'
        | 'remote_ref_resolution'
        | 'workspace_transfer'
        | 'checkout'
        | 'submodules'
        | 'credential_cleanup';
    };

/** Safe typed bridge from staged workspace helpers into provider admission. */
export class SandboxWorkspaceMaterializationError extends SandboxCoreError {
  constructor(readonly failure: SandboxWorkspaceOperationFailure) {
    super(
      failure.status === 'cancelled'
        ? `Sandbox workspace materialization cancelled during ${failure.stage}`
        : `Sandbox workspace materialization failed during ${failure.stage}: ${failure.cause}`,
      'sandbox_workspace_materialization_error',
    );
  }
}

export function isSandboxWorkspaceMaterializationError(
  error: unknown,
): error is SandboxWorkspaceMaterializationError {
  return (
    error instanceof SandboxWorkspaceMaterializationError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code ===
        'sandbox_workspace_materialization_error')
  );
}

export type RuntimeModelSetupFailurePhase =
  | 'lookup'
  | 'snapshot'
  | 'provider-selection'
  | 'runtime-resolution'
  | 'launch-context'
  | 'material-write'
  | 'material-verify';

function isRuntimeModelSetupFailurePhase(
  value: unknown,
): value is RuntimeModelSetupFailurePhase {
  return (
    value === 'lookup' ||
    value === 'snapshot' ||
    value === 'provider-selection' ||
    value === 'runtime-resolution' ||
    value === 'launch-context' ||
    value === 'material-write' ||
    value === 'material-verify'
  );
}

/**
 * Stable, provider-neutral failure raised before a fresh runtime launch when an
 * explicit persisted model cannot be propagated or materialized safely.
 *
 * The message deliberately contains only an allowlisted phase. Callers must not
 * append selector text, provider output, commands, or credential diagnostics.
 */
export class SandboxRuntimeModelSetupError extends SandboxCoreError {
  constructor(readonly phase: RuntimeModelSetupFailurePhase) {
    super(
      `Runtime model setup failed during ${phase}`,
      'runtime_model_setup_failed',
    );
  }
}

/** Structural guard also works when an error crosses a package/bundle boundary. */
export function isSandboxRuntimeModelSetupError(
  error: unknown,
): error is SandboxRuntimeModelSetupError {
  return (
    error instanceof SandboxRuntimeModelSetupError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'runtime_model_setup_failed')
  );
}
