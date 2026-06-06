import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  repoResponseSchema,
  type AvailableGithubRepo,
  type DefaultRepoResponse,
  type ImportRepoRequest,
  type RepoResponse,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  findExistingImport,
  githubDedupKey,
  pickDefaultRepo,
  reconcileAvailableRepos,
  validateSetDefaultTarget,
  type DefaultCandidateRepo,
  type ImportedRepoRef,
} from './github-import.logic';
import { GithubReposClient } from './github-repos.client';

/**
 * GitHub-import orchestration (be-github-import, 4.1–4.5).
 *
 * Composes the PURE decision logic ({@link github-import.logic}) with the GitHub
 * HTTP boundary ({@link GithubReposClient}) and Prisma persistence. The
 * security-critical token handling lives here: the requesting operator's OWN
 * stored OAuth token is read from their User row by immutable numeric
 * `githubId`, used ONLY as the server-side bearer, and NEVER returned to the
 * browser (it is not on any response shape).
 */

/** Distinct signal: the operator must (re)authorize GitHub (4.2). */
export class GithubAuthorizationRequiredException extends HttpException {
  constructor() {
    super(
      {
        error: 'github_auth_required',
        message:
          'GitHub authorization is required: no valid GitHub access token for ' +
          'this operator. Reconnect GitHub to list repositories.',
      },
      // A distinct, non-session 4xx so the console can branch on it. It is NOT a
      // platform-session 401 (the operator IS authenticated to the platform).
      HttpStatus.FORBIDDEN,
    );
  }
}

