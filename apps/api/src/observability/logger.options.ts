import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { getTaskLogContext } from './log-context';

/**
 * nestjs-pino configuration for the structured-logging foundation (Tier 0).
 *
 * The app emits single-line JSON to stdout ONLY (no file/network sink — that is
 * the opt-in observability-stack's job). This module pins the field vocabulary
 * downstream collection relies on: `level`, `reqId`, `taskId`, `userId`.
 *
 * SECURITY: `redact` is load-bearing — pino-http logs request headers by default,
 * so without redaction structured logging would PERSIST credentials. The paths
 * below blank the session cookie, bearer/Authorization, and any key-named secret;
 * whole `process.env`/config objects must never be passed to the logger (which
 * would expose `CODEX_CRED_ENC_KEY` / the OAuth client secret).
 */

/** Credential-bearing paths whose values are replaced with the censor string. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Key-named secrets anywhere in a logged object (depth-bounded by pino).
  '*.apiKey',
  '*.api_key',
  '*.token',
  '*.password',
  '*.secret',
];

/** Resolve a human log identity for the authenticated operator, if any. */
function userIdFor(req: IncomingMessage): string | undefined {
  const principal = (req as AuthenticatedRequest).operatorPrincipal;
  if (!principal) return undefined;
  return principal.user?.login ?? (principal.kind === 'legacy-token' ? 'legacy' : undefined);
}

/** Build the nestjs-pino params (structured JSON stdout + correlation + redaction). */
export function buildLoggerOptions(): Params {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Stable per-request id; honour an upstream X-Request-Id when present.
      genReqId: (req: IncomingMessage): string =>
        (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      // Stamp the task log context (set via runWithTaskLog) onto EVERY line, so
      // task-scoped logs outside an HTTP request still carry `taskId`.
      mixin(): Record<string, unknown> {
        const ctx = getTaskLogContext();
        return ctx ? { taskId: ctx.taskId } : {};
      },
      // One structured access line per request, carrying the operator identity.
      customProps: (req: IncomingMessage): Record<string, unknown> => {
        const userId = userIdFor(req);
        return userId ? { userId } : {};
      },
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
      // Raw JSON in prod (machine-parseable for the collector); pretty in dev.
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:standard' },
          },
    },
  };
}
