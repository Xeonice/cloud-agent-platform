import { forwardRef, Module } from '@nestjs/common';

import { TASK_OPERATIONS } from '@/task-operations/task-operations.port';
import { TasksController } from './tasks.controller';
import { SessionCastController } from './session-cast.controller';
import {
  SessionHistoryController,
  TRANSCRIPT_STORE,
  AUDIT_TIMELINE_READER,
} from './session-history.controller';
import { AuditService } from '@/audit/audit.service';
import { TasksService } from './tasks.service';
import {
  GUARDRAILS_SERVICE_TOKEN,
  AGENT_RUNTIME_REGISTRY_TOKEN,
  CLAUDE_RUNTIME_READINESS_TOKEN,
} from './tasks.service';
// add-claude-code-runtime VR-3: the create-time runtime resolve + claude
// fail-closed gate inject the two tasks-layer tokens below; bind them to the
// `@Global()` SandboxModule's already-exported runtime registry + claude auth
// source so the gates actually fire (they were @Optional and unbound = dead).
import { RUNTIME_REGISTRY, CLAUDE_AUTH_SOURCE } from '@/sandbox/sandbox.module';
import { GuardrailsModule } from '@/guardrails/guardrails.module';
import { GuardrailsService } from '@/guardrails/guardrails.service';
import { SessionTranscriptService } from '@/session-transcripts/session-transcript.service';
import { SandboxEnvironmentsModule } from '@/sandbox-environments/sandbox-environments.module';
import { ForgeModule } from '@/forge/forge.module';
import {
  EnvironmentTaskAdmissionGate,
  TASK_ADMISSION_GATE_TOKEN,
} from '@/task-admission/task-admission-gate';
import { TaskAdmissionModule } from '@/task-admission/task-admission.module';

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
 * collapse-three-collaborator-groups N3: the durable
 * {@link SessionTranscriptService} is no longer REGISTERED here — it is owned by
 * the `@Global()` `SessionTranscriptModule` in its own context. This module only
 * CONSUMES it, binding it to the {@link TRANSCRIPT_STORE} token the read-path
 * controller injects (durable-first read + read-through backfill). The
 * orchestrator no longer resolves it through this module at all, which is what
 * removed the `GuardrailsModule -> TasksModule` composition edge.
 */
@Module({
  imports: [
    forwardRef(() => GuardrailsModule),
    SandboxEnvironmentsModule,
    ForgeModule,
    TaskAdmissionModule,
  ],
  // SessionHistoryController is a standalone read-only REST surface; it injects
  // the global SANDBOX_PROVIDER port (no extra module import needed) + TasksService
  // + the durable TRANSCRIPT_STORE bound below.
  controllers: [TasksController, SessionHistoryController, SessionCastController],
  providers: [
    TasksService,
    // Guardrails resolves the task operations it drives by TOKEN, so it never
    // has to import this service — that import was half of the
    // tasks<->guardrails source cycle.
    { provide: TASK_OPERATIONS, useExisting: TasksService },
    EnvironmentTaskAdmissionGate,
    {
      provide: TASK_ADMISSION_GATE_TOKEN,
      useExisting: EnvironmentTaskAdmissionGate,
    },
    // Bridge the GuardrailsService under a token that TasksService injects
    // with @Optional(), resolving the circular module dependency.
    {
      provide: GUARDRAILS_SERVICE_TOKEN,
      useExisting: GuardrailsService,
    },
    // The narrow TRANSCRIPT_STORE binding the read-path controller injects (the
    // concrete service satisfies the controller's structural `TranscriptStore`).
    // The service itself comes from the `@Global()` SessionTranscriptModule that
    // owns it, so this module binds a token rather than registering a provider.
    {
      provide: TRANSCRIPT_STORE,
      useExisting: SessionTranscriptService,
    },
    // wire-transcript-real-data D3 — the read-path controller merges
    // audit-sourced system milestone turns; bind its narrow AUDIT_TIMELINE_READER
    // to the `@Global()` AuditService (its `queryTask` returns a task's full
    // ordered event sequence).
    {
      provide: AUDIT_TIMELINE_READER,
      useExisting: AuditService,
    },
    // add-claude-code-runtime VR-3: wire the two tasks-layer create-gate tokens
    // to the `@Global()` SandboxModule's runtime registry + claude auth source.
    // Without these the @Optional() deps were always undefined, so a `claude-code`
    // create with no token was admitted (failing only at provision) instead of
    // being rejected up front. `IntegrationRuntimeRegistry` satisfies
    // `IAgentRuntimeRegistry.resolve()`; `EnvClaudeAuthSource` satisfies
    // `IRuntimeReadiness.configured()`.
    {
      provide: AGENT_RUNTIME_REGISTRY_TOKEN,
      useExisting: RUNTIME_REGISTRY,
    },
    {
      provide: CLAUDE_RUNTIME_READINESS_TOKEN,
      useExisting: CLAUDE_AUTH_SOURCE,
    },
  ],
  exports: [TasksService, TASK_OPERATIONS],
})
export class TasksModule {}
