import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import {
  PublicV1IdParamsSchema,
  V1ListQuerySchema,
  type V1ListQuery,
  type V1ListReposResponse,
  type RepoResponse,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ReposService } from '../repos/repos.service';
import {
  hasScope,
  type OperatorPrincipal,
} from '../auth/operator-principal';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { zodParam, zodQuery } from '../repos/zod-validation.pipe';
import { listRepoPage } from './public-list-pages';

/**
 * `/v1` repo READ surface (public-v1-api, D1) — additive `@Controller('v1/...')`
 * delegating to the SAME `ReposService` the console uses. Only the read surface
 * ships in T0 (create/import stays console-only, design open-question).
 *
 * Routes:
 *   - `GET /v1/repos`      — keyset-paginated list, gated by `repos:read`.
 *   - `GET /v1/repos/:id`  — fetch by id, gated by `repos:read`. 404 when unknown.
 *
 * Auth: behind the global auth guard (401 for an unauthenticated caller); each
 * handler enforces `repos:read` on the guard-attached principal (a scopeless
 * session/legacy principal is allow-all; an api-key missing the scope is 403'd).
 * Registered into the V1Module in Integration (3.6).
 */
@Controller('v1/repos')
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
  async list(
    @Query(zodQuery(V1ListQuerySchema)) query: V1ListQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<V1ListReposResponse> {
    this.requireScope(req, 'repos:read');
    return listRepoPage(this.prisma, query);
  }

  /** `GET /v1/repos/:id` — fetch by id. 404 (NotFoundException) when unknown. */
  @Get(':id')
  async findById(
    @Param('id', zodParam(PublicV1IdParamsSchema.shape.id)) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<RepoResponse> {
    this.requireScope(req, 'repos:read');
    return this.reposService.findById(id);
  }

  /**
   * Reads the guard-attached principal and enforces the required scope (task 3.4).
   * A scopeless principal (session/legacy) is allow-all; a scoped principal
   * missing `required` is 403'd (distinct from the guard's 401 for no credential).
   */
  private requireScope(
    req: AuthenticatedRequest,
    required: Parameters<typeof hasScope>[1],
  ): OperatorPrincipal {
    const principal = req.operatorPrincipal;
    if (!principal) {
      throw new ForbiddenException('Missing operator principal');
    }
    if (!hasScope(principal, required)) {
      throw new ForbiddenException(`Insufficient scope: ${required} required`);
    }
    return principal;
  }
}
