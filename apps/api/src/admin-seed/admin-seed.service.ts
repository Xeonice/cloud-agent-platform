import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Default-admin bootstrap (add-private-account-identity, track admin-bootstrap —
 * tasks 6.1–6.3; spec `default-admin-bootstrap`).
 *
 * A SELF-CONTAINED, idempotent boot-time seed that guarantees a fresh, no-GitHub
 * deploy has a usable administrator without baking in a weak fixed password. The
 * whole concern lives behind this ONE service with its OWN single boot hook
 * ({@link onApplicationBootstrap}) — deliberately NOT spread across multiple
 * providers' bootstrap hooks. That decision is load-bearing: a prior production
 * outage (~6h) was caused by a cross-provider bootstrap whose ordering was not
 * guaranteed between independent `onApplicationBootstrap` participants; keeping
 * the seed wholly inside one order-independent path removes that failure mode
 * (design D6 / Risks).
 *
 * Credential discipline (design D6 / spec "Random admin password with one-time
 * reveal"):
 *  - The database NEVER holds the admin plaintext — only its argon2 hash.
 *  - When `ADMIN_PASSWORD` is unset a strong random password is generated and its
 *    plaintext is held ONLY in process memory, in the injected
 *    {@link AdminRevealHolder}. A one-time reveal endpoint (task 6.3) serves it
 *    exactly once, then clears it and stamps `SystemSettings.adminRevealConsumedAt`.
 *  - If the process restarts BEFORE the reveal is consumed, the password is
 *    regenerated (there is no persisted plaintext to re-serve) — but a reveal
 *    that was ALREADY consumed (or an admin whose password was set from
 *    `ADMIN_PASSWORD`, or customized after first login) is left intact.
 */

/** The fixed singleton id of the shared `SystemSettings` row (mirrors settings). */
export const SYSTEM_SETTINGS_ROW_ID = 'system';

/** The env var naming the default admin's email — the seed's account key. */
export const ADMIN_EMAIL_ENV = 'ADMIN_EMAIL';

/** Optional env var supplying a fixed admin password (skips random generation). */
export const ADMIN_PASSWORD_ENV = 'ADMIN_PASSWORD';

/**
 * Narrow port for argon2 password hashing (constant-time verify lives with the
 * shared util used by login). The seed only ever HASHES, so it depends on just
 * the hashing slice. Injected (rather than importing the shared `../auth/argon2`
 * util directly) so the seed stays self-contained and unit-testable with a fake
 * hasher — the concrete argon2-backed adapter is wired in {@link AdminSeedModule}.
 */
export interface PasswordHasher {
  /** Produce an argon2id hash of the plaintext password. */
  hash(plaintext: string): Promise<string>;
}

/** DI token under which a concrete {@link PasswordHasher} is supplied. */
export const PASSWORD_HASHER_TOKEN = 'ADMIN_SEED_PASSWORD_HASHER';

/**
 * The credential the one-time reveal channel serves, held ONLY in process
 * memory. Never persisted in plaintext (the DB stores only the argon2 hash).
 */
export interface AdminRevealCredential {
  readonly email: string;
  readonly password: string;
}

/**
 * In-memory holder for the generated admin plaintext (design D6). A single
 * shared instance is injected into both the seed (writer) and the reveal
 * controller (reader/consumer). The plaintext lives here and NOWHERE else:
 * cleared on consume, never written to the database or logged.
 */
@Injectable()
export class AdminRevealHolder {
  private credential: AdminRevealCredential | null = null;

  /** Replace the held credential (set by the seed when a password is generated). */
  set(credential: AdminRevealCredential): void {
    this.credential = credential;
  }

  /** The currently-held credential, or `null` when nothing is pending reveal. */
  peek(): AdminRevealCredential | null {
    return this.credential;
  }

  /** Drop the held plaintext (after a consumed reveal). Idempotent. */
  clear(): void {
    this.credential = null;
  }
}

/**
 * The minimal `User` shape the seed reads. Declared structurally so the service
 * does not couple to the generated Prisma row type (the new columns land in the
 * contracts-schema track); the live client satisfies this shape.
 */
interface SeedUserRow {
  id: string;
  email: string | null;
}

@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminSeedService.name);

  constructor(
    private readonly holder: AdminRevealHolder,
    @Inject(PASSWORD_HASHER_TOKEN)
    private readonly hasher: PasswordHasher,
    /**
     * Prisma client. Optional so a unit context can construct the service
     * without a database (the seed then no-ops); the boot path degrades to a
     * warning rather than crashing bootstrap on a missing client.
     */
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  /**
   * The ONE order-independent boot path for the admin seed (design D6). It never
   * throws into bootstrap: a seed failure is logged and swallowed so a single
   * misconfiguration cannot crash the whole API process.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seedAdmin();
    } catch (err) {
      this.logger.error(
        `admin seed failed (continuing boot): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Idempotently ensure the default admin exists (task 6.1) and manage the
   * generated-password lifecycle (task 6.2).
   *
   * Re-runnable on every boot:
   *  - No `ADMIN_EMAIL` → skip (nothing to key the admin on).
   *  - No admin row → create one (`role=admin`, `allowed=true`,
   *    `mustChangePassword=true`) with a `password` identity whose secret is the
   *    argon2 hash. When the password was generated, hold the plaintext for the
   *    one-time reveal and leave `adminRevealConsumedAt` null.
   *  - Admin row exists, password was generated, reveal NOT yet consumed → the
   *    previous plaintext was lost on restart, so REGENERATE (new hash + new held
   *    plaintext) — the DB never held plaintext to re-serve.
   *  - Admin row exists and the reveal was already consumed (or `ADMIN_PASSWORD`
   *    is set) → leave the existing admin INTACT (no duplicate, no reset), even
   *    if its password was customized after first login.
   */
  async seedAdmin(): Promise<void> {
    if (!this.prisma) {
      this.logger.warn('admin seed skipped: no prisma client wired');
      return;
    }

    const email = this.adminEmail();
    if (!email) {
      this.logger.warn(
        `admin seed skipped: ${ADMIN_EMAIL_ENV} is unset — no default admin will be provisioned`,
      );
      return;
    }

    const fixedPassword = this.fixedAdminPassword();
    const generated = fixedPassword === null;

    const existing = (await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true },
    })) as SeedUserRow | null;

    if (!existing) {
      const password = fixedPassword ?? generateStrongPassword();
      const secret = await this.hasher.hash(password);
      await this.createAdmin(email, secret);
      this.logger.log(`seeded default admin ${email} (mustChangePassword=true)`);
      if (generated) {
        // Hold the plaintext for the one-time reveal; the reveal stays available
        // (adminRevealConsumedAt left null) until consumed or the process exits.
        this.holder.set({ email, password });
      }
      return;
    }

    // The admin already exists — never duplicate or reset a customized account.
    if (!generated) {
      this.logger.log(`admin ${email} already present — leaving intact (fixed password)`);
      return;
    }

    // Generated-password mode: regenerate ONLY when the reveal was never consumed
    // (the in-memory plaintext was lost on restart and the DB never held it).
    const consumed = await this.revealConsumed();
    if (consumed) {
      this.logger.log(
        `admin ${email} already present and reveal consumed — leaving intact`,
      );
      return;
    }

    const password = generateStrongPassword();
    const secret = await this.hasher.hash(password);
    await this.resetPasswordIdentity(existing.id, email, secret);
    this.holder.set({ email, password });
    this.logger.log(
      `admin ${email} present but reveal unconsumed — regenerated password for one-time reveal`,
    );
  }

  /** The configured admin email, normalized (lower-cased, trimmed), or null. */
  private adminEmail(): string | null {
    const raw = process.env[ADMIN_EMAIL_ENV];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** The fixed admin password from env, or null when generation is required. */
  private fixedAdminPassword(): string | null {
    const raw = process.env[ADMIN_PASSWORD_ENV];
    if (typeof raw !== 'string') return null;
    return raw.length > 0 ? raw : null;
  }

  /**
   * Whether the one-time reveal has already been consumed (persisted flag). A
   * missing `SystemSettings` row means "never consumed" (fresh deploy).
   */
  private async revealConsumed(): Promise<boolean> {
    const row = await this.prisma!.systemSettings.findUnique({
      where: { id: SYSTEM_SETTINGS_ROW_ID },
      select: { adminRevealConsumedAt: true },
    });
    return row?.adminRevealConsumedAt != null;
  }

  /**
   * Create the admin `User` + its `password` `IdentityLink` (secret = argon2
   * hash). `role=admin`, `allowed=true`, `mustChangePassword=true`. The password
   * identity is keyed `(provider="password", providerAccountId=email)`.
   */
  private async createAdmin(email: string, passwordHash: string): Promise<void> {
    await this.prisma!.user.create({
      data: {
        email,
        name: email,
        role: 'admin',
        allowed: true,
        mustChangePassword: true,
        identities: {
          create: [
            {
              provider: 'password',
              providerAccountId: email,
              secret: passwordHash,
            },
          ],
        },
      },
    });
  }

  /**
   * Replace the admin's `password` identity secret with a freshly-generated hash
   * (restart-before-consume regeneration). Upserts the identity so a record that
   * predates a password identity still gets one. `mustChangePassword` is
   * re-asserted because this is a freshly-generated credential the operator has
   * not yet personalized.
   */
  private async resetPasswordIdentity(
    userId: string,
    email: string,
    passwordHash: string,
  ): Promise<void> {
    await this.prisma!.identityLink.upsert({
      where: {
        provider_providerAccountId: { provider: 'password', providerAccountId: email },
      },
      create: { userId, provider: 'password', providerAccountId: email, secret: passwordHash },
      update: { secret: passwordHash },
    });
    await this.prisma!.user.update({
      where: { id: userId },
      data: { mustChangePassword: true },
    });
  }
}

/**
 * Generate a strong random password (~115 bits of entropy) from an unambiguous
 * alphanumeric alphabet, using a uniform CSPRNG draw per character. Held only in
 * process memory and surfaced via the one-time reveal; never persisted.
 */
export function generateStrongPassword(length = 20): string {
  // Unambiguous set (no 0/O/1/l/I) so an operator can transcribe the one-time
  // reveal reliably; 55 symbols ^ 20 chars ≫ 110 bits of entropy.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}
