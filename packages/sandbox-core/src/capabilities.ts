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
  | 'workspace.git.materialize'
  | 'workspace.git.deliver'
  | 'transcript.retained-read'
  | 'lifecycle.readopt';

export const SANDBOX_PROVIDER_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
  'workspace.git.materialize',
  'workspace.git.deliver',
  'transcript.retained-read',
  'lifecycle.readopt',
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
