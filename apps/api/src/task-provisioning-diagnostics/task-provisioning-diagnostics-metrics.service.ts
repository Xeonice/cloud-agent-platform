import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import {
  ProvisioningDiagnosticsMetricsSchema,
  TaskProvisioningDiagnosticAnomalySchema,
  TaskProvisioningDiagnosticCauseSchema,
  TaskProvisioningDiagnosticCleanupStateSchema,
  TaskProvisioningDiagnosticOperationSchema,
  TaskProvisioningDiagnosticProviderFamilySchema,
  TaskProvisioningDiagnosticStageSchema,
  TaskProvisioningDiagnosticTerminalOutcomeSchema,
  type ProvisioningDiagnosticsAnomalyEntry,
  type ProvisioningDiagnosticsAttemptOutcomeEntry,
  type ProvisioningDiagnosticsCleanupOutcomeEntry,
  type ProvisioningDiagnosticsDurationSummary,
  type ProvisioningDiagnosticsMetrics,
  type ProvisioningDiagnosticsRetryEntry,
  type ProvisioningDiagnosticsStageOutcomeEntry,
} from '@cap/contracts';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';

export const TASK_PROVISIONING_DIAGNOSTICS_METRICS_OPTIONS =
  'TASK_PROVISIONING_DIAGNOSTICS_METRICS_OPTIONS';

export const DEFAULT_TASK_PROVISIONING_DIAGNOSTICS_METRICS_CADENCE_MS =
  10_000;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_DATE_MS = 8_640_000_000_000_000;
const NonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_SAFE_INTEGER);

export interface TaskProvisioningDiagnosticsMetricsOptions {
  /** Durable gauge refresh cadence. */
  readonly cadenceMs?: number;
  /** Age after which the latest successful durable sample is stale. */
  readonly staleAfterMs?: number;
  /** Testable process clock; production defaults to `Date.now`. */
  readonly now?: () => number;
}

const ObserveRetrySchema = z
  .object({
    /** Explicit provenance: initial and recovery attempts are never retries. */
    kind: z.literal('retry'),
    providerFamily: TaskProvisioningDiagnosticProviderFamilySchema,
    stage: TaskProvisioningDiagnosticStageSchema,
    cause: TaskProvisioningDiagnosticCauseSchema,
  })
  .strict();

const ObserveEventSchema = z
  .object({
    providerFamily: TaskProvisioningDiagnosticProviderFamilySchema,
    stage: TaskProvisioningDiagnosticStageSchema,
    operation: TaskProvisioningDiagnosticOperationSchema,
    outcome: TaskProvisioningDiagnosticTerminalOutcomeSchema,
    durationMs: NonnegativeSafeIntegerSchema.nullable(),
    anomaly: TaskProvisioningDiagnosticAnomalySchema.nullable(),
  })
  .strict();

const ObserveAttemptOutcomeSchema = z
  .object({
    providerFamily: TaskProvisioningDiagnosticProviderFamilySchema,
    outcome: TaskProvisioningDiagnosticTerminalOutcomeSchema,
    cause: TaskProvisioningDiagnosticCauseSchema.nullable(),
    retryable: z.boolean(),
    durationMs: NonnegativeSafeIntegerSchema.nullable(),
  })
  .strict();

const ObserveCleanupTransitionSchema = z
  .object({
    providerFamily: TaskProvisioningDiagnosticProviderFamilySchema,
    cleanupState: TaskProvisioningDiagnosticCleanupStateSchema,
    cause: TaskProvisioningDiagnosticCauseSchema.nullable(),
  })
  .strict();

interface MutableDurationSummary {
  count: number;
  sumMs: number;
  maxMs: number;
}

interface DurableGaugeCache {
  readonly sampledAt: Date;
  readonly activeAttempts: number;
  readonly oldestActiveAttemptStartedAt: Date | null;
  readonly cleanupPendingRuns: number;
  readonly confirmedOrphanRuns: number;
}

/**
 * Process-window, low-cardinality provisioning metrics plus a background cache
 * of durable current gauges.
 *
 * The service deliberately retains only closed label tuples and aggregate
 * numbers. Identifier-bearing inputs are rejected at the observation edge.
 * `currentSnapshot()` performs no IO, so the existing `/metrics` request path
 * cannot be delayed by Prisma availability.
 */
