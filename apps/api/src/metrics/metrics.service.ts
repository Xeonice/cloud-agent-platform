import { Injectable, Optional } from '@nestjs/common';
import type {
  MetricsResponse,
  ProvisioningDiagnosticsMetrics,
  TaskResourceResponse,
} from '@cap/contracts';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { TaskProvisioningDiagnosticsMetricsService } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-metrics.service';
import {
  buildSlotOccupancy,
  foldTaskSamples,
  projectCapacity,
} from './metrics-projection';
import { deriveRunnerMinutes } from './runner-minutes';
import { ResourceSamplerService } from './resource-sampler.service';

/**
 * Composes the `GET /metrics` aggregation response (be-metrics, task 5.5).
 *
 * It assembles, in ONE round trip, three strictly distinguished blocks:
 *
 *  - the DERIVED capacity block (`capacity`, `occupancy`, `runnerMinutes`) —
 *    exact, point-in-time, read LIVE from the guardrails semaphore + runner-
 *    minutes ledger at request time (never sampled, never cached);
 *  - the SAMPLED resource block (`resources`) — the cadence-bounded CPU/memory
 *    snapshot served from the {@link ResourceSamplerService} cache, self-
 *    describing its freshness via `status`/`sampledAt`/`ageMs`.
 *  - the PROVISIONING DIAGNOSTICS block — process-window counters plus durable
 *    current gauges served synchronously from an independently refreshed cache.
 *
 * Crucially, an outage / staleness degrades ONLY its owning additive block: the
 * derived capacity block is always present and exact. This service performs no
 * IO and never blocks on a live sample or hydration query.
 */
@Injectable()
export class MetricsService {
  private readonly provisioningDiagnosticsObservedSince = new Date();

  constructor(
    private readonly guardrails: GuardrailsService,
    private readonly sampler: ResourceSamplerService,
    @Optional()
    private readonly provisioningDiagnosticsMetrics?: TaskProvisioningDiagnosticsMetricsService,
  ) {}

  /** Builds the composed metrics response at the current instant. */
  build(now: number = Date.now()): MetricsResponse {
    // Read the semaphore ONCE so all derived figures reflect the same instant.
    const projection = this.guardrails.semaphoreProjection();

    // Sampled block from the cache; its own status flags freshness/outage so a
    // degraded sample never fails the whole response.
    const resources = this.sampler.currentSnapshot(now);
    // Fold each running task's LATEST cached frame (codex process scope,
    // container fallback) into the sampled block, keyed by taskId — pure cache
    // reads of the SAME sampler snapshot, never an extra sampling pass, so one
    // /metrics poll replaces the per-task GET /tasks/:taskId/metrics fan-out.
    const taskSamples = foldTaskSamples(
      projection.snapshotRunning(),
      (taskId) => this.sampler.taskReading(taskId, now),
      resources,
    );

    return {
      capacity: projectCapacity(projection),
      occupancy: buildSlotOccupancy(projection),
      runnerMinutes: deriveRunnerMinutes(this.guardrails.runnerMinuteIntervals(), now),
      resources: { ...resources, taskSamples },
      provisioningDiagnostics: this.buildProvisioningDiagnostics(now),
    };
  }

  private buildProvisioningDiagnostics(
    now: number,
  ): ProvisioningDiagnosticsMetrics {
    try {
      return (
        this.provisioningDiagnosticsMetrics?.currentSnapshot(now) ??
        this.unavailableProvisioningDiagnostics()
      );
    } catch {
      return this.unavailableProvisioningDiagnostics();
    }
  }

  /**
   * Module-compatibility fallback used only when the additive global collector
   * is absent (for example, an older/mixed Nest composition in rolling tests).
   */
  private unavailableProvisioningDiagnostics(): ProvisioningDiagnosticsMetrics {
    return {
      observedSince: new Date(this.provisioningDiagnosticsObservedSince),
      attemptOutcomes: [],
      stageOutcomes: [],
      retries: [],
      cleanupOutcomes: [],
      anomalies: [],
      durableGauges: {
        status: 'unavailable',
        sampledAt: null,
        ageMs: null,
        activeAttempts: null,
        oldestActiveAttemptAgeMs: null,
        cleanupPendingRuns: null,
        confirmedOrphanRuns: null,
      },
    };
  }

  /**
   * Per-task resource read (`GET /tasks/:taskId/metrics`). Real-time only: it
   * filters the SAME sampler snapshot that backs {@link build} for this task's
   * `cap-aio-<taskId>` container — no additional sampling pass, no persistence.
   * Returns the task's sample when present, or an explicit `not-running` state
   * (never an error, never fabricated zeros) when the task has no live sampled
   * container, so the console can honestly render "未运行/未采样".
   */
  buildTaskResource(taskId: string, now: number = Date.now()): TaskResourceResponse {
    // The sampler resolves the per-task reading: codex's OWN process subtree as
    // the PRIMARY figure (`scope: 'process'`) with the container aggregate as
    // background; the container aggregate as FALLBACK (`scope: 'container'`) when
    // the in-sandbox process read is unavailable; `null` (not-running) only when
    // the task has no live reading at all (not running / gone past carry-forward).
    const reading = this.sampler.taskReading(taskId, now);
    if (!reading) {
      return { state: 'not-running' };
    }
    return {
      state: 'sampled',
      scope: reading.scope,
      sample: reading.sample,
      container: reading.container,
      sampledAt: reading.sampledAt,
      ageMs: reading.ageMs,
    };
  }
}
