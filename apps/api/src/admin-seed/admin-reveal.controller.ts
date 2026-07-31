import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import {
  AdminRevealResponseSchema,
  type AdminRevealResponse,
} from '@cap-console/contracts';

import { PrismaService } from '@/prisma/prisma.service';
import {
  AdminRevealHolder,
  SYSTEM_SETTINGS_ROW_ID,
} from './admin-seed.service';

/**
 * One-time admin-credential reveal endpoint (add-private-account-identity, task
 * 6.3; spec `default-admin-bootstrap` — "Random admin password with one-time
 * reveal").
 *
 * Mounted at `POST /auth/admin/reveal`. It is a PUBLIC (pre-auth) endpoint — a
 * fresh deploy has no session yet, so the operator must be able to read the
 * generated admin credential without first logging in. The auth-core track adds
 * this exact path to `PUBLIC_AUTH_PATHS` (task 2.6) so the global `AuthGuard`
 * lets it through; the per-IP auth throttle tier (track rate-limit-auth) caps it.
 *
 * Single-use is enforced by an ATOMIC claim of the persisted
 * `SystemSettings.adminRevealConsumedAt` flag: the first caller that flips it
 * from null wins and receives `{ email, password }`; every subsequent call (and
 * any call after a process restart, since the in-memory plaintext is then gone)
 * receives an empty body. The plaintext lives only in {@link AdminRevealHolder}
 * and is cleared the moment the reveal is consumed — it is NEVER persisted.
 */

// `AdminRevealResponse` was declared here as
// `AdminRevealCredential | Record<string, never>` — the right shape, in the wrong
// place. The contract now carries both arms (a union, with the empty one strict),
// so the two-armed response is stated once and the schema below can be executed
// against it.

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
    // Parsed on the way out, as `SmtpController` and `RuntimesService` now are.
    // This schema had no call site anywhere, which is exactly how the contract
    // came to describe only one of the two bodies this endpoint returns.
    return AdminRevealResponseSchema.parse(await this.revealOnce());
  }

  /** The reveal itself. Split out so the parse above wraps every return path. */
  private async revealOnce(): Promise<AdminRevealResponse> {
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
