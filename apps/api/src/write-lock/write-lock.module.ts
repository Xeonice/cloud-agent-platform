import { Module } from '@nestjs/common';

import { WriteLockService } from './write-lock.service';

/**
 * Self-contained orchestrator module owning the application-layer write lock
 * (single-writer / multi-reader lease, heartbeat/expiry, auto-release on
 * disconnect, and preemptive takeover — design D7).
 *
 * Exports {@link WriteLockService} so the realtime-terminal gateway can consult
 * the lease on the keystroke path. That gateway wiring (keystroke gating +
 * lock-independent approvals) is performed by the orchestrator-integration track;
 * this module deliberately owns only the lease state machine.
 */
@Module({
  providers: [WriteLockService],
  exports: [WriteLockService],
})
export class WriteLockModule {}
