import { Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

/**
 * API-key management feature module (api-key-machine-identity, tasks 5.1 / 5.2).
 *
 * Wires:
 *  - {@link ApiKeysController} (`/api-keys*`) — session-gated by the global
 *    `AuthGuard`, then session-ONLY-gated in the controller so a machine
 *    credential cannot mint/list/revoke keys (no escalation chain);
 *  - {@link ApiKeysService} — hash-only mint / non-secret list / idempotent
 *    revoke, per-account-scoped by the session user's immutable `githubId`.
 *
 * Relies on the global `PrismaModule` for DB access and reuses the auth
 * `hashSessionToken` primitive (imported directly) so a minted key's stored hash
 * matches what {@link AuthSessionService.resolveApiKey} re-hashes at resolution
 * time. Registered in `app.module.ts` alongside the other feature modules
 * (task 5.2), where the CI boot-smoke (Track 1) exercises it on a live boot.
 */
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
