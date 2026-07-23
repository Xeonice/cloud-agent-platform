import {
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
import { decryptStored } from '../settings/secret-storage';
import {
  githubDedupKey,
  pickDefaultRepo,
  reconcileAvailableRepos,
  validateSetDefaultTarget,
  type DefaultCandidateRepo,
  type ImportedRepoRef,
} from './github-import.logic';
import { GithubReposClient } from './github-repos.client';
import { RepoCopyService } from './repo-copy.service';
import { repoRowToResponse, type RepoRowProjection } from './repo-response';
import { ReposService } from './repos.service';
import { basicAuthHeader } from '../forge/forge.port';

/**
 * GitHub-import orchestration (be-github-import, 4.1–4.5).
 *
 * Composes the PURE decision logic ({@link github-import.logic}) with the GitHub
 * HTTP boundary ({@link GithubReposClient}) and Prisma persistence. The
 * security-critical token handling lives here: the requesting operator's OWN
 * stored GitHub PAT is read from their `github.com` ForgeCredential, used ONLY
 * as the server-side bearer, and NEVER returned to the browser (it is not on any
 * response shape).
 */

const GITHUB_FORGE_KIND = 'github';
const GITHUB_FORGE_HOST = 'github.com';

/** Distinct signal: the operator must connect or refresh their GitHub PAT (4.2). */
export class GithubAuthorizationRequiredException extends HttpException {
  constructor() {
    super(
      {
        error: 'github_auth_required',
        message:
          'GitHub PAT is required: no valid connected GitHub PAT for this ' +
          'operator. Connect a GitHub PAT in settings to list repositories.',
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
    private readonly repos: ReposService,
    private readonly copies: RepoCopyService,
  ) {}

  /**
   * 4.1 / 4.2 — Lists the available GitHub repos for the requesting account
   * using THEIR OWN stored GitHub PAT, then reconciles against imported platform
   * Repos so the console can mark already-imported entries. Throws the distinct
   * auth-required / retry-able exceptions on the respective failure modes; an
   * empty-but-successful listing returns `[]`.
   */
  async listAvailable(operatorId: string): Promise<AvailableGithubRepo[]> {
    return this.listAvailableWithPat(await this.readOperatorPat(operatorId));
  }

  /**
   * The listing half of {@link listAvailable}, split out so the import path can
   * resolve the account's PAT exactly ONCE and reuse it for both the
   * authorization listing and the repo-store clone header — no second credential
   * read, no second decryption.
   */
  private async listAvailableWithPat(
    pat: string | null,
  ): Promise<AvailableGithubRepo[]> {
    const result = await this.githubRepos.listForOperator(pat);
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
  async listAvailableReconciled(operatorId: string): Promise<
    Array<AvailableGithubRepo & { imported: boolean; importedRepoId: string | null }>
  > {
    const available = await this.listAvailable(operatorId);
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
   * on the originating GitHub numeric id (full_name/normalized URL fallback).
   * Re-import is idempotent and reconciles fresh verified metadata into the
   * existing Repo instead of creating a second row.
   */
  async importRepoForOperator(
    operatorId: string,
    body: ImportRepoRequest,
  ): Promise<RepoResponse> {
    const pat = await this.readOperatorPat(operatorId);
    const available = await this.listAvailableWithPat(pat);
    const accessible = available.find(
      (repo) => repo.id === body.id && repo.full_name === body.full_name,
    );
    if (!accessible) {
      throw new ForbiddenException({
        error: 'github_repo_not_accessible',
        message:
          'The requested GitHub repository is not visible to the connected PAT.',
      });
    }
    // The browser body selects a candidate; it is not the metadata authority.
    // Persist the freshly owner-authenticated GitHub API result so a forged or
    // stale request cannot replace `master` with `main` (or another branch).
    const repo = await this.repos.reconcileVerifiedImport({
      name: this.deriveName(accessible.full_name),
      gitSource: this.deriveGitSource(accessible.full_name),
      forge: 'github',
      defaultBranch: accessible.defaultBranch,
      description: accessible.description ?? null,
      githubId: githubDedupKey(accessible.id),
      legacyGithubId: accessible.full_name,
    });

    // add-repo-content-store: the picker import completes only once the repo
    // store holds a ready bare mirror, cloned here on the API host with the same
    // account PAT the listing above was authorized by (as an http auth header —
    // never in the clone URL). A failure leaves this Repo visible with a
    // non-ready copy status and the copy-refresh retry path.
    return this.copies.acquireOnImport(
      repo,
      pat === null ? undefined : basicAuthHeader('x-access-token', pat),
    );
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
   * Reads the requesting account's OWN stored GitHub PAT by the account primary
   * key `userId` — the SINGLE per-account scope key, present for BOTH local and
   * GitHub accounts (fix-local-account-settings-scope). Returns `null` when the
   * account has no connected `github.com` ForgeCredential, the credential is
   * missing, or decryption fails. The PAT is NEVER returned beyond the server-side
   * GitHub call.
   */
  private async readOperatorPat(operatorId: string): Promise<string | null> {
    const row = await this.prisma.forgeCredential.findUnique({
      where: {
        userId_kind_host: {
          userId: operatorId,
          kind: GITHUB_FORGE_KIND,
          host: GITHUB_FORGE_HOST,
        },
      },
      select: { tokenCiphertext: true },
    });
    return decryptStored(row?.tokenCiphertext);
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

  /**
   * Shapes a Prisma Repo row into the contracts response shape through the
   * SHARED projection, so the GitHub surface exposes the same fields as the
   * console repos surface — including the additive repo-store copy status and
   * timestamp (add-repo-content-store).
   */
  private toResponse(repo: RepoRowProjection): RepoResponse {
    return repoRowToResponse(repo);
  }
}
