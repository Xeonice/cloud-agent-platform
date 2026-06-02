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
    const repo = await this.prisma.repo.create({
      data: {
        name: body.name,
        gitSource: body.gitSource,
      },
    });
    return repoResponseSchema.parse(this.toResponse(repo));
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
   * `RepoSchema.createdAt` is a `Date` (`z.coerce.date()`), so the row's native
   * `Date` is passed through unchanged; the HTTP boundary serializes it to an ISO
   * string on the way out.
   */
  private toResponse(repo: {
    id: string;
    name: string;
    gitSource: string;
    createdAt: Date;
  }): RepoResponse {
    return {
      id: repo.id,
      name: repo.name,
      gitSource: repo.gitSource,
      createdAt: repo.createdAt,
    };
  }
}
