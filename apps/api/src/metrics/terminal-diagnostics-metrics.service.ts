import { Injectable } from '@nestjs/common';
import {
  TERMINAL_ATTACH_OUTCOMES,
  TERMINAL_CLEANUP_OUTCOMES,
  TerminalAttachOutcomeSchema,
  TerminalCleanupOutcomeSchema,
  TerminalDiagnosticsMetricsSchema,
  type TerminalAttachOutcome,
  type TerminalCleanupOutcome,
  type TerminalDiagnosticsMetrics,
} from '@cap-console/contracts';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * Process-window native-terminal metrics with no identifier-bearing inputs.
 *
 * The collector accepts only closed contract enums and aggregate state
 * transitions. It never sees task/session/provider identities, so the public
 * `/metrics` projection cannot accidentally grow a high-cardinality label set
 * or retain terminal credentials/endpoints.
 */
@Injectable()
export class TerminalDiagnosticsMetricsService {
  private readonly observedSince = new Date();
  private activeViewers = 0;
  private pausedViewers = 0;
  private pauseCount = 0;
  private resumeCount = 0;
  private readonly attachOutcomeCounts = new Map<TerminalAttachOutcome, number>(
    TERMINAL_ATTACH_OUTCOMES.map((outcome) => [outcome, 0]),
  );
  private readonly cleanupOutcomeCounts = new Map<
    TerminalCleanupOutcome,
    number
  >(TERMINAL_CLEANUP_OUTCOMES.map((outcome) => [outcome, 0]));

  /** One viewer passed admission and is now attaching or ready. */
  viewerActivated(): void {
    this.activeViewers = saturatingIncrement(this.activeViewers);
  }

  /**
   * One admitted viewer left. The caller supplies only its local paused bit so
   * both gauges settle atomically without exposing any viewer identity.
   */
  viewerDeactivated(wasPaused: boolean): void {
    this.activeViewers = decrementFloorZero(this.activeViewers);
    if (wasPaused) {
      this.pausedViewers = decrementFloorZero(this.pausedViewers);
    }
    this.pausedViewers = Math.min(this.pausedViewers, this.activeViewers);
  }

  /** One viewer-local high-water transition paused its outer PTY. */
  viewerPaused(): void {
    this.pauseCount = saturatingIncrement(this.pauseCount);
    if (this.pausedViewers < this.activeViewers) {
      this.pausedViewers += 1;
    }
  }

  /** One ACK-driven low-water transition resumed its outer PTY. */
  viewerResumed(): void {
    this.resumeCount = saturatingIncrement(this.resumeCount);
    this.pausedViewers = decrementFloorZero(this.pausedViewers);
  }

  /** Record exactly one terminal outcome for an accepted attach attempt. */
  observeAttachOutcome(outcome: unknown): void {
    const parsed = TerminalAttachOutcomeSchema.safeParse(outcome);
    if (!parsed.success) return;
    this.attachOutcomeCounts.set(
      parsed.data,
      saturatingIncrement(this.attachOutcomeCounts.get(parsed.data) ?? 0),
    );
  }

  /** Record one bounded provider outer-PTY cleanup decision. */
  observeCleanupOutcome(outcome: unknown): void {
    const parsed = TerminalCleanupOutcomeSchema.safeParse(outcome);
    if (!parsed.success) return;
    this.cleanupOutcomeCounts.set(
      parsed.data,
      saturatingIncrement(this.cleanupOutcomeCounts.get(parsed.data) ?? 0),
    );
  }

  /** Return an IO-free, stable-order snapshot for the existing `/metrics` path. */
  currentSnapshot(): TerminalDiagnosticsMetrics {
    const candidate = TerminalDiagnosticsMetricsSchema.safeParse({
      observedSince: new Date(this.observedSince),
      gauges: {
        activeViewers: this.activeViewers,
        pausedViewers: this.pausedViewers,
      },
      attachOutcomes: TERMINAL_ATTACH_OUTCOMES.map((outcome) => ({
        outcome,
        count: this.attachOutcomeCounts.get(outcome) ?? 0,
      })),
      flowControl: {
        pauseCount: this.pauseCount,
        resumeCount: this.resumeCount,
      },
      cleanupOutcomes: TERMINAL_CLEANUP_OUTCOMES.map((outcome) => ({
        outcome,
        count: this.cleanupOutcomeCounts.get(outcome) ?? 0,
      })),
    });
    if (candidate.success) return candidate.data;

    // Internal drift degrades only this optional additive block. Returning the
    // closed zero shape keeps `/metrics` available without fabricating identity
    // labels or leaking the rejected candidate.
    return {
      observedSince: new Date(this.observedSince),
      gauges: { activeViewers: 0, pausedViewers: 0 },
      attachOutcomes: TERMINAL_ATTACH_OUTCOMES.map((outcome) => ({
        outcome,
        count: 0,
      })),
      flowControl: { pauseCount: 0, resumeCount: 0 },
      cleanupOutcomes: TERMINAL_CLEANUP_OUTCOMES.map((outcome) => ({
        outcome,
        count: 0,
      })),
    };
  }
}

function saturatingIncrement(value: number): number {
  return value >= MAX_SAFE_INTEGER ? MAX_SAFE_INTEGER : value + 1;
}

function decrementFloorZero(value: number): number {
  return value <= 0 ? 0 : value - 1;
}
