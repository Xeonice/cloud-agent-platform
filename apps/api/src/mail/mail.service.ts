import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { resolveDbSmtpConfig } from './smtp-config.service';

/**
 * SMTP env var names, centralised so the service, the OTP capability gate, and
 * the deploy docs agree on spelling. Every value is read from `process.env` AT
 * RUNTIME (never captured at module load) so the OTP capability flag is evaluated
 * against the live environment, exactly like the OAuth config readers.
 */
export const SMTP_ENV = {
  HOST: 'SMTP_HOST',
  PORT: 'SMTP_PORT',
  USER: 'SMTP_USER',
  PASS: 'SMTP_PASS',
  FROM: 'SMTP_FROM',
} as const;

/** A single outbound message: recipient, subject, plaintext body, optional HTML. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /**
   * Optional HTML body. When present the message is sent as `multipart/alternative`
   * (HTML + the `text` plaintext fallback) so clients that can't render HTML still
   * show the plaintext part.
   */
  readonly html?: string;
}

/**
 * The fully-resolved SMTP transport config — only ever non-null when configured.
 *
 * `source` records WHICH config won the DB-first/env-fallback resolution (D3): a
 * stored DB row (`'db'`) takes precedence; the unprefixed `SMTP_*` env (`'env'`)
 * is the fallback that keeps existing env-only deployments working unchanged. It
 * is diagnostic only — the transport itself is the same `nodemailer` path either
 * way — so the active source is observable without leaking the password.
 */
export interface ResolvedSmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
  readonly source: 'db' | 'env';
}

/**
 * Resolves the SMTP config from the live environment, or `null` when ANY required
 * value is missing/blank or the port is invalid. All five vars must be present — a
 * partial config is treated as unconfigured (fail closed). This is the SINGLE
 * source of truth for "is SMTP configured": both {@link MailService.isConfigured}
 * and the OTP capability flag ({@link isSmtpConfigured}, consumed by
 * `auth-config.isOtpAuthEnabled`) derive from it, so what the frontend is told is
 * available can never over-advertise relative to what `sendMail` will actually do.
 */
export function resolveSmtpConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSmtpConfig | null {
  const host = nonEmpty(env[SMTP_ENV.HOST]);
  const portRaw = nonEmpty(env[SMTP_ENV.PORT]);
  const user = nonEmpty(env[SMTP_ENV.USER]);
  const pass = nonEmpty(env[SMTP_ENV.PASS]);
  const from = nonEmpty(env[SMTP_ENV.FROM]);
  if (!host || !portRaw || !user || !pass || !from) {
    return null;
  }
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { host, port, user, pass, from, source: 'env' };
}

/**
 * Resolves the STORED DB SMTP config (decrypting the password), or `null` when no
 * row exists / no key is available. Bound to a Prisma instance + env by the caller
 * (the `smtp-config.service` free function `resolveDbSmtpConfig`), this is the seam
 * the default channel reads FIRST so a console-saved config takes precedence over
 * the env fallback (D3). Injected (rather than imported at the channel) so the
 * routing/gating functions stay unit-testable with a fake DB resolver and no DB.
 */
export type DbSmtpConfigResolver = () => Promise<ResolvedSmtpConfig | null>;

/** A DB resolver that always resolves `null` — the env-only path (no DB row). */
const NO_DB_CONFIG: DbSmtpConfigResolver = async () => null;

/**
 * A named outbound mail transport channel: how to resolve its SMTP config (DB
 * first, then env), and which recipients it handles. The recipient-routing seam
 * (add a China channel later without touching the OTP send path) lives here.
 */
interface TransportChannel {
  readonly name: string;
  /**
   * Resolve this channel's SMTP config: the DB-stored config first (via the
   * injected `resolveDb`), falling back to the env tuple. `null` = not configured.
   */
  readonly resolve: (
    resolveDb: DbSmtpConfigResolver,
    env: NodeJS.ProcessEnv,
  ) => Promise<ResolvedSmtpConfig | null>;
  /** True when this channel should handle `recipient`. The default channel matches all. */
  readonly matches: (recipient: string) => boolean;
}

/**
 * The ordered transport channels. TODAY only the DEFAULT channel, which matches
 * every recipient — so behavior is identical to a single transport. Its config is
 * resolved DB-FIRST (a console-saved row) then falls back to the unprefixed
 * `SMTP_*` env tuple (D3), so existing env-only deployments are unchanged until an
 * admin saves a DB config. A future China channel (e.g. Aliyun DirectMail) would
 * PREPEND a channel whose `matches` tests the recipient suffix
 * (e.g. `@qq.com`/`@163.com`/`@126.com`) — without touching {@link MailService.sendMail}.
 */
const TRANSPORT_CHANNELS: readonly TransportChannel[] = [
  {
    name: 'default',
    resolve: async (resolveDb, env) => (await resolveDb()) ?? resolveSmtpConfig(env),
    matches: () => true,
  },
];

/**
 * Select the SMTP config for a recipient (the recipient-routing seam): the first
 * channel whose rule matches AND is configured. The default channel matches every
 * recipient, so an unmatched address falls back to it; returns `null` only when NO
 * channel is configured (fail-closed). `recipient` is unused while a single default
 * channel is registered, but is the seam a future per-suffix channel reads.
 *
 * DB-FIRST/ENV-FALLBACK (D3): the default channel resolves the stored DB config via
 * `resolveDb` first, then the env tuple. `resolveDb` is injected (defaults to the
 * no-DB resolver) so the routing stays unit-testable without a DB.
 */
