import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminRevealHolder,
  SYSTEM_SETTINGS_ROW_ID,
  type AdminRevealCredential,
} from './admin-seed.service';

/**
 * One-time admin-credential reveal endpoint (add-private-account-identity, task
 * 6.3; spec `default-admin-bootstrap` — "Random admin password with one-time
 * reveal").
 *
 * Mounted at `POST /auth/admin/reveal`. It is a PUBLIC (pre-auth) endpoint — a
 * fresh deploy has no session yet, so the operator must be able to read the
 * generated admin credential without first logging in. The auth-core track adds
 * this exact path to `OAUTH_EXEMPT_PATHS` (task 2.6) so the global `AuthGuard`
 * lets it through; the per-IP auth throttle tier (track rate-limit-auth) caps it.
 *
 * Single-use is enforced by an ATOMIC claim of the persisted
 * `SystemSettings.adminRevealConsumedAt` flag: the first caller that flips it
 * from null wins and receives `{ email, password }`; every subsequent call (and
 * any call after a process restart, since the in-memory plaintext is then gone)
 * receives an empty body. The plaintext lives only in {@link AdminRevealHolder}
 * and is cleared the moment the reveal is consumed — it is NEVER persisted.
 */

/**
 * The reveal response: the credential exactly once, or `{}` when there is
 * nothing to reveal (already consumed, restarted past an unconsumed reveal, or a
 * fixed `ADMIN_PASSWORD` was configured so no plaintext was ever held).
 */
export type AdminRevealResponse = AdminRevealCredential | Record<string, never>;

@Controller('auth')
export class AdminRevealController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holder: AdminRevealHolder,
  ) {}

  /**
   * Reveal the generated admin credential exactly once. Returns `200` with
   * `{ email, password }` to the single winning caller and `200 {}` to everyone
   * else, so a probe cannot distinguish "consumed" from "never generated".
   */
  @Post('admin/reveal')
  @HttpCode(HttpStatus.OK)
  async reveal(): Promise<AdminRevealResponse> {
    const credential = this.holder.peek();
    // No plaintext in memory ⇒ nothing this process can reveal (consumed earlier,
    // restarted past an unconsumed reveal, or a fixed ADMIN_PASSWORD was used).
    if (!credential) {
      return {};
    }

    // Ensure the singleton settings row exists WITHOUT touching the consumed flag
    // (the create branch seeds the required concurrency ceiling from env/default).
    await this.prisma.systemSettings.upsert({
      where: { id: SYSTEM_SETTINGS_ROW_ID },
      create: {
        id: SYSTEM_SETTINGS_ROW_ID,
        maxConcurrentTasks: readMaxConcurrentTasksSeed(),
      },
      update: {},
    });

    // ATOMIC single-use claim: only the caller that flips adminRevealConsumedAt
    // from null wins (count === 1). A concurrent or repeat call sees count === 0.
    const claim = await this.prisma.systemSettings.updateMany({
      where: { id: SYSTEM_SETTINGS_ROW_ID, adminRevealConsumedAt: null },
      data: { adminRevealConsumedAt: new Date() },
    });

    // Whether we won or lost the claim, drop the in-memory plaintext now: a lost
    // claim means the reveal was already consumed, so it must never serve again.
    this.holder.clear();

    if (claim.count !== 1) {
      return {};
    }
    return { email: credential.email, password: credential.password };
  }
}

/**
 * The concurrency ceiling to seed onto a freshly-created `SystemSettings` row
 * (the column is required, no schema default). Mirrors the env/default the rest
 * of the app uses (`MAX_CONCURRENT_TASKS ?? 5`) so a row created here by the
 * reveal path carries a sane ceiling rather than an arbitrary one.
 */
function readMaxConcurrentTasksSeed(): number {
  const raw = process.env.MAX_CONCURRENT_TASKS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return 5;
}
