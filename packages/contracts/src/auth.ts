import { z } from 'zod';
import { FRAME_CHANNEL } from './ws-frames.js';

/**
 * Operator-auth shapes (single-user-auth spec, task 11.1).
 *
 * These are the OPERATOR trust domain: the single shared `AUTH_TOKEN` that gates
 * every REST endpoint and every client (browser) WebSocket connection. This is a
 * DISTINCT trust domain from the runner `TASK_TOKEN` dial-back handshake
 * (`./dialback.js`): the operator token authenticates a human operator's
 * console; the `TASK_TOKEN` authenticates a sandbox dialling back. A
 * `TASK_TOKEN` presented as the operator token is simply a non-matching operator
 * token and MUST be rejected.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket handshake, so the
 * connect-auth shape carries the operator token over the two browser-available
 * channels (a `token` query parameter and a `bearer.<token>` subprotocol) plus,
 * as a fallback for non-browser clients, an explicit connect-auth control frame.
 */

/**
 * The shared operator-token config contract. The orchestrator reads `AUTH_TOKEN`
 * from its environment; the web console reads the same value (exposed to the
 * browser bundle as `NEXT_PUBLIC_AUTH_TOKEN`) and attaches it to REST + WS calls.
 *
 * `authTokenConfigSchema` validates that a configured token is a non-empty
 * string — the orchestrator refuses to boot (task 11.3b) when this fails.
 */
export const AUTH_TOKEN_ENV_VAR = 'AUTH_TOKEN' as const;

/** The browser-exposed env var name carrying the same operator token to the web bundle. */
export const AUTH_TOKEN_PUBLIC_ENV_VAR = 'NEXT_PUBLIC_AUTH_TOKEN' as const;

/** The HTTP scheme used for the operator bearer token on REST requests. */
export const OPERATOR_AUTH_SCHEME = 'Bearer' as const;

/** The query-parameter name carrying the operator token on a WS handshake URL. */
export const WS_AUTH_QUERY_PARAM = 'token' as const;

/**
 * The subprotocol prefix carrying the operator token on a WS handshake. The full
 * subprotocol value is `bearer.<token>`; the orchestrator strips this prefix to
 * recover the presented token.
 */
export const WS_AUTH_SUBPROTOCOL_PREFIX = 'bearer.' as const;

/**
 * Validates a configured operator token. A valid `AUTH_TOKEN` is a non-empty
 * string; the orchestrator treats an unset/empty value as fatal (refuse-to-boot).
 */
export const authTokenConfigSchema = z
  .string()
  .min(1, 'AUTH_TOKEN must be a non-empty string');
export type AuthTokenConfig = z.infer<typeof authTokenConfigSchema>;

/**
 * The connect-auth credential a client presents to authenticate a WebSocket
 * connection at connect time, before it joins any task stream. Carries the
 * operator token and, optionally, the claimed task id the client wants to stream.
 *
 * This is the operator-auth analogue of the runner `DialbackHandshakeFrame`: it
 * authenticates a console client, never a sandbox. The two are intentionally
 * different frame `type`s so one can never be substituted for the other.
 */
export const ConnectAuthFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('connect_auth'),
  /** The shared operator token (`AUTH_TOKEN`); never a runner `TASK_TOKEN`. */
  token: z.string().min(1),
  /** The task this client intends to stream, when known at connect time. */
  taskId: z.string().uuid().optional(),
});
export type ConnectAuthFrame = z.infer<typeof ConnectAuthFrameSchema>;

/**
 * Extracts the operator token a WS client presented, from the handshake URL's
 * query parameter or `bearer.<token>` subprotocol. Returns the first token found
 * (query param preferred), or `null` when neither channel carries one. The
 * orchestrator's connect-time auth (task 11.4) feeds the result to a constant-time
 * comparison against the configured `AUTH_TOKEN`.
 */
export function extractWsOperatorToken(input: {
  queryToken?: string | null;
  subprotocols?: readonly string[] | null;
}): string | null {
  const q = input.queryToken;
  if (typeof q === 'string' && q.length > 0) {
    return q;
  }
  for (const proto of input.subprotocols ?? []) {
    if (proto.startsWith(WS_AUTH_SUBPROTOCOL_PREFIX)) {
      const token = proto.slice(WS_AUTH_SUBPROTOCOL_PREFIX.length);
      if (token.length > 0) {
        return token;
      }
    }
  }
  return null;
}