export async function resolveTransportFor(
  recipient: string,
  resolveDb: DbSmtpConfigResolver = NO_DB_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedSmtpConfig | null> {
  for (const channel of TRANSPORT_CHANNELS) {
    if (channel.matches(recipient)) {
      const config = await channel.resolve(resolveDb, env);
      if (config) {
        return config;
      }
    }
  }
  return null;
}

/**
 * True when at least one mail transport is configured (DB config OR env). The OTP
 * capability flag (`auth-config.isOtpAuthEnabled`) consumes THIS so the advertised
 * availability matches what {@link MailService.sendMail} can actually do — and is
 * now true when EITHER a console-saved DB config OR the `SMTP_*` env is present
 * (D7). `resolveDb` is injected (defaults to the no-DB resolver) for testability.
 */
export async function isSmtpConfigured(
  resolveDb: DbSmtpConfigResolver = NO_DB_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  for (const channel of TRANSPORT_CHANNELS) {
    if ((await channel.resolve(resolveDb, env)) !== null) {
      return true;
    }
  }
  return false;
}

/**
 * Thin SMTP mailer wrapping `nodemailer` (add-private-account-identity, task 5.1).
 *
 * This is the SINGLE outbound-email path. Its transport is resolved DB-FIRST (a
 * console-saved `SmtpConfig` row) and falls back to the `SMTP_HOST` / `SMTP_PORT`
 * / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` environment (D3), and it exposes its
 * configured-ness as a capability ({@link isConfigured}) so the OTP login method
 * can be reported unavailable — and fail closed — when NEITHER source is
 * configured (spec "OTP is unavailable when neither DB nor env SMTP is configured").
 *
 * Two load-bearing disciplines:
 *  - FAIL CLOSED: {@link sendMail} throws when SMTP is not fully configured. A
 *    caller (the OTP request path) must NOT silently treat an unconfigured mailer
 *    as success — there is no "drop the mail on the floor" path.
 *  - VISIBLE ERRORS: a transport/send failure is logged at error level AND
 *    re-thrown so the operator sees it, rather than being silently swallowed
 *    (spec "Send failures SHALL be surfaced ... rather than silently swallowed").
 *
 * The transport is created lazily and memoised per resolved config so a config
 * change at runtime (env edit + restart) is picked up, while a hot send path does
 * not re-create a connection pool on every message.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  /** Memoised transport + the config fingerprint it was built for. */
  private cached: { fingerprint: string; transporter: Transporter } | null = null;

  /**
   * `PrismaService` is injected so the mailer can resolve the DB-stored SMTP
   * config DB-first (D4). `PrismaModule` is `@Global`, so this dependency needs NO
   * `mail.module.ts` edit. Bound into the {@link DbSmtpConfigResolver} the routing
   * functions read first, falling back to the env tuple.
   */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Binds {@link resolveDbSmtpConfig} (the `smtp-config.service` free function) to
   * this instance's Prisma client + the given env, producing the DB-first resolver
   * the routing/gating functions read before the env fallback.
   */
  private dbResolver(env: NodeJS.ProcessEnv): DbSmtpConfigResolver {
    return () => resolveDbSmtpConfig(this.prisma, env);
  }

  /**
   * True when SMTP is fully configured (DB config OR env). Delegates to the shared
   * {@link isSmtpConfigured} so the OTP capability flag (task 2.8) and this gate
   * never diverge. Now ASYNC because the DB config is resolved first (D4); reading
   * the live env keeps the env fallback consistent with the runtime fail-closed
   * posture of the rest of the auth surface.
   */
  async isConfigured(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return isSmtpConfigured(this.dbResolver(env), env);
  }

  /**
   * Sends one message over the configured SMTP transport.
   *
   * FAIL CLOSED: throws when SMTP is not configured — the caller decides how to
   * present that (the OTP path keeps its response uniform but never reports a
   * non-existent send as success). VISIBLE: a transport/send error is logged at
   * error level and re-thrown so the operator sees a real delivery failure.
   */
  async sendMail(message: MailMessage, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    // Recipient-routing seam: pick the transport for this recipient (DB-first,
    // env-fallback; default channel today).
    const config = await resolveTransportFor(message.to, this.dbResolver(env), env);
    if (!config) {
      // Fail closed: do not pretend a message was sent when no transport exists.
      throw new Error('SMTP is not configured (set SMTP_HOST/PORT/USER/PASS/FROM)');
    }

    const transporter = this.getTransporter(config);
    try {
      await transporter.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        // HTML present → multipart/alternative with the plaintext `text` as fallback.
        ...(message.html ? { html: message.html } : {}),
      });
    } catch (error) {
      // Surface the failure: log loudly AND re-throw (never silently swallow).
      this.logger.error(
        `SMTP send failed (to=${message.to} subject=${JSON.stringify(message.subject)}): ${String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Returns a transport for the resolved config, memoised by a config
   * fingerprint so a steady config reuses one connection pool while a changed
   * config rebuilds the transport.
   */
  private getTransporter(config: ResolvedSmtpConfig): Transporter {
    const fingerprint = `${config.host}:${config.port}:${config.user}:${config.from}`;
    if (this.cached && this.cached.fingerprint === fingerprint) {
      return this.cached.transporter;
    }
    const transporter = createTransport({
      host: config.host,
      port: config.port,
      // STARTTLS on the standard submission ports, implicit TLS on 465.
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
    this.cached = { fingerprint, transporter };
    return transporter;
  }
}

/** Returns a trimmed non-empty string, or `null` for unset/blank values. */
function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
