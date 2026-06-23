import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UsePipes,
} from '@nestjs/common';
import {
  ConnectForgeCredentialRequestSchema,
  DiscoverModelsRequestSchema,
  ForgeKindSchema,
  RegisterForgeConnectionRequestSchema,
  SaveClaudeCredentialRequestSchema,
  SaveCodexCredentialRequestSchema,
  UpdateMcpServerSettingsRequestSchema,
  UpdateSettingsRequestSchema,
  type AccountSettings,
  type AvailableForgeRepo,
  type ClaudeCredential,
  type CodexCredential,
  type CodexDeviceLoginStartResponse,
  type CodexDeviceLoginStatus,
  type ConnectForgeCredentialRequest,
  type DiscoverModelsRequest,
  type DiscoverModelsResponse,
  type ForgeConnection,
  type ForgeCredential,
  type McpServerSettings,
  type RegisterForgeConnectionRequest,
  type SaveClaudeCredentialRequest,
  type SaveCodexCredentialRequest,
  type SessionUser,
  type UpdateMcpServerSettingsRequest,
  type UpdateSettingsRequest,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { isAdminPrincipal } from '../auth/admin';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { SettingsService } from './settings.service';
import { CodexDeviceLoginService } from './codex-device-login.service';
import { ForgeCredentialService } from './forge-credential.service';

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
 *                                      read-only. May also carry the
 *                                      SYSTEM-LEVEL `maxConcurrentTasks` slot
 *                                      ceiling (configurable-task-slots): the
 *                                      shared `UpdateSettingsRequestSchema`
 *                                      pipe rejects out-of-range/non-integer
 *                                      values 400 BEFORE the handler (nothing
 *                                      mutated); a valid save persists the one
 *                                      system-wide value and takes effect
 *                                      immediately, no restart.
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
  constructor(
    private readonly settings: SettingsService,
    private readonly deviceLogin: CodexDeviceLoginService,
    private readonly forge: ForgeCredentialService,
  ) {}

  // ---------------------------------------------------------------------------
  // Forge (code-hosting) connection credentials (add-forge-credentials)
  // ---------------------------------------------------------------------------

  /** Secret-free list of the operator's connected forges. */
  @Get('forges')
  async listForges(@Req() req: AuthenticatedRequest): Promise<ForgeCredential[]> {
    return this.forge.list(this.requireOperator(req));
  }

  /** Import picker: list repos the connected forge credential can access. */
  @Get('forges/repos')
  async listForgeRepos(
    @Req() req: AuthenticatedRequest,
    @Query('kind') kindRaw: string,
    @Query('host') host?: string,
  ): Promise<AvailableForgeRepo[]> {
    const kind = ForgeKindSchema.safeParse(kindRaw);
    if (!kind.success) {
      throw new BadRequestException({
        error: 'forge_kind_invalid',
        message: 'A valid `kind` query parameter (github|gitlab|gitee) is required.',
      });
    }
    return this.forge.listAvailableRepos(this.requireOperator(req), kind.data, host);
  }

  /** Connect a forge by validating + storing an encrypted PAT. */
  @Put('forges')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ConnectForgeCredentialRequestSchema))
  async connectForge(
    @Req() req: AuthenticatedRequest,
    @Body() body: ConnectForgeCredentialRequest,
  ): Promise<ForgeCredential> {
    return this.forge.connect(this.requireOperator(req), body);
  }

  /** Disconnect a forge credential (exact kind + host from the list). */
  @Delete('forges')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnectForge(
    @Req() req: AuthenticatedRequest,
    @Query('kind') kindRaw: string,
    @Query('host') host: string,
  ): Promise<void> {
    const kind = ForgeKindSchema.safeParse(kindRaw);
    if (!kind.success || typeof host !== 'string' || host.length === 0) {
      throw new BadRequestException({
        error: 'forge_disconnect_invalid',
        message: 'A valid `kind` and `host` query parameter are required.',
      });
    }
    await this.forge.disconnect(this.requireOperator(req), kind.data, host);
  }

  /** List registered self-hosted forge connections (deployment infra config). */
  @Get('forge-connections')
  async listForgeConnections(
    @Req() req: AuthenticatedRequest,
  ): Promise<ForgeConnection[]> {
    this.requireOperator(req);
    return this.forge.listConnections();
  }

  /** Register (or update) a self-hosted forge connection. */
  @Post('forge-connections')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RegisterForgeConnectionRequestSchema))
  async registerForgeConnection(
    @Req() req: AuthenticatedRequest,
    @Body() body: RegisterForgeConnectionRequest,
  ): Promise<ForgeConnection> {
    this.requireOperator(req);
    return this.forge.registerConnection(body);
  }

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

  @Get('claude')
  async readClaude(
    @Req() req: AuthenticatedRequest,
  ): Promise<ClaudeCredential> {
    return this.settings.readClaudeCredential(this.requireOperator(req));
  }

  @Put('claude')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(SaveClaudeCredentialRequestSchema))
  async saveClaude(
    @Req() req: AuthenticatedRequest,
    @Body() body: SaveClaudeCredentialRequest,
  ): Promise<ClaudeCredential> {
    return this.settings.saveClaudeCredential(this.requireOperator(req), body);
  }

  @Post('codex/models')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(DiscoverModelsRequestSchema))
  async discoverModels(
    @Req() req: AuthenticatedRequest,
    @Body() body: DiscoverModelsRequest,
  ): Promise<DiscoverModelsResponse> {
    return this.settings.discoverModels(
      this.requireOperator(req),
      body.baseUrl,
      body.apiKey,
    );
  }

  /**
   * remote-mcp-server 5.2 — Reads the SYSTEM-LEVEL `mcpServerEnabled` flag.
   * ADMIN-gated: only an explicitly-allowlisted admin operator may observe the
   * toggle state (mirroring the self-update admin gate). A non-admin session or a
   * machine principal (mcp / api-key) is rejected 403 BEFORE the service runs.
   * The flag is instance-wide, so this is NOT account-scoped.
   */
  @Get('mcp-server')
  async readMcpServer(
    @Req() req: AuthenticatedRequest,
  ): Promise<McpServerSettings> {
    this.requireAdmin(req);
    return this.settings.readMcpServerSettings();
  }

  /**
   * remote-mcp-server 5.2 — Flips the SYSTEM-LEVEL `mcpServerEnabled` flag.
   * ADMIN-gated identically to the read: only an admin may turn the `/mcp`
   * surface on/off; a non-admin session or a machine principal is 403 and nothing
   * is mutated. The shared `UpdateMcpServerSettingsRequestSchema` pipe rejects a
   * malformed body 400 before the handler. Turning it off stops new `/mcp` use
   * without deleting any minted token.
   */
  @Put('mcp-server')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(UpdateMcpServerSettingsRequestSchema))
  async updateMcpServer(
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdateMcpServerSettingsRequest,
  ): Promise<McpServerSettings> {
    this.requireAdmin(req);
    return this.settings.setMcpServerEnabled(body.mcpServerEnabled);
  }

  /**
   * Start an OFFICIAL-account OAuth device-code login: provisions a transient
   * codex container, launches `codex login --device-auth`, and returns the OpenAI
   * verification URL + one-time code for the operator to authorize. The client
   * then polls `GET /settings/codex/device-login`.
   */
  @Post('codex/device-login')
  @HttpCode(HttpStatus.OK)
  async startDeviceLogin(
    @Req() req: AuthenticatedRequest,
  ): Promise<CodexDeviceLoginStartResponse> {
    return this.deviceLogin.start(this.requireOperator(req));
  }

  /** Poll the in-flight device login; `connected` once the credential is stored. */
  @Get('codex/device-login')
  async pollDeviceLogin(
    @Req() req: AuthenticatedRequest,
  ): Promise<CodexDeviceLoginStatus> {
    return this.deviceLogin.pollStatus(this.requireOperator(req));
  }

  /** Cancel + reclaim the in-flight device login (operator dismissed the dialog). */
  @Delete('codex/device-login')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelDeviceLogin(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.deviceLogin.cancel(this.requireOperator(req));
  }

  /**
   * Extracts the authenticated account the guard attached. Any authenticated
   * account — LOCAL (password/OTP) or GitHub — has per-account settings, scoped on
   * its account primary key `user.id` (fix-local-account-settings-scope), so the
   * GitHub identity is no longer required. Only an IDENTITY-LESS principal (a
   * machine/legacy token with `user === null`) has no per-account settings and is
   * rejected here, mirroring the service's defensive account-scope guard.
   */
  private requireOperator(req: AuthenticatedRequest): SessionUser {
    const user = req.operatorPrincipal?.user;
    if (!user) {
      // Per-account settings require an authenticated account; reject the
      // identity-less machine/legacy principal rather than leak a shared row.
      throw new BadRequestException({
        error: 'account_scope_required',
        message: 'Account settings are per-account and require an authenticated account.',
      });
    }
    return user;
  }

  /**
   * remote-mcp-server 5.2/5.3 — Narrows the guard-attached principal to an
   * explicitly-allowlisted ADMIN *session*. The global `AuthGuard` has already
   * 401'd an unauthenticated / de-allowlisted caller and attached the resolved
   * principal; this re-narrows on TWO independent conditions so the toggle is
   * never read or mutated by the wrong caller:
   *
   *   1. it MUST be a GitHub-OAuth `session` principal — a MACHINE credential
   *      (`mcp` / `api-key`) or the identity-less `legacy-token` operator is
   *      rejected 403 even if its owner is on the admin allowlist, so the
   *      outward-facing execution surface can never be flipped by a machine
   *      credential (no-escalation, mirroring the API-key CRUD gate); and
   *   2. it MUST be an explicitly-allowlisted admin
   *      ({@link isAdminPrincipal} / `SELF_UPDATE_ADMINS`, the same narrow admin
   *      set the host-root self-update uses) — a merely-logged-in non-admin
   *      operator is rejected 403.
   *
   * "Who may flip the MCP server" is therefore the narrow ADMIN-SESSION set, not
   * any operator and never a machine credential.
   */
  private requireAdmin(req: AuthenticatedRequest): void {
    const principal = req.operatorPrincipal;
    if (
      !principal ||
      principal.kind !== 'session' ||
      !isAdminPrincipal(principal)
    ) {
      throw new ForbiddenException({
        error: 'admin_required',
        message:
          'Toggling the MCP server requires an admin operator session ' +
          '(SELF_UPDATE_ADMINS); a non-admin or a machine credential cannot.',
      });
    }
  }
}
