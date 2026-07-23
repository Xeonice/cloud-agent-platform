import type { SandboxProviderCapability } from './capabilities.js';
import { missingCapabilities } from './capabilities.js';
import {
  SandboxProviderCapabilityError,
  SandboxProviderConfigurationError,
} from './errors.js';
import type { GitCloneSpec } from './provider.js';

/**
 * Provider-facing workspace origin.
 *
 * The union replaces the bare clone spec as the workspace *intent*: the
 * orchestrator decides how the repo content reaches the sandbox (repo-store
 * volume mount, repo-store archive transfer, or the legacy in-sandbox network
 * clone) and providers consume the variant they declare support for.
 */
export const WORKSPACE_SOURCE_KINDS = ['volume', 'archive', 'git'] as const;

/**
 * Canonical in-sandbox path a repo copy is exposed at (read-only for the
 * `volume` variant). Provider-neutral so orchestration can name it without
 * reaching into a provider package.
 */
export const SANDBOX_REPO_SOURCE_MOUNT_DIR = '/cap-repo-source';

export type WorkspaceSourceKind = (typeof WORKSPACE_SOURCE_KINDS)[number];

/**
 * Repo-store copy exposed to the sandbox as a read-only per-repo mount.
 * `subpath` is relative to the volume root so a task only ever sees its own
 * repo copy; `mountPath` is where the copy appears inside the sandbox.
 */
export interface VolumeWorkspaceSource {
  readonly kind: 'volume';
  readonly repoId: string;
  readonly volumeName: string;
  readonly subpath: string;
  readonly mountPath: string;
  /** Recorded git source the materialized workspace must set `origin` to. */
  readonly gitSource: string;
}

/**
 * Repo-store copy transferred to the sandbox as an archive stream, for
 * providers without a mount seam (BoxLite REST, remote HTTP).
 */
export interface ArchiveWorkspaceSource {
  readonly kind: 'archive';
  readonly repoId: string;
  /** Host-side path of the bare mirror the archive is produced from. */
  readonly storePath: string;
  /** Recorded git source the materialized workspace must set `origin` to. */
  readonly gitSource: string;
}

/**
 * Legacy in-sandbox network clone. Kept for gated fallback and staged
 * migration; it wraps the existing {@link GitCloneSpec} unchanged.
 */
export interface GitWorkspaceSource {
  readonly kind: 'git';
  readonly spec: GitCloneSpec;
}

export type WorkspaceSource =
  | VolumeWorkspaceSource
  | ArchiveWorkspaceSource
  | GitWorkspaceSource;

export function isVolumeWorkspaceSource(
  source: WorkspaceSource | null | undefined,
): source is VolumeWorkspaceSource {
  return source?.kind === 'volume';
}

export function isArchiveWorkspaceSource(
  source: WorkspaceSource | null | undefined,
): source is ArchiveWorkspaceSource {
  return source?.kind === 'archive';
}

export function isGitWorkspaceSource(
  source: WorkspaceSource | null | undefined,
): source is GitWorkspaceSource {
  return source?.kind === 'git';
}

/**
 * One capability per injection variant. Providers opt in only after the
 * variant is implemented and preflighted, so selection stays fail-closed.
 */
export const WORKSPACE_SOURCE_CAPABILITY_BY_KIND: Readonly<
  Record<WorkspaceSourceKind, SandboxProviderCapability>
> = Object.freeze({
  volume: 'workspace.source.volume',
  archive: 'workspace.source.archive',
  git: 'workspace.source.git',
} as const);

export function workspaceSourceCapability(
  kind: WorkspaceSourceKind,
): SandboxProviderCapability {
  return WORKSPACE_SOURCE_CAPABILITY_BY_KIND[kind];
}

/** Capabilities a provider must advertise before receiving this source. */
export function workspaceSourceRequiredCapabilities(
  source: WorkspaceSource | null | undefined,
): readonly SandboxProviderCapability[] {
  if (source === null || source === undefined) return [];
  return [workspaceSourceCapability(source.kind)];
}

/** True when the provider declared the capability for this variant. */
export function supportsWorkspaceSource(
  declared: readonly SandboxProviderCapability[] | undefined,
  source: WorkspaceSource | null | undefined,
): boolean {
  return (
    missingCapabilities(declared, workspaceSourceRequiredCapabilities(source))
      .length === 0
  );
}

/**
 * Direct-adapter enforcement companion to scheduler capability selection.
 * Selection must fail closed rather than silently degrade to another variant.
 */
export function assertSandboxProviderSupportsWorkspaceSource(
  declared: readonly SandboxProviderCapability[] | undefined,
  source: WorkspaceSource | null | undefined,
): void {
  const missing = missingCapabilities(
    declared,
    workspaceSourceRequiredCapabilities(source),
  );
  if (missing.length === 0) return;
  throw new SandboxProviderCapabilityError(
    `Sandbox provider cannot materialize the selected workspace source; missing capabilities: ${missing.join(', ')}`,
    missing,
  );
}

/**
 * Validate and freeze caller input at the provider boundary. Shape only: the
 * repo-store owns copy readiness, and the injection seam owns transport.
 */
export function snapshotWorkspaceSource(
  source: WorkspaceSource | null | undefined,
): WorkspaceSource | null | undefined {
  if (source === null || source === undefined) return source;
  switch (source.kind) {
    case 'volume':
      return Object.freeze({
        kind: 'volume',
        repoId: requireExactString(source.repoId, 'repoId'),
        volumeName: requireExactString(source.volumeName, 'volumeName'),
        subpath: requireVolumeSubpath(source.subpath),
        mountPath: requireExactString(source.mountPath, 'mountPath'),
        gitSource: requireExactString(source.gitSource, 'gitSource'),
      });
    case 'archive':
      return Object.freeze({
        kind: 'archive',
        repoId: requireExactString(source.repoId, 'repoId'),
        storePath: requireExactString(source.storePath, 'storePath'),
        gitSource: requireExactString(source.gitSource, 'gitSource'),
      });
    case 'git': {
      const spec: GitCloneSpec | undefined = source.spec;
      return Object.freeze({
        kind: 'git',
        spec: Object.freeze({
          ...spec,
          url: requireExactString(spec?.url, 'spec.url'),
        }),
      });
    }
    default:
      throw new SandboxProviderConfigurationError(
        `Unsupported workspace source kind: ${String(
          (source as { readonly kind?: unknown }).kind,
        )}`,
      );
  }
}

function requireExactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new SandboxProviderConfigurationError(
      `Workspace source ${field} must be a non-empty string without surrounding whitespace`,
    );
  }
  return value;
}

/**
 * Volume subpaths address content inside the shared repo-store volume, so they
 * must stay relative and may not climb out of it.
 */
function requireVolumeSubpath(value: unknown): string {
  const subpath = requireExactString(value, 'subpath');
  if (subpath.startsWith('/')) {
    throw new SandboxProviderConfigurationError(
      'Workspace source subpath must be relative to the volume root',
    );
  }
  if (subpath.split('/').includes('..')) {
    throw new SandboxProviderConfigurationError(
      'Workspace source subpath must not contain parent-directory segments',
    );
  }
  return subpath;
}
