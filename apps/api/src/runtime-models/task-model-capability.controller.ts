import { Controller, Get } from '@nestjs/common';
import {
  TASK_MODEL_SELECTION_CAPABILITY,
  TaskModelSelectionCapabilityStatusSchema,
  type TaskModelSelectionCapabilityStatus,
} from '@cap/contracts';
import { TaskModelCapabilityService } from './task-model-capability.service';

/** Safe per-instance operational report; raw attestation/config is never exposed. */
@Controller('deployment-capabilities/task-model-selection-v1')
export class TaskModelCapabilityController {
  constructor(private readonly capabilities: TaskModelCapabilityService) {}

  @Get()
  status(): TaskModelSelectionCapabilityStatus {
    return TaskModelSelectionCapabilityStatusSchema.parse({
      capability: TASK_MODEL_SELECTION_CAPABILITY,
      gate: this.capabilities.evaluate(),
      localReports: this.capabilities.localRoleReports(),
    });
  }
}
