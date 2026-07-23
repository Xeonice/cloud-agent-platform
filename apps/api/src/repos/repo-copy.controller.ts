import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import {
  LocalRepoImportRequestSchema,
  type LocalRepoImportAvailability,
  type LocalRepoImportRequest,
  type RepoResponse,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { requireConsoleAccountId } from './console-account';
import { LocalRepoImportService } from './local-import.service';
import { RepoCopyService } from './repo-copy.service';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * Console-internal repository CONTENT surface (add-repo-content-store).
 *
 * A second controller under the same `repos` prefix (the pattern
 * `GithubImportController` already uses) so these routes join the repos module
 * without touching `app.module.ts` or the existing controller's constructor.
 *
 * - `GET  /repos/local-import/availability` -> 200 whether local-path import is
 *                                              enabled, plus the configured root
 *                                              and the variable that enables it.
 * - `POST /repos/local-import`              -> 201 the imported Repo with a ready
 *                                              copy, or a typed gate/copy failure.
 * - `POST /repos/:repoId/refresh-copy`      -> 200 the Repo after re-acquiring or
 *                                              fetching its content copy.
 *
 * These stay OUT of `/v1` and the MCP tool surface on purpose: copy freshness is
 * user-managed operator work, not a machine-surface capability. Every route is
 * session-gated by the global `AuthGuard`; the writes additionally require a
 * human Console session ({@link requireConsoleAccountId}).
 */
@Controller('repos')
export class RepoCopyController {
  constructor(
    private readonly copies: RepoCopyService,
    private readonly localImport: LocalRepoImportService,
  ) {}

  /**
   * Declared BEFORE any single-segment `:id` route in this controller so the
   * literal path can never be captured as a repo id.
   */
  @Get('local-import/availability')
  availability(): LocalRepoImportAvailability {
    // An ordinary authenticated read — the global `AuthGuard` already rejected
    // anonymous callers. The console needs it BEFORE any write to decide whether
    // to offer the local-path mode at all, so it is deliberately not gated on the
    // stricter Console-session write boundary.
    return this.localImport.availability();
  }

  @Post('local-import')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(LocalRepoImportRequestSchema))
  async importLocal(
    @Req() req: AuthenticatedRequest,
    @Body() body: LocalRepoImportRequest,
  ): Promise<RepoResponse> {
    requireConsoleAccountId(req);
    return this.localImport.import(body);
  }

  @Post(':repoId/refresh-copy')
  @HttpCode(HttpStatus.OK)
  async refreshCopy(
    @Req() req: AuthenticatedRequest,
    @Param('repoId') repoId: string,
  ): Promise<RepoResponse> {
    return this.copies.refreshCopy(requireConsoleAccountId(req), repoId);
  }
}
