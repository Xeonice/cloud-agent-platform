import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { GuardrailsService } from '../guardrails/guardrails.service';
import type {
  TaskAdmissionProcessor,
  TaskAdmissionProcessorContext,
  TaskAdmissionProcessResult,
  TaskAdmissionTerminalFailure,
  TaskAdmissionTerminalRecovery,
} from './task-admission.types';

/**
 * Provisioning-level detached-job marker probe triage (detach-workspace-clone
 * D9) lives in `./parked-admission-triage` so GuardrailsService — the claim
 * path's processor implementation — can invoke it without a module cycle
 * through this DI adapter. Re-exported here to keep the historical import
 * surface stable.
 */
export {
  triageParkedAdmissionMarkers,
  type ParkedAdmissionMarkerProbe,
  type ParkedAdmissionMarkerTriage,
} from './parked-admission-triage';

/**
 * Thin DI adapter. Guardrails remains the single owner of capacity, lifecycle,
 * provider selection/readoption, timers, launch and terminal settlement; the
 * durable worker supplies its database-backed lease/status/version authority.
 * ModuleRef keeps the existing Tasks <-> Guardrails construction cycle lazy.
 *
 * Parked detached-transfer claims (detach-workspace-clone) also route through
 * `process`: guardrails performs the {@link triageParkedAdmissionMarkers}
 * decision alongside its durable-protected snapshot before resuming, keeping
 * the marker probe inside the claim/processor ownership boundary.
 */
@Injectable()
export class FencedTaskAdmissionProcessor implements TaskAdmissionProcessor {
  constructor(private readonly moduleRef: ModuleRef) {}

  process(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionProcessResult> {
    return this.moduleRef
      .get(GuardrailsService, { strict: false })
      .processDurableAdmission(context);
  }

  settleTerminalFailure(
    context: TaskAdmissionProcessorContext,
    failure: TaskAdmissionTerminalFailure,
  ): Promise<boolean> {
    return this.moduleRef
      .get(GuardrailsService, { strict: false })
      .settleDurableAdmissionFailure(context, failure);
  }

  recoverTerminal(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionTerminalRecovery> {
    return this.moduleRef
      .get(GuardrailsService, { strict: false })
      .recoverDurableTerminalAdmission(context);
  }
}
