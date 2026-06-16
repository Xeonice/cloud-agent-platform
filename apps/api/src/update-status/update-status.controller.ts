import { Controller, Get } from '@nestjs/common';
import type { UpdateStatus } from '@cap/contracts';
import { UpdateStatusService } from './update-status.service';

/**
 * Operator-guarded update-availability endpoint (update-availability-check,
 * Phase 2 / design D1, task 2.2).
 *
 * `GET /update-status` returns the discriminated {@link UpdateStatus} comparing
 * the running `CAP_VERSION` against the latest GitHub Release for the configured
 * repo. Like `/metrics` (and UNLIKE the unauthenticated `/version`), it is NOT in
 * the global {@link AuthGuard}'s exemption list, so the `APP_GUARD`-registered
 * guard rejects an unauthenticated / de-allowlisted request with 401 BEFORE this
 * handler runs: it is console data and it triggers an outbound GitHub fetch, so
 * it requires a valid operator principal.
 *
 * The result is best-effort and degrades honestly (`updateAvailable: false`,
 * `latestVersion: null`) for a source build / no releases / fetch failure — the
 * service never throws, so this handler is a thin pass-through.
 */
@Controller()
export class UpdateStatusController {
  constructor(private readonly updateStatus: UpdateStatusService) {}

  @Get('update-status')
  get(): Promise<UpdateStatus> {
    return this.updateStatus.getStatus();
  }
}
