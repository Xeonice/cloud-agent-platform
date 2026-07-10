import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ReposModule } from '../repos/repos.module';
import { ScheduledTasksModule } from '../scheduled-tasks/scheduled-tasks.module';
import { SessionTranscriptService } from '../tasks/session-transcript.service';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_TIMELINE_READER,
  TRANSCRIPT_STORE,
} from '../tasks/task-transcript-reader';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp.server';

/**
 * The `/mcp` feature module (remote-mcp-server, Track `mcp-endpoint-tools`).
 *
 * Assembles the remote MCP surface — the SDK transport controller + a factory for
 * request-scoped, tools-registered servers — from the EXISTING console services, adding NO
 * second admission path (design D1/D4):
 *   - {@link TasksModule} (imported) exports `TasksService` (create/get/list/stop
 *     — the same admission the console uses) AND the durable
 *     {@link SessionTranscriptService} backing `get_transcript`.
 *   - {@link ReposModule} (imported) exports `ReposService` for repo reads.
 *   - {@link ScheduledTasksModule} (imported) exports `ScheduledTasksService` for
 *     the owner-scoped schedule tools.
 *   - `PrismaService` (the `@Global() PrismaModule`) backs the
 *     `SystemSettings.mcpServerEnabled` gate read in {@link McpController} (task
 *     4.3) — read DIRECTLY here, NOT via `settings.service.ts`, so Track 5 stays
 *     disjoint.
 *   - the `SANDBOX_PROVIDER` port (the `@Global() SandboxModule`) and global
 *     `AuditService` back the canonical shared transcript read.
 * Because these global providers need no explicit module import.
 *
 * `TRANSCRIPT_STORE` is RE-BOUND here (to the `SessionTranscriptService` that
 * `TasksModule` exports) rather than exported from `TasksModule`, so this track
 * injects the existing durable store WITHOUT editing `TasksModule` — the token is
 * module-local to whoever needs it (the same pattern `V1Module` uses).
 *
 * Auth posture: the SDK `requireBearerAuth` → `resolveMcpToken` Express
 * middleware (wired in `main.ts`, Track 7) 401s an absent/invalid bearer before
 * Nest's pipeline and threads the resolved scopes into each tool's gate; the
 * session guard exempts `/mcp` by exact match (Track 3). This module declares no
 * guard of its own. Registered into `AppModule` by Track 7 (the single shared
 * `app.module.ts` edit).
 */
@Module({
  imports: [TasksModule, ReposModule, ScheduledTasksModule],
  controllers: [McpController],
  providers: [
    McpServerFactory,
    // Re-bind the durable transcript store under the token the server factory
    // injects, to the concrete service TasksModule exports — keeping TasksModule
    // untouched (this track only CONSUMES the store).
    {
      provide: TRANSCRIPT_STORE,
      useExisting: SessionTranscriptService,
    },
    {
      provide: AUDIT_TIMELINE_READER,
      useExisting: AuditService,
    },
  ],
})
export class McpModule {}
