import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AUDIT_RECORDER_TOKEN } from './audit-recorder.port';
import { TerminalModule } from '../terminal/terminal.module';

/**
 * Audit / approvals module (be-audit-approvals 6.2–6.5).
 *
 * Wires:
 *  - {@link AuditService} — the best-effort append-only audit recorder (6.2) and
 *    the query reads (6.4). Injected by the guardrails/tasks lifecycle paths to
 *    emit one event per transition WITHOUT ever throwing on a persistence failure
 *    (the recorder swallows + logs). Composes the pure resultCode/level mapping
 *    (6.3) and query-filter logic from `audit-mapping.ts`. EXPORTED so the
 *    lifecycle services can inject it (wired by the verify phase in
 *    `app.module.ts`).
 *  - {@link AuditController} — the session-gated read surface: `GET /audit/events`
 *    (recent, filterable, capped), `GET /audit/tasks/:taskId` (one task's full
 *    ordered sequence), and `GET /audit/approvals/pending` (pending
 *    `PermissionRequest` decisions, 6.5). All routes inherit the GLOBAL operator
 *    `AuthGuard`, so an unauthenticated/de-allowlisted caller gets 401.
 *
 * Imports {@link TerminalModule} for the {@link TerminalGateway}, whose live
 * pending-approval map backs the 6.5 read endpoint. The DB access uses the
 * `@Global()` `PrismaService`, so no Prisma import is needed here.
 *
 * `@Global()` + the {@link AUDIT_RECORDER_TOKEN} alias: the lifecycle services
 * (`TasksService`, `GuardrailsService`) inject the best-effort recorder PORT by
 * that token with `@Optional()`. Binding it here (rather than importing
 * `AuditModule` into `TasksModule`) is what avoids the module cycle
 * `TasksModule -> AuditModule -> TerminalModule -> TasksModule`: the token is a
 * global alias of the concrete {@link AuditService}, so the lifecycle modules see
 * it without importing this one. This module is a leaf in the import graph (only
 * `AppModule` imports it), so making it global forms no cycle.
 */
@Global()
@Module({
  imports: [TerminalModule],
  controllers: [AuditController],
  providers: [
    AuditService,
    // Global alias of the concrete recorder under the lifecycle-services' port
    // token, so `TasksService` / `GuardrailsService` can inject it by token with
    // `@Optional()` without importing `AuditModule` (which would form a cycle).
    { provide: AUDIT_RECORDER_TOKEN, useExisting: AuditService },
  ],
  exports: [AuditService, AUDIT_RECORDER_TOKEN],
})
export class AuditModule {}
