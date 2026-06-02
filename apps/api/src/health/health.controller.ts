import { Controller, Get } from '@nestjs/common';

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
