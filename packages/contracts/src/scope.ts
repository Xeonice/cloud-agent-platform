import { z } from 'zod';

/**
 * Authorization scope vocabulary (api-key-auth spec, task 2.1).
 *
 * A single, shared scope enum used by both API-key principals and the later
 * machine (MCP) principals. Scopes gate scoped operations at the route boundary
 * as 403 (insufficient scope), distinct from the 401 returned for an absent or
 * invalid credential.
 *
 * The default-allow rule lives at the principal layer, NOT here: a principal
 * that carries NO scopes (a GitHub session or the legacy operator token) is
 * treated as allow-all so existing console behavior is unchanged. This schema
 * only enumerates the grantable scopes a scoped principal (an API key or MCP
 * token) may hold. `tasks:diagnostics` is deliberately independent from the
 * ordinary task read/write grants: adding it to this vocabulary makes it
 * eligible for an explicit capability-gated mint without widening any
 * already-persisted scope array.
 */
export const ScopeSchema = z.enum([
  'tasks:read',
  'tasks:write',
  'tasks:diagnostics',
  'repos:read',
]);

/** A single authorization scope drawn from the shared vocabulary. */
export type Scope = z.infer<typeof ScopeSchema>;
