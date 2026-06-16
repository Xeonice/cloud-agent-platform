import { Controller, Get } from '@nestjs/common';
import { resolveVersionResponse, type VersionResponse } from '@cap/contracts';

/**
 * Unauthenticated liveness endpoint.
 *
 * Exempt from the global operator-auth guard (11.2b) so platform probes (the Fly
 * `[[http_service.checks]]` and the docker-compose healthcheck) can reach it
 * without injecting the operator token. It performs no state change and returns a
 * fixed liveness payload.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

/**
 * Unauthenticated build-version endpoint (versioned-release-pipeline, design D1).
 *
 * `GET /version` is a SIBLING of `/health` — same liveness module, also exempt
 * from the global operator-auth guard (it returns only build metadata and
 * carries NO secrets, so it needs no operator principal; the guard's exemption
 * list covers it alongside `/health`). It is deliberately a sibling rather than a
 * nested `/health/version` so `/health` stays a zero-IO liveness probe and
 * `/version` is a clean public version surface for the later update-check.
 *
 * It reports `{ version, gitSha, buildTime }` read from the build-time-injected
 * environment (`CAP_VERSION` / `GIT_SHA` / `BUILD_TIME`, declared as `ARG`→`ENV`
 * in the api Dockerfile and injected by the release workflow's build args). Each
 * field falls back to `"unknown"` when not provided, so a plain source build with
 * no version args reports HONESTLY rather than failing. The fallback logic lives
 * in `@cap/contracts.resolveVersionResponse` (pure, shared, testable); the handler
 * reads `process.env` at REQUEST time so a redeploy with new args is reflected
 * without a code change.
 */
@Controller('version')
export class VersionController {
  @Get()
  version(): VersionResponse {
    return resolveVersionResponse(process.env);
  }
}
