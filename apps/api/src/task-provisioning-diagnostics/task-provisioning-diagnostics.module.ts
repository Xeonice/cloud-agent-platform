import { Global, Module } from '@nestjs/common';

import { TASK_PROVISIONING_DIAGNOSTIC_RECORDER } from './task-provisioning-diagnostic-recorder.port';
import {
  TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
} from './task-provisioning-diagnostics-deployment-gate.port';
import { TaskProvisioningDiagnosticsCapabilityService } from './task-provisioning-diagnostics-capability.service';
import { TaskProvisioningDiagnosticsConsoleController } from './task-provisioning-diagnostics-console.controller';
import { TaskProvisioningDiagnosticsConsoleQueryService } from './task-provisioning-diagnostics-console-query.service';
import { TaskProvisioningDiagnosticsMetricsService } from './task-provisioning-diagnostics-metrics.service';
import { TaskProvisioningDiagnosticsService } from './task-provisioning-diagnostics.service';
import { TaskProvisioningDiagnosticsPublicQueryService } from './task-provisioning-diagnostics-public-query.service';
import {
  EnvironmentTaskProvisioningDiagnosticsWriteGate,
  TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
} from './task-provisioning-diagnostics-write-gate.port';

/**
 * Global leaf module for the task-owned diagnostic ledger.  It imports no
 * lifecycle/provider module, so Guardrails and adapters can consume the narrow
 * recorder token without introducing a dependency cycle.
 */
@Global()
@Module({
  controllers: [TaskProvisioningDiagnosticsConsoleController],
  providers: [
    TaskProvisioningDiagnosticsService,
    TaskProvisioningDiagnosticsPublicQueryService,
    TaskProvisioningDiagnosticsConsoleQueryService,
    TaskProvisioningDiagnosticsCapabilityService,
    TaskProvisioningDiagnosticsMetricsService,
    EnvironmentTaskProvisioningDiagnosticsWriteGate,
    {
      provide: TASK_PROVISIONING_DIAGNOSTIC_RECORDER,
      useExisting: TaskProvisioningDiagnosticsService,
    },
    {
      provide: TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
      useExisting: EnvironmentTaskProvisioningDiagnosticsWriteGate,
    },
    {
      provide: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
      useExisting: TaskProvisioningDiagnosticsCapabilityService,
    },
  ],
  exports: [
    TaskProvisioningDiagnosticsService,
    TaskProvisioningDiagnosticsPublicQueryService,
    TaskProvisioningDiagnosticsCapabilityService,
    TaskProvisioningDiagnosticsMetricsService,
    TASK_PROVISIONING_DIAGNOSTIC_RECORDER,
    EnvironmentTaskProvisioningDiagnosticsWriteGate,
    TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
    TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
  ],
})
export class TaskProvisioningDiagnosticsModule {}
