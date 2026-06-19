/**
 * Reserved credential prefixes (api-key-auth spec, task 2.2).
 *
 * These public, non-secret token prefixes are the SINGLE SOURCE OF TRUTH shared
 * by three consumers that must agree on one list (design D1/D5/Open-Questions):
 *
 *   1. Dispatch — `resolveOperatorPrincipal` routes a presented bearer by its
 *      prefix as its FIRST step (`cap_sk_` → api-key resolver, `mcp_` → reserved
 *      MCP resolver), before any session/legacy resolution runs.
 *   2. Minting — the API-key minting endpoint stamps `API_KEY_PREFIX` onto every
 *      raw key body so issued keys are always dispatch-routable.
 *   3. Boot assertion — `main.ts` refuses to boot when a configured operator
 *      `AUTH_TOKEN` begins with any reserved prefix (it would otherwise route to
 *      a machine resolver, hash-miss to null, and never reach its constant-time
 *      compare — silently breaking legacy operator auth).
 *
 * Prefixes are NOT secrets; branching on them leaks nothing about any key.
 */

/** The reserved prefix carried by every minted API key (`cap_sk_<random>`). */
export const API_KEY_PREFIX = 'cap_sk_' as const;

/** The reserved prefix for machine/MCP tokens (`mcp_<…>`); slot reserved for T3. */
export const MCP_TOKEN_PREFIX = 'mcp_' as const;

/**
 * Namespaced view of the reserved prefixes for prefix-dispatch call sites that
 * read `CREDENTIAL_PREFIX.API_KEY` / `CREDENTIAL_PREFIX.MCP` (the dispatch in
 * `resolveOperatorPrincipal`). Derived from the same constants as
 * {@link RESERVED_CREDENTIAL_PREFIXES} so the namespaced and listed views can
 * never drift apart.
 */
export const CREDENTIAL_PREFIX = {
  API_KEY: API_KEY_PREFIX,
  MCP: MCP_TOKEN_PREFIX,
} as const;

/**
 * Every reserved credential prefix, in one immutable list. Dispatch, minting,
 * and the boot assertion all derive from this so the three can never drift.
 */
export const RESERVED_CREDENTIAL_PREFIXES = [
  API_KEY_PREFIX,
  MCP_TOKEN_PREFIX,
] as const;

/** A reserved credential prefix value drawn from {@link RESERVED_CREDENTIAL_PREFIXES}. */
export type ReservedCredentialPrefix =
  (typeof RESERVED_CREDENTIAL_PREFIXES)[number];

/**
 * Whether `token` begins with any reserved credential prefix. Used by the boot
 * assertion (refuse to boot when a configured `AUTH_TOKEN` collides) and by any
 * caller that needs to know a presented bearer is dispatch-reserved.
 */
export function startsWithReservedPrefix(token: string): boolean {
  return RESERVED_CREDENTIAL_PREFIXES.some((prefix) => token.startsWith(prefix));
}
