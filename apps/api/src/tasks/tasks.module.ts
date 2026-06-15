import { forwardRef, Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import {
  SessionHistoryController,
  TRANSCRIPT_STORE,
} from './session-history.controller';
import { TasksService } from './tasks.service';
import { GUARDRAILS_SERVICE_TOKEN } from './tasks.service';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { SessionTranscriptService } from './session-transcript.service';

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
 *
 * persist-session-transcripts I.1: the durable {@link SessionTranscriptService}
 * is registered here (the durable archive + index provider Tracks 2/3/4 wrote
 * against). It is bound to the {@link TRANSCRIPT_STORE} token the read-path
 * controller injects (durable-first read + read-through backfill), and exported
 * so the guardrails capture chokepoints (I.2) can resolve it from this module
 * via `ModuleRef` under their own `TRANSCRIPT_SERVICE_TOKEN`.
 */
@Module({
  imports: [forwardRef(() => GuardrailsModule)],
  // SessionHistoryController is a standalone read-only REST surface; it injects
  // the global SANDBOX_PROVIDER port (no extra module import needed) + TasksService
  // + the durable TRANSCRIPT_STORE bound below.
  controllers: [TasksController, SessionHistoryController],
  providers: [
    TasksService,
    // Bridge the GuardrailsService under a token that TasksService injects
    // with @Optional(), resolving the circular module dependency.
    {
      provide: GUARDRAILS_SERVICE_TOKEN,
      useExisting: GuardrailsService,
    },
    // persist-session-transcripts I.1 — the durable transcript provider, and the
    // narrow TRANSCRIPT_STORE binding the read-path controller injects (the
    // concrete service satisfies the controller's structural `TranscriptStore`).
    SessionTranscriptService,
    {
      provide: TRANSCRIPT_STORE,
      useExisting: SessionTranscriptService,
    },
  ],
  // Export the concrete service so GuardrailsModule (I.2) can resolve it from
  // the already-imported TasksModule via ModuleRef for the capture chokepoints.
  exports: [TasksService, SessionTranscriptService],
})
export class TasksModule {}
