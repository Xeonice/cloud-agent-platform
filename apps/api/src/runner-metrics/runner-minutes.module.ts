import { Module } from '@nestjs/common';
import { RUNNER_MINUTES_PORT } from './runner-minutes-ledger.port';
import { RunnerMinutesLedgerService } from './runner-minutes-ledger.service';

/**
 * Composition of the running-interval ledger owner (extract-runner-minutes-ledger).
 *
 * The owner is provided under {@link RUNNER_MINUTES_PORT} and only that token is
 * exported, so an importing module can inject the port but cannot reach the
 * concrete owner class. Importing this module is what makes one ledger instance
 * serve both the write side and the read side of a booted process.
 */
@Module({
  providers: [
    { provide: RUNNER_MINUTES_PORT, useClass: RunnerMinutesLedgerService },
  ],
  exports: [RUNNER_MINUTES_PORT],
})
export class RunnerMinutesModule {}
