import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import {
  AccountsService,
  AssignRoleSchema,
  CreateAccountSchema,
  ResetPasswordSchema,
  SetEnabledSchema,
  type AccountListItem,
  type AssignRoleInput,
  type CreateAccountInput,
  type ResetPasswordInput,
  type SetEnabledInput,
} from './accounts.service';

/**
 * Admin-only account-administration REST surface (account-administration,
 * tasks 7.1 / 7.2), mounted under `/accounts`.
 *
 * Every route is gated TWICE over:
 *   1. the GLOBAL `AuthGuard` first rejects any unauthenticated / disabled
 *      caller with 401 (no principal reaches these handlers); then
 *   2. {@link requireAdmin} re-confirms the resolved principal is an `allowed`
 *      account whose `role = admin` by reading the live `User` row — a `member`
 *      (or any scopeless machine principal) is 403'd, and a now-disabled or
 *      since-deleted account fails closed, BEFORE any service method runs. So a
 *      non-admin can never create, mutate, or even list accounts (account-
 *      administration: "A non-admin principal invoking any management operation
 *      SHALL be denied (403)").
 *
 * `role` here gates ONLY this admin panel; it grants NO execution privilege (every
 * allowed account is host-root), per the change's explicit non-goal.
 *
 * Routes (all admin-gated):
 *   - `GET   /accounts`               -> 200 all accounts,
 *                                        non-secret rows for the admin table.
 *   - `POST  /accounts`               -> 201 the created account (no secret).
 *   - `PATCH /accounts/:id/enabled`   -> 200 the account after the `allowed` flip
 *                                        (works for every account row).
 *   - `PATCH /accounts/:id/password`  -> 200 after rotating an account password
 *                                        (400 when the row has no password identity).
 *   - `PATCH /accounts/:id/role`      -> 200 after assigning the role.
 */
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<{ accounts: AccountListItem[] }> {
    await this.requireAdmin(req);
    const accounts = await this.accounts.list();
    return { accounts };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(CreateAccountSchema))
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateAccountInput,
  ): Promise<AccountListItem> {
    await this.requireAdmin(req);
    return this.accounts.create(body);
  }

  @Patch(':id/enabled')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(SetEnabledSchema))
  async setEnabled(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: SetEnabledInput,
  ): Promise<AccountListItem> {
    await this.requireAdmin(req);
    return this.accounts.setEnabled(id, body.allowed);
  }

  @Patch(':id/password')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ResetPasswordSchema))
  async resetPassword(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ResetPasswordInput,
  ): Promise<AccountListItem> {
    await this.requireAdmin(req);
    return this.accounts.resetPassword(id, body.password);
  }

  @Patch(':id/role')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(AssignRoleSchema))
  async assignRole(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: AssignRoleInput,
  ): Promise<AccountListItem> {
    await this.requireAdmin(req);
    return this.accounts.assignRole(id, body.role);
  }

  /**
   * Enforce that the request is an `allowed`, `role = admin` account, re-confirmed
   * against the LIVE `User` row (not cached on the principal) so a just-demoted or
   * just-disabled admin loses panel access on the very next request — fail-closed.
   *
   * The account is located from the guard-attached principal's resolved user, never
   * from the client: by the internal user `id` when the principal carries one (the
   * IdentityLink-era session/local principal), else by the immutable `githubId`
   * (a github/api-key principal). A principal with no resolved user (the legacy
   * shared-token operator, or a reserved/unbound machine kind) carries no account
   * and is denied. Any account that cannot be resolved, is not `allowed`, or is not
   * `admin` is 403'd before any mutation.
   */
  private async requireAdmin(req: AuthenticatedRequest): Promise<void> {
    const principal = req.operatorPrincipal;
    const user = principal?.user;
    if (!principal || !user) {
      throw this.adminDenied();
    }

    // Prefer the internal user id (IdentityLink era); fall back to the immutable
    // numeric githubId for a github/api-key principal. Either resolves the SAME row.
    const where = resolveAccountWhere(user);
    if (where === null) {
      throw this.adminDenied();
    }

    const account = await this.prisma.user.findUnique({
      where,
      select: { role: true, allowed: true },
    });
    if (!account || account.allowed !== true || account.role !== 'admin') {
      throw this.adminDenied();
    }
  }

  private adminDenied(): ForbiddenException {
    return new ForbiddenException({
      error: 'admin_required',
      message: 'Account administration requires an admin account.',
    });
  }
}

/**
 * Resolve the unique `User` lookup for a principal's resolved user: by internal
 * `id` when present (the provider-agnostic key under IdentityLink), else by the
 * immutable numeric `githubId`. Returns `null` when neither identifying field is
 * present so the caller can fail closed.
 */
function resolveAccountWhere(
  user: { id?: string; githubId?: number | null },
): { id: string } | { githubId: number } | null {
  if (typeof user.id === 'string' && user.id.length > 0) {
    return { id: user.id };
  }
  if (typeof user.githubId === 'number') {
    return { githubId: user.githubId };
  }
  return null;
}
