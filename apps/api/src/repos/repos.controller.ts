import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import { createRepoBodySchema, type CreateRepoBody, type RepoResponse } from '@cap/contracts';
import { type AuthenticatedRequest } from '../auth/auth.guard';
import { hasScope } from '../auth/operator-principal';
import { ReposService } from './repos.service';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * REST surface for repositories.
 *
 * - `POST /repos`     -> 201 with the created repo (400 if the body fails the
 *                        contracts schema; no record is created).
 * - `GET  /repos`     -> 200 with the list of repos.
 * - `GET  /repos/:id` -> 200 with the repo, or 404 when it does not exist.
 *
 * Scopes (api-key-machine-identity, route-integration 6.2): the `GET /repos`
 * list route requires the `repos:read` scope. A principal that carries scopes
 * (an api-key) is admitted only when its scopes include `repos:read`; otherwise
 * the request is rejected with 403 (insufficient scope), distinct from the
 * guard's 401. A scopeless principal (a GitHub session or the legacy operator
 * token) has `scopes === undefined`, which {@link hasScope} treats as allow-all,
 * so existing console behavior is unchanged.
 */
@Controller('repos')
export class ReposController {
  constructor(private readonly reposService: ReposService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(createRepoBodySchema))
  async create(@Body() body: CreateRepoBody): Promise<RepoResponse> {
    return this.reposService.create(body);
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<RepoResponse[]> {
    if (!hasScope(req.operatorPrincipal, 'repos:read')) {
      throw new ForbiddenException('Insufficient scope: repos:read required');
    }
    return this.reposService.list();
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<RepoResponse> {
    return this.reposService.findById(id);
  }
}
