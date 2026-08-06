import { Global, Module } from '@nestjs/common';

import { RUNTIME_REGISTRY } from '@/sandbox/sandbox.module';
import {
  SESSION_TRANSCRIPT_CAPTURE,
  TRANSCRIPT_RUNTIME_REGISTRY,
} from './session-transcript.port';
import { SessionTranscriptService } from './session-transcript.service';

/**
 * The durable transcript capture/read owner
 * (collapse-three-collaborator-groups N3).
 *
 * `SessionTranscriptService` used to be registered by `TasksModule`, which made
 * every consumer — the orchestrator's terminal chokepoints, the console history
 * controller, `/v1`, `/mcp` — reach it through the tasks module. The
 * orchestrator's half of that was an edge in the module graph
 * (`GuardrailsModule -> forwardRef(TasksModule)`) whose ONLY purpose was
 * reaching this one collaborator. Registering the owner here removes it.
 *
 * `@Global()` for the same reason `AuditModule` and `DomainEventsModule` are:
 * the durable transcript is a cross-cutting record consumed by four modules that
 * otherwise have no business importing each other, and binding it globally adds
 * no edge that could re-create a cycle. Consumers bind their own narrow token
 * (`TRANSCRIPT_STORE` for the read paths, `TRANSCRIPT_SERVICE_TOKEN` for the
 * orchestrator) to what this module exports.
 *
 * DI note (the trap this move had to clear): the moved service injects its
 * runtime registry NON-optionally, and in `tasks/` it read that registry through
 * `AGENT_RUNTIME_REGISTRY_TOKEN` — a token `TasksModule` PROVIDES but does not
 * EXPORT. Leaving that dependency as-is would have been an unresolved-dependency
 * failure at BOOT (not an `undefined` at runtime), and importing the tasks
 * service to name the token would have re-created the very edge this move
 * removes. So the registry is re-provided here under the transcript context's
 * own {@link TRANSCRIPT_RUNTIME_REGISTRY}, bound to the SAME `@Global()`
 * SandboxModule registry `TasksModule` binds its token to: one instance, two
 * consumer-local names, no edge between the two contexts.
 */
@Global()
@Module({
  providers: [
    SessionTranscriptService,
    // The runtime registry the moved service resolves each task's transcript
    // format through. Bound to the same `@Global()` SandboxModule registry
    // `TasksModule` binds its own token to, so both bindings name one instance.
    {
      provide: TRANSCRIPT_RUNTIME_REGISTRY,
      useExisting: RUNTIME_REGISTRY,
    },
    // The capture port itself: the orchestrator resolves THIS token and never
    // names the concrete class.
    {
      provide: SESSION_TRANSCRIPT_CAPTURE,
      useExisting: SessionTranscriptService,
    },
  ],
  exports: [SessionTranscriptService, SESSION_TRANSCRIPT_CAPTURE],
})
export class SessionTranscriptModule {}