@Injectable()
export class TaskProvisioningDiagnosticsMetricsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    TaskProvisioningDiagnosticsMetricsService.name,
  );
  private readonly cadenceMs: number;
  private readonly staleAfterMs: number;
  private readonly clock: () => number;
  private readonly observedSince: Date;

  private readonly attemptOutcomes = new Map<
    string,
    ProvisioningDiagnosticsAttemptOutcomeEntry
  >();
  private readonly stageOutcomes = new Map<
    string,
    ProvisioningDiagnosticsStageOutcomeEntry
  >();
  private readonly retries = new Map<string, ProvisioningDiagnosticsRetryEntry>();
  private readonly cleanupOutcomes = new Map<
    string,
    ProvisioningDiagnosticsCleanupOutcomeEntry
  >();
  private readonly anomalies = new Map<
    string,
    ProvisioningDiagnosticsAnomalyEntry
  >();

  private durableGaugeCache: DurableGaugeCache | null = null;
  private durableSourceFailed = false;
  private refreshInFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(TASK_PROVISIONING_DIAGNOSTICS_METRICS_OPTIONS)
    options?: TaskProvisioningDiagnosticsMetricsOptions,
  ) {
    this.clock = options?.now ?? Date.now;
    this.cadenceMs = positiveSafeInteger(
      options?.cadenceMs ??
        readPositiveSafeInteger(
          process.env.TASK_PROVISIONING_DIAGNOSTICS_METRICS_CADENCE_MS,
        ),
      DEFAULT_TASK_PROVISIONING_DIAGNOSTICS_METRICS_CADENCE_MS,
    );
    this.staleAfterMs = positiveSafeInteger(
      options?.staleAfterMs ??
        readPositiveSafeInteger(
          process.env.TASK_PROVISIONING_DIAGNOSTICS_METRICS_STALE_MS,
        ),
      saturatingMultiply(this.cadenceMs, 3),
    );
    this.observedSince = new Date(this.now());
  }

  /** Start one immediate best-effort hydration and then the bounded refresh loop. */
  onApplicationBootstrap(): void {
    void this.refreshDurableGauges();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refreshDurableGauges();
    }, this.cadenceMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Observe one committed, non-replayed terminal operation projection. The
   * strict input deliberately has no event/task/attempt/operation identifier.
   */
  observeEvent(event: unknown): void {
    try {
      const parsed = ObserveEventSchema.safeParse(event);
      if (!parsed.success) return;

      const value = parsed.data;
      const key = metricKey(
        value.providerFamily,
        value.stage,
        value.operation,
        value.outcome,
      );
      const entry = this.stageOutcomes.get(key) ?? {
        providerFamily: value.providerFamily,
        stage: value.stage,
        operation: value.operation,
        outcome: value.outcome,
        count: 0,
        duration: emptyDurationSummary(),
      };
      entry.count = saturatingAdd(entry.count, 1);
      observeDuration(entry.duration, value.durationMs);
      this.stageOutcomes.set(key, entry);

      if (value.anomaly) {
        this.observeAnomaly(value.providerFamily, value.anomaly);
      }
    } catch {
      // Metrics are observability only and can never become admission authority.
    }
  }

  /** Observe one committed, non-replayed primary-outcome projection. */
  observeAttemptOutcome(attempt: unknown): void {
    try {
      const parsed = ObserveAttemptOutcomeSchema.safeParse(attempt);
      if (!parsed.success) return;

      const value = parsed.data;
      const key = metricKey(
        value.providerFamily,
        value.outcome,
        value.cause,
        value.retryable,
      );
      const entry = this.attemptOutcomes.get(key) ?? {
        providerFamily: value.providerFamily,
        outcome: value.outcome,
        cause: value.cause,
        retryable: value.retryable,
        count: 0,
        duration: emptyDurationSummary(),
      };
      entry.count = saturatingAdd(entry.count, 1);
      observeDuration(entry.duration, value.durationMs);
      this.attemptOutcomes.set(key, entry);
    } catch {
      // Metrics are observability only and can never become admission authority.
    }
  }

  /** Observe one committed cleanup-state transition independently of primary. */
  observeCleanupTransition(attempt: unknown): void {
    try {
      const parsed = ObserveCleanupTransitionSchema.safeParse(attempt);
      if (!parsed.success) return;

      const value = parsed.data;
      const key = metricKey(
        value.providerFamily,
        value.cleanupState,
        value.cause,
      );
      const entry = this.cleanupOutcomes.get(key) ?? {
        providerFamily: value.providerFamily,
        cleanupState: value.cleanupState,
        cause: value.cause,
        count: 0,
      };
      entry.count = saturatingAdd(entry.count, 1);
      this.cleanupOutcomes.set(key, entry);
    } catch {
      // Metrics are observability only and can never become admission authority.
    }
  }

  /**
   * Observe a caller-proven retry. The literal `kind` prevents callers from
   * deriving a retry from attempt number or retryability and counting recovery.
   */
  observeRetry(input: unknown): void {
    try {
      const parsed = ObserveRetrySchema.safeParse(input);
      if (!parsed.success) return;

      const value = parsed.data;
      const key = metricKey(
        value.providerFamily,
        value.stage,
        value.cause,
      );
      const entry = this.retries.get(key) ?? {
        providerFamily: value.providerFamily,
        stage: value.stage,
        cause: value.cause,
        count: 0,
      };
      entry.count = saturatingAdd(entry.count, 1);
      this.retries.set(key, entry);
    } catch {
      // Metrics are observability only and can never become admission authority.
    }
  }

  /**
   * Refresh durable current gauges in the background. A first failure leaves an
   * unavailable cache; a later failure retains the last good sample as stale.
   */
  refreshDurableGauges(now?: number): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.performDurableGaugeRefresh(now).finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  private async performDurableGaugeRefresh(now?: number): Promise<void> {
    try {
      const [active, cleanupPendingRuns, confirmedOrphanRuns] =
        await this.prisma.$transaction(
          async (transaction) =>
            Promise.all([
              transaction.taskProvisioningDiagnosticAttempt.aggregate({
                where: { state: 'active' },
                _count: true,
                _min: { startedAt: true },
              }),
              transaction.sandboxRun.count({
                where: { status: 'deleting' },
              }),
              transaction.sandboxRun.count({
                where: {
                  status: { in: ['deleting', 'failed'] },
                  cleanupOrphanConfirmedAt: { not: null },
                },
              }),
            ]),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );

      const activeAttempts = requiredSafeInteger(active._count);
      const oldest = active._min.startedAt;
      if (
        activeAttempts > 0 &&
        (!(oldest instanceof Date) || !Number.isFinite(oldest.getTime()))
      ) {
        throw new Error('active attempt gauge source is incomplete');
      }

      this.durableGaugeCache = {
        sampledAt: new Date(this.now(now)),
        activeAttempts,
        oldestActiveAttemptStartedAt:
          activeAttempts === 0 ? null : new Date(oldest as Date),
        cleanupPendingRuns: requiredSafeInteger(cleanupPendingRuns),
        confirmedOrphanRuns: requiredSafeInteger(confirmedOrphanRuns),
      };
      this.durableSourceFailed = false;
    } catch {
      const newlyFailed = !this.durableSourceFailed;
      this.durableSourceFailed = true;
      if (newlyFailed) {
        this.logger.warn(
          'task provisioning diagnostics durable gauge refresh failed',
        );
      }
    }
  }

  /** Return the complete cached block synchronously; this method performs no IO. */
  currentSnapshot(now?: number): ProvisioningDiagnosticsMetrics {
    const nowMs = this.now(now);
    const cache = this.durableGaugeCache;
    const durableGauges: ProvisioningDiagnosticsMetrics['durableGauges'] = cache
      ? {
          status:
            this.durableSourceFailed ||
            nonnegativeSafeDifference(nowMs, cache.sampledAt.getTime()) >
              this.staleAfterMs
              ? 'stale'
              : 'available',
          sampledAt: new Date(cache.sampledAt),
          ageMs: nonnegativeSafeDifference(
            nowMs,
            cache.sampledAt.getTime(),
          ),
          activeAttempts: cache.activeAttempts,
          oldestActiveAttemptAgeMs: cache.oldestActiveAttemptStartedAt
            ? nonnegativeSafeDifference(
                nowMs,
                cache.oldestActiveAttemptStartedAt.getTime(),
              )
            : null,
          cleanupPendingRuns: cache.cleanupPendingRuns,
          confirmedOrphanRuns: cache.confirmedOrphanRuns,
        }
      : {
          status: 'unavailable',
          sampledAt: null,
          ageMs: null,
          activeAttempts: null,
          oldestActiveAttemptAgeMs: null,
          cleanupPendingRuns: null,
          confirmedOrphanRuns: null,
        };

    const candidate = ProvisioningDiagnosticsMetricsSchema.safeParse({
      observedSince: new Date(this.observedSince),
      attemptOutcomes: sortedEntries(this.attemptOutcomes, cloneAttemptOutcome),
      stageOutcomes: sortedEntries(this.stageOutcomes, cloneStageOutcome),
      retries: sortedEntries(this.retries, (entry) => ({ ...entry })),
      cleanupOutcomes: sortedEntries(this.cleanupOutcomes, (entry) => ({
        ...entry,
      })),
      anomalies: sortedEntries(this.anomalies, (entry) => ({ ...entry })),
      durableGauges,
    });
    if (candidate.success) return candidate.data;

    // A future internal/contract drift must degrade only this additive block,
    // never fail the existing `/metrics` response.
    return {
      observedSince: new Date(this.observedSince),
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

  private observeAnomaly(
    providerFamily: z.infer<
      typeof TaskProvisioningDiagnosticProviderFamilySchema
    >,
    anomaly: z.infer<typeof TaskProvisioningDiagnosticAnomalySchema>,
  ): void {
    const key = metricKey(providerFamily, anomaly);
    const entry = this.anomalies.get(key) ?? {
      providerFamily,
      anomaly,
      count: 0,
    };
    entry.count = saturatingAdd(entry.count, 1);
    this.anomalies.set(key, entry);
  }

  private now(candidate?: number): number {
    if (candidate !== undefined) return validDateEpoch(candidate);
    try {
      return validDateEpoch(this.clock());
    } catch {
      return Date.now();
    }
  }
}

function emptyDurationSummary(): MutableDurationSummary {
  return { count: 0, sumMs: 0, maxMs: 0 };
}

function observeDuration(
  summary: MutableDurationSummary,
  durationMs: number | null,
): void {
  if (durationMs === null) return;
  const safeDuration = nonnegativeSafeInteger(durationMs);
  summary.count = saturatingAdd(summary.count, 1);
  summary.sumMs = saturatingAdd(summary.sumMs, safeDuration);
  summary.maxMs = Math.max(summary.maxMs, safeDuration);
}

function cloneDuration(
  duration: ProvisioningDiagnosticsDurationSummary,
): ProvisioningDiagnosticsDurationSummary {
  return { ...duration };
}

function cloneAttemptOutcome(
  entry: ProvisioningDiagnosticsAttemptOutcomeEntry,
): ProvisioningDiagnosticsAttemptOutcomeEntry {
  return { ...entry, duration: cloneDuration(entry.duration) };
}

function cloneStageOutcome(
  entry: ProvisioningDiagnosticsStageOutcomeEntry,
): ProvisioningDiagnosticsStageOutcomeEntry {
  return { ...entry, duration: cloneDuration(entry.duration) };
}

function sortedEntries<T>(
  entries: ReadonlyMap<string, T>,
  clone: (entry: T) => T,
): T[] {
  return [...entries.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, entry]) => clone(entry));
}

function metricKey(...labels: readonly (string | boolean | null)[]): string {
  return labels
    .map((label) => (label === null ? '<none>' : String(label)))
    .join('\u0000');
}

function saturatingAdd(left: number, right: number): number {
  return right > MAX_SAFE_INTEGER - left ? MAX_SAFE_INTEGER : left + right;
}

function saturatingMultiply(left: number, right: number): number {
  return left > MAX_SAFE_INTEGER / right
    ? MAX_SAFE_INTEGER
    : Math.floor(left * right);
}

function nonnegativeSafeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= MAX_SAFE_INTEGER) return MAX_SAFE_INTEGER;
  return Math.floor(value);
}

function requiredSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('durable gauge source returned an invalid count');
  }
  return value;
}

function nonnegativeSafeDifference(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= right) {
    return 0;
  }
  return nonnegativeSafeInteger(left - right);
}

function validDateEpoch(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS
    ? value
    : Date.now();
}

function positiveSafeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function readPositiveSafeInteger(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
