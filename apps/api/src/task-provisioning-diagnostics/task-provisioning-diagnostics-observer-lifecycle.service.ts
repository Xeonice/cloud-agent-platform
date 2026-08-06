import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  TASK_PROVISIONING_DIAGNOSTIC_RECORDER,
  type TaskProvisioningDiagnosticRecorderPort,
} from './task-provisioning-diagnostic-recorder.port';
import {
  TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
  type TaskProvisioningDiagnosticsWriteGatePort,
} from './task-provisioning-diagnostics-write-gate.port';
import {
  TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT,
  TaskProvisioningDiagnosticsObserverLifecycle,
} from './task-provisioning-diagnostics-observer-lifecycle.port';

/**
 * The container's binding for the observer lifecycle, and nothing else.
 *
 * The behaviour is the owner's — see
 * {@link TaskProvisioningDiagnosticsObserverLifecycle}. This subclass exists so
 * a wired application resolves the recorder, the write gate and the write bound
 * from the injector instead of being handed them. All three are `@Optional()`
 * on purpose: an unbound collaborator is a legitimate state that the owner
 * answers with the "no observer" result, never a startup failure.
 */
@Injectable()
export class TaskProvisioningDiagnosticsObserverLifecycleService extends TaskProvisioningDiagnosticsObserverLifecycle {
  constructor(
    @Optional()
    @Inject(TASK_PROVISIONING_DIAGNOSTIC_RECORDER)
    recorder?: TaskProvisioningDiagnosticRecorderPort,
    @Optional()
    @Inject(TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE)
    writeGate?: TaskProvisioningDiagnosticsWriteGatePort,
    @Optional()
    @Inject(TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT)
    writeTimeoutMs?: number,
  ) {
    super({ recorder, writeGate, writeTimeoutMs });
  }
}
