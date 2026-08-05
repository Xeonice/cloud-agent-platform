import { Injectable } from '@nestjs/common';
import { RunnerMinutesLedger, type RunningInterval } from './runner-minutes';
import type { RunnerMinutesPort } from './runner-minutes-ledger.port';

/**
 * The OWNER of the in-process running-interval ledger (extract-runner-minutes-ledger).
 *
 * State ownership moved here and nothing else moved with it: this class holds
 * the ledger as a PRIVATE field and delegates the three port methods to it,
 * unchanged. There is deliberately no logging, no persistence, no metrics
 * emission, no timer, no retry and no error handling the ledger did not already
 * have — the move is a relocation, so any of those would be new behaviour
 * arriving under cover of a refactor.
 *
 * The instance is a field of a DI provider, not a module-level singleton, so
 * "one ledger per booted process" is a fact about the Nest container rather
 * than a fact about module evaluation order.
 */
@Injectable()
export class RunnerMinutesLedgerService implements RunnerMinutesPort {
  private readonly ledger = new RunnerMinutesLedger();

  recordStart(taskId: string): void {
    this.ledger.recordStart(taskId);
  }

  recordEnd(taskId: string): void {
    this.ledger.recordEnd(taskId);
  }

  intervals(): RunningInterval[] {
    return this.ledger.intervals();
  }
}
