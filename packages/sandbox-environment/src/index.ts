import type {
  SandboxEnvironmentProviderFamily,
  SandboxEnvironmentSourceKind,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox-core';

export type SandboxEnvironmentStatus =
  | 'draft'
  | 'validating'
  | 'ready'
  | 'failed'
  | 'stale'
  | 'disabled';

export const SANDBOX_ENVIRONMENT_READY_STATUS: SandboxEnvironmentStatus = 'ready';

export const SANDBOX_ENVIRONMENT_BLOCKED_STATUSES: readonly SandboxEnvironmentStatus[] = [
  'draft',
  'validating',
  'failed',
  'stale',
  'disabled',
] as const;

export type SandboxEnvironmentRuntimeId = string;

export interface SandboxEnvironmentCompatibility {
  readonly providerFamilies: readonly SandboxEnvironmentProviderFamily[];
  readonly runtimeIds?: readonly SandboxEnvironmentRuntimeId[];
}

export interface SandboxEnvironmentParameter {
  readonly name: string;
  readonly value?: string;
  readonly secret: boolean;
}

export interface SandboxEnvironmentBaseSource {
  readonly kind: SandboxEnvironmentSourceKind;
  readonly label?: string;
}

export interface AioDockerImageEnvironmentSource extends SandboxEnvironmentBaseSource {
  readonly kind: 'aio-docker-image';
  readonly image: string;
  readonly digest?: string;
}

export interface BoxLiteImageEnvironmentSource extends SandboxEnvironmentBaseSource {
  readonly kind: 'boxlite-image';
  readonly image: string;
  readonly digest?: string;
}

export type SandboxEnvironmentSourceDescriptor =
  | AioDockerImageEnvironmentSource
  | BoxLiteImageEnvironmentSource;

export interface SandboxEnvironmentRecord {
  readonly id: string;
  readonly name: string;
  readonly status: SandboxEnvironmentStatus;
  readonly source: SandboxEnvironmentSourceDescriptor;
  readonly compatibility: SandboxEnvironmentCompatibility;
  readonly parameters?: readonly SandboxEnvironmentParameter[];
  readonly isDefault?: boolean;
  readonly lastValidationId?: string | null;
  readonly lastValidatedAt?: string | null;
  readonly contractVersion?: string | null;
}

export interface SandboxEnvironmentValidationProbe {
  readonly name: string;
  readonly ok: boolean;
  readonly command?: string;
  readonly output?: string;
}

export interface SandboxEnvironmentValidationResult {
  readonly environmentId: string;
  readonly status: 'passed' | 'failed';
  readonly checkedAt: string;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly runtimeId?: string | null;
  readonly sourceKind: SandboxEnvironmentSourceKind;
  readonly resolvedDigest?: string;
  readonly resolvedChecksum?: string;
  readonly probes?: readonly SandboxEnvironmentValidationProbe[];
  readonly error?: string;
  readonly contractVersion?: string;
}

export interface SandboxEnvironmentResolverContext {
  readonly taskId: string;
  readonly runtimeId: string;
  readonly providerFamily?: SandboxEnvironmentProviderFamily;
  readonly requestedEnvironmentId?: string | null;
}

export interface SandboxEnvironmentResolver {
  resolveEnvironment(
    context: SandboxEnvironmentResolverContext,
  ): Promise<ResolvedSandboxEnvironment | null>;
}

export interface SandboxEnvironmentValidator {
  validateEnvironment(
    environment: SandboxEnvironmentRecord,
  ): Promise<SandboxEnvironmentValidationResult>;
}

export interface ResolvedSandboxEnvironment extends SandboxResolvedEnvironmentMetadata {
  readonly environmentId?: string;
  readonly name?: string;
  readonly source: SandboxEnvironmentSourceDescriptor;
}

export class SandboxEnvironmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SandboxEnvironmentSourceError extends SandboxEnvironmentError {
  constructor(message: string) {
    super(message, 'sandbox_environment_source_error');
  }
}

export class SandboxEnvironmentCompatibilityError extends SandboxEnvironmentError {
  constructor(message: string) {
    super(message, 'sandbox_environment_compatibility_error');
  }
}

export function providerFamiliesForEnvironmentSource(
  source: SandboxEnvironmentSourceDescriptor,
): readonly SandboxEnvironmentProviderFamily[] {
  switch (source.kind) {
    case 'aio-docker-image':
      return ['aio'];
    case 'boxlite-image':
      return ['boxlite'];
  }
}

export function sourceReference(source: SandboxEnvironmentSourceDescriptor): string {
  switch (source.kind) {
    case 'aio-docker-image':
    case 'boxlite-image':
      return source.image;
  }
}

export function sourceDigest(source: SandboxEnvironmentSourceDescriptor): string | undefined {
  switch (source.kind) {
    case 'aio-docker-image':
    case 'boxlite-image':
      return source.digest;
  }
}

export function sourceChecksum(
  source: SandboxEnvironmentSourceDescriptor,
): string | undefined {
  void source;
  return undefined;
}

export function isEnvironmentStatusSelectable(
  status: SandboxEnvironmentStatus,
): boolean {
  return status === SANDBOX_ENVIRONMENT_READY_STATUS;
}

export function isEnvironmentCompatible(args: {
  readonly environment: Pick<SandboxEnvironmentRecord, 'compatibility' | 'status'>;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly runtimeId?: string | null;
}): boolean {
  if (!isEnvironmentStatusSelectable(args.environment.status)) return false;
  if (!args.environment.compatibility.providerFamilies.includes(args.providerFamily)) {
    return false;
  }
  const runtimeIds = args.environment.compatibility.runtimeIds;
  return (
    !runtimeIds ||
    args.runtimeId === undefined ||
    args.runtimeId === null ||
    runtimeIds.includes(args.runtimeId)
  );
}

export function assertEnvironmentSelectable(args: {
  readonly environment: Pick<SandboxEnvironmentRecord, 'id' | 'status' | 'compatibility'>;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly runtimeId?: string | null;
}): void {
  if (!isEnvironmentStatusSelectable(args.environment.status)) {
    throw new SandboxEnvironmentCompatibilityError(
      `Sandbox environment ${args.environment.id} is not ready: ${args.environment.status}`,
    );
  }
  if (!args.environment.compatibility.providerFamilies.includes(args.providerFamily)) {
    throw new SandboxEnvironmentCompatibilityError(
      `Sandbox environment ${args.environment.id} is not compatible with provider family ${args.providerFamily}`,
    );
  }
  const runtimeIds = args.environment.compatibility.runtimeIds;
  if (
    runtimeIds &&
    args.runtimeId !== undefined &&
    args.runtimeId !== null &&
    !runtimeIds.includes(args.runtimeId)
  ) {
    throw new SandboxEnvironmentCompatibilityError(
      `Sandbox environment ${args.environment.id} is not compatible with runtime ${args.runtimeId}`,
    );
  }
}

export function selectEnvironmentSourceForProvider(args: {
  readonly sources: readonly SandboxEnvironmentSourceDescriptor[];
  readonly providerFamily: SandboxEnvironmentProviderFamily;
}): SandboxEnvironmentSourceDescriptor {
  const candidates = args.sources.filter((source) =>
    providerFamiliesForEnvironmentSource(source).includes(args.providerFamily),
  );
  if (candidates.length === 0) {
    throw new SandboxEnvironmentSourceError(
      `No sandbox environment source is compatible with provider family ${args.providerFamily}`,
    );
  }
  if (candidates.length > 1) {
    throw new SandboxEnvironmentSourceError(
      `Sandbox environment resolves to multiple sources for provider family ${args.providerFamily}`,
    );
  }
  return candidates[0]!;
}

export function normalizeResolvedEnvironment(args: {
  readonly environment: Pick<
    SandboxEnvironmentRecord,
    'id' | 'name' | 'source' | 'lastValidationId' | 'contractVersion'
  >;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly runtimeId?: string | null;
  readonly validationVersion?: string | null;
}): ResolvedSandboxEnvironment {
  const source = args.environment.source;
  const metadata: ResolvedSandboxEnvironment = {
    id: args.environment.id,
    environmentId: args.environment.id,
    name: args.environment.name,
    providerFamily: args.providerFamily,
    runtimeId: args.runtimeId ?? undefined,
    sourceKind: source.kind,
    sourceRef: sourceReference(source),
    digest: sourceDigest(source),
    checksum: sourceChecksum(source),
    validationId: args.environment.lastValidationId ?? undefined,
    validationVersion: args.validationVersion ?? undefined,
    contractVersion: args.environment.contractVersion ?? undefined,
    source,
  };
  return stripResolvedEnvironmentUndefined(metadata);
}

function stripResolvedEnvironmentUndefined(
  value: ResolvedSandboxEnvironment,
): ResolvedSandboxEnvironment {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as unknown as ResolvedSandboxEnvironment;
}
