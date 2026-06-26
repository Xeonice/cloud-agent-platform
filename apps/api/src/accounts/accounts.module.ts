import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

/**
 * Account-administration feature module (account-administration, tasks 7.1 / 7.2).
 *
 * Wires:
 *  - {@link AccountsController} (`/accounts*`) — session-gated by the global
 *    `AuthGuard`, then admin-ONLY-gated in the controller (re-confirmed against the
 *    live `User` row) so a non-admin cannot create/list/mutate accounts;
 *  - {@link AccountsService} — admin create (no public registration), enable/disable
 *    (the pure-DB `User.allowed` revocation path for every account row),
 *    reset-password (local only), and role assignment.
 *
 * Relies on the global `PrismaModule` for DB access and reuses the auth-core argon2
 * util (imported directly) so a locally-created/reset password verifies on the
 * password-login path. Registration in `app.module.ts` is DEFERRED to the
 * integration track (10.1), the single writer that wires every new module and
 * confirms no DI/module cycle.
 */
@Module({
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
