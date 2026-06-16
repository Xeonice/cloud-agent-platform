import { Module } from '@nestjs/common';

import { UpdateStatusService } from '../update-status/update-status.service';
import { SelfUpdateController } from './self-update.controller';
import { SelfUpdateService } from './self-update.service';

/**
 * Self-update module (self-update-action, design D1–D4 / task 1.3).
 *
 * Wires the admin-gated, env-gated `POST /self-update` controller and its
 * {@link SelfUpdateService}. The service depends on an {@link UpdateStatusService}
 * for the server-side latest-version cross-check (design D3); rather than EDIT
 * `update-status.module.ts` (a file outside this track) to export it, this module
 * constructs its OWN {@link UpdateStatusService} via the SAME production factory
 * (a defaulted-options constructor — `process.env` for repo/version, the real
 * GitHub `fetch`, the ~6h TTL cache), so the wiring stays disjoint from the
 * update-status track. The detached {@link UpdaterLauncher} is left to the
 * service's own default (the live `DockerUpdaterLauncher` over the existing docker
 * access) — no provider is bound here, so a deployment with the feature off never
 * touches docker.
 *
 * The endpoint is auth-gated by the GLOBAL `APP_GUARD` (auth.module), exactly like
 * `/update-status` and `/metrics`; the admin gate + env gate are enforced inside
 * the controller/service, so this module adds no guard of its own.
 */
@Module({
  controllers: [SelfUpdateController],
  providers: [
    {
      provide: UpdateStatusService,
      useFactory: () => new UpdateStatusService(),
    },
    {
      provide: SelfUpdateService,
      useFactory: (updateStatus: UpdateStatusService) =>
        new SelfUpdateService(updateStatus),
      inject: [UpdateStatusService],
    },
  ],
})
export class SelfUpdateModule {}
