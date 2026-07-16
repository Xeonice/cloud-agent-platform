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
 * require an authenticated ACCOUNT principal — scoped on its primary key
 * `user.id` (present for BOTH local and GitHub accounts,
 * fix-local-account-settings-scope) — so the account's OWN connected GitHub PAT
   * can be resolved server-side by `userId`. An external login identity is NOT
   * required at the boundary: a LOCAL account (password/OTP) that has connected a
 * GitHub PAT can list/import too. Only the IDENTITY-LESS legacy shared-`AUTH_TOKEN`
 * / machine principal (no account at all) — or any account lacking a usable
 * GitHub PAT — gets the distinct `github_auth_required` signal, NOT a session
 * 401. The account's PAT is NEVER part of any response.
 *
 * - `GET  /repos/github/available`     -> 200 available GitHub repos (reconciled
 *                                         with imported), or the distinct
 *                                         github_auth_required / github_unavailable
 *                                         error (never a session 401, never an
 *                                         empty list standing in for failure).
 * - `POST /repos/github/import`        -> 201 created or idempotently reconciled
 *                                         Repo (by stable GitHub identity).
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
    const operatorId = this.requireAccountId(req);
    return this.importService.listAvailableReconciled(operatorId);
  }

  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(ImportRepoRequestSchema))
  async import(
    @Req() req: AuthenticatedRequest,
    @Body() body: ImportRepoRequest,
  ): Promise<RepoResponse> {
    return this.importService.importRepoForOperator(this.requireAccountId(req), body);
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
   * Extracts the requesting account's primary key `user.id` — the SINGLE
   * per-account scope key (present for BOTH local and GitHub accounts,
   * fix-local-account-settings-scope), used downstream to resolve the account's
   * OWN connected GitHub PAT by `userId`.
   *
   * The GitHub identity is not required HERE: a LOCAL account (password/OTP,
   * `githubId === null`) that has separately connected a GitHub PAT can import
   * too. Whether a usable GitHub PAT actually exists for the account is decided
   * downstream — a missing/expired PAT still yields the distinct
   * `github_auth_required` signal (NOT a session 401, NOT a silent empty list).
   *
   * This boundary gate is retained ONLY for the IDENTITY-LESS principal (a
   * machine/legacy token with `user === null`), which has no account at all and
   * therefore no per-account GitHub PAT to import with.
   */
  private requireAccountId(req: AuthenticatedRequest): string {
    const user = req.operatorPrincipal?.user;
    if (!user) {
      // No authenticated account at all (the legacy shared-token / machine
      // principal): there is no per-account GitHub PAT to import with, so
      // it gets the distinct `github_auth_required` signal rather than a 401.
      throw new GithubAuthorizationRequiredException();
    }
    return user.id;
  }
}
