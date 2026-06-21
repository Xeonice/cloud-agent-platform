import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ReposModule } from '../repos/repos.module';
import {
  SessionTranscriptService,
} from '../tasks/session-transcript.service';
import {
  TRANSCRIPT_STORE,
  AUDIT_TIMELINE_READER,
} from '../tasks/session-history.controller';
import { AuditService } from '../audit/audit.service';
import { V1TasksController } from './v1-tasks.controller';
import { V1ReposController } from './v1-repos.controller';
import { V1TranscriptController } from './v1-transcript.controller';
import { V1EventsController } from './v1-events.controller';
import { IdempotencyService } from './idempotency.service';

/**
 * The public `/v1` feature module (public-v1-api, Integration task 3.6).
 *
 * Assembles the additive `/v1` REST + SSE surface from the controllers authored
 * by the parallel tracks, registering BOTH:
 *   - the Track `v1-controllers` task/repo/transcript controllers
 *     ({@link V1TasksController}, {@link V1ReposController},
 *     {@link V1TranscriptController}); AND
 *   - the Track `sse-observation` lifecycle-event controller
 *     ({@link V1EventsController}).
 * Those controller FILES are disjoint per track; THIS module is the single shared
 * assembly point (the only place that imports them all), wired into `AppModule`.
 *
 * Dependency wiring (every injected service comes from an already-composed
 * module — `/v1` adds NO second admission path, design D1):
 *   - {@link TasksModule} (imported) exports `TasksService` + the durable
 *     `SessionTranscriptService`. `V1TasksController`/`V1TranscriptController`/
 *     `V1EventsController` delegate to the SAME `TasksService` the console uses.
 *   - {@link ReposModule} (imported) exports `ReposService` for the `/v1/repos`
 *     read surface.
 *   - `PrismaService` (the `@Global() PrismaModule`) backs the keyset list
 *     queries + the idempotency dedup rows.
 *   - the `SANDBOX_PROVIDER` port (the `@Global() SandboxModule`) backs the
 *     transcript container-fallback read.
 *   - `AuditService` (the `@Global() AuditModule`) backs the SSE event tail.
 * Because the last three live in `@Global()` modules they need no explicit import
 * here.
 *
 * `TRANSCRIPT_STORE` is RE-PROVIDED here (bound to the `SessionTranscriptService`
 * that `TasksModule` exports) rather than exported from `TasksModule`, so the
 * v1-controllers track injects the existing durable store WITHOUT modifying
 * `TasksModule` — the token is module-local to whoever needs it, and this binding
 * resolves to the one concrete durable service instance.
 *
 * Auth/scope/rate posture is enforced by the GLOBAL guards (the `AuthGuard` then
 * the per-principal throttler, both `APP_GUARD`s wired in `AppModule`) plus the
 * per-handler `hasScope` checks in the controllers — none of which this module
 * re-declares.
 */
@Module({
  imports: [TasksModule, ReposModule],
  controllers: [
    V1TasksController,
    V1ReposController,
    V1TranscriptController,
    V1EventsController,
  ],
  providers: [
    IdempotencyService,
    // Re-bind the durable transcript store under the token the transcript
    // controller injects, to the concrete service TasksModule exports. Keeps
    // TasksModule untouched (the v1 track only CONSUMES the store).
    {
      provide: TRANSCRIPT_STORE,
      useExisting: SessionTranscriptService,
    },
    // wire-transcript-real-data D3 — the v1 transcript controller merges
    // audit-sourced system milestone turns; bind its AUDIT_TIMELINE_READER to the
    // `@Global()` AuditService (same as the console controller in TasksModule).
    {
      provide: AUDIT_TIMELINE_READER,
      useExisting: AuditService,
    },
  ],
})
export class V1Module {}
