import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UsePipes,
} from '@nestjs/common';
import { createRepoBodySchema, type CreateRepoBody, type RepoResponse } from '@cap/contracts';
import { ReposService } from './repos.service';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * REST surface for repositories.
 *
 * - `POST /repos`     -> 201 with the created repo (400 if the body fails the
 *                        contracts schema; no record is created).
 * - `GET  /repos`     -> 200 with the list of repos.
 * - `GET  /repos/:id` -> 200 with the repo, or 404 when it does not exist.
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
  async list(): Promise<RepoResponse[]> {
    return this.reposService.list();
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<RepoResponse> {
    return this.reposService.findById(id);
  }
}
