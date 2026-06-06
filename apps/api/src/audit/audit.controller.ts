import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  AUDIT_QUERY_DEFAULT_LIMIT,
  AuditLevelSchema,
  ListAuditEventsResponseSchema,
  ListPendingApprovalsResponseSchema,
  TaskStatusSchema,
  type ListAuditEventsResponse,
  type ListPendingApprovalsResponse,
} from '@cap/contracts';
import { AuditService } from './audit.service';
import { TerminalGateway } from '../terminal/terminal.gateway';

/**
 * Session-gated audit + approvals read surface (be-audit-approvals 6.4 / 6.5).
 *
 * Every route here is protected by the GLOBAL operator `AuthGuard` (registered
 * via `APP_GUARD` in `AuthModule`): these paths are NOT in the guard's exemption
 * list (`/health` + the OAuth entry points), so a request without a valid
 * operator principal — missing/expired credentials or a now-de-allowlisted user —
 * is rejected with 401 BEFORE any handler runs and no audit history or pending
 * approval is ever serialized to an unauthenticated caller (6.4/6.5 "401 on
 * missing/expired/non-allowlisted").
 *
 * - `GET /audit/events`          -> 200, recent events most-recent-first,
 *                                   filterable by `level` and task `status`,
 *                                   capped at `limit` (default
 *                                   {@link AUDIT_QUERY_DEFAULT_LIMIT}).
 * - `GET /audit/tasks/:taskId`   -> 200, a single task's FULL ordered event
 *                                   sequence (incl. after a terminal state).
 * - `GET /audit/approvals/pending` -> 200, pending `PermissionRequest` decisions
 *                                   currently awaiting an operator.
 */
@Controller('audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly gateway: TerminalGateway,
  ) {}

  /**
   * 6.4 — recent events, most-recent-first, filterable by `level`
   * (info/warning/error; omit for "全部"/all) and by task `status`, with a
   * caller-supplied `limit` (default {@link AUDIT_QUERY_DEFAULT_LIMIT}).
   *
   * Query params arrive as STRINGS, so they are parsed through a coercing schema
   * (the contracts `AuditQuerySchema` types `limit` as a number for the internal
   * call shape); an out-of-vocabulary `level`/`status` or a non-positive `limit`
   * is rejected with 400.
   */
  @Get('events')
  async events(@Query() rawQuery: unknown): Promise<ListAuditEventsResponse> {
    const parsed = AuditEventsQueryParamsSchema.safeParse(rawQuery ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid audit query',
        issues: parsed.error.issues,
      });
    }
    const events = await this.audit.query(parsed.data);
    // Re-assert the wire contract on the way out (most-recent-first ordering and
    // the resultCode/level shape are already produced by the service).
    return ListAuditEventsResponseSchema.parse(events);
  }

  /**
   * 6.4 — a single task's FULL ordered event sequence (oldest -> newest),
   * queryable by task id even after the task has reached a terminal state.
   */
  @Get('tasks/:taskId')
  async taskEvents(@Param('taskId') taskId: string): Promise<ListAuditEventsResponse> {
    const events = await this.audit.queryTask(taskId);
    return ListAuditEventsResponseSchema.parse(events);
  }

  /**
   * 6.5 — the pending `PermissionRequest` decisions currently awaiting an
   * operator, read from the live gateway approval surface and validated against
   * the contracts {@link ListPendingApprovalsResponseSchema}.
   */
  @Get('approvals/pending')
  pendingApprovals(): ListPendingApprovalsResponse {
    return ListPendingApprovalsResponseSchema.parse(this.gateway.listPendingApprovals());
  }
}

/**
 * Query-param coercion for `GET /audit/events`. Mirrors the contracts
 * `AuditQuerySchema` but coerces `limit` from its string query representation to
 * a positive integer (the contracts schema types it as a number for the internal
 * service call shape). The result is exactly the contracts `AuditQuery` shape.
 */
const AuditEventsQueryParamsSchema = z.object({
  level: AuditLevelSchema.optional(),
  status: TaskStatusSchema.optional(),
  limit: z.coerce.number().int().positive().default(AUDIT_QUERY_DEFAULT_LIMIT),
});
