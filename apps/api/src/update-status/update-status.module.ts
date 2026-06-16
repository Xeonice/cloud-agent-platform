import { Module } from '@nestjs/common';
import { UpdateStatusController } from './update-status.controller';
import { UpdateStatusService } from './update-status.service';

/**
 * Update-availability module (update-availability-check, Phase 2 / task 2.2).
 *
 * Wires the operator-guarded `GET /update-status` controller and its cached,
 * best-effort {@link UpdateStatusService}. The service is constructed via a
 * factory (its constructor takes a defaulted options object, not DI tokens) so
 * the live wiring uses the production defaults — `process.env` for
 * `GITHUB_RELEASES_REPO`/`CAP_VERSION`, the real GitHub `fetch`, and the ~6h TTL
 * cache. No new persistence; the endpoint is auth-gated by the GLOBAL
 * `APP_GUARD` (auth.module), exactly like `/metrics`.
 */
@Module({
  controllers: [UpdateStatusController],
  providers: [
    {
      provide: UpdateStatusService,
      useFactory: () => new UpdateStatusService(),
    },
  ],
})
export class UpdateStatusModule {}
