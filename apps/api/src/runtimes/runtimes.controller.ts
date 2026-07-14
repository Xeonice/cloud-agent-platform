import { Controller, Get, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard';

import {
  RuntimesService,
  type RuntimesReadinessResponse,
} from './runtimes.service';

/**
 * Runtime-readiness endpoint (add-claude-code-runtime Track 3, task 3.3 /
 * agent-runtime "Runtime readiness endpoint", design D9).
 *
 * `GET /runtimes` reports, per runtime id, whether it is ready to run (its
 * credential is configured) as BOOLEANS ONLY — never a token value or any suffix —
 * so the create-task dialog can OFFER or DISABLE a runtime before a task is
 * created (an un-configured runtime is disabled with a configure hint rather than
 * failing at launch). Default selection stays `codex`.
 *
 * Like `/update-status` / `/metrics` (and UNLIKE the unauthenticated `/version`),
 * it is NOT in the global {@link AuthGuard}'s exemption list, so the
 * `APP_GUARD`-registered guard rejects an unauthenticated / disabled request
 * with 401 BEFORE this handler runs — it is console data that reflects deployment
 * credential state, so it requires a valid operator principal. The handler is a
 * thin pass-through; the service never throws (it fails a runtime CLOSED to "not
 * ready").
 */
@Controller()
export class RuntimesController {
  constructor(private readonly runtimes: RuntimesService) {}

  @Get('runtimes')
  get(@Req() req: AuthenticatedRequest): Promise<RuntimesReadinessResponse> {
    return this.runtimes.getReadiness(req.operatorPrincipal?.user?.id ?? null);
  }
}
