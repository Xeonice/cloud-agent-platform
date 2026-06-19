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
  McpTokenMintRequestSchema,
  type McpTokenListResponse,
  type McpTokenMintRequest,
  type McpTokenMintResponse,
  type McpTokenRevokeResponse,
  type SessionUser,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { McpTokensService } from './mcp-tokens.service';

/**
 * MCP-token CRUD surface (remote-mcp-server, task 3.6), mounted under
 * `/mcp-tokens`.
 *
 * Every route is gated by the GLOBAL `AuthGuard`, but these endpoints are
 * additionally restricted to a GitHub-OAuth `session` principal: a MACHINE
 * credential (an `mcp` token, or a future `api-key`) MUST NOT be able to mint,
 * list, or revoke MCP tokens — a credential cannot mint another (task 3.7 / D7).
 * {@link requireSessionOperator} enforces this with a 403 BEFORE any service
 * call, so a non-session principal performs no read/write.
 *
 * The handlers resolve the session operator the guard attached and pass their
 * immutable `githubId` to the service, which scopes every mint/list/revoke to
 * THAT operator's own tokens — an operator can only manage their own.
 *
 * - `POST   /mcp-tokens`        -> 201 the show-once raw `mcp_` token + metadata.
 * - `GET    /mcp-tokens`        -> 200 the operator's tokens (prefix + last4 only).
 * - `DELETE /mcp-tokens/:id`    -> 200 the post-revocation list view (idempotent).
 */
@Controller('mcp-tokens')
export class McpTokensController {
  constructor(private readonly tokens: McpTokensService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(McpTokenMintRequestSchema))
  async mint(
    @Req() req: AuthenticatedRequest,
    @Body() body: McpTokenMintRequest,
  ): Promise<McpTokenMintResponse> {
    const operator = this.requireSessionOperator(req);
    return this.tokens.mint(operator.githubId, {
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt ?? null,
    });
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<McpTokenListResponse> {
    const operator = this.requireSessionOperator(req);
    const tokens = await this.tokens.list(operator.githubId);
    return { tokens };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<McpTokenRevokeResponse> {
    const operator = this.requireSessionOperator(req);
    const token = await this.tokens.revoke(operator.githubId, id);
    if (token === null) {
      // Revocation is idempotent and own-scoped; an unknown/foreign id is simply
      // not the caller's token. Surface a 403 rather than reveal existence.
      throw new ForbiddenException('No such MCP token for this operator');
    }
    return { token };
  }

  /**
   * Requires the attached principal to be a GitHub-OAuth `session` operator and
   * returns its {@link SessionUser}. A machine credential (an `mcp` token, which
   * the guard resolves via the prefix-routed `resolveMcp` slot of
   * `resolveOperatorPrincipal` to an `operatorPrincipal` of kind `'mcp'`, or a
   * `cap_sk_` api-key of kind `'api-key'`) and the legacy shared-token operator
   * (no GitHub identity, `kind === 'legacy-token'`, `user === null`) are ALL
   * rejected with 403 — a credential cannot mint/list/revoke another (task 3.7).
   * The single `kind !== 'session'` check covers every non-session principal, so
   * a machine credential never reaches the service: the check runs BEFORE any
   * service call, so a rejected request performs no state change.
   */
  private requireSessionOperator(req: AuthenticatedRequest): SessionUser {
    const principal = req.operatorPrincipal;
    if (!principal || principal.kind !== 'session' || principal.user === null) {
      throw McpTokensController.sessionOperatorRequired();
    }
    return principal.user;
  }

  /** The shared 403 for a non-session principal on the MCP-token CRUD. */
  private static sessionOperatorRequired(): ForbiddenException {
    return new ForbiddenException({
      error: 'session_operator_required',
      message:
        'MCP tokens may only be managed by a GitHub-OAuth operator session; ' +
        'a machine credential cannot mint, list, or revoke another.',
    });
  }
}
