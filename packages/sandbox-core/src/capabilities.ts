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
  /**
   * Workspace-source injection variants (see `workspace-source.ts`). A provider
   * declares one entry per `WorkspaceSource` kind it can materialize.
   */
  | 'workspace.source.volume'
  | 'workspace.source.archive'
  | 'workspace.source.git'
  | 'transcript.retained-read'
  | 'transcript.retained-source'
  /**
   * Readoption of an already-running sandbox. ONE spelling: a
   * `lifecycle.readoption` variant also existed and was carried by an alias
   * reconciliation copied into four places. It denoted the same capability —
   * every other REQUIRED/FEATURE pair below names genuinely DIFFERENT
   * capabilities, and only readoption named one capability twice. Operator
   * configuration still accepts the old spelling; see the BoxLite config parse.
   */
  | 'lifecycle.readopt'
  | 'lifecycle.sleep'
  | 'lifecycle.snapshot'
  | 'resource.disk-size-gb'
  | 'port.expose';

/**
 * How a capability participates in provider selection.
 *
 * - `operation` — part of the operation-level set the current AIO / cloud-HTTP
 *   selection paths rely on, and safe for default provider configuration to
 *   advertise.
 * - `feature` — opt-in: a provider declares it only after implementing and
 *   preflighting the feature, so default configuration does not over-advertise.
 */
export type SandboxProviderCapabilityClass = 'operation' | 'feature';

/**
 * THE source of the capability vocabulary's classification.
 *
 * Total by construction: every capability has exactly one class, and a
 * capability added to the union without a class here is a COMPILE error rather
 * than a value the type system blesses while `SANDBOX_PROVIDER_KNOWN_CAPABILITIES`
 * calls it unknown. The three exported lists below are DERIVED from this — they
 * were three hand-maintained arrays (plus a fourth hand-written copy in the
 * package's own test) with nothing reconciling them against the union or each
 * other, which is how one capability came to sit in the operation list under one
 * spelling and the feature list under another.
 */
const SANDBOX_PROVIDER_CAPABILITY_CLASSES: Readonly<
  Record<SandboxProviderCapability, SandboxProviderCapabilityClass>
> = {
  'terminal.websocket': 'operation',
  'workspace.git.materialize': 'operation',
  'workspace.git.deliver': 'operation',
  'transcript.retained-read': 'operation',
  'lifecycle.readopt': 'operation',
  'terminal.interactive': 'feature',
  'command.exec': 'feature',
  'workspace.archive.transfer': 'feature',
  'workspace.source.volume': 'feature',
  'workspace.source.archive': 'feature',
  'workspace.source.git': 'feature',
  'transcript.retained-source': 'feature',
  'lifecycle.sleep': 'feature',
  'lifecycle.snapshot': 'feature',
  'resource.disk-size-gb': 'feature',
  'port.expose': 'feature',
};

function capabilitiesOfClass(
  wanted: SandboxProviderCapabilityClass,
): readonly SandboxProviderCapability[] {
  return Object.freeze(
    (
      Object.keys(SANDBOX_PROVIDER_CAPABILITY_CLASSES) as SandboxProviderCapability[]
    ).filter((capability) => SANDBOX_PROVIDER_CAPABILITY_CLASSES[capability] === wanted),
  );
}

/**
 * Operation-level capabilities used by the current AIO/cloud HTTP selection
 * paths. Derived from the classification, so it cannot drift from it.
 */
export const SANDBOX_PROVIDER_CAPABILITIES: readonly SandboxProviderCapability[] =
  capabilitiesOfClass('operation');

/**
 * Provider feature capabilities used by selected-run planning and future
 * adapters. Derived from the classification, so it cannot drift from it.
 */
export const SANDBOX_PROVIDER_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] =
  capabilitiesOfClass('feature');

/**
 * Every capability, by construction the union's full membership: it is the key
 * set of a total mapping rather than a concatenation that happened to add up.
 */
export const SANDBOX_PROVIDER_KNOWN_CAPABILITIES: readonly SandboxProviderCapability[] =
  Object.freeze([
    ...SANDBOX_PROVIDER_CAPABILITIES,
    ...SANDBOX_PROVIDER_FEATURE_CAPABILITIES,
  ]);

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

/**
 * Readoption has no feature-level capability distinct from its operation-level
 * one — unlike interactive terminals or retained transcripts, where the pair
 * names two different capabilities. It previously appeared to have one only
 * because the second entry was the same capability under a second spelling.
 */
export const READOPTION_SANDBOX_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'lifecycle.readopt',
] as const;

export const RETAINED_TRANSCRIPT_SANDBOX_FEATURE_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'transcript.retained-source',
] as const;

export function missingCapabilities(
  declared: readonly SandboxProviderCapability[] | undefined,
  required: readonly SandboxProviderCapability[],
): SandboxProviderCapability[] {
  const set = new Set(declared ?? []);
  return required.filter((capability) => !set.has(capability));
}

export function hasAllCapabilities(
  declared: readonly SandboxProviderCapability[] | undefined,
  required: readonly SandboxProviderCapability[],
): boolean {
  return missingCapabilities(declared, required).length === 0;
}
