import { forwardRef, Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { SessionHistoryController } from './session-history.controller';
import { TasksService } from './tasks.service';
import { GUARDRAILS_SERVICE_TOKEN } from './tasks.service';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { GuardrailsService } from '../guardrails/guardrails.service';

/**
 * Feature module bundling the tasks REST controller, the tasks service, and the
 * lifecycle state machine it enforces. Relies on the global `PrismaModule`.
 *
 * Under the connect-in model there is NO per-task `TASK_TOKEN` issuance: the
 * orchestrator dials each per-task AIO sandbox by container name on `cap-net`,
 * so there is no dial-back to authenticate. `TaskTokenService` and the gateway
 * dial-back handshake verifier were removed with the runner (migrate-aio 7.4).
 *
 * VR.1 / VR.4 / VR.5: `GuardrailsModule` is imported via `forwardRef` to break
 * the circular reference (GuardrailsModule -> TasksModule -> GuardrailsModule).
 * The `GuardrailsService` is re-provided under the `GUARDRAILS_SERVICE_TOKEN` so
 * `TasksService` can inject it with `@Optional()` without creating the cycle.
 */
@Module({
  imports: [forwardRef(() => GuardrailsModule)],
  // SessionHistoryController is a standalone read-only REST surface; it injects
  // the global SANDBOX_PROVIDER port (no extra module import needed) + TasksService.
  controllers: [TasksController, SessionHistoryController],
  providers: [
    TasksService,
    // Bridge the GuardrailsService under a token that TasksService injects
    // with @Optional(), resolving the circular module dependency.
    {
      provide: GUARDRAILS_SERVICE_TOKEN,
      useExisting: GuardrailsService,
    },
  ],
  exports: [TasksService],
})
export class TasksModule {}
