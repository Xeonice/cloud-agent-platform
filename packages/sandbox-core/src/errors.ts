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
