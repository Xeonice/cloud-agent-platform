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

export type RuntimeModelSetupFailurePhase =
  | 'lookup'
  | 'snapshot'
  | 'provider-selection'
  | 'runtime-resolution'
  | 'launch-context'
  | 'material-write'
  | 'material-verify';

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
