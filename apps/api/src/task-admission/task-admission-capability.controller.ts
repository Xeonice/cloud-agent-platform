import { Controller, Get } from '@nestjs/common';
import {
  TASK_ADMISSION_V2_CAPABILITY,
  TaskAdmissionV2CapabilityStatusSchema,
  type TaskAdmissionV2CapabilityStatus,
} from '@cap/contracts';
import { TaskAdmissionCapabilityService } from './task-admission-capability.service';

/** Safe read-only operational status; raw attestation and environment stay private. */
@Controller('deployment-capabilities/task-admission-v2')
export class TaskAdmissionCapabilityController {
  constructor(private readonly capabilities: TaskAdmissionCapabilityService) {}

  @Get()
  status(): TaskAdmissionV2CapabilityStatus {
    return TaskAdmissionV2CapabilityStatusSchema.parse({
      capability: TASK_ADMISSION_V2_CAPABILITY,
      gate: this.capabilities.evaluate(),
      localReports: this.capabilities.localRoleReports(),
    });
  }
}
