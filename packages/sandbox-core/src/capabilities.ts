/**
 * Scheduler-facing sandbox capabilities.
 *
 * These are concrete operation surfaces rather than branding or implementation
 * names. A local Docker/AIO provider and a cloud provider can both satisfy the
 * same capability set, which keeps callers bound to behavior instead of backend
 * identity.
 */
export type SandboxProviderCapability =
  | 'terminal.websocket'
  | 'terminal.interactive'
  | 'command.exec'
  | 'workspace.git.materialize'
  | 'workspace.git.deliver'
  | 'workspace.archive.transfer'
  | 'transcript.retained-read'
  | 'transcript.retained-source'
  | 'lifecycle.readopt'
  | 'lifecycle.readoption'
  | 'lifecycle.sleep'
  | 'lifecycle.snapshot'
  | 'port.expose';

/**
 * Existing operation-level capabilities used by the current AIO/cloud HTTP
 * selection paths. Keep this list stable so default provider configuration does
 * not over-advertise newly introduced feature capabilities.
 */
export const SANDBOX_PROVIDER_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
  'workspace.git.materialize',
  'workspace.git.deliver',
  'transcript.retained-read',
  'lifecycle.readopt',
] as const;

/**
 * Provider feature capabilities used by selected-run planning and future
 * adapters. These are intentionally separate from
 * `SANDBOX_PROVIDER_CAPABILITIES` so providers opt in only after implementing
 * and preflighting the feature.
 */
export const SANDBOX_PROVIDER_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.interactive',
  'command.exec',
  'workspace.archive.transfer',
  'transcript.retained-source',
  'lifecycle.readoption',
  'lifecycle.sleep',
  'lifecycle.snapshot',
  'port.expose',
] as const;

export const SANDBOX_PROVIDER_KNOWN_CAPABILITIES: readonly SandboxProviderCapability[] = [
  ...SANDBOX_PROVIDER_CAPABILITIES,
  ...SANDBOX_PROVIDER_FEATURE_CAPABILITIES,
] as const;

export type SandboxProviderLocation = 'local' | 'cloud';

export const SANDBOX_PROVIDER_LOCATIONS: readonly SandboxProviderLocation[] = [
  'local',
  'cloud',
] as const;

export const INTERACTIVE_SANDBOX_REQUIRED_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
] as const;

export const MATERIALIZED_WORKSPACE_SANDBOX_REQUIRED_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
  'workspace.git.materialize',
] as const;

export const DELIVERY_SANDBOX_REQUIRED_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'workspace.git.deliver',
] as const;

export const READOPTION_SANDBOX_REQUIRED_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'lifecycle.readopt',
] as const;

export const RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'transcript.retained-read',
] as const;

export const INTERACTIVE_SANDBOX_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.interactive',
  'command.exec',
] as const;

export const ARCHIVE_WORKSPACE_SANDBOX_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'workspace.archive.transfer',
  'command.exec',
] as const;

export const DELIVERY_SANDBOX_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'workspace.git.deliver',
  'command.exec',
] as const;

export const READOPTION_SANDBOX_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'lifecycle.readoption',
] as const;

export const RETAINED_TRANSCRIPT_SANDBOX_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'transcript.retained-source',
] as const;
