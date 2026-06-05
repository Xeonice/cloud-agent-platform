import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';

/**
 * Operator-auth module (single-user-auth 11.2, integration 11.2b).
 *
 * 11.2b — registers the {@link AuthGuard} GLOBALLY across every REST endpoint via
 * the `APP_GUARD` provider. The guard itself exempts `/health` (so platform
 * liveness probes work unauthenticated) and rejects any missing/malformed/
 * non-matching `Authorization: Bearer <token>` with 401, performing no state
 * change. Any value that does not match the configured `AUTH_TOKEN` is rejected
 * by the ordinary comparison.
 *
 * The refuse-to-boot check for an unset `AUTH_TOKEN` (11.3b) lives in the
 * bootstrap (`main.ts`); this module wires the per-request enforcement.
 */
@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AuthModule {}
