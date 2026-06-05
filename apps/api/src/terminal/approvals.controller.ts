import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  PermissionRequestFrameSchema,
  PostToolUseReportFrameSchema,
  type Decision,
  type PermissionRequestFrame,
  type PostToolUseReportFrame,
} from '@cap/contracts';
import { TerminalGateway } from './terminal.gateway';

/**
 * Orchestrator approvals HTTP endpoint (migrate-execution-to-aio-sandbox,
 * Integration task 5.5).
 *
 * Under the connect-in model the per-task AIO sandbox's baked Codex hooks call
 * BACK IN to the orchestrator over the private `cap-net` network (the sandbox
 * has no inbound host port; it dials the orchestrator BY CONTAINER NAME). This
 * single endpoint replaces the old runner dial-back / WebSocket transport for
 * the approval round-trip and the post-tool-use report — ONLY the transport
 * changes; the approval semantics live unchanged in {@link TerminalGateway}
 * (`onPermissionRequest` fan-out -> operator decision -> `onDecision`).
 *
 * SECURITY: this endpoint is exempt from the operator `AUTH_TOKEN` guard (see
 * `AuthGuard.EXEMPT_PATHS`) because the caller is a sandbox, not a human
 * operator, and holds no operator token. Its security boundary is network
 * isolation: it is reachable only by the orchestrator's sibling sandbox
 * containers on `cap-net`, which publish no host port.
 *
 * Two callback shapes share the endpoint, discriminated on the frame `type`:
 *  - `permission_request` (BLOCKING): the request is fanned out to operators and
 *    the HTTP response is held open until an operator decides; the resolved
 *    {@link Decision} is returned as the JSON body so the blocked hook unblocks.
 *  - `post_tool_use_report` (NON-BLOCKING): recorded as task activity and
 *    acknowledged with an empty 200; post-hoc only — never gates or reverses a
 *    command.
 *
 * The hook fails closed (deny) on any non-2xx / unparseable response, so an
 * invalid body is rejected with 400 and the blocked tool call never proceeds.
 */
@Controller('v1/approvals')
export class ApprovalsController {
  constructor(private readonly gateway: TerminalGateway) {}

  /**
   * Receive a sandbox hook callback. The body is either a blocking
   * `permission_request` (resolved to a {@link Decision} returned in the body)
   * or a non-blocking `post_tool_use_report` (acknowledged with 204).
   *
   * Validation is performed inline (rather than a single `@UsePipes` schema)
   * because the endpoint accepts two distinct frame shapes; an unrecognized or
   * malformed body returns 400, which the hook treats as a fail-closed deny.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Body() body: unknown): Promise<Decision | void> {
    const permission = PermissionRequestFrameSchema.safeParse(body);
    if (permission.success) {
      return this.handlePermissionRequest(permission.data);
    }

    const report = PostToolUseReportFrameSchema.safeParse(body);
    if (report.success) {
      this.handlePostToolUseReport(report.data);
      return;
    }

    // Neither known callback shape: reject so the blocking hook fails closed.
    throw new BadApprovalCallbackError();
  }

  /**
   * Blocking approval round-trip. Routes the request through the gateway's
   * existing `onPermissionRequest` -> operator decision -> `onDecision` path and
   * returns the resolved decision. The promise (and thus the HTTP response) is
   * held open until an operator decides.
   */
  private async handlePermissionRequest(
    frame: PermissionRequestFrame,
  ): Promise<Decision> {
    const decision = await this.gateway.requestApproval(frame);
    // The hook accepts a bare decision or a `{decision}` envelope; return the
    // bare decision (the gateway's DecisionFrame carries the same shape).
    return decision.decision;
  }

  /** Non-blocking post-hoc report: record activity, acknowledge with 200 (empty). */
  private handlePostToolUseReport(frame: PostToolUseReportFrame): void {
    this.gateway.reportPostToolUse(frame);
  }
}

/** 400 for a body that is neither a permission request nor a post-tool-use report. */
class BadApprovalCallbackError extends BadRequestException {
  constructor() {
    super('Approval callback body is not a permission_request or post_tool_use_report frame');
  }
}
