import { Module } from '@nestjs/common';
import { CAPACITY_PROJECTION_PORT } from './capacity-projection.port';
import { CapacityProjectionService } from './capacity-projection.service';
import { RUNNER_MINUTES_PORT } from './runner-minutes-ledger.port';
import { RunnerMinutesLedgerService } from './runner-minutes-ledger.service';

/**
 * Composition of this directory's owners (extract-runner-minutes-ledger,
 * collapse-three-collaborator-groups).
 *
 * The running-interval ledger is provided under {@link RUNNER_MINUTES_PORT} and
 * the derived capacity/occupancy projection under {@link CAPACITY_PROJECTION_PORT};
 * only those tokens are exported, so an importing module can inject either port
 * but cannot reach the concrete owner classes. Importing this module is what
 * makes one ledger instance serve both the write side and the read side of a
 * booted process, and one projection owner serve every capacity reader.
 *
 * The projection owner joins the module that already exists rather than
 * bringing a second one: `app.module.ts` and `metrics.module.ts` both import
 * this module already, so nothing new reaches the composition root.
 */
@Module({
  providers: [
    { provide: RUNNER_MINUTES_PORT, useClass: RunnerMinutesLedgerService },
    { provide: CAPACITY_PROJECTION_PORT, useClass: CapacityProjectionService },
  ],
  exports: [RUNNER_MINUTES_PORT, CAPACITY_PROJECTION_PORT],
})
export class RunnerMinutesModule {}
