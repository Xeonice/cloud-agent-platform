import { forwardRef, Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskTokenService } from './task-token.service';
import { GUARDRAILS_SERVICE_TOKEN } from './tasks.service';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { GuardrailsService } from '../guardrails/guardrails.service';

/**
 * Feature module bundling the tasks REST controller, the tasks service, and the
 * lifecycle state machine it enforces. Relies on the global `PrismaModule`.
 *
 * The {@link TaskTokenService} (per-task `TASK_TOKEN` issuance, 8.3) is provided
 * here with the default TTL and exported so the realtime-terminal gateway's
 * dial-back handshake verifier (8.2) can verify presented tokens.
 *
 * VR.1 / VR.4 / VR.5: `GuardrailsModule` is imported via `forwardRef` to break
 * the circular reference (GuardrailsModule -> TasksModule -> GuardrailsModule).
 * The `GuardrailsService` is re-provided under the `GUARDRAILS_SERVICE_TOKEN` so
 * `TasksService` can inject it with `@Optional()` without creating the cycle.
 */
@Module({
  imports: [forwardRef(() => GuardrailsModule)],
  controllers: [TasksController],
  providers: [
    TasksService,
    { provide: TaskTokenService, useFactory: () => new TaskTokenService() },
    // Bridge the GuardrailsService under a token that TasksService injects
    // with @Optional(), resolving the circular module dependency.
    {
      provide: GUARDRAILS_SERVICE_TOKEN,
      useExisting: GuardrailsService,
    },
  ],
  exports: [TasksService, TaskTokenService],
})
export class TasksModule {}
