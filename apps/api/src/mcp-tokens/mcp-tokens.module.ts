import { Module } from '@nestjs/common';
import { McpTokensController } from './mcp-tokens.controller';
import { McpTokensService } from './mcp-tokens.service';

/**
 * MCP-token feature module (remote-mcp-server, task 3.6).
 *
 * ONE module owns BOTH the credential service and its CRUD controller — exactly
 * like `ApiKeysModule` bundles its service + controller — so the
 * settings-minted `mcp_` token lifecycle lives in a single cohesive unit:
 *  - {@link McpTokensService} — mint (show-once raw `mcp_` token) / list
 *    (prefix + last4 only) / revoke (idempotent), HASH-ONLY persistence; and
 *  - {@link McpTokensController} (`/mcp-tokens`, session-operator-only, gated by
 *    the global `AuthGuard` + an in-handler 403 for any machine credential).
 *
 * Relies on the global `PrismaModule` for DB access (no explicit import needed).
 * Exports {@link McpTokensService} so a downstream module (the `/mcp` endpoint +
 * tools track) can reach the credential surface. Registered in `app.module.ts`
 * by the integration track alongside the other feature modules.
 *
 * The RESOLUTION path (`resolveMcpToken`) deliberately lives in
 * `AuthSessionService` (the auth core), NOT here — the security-critical
 * resolve/allowlist-recheck decision sits next to `resolveSession`, while this
 * module owns only the operator-facing credential lifecycle.
 */
@Module({
  controllers: [McpTokensController],
  providers: [McpTokensService],
  exports: [McpTokensService],
})
export class McpTokensModule {}
