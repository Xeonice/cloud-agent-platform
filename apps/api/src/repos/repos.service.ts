import { Injectable, NotFoundException } from '@nestjs/common';
import { repoResponseSchema, type CreateRepoBody, type RepoResponse } from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Repository persistence + read service. Every value returned to a controller is
 * re-validated against the contracts `repoResponseSchema` so the response body
 * is guaranteed to match the shared contract (a defensive check against schema
 * drift between Prisma and contracts).
 */
@Injectable()
export class ReposService {
  constructor(private readonly prisma: PrismaService) {}

  async create(body: CreateRepoBody): Promise<RepoResponse> {
    // add-multi-forge-task-delivery: record the source forge (explicit, or
    // inferred from the gitSource public host). Self-hosted hosts must supply it.
    const forge = body.forge ?? ReposService.inferForge(body.gitSource);
    const repo = await this.prisma.repo.create({
      data: {
        name: body.name,
        gitSource: body.gitSource,
        forge,
      },
    });
    return repoResponseSchema.parse(this.toResponse(repo));
  }

  /** Infer the forge from a gitSource public host, or null (self-hosted/unknown). */
  private static inferForge(gitSource: string): string | null {
    try {
      const host = new URL(gitSource).host.toLowerCase();
      if (host === 'github.com') return 'github';
      if (host === 'gitlab.com') return 'gitlab';
      if (host === 'gitee.com') return 'gitee';
    } catch {
      // non-url gitSource → unknown
    }
    return null;
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
   * The GitHub-import metadata fields (`description`, `defaultBranch`,
   * `branchCount`, `updatedAt`, `githubId`) are surfaced on every read path
   * (list / fetch-by-id) exactly as persisted: the originating GitHub value when
   * the repo was imported, or `null` for plain `gitSource`-only repos. They are
   * never fabricated — a repo created via `POST /repos` (no GitHub import) carries
   * `null` for all five, which `RepoSchema` accepts as nullable/optional.
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
