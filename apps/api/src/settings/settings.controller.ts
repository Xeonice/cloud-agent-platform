import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  Req,
  UsePipes,
} from '@nestjs/common';
import { z } from 'zod';
import {
  SaveCodexCredentialRequestSchema,
  UpdateSettingsRequestSchema,
  type AccountSettings,
  type CodexCredential,
  type SaveCodexCredentialRequest,
  type SessionUser,
  type UpdateSettingsRequest,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { SettingsService } from './settings.service';
import type { ModelDiscoveryResult } from './model-discovery.client';

/**
 * Body for the candidate model-discovery probe (task 7.6). A base URL + key are
 * supplied so a compatible provider can be validated BEFORE persisting; nothing
 * is stored. Declared locally (no read shape on the wire) and validated by the
 * shared {@link ZodValidationPipe}.
 */
export const DiscoverModelsRequestSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
});
export type DiscoverModelsRequest = z.infer<typeof DiscoverModelsRequestSchema>;

/**
 * Account-settings REST surface (account-settings, tasks 7.2–7.6), mounted under
 * `/settings`.
 *
 * Every route is session-gated by the GLOBAL `AuthGuard` (an unauthenticated /
 * de-allowlisted caller gets 401 before reaching these handlers). The handlers
 * resolve the operator principal the guard attached and pass it to the service,
 * which scopes every read/write to THAT account by the immutable numeric
 * `githubId` — settings never leak across accounts and the body can never name
 * a different account.
 *
 * - `GET   /settings`               -> 200 the account's preferences (defaults
 *                                      when unsaved); `allowedAccount` is the
 *                                      read-only OAuth-sourced identity.
 * - `PATCH /settings` / `PUT`       -> 200 updated sanitized preferences; a
 *                                      defaultRepoId MUST be imported (else 4xx,
 *                                      nothing mutated); allowedAccount is
 *                                      read-only.
 * - `GET   /settings/codex`         -> 200 the secret-free Codex credential
 *                                      (mode + state + hasApiKey + masked suffix).
 * - `PUT   /settings/codex`         -> 200 saves the credential (modes mutually
 *                                      exclusive; key encrypted at rest).
 * - `POST  /settings/codex/models`  -> 200 discovered models for a CANDIDATE
 *                                      provider (no persistence), or a
 *                                      distinguishable provider error.
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async read(@Req() req: AuthenticatedRequest): Promise<AccountSettings> {
    return this.settings.readSettings(this.requireOperator(req));
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(UpdateSettingsRequestSchema))
  async patch(
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdateSettingsRequest,
  ): Promise<AccountSettings> {
    return this.settings.updateSettings(this.requireOperator(req), body);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(UpdateSettingsRequestSchema))
  async put(
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdateSettingsRequest,
  ): Promise<AccountSettings> {
    return this.settings.updateSettings(this.requireOperator(req), body);
  }

  @Get('codex')
  async readCodex(@Req() req: AuthenticatedRequest): Promise<CodexCredential> {
    return this.settings.readCredential(this.requireOperator(req));
  }

  @Put('codex')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(SaveCodexCredentialRequestSchema))
  async saveCodex(
    @Req() req: AuthenticatedRequest,
    @Body() body: SaveCodexCredentialRequest,
  ): Promise<CodexCredential> {
    return this.settings.saveCredential(this.requireOperator(req), body);
  }

  @Post('codex/models')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(DiscoverModelsRequestSchema))
  async discoverModels(
    @Req() req: AuthenticatedRequest,
    @Body() body: DiscoverModelsRequest,
  ): Promise<ModelDiscoveryResult> {
    return this.settings.discoverModels(
      this.requireOperator(req),
      body.baseUrl,
      body.apiKey,
    );
  }

  /**
   * Extracts the GitHub-identity operator the guard attached. The legacy
   * shared-token operator has no GitHub identity (`user === null`) and therefore
   * no per-account settings; the service rejects it, but we surface the missing
   * identity here too so the per-account contract is explicit at the boundary.
   */
  private requireOperator(req: AuthenticatedRequest): SessionUser {
    const user = req.operatorPrincipal?.user;
    if (!user) {
      // Per-account settings require a GitHub-identity session; mirror the
      // service's account-scope guard rather than leak a shared row.
      throw new BadRequestException({
        error: 'account_scope_required',
        message:
          'Account settings are per-account and require a GitHub-identity ' +
          'operator session.',
      });
    }
    return user;
  }
}
