import { Controller, Get } from '@nestjs/common';
import type { MetricsResponse } from '@cap/contracts';
import { MetricsService } from './metrics.service';

/**
 * Session-gated metrics endpoint (be-metrics, task 5.5).
 *
 * `GET /metrics` returns the composed derived-capacity + sampled-resource
 * payload in one round trip. The endpoint is NOT in the {@link AuthGuard}'s
 * exemption list (`/health` + the OAuth entry points), and the guard is
 * registered GLOBALLY via `APP_GUARD` (auth.module), so an unauthenticated /
 * de-allowlisted request is rejected with 401 BEFORE this handler runs — meaning
 * no task ids, queue depth, or CPU/memory figures are ever serialized to a
 * caller without a valid operator principal.
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  get(): MetricsResponse {
    return this.metrics.build();
  }
}
