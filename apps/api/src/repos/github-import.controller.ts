import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UsePipes } from '@nestjs/common';
import {
  ImportRepoRequestSchema,
  SetDefaultRepoRequestSchema,
  type AvailableGithubRepo,
  type DefaultRepoResponse,
  type ImportRepoRequest,
  type RepoResponse,
  type SetDefaultRepoRequest,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import {
  GithubAuthorizationRequiredException,
  GithubImportService,
} from './github-import.service';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * GitHub-import REST surface (be-github-import, 4.1–4.5), mounted under `/repos`
 * so it joins the repos module without touching `app.module.ts`.
 *
 * Every route here is session-gated by the GLOBAL `AuthGuard` (an unauthenticated
 * caller gets 401 before reaching these handlers). The handlers additionally
 * require the operator principal to carry a GitHub identity (the numeric
 * `githubId`) so the per-operator stored OAuth token can be resolved server-side:
 * the legacy shared-`AUTH_TOKEN` principal has no GitHub identity and therefore
 * cannot list/import (it gets the distinct `github_auth_required` signal, NOT a
 * session 401). The operator's OAuth token is NEVER part of any response.
 *
 * - `GET  /repos/github/available`     -> 200 available GitHub repos (reconciled
 *                                         with imported), or the distinct
 *                                         github_auth_required / github_unavailable
 *                                         error (never a session 401, never an
 *                                         empty list standing in for failure).
 * - `POST /repos/github/import`        -> 201 created Repo, or 409 when the GitHub
 *                                         repo (by numeric id) is already imported.
 * - `POST /repos/github/default`       -> 200 the new default Repo (clears prior).
 * - `GET  /repos/github/default`       -> 200 `{ repo }` or `{ repo: null }`.
 */
@Controller('repos/github')
export class GithubImportController {
  constructor(private readonly importService: GithubImportService) {}

  @Get('available')
  async listAvailable(
    @Req() req: AuthenticatedRequest,
  ): Promise<Array<AvailableGithubRepo & { imported: boolean; importedRepoId: string | null }>> {
    const operatorGithubId = this.requireGithubId(req);
    return this.importService.listAvailableReconciled(operatorGithubId);
  }

  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(ImportRepoRequestSchema))
  async import(@Body() body: ImportRepoRequest): Promise<RepoResponse> {
    return this.importService.importRepo(body);
  }

  @Post('default')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(SetDefaultRepoRequestSchema))
  async setDefault(@Body() body: SetDefaultRepoRequest): Promise<RepoResponse> {
    return this.importService.setDefault(body.repoId);
  }

  @Get('default')
  async readDefault(): Promise<DefaultRepoResponse> {
    return this.importService.readDefault();
  }

  /**
   * Extracts the requesting operator's immutable numeric GitHub id from the
   * principal the guard attached. A principal without a GitHub identity (the
   * legacy shared-token operator) cannot have a per-operator OAuth token, so it
   * gets the distinct `github_auth_required` signal — NOT a session 401 (the
   * caller IS authenticated to the platform) and NOT a silent empty list.
   */
  private requireGithubId(req: AuthenticatedRequest): number {
    const user = req.operatorPrincipal?.user;
    if (!user) {
      throw new GithubAuthorizationRequiredException();
    }
    return user.githubId;
  }
}
