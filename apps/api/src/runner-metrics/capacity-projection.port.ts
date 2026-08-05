import type { CapacityMetrics, SlotOccupancy } from '@cap-console/contracts';
import type { SemaphoreProjectionSource } from './metrics-projection';

/**
 * Derived-capacity projection PORT (collapse-three-collaborator-groups).
 *
 * The capacity/occupancy projection the `/metrics` response derives is OWNED by
 * one provider in this directory (`capacity-projection.service.ts`, registered
 * under {@link CAPACITY_PROJECTION_PORT} by `runner-minutes.module.ts`), exactly
 * as the running-interval ledger next door already is. The metrics reader
 * reaches that owner through THIS interface and that token — never through a
 * forwarding accessor on the orchestrator, which is what this port replaces.
 *
 * The surface is deliberately the reads the metrics response already made, in
 * the shape it already made them. Nothing is derived here that the pure
 * `projectCapacity` / `buildSlotOccupancy` functions did not already derive.
 */
export interface CapacityProjection {
  /** Exact scalar capacity figures — `projectCapacity` over one live reading. */
  capacity: CapacityMetrics;
  /** The slot table + FIFO queue — `buildSlotOccupancy` over the same reading. */
  occupancy: SlotOccupancy;
  /** Task ids holding a running slot, from that same reading. */
  runningTaskIds: string[];
}

export interface CapacityProjectionPort {
  /**
   * Registers the LIVE admission source the projection reads.
   *
   * The admission state itself stays where the admission decisions are made:
   * this port owns the PROJECTION, not the semaphore. The orchestrator that
   * owns the semaphore hands it in ONCE, at boot, the same way it resolves
   * `RUNNER_MINUTES_PORT` in its `onModuleInit` — the mirror image of the
   * runner-minutes seam, which pushes writes to an owner it resolves there too.
   *
   * The concrete `ConcurrencySemaphore` satisfies {@link SemaphoreProjectionSource}
   * structurally, so the caller passes it directly and never names this type.
   */
  bindSource(source: SemaphoreProjectionSource): void;
  /**
   * Everything the metrics response derives from admission state, from ONE
   * reading — so `capacity`, `occupancy` and `runningTaskIds` cannot disagree
   * about the instant they describe.
   */
  project(): CapacityProjection;
  /**
   * The live running set alone, for callers that need only it (the resource
   * sampler's running-task-id source polls this on its own cadence).
   */
  runningTaskIds(): string[];
}

/** DI token the owner is provided under, and the only way to inject it. */
export const CAPACITY_PROJECTION_PORT = 'CAPACITY_PROJECTION_PORT';
