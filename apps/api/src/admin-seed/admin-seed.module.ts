import { Module } from '@nestjs/common';
import { hashPassword } from '../auth/argon2';
import {
  AdminRevealHolder,
  AdminSeedService,
  PASSWORD_HASHER_TOKEN,
  type PasswordHasher,
} from './admin-seed.service';
import { AdminRevealController } from './admin-reveal.controller';

/**
 * Default-admin bootstrap module (add-private-account-identity, track
 * admin-bootstrap).
 *
 * Bundles the self-contained admin seed and its one-time reveal:
 *  - {@link AdminRevealHolder} — a single shared in-memory holder for the
 *    generated admin plaintext, injected into BOTH the seed (writer) and the
 *    reveal controller (reader/consumer) so the plaintext lives in exactly one
 *    place and is cleared on consume.
 *  - {@link AdminSeedService} — the ONE order-independent boot hook (design D6)
 *    that idempotently provisions the admin.
 *  - {@link AdminRevealController} — `POST /auth/admin/reveal`, the single-use
 *    reveal channel.
 *
 * `PrismaService` resolves from the `@Global` `PrismaModule` (optional on the
 * seed so a unit context still constructs without a database). The argon2
 * hashing slice is supplied under {@link PASSWORD_HASHER_TOKEN} by adapting the
 * SHARED `../auth/argon2` util (auth-core task 2.2) — the seed depends on the
 * narrow {@link PasswordHasher} port, not the util directly, so it stays
 * self-contained and unit-testable.
 *
 * Module registration in `app.module.ts` is DEFERRED to the integration track
 * (task 10.1, the single writer of `app.module.ts`).
 */
@Module({
  controllers: [AdminRevealController],
  providers: [
    AdminRevealHolder,
    AdminSeedService,
    {
      // Adapt the shared argon2 util to the narrow hashing port the seed needs.
      provide: PASSWORD_HASHER_TOKEN,
      useValue: { hash: (plaintext: string) => hashPassword(plaintext) } satisfies PasswordHasher,
    },
  ],
  exports: [AdminSeedService, AdminRevealHolder],
})
export class AdminSeedModule {}
