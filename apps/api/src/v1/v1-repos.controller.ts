import {
  Get,
  Req,
} from '@nestjs/common';
import {
  type V1ListQuery,
  type V1ListReposResponse,
  type RepoResponse,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ReposService } from '../repos/repos.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { listRepoPage } from './public-list-pages';
import {
  PublicV1Controller,
  PublicV1Input,
  PublicV1Operation,
  requirePublicV1Principal,
} from '../public-surface/public-v1-operation';

/**
 * `/v1` repo READ surface (public-v1-api, D1) — additive public data controller
 * delegating to the SAME `ReposService` the console uses. Only the read surface
 * ships in T0 (create/import stays console-only, design open-question).
 *
 * Routes:
 *   - `GET /v1/repos`      — keyset-paginated list, gated by `repos:read`.
 *   - `GET /v1/repos/:id`  — fetch by id, gated by `repos:read`. 404 when unknown.
 *
 * Auth: behind the global auth guard (401 for an unauthenticated caller); each
 * The registry-driven boundary enforces `repos:read` (a scopeless session/legacy
 * principal is allow-all; an api-key missing the scope is 403'd).
 * Registered into the V1Module in Integration (3.6).
 */
@PublicV1Controller('v1/repos')
export class V1ReposController {
  constructor(
    private readonly reposService: ReposService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `GET /v1/repos` — keyset-paginated list ordered by `(createdAt, id)` (D4).
   * Reads the pool directly (read-only) so the cursor query can be composed
   * without mutating `ReposService`. `nextCursor` is null on the last page.
   */
  @Get()
  @PublicV1Operation('repos.list')
  async list(
    @PublicV1Input('query') query: V1ListQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<V1ListReposResponse> {
    requirePublicV1Principal(req, this.list);
    return listRepoPage(this.prisma, query);
  }

  /** `GET /v1/repos/:id` — fetch by id. 404 (NotFoundException) when unknown. */
  @Get(':id')
  @PublicV1Operation('repos.get')
  async findById(
    @PublicV1Input('params', 'id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<RepoResponse> {
    requirePublicV1Principal(req, this.findById);
    return this.reposService.findById(id);
  }
}
