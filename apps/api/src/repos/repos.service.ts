import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  GitBranchNameSchema,
  repoResponseSchema,
  type CreateRepoBody,
  type ForgeKind,
  type RepoResponse,
} from '@cap/contracts';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import {
  ForgeHttpError,
  type AvailableRepo,
  type ForgeTarget,
} from '../forge/forge.port';
import {
  RemoteRefsProbePort,
  type RemoteRefsProbeFailureReason,
} from '../forge/remote-refs-probe';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Metadata that has already crossed an owner-authenticated verification
 * boundary (forge picker API or the bounded symbolic-HEAD probe).
 *
 * `defaultBranch` is deliberately required and non-null: callers must fail at
 * verification time instead of passing an absent value that could erase a
 * previously verified branch or be replaced with a fabricated fallback.
 */
export interface VerifiedRepoImport {
  readonly name: string;
  readonly gitSource: string;
  readonly forge: ForgeKind;
  readonly defaultBranch: string;
  readonly description?: string | null;
  readonly githubId?: string;
  /** Legacy GitHub rows stored `full_name` directly in `githubId`. */
  readonly legacyGithubId?: string;
  readonly gitlabProjectId?: string;
}

export function normalizeRepoGitSource(gitSource: string): string {
  const raw = gitSource.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException({
      error: 'repo_git_source_invalid',
      message: 'Repository URL must be a valid HTTP(S) clone URL.',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException({
      error: 'repo_git_source_invalid',
      message: 'Repository URL must use http or https.',
    });
  }
  if (url.username || url.password) {
    throw new BadRequestException({
      error: 'repo_git_source_credentials_forbidden',
      message: 'Repository URL must not include credentials.',
    });
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '') {
    throw new BadRequestException({
      error: 'repo_git_source_invalid',
      message: 'Repository URL must include an owner/project path.',
    });
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Shared, secret-free mapping for Console/Internal repository verification.
 * Refresh and import must return the same stable body/status without copying
 * command, credential, or provider diagnostics across the HTTP boundary.
 */
export function throwRepoRemoteRefsFailure(
  reason: RemoteRefsProbeFailureReason,
): never {
  switch (reason) {
    case 'authentication_failed':
      throw new ForbiddenException({
        error: 'repo_forge_authentication_failed',
        message: 'The connected forge credential could not authenticate this repository.',
      });
    case 'access_denied':
      throw new ForbiddenException({
        error: 'repo_forge_access_denied',
        message: 'The connected forge credential cannot access this repository.',
      });
    case 'network_unavailable':
      throw new ServiceUnavailableException({
        error: 'repo_forge_network_unavailable',
        message: 'The repository host could not be reached during the access probe.',
      });
    case 'platform_dependency_unavailable':
      throw new ServiceUnavailableException({
        error: 'repo_platform_dependency_unavailable',
        message:
          'The deployment is missing a required repository verification dependency.',
      });
    case 'default_branch_unresolved':
      throw new UnprocessableEntityException({
        error: 'repo_default_branch_unresolved',
        message: 'The repository default branch could not be resolved.',
      });
  }
}

/**
 * Repository persistence + read service. Every value returned to a controller is
 * re-validated against the contracts `repoResponseSchema` so the response body
 * is guaranteed to match the shared contract (a defensive check against schema
 * drift between Prisma and contracts).
 */
@Injectable()
export class ReposService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly forgeTargets: ForgeTargetResolver,
    private readonly remoteRefs: RemoteRefsProbePort,
    private readonly forgeRegistry: DefaultForgeRegistry,
  ) {}

  async create(ownerUserId: string, body: CreateRepoBody): Promise<RepoResponse> {
    const gitSource = normalizeRepoGitSource(body.gitSource);

    // Owner-aware import boundary (fix-large-repo-task-provisioning 4.1): URL,
    // Gitee, and GitLab imports all resolve the forge and credential through the
    // same exact-host seam used by task delivery. The account id comes from the
    // authenticated Console session; it is never accepted from the request body.
    // Task 4.2 attaches the bounded remote-refs probe to this resolved target.
    const target = await this.forgeTargets.resolveForOwner(ownerUserId, {
      gitSource,
      forge: body.forge,
    });
    if (!target.ok) {
      this.throwOwnerTargetFailure(target.reason);
    }

    let defaultBranch: string;
    let gitlabProjectId: string | undefined;
    if (body.importSource === 'picker') {
      // A browser-supplied branch is not a verification boundary. Re-list with
      // this account's exact-host credential, match the selected clone URL, and
      // persist only the forge API candidate returned by that server-side call.
      const picker = await this.resolvePickerMetadata(target.target, gitSource);
      defaultBranch = picker.defaultBranch;
      gitlabProjectId = picker.gitlabProjectId;
    } else {
      // Generic URL imports prove the remote's real symbolic HEAD through the
      // bounded 4.2 probe. This service receives only the verified branch or a
      // stable secret-free reason.
      const probe = await this.remoteRefs.resolveDefaultBranch(target.target);
      if (!probe.ok) {
        throwRepoRemoteRefsFailure(probe.reason);
      }
      defaultBranch = probe.defaultBranch;
    }

    return this.reconcileVerifiedImport({
      name: body.name,
      gitSource,
      forge: target.target.kind,
      defaultBranch,
      gitlabProjectId,
    });
  }

  /**
   * Re-verifies an existing repository's symbolic HEAD for the authenticated
   * Console account without accepting a branch from the caller.
   *
   * The remote operation deliberately happens before the transaction. The
   * subsequent write is fenced by the immutable database identity observed
   * before that probe, so a concurrent delete or forge/source reassignment
   * cannot be recreated or overwritten by a stale result.
   */
  async refreshDefaultBranch(
    ownerUserId: string,
    repoId: string,
  ): Promise<RepoResponse> {
    const snapshot = await this.prisma.repo.findUnique({
      where: { id: repoId },
      select: {
        id: true,
        gitSource: true,
        forge: true,
        gitlabProjectId: true,
      },
    });
    if (!snapshot) {
      throw new NotFoundException(`Repo not found: ${repoId}`);
    }

    const target = await this.forgeTargets.resolveForOwner(ownerUserId, {
      gitSource: snapshot.gitSource,
      forge: snapshot.forge,
      gitlabProjectId: snapshot.gitlabProjectId,
    });
    if (!target.ok) {
      this.throwOwnerTargetFailure(target.reason);
    }

    const probe = await this.remoteRefs.resolveDefaultBranch(target.target);
    if (!probe.ok) {
      throwRepoRemoteRefsFailure(probe.reason);
    }
    const defaultBranch = this.requireVerifiedDefaultBranch(probe.defaultBranch);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.repo.updateMany({
        where: {
          id: snapshot.id,
          gitSource: snapshot.gitSource,
          forge: snapshot.forge,
        },
        data: { defaultBranch },
      });
      if (updated.count !== 1) {
        this.throwRefreshIdentityConflict();
      }

      const refreshed = await tx.repo.findUnique({ where: { id: snapshot.id } });
      if (!refreshed) {
        this.throwRefreshIdentityConflict();
      }
      return repoResponseSchema.parse(this.toResponse(refreshed));
    });
  }

  /**
   * Persists a server-verified import or reconciles it into the earliest
   * matching Repo. This is shared by generic imports and the dedicated GitHub
   * picker so URL/picker retries cannot create two rows through different paths.
   *
   * Deterministic non-erasing policy:
   * - the latest owner-verified default branch wins (supports a real remote
   *   default-branch rename);
   * - nullable provenance is filled/canonicalized, never replaced with absence;
   * - an existing non-null forge/name/description is preserved;
   * - conflicting forge/stable provider ids fail closed instead of merging two
   *   repos;
   * - a stable provider-id match may refresh a verified renamed clone URL, while
   *   a URL-only match never rewrites its source.
   *
   * Callers MUST authenticate/verify before entering this method. In particular,
   * duplicate lookup happens only after owner access succeeds, so a different
   * account's existing private Repo never becomes an authentication oracle.
   */
  async reconcileVerifiedImport(input: VerifiedRepoImport): Promise<RepoResponse> {
    const gitSource = normalizeRepoGitSource(input.gitSource);
    const defaultBranch = this.requireVerifiedDefaultBranch(input.defaultBranch);
    const lockKeys = [
      `repo-url:${gitSource}`,
      ...(input.githubId ? [`repo-github:${input.githubId}`] : []),
      ...(input.gitlabProjectId ? [`repo-gitlab:${input.gitlabProjectId}`] : []),
    ].sort();

    // Repo predates canonical unique import keys. Serialize every cooperating
    // importer on deterministic Postgres transaction-scoped advisory keys so a
    // URL/picker race cannot both observe "missing" and create two rows. Keys
    // are sorted to keep multi-key imports deadlock-free across API instances.
    return this.prisma.$transaction(async (tx) => {
      for (const lockKey of lockKeys) {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
        `;
      }
      return this.reconcileVerifiedImportInTransaction(tx, {
        ...input,
        gitSource,
        defaultBranch,
      });
    });
  }

  private async reconcileVerifiedImportInTransaction(
    tx: Prisma.TransactionClient,
    input: VerifiedRepoImport,
  ): Promise<RepoResponse> {
    // Stable provider identities outrank legacy slug and mutable clone URL.
    // Separate reads make that priority deterministic; a single OR/findFirst
    // would let createdAt accidentally select a weaker URL-only match.
    let existing = input.githubId
      ? await tx.repo.findFirst({
          where: { githubId: input.githubId },
          orderBy: { createdAt: 'asc' },
        })
      : null;
    if (!existing && input.gitlabProjectId) {
      existing = await tx.repo.findFirst({
        where: { gitlabProjectId: input.gitlabProjectId },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!existing && input.legacyGithubId) {
      existing = await tx.repo.findFirst({
        where: { githubId: input.legacyGithubId },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!existing) {
      existing = await tx.repo.findFirst({
        where: { gitSource: input.gitSource },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!existing) {
      const created = await tx.repo.create({
        data: {
          name: input.name.trim(),
          gitSource: input.gitSource,
          forge: input.forge,
          defaultBranch: input.defaultBranch,
          description: input.description ?? null,
          githubId: input.githubId ?? null,
          gitlabProjectId: input.gitlabProjectId ?? null,
        },
      });
      return repoResponseSchema.parse(this.toResponse(created));
    }

    if (existing.forge !== null && existing.forge !== input.forge) {
      this.throwImportIdentityConflict();
    }
    if (
      input.githubId &&
      existing.githubId &&
      existing.githubId !== input.githubId &&
      existing.githubId !== input.legacyGithubId
    ) {
      this.throwImportIdentityConflict();
    }
    if (
      input.gitlabProjectId &&
      existing.gitlabProjectId &&
      existing.gitlabProjectId !== input.gitlabProjectId
    ) {
      this.throwImportIdentityConflict();
    }

    const stableProviderIdentityMatched =
      (input.githubId !== undefined && existing.githubId === input.githubId) ||
      (input.gitlabProjectId !== undefined &&
        existing.gitlabProjectId === input.gitlabProjectId);

    const updated = await tx.repo.update({
      where: { id: existing.id },
      data: {
        // Always non-null and owner verified; this is never an absent-value
        // overwrite and intentionally follows a real remote default rename.
        defaultBranch: input.defaultBranch,
        // Preserve existing verified metadata. Only fill absent provenance, or
        // canonicalize the legacy raw GitHub full_name to the stable namespaced id.
        ...(existing.forge === null ? { forge: input.forge } : {}),
        ...(input.githubId && existing.githubId !== input.githubId
          ? { githubId: input.githubId }
          : {}),
        ...(input.gitlabProjectId && existing.gitlabProjectId === null
          ? { gitlabProjectId: input.gitlabProjectId }
          : {}),
        ...(input.description != null && existing.description === null
          ? { description: input.description }
          : {}),
        // A stable id proves a rename is the same remote. URL-only matches do
        // not have that evidence and therefore keep their existing source.
        ...(stableProviderIdentityMatched && existing.gitSource !== input.gitSource
          ? { gitSource: input.gitSource }
          : {}),
      },
    });
    return repoResponseSchema.parse(this.toResponse(updated));
  }

  private async resolvePickerMetadata(
    target: ForgeTarget,
    selectedGitSource: string,
  ): Promise<{ defaultBranch: string; gitlabProjectId?: string }> {
    let candidates: AvailableRepo[];
    try {
      candidates = await this.forgeRegistry.forKind(target.kind).listRepos(target);
    } catch (error) {
      if (error instanceof ForgeHttpError && error.status === 401) {
        throwRepoRemoteRefsFailure('authentication_failed');
      }
      if (error instanceof ForgeHttpError && error.status === 403) {
        throwRepoRemoteRefsFailure('access_denied');
      }
      throw new ServiceUnavailableException({
        error: 'repo_forge_network_unavailable',
        message: 'The repository host could not be reached while verifying the picker selection.',
      });
    }

    const candidate = candidates.find((item) => {
      if (item.forge !== target.kind) return false;
      try {
        return normalizeRepoGitSource(item.gitSource) === selectedGitSource;
      } catch {
        return false;
      }
    });
    if (!candidate) {
      throw new ForbiddenException({
        error: 'repo_picker_candidate_not_accessible',
        message: 'The selected repository is no longer accessible to this account.',
      });
    }
    return {
      defaultBranch: this.requireVerifiedDefaultBranch(candidate.defaultBranch),
      ...(candidate.gitlabProjectId
        ? { gitlabProjectId: candidate.gitlabProjectId }
        : {}),
    };
  }

  private requireVerifiedDefaultBranch(value: string): string {
    const branch = GitBranchNameSchema.safeParse(value);
    if (!branch.success) {
      throwRepoRemoteRefsFailure('default_branch_unresolved');
    }
    return branch.data;
  }

  private throwOwnerTargetFailure(
    reason: 'forge_unresolved' | 'owner_credential_unavailable',
  ): never {
    if (reason === 'forge_unresolved') {
      throw new BadRequestException({
        error: 'repo_forge_unresolved',
        message:
          'Repository forge could not be resolved for this URL. Select the forge or register its host first.',
      });
    }
    throw new ForbiddenException({
      error: 'repo_forge_auth_required',
      message:
        'A connected credential for this repository host is required before import.',
    });
  }

  private throwRefreshIdentityConflict(): never {
    throw new ConflictException({
      error: 'repo_import_identity_conflict',
      message:
        'The repository identity changed while its default branch was being refreshed.',
    });
  }

  private throwImportIdentityConflict(): never {
    throw new ConflictException({
      error: 'repo_import_identity_conflict',
      message: 'The repository URL conflicts with an existing provider identity.',
    });
  }

  async list(): Promise<RepoResponse[]> {
    const repos = await this.prisma.repo.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return repos.map((repo) => repoResponseSchema.parse(this.toResponse(repo)));
  }

  async findById(id: string): Promise<RepoResponse> {
    const repo = await this.prisma.repo.findUnique({ where: { id } });
    if (!repo) {
      throw new NotFoundException(`Repo not found: ${id}`);
    }
    return repoResponseSchema.parse(this.toResponse(repo));
  }

  /**
   * Shapes a Prisma `Repo` row into the contracts response shape. The contracts
   * `RepoSchema.createdAt`/`updatedAt` are `Date`s (`z.coerce.date()`), so the
   * row's native `Date` is passed through unchanged; the HTTP boundary serializes
   * it to an ISO string on the way out.
   *
   * Import metadata is surfaced on every read path exactly as persisted.
   * `defaultBranch` is forge-neutral and verified for URL/Gitee/GitLab/GitHub
   * imports; GitHub-only fields remain nullable. No read path fabricates a
   * branch for legacy rows whose persisted value is null.
   */
  private toResponse(repo: {
    id: string;
    name: string;
    gitSource: string;
    createdAt: Date;
    description: string | null;
    defaultBranch: string | null;
    branchCount: number | null;
    updatedAt: Date | null;
    githubId: string | null;
    isDefault: boolean;
    forge?: string | null;
  }): RepoResponse {
    return {
      id: repo.id,
      name: repo.name,
      gitSource: repo.gitSource,
      createdAt: repo.createdAt,
      description: repo.description,
      defaultBranch: repo.defaultBranch,
      branchCount: repo.branchCount,
      updatedAt: repo.updatedAt,
      githubId: repo.githubId,
      // The single-default flag (be-github-import 4.5), surfaced on every read
      // path so the console can render which imported Repo is the default.
      isDefault: repo.isDefault,
      // add-multi-forge-task-delivery: the source forge (null for repos predating
      // multi-forge / unknown host), echoed so the console renders the source.
      forge: (repo.forge ?? null) as RepoResponse['forge'],
    };
  }
}
