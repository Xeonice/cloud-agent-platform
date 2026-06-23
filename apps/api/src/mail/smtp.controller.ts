import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import {
  SaveSmtpConfigRequestSchema,
  TestSmtpConfigRequestSchema,
  type SaveSmtpConfigRequest,
  type SmtpConfigRead,
  type TestSmtpConfigRequest,
  type TestSmtpConfigResponse,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { SmtpConfigService } from './smtp-config.service';

/**
 * Admin-only deployment-level SMTP configuration surface (add-smtp-config-ui,
 * task 4.1), mounted under `/settings/smtp`.
 *
 * SMTP is a SINGLE deployment-wide config (not per-account, unlike the Codex/forge
 * credentials), so every route is double-gated and operates on the one singleton
 * row resolved by {@link SmtpConfigService}:
 *
 *   1. the GLOBAL `AuthGuard` first 401s any unauthenticated / de-allowlisted
 *      caller (no principal reaches these handlers); then
 *   2. {@link requireAdmin} re-confirms the resolved principal is an `allowed`
 *      account whose `role = admin` by reading the LIVE `User` row — reusing the
 *      account-administration admin gate verbatim — so a `member`, a machine
 *      principal (api-key / mcp), the identity-less legacy operator, or a
 *      just-demoted/just-disabled admin is 403'd BEFORE any read, save, or
 *      test-send runs (spec: "A non-admin ... SHALL be denied").
 *
 * Routes (all admin-gated):
 *   - `GET  /settings/smtp`        -> 200 the MASKED config (host/port/user/from +
 *                                     passLast4 + hasPassword); NEVER the plaintext
 *                                     password.
 *   - `PUT  /settings/smtp`        -> 200 the masked config after saving (the
 *                                     password is encrypted at rest by the service;
 *                                     a save with no encryption key fails closed).
 *   - `POST /settings/smtp/test`   -> 200 `{ ok, message }` after sending a test
 *                                     email to the requesting admin's OWN account
 *                                     email through the submitted (or saved)
 *                                     config. Nothing is persisted on failure and
 *                                     the password is never returned.
 */
@Controller('settings/smtp')
export class SmtpController {
  constructor(
    private readonly smtp: SmtpConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Masked read — host/port/user/from + masked suffix, never the plaintext pass. */
  @Get()
  async read(@Req() req: AuthenticatedRequest): Promise<SmtpConfigRead> {
    await this.requireAdmin(req);
    // The storage service returns null when the singleton row has never been
    // saved; the wire contract (`SmtpConfigRead`) is non-nullable, so an unset
    // config surfaces as a masked projection with empty non-secret fields and no
    // stored password. This lets the admin UI render the unconfigured state
    // uniformly without a separate "does it exist" probe.
    return (await this.smtp.readConfig()) ?? EMPTY_SMTP_CONFIG_READ;
  }

  /**
   * Save the SMTP config. The service encrypts the submitted password at rest and
   * fails closed when no encryption key is configured; the returned projection is
   * masked (no plaintext password).
   */
  @Put()
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(SaveSmtpConfigRequestSchema))
  async save(
    @Req() req: AuthenticatedRequest,
    @Body() body: SaveSmtpConfigRequest,
  ): Promise<SmtpConfigRead> {
    await this.requireAdmin(req);
    return this.smtp.saveConfig(body);
  }

  /**
   * Test-send: send a real email to the requesting admin's OWN account email,
   * using the submitted candidate config (falling back to the saved/decrypted DB
   * config for any omitted field — notably the password, which may be left blank
   * to reuse the stored one). Nothing is persisted regardless of outcome, and the
   * password is never echoed back. Returns `{ ok, message }`: a transport/send
   * failure resolves to `ok: false` with a human-readable message rather than
   * throwing (the admin gate already ran; this is a connectivity probe).
   */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(TestSmtpConfigRequestSchema))
  async test(
    @Req() req: AuthenticatedRequest,
    @Body() body: TestSmtpConfigRequest,
  ): Promise<TestSmtpConfigResponse> {
    const admin = await this.requireAdmin(req);

    // The recipient is the admin's OWN account email — a misconfig can never be
    // used to mail an arbitrary address (spec D5 / "the requesting admin's own
    // email"). An admin account with no email cannot receive a test.
    if (typeof admin.email !== 'string' || admin.email.length === 0) {
      return {
        ok: false,
        message:
          'Your account has no email address, so a test message cannot be ' +
          'delivered to you. Add an email to your account first.',
      };
    }

    const config = await this.resolveTestConfig(body);
    if (!config) {
      return {
        ok: false,
        message:
          'No password is available for the test. Enter the SMTP password (API ' +
          'Key) or save a configuration first.',
      };
    }

    try {
      const transporter = this.createTransport(config);
      await transporter.sendMail({
        from: config.from,
        to: admin.email,
        subject: 'SMTP configuration test',
        text:
          'This is a test message confirming your SMTP configuration works. ' +
          'If you received this, outbound email (including login codes) is ' +
          'configured correctly.',
      });
      return {
        ok: true,
        message: `Test email sent to ${admin.email}.`,
      };
    } catch (error) {
      // Surface a readable failure; nothing is persisted on this path.
      return {
        ok: false,
        message: `Test send failed: ${describeError(error)}`,
      };
    }
  }

  /**
   * Build the nodemailer transport for a candidate config (implicit TLS on 465,
   * STARTTLS on the standard submission ports — mirrors MailService's transport
   * construction). Isolated as a `protected` seam so the test-send path is unit-
   * testable without a live SMTP server (the spec overrides it to capture the
   * recipient instead of opening a socket).
   */
  protected createTransport(config: ResolvedTestSmtpConfig): Transporter {
    return createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
  }

  /**
   * Resolve the EFFECTIVE config for a test-send: the submitted host/port/user/from
   * (or the saved values for omitted fields) and the password = the submitted one
   * when present, else the saved/decrypted DB password ("留空沿用"). Returns `null`
   * when no password can be determined (no submitted pass and no saved config), so
   * the caller fails the test rather than attempting an unauthenticated send.
   */
  private async resolveTestConfig(
    body: TestSmtpConfigRequest,
  ): Promise<ResolvedTestSmtpConfig | null> {
    const saved = await this.smtp.resolveDbSmtpConfig();

    const host = nonEmpty(body.host) ?? saved?.host ?? null;
    const user = nonEmpty(body.user) ?? saved?.user ?? null;
    const from = nonEmpty(body.from) ?? saved?.from ?? null;
    const port = typeof body.port === 'number' ? body.port : saved?.port ?? null;
    // Password: the submitted candidate takes precedence; a blank/omitted password
    // reuses the saved one (the dialog's "留空沿用" behaviour).
    const pass = nonEmpty(body.pass) ?? saved?.pass ?? null;

    if (
      host === null ||
      user === null ||
      from === null ||
      port === null ||
      pass === null
    ) {
      return null;
    }
    return { host, port, user, pass, from };
  }

  /**
   * Enforce that the request is an `allowed`, `role = admin` account, re-confirmed
   * against the LIVE `User` row (not cached on the principal) so a just-demoted or
   * just-disabled admin loses access on the very next request — fail-closed. Reuses
   * the account-administration admin gate exactly, additionally projecting the
   * live `email` so the test-send can target the admin's own address.
   */
  private async requireAdmin(
    req: AuthenticatedRequest,
  ): Promise<{ email: string | null }> {
    const principal = req.operatorPrincipal;
    const user = principal?.user;
    if (!principal || !user) {
      throw this.adminDenied();
    }

    const where = resolveAccountWhere(user);
    if (where === null) {
      throw this.adminDenied();
    }

    const account = await this.prisma.user.findUnique({
      where,
      select: { role: true, allowed: true, email: true },
    });
    if (!account || account.allowed !== true || account.role !== 'admin') {
      throw this.adminDenied();
    }
    return { email: account.email };
  }

  private adminDenied(): ForbiddenException {
    return new ForbiddenException({
      error: 'admin_required',
      message: 'SMTP configuration requires an admin account.',
    });
  }
}

/**
 * The masked read projection returned when NO SMTP config row has ever been
 * saved: empty non-secret fields and no stored password. The storage service
 * returns null for an unset singleton, but the wire contract `SmtpConfigRead` is
 * non-nullable, so the controller coalesces null to this so the admin UI always
 * receives a uniform masked shape (it renders the unconfigured state from
 * `hasPassword: false` + the blank fields).
 */
const EMPTY_SMTP_CONFIG_READ: SmtpConfigRead = {
  host: '',
  port: 0,
  user: '',
  from: '',
  hasPassword: false,
  passLast4: null,
};

/** The fully-resolved candidate config a test-send transmits over. */
interface ResolvedTestSmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

/**
 * Resolve the unique `User` lookup for a principal's resolved user: by internal
 * `id` when present (the provider-agnostic key under IdentityLink), else by the
 * immutable numeric `githubId`. Returns `null` when neither identifying field is
 * present so the caller can fail closed. Mirrors the account-administration gate.
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

/** A trimmed non-empty string, or `null` for unset/blank values. */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A short, log-safe description of a caught send error. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
