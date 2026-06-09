import { Module, OnModuleInit } from '@nestjs/common';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import {
  DEFAULT_CADENCE_MS,
  ResourceSamplerService,
  type ResourceSamplerOptions,
} from './resource-sampler.service';

/**
 * Metrics module (be-metrics, tasks 5.1–5.5).
 *
 * Wires:
 *  - {@link MetricsController} (`GET /metrics`, session-gated by the global
 *    `AuthGuard`);
 *  - {@link MetricsService} which composes the exact derived-capacity block
 *    (from the guardrails semaphore + runner-minutes ledger) with the cached
 *    sampled-resource block;
 *  - {@link ResourceSamplerService}, the background CPU/memory sampler, fed the
 *    LIVE running-task-id set from the guardrails semaphore projection so it
 *    samples exactly the `cap-aio-<taskId>` containers that are actually
 *    running.
 *
 * Imports {@link GuardrailsModule} for the `GuardrailsService` (the live
 * semaphore projection + runner-minutes ledger source).
 */
@Module({
  imports: [GuardrailsModule],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    {
      provide: ResourceSamplerService,
      useFactory: () => new ResourceSamplerService(readSamplerOptions()),
    },
  ],
})
export class MetricsModule implements OnModuleInit {
  constructor(
    private readonly guardrails: GuardrailsService,
    private readonly sampler: ResourceSamplerService,
  ) {}

  /**
   * Wire the sampler's running-task-id source to the LIVE semaphore projection
   * and start the bounded sampling loop. The loop is gated by
   * `METRICS_SAMPLING_ENABLED` (default off) because live cgroup/docker sampling
   * needs running `cap-aio-<taskId>` containers + a reachable docker socket /
   * cgroup fs; with the loop off, `/metrics` still returns the exact derived
   * capacity block and reports the sampled block as `unavailable` (never
   * sampled), which is the honest degraded state rather than a fabricated zero.
   */
  onModuleInit(): void {
    this.sampler.setRunningTaskIdSource(() =>
      this.guardrails.semaphoreProjection().snapshotRunning(),
    );
    // Per-task sandbox base URL for the in-sandbox codex-process read (D7): the
    // guardrails service holds each running task's SandboxConnection. A task with
    // no captured connection yields undefined → the sampler takes no process
    // reading and the per-task read falls back to the container scope.
    this.sampler.setTaskBaseUrlSource(
      (taskId) => this.guardrails.connectionFor(taskId)?.baseUrl,
    );
    if (samplingEnabled()) {
      this.sampler.start();
    }
  }
}

/** True when background resource sampling is explicitly enabled. */
function samplingEnabled(): boolean {
  const raw = process.env.METRICS_SAMPLING_ENABLED;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/** Reads the sampler cadence/staleness tunables from the environment. */
function readSamplerOptions(): ResourceSamplerOptions {
  return {
    cadenceMs: readPositiveInt(process.env.METRICS_SAMPLE_CADENCE_MS, DEFAULT_CADENCE_MS),
    staleAfterMs: readPositiveInt(process.env.METRICS_SAMPLE_STALE_MS, undefined),
  };
}

function readPositiveInt(
  raw: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
