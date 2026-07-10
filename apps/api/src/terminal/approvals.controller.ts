import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { isIP } from 'node:net';
import type { Request } from 'express';
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
 * SECURITY: this endpoint is exempt from operator auth because the caller is a
 * sandbox, not a human operator. The controller therefore enforces the existing
 * network-isolation trust boundary itself: it rejects every proxy-forwarded
 * request and accepts only a direct loopback/private/link-local/ULA peer.
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
@Controller('internal/sandbox/approvals')
export class ApprovalsController {
  constructor(private readonly gateway: TerminalGateway) {}

  /**
   * Receive a sandbox hook callback. The body is either a blocking
   * `permission_request` (resolved to a {@link Decision} returned in the body)
   * or a non-blocking `post_tool_use_report` (acknowledged with an empty 200).
   *
   * Validation is performed inline (rather than a single `@UsePipes` schema)
   * because the endpoint accepts two distinct frame shapes; an unrecognized or
   * malformed body returns 400, which the hook treats as a fail-closed deny.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<Decision | void> {
    const source = validateSandboxCallbackSource({
      remoteAddress: request.socket?.remoteAddress,
      headers: request.headers,
    });
    if (!source.allowed) {
      throw new ForbiddenException('Sandbox callback source is not allowed');
    }

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

export type SandboxCallbackSourceValidation =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | 'forwarded-header'
        | 'missing-remote-address'
        | 'non-private-remote-address';
    };

const FORWARDED_SOURCE_HEADERS = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
]);

/**
 * Pure source-boundary check for the unauthenticated sandbox callback.
 * Forwarding headers always fail closed; without them the TCP peer itself must
 * be loopback, RFC1918, IPv4/IPv6 link-local, or IPv6 ULA.
 */
export function validateSandboxCallbackSource(input: {
  readonly remoteAddress?: string;
  readonly headers: Readonly<Record<string, unknown>>;
}): SandboxCallbackSourceValidation {
  const hasForwardedSource = Object.keys(input.headers).some((name) =>
    FORWARDED_SOURCE_HEADERS.has(name.toLowerCase()),
  );
  if (hasForwardedSource) {
    return { allowed: false, reason: 'forwarded-header' };
  }

  const remoteAddress = input.remoteAddress?.trim();
  if (!remoteAddress) {
    return { allowed: false, reason: 'missing-remote-address' };
  }

  return isAllowedSandboxPeer(remoteAddress)
    ? { allowed: true }
    : { allowed: false, reason: 'non-private-remote-address' };
}

function isAllowedSandboxPeer(rawAddress: string): boolean {
  const address = rawAddress.split('%', 1)[0]!.toLowerCase();
  const mappedIpv4 = address.startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : null;
  if (mappedIpv4 !== null && isIP(mappedIpv4) === 4) {
    return isAllowedIpv4(mappedIpv4);
  }

  const family = isIP(address);
  if (family === 4) return isAllowedIpv4(address);
  if (family !== 6) return false;
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;

  const firstHextet = Number.parseInt(address.split(':', 1)[0]!, 16);
  if (!Number.isInteger(firstHextet)) return false;
  const isUla = (firstHextet & 0xfe00) === 0xfc00;
  const isLinkLocal = (firstHextet & 0xffc0) === 0xfe80;
  return isUla || isLinkLocal;
}

function isAllowedIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** 400 for a body that is neither a permission request nor a post-tool-use report. */
class BadApprovalCallbackError extends BadRequestException {
  constructor() {
    super('Approval callback body is not a permission_request or post_tool_use_report frame');
  }
}
