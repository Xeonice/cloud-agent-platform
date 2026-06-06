import { Injectable } from '@nestjs/common';
import type { MetricsResponse } from '@cap/contracts';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { buildSlotOccupancy, projectCapacity } from './metrics-projection';
import { deriveRunnerMinutes } from './runner-minutes';
import { ResourceSamplerService } from './resource-sampler.service';

/**
 * Composes the `GET /metrics` aggregation response (be-metrics, task 5.5).
 *
 * It assembles, in ONE round trip, two strictly distinguished blocks:
 *
 *  - the DERIVED capacity block (`capacity`, `occupancy`, `runnerMinutes`) —
 *    exact, point-in-time, read LIVE from the guardrails semaphore + runner-
 *    minutes ledger at request time (never sampled, never cached);
 *  - the SAMPLED resource block (`resources`) — the cadence-bounded CPU/memory
 *    snapshot served from the {@link ResourceSamplerService} cache, self-
 *    describing its freshness via `status`/`sampledAt`/`ageMs`.
 *
 * Crucially, a sampling outage / staleness degrades ONLY the sampled block: the
 * derived capacity block is always present and exact even when `resources.status`
 * is `stale`/`unavailable`. This service performs no IO and never blocks on a
 * live sample, so request latency is decoupled from docker-stats/cgroup cost.
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly guardrails: GuardrailsService,
    private readonly sampler: ResourceSamplerService,
  ) {}

  /** Builds the composed metrics response at the current instant. */
  build(now: number = Date.now()): MetricsResponse {
    // Read the semaphore ONCE so all derived figures reflect the same instant.
    const projection = this.guardrails.semaphoreProjection();

    return {
      capacity: projectCapacity(projection),
      occupancy: buildSlotOccupancy(projection),
      runnerMinutes: deriveRunnerMinutes(this.guardrails.runnerMinuteIntervals(), now),
      // Sampled block from the cache; its own status flags freshness/outage so a
      // degraded sample never fails the whole response.
      resources: this.sampler.currentSnapshot(now),
    };
  }
}
