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
 * Thin DI adapter. Guardrails remains the single owner of capacity, lifecycle,
 * provider selection/readoption, timers, launch and terminal settlement; the
 * durable worker supplies its database-backed lease/status/version authority.
 * ModuleRef keeps the existing Tasks <-> Guardrails construction cycle lazy.
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
