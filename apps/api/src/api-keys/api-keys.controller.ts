import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import {
  ApiKeyMintRequestSchema,
  type ApiKeyListResponse,
  type ApiKeyMintRequest,
  type ApiKeyMintResponse,
  type ApiKeyRevokeResponse,
  type SessionUser,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { ApiKeysService } from './api-keys.service';

/**
 * API-key management REST surface (api-key-machine-identity, task 5.1), mounted
 * under `/api-keys`.
 *
 * Every route is session-gated TWICE over:
 *   1. the GLOBAL `AuthGuard` first rejects any unauthenticated / de-allowlisted
 *      caller with 401 (no principal reaches these handlers); then
 *   2. {@link requireSessionUser} rejects any principal that is NOT a GitHub-OAuth
 *      `session` — an `api-key`, `legacy-token`, or reserved `mcp` principal is
 *      403'd — so a key can NEVER be used to mint/list/revoke another key (no
 *      privilege-escalation chain, spec "API key CRUD is session-authenticated
 *      only").
 *
 * The handlers read the SESSION user the guard attached and pass its immutable
 * numeric `githubId` to the service, which scopes every operation to THAT account
 * — the body/path can never name a different account.
 *
 * - `POST   /api-keys`      -> 201 the raw `cap_sk_…` key ONCE + metadata (400 on
 *                             an invalid body; nothing minted).
 * - `GET    /api-keys`      -> 200 the caller's keys (non-secret metadata only;
 *                             never the raw key or stored hash).
 * - `DELETE /api-keys/:id`  -> 200 the revoked key's post-revocation list view
 *                             (idempotent; 404 for an unknown / other-account id).
 */
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(ApiKeyMintRequestSchema))
  async mint(
    @Req() req: AuthenticatedRequest,
    @Body() body: ApiKeyMintRequest,
  ): Promise<ApiKeyMintResponse> {
    const user = this.requireSessionUser(req);
    return this.apiKeys.mint(user.githubId, body);
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<ApiKeyListResponse> {
    const user = this.requireSessionUser(req);
    const keys = await this.apiKeys.list(user.githubId);
    return { keys };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ApiKeyRevokeResponse> {
    const user = this.requireSessionUser(req);
    const key = await this.apiKeys.revoke(user.githubId, id);
    return { key };
  }

  /**
   * Enforces that the request is authenticated by a GitHub-OAuth `session`
   * principal and returns its user. Any other principal kind — an `api-key`,
   * the `legacy-token` operator, or a reserved `mcp` machine principal — is
   * rejected with 403, so an API key cannot mint/list/revoke API keys (the
   * no-escalation-chain guarantee). The session user is taken from the
   * guard-attached principal, never from the client.
   */
  private requireSessionUser(req: AuthenticatedRequest): SessionUser {
    const principal = req.operatorPrincipal;
    if (!principal || principal.kind !== 'session' || !principal.user) {
      throw new ForbiddenException({
        error: 'session_required',
        message:
          'API-key management is reachable only by a GitHub-OAuth session; ' +
          'a machine credential cannot mint, list, or revoke API keys.',
      });
    }
    return principal.user;
  }
}