/** Cause-preserving retry-able signal: GitHub rate-limited/outage/network (4.2). */
export class GithubUnavailableException extends HttpException {
  constructor() {
    super(
      {
        error: 'github_unavailable',
        message:
          'GitHub is temporarily unavailable (rate limit, outage, or network ' +
          'error). Retry shortly.',
      },
      // 503: a retry-able upstream failure, distinct from an auth problem.
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

@Injectable()
export class GithubImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly githubRepos: GithubReposClient,
  ) {}

  /**
   * 4.1 / 4.2 — Lists the available GitHub repos for the requesting operator
   * using THEIR OWN stored token, then reconciles against imported platform
   * Repos so the console can mark already-imported entries. Throws the distinct
   * auth-required / retry-able exceptions on the respective failure modes; an
   * empty-but-successful listing returns `[]`.
   */
  async listAvailable(operatorGithubId: number): Promise<AvailableGithubRepo[]> {
    const accessToken = await this.readOperatorToken(operatorGithubId);
    const result = await this.githubRepos.listForOperator(accessToken);
    if (!result.ok) {
      throw result.error.retryable
        ? new GithubUnavailableException()
        : new GithubAuthorizationRequiredException();
    }
    return result.repos;
  }

  /**
   * 4.1 / 4.4 — The reconciled available list: each entry annotated with whether
   * an imported platform Repo already represents it, so the console can mark
   * "already imported". The reconciliation is the pure
   * {@link reconcileAvailableRepos}.
   */
  async listAvailableReconciled(operatorGithubId: number): Promise<
    Array<AvailableGithubRepo & { imported: boolean; importedRepoId: string | null }>
  > {
    const available = await this.listAvailable(operatorGithubId);
    const imported = await this.loadImportedRefs();
    const annotations = reconcileAvailableRepos(available, imported);
    // Zip the contract shape with the reconciliation annotation by index (both
    // are derived from the same `available` order).
    return available.map((repo, i) => ({
      ...repo,
      imported: annotations[i].imported,
      importedRepoId: annotations[i].importedRepoId,
    }));
  }

  /**
   * 4.3 / 4.4 — Imports a selected GitHub repo as a platform Repo, de-duplicated
   * on the originating GitHub numeric id (full_name fallback). On a re-import of
   * an already-imported repo it throws 409 identifying the existing Repo. Returns
   * the created (or, conceptually, existing) Repo with its platform id.
   */
  async importRepo(body: ImportRepoRequest): Promise<RepoResponse> {
    const imported = await this.loadImportedRefs();
    const existing = findExistingImport(
      { id: body.id, full_name: body.full_name },
      imported,
    );
    if (existing !== null) {
      // Re-import: identify the existing platform Repo (de-dup on numeric id).
      throw new ConflictException({
        error: 'already_imported',
        message: `GitHub repo ${body.full_name} is already imported.`,
        repoId: existing.id,
      });
    }

    // Derive the platform Repo: display name from the slug, gitSource from the
    // canonical HTTPS clone URL, and the GitHub-import metadata (numeric id ->
    // namespaced githubId, default branch, description).
    const repo = await this.prisma.repo.create({
      data: {
        name: this.deriveName(body.full_name),
        gitSource: this.deriveGitSource(body.full_name),
        githubId: githubDedupKey(body.id),
        defaultBranch: body.defaultBranch,
        description: body.description ?? null,
      },
    });
    return repoResponseSchema.parse(this.toResponse(repo));
  }

  /**
   * 4.5 — Designates exactly ONE imported Repo as default. Rejects an
   * un-imported / available-only target (the pure
   * {@link validateSetDefaultTarget}), and atomically clears any prior default so
   * at most one Repo is ever the default. Returns the new default Repo.
   */
  async setDefault(repoId: string): Promise<RepoResponse> {
    const candidates = await this.loadDefaultCandidates();
    const decision = validateSetDefaultTarget(repoId, candidates);
    if (!decision.ok) {
      if (decision.reason === 'not_found') {
        throw new NotFoundException(`Repo not found: ${repoId}`);
      }
      // not_imported: an available-only / plain gitSource repo cannot be default.
      throw new ForbiddenException({
        error: 'not_imported',
        message:
          'Only an imported GitHub repo can be set as the default; ' +
          'this repo was not imported from GitHub.',
      });
    }

    // Atomic: clear prior default(s) then set the target, so at most one default
    // exists even under concurrent set-default calls.
    const [, updated] = await this.prisma.$transaction([
      this.prisma.repo.updateMany({
        where: { id: { in: [...decision.clearIds] }, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.repo.update({
        where: { id: decision.targetId },
        data: { isDefault: true },
      }),
    ]);
    return repoResponseSchema.parse(this.toResponse(updated));
  }

  /**
   * 4.5 — Reads the current default imported Repo, or `null` when none has been
   * designated. Uses the pure {@link pickDefaultRepo}.
   */
  async readDefault(): Promise<DefaultRepoResponse> {
    const repos = await this.prisma.repo.findMany({
      where: { isDefault: true },
      orderBy: { createdAt: 'asc' },
    });
    const def = pickDefaultRepo(repos);
    return { repo: def ? repoResponseSchema.parse(this.toResponse(def)) : null };
  }

  // ----- internals -----------------------------------------------------------

  /**
   * Reads the requesting operator's OWN stored GitHub OAuth token by immutable
   * numeric `githubId`. Returns `null` when the operator has no token stored —
   * the client maps that to the same `github_auth_required` signal as an
   * expired/revoked token. The token is NEVER returned beyond the server-side
   * GitHub call.
   */
  private async readOperatorToken(operatorGithubId: number): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { githubId: operatorGithubId },
      select: { githubAccessToken: true },
    });
    return user?.githubAccessToken ?? null;
  }

  /** Loads the de-dup view of every imported Repo (a non-null githubId). */
  private async loadImportedRefs(): Promise<ImportedRepoRef[]> {
    const rows = await this.prisma.repo.findMany({
      where: { githubId: { not: null } },
      select: { id: true, githubId: true },
    });
    return rows;
  }

  /** Loads the default-selection view of every Repo. */
  private async loadDefaultCandidates(): Promise<DefaultCandidateRepo[]> {
    const rows = await this.prisma.repo.findMany({
      select: { id: true, githubId: true, isDefault: true },
    });
    return rows;
  }

  /** Display name derived from the slug's repo segment (`owner/name` -> `name`). */
  private deriveName(fullName: string): string {
    const segment = fullName.split('/').pop();
    return segment && segment.length > 0 ? segment : fullName;
  }

  /** Canonical HTTPS clone URL derived from the `owner/name` slug. */
  private deriveGitSource(fullName: string): string {
    return `https://github.com/${fullName}.git`;
  }

  /** Shapes a Prisma Repo row into the contracts response shape. */
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
      isDefault: repo.isDefault,
    };
  }
}
