/**
 * The `/mcp` HTTP transport controller (remote-mcp-server, Track
 * `mcp-endpoint-tools`, tasks 4.1 / 4.3).
 *
 * Mounts the official `@modelcontextprotocol/sdk` (v1.x)
 * {@link StreamableHTTPServerTransport} in STATELESS mode on a Nest/Express route
 * (POST only — GET/DELETE return 405 via `methodNotAllowed`; stateless +
 * `enableJsonResponse` serves no SSE stream, so a GET routed to the transport
 * would hang an empty stream), per design D3 (NOT `@rekog/mcp-nest`, NOT the v2-alpha
 * `@modelcontextprotocol/express` — the v1.x single-package subpaths are pinned,
 * verified in Track 7 / G2). It coexists with the existing `ws` `/terminal`
 * adapter and the global JSON body parser.
 *
 * Per request (task 4.1):
 *   1. Gate on `SystemSettings.mcpServerEnabled` (task 4.3), read DIRECTLY via
 *      {@link PrismaService} in this module (no import of `settings.service.ts`,
 *      keeping Track 5 disjoint). Default `false` (ship inert): a missing row /
 *      column reads as OFF. When OFF the endpoint does NOT serve MCP traffic — it
 *      returns a clear disabled response and connects no transport, so no `mcp_`
 *      token can drive a usable session here.
 *   2. When ON, build a FRESH stateless transport (`sessionIdGenerator: undefined`,
 *      `enableJsonResponse: true`) and a fresh {@link McpServer} per request, then
 *      hand the pre-parsed `req.body` to
 *      `transport.handleRequest(req, res, req.body)` so the SDK owns the JSON-RPC
 *      response on the raw `res`.
 *
 * AUTHORIZATION is NOT enforced here: every `/mcp` request is validated by the SDK
 * `requireBearerAuth` → `resolveMcpToken` Express middleware registered in
 * `main.ts` (Track 7) BEFORE Nest's pipeline, which 401s an absent/invalid bearer
 * and attaches the resolved `AuthInfo` (carrying scopes) onto the request; the SDK
 * transport threads that into each tool's `extra.authInfo`, where the per-tool
 * scope gate reads it. The session guard EXEMPTS `/mcp` by exact match (Track 3),
 * so the only gate is the bearer middleware + the per-tool scope checks.
 */
import {
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PrismaService } from '../prisma/prisma.service';
import { McpServerFactory } from './mcp.server';

/**
 * The fixed singleton id of the `SystemSettings` row (the same constant
 * `settings.service.ts` upserts on). Declared LOCALLY here — not imported from
 * the settings module — so reading the toggle creates no cross-track file
 * dependency (Track 5 owns `settings.service.ts`; this track only READS the
 * column it adds via Track 1's migration).
 */
const SYSTEM_SETTINGS_ROW_ID = 'system';

@Controller('mcp')
export class McpController {
  constructor(
    private readonly mcp: McpServerFactory,
    private readonly prisma: PrismaService,
  ) {}

  /** `POST /mcp` — the JSON-RPC request channel (initialize, tools/list, tools/call). */
  @Post()
  async handlePost(
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    await this.handle(req, res);
  }

  /**
   * `GET /mcp` — 405 Method Not Allowed. Stateless + `enableJsonResponse` serves
   * NO server→client SSE stream, so there is nothing to open here. Routing GET to
   * `transport.handleRequest` opens an empty SSE stream that hangs until timeout
   * and breaks a real MCP client's handshake, so GET is rejected at the METHOD
   * layer — synchronously, independent of the enable toggle (a 405, never a
   * 503/401). A conformant streamable-HTTP client then falls back to POST-only.
   */
  @Get()
  handleGet(@Res({ passthrough: false }) res: Response): void {
    this.methodNotAllowed(res);
  }

  /** `DELETE /mcp` — 405 (same rationale as GET; no stateful session to delete). */
  @Delete()
  handleDelete(@Res({ passthrough: false }) res: Response): void {
    this.methodNotAllowed(res);
  }

  /**
   * The shared per-request handler: gate on the enable flag, then (when on) build
   * a fresh stateless server/transport pair and let the SDK own the response.
   */
  private async handle(req: Request, res: Response): Promise<void> {
    // (task 4.3) Gate the WHOLE surface on the enable flag. When off the endpoint
    // is INERT — it never connects a transport, so no mcp_ token resolves a usable
    // session here even with a valid bearer.
    if (!(await this.isEnabled())) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'MCP server is disabled',
        },
        id: null,
      });
      return;
    }

    // A FRESH stateless transport per request (task 4.1). Stateless mode:
    // `sessionIdGenerator: undefined` (no server-issued session id — a transport
    // session id is never a credential, spec) + `enableJsonResponse: true` so the
    // SDK answers the POST with a single JSON-RPC response body.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = this.mcp.createServer();

    // The request-scoped server owns its transport; closing it releases both.
    res.on('close', () => {
      void server.close();
    });

    await server.connect(transport);

    // Hand the PRE-PARSED body (the global JSON parser already ran) to the SDK,
    // which writes the JSON-RPC response onto the raw `res`. `req.auth` (set by the
    // `requireBearerAuth` middleware in main.ts) is threaded into the tools'
    // `extra.authInfo` by the transport.
    await transport.handleRequest(req, res, req.body);
  }

  /**
   * Read `SystemSettings.mcpServerEnabled` directly (task 4.3). Default-OFF: a
   * missing singleton row reads as `false`, so the platform ships inert until an
   * admin flips the toggle (Track 5). Read on EVERY request (not cached) so
   * turning the flag off stops new `/mcp` use immediately.
   */
  private async isEnabled(): Promise<boolean> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { id: SYSTEM_SETTINGS_ROW_ID },
      select: { mcpServerEnabled: true },
    });
    return row?.mcpServerEnabled === true;
  }

  /**
   * Reject a non-POST `/mcp` request with 405. The stateless endpoint serves POST
   * only — GET/DELETE would open an empty SSE stream that hangs. A JSON-RPC error
   * body + `Allow: POST`, written SYNCHRONOUSLY: no transport connected, no hang.
   * Independent of the enable toggle (method-layer verdict, not auth/availability),
   * so it is NOT gated on `isEnabled`.
   */
  private methodNotAllowed(res: Response): void {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'Method Not Allowed: the stateless MCP endpoint serves POST only',
      },
      id: null,
    });
  }
}
