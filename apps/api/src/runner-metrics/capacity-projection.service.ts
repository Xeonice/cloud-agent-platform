import { Injectable } from '@nestjs/common';
import {
  buildSlotOccupancy,
  projectCapacity,
  type SemaphoreProjectionSource,
} from './metrics-projection';
import type {
  CapacityProjection,
  CapacityProjectionPort,
} from './capacity-projection.port';

/**
 * The OWNER of the derived capacity/occupancy projection
 * (collapse-three-collaborator-groups).
 *
 * Ownership of the PROJECTION moved here and nothing else moved with it: the
 * two pure derivations already lived in this directory, and this class does no
 * more than read the bound source once and hand them that reading. There is
 * deliberately no logging, no persistence, no metrics emission, no timer, no
 * retry and no error handling the projection did not already have — the move is
 * a relocation, so any of those would be new behaviour arriving under cover of
 * a refactor.
 *
 * What is NOT owned here is the admission state itself: slots are granted and
 * released where the admission decisions are made. This owner holds a reference
 * to that state's read-only view and re-reads it per projection, so a `/metrics`
 * read still reflects the exact admission state at request time — there is NO
 * parallel counter that could drift.
 */
@Injectable()
export class CapacityProjectionService implements CapacityProjectionPort {
  /**
   * The live read-only view of admission state, registered once at boot.
   *
   * Null until then, and never defaulted to an empty stand-in: a zero-slot
   * stand-in would serve a plausible-looking capacity block for a process whose
   * projection was never wired, which is indistinguishable from a genuinely
   * idle process. The read below fails loudly instead.
   */
  private source: SemaphoreProjectionSource | null = null;

  bindSource(source: SemaphoreProjectionSource): void {
    this.source = source;
  }

  /**
   * Reads the source ONCE and derives every admission-state figure the metrics
   * response carries from that single reading, so the scalar block, the slot
   * table and the running set cannot describe different instants.
   */
  project(): CapacityProjection {
    const source = this.boundSource();
    return {
      capacity: projectCapacity(source),
      occupancy: buildSlotOccupancy(source),
      runningTaskIds: source.snapshotRunning(),
    };
  }

  runningTaskIds(): string[] {
    return this.boundSource().snapshotRunning();
  }

  /**
   * The bound source, or a loud composition failure.
   *
   * This is a wiring assertion, not projection error handling: the projection
   * has no failure mode of its own, and an unbound owner is a composition that
   * never registered the admission source rather than a degraded reading.
   */
  private boundSource(): SemaphoreProjectionSource {
    if (this.source === null) {
      throw new Error(
        'capacity projection has no bound admission source: the owner of the ' +
          'admission state must call bindSource() once at boot',
      );
    }
    return this.source;
  }
}
